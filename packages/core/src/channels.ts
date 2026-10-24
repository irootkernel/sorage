import { buildContentStorageKey, CONTENT_INLINE_MAX_UTF8_BYTES, utf8ByteLength } from "./content";
import { type AppError, appError, err, isRetryableWaitListingFailure, ok, type Result } from "./errors";
import { type ChannelDomainEventType, type NewDomainEvent, USER_ACTOR } from "./events";
import type { Clock, IdGenerator } from "./ids";
import type { AcceptedMemoBody } from "./memo-commands";

/**
 * The Channel domain rebuilt under ADR-0034 (CHN-001 to CHN-014, interface
 * sections 38.3 to 38.6, security section 10.1): Channels addressed by
 * globally unique name with their UUID also accepted, participants by handle,
 * messages by per-Channel sequence number; idempotent create, add, remove,
 * ack and close; post retries safe by content with the duplicate check inside
 * the posting transaction and before the closed and removed checks; posting
 * upstream only; complete-content listing with the body pinned per storage
 * state; and every mutation recording the User actor with the acting
 * participant handle in closed event metadata. There are no participant
 * UUIDs, idempotency keys, row versions, role assertions, assignments,
 * receipts, replay-only modes, `PRAGMA data_version` coherence loops,
 * rollback-and-retry cycles, or result indicators: the posting transaction is
 * the retry boundary, and one clock read per transaction stamps every row and
 * event of that transaction with the same instant.
 */

/** The closed text bounds of interface sections 38.3 and CHN-002. */
export const CHANNEL_NAME_SCALARS = 64;
export const CHANNEL_NAME_BYTES = 256;
export const CHANNEL_TITLE_SCALARS = 200;
export const CHANNEL_TITLE_BYTES = 800;
export const CHANNEL_HANDLE_SCALARS = 64;
export const CHANNEL_HANDLE_BYTES = 256;
export const CHANNEL_REF_SCALARS = 200;
export const CHANNEL_REF_BYTES = 800;
export const CHANNEL_NOTE_BYTES = 8_000;

/** The validated list upper bound of the `channel messages --limit` option (section 38.4). */
export const CHANNEL_LIST_MAX_LIMIT = 200;

/** The Channel domain schema floor: Channel surfaces exist only from version 11 on (SHR-009). */
export const CHANNEL_SCHEMA_FLOOR = 11;

export type ChannelRole = "main" | "worker" | "judge";
export type MessageKind = "report" | "question" | "relay_request";
export type ChannelLifecycleState = "open" | "closed";

/** True for a canonical UUID-shaped string, the form a Channel name may never take (CHN-002). */
export function isChannelUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) &&
    value.toLowerCase() === value
  );
}

// ---------------------------------------------------------------------------
// Records and public DTOs (interface sections 38.3 and 38.4, closed shapes)

/** One persisted Channel row (the `channels` table of schema 11 `channels-v2`). */
export interface ChannelRecord {
  id: string;
  name: string;
  title: string | null;
  state: ChannelLifecycleState;
  createdAt: string;
  closedAt: string | null;
}

/** One persisted participant row: removal sets `removedAt` and never deletes the row, so history keeps attributing old messages. */
export interface ParticipantRecord {
  channelId: string;
  handle: string;
  role: ChannelRole;
  addedAt: string;
  removedAt: string | null;
}

/** One persisted message row's immutable shared-content reference. */
export interface MessageBodyRef {
  recordId: string;
  representation: "inline" | "file";
  materialized: boolean;
  inlineText: string | null;
  storageKey: string | null;
  sizeBytes: number;
  sha256: string;
}

/** One persisted message row (the `channel_messages` table; `seq` is unique within its Channel). */
export interface MessageRecord {
  channelId: string;
  seq: number;
  senderHandle: string;
  kind: MessageKind;
  toHandle: string | null;
  ref: string | null;
  content: MessageBodyRef;
  handled: boolean;
  handledAt: string | null;
  handleNote: string | null;
  createdAt: string;
}

/** The closed public DTOs of interface section 38.4; every named field is present with its null meaning. */
export interface ChannelView {
  id: string;
  name: string;
  title: string | null;
  state: ChannelLifecycleState;
  main: string;
  participantCount: number;
  messageCount: number;
  unhandledCount: number;
  participants: ParticipantView[];
  createdAt: string;
  closedAt: string | null;
}

export interface ChannelSummary {
  id: string;
  name: string;
  title: string | null;
  state: ChannelLifecycleState;
  main: string;
  createdAt: string;
  closedAt: string | null;
}

export interface ParticipantView {
  handle: string;
  role: ChannelRole;
  addedAt: string;
  removedAt: string | null;
}

export interface MessageView {
  seq: number;
  kind: MessageKind;
  from: string;
  to: string | null;
  ref: string | null;
  body: string | null;
  bodyPath: string | null;
  bodyPending: boolean;
  handled: boolean;
  handledAt: string | null;
  handleNote: string | null;
  createdAt: string;
}

/** The accepted body this domain shares with the Memo capture primitive (SHR-012). */
export type AcceptedChannelBody = AcceptedMemoBody;

// ---------------------------------------------------------------------------
// Bounds validation (interface section 38.3)

function invalid(message: string): Result<never> {
  return err(appError("CHN_INVALID_INPUT", message));
}

function isSingleLineWellFormed(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && !/[\p{Cc}\u2028\u2029]/u.test(value);
}

/**
 * A Channel name: a single line of 1 to 64 scalars and at most 256 UTF-8
 * bytes, control-free and never trimmed because it is an identity, unique
 * under exact case-sensitive comparison; a UUID-shaped name is refused because
 * the UUID is the other addressing form (CHN-002).
 */
export function validateChannelName(value: unknown): Result<string> {
  if (!isSingleLineWellFormed(value)) {
    return invalid("Channel name must be valid single-line Unicode text");
  }
  const name = value as string;
  if (name.length === 0 || [...name].length > CHANNEL_NAME_SCALARS || utf8ByteLength(name) > CHANNEL_NAME_BYTES) {
    return invalid("Channel name must contain 1 to 64 scalars and at most 256 UTF-8 bytes");
  }
  if (isChannelUuid(name)) {
    return invalid("A Channel name must not be UUID-shaped; the UUID addresses an existing Channel");
  }
  return ok(name);
}

