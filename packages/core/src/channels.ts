import { createHash } from "node:crypto";
import { buildContentStorageKey, CONTENT_INLINE_MAX_UTF8_BYTES, utf8ByteLength } from "./content";
import { type AppError, appError, err, isRetryableWaitListingFailure, ok, type Result } from "./errors";
import type { ActorRef, ChannelDomainEventType, NewDomainEvent } from "./events";
import { decodeCursor, encodeCursor, filterHash } from "./cursor";
import { MEMO_PREVIEW_BYTES } from "./memos";
import type { AcceptedMemoBody } from "./memo-commands";
import type { Clock, IdGenerator } from "./ids";

/**
 * The Channel domain of TASK-109 (CHN-001 to CHN-011, interface sections 38.3
 * to 38.6, security section 10.1, the reviewed P3 operative addendum): one
 * durable attributed upstream Channel per orchestration invocation, exact
 * main/Worker/Judge registration, metadata-only assignments with the
 * insertion-frozen late flag, attributed text messages through the shared
 * content interface, immutable first handling decisions behind a
 * compare-and-set, pending-inclusive waiting, and metadata-only retained
 * receipts whose replay returns the original outcome verbatim. The M0
 * closed-Channel clarification of interface section 38.3 is operative here:
 * participant registration is open-only, assignment creation/closure and
 * non-main deactivation remain available after close, no M9 operation
 * deactivates the main participant, and an already-terminal repeat of close,
 * deactivate, or assignment close still runs the existence, same-Channel, and
 * asserted main-role-or-User role checks and then changes nothing, appends no
 * event, and returns the current view. The preparation discipline of P3 is
 * binding: the accepted body is captured once per invocation, its canonical
 * request identity, blank check, and bounded preview are prepared outside any
 * mutation transaction and reused on every retry, and the one SQL transaction
 * combines only insert-time facts with that prepared material.
 */

/** The closed text bounds of interface section 38.3. */
export const CHANNEL_TITLE_SCALARS = 200;
export const CHANNEL_TITLE_BYTES = 800;
export const CHANNEL_HANDLE_SCALARS = 64;
export const CHANNEL_HANDLE_BYTES = 256;
export const CHANNEL_NATIVE_PROVENANCE_BYTES = 256;
export const CHANNEL_NATIVE_PROVENANCE_MAX_ENTRIES = 4;
export const CHANNEL_CONTEXT_SCALARS = 200;
export const CHANNEL_CONTEXT_BYTES = 800;
export const CHANNEL_NOTE_BYTES = 8_000;
export const CHANNEL_PREVIEW_BYTES = MEMO_PREVIEW_BYTES;

/** The finite preparation-coherence budget and list-restart bound of the M0 coherence clause. */
export const CHANNEL_WRITE_ATTEMPTS = 3;
export const CHANNEL_LIST_ATTEMPTS = 2;
export const CHANNEL_LIST_BATCH = 200;
/** The bounded external-commit retry backoff of TASK-114 (full jitter; see plan r2 section 5.3). */
export const CHANNEL_RETRY_BASE_MS = 100;
export const CHANNEL_RETRY_MAX_DELAY_MS = 200;
/** The existing validated list upper bound the Channel listings share with the Memo listing (section 38.4). */
export const CHANNEL_LIST_MAX_LIMIT = 200;
/** The original retained-response window; Channel receipts expire 24 hours after their commit. */
export const CHANNEL_RECEIPT_RETENTION_MS = 86_400_000;

/** The central inventory's Channel surface floor; version 11 is the Channel migration (SHR-009, section 38.7). */
export const CHANNEL_SCHEMA_FLOOR = 11;

export type ChannelRole = "main" | "worker" | "judge";
export type MessageKind = "report" | "question" | "relay_request";
export type ChannelLifecycleState = "open" | "closed";
export type AssignmentLifecycleState = "open" | "closed";
/** The asserted closing or handling authority: the main participant, or the User. */
export type ChannelAuthorityKind = "participant" | "user";
/**
 * The creator kinds a Channel may record (section 38.3): the three ActorRef
 * kinds a creator provenance carries — never `system`, which is reserved for
 * the common physical-content family's system actor.
 */
export type ChannelCreatorKind = "registered_project" | "unregistered_workspace" | "user";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isChannelUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

const invalid = (message: string, details?: Record<string, unknown>) =>
  err(appError("CHN_INVALID_INPUT", message, details));

/** One persisted Channel with creator and closing provenance (CHN-008). */
export interface ChannelRecord {
  id: string;
  title: string | null;
  state: ChannelLifecycleState;
  creatorKind: ChannelCreatorKind;
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedByParticipantId: string | null;
  closedByKind: ChannelAuthorityKind | null;
}

export interface ChannelParticipantRecord {
  id: string;
  channelId: string;
  role: ChannelRole;
  handle: string;
  nativeProvenance: string[];
  active: boolean;
  registeredAt: string;
  deactivatedAt: string | null;
}

export interface ChannelAssignmentRecord {
  id: string;
  channelId: string;
  participantId: string | null;
  label: string;
  state: AssignmentLifecycleState;
  createdAt: string;
  closedAt: string | null;
}

/**
 * One persisted message. The body carries the immutable content record's
 * identity plus the exact text when the record is inline, so summaries never
 * re-read storage for inline bodies; file-backed bodies resolve through the
 * bounded body ports outside every transaction.
 */
export interface ChannelMessageRecord {
  id: string;
  channelId: string;
  senderParticipantId: string;
  senderHandle: string;
  kind: MessageKind;
  body: {
    recordId: string;
    representation: "inline" | "file";
    sizeBytes: number;
    sha256: string;
    inlineText: string | null;
  };
  assignmentId: string | null;
  assignmentLate: boolean;
  relayToParticipantId: string | null;
  contextSession: string | null;
  contextNode: string | null;
  contextAttempt: string | null;
  handled: boolean;
  handledAt: string | null;
  handledByParticipantId: string | null;
  handledByKind: ChannelAuthorityKind | null;
  handleNote: string | null;
  processingRowVersion: number;
  createdAt: string;
}

/** The closed public DTOs of interface section 38.4; every named field is present with its null meaning. */
export interface ChannelView {
  id: string;
  title: string | null;
  state: ChannelLifecycleState;
  creatorKind: ChannelCreatorKind;
  creatorId: string | null;
  mainParticipantId: string;
  closedAt: string | null;
  closedByParticipantId: string | null;
  closedByKind: ChannelAuthorityKind | null;
  createdAt: string;
  updatedAt: string;
  participantCount: number;
  messageCount: number;
  unhandledCount: number;
  participants: ParticipantView[];
  assignments: AssignmentView[];
}

export interface ChannelSummary {
  id: string;
  title: string | null;
  state: ChannelLifecycleState;
  mainHandle: string;
  createdAt: string;
  closedAt: string | null;
}

export interface ParticipantView {
  id: string;
  channelId: string;
  role: ChannelRole;
  handle: string;
  nativeProvenance: string[];
  active: boolean;
  deactivatedAt: string | null;
  registeredAt: string;
}

export interface AssignmentView {
  id: string;
  channelId: string;
  participantId: string | null;
  label: string;
  state: AssignmentLifecycleState;
  createdAt: string;
  closedAt: string | null;
}

export interface MessageSummary {
  id: string;
  channelId: string;
  kind: MessageKind;
  senderParticipantId: string;
  senderHandle: string;
  assignmentId: string | null;
  assignmentLate: boolean;
  relayToParticipantId: string | null;
  contextSession: string | null;
  contextNode: string | null;
  contextAttempt: string | null;
  handled: boolean;
  handledAt: string | null;
  handledByParticipantId: string | null;
  handledByKind: ChannelAuthorityKind | null;
  handleNote: string | null;
  processingRowVersion: number;
  createdAt: string;
  bodyBytes: number;
  bodyPreview: string;
  bodyPreviewTruncated: boolean;
}

export interface MessageDetail extends MessageSummary {
  body: string;
}

/** One aggregate read for `show` and the view builders: the Channel with its complete current rosters and counts. */
export interface ChannelAggregate {
  channel: ChannelRecord;
  participants: ChannelParticipantRecord[];
  assignments: ChannelAssignmentRecord[];
  mainParticipantId: string;
  messageCount: number;
  unhandledCount: number;
}

/** The content plan a message submission commits atomically with its rows (SHR-004, SHR-005). */
export type ChannelContentPlan =
  | { kind: "inline"; contentId: string; text: string; sizeBytes: number; sha256: string }
  | {
      kind: "file";
      contentId: string;
      intentId: string;
      stagedPath: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    };

/**
 * Validates one creation actor's provenance against the closed creator kinds
 * of section 38.3: exactly `registered_project`, `unregistered_workspace`, or
 * `user` — never `system` — with a non-null Project UUID or workspace key for
 * the first two and a null id for the User.
 */
export function validateChannelCreatorActor(
  actor: ActorRef,
): Result<{ creatorKind: ChannelCreatorKind; creatorId: string | null }> {
  if (actor.kind === "registered_project" || actor.kind === "unregistered_workspace") {
    if (typeof actor.id !== "string" || actor.id.length === 0) {
      return invalid(`A ${actor.kind} Channel creator must carry its stable actor id`);
    }
    return ok({ creatorKind: actor.kind, creatorId: actor.id });
  }
  if (actor.kind === "user") {
    if (actor.id !== null) {
      return invalid("A user Channel creator carries no actor id");
    }
    return ok({ creatorKind: "user", creatorId: null });
  }
  return invalid("A system actor cannot create a Channel");
}

/** A retained Channel receipt in its stored metadata-only form: the original outcome, never a body or content reference. */
export interface StoredChannelSubmitReceipt {
  requestHash: string;
  message: MessageSummary;
}

export interface StoredChannelCreateReceipt {
  requestHash: string;
  channel: ChannelView;
}

/** The once-captured accepted body the transports hand the composition (SHR-002, SHR-012, P3 step 1). */
export type AcceptedChannelBody = AcceptedMemoBody;

/** The prepared-once material of P3 step 2: identity, blank check, and preview, all outside SQL and reused on every retry. */
export interface PreparedChannelBody {
  sizeBytes: number;
  sha256: string;
  preview: { bodyPreview: string; bodyPreviewTruncated: boolean };
  inlineText: string | null;
}

// ---------------------------------------------------------------------------
// Bounds validation (interface section 38.3)

function isSingleLineWellFormed(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && !/[\p{Cc}\u2028\u2029]/u.test(value);
}

/**
 * The provenance single-line rule for untrusted verbatim fields — native
 * provenance entries and the external workflow context (section 38.3): well-
 * formed Unicode whose only forbidden scalars are the explicit line separators
 * LF, VT, FF, CR, NEL, LS, and PS. Everything else, including TAB and the
 * domain's NUL, stays verbatim — no trim, no strip, no replace, and no global
 * control ban (the TaskJudge and consumer semantic correction).
 */
const PROVENANCE_LINE_SEPARATORS = /[\n\v\f\r\u0085\u2028\u2029]/u;

function isSingleLineProvenanceText(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && !PROVENANCE_LINE_SEPARATORS.test(value);
}

/** A Channel title: null at creation, else a trimmed single line of 1 to 200 scalars and at most 800 UTF-8 bytes. */
export function normalizeChannelTitle(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (!isSingleLineWellFormed(value)) {
    return invalid("Channel title must be valid single-line Unicode text");
  }
  const title = value.trim();
  if (title.length === 0 || [...title].length > CHANNEL_TITLE_SCALARS || utf8ByteLength(title) > CHANNEL_TITLE_BYTES) {
    return invalid("Channel title must contain 1 to 200 scalars and at most 800 UTF-8 bytes");
  }
  return ok(title);
}

/**
 * A participant handle: a single line of 1 to 64 scalars and at most 256 UTF-8
 * bytes, control-free and never trimmed because it is an identity (section
 * 38.3). The only empty handle is the empty string: a blank-looking handle
 * built from whitespace or a lone byte-order mark is nonempty and stays
 * byte-exact, while TAB, NUL, and every other control scalar remain invalid.
 */
export function validateChannelHandle(value: unknown): Result<string> {
  if (!isSingleLineWellFormed(value)) {
    return invalid("Participant handle must be valid single-line Unicode text");
  }
  const handle = value as string;
  if (
    handle.length === 0 ||
    [...handle].length > CHANNEL_HANDLE_SCALARS ||
    utf8ByteLength(handle) > CHANNEL_HANDLE_BYTES
  ) {
    return invalid("Participant handle must contain 1 to 64 scalars and at most 256 UTF-8 bytes");
  }
  return ok(handle);
}

/** Native provenance entries: at most four single lines of at most 256 UTF-8 bytes, recorded verbatim as untrusted attribution. */
export function validateNativeProvenance(entries: unknown): Result<string[]> {
  if (!Array.isArray(entries)) return invalid("Native provenance must be supplied as a list");
  if (entries.length > CHANNEL_NATIVE_PROVENANCE_MAX_ENTRIES) {
    return invalid("At most four native provenance entries are recorded");
  }
  const values: string[] = [];
  for (const entry of entries) {
    // An empty entry is a supplied value recorded verbatim and stays distinct
    // from an absent entry (section 38.3, the semantic correction); the only
    // forbidden scalars are the explicit line separators.
    if (!isSingleLineProvenanceText(entry)) {
      return invalid("Each native provenance entry must be single-line Unicode text");
    }
    if (utf8ByteLength(entry as string) > CHANNEL_NATIVE_PROVENANCE_BYTES) {
      return invalid("Each native provenance entry must carry at most 256 UTF-8 bytes");
    }
    values.push(entry as string);
  }
  return ok(values);
}

/** An assignment label: a trimmed single line of 1 to 200 scalars and at most 800 UTF-8 bytes. */
export function normalizeAssignmentLabel(value: unknown): Result<string> {
  if (!isSingleLineWellFormed(value)) {
    return invalid("Assignment label must be valid single-line Unicode text");
  }
  const label = value.trim();
  if (label.length === 0 || [...label].length > CHANNEL_TITLE_SCALARS || utf8ByteLength(label) > CHANNEL_TITLE_BYTES) {
    return invalid("Assignment label must contain 1 to 200 scalars and at most 800 UTF-8 bytes");
  }
  return ok(label);
}

/**
 * One external workflow context field: well-formed single-line Unicode of at
 * most 200 scalars and 800 UTF-8 bytes, supplied verbatim as untrusted
 * provenance — only the explicit line separators are forbidden, so TAB and the
 * domain's NUL stay verbatim. An empty string is a supplied value and stays
 * verbatim; null means absent.
 */
export function validateContextField(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (!isSingleLineProvenanceText(value)) {
    return invalid("Channel context must be valid single-line Unicode text");
  }
  const text = value as string;
  if ([...text].length > CHANNEL_CONTEXT_SCALARS || utf8ByteLength(text) > CHANNEL_CONTEXT_BYTES) {
    return invalid("Channel context must carry at most 200 scalars and 800 UTF-8 bytes");
  }
  return ok(text);
}

/** A handling note: at most 8,000 UTF-8 bytes of verbatim text; null means no note was supplied. */
export function validateHandleNote(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string" || !value.isWellFormed()) {
    return invalid("Handling note must be valid Unicode text");
  }
  if (utf8ByteLength(value) > CHANNEL_NOTE_BYTES) {
    return invalid("Handling note must carry at most 8,000 UTF-8 bytes");
  }
  return ok(value);
}

/**
 * The Channel body's domain rule beyond the shared exact-bytes text rules: the
 * body must be nonempty after trimming and at most the shared accepted-body
 * bound, while the stored bytes stay the exact accepted bytes — trim never
 * rewrites them (CHN-004, SHR-002).
 */
