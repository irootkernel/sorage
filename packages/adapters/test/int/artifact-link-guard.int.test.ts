import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AppError,
  backupVerify,
  exportSnapshot,
  initializeInstallation,
  type Result,
  runBackupOnce,
  vaultVerify,
} from "@sorage/core";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createSqliteContentStore, sqliteContentReferences } from "../../src/content-store";
import { createNodeDaemonPorts } from "../../src/daemon-command-ports";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The missing-authoritative-record regressions of the M2 correction (SHR-004,
 * SHR-008, SHR-014, section 35): an INNER JOIN over `artifacts` and
 * `content_records` silently omits an Artifact whose referenced record row is
 * gone, so every checksum census and every physical-GC live-key proof must run
 * the shared content-link guard first and fail closed. Every fixture uses
 * canonical identities with one coherent current Artifact per Handoff; the
 * physical-GC cases keep a surviving healthy file-backed Artifact so the
 * broken proof is a genuinely mixed key set, never the all-empty shortcut. All
 * corruption happens through FKOFF row deletion inside isolated temporary
 * fixtures only — never a real installation — and every assertion drives the
 * real production ports.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

const PROJECT = "0a0b0c9a-1111-4111-8111-1111111111b1";
const HANDOFF_INLINE = "0a0b0c9a-2222-4222-8222-2222222222b2";
const HANDOFF_FILE = "0a0b0c9a-3333-4333-8333-3333333333b3";
const HANDOFF_SECOND_FILE = "0a0b0c9a-4444-4444-8444-4444444444b4";
const INLINE_RECORD = "0a0b0c9a-5555-4555-8555-5555555555b5";
const FILE_RECORD = "0a0b0c9a-6666-4666-8666-6666666666b6";
const SECOND_FILE_RECORD = "0a0b0c9a-7777-4777-8777-7777777777b7";
const INLINE_ARTIFACT = "0a0b0c9a-8888-4888-8888-8888888888b8";
const FILE_ARTIFACT = "0a0b0c9a-9999-4999-8999-9999999999b9";
const SECOND_FILE_ARTIFACT = "0a0b0c9a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INLINE_BODY = "inline link-guard body\n";
const FILE_BODY = "file link-guard bytes\n";
const SECOND_FILE_BODY = "second healthy file bytes\n";
const FILE_KEY = `artifacts/${HANDOFF_FILE}/${FILE_ARTIFACT}/report.md`;
const SECOND_FILE_KEY = `artifacts/${HANDOFF_SECOND_FILE}/${SECOND_FILE_ARTIFACT}/report.md`;
const AGED = new Date(Date.now() - 400 * 24 * 3_600_000);

interface LinkFixture {
  home: string;
  vault: string;
  database: string;
}

function initializedHome(prefix: string): LinkFixture {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  const result = initializeInstallation(ports, { vaultPath: vault });
  if (!result.ok) throw new Error(result.error.message);
  return { home, vault, database: join(home, "state", "sorage.sqlite3") };
}

function sha(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

interface SeedOptions {
  withInline?: boolean;
  withFile?: boolean;
  withSecondFile?: boolean;
  ageFiles?: boolean;
}

/** Coherent per-Handoff relations: every Handoff names exactly its own current Artifact. */
function seedArtifacts(fixture: LinkFixture, options: SeedOptions = {}): void {
  const withInline = options.withInline ?? true;
  const withFile = options.withFile ?? true;
  const withSecondFile = options.withSecondFile ?? false;
  const db = openSorageDatabase(fixture.database);
  try {
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'link-guard', 'Link Guard', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(PROJECT);
    const insertHandoff = db.prepare(
      "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Link guard probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
    );
    const insertRecord = db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, ?, ?, ?, ?, 1, '2026-01-02T00:00:00.000Z')",
    );
    const insertArtifact = db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'report.md', 'report.md', 'text/markdown', NULL, '2026-01-02T00:00:00.000Z', ?)",
    );
    if (withInline) {
      insertHandoff.run(HANDOFF_INLINE, PROJECT, INLINE_ARTIFACT);
      insertRecord.run(INLINE_RECORD, INLINE_BODY, null, Buffer.byteLength(INLINE_BODY), sha(INLINE_BODY));
      insertArtifact.run(INLINE_ARTIFACT, HANDOFF_INLINE, INLINE_RECORD);
    }
    if (withFile) {
      insertHandoff.run(HANDOFF_FILE, PROJECT, FILE_ARTIFACT);
      insertRecord.run(FILE_RECORD, null, FILE_KEY, Buffer.byteLength(FILE_BODY), sha(FILE_BODY));
      insertArtifact.run(FILE_ARTIFACT, HANDOFF_FILE, FILE_RECORD);
    }
    if (withSecondFile) {
      insertHandoff.run(HANDOFF_SECOND_FILE, PROJECT, SECOND_FILE_ARTIFACT);
      insertRecord.run(
        SECOND_FILE_RECORD,
        null,
        SECOND_FILE_KEY,
        Buffer.byteLength(SECOND_FILE_BODY),
        sha(SECOND_FILE_BODY),
      );
      insertArtifact.run(SECOND_FILE_ARTIFACT, HANDOFF_SECOND_FILE, SECOND_FILE_RECORD);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const plant = (key: string, body: string): void => {
    mkdirSync(join(fixture.vault, key.split("/").slice(0, -1).join("/")), { recursive: true });
    const path = join(fixture.vault, key);
    writeFileSync(path, body);
    if (options.ageFiles === true) utimesSync(path, AGED, AGED);
  };
  if (withFile) plant(FILE_KEY, FILE_BODY);
  if (withSecondFile) plant(SECOND_FILE_KEY, SECOND_FILE_BODY);
}