/**
 * A participant handle: a single line of 1 to 64 scalars and at most 256 UTF-8
 * bytes, control-free and never trimmed because it is an identity, unique
 * within its Channel under exact comparison (section 38.3). The only empty
 * handle is the empty string: a blank-looking handle built from whitespace or
 * a lone byte-order mark is nonempty and stays byte-exact.
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
 * A `--ref` reference: null when absent, else a trimmed single line of 1 to
 * 200 scalars and at most 800 UTF-8 bytes without control characters,
 * recorded verbatim as untrusted data (CHN-004).
 */
export function validateMessageRef(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (!isSingleLineWellFormed(value)) {
    return invalid("Message reference must be valid single-line Unicode text");
  }
  const reference = (value as string).trim();
  if (
    reference.length === 0 ||
    [...reference].length > CHANNEL_REF_SCALARS ||
    utf8ByteLength(reference) > CHANNEL_REF_BYTES
  ) {
    return invalid("Message reference must contain 1 to 200 scalars and at most 800 UTF-8 bytes");
  }
  return ok(reference);
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

/** True when the accepted body routes to the Vault's shared content store rather than inline text (SHR-005). */
export function channelBodyRoutesFile(accepted: AcceptedChannelBody): boolean {
  return accepted.sizeBytes > CONTENT_INLINE_MAX_UTF8_BYTES;
}

// ---------------------------------------------------------------------------
// Event metadata (security section 10.1, closed key sets; CHN-013)

/** One Channel event's closed input: the acting handle is the sender for a post and the main handle otherwise. */
export type ChannelEventInput =
  | { type: "CHANNEL_CREATED"; channelId: string; actingHandle: string; mainHandle: string }
  | { type: "CHANNEL_CLOSED"; channelId: string; actingHandle: string }
  | {
      type: "CHANNEL_PARTICIPANT_ADDED";
      channelId: string;
      actingHandle: string;
      handle: string;
      role: "worker" | "judge";
    }
  | { type: "CHANNEL_PARTICIPANT_REMOVED"; channelId: string; actingHandle: string; handle: string }
  | {
      type: "CHANNEL_MESSAGE_POSTED";
      channelId: string;
      actingHandle: string;
      seq: number;
      kind: MessageKind;
      toHandle: string | null;
    }
  | { type: "CHANNEL_MESSAGE_ACKED"; channelId: string; actingHandle: string; seq: number };

/** Builds the ledger row of one Channel event: the User actor, null associations, null row version (section 38.9). */
export function channelDomainEvent(id: string, input: ChannelEventInput, createdAt: string): NewDomainEvent {
  const actor = USER_ACTOR;
  switch (input.type) {
    case "CHANNEL_CREATED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle, mainHandle: input.mainHandle },
        createdAt,
      };
    case "CHANNEL_CLOSED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle },
        createdAt,
      };
    case "CHANNEL_PARTICIPANT_ADDED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: {
          channelId: input.channelId,
          actingHandle: input.actingHandle,
          handle: input.handle,
          role: input.role,
        },
        createdAt,
      };
    case "CHANNEL_PARTICIPANT_REMOVED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle, handle: input.handle },
        createdAt,
      };
    case "CHANNEL_MESSAGE_POSTED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: {
          channelId: input.channelId,
          actingHandle: input.actingHandle,
          seq: input.seq,
          kind: input.kind,
          toHandle: input.toHandle,
        },
        createdAt,
      };
    case "CHANNEL_MESSAGE_ACKED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle, seq: input.seq },
        createdAt,
      };
  }
}

