import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { errorSpec, knownSchemaMaximum, listMemos } from "@sorage/core";
import { createNodeMemoPorts } from "../../src/memo-command-ports";
import { openSorageReadonlyWalAccess, type SorageSqlite } from "../../src/sqlite/connection";
import { MIGRATIONS, productionMigrationPlan } from "../../src/sqlite/migrations";
import { openAndMigrate, readAppliedRows } from "../../src/sqlite/migrator";
import { openCoveredReadConnection, type ReadAdmissionPorts } from "../../src/sqlite/read-admission";
import { blockingSleepMs } from "../../src/sleep";

/**
 * The shared covered-read primitive of RDR-002 to RDR-004 over real files:
 * the state matrix (missing, empty, older, newer, corrupt histories), the
 * selection from the `-wal` length before any SQLite open (the copy for a
 * `-wal` absent or no longer than its 32-byte header, read-only WAL access
 * for a longer one with a `-shm`, the per-surface refusal for a longer one
 * without), the copy's identity re-check including the `-wal` length, the
 * post-open re-check that re-selects the copy when the last writer's close
 * emptied the `-wal`, the retry and exhaustion rules, and spawned native-Bun
 * regressions for the engine facts the vitest bridge cannot emulate:
 * persistent sidecars after close, the header-patched deserialize of a real
 * WAL-mode main file, and zero-write reads over the states a clean close, a
 * killed writer, a header-only `-wal` and an incomplete tail leave.
 *
 * Every state case asserts its fixture's precondition first. Under the
 * bridge (node:sqlite) a closing writer deletes the sidecars, so
 * frames-present cases hold a live writer connection after a committed write.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "sorage-read-admission-"));
  roots.push(dir);
  return dir;
}

function databasePath(dir: string) {
  return join(dir, "sorage.sqlite3");
}

/** Seeds through the real production plan; count builds a truthful ordinary prefix. */
function seed(database: string, count?: number) {
  if (count === undefined) {
    const plan = productionMigrationPlan();
    openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds }).db.close();
    return;
  }
  openAndMigrate(database, MIGRATIONS.slice(0, count)).db.close();
}

/** A live WAL-mode writer whose committed benign write leaves a `-wal` longer than its header. */
function liveWriterWithFrames(database: string): DatabaseSync {
  const writer = new DatabaseSync(database);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.exec("UPDATE migration_lock SET id = 1 WHERE id = 1");
  expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
  expect(existsSync(`${database}-shm`)).toBe(true);
  return writer;
}

/** Records every readonly open the primitive attempts; the seam otherwise behaves like production. */
function recordingPorts(): { ports: ReadAdmissionPorts; opens: string[] } {
  const opens: string[] = [];
  return {
    opens,
    ports: {
      openReadonly: (path) => {
        opens.push(path);
        return openSorageReadonlyWalAccess(path);
      },
    },
  };
}

type Refusal = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recovery?: { suggestedCommand: string };
};

function refusalOf(result: ReturnType<typeof openCoveredReadConnection>): Refusal {
  expect(result.ok).toBe(false);
  return (result as { error: Refusal }).error;
}

/** Size, nanosecond mtime and bytes of every file in the directory. */
function inventory(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const stat = lstatSync(join(dir, name), { bigint: true });
    out[name] = `${String(stat.size)}:${String(stat.mtimeNs)}:${readFileSync(join(dir, name)).toString("hex")}`;
  }
  return out;
}

