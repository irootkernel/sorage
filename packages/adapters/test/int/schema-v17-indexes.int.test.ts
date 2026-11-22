import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupRestore,
  backupVerify,
  exportSnapshot,
  initializeInstallation,
  KNOWN_SCHEMA_HISTORY,
  knownSchemaMaximum,
  type Result,
  serializeMemoReceiptForStorage,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { sqliteContentReferences } from "../../src/content-store";
import { createNodeInitPorts } from "../../src/init-ports";
import { inspectPreflight } from "../../src/preflight";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { migrate, openAndMigrate, SchemaAdmissionError } from "../../src/sqlite/migrator";
import { openCoveredReadConnection } from "../../src/sqlite/read-admission";

const V1_FIXTURE = readFileSync(fileURLToPath(new URL("../../fixtures/schema-v1.sql", import.meta.url)), "utf8");
const NOW = "2026-11-22T12:00:00.000Z";
const SHORT_ARTIFACT_ID = "a01234567";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_C = "33333333-3333-4333-8333-333333333333";

const EXPECTED_V17_INDEXES = [
  "idx_content_records_storage_key",
  "idx_pending_fs_ops_op_to_path",
  "idx_project_memos_content_record",
  "idx_handoffs_recipient_updated",
  "idx_handoffs_sender_updated",
  "idx_handoffs_updated",
  "idx_events_created",
  "idx_exchange_claims_project",
  "idx_exchange_notice_claims_project",
  "idx_exchange_materials_content",
  "idx_exchange_cleanup_items_content",
  "idx_idempotency_keys_scope_expires",
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unwrap<T, E extends { code: string; message: string }>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function explainDetails(db: SorageSqlite, sql: string, params: unknown[] = []): string[] {
  const rows = db.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return rows.map((row) => row.detail);
}

/**
 * Verifies that an EXPLAIN QUERY PLAN uses the expected v17 index, avoids any
 * unindexed full-table SCAN (an index walk like `SCAN t USING INDEX idx` is
 * allowed for unbounded ORDER BY scans), and avoids any temporary B-tree sort.
 */
function expectIndexedPlan(
  db: SorageSqlite,
  label: string,
  expectedIndex: (typeof EXPECTED_V17_INDEXES)[number],
  sql: string,
  params: unknown[] = [],
  options: { requireSearch?: boolean } = {},
): string[] {
  const details = explainDetails(db, sql, params);
  const joined = details.join("\n");
  expect(joined, `${label} should use ${expectedIndex}\n${joined}`).toContain(expectedIndex);
  for (const detail of details) {
    expect(detail, `${label} must not use temp B-tree sort:\n${joined}`).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    if (detail.startsWith("SCAN ")) {
      expect(detail, `${label} must not perform an unindexed table SCAN:\n${joined}`).toMatch(
        /USING (COVERING )?INDEX /,
      );
      if (options.requireSearch) {
        throw new Error(`${label} expected SEARCH with ${expectedIndex}, got: ${detail}\n${joined}`);
      }
    }
  }
  return details;
}

function makeMemoRefReceiptJson(memoId: string, projectId: string, recordId: string): string {
  return serializeMemoReceiptForStorage({
    changed: true,
    memo: {
      id: memoId,
      projectId,
      title: `Memo ${memoId.slice(0, 8)}`,
      body: null,
      bodyRef: {
        recordId,
        sizeBytes: 32,
        sha256: sha256Hex(recordId),
      },
      state: "open",
      rowVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: { kind: "user", id: null },
      updatedBy: { kind: "user", id: null },
      closedAt: null,
      closedBy: null,
    },
  });
}

function seedMultiDomainCorpus(
  db: SorageSqlite,
  options: { vaultPath?: string; includeExchangeWorking?: boolean } = {},
): {
  targetStorageKey: string;
  targetPendingPath: string;
  targetMemoContentId: string;
  targetWorkingContentId: string;
  targetCleanupContentId: string;
  unreferencedWorkingContentId: string;
} {
  const { vaultPath, includeExchangeWorking = true } = options;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [id, slug] of [
      [PROJECT_A, "alpha"],
      [PROJECT_B, "beta"],
      [PROJECT_C, "gamma"],
    ] as const) {
      db.prepare(
        "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', ?, ?)",
      ).run(id, slug, slug.toUpperCase(), NOW, NOW);
    }

    // 24 Handoffs with mixed recipients/senders, timestamps, file-backed and inline content_records, and events.
    let targetStorageKey = "";
    for (let i = 0; i < 24; i += 1) {
      const idx = String(i).padStart(2, "0");
      const handoffId = `40000000-0000-4000-8000-0000000000${idx}`;
      // Preserve one ADR-0031 legacy short Artifact ID in the seeded corpus.
      const artifactId = i === 0 ? SHORT_ARTIFACT_ID : `41000000-0000-4000-8000-0000000000${idx}`;
      const recordId = `42000000-0000-4000-8000-0000000000${idx}`;
      const eventId = `43000000-0000-4000-8000-0000000000${idx}`;
      const ts = `2026-11-22T10:${idx}:00.000Z`;
      const sender = i % 2 === 0 ? PROJECT_A : PROJECT_B;
      const recipient = i % 2 === 0 ? PROJECT_B : PROJECT_C;
      const bodyText = `handoff body ${idx}\n`;
      const digest = sha256Hex(bodyText);
      const storageKey = `artifacts/${handoffId}/${artifactId}/doc.md`;
      if (i === 12) targetStorageKey = storageKey;
      if (vaultPath !== undefined) {
        const fullPath = join(vaultPath, storageKey);
        mkdirSync(join(vaultPath, "artifacts", handoffId, artifactId), { recursive: true });
        writeFileSync(fullPath, bodyText);
      }
      db.prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, ?)",
      ).run(recordId, storageKey, Buffer.byteLength(bodyText), digest, ts);
      db.prepare(
        "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
      ).run(artifactId, handoffId, ts, recordId);
      db.prepare(
        "INSERT INTO handoffs (id, title, sender_kind, sender_project_id, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, ?, 'registered_project', ?, ?, ?, 1, 1, 'awaiting_recipient', ?, ?)",
      ).run(handoffId, `Handoff ${idx}`, sender, recipient, artifactId, ts, ts);
      db.prepare(
        "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, NULL, 'HANDOFF_CREATED', 'registered_project', ?, 1, '{}', ?)",
      ).run(eventId, handoffId, sender, ts);
    }

    // 20 Project Memos (inline content_records) + 1 channel with messages.
    let targetMemoContentId = "";
    for (let i = 0; i < 20; i += 1) {
      const idx = String(i).padStart(2, "0");
      const memoId = `50000000-0000-4000-8000-0000000000${idx}`;
      const recordId = `51000000-0000-4000-8000-0000000000${idx}`;
      if (i === 10) targetMemoContentId = recordId;
      const body = `memo body ${idx}`;
      const ts = `2026-11-22T11:${idx}:00.000Z`;
      db.prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, ?, NULL, ?, ?, 1, ?)",
      ).run(recordId, body, Buffer.byteLength(body), sha256Hex(body), ts);
      const memoProjectId = i % 2 === 0 ? PROJECT_A : PROJECT_B;
      db.prepare(
        `INSERT INTO project_memos (id, project_id, title, content_record_id, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by) VALUES (?, ?, ?, ?, 'open', 1, ?, ?, '{"kind":"user","id":null}', '{"kind":"user","id":null}', NULL, NULL)`,
      ).run(memoId, memoProjectId, `Memo ${idx}`, recordId, ts, ts);
      db.prepare(
        "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, NULL, ?, 'MEMO_CREATED', 'user', NULL, 1, ?, ?)",
      ).run(
        `52000000-0000-4000-8000-0000000000${idx}`,
        memoId,
        JSON.stringify({ projectId: memoProjectId, memoId, rowVersion: 1, toState: "open" }),
        ts,
      );
    }

    const channelId = "60000000-0000-4000-8000-000000000001";
    const channelRecordId = "61000000-0000-4000-8000-000000000001";
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, 'channel msg', NULL, 11, ?, 1, ?)",
    ).run(channelRecordId, sha256Hex("channel msg"), NOW);
    db.prepare(
      "INSERT INTO channels (id, name, title, state, created_at, closed_at) VALUES (?, 'ops', 'Ops', 'open', ?, NULL)",
    ).run(channelId, NOW);
    db.prepare(
      "INSERT INTO channel_participants (channel_id, handle, role, added_at, removed_at) VALUES (?, 'lead', 'main', ?, NULL)",
    ).run(channelId, NOW);
    db.prepare(
      "INSERT INTO channel_participants (channel_id, handle, role, added_at, removed_at) VALUES (?, 'worker-1', 'worker', ?, NULL)",
    ).run(channelId, NOW);
    db.prepare(
      "INSERT INTO channel_messages (channel_id, seq, sender_handle, kind, to_handle, ref, content_record_id, handled, handled_at, handle_note, created_at) VALUES (?, 1, 'worker-1', 'report', NULL, NULL, ?, 0, NULL, NULL, ?)",
    ).run(channelId, channelRecordId, NOW);
    db.prepare(
      "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, NULL, NULL, 'CHANNEL_CREATED', 'user', NULL, NULL, ?, ?)",
    ).run(
      "62000000-0000-4000-8000-000000000001",
      JSON.stringify({ channelId, actingHandle: "lead", mainHandle: "lead" }),
      NOW,
    );
    db.prepare(
      "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, NULL, NULL, 'CHANNEL_PARTICIPANT_ADDED', 'user', NULL, NULL, ?, ?)",
    ).run(
      "62000000-0000-4000-8000-000000000002",
      JSON.stringify({ channelId, actingHandle: "lead", handle: "worker-1", role: "worker" }),
      NOW,
    );
    db.prepare(
      "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, NULL, NULL, 'CHANNEL_MESSAGE_POSTED', 'user', NULL, NULL, ?, ?)",
    ).run(
      "62000000-0000-4000-8000-000000000003",
      JSON.stringify({ channelId, actingHandle: "worker-1", seq: 1, kind: "report", toHandle: null }),
      NOW,
    );

    // 20 pending_fs_ops rows across activate/unlink ops.
    let targetPendingPath = "";
    for (let i = 0; i < 20; i += 1) {
      const idx = String(i).padStart(2, "0");
      const toPath = `content/pending-${idx}.txt`;
      if (i === 10) targetPendingPath = toPath;
      db.prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, ?, ?, ?, NULL, ?, 0)",
      ).run(
        `70000000-0000-4000-8000-0000000000${idx}`,
        i % 2 === 0 ? "activate" : "unlink",
        i % 2 === 0 ? `staging/pending-${idx}.txt` : null,
        toPath,
        `2026-11-22T09:${idx}:00.000Z`,
      );
    }

    // 10 Exchanges with claims, notice claims, working content, materials, and cleanup items.
    let targetWorkingContentId = "";
    let targetCleanupContentId = "";
    let unreferencedWorkingContentId = "";
    for (let i = 0; i < 10; i += 1) {
      const idx = String(i).padStart(2, "0");
      const exchangeId = `80000000-0000-4000-8000-0000000000${idx}`;
      const workingId = `81000000-0000-4000-8000-0000000000${idx}`;
      const cleanupWorkId = `82000000-0000-4000-8000-0000000000${idx}`;
      const freeWorkId = `83000000-0000-4000-8000-0000000000${idx}`;
      if (i === 5) {
        targetWorkingContentId = workingId;
        targetCleanupContentId = cleanupWorkId;
        unreferencedWorkingContentId = freeWorkId;
      }
      const memberA = i % 2 === 0 ? PROJECT_A : PROJECT_B;
      const memberB = i % 2 === 0 ? PROJECT_B : PROJECT_C;
      db.prepare(
        "INSERT INTO exchanges (id, opening_project_id, goal, criteria_json, created_at, last_seq, work_revision, notice_compatibility_at) VALUES (?, ?, ?, '[\"done\"]', ?, 0, 1, ?)",
      ).run(exchangeId, memberA, `Goal ${idx}`, NOW, NOW);
      db.prepare("INSERT INTO exchange_members (exchange_id, project_id, active, initial) VALUES (?, ?, 1, 1)").run(
        exchangeId,
        memberA,
      );
      db.prepare("INSERT INTO exchange_members (exchange_id, project_id, active, initial) VALUES (?, ?, 1, 1)").run(
        exchangeId,
        memberB,
      );
      db.prepare("INSERT INTO exchange_claims (exchange_id, project_id, claim_id, expires_at) VALUES (?, ?, ?, ?)").run(
        exchangeId,
        memberA,
        `claim-a-${idx}`,
        "2026-11-23T00:00:00.000Z",
      );
      db.prepare("INSERT INTO exchange_claims (exchange_id, project_id, claim_id, expires_at) VALUES (?, ?, ?, ?)").run(
        exchangeId,
        memberB,
        `claim-b-${idx}`,
        "2026-11-23T00:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO exchange_notice_claims (exchange_id, incident_id, reporting_claim_id, project_id, participant_claim_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(exchangeId, `inc-${idx}`, `nclaim-${idx}`, memberA, `claim-a-${idx}`, "2026-11-23T00:00:00.000Z");

      if (includeExchangeWorking) {
        const workingText = `working-${idx}`;
        db.prepare(
          "INSERT INTO exchange_working_content (id, exchange_id, inline_text, storage_key, size_bytes, sha256, materialized) VALUES (?, ?, ?, NULL, ?, ?, 1)",
        ).run(workingId, exchangeId, workingText, Buffer.byteLength(workingText), sha256Hex(workingText));
        db.prepare(
          "INSERT INTO exchange_working_content (id, exchange_id, inline_text, storage_key, size_bytes, sha256, materialized) VALUES (?, ?, ?, NULL, ?, ?, 1)",
        ).run(cleanupWorkId, exchangeId, workingText, Buffer.byteLength(workingText), sha256Hex(workingText));
        db.prepare(
          "INSERT INTO exchange_working_content (id, exchange_id, inline_text, storage_key, size_bytes, sha256, materialized) VALUES (?, ?, ?, NULL, ?, ?, 1)",
        ).run(freeWorkId, exchangeId, workingText, Buffer.byteLength(workingText), sha256Hex(workingText));

        db.prepare(
          "INSERT INTO exchange_materials (exchange_id, id, owner_project_id, kind, content_id, size_bytes, sha256, scope_json, available, retired) VALUES (?, ?, ?, 'body', ?, ?, ?, NULL, 1, 0)",
        ).run(exchangeId, `mat-${idx}`, memberA, workingId, Buffer.byteLength(workingText), sha256Hex(workingText));
        db.prepare("INSERT INTO exchange_cleanup_intents (exchange_id, failure) VALUES (?, 0)").run(exchangeId);
        db.prepare("INSERT INTO exchange_cleanup_items (exchange_id, content_id, armed) VALUES (?, ?, 0)").run(
          exchangeId,
          cleanupWorkId,
        );
      }
    }

    // Mixed-scope idempotency_keys across memo:, send, boundary prefixes, and expired rows.
    for (let i = 0; i < 20; i += 1) {
      const idx = String(i).padStart(2, "0");
      const scope = i < 10 ? `send` : i < 15 ? `memo:inst-${idx}:user` : `other:${idx}`;
      const expiresAt = i % 2 === 0 ? "2026-11-23T00:00:00.000Z" : "2026-11-21T00:00:00.000Z";
      db.prepare(
        "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, '{}', ?, ?)",
      ).run(`idem-${idx}`, scope, sha256Hex(`req-${idx}`), NOW, expiresAt);
    }

    db.exec("COMMIT");
    return {
      targetStorageKey,
      targetPendingPath,
      targetMemoContentId,
      targetWorkingContentId,
      targetCleanupContentId,
      unreferencedWorkingContentId,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initIsolatedHome(prefix: string): { home: string; vaultPath: string; database: string; snapshots: string } {
  const home = makeTempDir(prefix);
  const vaultPath = join(home, "vault");
  const env = { SORAGE_HOME: home };
  unwrap(initializeInstallation(createNodeInitPorts({ env }), { vaultPath }));
  return {
    home,
    vaultPath,
    database: join(home, "state", "sorage.sqlite3"),
    snapshots: join(vaultPath, "snapshots"),
  };
}

function snapshotTableRows(db: SorageSqlite): Record<string, unknown[]> {
  const tables = [
    "projects",
    "content_records",
    "artifacts",
    "handoffs",
    "project_memos",
    "events",
    "pending_fs_ops",
    "channels",
    "channel_participants",
    "channel_messages",
    "exchanges",
    "exchange_members",
    "exchange_claims",
    "exchange_notice_claims",
    "exchange_working_content",
    "exchange_materials",
    "exchange_cleanup_intents",
    "exchange_cleanup_items",
    "idempotency_keys",
  ] as const;
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    result[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  return result;
}

describe("schema 17 / m11-secondary-indexes-v1 (TASK-152)", () => {
  it("uses every one of the 12 v17 indexes on realistic seeded queries with zero table SCAN and zero temp B-tree sorts", () => {
    const dir = makeTempDir("sorage-v17-eqp-");
    const dbPath = join(dir, "sorage.sqlite3");
    const plan = productionMigrationPlan();
    const { db } = openAndMigrate(dbPath, plan.migrations, { rebuilds: plan.rebuilds });
    try {
      const seeded = seedMultiDomainCorpus(db);
      // Run ANALYZE so SQLite's query planner exercises realistic table stats too.
      db.exec("ANALYZE");

      // 1. idx_content_records_storage_key (daemon cursor sweep, unbounded sweep, and GC key scan)
      expectIndexedPlan(
        db,
        "#1 daemon sweep cursor",
        "idx_content_records_storage_key",
        "SELECT c.storage_key AS storage_key, c.sha256 AS sha256 FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE c.materialized = 1 AND c.storage_key IS NOT NULL AND c.storage_key >= ? ORDER BY c.storage_key",
        [seeded.targetStorageKey],
        { requireSearch: true },
      );
      expectIndexedPlan(
        db,
        "#1 daemon sweep unbounded",
        "idx_content_records_storage_key",
        "SELECT c.storage_key AS storage_key, c.sha256 AS sha256 FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE c.materialized = 1 AND c.storage_key IS NOT NULL ORDER BY c.storage_key",
      );
      expectIndexedPlan(
        db,
        "#1 GC storage_key scan",
        "idx_content_records_storage_key",
        "SELECT storage_key FROM content_records WHERE storage_key IS NOT NULL",
      );

      // 2. idx_pending_fs_ops_op_to_path
      expectIndexedPlan(
        db,
        "#2 unlink deferral check",
        "idx_pending_fs_ops_op_to_path",
        "SELECT 1 AS pending FROM pending_fs_ops WHERE op = 'activate' AND to_path = ? LIMIT 1",
        [seeded.targetPendingPath],
        { requireSearch: true },
      );

      // 3. idx_project_memos_content_record
      expectIndexedPlan(
        db,
        "#3 memo content_record point lookup",
        "idx_project_memos_content_record",
        "SELECT 1 FROM project_memos WHERE content_record_id = ? LIMIT 1",
        [seeded.targetMemoContentId],
        { requireSearch: true },
      );

      // 4. idx_handoffs_recipient_updated
      expectIndexedPlan(
        db,
        "#4 inbox pagination",
        "idx_handoffs_recipient_updated",
        "SELECT * FROM handoffs WHERE recipient_project_id = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?",
        [PROJECT_B, 10],
        { requireSearch: true },
      );

      // 5. idx_handoffs_sender_updated
      expectIndexedPlan(
        db,
        "#5 outbox pagination",
        "idx_handoffs_sender_updated",
        "SELECT * FROM handoffs WHERE sender_project_id = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?",
        [PROJECT_A, 10],
        { requireSearch: true },
      );

      // 6. idx_handoffs_updated
      expectIndexedPlan(
        db,
        "#6 global/user handoff listing",
        "idx_handoffs_updated",
        "SELECT * FROM handoffs WHERE 1 = 1 AND archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?",
        [10],
      );

      // 7. idx_events_created
      expectIndexedPlan(
        db,
        "#7 global recent events listing",
        "idx_events_created",
        "SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?",
        [20],
      );

      // 8. idx_exchange_claims_project
      expectIndexedPlan(
        db,
        "#8 exchange_claims revocation",
        "idx_exchange_claims_project",
        "DELETE FROM exchange_claims WHERE project_id = ?",
        [PROJECT_A],
        { requireSearch: true },
      );

      // 9. idx_exchange_notice_claims_project
      expectIndexedPlan(
        db,
        "#9 exchange_notice_claims revocation",
        "idx_exchange_notice_claims_project",
        "DELETE FROM exchange_notice_claims WHERE project_id = ?",
        [PROJECT_A],
        { requireSearch: true },
      );

      // 10. idx_exchange_materials_content (lookup + FK parent-delete enforcement)
      expectIndexedPlan(
        db,
        "#10 exchange_materials content lookup",
        "idx_exchange_materials_content",
        "SELECT 1 FROM exchange_materials WHERE content_id = ? LIMIT 1",
        [seeded.targetWorkingContentId],
        { requireSearch: true },
      );
      expectIndexedPlan(
        db,
        "#10 exchange_materials live reference lookup",
        "idx_exchange_materials_content",
        "SELECT 1 FROM exchange_materials WHERE content_id = ? AND retired = 0 LIMIT 1",
        [seeded.targetWorkingContentId],
        { requireSearch: true },
      );

      // 11. idx_exchange_cleanup_items_content (lookup + delete + FK parent-delete enforcement)
      expectIndexedPlan(
        db,
        "#11 exchange_cleanup_items content lookup",
        "idx_exchange_cleanup_items_content",
        "SELECT 1 FROM exchange_cleanup_items WHERE content_id = ? LIMIT 1",
        [seeded.targetCleanupContentId],
        { requireSearch: true },
      );
      expectIndexedPlan(
        db,
        "#11 exchange_cleanup_items delete by content_id",
        "idx_exchange_cleanup_items_content",
        "DELETE FROM exchange_cleanup_items WHERE content_id = ?",
        [seeded.targetCleanupContentId],
        { requireSearch: true },
      );

      // Real FK parent DELETE checks with PRAGMA foreign_keys = ON for #10 and #11.
      expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(() =>
        db.prepare("DELETE FROM exchange_working_content WHERE id = ?").run(seeded.targetWorkingContentId),
      ).toThrow(/FOREIGN KEY/i);
      expect(() =>
        db.prepare("DELETE FROM exchange_working_content WHERE id = ?").run(seeded.targetCleanupContentId),
      ).toThrow(/FOREIGN KEY/i);
      const deletedFree = db
        .prepare("DELETE FROM exchange_working_content WHERE id = ?")
        .run(seeded.unreferencedWorkingContentId) as { changes: number };
      expect(deletedFree.changes).toBe(1);
      db.prepare("UPDATE exchange_materials SET content_id = NULL, available = 0 WHERE content_id = ?").run(
        seeded.targetWorkingContentId,
      );
      expect(
        (
          db.prepare("DELETE FROM exchange_working_content WHERE id = ?").run(seeded.targetWorkingContentId) as {
            changes: number;
          }
        ).changes,
      ).toBe(1);
      db.prepare("DELETE FROM exchange_cleanup_items WHERE content_id = ?").run(seeded.targetCleanupContentId);
      expect(
        (
          db.prepare("DELETE FROM exchange_working_content WHERE id = ?").run(seeded.targetCleanupContentId) as {
            changes: number;
          }
        ).changes,
      ).toBe(1);

      // 12. idx_idempotency_keys_scope_expires (content-store.ts BINARY prefix range & exact scope)
      expectIndexedPlan(
        db,
        "#12 memo prefix range scan",
        "idx_idempotency_keys_scope_expires",
        "SELECT scope, response_json FROM idempotency_keys WHERE scope >= 'memo:' AND scope < 'memo;' AND expires_at > ?",
        [NOW],
        { requireSearch: true },
      );
      expectIndexedPlan(
        db,
        "#12 exact scope unexpired lookup",
        "idx_idempotency_keys_scope_expires",
        "SELECT scope, response_json FROM idempotency_keys WHERE scope = ? AND expires_at > ?",
        ["memo:inst-10:user", NOW],
        { requireSearch: true },
      );
    } finally {
      db.close();
    }
  });

  it("matches only unexpired lowercase memo: receipts across BINARY range and exact timestamp boundaries", () => {
    const dir = makeTempDir("sorage-v17-memo-scope-");
    const dbPath = join(dir, "sorage.sqlite3");
    const plan = productionMigrationPlan();
    const { db } = openAndMigrate(dbPath, plan.migrations, { rebuilds: plan.rebuilds });
    try {
      const insert = db.prepare(
        "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const recExactPrefix = "90000000-0000-4000-8000-000000000001";
      const recTypical = "90000000-0000-4000-8000-000000000002";
      const recAtBoundary = "90000000-0000-4000-8000-000000000003";
      const recExpired = "90000000-0000-4000-8000-000000000004";
      const recSemicolon = "90000000-0000-4000-8000-000000000005";
      const recNine = "90000000-0000-4000-8000-000000000006";
      const recUpper = "90000000-0000-4000-8000-000000000007";
      const recSend = "90000000-0000-4000-8000-000000000008";

      const cases: Array<[string, string, string, string]> = [
        [
          "k1",
          "memo:",
          "2026-11-22T12:00:00.001Z",
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000001", PROJECT_A, recExactPrefix),
        ],
        [
          "k2",
          "memo:p:u",
          "2026-11-23T00:00:00.000Z",
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000002", PROJECT_A, recTypical),
        ],
        // Exact boundary expires_at === now must be excluded (`expires_at > ?`).
        [
          "k3",
          "memo:p:u",
          NOW,
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000003", PROJECT_A, recAtBoundary),
        ],
        [
          "k4",
          "memo:p:u",
          "2026-11-22T11:59:59.999Z",
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000004", PROJECT_A, recExpired),
        ],
        // Non-matching prefix boundaries (';' is 0x3B right after ':' 0x3A; '9' is 0x39 right before ':'; uppercase 'MEMO:' is excluded by BINARY collation).
        [
          "k5",
          "memo;",
          "2026-11-23T00:00:00.000Z",
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000005", PROJECT_A, recSemicolon),
        ],
        [
          "k6",
          "memo9",
          "2026-11-23T00:00:00.000Z",
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000006", PROJECT_A, recNine),
        ],
        [
          "k7",
          "MEMO:p:u",
          "2026-11-23T00:00:00.000Z",
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000007", PROJECT_A, recUpper),
        ],
        [
          "k8",
          "send",
          "2026-11-23T00:00:00.000Z",
          makeMemoRefReceiptJson("91000000-0000-4000-8000-000000000008", PROJECT_A, recSend),
        ],
      ];
      for (const [key, scope, expiresAt, json] of cases) {
        insert.run(key, scope, sha256Hex(key), json, NOW, expiresAt);
      }

      const refs = unwrap(sqliteContentReferences(db).receiptReferencedRecordIds(new Date(NOW)));
      expect(refs.sort()).toEqual([recExactPrefix, recTypical].sort());
    } finally {
      db.close();
    }
  });

  it("upgrades an isolated v16 home to v17 on the ordinary path with zero rebuilds, zero FK-off toggles, byte-identical rows, and idempotent reopens", () => {
    const fixture = initIsolatedHome("sorage-v16-upgrade-");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${fixture.database}${suffix}`, { force: true });

    const plan = productionMigrationPlan();
    const v16Migrations = plan.migrations.filter((step) => step.version <= 16);
    const initial = openAndMigrate(fixture.database, v16Migrations, { rebuilds: plan.rebuilds });
    let beforeRows: Record<string, unknown[]>;
    try {
      // Preserve installation row expected by preflight.
      const marker = JSON.parse(readFileSync(join(fixture.vaultPath, ".sorage-vault.json"), "utf8")) as {
        installationId: string;
      };
      initial.db
        .prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 1, ?)")
        .run(marker.installationId, NOW);
      seedMultiDomainCorpus(initial.db, { vaultPath: fixture.vaultPath });
      beforeRows = snapshotTableRows(initial.db);
      expect(initial.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 16 });
    } finally {
      initial.db.close();
    }

    // Preflight classifies schema 16 as upgrade_required before upgrade.
    expect(inspectPreflight(fixture.home).status).toBe("upgrade_required");

    // Upgrade v16 -> v17 via an instrumented connection proving ordinary path only.
    const upgradeSql: string[] = [];
    let rebuildConnections = 0;
    const rawUpgrade = openSorageDatabase(fixture.database);
    const instrumentedUpgrade: SorageSqlite = {
      exec(sql: string) {
        upgradeSql.push(sql);
        return rawUpgrade.exec(sql);
      },
      prepare: <Row = Record<string, unknown>>(sql: string) => rawUpgrade.prepare<Row>(sql),
      close: () => rawUpgrade.close(),
    };
    try {
      const outcome = migrate(instrumentedUpgrade, plan.migrations, () => NOW, {
        databasePath: fixture.database,
        rebuilds: plan.rebuilds,
        connectionFactory: (path: string) => {
          rebuildConnections += 1;
          return openSorageDatabase(path);
        },
      });
      expect(outcome).toEqual({ appliedVersions: [17], alreadyUpToDate: false });
      expect(rebuildConnections).toBe(0);
      expect(upgradeSql.some((sql) => /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql))).toBe(false);

      // Verify all 12 v17 indexes exist in sqlite_master.
      const indexNames = (
        rawUpgrade.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const expectedIndex of EXPECTED_V17_INDEXES) {
        expect(indexNames).toContain(expectedIndex);
      }

      // Verify all seeded rows (including ADR-0031 short Artifact ID) are byte-for-byte identical.
      expect(snapshotTableRows(rawUpgrade)).toEqual(beforeRows);
      expect(rawUpgrade.prepare("SELECT id FROM artifacts WHERE id = ?").get(SHORT_ARTIFACT_ID)).toEqual({
        id: SHORT_ARTIFACT_ID,
      });
      expect(rawUpgrade.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      rawUpgrade.close();
    }

    // Preflight transitions to compatible after upgrade.
    expect(inspectPreflight(fixture.home).status).toBe("compatible");

    // Subsequent open on up-to-date v17 takes zero BEGIN IMMEDIATE locks and zero FK-off toggles.
    const secondSql: string[] = [];
    let secondRebuildConnections = 0;
    const rawSecond = openSorageDatabase(fixture.database);
    const instrumentedSecond: SorageSqlite = {
      exec(sql: string) {
        secondSql.push(sql);
        return rawSecond.exec(sql);
      },
      prepare: <Row = Record<string, unknown>>(sql: string) => rawSecond.prepare<Row>(sql),
      close: () => rawSecond.close(),
    };
    try {
      const secondOutcome = migrate(instrumentedSecond, plan.migrations, () => NOW, {
        databasePath: fixture.database,
        rebuilds: plan.rebuilds,
        connectionFactory: (path: string) => {
          secondRebuildConnections += 1;
          return openSorageDatabase(path);
        },
      });
      expect(secondOutcome).toEqual({ appliedVersions: [], alreadyUpToDate: true });
      expect(secondRebuildConnections).toBe(0);
      expect(secondSql.filter((sql) => /BEGIN\s+IMMEDIATE/i.test(sql))).toEqual([]);
      expect(secondSql.some((sql) => /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql))).toBe(false);
    } finally {
      rawSecond.close();
    }
  });

  it("replays the captured schema-v1.sql fixture all the way to v17 with all 12 indexes and clean FKs", () => {
    const dir = makeTempDir("sorage-v1-to-v17-");
    const dbPath = join(dir, "v1.sqlite3");
    const db = openSorageDatabase(dbPath);
    try {
      db.exec(V1_FIXTURE);
      db.prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 1, ?)").run(
        "11111111-1111-4111-8111-111111111111",
        NOW,
      );
      const plan = productionMigrationPlan();
      const outcome = migrate(db, plan.migrations, () => NOW, {
        databasePath: dbPath,
        rebuilds: plan.rebuilds,
      });
      expect(outcome.appliedVersions).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
      const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
      expect(rows).toEqual([...KNOWN_SCHEMA_HISTORY]);
      const indexNames = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const expectedIndex of EXPECTED_V17_INDEXES) {
        expect(indexNames).toContain(expectedIndex);
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("reports recovery_required from inspectPreflight when a v17 index is missing from sqlite_master", () => {
    const fixture = initIsolatedHome("sorage-v17-dropped-index-");
    expect(inspectPreflight(fixture.home).status).toBe("compatible");
    const db = openSorageDatabase(fixture.database);
    try {
      db.exec("DROP INDEX idx_events_created");
    } finally {
      db.close();
    }
    expect(inspectPreflight(fixture.home).status).toBe("recovery_required");
  });

  it("refuses v17 under a guarded v0.1.5 schema-16 catalog and refuses synthetic v18 under the current build without modifying DB bytes", () => {
    const fixture = initIsolatedHome("sorage-v17-refusals-");
    const plan = productionMigrationPlan();
    const v16Migrations = plan.migrations.filter((step) => step.version <= 16);

    // Checkpoint cleanly so main file bytes represent full state.
    const checkpointDb = openSorageDatabase(fixture.database);
    try {
      checkpointDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      checkpointDb.close();
    }
    const v17BytesBefore = readFileSync(fixture.database);

    // Guarded v0.1.5 (schema-16-max catalog) refuses v17 DB with STORAGE_SCHEMA_UNSUPPORTED.
    let v16Refusal: unknown;
    try {
      const opened = openAndMigrate(fixture.database, v16Migrations, { rebuilds: plan.rebuilds });
      opened.db.close();
    } catch (error) {
      v16Refusal = error;
    }
    expect(v16Refusal).toBeInstanceOf(SchemaAdmissionError);
    expect((v16Refusal as SchemaAdmissionError).error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(readFileSync(fixture.database)).toEqual(v17BytesBefore);

    // Insert synthetic forward schema v18 into schema_migrations.
    const writer = openSorageDatabase(fixture.database);
    try {
      writer
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future-v18', ?)")
        .run(knownSchemaMaximum() + 1, NOW);
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      writer.close();
    }
    const v18BytesBefore = readFileSync(fixture.database);

    // Operational openAndMigrate refuses v18.
    let v18Refusal: unknown;
    try {
      const opened = openAndMigrate(fixture.database, plan.migrations, { rebuilds: plan.rebuilds });
      opened.db.close();
    } catch (error) {
      v18Refusal = error;
    }
    expect(v18Refusal).toBeInstanceOf(SchemaAdmissionError);
    expect((v18Refusal as SchemaAdmissionError).error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");

    // Covered read on Exchange surface refuses v18.
    const covered = openCoveredReadConnection(fixture.database, "exchange");
    expect(covered.ok).toBe(false);
    if (!covered.ok) expect(covered.error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");

    // Preflight reports unsupported without mutating the database.
    expect(inspectPreflight(fixture.home).status).toBe("unsupported");
    expect(readFileSync(fixture.database)).toEqual(v18BytesBefore);
  });

  it("keeps Format 5 backup export and restore round-trip unchanged across a v16 to v17 upgrade", () => {
    const fromV16 = initIsolatedHome("sorage-v17-fmt5-upgraded-");
    const freshV17 = initIsolatedHome("sorage-v17-fmt5-fresh-");
    const plan = productionMigrationPlan();
    const v16Migrations = plan.migrations.filter((step) => step.version <= 16);

    // Rebuild fromV16 strictly at schema 16, then seed identical logical records into both homes
    // (removing transient pending_fs_ops so backup export runs cleanly on settled state).
    const markerV16 = JSON.parse(readFileSync(join(fromV16.vaultPath, ".sorage-vault.json"), "utf8")) as {
      installationId: string;
    };
    const markerV17 = JSON.parse(readFileSync(join(freshV17.vaultPath, ".sorage-vault.json"), "utf8")) as {
      installationId: string;
    };
    // Match installationId across both fixtures so canonical snapshots can be compared byte-for-byte.
    writeFileSync(
      join(freshV17.vaultPath, ".sorage-vault.json"),
      readFileSync(join(freshV17.vaultPath, ".sorage-vault.json"), "utf8").replace(
        markerV17.installationId,
        markerV16.installationId,
      ),
    );
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${fromV16.database}${suffix}`, { force: true });
    const dbV16 = openAndMigrate(fromV16.database, v16Migrations, { rebuilds: plan.rebuilds }).db;
    try {
      dbV16
        .prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 1, ?)")
        .run(markerV16.installationId, NOW);
      seedMultiDomainCorpus(dbV16, { vaultPath: fromV16.vaultPath, includeExchangeWorking: false });
      dbV16.exec("DELETE FROM pending_fs_ops");
    } finally {
      dbV16.close();
    }

    const dbFreshV17 = openSorageDatabase(freshV17.database);
    try {
      dbFreshV17.prepare("UPDATE installation SET installation_id = ? WHERE id = 1").run(markerV16.installationId);
      seedMultiDomainCorpus(dbFreshV17, { vaultPath: freshV17.vaultPath, includeExchangeWorking: false });
      dbFreshV17.exec("DELETE FROM pending_fs_ops");
    } finally {
      dbFreshV17.close();
    }

    // Export Format 5 snapshot from the upgraded v16->v17 home and the fresh v17 home.
    const fixedClock = { now: () => new Date(NOW) };
    const portsUpgraded = createNodeBackupCommandPorts({ env: { SORAGE_HOME: fromV16.home }, clock: fixedClock });
    const portsFresh = createNodeBackupCommandPorts({ env: { SORAGE_HOME: freshV17.home }, clock: fixedClock });

    unwrap(exportSnapshot(unwrap(portsUpgraded.exportPorts())));
    unwrap(exportSnapshot(unwrap(portsFresh.exportPorts())));

    const manifest = JSON.parse(readFileSync(join(fromV16.snapshots, "manifest.json"), "utf8")) as {
      formatVersion: number;
    };
    expect(manifest.formatVersion).toBe(5);

    const walkFiles = (root: string, rel = ""): string[] => {
      const entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const out: string[] = [];
      for (const entry of entries) {
        const next = rel === "" ? entry.name : join(rel, entry.name);
        if (entry.isDirectory()) out.push(...walkFiles(root, next));
        else out.push(next);
      }
      return out;
    };
    const upgradedFiles = walkFiles(fromV16.snapshots);
    const freshFiles = walkFiles(freshV17.snapshots);
    expect(upgradedFiles).toEqual(freshFiles);
    expect(upgradedFiles.length).toBeGreaterThan(10);
    for (const file of upgradedFiles) {
      expect(readFileSync(join(fromV16.snapshots, file), "utf8"), `snapshot file ${file}`).toBe(
        readFileSync(join(freshV17.snapshots, file), "utf8"),
      );
    }

    // Verify backup and restore into a fresh empty v17 target installation.
    const verified = unwrap(backupVerify(unwrap(portsUpgraded.verifyPorts()), { now: new Date(NOW) }));
    expect(verified.checked.manifest.present).toBe(true);
    expect(verified.checked.manifest.handoffs).toBe(24);
    expect(verified.findings).toEqual([
      "The Vault has no Git repository; re-run sorage init --initialize-git to initialize one.",
    ]);

    const restoredTarget = initIsolatedHome("sorage-v17-fmt5-restore-");
    const restorePorts = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: restoredTarget.home },
      sourcePath: fromV16.vaultPath,
      clock: fixedClock,
    });
    const restored = backupRestore(unwrap(restorePorts.restorePorts()), { dryRun: false });
    expect(restored.ok).toBe(true);

    const restoredDb = openSorageDatabase(restoredTarget.database);
    try {
      expect(restoredDb.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 17 });
      expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM handoffs").get()).toEqual({ n: 24 });
      expect(restoredDb.prepare("SELECT id FROM artifacts WHERE id = ?").get(SHORT_ARTIFACT_ID)).toEqual({
        id: SHORT_ARTIFACT_ID,
      });
      expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM project_memos").get()).toEqual({ n: 20 });
      expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM channels").get()).toEqual({ n: 1 });
      expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM exchanges").get()).toEqual({ n: 10 });
      expect(restoredDb.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      restoredDb.close();
    }
  });
});
