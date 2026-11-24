import {
  appError,
  canonicalJsonLine,
  err,
  type Memo,
  memoObject,
  type MemoSnapshot,
  type MemoState,
  ok,
  type Result,
} from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

export interface MemoRow {
  id: string;
  project_id: string;
  title: string;
  content_record_id: string;
  state: MemoState;
  row_version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  closed_at: string | null;
  closed_by: string | null;
}

export interface ContentJoinRow extends MemoRow {
  record_id: string;
  inline_text: string | null;
  storage_key: string | null;
  size_bytes: number;
  sha256: string;
  materialized: number;
}

export const MEMO_SELECT = `SELECT m.id AS id, m.project_id AS project_id, m.title AS title, m.content_record_id AS content_record_id,
  m.state AS state, m.row_version AS row_version, m.created_at AS created_at, m.updated_at AS updated_at,
  m.created_by AS created_by, m.updated_by AS updated_by, m.closed_at AS closed_at, m.closed_by AS closed_by,
  c.id AS record_id, c.inline_text AS inline_text, c.storage_key AS storage_key, c.size_bytes AS size_bytes, c.sha256 AS sha256, c.materialized AS materialized
  FROM project_memos m LEFT JOIN content_records c ON c.id = m.content_record_id`;

function userOf(raw: string): { kind: "user"; id: null } {
  const parsed: unknown = JSON.parse(raw);
  if (!memoObject(parsed, ["kind", "id"]) || parsed.kind !== "user" || parsed.id !== null)
    throw new Error("Stored Memo actor violates its contract");
  return parsed as { kind: "user"; id: null };
}

export function snapshotFromRow(row: ContentJoinRow): MemoSnapshot {
  if (row.inline_text !== null && row.storage_key === null) {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      body: row.inline_text,
      bodyRef: { recordId: row.content_record_id, sizeBytes: Number(row.size_bytes), sha256: row.sha256 },
      state: row.state,
      rowVersion: Number(row.row_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: userOf(row.created_by),
      updatedBy: userOf(row.updated_by),
      closedAt: row.closed_at,
      closedBy: row.closed_by === null ? null : userOf(row.closed_by),
    };
  }
  if (row.inline_text === null && row.storage_key !== null) {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      body: null,
      bodyRef: { recordId: row.content_record_id, sizeBytes: Number(row.size_bytes), sha256: row.sha256 },
      state: row.state,
      rowVersion: Number(row.row_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: userOf(row.created_by),
      updatedBy: userOf(row.updated_by),
      closedAt: row.closed_at,
      closedBy: row.closed_by === null ? null : userOf(row.closed_by),
    };
  }
  throw new Error(`Content record ${row.content_record_id} violates the XOR representation`);
}

/** A LEFT JOIN row whose required record is missing is an honest integrity failure, never a silent absence (SHR-004). */
export function requireJoinedRecord(row: ContentJoinRow): Result<ContentJoinRow> {
  if (row.record_id === null || row.record_id === undefined) {
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        `The Memo ${row.id} references content record ${row.content_record_id}, which is missing`,
        { memoId: row.id, contentRecordId: row.content_record_id },
      ),
    );
  }
  return ok(row);
}

/** The appendEvent association validator expects the public detail shape; a file-backed body is complete metadata. */
export function snapshotToPublicForAssociation(snapshot: MemoSnapshot): Memo {
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    title: snapshot.title,
    body: snapshot.body ?? "",
    state: snapshot.state,
    rowVersion: snapshot.rowVersion,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    createdBy: snapshot.createdBy,
    updatedBy: snapshot.updatedBy,
    closedAt: snapshot.closedAt,
    closedBy: snapshot.closedBy,
  };
}

/** The public metadata projection of a snapshot row, body excluded. */
export function snapshotMetaOf(snapshot: MemoSnapshot): Omit<Memo, "body"> {
  const { body: _body, bodyRef: _reference, ...meta } = snapshot;
  return meta;
}

/** Inserts one Memo row with its record reference; throws so the caller's transaction aborts. */
export function insertMemoSnapshotRow(db: SorageSqlite, memo: MemoSnapshot): void {
  db.prepare(`INSERT INTO project_memos
    (id, project_id, title, content_record_id, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    memo.id,
    memo.projectId,
    memo.title,
    memo.bodyRef.recordId,
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