/** A real writer process that commits a benign write with persistent sidecars and holds its connection until told to close. */
function holdWriter(database: string): {
  /** Synchronously signals the writer to close and waits until its database is settled (EXITED is written after db.close()). */
  signalCloseAndWaitDb(): void;
  /** Async completion: signals the close, then awaits the process's actual exit. */
  stop(): Promise<void>;
  kill(): void;
} {
  // Synchronization files live in their own directory outside every inventoried
  // one: a marker inside an inventoried tree once raced an inventory snapshot
  // by its own timestamp. The writer closes its database before reporting
  // EXITED, so signalCloseAndWaitDb() returns with every database effect
  // settled; stop() additionally awaits the child's exit promise, captured
  // right after the spawn.
  const sync = mkdtempSync(join(tmpdir(), "sorage-read-admission-sync-"));
  roots.push(sync);
  const ready = join(sync, "ready");
  const stopMarker = join(sync, "stop");
  const exitedMarker = join(sync, "exited");
  const script = `import {constants, Database} from 'bun:sqlite'; import {existsSync, writeFileSync} from 'node:fs';
    const db = new Database(${JSON.stringify(database)});
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
    db.exec('BEGIN'); db.exec('UPDATE migration_lock SET id = 1 WHERE id = 1'); db.exec('COMMIT');
    writeFileSync(${JSON.stringify(ready)}, 'READY');
    while (!existsSync(${JSON.stringify(stopMarker)})) await new Promise((r) => setTimeout(r, 10));
    db.close(); writeFileSync(${JSON.stringify(exitedMarker)}, 'EXITED'); process.exit(0);`;
  const child = spawn("bun", ["-e", script], { stdio: "ignore" });
  // Captured immediately after the spawn, before any yield, so a close that
  // happens during a later await can never orphan the wait.
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  registerSpawnCleanup(child);
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && Date.now() < deadline) blockingSleepMs(10);
  expect(existsSync(ready), "the writer must commit before READY").toBe(true);
  expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
  const signalCloseAndWaitDb = () => {
    writeFileSync(stopMarker, "STOP");
    const close = Date.now() + 10_000;
    while (!existsSync(exitedMarker) && Date.now() < close) blockingSleepMs(10);
    expect(existsSync(exitedMarker), "the writer must close cleanly").toBe(true);
  };
  return {
    signalCloseAndWaitDb,
    stop: async () => {
      signalCloseAndWaitDb();
      await exited;
    },
    kill: () => {
      child.kill("SIGKILL");
    },
  };
}

const liveChildren: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
});
function registerSpawnCleanup(child: ReturnType<typeof spawn>): void {
  liveChildren.push(child);
}

