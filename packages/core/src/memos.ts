import { appError, err, ok, type AppError, type Result } from "./errors";
import type { MemoEventType } from "./events";
import { sha256OfText, utf8ByteLength } from "./content";

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

/** The immutable shared-content record a Memo's current body lives in (SHR-004). */
export interface MemoBodyRef {
  recordId: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * One accepted replacement body routed by the fixed threshold (SHR-002): text
 * of at most 65,536 UTF-8 bytes stays inline, every larger accepted text body
 * is Vault-backed and reaches the domain only as its once-computed identity
 * plus the content-record id the write will commit.
 */
export type MemoBodyReplacement = { kind: "inline"; text: string } | { kind: "file"; identity: MemoBodyRef };

export type MemoChange =
  | { operation: "update"; expectedRowVersion: number; title?: string; body?: string }
  | { operation: "done" | "dismiss" | "reopen"; expectedRowVersion: number };

export interface MemoSnapshotChange {
  operation: "update";
  expectedRowVersion: number;
  projectId?: string;
  title?: string;
  body?: MemoBodyReplacement;
}

/**
 * The transactional view of one Memo: complete metadata plus its current
 * record reference, with the exact body text present only when the current
 * record is inline. A file-backed body is never read inside the write
 * transaction (MEM-009); its bytes resolve after commit through the record.
 */
export interface MemoSnapshot {
  id: string;
  projectId: string;
  title: string;
  body: string | null;
  bodyRef: MemoBodyRef;
  state: MemoState;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  createdBy: MemoUser;
  updatedBy: MemoUser;
  closedAt: string | null;
  closedBy: MemoUser | null;
}

export interface MemoSnapshotTransition {
  memo: MemoSnapshot;
  changed: boolean;
  event: MemoEvent | null;
}

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

export function validateMemoBody(value: unknown, bound: number = MEMO_BODY_BYTES): Result<string> {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) {
    return err(appError("MEMO_INVALID_INPUT", "Memo body must be valid Unicode without NUL"));
  }
  if (Buffer.byteLength(value) > bound) {
    return err(appError("MEMO_TOO_LARGE", `Memo body exceeds ${String(bound)} UTF-8 bytes`));
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
  const created = createMemoSnapshot(
    id,
    projectId,
    { title: content.title, body: { kind: "inline", text: content.body } },
    now,
  );
  if (!created.ok) return created;
  if (created.value.memo.body === null) {
    return err(appError("INTERNAL_ERROR", "An inline Memo creation must carry its body text"));
  }
  return ok({
    memo: publicMemoOf(created.value.memo),
    changed: created.value.changed,
    event: created.value.event,
  });
}

/** The snapshot creation path: routes the accepted body and never imposes the inline threshold on Vault-routed text. */
export function createMemoSnapshot(
  id: string,
  projectId: string,
  content: { title: string; body: MemoBodyReplacement },
  now: string,
): Result<MemoSnapshotTransition> {
  if (!isMemoUuid(id) || !isMemoUuid(projectId) || !isMemoTimestamp(now)) {
    return err(appError("MEMO_INVALID_INPUT", "Memo identity or timestamp is invalid"));
  }
  const title = normalizeMemoTitle(content.title);
  if (!title.ok) return title;
  const routed = snapshotBodyOf(content.body);
  if (!routed.ok) return routed;
  const memo: MemoSnapshot = {
    id,
    projectId,
    title: title.value,
    body: routed.value.body,
    bodyRef: routed.value.bodyRef,
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

/**
 * Validates a routed replacement body's shape and derives its snapshot fields.
 * The routed kind carries the fixed threshold invariant (SHR-002): an inline
 * body is at most 65,536 UTF-8 bytes and a file-backed body strictly exceeds
 * it, so a legal larger source string must arrive through the file accepted
 * path with its once-computed identity — never as an oversized inline record.
 * Acceptance bounds belong to the accepting surface; the frozen legacy
 * embedded-receipt and format-2 readers keep this same 65,536 cap.
 */
function snapshotBodyOf(body: MemoBodyReplacement): Result<{ body: string | null; bodyRef: MemoBodyRef }, AppError> {
  if (body.kind === "file") {
    if (!isMemoUuid(body.identity.recordId)) {
      return err(appError("MEMO_INVALID_INPUT", "A Vault-backed Memo body requires its content-record identity"));
    }
    if (
      typeof body.identity.sizeBytes !== "number" ||
      !Number.isSafeInteger(body.identity.sizeBytes) ||
      body.identity.sizeBytes < 0 ||
      body.identity.sizeBytes <= MEMO_BODY_BYTES
    ) {
      return err(
        appError("MEMO_INVALID_INPUT", "A Vault-backed Memo body must exceed the inline threshold with a safe size"),
      );
    }
    if (typeof body.identity.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.identity.sha256)) {
      return err(appError("MEMO_INVALID_INPUT", "A Vault-backed Memo body requires a lowercase SHA-256"));
    }
    return ok({ body: null, bodyRef: body.identity });
  }
  const checked = validateMemoBody(body.text, MEMO_BODY_BYTES);
  if (!checked.ok) return checked;
  const text = checked.value;
  return ok({ body: text, bodyRef: { recordId: "", sizeBytes: utf8ByteLength(text), sha256: sha256OfText(text) } });
}

/** Pure lifecycle calculation over a fully-inline legacy Memo; the adapter must still compare-and-set inside its transaction. */
export function changeMemo(memo: Memo, change: MemoChange, now: string): Result<MemoTransition> {
  const snapshot = snapshotOfInlineMemo(memo);
  const transition =
    change.operation === "update"
      ? changeMemoSnapshot(
          snapshot,
          {
            operation: "update",
            expectedRowVersion: change.expectedRowVersion,
            ...(change.title !== undefined ? { title: change.title } : {}),
            ...(change.body !== undefined ? { body: { kind: "inline" as const, text: change.body } } : {}),
          },
          now,
        )
      : changeMemoSnapshot(
          snapshot,
          { operation: change.operation, expectedRowVersion: change.expectedRowVersion },
          now,
        );
  if (!transition.ok) return transition;
  if (transition.value.memo.body === null) {
    return err(appError("INTERNAL_ERROR", "An inline Memo body replacement must stay inline"));
  }
  return ok({
    memo: transition.value.changed ? publicMemoOf(transition.value.memo) : memo,
    changed: transition.value.changed,
    event: transition.value.event,
  });
}

/**
 * The one projection from a MemoSnapshot to the public Memo DTO: exactly the
 * twelve public fields, so a snapshot's private content-record reference never
 * reaches a response, receipt, or snapshot through object spread. Adapters and
 * serializers resolve bodies through the record explicitly instead.
 */
export function publicMemoOf(snapshot: MemoSnapshot): Memo {
  if (snapshot.body === null) {
    throw new Error("A file-backed Memo body must be resolved from its record before public projection");
  }
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    title: snapshot.title,
    body: snapshot.body,
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

/** Derives the snapshot of a fully-inline legacy Memo; its bodyRef identity is the text's own byte identity. */
export function snapshotOfInlineMemo(memo: Memo): MemoSnapshot {
  return {
    ...memo,
    body: memo.body,
    bodyRef: { recordId: "", sizeBytes: utf8ByteLength(memo.body), sha256: sha256OfText(memo.body) },
  };
}

/**
 * The snapshot lifecycle calculation (MEM-005, MEM-006): pure state and no-op
 * decisions over metadata plus body identity. An inline current body compares
 * by exact string equality; a file-backed current body compares through the
 * recorded immutable byte identity, so no file-backed body is ever read inside
 * a write transaction (MEM-009).
 */
export function changeMemoSnapshot(
  memo: MemoSnapshot,
  change:
    | MemoSnapshotChange
    | { operation: "done" | "dismiss" | "reopen"; expectedRowVersion: number; projectId?: string },
  now: string,
): Result<MemoSnapshotTransition> {
  if (!isMemoRowVersion(change.expectedRowVersion) || !isMemoTimestamp(now)) {
    return err(appError("MEMO_INVALID_INPUT", "Memo expected Row Version or timestamp is invalid"));
  }
  if (change.expectedRowVersion !== memo.rowVersion) {
    return err(appError("ROW_VERSION_CONFLICT", "Memo changed since the observed Row Version"));
  }
  let title = memo.title;
  let body: string | null = memo.body;
  let bodyRef = memo.bodyRef;
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
      const routed = snapshotBodyOf(change.body);
      if (!routed.ok) return routed;
      body = routed.value.body;
      bodyRef = routed.value.bodyRef;
      if (!sameBodyIdentity(memo, bodyRef)) changedFields.push("body");
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
  const next: MemoSnapshot = {
    ...memo,
    title,
    body,
    bodyRef,
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

/** Exact string equality for inline bodies, recorded byte identity for file-backed bodies. */
function sameBodyIdentity(current: MemoSnapshot, next: MemoBodyRef): boolean {
  if (current.body !== null) {
    return (
      next.sizeBytes === current.bodyRef.sizeBytes &&
      next.sha256 === current.bodyRef.sha256 &&
      utf8ByteLength(current.body) === next.sizeBytes &&
      sha256OfText(current.body) === next.sha256
    );
  }
  return next.sizeBytes === current.bodyRef.sizeBytes && next.sha256 === current.bodyRef.sha256;
}

function memoEvent(
  memo: Pick<Memo, "id" | "projectId" | "rowVersion" | "updatedAt">,
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
