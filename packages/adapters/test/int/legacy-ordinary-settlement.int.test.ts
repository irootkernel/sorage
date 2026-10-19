import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { approveDeletion, initializeInstallation, reviseHandoff, SYSTEM_ACTOR } from "@sorage/core";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteIntentLog, executeLegacyIntent } from "../../src/intent-log";
import {
  createSqliteHandoffWriteStore,
  createSqliteRetentionStore,
  createSqliteRevisionStore,
} from "../../src/handoffs";
import { createNodeRetentionPorts, createNodeRevisionPorts } from "../../src/handoff-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { createVaultInitializer } from "../../src/vault";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { migrate, openAndMigrate } from "../../src/sqlite/migrator";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { makeArtifactContentBindings, makeTempDatabase } from "../../src/testkit";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The ordinary mutation paths over the one shared legacy execution boundary
 * (section 3): a dependent unlink defers through the same eligibility the
 * drain uses — reported as the internal non-ok result the core commands
 * already swallow — and every ordinary settlement (completeActivations,
 * completeUnlinks, and the retention completeUnlink) takes the persisted
 * pending row as the authority for the physical target and the event
 * attribution instead of the caller's event metadata.
 */
const INSTALLATION = "1d0a0c9a-1111-4111-8111-1111111111d1";
const PROJECT = "1d0a0c9a-2222-4222-8222-2222222222d2";
const HANDOFF = "1d0a0c9a-3333-4333-8333-3333333333d3";
const ARTIFACT = "1d0a0c9a-4444-4444-8444-4444444444d4";
const RECORD = "1d0a0c9a-5555-4555-8555-5555555555d5";
const KEY = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;
const SHA = "4d".repeat(32);
const TIME = "2026-06-01T00:00:00.000Z";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
afterEach(() => {
  delete process.env.SORAGE_HOME;
});

function fixture(prefix: string) {
  const vault = makeTempVault(prefix);
  cleanups.push(vault.cleanup);
  if (!createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION).ok) {
    throw new Error("fixture init must succeed");
  }
  const database = makeTempDatabase(`${prefix}db-`);
  cleanups.push(database.cleanup);
  const plan = productionMigrationPlan();
  migrate(database.db, plan.migrations, () => TIME, {
    databasePath: database.databasePath,
    rebuilds: plan.rebuilds,
  });
  const db = database.db;
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'ordinary', 'Ordinary', NULL, 'active', ?, ?)",
  ).run(PROJECT, TIME, TIME);
  db.prepare(
    "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Ordinary probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', ?, ?)",
  ).run(HANDOFF, PROJECT, ARTIFACT, TIME, TIME);
  db.prepare(
    "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 6, ?, 0, ?)",
  ).run(RECORD, KEY, SHA, TIME);
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
  ).run(ARTIFACT, HANDOFF, TIME, RECORD);
  db.exec("COMMIT");
  const ledger = createSqliteEventLedger(db);
  const bindings = () =>
    makeArtifactContentBindings({ db, ledger, vaultPath: vault.vaultPath, installationId: INSTALLATION });
  return {
    vaultPath: vault.vaultPath,
    db,
    ledger,
    bindings,
    log: createSqliteIntentLog({ db, installationId: INSTALLATION, events: ledger }),
  };
}

function eventsOf(db: ReturnType<typeof fixture>["db"], type: string) {
  return db
    .prepare("SELECT handoff_id, metadata_json FROM events WHERE event_type = ? ORDER BY created_at, id")
    .all(type) as Array<{ handoff_id: string | null; metadata_json: string }>;
}