describe("the covered-read admission state matrix (RDR-002)", () => {
  it("reads a current database through read-only WAL access when the -wal holds a live writer's frames", () => {
    const database = databasePath(home());
    seed(database);
    const writer = liveWriterWithFrames(database);
    try {
      const opened = openCoveredReadConnection(database, "handoff");
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.source).toBe("readonly-wal");
      expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
      opened.value.close();
    } finally {
      writer.close();
    }
  });

  it("refuses an older schema prefix with STORAGE_MIGRATION_REQUIRED naming both versions and the backup-run recovery", () => {
    const database = databasePath(home());
    seed(database, 7);
    const error = refusalOf(openCoveredReadConnection(database, "handoff"));
    expect(error.code).toBe("STORAGE_MIGRATION_REQUIRED");
    expect(error.message).toContain("migration 7");
    expect(error.message).toContain(String(knownSchemaMaximum()));
    expect(error.message).toContain("never migrates");
    expect(error.details?.appliedMaximum).toBe(7);
    // The recovery is the catalogue's, applied by the renderer (one source).
    expect(error.recovery).toBeUndefined();
    expect(errorSpec("STORAGE_MIGRATION_REQUIRED").recovery?.suggestedCommand).toContain("sorage backup run");
  });

  it("refuses a zero-byte main file as migration 0 through the copy branch and creates nothing", () => {
    const dir = home();
    const database = databasePath(dir);
    writeFileSync(database, Buffer.alloc(0));
    const { ports, opens } = recordingPorts();
    const error = refusalOf(openCoveredReadConnection(database, "handoff", ports));
    expect(error.code).toBe("STORAGE_MIGRATION_REQUIRED");
    expect(error.details?.appliedMaximum).toBe(0);
    expect(opens).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["sorage.sqlite3"]);
  });

  it("refuses a forward version with STORAGE_SCHEMA_UNSUPPORTED", () => {
    const database = databasePath(home());
    seed(database);
    const writer = liveWriterWithFrames(database);
    try {
      writer.exec(`INSERT INTO schema_migrations VALUES(${knownSchemaMaximum() + 1}, 'future', '2026-01-01')`);
      const error = refusalOf(openCoveredReadConnection(database, "handoff"));
      expect(error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    } finally {
      writer.close();
    }
  });

  it("refuses a holed history with STORAGE_INTEGRITY_ERROR", () => {
    const database = databasePath(home());
    seed(database);
    const writer = liveWriterWithFrames(database);
    try {
      writer.exec("DELETE FROM schema_migrations WHERE version = 4");
      const error = refusalOf(openCoveredReadConnection(database, "project"));
      expect(error.code).toBe("STORAGE_INTEGRITY_ERROR");
    } finally {
      writer.close();
    }
  });

  it("refuses a missing database with preflight's finding and creates no file", () => {
    const dir = home();
    const database = databasePath(dir);
    const error = refusalOf(openCoveredReadConnection(database, "handoff"));
    expect(error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(error.message).toBe("The database is missing from a recognizable installation.");
    expect(error.recovery?.suggestedCommand).toContain("sorage backup restore");
    expect(existsSync(database)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a non-SQLite main file with the integrity refusal", () => {
    const dir = home();
    const database = databasePath(dir);
    writeFileSync(database, Buffer.from("definitely not a sqlite database, just opaque padding bytes"));
    const error = refusalOf(openCoveredReadConnection(database, "handoff"));
    expect(error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(readdirSync(dir).sort()).toEqual(["sorage.sqlite3"]);
  });
});

describe("the selection from the -wal length before any open (RDR-004)", () => {
  it("serves a main-only database from the in-memory copy without any SQLite open", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });
    expect(existsSync(`${database}-wal`)).toBe(false);
    const before = inventory(dir);
    const { ports, opens } = recordingPorts();
    const opened = openCoveredReadConnection(database, "handoff", ports);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.source).toBe("memory-copy");
    expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
    opened.value.close();
    expect(opens).toEqual([]);
    expect(inventory(dir)).toEqual(before);
  });

  it("serves an empty -wal beside its -shm from the in-memory copy, leaving both byte- and mtime-identical", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    // The state a clean last close leaves on the native engine.
    writeFileSync(`${database}-wal`, Buffer.alloc(0));
    writeFileSync(`${database}-shm`, Buffer.alloc(32768));
    expect(lstatSync(`${database}-wal`).size).toBe(0);
    expect(existsSync(`${database}-shm`)).toBe(true);
    const before = inventory(dir);
    const { ports, opens } = recordingPorts();
    const opened = openCoveredReadConnection(database, "handoff", ports);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.source).toBe("memory-copy");
    expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
    opened.value.close();
    expect(opens).toEqual([]);
    expect(inventory(dir)).toEqual(before);
  });

  it("serves a header-only -wal from the in-memory copy without any SQLite open", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    writeFileSync(`${database}-wal`, Buffer.alloc(32));
    writeFileSync(`${database}-shm`, Buffer.alloc(32768));
    expect(lstatSync(`${database}-wal`).size).toBe(32);
    const before = inventory(dir);
    const { ports, opens } = recordingPorts();
    const opened = openCoveredReadConnection(database, "handoff", ports);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.source).toBe("memory-copy");
    expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
    opened.value.close();
    expect(opens).toEqual([]);
    expect(inventory(dir)).toEqual(before);
  });

  it("refuses a -wal longer than its header without a -shm per surface, without opening storage or creating the -shm", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    const writer = liveWriterWithFrames(database);
    rmSync(`${database}-shm`);
    try {
      expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
      expect(existsSync(`${database}-shm`)).toBe(false);
      const before = inventory(dir);
      const { ports, opens } = recordingPorts();
      for (const [surface, code] of [
        ["handoff", "STORAGE_INSPECTION_UNAVAILABLE"],
        ["project", "STORAGE_INSPECTION_UNAVAILABLE"],
        [undefined, "INTERNAL_ERROR"],
      ] as const) {
        const error = refusalOf(openCoveredReadConnection(database, surface, ports));
        expect(error.code, String(surface)).toBe(code);
        expect(error.recovery?.suggestedCommand).toContain("sorage backup run");
      }
      expect(opens).toEqual([]);
      expect(existsSync(`${database}-shm`)).toBe(false);
      expect(inventory(dir)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("retries onto the copy when a writer empties the -wal between the selection and the open", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    // The selection saw a `-wal` longer than its header and a `-shm`; the
    // injected open then fails as read-only WAL access does when the writer
    // checkpointed and closed.
    writeFileSync(`${database}-wal`, Buffer.alloc(64));
    writeFileSync(`${database}-shm`, Buffer.alloc(32768));
    expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
    const ports: ReadAdmissionPorts = {
      openReadonly: (path) => {
        writeFileSync(`${path}-wal`, Buffer.alloc(0));
        const failure = new Error("unable to open database file") as Error & { code?: string };
        failure.code = "SQLITE_CANTOPEN";
        throw failure;
      },
    };
    const opened = openCoveredReadConnection(database, "handoff", ports);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.source).toBe("memory-copy");
    expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
    opened.value.close();
  });

  it("refuses a -wal that is a short symlink over frames, never serving a copy that omits them", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    // Frames in the `-wal` (real ones, on the native engine, in the regression
    // below); the link's own length is shorter than the header, so without the
    // regular-file check the copy would serve the main file and silently omit
    // whatever the WAL committed.
    writeFileSync(`${database}-wal`, Buffer.alloc(64));
    writeFileSync(`${database}-shm`, Buffer.alloc(32768));
    renameSync(`${database}-wal`, `${database}-wal.real`);
    symlinkSync("sorage.sqlite3-wal.real", `${database}-wal`);
    expect(lstatSync(`${database}-wal`).isSymbolicLink()).toBe(true);
    expect(lstatSync(`${database}-wal`).size).toBeLessThanOrEqual(32);
    const before = inventory(dir);
    const { ports, opens } = recordingPorts();
    const error = refusalOf(openCoveredReadConnection(database, "handoff", ports));
    expect(error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(error.message).toContain("WAL sidecar is not a regular file");
    expect(error.recovery?.suggestedCommand).toContain("do not initialize over it");
    expect(opens).toEqual([]);
    expect(inventory(dir)).toEqual(before);
  });

  it("refuses a -shm that is not a regular file before the WAL-path open", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    writeFileSync(`${database}-wal`, Buffer.alloc(64));
    symlinkSync("sorage.sqlite3-shm.real", `${database}-shm`);
    expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
    expect(lstatSync(`${database}-shm`).isSymbolicLink()).toBe(true);
    const { ports, opens } = recordingPorts();
    const error = refusalOf(openCoveredReadConnection(database, "project", ports));
    expect(error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(error.message).toContain("Shared-memory sidecar is not a regular file");
    expect(opens).toEqual([]);
  });

  it("serves a non-regular -shm beside an empty -wal from the copy, because the copy never opens or measures it", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    writeFileSync(`${database}-wal`, Buffer.alloc(0));
    // The link target exists so the inventory can hash through it; the read
    // never follows the link, on either path.
    writeFileSync(`${database}-shm.real`, Buffer.alloc(32768));
    symlinkSync("sorage.sqlite3-shm.real", `${database}-shm`);
    expect(lstatSync(`${database}-wal`).size).toBe(0);
    expect(lstatSync(`${database}-shm`).isSymbolicLink()).toBe(true);
    const before = inventory(dir);
    const { ports, opens } = recordingPorts();
    const opened = openCoveredReadConnection(database, "handoff", ports);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.source).toBe("memory-copy");
    expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
    opened.value.close();
    expect(opens).toEqual([]);
    expect(inventory(dir)).toEqual(before);
  });
});

