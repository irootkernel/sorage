import { createHash } from "node:crypto";
import { canonicalJson, compareSnapshotStrings, type SnapshotEvent } from "./backup-snapshot";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { isChannelDomainEventType } from "./events";
import { memoObject } from "./memo-protocol";
import { isMemoTimestamp, isMemoUuid } from "./memos";
import { parseUniqueSnapshotJson, type ContentSnapshotManifest } from "./memo-snapshot";
import { CONTENT_INLINE_MAX_UTF8_BYTES, isUtf8ExactText, utf8ByteLength } from "./content";
import {
  isChannelUuid,
  normalizeAssignmentLabel,
  normalizeChannelTitle,
  validateChannelEventMetadata,
  validateChannelHandle,
  validateContextField,
  validateHandleNote,
  validateNativeProvenance,
} from "./channels";
import {
  memoContentFilePath,
  parseSnapshotBodyContent,
  type ChannelContentFileExport,
  type SnapshotChannelAssignment,
  type SnapshotChannelMessage,
  type SnapshotChannelParticipant,
  type SnapshotChannelShard,
  type SnapshotDataV3,
} from "./content-snapshot";

/**
 * The format-3 Channel snapshot family of TASK-109 (CHN-009, SHR-010, interface
 * sections 38.8 and 38.9, security section 10.1): one closed Channel shard per
 * Channel under `snapshots/channels/<xx>/<id>.json`, file-backed message bodies
 * carried as exact raw bytes under `snapshots/content/channel/<channel-id>/…`
 * and digested in the manifest's `contentDigests`, and the complete retained
 * Channel-domain ledger reconciled against the retained records before import.
 * The manifest stays closed — `memoDigests` and `contentDigests` only — so a
 * Channel shard has no authoritative external digest: its integrity scope is
 * the closed record shape, duplicate-key refusal, fatal UTF-8, canonical
 * bytes, ledger correspondence, and the content files' digested exact bytes.
 */

function corrupt(message: string): Result<never, AppError> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

/** The canonical `snapshots/`-relative shard path of one Channel (section 38.8). */
export function channelSnapshotPath(id: string): Result<string, AppError> {
  if (!isChannelUuid(id)) return corrupt("Channel snapshot UUID is not canonical");
  return ok(`channels/${id.slice(0, 2)}/${id}.json`);
}

/** Recovers the Channel id from a canonical shard path, refusing any other shape. */
export function channelIdFromSnapshotPath(path: string): Result<string, AppError> {
  const match = /^channels\/([0-9a-f]{2})\/([0-9a-f-]{36})\.json$/.exec(path);
  const id = match?.[2];
  if (id === undefined) return corrupt("Channel snapshot path is not canonical");
  const canonical = channelSnapshotPath(id);
  if (!canonical.ok || canonical.value !== path) return corrupt("Channel snapshot path does not match its UUID shard");
  return ok(id);
}

/** The canonical `snapshots/`-relative content-file path of one file-backed Channel message body. */
export function channelContentFilePath(channelId: string, contentId: string): Result<string, AppError> {
  if (!isChannelUuid(channelId) || !isChannelUuid(contentId))
    return corrupt("The Channel content file identity is not canonical");
  return ok(`content/channel/${channelId}/${contentId}`);
}

const SHARD_KEYS = [
  "id",
  "title",
  "state",
  "creatorKind",
  "creatorId",
  "createdAt",
  "closedAt",
  "closedByParticipantId",
  "closedByKind",
  "participants",
  "assignments",
  "messages",
] as const;

const PARTICIPANT_KEYS = [
  "id",
  "role",
  "handle",
  "nativeProvenance",
  "active",
  "registeredAt",
  "deactivatedAt",
] as const;

const ASSIGNMENT_KEYS = ["id", "participantId", "label", "state", "createdAt", "closedAt"] as const;

const MESSAGE_KEYS = [
  "id",
  "senderParticipantId",
  "kind",
  "bodyContent",
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
  "createdAt",
] as const;

function isCreatorKind(value: unknown): value is SnapshotChannelShard["creatorKind"] {
  return value === "registered_project" || value === "unregistered_workspace" || value === "user";
}

function isAuthorityKind(value: unknown): value is "participant" | "user" {
  return value === "participant" || value === "user";
}

