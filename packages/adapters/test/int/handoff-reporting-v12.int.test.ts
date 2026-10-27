import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  backupRestore,
  canonicalJson,
  canonicalJsonLine,
  exportSnapshot,
  initializeInstallation,
  sha256OfText,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createSqliteEventLedger } from "../../src/events";
import { createNodeInitPorts } from "../../src/init-ports";
import { createSqliteReviewStore } from "../../src/review-store";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { openAndMigrate, SchemaAdmissionError } from "../../src/sqlite/migrator";
import { unwrap } from "../fixtures/memo-installation";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const HANDOFF = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const RECORD = "44444444-4444-4444-8444-444444444444";
const TIME = "2026-10-27T00:00:00.000Z";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fresh() {
  const home = realpathSync(mkdtempSync("/tmp/sorage-reporting-v12-"));
  homes.push(home);
  const vault = join(home, "vault");
  unwrap(
    initializeInstallation(createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home }), { vaultPath: vault }),
  );
  return { home, vault, database: join(home, "state", "sorage.sqlite3") };
}
function ports(value: ReturnType<typeof fresh>, source?: ReturnType<typeof fresh>) {
  return createNodeBackupCommandPorts({
    env: { SORAGE_HOME: value.home },
    userHome: value.home,
    sourcePath: source?.vault,
  });
}
function seed(db: SorageSqlite, state = "changes_requested") {
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id,slug,display_name,status,created_at,updated_at) VALUES (?,'recipient','Recipient','active',?,?)",
  ).run(PROJECT, TIME, TIME);
  db.prepare(
    "INSERT INTO handoffs (id,title,sender_kind,recipient_project_id,current_artifact_id,revision,row_version,review_state,first_fetched_at,created_at,updated_at) VALUES (?,'Request','user',?,?,1,1,?,?,?,?)",
  ).run(HANDOFF, PROJECT, ARTIFACT, state, TIME, TIME, TIME);
  db.prepare(
    "INSERT INTO content_records (id,inline_text,storage_key,size_bytes,sha256,materialized,created_at) VALUES (?,'body',NULL,4,?,1,?)",
  ).run(RECORD, sha256OfText("body"), TIME);
  db.prepare(
    "INSERT INTO artifacts (id,handoff_id,original_name,stored_name,mime_type,content_record_id,created_at) VALUES (?,?,'request.md','request.md','text/markdown',?,?)",
  ).run(ARTIFACT, HANDOFF, RECORD, TIME);
  db.prepare(
    "INSERT INTO review_notes (handoff_id,author_kind,author_project_id,target_revision,body,created_at,updated_at) VALUES (?,'registered_project',?,1,?,?,?)",
  ).run(HANDOFF, PROJECT, "\uFEFFFeedback\r\n", TIME, TIME);
  db.exec("COMMIT");
}
function reports(db: SorageSqlite) {
  return db
    .prepare(
      "SELECT read_status,read_revision,revision_read_at,processing_status,processing_started_at,processing_completed_at FROM handoffs WHERE id=?",
    )
    .get(HANDOFF);
}