describe("connection ownership after the open (the post-open re-check)", () => {
  it("closes the open connection when the -wal turns into a non-regular file after the first read", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    const writer = liveWriterWithFrames(database);
    try {
      const closeLog: string[] = [];
      const ports: ReadAdmissionPorts = {
        openReadonly: (path) => {
          const real = openSorageReadonlyWalAccess(path);
          let firstStatement = true;
          const wrapped: SorageSqlite = {
            exec: (sql: string) => real.exec(sql),
            prepare<Row>(sql: string) {
              const statement = real.prepare<Row>(sql);
              if (firstStatement) {
                firstStatement = false;
                // The read's first statement has run; the post-open re-check
                // must then see a `-wal` that turned non-regular, refuse, and
                // close this owned connection before returning.
                renameSync(`${path}-wal`, `${path}-wal.real`);
                symlinkSync("sorage.sqlite3-wal.real", `${path}-wal`);
              }
              return statement;
            },
            close: () => {
              closeLog.push("close");
              real.close();
            },
          };
          return wrapped;
        },
      };
      const error = refusalOf(openCoveredReadConnection(database, "handoff", ports));
      expect(error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(error.message).toContain("WAL sidecar is not a regular file");
      expect(closeLog).toEqual(["close"]);
    } finally {
      writer.close();
    }
  });
});

