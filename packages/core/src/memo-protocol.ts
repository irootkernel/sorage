import { appError, err, ok, type Result } from "./errors";
import {
  type Memo,
  type MemoBodyRef,
  type MemoSnapshot,
  type MemoState,
  MEMO_BODY_BYTES,
  MEMO_PREVIEW_BYTES,
  isMemoRowVersion,
  isMemoState,
  isMemoTimestamp,
  isMemoUuid,
  normalizeMemoTitle,
  publicMemoOf,
  snapshotOfInlineMemo,
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

/** One bounded list-capture row: metadata, SQL match flags, and an inline preview seed; never a full body. */
export interface MemoCandidateDescriptor {
  id: string;
  projectId: string;
  createdAt: string;
  title: string;
  state: MemoState;
  rowVersion: number;
  updatedAt: string;
  closedAt: string | null;
  representation: "inline" | "file";
  recordId: string;
  sizeBytes: number;
  sha256: string;
  titleMatch: boolean;
  inlineMatch: boolean;
  /** Inline rows: the stored text's bounded head exactly as the SQL substr produced it; null for file rows. */
  previewSeed: string | null;
  project: { slug: string; displayName: string; status: "active" | "archived" };
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

export function parseMemoCreate(value: unknown, bodyBound: number = MEMO_BODY_BYTES): Result<MemoCreateRequest> {
  if (!memoObject(value, ["projectId", "title"], ["body"]) || !isMemoUuid(value.projectId))
    return invalid("Invalid Memo create fields");
  const title = normalizeMemoTitle(value.title);
  if (!title.ok) return title;
  const body = validateMemoBody(Object.hasOwn(value, "body") ? value.body : "", bodyBound);
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

export function parseMemoUpdate(
  value: unknown,
  bodyBound: number = MEMO_BODY_BYTES,
  options: { externalBody?: boolean } = {},
): Result<MemoUpdateRequest> {
  if (!memoObject(value, ["expectedRowVersion"], ["projectId", "title", "body"]))
    return invalid("Invalid Memo update fields");
  const base = parseMemoStateRequest({
    expectedRowVersion: value.expectedRowVersion,
    ...(Object.hasOwn(value, "projectId") ? { projectId: value.projectId } : {}),
  });
  if (!base.ok) return base;
  // A transport-held accepted body counts as the update's supplied body: the
  // closed field shape and every unknown-field rule stay strict, only the
  // title-or-body presence requirement widens to title-or-external-body.
  if (!Object.hasOwn(value, "title") && !Object.hasOwn(value, "body") && options.externalBody !== true)
    return invalid("Supply a Memo title or body");
  const result: MemoUpdateRequest = base.value;
  if (Object.hasOwn(value, "title")) {
    const title = normalizeMemoTitle(value.title);
    if (!title.ok) return title;
    result.title = title.value;
  }
  if (Object.hasOwn(value, "body")) {
    const body = validateMemoBody(value.body, bodyBound);
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
export function parseMemoDetail(value: unknown, bodyBound: number = MEMO_BODY_BYTES): Result<MemoDetail> {
  if (
    !memoObject(value, MEMO_FIELDS) ||
    !validateMemoDetailFields(value) ||
    !validateMemoBody(value.body, bodyBound).ok
  )
    return invalid("Invalid Memo detail fields");
  return ok(value as unknown as MemoDetail);
}

/** The same stored lifecycle and provenance checks without materializing a body. */
export function parseMemoMetadata(value: unknown): Result<Omit<MemoDetail, "body">> {
  if (
    !memoObject(
      value,
      MEMO_FIELDS.filter((field) => field !== "body"),
    ) ||
    !validateMemoDetailFields(value)
  )
    return invalid("Invalid Memo metadata fields");
  return ok(value as unknown as Omit<MemoDetail, "body">);
}

/** The closed metadata checks every Memo record shape shares, body excluded. */
function validateMemoDetailFields(memo: Record<string, unknown>): boolean {
  if (!isMemoUuid(memo.id) || !isMemoUuid(memo.projectId)) return false;
  if (!isMemoState(memo.state) || !isMemoRowVersion(memo.rowVersion)) return false;
  return validateMemoDetailState(memo);
}

function validateMemoDetailState(memo: Record<string, unknown>): boolean {
  if (memo.state !== "open" && memo.rowVersion === 1) return false;
  if (!isMemoTimestamp(memo.createdAt) || !isMemoTimestamp(memo.updatedAt)) return false;
  if (!isUser(memo.createdBy) || !isUser(memo.updatedBy)) return false;
  const title = normalizeMemoTitle(memo.title);
  if (!title.ok || title.value !== memo.title) return false;
  if (memo.state === "open") return memo.closedAt === null && memo.closedBy === null;
  return memo.closedAt === memo.updatedAt && isUser(memo.closedBy);
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

/** The stored reference form's memo field set: the public fields with `bodyRef` in the body's position. */
const MEMO_RECEIPT_REF_FIELDS = [
  "id",
  "projectId",
  "title",
  "bodyRef",
  "state",
  "rowVersion",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "closedAt",
  "closedBy",
];

/** One stored Memo receipt in either historical form: a verbatim embedded inline body, or an immutable record reference. */
export interface StoredMemoReceipt {
  memo: MemoSnapshot;
  changed: boolean;
  replayed: boolean;
}

function storedCorrupt(message: string): Result<never> {
  return err(appError("STORAGE_INTEGRITY_ERROR", message));
}

function validMemoBodyRef(value: unknown): value is MemoBodyRef {
  if (!memoObject(value, ["recordId", "sizeBytes", "sha256"])) return false;
  return (
    isMemoUuid(value.recordId) &&
    typeof value.sizeBytes === "number" &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses a stored Memo receipt in either form (SHR-008): a legacy receipt
 * embeds its inline body verbatim under the frozen 65,536 cap, and a receipt
 * for a Vault-backed original references its immutable content record without
 * serializing the body into SQLite. Malformed data of either shape is a
 * storage-integrity refusal — never absence, so a broken receipt can never
 * become deletion license or a silent miss.
 */
export function parseStoredMemoReceipt(value: unknown): Result<StoredMemoReceipt> {
  if (!memoObject(value, ["memo", "changed", "replayed"]))
    return storedCorrupt("A stored Memo receipt is not its closed object");
  if (typeof value.changed !== "boolean" || value.replayed !== false)
    return storedCorrupt("A stored Memo receipt must be an original outcome");
  const memo = value.memo;
  if (!isPlainObject(memo)) return storedCorrupt("A stored Memo receipt's memo is not an object");
  if (Object.hasOwn(memo, "bodyRef")) {
    if (!memoObject(memo, MEMO_RECEIPT_REF_FIELDS))
      return storedCorrupt("A referenced Memo receipt does not carry its closed field set");
    if (!validateMemoDetailFields(memo)) return storedCorrupt("A referenced Memo receipt's Memo fields are invalid");
    if (!validMemoBodyRef(memo.bodyRef)) return storedCorrupt("A referenced Memo receipt's body reference is invalid");
    const { bodyRef, ...meta } = memo;
    return ok({
      memo: { ...(meta as unknown as Omit<MemoSnapshot, "body" | "bodyRef">), body: null, bodyRef },
      changed: value.changed,
      replayed: false,
    });
  }
  const legacy = parseMemoReceipt(value);
  if (!legacy.ok) return storedCorrupt("A stored Memo receipt's embedded form is invalid");
  return ok({
    memo: snapshotOfInlineMemo(legacy.value.memo),
    changed: legacy.value.changed,
    replayed: legacy.value.replayed,
  });
}

/**
 * Serializes one receipt for SQLite storage: an inline original keeps the
 * legacy verbatim embedded shape byte-for-byte, and a Vault-backed original
 * stores only its immutable record reference (SHR-008).
 */
export function serializeMemoReceiptForStorage(receipt: { memo: MemoSnapshot; changed: boolean }): string {
  if (receipt.memo.body !== null) {
    return JSON.stringify({ memo: publicMemoOf(receipt.memo), changed: receipt.changed, replayed: false });
  }
  const memo = receipt.memo;
  return JSON.stringify({
    memo: {
      id: memo.id,
      projectId: memo.projectId,
      title: memo.title,
      bodyRef: { recordId: memo.bodyRef.recordId, sizeBytes: memo.bodyRef.sizeBytes, sha256: memo.bodyRef.sha256 },
      state: memo.state,
      rowVersion: memo.rowVersion,
      createdAt: memo.createdAt,
      updatedAt: memo.updatedAt,
      createdBy: memo.createdBy,
      updatedBy: memo.updatedBy,
      closedAt: memo.closedAt,
      closedBy: memo.closedBy,
    },
    changed: receipt.changed,
    replayed: false,
  });
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

/**
 * The one bounded-preview rule every surface shares: accumulate scalars while
 * the cumulative UTF-8 byte count stays within 512 bytes, and mark truncation
 * against the body's total recorded bytes — identical bytes for an inline body
 * (whose preview seed is the stored text's head) and a file-backed body.
 */
export function memoPreviewOf(
  previewSeed: string,
  totalBodyBytes: number,
): { bodyPreview: string; bodyPreviewTruncated: boolean } {
  let bodyPreview = "";
  let size = 0;
  for (const scalar of previewSeed) {
    size += Buffer.byteLength(scalar);
    if (size > MEMO_PREVIEW_BYTES) break;
    bodyPreview += scalar;
  }
  return {
    bodyPreview,
    bodyPreviewTruncated: Buffer.byteLength(bodyPreview) < totalBodyBytes,
  };
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