describe("schema12 reporting persistence and snapshot4", () => {
  it.each(["changes_requested", "accepted"])(
    "upgrades schema11 %s without invented evidence and preserves a rollback copy",
    (state) => {
      const home = realpathSync(mkdtempSync("/tmp/sorage-reporting-upgrade-"));
      homes.push(home);
      const database = join(home, "old.sqlite3");
      const plan = productionMigrationPlan();
      const old = plan.migrations.filter((migration) => migration.version <= 11);
      const initial = openAndMigrate(database, old, { rebuilds: plan.rebuilds });
      seed(initial.db, state);
      initial.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      initial.db.close();
      const backup = join(home, "pre-upgrade.sqlite3");
      copyFileSync(database, backup);
      const current = openAndMigrate(database, plan.migrations, { rebuilds: plan.rebuilds });
      expect(current.outcome.appliedVersions).toEqual([12]);
      expect(current.db.prepare("SELECT purpose,active,body FROM review_notes").get()).toEqual({
        purpose: "change_request",
        active: state === "changes_requested" ? 1 : 0,
        body: "\uFEFFFeedback\r\n",
      });
      expect(reports(current.db)).toEqual({
        read_status: "unrecorded",
        read_revision: null,
        revision_read_at: null,
        processing_status: "unrecorded",
        processing_started_at: null,
        processing_completed_at: null,
      });
      expect(current.db.prepare("SELECT first_fetched_at FROM handoffs").get()).toEqual({ first_fetched_at: TIME });
      expect(() => current.db.prepare("UPDATE handoffs SET read_status='read'").run()).toThrow();
      expect(() => current.db.prepare("UPDATE review_notes SET purpose='general',active=1").run()).toThrow();
      expect(() => current.db.prepare("INSERT INTO review_notes SELECT * FROM review_notes").run()).toThrow();
      current.db.close();
      expect(() => openAndMigrate(database, old, { rebuilds: plan.rebuilds })).toThrow(SchemaAdmissionError);
      const rollback = openAndMigrate(backup, old, { rebuilds: plan.rebuilds });
      expect(rollback.db.prepare("SELECT body FROM review_notes").get()).toEqual({ body: "\uFEFFFeedback\r\n" });
      expect(rollback.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: 11,
      });
      rollback.db.close();
    },
  );

  it("round-trips deterministic current reports and one general comment through format4", () => {
    const source = fresh();
    const target = fresh();
    const db = openSorageDatabase(source.database);
    seed(db, "accepted");
    db.prepare("UPDATE review_notes SET purpose='general',active=0").run();
    db.prepare(
      "UPDATE handoffs SET read_status='read',read_revision=1,revision_read_at=?,processing_status='completed',processing_completed_at=?",
    ).run(TIME, TIME);
    const before = reports(db);
    db.close();
    const exp = unwrap(ports(source).exportPorts());
    unwrap(exportSnapshot(exp));
    const manifestFile = join(source.vault, "snapshots/manifest.json");
    const beforeManifest = readFileSync(manifestFile);
    const shardFile = join(source.vault, "snapshots/handoffs", HANDOFF.slice(0, 2), `${HANDOFF}.json`);
    const beforeShard = readFileSync(shardFile);
    const shard = JSON.parse(beforeShard.toString());
    expect(JSON.parse(beforeManifest.toString()).formatVersion).toBe(4);
    expect(shard).not.toHaveProperty("reviewNote");
    expect(shard.comment).toMatchObject({ purpose: "general", active: false });
    unwrap(exportSnapshot(exp));
    expect(readFileSync(manifestFile)).toEqual(beforeManifest);
    expect(readFileSync(shardFile)).toEqual(beforeShard);
    const restoring = unwrap(ports(target, source).restorePorts());
    expect(backupRestore(restoring, { dryRun: true }).ok).toBe(true);
    unwrap(backupRestore(restoring, { dryRun: false }));
    const restored = openSorageDatabase(target.database);
    expect(reports(restored)).toEqual(before);
    expect(restored.prepare("SELECT purpose,active,body FROM review_notes").get()).toEqual({
      purpose: "general",
      active: 0,
      body: "\uFEFFFeedback\r\n",
    });
    const store = createSqliteReviewStore(restored, createSqliteEventLedger(restored));
    expect(unwrap(store.findNote(HANDOFF))).toBeNull();
    unwrap(
      store.applyReviewMutation({
        handoffId: HANDOFF,
        expectedRowVersion: 1,
        reviewState: "changes_requested",
        setReviewEngagedAt: true,
        note: {
          op: "upsert",
          authorKind: "registered_project",
          authorProjectId: PROJECT,
          targetRevision: 1,
          body: "Replaced",
          now: TIME,
        },
        event: {
          id: randomUUID(),
          handoffId: HANDOFF,
          eventType: "REVIEW_NOTE_UPDATED",
          actor: { kind: "registered_project", id: PROJECT },
          rowVersion: 2,
          metadata: { targetRevision: 1, authorKind: "registered_project" },
          createdAt: TIME,
        },
      }),
    );
    expect(restored.prepare("SELECT purpose,active,body FROM review_notes").get()).toEqual({
      purpose: "change_request",
      active: 1,
      body: "Replaced",
    });
    restored.close();
  });

  it.each(["future-target", "duplicate-comment", "bad-status", "bad-timestamp", "tombstone-content"])(
    "rejects malformed %s before changing an empty restore target",
    (defect) => {
      const source = fresh();
      const target = fresh();
      const db = openSorageDatabase(source.database);
      seed(db);
      db.close();
      unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
      const path = join(source.vault, "snapshots/handoffs", HANDOFF.slice(0, 2), `${HANDOFF}.json`);
      const h = JSON.parse(readFileSync(path, "utf8"));
      if (defect === "future-target") h.comment.targetRevision = 2;
      if (defect === "duplicate-comment") h.reviewNote = h.comment;
      if (defect === "bad-status") h.processing.status = "pending";
      if (defect === "bad-timestamp") {
        h.read.status = "read";
        h.read.readAt = "not-a-timestamp";
      }
      if (defect === "tombstone-content") h.deletedAt = TIME;
      writeFileSync(path, canonicalJson(h));
      expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false })).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR" },
      });
      const empty = openSorageDatabase(target.database);
      expect(empty.prepare("SELECT count(*) AS count FROM handoffs").get()).toEqual({ count: 0 });
      expect(empty.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 0 });
      empty.close();
    },
  );

  it("refuses a current read event naming another Artifact before importing any domain rows", () => {
    const source = fresh();
    const target = fresh();
    const db = openSorageDatabase(source.database);
    seed(db);
    db.close();
    unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
    const event = {
      id: randomUUID(),
      handoffId: HANDOFF,
      memoId: null,
      eventType: "HANDOFF_REVISION_READ",
      actorKind: "user",
      actorId: null,
      rowVersion: 1,
      metadata: { revision: 1, artifactId: ARTIFACT },
      createdAt: TIME,
    };
    const eventsFile = join(source.vault, "snapshots/events.jsonl");
    writeFileSync(eventsFile, canonicalJsonLine(event));
    const manifestFile = join(source.vault, "snapshots/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.counts.events = 1;
    writeFileSync(manifestFile, canonicalJson(manifest));
    const restoring = unwrap(ports(target, source).restorePorts());
    expect(backupRestore(restoring, { dryRun: true }).ok).toBe(true);
    event.metadata.artifactId = PROJECT;
    writeFileSync(eventsFile, canonicalJsonLine(event));
    expect(backupRestore(restoring, { dryRun: true })).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_INTEGRITY_ERROR",
        message: "Format-4 reading event Artifact does not match the current Revision",
      },
    });
    expect(backupRestore(restoring, { dryRun: false })).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_INTEGRITY_ERROR",
        message: "Format-4 reading event Artifact does not match the current Revision",
      },
    });
    const empty = openSorageDatabase(target.database);
    for (const table of ["projects", "handoffs", "artifacts", "events", "review_notes"]) {
      expect(empty.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    empty.close();
  });
});