function isMessageKind(value: unknown): value is SnapshotChannelMessage["kind"] {
  return value === "report" || value === "question" || value === "relay_request";
}

function strictlySorted(rows: ReadonlyArray<{ key: [string, string] }>): boolean {
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]?.key as [string, string];
    const current = rows[index]?.key as [string, string];
    const byTime = compareSnapshotStrings(previous[0], current[0]);
    if (byTime > 0) return false;
    if (byTime === 0 && compareSnapshotStrings(previous[1], current[1]) >= 0) return false;
  }
  return true;
}

/**
 * Validates one Channel shard's complete closed wire contract (section 38.8):
 * exact key sets, canonical UUIDs, canonical timestamps, the frozen enums, the
 * creator ActorRef coherence, the closed/open and active/inactive field pairs,
 * the retained verbatim text rules without re-normalization, the closed
 * `BodyContent` union with the fixed inline threshold, same-Channel roster
 * references, and the deterministic array orders. The record's retained values
 * — handles, native provenance, contexts, notes, the insertion-frozen late
 * flag, bodies — are validated as retained history, never re-derived from
 * today's runtime eligibility rules.
 */
export function validateSnapshotChannelShard(value: unknown): Result<SnapshotChannelShard, AppError> {
  if (!memoObject(value, SHARD_KEYS)) return corrupt("Format-3 Channel shard fields are invalid");
  const shard = value as Record<string, unknown>;
  if (
    !isChannelUuid(shard.id) ||
    (shard.state !== "open" && shard.state !== "closed") ||
    !isCreatorKind(shard.creatorKind) ||
    !isMemoTimestamp(shard.createdAt)
  )
    return corrupt("Format-3 Channel shard identity or lifecycle fields are invalid");
  if (shard.title !== null) {
    const title = normalizeChannelTitle(shard.title);
    if (!title.ok || title.value !== shard.title)
      return corrupt("A Channel shard title is outside the recorded title rules");
  }
  if (shard.creatorKind === "registered_project") {
    if (!isMemoUuid(shard.creatorId)) return corrupt("A registered Project Channel creator carries a non-UUID id");
  } else if (shard.creatorKind === "unregistered_workspace") {
    if (typeof shard.creatorId !== "string" || shard.creatorId.length === 0)
      return corrupt("An unregistered workspace Channel creator carries no workspace key");
  } else if (shard.creatorId !== null) {
    return corrupt("A user Channel creator carries a creator id");
  }
  if (shard.state === "open") {
    if (shard.closedAt !== null || shard.closedByParticipantId !== null || shard.closedByKind !== null)
      return corrupt("An open Channel shard carries closing provenance");
  } else if (
    !isMemoTimestamp(shard.closedAt) ||
    !isAuthorityKind(shard.closedByKind) ||
    (shard.closedByKind === "participant"
      ? !isChannelUuid(shard.closedByParticipantId)
      : shard.closedByParticipantId !== null)
  )
    return corrupt("A closed Channel shard does not carry its closing provenance");
  if (!Array.isArray(shard.participants) || !Array.isArray(shard.assignments) || !Array.isArray(shard.messages))
    return corrupt("Format-3 Channel shard rosters are not arrays");

  const participantIds = new Set<string>();
  const handles = new Set<string>();
  let main: SnapshotChannelParticipant | null = null;
  for (const raw of shard.participants) {
    if (!memoObject(raw, PARTICIPANT_KEYS)) return corrupt("Format-3 Channel participant fields are invalid");
    const participant = raw as Record<string, unknown>;
    if (
      !isChannelUuid(participant.id) ||
      (participant.role !== "main" && participant.role !== "worker" && participant.role !== "judge") ||
      !isMemoTimestamp(participant.registeredAt)
    )
      return corrupt("Format-3 Channel participant identity fields are invalid");
    const handle = validateChannelHandle(participant.handle);
    if (!handle.ok) return corrupt("A Channel participant handle is outside the recorded handle rules");
    const native = validateNativeProvenance(participant.nativeProvenance);
    if (!native.ok) return corrupt("A Channel participant native provenance is outside the recorded rules");
    if (typeof participant.active !== "boolean") return corrupt("A Channel participant active flag is not boolean");
    if (participant.active) {
      if (participant.deactivatedAt !== null)
        return corrupt("An active Channel participant carries a deactivation time");
    } else if (!isMemoTimestamp(participant.deactivatedAt)) {
      return corrupt("A deactivated Channel participant carries no deactivation time");
    }
    if (participantIds.has(participant.id)) return corrupt("A Channel shard repeats a participant identity");
    if (handles.has(handle.value)) return corrupt("A Channel shard repeats a participant handle");
    participantIds.add(participant.id);
    handles.add(handle.value);
    if (participant.role === "main") {
      if (main !== null) return corrupt("A Channel shard carries more than one main participant");
      main = participant as unknown as SnapshotChannelParticipant;
    }
  }
  if (main === null) return corrupt("A Channel shard carries no main participant");
  // The creation main is registered inside the creation transaction: it is
  // active, carries exactly an empty native provenance list, and its
  // registration time is the Channel's creation time (section 38.8, section
  // 10.1 — creation includes the initial main registration in its one event).
  if (!main.active || main.deactivatedAt !== null)
    return corrupt("The initial main participant of a Channel shard is deactivated");
  if (main.nativeProvenance.length !== 0)
    return corrupt("The initial main participant of a Channel shard carries native provenance");
  if (main.registeredAt !== shard.createdAt)
    return corrupt("The initial main participant of a Channel shard is not registered at creation");
  if (
    !strictlySorted(
      shard.participants.map((participant) => ({
        key: [(participant as SnapshotChannelParticipant).registeredAt, (participant as SnapshotChannelParticipant).id],
      })),
    )
  )
    return corrupt("A Channel shard's participants are not in their deterministic order");

  const assignmentIds = new Set<string>();
  for (const raw of shard.assignments) {
    if (!memoObject(raw, ASSIGNMENT_KEYS)) return corrupt("Format-3 Channel assignment fields are invalid");
    const assignment = raw as Record<string, unknown>;
    if (
      !isChannelUuid(assignment.id) ||
      !isMemoTimestamp(assignment.createdAt) ||
      (assignment.participantId !== null && !isChannelUuid(assignment.participantId)) ||
      (assignment.participantId !== null && !participantIds.has(assignment.participantId))
    )
      return corrupt("Format-3 Channel assignment identity or binding fields are invalid");
    const label = normalizeAssignmentLabel(assignment.label);
    if (!label.ok || label.value !== assignment.label)
      return corrupt("A Channel assignment label is outside the recorded label rules");
    if (assignment.state === "open") {
      if (assignment.closedAt !== null) return corrupt("An open Channel assignment carries a closure time");
    } else if (assignment.state !== "closed" || !isMemoTimestamp(assignment.closedAt)) {
      return corrupt("A Channel assignment does not carry a coherent state");
    }
    if (assignmentIds.has(assignment.id)) return corrupt("A Channel shard repeats an assignment identity");
    assignmentIds.add(assignment.id);
  }
  if (
    !strictlySorted(
      shard.assignments.map((assignment) => ({
        key: [(assignment as SnapshotChannelAssignment).createdAt, (assignment as SnapshotChannelAssignment).id],
      })),
    )
  )
    return corrupt("A Channel shard's assignments are not in their deterministic order");

  const messageIds = new Set<string>();
  for (const raw of shard.messages) {
    if (!memoObject(raw, MESSAGE_KEYS)) return corrupt("Format-3 Channel message fields are invalid");
    const message = raw as Record<string, unknown>;
    if (!isChannelUuid(message.id) || !isMessageKind(message.kind) || !isMemoTimestamp(message.createdAt))
      return corrupt("Format-3 Channel message identity fields are invalid");
    if (!isChannelUuid(message.senderParticipantId) || !participantIds.has(message.senderParticipantId))
      return corrupt("A Channel message names a sender outside its Channel's roster");
    if (message.assignmentId !== null) {
      if (!isChannelUuid(message.assignmentId) || !assignmentIds.has(message.assignmentId))
        return corrupt("A Channel message names an assignment outside its Channel's records");
    }
    if (typeof message.assignmentLate !== "boolean")
      return corrupt("A Channel message carries a non-boolean assignmentLate flag");
    if (message.assignmentLate && message.assignmentId === null)
      return corrupt("A Channel message is marked late against no assignment");
    const relay = message.relayToParticipantId;
    if (message.kind === "relay_request") {
      if (!isChannelUuid(relay) || !participantIds.has(relay))
        return corrupt("A relay request names no target inside its Channel's roster");
    } else if (relay !== null) {
      return corrupt("A Channel message that is not a relay request names a relay target");
    }
    for (const field of [message.contextSession, message.contextNode, message.contextAttempt]) {
      if (field !== null && !validateContextField(field).ok)
        return corrupt("A Channel message context field is outside the recorded context rules");
    }
    if (typeof message.handled !== "boolean") return corrupt("A Channel message handled flag is not boolean");
    if (!message.handled) {
      if (
        message.handledAt !== null ||
        message.handledByParticipantId !== null ||
        message.handledByKind !== null ||
        message.handleNote !== null
      )
        return corrupt("An unhandled Channel message carries handling provenance");
    } else if (
      !isMemoTimestamp(message.handledAt) ||
      !isAuthorityKind(message.handledByKind) ||
      (message.handledByKind === "participant"
        ? !isChannelUuid(message.handledByParticipantId)
        : message.handledByParticipantId !== null)
    )
      return corrupt("A handled Channel message does not carry its handling provenance");
    if (message.handleNote !== null && !validateHandleNote(message.handleNote).ok)
      return corrupt("A Channel handling note is outside the recorded note rules");
    const body = parseSnapshotBodyContent(message.bodyContent);
    if (!body.ok) return body;
    if (body.value.kind === "inline") {
      const text = body.value.text;
      if (!isUtf8ExactText(text)) return corrupt("An inline Channel message body cannot be stored byte-exactly");
      if (text.includes("\0")) return corrupt("An inline Channel message body carries a NUL byte");
      if (text.trim().length === 0) return corrupt("An inline Channel message body is empty after trimming");
      if (utf8ByteLength(text) > CONTENT_INLINE_MAX_UTF8_BYTES)
        return corrupt("An inline Channel message body exceeds the inline routing threshold");
    } else {
      const contentId = body.value.contentPath.split("/")[3] as string;
      const owned = channelContentFilePath(shard.id, contentId);
      if (!owned.ok || owned.value !== body.value.contentPath)
        return corrupt("A Channel message names a content file outside its own Channel's identity path");
    }
    if (messageIds.has(message.id)) return corrupt("A Channel shard repeats a message identity");
    messageIds.add(message.id);
  }
  if (
    !strictlySorted(
      shard.messages.map((message) => ({
        key: [(message as SnapshotChannelMessage).createdAt, (message as SnapshotChannelMessage).id],
      })),
    )
  )
    return corrupt("A Channel shard's messages are not in their deterministic order");
  return ok(value as unknown as SnapshotChannelShard);
}

