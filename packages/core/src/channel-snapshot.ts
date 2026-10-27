import { createHash } from "node:crypto";
import { canonicalJson, type SnapshotEvent } from "./backup-snapshot";
import {
  compareHandles,
  isChannelUuid,
  normalizeChannelTitle,
  validateChannelEventMetadata,
  validateChannelHandle,
  validateChannelName,
  validateHandleNote,
  validateMessageRef,
} from "./channels";
import { CONTENT_INLINE_MAX_UTF8_BYTES, isUtf8ExactText, utf8ByteLength } from "./content";
import {
  type ChannelContentFileExport,
  memoContentFilePath,
  parseSnapshotBodyContent,
  type SnapshotChannelMessage,
  type SnapshotChannelParticipant,
  type SnapshotChannelShard,
  type SnapshotDataV3,
} from "./content-snapshot";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { isChannelDomainEventType } from "./events";
import { memoObject } from "./memo-protocol";
import { type ContentSnapshotManifest, parseUniqueSnapshotJson } from "./memo-snapshot";
import { isMemoTimestamp } from "./memos";

/**
 * The format-3 Channel snapshot family rebuilt under ADR-0034 (CHN-009,
 * SHR-010, interface sections 38.8 and 38.9, security section 10.1): one
 * closed Channel shard per Channel under `snapshots/channels/<xx>/<id>.json`
 * carrying the rebuilt record shape — the name, the main handle, participants
 * keyed by handle with reversible removal, and messages keyed by per-Channel
 * sequence number — with file-backed message bodies carried as exact raw
 * bytes under `snapshots/content/channel/<channel-id>/…` and digested in the
 * manifest's `contentDigests`. The retained ledger reconciles against the
 * shards referentially and order-independently: the six User-actor event
 * types, the acting handle of every event, exactly one posting event per
 * message and one handling event per handled message, and the add/remove
 * count relation of every non-main handle, with no assumption that timestamp
 * or UUID order records mutation order. A development snapshot carrying an
 * old Channel shard key set or an old Channel event name fails closed
 * validation with `VAULT_INTEGRITY_ERROR` rather than being converted.
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
  "name",
  "title",
  "state",
  "main",
  "createdAt",
  "closedAt",
  "participants",
  "messages",
] as const;

const PARTICIPANT_KEYS = ["handle", "role", "addedAt", "removedAt"] as const;

const MESSAGE_KEYS = [
  "seq",
  "senderHandle",
  "kind",
  "toHandle",
  "ref",
  "bodyContent",
  "handled",
  "handledAt",
  "handleNote",
  "createdAt",
] as const;

function isMessageKind(value: unknown): value is SnapshotChannelMessage["kind"] {
  return value === "report" || value === "question" || value === "relay_request";
}

/**
 * Validates one rebuilt Channel shard's complete closed wire contract (section
 * 38.8 line 1806): exact key sets, canonical UUID identity, the name and title
 * rules, the closed/open field pairs, the one-main roster with reversible
 * removal, the relay-target and handled-state null rules, the retained
 * verbatim text rules without re-normalization, the closed `BodyContent`
 * union with the fixed inline threshold, same-Channel roster references, and
 * the deterministic array orders — participants by handle under exact
 * code-point comparison, messages by `seq` ascending.
 */
