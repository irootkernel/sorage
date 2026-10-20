import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeInstallation } from "@sorage/core";
import { sqliteContentReferences, createSqliteContentStore } from "../../src/content-store";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createHomePaths } from "../../src/home";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The TASK-107 legacy-layout regressions of `artifacts.checksums` and the
 * default Artifact content-reference provider (SHR-014, section 35): a
 * legitimate unupgraded schema-8 installation keeps its legacy Artifact
 * checksum census healthy — while `db.migrations` separately reports the
 * ordinary 8-expected-9 finding — a schema-9 installation censuses inline and
 * file-backed Artifacts through their normalized records and reports the
 * actual references, and a schema-9 database that lost the required
 * `artifacts.content_record_id` column is inconsistent rather than legacy.
 * The layout is decided from the applied history and the table's columns, so
 * no missing-column SQL error is ever caught and reclassified.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function initializedHome(prefix: string): { home: string; databasePath: string; vaultPath: string } {
  const home = tempHome(prefix);
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
  if (initialized.ok !== true) throw new Error("fixture initialization failed");
  const paths = createHomePaths({ SORAGE_HOME: home }, home);
  return { home, databasePath: join(paths.stateDir, "sorage.sqlite3"), vaultPath: join(home, "vault") };
}

const LEGACY_BYTES = "legacy doctor bytes\n";
const LEGACY_SHA = createHash("sha256").update(LEGACY_BYTES).digest("hex");
const LEGACY_KEY = "artifacts/h-doc/a-doc/report.md";
const LEGACY_PROJECT = "0123abcd-0000-4000-8000-0000000000d1";
const LEGACY_HANDOFF = "0123abcd-0000-4000-8000-0000000000d2";

/**
 * A real unupgraded schema-8 installation: the retained ordinary catalog 1..8
 * applied to a fresh database file, one materialized legacy Artifact, and its
 * bytes at the Vault key the row records.
 */
function legacySchema8Home(prefix: string, options: { writeFile?: boolean } = {}) {
  const fixture = initializedHome(prefix);
  rmSync(fixture.databasePath, { force: true });
  rmSync(`${fixture.databasePath}-wal`, { force: true });
  rmSync(`${fixture.databasePath}-shm`, { force: true });
  const db = openSorageDatabase(fixture.databasePath);
  migrate(db, MIGRATIONS, () => "2026-01-01T00:00:00.000Z");
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'doctor-legacy', 'Doctor Legacy', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(LEGACY_PROJECT);
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES ('a-doc', ?, ?, 'report.md', 'report.md', 'text/markdown', ?, ?, NULL, 1, '2026-01-02T00:00:00.000Z')",
  ).run(LEGACY_HANDOFF, LEGACY_KEY, Buffer.byteLength(LEGACY_BYTES), LEGACY_SHA);
  db.prepare(
    "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Legacy census', 'user', ?, 'a-doc', 1, 1, 'accepted', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
  ).run(LEGACY_HANDOFF, LEGACY_PROJECT);
  db.exec("COMMIT");
  db.close();
  if (options.writeFile !== false) {
    mkdirSync(join(fixture.vaultPath, "artifacts", "h-doc", "a-doc"), { recursive: true });
    writeFileSync(join(fixture.vaultPath, LEGACY_KEY), LEGACY_BYTES);
  }
  return fixture;
}

const INLINE_BODY = "inline artifact body\n";
const INLINE_SHA = createHash("sha256").update(INLINE_BODY).digest("hex");
const FILE_BODY = "file artifact bytes\n";
const FILE_SHA = createHash("sha256").update(FILE_BODY).digest("hex");
const N9_PROJECT = "0123abcd-0000-4000-8000-0000000000e1";
const N9_HANDOFF = "0123abcd-0000-4000-8000-0000000000e2";
const N9_FILE_KEY = "artifacts/h-doc9/a-file/report.md";
const N9_INLINE_RECORD = "0123abcd-0000-4000-8000-0000000000e3";
const N9_FILE_RECORD = "0123abcd-0000-4000-8000-0000000000e4";