/**
 * Parses one format-3 Channel shard from its exact raw bytes (section 38.8):
 * the path must be canonical for its id, the bytes decode fatally as UTF-8,
 * the JSON carries no duplicate key, the record satisfies its closed wire
 * contract, and the bytes are exactly the canonical serialization of the
 * record. A manifest never carries an authoritative shard digest, so nothing
 * here claims one; the checks are the closed integrity scope above.
 */
export function parseChannelSnapshotShard(path: string, bytes: Uint8Array): Result<SnapshotChannelShard, AppError> {
  const id = channelIdFromSnapshotPath(path);
  if (!id.ok) return id;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return corrupt("Channel snapshot is not valid UTF-8");
  }
  const parsed = parseUniqueSnapshotJson(text);
  if (!parsed.ok) return parsed;
  const shard = validateSnapshotChannelShard(parsed.value);
  if (!shard.ok) return shard;
  if (shard.value.id !== id.value) return corrupt("Channel snapshot record does not match its path");
  if (canonicalJson(parsed.value) !== text) return corrupt("Channel snapshot bytes are not canonical");
  return shard;
}

/**
 * The whole-bytes semantic proof every Channel message body must pass (CHN-004,
 * SHR-002, the F5 correction): streaming fatal UTF-8 decode, a NUL scan over
 * every chunk, and a nonblank-after-trimming proof over the complete bytes —
 * a body whose only non-whitespace scalars live beyond any bounded head still
 * passes — never a prefix-only guess and never a whole-body string
 * materialization. A valid size and SHA-256 alone never substitute for this
 * proof. The bytes themselves are never rewritten: a byte-order mark, CRLF,
 * and the presence or absence of a final newline stay exact.
 */
