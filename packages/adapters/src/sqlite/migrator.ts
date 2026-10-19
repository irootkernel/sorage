import { admitAppliedHistory, type AppliedMigrationRow, type AppError, type KnownSchemaVersion } from "@sorage/core";
import type { SorageSqlite } from "./connection";
import { openSorageDatabase } from "./connection";
import { inspectAppliedHistory, readAppliedRows } from "./history-inspection";
export { readAppliedRows } from "./history-inspection";

/**
 * Migration runner (NFR-009 as resolved by M9, SEC-008, SHR-009, interface
 * section 38.7): every invocation shares one ordered known-catalog admission
 * executed before any DDL — an unknown forward applied version is a
 * `STORAGE_SCHEMA_UNSUPPORTED` refusal and a hole, duplicate, or version/name
 * mismatch is an integrity refusal, both leaving `sqlite_master` and
 * `schema_migrations` provably untouched. Migrations serialize through the
 * single-row `migration_lock` table inside a write transaction, a failing step
 * rolls back to the previously active schema, and a second concurrent migrator
 * waits on the busy timeout and then observes the applied version instead of
 * reapplying it. The runner never acquires or deletes the legacy
 * `run/migration.lock` file; inspection surfaces treat it as evidence only.
 */
export interface Migration {
  version: number;
  name: string;
  /** The single-SQL form every migration through version 9 uses. */
  sql?: string;
  /**
   * The segmented form a data-carrying rebuild uses (SHR-009, interface
   * section 38.7): the runner executes `sqlBefore`, then the synchronous
   * `backfill` callback on the same connection inside the same savepoint, then
   * `sqlAfter`. Exactly one of `sql` and the segmented triple is present; a
   * backfill that throws fails its step and rolls back the whole batch exactly
   * like a SQL error.
   */
  sqlBefore?: string;
  backfill?: (connection: SorageSqlite) => void;
  sqlAfter?: string;
}

/** Executes one migration's segments in declaration order; throws on any failure so the caller's rollback owns the batch. */
export function execMigrationSegments(connection: SorageSqlite, migration: Migration): void {
  if (migration.sql !== undefined) {
    if (migration.sqlBefore !== undefined || migration.sqlAfter !== undefined || migration.backfill !== undefined) {
      throw new Error(`migration ${String(migration.version)} declares both the single-sql and segmented forms`);
    }
    connection.exec(migration.sql);
    return;
  }
  if (migration.sqlBefore === undefined || migration.sqlAfter === undefined) {
    throw new Error(`migration ${String(migration.version)} is neither single-sql nor a complete segmented step`);
  }
  connection.exec(migration.sqlBefore);
  if (migration.backfill !== undefined) migration.backfill(connection);
  connection.exec(migration.sqlAfter);
}

export interface MigrationOutcome {
  appliedVersions: number[];
  alreadyUpToDate: boolean;
}

/**
 * Internal-by-convention options: `openAndMigrate` passes them in production
 * and tests inject through them. There is no CLI flag, no configuration key, no
 * exported registry, and no synthetic fixture migration is ever registered
 * into `MIGRATIONS` or advertised as future production support.
 */
export interface MigrateOptions {
  /**
   * The database path the dedicated non-operational connection opens when the
   * run's rebuild set is non-empty; required exactly then.
   */
  databasePath?: string;
  /**
   * Rebuild-marked steps of this invocation, after the ordinary list. Empty in
   * every production build at schema 8; the domain rebuild DDL of TASK-107 and
   * TASK-108 arrives through this seam, test-injected first here.
   */
  rebuilds?: Migration[];
  /** The connection factory override for tests; production uses the real SQLite factory. */
  connectionFactory?: (path: string) => SorageSqlite;
}

const LOCK_TABLE = `
CREATE TABLE IF NOT EXISTS migration_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1)
)`;

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/** A refusal thrown before any DDL runs; the carried error keeps the public code and exit mapping. */
export class SchemaAdmissionError extends Error {
  constructor(public readonly error: AppError) {
    super(error.message);
    this.name = "SchemaAdmissionError";
  }
}

