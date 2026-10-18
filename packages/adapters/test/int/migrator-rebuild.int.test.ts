import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import {
  asSchemaAdmission,
  type Migration,
  migrate,
  MigrationConnectionError,
  MigrationFailedError,
  MigrationIntegrityError,
  openAndMigrate,
} from "../../src/sqlite/migrator";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { makeTempDatabase } from "../../src/testkit/temp-database";

const tempCleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of tempCleanups) cleanup();
});

function freshDb() {
  const temp = makeTempDatabase();
  tempCleanups.push(temp.cleanup);
  return temp;
}

const TOY_BASE: Migration = {
  version: 1,
  name: "toy-base-v1",
  sql: `
CREATE TABLE toy_parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE toy_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES toy_parent(id));
INSERT INTO toy_parent (id, name) VALUES (1, 'one');
INSERT INTO toy_child (id, parent_id) VALUES (10, 1);
`,
};

const TOY_REBUILD: Migration = {
  version: 2,
  name: "toy-rebuild-v1",
  sql: `
CREATE TABLE toy_parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO toy_parent_new (id, name) SELECT id, name FROM toy_parent;
DROP TABLE toy_parent;
ALTER TABLE toy_parent_new RENAME TO toy_parent;
`,
};

function schemaFingerprint(db: SorageSqlite): string {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{
    type: string;
    name: string;
    sql: string | null;
  }>;
  return JSON.stringify(objects);
}

function history(db: SorageSqlite): Array<{ version: number; name: string }> {
  return db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
    name: string;
  }>;
}

/** Wraps the real factory so tests observe and fault-inject the FK read-backs on the dedicated connection. */
function instrumentedFactory(failFromRead: number | null) {
  const observations: Array<{ connection: number; read: number; value: number; closedAfter: boolean }> = [];
  let reads = 0;
  let connection = 0;
  const factory = (path: string): SorageSqlite => {
    const real = openSorageDatabase(path);
    connection += 1;
    const mine = connection;
    let lastRead: number | null = null;
    const wrapper: SorageSqlite = {
      exec: (sql: string) => real.exec(sql),
      prepare: <Row = Record<string, unknown>>(sql: string) => {
        const statement = real.prepare<Row>(sql);
        if (!/^\s*pragma\s+foreign_keys/i.test(sql)) return statement;
        return {
          all: (...args: unknown[]) => statement.all(...args),
          run: (...args: unknown[]) => statement.run(...args),
          get: (...args: unknown[]) => {
            reads += 1;
            const value = statement.get(...(args as [unknown?, ...unknown[]])) as
              | { foreign_keys?: number }
              | null
              | undefined;
            const observed = value?.foreign_keys ?? 0;
            lastRead = observed;
            if (failFromRead !== null && reads >= failFromRead) {
              observations.push({ connection: mine, read: reads, value: 0, closedAfter: false });
              return { foreign_keys: 0 };
            }
            observations.push({ connection: mine, read: reads, value: observed, closedAfter: false });
            return value;
          },
        };
      },
      close: () => {
        observations.push({ connection: mine, read: -1, value: lastRead ?? -1, closedAfter: true });
        real.close();
      },
    };
    return wrapper;
  };
  return { factory, observations, readCount: () => reads };
}