describe("the ordinary legacy settlement (section 3)", () => {
  it("derives the completion's target and attribution from the persisted pending row, not the caller event", () => {
    const f = fixture("sorage-ordinary-settle-");
    writeFileSync(join(f.vaultPath, "staging", "staged-1"), "ordinary bytes");
    const activateId = randomUUID();
    expect(
      f.log.record([
        {
          id: activateId,
          op: "activate",
          fromPath: "staging/staged-1",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: TIME,
        },
      ]).ok,
    ).toBe(true);

    const write = createSqliteHandoffWriteStore(f.db, f.ledger, {}, f.bindings());
    // The caller's event metadata deliberately lies about the storage key and
    // the association; the settlement must ignore both.
    const completed = write.completeActivations([
      {
        intentId: activateId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          handoffId: "0d000000-0000-4000-8000-0000000000fa",
          eventType: "ARTIFACT_ACTIVATED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: { storageKey: "artifacts/not-the-persisted-key/x.md", sha256: "0".repeat(64) },
          createdAt: TIME,
        },
      },
    ]);
    expect(completed.ok && completed.value.completed).toBe(1);
    // The persisted to_path pinned the record flip and the event.
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 1,
    });
    const activated = eventsOf(f.db, "ARTIFACT_ACTIVATED");
    expect(activated).toHaveLength(1);
    expect(activated[0]?.handoff_id).toBe(HANDOFF);
    expect(JSON.parse(activated[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY, sha256: SHA });
  });

  it("refuses a wrong-op settlement and keeps exactly-once for unlinks with authoritative attribution", () => {
    const f = fixture("sorage-ordinary-unlink-");
    const unlinkId = randomUUID();
    expect(
      f.log.record([{ id: unlinkId, op: "unlink", fromPath: null, toPath: KEY, artifactId: ARTIFACT, createdAt: TIME }])
        .ok,
    ).toBe(true);
    // A common-owned Memo intent on the same key must never be cleared or
    // evented by an ordinary legacy completion: ownership mismatches leave
    // the row untouched.
    const commonId = randomUUID();
    f.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, 'unlink', NULL, ?, NULL, 'memo', ?, ?, ?, 0)",
      )
      .run(commonId, KEY, HANDOFF, RECORD, TIME);

    const revisions = createSqliteRevisionStore(f.db, f.ledger, {}, f.bindings());
    // A completion expecting the opposite operation is not a winner: nothing
    // clears and nothing appends.
    const mismatched = revisions.completeActivations([
      {
        intentId: unlinkId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          eventType: "ARTIFACT_ACTIVATED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(mismatched.ok && mismatched.value.completed).toBe(0);
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED")).toHaveLength(0);

    // The common-owned row is not this completion's to settle either.
    const commonAttempt = revisions.completeUnlinks([
      {
        intentId: commonId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(commonAttempt.ok && commonAttempt.value.completed).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops WHERE id = ?").get(commonId)).toMatchObject({ c: 1 });

    const first = revisions.completeUnlinks([
      {
        intentId: unlinkId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: { storageKey: "artifacts/caller-lie/x.md" },
          createdAt: TIME,
        },
      },
    ]);
    expect(first.ok && first.value.completed).toBe(1);
    const repeated = revisions.completeUnlinks([
      {
        intentId: unlinkId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(repeated.ok && repeated.value.completed).toBe(0);
    const unlinked = eventsOf(f.db, "ARTIFACT_UNLINKED");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]?.handoff_id).toBe(HANDOFF);
    expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
    // An unlink never carries a content-record state update.
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 0,
    });
  });

  it("keeps a null association and omits the digest when the authoritative Artifact row is gone", () => {
    const f = fixture("sorage-ordinary-gone-");
    writeFileSync(join(f.vaultPath, "staging", "staged-2"), "gone bytes");
    const activateId = randomUUID();
    f.db.exec("PRAGMA foreign_keys = OFF");
    f.db.prepare("DELETE FROM artifacts WHERE id = ?").run(ARTIFACT);
    f.db.exec("PRAGMA foreign_keys = ON");
    expect(
      f.log.record([
        {
          id: activateId,
          op: "activate",
          fromPath: "staging/staged-2",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: TIME,
        },
      ]).ok,
    ).toBe(true);
    const retention = createSqliteRetentionStore(f.db, f.ledger, {}, f.bindings());
    const settled = retention.completeUnlink({
      intentId: activateId,
      artifactId: ARTIFACT,
      event: {
        id: randomUUID(),
        eventType: "ARTIFACT_UNLINKED",
        actor: SYSTEM_ACTOR,
        rowVersion: null,
        metadata: { storageKey: KEY, sha256: "0".repeat(64) },
        createdAt: TIME,
      },
    });
    // The persisted op is activate, so the retention completion is not the
    // winner; the durable attribution rules surface through the drain.
    expect(settled.ok && settled.value.completed).toBe(0);
    const drained = f.log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    const activated = eventsOf(f.db, "ARTIFACT_ACTIVATED");
    expect(activated).toHaveLength(1);
    expect(activated[0]?.handoff_id).toBeNull();
    expect(JSON.parse(activated[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
    // The retained record resolved through the exact-key fallback.
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 1,
    });
  });
});

describe("the ordinary physical wrapper over the shared executor (section 3)", () => {
  it("defers a dependent ordinary unlink, keeps the intent durable, and the real drain finishes it", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-ordinary-defer-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.SORAGE_HOME = home;
    const vault = join(home, "vault");
    const init = initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
      { vaultPath: vault },
    );
    expect(init.ok).toBe(true);
    // The intent log must present the installation identity the real Vault
    // marker carries, exactly as the production drain does.
    const markerInstallation = (
      JSON.parse(readFileSync(join(vault, ".sorage-vault.json"), "utf8")) as { installationId: string }
    ).installationId;
    const databasePath = join(home, "state", "sorage.sqlite3");
    const plan = productionMigrationPlan();
    const setup = openAndMigrate(databasePath, plan.migrations, { rebuilds: plan.rebuilds }).db;
    const oldKey = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;
    setup.exec("BEGIN");
    setup
      .prepare(
        "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'ordinary-defer', 'Ordinary Defer', NULL, 'active', ?, ?)",
      )
      .run(PROJECT, TIME, TIME);
    setup
      .prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 6, ?, 1, ?)",
      )
      .run(RECORD, oldKey, SHA, TIME);
    setup
      .prepare(
        "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
      )
      .run(ARTIFACT, HANDOFF, TIME, RECORD);
    setup
      .prepare(
        "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Defer probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', ?, ?)",
      )
      .run(HANDOFF, PROJECT, ARTIFACT, TIME, TIME);
    // A crash-leftover staged activation still promises the old key.
    setup
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'activate', 'staging/leftover', ?, ?, ?, 0)",
      )
      .run(randomUUID(), oldKey, ARTIFACT, TIME);
    setup.exec("COMMIT");
    setup.close();
    writeFileSync(join(vault, "staging", "leftover"), "leftover activation");

    // The production revision ports' ordinary physical surface: the remove is
    // the exact call the core revise and retention commands make.
    const ports = createNodeRevisionPorts({ env: { SORAGE_HOME: home }, userHome: home });
    const deferred = ports.artifactStore.remove(oldKey);
    expect(deferred.ok).toBe(false);
    if (!deferred.ok) {
      // The internal deferral result the core commands swallow: no fake public
      // pause vocabulary, and the intent stays durable for the drain.
      expect(deferred.error.code).toBe("SERVICE_PAUSED");
      expect(deferred.error.message).toContain("deferred");
    }

    const verify = openSorageDatabase(databasePath);
    try {
      const pendingActivate = verify
        .prepare("SELECT COUNT(*) AS c FROM pending_fs_ops WHERE op = 'activate' AND to_path = ?")
        .get(oldKey) as { c: number };
      expect(pendingActivate.c).toBe(1);
      const unlinkEvents = verify
        .prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_UNLINKED'")
        .get() as { c: number };
      expect(unlinkEvents.c).toBe(0);

      // The real drain finishes the leftover activation first, then a later
      // unlink of the same key proceeds exactly once.
      const ledger = createSqliteEventLedger(verify);
      const log = createSqliteIntentLog({ db: verify, installationId: markerInstallation, events: ledger });
      const drained = log.drain(vault);
      expect(drained.ok).toBe(true);
      // The drain completed the leftover activation: the key exists again and
      // no unlink event landed — the deferred ordinary unlink is still owed.
      expect(existsSync(join(vault, oldKey))).toBe(true);
      const unlinked = verify
        .prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_UNLINKED'")
        .get() as { c: number };
      expect(unlinked.c).toBe(0);
      const activated = verify
        .prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_ACTIVATED'")
        .get() as { c: number };
      expect(activated.c).toBe(1);

      // After the dependency cleared, the same ordinary remove now performs
      // the physical unlink through the shared executor.
      const proceeded = ports.artifactStore.remove(oldKey);
      expect(proceeded.ok).toBe(true);
      expect(existsSync(join(vault, oldKey))).toBe(false);
    } finally {
      verify.close();
    }
  });

  it("preserves owned bytes and promises behind a live move lock and behind a mismatched Vault marker", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-ordinary-guards-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.SORAGE_HOME = home;
    try {
      const vault = join(home, "vault");
      const init = initializeInstallation(
        createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
        { vaultPath: vault },
      );
      expect(init.ok).toBe(true);
      const databasePath = join(home, "state", "sorage.sqlite3");
      const plan = productionMigrationPlan();
      const setup = openAndMigrate(databasePath, plan.migrations, { rebuilds: plan.rebuilds }).db;
      const oldKey = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;
      setup.exec("BEGIN");
      setup
        .prepare(
          "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'ordinary-guards', 'Ordinary Guards', NULL, 'active', ?, ?)",
        )
        .run(PROJECT, TIME, TIME);
      setup
        .prepare(
          "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 6, ?, 1, ?)",
        )
        .run(RECORD, oldKey, SHA, TIME);
      setup
        .prepare(
          "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
        )
        .run(ARTIFACT, HANDOFF, TIME, RECORD);
      setup
        .prepare(
          "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Guards probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', ?, ?)",
        )
        .run(HANDOFF, PROJECT, ARTIFACT, TIME, TIME);
      setup.exec("COMMIT");
      setup.close();
      mkdirSync(join(vault, oldKey.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(vault, oldKey), "owned bytes");

      // A live vault-move lock pauses the ordinary unlink at the filesystem
      // boundary: the owned bytes, the record, and the ledger stand still.
      const lock = join(home, "run", "vault-move.lock");
      mkdirSync(join(home, "run"), { recursive: true });
      writeFileSync(
        lock,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
      );
      try {
        const lockedPorts = createNodeRevisionPorts({ env: { SORAGE_HOME: home }, userHome: home });
        const paused = lockedPorts.artifactStore.remove(oldKey);
        expect(paused.ok).toBe(false);
        if (!paused.ok) expect(paused.error.code).toBe("SERVICE_PAUSED");
        expect(readFileSync(join(vault, oldKey), "utf8")).toBe("owned bytes");
      } finally {
        rmSync(lock, { force: true });
      }

      // A mismatched Vault marker refuses the mutation the same way the
      // ArtifactStore's own guard always has: nothing is removed or evented.
      const markerPath = join(vault, ".sorage-vault.json");
      const markerBefore = readFileSync(markerPath, "utf8");
      const mismatchedMarker = JSON.parse(markerBefore) as { installationId: string };
      mismatchedMarker.installationId = "0f0e0d0c-0000-4000-8000-0000000000ba";
      writeFileSync(markerPath, JSON.stringify(mismatchedMarker));
      try {
        const mismatchedPorts = createNodeRevisionPorts({ env: { SORAGE_HOME: home }, userHome: home });
        const refused = mismatchedPorts.artifactStore.remove(oldKey);
        expect(refused.ok).toBe(false);
        expect(readFileSync(join(vault, oldKey), "utf8")).toBe("owned bytes");
        const verify = openSorageDatabase(databasePath);
        try {
          expect(verify.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
          expect(verify.prepare("SELECT COUNT(*) AS c FROM events").get()).toMatchObject({ c: 0 });
        } finally {
          verify.close();
        }
      } finally {
        writeFileSync(markerPath, markerBefore);
      }
    } finally {
      delete process.env.SORAGE_HOME;
    }
  });

  it("a real core revise cannot clear its dependent unlink, which the drain finishes after repair, and maintenance reaps the retained record", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-ordinary-revise-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.SORAGE_HOME = home;
    const vault = join(home, "vault");
    const init = initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
      { vaultPath: vault },
    );
    expect(init.ok).toBe(true);
    const markerInstallation = (
      JSON.parse(readFileSync(join(vault, ".sorage-vault.json"), "utf8")) as { installationId: string }
    ).installationId;
    const databasePath = join(home, "state", "sorage.sqlite3");
    const plan = productionMigrationPlan();
    const setup = openAndMigrate(databasePath, plan.migrations, { rebuilds: plan.rebuilds }).db;
    const oldKey = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;
    setup.exec("BEGIN");
    setup
      .prepare(
        "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'ordinary-revise', 'Ordinary Revise', NULL, 'active', ?, ?)",
      )
      .run(PROJECT, TIME, TIME);
    // The mandatory current-body verification of the revise now runs against
    // the old Artifact, so the retired-file crash shape keeps its record AND
    // its healthy existing old bytes on disk: the dependency rule, not a
    // corruption refusal, owns the deferred unlink (VLT-023, section 3).
    const oldBody = "origin";
    mkdirSync(join(vault, oldKey.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(vault, oldKey), oldBody);
    setup
      .prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, ?)",
      )
      .run(RECORD, oldKey, oldBody.length, createHash("sha256").update(oldBody).digest("hex"), TIME);
    setup
      .prepare(
        "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
      )
      .run(ARTIFACT, HANDOFF, TIME, RECORD);
    setup
      .prepare(
        "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Revise probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', ?, ?)",
      )
      .run(HANDOFF, PROJECT, ARTIFACT, TIME, TIME);
    // The unresolved dependency: a staged activation still promises the old
    // key, and its staged source is deliberately absent — a real failure.
    setup
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'activate', 'staging/unresolved', ?, ?, ?, 0)",
      )
      .run(randomUUID(), oldKey, ARTIFACT, TIME);
    setup.exec("COMMIT");
    setup.close();

    // The real core revise through the production ports, with a genuine
    // source digest and import: no fabricated activation or manual clears.
    // This coverage specifically checks the new Artifact's activation through
    // the ordinary executor, so the replacement is a small binary body — the
    // file representation at every size (SHR-002).
    const replacement = join(home, "brief-v2.bin");
    writeFileSync(replacement, Buffer.from([0x00, 0x0a, 0xfe, 0xff, 0x7f, 0x33]));
    const ports = createNodeRevisionPorts({ env: { SORAGE_HOME: home }, userHome: home });
    const verifyBody = ports.artifact.verifyArtifactBody.bind(ports.artifact);
    const savedOld = join(home, "saved-old-body");
    let faultInjected = false;
    ports.artifact.verifyArtifactBody = (id, policy) => {
      const verified = verifyBody(id, policy);
      // Keep the mandatory old-body gate real and healthy. Only after its
      // successful close, inject the filesystem loss whose pending activation
      // the ordinary unlink must respect and the real drain must recover.
      if (verified.ok && id === ARTIFACT && !faultInjected) {
        renameSync(join(vault, oldKey), savedOld);
        faultInjected = true;
      }
      return verified;
    };
    const revised = reviseHandoff(ports, {
      handoffId: HANDOFF,
      file: replacement,
      as: undefined,
      asUser: true,
      allowExternalSource: true,
      path: home,
      userHome: home,
    });
    expect(faultInjected).toBe(true);
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.revision).toBe(2);
    expect(revised.value.rowVersion).toBe(2);

    const verify = openSorageDatabase(databasePath);
    try {
      // The logical revision committed; the dependent unlink of the old key
      // could not clear and never physically ran or evented.
      const unlinkRow = verify
        .prepare("SELECT attempts FROM pending_fs_ops WHERE op = 'unlink' AND to_path = ?")
        .get(oldKey) as { attempts: number } | undefined;
      expect(unlinkRow?.attempts).toBe(0);
      expect(
        verify.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_UNLINKED'").get(),
      ).toMatchObject({ c: 0 });
      // The new Artifact activated through the ordinary executor.
      expect(
        verify.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_ACTIVATED'").get(),
      ).toMatchObject({ c: 1 });
      // The revision transaction could not remove the old record: the pending
      // activation still names its exact stored key, so it stays retained.
      expect(verify.prepare("SELECT COUNT(*) AS c FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
        c: 1,
      });
      expect(verify.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE id = ?").get(ARTIFACT)).toMatchObject({ c: 0 });

      // A first real drain meets the genuine failure: the unresolved
      // activation is both-gone and retained, the dependent unlink defers with
      // no attempt, and both promises plus the retained record survive.
      const first = createSqliteIntentLog({
        db: verify,
        installationId: markerInstallation,
        events: createSqliteEventLedger(verify),
      }).drain(vault);
      expect(first.ok).toBe(true);
      const pending = verify.prepare("SELECT op, attempts FROM pending_fs_ops ORDER BY op").all() as Array<{
        op: string;
        attempts: number;
      }>;
      expect(pending.find((row) => row.op === "activate")?.attempts).toBe(1);
      expect(pending.find((row) => row.op === "unlink")?.attempts).toBe(0);
      expect(
        verify.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_UNLINKED'").get(),
      ).toMatchObject({ c: 0 });
      expect(verify.prepare("SELECT COUNT(*) AS c FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
        c: 1,
      });

      // The owned repair arrives; the drain performs the real activation
      // (rename plus parent fsync) and only then the unlink of the old key.
      writeFileSync(join(vault, "staging", "unresolved"), readFileSync(savedOld));
      const second = createSqliteIntentLog({
        db: verify,
        installationId: markerInstallation,
        events: createSqliteEventLedger(verify),
      }).drain(vault);
      expect(second.ok).toBe(true);
      expect(verify.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
      expect(existsSync(join(vault, oldKey))).toBe(false);
      const unlinked = verify
        .prepare("SELECT metadata_json FROM events WHERE event_type = 'ARTIFACT_UNLINKED'")
        .all() as Array<{ metadata_json: string }>;
      expect(unlinked).toHaveLength(1);
      expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toMatchObject({ storageKey: oldKey });
      const activations = verify
        .prepare("SELECT metadata_json FROM events WHERE event_type = 'ARTIFACT_ACTIVATED' AND metadata_json LIKE ?")
        .all(`%${oldKey}%`) as Array<{ metadata_json: string }>;
      expect(activations).toHaveLength(1);
    } finally {
      verify.close();
    }

    // The actual maintenance entrypoint reaps the now-unreferenced retained
    // record through the shared cleanup proof.
    const maintained = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
    }).drainAtStart();
    expect(maintained.ok).toBe(true);
    const final = openSorageDatabase(databasePath);
    try {
      expect(final.prepare("SELECT COUNT(*) AS c FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
        c: 0,
      });
    } finally {
      final.close();
    }
  });
});