/** A separate fault connection removes record rows; operational connections retain FK enforcement. */
function deleteRecordRows(fixture: LinkFixture, recordIds: string[]): void {
  const fault = openSorageDatabase(fixture.database);
  try {
    fault.exec("PRAGMA foreign_keys = OFF");
    for (const id of recordIds) fault.prepare("DELETE FROM content_records WHERE id = ?").run(id);
  } finally {
    fault.exec("PRAGMA foreign_keys = ON");
    expect(fault.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    fault.close();
  }
}

/** FK-off deletion of Artifact rows on living Handoffs — the isolated partial-loss shapes. */
function breakLivingLink(
  fixture: LinkFixture,
  fault: "artifact-row" | "all-artifact-rows" | "wrong-association",
): void {
  const db = openSorageDatabase(fixture.database);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    if (fault === "all-artifact-rows") {
      db.prepare("DELETE FROM artifacts").run();
    } else if (fault === "artifact-row") {
      db.prepare("DELETE FROM artifacts WHERE id = ?").run(INLINE_ARTIFACT);
    } else {
      db.prepare("UPDATE artifacts SET handoff_id = ? WHERE id = ?").run(HANDOFF_FILE, INLINE_ARTIFACT);
    }
    db.exec("PRAGMA foreign_keys = ON");
  } finally {
    db.close();
  }
}

