import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { ok } from "@sorage/core";
import {
  HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION,
  MIGRATIONS,
  productionMigrationPlan,
} from "../../src/sqlite/migrations";
import {
  asSchemaAdmission,
  MigrationConnectionError,
  type Migration,
  migrate,
  MigrationFailedError,
  openAndMigrate,
} from "../../src/sqlite/migrator";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { createSqliteContentStore, sqliteContentReferences } from "../../src/content-store";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteRevisionStore, type ArtifactContentBindings } from "../../src/handoffs";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { createVaultInitializer } from "../../src/vault";
import { SystemClock } from "@sorage/core";

const INSTALLATION = "11111111-2222-4333-8444-555555555555";

// Canonical v4-shaped hex UUIDs throughout the production-graph fixture; the
// one deliberate exception is the legacy short Artifact id, which the rebuild
// must copy verbatim. The event actor carries the Handoff's actual recorded
// workspace key, the sender provenance of this graph.
const PROJECT = "0123abcd-0000-4000-8000-0000000000f1";
const HANDOFF_WITH_LEGACY_ARTIFACT = "0123abcd-0000-4000-8000-0000000000b1";
const HANDOFF_WITH_PENDING_ARTIFACT = "0123abcd-0000-4000-8000-0000000000b2";
const LEGACY_ARTIFACT_ID = "a1b2c3d4e";
const PENDING_ARTIFACT_ID = "0123abcd-0000-4000-8000-0000000000a2";
const DELETION_REQUEST_ID = "0123abcd-0000-4000-8000-0000000000d1";
const EVENT_ID = "0123abcd-0000-4000-8000-0000000000e1";
const PENDING_OP_ID = "0123abcd-0000-4000-8000-0000000000c1";
const PREEXISTING_RECORD_ID = "0123abcd-0000-4000-8000-0000000000c8";
const MEMO_ID = "0123abcd-0000-4000-8000-0000000000m1";
const MEMO_CREATED_EVENT_ID = "0123abcd-0000-4000-8000-0000000000e2";
const MEMO_UPDATED_EVENT_ID = "0123abcd-0000-4000-8000-0000000000e3";
const MEMO_BODY = "메모 본문\r\nsecond line";
const WORKSPACE_KEY = "ws-key";
const LEGACY_STORAGE_KEY = `artifacts/${HANDOFF_WITH_LEGACY_ARTIFACT}/${LEGACY_ARTIFACT_ID}/report.md`;
// The normalized mutation-store fixture: canonical UUIDs here too, because new
// schema-9 Artifact rows come from the shared UUID generator, never short ids.
const MUTATION_HANDOFF = "0123abcd-0000-4000-8000-0000000000b3";
const MUTATION_OLD_ARTIFACT = "0123abcd-0000-4000-8000-0000000000a1";
const MUTATION_NEW_ARTIFACT = "0123abcd-0000-4000-8000-0000000000a3";
const MUTATION_OLD_STORAGE_KEY = `artifacts/${MUTATION_HANDOFF}/${MUTATION_OLD_ARTIFACT}/one.md`;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

/** The frozen owning-Task slice: later Memo adoption has separate fidelity tests. */
function handoffAdoptionPlan() {
  const current = productionMigrationPlan();
  return {
    migrations: current.migrations.filter((step) => step.version <= 9),
    rebuilds: current.rebuilds.filter((step) => step.version <= 9),
  };
}

function migrateProduction(temp: ReturnType<typeof makeTempDatabase>): void {
  const plan = handoffAdoptionPlan();
  const outcome = migrate(temp.db, plan.migrations, () => "2026-01-01T00:00:00.000Z", {
    databasePath: temp.databasePath,
    rebuilds: plan.rebuilds,
  });
  // migrate returns a MigrationOutcome, never a Result: the batch either
  // reports the versions it applied or throws its typed admission error.
  expect(outcome.alreadyUpToDate).toBe(false);
  expect(outcome.appliedVersions).toContain(9);
}

function schemaObjectDefinitions(db: ReturnType<typeof makeTempDatabase>["db"]): Array<{ name: string; sql: string }> {
  return (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string | null }>
  ).map((object) => ({ name: object.name, sql: (object.sql ?? "").replace(/\s+/g, " ").trim() }));
}