/** The typed error wrappers map onto the Result error so a refused database keeps its public code. */
export function asSchemaAdmission(error: unknown): AppError | null {
  return error instanceof SchemaAdmissionError ? error.error : null;
}

/**
 * A dedicated connection whose foreign-key restoration could not be verified.
 * `committed` distinguishes the two accurate reports the contract requires:
 * committed work plus an unusable connection, or rolled-back work plus an
 * unusable connection. The connection is closed before this is thrown and is
 * never handed out for operational use.
 */
export class MigrationConnectionError extends Error {
  constructor(
    message: string,
    public readonly committed: boolean,
    public readonly restorationVerified: false,
    public readonly causeOfFailure?: unknown,
  ) {
    super(message);
    this.name = "MigrationConnectionError";
  }
}

/** An empty full `PRAGMA foreign_key_check` gate refused the commit; the whole batch rolled back. */
export class MigrationIntegrityError extends Error {
  constructor(
    public readonly violations: number,
    public readonly failingVersion: number | null,
    public readonly failingName: string | null,
  ) {
    super(
      `PRAGMA foreign_key_check reported ${String(violations)} violation(s) after migration ${
        failingName ?? "batch"
      }; the entire batch and its history rolled back.`,
    );
    this.name = "MigrationIntegrityError";
  }
}

export function migrate(
  db: SorageSqlite,
  migrations: Migration[],
  now: () => string = () => new Date().toISOString(),
  options: MigrateOptions = {},
): MigrationOutcome {
  const rebuilds = options.rebuilds ?? [];
  const combined = combinedCatalog(migrations, rebuilds);
  // Admission before any DDL: a refused database is only ever read.
  admitHistory(db, combined);
  if (rebuilds.length > 0) {
    return migrateRebuildBatch(migrations, rebuilds, combined, now, options);
  }
  return migrateOrdinary(db, migrations, combined, now);
}

/** The ordinary single-connection flow of every production build at schema 8. */
function migrateOrdinary(
  db: SorageSqlite,
  migrations: Migration[],
  catalog: KnownSchemaVersion[],
  now: () => string,
): MigrationOutcome {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  // BEGIN IMMEDIATE takes the database write lock up front, which is how concurrent
  // migrators serialize: the loser blocks on busy_timeout and then observes the result.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(LOCK_TABLE);
    db.exec(MIGRATIONS_TABLE);
    db.exec("INSERT OR IGNORE INTO migration_lock (id) VALUES (1)");

    // The history guard re-read after the write lock, so a batch another
    // migrator applied while this one waited is observed, admitted, and skipped.
    const appliedRows = readAppliedRows(db);
    admitRowsOrThrow(appliedRows, catalog);
    const applied = new Set(appliedRows.map((row) => row.version));

    const toApply = ordered.filter((migration) => !applied.has(migration.version));
    for (const migration of toApply) {
      // Each step is its own savepoint, so a failure leaves the previous schema active.
      db.exec("SAVEPOINT sorage_migration_step");
      try {
        execMigrationSegments(db, migration);
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          migration.version,
          migration.name,
          now(),
        );
        db.exec("RELEASE SAVEPOINT sorage_migration_step");
      } catch (error) {
        try {
          db.exec("ROLLBACK TO SAVEPOINT sorage_migration_step");
          db.exec("RELEASE SAVEPOINT sorage_migration_step");
          db.exec("ROLLBACK");
        } catch {
          // SQLite may already have rolled the failed transaction back; the original
          // failure is the one the caller must see.
        }
        throw new MigrationFailedError(migration.version, migration.name, error);
      }
    }

    db.exec("COMMIT");
    return { appliedVersions: toApply.map((migration) => migration.version), alreadyUpToDate: toApply.length === 0 };
  } catch (error) {
    if (!(error instanceof MigrationFailedError)) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction was never opened or was already rolled back.
      }
    }
    throw error;
  }
}

