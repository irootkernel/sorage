import * as sqlite from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeInstallation, parseConfigurationFile, runDoctor } from "@sorage/core";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeDoctorPorts } from "../../src/doctor";
import { MIGRATIONS, productionMigrationPlan } from "../../src/sqlite/migrations";
import { openAndMigrate, asSchemaAdmission, readAppliedRows } from "../../src/sqlite/migrator";
import * as connections from "../../src/sqlite/connection";
import * as inspection from "../../src/sqlite/history-inspection";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(initialized = false) {
  const home = mkdtempSync(join(tmpdir(), "sorage-readonly-admission-"));
  roots.push(home);
  mkdirSync(join(home, "state"));
  const database = join(home, "state/sorage.sqlite3");
  if (initialized) {
    const result = initializeInstallation(createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home }), {
      vaultPath: join(home, "vault"),
    });
    if (!result.ok) throw new Error(result.error.message);
  }
  return { home, database };
}
function seed(database: string, count?: number) {
  // Without an explicit count the fixture seeds the current database through
  // the real production plan including the guarded schema-9 rebuild; an
  // explicit count builds a truthful ordinary-catalog prefix of that version.
  if (count === undefined) {
    const plan = productionMigrationPlan();
    openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds }).db.close();
    return;
  }
  openAndMigrate(database, MIGRATIONS.slice(0, count)).db.close();
}
function edit(database: string, sql: string, journal = "DELETE") {
  const db = new DatabaseSync(database);
  try {
    db.exec(`PRAGMA journal_mode=${journal}`);
    db.exec(sql);
  } finally {
    db.close();
  }
}
const future = "INSERT INTO schema_migrations VALUES(11, 'future', '2026-01-01')";
function doctor(home: string) {
  return createNodeDoctorPorts({ env: { SORAGE_HOME: home }, userHome: home, portProbe: () => false });
}
function expectRefusal(work: () => unknown, code = "STORAGE_SCHEMA_UNSUPPORTED") {
  let error: unknown;
  try {
    work();
  } catch (cause) {
    error = cause;
  }
  expect(asSchemaAdmission(error)?.code).toBe(code);
}
function native(database: string, home?: string) {
  const source =
    home === undefined
      ? `import {openAndMigrate,asSchemaAdmission} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrator.ts", import.meta.url)))};
       import {productionMigrationPlan} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrations.ts", import.meta.url)))};
       const plan=productionMigrationPlan();
       try {const r=openAndMigrate(${JSON.stringify(database)},plan.migrations,{rebuilds:plan.rebuilds});r.db.close();console.log('ok');}
       catch(e){console.log(asSchemaAdmission(e)?.code ?? String(e));}`
      : `import {createNodeDoctorPorts} from ${JSON.stringify(fileURLToPath(new URL("../../src/doctor.ts", import.meta.url)))};
       import {asSchemaAdmission} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrator.ts", import.meta.url)))};
       try {createNodeDoctorPorts({env:{SORAGE_HOME:${JSON.stringify(home)}},userHome:${JSON.stringify(home)}});console.log('ok');}
       catch(e){console.log(asSchemaAdmission(e)?.code ?? String(e));}`;
  const run = spawnSync("bun", ["-e", source], { encoding: "utf8", timeout: 15_000 });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
}

/** The native child performs the real production-plan migration and reports its outcome, not just success. */
function nativeOutcome(database: string): { appliedVersions: number[]; alreadyUpToDate: boolean } {
  const source = `import {openAndMigrate} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrator.ts", import.meta.url)))};
       import {productionMigrationPlan} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrations.ts", import.meta.url)))};
       const plan=productionMigrationPlan();
       const r=openAndMigrate(${JSON.stringify(database)},plan.migrations,{rebuilds:plan.rebuilds});
       console.log(JSON.stringify(r.outcome));r.db.close();`;
  const run = spawnSync("bun", ["-e", source], { encoding: "utf8", timeout: 15_000 });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim()) as { appliedVersions: number[]; alreadyUpToDate: boolean };
}