describe("the copy's identity re-check (RDR-004)", () => {
  it("retries and then serves the copy when the main file changes under the capture", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });
    let reads = 0;
    const ports: ReadAdmissionPorts = {
      readMainFile: (path, size) => {
        reads += 1;
        const bytes = readFileSync(path);
        if (reads === 1) {
          // A writer touched the main file while the bytes were being read.
          const future = new Date(Date.now() + 5_000);
          utimesSync(path, future, future);
        }
        return bytes.subarray(0, size);
      },
    };
    const opened = openCoveredReadConnection(database, "handoff", ports);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(reads).toBe(2);
    expect(opened.value.source).toBe("memory-copy");
    expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
    opened.value.close();
  });

  it("never serves a copy once the -wal grows past its header under the capture, and re-selects from the new state", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });
    let reads = 0;
    let images = 0;
    const ports: ReadAdmissionPorts = {
      readMainFile: (path, size) => {
        reads += 1;
        // A writer appended frames while the bytes were being read.
        writeFileSync(`${path}-wal`, Buffer.alloc(64));
        return readFileSync(path).subarray(0, size);
      },
      openMemoryCopy: () => {
        images += 1;
        throw new Error("a stale copy must never be opened");
      },
    };
    // The new state is a `-wal` longer than its header without a `-shm.
    const error = refusalOf(openCoveredReadConnection(database, "handoff", ports));
    expect(error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(reads).toBe(1);
    expect(images).toBe(0);
  });

  it("refuses with the typed integrity refusal when the -wal becomes a non-regular file under the capture", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });
    let reads = 0;
    let images = 0;
    const ports: ReadAdmissionPorts = {
      readMainFile: (path, size) => {
        reads += 1;
        symlinkSync("sorage.sqlite3-wal.real", `${path}-wal`);
        return readFileSync(path).subarray(0, size);
      },
      openMemoryCopy: () => {
        images += 1;
        throw new Error("a stale copy must never be opened");
      },
    };
    const error = refusalOf(openCoveredReadConnection(database, "handoff", ports));
    expect(error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(error.message).toContain("WAL sidecar is not a regular file");
    expect(reads).toBe(1);
    expect(images).toBe(0);
  });

  it("maps capture exhaustion onto the family's lock refusal and Memo's typed internal error", () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });
    let tick = 0;
    const ports: ReadAdmissionPorts = {
      readMainFile: (path, size) => {
        tick += 1;
        const future = new Date(Date.now() + tick * 5_000);
        utimesSync(path, future, future);
        return readFileSync(path).subarray(0, size);
      },
    };
    const handoff = refusalOf(openCoveredReadConnection(database, "handoff", ports));
    expect(handoff.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(handoff.message).toContain("contended");
    const memo = refusalOf(openCoveredReadConnection(database, undefined, ports));
    expect(memo.code).toBe("INTERNAL_ERROR");
    expect(memo.message).toContain("could not be read coherently");
  });
});

describe("the post-open re-check (RDR-004)", () => {
  it("re-selects the copy when the last writer's close empties the -wal between selection and first read", async () => {
    const dir = home();
    const database = databasePath(dir);
    seed(database);
    const holder = holdWriter(database);
    try {
      expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
      let walAfterClose = -1;
      let before: Record<string, string> | null = null;
      const ports: ReadAdmissionPorts = {
        beforeOpen: (path) => {
          // The selection observed frames; the writer now closes cleanly,
          // which empties the `-wal` before the reader's first read. The seam
          // is synchronous, so it waits only until the database is settled;
          // the process's actual exit is awaited below, before the assertions.
          holder.signalCloseAndWaitDb();
          walAfterClose = lstatSync(`${path}-wal`).size;
          before = inventory(dir);
        },
      };
      const opened = openCoveredReadConnection(database, "handoff", ports);
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      if (!opened.ok) return;
      expect(walAfterClose).toBe(0);
      expect(opened.value.source).toBe("memory-copy");
      expect(readAppliedRows(opened.value.db)).toHaveLength(knownSchemaMaximum());
      opened.value.close();
      await holder.stop();
      expect(inventory(dir)).toEqual(before);
    } finally {
      holder.kill();
    }
  });

  it("serves the correct Memo page from the re-selected copy without writing anything", async () => {
    const dir = home();
    const work = join(dir, "work");
    mkdirSync(work);
    const homeEnv = dir;
    const database = join(dir, "state", "sorage.sqlite3");
    const entry = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));
    const run = (args: string[]) => {
      const result = spawnSync("bun", [entry, ...args, "--json"], {
        encoding: "utf8",
        cwd: work,
        env: { ...process.env, SORAGE_HOME: homeEnv },
      });
      expect(result.status, result.stderr).toBe(0);
    };
    run(["init", "--non-interactive"]);
    run(["project", "add", "--name", "Memo", "--slug", "memo", "--dir", work]);
    run(["memo", "add", "--title", "First"]);
    run(["memo", "add", "--title", "Second"]);
    // The real CLI leaves the empty `-wal` of a clean close; give it frames again.
    const holder = holdWriter(database);
    try {
      expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
      let before: Record<string, string> | null = null;
      const ports: ReadAdmissionPorts = {
        beforeOpen: () => {
          holder.signalCloseAndWaitDb();
          expect(lstatSync(`${database}-wal`).size).toBe(0);
          before = inventory(join(database, ".."));
        },
      };
      const opened = openCoveredReadConnection(database, undefined, ports);
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.source).toBe("memory-copy");
      const memoPorts = createNodeMemoPorts({
        env: { SORAGE_HOME: homeEnv },
        userHome: homeEnv,
        database: opened.value.db,
      });
      const page = listMemos(memoPorts, { allProjects: true });
      expect(page.ok, JSON.stringify(page)).toBe(true);
      if (!page.ok) return;
      expect(page.value.items).toHaveLength(2);
      memoPorts.close();
      opened.value.close();
      await holder.stop();
      expect(inventory(join(database, ".."))).toEqual(before);
    } finally {
      holder.kill();
    }
  });
});