export function checkChannelBodyText(text: string, maxBytes: number): Result<void> {
  if (text.includes("\0")) return invalid("Channel message body must not contain NUL");
  if (text.trim().length === 0) return invalid("Channel message body must be nonempty after trimming");
  if (utf8ByteLength(text) > maxBytes) {
    return err(
      appError(
        "CHN_TOO_LARGE",
        `The Channel body crossed the accepted bound artifact.maxBytes ${String(maxBytes)} bytes`,
        {
          maxBytes,
          sizeBytes: utf8ByteLength(text),
        },
      ),
    );
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Event metadata (security section 10.1, closed key sets)

export function channelCreatedMetadata(input: {
  channelId: string;
  mainParticipantId: string;
}): Record<string, unknown> {
  return { channelId: input.channelId, mainParticipantId: input.mainParticipantId };
}

export function channelClosedMetadata(input: {
  channelId: string;
  actingParticipantId: string | null;
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    actingParticipantId: input.actingParticipantId,
    fromState: "open",
    toState: "closed",
  };
}

export function participantRegisteredMetadata(input: {
  channelId: string;
  actingParticipantId: string | null;
  participantId: string;
  role: "worker" | "judge";
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    actingParticipantId: input.actingParticipantId,
    participantId: input.participantId,
    role: input.role,
  };
}

export function participantDeactivatedMetadata(input: {
  channelId: string;
  actingParticipantId: string | null;
  participantId: string;
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    actingParticipantId: input.actingParticipantId,
    participantId: input.participantId,
    fromActive: true,
    toActive: false,
  };
}

export function assignmentCreatedMetadata(input: {
  channelId: string;
  actingParticipantId: string | null;
  assignmentId: string;
  participantId: string | null;
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    actingParticipantId: input.actingParticipantId,
    assignmentId: input.assignmentId,
    participantId: input.participantId,
  };
}

export function assignmentClosedMetadata(input: {
  channelId: string;
  actingParticipantId: string | null;
  assignmentId: string;
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    actingParticipantId: input.actingParticipantId,
    assignmentId: input.assignmentId,
    fromState: "open",
    toState: "closed",
  };
}

export function messageSubmittedMetadata(input: {
  channelId: string;
  senderParticipantId: string;
  messageId: string;
  kind: MessageKind;
  assignmentId: string | null;
  assignmentLate: boolean;
  relayToParticipantId: string | null;
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    participantId: input.senderParticipantId,
    messageId: input.messageId,
    kind: input.kind,
    assignmentId: input.assignmentId,
    assignmentLate: input.assignmentLate,
    relayToParticipantId: input.relayToParticipantId,
    processingRowVersion: 1,
  };
}

export function messageHandledMetadata(input: {
  channelId: string;
  actingParticipantId: string | null;
  messageId: string;
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    actingParticipantId: input.actingParticipantId,
    messageId: input.messageId,
    processingRowVersion: 2,
  };
}

const CHANNEL_EVENT_KEYS: Record<ChannelDomainEventType, { keys: string[]; rowVersion: number | null }> = {
  CHANNEL_CREATED: { keys: ["channelId", "mainParticipantId"], rowVersion: null },
  CHANNEL_CLOSED: { keys: ["channelId", "actingParticipantId", "fromState", "toState"], rowVersion: null },
  CHANNEL_PARTICIPANT_REGISTERED: {
    keys: ["channelId", "actingParticipantId", "participantId", "role"],
    rowVersion: null,
  },
  CHANNEL_PARTICIPANT_DEACTIVATED: {
    keys: ["channelId", "actingParticipantId", "participantId", "fromActive", "toActive"],
    rowVersion: null,
  },
  CHANNEL_ASSIGNMENT_CREATED: {
    keys: ["channelId", "actingParticipantId", "assignmentId", "participantId"],
    rowVersion: null,
  },
  CHANNEL_ASSIGNMENT_CLOSED: {
    keys: ["channelId", "actingParticipantId", "assignmentId", "fromState", "toState"],
    rowVersion: null,
  },
  CHANNEL_MESSAGE_SUBMITTED: {
    keys: [
      "channelId",
      "participantId",
      "messageId",
      "kind",
      "assignmentId",
      "assignmentLate",
      "relayToParticipantId",
      "processingRowVersion",
    ],
    rowVersion: 1,
  },
  CHANNEL_MESSAGE_HANDLED: {
    keys: ["channelId", "actingParticipantId", "messageId", "processingRowVersion"],
    rowVersion: 2,
  },
};

function isUuidOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID.test(value));
}

/**
 * Validates one Channel domain event's closed metadata exactly as the append
 * path and the restore reconciliation must (security section 10.1): every
 * listed key present, no additional key, UUID-or-null where the catalog allows
 * the User's null, the frozen enum values where the catalog fixes them, and no
 * free text anywhere.
 */
export function validateChannelEventMetadata(
  eventType: ChannelDomainEventType,
  metadata: unknown,
): Result<void, AppError> {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata is not an object.`));
  }
  const value = metadata as Record<string, unknown>;
  const contract = CHANNEL_EVENT_KEYS[eventType];
  const keys = Object.keys(value);
  if (!contract.keys.every((key) => Object.hasOwn(value, key)) || keys.some((key) => !contract.keys.includes(key))) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata does not carry its closed key set.`));
  }
  if (!isChannelUuid(value.channelId)) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a non-UUID channelId.`));
  }
  if (Object.hasOwn(value, "actingParticipantId") && !isUuidOrNull(value.actingParticipantId)) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid actingParticipantId.`),
    );
  }
  if (Object.hasOwn(value, "mainParticipantId") && !isChannelUuid(value.mainParticipantId)) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a non-UUID mainParticipantId.`),
    );
  }
  if (eventType === "CHANNEL_ASSIGNMENT_CREATED") {
    // The assignment catalog row is `participantId: UUID-or-null` exactly as
    // security section 10.1 fixes it: an unbound assignment carries null.
    if (!isUuidOrNull(value.participantId)) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid participantId.`),
      );
    }
  } else if (Object.hasOwn(value, "participantId")) {
    // The participant and submission rows carry a strict UUID sender or
    // subject; the User's null belongs to actingParticipantId alone.
    if (!isChannelUuid(value.participantId)) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid participantId.`),
      );
    }
  }
  if (Object.hasOwn(value, "assignmentId") && !isUuidOrNull(value.assignmentId)) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid assignmentId.`));
  }
  if (Object.hasOwn(value, "messageId") && !isChannelUuid(value.messageId)) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a non-UUID messageId.`));
  }
  if (Object.hasOwn(value, "relayToParticipantId") && !isUuidOrNull(value.relayToParticipantId)) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid relayToParticipantId.`),
    );
  }
  if (Object.hasOwn(value, "role") && value.role !== "worker" && value.role !== "judge") {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a role other than worker or judge.`),
    );
  }
  if (Object.hasOwn(value, "kind")) {
    if (value.kind !== "report" && value.kind !== "question" && value.kind !== "relay_request") {
      return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid message kind.`));
    }
  }
  if (Object.hasOwn(value, "fromState") && value.fromState !== "open") {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a fromState other than open.`),
    );
  }
  if (Object.hasOwn(value, "toState") && value.toState !== "closed") {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a toState other than closed.`),
    );
  }
  if (Object.hasOwn(value, "fromActive") && value.fromActive !== true) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a fromActive other than true.`),
    );
  }
  if (Object.hasOwn(value, "toActive") && value.toActive !== false) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a toActive other than false.`),
    );
  }
  if (Object.hasOwn(value, "assignmentLate") && typeof value.assignmentLate !== "boolean") {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a non-boolean assignmentLate.`),
    );
  }
  if (Object.hasOwn(value, "processingRowVersion") && value.processingRowVersion !== contract.rowVersion) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries the wrong processingRowVersion.`),
    );
  }
  return ok(undefined);
}

