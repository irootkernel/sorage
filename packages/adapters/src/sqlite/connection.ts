import { Database } from "bun:sqlite";

/**
 * The structural slice of the SQLite API Sorage code touches. Declaring it keeps the
 * adapters testable against either bun:sqlite or Bun's node:sqlite implementation of
 * the same synchronous engine, while production always opens bun:sqlite (ADR-0016).
 */
export interface SorageSqlite {
  exec(sql: string): void;
  prepare<Row = Record<string, unknown>>(
    sql: string,
  ): {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

export type { Database };

export interface SorageDatabaseOptions {
  /** Busy timeout in milliseconds; the default matches the documented 5 seconds. */
  busyTimeoutMs?: number;
}

/**
 * SQLite connection factory (RUN-001, NFR-009): every Sorage process opens exactly one
 * connection configured for WAL journaling, enforced foreign keys, and a busy timeout,
 * which is what lets concurrent CLI processes and the daemon share one database file.
 */
export function openSorageDatabase(path: string, options: SorageDatabaseOptions = {}): SorageSqlite {
  const db = new Database(path);
  const view = db as unknown as SorageSqlite;
  configure(view, options);
  return view;
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
}
