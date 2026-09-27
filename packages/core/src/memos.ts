import { appError, err, ok, type AppError, type Result } from "./errors";
import type { MemoEventType } from "./events";

export const MEMO_STATES = ["open", "done", "dismissed"] as const;
export type MemoState = (typeof MEMO_STATES)[number];
export type MemoUser = { kind: "user"; id: null };
export const MEMO_TITLE_SCALARS = 200;
export const MEMO_TEXT_BYTES = 800;
export const MEMO_BODY_BYTES = 65_536;
export const MEMO_PREVIEW_BYTES = 512;

/** Stored values only: Project names are joined by readers, never Memo identity. */
export interface Memo {
  id: string;
  projectId: string;
  title: string;
  body: string;
  state: MemoState;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  createdBy: MemoUser;
  updatedBy: MemoUser;
  closedAt: string | null;
  closedBy: MemoUser | null;
}

export interface MemoContent {
  title: string;
  body: string;
}

export type MemoChange =
  | { operation: "update"; expectedRowVersion: number; title?: string; body?: string }
  | { operation: "done" | "dismiss" | "reopen"; expectedRowVersion: number };

/** Metadata deliberately cannot carry title/body values or local paths. */
export interface MemoEvent {
  memoId: string;
  handoffId: null;
  eventType: MemoEventType;
  actor: MemoUser;
  rowVersion: number;
  createdAt: string;
  metadata: {
    projectId: string;
    memoId: string;
    rowVersion: number;
    changedFields?: ("title" | "body")[];
    fromState?: MemoState;
    toState?: MemoState;
  };
}

export interface MemoTransition {
  memo: Memo;
  changed: boolean;
  event: MemoEvent | null;
}

export function isMemoUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function isMemoRowVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isMemoState(value: unknown): value is MemoState {
  return value === "open" || value === "done" || value === "dismissed";
}

export function normalizeMemoTitle(value: unknown): Result<string> {
  // Check before trimming: a newline or control character must not disappear.
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\u2028\u2029]/u.test(value)) {
    return err(appError("MEMO_INVALID_INPUT", "Memo title must be valid single-line Unicode text"));
  }
  const title = value.trim();
  if (title.length === 0 || [...title].length > MEMO_TITLE_SCALARS || Buffer.byteLength(title) > MEMO_TEXT_BYTES) {
    return err(appError("MEMO_INVALID_INPUT", "Memo title must contain 1 to 200 scalars and at most 800 UTF-8 bytes"));
  }
  return ok(title);
}

export function validateMemoBody(value: unknown): Result<string> {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) {
    return err(appError("MEMO_INVALID_INPUT", "Memo body must be valid Unicode without NUL"));
  }
  if (Buffer.byteLength(value) > MEMO_BODY_BYTES) {
    return err(appError("MEMO_TOO_LARGE", "Memo body exceeds 65536 UTF-8 bytes"));
  }
  return ok(value);
}

export function validateMemoQuery(value: unknown): Result<string> {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    [...value].length > MEMO_TITLE_SCALARS ||
    Buffer.byteLength(value) > MEMO_TEXT_BYTES
  ) {
    return err(appError("MEMO_INVALID_INPUT", "Memo query must contain at most 200 scalars and 800 UTF-8 bytes"));
  }
  return ok(value);
}

/** Clock values use the same canonical UTC representation as Date.toISOString(). */
export function isMemoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function createMemo(id: string, projectId: string, content: MemoContent, now: string): Result<MemoTransition> {
  if (!isMemoUuid(id) || !isMemoUuid(projectId) || !isMemoTimestamp(now)) {
    return err(appError("MEMO_INVALID_INPUT", "Memo identity or timestamp is invalid"));
  }
  const title = normalizeMemoTitle(content.title);
  if (!title.ok) return title;
  const body = validateMemoBody(content.body);
  if (!body.ok) return body;
  const memo: Memo = {
    id,
    projectId,
    title: title.value,
    body: body.value,
    state: "open",
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: "user", id: null },
    updatedBy: { kind: "user", id: null },
    closedAt: null,
    closedBy: null,
  };
  return ok({ memo, changed: true, event: memoEvent(memo, "MEMO_CREATED", { toState: "open" }) });
}