export function proveChannelContentBytes(bytes: Uint8Array): Result<void, AppError> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let nonBlank = false;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
      const chunk = bytes.subarray(offset, offset + 65536);
      if (chunk.includes(0)) return corrupt("A Channel message body carries a NUL byte");
      const decoded = decoder.decode(chunk, { stream: true });
      if (!nonBlank && /\S/u.test(decoded)) nonBlank = true;
    }
    const tail = decoder.decode();
    if (!nonBlank && /\S/u.test(tail)) nonBlank = true;
  } catch {
    return corrupt("A Channel message body is not valid UTF-8");
  }
  if (!nonBlank) return corrupt("A Channel message body is empty after trimming");
  return ok(undefined);
}

/**
 * Reconciles the whole Channel family of a format-3 snapshot before any
 * adoption (CHN-009, section 38.8): the manifest's Channel count matches the
 * shard family exactly — zero shards with a positive count and stray shards
 * with a zero count are both refused — identities are globally unique per
 * record table across all shards, every shard satisfies its closed wire
 * contract, every file-backed message names exactly one carried content file
 * of its own Channel whose exact bytes agree with the recorded size, the
 * record digest, and the manifest's `contentDigests` entry and pass the
 * whole-bytes semantic proof, and the union of the Memo and Channel file-body
 * references equals the manifest's exact `contentDigests` key set with no
 * extra, missing, unreferenced, or cross-owner entry. Memo-only behavior and
 * formats 1 and 2 are untouched; this validator composes with, never
 * replaces, the Memo content validation.
 */