/**
 * The guarded whole-batch rebuild path (SHR-009, architecture section 19): the
 * entire pending batch — ordinary and rebuild-marked steps alike — runs on one
 * dedicated non-operational connection inside exactly one transaction. Foreign-
 * key enforcement is verified ON after open, disabled outside any transaction
 * on that connection only, and the history guard re-reads inside the write
 * lock; any pre-commit failure rolls back the entire batch and every history
 * row, an empty full `PRAGMA foreign_key_check` is required before the one
 * commit, and enforcement is restored and verified on the same connection on
 * every exit before it is closed. A restoration failure after commit is
 * reported as committed work plus an unusable connection, never falsely as a
 * rollback; after rollback, as rolled-back work plus an unusable connection.
 */
function migrateRebuildBatch(
  migrations: Migration[],
  rebuilds: Migration[],
  catalog: KnownSchemaVersion[],
  now: () => string,
  options: MigrateOptions,
): MigrationOutcome {
  if (options.databasePath === undefined) {
    throw new Error("a rebuild-marked migration requires databasePath for its dedicated connection");
  }
  const factory = options.connectionFactory ?? openSorageDatabase;
  const dedicated = factory(options.databasePath);
  let inTransaction = false;
  let committed = false;
  let batchError: unknown = null;
  let outcome: MigrationOutcome | null = null;
  let restoration: MigrationConnectionError | null = null;
  try {
    if (foreignKeysFlag(dedicated) !== 1) {
      batchError = new MigrationConnectionError(
        "the dedicated migration connection did not open with foreign-key enforcement; no migration ran",
        false,
        false,
      );
      throw batchError;
    }
    dedicated.exec("PRAGMA foreign_keys = OFF");
    if (foreignKeysFlag(dedicated) !== 0) {
      batchError = new MigrationConnectionError(
        "foreign-key enforcement could not be disabled outside the transaction on the dedicated connection; no migration ran",
        false,
        false,
      );
      throw batchError;
    }
    dedicated.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    dedicated.exec(LOCK_TABLE);
    dedicated.exec(MIGRATIONS_TABLE);
    dedicated.exec("INSERT OR IGNORE INTO migration_lock (id) VALUES (1)");

    // The history guard re-read inside the write lock, so a half-executed batch
    // can never surface as a later PK-conflict-pretending-applied.
    const appliedRows = readAppliedRows(dedicated);
    admitRowsOrThrow(appliedRows, catalog);
    const applied = new Set(appliedRows.map((row) => row.version));

    const ordered = orderedSteps(migrations, rebuilds);
    const toApply = ordered.filter((migration) => !applied.has(migration.version));
    for (const migration of toApply) {
      // Savepoints are retained purely for accurate step-level failure
      // attribution; rollback always covers the entire batch.
      dedicated.exec("SAVEPOINT sorage_migration_step");
      try {
        execMigrationSegments(dedicated, migration);
        dedicated
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now());
        dedicated.exec("RELEASE SAVEPOINT sorage_migration_step");
      } catch (error) {
        try {
          dedicated.exec("ROLLBACK TO SAVEPOINT sorage_migration_step");
          dedicated.exec("RELEASE SAVEPOINT sorage_migration_step");
          dedicated.exec("ROLLBACK");
        } catch {
          // The transaction may already be rolled back; the step failure is the error.
        }
        inTransaction = false;
        batchError = new MigrationFailedError(migration.version, migration.name, error);
        throw batchError;
      }
    }
    if (toApply.length > 0) {
      const violations = dedicated.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        dedicated.exec("ROLLBACK");
        inTransaction = false;
        const last = toApply[toApply.length - 1] as Migration;
        batchError = new MigrationIntegrityError(violations.length, last.version, last.name);
        throw batchError;
      }
    }
    dedicated.exec("COMMIT");
    inTransaction = false;
    committed = toApply.length > 0;
    outcome = { appliedVersions: toApply.map((migration) => migration.version), alreadyUpToDate: toApply.length === 0 };
  } catch (error) {
    batchError = error;
  } finally {
    try {
      if (inTransaction) {
        try {
          dedicated.exec("ROLLBACK");
        } catch {
          // Already rolled back; the batch error is the primary report.
        }
        inTransaction = false;
        committed = false;
      }
      dedicated.exec("PRAGMA foreign_keys = ON");
      if (foreignKeysFlag(dedicated) !== 1) {
        restoration = new MigrationConnectionError(
          committed
            ? "the migration committed, but restoring foreign-key enforcement on the dedicated connection could not be verified; the connection is closed and unusable"
            : "the migration rolled back, and restoring foreign-key enforcement on the dedicated connection could not be verified; the connection is closed and unusable",
          committed,
          false,
        );
      }
    } catch (error) {
      restoration = new MigrationConnectionError(
        `restoring foreign-key enforcement on the dedicated migration connection failed: ${messageOf(error)}; the connection is closed and unusable`,
        committed,
        false,
        error,
      );
    }
    try {
      dedicated.close();
    } catch {
      // A connection that cannot close is refused for operational use regardless.
    }
  }
  if (restoration !== null) {
    if (batchError !== null && batchError !== restoration) {
      throw new MigrationConnectionError(
        `${restoration.message}; the batch had already failed with: ${messageOf(batchError)}`,
        restoration.committed,
        false,
        batchError,
      );
    }
    throw restoration;
  }
  if (outcome === null) throw batchError;
  return outcome;
}