function requireClosedKeys(value: Record<string, unknown>, keys: readonly string[]): Result<void> {
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      return invalid(`The ${String(value.eventType ?? "Channel event")} metadata lacks ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return invalid(`The Channel event metadata carries the unknown key ${key}`);
  }
  return ok(undefined);
}

function requireEventHandle(value: unknown, field: string): Result<string> {
  const handle = validateChannelHandle(value);
  if (!handle.ok) return invalid(`Channel event ${field} must be a bounded handle`);
  return handle;
}

function requireEventSeq(value: unknown): Result<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid("Channel event seq must be a positive safe integer");
  }
  return ok(value);
}

/**
 * Validates one Channel event's closed metadata against security section
 * 10.1: the exact key set of its type, a canonical UUID `channelId`, bounded
 * handles, the kind and role enums with their null rules, and a positive safe
 * integer `seq`. No body, title, reference or note text ever appears here
 * (CHN-011).
 */
export function validateChannelEventMetadata(
  eventType: ChannelDomainEventType,
  metadata: Record<string, unknown>,
): Result<void> {
  if (typeof metadata.channelId !== "string" || !isChannelUuid(metadata.channelId)) {
    return invalid("Channel event metadata carries a non-canonical channelId");
  }
  switch (eventType) {
    case "CHANNEL_CREATED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "mainHandle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const main = requireEventHandle(metadata.mainHandle, "mainHandle");
      if (!main.ok) return main;
      if (acting.value !== main.value)
        return invalid("A Channel creation event's acting handle must be its main handle");
      return ok(undefined);
    }
    case "CHANNEL_CLOSED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      return ok(undefined);
    }
    case "CHANNEL_PARTICIPANT_ADDED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "handle", "role"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const handle = requireEventHandle(metadata.handle, "handle");
      if (!handle.ok) return handle;
      if (metadata.role !== "worker" && metadata.role !== "judge") {
        return invalid("A participant addition event carries a non-registration role");
      }
      if (metadata.handle === metadata.actingHandle) return invalid("A participant addition names the main handle");
      return ok(undefined);
    }
    case "CHANNEL_PARTICIPANT_REMOVED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "handle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const handle = requireEventHandle(metadata.handle, "handle");
      if (!handle.ok) return handle;
      if (metadata.handle === metadata.actingHandle) return invalid("A participant removal names the main handle");
      return ok(undefined);
    }
    case "CHANNEL_MESSAGE_POSTED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "seq", "kind", "toHandle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const seq = requireEventSeq(metadata.seq);
      if (!seq.ok) return seq;
      if (metadata.kind !== "report" && metadata.kind !== "question" && metadata.kind !== "relay_request") {
        return invalid("A message posting event carries an unknown kind");
      }
      if (metadata.kind === "relay_request") {
        if (typeof metadata.toHandle !== "string")
          return invalid("A relay_request posting event must name its target handle");
        const to = requireEventHandle(metadata.toHandle, "toHandle");
        if (!to.ok) return to;
      } else if (metadata.toHandle !== null) {
        return invalid("A non-relay posting event must carry a null toHandle");
      }
      return ok(undefined);
    }
    case "CHANNEL_MESSAGE_ACKED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "seq"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const seq = requireEventSeq(metadata.seq);
      if (!seq.ok) return seq;
      return ok(undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Ports and the repository contract

/** The file-body staging and activation seam shared with the Memo domain (SHR-005, CHN-014). */
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

/** The resolved body state of one message, pinned per storage state (interface section 38.4). */
export type ResolvedMessageBody =
  | { state: "inline"; text: string }
  | { state: "materialized"; text: string; path: string }
  | { state: "pending" };

/** The bounded body readers backed by the shared content store; bodies resolve outside every transaction. */
export interface ChannelBodyPorts {
  /** The full accepted-body nonblank proof (CHN-004): bounded chunks over the exact spool bytes. */
  proveAcceptedNonBlank(accepted: AcceptedChannelBody): Result<void, AppError>;
  /** Resolves one record's complete body against the current Vault binding; a corrupt file is a typed refusal. */
  resolveBody(ref: MessageBodyRef): Result<ResolvedMessageBody, AppError>;
}

/** One page query of the message listing: unhandled by default, `--after` on the sequence key (section 38.4). */
export interface MessagePageQuery {
  handling: "unhandled" | "all";
  afterSeq: number | null;
  fromHandle: string | null;
  kind: MessageKind | null;
}

export interface ChannelCounters {
  total: number;
  unhandled: number;
}

/** The mutation transaction: one `BEGIN IMMEDIATE` through the shared helper, one clock read per transaction. */
export interface ChannelTransaction {
  channelByName(name: string): Result<ChannelRecord | null, AppError>;
  channelById(id: string): Result<ChannelRecord | null, AppError>;
  participants(channelId: string): Result<ParticipantRecord[], AppError>;
  participant(channelId: string, handle: string): Result<ParticipantRecord | null, AppError>;
  messageBySeq(channelId: string, seq: number): Result<MessageRecord | null, AppError>;
  pageMessages(channelId: string, query: MessagePageQuery, limit: number): Result<MessageRecord[], AppError>;
  counters(channelId: string): Result<ChannelCounters, AppError>;
  /** The NULL-safe duplicate lookup of CHN-005: same Channel, sender, kind, `--to`, `--ref` and body digest, unhandled only. */
  findUnhandledDuplicate(
    channelId: string,
    senderHandle: string,
    kind: MessageKind,
    toHandle: string | null,
    ref: string | null,
    bodySha256: string,
  ): Result<MessageRecord | null, AppError>;
  nextSeq(channelId: string): Result<number, AppError>;
  /** Records the plan's immutable content record — and, for a file plan, its activation intent — inside this open transaction. */
  commitContent(plan: ChannelContentPlan, ownerChannelId: string, createdAt: string): Result<void, AppError>;
  insertMessage(row: MessageRecord): Result<void, AppError>;
  insertChannel(row: ChannelRecord): Result<void, AppError>;
  insertParticipant(channelId: string, handle: string, role: ChannelRole, addedAt: string): Result<void, AppError>;
  reRegisterParticipant(channelId: string, handle: string, addedAt: string): Result<void, AppError>;
  removeParticipant(channelId: string, handle: string, removedAt: string): Result<void, AppError>;
  closeChannelRow(id: string, closedAt: string): Result<"changed" | "unchanged", AppError>;
  markHandled(channelId: string, seq: number, handledAt: string, note: string | null): Result<void, AppError>;
  appendEvent(id: string, event: ChannelEventInput, createdAt: string): Result<void, AppError>;
}

/** The read side: one plain `BEGIN`/`COMMIT` with no SQL fence check; the covered-read admission checked the fence once. */
export interface ChannelReader {
  channelByName(name: string): Result<ChannelRecord | null, AppError>;
  channelById(id: string): Result<ChannelRecord | null, AppError>;
  participants(channelId: string): Result<ParticipantRecord[], AppError>;
  participant(channelId: string, handle: string): Result<ParticipantRecord | null, AppError>;
  pageMessages(channelId: string, query: MessagePageQuery, limit: number): Result<MessageRecord[], AppError>;
  counters(channelId: string): Result<ChannelCounters, AppError>;
  listChannels(filter: { state: "open" | "closed" | "all" }): Result<ChannelSummary[], AppError>;
}

export interface ChannelRepository {
  run<T>(work: (transaction: ChannelTransaction) => Result<T, AppError>): Result<T, AppError>;
  read<T>(work: (reader: ChannelReader) => Result<T, AppError>): Result<T, AppError>;
}

/** The content plan a post commits atomically with its rows (SHR-004, SHR-005). */
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

export interface ChannelCommandPorts {
  installationId: string;
  maxBytes: number;
  defaultPageSize: number;
  channels: ChannelRepository;
  bodies: ChannelBodyPorts;
  staging: ChannelStagingPorts;
  clock: Clock;
  ids: IdGenerator;
  /** The SHR-011 large-content disclosure seam and the contained post-commit warning sink: firing never changes the outcome. */
  disclosures?: {
    backupEnabled: boolean;
    thresholdBytes: number;
    largeContent(sizeBytes: number, thresholdBytes: number): void;
    completionWarning?(text: string): void;
  };
}

// ---------------------------------------------------------------------------
// View builders

/** Numeric code-point comparison, the shard's deterministic handle order (section 38.8).
 * UTF-16 unit comparison would sort U+10000 before U+E000; code points do not. */
export function compareHandles(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const first = (a[index] ?? "").codePointAt(0) ?? 0;
    const second = (b[index] ?? "").codePointAt(0) ?? 0;
    if (first < second) return -1;
    if (first > second) return 1;
  }
  return a.length - b.length;
}

export function participantViewOf(participant: ParticipantRecord): ParticipantView {
  return {
    handle: participant.handle,
    role: participant.role,
    addedAt: participant.addedAt,
    removedAt: participant.removedAt,
  };
}

export function channelSummaryOf(channel: ChannelRecord, mainHandle: string): ChannelSummary {
  return {
    id: channel.id,
    name: channel.name,
    title: channel.title,
    state: channel.state,
    main: mainHandle,
    createdAt: channel.createdAt,
    closedAt: channel.closedAt,
  };
}

export function channelViewOf(
  channel: ChannelRecord,
  participants: ParticipantRecord[],
  counters: ChannelCounters,
): Result<ChannelView> {
  const main = participants.find((participant) => participant.role === "main");
  if (main === undefined) {
    return err(
      appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.id} has no main participant`, {
        channelId: channel.id,
      }),
    );
  }
  const roster = [...participants].sort((left, right) => compareHandles(left.handle, right.handle));
  return ok({
    id: channel.id,
    name: channel.name,
    title: channel.title,
    state: channel.state,
    main: main.handle,
    participantCount: roster.length,
    messageCount: counters.total,
    unhandledCount: counters.unhandled,
    participants: roster.map(participantViewOf),
    createdAt: channel.createdAt,
    closedAt: channel.closedAt,
  });
}