/** Commit while live, then kill and await close: no writable last-close checkpoint. */
async function orphan(database: string, sql: string, whileLive?: () => void) {
  const marker = `${database}.ready`;
  const script = `import {Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs';
    const db=new Database(${JSON.stringify(database)});
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN');
    db.exec(${JSON.stringify(sql)});db.exec('COMMIT');
    writeFileSync(${JSON.stringify(marker)},'READY');setInterval(()=>db.exec('SELECT 1'),1000);`;
  const child = spawn("bun", ["-e", script], { stdio: "ignore" });
  let exited = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && !exited && Date.now() < deadline) await delay(10);
    expect(existsSync(marker), "child must commit before READY").toBe(true);
    whileLive?.();
    expect(child.kill("SIGKILL")).toBe(true);
    expect((await closed).signal).toBe("SIGKILL");
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  expect(existsSync(`${database}-wal`)).toBe(true);
  expect(readFileSync(`${database}-wal`).length).toBeGreaterThan(0);
}

describe("readonly admission before operational SQLite settings", () => {
  it("enforces actual write denial through the driver alias", () => {
    const { database } = fixture();
    seed(database);
    edit(database, "SELECT 1");
    const before = readFileSync(database);
    const reader = connections.openSorageReadonlyAdmission(database);
    try {
      expect(() => reader.exec(future)).toThrow(/readonly|READONLY/i);
    } finally {
      reader.close();
    }
    const run = spawnSync(
      "bun",
      [
        "-e",
        `
      import {openSorageReadonlyAdmission} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url)))};
      const reader=openSorageReadonlyAdmission(${JSON.stringify(database)});
      try{reader.exec(${JSON.stringify(future)});throw Error('write allowed')}catch(e){console.log(e.code)}finally{reader.close()}`,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe("SQLITE_READONLY");
    expect(readFileSync(database)).toEqual(before);
  });

  it.each([false, true])("refuses future DELETE history before WAL conversion, malformed config=%s", (malformed) => {
    const { home, database } = fixture(true);
    edit(database, future);
    if (malformed) writeFileSync(join(home, "config.yaml"), "{ invalid yaml");
    const before = readFileSync(database);
    expect(before.subarray(18, 20)).toEqual(Buffer.from([1, 1]));
    const plan = productionMigrationPlan();
    expectRefusal(() => openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds }));
    expectRefusal(() => doctor(home));
    expect(native(database)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(native(database, home)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(readFileSync(database)).toEqual(before);
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);
  });

  it("refuses malformed known DELETE history before normalization but retains doctor's catalog", () => {
    const { home, database } = fixture(true);
    edit(database, "UPDATE schema_migrations SET name='wrong-name' WHERE version=4");
    const before = readFileSync(database);
    const plan = productionMigrationPlan();
    expectRefusal(
      () => openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds }),
      "STORAGE_INTEGRITY_ERROR",
    );
    expect(readFileSync(database)).toEqual(before);
    const ports = doctor(home);
    expect(ports.probe("db.migrations")).toMatchObject({
      severity: "blocking",
      message: expect.stringContaining("wrong-name"),
    });
    expect(ports.probe("db.integrity").severity).toBe("ok");
  });

  it("reads a true orphan future from WAL and preserves both files under both drivers and doctor", async () => {
    const { home, database } = fixture(true);
    await orphan(database, future);
    const before = readFileSync(database),
      wal = readFileSync(`${database}-wal`);
    const mainOnly = `${database}.main-only`;
    copyFileSync(database, mainOnly);
    const bare = new DatabaseSync(mainOnly, { readOnly: true });
    try {
      expect(bare.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()).toMatchObject({ n: 10 });
    } finally {
      bare.close();
    }
    const reader = connections.openSorageReadonlyAdmission(database);
    try {
      expect(readAppliedRows(reader).at(-1)?.version).toBe(11);
    } finally {
      reader.close();
    }
    const plan = productionMigrationPlan();
    expectRefusal(() => openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds }));
    expectRefusal(() => doctor(home));
    expect(native(database)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(native(database, home)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    writeFileSync(join(home, "config.yaml"), "{ invalid yaml");
    expect(native(database, home)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(readFileSync(database)).toEqual(before);
    expect(readFileSync(`${database}-wal`)).toEqual(wal);
  });

  it("admits supported orphan WAL and migrates the older prefix without losing committed data", async () => {
    const { database } = fixture();
    seed(database, 7);
    await orphan(database, "UPDATE schema_migrations SET applied_at='orphan-supported' WHERE version=1");
    // The native child performs the actual older-prefix upgrade first: the
    // observed outcome proves the real production plan applied the schema-9
    // rebuild over the orphan-WAL database, not merely that it succeeded.
    const upgraded = nativeOutcome(database);
    expect(upgraded.alreadyUpToDate).toBe(false);
    expect(upgraded.appliedVersions).toEqual([8, 9, 10]);
    const plan = productionMigrationPlan();
    const result = openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds });
    try {
      // The second, already-current opener legitimately reports up-to-date.
      expect(result.outcome.alreadyUpToDate).toBe(true);
      expect(result.outcome.appliedVersions).toEqual([]);
      expect(result.db.prepare("SELECT applied_at FROM schema_migrations WHERE version=1").get()).toMatchObject({
        applied_at: "orphan-supported",
      });
      expect(result.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(result.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({
        version: 10,
      });
      expect(result.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      result.db.close();
    }
  });

  it.each([false, true])("initializes missing/zero-byte files after readonly empty inspection, zero=%s", (zero) => {
    const { database } = fixture();
    if (zero) {
      writeFileSync(database, "");
      const reader = connections.openSorageReadonlyAdmission(database);
      try {
        expect(readAppliedRows(reader)).toEqual([]);
      } finally {
        reader.close();
      }
      expect(readFileSync(database).length).toBe(0);
    }
    const plan = productionMigrationPlan();
    const result = openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds });
    try {
      expect(result.outcome.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(result.db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    } finally {
      result.db.close();
    }
  });

  it("preserves the before-init catalog without opening a future DB", () => {
    const { home, database } = fixture();
    seed(database);
    edit(database, future);
    const before = readFileSync(database);
    const report = runDoctor(doctor(home), join(home, "config.yaml"));
    expect(report.checks).toHaveLength(21);
    expect(report.checks.every((check) => check.severity === "blocking")).toBe(true);
    expect(readFileSync(database)).toEqual(before);
  });

  it("reports unreadable history honestly, including indirect helpers, without a writable retry", () => {
    const { home, database } = fixture(true);
    const config = parseConfigurationFile(readFileSync(join(home, "config.yaml"), "utf8"));
    if (!config.ok) throw new Error(config.error.message);
    config.value.config.gitBackup.enabled = true;
    writeFileSync(join(home, "config.yaml"), JSON.stringify(config.value.config));
    writeFileSync(database, "not a SQLite database");
    const writable = vi.spyOn(connections, "openSorageDatabase");
    const ports = doctor(home);
    expect(ports.probe("db.integrity").severity).toBe("blocking");
    expect(ports.probe("db.migrations").severity).toBe("blocking");
    for (const id of ["bindings.exist", "bindings.nested", "bindings.ambiguous", "backup.schedule"] as const) {
      expect(ports.probe(id)).toMatchObject({
        severity: "warning",
        message: expect.stringMatching(/inspect|unavailable/i),
      });
    }
    expect(ports.probe("config.schema").severity).toBe("ok");
    expect(writable).not.toHaveBeenCalled();
    expect(readFileSync(database, "utf8")).toBe("not a SQLite database");
  });

  it("does not open writable after a failed reader close", () => {
    const { home, database } = fixture(true);
    const real = connections.openSorageReadonlyAdmission;
    vi.spyOn(connections, "openSorageReadonlyAdmission").mockImplementation((path) => {
      const db = real(path);
      return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        close: () => {
          db.close();
          throw new Error("close failed");
        },
      };
    });
    const writable = vi.spyOn(connections, "openSorageDatabase");
    const plan = productionMigrationPlan();
    expect(() => openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds })).toThrow("close failed");
    expect(doctor(home).probe("db.migrations").severity).toBe("blocking");
    expect(writable).not.toHaveBeenCalled();
  });
});

