import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasBlockingCheck,
  initializeInstallation,
  KNOWN_SCHEMA_HISTORY,
  runBackupOnce,
  runDoctor,
  vaultVerify,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { validateChannelContentLinks } from "../../src/content-store";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createNodeInitPorts } from "../../src/init-ports";
import { inspectPreflight } from "../../src/preflight";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { MIGRATIONS, productionMigrationPlan } from "../../src/sqlite/migrations";
import { openAndMigrate, SchemaAdmissionError } from "../../src/sqlite/migrator";
import { openCoveredReadConnection } from "../../src/sqlite/read-admission";
import { FakeClock } from "../../src/testkit/fakes";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";

/**
 * The TASK-123 schema-slot regression (CHN-009, interface 38.7): the version-11
 * slot is replaced in place as `channels-v2`, and a development home holding
 * `11 / channels-v1` is refused through the existing migration-name check on
 * every history-reading surface — the operational admission, the covered
 * read primitive, preflight and doctor — with nothing migrated or converted.
 * The healthy-home half proves the shared content-link guard and the drain,
 * `doctor`, `vault verify` and `backup run` paths over the rebuilt tables,
 * including the rebuilt `(channel_id, seq)` diagnostic identity of a dangling
 * Channel content reference, refused before any deletion under SHR-004.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

const CHANNEL_ID = "1a0b0c9a-1111-4111-8111-1111111111a1";
const RECORD_ID = "1a0b0c9a-2222-4222-8222-2222222222a2";
const STAMP = "2026-10-24T00:00:00.000Z";

function initializedHome(prefix: string): { home: string; vault: string; database: string } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  const result = initializeInstallation(ports, { vaultPath: vault });
  if (!result.ok) throw new Error(result.error.message);
  return { home, vault, database: join(home, "state", "sorage.sqlite3") };
}

/** The storage proof of an unconverted home: main-file bytes plus sidecar state. */
function storageState(database: string): string {
  const main = createHash("sha256").update(readFileSync(database)).digest("hex");
  const sidecar = (suffix: string): string => {
    try {
      const stat = statSync(`${database}${suffix}`);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return "absent";
    }
  };
  return `${main}|wal=${sidecar("-wal")}|shm=${sidecar("-shm")}`;
}

/** Rewrites the applied version-11 row to the unreleased `channels-v1` name: the development home TASK-109 left. */
function renameAppliedSlotToV1(database: string): void {
  const db = openSorageDatabase(database);
  try {
    const row = db.prepare("SELECT name FROM schema_migrations WHERE version = 11").get() as { name: string };
    expect(row.name).toBe("channels-v2");
    db.prepare("UPDATE schema_migrations SET name = 'channels-v1' WHERE version = 11").run();
  } finally {
    db.close();
  }
}

/** Seeds one open Channel, its main and one worker, and a message row whose content record does not exist. */
function seedDanglingReference(fixture: { home: string; database: string }): void {
  const db = openSorageDatabase(fixture.database);
  try {
    db.exec("PRAGMA foreign_keys = Off");
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO channels (id, name, title, state, created_at, closed_at) VALUES (?, ?, NULL, 'open', ?, NULL)",
    ).run(CHANNEL_ID, "dangling-ref", STAMP);
    db.prepare(
      "INSERT INTO channel_participants (channel_id, handle, role, added_at, removed_at) VALUES (?, 'main', 'main', ?, NULL), (?, 'worker-a', 'worker', ?, NULL)",
    ).run(CHANNEL_ID, STAMP, CHANNEL_ID, STAMP);
    db.prepare(
      "INSERT INTO channel_messages (channel_id, seq, sender_handle, kind, to_handle, ref, content_record_id, handled, handled_at, handle_note, created_at) VALUES (?, 1, 'worker-a', 'report', NULL, NULL, ?, 0, NULL, NULL, ?)",
    ).run(CHANNEL_ID, RECORD_ID, STAMP);
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = On");
  } finally {
    db.close();
  }
}

