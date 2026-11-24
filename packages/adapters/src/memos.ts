import {
  appError,
  canonicalJsonLine,
  err,
  isManagedContentStorageKey,
  type MemoCandidateDescriptor,
  type MemoListCapture,
  type MemoRepository,
  type MemoRunOptions,
  type MemoSnapshot,
  type MemoState,
  type MemoTransaction,
  ok,
  parseMemoEventAssociation,
  parseStoredMemoReceipt,
  type Result,
  serializeMemoReceiptForStorage,
  type StoredMemoReceiptLookup,
} from "@sorage/core";
import type { SqliteContentStore } from "./content-store";
import { isSafeVaultRelativePath } from "./managed-paths";
import {
  type ContentJoinRow,
  insertMemoSnapshotRow,
  MEMO_SELECT,
  requireJoinedRecord,
  snapshotFromRow,
  snapshotToPublicForAssociation,
} from "./memo-rows";
import type { SorageSqlite } from "./sqlite/connection";
import { runInTransaction } from "./sqlite/transaction";

/**
 * The schema-10 SQLite Memo repository (SHR-004, MEM-009, ADR-0032): reads
 * carry metadata plus immutable record references with the inline text present
 * only for inline records; the write transaction commits the domain rows, the
 * content record, any activation intent, the event, and the receipt atomically
 * behind the move fence and the optional connection-local external-commit
 * guard; list capture runs one bounded metadata batch per short read
 * transaction with SQL-side match flags; and receipts store in the dual
 * historical forms of SHR-008 — verbatim embedded inline bodies and immutable
 * record references — with neither ever rewritten.
 */

export interface MemoRepositoryOptions {
  /** The shared content store whose in-transaction primitives carry the content plans. */
  contentStore: SqliteContentStore;
}

function databaseResult<T>(work: () => Result<T>): Result<T> {
  try {
    return work();
  } catch {
    // A fixed body-free diagnostic: exception text and any payload it carries
    // never ride the public error (the malformed-receipt syntax path carries
    // its own fixed integrity refusal above).
    return err(appError("INTERNAL_ERROR", "Accessing Memo storage failed"));
  }
}

function coherenceMarker(): Result<never> {
  return err(
    appError("SERVICE_PAUSED", "External database state changed during this write; the attempt rolled back", {
      coherenceMismatch: true,
    }),
  );
}