export function validateSnapshotChannelContent(
  data: SnapshotDataV3,
  manifest: ContentSnapshotManifest,
): Result<void, AppError> {
  const channels = data.channels ?? [];
  if (channels.length !== manifest.counts.channels)
    return corrupt("The manifest's Channel count disagrees with the shard family");
  const channelIds = new Set<string>();
  const participantIds = new Set<string>();
  const assignmentIds = new Set<string>();
  const messageIds = new Set<string>();
  const messageContentPaths = new Set<string>();
  for (const channel of channels) {
    const shard = validateSnapshotChannelShard(channel);
    if (!shard.ok) return shard;
    if (channelIds.has(channel.id)) return corrupt("The snapshot repeats a Channel identity");
    channelIds.add(channel.id);
    for (const participant of channel.participants) {
      if (participantIds.has(participant.id))
        return corrupt("A participant identity is duplicated across Channel shards");
      participantIds.add(participant.id);
    }
    for (const assignment of channel.assignments) {
      if (assignmentIds.has(assignment.id))
        return corrupt("An assignment identity is duplicated across Channel shards");
      assignmentIds.add(assignment.id);
    }
    for (const message of channel.messages) {
      if (messageIds.has(message.id)) return corrupt("A message identity is duplicated across Channel shards");
      messageIds.add(message.id);
      if ("contentPath" in message.bodyContent) {
        if (messageContentPaths.has(message.bodyContent.contentPath))
          return corrupt("Two Channel messages name one content record");
        messageContentPaths.add(message.bodyContent.contentPath);
      }
    }
  }
  const carriedChannel = new Map<string, ChannelContentFileExport>();
  for (const file of data.channelContentFiles ?? []) {
    const path = channelContentFilePath(file.channelId, file.contentId);
    if (!path.ok) return path;
    if (carriedChannel.has(path.value)) return corrupt("Duplicate Channel content file identity");
    carriedChannel.set(path.value, file);
  }
  const carriedMemo = new Set<string>();
  for (const file of data.memoContentFiles ?? []) {
    const path = memoContentFilePath(file.memoId, file.contentId);
    if (!path.ok) return path;
    if (carriedMemo.has(path.value)) return corrupt("Duplicate Memo content file identity");
    carriedMemo.add(path.value);
  }
  const referencedMemo: string[] = [];
  for (const memo of data.memos ?? []) {
    if (memo.bodyContent?.kind === "file-backed") referencedMemo.push(memo.bodyContent.contentPath);
  }
  const referenced = new Set<string>([...referencedMemo, ...messageContentPaths]);
  const carried = new Set<string>([...carriedChannel.keys(), ...carriedMemo]);
  const mapKeys = Object.keys(manifest.contentDigests);
  if (mapKeys.length !== referenced.size || [...referenced].some((key) => !Object.hasOwn(manifest.contentDigests, key)))
    return corrupt("The snapshot's content digest inventory disagrees with its records");
  if (carried.size !== referenced.size || [...carried].some((key) => !referenced.has(key)))
    return corrupt("The snapshot's carried content files disagree with its records");
  for (const channel of channels) {
    for (const message of channel.messages) {
      if (!("contentPath" in message.bodyContent)) continue;
      const body = message.bodyContent;
      const carriedFile = carriedChannel.get(body.contentPath);
      if (carriedFile === undefined)
        return corrupt("A file-backed Channel message names a content file the snapshot does not carry");
      if (carriedFile.bytes.byteLength !== body.sizeBytes)
        return corrupt("A carried Channel content file disagrees with its recorded size");
      const digest = createHash("sha256").update(carriedFile.bytes).digest("hex");
      if (digest !== body.sha256 || manifest.contentDigests[body.contentPath] !== digest)
        return corrupt("A carried Channel content file disagrees with its recorded digest");
      const proof = proveChannelContentBytes(carriedFile.bytes);
      if (!proof.ok) return proof;
    }
  }
  return ok(undefined);
}

