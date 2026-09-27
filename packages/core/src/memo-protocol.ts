import { appError, err, ok, type Result } from "./errors";
import {
  type Memo,
  type MemoState,
  MEMO_PREVIEW_BYTES,
  isMemoRowVersion,
  isMemoState,
  isMemoTimestamp,
  isMemoUuid,
  normalizeMemoTitle,
  validateMemoBody,
  validateMemoQuery,
} from "./memos";
import type { Project } from "./projects";

export const MEMO_REQUEST_BYTES = 512 * 1024;
export type MemoDetail = Memo;
export interface MemoSummary extends Omit<Memo, "body" | "createdBy" | "updatedBy" | "closedBy"> {
  projectSlug: string;
  projectDisplayName: string;
  projectStatus: Project["status"];
  bodyPreview: string;
  bodyPreviewTruncated: boolean;
}
export interface MemoReceipt {
  memo: MemoDetail;
  changed: boolean;
  replayed: boolean;
}
export interface MemoPage {
  items: MemoSummary[];
  nextCursor: string | null;
}
export interface MemoCreateRequest {
  projectId: string;
  title: string;
  body: string;
}
export interface MemoStateRequest {
  expectedRowVersion: number;
  projectId?: string;
}
export interface MemoUpdateRequest extends MemoStateRequest {
  title?: string;
  body?: string;
}
export type MemoMode = "execute" | "replay-only";
/** Transport execution policy is separate from normalized business request identity. */
export interface MemoExecution {
  mode: MemoMode;
  idempotencyKey?: string;
}
export interface MemoListFilter {
  scope: { projectId: string } | { allProjects: true };
  state: MemoState | "all";
  query: string;
  limit: number;
  cursor?: string;
}

/** Closed objects at the Memo boundary; JSON null and arrays are never records. */
export function memoObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function invalid(message: string): Result<never> {
  return err(appError("MEMO_INVALID_INPUT", message));
}

export function parseMemoCreate(value: unknown): Result<MemoCreateRequest> {
  if (!memoObject(value, ["projectId", "title"], ["body"]) || !isMemoUuid(value.projectId))
    return invalid("Invalid Memo create fields");
  const title = normalizeMemoTitle(value.title);
  if (!title.ok) return title;
  const body = validateMemoBody(Object.hasOwn(value, "body") ? value.body : "");
  if (!body.ok) return body;
  return ok({ projectId: value.projectId, title: title.value, body: body.value });
}

export function parseMemoStateRequest(value: unknown): Result<MemoStateRequest> {
  if (
    !memoObject(value, ["expectedRowVersion"], ["projectId"]) ||
    !isMemoRowVersion(value.expectedRowVersion) ||
    (Object.hasOwn(value, "projectId") && !isMemoUuid(value.projectId))
  )
    return invalid("Invalid Memo state request");
  return ok({
    expectedRowVersion: value.expectedRowVersion,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
  });
}

export function parseMemoUpdate(value: unknown): Result<MemoUpdateRequest> {
  if (!memoObject(value, ["expectedRowVersion"], ["projectId", "title", "body"]))
    return invalid("Invalid Memo update fields");
  const base = parseMemoStateRequest({
    expectedRowVersion: value.expectedRowVersion,
    ...(Object.hasOwn(value, "projectId") ? { projectId: value.projectId } : {}),
  });
  if (!base.ok) return base;
  if (!Object.hasOwn(value, "title") && !Object.hasOwn(value, "body")) return invalid("Supply a Memo title or body");
  const result: MemoUpdateRequest = base.value;
  if (Object.hasOwn(value, "title")) {
    const title = normalizeMemoTitle(value.title);
    if (!title.ok) return title;
    result.title = title.value;
  }
  if (Object.hasOwn(value, "body")) {
    const body = validateMemoBody(value.body);
    if (!body.ok) return body;
    result.body = body.value;
  }
  return ok(result);
}

/** Pass all raw mode occurrences: duplicates must not be discarded by a header map. */
export function parseMemoExecution(
  modeValues: readonly string[],
  idempotencyKey: unknown,
  mutation: boolean,
): Result<MemoExecution> {
  if (modeValues.length > 1 || (!mutation && modeValues.length !== 0))
    return invalid("Memo execution mode is invalid for this request");
  const mode = modeValues[0] ?? "execute";
  if (mode !== "execute" && mode !== "replay-only") return invalid("Memo mode must be execute or replay-only");
  if (idempotencyKey !== undefined && !isMemoUuid(idempotencyKey))
    return invalid("Memo idempotency key must be a UUID");
  if (mode === "replay-only" && idempotencyKey === undefined)
    return invalid("Memo replay-only requires the original idempotency key");
  return ok({ mode, ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}) });
}

/** Adapters coerce URL numeric/boolean syntax explicitly before this typed filter boundary. */
export function parseMemoListFilter(value: unknown, defaultPageSize: number): Result<MemoListFilter> {
  if (!memoObject(value, [], ["projectId", "allProjects", "state", "query", "limit", "cursor"]))
    return invalid("Invalid Memo list fields");
  const project = Object.hasOwn(value, "projectId");
  const all = Object.hasOwn(value, "allProjects");
  if (project === all || (project && !isMemoUuid(value.projectId)) || (all && value.allProjects !== true))
    return invalid("Select one Memo Project scope");
  const state = Object.hasOwn(value, "state") ? value.state : "open";
  if (!isMemoState(state) && state !== "all") return invalid("Invalid Memo state filter");
  const query = validateMemoQuery(Object.hasOwn(value, "query") ? value.query : "");
  if (!query.ok) return query;
  const limit = Object.hasOwn(value, "limit") ? value.limit : defaultPageSize;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
    return invalid("Memo limit must be between 1 and 200");
  if (Object.hasOwn(value, "cursor") && (typeof value.cursor !== "string" || value.cursor.length === 0))
    return err(appError("CURSOR_INVALID", "Invalid Memo cursor"));
  return ok({
    scope: typeof value.projectId === "string" ? { projectId: value.projectId } : { allProjects: true },
    state,
    query: query.value,
    limit,
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
  });
}

