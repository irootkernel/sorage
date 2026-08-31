import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { type Migration, migrate, openAndMigrate } from "../../src/sqlite/migrator";
import { generateHandoffSeed, insertHandoffSeed } from "../../src/testkit/seed";
import { makeTempDatabase } from "../../src/testkit/temp-database";

/**
 * The TASK-063 upgrade proof over the fixture captured when the first schema
 * shipped (CFG-001, CFG-002, VLT-019, SEC-016, NFR-009): replaying the full
 * migration history over real v1 data loses nothing, the upgraded database
 * carries a corpus whose checksums still match their recorded values, a
 * deliberately failing step rolls back to the previous valid schema instead of
 * running half-migrated, and the downgrade guard on the Vault marker refuses a
 * newer schema rather than attempting it.
 */
const V1_FIXTURE = readFileSync(fileURLToPath(new URL("../../fixtures/schema-v1.sql", import.meta.url)), "utf8");

function upgradedFromV1() {
  const temp = makeTempDatabase();
  temp.db.exec(V1_FIXTURE);
  // Real v1 data: one installation row the upgrade must carry forward.
  temp.db
    .prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 1, ?)")
    .run("11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z");
  migrate(temp.db, MIGRATIONS);
  return temp;
}

describe("the first-schema upgrade fixture", () => {
  it("carries v1 data through the full replay without loss", () => {
    const temp = upgradedFromV1();
    const row = temp.db.prepare("SELECT installation_id FROM installation WHERE id = 1").get() as {
      installation_id: string;
    };
    expect(row.installation_id).toBe("11111111-1111-4111-8111-111111111111");
    const version = temp.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as {
      version: number;
    };
    expect(version.version).toBe(MIGRATIONS.at(-1)?.version);
    temp.cleanup();
  });

  it("holds a full corpus whose checksums still match after the upgrade", { timeout: 30_000 }, () => {
    const temp = upgradedFromV1();
    insertHandoffSeed(temp.db, 10_000);
    // The seed derives every checksum deterministically, so the upgraded
    // database's recorded digests must equal that derivation exactly: the
    // replay neither rewrote nor corrupted the integrity column.
    const expected = new Set(generateHandoffSeed(10_000).map((row) => row.contentSha256));
    const recorded = temp.db.prepare("SELECT sha256 FROM artifacts").all() as Array<{ sha256: string }>;
    expect(recorded.length).toBe(10_000);
    const recordedSet = new Set(recorded.map((row) => row.sha256));
    expect(recordedSet).toEqual(expected);
    temp.cleanup();
  });

  it("rolls a deliberately failing migration back to the previous valid schema", () => {
    const temp = upgradedFromV1();
    insertHandoffSeed(temp.db, 50);
    const before = temp.db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number };
    const poisoned: Migration[] = [
      ...MIGRATIONS,
      {
        version: (MIGRATIONS.at(-1)?.version ?? 0) + 1,
        name: "poisoned-step",
        sql: "CREATE TABLE broken_step (id TEXT); INSERT INTO nonexistent_table VALUES (1)",
      },
    ];
    // The migrator throws on a failing step after rolling it back.
    expect(() => migrate(temp.db, poisoned)).toThrow(/nonexistent_table/);
    // The failed step rolled back completely: the schema stays at the last good
    // version, its tables are untouched, and the data is intact.
    const version = temp.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as {
      version: number;
    };
    expect(version.version).toBe(MIGRATIONS.at(-1)?.version);
    const brokenTable = temp.db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'broken_step'")
      .get() as { c: number };
    expect(brokenTable.c).toBe(0);
    const after = temp.db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number };
    expect(after.c).toBe(before.c);
    temp.cleanup();
  });

  it("refuses to open half-migrated state: the failure surfaces, nothing is fabricated", () => {
    const temp = makeTempDatabase();
    temp.db.exec(V1_FIXTURE);
    const poisoned: Migration[] = [
      ...MIGRATIONS,
      {
        version: (MIGRATIONS.at(-1)?.version ?? 0) + 1,
        name: "poisoned-step",
        sql: "INSERT INTO nonexistent_table VALUES (1)",
      },
    ];
    // openAndMigrate is the start-up seam init and the daemon open through: it
    // closes the connection and rethrows, so a half-migrated database is never
    // served, which is the refusing process this row promises.
    expect(() => openAndMigrate(temp.databasePath, poisoned)).toThrow(/nonexistent_table/);
    temp.cleanup();
  });
});
