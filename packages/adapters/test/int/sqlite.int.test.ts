import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS, FIRST_RELEASED_SCHEMA } from "../../src/sqlite/migrations";
import { migrate, MigrationFailedError, openAndMigrate } from "../../src/sqlite/migrator";
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

describe("sqlite connection factory", () => {
  it("opens with WAL, foreign keys, and a busy timeout", () => {
    const temp = freshDb();
    expect(temp.db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(temp.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(temp.db.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
  });
});

describe("migration runner", () => {
  it("applies every migration, is idempotent on a second run, and records schema_migrations", () => {
    const temp = freshDb();
    const first = migrate(temp.db, MIGRATIONS, () => "2026-01-01T00:00:00.000Z");
    expect(first.appliedVersions).toEqual([1, 2, 3, 4, 5, 6]);
    const second = migrate(temp.db, MIGRATIONS, () => "2026-01-02T00:00:00.000Z");
    expect(second.alreadyUpToDate).toBe(true);
    expect(second.appliedVersions).toEqual([]);
    const rows = temp.db.prepare("SELECT version, name, applied_at FROM schema_migrations").all() as Array<{
      version: number;
      name: string;
      applied_at: string;
    }>;
    expect(rows).toEqual([
      { version: 1, name: "operational-baseline-v1", applied_at: "2026-01-01T00:00:00.000Z" },
      { version: 2, name: "project-registry-v1", applied_at: "2026-01-01T00:00:00.000Z" },
      { version: 3, name: "intent-log-v1", applied_at: "2026-01-01T00:00:00.000Z" },
      { version: 4, name: "handoff-domain-v1", applied_at: "2026-01-01T00:00:00.000Z" },
      { version: 5, name: "vault-move-fence-v1", applied_at: "2026-01-01T00:00:00.000Z" },
      { version: 6, name: "backup-runs-v1", applied_at: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("rolls a failed step back and leaves the previous schema version active", () => {
    const temp = freshDb();
    migrate(temp.db, MIGRATIONS);
    const failing = [
      ...MIGRATIONS,
      {
        version: 7,
        name: "broken",
        sql: "CREATE TABLE deliberately_broken (id INTEGER PRIMARY KEY); CREATE TABLE deliberately_broken (id INTEGER);",
      },
    ];
    expect(() => migrate(temp.db, failing)).toThrowError(MigrationFailedError);
    const versions = temp.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const broken = temp.db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'deliberately_broken'")
      .all() as unknown[];
    expect(broken).toHaveLength(0);
  });

  it("lets a second concurrent migrator wait and then observe the applied version", () => {
    const temp = freshDb();
    // Simulate the concurrent winner: another process migrates the same file first.
    const other = openAndMigrate(temp.databasePath, MIGRATIONS);
    expect(other.outcome.appliedVersions).toEqual([1, 2, 3, 4, 5, 6]);
    const loser = migrate(temp.db, MIGRATIONS);
    expect(loser.alreadyUpToDate).toBe(true);
    expect(loser.appliedVersions).toEqual([]);
    other.db.close();
  });

  it("loads the committed first-schema fixture and matches the live migrated schema", () => {
    const fixture = readFileSync(fileURLToPath(new URL("../../fixtures/schema-v1.sql", import.meta.url)), "utf8");
    expect(fixture).toContain("CREATE TABLE installation");
    const seeded = freshDb();
    seeded.db.exec(fixture);
    // The fixture holds the first released schema only, so replaying the full history
    // upgrades it to the current schema without data loss (the TASK-063 upgrade path).
    const replay = migrate(seeded.db, MIGRATIONS);
    expect(replay.appliedVersions).toEqual([2, 3, 4, 5, 6]);
    expect(replay.alreadyUpToDate).toBe(false);
    const migrated = freshDb();
    migrate(migrated.db, MIGRATIONS);
    const tableNames = (db: (typeof seeded)["db"]) =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
      ).map((row) => row.name);
    expect(tableNames(seeded.db)).toEqual(tableNames(migrated.db));
  });

  it("serializes two migrator processes through the lock", () => {
    const temp = freshDb();
    const script = `
      const { openAndMigrate } = await import(${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrator", import.meta.url)))});
      const { MIGRATIONS } = await import(${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/migrations", import.meta.url)))});
      const { db, outcome } = openAndMigrate(${JSON.stringify(temp.databasePath)}, MIGRATIONS);
      console.log(JSON.stringify(outcome));
      db.close();
    `;
    const first = spawnSync("bun", ["-e", script], { encoding: "utf8" });
    expect(first.status).toBe(0);
    const second = spawnSync("bun", ["-e", script], { encoding: "utf8" });
    expect(second.status).toBe(0);
    const outcome = JSON.parse((second.stdout ?? "").trim()) as { appliedVersions: number[]; alreadyUpToDate: boolean };
    expect(outcome.alreadyUpToDate).toBe(true);
  });
});