describe("the replaced version-11 slot (channels-v2)", () => {
  it("applies channels-v2 on a fresh home and keeps the catalog equal to the central inventory", () => {
    const fixture = initializedHome("sorage-channels-v2-fresh-");
    const db = openSorageDatabase(fixture.database);
    try {
      const row = db.prepare("SELECT name FROM schema_migrations WHERE version = 11").get() as { name: string };
      expect(row.name).toBe("channels-v2");
      for (const table of ["channels", "channel_participants", "channel_messages"]) {
        expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)).toMatchObject(
          {
            name: table,
          },
        );
      }
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_assignments'").get(),
      ).toBe(undefined);
    } finally {
      db.close();
    }
    const plan = productionMigrationPlan();
    expect(plan.migrations.map((step) => ({ version: step.version, name: step.name }))).toEqual([
      ...MIGRATIONS.map((step) => ({ version: step.version, name: step.name })),
      { version: 11, name: "channels-v2" },
      { version: 12, name: "handoff-reporting-v1" },
    ]);
    const catalog = [
      ...plan.migrations.map((migration) => ({ version: migration.version, name: migration.name })),
      ...plan.rebuilds.map((migration) => ({ version: migration.version, name: migration.name })),
    ].sort((a, b) => a.version - b.version);
    expect(catalog).toEqual([...KNOWN_SCHEMA_HISTORY]);
  });

  it("refuses an 11 / channels-v1 home per surface without migrating or converting it", () => {
    const fixture = initializedHome("sorage-channels-v1-refused-");
    renameAppliedSlotToV1(fixture.database);
    const before = storageState(fixture.database);

    // The operational admission: every mutating composition opens through this
    // path, and the refusal precedes any DDL or write.
    const plan = productionMigrationPlan();
    let operational: unknown;
    try {
      const opened = openAndMigrate(fixture.database, plan.migrations, { rebuilds: plan.rebuilds });
      opened.db.close();
      operational = null;
    } catch (error) {
      operational = error;
    }
    expect(operational).toBeInstanceOf(SchemaAdmissionError);
    const admission = (operational as SchemaAdmissionError).error;
    expect(admission.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(admission.message).toContain("channels-v1");

    // The covered read primitive: the storage-state refusal of RDR-002.
    const covered = openCoveredReadConnection(fixture.database, "channel");
    expect(covered.ok).toBe(false);
    if (!covered.ok) {
      expect(covered.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(covered.error.message).toContain("channels-v1");
    }

    // Preflight completes its assessment with recovery_required and exit 78.
    const preflight = inspectPreflight(fixture.home);
    expect(preflight.status).toBe("recovery_required");

    // Doctor reports the blocking migration-history finding; the CLI exits 1.
    const doctorPorts = createNodeDoctorPorts({ userHome: fixture.home });
    const migrations = doctorPorts.probe("db.migrations");
    expect(migrations.severity).toBe("blocking");
    expect(migrations.message).toContain("channels-v1");
    expect(hasBlockingCheck(runDoctor(doctorPorts, join(fixture.home, "config", "config.yaml")))).toBe(true);

    expect(storageState(fixture.database)).toBe(before);
  });

  it("runs the drain, doctor, vault verify, and backup run paths on a healthy channels-v2 home", () => {
    const fixture = initializedHome("sorage-channels-v2-healthy-");

    // The mutation startup path: the drain's cleanup transactions run the
    // rebuilt content-link guard over the empty rebuilt tables.
    const drained = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
      contentionSurface: "channel",
    }).drainAtStart();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);

    const doctorPorts = createNodeDoctorPorts({ userHome: fixture.home });
    expect(doctorPorts.probe("content.checksums").severity).toBe("ok");

    const verifyPorts = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).verifyPorts();
    expect(verifyPorts.ok).toBe(true);
    if (verifyPorts.ok) expect(vaultVerify(verifyPorts.value, { now: new Date() }).ok).toBe(true);

    const runPorts = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).runPorts("manual");
    expect(runPorts.ok).toBe(true);
    if (runPorts.ok) expect(runBackupOnce(runPorts.value).ok).toBe(true);
  });

  it("refuses a dangling Channel content reference with the rebuilt identity, before any deletion, per surface", () => {
    const fixture = initializedHome("sorage-channels-v2-dangling-");
    seedDanglingReference(fixture);
    const db = openSorageDatabase(fixture.database);
    const eventsBefore = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    const messageBefore = db.prepare("SELECT * FROM channel_messages").all();
    db.close();

    // The guard itself, with the rebuilt (channel_id, seq) diagnostic identity.
    const proof = openSorageDatabase(fixture.database);
    try {
      const guard = validateChannelContentLinks(proof);
      expect(guard.ok).toBe(false);
      if (!guard.ok) {
        expect(guard.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        expect(guard.error.message).toContain(CHANNEL_ID);
        expect(guard.error.message).toContain("1");
        expect(guard.error.details).toEqual({ channelId: CHANNEL_ID, seq: 1, contentRecordId: RECORD_ID });
      }
    } finally {
      proof.close();
    }

    // The command boundary that propagates it: the mutation startup drain
    // (exactly the path `memo add` runs before its own work) refuses with the
    // typed envelope, having deleted nothing.
    const drained = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
      contentionSurface: "channel",
    }).drainAtStart();
    expect(drained.ok).toBe(false);
    if (!drained.ok) {
      expect(drained.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(drained.error.message).toContain("could not be verified");
      expect(drained.error.details).toEqual({ channelId: CHANNEL_ID, seq: 1, contentRecordId: RECORD_ID });
    }

    // Vault verification fails the proof loudly with the identifying message.
    const verifyPorts = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).verifyPorts();
    expect(verifyPorts.ok).toBe(true);
    if (verifyPorts.ok) {
      const verified = vaultVerify(verifyPorts.value, { now: new Date() });
      expect(verified.ok).toBe(false);
      if (!verified.ok) {
        expect(verified.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        expect(verified.error.message).toContain(CHANNEL_ID);
      }
    }

    // Backup run refuses before any snapshot work.
    const runPorts = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).runPorts("manual");
    expect(runPorts.ok).toBe(true);
    if (runPorts.ok) {
      const run = runBackupOnce(runPorts.value);
      expect(run.ok).toBe(false);
      if (!run.ok) expect(run.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    }

    // Doctor consumes the guard's error as a blocking check message, exit 1.
    const doctorPorts = createNodeDoctorPorts({ userHome: fixture.home });
    const census = doctorPorts.probe("content.checksums");
    expect(census.severity).toBe("blocking");
    expect(census.message).toContain(CHANNEL_ID);
    expect(census.message).toContain("1");
    expect(hasBlockingCheck(runDoctor(doctorPorts, join(fixture.home, "config", "config.yaml")))).toBe(true);

    // Nothing was deleted and nothing was appended.
    const after = openSorageDatabase(fixture.database);
    try {
      expect(after.prepare("SELECT * FROM channel_messages").all()).toEqual(messageBefore);
      expect((after.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(eventsBefore);
    } finally {
      after.close();
    }
  });
});
