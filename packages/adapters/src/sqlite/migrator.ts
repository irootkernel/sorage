import type { SorageSqlite } from "./connection";
import { openSorageDatabase } from "./connection";

/**
 * Migration runner (NFR-009, SEC-008): migrations serialize through the single-row
 * `migration_lock` table inside a write transaction, every applied version is recorded
 * in `schema_migrations`, a failing step rolls back to the previously active schema, and
 * a second concurrent migrator waits on the busy timeout and then observes the applied
 * version instead of reapplying it.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationOutcome {
  appliedVersions: number[];
  alreadyUpToDate: boolean;
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

export function migrate(
  db: SorageSqlite,
  migrations: Migration[],
  now: () => string = () => new Date().toISOString(),
): MigrationOutcome {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && current.version <= previous.version) {
      throw new Error(`migration versions must strictly increase: ${current.version}`);
    }
  }

  // BEGIN IMMEDIATE takes the database write lock up front, which is how concurrent
  // migrators serialize: the loser blocks on busy_timeout and then observes the result.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(LOCK_TABLE);
    db.exec(MIGRATIONS_TABLE);
    db.exec("INSERT OR IGNORE INTO migration_lock (id) VALUES (1)");

    const appliedRows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{
      version: number;
    }>;
    const applied = new Set(appliedRows.map((row) => row.version));

    const toApply = ordered.filter((migration) => !applied.has(migration.version));
    for (const migration of toApply) {
      // Each step is its own savepoint, so a failure leaves the previous schema active.
      db.exec("SAVEPOINT sorage_migration_step");
      try {
        db.exec(migration.sql);
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
export function openAndMigrate(path: string, migrations: Migration[]): { db: SorageSqlite; outcome: MigrationOutcome } {
  const db = openSorageDatabase(path);
  try {
    const outcome = migrate(db, migrations);
    return { db, outcome };
  } catch (error) {
    db.close();
    throw error;
  }
}