function populatedVersion8(): ReturnType<typeof makeTempDatabase> {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS, () => "2026-01-01T00:00:00.000Z");
  const db = temp.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'recipient', 'Recipient', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(PROJECT);
    const sha = createHash("sha256").update("legacy report\n").digest("hex");
    const receiptJson = JSON.stringify({
      handoffs: [{ id: HANDOFF_WITH_LEGACY_ARTIFACT, storageKey: LEGACY_STORAGE_KEY }],
    });
    for (const [handoffId, artifactId, materialized] of [
      [HANDOFF_WITH_LEGACY_ARTIFACT, LEGACY_ARTIFACT_ID, 1],
      [HANDOFF_WITH_PENDING_ARTIFACT, PENDING_ARTIFACT_ID, 0],
    ] as const) {
      db.prepare(
        "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, 'report.md', 'report.md', 'text/markdown', 15, ?, NULL, ?, '2026-01-02T00:00:00.000Z')",
      ).run(artifactId, handoffId, `artifacts/${handoffId}/${artifactId}/report.md`, sha, materialized);
      db.prepare(
        "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES (?, NULL, NULL, 'Report', 'unregistered_workspace', NULL, ?, '/virtual/ws', ?, ?, 1, 3, 'awaiting_recipient', 0, 0, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
      ).run(handoffId, WORKSPACE_KEY, PROJECT, artifactId);
    }
    db.prepare(
      "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at) VALUES (?, 'registered_project', ?, 1, 'tighten', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')",
    ).run(HANDOFF_WITH_PENDING_ARTIFACT, PROJECT);
    db.prepare(
      "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at) VALUES (?, ?, 'user', NULL, NULL, 'pending', '2026-01-04T00:00:00.000Z')",
    ).run(DELETION_REQUEST_ID, HANDOFF_WITH_LEGACY_ARTIFACT);
    db.prepare(
      "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, NULL, 'HANDOFF_CREATED', 'unregistered_workspace', ?, NULL, ?, '2026-01-02T00:00:01.000Z')",
    ).run(EVENT_ID, HANDOFF_WITH_LEGACY_ARTIFACT, WORKSPACE_KEY, JSON.stringify({ storageKey: LEGACY_STORAGE_KEY }));
    // A nonempty Memo with its associated ledger rows and the trigger-enforced
    // association shape: the Memo event family is the other domain the events
    // table serves, and the rebuild must carry it verbatim too.
    db.prepare(
      "INSERT INTO project_memos (id, project_id, title, body, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by) VALUES (?, ?, '검토 메모', ?, 'open', 2, '2026-01-06T00:00:00.000Z', '2026-01-06T01:00:00.000Z', 'user', 'user', NULL, NULL)",
    ).run(MEMO_ID, PROJECT, MEMO_BODY);
    db.prepare(
      "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, NULL, ?, 'MEMO_CREATED', 'user', NULL, 1, '{}', '2026-01-06T00:00:00.000Z')",
    ).run(MEMO_CREATED_EVENT_ID, MEMO_ID);
    db.prepare(
      "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, NULL, ?, 'MEMO_UPDATED', 'user', NULL, 2, '{}', '2026-01-06T01:00:00.000Z')",
    ).run(MEMO_UPDATED_EVENT_ID, MEMO_ID);
    db.prepare(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'activate', 'staging/s1', ?, ?, '2026-01-02T00:00:02.000Z', 2)",
    ).run(
      PENDING_OP_ID,
      `artifacts/${HANDOFF_WITH_PENDING_ARTIFACT}/${PENDING_ARTIFACT_ID}/report.md`,
      PENDING_ARTIFACT_ID,
    );
    db.prepare(
      "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES ('k1', 'send', 'rh1', ?, '2026-01-02T00:00:00.000Z', '2027-01-02T00:00:00.000Z')",
    ).run(receiptJson);
    // A pre-existing version-8 content record must survive the rebuild untouched.
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, ?, NULL, 4, ?, 1, '2026-01-05T00:00:00.000Z')",
    ).run(PREEXISTING_RECORD_ID, "memo", createHash("sha256").update("memo").digest("hex"));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return temp;
}