/** One ordered catalog over the ordinary list plus the rebuild-marked steps of this invocation. */
function combinedCatalog(migrations: Migration[], rebuilds: Migration[]): KnownSchemaVersion[] {
  return orderedSteps(migrations, rebuilds).map((migration) => ({ version: migration.version, name: migration.name }));
}

function orderedSteps(migrations: Migration[], rebuilds: Migration[]): Migration[] {
  const ordered = [...migrations, ...rebuilds].sort((a, b) => a.version - b.version);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && current.version <= previous.version) {
      throw new Error(`migration versions must strictly increase: ${current.version}`);
    }
  }
  return ordered;
}

function admitHistory(db: SorageSqlite, catalog: KnownSchemaVersion[]): void {
  admitRowsOrThrow(readAppliedRows(db), catalog);
}

function admitRowsOrThrow(rows: AppliedMigrationRow[], catalog: KnownSchemaVersion[]): void {
  const admission = admitAppliedHistory(rows, catalog);
  if (admission.kind === "unsupported" || admission.kind === "integrity") {
    throw new SchemaAdmissionError(admission.error);
  }
}

function foreignKeysFlag(db: SorageSqlite): number {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | null | undefined;
  return row?.foreign_keys ?? 0;
}

export class MigrationFailedError extends Error {
  constructor(
    public readonly version: number,
    public readonly name: string,
    public readonly causeOfFailure: unknown,
  ) {
    super(`migration ${version} (${name}) failed: ${String(causeOfFailure)}`);
    this.name = "MigrationFailedError";
  }
}

/** Opens and migrates a database in one step, as `sorage init` and the daemon do. */
export function openAndMigrate(
  path: string,
  migrations: Migration[],
  options: MigrateOptions = {},
): { db: SorageSqlite; outcome: MigrationOutcome } {
  // Both direct readonly and coherent private-copy inspection avoid source
  // checkpointing before admission; the transaction still rechecks history.
  const rows = inspectAppliedHistory(path);
  if (rows !== null) admitRowsOrThrow(rows, combinedCatalog(migrations, options.rebuilds ?? []));
  const db = openSorageDatabase(path);
  try {
    const outcome = migrate(db, migrations, () => new Date().toISOString(), { databasePath: path, ...options });
    return { db, outcome };
  } catch (error) {
    db.close();
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
