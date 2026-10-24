import { constants as sqliteConstants, Database } from "bun:sqlite";
import { statSync } from "node:fs";

/**
 * The structural slice of the SQLite API Sorage code touches. Declaring it keeps the
 * adapters testable against either bun:sqlite or Bun's node:sqlite implementation of
 * the same synchronous engine, while production always opens bun:sqlite (ADR-0016).
 * Optional members (`finalize?`, `fileControl?`) exist only on bun:sqlite; callers
 * guard on presence exactly like the statement seam above.
 */
export interface SorageSqlite {
  exec(sql: string): void;
  prepare<Row = Record<string, unknown>>(
    sql: string,
  ): {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    /** Bun statements need explicit finalization before their connection closes. */
    finalize?(): void;
  };
  close(): void;
  /** bun:sqlite's sqlite3_file_control bridge; absent on node:sqlite. */
  fileControl?(op: number, arg?: number): number;
}

export type { Database };

export interface SorageDatabaseOptions {
  /** Busy timeout in milliseconds; the default matches the documented 5 seconds. */
  busyTimeoutMs?: number;
}

/**
 * Operational SQLite connection factory (RUN-001, NFR-009), configured for
 * WAL journaling, enforced foreign keys, and a busy timeout,
 * which is what lets concurrent CLI processes and the daemon share one database file.
 * Every writer opened here keeps its WAL sidecars persistent (RDR-003): the sidecars
 * stay in place after the last writer closes, and a covered read selects its
 * storage path from them under RDR-004.
 */
export function openSorageDatabase(path: string, options: SorageDatabaseOptions = {}): SorageSqlite {
  const db = new Database(path);
  const view = db as unknown as SorageSqlite;
  try {
    configure(view, options);
  } catch (error) {
    try {
      view.close();
    } catch {
      // Best effort on the configuration failure path.
    }
    throw error;
  }
  return view;
}

/**
 * The true-readonly history-admission connection (SHR-009): Bun's native
 * `readonly: true` refuses writes with SQLITE_READONLY and reads live WAL
 * content, so a refused database's main file bytes and its existing committed
 * WAL bytes stay byte-identical after the refusal. Reader-side SHM
 * housekeeping may still occur and is not claimed invariant. Only the
 * connection-local busy timeout is set — never journal_mode, foreign keys,
 * or any persistent pragma. The handle never escapes to operational callers;
 * it reads the migration history and closes.
 */
export function openSorageReadonlyAdmission(path: string): SorageSqlite {
  const db = new Database(path, { readonly: true }) as unknown as SorageSqlite;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      // Keep uncertain ownership distinct from retryable CANTOPEN failures.
      throw new AggregateError(
        [error, closeError],
        "Readonly history configuration failed and its connection could not close",
        { cause: error },
      );
    }
    throw error;
  }
  return db;
}

/**
 * The covered zero-write read's connection over a `-wal` longer than its
 * 32-byte header (RDR-002, RDR-003): a percent-encoded `file:` URI with
 * `mode=ro` and `readonly_shm=1`, which opens the existing `-shm` read-only.
 * TASK-122 measured this form as stable and write-free, sandboxed or not,
 * with a live writer holding its connection after a commit, after a writer
 * was killed before closing, and over an incomplete frame tail. Over a `-wal`
 * no longer than its header with no writer connected the same form runs
 * SQLite's unreliable shared-memory mode — reporting an external change at
 * every read transaction over an empty `-wal`, or failing with
 * `SQLITE_PROTOCOL` over a header-only one — so that state is served by the
 * in-memory copy instead (`sqlite/read-admission.ts`). Only the
 * connection-local busy timeout is set.
 */
export function openSorageReadonlyWalAccess(path: string): SorageSqlite {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const db = new Database(`file:${encoded}?mode=ro&readonly_shm=1`, { readonly: true }) as unknown as SorageSqlite;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Readonly WAL access configuration failed and its connection could not close",
        { cause: error },
      );
    }
    throw error;
  }
  return db;
}

/** Opens only an owned history-capture copy; recovery may write that copy. */
export function openSorageInspectionCopy(path: string): SorageSqlite {
  return new Database(path) as unknown as SorageSqlite;
}

/**
 * The read-only in-memory image of a captured quiescent main file (RDR-004):
 * `sqlite3_deserialize` with the readonly flag, so the image refuses writes.
 * The buffer is the caller's private copy; a WAL-format header in it must be
 * normalized to the legacy pair before this call, because SQLite's memdb VFS
 * cannot open a WAL-mode image.
 */
export function openSorageMemoryCopy(bytes: Uint8Array): SorageSqlite {
  return Database.deserialize(bytes, { readonly: true }) as unknown as SorageSqlite;
}

/**
 * Confirms the database file itself exists by stat: a confirmed ENOENT (no
 * existing history, safe to initialize fresh) returns false; every other
 * inspection failure throws so the caller stops rather than proceeding to a
 * writable open on an uncertain filesystem state. Only `false` from this
 * function may bypass the readonly admission step.
 */
export function databaseFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Applies the Sorage pragmas to an already-open connection; used by tests too. */
export function configureSorageDatabase(db: SorageSqlite, options: SorageDatabaseOptions = {}): void {
  configure(db, options);
}

function configure(db: SorageSqlite, options: SorageDatabaseOptions): void {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  // busy_timeout comes first: converting a fresh database to WAL needs a write lock,
  // and without a busy handler a racing first-open would fail immediately.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  persistWalSidecars(db);
}

/**
 * `SQLITE_FCNTL_PERSIST_WAL` (opcode 10) keeps `-wal`/`-shm` beside the
 * database after the last writer closes, so the sidecars stay in place and a
 * covered read selects its storage path from them under RDR-004 (RDR-003). A
 * refused or failing call fails the open — a writer must never run with
 * sidecars it would silently delete on close. Absent under node:sqlite (the
 * vitest bridge), where the call is skipped and spawned-engine tests pin the
 * effect.
 */
function persistWalSidecars(db: SorageSqlite): void {
  if (db.fileControl === undefined) return;
  const refused = db.fileControl(sqliteConstants.SQLITE_FCNTL_PERSIST_WAL, 1);
  if (refused !== 0) {
    throw new Error(`persisting WAL sidecars was refused (fileControl returned ${String(refused)})`);
  }
}