describe("guarded-entry admission", () => {
  it("refuses an unknown forward applied version before any DDL, leaving the database untouched", () => {
    const temp = freshDb();
    migrate(temp.db, MIGRATIONS, () => "2026-01-01T00:00:00.000Z");
    const before = schemaFingerprint(temp.db);
    temp.db
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (9, 'future', '2026-01-02T00:00:00.000Z')",
      )
      .run();
    const historyBefore = JSON.stringify(history(temp.db));
    let thrown: unknown;
    try {
      migrate(temp.db, MIGRATIONS, () => "2026-01-02T00:00:00.000Z");
    } catch (error) {
      thrown = error;
    }
    const admission = asSchemaAdmission(thrown);
    expect(admission?.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    // Admission only read: the schema fingerprint is unchanged by the refusal
    // (the history row the test itself inserted is the only difference in state).
    expect(schemaFingerprint(temp.db)).toBe(before);
    expect(JSON.stringify(history(temp.db))).toBe(historyBefore);
  });

  it("refuses a prefix hole and a version/name mismatch as integrity failures without DDL", () => {
    const hole = freshDb();
    migrate(hole.db, MIGRATIONS.slice(0, 1));
    hole.db.exec(MIGRATIONS[2]?.sql ?? "");
    hole.db
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, ?, '2026-01-01T00:00:00.000Z')")
      .run(MIGRATIONS[2]?.name ?? "");
    const historyBefore = JSON.stringify(history(hole.db));
    expect(asSchemaAdmission(expectThrow(() => migrate(hole.db, MIGRATIONS)))?.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(JSON.stringify(history(hole.db))).toBe(historyBefore);

    const mismatch = freshDb();
    migrate(mismatch.db, MIGRATIONS.slice(0, 1));
    mismatch.db.prepare("UPDATE schema_migrations SET name = 'wrong-name' WHERE version = 1").run();
    expect(asSchemaAdmission(expectThrow(() => migrate(mismatch.db, MIGRATIONS)))?.code).toBe(
      "STORAGE_INTEGRITY_ERROR",
    );
  });
});

function expectThrow(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected migrate to throw");
}