/** Pins the body fields per storage state (section 38.4 line 1716): all named fields present, explicit null. */
export function messageViewOf(record: MessageRecord, resolved: ResolvedMessageBody): MessageView {
  return {
    seq: record.seq,
    kind: record.kind,
    from: record.senderHandle,
    to: record.toHandle,
    ref: record.ref,
    body: resolved.state === "pending" ? null : resolved.text,
    bodyPath: resolved.state === "materialized" ? resolved.path : null,
    bodyPending: resolved.state === "pending",
    handled: record.handled,
    handledAt: record.handledAt,
    handleNote: record.handleNote,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Commands (interface section 38.4)

type ChannelRefReader = Pick<ChannelReader, "channelByName" | "channelById">;

/** Resolves a `<channel>` argument: a UUID-shaped reference addresses the id, every other string the name (CHN-002). */
function resolveChannel(reader: ChannelRefReader, reference: string): Result<ChannelRecord | null, AppError> {
  return isChannelUuid(reference) ? reader.channelById(reference) : reader.channelByName(reference);
}

function channelNotFound(reference: string): Result<never> {
  return err(appError("CHN_NOT_FOUND", `Unknown Channel name or UUID: ${reference}`));
}

export interface CreateChannelInput {
  name: unknown;
  title?: unknown;
  main?: unknown;
}

/**
 * Creates one open Channel with its single main participant, idempotently
 * (CHN-003, CHN-008): the same name and main handle returns the existing open
 * Channel with `existing: true` and appends nothing; a closed name refuses
 * with `CHN_CLOSED`; a different main handle on an existing name refuses with
 * `CHN_INVALID_INPUT`.
 */
export function createChannel(
  ports: ChannelCommandPorts,
  input: CreateChannelInput,
): Result<{ channel: ChannelView; existing: boolean }> {
  if (typeof input.name !== "string") return invalid("Channel create requires a name");
  const name = validateChannelName(input.name);
  if (!name.ok) return name;
  const title = normalizeChannelTitle(input.title);
  if (!title.ok) return title;
  const mainHandle = validateChannelHandle(input.main === undefined ? "main" : input.main);
  if (!mainHandle.ok) return mainHandle;
  return ports.channels.run((tx): Result<{ channel: ChannelView; existing: boolean }> => {
    const now = ports.clock.now().toISOString();
    const existing = tx.channelByName(name.value);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      if (existing.value.state === "closed") {
        return err(
          appError("CHN_CLOSED", `The Channel name ${name.value} belongs to a closed Channel; create uses a new name`, {
            channelId: existing.value.id,
          }),
        );
      }
      const roster = tx.participants(existing.value.id);
      if (!roster.ok) return roster;
      const main = roster.value.find((participant) => participant.role === "main");
      if (main === undefined || main.handle !== mainHandle.value) {
        return invalid(
          `The Channel name ${name.value} already exists with main handle ${main === undefined ? "unknown" : main.handle}`,
        );
      }
      const counters = tx.counters(existing.value.id);
      if (!counters.ok) return counters;
      const view = channelViewOf(existing.value, roster.value, counters.value);
      if (!view.ok) return view;
      return ok({ channel: view.value, existing: true });
    }
    const id = ports.ids.next();
    const record: ChannelRecord = {
      id,
      name: name.value,
      title: title.value,
      state: "open",
      createdAt: now,
      closedAt: null,
    };
    const inserted = tx.insertChannel(record);
    if (!inserted.ok) return inserted;
    const registered = tx.insertParticipant(id, mainHandle.value, "main", now);
    if (!registered.ok) return registered;
    const appended = tx.appendEvent(
      ports.ids.next(),
      { type: "CHANNEL_CREATED", channelId: id, actingHandle: mainHandle.value, mainHandle: mainHandle.value },
      now,
    );
    if (!appended.ok) return appended;
    const roster = tx.participants(id);
    if (!roster.ok) return roster;
    const counters = tx.counters(id);
    if (!counters.ok) return counters;
    const view = channelViewOf(record, roster.value, counters.value);
    if (!view.ok) return view;
    return ok({ channel: view.value, existing: false });
  });
}

export interface AddParticipantInput {
  channelRef: unknown;
  handle: unknown;
  role: unknown;
}

/**
 * Registers one worker or judge participant on an open Channel, idempotently
 * per handle and role (CHN-003): a repeat `add` of the same handle and role
 * returns the participant; a different role for a registered handle refuses
 * with `CHN_INVALID_INPUT`; a removed handle is re-registered — clearing
 * `removedAt` and recording a new `addedAt` under its original role — with a
 * fresh `CHANNEL_PARTICIPANT_ADDED` event; a closed Channel refuses with
 * `CHN_CLOSED`.
 */
export function addParticipant(
  ports: ChannelCommandPorts,
  input: AddParticipantInput,
): Result<{ participant: ParticipantView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel add requires a Channel name or UUID");
  const handle = validateChannelHandle(input.handle);
  if (!handle.ok) return handle;
  if (input.role !== "worker" && input.role !== "judge") {
    return invalid("Channel add requires --role worker or judge");
  }
  const role: "worker" | "judge" = input.role;
  return ports.channels.run((tx): Result<{ participant: ParticipantView }> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    if (channel.value.state === "closed") {
      return err(
        appError("CHN_CLOSED", `The Channel ${channel.value.name} is closed; participant registration is frozen`, {
          channelId: channel.value.id,
        }),
      );
    }
    const roster = tx.participants(channel.value.id);
    if (!roster.ok) return roster;
    const acting = roster.value.find((participant) => participant.role === "main");
    if (acting === undefined) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.value.id} has no main participant`, {
          channelId: channel.value.id,
        }),
      );
    }
    const existing = tx.participant(channel.value.id, handle.value);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      if (existing.value.role !== role) {
        return invalid(
          `The handle ${handle.value} is already registered with role ${existing.value.role}; a re-add keeps its original role`,
        );
      }
      if (existing.value.removedAt !== null) {
        const reRegistered = tx.reRegisterParticipant(channel.value.id, handle.value, now);
        if (!reRegistered.ok) return reRegistered;
        const appended = tx.appendEvent(
          ports.ids.next(),
          {
            type: "CHANNEL_PARTICIPANT_ADDED",
            channelId: channel.value.id,
            actingHandle: acting.handle,
            handle: handle.value,
            role: role,
          },
          now,
        );
        if (!appended.ok) return appended;
        return ok({ participant: { handle: handle.value, role: role, addedAt: now, removedAt: null } });
      }
      return ok({ participant: participantViewOf(existing.value) });
    }
    const inserted = tx.insertParticipant(channel.value.id, handle.value, role, now);
    if (!inserted.ok) return inserted;
    const appended = tx.appendEvent(
      ports.ids.next(),
      {
        type: "CHANNEL_PARTICIPANT_ADDED",
        channelId: channel.value.id,
        actingHandle: acting.handle,
        handle: handle.value,
        role: role,
      },
      now,
    );
    if (!appended.ok) return appended;
    return ok({ participant: { handle: handle.value, role: role, addedAt: now, removedAt: null } });
  });
}

export interface RemoveParticipantInput {
  channelRef: unknown;
  handle: unknown;
}

/**
 * Removes one participant idempotently, in any Channel state (CHN-003): a
 * removed handle cannot post until re-added, the main handle is never
 * removable, and a repeat removal returns the participant without an event.
 */
export function removeParticipant(
  ports: ChannelCommandPorts,
  input: RemoveParticipantInput,
): Result<{ participant: ParticipantView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel remove requires a Channel name or UUID");
  const handle = validateChannelHandle(input.handle);
  if (!handle.ok) return handle;
  return ports.channels.run((tx): Result<{ participant: ParticipantView }> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    const existing = tx.participant(channel.value.id, handle.value);
    if (!existing.ok) return existing;
    if (existing.value === null) {
      return err(
        appError("CHN_PARTICIPANT_NOT_FOUND", `Unknown handle on the Channel ${channel.value.name}: ${handle.value}`, {
          channelId: channel.value.id,
          handle: handle.value,
        }),
      );
    }
    if (existing.value.role === "main") {
      return invalid(
        "The main participant cannot be removed; exactly one main participant exists for the Channel's life",
      );
    }
    if (existing.value.removedAt !== null) {
      return ok({ participant: participantViewOf(existing.value) });
    }
    const removed = tx.removeParticipant(channel.value.id, handle.value, now);
    if (!removed.ok) return removed;
    const roster = tx.participants(channel.value.id);
    if (!roster.ok) return roster;
    const acting = roster.value.find((participant) => participant.role === "main");
    if (acting === undefined) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.value.id} has no main participant`, {
          channelId: channel.value.id,
        }),
      );
    }
    const appended = tx.appendEvent(
      ports.ids.next(),
      {
        type: "CHANNEL_PARTICIPANT_REMOVED",
        channelId: channel.value.id,
        actingHandle: acting.handle,
        handle: handle.value,
      },
      now,
    );
    if (!appended.ok) return appended;
    return ok({
      participant: { handle: handle.value, role: existing.value.role, addedAt: existing.value.addedAt, removedAt: now },
    });
  });
}

