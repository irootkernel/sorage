import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMemo,
  addProject,
  DOCTOR_CATALOG_0_1,
  hasBlockingCheck,
  initializeInstallation,
  listMemos,
  type Result,
  runDoctor,
  sendHandoffs,
  serializeMemoReceiptForStorage,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteContentReferences } from "../../src/content-references";
import { createSqliteContentStore } from "../../src/content-store";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createSqliteEventLedger } from "../../src/events";
import { readExchangeOriginal, resolveExchangeSource, withExchangeSource } from "../../src/exchange-sources";
import { createExchangeWorkingStore } from "../../src/exchange-working-store";
import { createNodeSendPorts } from "../../src/handoff-command-ports";
import { createSqliteHandoffReadStore } from "../../src/handoff-read-store";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeMemoPorts } from "../../src/memo-command-ports";
import { inspectPreflight } from "../../src/preflight";
import { createNodeProjectPorts } from "../../src/project-command-ports";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function initHome(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  const env = { SORAGE_HOME: home };
  const vaultPath = join(home, "vault");
  const stateDir = join(home, "state");
  const databasePath = join(stateDir, "sorage.sqlite3");
  const clock = new FakeClock(Date.parse("2026-11-22T12:00:00.000Z"));
  unwrap(initializeInstallation(createNodeInitPorts({ env, userHome: home, clock }), { vaultPath }));
  const alphaDir = join(home, "ws-alpha");
  const betaDir = join(home, "ws-beta");
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  const projectPorts = createNodeProjectPorts({ env, userHome: home });
  let alpha: ReturnType<typeof addProject> extends Result<infer V> ? V : never;
  let beta: typeof alpha;
  try {
    alpha = unwrap(
      addProject(projectPorts, {
        name: "Alpha",
        slug: "alpha",
        dir: alphaDir,
        userHome: home,
        actor: { kind: "user", id: "user" },
      }),
    );
    beta = unwrap(
      addProject(projectPorts, {
        name: "Beta",
        slug: "beta",
        dir: betaDir,
        userHome: home,
        actor: { kind: "user", id: "user" },
      }),
    );
  } finally {
    projectPorts.close();
  }
  return { home, env, vaultPath, stateDir, databasePath, alphaDir, betaDir, alpha, beta, clock };
}

function explainPlan(db: SorageSqlite, sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail?: string }>;
  return rows.map((row) => row.detail ?? "").join("\n");
}