describe("guarded whole-batch rebuild path", () => {
  it("applies a mixed ordinary and rebuild batch together in one commit with complete history", () => {
    const temp = freshDb();
    const outcome = migrate(temp.db, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", {
      databasePath: temp.databasePath,
      rebuilds: [TOY_REBUILD],
    });
    expect(outcome.appliedVersions).toEqual([1, 2]);
    expect(history(temp.db)).toEqual([
      { version: 1, name: "toy-base-v1" },
      { version: 2, name: "toy-rebuild-v1" },
    ]);
    // The rebuild preserved the copied rows and the FK-dependent child table.
    const parents = temp.db.prepare("SELECT id, name FROM toy_parent ORDER BY id").all() as Array<{
      id: number;
      name: string;
    }>;
    expect(parents).toEqual([{ id: 1, name: "one" }]);
    const violations = temp.db.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toEqual([]);
  });

  it("skips an already-applied rebuild target in-transaction with zero effects and no receipt claim", () => {
    const temp = freshDb();
    const first = migrate(temp.db, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", {
      databasePath: temp.databasePath,
      rebuilds: [TOY_REBUILD],
    });
    expect(first.alreadyUpToDate).toBe(false);
    const fingerprint = schemaFingerprint(temp.db);
    const second = migrate(temp.db, [TOY_BASE], () => "2026-01-02T00:00:00.000Z", {
      databasePath: temp.databasePath,
      rebuilds: [TOY_REBUILD],
    });
    expect(second.appliedVersions).toEqual([]);
    expect(second.alreadyUpToDate).toBe(true);
    expect(schemaFingerprint(temp.db)).toBe(fingerprint);
    expect(history(temp.db)).toHaveLength(2);
  });

  it("rolls back the entire batch and its history when a later ordinary step fails", () => {
    const temp = freshDb();
    migrate(temp.db, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", { databasePath: temp.databasePath });
    const broken: Migration = {
      version: 3,
      name: "toy-broken",
      sql: "CREATE TABLE toy_twice (id INTEGER PRIMARY KEY); CREATE TABLE toy_twice (id INTEGER);",
    };
    let thrown: unknown;
    try {
      migrate(temp.db, [TOY_BASE], () => "2026-01-02T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [TOY_REBUILD, broken],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationFailedError);
    expect((thrown as MigrationFailedError).version).toBe(3);
    // The whole pending batch rolled back: no v2 rebuild effects, no surviving
    // history rows for earlier steps, and no intermediate commit.
    expect(history(temp.db)).toEqual([{ version: 1, name: "toy-base-v1" }]);
    const parents = temp.db.prepare("SELECT id, name FROM toy_parent ORDER BY id").all() as Array<{
      id: number;
      name: string;
    }>;
    expect(parents).toEqual([{ id: 1, name: "one" }]);
    expect(temp.db.prepare("SELECT name FROM sqlite_master WHERE name = 'toy_parent_new'").all()).toEqual([]);
  });

  it("refuses commit and rolls back when the empty foreign_key_check gate finds an orphan", () => {
    const temp = freshDb();
    const orphaning: Migration = {
      version: 2,
      name: "toy-orphan",
      sql: "INSERT INTO toy_child (id, parent_id) VALUES (99, 42);",
    };
    let thrown: unknown;
    try {
      migrate(temp.db, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [orphaning],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationIntegrityError);
    // The base and rebuild were both pending: the failed full-batch check
    // must roll back even the history table and base DDL.
    expect(
      temp.db
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('schema_migrations', 'toy_parent', 'toy_child')")
        .all(),
    ).toEqual([]);
  });

  it("verifies and restores foreign keys on the same dedicated connection on every exit", () => {
    const temp = freshDb();
    const instrument = instrumentedFactory(null);
    migrate(temp.db, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", {
      databasePath: temp.databasePath,
      rebuilds: [TOY_REBUILD],
      connectionFactory: instrument.factory,
    });
    // Read order on the dedicated connection: verify ON after open, verify OFF
    // after disabling, verify ON after restoration — then close.
    const reads = instrument.observations.filter((entry) => entry.read > 0);
    expect(reads.map((entry) => entry.value)).toEqual([1, 0, 1]);
    const closed = instrument.observations.at(-1);
    expect(closed?.closedAfter).toBe(true);
    expect(closed?.value).toBe(1);
  });

  it("reports committed work plus an unusable connection when restoration fails after commit", () => {
    const temp = freshDb();
    const instrument = instrumentedFactory(3);
    let thrown: unknown;
    try {
      migrate(temp.db, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [TOY_REBUILD],
        connectionFactory: instrument.factory,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationConnectionError);
    expect((thrown as MigrationConnectionError).committed).toBe(true);
    expect((thrown as MigrationConnectionError).restorationVerified).toBe(false);
    // The work is genuinely committed: a fresh FK-ON connection reads the history.
    const fresh = openSorageDatabase(temp.databasePath);
    try {
      expect(history(fresh)).toHaveLength(2);
    } finally {
      fresh.close();
    }
    // Every dedicated connection the test created was closed before the throw.
    expect(instrument.observations.filter((entry) => entry.closedAfter)).toHaveLength(1);
  });

  it("reports rolled-back work plus an unusable connection when restoration fails after a step rollback", () => {
    const temp = freshDb();
    migrate(temp.db, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", { databasePath: temp.databasePath });
    const broken: Migration = {
      version: 2,
      name: "toy-broken",
      sql: "CREATE TABLE nope (id INTEGER PRIMARY KEY, bad syntax here",
    };
    const instrument = instrumentedFactory(3);
    let thrown: unknown;
    try {
      migrate(temp.db, [TOY_BASE], () => "2026-01-02T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [broken],
        connectionFactory: instrument.factory,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationConnectionError);
    expect((thrown as MigrationConnectionError).committed).toBe(false);
    expect((thrown as MigrationConnectionError).message).toContain("toy-broken");
    expect(history(temp.db)).toEqual([{ version: 1, name: "toy-base-v1" }]);
  });

  it("replays the guarded path sequentially on a second connection with zero effects", () => {
    const temp = freshDb();
    const other = openSorageDatabase(temp.databasePath);
    try {
      const winner = migrate(other, [TOY_BASE], () => "2026-01-01T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [TOY_REBUILD],
      });
      expect(winner.appliedVersions).toEqual([1, 2]);
      const loser = migrate(temp.db, [TOY_BASE], () => "2026-01-02T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [TOY_REBUILD],
      });
      expect(loser.alreadyUpToDate).toBe(true);
      expect(loser.appliedVersions).toEqual([]);
      expect(history(temp.db)).toHaveLength(2);
    } finally {
      other.close();
    }
  });

  it("runs the guarded path across real processes as the spawned-Bun corroboration", () => {
    const temp = freshDb();
    const script = `
      const { openSorageDatabase } = await import(${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/connection", import.meta.url)))});
      const { migrate } = await import(${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrator", import.meta.url)))});
      const base = ${JSON.stringify(TOY_BASE)};
      const rebuild = ${JSON.stringify(TOY_REBUILD)};
      const db = openSorageDatabase(${JSON.stringify(temp.databasePath)});
      try {
        const outcome = migrate(db, [base], () => "2026-01-01T00:00:00.000Z", { databasePath: ${JSON.stringify(temp.databasePath)}, rebuilds: [rebuild] });
        console.log(JSON.stringify(outcome));
      } finally {
        db.close();
      }
    `;
    const first = spawnSync("bun", ["-e", script], { encoding: "utf8" });
    expect(first.status).toBe(0);
    const parsed = JSON.parse((first.stdout ?? "").trim()) as { appliedVersions: number[] };
    expect(parsed.appliedVersions).toEqual([1, 2]);
  });
});

describe("true overlapping migrator concurrency across live processes", () => {
  const MIGRATOR_URL = fileURLToPath(new URL("../../src/sqlite/migrator", import.meta.url));
  const CONNECTION_URL = fileURLToPath(new URL("../../src/sqlite/connection", import.meta.url));
  const MIGRATIONS_URL = fileURLToPath(new URL("../../src/sqlite/migrations", import.meta.url));

  interface ChildRun {
    status: number | null;
    stdout: string;
    killed: boolean;
  }

  function spawnMigratorChild(input: {
    databasePath: string;
    markerPath: string;
    acquiredPath: string;
    releasePath: string;
    winner: boolean;
    ordinary: boolean;
  }): { run: Promise<ChildRun>; started: Promise<void>; stop: () => void } {
    const body = `
      const { writeFileSync, existsSync } = await import("node:fs");
      const { openSorageDatabase } = await import(${JSON.stringify(CONNECTION_URL)});
      const { migrate } = await import(${JSON.stringify(MIGRATOR_URL)});
      const { MIGRATIONS } = await import(${JSON.stringify(MIGRATIONS_URL)});
      const wrap = (real) => ({
        prepare: (sql) => real.prepare(sql),
        close: () => real.close(),
        exec: (sql) => {
          if (sql !== "BEGIN IMMEDIATE") return real.exec(sql);
          if (!${String(input.winner)}) writeFileSync(${JSON.stringify(input.markerPath)}, "attempting");
          real.exec(sql);
          writeFileSync(${JSON.stringify(input.acquiredPath)}, "acquired");
          if (${String(input.winner)}) {
            writeFileSync(${JSON.stringify(input.markerPath)}, "holding");
            const deadline = Date.now() + 15000;
            while (!existsSync(${JSON.stringify(input.releasePath)})) {
              if (Date.now() > deadline) throw new Error("winner release timed out");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          }
        },
      });
      const db = openSorageDatabase(${JSON.stringify(input.databasePath)});
      try {
        const outcome = ${
          input.ordinary
            ? "migrate(wrap(db), MIGRATIONS)"
            : `migrate(db, [${JSON.stringify(TOY_BASE)}], undefined, {
              databasePath: ${JSON.stringify(input.databasePath)},
              rebuilds: [${JSON.stringify(TOY_REBUILD)}],
              connectionFactory: (path) => wrap(openSorageDatabase(path)),
            })`
        };
        console.log(JSON.stringify(outcome));
      } finally { db.close(); }
    `;
    const child = spawn("bun", ["-e", body], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    let killed = false;
    let finished = false;
    const stop = () => {
      if (!finished) {
        killed = true;
        child.kill("SIGKILL");
      }
    };
    const timeout = setTimeout(stop, 20_000);
    const run = new Promise<ChildRun>((resolve, reject) => {
      child.on("error", (error) => {
        clearTimeout(timeout);
        finished = true;
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timeout);
        finished = true;
        resolve({ status, stdout, killed });
      });
    });
    const started = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (existsSync(input.markerPath)) {
          resolve();
          return;
        }
        if (finished || Date.now() > deadline) {
          stop();
          reject(new Error(`the migrator child never reached its lock marker: ${stdout}`));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    return { run, started, stop };
  }

  it.each([true, false])(
    "serializes overlapping ordinary=%s migrators and re-reads history after the live lock",
    async (ordinary) => {
      const temp = freshDb();
      const releasePath = join(temp.home.home, "release-winner");
      const winner = spawnMigratorChild({
        databasePath: temp.databasePath,
        markerPath: join(temp.home.home, "winner-holding-lock"),
        acquiredPath: join(temp.home.home, "winner-acquired-lock"),
        releasePath,
        winner: true,
        ordinary,
      });
      let loser: ReturnType<typeof spawnMigratorChild> | undefined;
      try {
        await winner.started;
        const loserAcquired = join(temp.home.home, "loser-acquired-lock");
        loser = spawnMigratorChild({
          databasePath: temp.databasePath,
          markerPath: join(temp.home.home, "loser-attempting-lock"),
          acquiredPath: loserAcquired,
          releasePath,
          winner: false,
          ordinary,
        });
        await loser.started;
        // The winner's actual BEGIN IMMEDIATE has returned, while the loser has
        // reached its own BEGIN but cannot acquire it until this explicit release.
        expect(existsSync(loserAcquired)).toBe(false);
        writeFileSync(releasePath, "release");
        const [winnerDone, loserDone] = await Promise.all([winner.run, loser.run]);
        for (const result of [winnerDone, loserDone]) {
          expect(result.killed).toBe(false);
          expect(result.status, result.stdout).toBe(0);
        }
        expect(existsSync(loserAcquired)).toBe(true);
        const winnerOutcome = JSON.parse(winnerDone.stdout.trim()) as { appliedVersions: number[] };
        const loserOutcome = JSON.parse(loserDone.stdout.trim()) as {
          appliedVersions: number[];
          alreadyUpToDate: boolean;
        };
        expect(winnerOutcome.appliedVersions).toEqual(ordinary ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2]);
        expect(loserOutcome).toEqual({ appliedVersions: [], alreadyUpToDate: true });
        expect(history(temp.db)).toHaveLength(ordinary ? 8 : 2);
        expect(temp.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        winner.stop();
        loser?.stop();
        await Promise.allSettled([winner.run, ...(loser ? [loser.run] : [])]);
      }
    },
  );

  it("keeps the ordinary production path byte-identical for the real catalog through openAndMigrate", () => {
    const temp = freshDb();
    const opened = openAndMigrate(temp.databasePath, MIGRATIONS);
    try {
      expect(opened.outcome.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const second = migrate(temp.db, MIGRATIONS, () => "2026-01-02T00:00:00.000Z");
      expect(second.alreadyUpToDate).toBe(true);
      const table = temp.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("content_records");
      const ownerColumn = temp.db
        .prepare("SELECT name FROM pragma_table_info('pending_fs_ops') WHERE name = 'owner_domain'")
        .get() as { name: string } | undefined;
      expect(ownerColumn?.name).toBe("owner_domain");
    } finally {
      opened.db.close();
    }
  });
});