describe("cold-WAL private history capture", () => {
  const cantOpen = () => {
    throw Object.assign(new Error("cold WAL"), { code: "SQLITE_CANTOPEN" });
  };

  it("reopens cold current/older databases and refuses cold future through native Bun", () => {
    const { home, database } = fixture(true);
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(native(database)).toBe("ok");
    expect(native(database, home)).toBe("ok");
    edit(database, future, "WAL");
    expect(existsSync(`${database}-wal`)).toBe(false);
    const before = readFileSync(database);
    expect(native(database)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(native(database, home)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    writeFileSync(join(home, "config.yaml"), "{ invalid yaml");
    expect(native(database, home)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(readFileSync(database)).toEqual(before);
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);
    const older = fixture();
    seed(older.database, 7);
    expect(native(older.database)).toBe("ok");
    const empty = fixture();
    const db = new DatabaseSync(empty.database);
    db.exec("PRAGMA journal_mode=WAL");
    db.close();
    expect(native(empty.database)).toBe("ok");
  });

  it.each([false, true])("preserves doctor duplicate classification with future=%s", (hasFuture) => {
    const { home, database } = fixture(true);
    edit(
      database,
      `ALTER TABLE schema_migrations RENAME TO old_history;
      CREATE TABLE schema_migrations(version INTEGER,name TEXT,applied_at TEXT);
      INSERT INTO schema_migrations SELECT * FROM old_history;
      INSERT INTO schema_migrations SELECT * FROM old_history WHERE version=1;
      DROP TABLE old_history;${hasFuture ? future : ""}`,
      "WAL",
    );
    const before = readFileSync(database);
    if (hasFuture) {
      expect(native(database)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
      expect(native(database, home)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    } else {
      expect(native(database)).toBe("STORAGE_INTEGRITY_ERROR");
      expect(doctor(home).probe("db.migrations")).toMatchObject({
        severity: "blocking",
        message: expect.stringContaining("more than once"),
      });
    }
    expect(readFileSync(database)).toEqual(before);
  });

  it("includes a committed orphan WAL in fallback capture and removes owned scratch", async () => {
    const { database } = fixture();
    seed(database);
    await orphan(database, future);
    const before = readFileSync(database),
      wal = readFileSync(`${database}-wal`);
    const targets: string[] = [];
    const rows = inspection.inspectAppliedHistory(database, {
      openReadonly: cantOpen,
      copyFile: (source, target) => {
        targets.push(target);
        copyFileSync(source, target);
      },
    });
    expect(rows?.at(-1)?.version).toBe(11);
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => !existsSync(dirname(target)))).toBe(true);
    expect(readFileSync(database)).toEqual(before);
    expect(readFileSync(`${database}-wal`)).toEqual(wal);
  });

  it("rejects corrupt input without attempting the copy fallback", () => {
    const { database } = fixture();
    writeFileSync(database, "invalid SQLite bytes");
    const copyFile = vi.fn();
    expect(() => inspection.inspectAppliedHistory(database, { copyFile })).toThrow();
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("rejects non-absence path errors before attempting writable initialization", () => {
    const { database } = fixture();
    writeFileSync(database, "parent file");
    expect(() => connections.databaseFileExists(join(database, "child"))).toThrow(/ENOTDIR/);
    const plan = productionMigrationPlan();
    expect(() => openAndMigrate(join(database, "child"), plan.migrations, { rebuilds: plan.rebuilds })).toThrow(
      /ENOTDIR/,
    );
    expect(readFileSync(database, "utf8")).toBe("parent file");
  });

  it("bounds changing-source capture, cleans every attempt, and never opens the copy", () => {
    const { database } = fixture();
    seed(database);
    let changes = 0;
    const targets: string[] = [];
    const openCopy = vi.fn();
    expect(() =>
      inspection.inspectAppliedHistory(database, {
        openReadonly: cantOpen,
        openCopy,
        copyFile: (source, target) => {
          targets.push(target);
          copyFileSync(source, target);
          if (source === database) edit(database, `PRAGMA user_version=${++changes}`);
        },
      }),
    ).toThrow(/changed/);
    expect(changes).toBe(3);
    expect(openCopy).not.toHaveBeenCalled();
    expect(targets.every((target) => !existsSync(dirname(target)))).toBe(true);
  });

  it.each(["copy", "close", "cleanup"])("never continues operational opening after %s failure", (phase) => {
    const { database } = fixture();
    seed(database);
    const original = inspection.inspectAppliedHistory;
    vi.spyOn(inspection, "inspectAppliedHistory").mockImplementation((path) =>
      original(path, {
        openReadonly: cantOpen,
        ...(phase === "copy"
          ? {
              copyFile: () => {
                throw new Error("copy failure");
              },
            }
          : {}),
        ...(phase === "close"
          ? {
              openCopy: (path: string) => {
                const db = connections.openSorageInspectionCopy(path);
                return {
                  exec: (sql: string) => db.exec(sql),
                  prepare: (sql: string) => db.prepare(sql),
                  close: () => {
                    db.close();
                    throw Object.assign(new Error("close failure"), { code: "ENOENT" });
                  },
                };
              },
            }
          : {}),
        ...(phase === "cleanup"
          ? {
              removeScratch: (path: string) => {
                rmSync(path, { recursive: true, force: true });
                throw new Error("cleanup failure");
              },
            }
          : {}),
      }),
    );
    const writable = vi.spyOn(connections, "openSorageDatabase");
    const plan = productionMigrationPlan();
    expect(() => openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds })).toThrow(`${phase} failure`);
    expect(writable).not.toHaveBeenCalled();
  });
});

it("reads active WAL through native readonly without falling back to a copy", async () => {
  const { database } = fixture();
  seed(database);
  await orphan(database, "UPDATE schema_migrations SET applied_at='live' WHERE version=1", () => {
    const source = `
      import {openSorageReadonlyAdmission} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url)))};
      import {inspectAppliedHistory} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/history-inspection.ts", import.meta.url)))};
      const rows=inspectAppliedHistory(${JSON.stringify(database)},{openCopy:()=>{throw Error('unexpected copy')}});
      const reader=openSorageReadonlyAdmission(${JSON.stringify(database)});
      const statement=reader.prepare('SELECT applied_at FROM schema_migrations WHERE version=1');
      let row;try{row=statement.get()}finally{statement.finalize?.();reader.close()}
      console.log(JSON.stringify({rows:rows.length,appliedAt:row.applied_at}));`;
    const result = spawnSync("bun", ["-e", source], { encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rows: 10, appliedAt: "live" });
  });
});

it("measures native cold opening on the existing 10,000-Handoff metadata seed", () => {
  const { database } = fixture();
  const imports = `
    import {openAndMigrate} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrator.ts", import.meta.url)))};
    import {productionMigrationPlan} from ${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrations.ts", import.meta.url)))};
    const plan=productionMigrationPlan();`;
  const seeded = spawnSync(
    "bun",
    [
      "-e",
      `${imports}
    import {insertHandoffSeed} from ${JSON.stringify(fileURLToPath(new URL("../../src/testkit/seed.ts", import.meta.url)))};
    const seeded=openAndMigrate(${JSON.stringify(database)},plan.migrations,{rebuilds:plan.rebuilds});insertHandoffSeed(seeded.db,10000);seeded.db.close();`,
    ],
    { encoding: "utf8", timeout: 25_000 },
  );
  expect(seeded.status, seeded.stderr).toBe(0);
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    // Prepare a genuinely cold fixture through SQLite's own checkpoint/close,
    // never by unlinking WAL. This preparation is outside the measured call.
    const checkpoint = new DatabaseSync(database);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);
    const measured = spawnSync(
      "bun",
      [
        "-e",
        `${imports}
      const started=performance.now();const current=openAndMigrate(${JSON.stringify(database)},plan.migrations,{rebuilds:plan.rebuilds});
      if(current.db.prepare('SELECT COUNT(*) AS n FROM handoffs').get().n!==10000)throw Error('seed lost');
      current.db.close();console.log(JSON.stringify({elapsedMs:performance.now()-started}));`,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(measured.status, measured.stderr).toBe(0);
    samples.push((JSON.parse(measured.stdout) as { elapsedMs: number }).elapsedMs);
  }
  samples.sort((a, b) => a - b);
  expect(samples[2]).toBeLessThan(500);
  console.info("native cold-open metadata cost:", {
    handoffs: 10_000,
    samplesMs: samples,
    medianMs: samples[2],
    databaseBytes: readFileSync(database).length,
  });
});

it("does not retry factory configuration failure when its unreturned handle also fails to close", () => {
  const { database } = fixture();
  seed(database);
  const setup = Object.assign(new Error("configuration cannot open"), { code: "SQLITE_CANTOPEN" });
  const cleanup = new Error("connection closure failed");
  const handle = {
    exec: () => {
      throw setup;
    },
    close: vi.fn(() => {
      throw cleanup;
    }),
  };
  vi.spyOn(sqlite, "Database").mockImplementation(() => handle as unknown as InstanceType<typeof sqlite.Database>);
  const copy = vi.spyOn(connections, "openSorageInspectionCopy");
  const writable = vi.spyOn(connections, "openSorageDatabase");
  let failure: unknown;
  try {
    const plan = productionMigrationPlan();
    openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([setup, cleanup]);
  expect((failure as Error).cause).toBe(setup);
  expect(handle.close).toHaveBeenCalledOnce();
  expect(copy).not.toHaveBeenCalled();
  expect(writable).not.toHaveBeenCalled();
});