export function validateSnapshotChannelShard(value: unknown): Result<SnapshotChannelShard, AppError> {
  if (!memoObject(value, SHARD_KEYS)) return corrupt("Format-3 Channel shard fields are invalid");
  const shard = value as Record<string, unknown>;
  if (
    !isChannelUuid(shard.id) ||
    (shard.state !== "open" && shard.state !== "closed") ||
    !isMemoTimestamp(shard.createdAt)
  )
    return corrupt("Format-3 Channel shard identity or lifecycle fields are invalid");
  const name = validateChannelName(shard.name);
  if (!name.ok || name.value !== shard.name) return corrupt("A Channel shard name is outside the recorded name rules");
  if (shard.title !== null) {
    const title = normalizeChannelTitle(shard.title);
    if (!title.ok || title.value !== shard.title)
      return corrupt("A Channel shard title is outside the recorded title rules");
  }
  if (typeof shard.main !== "string") return corrupt("A Channel shard carries no main handle");
  if (shard.state === "open") {
    if (shard.closedAt !== null) return corrupt("An open Channel shard carries a closure time");
  } else if (!isMemoTimestamp(shard.closedAt)) {
    return corrupt("A closed Channel shard does not carry its closure time");
  }
  if (!Array.isArray(shard.participants) || !Array.isArray(shard.messages))
    return corrupt("Format-3 Channel shard rosters are not arrays");

  const handles = new Set<string>();
  let main: SnapshotChannelParticipant | null = null;
  for (const raw of shard.participants) {
    if (!memoObject(raw, PARTICIPANT_KEYS)) return corrupt("Format-3 Channel participant fields are invalid");
    const participant = raw as Record<string, unknown>;
    const handle = validateChannelHandle(participant.handle);
    if (!handle.ok) return corrupt("A Channel participant handle is outside the recorded handle rules");
    if (
      (participant.role !== "main" && participant.role !== "worker" && participant.role !== "judge") ||
      !isMemoTimestamp(participant.addedAt)
    )
      return corrupt("Format-3 Channel participant identity fields are invalid");
    if (participant.removedAt === null) {
      // registered: nothing more to carry
    } else if (!isMemoTimestamp(participant.removedAt)) {
      return corrupt("A removed Channel participant carries a malformed removal time");
    }
    if (handles.has(handle.value)) return corrupt("A Channel shard repeats a participant handle");
    handles.add(handle.value);
    if (participant.role === "main") {
      if (main !== null) return corrupt("A Channel shard carries more than one main participant");
      if (participant.removedAt !== null) return corrupt("A Channel shard's main participant is removed");
      main = participant as unknown as SnapshotChannelParticipant;
    }
  }
  if (main === null) return corrupt("A Channel shard carries no main participant");
  if (main.handle !== shard.main) return corrupt("A Channel shard's main field disagrees with its main participant");
  // The creation registers the main participant inside the creation
  // transaction: its `addedAt` is the Channel's creation time (section 38.8;
  // one clock read per transaction).
  if (main.addedAt !== shard.createdAt)
    return corrupt("The initial main participant of a Channel shard is not registered at creation");
  const roster = shard.participants as SnapshotChannelParticipant[];
  const ordered = roster.map((participant) => participant.handle);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] ?? "";
    const current = ordered[index] ?? "";
    if (compareHandles(previous, current) >= 0)
      return corrupt("A Channel shard's participants are not in their deterministic order");
  }

  const seqs = new Set<number>();
  let previousSeq = 0;
  for (const raw of shard.messages) {
    if (!memoObject(raw, MESSAGE_KEYS)) return corrupt("Format-3 Channel message fields are invalid");
    const message = raw as Record<string, unknown>;
    if (
      typeof message.seq !== "number" ||
      !Number.isSafeInteger(message.seq) ||
      message.seq < 1 ||
      !isMessageKind(message.kind) ||
      !isMemoTimestamp(message.createdAt)
    )
      return corrupt("Format-3 Channel message identity fields are invalid");
    if (message.seq <= previousSeq) return corrupt("A Channel shard's messages are not in their deterministic order");
    previousSeq = message.seq;
    if (typeof message.senderHandle !== "string" || !handles.has(message.senderHandle))
      return corrupt("A Channel message names a sender outside its Channel's roster");
    if (message.senderHandle === shard.main)
      return corrupt("A Channel message's sender is the main handle, which never posts");
    if (message.kind === "relay_request") {
      if (typeof message.toHandle !== "string" || !handles.has(message.toHandle))
        return corrupt("A relay request names no target inside its Channel's roster");
    } else if (message.toHandle !== null) {
      return corrupt("A Channel message that is not a relay request names a target handle");
    }
    if (message.ref !== null) {
      const reference = validateMessageRef(message.ref);
      if (!reference.ok || reference.value !== message.ref)
        return corrupt("A Channel message reference is outside the recorded reference rules");
    }
    if (typeof message.handled !== "boolean") return corrupt("Format-3 Channel message handled flag is not boolean");
    if (!message.handled) {
      if (message.handledAt !== null || message.handleNote !== null)
        return corrupt("An unhandled Channel message carries handling state");
    } else if (!isMemoTimestamp(message.handledAt)) {
      return corrupt("A handled Channel message carries no handling time");
    }
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
      const owned = channelContentFilePath(shard.id as string, contentId);
      if (!owned.ok || owned.value !== body.value.contentPath)
        return corrupt("A Channel message names a content file outside its own Channel's identity path");
    }
    if (seqs.has(message.seq)) return corrupt("A Channel shard repeats a message sequence number");
    seqs.add(message.seq);
  }
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
  manifest: Pick<ContentSnapshotManifest, "counts" | "contentDigests">,
): Result<void, AppError> {
  const channels = data.channels ?? [];
  if (channels.length !== manifest.counts.channels)
    return corrupt("The manifest's Channel count disagrees with the shard family");
  const channelIds = new Set<string>();
  // Names are globally unique in the live model (`name TEXT NOT NULL UNIQUE`
  // in channels-v2, CHN-002); a snapshot repeating one across shards must
  // fail closed before import, never as a restore-time UNIQUE violation.
  const channelNames = new Set<string>();
  const messageContentPaths = new Set<string>();
  for (const channel of channels) {
    const shard = validateSnapshotChannelShard(channel);
    if (!shard.ok) return shard;
    if (channelIds.has(channel.id)) return corrupt("The snapshot repeats a Channel identity");
    channelIds.add(channel.id);
    if (channelNames.has(channel.name)) return corrupt("The snapshot repeats a Channel name");
    channelNames.add(channel.name);
    for (const message of channel.messages) {
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
  mainHandle: string;
  participants: Map<string, SnapshotChannelParticipant>;
  messages: Map<number, SnapshotChannelMessage>;
  created: number;
  closed: number;
  added: Map<string, number>;
  removed: Map<string, number>;
  posted: Set<number>;
  acked: Set<number>;
}

/**
 * Reconciles the retained Channel-domain ledger against the retained Channel
 * shards before import (security section 10.1, interface section 38.9 line
 * 1818): every `CHANNEL_*` event carries null Handoff and Memo associations,
 * the User actor with a null id and a null row version, and its closed
 * metadata with the acting handle — the sender for a posting, the Channel's
 * main handle otherwise; every event resolves to a retained shard; and the
 * retained state is covered exactly — creation once, closure exactly when
 * closed, at least one `ADDED` per retained non-main participant with the
 * count relation `#ADDED = #REMOVED + (removedAt === null ? 1 : 0)`, exactly
 * one posting event per message with matching sender, kind and target, and
 * exactly one handling event per handled message and none for an unhandled
 * one. The checks are referential and count-based: neither timestamp order
 * nor UUID order records mutation order, and the four same-transaction
 * timestamp equalities hold because one clock read stamps a transaction's
 * rows and its event alike. Common physical-content events stay outside this
 * reconciliation: their owner ids are historical attribution and never
 * require a live owner.
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
      mainHandle: main.handle,
      participants: new Map(shard.participants.map((participant) => [participant.handle, participant])),
      messages: new Map(shard.messages.map((message) => [message.seq, message])),
      created: 0,
      closed: 0,
      added: new Map(),
      removed: new Map(),
      posted: new Set(),
      acked: new Set(),
    });
  }
  for (const event of events) {
    if (typeof event.eventType !== "string" || !isChannelDomainEventType(event.eventType)) continue;
    if (event.handoffId !== null) return corrupt("A Channel domain event carries a Handoff association");
    if (event.memoId !== null && event.memoId !== undefined)
      return corrupt("A Channel domain event carries a Memo association");
    if (event.actorKind !== "user" || event.actorId !== null)
      return corrupt("A Channel domain event's actor is not the User");
    if (event.rowVersion !== null && event.rowVersion !== undefined)
      return corrupt("A Channel domain event carries a row version");
    const metadata = validateChannelEventMetadata(event.eventType, event.metadata);
    if (!metadata.ok) return corrupt("A Channel domain event carries invalid closed metadata");
    const row = event.metadata as Record<string, unknown>;
    const channelId = row.channelId as string;
    const entry = index.get(channelId);
    if (entry === undefined) return corrupt("A Channel domain event names a Channel the snapshot does not retain");
    const acting = row.actingHandle as string;
    if (!entry.participants.has(acting)) return corrupt("A Channel domain event's acting handle is outside its roster");
    const count = (map: Map<string, number>, handle: string): number => {
      const next = (map.get(handle) ?? 0) + 1;
      map.set(handle, next);
      return next;
    };
    switch (event.eventType) {
      case "CHANNEL_CREATED": {
        entry.created += 1;
        if (entry.created > 1) return corrupt("A Channel's creation is recorded more than once");
        if (row.mainHandle !== entry.mainHandle)
          return corrupt("A Channel's creation event names a main outside its roster");
        if (acting !== entry.mainHandle)
          return corrupt("A Channel's creation event acting handle is not its main handle");
        if (event.createdAt !== entry.shard.createdAt)
          return corrupt("A Channel's creation event disagrees with its creation time");
        break;
      }
      case "CHANNEL_CLOSED": {
        entry.closed += 1;
        if (entry.shard.state !== "closed") return corrupt("A Channel's closure event is recorded while it is open");
        if (acting !== entry.mainHandle)
          return corrupt("A Channel's closure event acting handle is not its main handle");
        if (event.createdAt !== entry.shard.closedAt)
          return corrupt("A Channel's closure event disagrees with its closure time");
        break;
      }
      case "CHANNEL_PARTICIPANT_ADDED": {
        const handle = row.handle as string;
        // The User acts as the Channel's main participant on every
        // User-performed operation: a worker acting handle is corrupt even
        // when the worker is registered (security section 10.1).
        if (acting !== entry.mainHandle)
          return corrupt("An addition event's acting handle is not the Channel's main handle");
        const participant = entry.participants.get(handle);
        if (participant === undefined) return corrupt("An addition event names a handle outside its Channel");
        if (participant.role === "main") return corrupt("An addition event names the main handle");
        if (row.role !== participant.role) return corrupt("An addition event disagrees with the participant's role");
        count(entry.added, handle);
        break;
      }
      case "CHANNEL_PARTICIPANT_REMOVED": {
        const handle = row.handle as string;
        if (acting !== entry.mainHandle)
          return corrupt("A removal event's acting handle is not the Channel's main handle");
        const participant = entry.participants.get(handle);
        if (participant === undefined) return corrupt("A removal event names a handle outside its Channel");
        if (participant.role === "main") return corrupt("A removal event names the main handle");
        count(entry.removed, handle);
        break;
      }
      case "CHANNEL_MESSAGE_POSTED": {
        const seq = row.seq as number;
        const message = entry.messages.get(seq);
        if (message === undefined) return corrupt("A posting event names a sequence number outside its Channel");
        if (entry.posted.has(seq)) return corrupt("A message's posting is recorded more than once");
        if (acting !== message.senderHandle) return corrupt("A posting event's acting handle is not its sender");
        if (row.kind !== message.kind || row.toHandle !== message.toHandle)
          return corrupt("A posting event disagrees with its retained message");
        if (event.createdAt !== message.createdAt)
          return corrupt("A posting event disagrees with the message's creation time");
        entry.posted.add(seq);
        break;
      }
      case "CHANNEL_MESSAGE_ACKED": {
        const seq = row.seq as number;
        const message = entry.messages.get(seq);
        if (message === undefined) return corrupt("A handling event names a sequence number outside its Channel");
        if (!message.handled) return corrupt("A handling event is recorded for an unhandled message");
        if (entry.acked.has(seq)) return corrupt("A message's handling is recorded more than once");
        if (acting !== entry.mainHandle)
          return corrupt("A handling event's acting handle is not the Channel's main handle");
        if (event.createdAt !== message.handledAt)
          return corrupt("A handling event disagrees with the message's handling time");
        entry.acked.add(seq);
        break;
      }
    }
  }
  for (const entry of index.values()) {
    const { shard } = entry;
    if (entry.created !== 1) return corrupt("A Channel's creation event is missing");
    if (entry.closed !== (shard.state === "closed" ? 1 : 0))
      return corrupt("A Channel's closure event does not match its state");
    for (const participant of shard.participants) {
      if (participant.role === "main") continue;
      const added = entry.added.get(participant.handle) ?? 0;
      const removed = entry.removed.get(participant.handle) ?? 0;
      if (added < 1) return corrupt("A retained participant has no addition event");
      if (added !== removed + (participant.removedAt === null ? 1 : 0))
        return corrupt("A retained participant's addition and removal events disagree with its registration state");
    }
    if (entry.posted.size !== shard.messages.length)
      return corrupt("A Channel's posting events do not cover its messages");
    for (const message of shard.messages) {
      if (message.handled && !entry.acked.has(message.seq)) return corrupt("A handled message has no handling event");
    }
  }
  return ok(undefined);
}