interface ChannelHistoryIndex {
  shard: SnapshotChannelShard;
  mainId: string;
  participants: Map<string, SnapshotChannelParticipant>;
  assignments: Map<string, SnapshotChannelAssignment>;
  messages: Map<string, SnapshotChannelMessage>;
  created: number;
  closed: number;
  registered: Set<string>;
  deactivated: Set<string>;
  assignmentCreated: Set<string>;
  assignmentClosed: Set<string>;
  submitted: Set<string>;
  handled: Set<string>;
}

function channelEventActorOk(kind: unknown, id: unknown): boolean {
  if (kind === "registered_project") return isMemoUuid(id);
  if (kind === "unregistered_workspace") return typeof id === "string" && id.length > 0;
  if (kind === "user") return id === null;
  return false;
}

/**
 * Reconciles the complete retained Channel-domain ledger against the retained
 * Channel shards before import (security section 10.1, interface section 38.9):
 * every Channel event carries null Handoff and Memo associations, one of the
 * three creator actor kinds with a coherent ActorRef id, the catalog row
 * version, and its closed metadata; every event resolves to a retained shard —
 * a ledger-only Channel event without its record is a corrupt supported-family
 * record, never an unknown or unsupported one — and creation, closure,
 * participant registration and deactivation, assignment creation and closure,
 * and message submission and first handling correspond exactly, one event per
 * retained record, with the original ids, actors, and links preserved. The
 * correspondence checks decision and version equality and the
 * same-transaction timestamp equality the runtime guarantees; it never treats
 * wall-clock ordering as authentication, never recomputes the insertion-frozen
 * late flag, and never substitutes today's runtime eligibility for historical
 * validity. Common physical-content events stay outside this reconciliation:
 * their owner ids are historical attribution and never require a live owner.
 */