/** One Channel domain event before its in-transaction append. */
export interface ChannelEventInput {
  eventType: ChannelDomainEventType;
  actor: ActorRef;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Builds one NewDomainEvent for the Channel family; the row keeps handoffId and memoId null (section 38.9). */
export function channelDomainEvent(id: string, event: ChannelEventInput): NewDomainEvent {
  return {
    id,
    handoffId: null,
    eventType: event.eventType,
    actor: event.actor,
    rowVersion: CHANNEL_EVENT_KEYS[event.eventType].rowVersion,
    metadata: event.metadata,
    createdAt: event.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Request identity and preview (P3 steps 1 and 2)

/**
 * The canonical Channel request identity: a SHA-256 over the canonical JSON of
 * the operation, the installation, the Channel, the sorted business fields, and
 * the accepted body's captured identity. The body contributes the digest the
 * single bounded-chunk capture pass already computed — never a second stream,
 * never a whole-body buffer — so identity binds the exact accepted bytes once
 * and stays identical across every retry.
 */
export function composeChannelRequestDigest(input: {
  operation: string;
  installationId: string;
  channelId: string | null;
  fields: Record<string, string | number | boolean | null>;
  body: { sha256: string; sizeBytes: number } | null;
}): string {
  const canonical = JSON.stringify([
    input.operation,
    input.installationId,
    input.channelId,
    Object.keys(input.fields)
      .sort()
      .map((key) => [key, input.fields[key]] as [string, string | number | boolean | null]),
    input.body === null ? null : [input.body.sha256, input.body.sizeBytes],
  ]);
  return createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
}

/** The one bounded-preview rule: accumulate scalars while the cumulative UTF-8 byte count stays within 512 bytes. */
export function channelPreviewOf(
  previewSeed: string,
  totalBodyBytes: number,
): { bodyPreview: string; bodyPreviewTruncated: boolean } {
  let bodyPreview = "";
  let size = 0;
  for (const scalar of previewSeed) {
    size += utf8ByteLength(scalar);
    if (size > CHANNEL_PREVIEW_BYTES) break;
    bodyPreview += scalar;
  }
  return { bodyPreview, bodyPreviewTruncated: utf8ByteLength(bodyPreview) < totalBodyBytes };
}

// ---------------------------------------------------------------------------
// Ports

/** The connection-local operation-coherence seam, the Channel twin of the Memo seam of ADR-0032 and its TASK-109 amendment. */
export interface ChannelCoherencePorts {
  captureExternalVersion(): Result<number, AppError>;
  classifyExternalChange(
    expectedVaultPath: string,
  ): Result<"vault-move-held" | "vault-path-changed" | "external-commit", AppError>;
  moveLockHeld(): boolean;
}

/**
 * The injected retry-timing seam of TASK-114 section 5.3: full jitter never
 * calls a hidden timer or randomness source from core. The adapter composes a
 * blocking sleep and `Math.random`; tests inject a recording sleep and a
 * deterministic sequence. A delay is only applied after an `external-commit`
 * mismatch and only before another attempt, outside every transaction.
 */
export interface ChannelBackoffPorts {
  sleepMs(ms: number): void;
  random(): number;
}

export interface ChannelStagingPorts {
  freshBinding(): Result<{ vaultPath: string }, AppError>;
  /** Streams the accepted body's exact bytes into the bound Vault's `staging/` tree; never a whole-body buffer. */
  stageAccepted(
    accepted: AcceptedChannelBody,
    binding: { vaultPath: string },
  ): Result<{ stagedPath: string; sizeBytes: number; sha256: string }, AppError>;
  /** The post-commit activation gate and shared completion transaction; `paused` leaves the committed intent durably pending. */
  activateContent(
    input: {
      intentId: string;
      contentId: string;
      ownerChannelId: string;
      stagedPath: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    },
    binding: { vaultPath: string },
  ): Result<{ status: "completed" } | { status: "paused" }, AppError>;
}

/** One message body's record identity, the bounded read surface's input. */
export interface ChannelBodyRef {
  recordId: string;
  representation: "inline" | "file";
  sizeBytes: number;
  sha256: string;
}

/** The bounded body readers backed by the shared content store; file-backed reads resolve outside every transaction. */
export interface ChannelBodyPorts {
  /** Reads the accepted spool's bounded head bytes for the once-prepared preview seed; never the whole body. */
  readAcceptedPreviewSeed(accepted: AcceptedChannelBody): Result<string, AppError>;
  /**
   * The full accepted-body nonblank proof (CHN-004, the F5 correction): streams
   * the accepted spool's exact bytes in bounded chunks and proves at least one
   * non-whitespace scalar exists — never a whole-body materialization, never a
   * prefix-only guess, never a second UTF-8 or bound validator, because the
   * capture pass already owns those.
   */
  proveAcceptedNonBlank(accepted: AcceptedChannelBody): Result<void, AppError>;
  /** Reads one record's bounded head seed for list summaries, outside any transaction. */
  readRecordPreviewSeed(ref: ChannelBodyRef, binding: { vaultPath: string }): Result<string, AppError>;
  /** Resolves a record's complete exact text outside any transaction, honestly reporting materializing and corrupt bytes. */
  resolveBody(ref: ChannelBodyRef, binding: { vaultPath: string }): Result<string, AppError>;
  /**
   * Database-only content-state probe: the message's content representation and
   * whether the record is materialized. Never reads the filesystem.
   */
  messageContentState(
    channelId: string,
    messageId: string,
  ): Result<{ representation: "inline" | "file"; materialized: boolean }, AppError>;
}

/** The actor assertion one mutation carries: the resolved provenance plus the asserted participant or User context. */
export interface ChannelActorAssertion {
  actor: ActorRef;
  /** The `--as-participant` assertion; a main-role operation needs the main participant or the User. */
  asParticipant?: string;
  asUser?: boolean;
}

export interface ChannelRunOptions {
  expectedExternalVersion?: number;
}

export interface ChannelTransaction {
  channel(id: string): Result<ChannelRecord | null>;
  participants(channelId: string): Result<ChannelParticipantRecord[]>;
  participant(channelId: string, participantId: string): Result<ChannelParticipantRecord | null>;
  participantByHandle(channelId: string, handle: string): Result<ChannelParticipantRecord | null>;
  assignment(channelId: string, assignmentId: string): Result<ChannelAssignmentRecord | null>;
  message(channelId: string, messageId: string): Result<ChannelMessageRecord | null>;
  submitReceipt(key: string, scope: string, now: string): Result<StoredChannelSubmitReceipt | null>;
  createReceipt(key: string, scope: string, now: string): Result<StoredChannelCreateReceipt | null>;
  /** Records the plan's immutable content record — and, for a file plan, its activation intent — inside this open transaction. */
  commitContent(plan: ChannelContentPlan, ownerChannelId: string, createdAt: string): Result<void>;
  insertChannel(row: ChannelRecord): Result<void>;
  insertParticipant(row: ChannelParticipantRecord): Result<void>;
  insertAssignment(row: ChannelAssignmentRecord): Result<void>;
  insertMessage(row: ChannelMessageRecord): Result<void>;
  /**
   * The guarded close: exactly one change when the Channel is open, zero
   * changes when already closed — the M0 unchanged no-op still runs after the
   * caller's existence and role checks.
   */
  closeChannel(
    id: string,
    closedAt: string,
    closedByParticipantId: string | null,
    closedByKind: ChannelAuthorityKind,
  ): Result<"changed" | "unchanged">;
  deactivateParticipant(id: string, deactivatedAt: string): Result<"changed" | "unchanged">;
  closeAssignment(id: string, closedAt: string): Result<"changed" | "unchanged">;
  /** The compare-and-set handling decision against the currently unhandled row. */
  handleMessage(
    channelId: string,
    messageId: string,
    decision: {
      handledAt: string;
      handledByParticipantId: string | null;
      handledByKind: ChannelAuthorityKind;
      handleNote: string | null;
    },
  ): Result<"changed">;
  appendEvent(id: string, event: ChannelEventInput): Result<void>;
  storeSubmitReceipt(
    key: string,
    scope: string,
    requestHash: string,
    summary: MessageSummary,
    createdAt: string,
    expiresAt: string,
  ): Result<void>;
  storeCreateReceipt(
    key: string,
    scope: string,
    requestHash: string,
    view: ChannelView,
    createdAt: string,
    expiresAt: string,
  ): Result<void>;
}

export interface ChannelReader {
  aggregate(channelId: string): Result<ChannelAggregate | null>;
  message(channelId: string, messageId: string): Result<ChannelMessageRecord | null>;
}

export interface ChannelListFilter {
  state: "open" | "closed" | "all";
}

export interface MessageListFilter {
  handling: "unhandled" | "handled" | "all";
  participantId: string | null;
  assignmentId: string | null;
  kind: MessageKind | null;
}

export interface ChannelListCapture {
  summaries: ChannelSummary[];
  lastSortKey: { createdAt: string; id: string } | null;
  exhausted: boolean;
}

export interface MessageListCapture {
  records: ChannelMessageRecord[];
  lastSortKey: { createdAt: string; id: string } | null;
  exhausted: boolean;
}

export interface ChannelRepository {
  aggregate(channelId: string): Result<ChannelAggregate | null>;
  message(channelId: string, messageId: string): Result<ChannelMessageRecord | null>;
  captureChannelList(
    filter: ChannelListFilter,
    after: { createdAt: string; id: string } | undefined,
    batchSize: number,
  ): Result<ChannelListCapture>;
  captureMessageList(
    channelId: string,
    filter: MessageListFilter,
    after: { createdAt: string; id: string } | undefined,
    batchSize: number,
  ): Result<MessageListCapture>;
  run<T>(work: (transaction: ChannelTransaction) => Result<T>, options?: ChannelRunOptions): Result<T>;
  inspect<T>(work: (reader: ChannelReader) => Result<T>): Result<T>;
}

export interface ChannelCommandPorts {
  installationId: string;
  maxBytes: number;
  defaultPageSize: number;
  channels: ChannelRepository;
  bodies: ChannelBodyPorts;
  coherence: ChannelCoherencePorts;
  backoff: ChannelBackoffPorts;
  staging: ChannelStagingPorts;
  clock: Clock;
  ids: IdGenerator;
  /** The SHR-011 large-content disclosure seam: fires once, after the fresh body's SQL commit, never changing the outcome. */
  disclosures?: {
    backupEnabled: boolean;
    thresholdBytes: number;
    largeContent(sizeBytes: number, thresholdBytes: number): void;
    /** The contained post-commit warning sink (SHR-015): a throwing sink never changes the result. */
    completionWarning?(text: string): void;
  };
}

// ---------------------------------------------------------------------------
// View builders

export function participantViewOf(participant: ChannelParticipantRecord): ParticipantView {
  return {
    id: participant.id,
    channelId: participant.channelId,
    role: participant.role,
    handle: participant.handle,
    nativeProvenance: participant.nativeProvenance,
    active: participant.active,
    deactivatedAt: participant.deactivatedAt,
    registeredAt: participant.registeredAt,
  };
}

export function assignmentViewOf(assignment: ChannelAssignmentRecord): AssignmentView {
  return {
    id: assignment.id,
    channelId: assignment.channelId,
    participantId: assignment.participantId,
    label: assignment.label,
    state: assignment.state,
    createdAt: assignment.createdAt,
    closedAt: assignment.closedAt,
  };
}

/** The deterministic roster orders of section 38.8: participants by `(registeredAt, id)`, assignments by `(createdAt, id)`. */
export function orderedRoster(aggregate: ChannelAggregate): {
  participants: ChannelParticipantRecord[];
  assignments: ChannelAssignmentRecord[];
} {
  const participants = [...aggregate.participants].sort((a, b) =>
    a.registeredAt < b.registeredAt ? -1 : a.registeredAt > b.registeredAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const assignments = [...aggregate.assignments].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { participants, assignments };
}

export function channelViewOf(aggregate: ChannelAggregate): ChannelView {
  const roster = orderedRoster(aggregate);
  return {
    id: aggregate.channel.id,
    title: aggregate.channel.title,
    state: aggregate.channel.state,
    creatorKind: aggregate.channel.creatorKind,
    creatorId: aggregate.channel.creatorId,
    mainParticipantId: aggregate.mainParticipantId,
    closedAt: aggregate.channel.closedAt,
    closedByParticipantId: aggregate.channel.closedByParticipantId,
    closedByKind: aggregate.channel.closedByKind,
    createdAt: aggregate.channel.createdAt,
    updatedAt: aggregate.channel.updatedAt,
    participantCount: aggregate.participants.length,
    messageCount: aggregate.messageCount,
    unhandledCount: aggregate.unhandledCount,
    participants: roster.participants.map(participantViewOf),
    assignments: roster.assignments.map(assignmentViewOf),
  };
}

export function channelSummaryOf(aggregate: ChannelAggregate): ChannelSummary {
  const main = aggregate.participants.find((participant) => participant.id === aggregate.mainParticipantId);
  return {
    id: aggregate.channel.id,
    title: aggregate.channel.title,
    state: aggregate.channel.state,
    mainHandle: main?.handle ?? "",
    createdAt: aggregate.channel.createdAt,
    closedAt: aggregate.channel.closedAt,
  };
}

export function messageSummaryOf(
  message: ChannelMessageRecord,
  preview: { bodyPreview: string; bodyPreviewTruncated: boolean },
): MessageSummary {
  return {
    id: message.id,
    channelId: message.channelId,
    kind: message.kind,
    senderParticipantId: message.senderParticipantId,
    senderHandle: message.senderHandle,
    assignmentId: message.assignmentId,
    assignmentLate: message.assignmentLate,
    relayToParticipantId: message.relayToParticipantId,
    contextSession: message.contextSession,
    contextNode: message.contextNode,
    contextAttempt: message.contextAttempt,
    handled: message.handled,
    handledAt: message.handledAt,
    handledByParticipantId: message.handledByParticipantId,
    handledByKind: message.handledByKind,
    handleNote: message.handleNote,
    processingRowVersion: message.processingRowVersion,
    createdAt: message.createdAt,
    bodyBytes: message.body.sizeBytes,
    bodyPreview: preview.bodyPreview,
    bodyPreviewTruncated: preview.bodyPreviewTruncated,
  };
}

// ---------------------------------------------------------------------------
// The coherence mutation runner (the M0 coherence clause, P3 steps 3 to 6)

function pausedError(): AppError {
  return appError(
    "SERVICE_PAUSED",
    "A Vault move or restore is in progress; the Channel operation paused instead of racing it.",
  );
}

function coherenceExhausted(keyPresent: boolean, lastClass: "vault-path-changed" | "external-commit"): AppError {
  if (lastClass === "vault-path-changed") {
    return {
      ...appError(
        "CONFIG_CONFLICT",
        "The configuration or Vault binding changed while this Channel operation was being prepared",
      ),
      recovery: {
        suggestedCommand: keyPresent
          ? "Reload the configuration and retry the identical request with its original mode, inputs, and key"
          : "Reload the configuration and retry the identical request",
      },
    };
  }
  return {
    ...appError(
      "STORAGE_INSPECTION_UNAVAILABLE",
      "A coherent storage state could not be established while this Channel operation was being prepared; this invocation committed nothing",
    ),
    recovery: {
      suggestedCommand: keyPresent
        ? "Retry the identical request with its original mode, inputs, and key; this invocation committed nothing and settles no earlier unknown outcome"
        : "Retry the identical request; this Channel operation committed nothing",
    },
  };
}

function isCoherenceMismatch(error: AppError): boolean {
  return error.code === "SERVICE_PAUSED" && error.details !== undefined && error.details.coherenceMismatch === true;
}

/** The full-jitter delay of one `external-commit` retry (TASK-114 section 5.3, base 100 ms). */
function channelRetryDelayMs(retryIndex: number, random: number): number {
  const ceiling = Math.min(CHANNEL_RETRY_MAX_DELAY_MS, CHANNEL_RETRY_BASE_MS * 2 ** retryIndex);
  return Math.floor(random * ceiling);
}

/**
 * The finite preparation-coherence loop every Channel mutation runs (P3 steps
 * 3 to 6): fence probe, external-version capture, fresh binding before any
 * staging, one version-guarded transaction, and classification of a mismatch
 * into a pause, a restage, or a plain restart within the bounded budget.
 */
function runChannelMutation<T>(
  ports: ChannelCommandPorts,
  stagedBody: AcceptedChannelBody | null,
  keyPresent: boolean,
  work: (
    transaction: ChannelTransaction,
    now: string,
    stagedPath: string | null,
    binding: { vaultPath: string },
  ) => Result<T>,
): Result<T> {
  let staged: { vaultPath: string; stagedPath: string } | null = null;
  let lastClass: "vault-path-changed" | "external-commit" = "external-commit";
  for (let attempt = 0; attempt < CHANNEL_WRITE_ATTEMPTS; attempt++) {
    if (ports.coherence.moveLockHeld()) return err(pausedError());
    const version = ports.coherence.captureExternalVersion();
    if (!version.ok) return version;
    const binding = ports.staging.freshBinding();
    if (!binding.ok) return binding;
    if (stagedBody !== null && (staged === null || staged.vaultPath !== binding.value.vaultPath)) {
      const stage = ports.staging.stageAccepted(stagedBody, binding.value);
      if (!stage.ok) return stage;
      if (stage.value.sizeBytes !== stagedBody.sizeBytes || stage.value.sha256 !== stagedBody.sha256) {
        return err(appError("STORAGE_INTEGRITY_ERROR", "The accepted Channel body changed before staging completed"));
      }
      staged = { vaultPath: binding.value.vaultPath, stagedPath: stage.value.stagedPath };
    }
    const run = ports.channels.run(
      (transaction) =>
        work(transaction, ports.clock.now().toISOString(), staged === null ? null : staged.stagedPath, binding.value),
      { expectedExternalVersion: version.value },
    );
    if (run.ok) return run;
    if (isCoherenceMismatch(run.error)) {
      const classified = ports.coherence.classifyExternalChange(binding.value.vaultPath);
      if (!classified.ok) return classified;
      if (classified.value === "vault-move-held") return err(pausedError());
      lastClass = classified.value === "vault-path-changed" ? "vault-path-changed" : "external-commit";
      // Only an external-commit restart sleeps, only before another attempt,
      // and always outside the closed transaction. Full jitter uses the
      // injected ports; a vault-path-changed retry and the final exhausted
      // attempt never delay.
      if (lastClass === "external-commit" && attempt + 1 < CHANNEL_WRITE_ATTEMPTS) {
        ports.backoff.sleepMs(channelRetryDelayMs(attempt, ports.backoff.random()));
      }
      continue;
    }
    return run;
  }
  return err(coherenceExhausted(keyPresent, lastClass));
}

// ---------------------------------------------------------------------------
// Mutations

function requireMainRole(
  channel: ChannelRecord,
  participants: ChannelParticipantRecord[],
  assertion: ChannelActorAssertion,
): Result<{ actingParticipantId: string | null; authority: ChannelAuthorityKind; mainParticipantId: string }> {
  const main = participants.find((candidate) => candidate.role === "main");
  if (main === undefined) {
    return err(appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.id} has no main participant.`));
  }
  if (assertion.asUser === true) {
    return ok({ actingParticipantId: null, authority: "user", mainParticipantId: main.id });
  }
  if (assertion.asParticipant !== undefined && assertion.asParticipant === main.id) {
    return ok({ actingParticipantId: main.id, authority: "participant", mainParticipantId: main.id });
  }
  return err(appError("CHN_FORBIDDEN_ROLE", "The operation requires the main participant or the User"));
}

/** Creates one open Channel with its single main participant and exactly one CHANNEL_CREATED event (CHN-001, CHN-008). */
export function createChannel(
  ports: ChannelCommandPorts,
  input: { creator: ActorRef; mainHandle: unknown; title: unknown; idempotencyKey?: string },
): Result<{ channel: ChannelView; replayed: boolean }> {
  const creator = validateChannelCreatorActor(input.creator);
  if (!creator.ok) return creator;
  const handle = validateChannelHandle(input.mainHandle);
  if (!handle.ok) return handle;
  const title = normalizeChannelTitle(input.title);
  if (!title.ok) return title;
  const hash = composeChannelRequestDigest({
    operation: "channel-create",
    installationId: ports.installationId,
    channelId: null,
    fields: {
      mainHandle: handle.value,
      title: title.value,
      creatorKind: creator.value.creatorKind,
      creatorId: creator.value.creatorId,
    },
    body: null,
  });
  const scope = channelCreateScope(ports.installationId);
  const key = input.idempotencyKey;
  type CreateOutcome = { kind: "replay"; channel: ChannelView } | { kind: "fresh"; channel: ChannelView };
  const outcome = runChannelMutation(ports, null, key !== undefined, (transaction, now): Result<CreateOutcome> => {
    if (key !== undefined) {
      const stored = transaction.createReceipt(key, scope, now);
      if (!stored.ok) return stored;
      if (stored.value !== null) {
        if (stored.value.requestHash !== hash) {
          return err({
            ...appError(
              "IDEMPOTENCY_CONFLICT",
              "The retained Channel creation key belongs to a different create request; this invocation created no Channel.",
            ),
            recovery: {
              suggestedCommand:
                "Replay the identical original sorage channel create with the original key and inputs; while its receipt is retained, that replay returns the original Channel. A new key creates a new Channel and is legitimate only for a genuinely new intent, never as recovery for an unknown create outcome",
            },
          });
        }
        // The retained outcome must be this request's original outcome: the
        // input-known main handle, normalized title, and creator provenance
        // are compared against the stored creation view (the C1 correction).
        const consistent = checkRetainedCreationAgainstRequest(stored.value.channel, {
          mainHandle: handle.value,
          title: title.value,
          creatorKind: creator.value.creatorKind,
          creatorId: creator.value.creatorId,
        });
        if (!consistent.ok) return consistent;
        return ok({ kind: "replay" as const, channel: stored.value.channel });
      }
    }
    const channelId = ports.ids.next();
    const mainParticipantId = ports.ids.next();
    const channel: ChannelRecord = {
      id: channelId,
      title: title.value,
      state: "open",
      creatorKind: creator.value.creatorKind,
      creatorId: creator.value.creatorId,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      closedByParticipantId: null,
      closedByKind: null,
    };
    const main: ChannelParticipantRecord = {
      id: mainParticipantId,
      channelId,
      role: "main",
      handle: handle.value,
      nativeProvenance: [],
      active: true,
      registeredAt: now,
      deactivatedAt: null,
    };
    const inserted = transaction.insertChannel(channel);
    if (!inserted.ok) return inserted;
    const participantInserted = transaction.insertParticipant(main);
    if (!participantInserted.ok) return participantInserted;
    const appended = transaction.appendEvent(ports.ids.next(), {
      eventType: "CHANNEL_CREATED",
      actor: input.creator,
      metadata: channelCreatedMetadata({ channelId, mainParticipantId }),
      createdAt: now,
    });
    if (!appended.ok) return appended;
    const view: ChannelView = {
      id: channelId,
      title: channel.title,
      state: "open",
      creatorKind: channel.creatorKind,
      creatorId: channel.creatorId,
      mainParticipantId,
      closedAt: null,
      closedByParticipantId: null,
      closedByKind: null,
      createdAt: now,
      updatedAt: now,
      participantCount: 1,
      messageCount: 0,
      unhandledCount: 0,
      participants: [participantViewOf(main)],
      assignments: [],
    };
    if (key !== undefined) {
      const expiresAt = new Date(Date.parse(now) + CHANNEL_RECEIPT_RETENTION_MS).toISOString();
      const stored = transaction.storeCreateReceipt(key, scope, hash, view, now, expiresAt);
      if (!stored.ok) return stored;
    }
    return ok({ kind: "fresh" as const, channel: view });
  });
  if (!outcome.ok) return outcome;
  if (outcome.value.kind === "replay") return ok({ channel: outcome.value.channel, replayed: true });
  return ok({ channel: outcome.value.channel, replayed: false });
}

/** The terminal main-role or User close: freezes submissions, keeps reads and processing (CHN-008, M0). */
export function closeChannel(
  ports: ChannelCommandPorts,
  input: { channelId: unknown; assertion: ChannelActorAssertion },
): Result<ChannelView> {
  if (!isChannelUuid(input.channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  const outcome = runChannelMutation(ports, null, false, (transaction, now): Result<undefined> => {
    const channel = transaction.channel(input.channelId as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
    const participants = transaction.participants(channel.value.id);
    if (!participants.ok) return participants;
    const role = requireMainRole(channel.value, participants.value, input.assertion);
    if (!role.ok) return role;
    if (channel.value.state === "open") {
      const changed = transaction.closeChannel(
        channel.value.id,
        now,
        role.value.actingParticipantId,
        role.value.authority,
      );
      if (!changed.ok) return changed;
      if (changed.value === "changed") {
        const appended = transaction.appendEvent(ports.ids.next(), {
          eventType: "CHANNEL_CLOSED",
          actor: input.assertion.actor,
          metadata: channelClosedMetadata({
            channelId: channel.value.id,
            actingParticipantId: role.value.actingParticipantId,
          }),
          createdAt: now,
        });
        if (!appended.ok) return appended;
      }
    }
    return ok(undefined);
  });
  if (!outcome.ok) return outcome;
  const shown = showChannel(ports, input.channelId);
  if (!shown.ok) return shown;
  return shown;
}

/** Registers one `worker` or `judge` participant on an open Channel under main-role or User authority (CHN-002, M0). */
export function addParticipant(
  ports: ChannelCommandPorts,
  input: {
    channelId: unknown;
    assertion: ChannelActorAssertion;
    role: unknown;
    handle: unknown;
    nativeProvenance?: unknown[];
  },
): Result<ParticipantView> {
  if (!isChannelUuid(input.channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  if (input.role !== "worker" && input.role !== "judge") {
    return invalid("Participant registration carries exactly the roles worker and judge");
  }
  const handle = validateChannelHandle(input.handle);
  if (!handle.ok) return handle;
  const native = validateNativeProvenance(input.nativeProvenance ?? []);
  if (!native.ok) return native;
  // The narrowed role is hoisted: the unknown-input guard's narrowing does not
  // survive into the transaction callback.
  const registrationRole: "worker" | "judge" = input.role;
  return runChannelMutation(ports, null, false, (transaction, now) => {
    const channel = transaction.channel(input.channelId as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
    if (channel.value.state !== "open") {
      return err(appError("CHN_CLOSED", "The Channel is closed, so participant registration is frozen"));
    }
    const participants = transaction.participants(channel.value.id);
    if (!participants.ok) return participants;
    const role = requireMainRole(channel.value, participants.value, input.assertion);
    if (!role.ok) return role;
    const existing = transaction.participantByHandle(channel.value.id, handle.value);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return invalid("The handle is already registered in this Channel", { handle: handle.value });
    }
    const participantId = ports.ids.next();
    const record: ChannelParticipantRecord = {
      id: participantId,
      channelId: channel.value.id,
      role: registrationRole,
      handle: handle.value,
      nativeProvenance: native.value,
      active: true,
      registeredAt: now,
      deactivatedAt: null,
    };
    const inserted = transaction.insertParticipant(record);
    if (!inserted.ok) return inserted;
    const appended = transaction.appendEvent(ports.ids.next(), {
      eventType: "CHANNEL_PARTICIPANT_REGISTERED",
      actor: input.assertion.actor,
      metadata: participantRegisteredMetadata({
        channelId: channel.value.id,
        actingParticipantId: role.value.actingParticipantId,
        participantId,
        role: registrationRole,
      }),
      createdAt: now,
    });
    if (!appended.ok) return appended;
    return ok(participantViewOf(record));
  });
}

/** Deactivates one non-main participant, on an open or closed Channel; attribution of earlier messages is preserved (CHN-002, M0). */
export function deactivateParticipant(
  ports: ChannelCommandPorts,
  input: { channelId: unknown; participantId: unknown; assertion: ChannelActorAssertion },
): Result<ParticipantView> {
  if (!isChannelUuid(input.channelId) || !isChannelUuid(input.participantId)) {
    return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
  }
  return runChannelMutation(ports, null, false, (transaction, now) => {
    const channel = transaction.channel(input.channelId as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
    const participants = transaction.participants(channel.value.id);
    if (!participants.ok) return participants;
    const role = requireMainRole(channel.value, participants.value, input.assertion);
    if (!role.ok) return role;
    const target = transaction.participant(channel.value.id, input.participantId as string);
    if (!target.ok) return target;
    if (target.value === null)
      return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
    if (target.value.role === "main") {
      return invalid("No M9 operation deactivates the main participant of a Channel");
    }
    if (target.value.active) {
      const changed = transaction.deactivateParticipant(target.value.id, now);
      if (!changed.ok) return changed;
      if (changed.value === "changed") {
        const appended = transaction.appendEvent(ports.ids.next(), {
          eventType: "CHANNEL_PARTICIPANT_DEACTIVATED",
          actor: input.assertion.actor,
          metadata: participantDeactivatedMetadata({
            channelId: channel.value.id,
            actingParticipantId: role.value.actingParticipantId,
            participantId: target.value.id,
          }),
          createdAt: now,
        });
        if (!appended.ok) return appended;
      }
    }
    const after = transaction.participant(channel.value.id, target.value.id);
    if (!after.ok) return after;
    if (after.value === null) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", "The deactivated participant vanished inside its own transaction."),
      );
    }
    return ok(participantViewOf(after.value));
  });
}

/** Creates one labeled assignment, optionally bound to one participant of the Channel (CHN-003, M0). */
export function addAssignment(
  ports: ChannelCommandPorts,
  input: { channelId: unknown; assertion: ChannelActorAssertion; participantId?: unknown; label: unknown },
): Result<AssignmentView> {
  if (!isChannelUuid(input.channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  const label = normalizeAssignmentLabel(input.label);
  if (!label.ok) return label;
  return runChannelMutation(ports, null, false, (transaction, now) => {
    const channel = transaction.channel(input.channelId as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
    const participants = transaction.participants(channel.value.id);
    if (!participants.ok) return participants;
    const role = requireMainRole(channel.value, participants.value, input.assertion);
    if (!role.ok) return role;
    let boundParticipant: string | null = null;
    if (input.participantId !== undefined && input.participantId !== null) {
      if (!isChannelUuid(input.participantId)) {
        return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
      }
      const target = transaction.participant(channel.value.id, input.participantId);
      if (!target.ok) return target;
      if (target.value === null)
        return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
      boundParticipant = target.value.id;
    }
    const assignmentId = ports.ids.next();
    const record: ChannelAssignmentRecord = {
      id: assignmentId,
      channelId: channel.value.id,
      participantId: boundParticipant,
      label: label.value,
      state: "open",
      createdAt: now,
      closedAt: null,
    };
    const inserted = transaction.insertAssignment(record);
    if (!inserted.ok) return inserted;
    const appended = transaction.appendEvent(ports.ids.next(), {
      eventType: "CHANNEL_ASSIGNMENT_CREATED",
      actor: input.assertion.actor,
      metadata: assignmentCreatedMetadata({
        channelId: channel.value.id,
        actingParticipantId: role.value.actingParticipantId,
        assignmentId,
        participantId: boundParticipant,
      }),
      createdAt: now,
    });
    if (!appended.ok) return appended;
    return ok(assignmentViewOf(record));
  });
}

/** Closes one assignment as a metadata operation; an already-closed assignment is the M0 unchanged no-op (CHN-003, M0). */
export function closeAssignment(
  ports: ChannelCommandPorts,
  input: { channelId: unknown; assignmentId: unknown; assertion: ChannelActorAssertion },
): Result<AssignmentView> {
  if (!isChannelUuid(input.channelId) || !isChannelUuid(input.assignmentId)) {
    return err(appError("CHN_ASSIGNMENT_NOT_FOUND", "Unknown assignment for this Channel"));
  }
  return runChannelMutation(ports, null, false, (transaction, now) => {
    const channel = transaction.channel(input.channelId as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
    const participants = transaction.participants(channel.value.id);
    if (!participants.ok) return participants;
    const role = requireMainRole(channel.value, participants.value, input.assertion);
    if (!role.ok) return role;
    const assignment = transaction.assignment(channel.value.id, input.assignmentId as string);
    if (!assignment.ok) return assignment;
    if (assignment.value === null)
      return err(appError("CHN_ASSIGNMENT_NOT_FOUND", "Unknown assignment for this Channel"));
    if (assignment.value.state === "open") {
      const changed = transaction.closeAssignment(assignment.value.id, now);
      if (!changed.ok) return changed;
      if (changed.value === "changed") {
        const appended = transaction.appendEvent(ports.ids.next(), {
          eventType: "CHANNEL_ASSIGNMENT_CLOSED",
          actor: input.assertion.actor,
          metadata: assignmentClosedMetadata({
            channelId: channel.value.id,
            actingParticipantId: role.value.actingParticipantId,
            assignmentId: assignment.value.id,
          }),
          createdAt: now,
        });
        if (!appended.ok) return appended;
      }
    }
    const after = transaction.assignment(channel.value.id, assignment.value.id);
    if (!after.ok) return after;
    if (after.value === null) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "The closed assignment vanished inside its own transaction."));
    }
    return ok(assignmentViewOf(after.value));
  });
}

/**
 * P3 step 2: prepares the once-captured accepted body's identity, blank check,
 * and bounded preview outside any transaction. The accepted input is captured
 * once per invocation and reused on every retry; the preview seed reads only
 * the accepted text or the spool's bounded head, never the whole body.
 */
export function prepareChannelBody(
  ports: ChannelCommandPorts,
  accepted: AcceptedChannelBody,
): Result<PreparedChannelBody> {
  if (accepted.kind === "text") {
    const blank = checkChannelBodyText(accepted.text, ports.maxBytes);
    if (!blank.ok) return blank;
    const preview = channelPreviewOf(accepted.text, accepted.sizeBytes);
    return ok({
      sizeBytes: accepted.sizeBytes,
      sha256: accepted.sha256,
      preview,
      inlineText: accepted.text,
    });
  }
  // The F5 correction: the nonempty-after-trim rule is proven over the full
  // accepted spool — bounded chunks, exact bytes, early exit on the first
  // non-whitespace scalar — before any mutation transaction and before any
  // preview seed read, so an all-whitespace body of any size is refused here
  // while a body with leading whitespace beyond the head and the threshold
  // stays accepted with its exact bytes (CHN-004, SHR-002).
  const nonBlank = ports.bodies.proveAcceptedNonBlank(accepted);
  if (!nonBlank.ok) return nonBlank;
  const seed = ports.bodies.readAcceptedPreviewSeed(accepted);
  if (!seed.ok) return seed;
  const preview = channelPreviewOf(seed.value, accepted.sizeBytes);
  return ok({ sizeBytes: accepted.sizeBytes, sha256: accepted.sha256, preview, inlineText: null });
}

export interface SubmitMessageInput {
  channelId: unknown;
  senderParticipantId: unknown;
  kind: unknown;
  accepted: AcceptedChannelBody;
  assignmentId?: unknown;
  relayToParticipantId?: unknown;
  contextSession?: unknown;
  contextNode?: unknown;
  contextAttempt?: unknown;
  idempotencyKey?: string;
}

/** The one SQL transaction's fresh outcome, before its post-commit activation half. */
interface FreshSubmitOutcome {
  kind: "fresh";
  message: MessageSummary;
  plan: ChannelContentPlan;
  channelId: string;
  binding: { vaultPath: string };
}

type SubmitOutcome = { kind: "replay"; message: MessageSummary } | FreshSubmitOutcome;

/**
 * Submits one attributed message (CHN-004, CHN-006, P3 steps 1 to 5). The
 * prepared material is computed once from the accepted body before the
 * mutation transaction; the one SQL transaction combines only insert-time
 * facts — eligibility, the insertion-frozen `assignmentLate`, fresh ids and
 * timestamps — with that prepared material to commit the content record (and
 * its activation intent for a file body), the message row, the
 * CHANNEL_MESSAGE_SUBMITTED event, and the bounded metadata-only receipt
 * carrying the original submission-time summary. A retained receipt replays
 * the original outcome before any live-state eligibility is read, appends
 * nothing, and never refreshes expiry; after the commit the disclosure fires
 * once and a file body activates behind the move-lock gate.
 */
export function submitMessage(
  ports: ChannelCommandPorts,
  input: SubmitMessageInput & { actor: ActorRef },
): Result<{ message: MessageSummary; replayed: boolean; contentActivating: boolean }> {
  if (!isChannelUuid(input.channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  if (!isChannelUuid(input.senderParticipantId)) {
    return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
  }
  if (input.kind !== "report" && input.kind !== "question" && input.kind !== "relay_request") {
    return invalid("A message carries exactly the kinds report, question, and relay_request");
  }
  if (input.kind === "relay_request" && !isChannelUuid(input.relayToParticipantId)) {
    return invalid("A relay request names its target participant");
  }
  if (
    input.kind !== "relay_request" &&
    input.relayToParticipantId !== undefined &&
    input.relayToParticipantId !== null
  ) {
    return invalid("Only a relay request names a target participant");
  }
  if (input.assignmentId !== undefined && input.assignmentId !== null && !isChannelUuid(input.assignmentId)) {
    return err(appError("CHN_ASSIGNMENT_NOT_FOUND", "Unknown assignment for this Channel"));
  }
  const contextSession = validateContextField(input.contextSession);
  if (!contextSession.ok) return contextSession;
  const contextNode = validateContextField(input.contextNode);
  if (!contextNode.ok) return contextNode;
  const contextAttempt = validateContextField(input.contextAttempt);
  if (!contextAttempt.ok) return contextAttempt;
  // The narrowed kind and relay target are hoisted: the unknown-input guards'
  // narrowing does not survive into the transaction callback.
  const messageKind: MessageKind = input.kind;
  const relayTarget: string | null = input.kind === "relay_request" ? (input.relayToParticipantId as string) : null;
  // P3 step 2: identity, blank check, and preview from the once-accepted input, outside SQL.
  const prepared = prepareChannelBody(ports, input.accepted);
  if (!prepared.ok) return prepared;
  const fileRouted = prepared.value.inlineText === null;
  const hash = composeChannelRequestDigest({
    operation: "channel-submit",
    installationId: ports.installationId,
    channelId: input.channelId as string,
    fields: {
      senderParticipantId: input.senderParticipantId as string,
      kind: messageKind,
      assignmentId: (input.assignmentId as string | null) ?? null,
      relayToParticipantId: relayTarget,
      contextSession: contextSession.value,
      contextNode: contextNode.value,
      contextAttempt: contextAttempt.value,
    },
    body: { sha256: prepared.value.sha256, sizeBytes: prepared.value.sizeBytes },
  });
  const scope = channelSubmitScope(ports.installationId, input.channelId as string);
  const key = input.idempotencyKey;
  const outcome = runChannelMutation(
    ports,
    fileRouted ? input.accepted : null,
    key !== undefined,
    (transaction, now, stagedPath, binding): Result<SubmitOutcome> => {
      // The retained receipt outranks live-state eligibility: a closed Channel
      // or a since-deactivated sender never invalidates a historical retained
      // outcome (security section 10.1).
      if (key !== undefined) {
        const stored = transaction.submitReceipt(key, scope, now);
        if (!stored.ok) return stored;
        if (stored.value !== null) {
          if (stored.value.message.channelId !== (input.channelId as string)) {
            return err(
              appError("STORAGE_INTEGRITY_ERROR", "The retained Channel submission receipt names another Channel."),
            );
          }
          if (stored.value.requestHash !== hash) {
            return err({
              ...appError("IDEMPOTENCY_CONFLICT", "The retained Channel submission key carries a different request"),
              recovery: {
                suggestedCommand:
                  "The key is retained for a different request. Replaying the identical original request returns its original outcome; a new key is legitimate only for a genuinely new intent such as a new main-directed attempt, never as recovery for an unknown outcome",
              },
            });
          }
          // A hash-matching receipt must still be this request's original
          // outcome: the input-known sender, kind, assignment, relay target,
          // verbatim contexts, body bytes, and the once-prepared preview are
          // compared against the retained summary (the C1 correction).
          const consistent = checkRetainedSummaryAgainstRequest(stored.value.message, {
            channelId: input.channelId as string,
            senderParticipantId: input.senderParticipantId as string,
            kind: messageKind,
            assignmentId: (input.assignmentId as string | null) ?? null,
            relayToParticipantId: relayTarget,
            contextSession: contextSession.value,
            contextNode: contextNode.value,
            contextAttempt: contextAttempt.value,
            bodyBytes: prepared.value.sizeBytes,
            preview: prepared.value.preview,
          });
          if (!consistent.ok) return consistent;
          return ok({ kind: "replay", message: stored.value.message });
        }
      }
      const channel = transaction.channel(input.channelId as string);
      if (!channel.ok) return channel;
      if (channel.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
      if (channel.value.state !== "open") {
        return err(appError("CHN_CLOSED", "The Channel is closed, so submissions are frozen"));
      }
      const sender = transaction.participant(channel.value.id, input.senderParticipantId as string);
      if (!sender.ok) return sender;
      if (sender.value === null)
        return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
      if (!sender.value.active)
        return err(appError("CHN_PARTICIPANT_INACTIVE", "The sending participant is deactivated"));
      let relayTo: string | null = null;
      if (messageKind === "relay_request") {
        const target = transaction.participant(channel.value.id, relayTarget as string);
        if (!target.ok) return target;
        if (target.value === null)
          return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown relay target for this Channel"));
        relayTo = target.value.id;
      }
      // The assignment may be any same-Channel assignment in any state; the
      // late flag freezes inside this insertion transaction (CHN-003).
      let assignmentId: string | null = null;
      let assignmentLate = false;
      if (input.assignmentId !== undefined && input.assignmentId !== null) {
        const assignment = transaction.assignment(channel.value.id, input.assignmentId as string);
        if (!assignment.ok) return assignment;
        if (assignment.value === null)
          return err(appError("CHN_ASSIGNMENT_NOT_FOUND", "Unknown assignment for this Channel"));
        assignmentId = assignment.value.id;
        assignmentLate = assignment.value.state === "closed";
      }
      const messageId = ports.ids.next();
      const contentId = ports.ids.next();
      let plan: ChannelContentPlan;
      if (fileRouted) {
        if (stagedPath === null) {
          return err(
            appError(
              "INTERNAL_ERROR",
              "A Vault-routed Channel body requires its staged file before the write transaction",
            ),
          );
        }
        const storageKey = buildContentStorageKey({ domain: "channel", ownerId: channel.value.id, contentId });
        if (!storageKey.ok) return storageKey;
        plan = {
          kind: "file",
          contentId,
          intentId: ports.ids.next(),
          stagedPath,
          storageKey: storageKey.value,
          sizeBytes: prepared.value.sizeBytes,
          sha256: prepared.value.sha256,
        };
      } else {
        plan = {
          kind: "inline",
          contentId,
          text: prepared.value.inlineText as string,
          sizeBytes: prepared.value.sizeBytes,
          sha256: prepared.value.sha256,
        };
      }
      const committed = transaction.commitContent(plan, channel.value.id, now);
      if (!committed.ok) return committed;
      const record: ChannelMessageRecord = {
        id: messageId,
        channelId: channel.value.id,
        senderParticipantId: sender.value.id,
        senderHandle: sender.value.handle,
        kind: messageKind,
        body: {
          recordId: contentId,
          representation: fileRouted ? "file" : "inline",
          sizeBytes: prepared.value.sizeBytes,
          sha256: prepared.value.sha256,
          inlineText: fileRouted ? null : (prepared.value.inlineText as string),
        },
        assignmentId,
        assignmentLate,
        relayToParticipantId: relayTo,
        contextSession: contextSession.value,
        contextNode: contextNode.value,
        contextAttempt: contextAttempt.value,
        handled: false,
        handledAt: null,
        handledByParticipantId: null,
        handledByKind: null,
        handleNote: null,
        processingRowVersion: 1,
        createdAt: now,
      };
      const inserted = transaction.insertMessage(record);
      if (!inserted.ok) return inserted;
      const appended = transaction.appendEvent(ports.ids.next(), {
        eventType: "CHANNEL_MESSAGE_SUBMITTED",
        actor: input.actor,
        metadata: messageSubmittedMetadata({
          channelId: channel.value.id,
          senderParticipantId: sender.value.id,
          messageId,
          kind: messageKind,
          assignmentId,
          assignmentLate,
          relayToParticipantId: relayTo,
        }),
        createdAt: now,
      });
      if (!appended.ok) return appended;
      const summary = messageSummaryOf(record, prepared.value.preview);
      if (key !== undefined) {
        const expiresAt = new Date(Date.parse(now) + CHANNEL_RECEIPT_RETENTION_MS).toISOString();
        const stored = transaction.storeSubmitReceipt(key, scope, hash, summary, now, expiresAt);
        if (!stored.ok) return stored;
      }
      return ok({ kind: "fresh", message: summary, plan, channelId: channel.value.id, binding });
    },
  );
  if (!outcome.ok) return outcome;
  const value = outcome.value;
  if (value.kind === "replay") {
    // The recorded outcome keeps its committed summary; a file-backed record's
    // state is observed read-only, and an unobservable state is disclosed
    // rather than asserted (CHN-012, ADR-0033's unconfirmed-content note).
    const warn = (text: string): void => emitChannelCompletionWarning(ports, text);
    return ok({
      message: value.message,
      replayed: true,
      contentActivating:
        value.message.bodyBytes > CONTENT_INLINE_MAX_UTF8_BYTES
          ? contentStateFlagOf(
              ports.bodies.messageContentState(value.message.channelId, value.message.id),
              value.message.id,
              warn,
            )
          : false,
    });
  }
  discloseLargeContent(ports, value.plan);
  const warn = (text: string): void => emitChannelCompletionWarning(ports, text);
  let contentActivating = false;
  if (value.plan.kind === "file") {
    const activation = ports.staging.activateContent(
      {
        intentId: value.plan.intentId,
        contentId: value.plan.contentId,
        ownerChannelId: value.channelId,
        stagedPath: value.plan.stagedPath,
        storageKey: value.plan.storageKey,
        sizeBytes: value.plan.sizeBytes,
        sha256: value.plan.sha256,
      },
      value.binding,
    );
    // Physical completion never changes the committed outcome (SHR-015): a
    // failed or paused activation leaves the pending intent for the next
    // process start and is disclosed as a contained warning.
    if (!activation.ok) {
      warn(activationFailedWarning(activation.error.message));
    } else if (activation.value.status === "paused") {
      warn(CHANNEL_ACTIVATION_PAUSED_WARNING);
    }
    contentActivating = contentStateFlagOf(
      ports.bodies.messageContentState(value.channelId, value.message.id),
      value.message.id,
      warn,
    );
  }
  return ok({ message: value.message, replayed: false, contentActivating });
}

/** The stable opening of the unconfirmed-content-state warning; the CLI selects its human line from it. */
export const CHANNEL_UNCONFIRMED_CONTENT_WARNING = "the content-state probe for message";

/** The observed-pending activation warning of a committed file-backed submit that paused behind a live fence. */
const CHANNEL_ACTIVATION_PAUSED_WARNING =
  "the Channel message committed but its content activation paused behind a held Vault-move lock; the pending intent remains for the next process start";

function activationFailedWarning(reason: string): string {
  return `the Channel message committed but its content activation failed (${reason}); the pending intent remains for the next process start`;
}

function unconfirmedContentWarning(messageId: string, reason: string): string {
  return `${CHANNEL_UNCONFIRMED_CONTENT_WARNING} ${messageId} failed (${reason}); activation is not confirmed and contentActivating is reported as true`;
}

/**
 * The observed content-state flag (CHN-012): false only when the database shows
 * the record materialized, true when it shows it unmaterialized, and true plus
 * a contained warning when the database-only probe cannot observe it — never
 * `false`, which would assert a state nobody saw.
 */
function contentStateFlagOf(
  state: Result<{ representation: "inline" | "file"; materialized: boolean }, AppError>,
  messageId: string,
  warn: (text: string) => void,
): boolean {
  if (!state.ok) {
    warn(unconfirmedContentWarning(messageId, state.error.message));
    return true;
  }
  return !state.value.materialized;
}

/** A contained completion warning: the sink's own failure never changes the committed outcome. */
function emitChannelCompletionWarning(ports: ChannelCommandPorts, text: string): void {
  const sink = ports.disclosures?.completionWarning;
  if (sink === undefined) return;
  try {
    sink(text);
  } catch {
    // A diagnostic sink failure never changes the result.
  }
}

/**
 * The Channel per-surface error hook (interface section 38.4, the twin of the
 * Memo hook): it carries the state-accurate statements interface section 38.4
 * requires that no context-free catalogue default can produce. Site messages
 * and details are preserved; a replay-only surface keeps its own unknown-
 * outcome framing and never passes through this hook.
 */
export function channelError(error: AppError): AppError {
  if (error.code === "CONTENT_MATERIALIZING") {
    return {
      ...appError(
        "CONTENT_MATERIALIZING",
        "The message itself is committed and needs no resubmission; its file-backed content has not activated yet",
        error.details,
        error.cause,
      ),
      recovery: {
        suggestedCommand:
          "Retry the read or wait after activation; the next process start retries the pending activation, and the message needs no resubmission",
      },
    };
  }
  if (error.code === "STORAGE_INTEGRITY_ERROR" && error.recovery === undefined) {
    return {
      ...error,
      recovery: {
        suggestedCommand:
          "Diagnose the installation with sorage doctor and sorage vault verify before further Channel work; any committed outcome already reported stands",
      },
    };
  }
  if (error.code === "STORAGE_SCHEMA_UNSUPPORTED" && error.recovery === undefined) {
    return {
      ...error,
      recovery: {
        suggestedCommand:
          "Retain the original Channel command and its input, and for a keyed create or submit its idempotency key; use a Sorage version that supports this storage layout; never downgrade the database",
      },
    };
  }
  return error;
}

function discloseLargeContent(ports: ChannelCommandPorts, plan: ChannelContentPlan): void {
  const disclosures = ports.disclosures;
  if (disclosures === undefined || !disclosures.backupEnabled) return;
  if (!(plan.sizeBytes > disclosures.thresholdBytes)) return;
  try {
    disclosures.largeContent(plan.sizeBytes, disclosures.thresholdBytes);
  } catch {
    // A diagnostic sink failure never changes the committed outcome.
  }
}

/**
 * The main-role handling decision (CHN-005): requires the currently unhandled
 * state and the observed processing row version; the first decision is
 * immutable. A duplicate carrying the stale pre-handle version 1 fails with
 * ROW_VERSION_CONFLICT once another attempt won; an attempt carrying the
 * current version 2 against a handled message fails with CHN_INVALID_INPUT
 * naming the existing first decision.
 */
export function handleChannelMessage(
  ports: ChannelCommandPorts,
  input: {
    channelId: unknown;
    messageId: unknown;
    assertion: ChannelActorAssertion;
    expectedRowVersion: unknown;
    note?: unknown;
  },
): Result<{ message: MessageSummary; bodyPreviewUnavailable: boolean }> {
  if (!isChannelUuid(input.channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  if (!isChannelUuid(input.messageId))
    return err(appError("CHN_MESSAGE_NOT_FOUND", "Unknown message for this Channel"));
  if (
    typeof input.expectedRowVersion !== "number" ||
    !Number.isSafeInteger(input.expectedRowVersion) ||
    input.expectedRowVersion < 1 ||
    input.expectedRowVersion > 2
  ) {
    return invalid("Handling requires the observed processing row version");
  }
  const note = validateHandleNote(input.note);
  if (!note.ok) return note;
  const outcome = runChannelMutation(ports, null, false, (transaction, now): Result<ChannelMessageRecord> => {
    const channel = transaction.channel(input.channelId as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
    const participants = transaction.participants(channel.value.id);
    if (!participants.ok) return participants;
    const role = requireMainRole(channel.value, participants.value, input.assertion);
    if (!role.ok) return role;
    const message = transaction.message(channel.value.id, input.messageId as string);
    if (!message.ok) return message;
    if (message.value === null) return err(appError("CHN_MESSAGE_NOT_FOUND", "Unknown message for this Channel"));
    if (message.value.handled) {
      const decided = {
        handledAt: message.value.handledAt,
        handledByParticipantId: message.value.handledByParticipantId,
        handledByKind: message.value.handledByKind,
      };
      const immutableRecovery = {
        suggestedCommand:
          "The first decision is immutable and there is nothing to retry; read the recorded decision with sorage channel read <channelId> <messageId>",
      };
      if (input.expectedRowVersion === 2) {
        const authority =
          message.value.handledByKind === "user"
            ? "the User"
            : `participant ${message.value.handledByParticipantId ?? "unknown"}`;
        return err({
          ...appError(
            "CHN_INVALID_INPUT",
            `The message was already handled by ${authority}; the first handling decision is immutable`,
            decided,
          ),
          recovery: immutableRecovery,
        });
      }
      return err({
        ...appError(
          "ROW_VERSION_CONFLICT",
          "A handling decision has already committed for this message, possibly an earlier attempt of this same caller whose response was lost; the first handling decision is immutable",
          decided,
        ),
        recovery: immutableRecovery,
      });
    }
    if (input.expectedRowVersion !== 1) {
      return err({
        ...appError(
          "ROW_VERSION_CONFLICT",
          "The message is unhandled and its processing row version is 1; the supplied expected row version does not match",
        ),
        recovery: {
          suggestedCommand:
            "List the message with sorage channel messages <channelId> and re-run handle with the observed processing row version",
        },
      });
    }
    const changed = transaction.handleMessage(channel.value.id, message.value.id, {
      handledAt: now,
      handledByParticipantId: role.value.actingParticipantId,
      handledByKind: role.value.authority,
      handleNote: note.value,
    });
    if (!changed.ok) return changed;
    const appended = transaction.appendEvent(ports.ids.next(), {
      eventType: "CHANNEL_MESSAGE_HANDLED",
      actor: input.assertion.actor,
      metadata: messageHandledMetadata({
        channelId: channel.value.id,
        actingParticipantId: role.value.actingParticipantId,
        messageId: message.value.id,
      }),
      createdAt: now,
    });
    if (!appended.ok) return appended;
    const after = transaction.message(channel.value.id, message.value.id);
    if (!after.ok) return after;
    if (after.value === null) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "The handled message vanished inside its own transaction."));
    }
    return ok(after.value);
  });
  if (!outcome.ok) return outcome;
  // The summary's preview resolves outside the mutation transaction: an inline
  // record's stored text is its own seed and a file-backed body reads its
  // bounded head through the body ports (P3: no body read inside SQL). The
  // decision already committed, so a failed binding or preview read returns
  // the committed summary with the explicit unavailable-preview indicator
  // instead of a failure (CHN-012, SHR-015).
  const noPreview = { bodyPreview: "", bodyPreviewTruncated: false };
  const binding = ports.staging.freshBinding();
  if (!binding.ok) {
    return ok({ message: messageSummaryOf(outcome.value, noPreview), bodyPreviewUnavailable: true });
  }
  const preview = previewOfRecord(ports, outcome.value, binding.value);
  if (!preview.ok) {
    return ok({ message: messageSummaryOf(outcome.value, noPreview), bodyPreviewUnavailable: true });
  }
  return ok({ message: messageSummaryOf(outcome.value, preview.value), bodyPreviewUnavailable: false });
}

// ---------------------------------------------------------------------------
// Reads, listings, waiting

/** One consistent Channel show: the complete current rosters, counts, and state; no message bodies (section 38.4). */
export function showChannel(ports: ChannelCommandPorts, channelId: unknown): Result<ChannelView> {
  if (!isChannelUuid(channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  const aggregate = ports.channels.inspect((reader) => reader.aggregate(channelId as string));
  if (!aggregate.ok) return aggregate;
  if (aggregate.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  return ok(channelViewOf(aggregate.value));
}

export interface ChannelPage {
  items: ChannelSummary[];
  nextCursor: string | null;
}

export interface MessagePage {
  items: MessageSummary[];
  nextCursor: string | null;
}

function sortKeyOf(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

function listExhausted(): AppError {
  return {
    ...appError(
      "STORAGE_INSPECTION_UNAVAILABLE",
      "A coherent Channel list page could not be assembled because the database kept changing; no page was emitted",
    ),
    recovery: { suggestedCommand: "Retry the Channel list; no partial page was emitted" },
  };
}

/**
 * The bounded coherent Channel list page (section 38.4, the M0 coherence
 * clause): the attempt captures the external-commit version before its short
 * snapshot capture and re-checks it after, restarting the whole page on a
 * change within the bounded budget and failing whole with
 * STORAGE_INSPECTION_UNAVAILABLE otherwise — no partial page is ever emitted
 * (the Memo listing's retained pattern).
 */
export function listChannels(
  ports: ChannelCommandPorts,
  input: { state?: unknown; limit?: unknown; cursor?: unknown },
): Result<ChannelPage> {
  const state = input.state === undefined || input.state === null ? "all" : input.state;
  if (state !== "open" && state !== "closed" && state !== "all") {
    return invalid("The Channel state filter is open, closed, or all");
  }
  const limit = boundedLimit(ports, input.limit);
  if (!limit.ok) return limit;
  let after: { createdAt: string; id: string } | undefined;
  if (input.cursor !== undefined && input.cursor !== null) {
    if (typeof input.cursor !== "string")
      return err(appError("CURSOR_INVALID", "The Channel list cursor is malformed"));
    const decoded = decodeChannelCursor(
      input.cursor,
      "channel-list",
      channelListFilterFields({ state }),
      ports,
      limit.value,
    );
    if (!decoded.ok) return decoded;
    after = decoded.value;
  }
  for (let attempt = 0; attempt < CHANNEL_LIST_ATTEMPTS; attempt++) {
    const version = ports.coherence.captureExternalVersion();
    if (!version.ok) return version;
    const capture = ports.channels.captureChannelList({ state }, after, Math.max(CHANNEL_LIST_BATCH, limit.value));
    if (!capture.ok) {
      // An external commit takes precedence over the captured failure's
      // classification: a concurrent change restarts the whole page.
      const current = ports.coherence.captureExternalVersion();
      if (current.ok && current.value !== version.value) continue;
      return capture;
    }
    const final = ports.coherence.captureExternalVersion();
    if (!final.ok) return final;
    if (final.value !== version.value) continue;
    const items = capture.value.summaries.slice(0, limit.value);
    const more = capture.value.summaries.length > items.length || !capture.value.exhausted;
    const last = items.length === limit.value && more ? items[items.length - 1] : undefined;
    return ok({
      items,
      nextCursor:
        last === undefined
          ? null
          : encodeChannelCursor("channel-list", channelListFilterFields({ state }), ports, limit.value, {
              createdAt: last.createdAt,
              id: last.id,
            }),
    });
  }
  return err(listExhausted());
}

function channelListFilterFields(filter: ChannelListFilter): Record<string, string | number | boolean | null> {
  return { namespace: "channel-list", state: filter.state };
}

function messageFilterFields(filter: MessageListFilter): Record<string, string | number | boolean | null> {
  return {
    namespace: "channel-messages",
    handling: filter.handling,
    participantId: filter.participantId,
    assignmentId: filter.assignmentId,
    kind: filter.kind,
  };
}

function boundedLimit(ports: ChannelCommandPorts, value: unknown): Result<number> {
  const limit =
    value === undefined || value === null
      ? ports.defaultPageSize
      : typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : undefined;
  if (limit === undefined) return invalid("The list bound must be a positive integer");
  // The existing validated list upper bound of section 38.4, shared with the
  // Memo listing: explicit and default bounds alike stay inside 1 to 200, so
  // no request can drive an unbounded SQL page.
  if (limit < 1 || limit > CHANNEL_LIST_MAX_LIMIT) {
    return invalid(`The list bound must stay within 1 to ${String(CHANNEL_LIST_MAX_LIMIT)}`);
  }
  return ok(limit);
}

/**
 * The bounded coherent message list page with previews resolved outside the
 * capture transaction (section 38.4, the M0 coherence clause). File-backed
 * previews read a bounded head through the body ports only after the short
 * capture read; a seed that cannot be read honestly fails the whole page
 * rather than fabricating a preview.
 */
export function listChannelMessages(
  ports: ChannelCommandPorts,
  channelId: unknown,
  input: {
    handling?: unknown;
    participantId?: unknown;
    assignmentId?: unknown;
    kind?: unknown;
    limit?: unknown;
    cursor?: unknown;
  },
): Result<MessagePage> {
  const validated = validateMessageListAttributes(ports, channelId, {
    handling: input.handling,
    participantId: input.participantId,
    assignmentId: input.assignmentId,
    kind: input.kind,
    limit: input.limit,
  });
  if (!validated.ok) return validated;
  const { filter, limit } = validated.value;
  let after: { createdAt: string; id: string } | undefined;
  if (input.cursor !== undefined && input.cursor !== null) {
    if (typeof input.cursor !== "string")
      return err(appError("CURSOR_INVALID", "The channel messages cursor is malformed"));
    const decoded = decodeChannelCursor(
      input.cursor,
      "channel-messages",
      messageFilterFields(filter),
      ports,
      limit,
      channelId as string,
    );
    if (!decoded.ok) return decoded;
    after = decoded.value;
  }
  // The supplied filters name Channel roster members (section 38.4, C2): an
  // unknown participant or assignment fails immediately here rather than
  // emitting a silently empty page.
  const existence = validateMessageFilterExistence(ports, channelId as string, {
    participantId: filter.participantId,
    assignmentId: filter.assignmentId,
  });
  if (!existence.ok) return existence;
  return captureMessagePage(ports, channelId as string, filter, after, limit);
}

/**
 * The listing input both entry points validate before their first read
 * (section 38.4): the Channel UUID shape, the handling and kind filters, the
 * two filter UUID shapes, and the bounded page size. The ordinary listing and
 * the wait share it, so a wait can never poll on input the listing refuses.
 */
function validateMessageListAttributes(
  ports: ChannelCommandPorts,
  channelId: unknown,
  input: {
    handling?: unknown;
    participantId?: unknown;
    assignmentId?: unknown;
    kind?: unknown;
    limit?: unknown;
  },
): Result<{ filter: MessageListFilter; limit: number }> {
  if (!isChannelUuid(channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  const handling = input.handling === undefined || input.handling === null ? "unhandled" : input.handling;
  if (handling !== "unhandled" && handling !== "handled" && handling !== "all") {
    return invalid("The handling filter is unhandled, handled, or all");
  }
  if (input.participantId !== undefined && input.participantId !== null && !isChannelUuid(input.participantId)) {
    return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
  }
  if (input.assignmentId !== undefined && input.assignmentId !== null && !isChannelUuid(input.assignmentId)) {
    return err(appError("CHN_ASSIGNMENT_NOT_FOUND", "Unknown assignment for this Channel"));
  }
  if (
    input.kind !== undefined &&
    input.kind !== null &&
    input.kind !== "report" &&
    input.kind !== "question" &&
    input.kind !== "relay_request"
  ) {
    return invalid("The kind filter is report, question, or relay_request");
  }
  const limit = boundedLimit(ports, input.limit);
  if (!limit.ok) return limit;
  return ok({
    filter: {
      handling,
      participantId: (input.participantId as string | null) ?? null,
      assignmentId: (input.assignmentId as string | null) ?? null,
      kind: (input.kind as MessageKind | null) ?? null,
    },
    limit: limit.value,
  });
}

/**
 * The one filter-existence check (section 38.4, C2): a supplied participant or
 * assignment id absent from the Channel's current rosters is the documented
 * not-found code. It reuses the `show` aggregate reader; the check runs once
 * per successful validation, so a wait retries it with its own continuation
 * while a non-waiting listing reports any failure at once.
 */
function validateMessageFilterExistence(
  ports: ChannelCommandPorts,
  channelId: string,
  filter: { participantId: string | null; assignmentId: string | null },
): Result<void> {
  if (filter.participantId === null && filter.assignmentId === null) return ok(undefined);
  const aggregate = ports.channels.inspect((reader) => reader.aggregate(channelId));
  if (!aggregate.ok) return aggregate;
  if (aggregate.value === null) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  if (filter.participantId !== null && !aggregate.value.participants.some((p) => p.id === filter.participantId)) {
    return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
  }
  if (filter.assignmentId !== null && !aggregate.value.assignments.some((a) => a.id === filter.assignmentId)) {
    return err(appError("CHN_ASSIGNMENT_NOT_FOUND", "Unknown assignment for this Channel"));
  }
  return ok(undefined);
}

/** The bounded coherent message page capture the ordinary listing and the wait share (section 38.4, the M0 coherence clause). */
function captureMessagePage(
  ports: ChannelCommandPorts,
  channelId: string,
  filter: MessageListFilter,
  after: { createdAt: string; id: string } | undefined,
  limit: number,
): Result<MessagePage> {
  for (let attempt = 0; attempt < CHANNEL_LIST_ATTEMPTS; attempt++) {
    const version = ports.coherence.captureExternalVersion();
    if (!version.ok) return version;
    // The attempt's binding owns every outside-transaction body read: a Vault
    // move that completes between the capture and the preview resolution
    // leaves the version re-check to restart the whole page against the new
    // state instead of mixing a stale snapshot with a new Vault.
    const binding = ports.staging.freshBinding();
    if (!binding.ok) return binding;
    const capture = ports.channels.captureMessageList(channelId, filter, after, Math.max(CHANNEL_LIST_BATCH, limit));
    if (!capture.ok) {
      const current = ports.coherence.captureExternalVersion();
      if (current.ok && current.value !== version.value) continue;
      return capture;
    }
    const page = capture.value.records.slice(0, limit);
    const more = capture.value.records.length > page.length || !capture.value.exhausted;
    const last = page.length === limit && more ? page[page.length - 1] : undefined;
    const summaries: MessageSummary[] = [];
    let failure: AppError | null = null;
    for (const record of page) {
      // Every preview seed resolves outside the capture transaction through
      // the body ports — inline and file-backed alike — so a corrupt or
      // materializing record fails the whole page honestly instead of leaking
      // an unchecked stored text into a summary.
      const preview = previewOfRecord(ports, record, binding.value);
      if (!preview.ok) {
        failure = preview.error;
        break;
      }
      summaries.push(messageSummaryOf(record, preview.value));
    }
    if (failure !== null) {
      const current = ports.coherence.captureExternalVersion();
      if (current.ok && current.value !== version.value) continue;
      return err(failure);
    }
    const final = ports.coherence.captureExternalVersion();
    if (!final.ok) return final;
    if (final.value !== version.value) continue;
    return ok({
      items: summaries,
      nextCursor:
        last === undefined
          ? null
          : encodeChannelCursor("channel-messages", messageFilterFields(filter), ports, limit, last, channelId),
    });
  }
  return err(listExhausted());
}

function previewOfRecord(
  ports: ChannelCommandPorts,
  record: ChannelMessageRecord,
  binding: { vaultPath: string },
): Result<{ bodyPreview: string; bodyPreviewTruncated: boolean }> {
  const seed = ports.bodies.readRecordPreviewSeed(
    {
      recordId: record.body.recordId,
      representation: record.body.representation,
      sizeBytes: record.body.sizeBytes,
      sha256: record.body.sha256,
    },
    binding,
  );
  if (!seed.ok) return seed;
  return ok(channelPreviewOf(seed.value, record.body.sizeBytes));
}

function encodeChannelCursor(
  _namespace: "channel-list" | "channel-messages",
  filters: Record<string, string | number | boolean | null>,
  ports: ChannelCommandPorts,
  limit: number,
  lastSortKey: { createdAt: string; id: string },
  channelId?: string,
): string {
  return encodeCursor({
    filterHash: filterHash({ ...filters, installationId: ports.installationId, channel: channelId ?? null }),
    lastSortKey: sortKeyOf(lastSortKey.createdAt, lastSortKey.id),
    limit,
  });
}

function decodeChannelCursor(
  cursor: string,
  _namespace: "channel-list" | "channel-messages",
  filters: Record<string, string | number | boolean | null>,
  ports: ChannelCommandPorts,
  limit: number,
  channelId?: string,
): Result<{ createdAt: string; id: string }> {
  const expected = filterHash({ ...filters, installationId: ports.installationId, channel: channelId ?? null });
  const decoded = decodeCursor(cursor, expected);
  if (!decoded.ok) return decoded;
  if (decoded.value.limit !== limit)
    return err(appError("CURSOR_INVALID", "The cursor does not match the supplied page size"));
  // The exact sort-component guards of the Memo cursor tuple: the last sort
  // key must be a valid timestamp and a canonical UUID, so a malformed tuple is
  // CURSOR_INVALID rather than a silent page drift (section 38.4).
  const separator = decoded.value.lastSortKey.lastIndexOf("|");
  if (separator <= 0 || separator === decoded.value.lastSortKey.length - 1) {
    return err(appError("CURSOR_INVALID", "The Channel cursor sort key is malformed"));
  }
  const createdAt = decoded.value.lastSortKey.slice(0, separator);
  const id = decoded.value.lastSortKey.slice(separator + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !isChannelUuid(id)) {
    return err(appError("CURSOR_INVALID", "The Channel cursor sort key is malformed"));
  }
  return ok({ createdAt, id });
}

/** The complete-content read: the exact body text resolves outside any transaction; no fetch event, no mutation (section 38.4). */
export function readChannelMessage(
  ports: ChannelCommandPorts,
  channelId: unknown,
  messageId: unknown,
): Result<MessageDetail> {
  if (!isChannelUuid(channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  if (!isChannelUuid(messageId)) return err(appError("CHN_MESSAGE_NOT_FOUND", "Unknown message for this Channel"));
  const record = ports.channels.inspect((reader) => reader.message(channelId as string, messageId as string));
  if (!record.ok) return record;
  if (record.value === null) return err(appError("CHN_MESSAGE_NOT_FOUND", "Unknown message for this Channel"));
  const binding = ports.staging.freshBinding();
  if (!binding.ok) return binding;
  const body = ports.bodies.resolveBody(
    {
      recordId: record.value.body.recordId,
      representation: record.value.body.representation,
      sizeBytes: record.value.body.sizeBytes,
      sha256: record.value.body.sha256,
    },
    binding.value,
  );
  if (!body.ok) return body;
  const preview =
    record.value.body.inlineText !== null
      ? channelPreviewOf(record.value.body.inlineText, record.value.body.sizeBytes)
      : channelPreviewOf(body.value, record.value.body.sizeBytes);
  return ok({ ...messageSummaryOf(record.value, preview), body: body.value });
}

export interface ChannelWaitOutcome {
  timedOut: boolean;
  messages: MessageSummary[];
  /** The same page-bound cursor the ordinary listing would emit for this page. */
  nextCursor: string | null;
}

/**
 * The pending-inclusive Channel wait (CHN-007, CHN-012, section 38.5): it
 * returns immediately when at least one unhandled message matches the filter at
 * invocation, otherwise polls at the bounded interval until an arrival or the
 * timeout. The deadline is measured from invocation; a retryable listing
 * failure (`STORAGE_INSPECTION_UNAVAILABLE` or read-side
 * `CONTENT_MATERIALIZING`) is retried at the poll cadence, the most recent
 * failure is reported as its typed error only when it persists at the deadline,
 * and an ordinary empty timeout reports `timedOut` with an empty list. The
 * supplied filter is validated once per successful validation inside the same
 * continuation, so an unknown participant or assignment fails immediately. A
 * wait never marks, handles, acknowledges, or otherwise mutates anything, and it
 * returns one bounded page under the same `--limit`, ordering, and preview
 * bounds as the ordinary listing — with the same page-bound `nextCursor`, never
 * a separate unbounded path — so remaining messages are read through the
 * subsequent non-waiting paginated listing.
 */
export function waitForChannelMessages(
  ports: ChannelCommandPorts,
  channelId: string,
  filter: { participantId?: string | null; assignmentId?: string | null; kind?: MessageKind | null },
  options: {
    intervalSeconds: number;
    timeoutSeconds: number;
    sleepMs: (ms: number) => void;
    /** The explicit page bound; the default page size when omitted. */
    limit?: unknown;
  },
): Result<ChannelWaitOutcome> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  // The same input validation the ordinary listing runs, before the existence
  // check and the loop: a wait never polls on a kind, UUID shape, or bound the
  // listing refuses (section 38.5).
  const validated = validateMessageListAttributes(ports, channelId, {
    handling: "unhandled",
    participantId: filter.participantId,
    assignmentId: filter.assignmentId,
    kind: filter.kind,
    limit: options.limit,
  });
  if (!validated.ok) return validated;
  const pageFilter = validated.value.filter;
  const limit = validated.value.limit;
  const participantId = pageFilter.participantId;
  const assignmentId = pageFilter.assignmentId;
  let filtersValidated = false;
  let tracked: AppError | null = null;
  for (;;) {
    if (!filtersValidated) {
      const existence = validateMessageFilterExistence(ports, channelId, { participantId, assignmentId });
      if (!existence.ok) {
        if (!isRetryableWaitListingFailure(existence.error)) return existence;
        tracked = existence.error;
      } else {
        filtersValidated = true;
        tracked = null;
      }
    }
    if (filtersValidated) {
      const page = captureMessagePage(ports, channelId, pageFilter, undefined, limit);
      if (!page.ok) {
        if (!isRetryableWaitListingFailure(page.error)) return page;
        tracked = page.error;
      } else if (page.value.items.length > 0) {
        return ok({ timedOut: false, messages: page.value.items, nextCursor: page.value.nextCursor });
      } else {
        // A later successful poll clears an earlier failure: only a failure
        // that persists at the deadline is reported.
        tracked = null;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (tracked !== null) return err(tracked);
      return ok({ timedOut: true, messages: [], nextCursor: null });
    }
    options.sleepMs(Math.min(options.intervalSeconds * 1000, remaining));
  }
}

// ---------------------------------------------------------------------------
// Stored-receipt parsers (SHR-008 fail-closed, section 38.4 closed DTOs)

const MESSAGE_SUMMARY_KEYS = [
  "id",
  "channelId",
  "kind",
  "senderParticipantId",
  "senderHandle",
  "assignmentId",
  "assignmentLate",
  "relayToParticipantId",
  "contextSession",
  "contextNode",
  "contextAttempt",
  "handled",
  "handledAt",
  "handledByParticipantId",
  "handledByKind",
  "handleNote",
  "processingRowVersion",
  "createdAt",
  "bodyBytes",
  "bodyPreview",
  "bodyPreviewTruncated",
] as const;

const CHANNEL_VIEW_KEYS = [
  "id",
  "title",
  "state",
  "creatorKind",
  "creatorId",
  "mainParticipantId",
  "closedAt",
  "closedByParticipantId",
  "closedByKind",
  "createdAt",
  "updatedAt",
  "participantCount",
  "messageCount",
  "unhandledCount",
  "participants",
  "assignments",
] as const;

const PARTICIPANT_VIEW_KEYS = [
  "id",
  "channelId",
  "role",
  "handle",
  "nativeProvenance",
  "active",
  "deactivatedAt",
  "registeredAt",
] as const;

function closedObject(value: unknown, keys: readonly string[]): Result<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt entry is not an object."));
  }
  const record = value as Record<string, unknown>;
  const present = Object.keys(record);
  if (
    !keys.every((key) => present.includes(key)) ||
    present.some((key) => !(keys as readonly string[]).includes(key))
  ) {
    return err(
      appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt entry does not carry its closed key set."),
    );
  }
  return ok(record);
}

function requireUuidOrNull(value: unknown, field: string): Result<string | null> {
  if (value === null) return ok(null);
  if (!isChannelUuid(value)) {
    return err(appError("STORAGE_INTEGRITY_ERROR", `A stored Channel receipt carries an invalid ${field}.`));
  }
  return ok(value);
}

function requireBoundedText(value: unknown, field: string, maxBytes: number): Result<string | null> {
  if (value === null) return ok(null);
  if (typeof value !== "string" || !value.isWellFormed() || utf8ByteLength(value) > maxBytes) {
    return err(appError("STORAGE_INTEGRITY_ERROR", `A stored Channel receipt carries an invalid ${field}.`));
  }
  return ok(value);
}

function integrityRefusal(message: string): Result<never> {
  return err(appError("STORAGE_INTEGRITY_ERROR", message));
}

function requireInstant(value: unknown, field: string): Result<string> {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return err(appError("STORAGE_INTEGRITY_ERROR", `A stored Channel receipt carries an invalid ${field}.`));
  }
  return ok(value);
}

/**
 * The one strict stored submit-receipt parser every lookup — the mutation
 * transaction's receipt probe and the non-migrating replay-only inspection —
 * consumes (SHR-008, section 38.4): the receipt envelope carries exactly
 * `message`, the summary carries exactly its closed named fields with their
 * null meanings and bounds, no body or private content field appears, and the
 * original submission decision state is intact — unhandled, no handling
 * fields, processing row version 1 — because the receipt stores the original
 * submission-time outcome verbatim. A malformed receipt is a body-free
 * `STORAGE_INTEGRITY_ERROR`, never absence and never a fresh execute.
 */
export function parseStoredChannelSubmitReceipt(value: unknown): Result<MessageSummary> {
  const envelope = closedObject(value, ["message"]);
  if (!envelope.ok) return envelope;
  const message = closedObject(envelope.value.message, MESSAGE_SUMMARY_KEYS);
  if (!message.ok) return message;
  const m = message.value;
  const id = requireUuidOrNull(m.id, "message id");
  if (!id.ok || id.value === null)
    return id.ok ? err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a null message id.")) : id;
  const channelId = requireUuidOrNull(m.channelId, "channelId");
  if (!channelId.ok || channelId.value === null)
    return channelId.ok
      ? err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a null channelId."))
      : channelId;
  const senderParticipantId = requireUuidOrNull(m.senderParticipantId, "senderParticipantId");
  if (!senderParticipantId.ok || senderParticipantId.value === null)
    return senderParticipantId.ok
      ? err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a null senderParticipantId."))
      : senderParticipantId;
  const assignmentId = requireUuidOrNull(m.assignmentId, "assignmentId");
  if (!assignmentId.ok) return assignmentId;
  const relayToParticipantId = requireUuidOrNull(m.relayToParticipantId, "relayToParticipantId");
  if (!relayToParticipantId.ok) return relayToParticipantId;
  const handledByParticipantId = requireUuidOrNull(m.handledByParticipantId, "handledByParticipantId");
  if (!handledByParticipantId.ok) return handledByParticipantId;
  if (m.kind !== "report" && m.kind !== "question" && m.kind !== "relay_request") {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries an invalid message kind."));
  }
  if ((m.kind === "relay_request") !== (relayToParticipantId.value !== null)) {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt's relay target does not match its kind."));
  }
  // The sender handle keeps its recorded semantic bounds without
  // normalization: a stored handle must satisfy the exact registration rules.
  const senderHandle = validateChannelHandle(m.senderHandle);
  if (!senderHandle.ok) {
    return integrityRefusal("A stored Channel receipt carries a senderHandle outside the recorded handle rules.");
  }
  if (
    typeof m.assignmentLate !== "boolean" ||
    typeof m.handled !== "boolean" ||
    typeof m.bodyPreviewTruncated !== "boolean"
  ) {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a non-boolean flag."));
  }
  // The late flag exists only on a referenced assignment that was already
  // closed at submission: a late flag without an assignment is impossible.
  if (m.assignmentLate === true && assignmentId.value === null) {
    return integrityRefusal("A stored Channel receipt marks a late report against no assignment.");
  }
  // The original submission decision state: unhandled with null handling fields.
  if (
    m.handled !== false ||
    m.handledAt !== null ||
    m.handledByParticipantId !== null ||
    m.handleNote !== null ||
    m.processingRowVersion !== 1
  ) {
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        "A stored Channel receipt does not carry its original submission-time summary.",
      ),
    );
  }
  if (m.handledByKind !== null) {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a handledByKind."));
  }
  // The context fields keep their recorded semantic bounds without
  // normalization; an empty string is a supplied value and stays verbatim.
  const contextSession = validateContextField(m.contextSession);
  if (!contextSession.ok) {
    return integrityRefusal("A stored Channel receipt carries a contextSession outside the recorded context rules.");
  }
  const contextNode = validateContextField(m.contextNode);
  if (!contextNode.ok) {
    return integrityRefusal("A stored Channel receipt carries a contextNode outside the recorded context rules.");
  }
  const contextAttempt = validateContextField(m.contextAttempt);
  if (!contextAttempt.ok) {
    return integrityRefusal("A stored Channel receipt carries a contextAttempt outside the recorded context rules.");
  }
  if (
    typeof m.bodyBytes !== "number" ||
    !Number.isSafeInteger(m.bodyBytes) ||
    m.bodyBytes < 1 ||
    typeof m.bodyPreview !== "string" ||
    !m.bodyPreview.isWellFormed() ||
    utf8ByteLength(m.bodyPreview) > CHANNEL_PREVIEW_BYTES
  ) {
    return integrityRefusal("A stored Channel receipt carries an invalid body summary.");
  }
  // The preview and the recorded byte count must cohere: a complete preview
  // is the whole body's exact byte length, and a truncated preview is
  // strictly shorter than the body it truncates.
  const previewBytes = utf8ByteLength(m.bodyPreview);
  if (m.bodyPreviewTruncated === false && previewBytes !== m.bodyBytes) {
    return integrityRefusal("A stored Channel receipt's complete preview disagrees with its recorded body bytes.");
  }
  if (m.bodyPreviewTruncated === true && m.bodyBytes <= previewBytes) {
    return integrityRefusal("A stored Channel receipt's truncated preview is not shorter than its body.");
  }
  const createdAt = requireInstant(m.createdAt, "createdAt");
  if (!createdAt.ok) return createdAt;
  return ok({
    id: id.value,
    channelId: channelId.value,
    kind: m.kind,
    senderParticipantId: senderParticipantId.value,
    senderHandle: senderHandle.value,
    assignmentId: assignmentId.value,
    assignmentLate: m.assignmentLate,
    relayToParticipantId: relayToParticipantId.value,
    contextSession: contextSession.value,
    contextNode: contextNode.value,
    contextAttempt: contextAttempt.value,
    handled: false,
    handledAt: null,
    handledByParticipantId: null,
    handledByKind: null,
    handleNote: null,
    processingRowVersion: 1,
    createdAt: createdAt.value,
    bodyBytes: m.bodyBytes,
    bodyPreview: m.bodyPreview,
    bodyPreviewTruncated: m.bodyPreviewTruncated,
  });
}

/**
 * The one strict stored create-receipt parser: the envelope carries exactly
 * `channel`, the view carries exactly its closed named fields, and the stored
 * view is the original creation outcome — an open Channel with null closing
 * fields, zero messages and unhandled counts, exactly its creation roster, and
 * no assignments — with the closed creator kinds only. A malformed receipt is
 * a body-free `STORAGE_INTEGRITY_ERROR`.
 */
export function parseStoredChannelCreateReceipt(value: unknown): Result<ChannelView> {
  const envelope = closedObject(value, ["channel"]);
  if (!envelope.ok) return envelope;
  const view = closedObject(envelope.value.channel, CHANNEL_VIEW_KEYS);
  if (!view.ok) return view;
  const c = view.value;
  const id = requireUuidOrNull(c.id, "channel id");
  if (!id.ok || id.value === null)
    return id.ok ? err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a null channel id.")) : id;
  const mainParticipantId = requireUuidOrNull(c.mainParticipantId, "mainParticipantId");
  if (!mainParticipantId.ok || mainParticipantId.value === null)
    return mainParticipantId.ok
      ? err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a null mainParticipantId."))
      : mainParticipantId;
  const title = requireBoundedText(c.title, "title", CHANNEL_TITLE_BYTES);
  if (!title.ok) return title;
  // The stored creation title is the normalized creation title: the original
  // normalized rules must accept it unchanged, with no re-normalization.
  const normalizedTitle = normalizeChannelTitle(c.title);
  if (!normalizedTitle.ok || normalizedTitle.value !== c.title) {
    return integrityRefusal("A stored Channel receipt carries a title outside the recorded title rules.");
  }
  const creatorId = requireBoundedText(c.creatorId, "creatorId", 512);
  if (!creatorId.ok) return creatorId;
  if (
    c.creatorKind !== "registered_project" &&
    c.creatorKind !== "unregistered_workspace" &&
    c.creatorKind !== "user"
  ) {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries an invalid creatorKind."));
  }
  if ((c.creatorKind === "user") !== (creatorId.value === null)) {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt's creator id does not match its kind."));
  }
  if (
    c.state !== "open" ||
    c.closedAt !== null ||
    c.closedByParticipantId !== null ||
    c.closedByKind !== null ||
    c.messageCount !== 0 ||
    c.unhandledCount !== 0
  ) {
    return err(
      appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt does not carry its original creation-time view."),
    );
  }
  if (
    typeof c.participantCount !== "number" ||
    !Number.isSafeInteger(c.participantCount) ||
    c.participantCount !== 1 ||
    !Array.isArray(c.participants) ||
    c.participants.length !== c.participantCount ||
    !Array.isArray(c.assignments) ||
    c.assignments.length !== 0
  ) {
    return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries an invalid creation roster."));
  }
  const participants: ParticipantView[] = [];
  for (const raw of c.participants) {
    const p = closedObject(raw, PARTICIPANT_VIEW_KEYS);
    if (!p.ok) return p;
    const pid = requireUuidOrNull(p.value.id, "participant id");
    if (!pid.ok || pid.value === null)
      return pid.ok
        ? err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a null participant id."))
        : pid;
    const pchannel = requireUuidOrNull(p.value.channelId, "participant channelId");
    if (!pchannel.ok || pchannel.value !== id.value) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt's participant names another Channel."));
    }
    if (p.value.role !== "main" || pid.value !== mainParticipantId.value) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries an invalid participant role."));
    }
    const storedHandle = validateChannelHandle(p.value.handle);
    if (!storedHandle.ok) {
      return integrityRefusal(
        "A stored Channel receipt carries a participant handle outside the recorded handle rules.",
      );
    }
    const storedProvenance = validateNativeProvenance(p.value.nativeProvenance);
    if (!storedProvenance.ok) {
      return integrityRefusal("A stored Channel receipt carries a native provenance list outside the recorded rules.");
    }
    if (p.value.active !== true || p.value.deactivatedAt !== null) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt carries a non-boolean active flag."));
    }
    if ((p.value.active !== true) !== (p.value.deactivatedAt !== null)) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt's deactivation state is incoherent."));
    }
    const registeredAt = requireInstant(p.value.registeredAt, "registeredAt");
    if (!registeredAt.ok) return registeredAt;
    participants.push({
      id: pid.value,
      channelId: pchannel.value as string,
      role: p.value.role,
      handle: storedHandle.value,
      nativeProvenance: storedProvenance.value,
      active: p.value.active,
      deactivatedAt: (p.value.deactivatedAt as string | null) ?? null,
      registeredAt: registeredAt.value,
    });
  }
  if (participants.filter((p) => p.role === "main").length !== 1) {
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        "A stored Channel receipt's creation roster does not carry exactly one main.",
      ),
    );
  }
  // The initial main is registered at creation and carries exactly an empty
  // native provenance list — a general `[""]` entry stays a valid supplied
  // value for later participants, but an invented entry on the creation main
  // contradicts the creation contract (the F2 correction).
  const creationMain = participants.find((p) => p.role === "main") as ParticipantView;
  if (creationMain.nativeProvenance.length !== 0) {
    return err(
      appError("STORAGE_INTEGRITY_ERROR", "A stored Channel receipt's creation main carries native provenance."),
    );
  }
  const createdAt = requireInstant(c.createdAt, "createdAt");
  if (!createdAt.ok) return createdAt;
  const updatedAt = requireInstant(c.updatedAt, "updatedAt");
  if (!updatedAt.ok) return updatedAt;
  if (updatedAt.value !== createdAt.value || participants[0]?.registeredAt !== createdAt.value) {
    return integrityRefusal("A stored Channel creation receipt carries inconsistent creation timestamps.");
  }
  return ok({
    id: id.value,
    title: title.value,
    state: "open",
    creatorKind: c.creatorKind,
    creatorId: creatorId.value,
    mainParticipantId: mainParticipantId.value,
    closedAt: null,
    closedByParticipantId: null,
    closedByKind: null,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    participantCount: c.participantCount as number,
    messageCount: 0,
    unhandledCount: 0,
    participants,
    assignments: [],
  });
}

// ---------------------------------------------------------------------------
// Retained-receipt request consistency (the C1 correction)

/** The input-known facts of the original submission a replay caller carries. */
export interface RetainedSubmitRequestKnowledge {
  channelId: string;
  senderParticipantId: string;
  kind: MessageKind;
  assignmentId: string | null;
  relayToParticipantId: string | null;
  contextSession: string | null;
  contextNode: string | null;
  contextAttempt: string | null;
  bodyBytes: number;
  preview: { bodyPreview: string; bodyPreviewTruncated: boolean };
}

/**
 * Cross-checks a hash-matching retained submit receipt's summary against the
 * input-known facts of the request the caller just presented (the C1
 * correction): every field the original request determined — sender, kind,
 * assignment, relay target, the three verbatim context fields with their
 * null-versus-empty distinction, the body's accepted byte count, and the
 * deterministically prepared preview — must equal the retained summary,
 * because the receipt claims to be this request's original outcome. A
 * contradiction is a body-free `STORAGE_INTEGRITY_ERROR`, never a miss, a
 * fresh execute, or a fabricated original; a legitimately different request
 * keeps its earlier `IDEMPOTENCY_CONFLICT`, and an honest historical receipt
 * — closed Channel, deactivated sender, or since-handled message alike —
 * still replays, because the comparison is against the original request's
 * input, never against current state. Input-unknowable fields (the message
 * id, createdAt, the sender handle, the insertion-frozen late flag) are not
 * checked here.
 */
export function checkRetainedSummaryAgainstRequest(
  summary: MessageSummary,
  known: RetainedSubmitRequestKnowledge,
): Result<void> {
  const mismatch = (field: string): Result<void> =>
    err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        `The retained Channel submission receipt contradicts the original request on ${field}.`,
        { field },
      ),
    );
  if (summary.channelId !== known.channelId) return mismatch("channelId");
  if (summary.senderParticipantId !== known.senderParticipantId) return mismatch("senderParticipantId");
  if (summary.kind !== known.kind) return mismatch("kind");
  if (summary.assignmentId !== known.assignmentId) return mismatch("assignmentId");
  if (summary.relayToParticipantId !== known.relayToParticipantId) return mismatch("relayToParticipantId");
  if (summary.contextSession !== known.contextSession) return mismatch("contextSession");
  if (summary.contextNode !== known.contextNode) return mismatch("contextNode");
  if (summary.contextAttempt !== known.contextAttempt) return mismatch("contextAttempt");
  if (summary.bodyBytes !== known.bodyBytes) return mismatch("bodyBytes");
  if (summary.bodyPreview !== known.preview.bodyPreview) return mismatch("bodyPreview");
  if (summary.bodyPreviewTruncated !== known.preview.bodyPreviewTruncated) return mismatch("bodyPreviewTruncated");
  return ok(undefined);
}

/** The input-known facts of the original creation a replay caller carries. */
export interface RetainedCreateRequestKnowledge {
  mainHandle: string;
  title: string | null;
  creatorKind: ChannelCreatorKind;
  creatorId: string | null;
}

/**
 * The creation twin of the retained-receipt consistency check (the C1
 * correction): a hash-matching retained creation receipt must carry the
 * caller's known main handle, normalized title, and creator provenance — the
 * fields the original request determined — and its roster's single main must
 * be exactly that handle. A contradiction is a body-free
 * `STORAGE_INTEGRITY_ERROR`; a legitimately different request keeps its
 * `IDEMPOTENCY_CONFLICT`.
 */
export function checkRetainedCreationAgainstRequest(
  view: ChannelView,
  known: RetainedCreateRequestKnowledge,
): Result<void> {
  const mismatch = (field: string): Result<void> =>
    err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        `The retained Channel creation receipt contradicts the original request on ${field}.`,
        { field },
      ),
    );
  if (view.title !== known.title) return mismatch("title");
  if (view.creatorKind !== known.creatorKind) return mismatch("creatorKind");
  if (view.creatorId !== known.creatorId) return mismatch("creatorId");
  const main = view.participants.find((participant) => participant.role === "main");
  if (main === undefined || main.id !== view.mainParticipantId) return mismatch("mainParticipantId");
  if (main.handle !== known.mainHandle) return mismatch("mainHandle");
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Replay-only submission recovery (CHN-006, section 38.6, P3 section C)

/** The non-migrating receipt reader the replay-only inspection seam supplies. */
export interface ChannelReceiptReader {
  submitReceipt(key: string, scope: string, now: string): Result<StoredChannelSubmitReceipt | null>;
}

/** The replay-only observation the installation-inspection seam produces; no staging, no activation, no migration, no log writes. */
export interface ChannelRecoveryPorts {
  clock: Clock;
  /**
   * The optional contained warning sink for a recorded outcome whose content
   * state cannot be observed (SHR-015): a throwing sink never changes the result.
   */
  warnings?(text: string): void;
  inspect<T>(
    consume: (observation: {
      installationId: string;
      migrationVersion: number;
      receipts: ChannelReceiptReader;
      /** The same database-only content-state probe the submit paths use, over this captured inspection. */
      contentState(
        channelId: string,
        messageId: string,
      ): Result<{ representation: "inline" | "file"; materialized: boolean }, AppError>;
    }) => Result<T>,
  ): Result<T>;
  /** The same full accepted-body proofs the execute path runs, over the read-only seam (the F5 and C1 corrections). */
  bodies: Pick<ChannelBodyPorts, "proveAcceptedNonBlank" | "readAcceptedPreviewSeed">;
}

export interface SubmitReplayOnlyInput {
  installationId: string;
  maxBytes: number;
  channelId: unknown;
  senderParticipantId: unknown;
  kind: unknown;
  accepted: AcceptedChannelBody;
  assignmentId?: unknown;
  relayToParticipantId?: unknown;
  contextSession?: unknown;
  contextNode?: unknown;
  contextAttempt?: unknown;
  idempotencyKey: string;
}

/**
 * The replay-only inspection of an outcome-unknown submission (CHN-006, P3
 * section C): it reads the retained receipt through the non-migrating
 * installation-inspection seam without executing, without staging or
 * activating content, without mutating domain, receipt, event, or expiry
 * state, and never resolves an unknown external dispatch outcome into a
 * repeat. A database whose applied maximum is below the Channel floor has no
 * Channel domain and refuses with STORAGE_SCHEMA_UNSUPPORTED. A retained
 * eligible receipt is found before any live-state eligibility is even read;
 * the original input is the only request identity, so a changed request
 * conflicts and a missing, expired, or restore-lost receipt is
 * CHN_REPLAY_UNAVAILABLE.
 */
export function submitMessageReplayOnly(
  ports: ChannelRecoveryPorts,
  input: SubmitReplayOnlyInput,
): Result<{ message: MessageSummary; contentActivating: boolean }> {
  if (!isChannelUuid(input.channelId)) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
  if (!isChannelUuid(input.senderParticipantId)) {
    return err(appError("CHN_PARTICIPANT_NOT_FOUND", "Unknown participant for this Channel"));
  }
  if (input.kind !== "report" && input.kind !== "question" && input.kind !== "relay_request") {
    return invalid("A message carries exactly the kinds report, question, and relay_request");
  }
  const messageKind: MessageKind = input.kind;
  // Original-input parity with the normal submit path: the relay target is
  // required exactly on a relay request, so a weaker recovery surface cannot
  // hide behind the inspection (CHN-004, CHN-006).
  if (input.kind === "relay_request" && !isChannelUuid(input.relayToParticipantId)) {
    return invalid("A relay request names its target participant");
  }
  if (
    input.kind !== "relay_request" &&
    input.relayToParticipantId !== undefined &&
    input.relayToParticipantId !== null
  ) {
    return invalid("Only a relay request names a target participant");
  }
  if (input.assignmentId !== undefined && input.assignmentId !== null && !isChannelUuid(input.assignmentId)) {
    return err(appError("CHN_ASSIGNMENT_NOT_FOUND", "Unknown assignment for this Channel"));
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    return invalid("Replay-only requires the original idempotency key");
  }
  const contextSession = validateContextField(input.contextSession);
  if (!contextSession.ok) return contextSession;
  const contextNode = validateContextField(input.contextNode);
  if (!contextNode.ok) return contextNode;
  const contextAttempt = validateContextField(input.contextAttempt);
  if (!contextAttempt.ok) return contextAttempt;
  if (input.accepted.kind === "text") {
    const blank = checkChannelBodyText(input.accepted.text, input.maxBytes);
    if (!blank.ok) return blank;
  } else {
    // The F5 correction on the read-only seam: a spool-backed original gets
    // the same full nonblank proof before any inspection, so a blank original
    // is refused without touching the installation.
    const nonBlank = ports.bodies.proveAcceptedNonBlank(input.accepted);
    if (!nonBlank.ok) return nonBlank;
  }
  // The C1 correction's once-prepared preview, prepared before any inspection
  // from the same once-accepted input through the existing bounded seam: the
  // accepted text directly, or the spool's bounded head — never the mutable
  // original body reread, never a whole-body buffer.
  const previewSeed =
    input.accepted.kind === "text" ? ok(input.accepted.text) : ports.bodies.readAcceptedPreviewSeed(input.accepted);
  if (!previewSeed.ok) return previewSeed;
  const preparedPreview = channelPreviewOf(previewSeed.value, input.accepted.sizeBytes);
  const hash = composeChannelRequestDigest({
    operation: "channel-submit",
    installationId: input.installationId,
    channelId: input.channelId as string,
    fields: {
      senderParticipantId: input.senderParticipantId as string,
      kind: messageKind,
      assignmentId: (input.assignmentId as string | null) ?? null,
      relayToParticipantId: (input.relayToParticipantId as string | null) ?? null,
      contextSession: contextSession.value,
      contextNode: contextNode.value,
      contextAttempt: contextAttempt.value,
    },
    body: { sha256: input.accepted.sha256, sizeBytes: input.accepted.sizeBytes },
  });
  const scope = channelSubmitScope(input.installationId, input.channelId as string);
  return ports.inspect((observation) => {
    if (observation.migrationVersion < CHANNEL_SCHEMA_FLOOR) {
      return err(appError("STORAGE_SCHEMA_UNSUPPORTED", "the historical database layout has no Channel domain"));
    }
    if (observation.installationId !== input.installationId) {
      return err(
        appError(
          "CHN_REPLAY_UNAVAILABLE",
          "The selected Installation differs from the original; the original outcome is unknown",
        ),
      );
    }
    // The lookup Clock is sampled inside the consistent captured inspection,
    // immediately before the receipt read: a capture that took time cannot let
    // a stale invocation time revive an expired receipt, and `expiresAt` equal
    // to the sampled now stays expired (sections 36.2 and 37).
    const now = ports.clock.now().toISOString();
    const stored = observation.receipts.submitReceipt(input.idempotencyKey, scope, now);
    if (!stored.ok) return stored;
    if (stored.value === null) {
      return err(
        appError("CHN_REPLAY_UNAVAILABLE", "No retained Channel submission receipt; the original outcome is unknown"),
      );
    }
    if (stored.value.message.channelId !== (input.channelId as string)) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "The retained Channel submission receipt names another Channel."));
    }
    if (stored.value.requestHash !== hash) {
      return err(appError("IDEMPOTENCY_CONFLICT", "The retained Channel submission key carries a different request"));
    }
    // A hash-matching receipt must still be this request's original outcome:
    // the same input-known consistency check the mutation path applies, over
    // the once-prepared preview and the normalized original input (the C1
    // correction, symmetric on both surfaces).
    const consistent = checkRetainedSummaryAgainstRequest(stored.value.message, {
      channelId: input.channelId as string,
      senderParticipantId: input.senderParticipantId as string,
      kind: messageKind,
      assignmentId: (input.assignmentId as string | null) ?? null,
      relayToParticipantId: (input.relayToParticipantId as string | null) ?? null,
      contextSession: contextSession.value,
      contextNode: contextNode.value,
      contextAttempt: contextAttempt.value,
      bodyBytes: input.accepted.sizeBytes,
      preview: preparedPreview,
    });
    if (!consistent.ok) return consistent;
    // The recorded summary returns verbatim; a file-backed record's current
    // state is derived read-only through the same database-only probe, and an
    // unobservable state is disclosed rather than asserted (CHN-012).
    if (stored.value.message.bodyBytes <= CONTENT_INLINE_MAX_UTF8_BYTES) {
      return ok({ message: stored.value.message, contentActivating: false });
    }
    return ok({
      message: stored.value.message,
      contentActivating: contentStateFlagOf(
        observation.contentState(input.channelId as string, stored.value.message.id),
        stored.value.message.id,
        (text) => emitRecoveryWarning(ports, text),
      ),
    });
  });
}

/** A contained replay-only warning: the sink's own failure never changes the recorded outcome. */
function emitRecoveryWarning(ports: ChannelRecoveryPorts, text: string): void {
  const sink = ports.warnings;
  if (sink === undefined) return;
  try {
    sink(text);
  } catch {
    // A diagnostic sink failure never changes the result.
  }
}

export function channelSubmitScope(installationId: string, channelId: string): string {
  return `channel-submit:${installationId}:${channelId}`;
}

export function channelCreateScope(installationId: string): string {
  return `channel-create:${installationId}`;
}