export interface CloseChannelInput {
  channelRef: unknown;
}

/**
 * Closes one Channel idempotently (CHN-008): a terminal close freezes posting
 * and participant registration while reads and acks remain available; a
 * repeat close returns the Channel without an event.
 */
export function closeChannel(ports: ChannelCommandPorts, input: CloseChannelInput): Result<{ channel: ChannelView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel close requires a Channel name or UUID");
  return ports.channels.run((tx): Result<{ channel: ChannelView }> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    const roster = tx.participants(channel.value.id);
    if (!roster.ok) return roster;
    const acting = roster.value.find((participant) => participant.role === "main");
    if (acting === undefined) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.value.id} has no main participant`, {
          channelId: channel.value.id,
        }),
      );
    }
    const closed = tx.closeChannelRow(channel.value.id, now);
    if (!closed.ok) return closed;
    let record = channel.value;
    if (closed.value === "changed") {
      const appended = tx.appendEvent(
        ports.ids.next(),
        { type: "CHANNEL_CLOSED", channelId: channel.value.id, actingHandle: acting.handle },
        now,
      );
      if (!appended.ok) return appended;
      record = { ...channel.value, state: "closed", closedAt: now };
    }
    const counters = tx.counters(channel.value.id);
    if (!counters.ok) return counters;
    const view = channelViewOf(record, roster.value, counters.value);
    if (!view.ok) return view;
    return ok({ channel: view.value });
  });
}

export interface PostMessageInput {
  channelRef: unknown;
  from: unknown;
  kind: unknown;
  to?: unknown;
  ref?: unknown;
  accepted: AcceptedChannelBody;
}

/** The one SQL transaction's fresh outcome, before its post-commit activation half. */
interface FreshPostOutcome {
  message: MessageRecord;
  plan: ChannelContentPlan;
  channelId: string;
  binding: { vaultPath: string } | null;
}

type PostOutcome = { duplicate: true; message: MessageRecord } | ({ duplicate: false } & FreshPostOutcome);

/**
 * Posts one attributed message (CHN-004, CHN-005, section 38.6). The body is
 * captured once per invocation outside every transaction; a file-routed body
 * stages into the bound Vault's `staging/` tree before the transaction. The
 * one `BEGIN IMMEDIATE` transaction runs, in order: the Channel resolution,
 * the NULL-safe duplicate check — same Channel, sender, kind, `--to`, `--ref`
 * and body digest over the unhandled window — which returns the original with
 * `duplicate: true` before the closed and removed checks so a retry after
 * close still reports the duplicate, the closed refusal, the sender and relay
 * target checks, the staged file's Vault-binding re-read (CHN-014), the
 * content record and message insert with its sequence number, the
 * `CHANNEL_MESSAGE_POSTED` event whose acting handle is the sender, and the
 * in-transaction result-row read. After the commit a file body activates
 * behind the move-lock gate; a paused or failed activation leaves the
 * committed message with `bodyPending: true` and the failure disclosed as a
 * warning (CHN-012).
 */
export function postMessage(
  ports: ChannelCommandPorts,
  input: PostMessageInput,
): Result<{ message: MessageView; duplicate: boolean }> {
  if (typeof input.channelRef !== "string") return invalid("A post requires a Channel name or UUID");
  const from = validateChannelHandle(input.from);
  if (!from.ok) return from;
  if (input.kind !== "report" && input.kind !== "question" && input.kind !== "relay_request") {
    return invalid("A post requires --kind report, question or relay_request");
  }
  const kind: MessageKind = input.kind;
  if (kind === "relay_request") {
    if (input.to === undefined || input.to === null) {
      return invalid("A relay_request post requires --to naming an active registered participant");
    }
  } else if (input.to !== undefined && input.to !== null) {
    return invalid("The --to target belongs to relay_request posts only");
  }
  const toHandle = input.to === undefined || input.to === null ? null : validateChannelHandle(input.to);
  if (toHandle !== null && !toHandle.ok) return toHandle;
  const reference = validateMessageRef(input.ref);
  if (!reference.ok) return reference;

  // The prepared material, computed once before any transaction (the P3 discipline).
  if (input.accepted.kind === "text") {
    const text = checkChannelBodyText(input.accepted.text, ports.maxBytes);
    if (!text.ok) return text;
  } else {
    const nonBlank = ports.bodies.proveAcceptedNonBlank(input.accepted);
    if (!nonBlank.ok) return nonBlank;
  }
  const routesFile = channelBodyRoutesFile(input.accepted);
  let staged: { binding: { vaultPath: string }; stagedPath: string } | null = null;
  if (routesFile) {
    const binding = ports.staging.freshBinding();
    if (!binding.ok) return binding;
    const stage = ports.staging.stageAccepted(input.accepted, binding.value);
    if (!stage.ok) return stage;
    if (stage.value.sizeBytes !== input.accepted.sizeBytes || stage.value.sha256 !== input.accepted.sha256) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "The accepted Channel body changed before staging completed"));
    }
    staged = { binding: binding.value, stagedPath: stage.value.stagedPath };
  }

  const outcome = ports.channels.run((tx): Result<PostOutcome> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);

    // The duplicate check first (CHN-005, section 38.6): before the closed and
    // removed checks, over the unhandled window only.
    const duplicate = tx.findUnhandledDuplicate(
      channel.value.id,
      from.value,
      kind,
      toHandle === null ? null : toHandle.value,
      reference.value,
      input.accepted.sha256,
    );
    if (!duplicate.ok) return duplicate;
    if (duplicate.value !== null) {
      return ok({ duplicate: true, message: duplicate.value });
    }

    if (channel.value.state === "closed") {
      return err(
        appError("CHN_CLOSED", `The Channel ${channel.value.name} is closed; posting is frozen`, {
          channelId: channel.value.id,
        }),
      );
    }
    const sender = tx.participant(channel.value.id, from.value);
    if (!sender.ok) return sender;
    if (sender.value === null || sender.value.removedAt !== null) {
      return err(
        appError(
          "CHN_PARTICIPANT_NOT_FOUND",
          `Unknown or removed sender handle on the Channel ${channel.value.name}: ${from.value}`,
          {
            channelId: channel.value.id,
            handle: from.value,
          },
        ),
      );
    }
    if (sender.value.role === "main") {
      return invalid(
        `The main handle never posts: main-to-agent dispatch stays consumer-owned, and workers and judges post upstream only`,
      );
    }
    if (toHandle?.ok) {
      const target = tx.participant(channel.value.id, toHandle.value);
      if (!target.ok) return target;
      if (target.value === null || target.value.removedAt !== null) {
        return err(
          appError(
            "CHN_PARTICIPANT_NOT_FOUND",
            `Unknown or removed --to handle on the Channel ${channel.value.name}: ${toHandle.value}`,
            { channelId: channel.value.id, handle: toHandle.value },
          ),
        );
      }
    }
    if (staged !== null) {
      // The CHN-014 staged-file binding re-read inside the transaction: a move
      // that switched the destination between staging and commit rolls the
      // post back instead of committing a body staged into a foreign Vault.
      const current = ports.staging.freshBinding();
      if (!current.ok) return current;
      if (current.value.vaultPath !== staged.binding.vaultPath) {
        return err({
          ...appError("CONFIG_CONFLICT", "The Vault path changed while this post was being prepared"),
          recovery: { suggestedCommand: "Reload the configuration and retry the identical post" },
        });
      }
    }

    const seq = tx.nextSeq(channel.value.id);
    if (!seq.ok) return seq;
    const contentId = ports.ids.next();
    const storageKey = buildContentStorageKey({ domain: "channel", ownerId: channel.value.id, contentId });
    if (!storageKey.ok) return storageKey;
    const plan: ChannelContentPlan = routesFile
      ? {
          kind: "file",
          contentId,
          intentId: ports.ids.next(),
          stagedPath: (staged as { stagedPath: string }).stagedPath,
          storageKey: storageKey.value,
          sizeBytes: input.accepted.sizeBytes,
          sha256: input.accepted.sha256,
        }
      : {
          kind: "inline",
          contentId,
          text: input.accepted.kind === "text" ? input.accepted.text : "",
          sizeBytes: input.accepted.sizeBytes,
          sha256: input.accepted.sha256,
        };
    const committed = tx.commitContent(plan, channel.value.id, now);
    if (!committed.ok) return committed;
    const inserted = tx.insertMessage({
      channelId: channel.value.id,
      seq: seq.value,
      senderHandle: from.value,
      kind,
      toHandle: toHandle === null ? null : toHandle.value,
      ref: reference.value,
      content: {
        recordId: contentId,
        representation: routesFile ? "file" : "inline",
        materialized: !routesFile,
        inlineText: routesFile ? null : input.accepted.kind === "text" ? input.accepted.text : null,
        storageKey: routesFile ? storageKey.value : null,
        sizeBytes: input.accepted.sizeBytes,
        sha256: input.accepted.sha256,
      },
      handled: false,
      handledAt: null,
      handleNote: null,
      createdAt: now,
    });
    if (!inserted.ok) return inserted;
    const appended = tx.appendEvent(
      ports.ids.next(),
      {
        type: "CHANNEL_MESSAGE_POSTED",
        channelId: channel.value.id,
        actingHandle: from.value,
        seq: seq.value,
        kind,
        toHandle: toHandle === null ? null : toHandle.value,
      },
      now,
    );
    if (!appended.ok) return appended;
    const readBack = tx.messageBySeq(channel.value.id, seq.value);
    if (!readBack.ok) return readBack;
    if (readBack.value === null) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The posted message ${String(seq.value)} could not be read back inside its transaction`,
        ),
      );
    }
    return ok({
      duplicate: false,
      message: readBack.value,
      plan,
      channelId: channel.value.id,
      binding: staged === null ? null : staged.binding,
    });
  });
  if (!outcome.ok) return outcome;

  if (outcome.value.duplicate) {
    const resolved = ports.bodies.resolveBody(outcome.value.message.content);
    if (!resolved.ok) {
      // Only a genuinely unactivated body is pending without a word; a
      // corrupt or missing materialized body is disclosed, never described
      // as awaiting activation (SHR-005, CHN-012).
      if (resolved.error.code !== "CONTENT_MATERIALIZING") {
        emitContainedWarning(ports, resolved.error.message);
      }
      return ok({ message: messageViewOf(outcome.value.message, { state: "pending" }), duplicate: true });
    }
    return ok({ message: messageViewOf(outcome.value.message, resolved.value), duplicate: true });
  }

  // The post-commit half: disclosure, activation, and the body resolution of
  // the committed view. A failure here never becomes a plain failure of the
  // committed post (CHN-012, SHR-015).
  discloseLargeContent(ports, outcome.value.plan.sizeBytes);
  let pending = false;
  if (outcome.value.plan.kind === "file" && outcome.value.binding !== null) {
    const activation = ports.staging.activateContent(
      {
        intentId: outcome.value.plan.intentId,
        contentId: outcome.value.plan.contentId,
        ownerChannelId: outcome.value.channelId,
        stagedPath: outcome.value.plan.stagedPath,
        storageKey: outcome.value.plan.storageKey,
        sizeBytes: outcome.value.plan.sizeBytes,
        sha256: outcome.value.plan.sha256,
      },
      outcome.value.binding,
    );
    if (!activation.ok) {
      emitContainedWarning(ports, activation.error.message);
      pending = true;
    } else if (activation.value.status === "paused") {
      emitContainedWarning(
        ports,
        "the Channel message committed but its content activation paused behind a held Vault-move lock; the pending intent remains for the next process start",
      );
      pending = true;
    }
  }
  if (pending) {
    return ok({ message: messageViewOf(outcome.value.message, { state: "pending" }), duplicate: false });
  }
  const resolved = ports.bodies.resolveBody(outcome.value.message.content);
  if (!resolved.ok) {
    emitContainedWarning(ports, resolved.error.message);
    return ok({ message: messageViewOf(outcome.value.message, { state: "pending" }), duplicate: false });
  }
  return ok({ message: messageViewOf(outcome.value.message, resolved.value), duplicate: false });
}