describe("the living-Handoff link guard across the real fault shapes", () => {
  function git(vault: string, ...args: string[]): string {
    return execFileSync("git", ["-C", vault, ...args], { encoding: "utf8" });
  }

  function inventory(root: string): string {
    const rows: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        if (name === ".git") continue;
        const path = join(directory, name);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          rows.push(`d ${relative(root, path)}`);
          walk(path);
        } else {
          rows.push(`f ${relative(root, path)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
        }
      }
    };
    walk(root);
    return rows.sort().join("\n");
  }

  function runOnce(fixture: LinkFixture) {
    const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home });
    const runPorts = ports.runPorts("manual");
    expect(runPorts.ok).toBe(true);
    if (!runPorts.ok) throw new Error(runPorts.error.message);
    return runBackupOnce(runPorts.value);
  }

  function tableCount(fixture: LinkFixture, sql: string): number {
    const db = openSorageDatabase(fixture.database);
    try {
      return (db.prepare(sql).get() as { c: number }).c;
    } finally {
      db.close();
    }
  }

  it.each(["artifact-row", "all-artifact-rows", "wrong-association"] as const)(
    "refuses doctor, verifies, export, run, and both maintenance entrypoints on %s while nothing is freed",
    (fault) => {
      const fixture = initializedHome(`sorage-link-living-${fault}-`);
      seedArtifacts(fixture, { withInline: true, withFile: true, withSecondFile: true, ageFiles: true });
      expect(runOnce(fixture).ok).toBe(true);
      const snapshots = join(fixture.vault, "snapshots");
      const treeBefore = inventory(snapshots);
      const headBefore = git(fixture.vault, "rev-parse", "HEAD").trim();
      const recordsBefore = tableCount(fixture, "SELECT COUNT(*) AS c FROM content_records");
      const eventsBefore = tableCount(fixture, "SELECT COUNT(*) AS c FROM events");

      const orphan = join(fixture.vault, "artifacts", "unreferenced", "old.bin");
      const cache = join(fixture.home, "state", "fetch-cache", "a".repeat(64));
      for (const path of [orphan, cache]) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, "unreferenced and aged");
        utimesSync(path, AGED, AGED);
      }
      breakLivingLink(fixture, fault);

      const doctor = createNodeDoctorPorts({ userHome: fixture.home });
      const census = doctor.probe("artifacts.checksums");
      expect(census.severity).toBe("blocking");
      expect(census.message).toContain("could not be verified");
      expectRelationshipRefusal(vaultVerifyOutcome(fixture), "Artifact content links");
      expectRelationshipRefusal(backupVerifyOutcome(fixture), "Artifact content links");

      const exportPorts = createNodeBackupCommandPorts({
        env: { SORAGE_HOME: fixture.home },
        userHome: fixture.home,
      }).exportPorts();
      expect(exportPorts.ok).toBe(true);
      if (exportPorts.ok) expectRelationshipRefusal(exportSnapshot(exportPorts.value), "Artifact content links");

      const refused = runOnce(fixture);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        expect(refused.error.message).toContain("could not be verified");
      }
      expect(inventory(snapshots)).toBe(treeBefore);
      expect(git(fixture.vault, "rev-parse", "HEAD").trim()).toBe(headBefore);

      // Both real maintenance entrypoints run drain -> cleanup -> GC in that
      // order: the strengthened proof refuses inside the cleanup transaction,
      // so the orphaned record the surviving-artifact reference provider no
      // longer names must NOT be freed before any census could see the fault.
      for (const drain of [
        () =>
          createNodeVaultCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home }).drainAtStart(),
        () =>
          createNodeBackupCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home }).drainAtStart(),
      ]) {
        const maintained = drain();
        expect(maintained.ok).toBe(false);
        if (!maintained.ok) expect(maintained.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      }
      expect(tableCount(fixture, "SELECT COUNT(*) AS c FROM content_records")).toBe(recordsBefore);
      expect(tableCount(fixture, "SELECT COUNT(*) AS c FROM pending_fs_ops")).toBe(0);
      expect(tableCount(fixture, "SELECT COUNT(*) AS c FROM events")).toBe(eventsBefore);
      expect(readFileSync(join(fixture.vault, FILE_KEY), "utf8")).toBe(FILE_BODY);
      expect(readFileSync(join(fixture.vault, SECOND_FILE_KEY), "utf8")).toBe(SECOND_FILE_BODY);
      for (const path of [orphan, cache]) expect(readFileSync(path, "utf8")).toBe("unreferenced and aged");

      // Exercise the cleanup proof directly with a durable pending promise.
      // No drain runs in this control: guard refusal must precede any provider,
      // record/intent/ledger change or derived-cache/physical cleanup.
      const db = openSorageDatabase(fixture.database);
      try {
        db.prepare(
          "INSERT INTO pending_fs_ops(id,op,from_path,to_path,artifact_id,created_at,attempts) VALUES(?, 'activate','staging/untouched',?,?,?,0)",
        ).run("0a0b0c9a-bbbb-4bbb-8bbb-bbbbbbbbbbbb", FILE_KEY, FILE_ARTIFACT, AGED.toISOString());
        const tables = ["handoffs", "artifacts", "content_records", "events", "pending_fs_ops"];
        const snapshot = () => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        const before = snapshot();
        const marker = JSON.parse(readFileSync(join(fixture.vault, ".sorage-vault.json"), "utf8")) as {
          installationId: string;
        };
        const cleaned = createSqliteContentStore({
          db,
          vaultPath: fixture.vault,
          installationId: marker.installationId,
        }).cleanup(sqliteContentReferences(db), new Date());
        expectRelationshipRefusal(cleaned, "Artifact content links");
        expect(snapshot()).toEqual(before);
      } finally {
        db.close();
      }
      for (const path of [orphan, cache]) expect(readFileSync(path, "utf8")).toBe("unreferenced and aged");
    },
  );

  it("keeps a legitimate tombstone with its Artifact row gone passing the guard", () => {
    const fixture = initializedHome("sorage-link-tombstone-control-");
    seedArtifacts(fixture, { withInline: true, withFile: false });
    const db = openSorageDatabase(fixture.database);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("UPDATE handoffs SET deleted_at = ?, current_artifact_id = NULL WHERE id = ?").run(
        "2026-01-03T00:00:00.000Z",
        HANDOFF_INLINE,
      );
      db.prepare("DELETE FROM artifacts WHERE id = ?").run(INLINE_ARTIFACT);
      db.exec("PRAGMA foreign_keys = ON");
    } finally {
      db.close();
    }
    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("ok");
    expect(vaultVerifyOutcome(fixture).ok).toBe(true);
  });
});

function vaultVerifyOutcome(fixture: LinkFixture) {
  const ports = createNodeVaultCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home });
  const verifyPorts = ports.verifyPorts();
  expect(verifyPorts.ok).toBe(true);
  if (!verifyPorts.ok) throw new Error(verifyPorts.error.message);
  return vaultVerify(verifyPorts.value, { now: new Date() });
}

function backupVerifyOutcome(fixture: LinkFixture) {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home });
  const verifyPorts = ports.verifyPorts();
  expect(verifyPorts.ok).toBe(true);
  if (!verifyPorts.ok) throw new Error(verifyPorts.error.message);
  return backupVerify(verifyPorts.value, { now: new Date() });
}

function expectRelationshipRefusal(result: Result<unknown, AppError>, message = "content record"): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(result.error.message).toContain(message);
    expect(result.error.message).toContain("could not be verified");
  }
}

function expectFailedSweep(fixture: LinkFixture): void {
  // Even a cursor past the damaged Artifact must not hide the broken link.
  const cursor = "artifacts/z";
  const batch = createNodeDaemonPorts({ env: { SORAGE_HOME: fixture.home } }).nextArtifactBatch(cursor, 4096);
  expect(batch.failure?.code).toBe("STORAGE_INTEGRITY_ERROR");
  expect(batch.records).toEqual([]);
  expect(batch.plannedBytes).toBe(0);
  expect(batch.nextCursor).toBe(cursor);
}

describe("the missing-authoritative-record guard across the real verification surfaces", () => {
  it("refuses every census when every authoritative record is missing", () => {
    const fixture = initializedHome("sorage-link-only-");
    seedArtifacts(fixture);
    deleteRecordRows(fixture, [INLINE_RECORD, FILE_RECORD]);

    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("blocking");
    expect(census.message).toContain("content record");
    expect(census.message).toContain("could not be verified");

    expectRelationshipRefusal(vaultVerifyOutcome(fixture));
    expectRelationshipRefusal(backupVerifyOutcome(fixture));
    expectFailedSweep(fixture);
  });

  it("refuses every census on partial loss while a healthy record remains", () => {
    const fixture = initializedHome("sorage-link-partial-");
    seedArtifacts(fixture);
    // Only the file-backed Artifact loses its record; the inline Artifact keeps
    // a complete link — a mixed state the INNER JOIN would have silently
    // shrunk to the healthy half.
    deleteRecordRows(fixture, [FILE_RECORD]);

    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("blocking");
    expect(census.message).toContain(FILE_ARTIFACT);

    expectRelationshipRefusal(vaultVerifyOutcome(fixture));
    expectRelationshipRefusal(backupVerifyOutcome(fixture));
    expectFailedSweep(fixture);
  });

  it("keeps a healthy mixed inline/file installation passing, and an unmaterialized but linked file is not a missing relationship", () => {
    const fixture = initializedHome("sorage-link-healthy-");
    seedArtifacts(fixture);

    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const census = doctor.probe("artifacts.checksums");
    expect(census.severity).toBe("ok");
    expect(census.message).toContain("Every recorded current Artifact exists and matches");
    expect(vaultVerifyOutcome(fixture).ok).toBe(true);
    expect(backupVerifyOutcome(fixture).ok).toBe(true);

    // The file Artifact's link stays complete while its record is deliberately
    // unmaterialized: the census still verifies the materialized inline body
    // and never reports a broken relationship or force-inlines the file.
    const unmaterialized = initializedHome("sorage-link-unmaterialized-");
    seedArtifacts(unmaterialized);
    const db = openSorageDatabase(unmaterialized.database);
    try {
      db.prepare("UPDATE content_records SET materialized = 0 WHERE id = ?").run(FILE_RECORD);
    } finally {
      db.close();
    }
    const stillHealthy = createNodeDoctorPorts({ userHome: unmaterialized.home }).probe("artifacts.checksums");
    expect(stillHealthy.severity).toBe("ok");
    expect(stillHealthy.message).toContain("Every recorded current Artifact exists and matches");
    expect(vaultVerifyOutcome(unmaterialized).ok).toBe(true);
  });
});

describe("the real backup boundaries refuse relationship loss without touching the previous snapshot", () => {
  function git(vault: string, ...args: string[]): string {
    return execFileSync("git", ["-C", vault, ...args], { encoding: "utf8" });
  }

  function inventory(root: string): string {
    const rows: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        if (name === ".git") continue;
        const path = join(directory, name);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          rows.push(`d ${relative(root, path)}`);
          walk(path);
        } else {
          rows.push(`f ${relative(root, path)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
        }
      }
    };
    walk(root);
    return rows.sort().join("\n");
  }

  function runOnce(fixture: LinkFixture) {
    const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home });
    const runPorts = ports.runPorts("manual");
    expect(runPorts.ok).toBe(true);
    if (!runPorts.ok) throw new Error(runPorts.error.message);
    return runBackupOnce(runPorts.value);
  }

  it.each(["all", "partial"])(
    "preserves the snapshot tree and Git HEAD on %s record loss through export and run",
    (loss) => {
      // The M2 format-3 snapshot represents file-backed Artifacts only, so the
      // healthy baseline uses coherent file-only Artifacts.
      const fixture = initializedHome("sorage-link-backup-run-");
      seedArtifacts(fixture, { withInline: false, withFile: true, withSecondFile: true });
      expect(runOnce(fixture).ok).toBe(true);

      const snapshots = join(fixture.vault, "snapshots");
      const treeBefore = inventory(snapshots);
      const headBefore = git(fixture.vault, "rev-parse", "HEAD").trim();

      deleteRecordRows(fixture, loss === "all" ? [FILE_RECORD, SECOND_FILE_RECORD] : [FILE_RECORD]);

      // The direct export boundary refuses first, through the production export
      // ports' own consistent read transaction — no earlier drain can mask it.
      const exportPorts = createNodeBackupCommandPorts({
        env: { SORAGE_HOME: fixture.home },
        userHome: fixture.home,
      }).exportPorts();
      expect(exportPorts.ok).toBe(true);
      if (exportPorts.ok) expectRelationshipRefusal(exportSnapshot(exportPorts.value));

      // The full run path refuses the same loss explicitly and leaves the
      // previous verified state exactly as it was: no snapshot replacement, no
      // new commit.
      const refused = runOnce(fixture);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        expect(refused.error.message).toContain("could not be verified");
      }
      expect(inventory(snapshots)).toBe(treeBefore);
      expect(git(fixture.vault, "rev-parse", "HEAD").trim()).toBe(headBefore);
    },
  );
});