describe("the covered-read engine regressions on the native engine", () => {
  const moduleUrl = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
  function native(source: string): string {
    const run = spawnSync("bun", ["-e", source], { encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    return run.stdout.trim();
  }
  /** Reads through the primitive on the native engine and reports source, rows, file identity and data_version stability. */
  const coveredReadReport = (database: string) => `import {createHash} from 'node:crypto';
      import {lstatSync, readFileSync} from 'node:fs';
      import {openCoveredReadConnection} from ${moduleUrl("../../src/sqlite/read-admission.ts")};
      import {readAppliedRows} from ${moduleUrl("../../src/sqlite/migrator.ts")};
      const files = [${JSON.stringify(database)}, ${JSON.stringify(`${database}-wal`)}, ${JSON.stringify(`${database}-shm`)}];
      const identity = () => files.map((p) => { try { const s = lstatSync(p, { bigint: true }); return String(s.size) + ':' + String(s.mtimeNs) + ':' + createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12); } catch { return 'ABSENT'; } }).join('|');
      const before = identity();
      const started = Date.now();
      const opened = openCoveredReadConnection(${JSON.stringify(database)}, 'handoff');
      if (!opened.ok) { console.log('REFUSED ' + opened.error.code + ' ' + opened.error.message); process.exit(0); }
      const dv = () => opened.value.db.prepare('PRAGMA data_version').get().data_version;
      const versions = [dv()];
      opened.value.db.exec('BEGIN'); const rows = readAppliedRows(opened.value.db).length; opened.value.db.exec('COMMIT');
      versions.push(dv(), dv());
      opened.value.close();
      const after = identity();
      console.log(opened.value.source + ' rows=' + rows + ' files=' + (before === after ? 'IDENTICAL' : before + ' -> ' + after) + ' data_version=' + (versions.every((v) => v === versions[0]) ? 'STABLE' : versions.join(',')) + ' ms=' + (Date.now() - started));`;

  it("keeps WAL sidecars persistent through every writer open (RDR-003)", () => {
    const database = databasePath(home());
    const out = native(`import {constants} from 'bun:sqlite';
      import {existsSync} from 'node:fs';
      import {openSorageDatabase} from ${moduleUrl("../../src/sqlite/connection.ts")};
      if (constants.SQLITE_FCNTL_PERSIST_WAL !== 10) { console.log('BAD_OPCODE ' + constants.SQLITE_FCNTL_PERSIST_WAL); process.exit(0); }
      const db = openSorageDatabase(${JSON.stringify(database)});
      db.exec('CREATE TABLE t(x)'); db.exec('INSERT INTO t VALUES (1)'); db.close();
      console.log(existsSync(${JSON.stringify(`${database}-wal`)}) && existsSync(${JSON.stringify(`${database}-shm`)}) ? 'SIDECARS_PERSIST' : 'SIDECARS_GONE');`);
    expect(out).toBe("SIDECARS_PERSIST");
  });

  it("reads a real quiescent WAL-mode main-only database through the header-patched deserialize", () => {
    const database = databasePath(home());
    const out = native(`import {rmSync} from 'node:fs';
      import {openCoveredReadConnection} from ${moduleUrl("../../src/sqlite/read-admission.ts")};
      import {openAndMigrate, readAppliedRows} from ${moduleUrl("../../src/sqlite/migrator.ts")};
      import {productionMigrationPlan} from ${moduleUrl("../../src/sqlite/migrations.ts")};
      const plan = productionMigrationPlan();
      const migrated = openAndMigrate(${JSON.stringify(database)}, plan.migrations, { rebuilds: plan.rebuilds });
      migrated.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); migrated.db.close();
      rmSync(${JSON.stringify(`${database}-wal`)}); rmSync(${JSON.stringify(`${database}-shm`)});
      const opened = openCoveredReadConnection(${JSON.stringify(database)}, 'handoff');
      if (!opened.ok) { console.log('REFUSED ' + opened.error.code + ' ' + opened.error.message); process.exit(0); }
      const rows = readAppliedRows(opened.value.db).length;
      opened.value.close();
      console.log(opened.value.source + ' rows=' + rows);`);
    expect(out).toBe(`memory-copy rows=${String(knownSchemaMaximum())}`);
  });

  it("reads the empty -wal a clean close leaves through the copy, with every file byte- and mtime-identical", () => {
    const database = databasePath(home());
    const out = native(`import {Database} from 'bun:sqlite';
      import {lstatSync} from 'node:fs';
      import {openAndMigrate} from ${moduleUrl("../../src/sqlite/migrator.ts")};
      import {productionMigrationPlan} from ${moduleUrl("../../src/sqlite/migrations.ts")};
      const plan = productionMigrationPlan();
      openAndMigrate(${JSON.stringify(database)}, plan.migrations, { rebuilds: plan.rebuilds }).db.close();
      // The rebuild's own close defers (its dedicated connection keeps
      // unfinalized statements), so the frames stay; a checkpointing close —
      // the state every later CLI command leaves — empties the WAL.
      const truncating = new Database(${JSON.stringify(database)});
      truncating.exec('PRAGMA wal_checkpoint(TRUNCATE)'); truncating.close();
      if (lstatSync(${JSON.stringify(`${database}-wal`)}).size !== 0) { console.log('WAL_NOT_EMPTY ' + lstatSync(${JSON.stringify(`${database}-wal`)}).size); process.exit(0); }
      if (!lstatSync(${JSON.stringify(`${database}-shm`)}).isFile()) { console.log('SHM_MISSING'); process.exit(0); }
      ${coveredReadReport(database)}`);
    expect(
      out.startsWith(`memory-copy rows=${String(knownSchemaMaximum())} files=IDENTICAL data_version=STABLE ms=`),
    ).toBe(true);
  });

  it("reads the frames a killed writer left through read-only WAL access, with every file byte- and mtime-identical", async () => {
    const database = databasePath(home());
    native(`import {openAndMigrate} from ${moduleUrl("../../src/sqlite/migrator.ts")};
      import {productionMigrationPlan} from ${moduleUrl("../../src/sqlite/migrations.ts")};
      const plan = productionMigrationPlan();
      openAndMigrate(${JSON.stringify(database)}, plan.migrations, { rebuilds: plan.rebuilds }).db.close();
      console.log('seeded');`);
    // A benign write that changes no Sorage data, committed by a writer that is
    // then killed before it can checkpoint or close.
    const marker = `${database}.ready`;
    const script = `import {constants, Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs';
      const db = new Database(${JSON.stringify(database)});
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
      db.exec('BEGIN'); db.exec('UPDATE migration_lock SET id = 1 WHERE id = 1'); db.exec('COMMIT');
      writeFileSync(${JSON.stringify(marker)}, 'READY'); setInterval(() => db.exec('SELECT 1'), 1000);`;
    const child = spawn("bun", ["-e", script], { stdio: "ignore" });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("close", (_code, signal) => resolve(signal)),
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(10);
    expect(existsSync(marker), "the writer must commit before READY").toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await closed).toBe("SIGKILL");
    rmSync(marker);
    expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
    const out = native(coveredReadReport(database));
    expect(
      out.startsWith(`readonly-wal rows=${String(knownSchemaMaximum())} files=IDENTICAL data_version=STABLE ms=`),
    ).toBe(true);
  });

  it("refuses a killed writer's real frames behind a short symlink, never serving a copy that omits them", async () => {
    const database = databasePath(home());
    native(`import {openAndMigrate} from ${moduleUrl("../../src/sqlite/migrator.ts")};
      import {productionMigrationPlan} from ${moduleUrl("../../src/sqlite/migrations.ts")};
      const plan = productionMigrationPlan();
      openAndMigrate(${JSON.stringify(database)}, plan.migrations, { rebuilds: plan.rebuilds }).db.close();
      console.log('seeded');`);
    const marker = `${database}.ready`;
    const script = `import {constants, Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs';
      const db = new Database(${JSON.stringify(database)});
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
      db.exec('BEGIN'); db.exec('UPDATE migration_lock SET id = 1 WHERE id = 1'); db.exec('COMMIT');
      writeFileSync(${JSON.stringify(marker)}, 'READY'); setInterval(() => db.exec('SELECT 1'), 1000);`;
    const child = spawn("bun", ["-e", script], { stdio: "ignore" });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("close", (_code, signal) => resolve(signal)),
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(10);
    expect(existsSync(marker), "the writer must commit before READY").toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await closed).toBe("SIGKILL");
    rmSync(marker);
    // The real uncheckpointed commit moves aside behind a short relative link.
    expect(lstatSync(`${database}-wal`).size).toBeGreaterThan(32);
    renameSync(`${database}-wal`, `${database}-wal.real`);
    symlinkSync("sorage.sqlite3-wal.real", `${database}-wal`);
    expect(lstatSync(`${database}-wal`).size).toBeLessThanOrEqual(32);
    const out = native(coveredReadReport(database));
    expect(out).toContain("REFUSED STORAGE_INTEGRITY_ERROR");
    expect(out).toContain("WAL sidecar is not a regular file");
    expect(out).not.toContain("rows=");
  });

  it("serves a killed writer's header-only -wal from the copy, promptly and without writing anything", async () => {
    const database = databasePath(home());
    native(`import {openAndMigrate} from ${moduleUrl("../../src/sqlite/migrator.ts")};
      import {productionMigrationPlan} from ${moduleUrl("../../src/sqlite/migrations.ts")};
      const plan = productionMigrationPlan();
      openAndMigrate(${JSON.stringify(database)}, plan.migrations, { rebuilds: plan.rebuilds }).db.close();
      console.log('seeded');`);
    const marker = `${database}.ready`;
    const script = `import {constants, Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs';
      const db = new Database(${JSON.stringify(database)});
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
      db.exec('BEGIN'); db.exec('UPDATE migration_lock SET id = 1 WHERE id = 1'); db.exec('COMMIT');
      writeFileSync(${JSON.stringify(marker)}, 'READY'); setInterval(() => db.exec('SELECT 1'), 1000);`;
    const child = spawn("bun", ["-e", script], { stdio: "ignore" });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("close", (_code, signal) => resolve(signal)),
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(10);
    expect(existsSync(marker), "the writer must commit before READY").toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await closed).toBe("SIGKILL");
    rmSync(marker);
    // The boundary case: the killed writer's `-wal` truncated to its header.
    truncateSync(`${database}-wal`, 32);
    expect(lstatSync(`${database}-wal`).size).toBe(32);
    const out = native(coveredReadReport(database));
    expect(
      out.startsWith(`memory-copy rows=${String(knownSchemaMaximum())} files=IDENTICAL data_version=STABLE ms=`),
    ).toBe(true);
    const elapsed = Number(out.slice(out.lastIndexOf("=") + 1));
    expect(elapsed).toBeLessThan(5_000);
  });

  it("reads a killed writer's incomplete frame tail through read-only WAL access, without writing anything", async () => {
    const database = databasePath(home());
    native(`import {openAndMigrate} from ${moduleUrl("../../src/sqlite/migrator.ts")};
      import {productionMigrationPlan} from ${moduleUrl("../../src/sqlite/migrations.ts")};
      const plan = productionMigrationPlan();
      openAndMigrate(${JSON.stringify(database)}, plan.migrations, { rebuilds: plan.rebuilds }).db.close();
      console.log('seeded');`);
    const marker = `${database}.ready`;
    const script = `import {constants, Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs';
      const db = new Database(${JSON.stringify(database)});
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
      db.exec('BEGIN'); db.exec('UPDATE migration_lock SET id = 1 WHERE id = 1'); db.exec('COMMIT');
      writeFileSync(${JSON.stringify(marker)}, 'READY'); setInterval(() => db.exec('SELECT 1'), 1000);`;
    const child = spawn("bun", ["-e", script], { stdio: "ignore" });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("close", (_code, signal) => resolve(signal)),
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(10);
    expect(existsSync(marker), "the writer must commit before READY").toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await closed).toBe("SIGKILL");
    rmSync(marker);
    // The header plus part of one frame: longer than the header, no complete frame.
    truncateSync(`${database}-wal`, 2_000);
    expect(lstatSync(`${database}-wal`).size).toBe(2_000);
    const out = native(coveredReadReport(database));
    expect(
      out.startsWith(`readonly-wal rows=${String(knownSchemaMaximum())} files=IDENTICAL data_version=STABLE ms=`),
    ).toBe(true);
  });
});