export function validateSnapshotChannelHistory(
  events: readonly SnapshotEvent[],
  channels: readonly SnapshotChannelShard[],
): Result<void, AppError> {
  const index = new Map<string, ChannelHistoryIndex>();
  for (const shard of channels) {
    const main = shard.participants.find((participant) => participant.role === "main");
    if (main === undefined) return corrupt("A Channel shard carries no main participant for its ledger");
    index.set(shard.id, {
      shard,
      mainId: main.id,
      participants: new Map(shard.participants.map((participant) => [participant.id, participant])),
      assignments: new Map(shard.assignments.map((assignment) => [assignment.id, assignment])),
      messages: new Map(shard.messages.map((message) => [message.id, message])),
      created: 0,
      closed: 0,
      registered: new Set<string>(),
      deactivated: new Set<string>(),
      assignmentCreated: new Set<string>(),
      assignmentClosed: new Set<string>(),
      submitted: new Set<string>(),
      handled: new Set<string>(),
    });
  }
  for (const event of events) {
    if (typeof event.eventType !== "string" || !isChannelDomainEventType(event.eventType)) continue;
    if (event.handoffId !== null) return corrupt("A Channel domain event carries a Handoff association");
    if (event.memoId !== null && event.memoId !== undefined)
      return corrupt("A Channel domain event carries a Memo association");
    if (!channelEventActorOk(event.actorKind, event.actorId))
      return corrupt("A Channel domain event carries an invalid creator actor");
    const expectedRowVersion =
      event.eventType === "CHANNEL_MESSAGE_SUBMITTED" ? 1 : event.eventType === "CHANNEL_MESSAGE_HANDLED" ? 2 : null;
    if (event.rowVersion !== expectedRowVersion) return corrupt("A Channel domain event carries the wrong row version");
    const metadata = validateChannelEventMetadata(event.eventType, event.metadata);
    if (!metadata.ok) return metadata;
    const row = event.metadata as Record<string, unknown>;
    const channelId = row.channelId as string;
    const entry = index.get(channelId);
    if (entry === undefined) return corrupt("A Channel domain event names a Channel the snapshot does not retain");
    const acting = (row.actingParticipantId as string | null | undefined) ?? null;
    if (acting !== null && acting !== entry.mainId)
      return corrupt("A Channel domain event's acting participant is not the Channel's main");
    switch (event.eventType) {
      case "CHANNEL_CREATED": {
        entry.created += 1;
        if (entry.created > 1) return corrupt("A Channel's creation is recorded more than once");
        if (row.mainParticipantId !== entry.mainId)
          return corrupt("A Channel's creation event names a main outside its roster");
        if (event.actorKind !== entry.shard.creatorKind || event.actorId !== entry.shard.creatorId)
          return corrupt("A Channel's creation event actor disagrees with its creator provenance");
        if (event.createdAt !== entry.shard.createdAt)
          return corrupt("A Channel's creation event disagrees with its creation time");
        break;
      }
      case "CHANNEL_CLOSED": {
        entry.closed += 1;
        if (entry.shard.state !== "closed") return corrupt("A Channel's closure is recorded while the Channel is open");
        if (acting !== entry.shard.closedByParticipantId)
          return corrupt("A Channel's closure event disagrees with its closing provenance");
        if ((acting !== null) !== (entry.shard.closedByKind === "participant"))
          return corrupt("A Channel's closure event authority is incoherent");
        if (event.createdAt !== entry.shard.closedAt)
          return corrupt("A Channel's closure event disagrees with its closure time");
        break;
      }
      case "CHANNEL_PARTICIPANT_REGISTERED": {
        const participantId = row.participantId as string;
        const participant = entry.participants.get(participantId);
        if (participant === undefined) return corrupt("A registration event names a participant outside its Channel");
        if (participant.role === "main")
          return corrupt("The initial main participant carries a separate registration event");
        if (row.role !== participant.role) return corrupt("A registration event disagrees with the participant's role");
        if (event.createdAt !== participant.registeredAt)
          return corrupt("A registration event disagrees with the participant's registration time");
        if (entry.registered.has(participantId))
          return corrupt("A participant's registration is recorded more than once");
        entry.registered.add(participantId);
        break;
      }
      case "CHANNEL_PARTICIPANT_DEACTIVATED": {
        const participantId = row.participantId as string;
        const participant = entry.participants.get(participantId);
        if (participant === undefined) return corrupt("A deactivation event names a participant outside its Channel");
        if (participant.role === "main") return corrupt("A main participant is deactivated by a Channel event");
        if (participant.active) return corrupt("A deactivation event names an active participant");
        if (event.createdAt !== participant.deactivatedAt)
          return corrupt("A deactivation event disagrees with the participant's deactivation time");
        if (entry.deactivated.has(participantId))
          return corrupt("A participant's deactivation is recorded more than once");
        entry.deactivated.add(participantId);
        break;
      }
      case "CHANNEL_ASSIGNMENT_CREATED": {
        const assignmentId = row.assignmentId as string;
        const assignment = entry.assignments.get(assignmentId);
        if (assignment === undefined) return corrupt("An assignment event names an assignment outside its Channel");
        if (row.participantId !== assignment.participantId)
          return corrupt("An assignment creation event disagrees with the assignment's bound participant");
        if (event.createdAt !== assignment.createdAt)
          return corrupt("An assignment creation event disagrees with the assignment's creation time");
        if (entry.assignmentCreated.has(assignmentId))
          return corrupt("An assignment's creation is recorded more than once");
        entry.assignmentCreated.add(assignmentId);
        break;
      }
      case "CHANNEL_ASSIGNMENT_CLOSED": {
        const assignmentId = row.assignmentId as string;
        const assignment = entry.assignments.get(assignmentId);
        if (assignment === undefined) return corrupt("An assignment event names an assignment outside its Channel");
        if (assignment.state !== "closed") return corrupt("An assignment closure is recorded while it is open");
        if (event.createdAt !== assignment.closedAt)
          return corrupt("An assignment closure event disagrees with the assignment's closure time");
        if (entry.assignmentClosed.has(assignmentId))
          return corrupt("An assignment's closure is recorded more than once");
        entry.assignmentClosed.add(assignmentId);
        break;
      }
      case "CHANNEL_MESSAGE_SUBMITTED": {
        const messageId = row.messageId as string;
        const message = entry.messages.get(messageId);
        if (message === undefined) return corrupt("A submission event names a message outside its Channel");
        if (
          row.participantId !== message.senderParticipantId ||
          row.kind !== message.kind ||
          row.assignmentId !== message.assignmentId ||
          row.assignmentLate !== message.assignmentLate ||
          row.relayToParticipantId !== message.relayToParticipantId
        )
          return corrupt("A submission event disagrees with its retained message");
        if (event.createdAt !== message.createdAt)
          return corrupt("A submission event disagrees with the message's creation time");
        if (entry.submitted.has(messageId)) return corrupt("A message's submission is recorded more than once");
        entry.submitted.add(messageId);
        break;
      }
      case "CHANNEL_MESSAGE_HANDLED": {
        const messageId = row.messageId as string;
        const message = entry.messages.get(messageId);
        if (message === undefined) return corrupt("A handling event names a message outside its Channel");
        if (!message.handled) return corrupt("A handling event is recorded for an unhandled message");
        if (acting !== message.handledByParticipantId)
          return corrupt("A handling event disagrees with the message's handling provenance");
        if ((acting !== null) !== (message.handledByKind === "participant"))
          return corrupt("A handling event's authority is incoherent");
        if (event.createdAt !== message.handledAt)
          return corrupt("A handling event disagrees with the message's handling time");
        if (entry.handled.has(messageId)) return corrupt("A message's handling is recorded more than once");
        entry.handled.add(messageId);
        break;
      }
    }
  }
  for (const entry of index.values()) {
    const { shard } = entry;
    if (entry.created !== 1) return corrupt("A Channel's creation event is missing");
    if (entry.closed !== (shard.state === "closed" ? 1 : 0))
      return corrupt("A Channel's closure event does not match its state");
    const nonMain = shard.participants.filter((participant) => participant.role !== "main");
    if (entry.registered.size !== nonMain.length)
      return corrupt("A Channel's registration events do not cover its non-main roster");
    const inactive = nonMain.filter((participant) => !participant.active);
    if (entry.deactivated.size !== inactive.length)
      return corrupt("A Channel's deactivation events do not cover its inactive roster");
    if (entry.assignmentCreated.size !== shard.assignments.length)
      return corrupt("A Channel's assignment creation events do not cover its assignments");
    const closedAssignments = shard.assignments.filter((assignment) => assignment.state === "closed");
    if (entry.assignmentClosed.size !== closedAssignments.length)
      return corrupt("A Channel's assignment closure events do not cover its closed assignments");
    if (entry.submitted.size !== shard.messages.length)
      return corrupt("A Channel's submission events do not cover its messages");
    const handled = shard.messages.filter((message) => message.handled);
    if (entry.handled.size !== handled.length)
      return corrupt("A Channel's handling events do not cover its handled messages");
  }
  return ok(undefined);
}