export function createSqliteMemoRepository(db: SorageSqlite, options: MemoRepositoryOptions): MemoRepository {
  const store = options.contentStore;

  const getSnapshot = (id: string): Result<MemoSnapshot | null> =>
    databaseResult(() => {
      const row = db.prepare(`${MEMO_SELECT} WHERE m.id = ?`).get(id) as ContentJoinRow | undefined;
      if (!row) return ok(null);
      const joined = requireJoinedRecord(row);
      if (!joined.ok) return joined;
      if (joined.value.inline_text !== null) {
        // This path is bounded by the fixed inline threshold and performs no
        // filesystem I/O, including when called inside a write transaction.
        const verified = store.openBody(joined.value.record_id, { verifyFileDigest: "always" });
        if (!verified.ok) return verified;
        verified.value.close();
      }
      return ok(snapshotFromRow(joined.value));
    });

  const receiptLookup = (key: string, scope: string, now: string): Result<StoredMemoReceiptLookup | null> =>
    databaseResult(() => {
      const row = db
        .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key=? AND scope=? AND expires_at > ?")
        .get(key, scope, now) as { request_hash: string; response_json: string } | undefined;
      if (!row) return ok(null);
      let value: unknown;
      try {
        value = JSON.parse(row.response_json);
      } catch {
        // Malformed stored syntax is a fixed body-free integrity refusal: the
        // raw payload and the parser's exception text never ride the error,
        // and the refusal is never absence (SHR-008, ADR-0032 plan).
        return err(
          appError("STORAGE_INTEGRITY_ERROR", `A stored Memo receipt under scope ${scope} is not valid JSON.`, {
            scope,
          }),
        );
      }
      const parsed = parseStoredMemoReceipt(value);
      if (!parsed.ok) return parsed;
      return ok({ requestHash: row.request_hash, memo: parsed.value.memo, changed: parsed.value.changed });
    });

  const transaction: MemoTransaction = {
    get: getSnapshot,
    receipt: receiptLookup,
    projectStatus: (id) =>
      databaseResult(() => {
        const row = db.prepare("SELECT status FROM projects WHERE id = ?").get(id) as
          | { status: "active" | "archived" }
          | undefined;
        return ok(row?.status ?? null);
      }),
    commitContent: (plan, ownerMemoId, createdAt) =>
      databaseResult(() => {
        if (plan.kind === "keep") return ok(undefined);
        if (plan.kind === "inline") {
          store.insertContentRecord({
            id: plan.contentId,
            inlineText: plan.text,
            storageKey: null,
            sizeBytes: plan.sizeBytes,
            sha256: plan.sha256,
            materialized: true,
            createdAt,
          });
          return ok(undefined);
        }
        if (!isSafeVaultRelativePath(plan.stagedPath) || !isManagedContentStorageKey(plan.storageKey)) {
          return err(appError("INTERNAL_ERROR", "A file content plan carries an unsafe path"));
        }
        store.insertContentRecord({
          id: plan.contentId,
          inlineText: null,
          storageKey: plan.storageKey,
          sizeBytes: plan.sizeBytes,
          sha256: plan.sha256,
          materialized: false,
          createdAt,
        });
        store.insertCommonIntent({
          id: plan.intentId,
          op: "activate",
          fromPath: plan.stagedPath,
          toPath: plan.storageKey,
          owner: { domain: "memo", ownerId: ownerMemoId },
          contentId: plan.contentId,
          createdAt,
        });
        return ok(undefined);
      }),
    insertMemo: (memo) =>
      databaseResult(() => {
        insertMemoSnapshotRow(db, memo);
        return ok(undefined);
      }),
    compareAndSetMemo: (memo, expectedRowVersion) =>
      databaseResult(() => {
        if (memo.rowVersion !== expectedRowVersion + 1)
          return err(appError("MEMO_INVALID_INPUT", "A Memo write must advance its expected version once"));
        const changed = db
          // Preserved legacy and restored actor JSON may use different key order
          // or trailing whitespace. Immutable User identity is semantic, never
          // equality against a newly serialized JSON string.
          .prepare(`UPDATE project_memos SET title=?, content_record_id=?, state=?, row_version=?, updated_at=?,
          updated_by=?, closed_at=?, closed_by=? WHERE id=? AND project_id=? AND created_at=?
          AND json_extract(created_by, '$.kind')=? AND json_type(created_by, '$.id')='null' AND row_version=?`)
          .run(
            memo.title,
            memo.bodyRef.recordId,
            memo.state,
            memo.rowVersion,
            memo.updatedAt,
            canonicalJsonLine(memo.updatedBy),
            memo.closedAt,
            memo.closedBy === null ? null : canonicalJsonLine(memo.closedBy),
            memo.id,
            memo.projectId,
            memo.createdAt,
            memo.createdBy.kind,
            expectedRowVersion,
          ) as { changes: number };
        return changed.changes === 1
          ? ok(undefined)
          : err(appError("ROW_VERSION_CONFLICT", "Memo changed since the observed Row Version"));
      }),
    appendEvent: (id, event) =>
      databaseResult(() => {
        const owner = getSnapshot(event.memoId);
        if (!owner.ok) return owner;
        if (!owner.value) return err(appError("MEMO_NOT_FOUND", "Memo event owner does not exist"));
        const checked = parseMemoEventAssociation(
          {
            id,
            handoffId: null,
            memoId: event.memoId,
            eventType: event.eventType,
            actorKind: event.actor.kind,
            actorId: event.actor.id,
            rowVersion: event.rowVersion,
            metadata: event.metadata,
            createdAt: event.createdAt,
          },
          2,
          new Map([[owner.value.id, snapshotToPublicForAssociation(owner.value)]]),
        );
        if (!checked.ok) return checked;
        db.prepare(`INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
        VALUES (?, NULL, ?, ?, 'user', NULL, ?, ?, ?)`).run(
          id,
          event.memoId,
          event.eventType,
          event.rowVersion,
          JSON.stringify(event.metadata),
          event.createdAt,
        );
        return ok(undefined);
      }),
    storeReceipt: (key, scope, hash, receipt, createdAt, expiresAt) =>
      databaseResult(() => {
        // Reuse only this expired Memo key; no global cleanup or Handoff receipt mutation.
        db.prepare("DELETE FROM idempotency_keys WHERE key=? AND scope=? AND expires_at <= ?").run(
          key,
          scope,
          createdAt,
        );
        db.prepare(
          "INSERT INTO idempotency_keys (key,scope,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,?,?)",
        ).run(key, scope, hash, serializeMemoReceiptForStorage(receipt), createdAt, expiresAt);
        return ok(undefined);
      }),
  };

  function inTransaction<T>(begin: string, work: () => Result<T>, options?: MemoRunOptions): Result<T> {
    // The shared adapter transaction runner (CHN-014) with the Memo domain's
    // failure classifier and MEM-011 coherence option: the envelopes are
    // byte-identical to the private helper this delegation replaced.
    return runInTransaction(db, begin as "BEGIN" | "BEGIN IMMEDIATE", work, {
      failure: () => appError("INTERNAL_ERROR", "Accessing Memo storage failed"),
      ...(options?.expectedExternalVersion !== undefined
        ? { expectedExternalVersion: options.expectedExternalVersion, coherenceMarker }
        : {}),
    });
  }

  return {
    get: getSnapshot,
    captureListBatch: (filter, after, batchSize) =>
      runInTransaction(
        db,
        "BEGIN",
        () => {
          const where: string[] = [];
          const params: unknown[] = [];
          if ("projectId" in filter.scope) {
            const exists = db.prepare("SELECT id FROM projects WHERE id = ?").get(filter.scope.projectId);
            if (!exists) {
              return err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
            }
            where.push("m.project_id = ?");
            params.push(filter.scope.projectId);
          }
          if (filter.state !== "all") {
            where.push("m.state = ?");
            params.push(filter.state);
          }
          if (after) {
            where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
            params.push(after.createdAt, after.createdAt, after.id);
          }
          const query = filter.query;
          const titleMatch = query === "" ? "0" : "instr(m.title, ?) > 0";
          const inlineMatch =
            query === "" ? "0" : "CASE WHEN c.inline_text IS NOT NULL THEN instr(c.inline_text, ?) > 0 ELSE 0 END";
          const previewSeed = "CASE WHEN c.inline_text IS NOT NULL THEN substr(c.inline_text, 1, 512) ELSE NULL END";
          const rows = db
            .prepare(
              `SELECT m.id AS id, m.project_id AS project_id, m.title AS title, m.state AS state,
              m.row_version AS row_version, m.created_at AS created_at, m.updated_at AS updated_at, m.closed_at AS closed_at,
              CASE WHEN c.inline_text IS NOT NULL THEN 'inline' ELSE 'file' END AS representation,
              c.id AS record_id, c.size_bytes AS size_bytes, c.sha256 AS sha256,
              ${titleMatch} AS title_match, ${inlineMatch} AS inline_match, ${previewSeed} AS preview_seed,
              p.slug AS slug, p.display_name AS display_name, p.status AS status
              FROM project_memos m LEFT JOIN content_records c ON c.id = m.content_record_id JOIN projects p ON p.id = m.project_id
              ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
              ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
            )
            .all(...(query === "" ? [] : [query, query]), ...params, batchSize) as unknown as Array<{
            id: string;
            project_id: string;
            title: string;
            state: MemoState;
            row_version: number;
            created_at: string;
            updated_at: string;
            closed_at: string | null;
            representation: "inline" | "file";
            record_id: string | null;
            size_bytes: number | null;
            sha256: string | null;
            title_match: number;
            inline_match: number;
            preview_seed: string | null;
            slug: string;
            display_name: string;
            status: "active" | "archived";
          }>;
          // A captured row whose required record is missing is an honest
          // whole-page integrity failure — a LEFT JOIN must never let a
          // dangling Memo disappear from the page (SHR-004).
          const dangling = rows.find((row) => row.record_id === null || row.record_id === undefined);
          if (dangling !== undefined) {
            return err(
              appError(
                "STORAGE_INTEGRITY_ERROR",
                `The Memo ${dangling.id} references a missing content record; the page could not be assembled`,
                { memoId: dangling.id },
              ),
            );
          }
          const descriptors: MemoCandidateDescriptor[] = rows.map((row) => ({
            id: row.id,
            projectId: row.project_id,
            createdAt: row.created_at,
            title: row.title,
            state: row.state,
            rowVersion: Number(row.row_version),
            updatedAt: row.updated_at,
            closedAt: row.closed_at,
            representation: row.representation,
            recordId: row.record_id as string,
            sizeBytes: Number(row.size_bytes),
            sha256: row.sha256 as string,
            titleMatch: row.title_match === 1,
            inlineMatch: row.inline_match === 1,
            previewSeed: row.preview_seed,
            project: { slug: row.slug, displayName: row.display_name, status: row.status },
          }));
          const last = rows[rows.length - 1];
          const capture: MemoListCapture = {
            descriptors,
            exhausted: rows.length < batchSize,
            lastSortKey: last ? { createdAt: last.created_at, id: last.id } : null,
          };
          return ok(capture);
        },
        {
          checkFence: false,
          failure: () => appError("INTERNAL_ERROR", "Accessing Memo storage failed"),
        },
      ),
    run: (work, options) => inTransaction("BEGIN IMMEDIATE", () => work(transaction), options),
    inspect: (work) =>
      inTransaction("BEGIN", () =>
        work({ get: getSnapshot, projectStatus: transaction.projectStatus, receipt: receiptLookup }),
      ),
  };
}
