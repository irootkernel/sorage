import {
  appError,
  canonicalJsonLine,
  err,
  ok,
  parseMemoDetail,
  parseMemoReceipt,
  summarizeMemo,
  parseMemoEventAssociation,
  type Memo,
  type MemoRepository,
  type MemoTransaction,
  type Result,
} from "@sorage/core";
import { liveFencePaused } from "./intent-log";
import type { SorageSqlite } from "./sqlite/connection";

/** Shared row mapping for the live repository and consistent backup reader. */
export function memoFromRow(row: Record<string, unknown>): Memo {
  const parsed = parseMemoDetail({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    state: row.state,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: JSON.parse(String(row.created_by)),
    updatedBy: JSON.parse(String(row.updated_by)),
    closedAt: row.closed_at,
    closedBy: row.closed_by === null ? null : JSON.parse(String(row.closed_by)),
  });
  if (!parsed.ok) throw new Error("Stored Memo violates its contract");
  return parsed.value;
}

/** The caller owns its transaction; restore uses this after validating the whole inventory. */
export function insertMemoRow(db: SorageSqlite, memo: Memo): void {
  const checked = parseMemoDetail(memo);
  if (!checked.ok) throw new Error("Invalid Memo row");
  db.prepare(`INSERT INTO project_memos
    (id, project_id, title, body, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    memo.id,
    memo.projectId,
    memo.title,
    memo.body,
    memo.state,
    memo.rowVersion,
    memo.createdAt,
    memo.updatedAt,
    canonicalJsonLine(memo.createdBy),
    canonicalJsonLine(memo.updatedBy),
    memo.closedAt,
    memo.closedBy === null ? null : canonicalJsonLine(memo.closedBy),
  );
}

function databaseResult<T>(work: () => Result<T>): Result<T> {
  try {
    return work();
  } catch {
    return err(appError("INTERNAL_ERROR", "Accessing Memo storage failed"));
  }
}

export function createSqliteMemoRepository(db: SorageSqlite): MemoRepository {
  const get: MemoRepository["get"] = (id) =>
    databaseResult(() => {
      const row = db.prepare("SELECT * FROM project_memos WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return ok(row ? memoFromRow(row) : null);
    });
  const transaction: MemoTransaction = {
    get,
    receipt: (key, scope, now) =>
      databaseResult(() => {
        const row = db
          .prepare(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE key=? AND scope=? AND expires_at > ?",
          )
          .get(key, scope, now) as { request_hash: string; response_json: string } | undefined;
        if (!row) return ok(null);
        const parsed = parseMemoReceipt(JSON.parse(row.response_json));
        if (!parsed.ok || parsed.value.replayed) throw new Error("Invalid stored Memo receipt");
        return ok({ requestHash: row.request_hash, receipt: parsed.value });
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
        ).run(key, scope, hash, JSON.stringify(receipt), createdAt, expiresAt);
        return ok(undefined);
      }),
    projectStatus: (id) =>
      databaseResult(() => {
        const row = db.prepare("SELECT status FROM projects WHERE id = ?").get(id) as
          | { status: "active" | "archived" }
          | undefined;
        return ok(row?.status ?? null);
      }),
    insert: (memo) =>
      databaseResult(() => {
        insertMemoRow(db, memo);
        return ok(undefined);
      }),
    compareAndSet: (memo, expectedRowVersion) =>
      databaseResult(() => {
        const checked = parseMemoDetail(memo);
        if (!checked.ok) return checked;
        if (memo.rowVersion !== expectedRowVersion + 1)
          return err(appError("MEMO_INVALID_INPUT", "A Memo write must advance its expected version once"));
        const changed = db
          .prepare(`UPDATE project_memos SET title=?, body=?, state=?, row_version=?, updated_at=?,
        updated_by=?, closed_at=?, closed_by=? WHERE id=? AND project_id=? AND created_at=? AND created_by=? AND row_version=?`)
          .run(
            memo.title,
            memo.body,
            memo.state,
            memo.rowVersion,
            memo.updatedAt,
            canonicalJsonLine(memo.updatedBy),
            memo.closedAt,
            memo.closedBy === null ? null : canonicalJsonLine(memo.closedBy),
            memo.id,
            memo.projectId,
            memo.createdAt,
            canonicalJsonLine(memo.createdBy),
            expectedRowVersion,
          ) as { changes: number };
        return changed.changes === 1
          ? ok(undefined)
          : err(appError("ROW_VERSION_CONFLICT", "Memo changed since the observed Row Version"));
      }),
    appendEvent: (id, event) =>
      databaseResult(() => {
        const owner = get(event.memoId);
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
          new Map([[owner.value.id, owner.value]]),
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
  };
  function inTransaction<T>(begin: string, work: () => Result<T>): Result<T> {
    return databaseResult(() => {
      db.exec(begin);
      try {
        if (liveFencePaused(db)) {
          db.exec("ROLLBACK");
          return err(appError("SERVICE_PAUSED", "A Vault move or restore is in progress"));
        }
        const result = work();
        db.exec(result.ok ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  return {
    get,
    list: (filter, after) =>
      databaseResult(() => {
        const where: string[] = [];
        const params: unknown[] = [];
        if ("projectId" in filter.scope) {
          where.push("m.project_id = ?");
          params.push(filter.scope.projectId);
        }
        if (filter.state !== "all") {
          where.push("m.state = ?");
          params.push(filter.state);
        }
        if (filter.query !== "") {
          where.push("(instr(m.title, ?) > 0 OR instr(m.body, ?) > 0)");
          params.push(filter.query, filter.query);
        }
        if (after) {
          where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
          params.push(after.createdAt, after.createdAt, after.id);
        }
        const rows = db
          .prepare(`SELECT m.id, m.project_id, m.title, substr(m.body, 1, 512) AS body,
        length(CAST(m.body AS BLOB)) AS body_bytes, m.state, m.row_version, m.created_at, m.updated_at,
        m.created_by, m.updated_by, m.closed_at, m.closed_by, p.slug, p.display_name, p.status
        FROM project_memos m JOIN projects p ON p.id=m.project_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
          .all(...params, filter.limit + 1);
        const items = [];
        for (const row of rows) {
          const memo = memoFromRow(row);
          const summary = summarizeMemo(memo, {
            id: memo.projectId,
            slug: String(row.slug),
            displayName: String(row.display_name),
            status: row.status as "active" | "archived",
          });
          if (!summary.ok) return summary;
          items.push({
            ...summary.value,
            bodyPreviewTruncated: Number(row.body_bytes) > Buffer.byteLength(summary.value.bodyPreview),
          });
        }
        return ok(items);
      }),
    run: (work) => inTransaction("BEGIN IMMEDIATE", () => work(transaction)),
    inspect: (work) =>
      inTransaction("BEGIN", () =>
        work({ get, projectStatus: transaction.projectStatus, receipt: transaction.receipt }),
      ),
  };
}