/** The SHR-011 large-content Git-history disclosure, fired once after the fresh body's SQL commit. */
function discloseLargeContent(ports: ChannelCommandPorts, sizeBytes: number): void {
  const disclosures = ports.disclosures;
  if (disclosures === undefined || !disclosures.backupEnabled) return;
  if (!(sizeBytes > disclosures.thresholdBytes)) return;
  try {
    disclosures.largeContent(sizeBytes, disclosures.thresholdBytes);
  } catch {
    // A diagnostic sink failure never changes the committed outcome.
  }
}

/** The contained post-commit warning sink (SHR-015): a throwing sink never changes the result. */
function emitContainedWarning(ports: ChannelCommandPorts, text: string): void {
  const sink = ports.disclosures?.completionWarning;
  if (sink === undefined) return;
  try {
    sink(text);
  } catch {
    // A diagnostic sink failure never changes the committed outcome.
  }
}

export interface AckMessagesInput {
  channelRef: unknown;
  seqs: number[];
  note?: unknown;
}

/**
 * Records the User handling decision for the named messages (CHN-006):
 * all-or-nothing — any unknown sequence number refuses with
 * `CHN_MESSAGE_NOT_FOUND` naming them and commits nothing — already-handled
 * messages are reported as `alreadyHandled` without a commit or an event, a
 * repeat ack commits nothing, the first decision is immutable, and the
 * operation is available on a closed Channel.
 */