/** A schema-9 installation with one inline and one file-backed current Artifact. */
function normalizedSchema9Home(prefix: string) {
  const fixture = initializedHome(prefix);
  const db = openSorageDatabase(fixture.databasePath);
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'doctor-9', 'Doctor 9', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(N9_PROJECT);
  db.prepare(
    "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Normalized census', 'user', ?, 'a-inline', 1, 1, 'awaiting_recipient', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
  ).run(N9_HANDOFF, N9_PROJECT);
  db.prepare(
    "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, ?, NULL, ?, ?, 1, '2026-01-02T00:00:00.000Z')",
  ).run(N9_INLINE_RECORD, INLINE_BODY, Buffer.byteLength(INLINE_BODY), INLINE_SHA);
  db.prepare(
    "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, '2026-01-02T00:00:00.000Z')",
  ).run(N9_FILE_RECORD, N9_FILE_KEY, Buffer.byteLength(FILE_BODY), FILE_SHA);
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES ('a-inline', ?, 'report.md', 'report.md', 'text/markdown', NULL, '2026-01-02T00:00:00.000Z', ?)",
  ).run(N9_HANDOFF, N9_INLINE_RECORD);
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES ('a-file', ?, 'report.md', 'report.md', 'text/markdown', NULL, '2026-01-02T00:00:00.000Z', ?)",
  ).run(N9_HANDOFF, N9_FILE_RECORD);
  db.exec("COMMIT");
  db.close();
  mkdirSync(join(fixture.vaultPath, "artifacts", "h-doc9", "a-file"), { recursive: true });
  writeFileSync(join(fixture.vaultPath, N9_FILE_KEY), FILE_BODY);
  return fixture;
}