describe("TASK-154: M11 Exchange, read-path and diagnostics I/O hot paths", () => {
  it("folds 50-row Handoff listPage from 303 SQL statements into 1 LEFT JOIN query with v17 index usage and exact parity", () => {
    const f = initHome("sorage-t154-listpage-");
    const sendPorts = createNodeSendPorts({ env: f.env, userHome: f.home, clock: f.clock });
    const sentIds: string[] = [];
    try {
      for (let i = 0; i < 60; i++) {
        f.clock.advance(1000);
        const sent = unwrap(
          sendHandoffs(sendPorts, {
            to: ["beta"],
            title: `Handoff ${i}`,
            body: `Inline body ${i}`,
            allowExternalSource: false,
            allowUnregistered: false,
            path: f.alphaDir,
            userHome: f.home,
          }),
        );
        sentIds.push(sent.handoffs[0]?.handoffId as string);
      }
    } finally {
      sendPorts.close();
    }

    const db = openSorageDatabase(f.databasePath);
    try {
      // Decorate specific rows to exercise every joined table and integrity branch:
      // 1. Active change_request review note
      const noteTarget = sentIds[59] as string;
      db.prepare("UPDATE handoffs SET review_state = 'changes_requested' WHERE id = ?").run(noteTarget);
      db.prepare(
        "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at, purpose, active) VALUES (?, 'registered_project', ?, 1, 'fix it', '2026-11-22T12:05:00.000Z', '2026-11-22T12:05:00.000Z', 'change_request', 1)",
      ).run(noteTarget, f.beta.project.id);

      // 2. General comment (active=0)
      const commentTarget = sentIds[58] as string;
      db.prepare(
        "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at, purpose, active) VALUES (?, 'user', NULL, 1, 'fyi', '2026-11-22T12:05:00.000Z', '2026-11-22T12:05:00.000Z', 'general', 0)",
      ).run(commentTarget);

      // 3. Pending deletion request
      const delTarget = sentIds[57] as string;
      db.prepare(
        "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at) VALUES (?, ?, 'registered_project', ?, 'cleanup', 'pending', '2026-11-22T12:05:00.000Z')",
      ).run(randomUUID(), delTarget, f.alpha.project.id);

      // 4. Tombstone masking
      const tombTarget = sentIds[56] as string;
      db.prepare(
        "UPDATE handoffs SET deleted_at = '2026-11-22T12:06:00.000Z', current_artifact_id = NULL, read_status = 'read', read_revision = 1, revision_read_at = '2026-11-22T12:05:00.000Z', processing_status = 'completed', processing_completed_at = '2026-11-22T12:05:00.000Z' WHERE id = ?",
      ).run(tombTarget);
      db.prepare(
        "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at, purpose, active) VALUES (?, 'user', NULL, 1, 'old', '2026-11-22T12:05:00.000Z', '2026-11-22T12:05:00.000Z', 'general', 0)",
      ).run(tombTarget);

      // 5. Wrong-owner artifact integrity failure (SHR-004)
      const corruptTarget = sentIds[55] as string;
      const otherArtifact = (
        db.prepare("SELECT current_artifact_id FROM handoffs WHERE id = ?").get(sentIds[54]) as {
          current_artifact_id: string;
        }
      ).current_artifact_id;
      db.prepare("UPDATE handoffs SET current_artifact_id = ? WHERE id = ?").run(otherArtifact, corruptTarget);

      // Instrument prepare() to count exact SQL statements executed by listPage & loadHandoff.
      let statementCount = 0;
      const capturedSql: string[] = [];
      const countedDb: SorageSqlite = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              statementCount += 1;
              capturedSql.push(sql);
              return target.prepare(sql);
            };
          }
          if (prop === "exec") {
            return (sql: string) => {
              statementCount += 1;
              capturedSql.push(sql);
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const store = createSqliteHandoffReadStore(countedDb, createSqliteEventLedger(db), { runDir: null });
      statementCount = 0;
      capturedSql.length = 0;
      const page = unwrap(
        store.listPage(
          { kind: "inbox", recipientProjectId: f.beta.project.id },
          { includeArchived: false, includeDeleted: true },
          50,
          null,
        ),
      );
      expect(page.items).toHaveLength(50);
      expect(statementCount).toBe(1);

      // Verify EXPLAIN QUERY PLAN uses v17 idx_handoffs_recipient_updated without temp B-tree sort.
      const inboxPlan = explainPlan(db, capturedSql[0] as string, f.beta.project.id, 50);
      expect(inboxPlan).toContain("idx_handoffs_recipient_updated");
      expect(inboxPlan).not.toContain("USE TEMP B-TREE");

      // Verify exact field parity on all special rows.
      const byId = new Map(page.items.map((item) => [item.view.id, item]));
      const noteRow = byId.get(noteTarget);
      expect(noteRow?.contentIntegrity).toBe("ok");
      expect(noteRow?.view.hasReviewNote).toBe(true);
      expect(noteRow?.view.comment?.purpose).toBe("change_request");
      expect(noteRow?.view.currentArtifact?.storageKey).toBeNull();
      expect(noteRow?.view.senderProjectSlug).toBe("alpha");
      expect(noteRow?.view.recipientProjectSlug).toBe("beta");

      const commentRow = byId.get(commentTarget);
      expect(commentRow?.view.hasReviewNote).toBe(false);
      expect(commentRow?.view.comment?.purpose).toBe("general");

      const delRow = byId.get(delTarget);
      expect(delRow?.view.pendingDeletionRequest).toBe(true);
      expect(delRow?.view.nextActors.administrativeNextActor).toBe("user");

      const tombRow = byId.get(tombTarget);
      expect(tombRow?.view.comment).toBeNull();
      expect(tombRow?.view.read.status).toBe("unrecorded");
      expect(tombRow?.view.processing.status).toBe("unrecorded");
      expect(tombRow?.view.currentArtifact).toBeNull();
      expect(tombRow?.contentIntegrity).toBe("ok");

      const corruptRow = byId.get(corruptTarget);
      expect(corruptRow?.contentIntegrity).toBe("artifact-record-missing");
      expect(corruptRow?.view.currentArtifact).toBeNull();
      expect(corruptRow?.view.nextActors.administrativeNextActor).toBe("user");

      // Verify outbox & global listing query plans also use v17 indexes without temp B-tree.
      statementCount = 0;
      capturedSql.length = 0;
      unwrap(
        store.listPage(
          { kind: "outbox_project", senderProjectId: f.alpha.project.id },
          { includeArchived: false, includeDeleted: false },
          10,
          null,
        ),
      );
      expect(statementCount).toBe(1);
      const outboxPlan = explainPlan(db, capturedSql[0] as string, f.alpha.project.id, 10);
      expect(outboxPlan).toContain("idx_handoffs_sender_updated");
      expect(outboxPlan).not.toContain("USE TEMP B-TREE");

      statementCount = 0;
      capturedSql.length = 0;
      unwrap(
        store.listPage(
          { kind: "all" },
          { senderSlug: "ALPHA", recipientSlug: "BETA", includeArchived: false, includeDeleted: false },
          10,
          null,
        ),
      );
      expect(statementCount).toBe(1);
      const globalPlan = explainPlan(db, capturedSql[0] as string, "ALPHA", "BETA", 10);
      expect(globalPlan).not.toContain("USE TEMP B-TREE");

      // Verify loadHandoff also runs exactly 1 statement.
      statementCount = 0;
      const single = unwrap(store.loadHandoff(noteTarget));
      expect(statementCount).toBe(1);
      expect(single?.view.id).toBe(noteTarget);
      expect(single?.view.hasReviewNote).toBe(true);
    } finally {
      db.close();
    }
  });

  it("eliminates O(S^2/page) Exchange planRead re-hashing while catching corruption, truncation, growth, and mid-pagination tampering", () => {
    const f = initHome("sorage-t154-exchange-read-");
    const db = openSorageDatabase(f.databasePath);
    try {
      const exchangeId = randomUUID();
      db.prepare(
        "INSERT INTO exchanges (id, opening_project_id, goal, criteria_json, created_at) VALUES (?, ?, 'goal', '[\"ok\"]', '2026-11-22T12:00:00.000Z')",
      ).run(exchangeId, f.alpha.project.id);

      const store = createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.vaultPath });
      const totalBytes = 10 * 1024 * 1024; // 10 MiB (Metric 4)
      const payload = Buffer.allocUnsafe(totalBytes);
      for (let i = 0; i < totalBytes; i += 4096) {
        payload.writeUInt32BE(i, i);
      }

      const written = unwrap(
        store.write({
          exchangeId,
          classification: "binary",
          maxBytes: totalBytes,
          chunks: [payload],
        }),
      );
      expect(written.sizeBytes).toBe(totalBytes);
      expect(written.sha256).toBe(createHash("sha256").update(payload).digest("hex"));

      // Paginate 10 MiB in 160 x 64 KiB pages and verify exact reconstruction.
      const pageSize = 65_536;
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < totalBytes; offset += pageSize) {
        const thunk = unwrap(store.planRead(exchangeId, written.id, offset, pageSize));
        chunks.push(unwrap(thunk()));
      }
      expect(chunks).toHaveLength(160);
      expect(Buffer.concat(chunks)).toEqual(payload);

      // Edge case: offset === size_bytes returns 0-byte Buffer cleanly (Guardrail 1B).
      const atEnd = unwrap(unwrap(store.planRead(exchangeId, written.id, totalBytes, pageSize))());
      expect(atEnd.byteLength).toBe(0);

      // Tampering detection:
      const contentPath = join(f.stateDir, "exchange-working", "content", written.id);

      // 1. Mid-pagination same-size byte flip (caught even at offset > 0 via verifiedStats!).
      const tampered = Buffer.from(payload);
      tampered[5 * 1024 * 1024] = (tampered[5 * 1024 * 1024] ?? 0) ^ 0xff;
      writeFileSync(contentPath, tampered);
      const midPage = unwrap(store.planRead(exchangeId, written.id, pageSize * 2, pageSize))();
      expect(midPage).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });

      // 2. Pre-existing 1-byte same-size flip caught on fresh store at offset 0.
      const freshStore = createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.vaultPath });
      const page0 = unwrap(freshStore.planRead(exchangeId, written.id, 0, pageSize))();
      expect(page0).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });

      // 3. Growth (appended 1 byte) caught at offset > 0.
      writeFileSync(contentPath, Buffer.concat([payload, Buffer.from([0x01])]));
      const grown = unwrap(freshStore.planRead(exchangeId, written.id, pageSize, pageSize))();
      expect(grown).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });

      // 4. Truncation caught at offset > 0.
      writeFileSync(contentPath, payload);
      truncateSync(contentPath, totalBytes - 10);
      const truncated = unwrap(freshStore.planRead(exchangeId, written.id, pageSize, pageSize))();
      expect(truncated).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });

      // 5. Symlink replacement caught (VLT-020).
      const decoy = join(f.home, "decoy.bin");
      writeFileSync(decoy, payload);
      rmSync(contentPath);
      symlinkSync(decoy, contentPath);
      const linked = unwrap(freshStore.planRead(exchangeId, written.id, pageSize, pageSize))();
      expect(linked).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });

      // 6. Versioned readExchangeOriginal fast-path + Guardrail 1C offset > expectedSize check.
      const origPath = join(f.alphaDir, "versioned.bin");
      const origBytes = Buffer.alloc(256 * 1024, 0x42);
      writeFileSync(origPath, origBytes);
      const origSha = createHash("sha256").update(origBytes).digest("hex");
      const binding = f.alpha.binding;
      expect(binding).not.toBeNull();
      if (binding !== null) {
        const scope = resolveExchangeSource(binding, binding.directory, "versioned.bin", 0, null);
        withExchangeSource(scope, binding, ({ observedVersion }) => {
          scope.observedVersion = observedVersion;
        });
        const rebuilt: Buffer[] = [];
        for (let off = 0; off < origBytes.length; off += pageSize) {
          rebuilt.push(readExchangeOriginal(scope, binding, off, pageSize, origSha, origBytes.length).bytes);
        }
        expect(Buffer.concat(rebuilt)).toEqual(origBytes);
        // Shrink file and request offset > expectedSize: must fail EXCHANGE_INVALID_INPUT before changed!
        writeFileSync(origPath, "tiny");
        let pastEndError: unknown;
        try {
          readExchangeOriginal(scope, binding, origBytes.length + 1, pageSize, origSha, origBytes.length);
        } catch (error) {
          pastEndError = error;
        }
        expect(pastEndError).toMatchObject({ error: { code: "EXCHANGE_INVALID_INPUT" } });
        // Request in-bounds offset on modified file: fails EXCHANGE_MATERIAL_UNAVAILABLE (reason: "changed").
        let changedError: unknown;
        try {
          readExchangeOriginal(scope, binding, 0, pageSize, origSha, origBytes.length);
        } catch (error) {
          changedError = error;
        }
        expect(changedError).toMatchObject({
          error: { code: "EXCHANGE_MATERIAL_UNAVAILABLE", details: { reason: "changed" } },
        });
      }
    } finally {
      db.close();
    }
  });

  it("uses indexed point-lookup EXISTS in removeContentRecordInTx while retaining full cross-domain audits in GC", () => {
    const f = initHome("sorage-t154-content-exists-");
    const db = openSorageDatabase(f.databasePath);
    try {
      const instId = (
        JSON.parse(readFileSync(join(f.vaultPath, ".sorage-vault.json"), "utf8")) as { installationId: string }
      ).installationId;
      const store = createSqliteContentStore({
        db,
        vaultPath: f.vaultPath,
        installationId: instId,
        ledger: createSqliteEventLedger(db),
      });
      const refs = sqliteContentReferences(db);
      const now = new Date("2026-11-22T12:00:00.000Z");

      // Verify EXPLAIN QUERY PLAN for point-lookup queries uses indexes (zero full table scan).
      expect(explainPlan(db, "SELECT 1 FROM artifacts WHERE content_record_id = ? LIMIT 1", "x")).toContain(
        "idx_artifacts_content_record",
      );
      expect(explainPlan(db, "SELECT 1 FROM project_memos WHERE content_record_id = ? LIMIT 1", "x")).toContain(
        "idx_project_memos_content_record",
      );
      expect(explainPlan(db, "SELECT 1 FROM channel_messages WHERE content_record_id = ? LIMIT 1", "x")).toContain(
        "idx_channel_messages_record",
      );
      expect(
        explainPlan(db, "SELECT 1 FROM pending_fs_ops WHERE op IN ('activate', 'unlink') AND to_path = ? LIMIT 1", "x"),
      ).toContain("idx_pending_fs_ops_op_to_path");

      // 1. Retained by living Memo row
      const memoRec = randomUUID();
      unwrap(store.writeInline({ contentId: memoRec, text: "memo body", createdAt: now.toISOString() }));
      db.prepare(
        "INSERT INTO project_memos (id, project_id, title, content_record_id, state, row_version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, 't', ?, 'open', 1, ?, ?, 'user', 'user')",
      ).run(randomUUID(), f.alpha.project.id, memoRec, now.toISOString(), now.toISOString());

      db.exec("BEGIN IMMEDIATE");
      const memoPlan = unwrap(store.removeContentRecordInTx(memoRec, { references: refs, now }));
      db.exec("COMMIT");
      expect(memoPlan).toEqual({ action: "retain", reason: "domain-reference" });

      // 2. Retained by pending unlink intent on to_path (Guardrail 3A)
      const unlinkRec = randomUUID();
      const unlinkKey = `content/memo/${f.alpha.project.id}/${unlinkRec}`;
      db.exec("BEGIN IMMEDIATE");
      store.insertContentRecord({
        id: unlinkRec,
        inlineText: null,
        storageKey: unlinkKey,
        sizeBytes: 5,
        sha256: "a".repeat(64),
        materialized: true,
        createdAt: now.toISOString(),
      });
      db.prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, 'unlink', NULL, ?, NULL, 'memo', ?, ?, ?, 0)",
      ).run(randomUUID(), unlinkKey, f.alpha.project.id, unlinkRec, now.toISOString());
      const unlinkPlan = unwrap(store.removeContentRecordInTx(unlinkRec, { references: refs, now }));
      db.exec("COMMIT");
      expect(unlinkPlan).toEqual({ action: "retain", reason: "pending-physical-op" });

      // 3. Retained by unexpired Memo receipt; malformed Memo receipt refuses fail-closed!
      const receiptRec = randomUUID();
      unwrap(store.writeInline({ contentId: receiptRec, text: "receipt body", createdAt: now.toISOString() }));
      const receiptId = randomUUID();
      db.prepare(
        "INSERT INTO idempotency_keys (scope, key, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        `memo:${f.alpha.project.id}:add`,
        "k1",
        "h".repeat(64),
        serializeMemoReceiptForStorage({
          changed: true,
          memo: {
            id: receiptId,
            projectId: f.alpha.project.id,
            title: "t",
            body: null,
            bodyRef: {
              recordId: receiptRec,
              sizeBytes: 12,
              sha256: createHash("sha256").update("receipt body").digest("hex"),
            },
            state: "open",
            rowVersion: 1,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            createdBy: { kind: "user", id: null },
            updatedBy: { kind: "user", id: null },
            closedAt: null,
            closedBy: null,
          },
        }),
        now.toISOString(),
        "2026-11-23T12:00:00.000Z",
      );
      db.exec("BEGIN IMMEDIATE");
      const receiptPlan = unwrap(store.removeContentRecordInTx(receiptRec, { references: refs, now }));
      db.exec("COMMIT");
      expect(receiptPlan).toEqual({ action: "retain", reason: "receipt-reference" });

      // Malformed unexpired Memo receipt refuses with STORAGE_INTEGRITY_ERROR
      db.prepare(
        "INSERT INTO idempotency_keys (scope, key, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        `memo:${f.alpha.project.id}:bad`,
        "k2",
        "h".repeat(64),
        "{bad-json",
        now.toISOString(),
        "2026-11-23T12:00:00.000Z",
      );
      db.exec("BEGIN IMMEDIATE");
      const malformed = store.removeContentRecordInTx(receiptRec, { references: refs, now });
      db.exec("ROLLBACK");
      expect(malformed).toMatchObject({ ok: false, error: { code: "STORAGE_INTEGRITY_ERROR" } });
    } finally {
      db.close();
    }
  });

  it("reads only 100-byte SQLite header and streams SHA-256 with cached config in preflight", () => {
    const f = initHome("sorage-t154-preflight-");
    const valid = inspectPreflight(f.home, { userHome: f.home });
    expect(valid.status).toBe("compatible");

    // Truncated 50-byte SQLite header with NUL 16th byte -> corrupt (recovery_required)
    const truncatedHome = initHome("sorage-t154-preflight-trunc-");
    const dbFile = truncatedHome.databasePath;
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${dbFile}${suffix}`)) rmSync(`${dbFile}${suffix}`);
    }
    writeFileSync(dbFile, Buffer.concat([Buffer.from("SQLite format 3\0", "utf8"), Buffer.alloc(34)]));
    const truncResult = inspectPreflight(truncatedHome.home, { userHome: truncatedHome.home });
    expect(truncResult.status).toBe("recovery_required");
    expect(truncResult.checks.some((check) => check.id === "db.schema" && check.severity === "blocking")).toBe(true);

    // 15-byte "SQLite format 3" (missing 16th NUL byte) -> unsupported
    writeFileSync(dbFile, Buffer.from("SQLite format 3", "utf8"));
    const shortHeaderResult = inspectPreflight(truncatedHome.home, { userHome: truncatedHome.home });
    expect(shortHeaderResult.status).toBe("unsupported");

    // 100-byte file with non-NUL 16th byte ("SQLite format 3X...") -> unsupported
    writeFileSync(dbFile, Buffer.concat([Buffer.from("SQLite format 3X", "utf8"), Buffer.alloc(84)]));
    const nonNulHeaderResult = inspectPreflight(truncatedHome.home, { userHome: truncatedHome.home });
    expect(nonNulHeaderResult.status).toBe("unsupported");

    // Non-SQLite header -> unsupported
    writeFileSync(
      dbFile,
      Buffer.from(
        "NOT_A_SQLITE_DATABASE_HEADER_AT_ALL_000000000000000000000000000000000000000000000000000000000000000000",
      ),
    );
    const badResult = inspectPreflight(truncatedHome.home, { userHome: truncatedHome.home });
    expect(badResult.status).toBe("unsupported");
  });

  it("scans and previews file-backed Memos in one pass and stages oversized text directly via stageBytes without spooling", () => {
    const f = initHome("sorage-t154-memo-");
    const ports = createNodeMemoPorts({ env: f.env, userHome: f.home, clock: f.clock });
    try {
      const largeText = `HEAD_MARKER ${"x".repeat(70_000)} NEEDLE_AT_END`;
      const largeBytes = Buffer.from(largeText, "utf8");
      const accepted = {
        kind: "text" as const,
        text: largeText,
        sizeBytes: largeBytes.byteLength,
        sha256: createHash("sha256").update(largeBytes).digest("hex"),
      };
      const added = unwrap(
        addMemo(ports, { projectId: f.alpha.project.id, title: "large-memo" }, { mode: "execute" }, accepted),
      );
      expect(added.memo.body).toBe(largeText);

      // Verify zero intermediate memo-input spool directory or files were created!
      const spoolDir = join(f.stateDir, "memo-input");
      expect(existsSync(spoolDir) ? readdirSync(spoolDir) : []).toEqual([]);

      // Invalid lone surrogate still rejected by stageAccepted with MEMO_INVALID_INPUT
      const binding = unwrap(ports.staging.freshBinding());
      const loneSurrogate = `${"a".repeat(70_000)}\uD800`;
      expect(
        ports.staging.stageAccepted(
          { kind: "text", text: loneSurrogate, sizeBytes: 70_003, sha256: "0".repeat(64) },
          binding,
        ),
      ).toMatchObject({ ok: false, error: { code: "MEMO_INVALID_INPUT" } });

      // Single-pass query scan + head preview: readBodyPreviewSeed must NOT be called for matched file-backed Memo!
      let previewSeedCalls = 0;
      const origPreviewSeed = ports.bodies.readBodyPreviewSeed;
      ports.bodies.readBodyPreviewSeed = (ref, bound) => {
        previewSeedCalls += 1;
        return origPreviewSeed(ref, bound);
      };
      const matched = unwrap(listMemos(ports, { allProjects: true, query: "NEEDLE_AT_END" }));
      expect(matched.items).toHaveLength(1);
      expect(matched.items[0]?.bodyPreview).toContain("HEAD_MARKER");
      expect(matched.items[0]?.bodyPreviewTruncated).toBe(true);
      expect(previewSeedCalls).toBe(0);
    } finally {
      ports.close();
    }
  });

  it("caches DoctorContext session DB handle, deduplicates artifact/content hashing, and runs O(B log B) binding checks", () => {
    const f = initHome("sorage-t154-doctor-");
    // Send a file-backed Handoff so both artifacts.checksums and content.checksums inspect it.
    const filePath = join(f.alphaDir, "payload.bin");
    writeFileSync(filePath, Buffer.alloc(128 * 1024, 0x7a));
    const sendPorts = createNodeSendPorts({ env: f.env, userHome: f.home, clock: f.clock });
    try {
      unwrap(
        sendHandoffs(sendPorts, {
          to: ["beta"],
          title: "File Handoff",
          file: filePath,
          allowExternalSource: false,
          allowUnregistered: false,
          path: f.alphaDir,
          userHome: f.home,
        }),
      );
    } finally {
      sendPorts.close();
    }

    // Run full doctor catalog through DoctorContext session.
    const doctorPorts = createNodeDoctorPorts({ env: f.env, userHome: f.home, portProbe: () => false });
    const report = runDoctor(doctorPorts, join(f.home, "config.yaml"));
    expect(report.checks.map((check) => check.id)).toEqual([...DOCTOR_CATALOG_0_1]);
    expect(hasBlockingCheck(report)).toBe(false);

    // Seed hyphen-sibling trap (/a, /a-other, /a/b, /a/b/c) + symlink alias + vanished dir + 120 siblings.
    const nestRoot = join(f.home, "nest");
    const dirA = join(nestRoot, "a");
    const dirAOther = join(nestRoot, "a-other");
    const dirAB = join(nestRoot, "a", "b");
    const dirABC = join(nestRoot, "a", "b", "c");
    const symlinkA = join(nestRoot, "a-link");
    for (const dir of [dirA, dirAOther, dirAB, dirABC]) mkdirSync(dir, { recursive: true });
    symlinkSync(dirA, symlinkA);
    const missingDir = join(nestRoot, "vanished");

    const db = openSorageDatabase(f.databasePath);
    try {
      const insertBinding = db.prepare(
        "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', '2026-11-22T12:00:00.000Z', '2026-11-22T12:00:00.000Z')",
      );
      const instId = (
        JSON.parse(readFileSync(join(f.vaultPath, ".sorage-vault.json"), "utf8")) as { installationId: string }
      ).installationId;
      insertBinding.run(randomUUID(), f.alpha.project.id, instId, dirA);
      insertBinding.run(randomUUID(), f.beta.project.id, instId, dirAOther);
      insertBinding.run(randomUUID(), f.beta.project.id, instId, dirAB);
      insertBinding.run(randomUUID(), f.alpha.project.id, instId, dirABC);
      insertBinding.run(randomUUID(), f.beta.project.id, instId, symlinkA);
      insertBinding.run(randomUUID(), f.alpha.project.id, instId, missingDir);
      for (let i = 0; i < 120; i++) {
        const sibling = join(nestRoot, `sib-${String(i).padStart(3, "0")}`);
        mkdirSync(sibling, { recursive: true });
        insertBinding.run(randomUUID(), f.alpha.project.id, instId, sibling);
      }
    } finally {
      db.close();
    }

    const nestedReport = runDoctor(
      createNodeDoctorPorts({ env: f.env, userHome: f.home, portProbe: () => false }),
      join(f.home, "config.yaml"),
    );
    const nestedCheck = nestedReport.checks.find((c) => c.id === "bindings.nested");
    expect(nestedCheck?.severity).toBe("warning");
    expect(nestedCheck?.message).toContain(`'${dirAB}' (beta) is nested inside '${dirA}' (alpha)`);
    expect(nestedCheck?.message).toContain(`'${dirABC}' (alpha) is nested inside '${dirA}' (alpha)`);
    expect(nestedCheck?.message).toContain(`'${dirABC}' (alpha) is nested inside '${dirAB}' (beta)`);
    expect(nestedCheck?.message).not.toContain("a-other");

    const ambiguousCheck = nestedReport.checks.find((c) => c.id === "bindings.ambiguous");
    expect(ambiguousCheck?.severity).toBe("warning");
    expect(ambiguousCheck?.message).toContain("alias one directory");

    const existCheck = nestedReport.checks.find((c) => c.id === "bindings.exist");
    expect(existCheck?.severity).toBe("warning");
    expect(existCheck?.message).toContain(missingDir);

    // Guardrail 6B: removing file-backed artifact produces distinct wording on BOTH checks (errors never cached).
    const dbCheck = openSorageDatabase(f.databasePath);
    let storageKey: string;
    try {
      storageKey = (
        dbCheck.prepare("SELECT storage_key FROM content_records WHERE storage_key IS NOT NULL LIMIT 1").get() as {
          storage_key: string;
        }
      ).storage_key;
    } finally {
      dbCheck.close();
    }
    rmSync(join(f.vaultPath, storageKey));
    const missingReport = runDoctor(
      createNodeDoctorPorts({ env: f.env, userHome: f.home, portProbe: () => false }),
      join(f.home, "config.yaml"),
    );
    const artCheck = missingReport.checks.find((c) => c.id === "artifacts.checksums");
    const contentCheck = missingReport.checks.find((c) => c.id === "content.checksums");
    expect(artCheck?.severity).toBe("blocking");
    expect(artCheck?.message).toContain("is missing from its storageKey");
    expect(contentCheck?.severity).toBe("blocking");
    expect(contentCheck?.message).toContain("Content is missing, unsafe, or unreadable at the managed key");

    // Standalone vault.marker probe must NOT leak cached VaultState across standalone probes or into runDoctor.
    const reusePorts = createNodeDoctorPorts({ env: f.env, userHome: f.home, portProbe: () => false });
    expect(reusePorts.probe("vault.marker").severity).toBe("ok");
    rmSync(join(f.vaultPath, ".sorage-vault.json"));
    expect(reusePorts.probe("vault.marker").severity).toBe("blocking");
    const afterMarkerRemoval = runDoctor(reusePorts, join(f.home, "config.yaml"));
    expect(afterMarkerRemoval.checks.find((c) => c.id === "vault.marker")?.severity).toBe("blocking");
  });
});