export function ackMessages(
  ports: ChannelCommandPorts,
  input: AckMessagesInput,
): Result<{ handled: number[]; alreadyHandled: number[]; note: string | null }> {
  if (typeof input.channelRef !== "string") return invalid("An ack requires a Channel name or UUID");
  const note = validateHandleNote(input.note);
  if (!note.ok) return note;
  const requested = [...new Set(input.seqs)].sort((left, right) => left - right);
  if (requested.length === 0) return invalid("An ack requires at least one sequence number");
  for (const seq of requested) {
    if (!Number.isSafeInteger(seq) || seq < 1) return invalid("Sequence numbers are positive integers");
  }
  return ports.channels.run((tx): Result<{ handled: number[]; alreadyHandled: number[]; note: string | null }> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    const roster = tx.participants(channel.value.id);
    if (!roster.ok) return roster;
    const acting = roster.value.find((participant) => participant.role === "main");
    if (acting === undefined) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.value.id} has no main participant`, {
          channelId: channel.value.id,
        }),
      );
    }
    const handled: number[] = [];
    const alreadyHandled: number[] = [];
    const missing: number[] = [];
    for (const seq of requested) {
      const message = tx.messageBySeq(channel.value.id, seq);
      if (!message.ok) return message;
      if (message.value === null) {
        missing.push(seq);
        continue;
      }
      if (message.value.handled) alreadyHandled.push(seq);
      else handled.push(seq);
    }
    if (missing.length > 0) {
      return err(
        appError(
          "CHN_MESSAGE_NOT_FOUND",
          `Unknown sequence number${missing.length === 1 ? "" : "s"} on the Channel ${channel.value.name}: ${missing.map((seq) => String(seq)).join(", ")}`,
          { channelId: channel.value.id, missing },
        ),
      );
    }
    for (const seq of handled) {
      const marked = tx.markHandled(channel.value.id, seq, now, note.value);
      if (!marked.ok) return marked;
      const appended = tx.appendEvent(
        ports.ids.next(),
        { type: "CHANNEL_MESSAGE_ACKED", channelId: channel.value.id, actingHandle: acting.handle, seq },
        now,
      );
      if (!appended.ok) return appended;
    }
    return ok({ handled, alreadyHandled, note: note.value });
  });
}

export interface ListChannelsInput {
  state?: unknown;
}

/** Lists Channels with both identifiers (section 38.4): `--state` defaults to `all`, newest first, no cursor, no total promise. */
export function listChannels(
  ports: ChannelCommandPorts,
  input: ListChannelsInput = {},
): Result<{ items: ChannelSummary[] }> {
  const state = input.state === undefined ? "all" : input.state;
  if (state !== "open" && state !== "closed" && state !== "all") {
    return invalid("Channel list accepts --state open, closed or all");
  }
  const listed = ports.channels.read((reader) => reader.listChannels({ state }));
  if (!listed.ok) return listed;
  return ok({ items: listed.value });
}

export interface ShowChannelInput {
  channelRef: unknown;
}

/** Shows one Channel with its complete participant roster and counts, no message bodies (section 38.4). */
export function showChannel(ports: ChannelCommandPorts, input: ShowChannelInput): Result<{ channel: ChannelView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel show requires a Channel name or UUID");
  return ports.channels.read((reader): Result<{ channel: ChannelView }> => {
    const channel = resolveChannel(reader, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    const roster = reader.participants(channel.value.id);
    if (!roster.ok) return roster;
    const counters = reader.counters(channel.value.id);
    if (!counters.ok) return counters;
    const view = channelViewOf(channel.value, roster.value, counters.value);
    if (!view.ok) return view;
    return ok({ channel: view.value });
  });
}

export interface ListMessagesInput {
  channelRef: unknown;
  all?: boolean;
  after?: unknown;
  from?: unknown;
  kind?: unknown;
  limit?: unknown;
  /**
   * Skip the `--from` roster validation. Reserved for a wait poll whose filter
   * was validated once at invocation (section 38.5); every ordinary listing
   * validates and refuses an unknown or removed handle at once.
   */
  fromAlreadyValidated?: boolean;
}

function boundedLimit(ports: ChannelCommandPorts, value: unknown): Result<number> {
  if (value === undefined || value === null) return ok(ports.defaultPageSize);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid("The --limit option is a positive integer");
  }
  if (value > CHANNEL_LIST_MAX_LIMIT) {
    return invalid(`The --limit option is at most ${String(CHANNEL_LIST_MAX_LIMIT)}`);
  }
  return ok(value);
}

/**
 * The complete-content listing (CHN-006, SHR-012): unhandled messages oldest
 * first by default, all messages with `--all`, full inline bodies with
 * `bodyPath` for materialized file-backed bodies and `bodyPending: true` for
 * an unactivated one, the `--after`, `--from` and `--kind` filters, and no
 * mutation. `--from` is validated against the Channel roster once and an
 * unknown or removed handle fails immediately with
 * `CHN_PARTICIPANT_NOT_FOUND` (section 38.4 line 1712).
 */
export function listChannelMessages(
  ports: ChannelCommandPorts,
  input: ListMessagesInput,
): Result<{ items: MessageView[] }> {
  if (typeof input.channelRef !== "string") return invalid("The messages listing requires a Channel name or UUID");
  const from = input.from === undefined || input.from === null ? null : validateChannelHandle(input.from);
  if (from !== null && !from.ok) return from;
  if (
    input.kind !== undefined &&
    input.kind !== null &&
    input.kind !== "report" &&
    input.kind !== "question" &&
    input.kind !== "relay_request"
  ) {
    return invalid("The --kind filter accepts report, question or relay_request");
  }
  const kind = input.kind === undefined || input.kind === null ? null : (input.kind as MessageKind);
  let afterSeq: number | null = null;
  if (input.after !== undefined && input.after !== null) {
    if (typeof input.after !== "number" || !Number.isSafeInteger(input.after) || input.after < 0) {
      return invalid("The --after option is a non-negative integer sequence number");
    }
    afterSeq = input.after;
  }
  const limit = boundedLimit(ports, input.limit);
  if (!limit.ok) return limit;
  const listed = ports.channels.read((reader): Result<MessageRecord[]> => {
    const channel = resolveChannel(reader, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    if (from?.ok && input.fromAlreadyValidated !== true) {
      const sender = reader.participant(channel.value.id, from.value);
      if (!sender.ok) return sender;
      if (sender.value === null || sender.value.removedAt !== null) {
        return err(
          appError(
            "CHN_PARTICIPANT_NOT_FOUND",
            `Unknown or removed --from handle on the Channel ${channel.value.name}: ${from.value}`,
            {
              channelId: channel.value.id,
              handle: from.value,
            },
          ),
        );
      }
    }
    return reader.pageMessages(
      channel.value.id,
      {
        handling: input.all === true ? "all" : "unhandled",
        afterSeq,
        fromHandle: from === null ? null : from.value,
        kind,
      },
      limit.value,
    );
  });
  if (!listed.ok) return listed;
  const items: MessageView[] = [];
  for (const record of listed.value) {
    const resolved = ports.bodies.resolveBody(record.content);
    if (!resolved.ok) return resolved;
    items.push(messageViewOf(record, resolved.value));
  }
  return ok({ items });
}

export interface ChannelWaitOptions<T> {
  intervalSeconds: number;
  /** The deadline instant, measured by the caller at invocation (section 38.5). */
  deadlineAt: number;
  sleepMs: (ms: number) => void;
  /**
   * One poll: opens storage afresh, validates the Channel and the `--from`
   * handle on the first successful poll, and returns the matching unhandled
   * page. Every poll's storage refusal flows back here so the wait's own
   * retry classification decides it (CHN-007).
   */
  poll: () => Result<T[], AppError>;
}

/**
 * The Channel wait of CHN-007 and section 38.5: pending-inclusive — it returns
 * immediately when any unhandled message matches its filter at invocation —
 * and otherwise polls at the interval until an arrival or the deadline
 * measured from invocation. A retried read-side
 * `STORAGE_INSPECTION_UNAVAILABLE` keeps the wait polling and only a failure
 * persisting at the deadline is reported as that typed error; every other
 * failure ends the wait at once. The wait never mutates anything, and its
 * admission ran once at its start: a poll consults no lock (RDR-001, RDR-005).
 */
export function waitForChannelMessages<T>(options: ChannelWaitOptions<T>): Result<{ timedOut: boolean; items: T[] }> {
  const deadline = options.deadlineAt;
  let tracked: AppError | null = null;
  for (;;) {
    const page = options.poll();
    if (page.ok) {
      if (page.value.length > 0) return ok({ timedOut: false, items: page.value });
      // A later successful poll clears an earlier retried failure: only a
      // failure that persists at the deadline is reported.
      tracked = null;
    } else if (isRetryableWaitListingFailure(page.error)) {
      tracked = page.error;
    } else {
      return err(page.error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (tracked !== null) return err(tracked);
      return ok({ timedOut: true, items: [] });
    }
    options.sleepMs(Math.min(options.intervalSeconds * 1000, remaining));
  }
}

// ---------------------------------------------------------------------------
// The CLI's typed-error refinement of the shared mappings

/**
 * Refines a shared typed error for the Channel surface: the read-side
 * materialization state carries the rebuilt surface's own recovery, and the
 * unclassified integrity and schema refusals name the Channel commands.
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
          "Retain the original Channel command and its input; use a Sorage version that supports this storage layout; never downgrade the database",
      },
    };
  }
  return error;
}