describe("the ordinary unlink association preservation (R3.2-M3-P2.1)", () => {
  // The revise coverage asserts the replacement's activation through the
  // ordinary executor, so the replacement is a small binary body: the file
  // representation at every size, never inline (SHR-002).
  const NEW_BODY = Buffer.from([0x10, 0x20, 0x30, 0xfd, 0xfe, 0xff]);

  function seededHome(prefix: string, options: { withDeletionRequest?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.SORAGE_HOME = home;
    const vault = join(home, "vault");
    const init = initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
      { vaultPath: vault },
    );
    expect(init.ok).toBe(true);
    const markerInstallation = (
      JSON.parse(readFileSync(join(vault, ".sorage-vault.json"), "utf8")) as { installationId: string }
    ).installationId;
    const databasePath = join(home, "state", "sorage.sqlite3");
    const plan = productionMigrationPlan();
    const setup = openAndMigrate(databasePath, plan.migrations, { rebuilds: plan.rebuilds }).db;
    const oldKey = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;
    const oldBody = "# Original content\n";
    setup.exec("BEGIN");
    setup
      .prepare(
        "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'assoc', 'Assoc', NULL, 'active', ?, ?)",
      )
      .run(PROJECT, TIME, TIME);
    setup
      .prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, ?)",
      )
      .run(RECORD, oldKey, Buffer.byteLength(oldBody), createHash("sha256").update(oldBody).digest("hex"), TIME);
    setup
      .prepare(
        "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
      )
      .run(ARTIFACT, HANDOFF, TIME, RECORD);
    setup
      .prepare(
        "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Assoc probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', ?, ?)",
      )
      .run(HANDOFF, PROJECT, ARTIFACT, TIME, TIME);
    if (options.withDeletionRequest === true) {
      setup.prepare("UPDATE handoffs SET review_state = 'accepted' WHERE id = ?").run(HANDOFF);
      setup
        .prepare(
          "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at) VALUES (?, ?, 'user', NULL, NULL, 'pending', ?)",
        )
        .run("1d0a0c9a-9999-4999-8999-9999999999d9", HANDOFF, TIME);
    }
    setup.exec("COMMIT");
    setup.close();
    mkdirSync(join(vault, oldKey.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(vault, oldKey), oldBody);
    return { home, vault, databasePath, oldKey, oldBody, markerInstallation };
  }

  it("a clean real revise preserves the per-Handoff ARTIFACT_UNLINKED association after the Artifact row is gone", () => {
    const f = seededHome("sorage-assoc-revise-");
    const replacement = join(f.home, "brief-v2.bin");
    writeFileSync(replacement, NEW_BODY);
    const revised = reviseHandoff(createNodeRevisionPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }), {
      handoffId: HANDOFF,
      file: replacement,
      as: undefined,
      asUser: true,
      allowExternalSource: true,
      path: f.home,
      userHome: f.home,
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;

    const verify = openSorageDatabase(f.databasePath);
    try {
      // The ordinary unlink completed with no dependency: the superseded
      // Artifact row and its record left in the revision transaction, and the
      // physical file left through the ordinary executor.
      expect(verify.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
      expect(existsSync(join(f.vault, f.oldKey))).toBe(false);
      expect(verify.prepare("SELECT COUNT(*) AS c FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
        c: 0,
      });
      // Exactly one ARTIFACT_UNLINKED, associated with the revised Handoff —
      // the 39a participant timeline — with the persisted key and no SHA.
      const unlinked = verify
        .prepare("SELECT handoff_id, metadata_json FROM events WHERE event_type = 'ARTIFACT_UNLINKED'")
        .all() as Array<{ handoff_id: string | null; metadata_json: string }>;
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0]?.handoff_id).toBe(HANDOFF);
      expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toEqual({ storageKey: f.oldKey });
      // The new Artifact activated through the ordinary path with its
      // authoritative association and digest.
      const activated = verify
        .prepare("SELECT handoff_id, metadata_json FROM events WHERE event_type = 'ARTIFACT_ACTIVATED'")
        .all() as Array<{ handoff_id: string | null; metadata_json: string }>;
      expect(activated).toHaveLength(1);
      expect(activated[0]?.handoff_id).toBe(HANDOFF);
      expect(JSON.parse(activated[0]?.metadata_json ?? "{}")).toMatchObject({
        sha256: createHash("sha256").update(NEW_BODY).digest("hex"),
      });
    } finally {
      verify.close();
    }
  });

  it("a real delete-approve preserves the per-Handoff ARTIFACT_UNLINKED association after the Artifact row is gone", () => {
    const f = seededHome("sorage-assoc-delete-", { withDeletionRequest: true });
    const approved = approveDeletion(createNodeRetentionPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }), {
      handoffId: HANDOFF,
      confirm: true,
      asUser: true,
      as: undefined,
      path: f.home,
      userHome: f.home,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    const verify = openSorageDatabase(f.databasePath);
    try {
      expect(verify.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
      expect(existsSync(join(f.vault, f.oldKey))).toBe(false);
      const unlinked = verify
        .prepare("SELECT handoff_id, metadata_json FROM events WHERE event_type = 'ARTIFACT_UNLINKED'")
        .all() as Array<{ handoff_id: string | null; metadata_json: string }>;
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0]?.handoff_id).toBe(HANDOFF);
      expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toEqual({ storageKey: f.oldKey });
    } finally {
      verify.close();
    }
  });

  it("rejects a wrong expected ArtifactID before any clear, keeping the row, attempts, and events untouched", () => {
    const f = fixture("sorage-assoc-mismatch-");
    const unlinkId = randomUUID();
    expect(
      f.log.record([{ id: unlinkId, op: "unlink", fromPath: null, toPath: KEY, artifactId: ARTIFACT, createdAt: TIME }])
        .ok,
    ).toBe(true);
    const revisions = createSqliteRevisionStore(f.db, f.ledger, {}, f.bindings());
    // A different well-formed Artifact id: the completion does not own
    // this pending row.
    const wrongArtifactId = "1d0a0c9a-aaa1-4aa1-8aa1-aaaaaaaaa1a1";
    const settled = revisions.completeUnlinks([
      {
        intentId: unlinkId,
        artifactId: wrongArtifactId,
        event: {
          id: randomUUID(),
          handoffId: HANDOFF,
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(settled.ok && settled.value.completed).toBe(0);
    const pending = f.db.prepare("SELECT attempts FROM pending_fs_ops WHERE id = ?").get(unlinkId) as {
      attempts: number;
    };
    expect(pending.attempts).toBe(0);
    expect(eventsOf(f.db, "ARTIFACT_UNLINKED")).toHaveLength(0);
    // The correct expected ArtifactID then wins normally.
    const winner = revisions.completeUnlinks([
      {
        intentId: unlinkId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          handoffId: HANDOFF,
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(winner.ok && winner.value.completed).toBe(1);
    expect(eventsOf(f.db, "ARTIFACT_UNLINKED")).toHaveLength(1);
  });

  it("settles a context-free legacy null===null row with an honest null association", () => {
    const f = fixture("sorage-assoc-null-null-");
    const unlinkId = randomUUID();
    expect(
      f.log.record([{ id: unlinkId, op: "unlink", fromPath: null, toPath: KEY, artifactId: null, createdAt: TIME }]).ok,
    ).toBe(true);
    const revisions = createSqliteRevisionStore(f.db, f.ledger, {}, f.bindings());
    const settled = revisions.completeUnlinks([
      {
        intentId: unlinkId,
        artifactId: null,
        event: {
          id: randomUUID(),
          handoffId: HANDOFF,
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(settled.ok && settled.value.completed).toBe(1);
    const unlinked = eventsOf(f.db, "ARTIFACT_UNLINKED");
    expect(unlinked).toHaveLength(1);
    // No fabricated association for a context-free row, whatever the event
    // carried: the null===null shape has no trusted context to preserve.
    expect(unlinked[0]?.handoff_id).toBeNull();
    expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
  });

  it("keeps an absent-string event handoff association out of the missing-row fallback", () => {
    const f = fixture("sorage-assoc-no-string-");
    const unlinkId = randomUUID();
    // The Artifact row is gone but the completion event carries no string
    // handoffId: the matched expected ArtifactID alone cannot supply one.
    f.db.exec("PRAGMA foreign_keys = OFF");
    f.db.prepare("DELETE FROM artifacts WHERE id = ?").run(ARTIFACT);
    f.db.exec("PRAGMA foreign_keys = ON");
    expect(
      f.log.record([{ id: unlinkId, op: "unlink", fromPath: null, toPath: KEY, artifactId: ARTIFACT, createdAt: TIME }])
        .ok,
    ).toBe(true);
    const revisions = createSqliteRevisionStore(f.db, f.ledger, {}, f.bindings());
    const settled = revisions.completeUnlinks([
      {
        intentId: unlinkId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(settled.ok && settled.value.completed).toBe(1);
    const unlinked = eventsOf(f.db, "ARTIFACT_UNLINKED");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]?.handoff_id).toBeNull();
  });

  it("a drain winner then a stale ordinary completion appends nothing, and an ordinary winner then a drain keeps the association", () => {
    // Drain-first shape: the drain clears the row with its authoritative
    // association, and the late ordinary completion is not a winner.
    const drainFirst = fixture("sorage-assoc-drain-first-");
    mkdirSync(join(drainFirst.vaultPath, KEY.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(drainFirst.vaultPath, KEY), "bytes");
    const drainId = randomUUID();
    expect(
      drainFirst.log.record([
        { id: drainId, op: "unlink", fromPath: null, toPath: KEY, artifactId: ARTIFACT, createdAt: TIME },
      ]).ok,
    ).toBe(true);
    expect(drainFirst.log.drain(drainFirst.vaultPath).ok).toBe(true);
    const stale = createSqliteRevisionStore(drainFirst.db, drainFirst.ledger, {}, drainFirst.bindings());
    const lateOrdinary = stale.completeUnlinks([
      {
        intentId: drainId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          handoffId: HANDOFF,
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(lateOrdinary.ok && lateOrdinary.value.completed).toBe(0);
    const drained = eventsOf(drainFirst.db, "ARTIFACT_UNLINKED");
    expect(drained).toHaveLength(1);
    expect(drained[0]?.handoff_id).toBe(HANDOFF);

    // Ordinary-first shape: the ordinary winner preserves the association and
    // a following drain over the cleared queue duplicates nothing.
    const ordinaryFirst = fixture("sorage-assoc-ordinary-first-");
    mkdirSync(join(ordinaryFirst.vaultPath, KEY.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(ordinaryFirst.vaultPath, KEY), "bytes");
    const ordinaryId = randomUUID();
    ordinaryFirst.db.exec("PRAGMA foreign_keys = OFF");
    ordinaryFirst.db.prepare("DELETE FROM artifacts WHERE id = ?").run(ARTIFACT);
    ordinaryFirst.db.exec("PRAGMA foreign_keys = ON");
    expect(
      ordinaryFirst.log.record([
        { id: ordinaryId, op: "unlink", fromPath: null, toPath: KEY, artifactId: ARTIFACT, createdAt: TIME },
      ]).ok,
    ).toBe(true);
    expect(
      executeLegacyIntent(ordinaryFirst.db, { op: "unlink", fromPath: null, toPath: KEY }, ordinaryFirst.vaultPath),
    ).toEqual({ ok: true, value: "done" });
    expect(existsSync(join(ordinaryFirst.vaultPath, KEY))).toBe(false);
    const winner = createSqliteRevisionStore(ordinaryFirst.db, ordinaryFirst.ledger, {}, ordinaryFirst.bindings());
    const won = winner.completeUnlinks([
      {
        intentId: ordinaryId,
        artifactId: ARTIFACT,
        event: {
          id: randomUUID(),
          handoffId: HANDOFF,
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: {},
          createdAt: TIME,
        },
      },
    ]);
    expect(won.ok && won.value.completed).toBe(1);
    expect(ordinaryFirst.log.drain(ordinaryFirst.vaultPath).ok).toBe(true);
    const preserved = eventsOf(ordinaryFirst.db, "ARTIFACT_UNLINKED");
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.handoff_id).toBe(HANDOFF);
    expect(JSON.parse(preserved[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
  });
});