describe("schema 9: the guarded Handoff rebuild over a real production graph", () => {
  it("registers version 9 exactly once and never in the ordinary catalog", () => {
    const plan = handoffAdoptionPlan();
    expect(plan.migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.rebuilds.map((migration) => migration.version)).toEqual([9]);
    expect(HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION.name).toBe("handoff-shared-content-v1");
  });

  it("rebuilds a populated version-8 graph preserving every identity, association, and promise", () => {
    const temp = populatedVersion8();
    const before = {
      handoffs: temp.db.prepare("SELECT * FROM handoffs ORDER BY id").all(),
      artifacts: temp.db.prepare("SELECT * FROM artifacts ORDER BY id").all(),
      reviewNotes: temp.db.prepare("SELECT * FROM review_notes ORDER BY handoff_id").all(),
      deletionRequests: temp.db.prepare("SELECT * FROM deletion_requests ORDER BY id").all(),
      events: temp.db.prepare("SELECT * FROM events ORDER BY id").all(),
      pending: temp.db.prepare("SELECT * FROM pending_fs_ops ORDER BY id").all(),
      receipts: temp.db.prepare("SELECT * FROM idempotency_keys ORDER BY key").all(),
      records: temp.db.prepare("SELECT * FROM content_records ORDER BY id").all(),
      memos: temp.db.prepare("SELECT * FROM project_memos ORDER BY id").all(),
      // The exact stored definitions of every index and trigger, not just the
      // names: the rebuild must recreate byte-equivalent DDL for every shared
      // object (whitespace-normalized, since the original catalog and the
      // recreation differ only in statement layout).
      schemaObjects: schemaObjectDefinitions(temp.db),
    };
    // The exact expected production graph: two Handoffs with one Artifact each,
    // one Review Note, one pending Deletion Request, one Handoff event, one Memo
    // with its two associated ledger rows, one owed intent, one retained
    // receipt, and one pre-existing version-8 content record.
    expect(before.handoffs).toHaveLength(2);
    expect(before.artifacts).toHaveLength(2);
    expect(before.reviewNotes).toHaveLength(1);
    expect(before.deletionRequests).toHaveLength(1);
    expect(before.events).toHaveLength(3);
    expect(before.memos).toHaveLength(1);
    expect(before.pending).toHaveLength(1);
    expect(before.receipts).toHaveLength(1);
    expect(before.records).toHaveLength(1);
    migrateProduction(temp);
    const after = {
      handoffs: temp.db.prepare("SELECT * FROM handoffs ORDER BY id").all(),
      reviewNotes: temp.db.prepare("SELECT * FROM review_notes ORDER BY handoff_id").all(),
      deletionRequests: temp.db.prepare("SELECT * FROM deletion_requests ORDER BY id").all(),
      events: temp.db.prepare("SELECT * FROM events ORDER BY id").all(),
      pending: temp.db.prepare("SELECT * FROM pending_fs_ops ORDER BY id").all(),
      receipts: temp.db.prepare("SELECT * FROM idempotency_keys ORDER BY key").all(),
      memos: temp.db.prepare("SELECT * FROM project_memos ORDER BY id").all(),
    };
    expect(after.handoffs).toEqual(before.handoffs);
    expect(after.reviewNotes).toEqual(before.reviewNotes);
    expect(after.deletionRequests).toEqual(before.deletionRequests);
    expect(after.events).toEqual(before.events);
    expect(after.pending).toEqual(before.pending);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.memos).toEqual(before.memos);
    // Mirrors are gone; every Artifact references exactly one record that
    // carries its exact physical columns, and the mapping is one-to-one.
    const artifactColumns = temp.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    for (const removed of ["storage_key", "size_bytes", "sha256", "materialized"]) {
      expect(artifactColumns.some((column) => column.name === removed)).toBe(false);
    }
    expect(artifactColumns.some((column) => column.name === "content_record_id")).toBe(true);
    const joined = temp.db
      .prepare(
        "SELECT a.id AS id, cr.id AS record_id, cr.inline_text AS inline_text, cr.storage_key AS storage_key, cr.size_bytes AS size_bytes, cr.sha256 AS sha256, cr.materialized AS materialized, cr.created_at AS created_at FROM artifacts a JOIN content_records cr ON cr.id = a.content_record_id ORDER BY a.id",
      )
      .all() as Array<Record<string, unknown>>;
    expect(joined).toHaveLength(before.artifacts.length);
    for (const row of joined) {
      const original = (before.artifacts as Array<Record<string, unknown>>).find(
        (candidate) => candidate.id === row.id,
      );
      expect(original).toBeDefined();
      expect(row.inline_text).toBeNull();
      expect(row.storage_key).toBe(original?.storage_key);
      expect(Number(row.size_bytes)).toBe(original?.size_bytes);
      expect(row.sha256).toBe(original?.sha256);
      expect(row.materialized).toBe(original?.materialized);
      expect(row.created_at).toBe(original?.created_at);
      expect(row.record_id).not.toBe(row.id);
      expect(String(row.record_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // The pre-existing version-8 record survives verbatim, and the only new
    // records are the two backfilled ones: exactly one per original Artifact.
    expect(temp.db.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({
      c: before.artifacts.length + 1,
    });
    const survived = temp.db.prepare("SELECT * FROM content_records WHERE id = ?").all(PREEXISTING_RECORD_ID);
    expect(survived).toEqual(before.records.filter((row) => (row as { id: string }).id === PREEXISTING_RECORD_ID));
    // Triggers and indexes live again with their exact original definitions —
    // not just their names — and the foreign-key graph is clean.
    expect(temp.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const afterObjects = schemaObjectDefinitions(temp.db);
    const beforeNames = new Set(before.schemaObjects.map((object) => object.name));
    const afterNames = new Set(afterObjects.map((object) => object.name));
    for (const name of beforeNames) {
      expect(afterNames.has(name), `the rebuild lost schema object ${name}`).toBe(true);
    }
    // The only new schema object is the normalized Artifact reference's index.
    expect([...afterNames].filter((name) => !beforeNames.has(name))).toEqual(["idx_artifacts_content_record"]);
    const beforeSql = new Map(before.schemaObjects.map((object) => [object.name, object.sql]));
    for (const object of afterObjects) {
      if (beforeSql.has(object.name)) {
        expect(object.sql, `the rebuild changed the definition of ${object.name}`).toBe(
          beforeSql.get(object.name) as string,
        );
      }
    }
    // The recreated triggers still enforce their contracts on live rows.
    expect(() =>
      temp.db
        .prepare(
          "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES ('0123abcd-0000-4000-8000-0000000000e8', NULL, ?, 'MEMO_UPDATED', 'system', NULL, 3, '{}', '2026-01-07T00:00:00.000Z')",
        )
        .run(MEMO_ID),
    ).toThrow(/invalid Memo event association/);
    expect(() =>
      temp.db
        .prepare(
          "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES ('0123abcd-0000-4000-8000-0000000000e7', NULL, ?, 'MEMO_REOPENED', 'user', NULL, 2, '{}', '2026-01-07T00:00:00.000Z')",
        )
        .run(MEMO_ID),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() => temp.db.prepare("UPDATE events SET metadata_json = '{}' WHERE id = ?").run(EVENT_ID)).toThrow(
      /events is append-only/,
    );
  });

  it("refuses a future version-11 history through the production open path", () => {
    const temp = populatedVersion8();
    migrateProduction(temp);
    temp.db
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (11, 'future', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    let admission: unknown = null;
    expect(() => {
      try {
        const plan = handoffAdoptionPlan();
        openAndMigrate(temp.databasePath, plan.migrations, { rebuilds: plan.rebuilds });
      } catch (error) {
        admission = asSchemaAdmission(error);
        throw error;
      }
    }).toThrow();
    // asSchemaAdmission unwraps to the public AppError itself: { code, message }.
    expect(admission).toMatchObject({ code: "STORAGE_SCHEMA_UNSUPPORTED" });
    expect((admission as { message: string }).message).toContain("migration 11");
  });
});

describe("schema 9: normalized mutation stores stay coherent and abort cleanly", () => {
  function fixture() {
    const temp = makeTempDatabase();
    cleanups.push(temp.cleanup);
    migrateProduction(temp);
    const vault = makeTempVault();
    cleanups.push(vault.cleanup);
    createVaultInitializer(new SystemClock()).initialize(vault.vaultPath, INSTALLATION);
    const db = temp.db;
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'recipient', 'Recipient', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(PROJECT);
    const sha = createHash("sha256").update("v1 body").digest("hex");
    const contentId = randomUUID();
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 7, ?, 1, '2026-01-01T00:00:00.000Z')",
    ).run(contentId, MUTATION_OLD_STORAGE_KEY, sha);
    db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'one.md', 'one.md', 'text/markdown', NULL, '2026-01-01T00:00:00.000Z', ?)",
    ).run(MUTATION_OLD_ARTIFACT, MUTATION_HANDOFF, contentId);
    db.prepare(
      "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES (?, NULL, NULL, 'T', 'unregistered_workspace', NULL, ?, '/virtual/ws', ?, ?, 2, 5, 'changes_requested', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(MUTATION_HANDOFF, WORKSPACE_KEY, PROJECT, MUTATION_OLD_ARTIFACT);
    db.exec("COMMIT");
    const ledger = createSqliteEventLedger(db);
    const store = createSqliteContentStore({ db, vaultPath: vault.vaultPath, installationId: INSTALLATION, ledger });
    const references = sqliteContentReferences(db);
    const ids = { next: randomUUID };
    const content: ArtifactContentBindings = {
      insertArtifactContentRecord: (record) => store.insertContentRecord(record),
      removeArtifactContentRecord: (recordId) =>
        store.removeContentRecordInTx(recordId, { references, now: new Date() }),
      nextContentRecordId: () => ids.next(),
    };
    return { temp, db, ledger, content, vaultPath: vault.vaultPath };
  }

  it("a refusal inside a revision aborts the whole mutation and leaves the connection usable", () => {
    const f = fixture();
    // Corrupt the stored key of the current record so the removal proof refuses.
    f.db
      .prepare("UPDATE content_records SET storage_key = '../outside/tamper.md' WHERE storage_key = ?")
      .run(MUTATION_OLD_STORAGE_KEY);
    const events = [
      {
        id: randomUUID(),
        handoffId: MUTATION_HANDOFF,
        eventType: "HANDOFF_REVISED" as const,
        // The revising actor is the fixture Handoff's actual recorded sender:
        // an unregistered Workspace provenance carries its workspace key.
        actor: { kind: "unregistered_workspace" as const, id: WORKSPACE_KEY },
        rowVersion: null,
        metadata: {},
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    const revisions = createSqliteRevisionStore(f.db, f.ledger, {}, f.content);
    const outcome = revisions.applyContentRevision({
      handoffId: MUTATION_HANDOFF,
      expectedRowVersion: 5,
      newArtifact: {
        id: MUTATION_NEW_ARTIFACT,
        handoffId: MUTATION_HANDOFF,
        storageKey: `artifacts/${MUTATION_HANDOFF}/${MUTATION_NEW_ARTIFACT}/two.md`,
        originalName: "two.md",
        storedName: "two.md",
        mimeType: "text/markdown",
        sizeBytes: 7,
        sha256: createHash("sha256").update("v2 body").digest("hex"),
        inlineBody: null,
        importedFromPath: null,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
      activateIntent: {
        id: randomUUID(),
        op: "activate" as const,
        fromPath: "staging/s2",
        toPath: `artifacts/${MUTATION_HANDOFF}/${MUTATION_NEW_ARTIFACT}/two.md`,
        artifactId: MUTATION_NEW_ARTIFACT,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
      unlinkIntent: {
        id: randomUUID(),
        op: "unlink" as const,
        fromPath: null,
        toPath: MUTATION_OLD_STORAGE_KEY,
        artifactId: MUTATION_OLD_ARTIFACT,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
      events,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    // The whole revision is gone: rows, note, events, and intents are unchanged.
    expect(
      f.db
        .prepare("SELECT revision, row_version, current_artifact_id FROM handoffs WHERE id = ?")
        .get(MUTATION_HANDOFF) as { revision: number; row_version: number; current_artifact_id: string },
    ).toEqual({
      revision: 2,
      row_version: 5,
      current_artifact_id: MUTATION_OLD_ARTIFACT,
    });
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE id = ?").get(MUTATION_NEW_ARTIFACT)).toMatchObject({
      c: 0,
    });
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'HANDOFF_REVISED'").get()).toMatchObject({
      c: 0,
    });
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
    expect(
      f.db.prepare("SELECT COUNT(*) AS c FROM content_records WHERE storage_key = '../outside/tamper.md'").get(),
    ).toMatchObject({ c: 1 });
    // No transaction leaked: a fresh write transaction completes.
    f.db.exec("BEGIN IMMEDIATE");
    f.db.exec("ROLLBACK");
  });

  it("the domain reference provider protects current Artifact records from cleanup", () => {
    const f = fixture();
    const references = sqliteContentReferences(f.db);
    const domain = references.domainReferencedRecordIds();
    expect(domain.ok && domain.value).toHaveLength(1);
    const store = createSqliteContentStore({ db: f.db, vaultPath: f.vaultPath, installationId: INSTALLATION });
    const cleaned = store.cleanup(references, new Date("2026-06-01T00:00:00.000Z"));
    expect(cleaned).toEqual(ok({ removedInlineIds: [], scheduledUnlinkIds: [], removedFileOnlyIds: [] }));
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM artifacts").get()).toMatchObject({ c: 1 });
  });
});

describe("schema 9: whole-batch rollback, restoration reporting, and native concurrent/crash outcomes", () => {
  const MIGRATOR_URL = fileURLToPath(new URL("../../src/sqlite/migrator.ts", import.meta.url));
  const CONNECTION_URL = fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url));
  const MIGRATIONS_URL = fileURLToPath(new URL("../../src/sqlite/migrations.ts", import.meta.url));
  const CHILD_BARRIER_MS = 20_000;

  interface GraphSnapshot {
    handoffs: unknown[];
    artifacts: unknown[];
    reviewNotes: unknown[];
    deletionRequests: unknown[];
    events: unknown[];
    pending: unknown[];
    receipts: unknown[];
    records: unknown[];
    memos: unknown[];
    schemaObjects: Array<{ name: string; sql: string }>;
  }

  function captureGraph(db: ReturnType<typeof makeTempDatabase>["db"]): GraphSnapshot {
    return {
      handoffs: db.prepare("SELECT * FROM handoffs ORDER BY id").all(),
      artifacts: db.prepare("SELECT * FROM artifacts ORDER BY id").all(),
      reviewNotes: db.prepare("SELECT * FROM review_notes ORDER BY handoff_id").all(),
      deletionRequests: db.prepare("SELECT * FROM deletion_requests ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY id").all(),
      pending: db.prepare("SELECT * FROM pending_fs_ops ORDER BY id").all(),
      receipts: db.prepare("SELECT * FROM idempotency_keys ORDER BY key").all(),
      records: db.prepare("SELECT * FROM content_records ORDER BY id").all(),
      memos: db.prepare("SELECT * FROM project_memos ORDER BY id").all(),
      schemaObjects: schemaObjectDefinitions(db),
    };
  }

  /** Every domain row, the opaque receipt JSON, the old component DDL, and the old index/trigger definitions are restored exactly. */
  function expectStillVersion8(db: ReturnType<typeof makeTempDatabase>["db"], before: GraphSnapshot): void {
    const after = captureGraph(db);
    expect(after.handoffs).toEqual(before.handoffs);
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.reviewNotes).toEqual(before.reviewNotes);
    expect(after.deletionRequests).toEqual(before.deletionRequests);
    expect(after.events).toEqual(before.events);
    expect(after.pending).toEqual(before.pending);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.records).toEqual(before.records);
    expect(after.memos).toEqual(before.memos);
    expect(after.schemaObjects).toEqual(before.schemaObjects);
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version })),
    );
    const artifactColumns = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    for (const column of ["storage_key", "size_bytes", "sha256", "materialized"]) {
      expect(artifactColumns.some((entry) => entry.name === column)).toBe(true);
    }
    expect(artifactColumns.some((entry) => entry.name === "content_record_id")).toBe(false);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('handoffs_new', 'artifacts_new', 'review_notes_new', 'deletion_requests_new', 'events_new', 'migration_v9_assertions')",
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({
      c: before.records.length,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }

  /** The real rebuild landed exactly once: complete history, one new record per Artifact, preserved definitions, clean graph. */
  function expectNormalizedExactlyOnce(db: ReturnType<typeof makeTempDatabase>["db"], before: GraphSnapshot): void {
    const appliedVersions = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>
    ).map((row) => row.version);
    expect(appliedVersions).toEqual([...MIGRATIONS.map((migration) => migration.version), 9]);
    const after = captureGraph(db);
    expect(after.handoffs).toEqual(before.handoffs);
    expect(after.reviewNotes).toEqual(before.reviewNotes);
    expect(after.deletionRequests).toEqual(before.deletionRequests);
    expect(after.events).toEqual(before.events);
    expect(after.pending).toEqual(before.pending);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.memos).toEqual(before.memos);
    expect(after.records).toHaveLength(before.records.length + before.artifacts.length);
    const joined = db
      .prepare(
        "SELECT a.id AS id, c.id AS record_id FROM artifacts a JOIN content_records c ON c.id = a.content_record_id ORDER BY a.id",
      )
      .all() as Array<{ id: string; record_id: string }>;
    expect(joined).toHaveLength(before.artifacts.length);
    for (const row of joined) expect(row.record_id).not.toBe(row.id);
    const beforeNames = new Set(before.schemaObjects.map((object) => object.name));
    const afterNames = new Set(after.schemaObjects.map((object) => object.name));
    for (const name of beforeNames) expect(afterNames.has(name)).toBe(true);
    expect([...afterNames].filter((name) => !beforeNames.has(name))).toEqual(["idx_artifacts_content_record"]);
    const beforeSql = new Map(before.schemaObjects.map((object) => [object.name, object.sql]));
    for (const object of after.schemaObjects) {
      if (beforeSql.has(object.name)) {
        expect(object.sql).toBe(beforeSql.get(object.name) as string);
      }
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }

  /** A connection factory whose Nth foreign-keys read reports 0, for injected restoration-verification faults. */
  function foreignKeyReadFaultFactory(failFromRead: number) {
    let reads = 0;
    let opened = 0;
    let closed = 0;
    const factory = (path: string): SorageSqlite => {
      opened += 1;
      const real = openSorageDatabase(path);
      const wrapper = {
        exec: (sql: string) => real.exec(sql),
        prepare: <Row = Record<string, unknown>>(sql: string) => {
          const statement = real.prepare<Row>(sql);
          if (!/^\s*pragma\s+foreign_keys/i.test(sql)) return statement;
          return {
            all: (...args: unknown[]) => statement.all(...(args as never[])),
            run: (...args: unknown[]) => statement.run(...(args as never[])),
            get: (...args: unknown[]) => {
              reads += 1;
              if (reads >= failFromRead) return { foreign_keys: 0 } as unknown;
              return statement.get(...(args as never[]));
            },
          };
        },
        close: () => {
          closed += 1;
          real.close();
        },
      };
      return wrapper as unknown as SorageSqlite;
    };
    return { factory, readCount: () => reads, openedCount: () => opened, closedCount: () => closed };
  }

  interface RealPlanChild {
    done: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
    kill: () => boolean;
    exited: () => boolean;
  }

  /**
   * A real native Bun process running the actual production plan against the
   * given file, with an owned instrumentation barrier on the dedicated rebuild
   * connection: it may hold the acquired BEGIN IMMEDIATE until released, mark
   * its attempt, or pause immediately before/after forwarding COMMIT so the
   * parent can kill it at that exact point. These are short-lived, awaited
   * test children — never background jobs.
   */
  function spawnRealPlanChild(input: {
    databasePath: string;
    holdAcquiredUntilReleased?: string;
    acquiredMarker?: string;
    attemptingMarker?: string;
    pauseCommit?: "before" | "after";
    pausedMarker?: string;
    releasePath?: string;
  }): RealPlanChild {
    const body = `
      const { writeFileSync, existsSync } = await import("node:fs");
      const { openSorageDatabase } = await import(${JSON.stringify(CONNECTION_URL)});
      const { migrate } = await import(${JSON.stringify(MIGRATOR_URL)});
      const { productionMigrationPlan } = await import(${JSON.stringify(MIGRATIONS_URL)});
      const plan = productionMigrationPlan();
      plan.migrations = plan.migrations.filter(step => step.version <= 9);
      plan.rebuilds = plan.rebuilds.filter(step => step.version <= 9);
      const holdPath = ${JSON.stringify(input.holdAcquiredUntilReleased ?? "")};
      const acquiredPath = ${JSON.stringify(input.acquiredMarker ?? "")};
      const attemptingPath = ${JSON.stringify(input.attemptingMarker ?? "")};
      const pauseCommit = ${JSON.stringify(input.pauseCommit ?? null)};
      const pausedPath = ${JSON.stringify(input.pausedMarker ?? "")};
      const releasePath = ${JSON.stringify(input.releasePath ?? "")};
      const waitOrTimeout = () => {
        const deadline = Date.now() + ${String(CHILD_BARRIER_MS)};
        while (!existsSync(releasePath)) {
          if (Date.now() > deadline) throw new Error("child barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      };
      const factory = (path) => {
        const real = openSorageDatabase(path);
        return {
          prepare: (sql) => real.prepare(sql),
          close: () => real.close(),
          exec: (sql) => {
            if (sql === "BEGIN IMMEDIATE") {
              if (attemptingPath !== "") writeFileSync(attemptingPath, "attempting");
              real.exec(sql);
              if (holdPath !== "") {
                writeFileSync(acquiredPath, "acquired");
                waitOrTimeout();
              }
              return;
            }
            if (sql === "COMMIT" && pauseCommit !== null) {
              if (pauseCommit === "before") {
                writeFileSync(pausedPath, "paused-before-commit");
                waitOrTimeout();
              }
              real.exec(sql);
              if (pauseCommit === "after") {
                writeFileSync(pausedPath, "paused-after-commit");
                waitOrTimeout();
              }
              return;
            }
            real.exec(sql);
          },
        };
      };
      const db = openSorageDatabase(${JSON.stringify(input.databasePath)});
      try {
        const outcome = migrate(db, plan.migrations, () => "2026-01-03T00:00:00.000Z", {
          databasePath: ${JSON.stringify(input.databasePath)},
          rebuilds: plan.rebuilds,
          connectionFactory: factory,
        });
        console.log(JSON.stringify(outcome));
      } finally {
        db.close();
      }
    `;
    const child = spawn("bun", ["-e", body], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    let settled = false;
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          settled = true;
          resolve({ code, signal, output });
        });
      },
    );
    return {
      done,
      kill: () => child.kill("SIGKILL"),
      exited: () => settled,
    };
  }

  async function waitForMarker(path: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for marker ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function settleChild(child: RealPlanChild, releasePath: string | null): Promise<void> {
    if (releasePath !== null && !child.exited()) writeFileSync(releasePath, "release");
    const deadline = Date.now() + CHILD_BARRIER_MS + 5_000;
    while (!child.exited() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!child.exited()) {
      child.kill();
      await child.done;
      throw new Error("a real-plan child did not settle within the bounded window");
    }
  }

  it("rolls the faulted real rebuild back without a trace when its own CHECK assertion refuses", () => {
    const temp = populatedVersion8();
    const before = captureGraph(temp.db);
    // The fault is genuinely injected: exactly one assertion's expected value
    // is off by one, so the CHECK-constrained assertion table aborts mid-DDL.
    const real = HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION;
    if (real.sql === undefined) throw new Error("The Handoff rebuild fixture requires its original SQL migration");
    const faultedSql = real.sql.replace(
      "('handoff-count', (SELECT COUNT(*) FROM handoffs), (SELECT COUNT(*) FROM handoffs_new))",
      "('handoff-count', (SELECT COUNT(*) FROM handoffs) - 1, (SELECT COUNT(*) FROM handoffs_new))",
    );
    expect(faultedSql).not.toBe(real.sql);
    const faulted: Migration = { version: real.version, name: real.name, sql: faultedSql };
    const plan = handoffAdoptionPlan();
    let thrown: unknown;
    try {
      migrate(temp.db, plan.migrations, () => "2026-01-03T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [faulted],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationFailedError);
    expect((thrown as MigrationFailedError).version).toBe(9);
    expectStillVersion8(temp.db, before);
  });

  it("rolls the whole batch back when a step after the real rebuild fails", () => {
    const temp = populatedVersion8();
    const before = captureGraph(temp.db);
    const failing: Migration = {
      version: 10,
      name: "fails-after-nine",
      sql: "INSERT INTO nonexistent_table VALUES (1)",
    };
    const plan = handoffAdoptionPlan();
    let thrown: unknown;
    try {
      migrate(temp.db, plan.migrations, () => "2026-01-03T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: [HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION, failing],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationFailedError);
    expect((thrown as MigrationFailedError).version).toBe(10);
    expectStillVersion8(temp.db, before);
  });

  it("reports the real rebuild's commit accurately when restoration verification fails afterwards", () => {
    // Injected verification-failure evidence over the real DDL — not a host
    // power-loss claim: the third foreign-keys read (the post-commit
    // restoration check) reports 0 after the batch committed.
    const temp = populatedVersion8();
    const before = captureGraph(temp.db);
    const instrument = foreignKeyReadFaultFactory(3);
    const plan = handoffAdoptionPlan();
    let thrown: unknown;
    try {
      migrate(temp.db, plan.migrations, () => "2026-01-03T00:00:00.000Z", {
        databasePath: temp.databasePath,
        rebuilds: plan.rebuilds,
        connectionFactory: instrument.factory,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationConnectionError);
    expect((thrown as MigrationConnectionError).committed).toBe(true);
    expect((thrown as MigrationConnectionError).restorationVerified).toBe(false);
    // The unusable dedicated connection was closed before the failure surfaced.
    expect(instrument.openedCount()).toBe(1);
    expect(instrument.closedCount()).toBe(1);
    // A fresh FK-ON connection sees the complete, committed, normalized graph.
    const fresh = openSorageDatabase(temp.databasePath);
    try {
      expect(fresh.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(fresh.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({
        version: 9,
      });
      expect(fresh.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({
        c: before.records.length + before.artifacts.length,
      });
      expect(fresh.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it("applies the real rebuild exactly once when two native processes overlap on the same populated database", async () => {
    const temp = populatedVersion8();
    const before = captureGraph(temp.db);
    const acquired = join(temp.home.home, "winner-acquired");
    const release = join(temp.home.home, "winner-release");
    const attempting = join(temp.home.home, "loser-attempting");
    const winner = spawnRealPlanChild({
      databasePath: temp.databasePath,
      holdAcquiredUntilReleased: release,
      acquiredMarker: acquired,
      releasePath: release,
    });
    let loser: RealPlanChild | null = null;
    try {
      await waitForMarker(acquired);
      loser = spawnRealPlanChild({ databasePath: temp.databasePath, attemptingMarker: attempting });
      await waitForMarker(attempting);
      // Observed overlap: the winner holds the write lock while the loser has
      // begun its own BEGIN IMMEDIATE. Release and let both finish natively.
      writeFileSync(release, "release");
      const [winnerResult, loserResult] = await Promise.all([winner.done, loser.done]);
      const outcomes = [winnerResult, loserResult].map((result) => {
        expect(result.code, result.output).toBe(0);
        const lines = result.output.trim().split("\n");
        return JSON.parse(lines[lines.length - 1] as string) as {
          appliedVersions: number[];
          alreadyUpToDate: boolean;
        };
      });
      const applied = outcomes.map((outcome) => outcome.appliedVersions).sort((a, b) => a.length - b.length);
      expect(applied).toEqual([[], [9]]);
      expect(outcomes.filter((outcome) => outcome.alreadyUpToDate)).toHaveLength(1);
      expectNormalizedExactlyOnce(temp.db, before);
    } finally {
      if (!winner.exited()) writeFileSync(release, "release");
      await settleChild(winner, null);
      if (loser !== null) await settleChild(loser, null);
    }
  }, 45_000);

  it("recovers a pre-COMMIT crash of the real rebuild with the old graph intact and a clean retry", async () => {
    const temp = populatedVersion8();
    const before = captureGraph(temp.db);
    const paused = join(temp.home.home, "paused");
    const release = join(temp.home.home, "release");
    const child = spawnRealPlanChild({
      databasePath: temp.databasePath,
      pauseCommit: "before",
      pausedMarker: paused,
      releasePath: release,
    });
    try {
      await waitForMarker(paused);
      // The child's real rebuild transaction is complete in memory but not
      // committed; killing the process now must discard all of it.
      expect(child.kill()).toBe(true);
      const ended = await child.done;
      expect(ended.signal).toBe("SIGKILL");
    } finally {
      await settleChild(child, release);
    }
    // The in-flight batch vanished: the truthful old version-8 graph survives.
    expectStillVersion8(temp.db, before);
    // The real production retry then applies schema 9 exactly once.
    const plan = handoffAdoptionPlan();
    const outcome = migrate(temp.db, plan.migrations, () => "2026-01-04T00:00:00.000Z", {
      databasePath: temp.databasePath,
      rebuilds: plan.rebuilds,
    });
    expect(outcome.appliedVersions).toEqual([9]);
    expectNormalizedExactlyOnce(temp.db, before);
  }, 45_000);

  it("reopens a post-COMMIT crash of the real rebuild as already applied without duplication", async () => {
    const temp = populatedVersion8();
    const before = captureGraph(temp.db);
    const paused = join(temp.home.home, "paused");
    const release = join(temp.home.home, "release");
    const child = spawnRealPlanChild({
      databasePath: temp.databasePath,
      pauseCommit: "after",
      pausedMarker: paused,
      releasePath: release,
    });
    try {
      await waitForMarker(paused);
      // The batch is committed; killing the process now must lose nothing.
      expect(child.kill()).toBe(true);
      const ended = await child.done;
      expect(ended.signal).toBe("SIGKILL");
    } finally {
      await settleChild(child, release);
    }
    // A fresh production open sees the applied history and the complete
    // normalized graph, with no duplicate application.
    const plan = handoffAdoptionPlan();
    const opened = openAndMigrate(temp.databasePath, plan.migrations, { rebuilds: plan.rebuilds });
    try {
      expect(opened.outcome.alreadyUpToDate).toBe(true);
      expect(opened.outcome.appliedVersions).toEqual([]);
      expectNormalizedExactlyOnce(temp.db, before);
    } finally {
      opened.db.close();
    }
  }, 45_000);
});