describe("physical GC skips when the current key proof is a broken mixed set", () => {
  function plantOrphan(fixture: LinkFixture): string {
    const orphan = join(fixture.vault, "artifacts", "h-link-guard-orphan", "old.md");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "orphaned long ago");
    utimesSync(orphan, AGED, AGED);
    return orphan;
  }

  function drainVault(fixture: LinkFixture) {
    return createNodeVaultCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home }).drainAtStart();
  }

  function drainBackup(fixture: LinkFixture) {
    return createNodeBackupCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home }).drainAtStart();
  }

  it.each([
    { name: "vault", drain: drainVault },
    { name: "backup", drain: drainBackup },
  ])("$name GC runs on a healthy mixed proof and skips on partial record loss", ({ drain }) => {
    // Healthy control: both file Artifacts recorded and materialized, one aged
    // orphan no record or intent protects — the collector runs and removes
    // exactly the orphan while both owned files survive whatever their age.
    const healthy = initializedHome("sorage-link-gc-healthy-");
    seedArtifacts(healthy, { withInline: false, withFile: true, withSecondFile: true, ageFiles: true });
    const healthyOrphan = plantOrphan(healthy);
    expect(drain(healthy).ok).toBe(true);
    expect(existsSync(healthyOrphan)).toBe(false);
    expect(readFileSync(join(healthy.vault, FILE_KEY), "utf8")).toBe(FILE_BODY);
    expect(readFileSync(join(healthy.vault, SECOND_FILE_KEY), "utf8")).toBe(SECOND_FILE_BODY);

    // Broken mixed proof: one of the two file records is lost while the other
    // healthy file record keeps the live-key set nonempty — the exact state an
    // INNER JOIN would silently shrink. With no protecting pending intent and
    // both files aged past grace, the invalid proof must skip the collector:
    // the orphan and BOTH owned files survive with their exact bytes.
    const broken = initializedHome("sorage-link-gc-broken-");
    seedArtifacts(broken, { withInline: false, withFile: true, withSecondFile: true, ageFiles: true });
    const brokenOrphan = plantOrphan(broken);
    deleteRecordRows(broken, [FILE_RECORD]);
    expectRelationshipRefusal(drain(broken));
    expect(existsSync(brokenOrphan)).toBe(true);
    expect(readFileSync(join(broken.vault, FILE_KEY), "utf8")).toBe(FILE_BODY);
    expect(readFileSync(join(broken.vault, SECOND_FILE_KEY), "utf8")).toBe(SECOND_FILE_BODY);
  });
});