describe("the doctor Artifact census across the adoption boundary", () => {
  it("keeps a legitimate unupgraded schema-8 installation's census healthy and reports no content references", () => {
    const fixture = legacySchema8Home("sorage-doctor-legacy8-");
    const doctor = createNodeDoctorPorts({ userHome: fixture.home });

    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("ok");
    expect(census.message).toContain("Every recorded current Artifact exists and matches");

    const db = openSorageDatabase(fixture.databasePath);
    try {
      const references = sqliteContentReferences(db).domainReferencedRecordIds();
      expect(references.ok && references.value).toEqual([]);
    } finally {
      db.close();
    }

    // The ordinary migration finding is db.migrations' own stable blocking
    // diagnostic; the doctor never upgrades the database to silence it.
    const migrations = doctor.probe("db.migrations");
    expect(migrations.severity).toBe("blocking");
    expect(migrations.message).toContain("at 8, expected 11");
  });

  it("blocks when the owned legacy Artifact file is missing on schema 8", () => {
    const fixture = legacySchema8Home("sorage-doctor-legacy8-missing-", { writeFile: false });
    const doctor = createNodeDoctorPorts({ userHome: fixture.home });

    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("blocking");
    expect(census.message).toContain(LEGACY_KEY);
  });

  it("censuses schema-9 inline and file-backed Artifacts through their records and reports the actual references", () => {
    const fixture = normalizedSchema9Home("sorage-doctor-9-");
    const doctor = createNodeDoctorPorts({ userHome: fixture.home });

    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("ok");
    expect(census.message).toContain("Every recorded current Artifact exists and matches");
    const content = doctor.probe("content.checksums");
    expect(content.severity).toBe("ok");

    const db = openSorageDatabase(fixture.databasePath);
    try {
      const references = sqliteContentReferences(db).domainReferencedRecordIds();
      expect(references.ok).toBe(true);
      if (references.ok) expect(new Set(references.value)).toEqual(new Set([N9_INLINE_RECORD, N9_FILE_RECORD]));
    } finally {
      db.close();
    }

    // Tamper the stored inline text only: the Artifact census turns blocking
    // with the artifact-scoped finding and the content census independently
    // reports the same record mismatch, each from its own check identity.
    const tamper = openSorageDatabase(fixture.databasePath);
    tamper.prepare("UPDATE content_records SET inline_text = 'tampered body\n' WHERE id = ?").run(N9_INLINE_RECORD);
    tamper.close();
    const artifactFinding = doctor.probe("artifacts.checksums");
    expect(artifactFinding.severity).toBe("blocking");
    expect(artifactFinding.message).toContain("inline Artifact body");
    expect(artifactFinding.message).toContain("digests to");
    const contentFinding = doctor.probe("content.checksums");
    expect(contentFinding.severity).toBe("blocking");
    expect(contentFinding.message).toContain("inline content record");
  });

  it("treats a schema-9 database missing the required artifacts column as inconsistent, not legacy", () => {
    const fixture = normalizedSchema9Home("sorage-doctor-9-column-");
    const tamper = openSorageDatabase(fixture.databasePath);
    tamper.exec("PRAGMA foreign_keys = OFF");
    tamper.exec("DROP INDEX IF EXISTS idx_artifacts_content_record");
    tamper.exec("DROP TABLE artifacts");
    tamper.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        imported_from_path TEXT,
        materialized INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    tamper.exec("PRAGMA foreign_keys = ON");
    tamper.close();

    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("blocking");
    expect(census.message).toContain("content_record_id");

    const db = openSorageDatabase(fixture.databasePath);
    try {
      const references = sqliteContentReferences(db).domainReferencedRecordIds();
      expect(references.ok).toBe(false);
      if (!references.ok) expect(references.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    } finally {
      db.close();
    }
  });

  it("treats a schema-9 database missing the artifacts table as inconsistent: the provider refuses and the standalone cleanup rolls back without touching owned data (SHR-004)", () => {
    // Isolated temporary fixture only: FK enforcement is disabled on this one
    // connection to drop a table the foreign-key graph names, never on any
    // real installation.
    const fixture = normalizedSchema9Home("sorage-doctor-9-missing-table-");
    const setup = openSorageDatabase(fixture.databasePath);
    setup
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('0123abcd-0000-4000-8000-0000000000f1', 'activate', 'staging/kept', ?, 'a-file', '2026-01-03T00:00:00.000Z', 0)",
      )
      .run(N9_FILE_KEY);
    setup.close();
    const recordsBefore = fixtureRecords(fixture.databasePath);
    const pendingBefore = pendingRows(fixture.databasePath);
    const fileBytesBefore = readVaultBytes(fixture.vaultPath, N9_FILE_KEY);

    const tamper = openSorageDatabase(fixture.databasePath);
    tamper.exec("PRAGMA foreign_keys = OFF");
    tamper.exec("DROP TABLE artifacts");
    tamper.exec("PRAGMA foreign_keys = ON");
    tamper.close();

    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("blocking");
    expect(census.message).toContain("artifacts table is missing");
    expect(census.message).toContain("could not be verified");

    const db = openSorageDatabase(fixture.databasePath);
    try {
      const references = sqliteContentReferences(db);
      const refused = references.domainReferencedRecordIds();
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("STORAGE_INTEGRITY_ERROR");

      // The standalone cleanup API must treat the refusal as authoritative: it
      // rolls its writer transaction back and preserves every record row, every
      // pending intent, and the owned file bytes exactly.
      const store = createSqliteContentStore({
        db,
        vaultPath: fixture.vaultPath,
        installationId: "11111111-4444-4444-8444-444444444444",
      });
      const cleaned = store.cleanup(references, new Date("2026-06-01T00:00:00.000Z"));
      expect(cleaned.ok).toBe(false);
      if (!cleaned.ok) expect(cleaned.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(fixtureRecords(fixture.databasePath)).toEqual(recordsBefore);
      expect(pendingRows(fixture.databasePath)).toEqual(pendingBefore);
      expect(readVaultBytes(fixture.vaultPath, N9_FILE_KEY)).toEqual(fileBytesBefore);
      // No transaction leaked: a fresh write transaction completes.
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  });
});

function fixtureRecords(databasePath: string): Array<Record<string, unknown>> {
  const db = openSorageDatabase(databasePath);
  try {
    return db.prepare("SELECT * FROM content_records ORDER BY id").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function pendingRows(databasePath: string): Array<Record<string, unknown>> {
  const db = openSorageDatabase(databasePath);
  try {
    return db.prepare("SELECT * FROM pending_fs_ops ORDER BY id").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function readVaultBytes(vaultPath: string, key: string): Buffer {
  return readFileSync(join(vaultPath, key));
}