/** Pure lifecycle calculation. The adapter must still compare-and-set inside its transaction. */
export function changeMemo(memo: Memo, change: MemoChange, now: string): Result<MemoTransition> {
  if (!isMemoRowVersion(change.expectedRowVersion) || !isMemoTimestamp(now)) {
    return err(appError("MEMO_INVALID_INPUT", "Memo expected Row Version or timestamp is invalid"));
  }
  if (change.expectedRowVersion !== memo.rowVersion) {
    return err(appError("ROW_VERSION_CONFLICT", "Memo changed since the observed Row Version"));
  }
  let title = memo.title;
  let body = memo.body;
  const changedFields: ("title" | "body")[] = [];
  let state = memo.state;
  let eventType: MemoEventType;
  if (change.operation === "update") {
    if (memo.state !== "open") return err(appError("MEMO_NOT_OPEN", "Reopen the Memo before editing it"));
    if (change.title === undefined && change.body === undefined)
      return err(appError("MEMO_INVALID_INPUT", "Supply a Memo title or body"));
    if (change.title !== undefined) {
      const result = normalizeMemoTitle(change.title);
      if (!result.ok) return result;
      title = result.value;
      if (title !== memo.title) changedFields.push("title");
    }
    if (change.body !== undefined) {
      const result = validateMemoBody(change.body);
      if (!result.ok) return result;
      body = result.value;
      if (body !== memo.body) changedFields.push("body");
    }
    eventType = "MEMO_UPDATED";
  } else {
    state = change.operation === "done" ? "done" : change.operation === "dismiss" ? "dismissed" : "open";
    if (memo.state !== "open" && state !== "open" && state !== memo.state) {
      return err(appError("MEMO_NOT_OPEN", "Reopen the Memo before changing its closing decision"));
    }
    eventType =
      change.operation === "done"
        ? "MEMO_MARKED_DONE"
        : change.operation === "dismiss"
          ? "MEMO_DISMISSED"
          : "MEMO_REOPENED";
  }
  if (state === memo.state && changedFields.length === 0) return ok({ memo, changed: false, event: null });
  if (memo.rowVersion === Number.MAX_SAFE_INTEGER)
    return err(appError("MEMO_INVALID_INPUT", "Memo Row Version cannot overflow"));
  const next: Memo = {
    ...memo,
    title,
    body,
    state,
    rowVersion: memo.rowVersion + 1,
    updatedAt: now,
    updatedBy: { kind: "user", id: null },
    closedAt: state === "open" ? null : now,
    closedBy: state === "open" ? null : { kind: "user", id: null },
  };
  return ok({
    memo: next,
    changed: true,
    event: memoEvent(
      next,
      eventType,
      change.operation === "update" ? { changedFields } : { fromState: memo.state, toState: state },
    ),
  });
}

function memoEvent(
  memo: Memo,
  eventType: MemoEventType,
  metadata: Pick<MemoEvent["metadata"], "changedFields" | "fromState" | "toState">,
): MemoEvent {
  return {
    memoId: memo.id,
    handoffId: null,
    eventType,
    actor: { kind: "user", id: null },
    rowVersion: memo.rowVersion,
    createdAt: memo.updatedAt,
    metadata: { projectId: memo.projectId, memoId: memo.id, rowVersion: memo.rowVersion, ...metadata },
  };
}

/** Preserve shared error codes while directing Memo callers to supported recovery actions. */
export function memoError(error: AppError): AppError {
  const suggestedCommand =
    error.code === "ROW_VERSION_CONFLICT"
      ? "Re-read the Memo and choose a new action with its observed Row Version"
      : error.code === "AMBIGUOUS_PROJECT"
        ? "Pass --project <project-slug>, or remove the aliased binding"
        : undefined;
  return suggestedCommand ? { ...error, recovery: { suggestedCommand } } : error;
}