export function decodeMemoJson(bytes: Uint8Array): Result<unknown> {
  if (bytes.byteLength > MEMO_REQUEST_BYTES) return err(appError("MEMO_TOO_LARGE", "Memo request exceeds 512 KiB"));
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return invalid("Memo request must be a JSON object");
    return ok(value);
  } catch {
    return invalid("Memo request must be valid UTF-8 JSON");
  }
}

const MEMO_FIELDS = [
  "id",
  "projectId",
  "title",
  "body",
  "state",
  "rowVersion",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "closedAt",
  "closedBy",
];
function isUser(value: unknown): boolean {
  return memoObject(value, ["kind", "id"]) && value.kind === "user" && value.id === null;
}

/** Used for complete response/receipt data and snapshot rows, without normalizing stored values. */
export function parseMemoDetail(value: unknown): Result<MemoDetail> {
  if (
    !memoObject(value, MEMO_FIELDS) ||
    !isMemoUuid(value.id) ||
    !isMemoUuid(value.projectId) ||
    !isMemoState(value.state) ||
    !isMemoRowVersion(value.rowVersion) ||
    (value.state !== "open" && value.rowVersion === 1) ||
    !isMemoTimestamp(value.createdAt) ||
    !isMemoTimestamp(value.updatedAt) ||
    !isUser(value.createdBy) ||
    !isUser(value.updatedBy)
  )
    return invalid("Invalid Memo detail fields");
  const title = normalizeMemoTitle(value.title);
  if (!title.ok || title.value !== value.title) return invalid("Memo detail title must already be normalized");
  const body = validateMemoBody(value.body);
  if (!body.ok) return body;
  if (
    value.state === "open"
      ? value.closedAt !== null || value.closedBy !== null
      : value.closedAt !== value.updatedAt || !isUser(value.closedBy)
  )
    return invalid("Memo closing metadata does not match its state");
  return ok(value as unknown as MemoDetail);
}

export function parseMemoReceipt(value: unknown): Result<MemoReceipt> {
  if (
    !memoObject(value, ["memo", "changed", "replayed"]) ||
    typeof value.changed !== "boolean" ||
    typeof value.replayed !== "boolean"
  )
    return invalid("Invalid Memo receipt fields");
  const memo = parseMemoDetail(value.memo);
  if (!memo.ok) return memo;
  return ok({ memo: memo.value, changed: value.changed, replayed: value.replayed });
}

export function parseMemoSummary(value: unknown): Result<MemoSummary> {
  const fields = [
    "id",
    "projectId",
    "title",
    "state",
    "rowVersion",
    "createdAt",
    "updatedAt",
    "closedAt",
    "projectSlug",
    "projectDisplayName",
    "projectStatus",
    "bodyPreview",
    "bodyPreviewTruncated",
  ];
  if (
    !memoObject(value, fields) ||
    !isMemoUuid(value.id) ||
    !isMemoUuid(value.projectId) ||
    !isMemoState(value.state) ||
    !isMemoRowVersion(value.rowVersion) ||
    (value.state !== "open" && value.rowVersion === 1) ||
    !isMemoTimestamp(value.createdAt) ||
    !isMemoTimestamp(value.updatedAt) ||
    typeof value.projectSlug !== "string" ||
    typeof value.projectDisplayName !== "string" ||
    (value.projectStatus !== "active" && value.projectStatus !== "archived") ||
    typeof value.bodyPreviewTruncated !== "boolean"
  )
    return invalid("Invalid Memo summary fields");
  const title = normalizeMemoTitle(value.title);
  const body = validateMemoBody(value.bodyPreview);
  if (
    !title.ok ||
    title.value !== value.title ||
    !body.ok ||
    Buffer.byteLength(body.value) > MEMO_PREVIEW_BYTES ||
    (value.state === "open" ? value.closedAt !== null : value.closedAt !== value.updatedAt)
  )
    return invalid("Invalid Memo summary text or closing time");
  return ok(value as unknown as MemoSummary);
}

export function parseMemoPage(value: unknown): Result<MemoPage> {
  if (
    !memoObject(value, ["items", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    (value.nextCursor !== null && (typeof value.nextCursor !== "string" || value.nextCursor.length === 0))
  )
    return invalid("Invalid Memo page fields");
  const items: MemoSummary[] = [];
  for (const item of value.items) {
    const parsed = parseMemoSummary(item);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return ok({ items, nextCursor: value.nextCursor });
}

export function summarizeMemo(
  memo: Memo,
  project: Pick<Project, "id" | "slug" | "displayName" | "status">,
): Result<MemoSummary> {
  if (memo.projectId !== project.id) return invalid("Memo summary Project does not match");
  let bodyPreview = "";
  let size = 0;
  for (const scalar of memo.body) {
    size += Buffer.byteLength(scalar);
    if (size > MEMO_PREVIEW_BYTES) break;
    bodyPreview += scalar;
  }
  return ok({
    id: memo.id,
    projectId: memo.projectId,
    title: memo.title,
    state: memo.state,
    rowVersion: memo.rowVersion,
    createdAt: memo.createdAt,
    updatedAt: memo.updatedAt,
    closedAt: memo.closedAt,
    projectSlug: project.slug,
    projectDisplayName: project.displayName,
    projectStatus: project.status,
    bodyPreview,
    bodyPreviewTruncated: bodyPreview.length < memo.body.length,
  });
}
