import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonLine,
  compareSnapshotStrings,
  handoffShardPath,
  redactEventMetadata,
  snapshotCounts,
  snapshotFiles,
  type SnapshotData,
  type SnapshotFile,
  type SnapshotHandoff,
} from "./backup-snapshot";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { isCommonContentEventType, snapshotEventTypeAllowed } from "./events";
import {
  CONTENT_INLINE_MAX_UTF8_BYTES,
  isUtf8ExactText,
  sha256OfText,
  utf8ByteLength,
  validateCommonContentEventMetadata,
} from "./content";
import { memoObject, parseMemoDetail, parseMemoMetadata } from "./memo-protocol";
import {
  isCanonicalContentFilePath,
  memoIdFromSnapshotPath,
  memoSnapshotPath,
  parseUniqueSnapshotJson,
  type ContentSnapshotManifest,
  type MemoSnapshotShard,
} from "./memo-snapshot";
import type { Memo } from "./memos";
import { isMemoTimestamp, isMemoUuid } from "./memos";
import { isValidStorageKeySegment } from "./artifacts";
import { REVIEW_STATES } from "./handoffs";
import {
  channelContentFilePath,
  channelSnapshotPath,
  proveChannelContentBytes,
  validateSnapshotChannelShard,
} from "./channel-snapshot";

/**
 * The format-3 snapshot generation of M9 (SHR-010, interface section 38.8): one
 * coherent global snapshot whose single manifest counts the Channel family and
 * digests the shared-content files this build exports. The writer keeps the
 * determinism, purity, redaction, and canonical JSON conventions of formats 1
 * and 2; the reader accepts exactly the format-3 representations this schema
 * can faithfully import and refuses a valid later-generation structure before
 * import with `VAULT_SCHEMA_UNSUPPORTED` rather than as corruption, partial
 * restore, fallback, or silent omission.
 */

function corrupt(message: string): Result<never, AppError> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

/** The closed `BodyContent` union of section 38.8: exactly `inline`, or exactly the file-backed triple. */
export type SnapshotBodyContent = { inline: string } | { contentPath: string; sizeBytes: number; sha256: string };

export type ParsedBodyContent =
  | { kind: "inline"; text: string }
  | { kind: "file-backed"; contentPath: string; sizeBytes: number; sha256: string };

/**
 * Parses one `BodyContent` value: the inline form carries exactly the key
 * `inline` with the exact body text, the file-backed form carries exactly
 * `contentPath`, `sizeBytes`, and `sha256`, and any other shape is an integrity
 * failure. Which of the two valid forms this build may import is the caller's
 * classification; parsing only establishes that the shape is one of them.
 */
export function parseSnapshotBodyContent(value: unknown): Result<ParsedBodyContent, AppError> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return corrupt("A bodyContent value is not an object");
  const keys = Object.keys(value).sort();
  if (keys.length === 1 && keys[0] === "inline") {
    if (typeof (value as { inline: unknown }).inline !== "string")
      return corrupt("An inline bodyContent value is not a string");
    return ok({ kind: "inline", text: (value as { inline: string }).inline });
  }
  if (keys.length === 3 && keys[0] === "contentPath" && keys[1] === "sha256" && keys[2] === "sizeBytes") {
    const record = value as { contentPath: unknown; sizeBytes: unknown; sha256: unknown };
    if (
      typeof record.contentPath !== "string" ||
      !isCanonicalContentFilePath(record.contentPath) ||
      typeof record.sizeBytes !== "number" ||
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes < 0 ||
      typeof record.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.sha256)
    )
      return corrupt("A file-backed bodyContent value is malformed");
    return ok({
      kind: "file-backed",
      contentPath: record.contentPath,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
    });
  }
  return corrupt("A bodyContent value does not match its closed union");
}

export type SnapshotArtifactBodyClassification = "file-backed-baseline" | "inline-supported" | "integrity";

/**
 * Classifies one format-3 Artifact record's body fields against the explicit
 * containing contract of section 38.8: `inlineBody` is always present and
 * exactly one of `storageKey` and `inlineBody` is non-null. A file-backed
 * record (`inlineBody: null`, managed `storageKey`) and an inline record
 * (`inlineBody: string`, `storageKey: null`) are supported representations; any
 * other shape, a `bodyContent` key on an Artifact, or a missing field is an
 * integrity failure.
 */
export function classifySnapshotArtifactBody(
  raw: Record<string, unknown>,
): Result<SnapshotArtifactBodyClassification, AppError> {
  if (Object.hasOwn(raw, "bodyContent")) return corrupt("An Artifact record carries the Memo-family bodyContent field");
  if (!Object.hasOwn(raw, "inlineBody")) return corrupt("A format-3 Artifact record omits its inlineBody field");
  const inlineBody = raw.inlineBody;
  const storageKey = raw.storageKey;
  if (inlineBody === null && typeof storageKey === "string") return ok("file-backed-baseline");
  if (typeof inlineBody === "string" && storageKey === null) return ok("inline-supported");
  return corrupt("A format-3 Artifact record does not carry exactly one of storageKey and inlineBody");
}

export type SnapshotEventClassification = "family" | "unknown";

/**
 * Classifies one snapshot event name for a format: the format-3 family admits
 * the Channel domain family alongside the complete existing ledger (section
 * 38.9, the TASK-109 family admission); formats 1 and 2 keep their frozen
 * pre-M9 allowlists, so a Channel domain name in those formats is an unknown
 * name and stays an integrity failure.
 */
export function classifySnapshotEvent(eventType: string, formatVersion: 1 | 2 | 3): SnapshotEventClassification {
  return snapshotEventTypeAllowed(formatVersion, eventType) ? "family" : "unknown";
}

/** Validates the closed metadata of one common physical-content event in a format-3 snapshot. */
export function validateSnapshotCommonEvent(eventType: string, metadata: unknown): Result<void, AppError> {
  if (!isCommonContentEventType(eventType)) return corrupt("A common content event name is not in the family");
  return validateCommonContentEventMetadata(metadata, eventType);
}

/** Validate existing Project/Binding values without introducing a closed extension-field whitelist. */
export function validateSnapshotProjectV3(value: unknown): Result<void, AppError> {
  const object = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  if (
    !object(value) ||
    !isMemoUuid(value.id) ||
    typeof value.slug !== "string" ||
    value.slug.includes("\0") ||
    typeof value.displayName !== "string" ||
    (value.description !== null && typeof value.description !== "string") ||
    (value.status !== "active" && value.status !== "archived") ||
    !isMemoTimestamp(value.createdAt) ||
    !isMemoTimestamp(value.updatedAt) ||
    !Array.isArray(value.bindings)
  )
    return corrupt("Format-3 Project fields or values are invalid");
  for (const binding of value.bindings) {
    if (
      !object(binding) ||
      !isMemoUuid(binding.id) ||
      !isMemoUuid(binding.installationId) ||
      (binding.bindingKind !== "directory" && binding.bindingKind !== "git_repository") ||
      (Object.hasOwn(binding, "directory") && typeof binding.directory !== "string") ||
      !isMemoTimestamp(binding.createdAt) ||
      !isMemoTimestamp(binding.updatedAt)
    )
      return corrupt("Format-3 Binding fields or values are invalid");
  }
  return ok(undefined);
}

/** Format 3 keeps these legacy record fields, with explicit nullable values and the existing path-redaction exception. */
export function validateSnapshotHandoffV3(value: unknown): Result<void, AppError> {
  const text = (value: unknown): value is string => typeof value === "string";
  const nullableText = (value: unknown) => value === null || text(value);
  const identifier = isMemoUuid;
  const nullableIdentifier = (value: unknown) => value === null || identifier(value);
  // ADR-0031: only the two Artifact identity fields accept the legacy short
  // form — exactly `a` followed by eight lowercase hexadecimal characters —
  // beside a canonical UUID. The value is a string before either form is
  // tested, and the explicit length predicate runs before the pattern, so
  // arrays, numbers, booleans, objects (whatever their toString), upper-case
  // hex, wrong lengths, and embedded line terminators all fail as typed
  // integrity errors without throwing.
  const artifactIdentity = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    (candidate.length === 9
      ? /^a[0-9a-f]{8}$/.test(candidate)
      : candidate.length === 36
        ? isMemoUuid(candidate)
        : false);
  const nullableArtifactIdentity = (value: unknown) => value === null || artifactIdentity(value);
  const timestamp = (value: unknown) => isMemoTimestamp(value);
  const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
  const integer = (value: unknown, minimum = 0) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
  const actor = (value: unknown) =>
    value === "user" || value === "registered_project" || value === "unregistered_workspace";
  if (
    !memoObject(
      value,
      [
        "id",
        "dispatchGroupId",
        "supersedesHandoffId",
        "title",
        "senderKind",
        "senderProjectId",
        "senderWorkspaceKey",
        "recipientProjectId",
        "currentArtifactId",
        "revision",
        "rowVersion",
        "reviewState",
        "acceptedRevision",
        "acceptedAt",
        "declinedAt",
        "declineReason",
        "withdrawnAt",
        "consecutiveNoChangeResolutions",
        "firstFetchedAt",
        "reviewEngagedAt",
        "pinned",
        "archivedAt",
        "deletedAt",
        "createdAt",
        "updatedAt",
        "artifact",
        "reviewNote",
        "deletionRequests",
      ],
      ["senderPathSnapshot"],
    )
  )
    return corrupt("Format-3 Handoff fields are invalid");
  if (
    !identifier(value.id) ||
    !nullableIdentifier(value.dispatchGroupId) ||
    !nullableIdentifier(value.supersedesHandoffId) ||
    !text(value.title) ||
    !actor(value.senderKind) ||
    !nullableIdentifier(value.senderProjectId) ||
    !nullableText(value.senderWorkspaceKey) ||
    (value.senderKind === "registered_project"
      ? !identifier(value.senderProjectId) || value.senderWorkspaceKey !== null
      : value.senderKind === "unregistered_workspace"
        ? value.senderProjectId !== null || !text(value.senderWorkspaceKey)
        : value.senderProjectId !== null || value.senderWorkspaceKey !== null) ||
    (Object.hasOwn(value, "senderPathSnapshot") && !nullableText(value.senderPathSnapshot)) ||
    !identifier(value.recipientProjectId) ||
    !nullableArtifactIdentity(value.currentArtifactId) ||
    !integer(value.revision, 1) ||
    !integer(value.rowVersion, 1) ||
    !(REVIEW_STATES as readonly unknown[]).includes(value.reviewState) ||
    (value.acceptedRevision !== null && !integer(value.acceptedRevision, 1)) ||
    ![
      value.acceptedAt,
      value.declinedAt,
      value.withdrawnAt,
      value.firstFetchedAt,
      value.reviewEngagedAt,
      value.archivedAt,
      value.deletedAt,
    ].every(nullableTimestamp) ||
    !nullableText(value.declineReason) ||
    !integer(value.consecutiveNoChangeResolutions) ||
    typeof value.pinned !== "boolean" ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !Array.isArray(value.deletionRequests)
  )
    return corrupt("Format-3 Handoff values are invalid");
  if (value.artifact !== null) {
    const artifact = value.artifact;
    if (
      !memoObject(artifact, [
        "id",
        "handoffId",
        "storageKey",
        "inlineBody",
        "originalName",
        "storedName",
        "mimeType",
        "sizeBytes",
        "sha256",
        "importedFromPath",
        "materialized",
        "createdAt",
      ]) ||
      !artifactIdentity(artifact.id) ||
      artifact.handoffId !== value.id ||
      !nullableText(artifact.storageKey) ||
      !nullableText(artifact.inlineBody) ||
      !text(artifact.originalName) ||
      !text(artifact.storedName) ||
      !isValidStorageKeySegment(artifact.storedName) ||
      !text(artifact.mimeType) ||
      !integer(artifact.sizeBytes) ||
      !text(artifact.sha256) ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !nullableText(artifact.importedFromPath) ||
      typeof artifact.materialized !== "boolean" ||
      !timestamp(artifact.createdAt)
    )
      return corrupt("Format-3 Artifact fields or values are invalid");
    // The closed containing pair of section 38.8: exactly one of the inline
    // body and the managed key is present, an inline body's exact UTF-8 bytes
    // match the recorded size and digest — byte-order mark, line endings, and
    // the presence or absence of a final newline included — and an inline row
    // is always materialized (SHR-001, SHR-003, SHR-004).
    if ((artifact.inlineBody === null) === (artifact.storageKey === null))
      return corrupt("A format-3 Artifact record does not carry exactly one of storageKey and inlineBody");
    if (artifact.inlineBody !== null) {
      if (artifact.materialized !== true) return corrupt("An inline format-3 Artifact record must be materialized");
      // A string that cannot round-trip UTF-8 — a lone surrogate — encodes to
      // replacement bytes, so a forged size and digest over those bytes must
      // never admit it as byte-exact accepted content (SHR-003); the routing
      // threshold that bounds every inline record applies unchanged
      // (SHR-002).
      if (!isUtf8ExactText(artifact.inlineBody))
        return corrupt("An inline format-3 Artifact body cannot be stored byte-exactly");
      if (utf8ByteLength(artifact.inlineBody) > CONTENT_INLINE_MAX_UTF8_BYTES)
        return corrupt("An inline format-3 Artifact body exceeds the inline routing threshold");
      if (
        utf8ByteLength(artifact.inlineBody) !== artifact.sizeBytes ||
        sha256OfText(artifact.inlineBody) !== artifact.sha256
      )
        return corrupt("An inline format-3 Artifact body does not match its recorded size and SHA-256");
    }
  }
  if (value.reviewNote !== null) {
    const note = value.reviewNote;
    if (
      !memoObject(note, [
        "handoffId",
        "authorKind",
        "authorProjectId",
        "targetRevision",
        "body",
        "createdAt",
        "updatedAt",
      ]) ||
      note.handoffId !== value.id ||
      (note.authorKind !== "registered_project" && note.authorKind !== "user") ||
      !nullableIdentifier(note.authorProjectId) ||
      (note.authorKind === "user" ? note.authorProjectId !== null : !identifier(note.authorProjectId)) ||
      !integer(note.targetRevision, 1) ||
      !text(note.body) ||
      !timestamp(note.createdAt) ||
      !timestamp(note.updatedAt)
    )
      return corrupt("Format-3 Review Note fields or values are invalid");
  }
  for (const request of value.deletionRequests) {
    if (
      !memoObject(request, [
        "id",
        "handoffId",
        "requestedByKind",
        "requestedById",
        "reason",
        "status",
        "requestedAt",
        "resolvedAt",
        "resolvedByUser",
        "resolutionNote",
      ]) ||
      !identifier(request.id) ||
      request.handoffId !== value.id ||
      !actor(request.requestedByKind) ||
      !nullableText(request.requestedById) ||
      (request.requestedByKind === "registered_project"
        ? !identifier(request.requestedById)
        : request.requestedByKind === "user"
          ? request.requestedById !== null
          : !text(request.requestedById)) ||
      !nullableText(request.reason) ||
      (request.status !== "pending" && request.status !== "approved" && request.status !== "rejected") ||
      !timestamp(request.requestedAt) ||
      !nullableTimestamp(request.resolvedAt) ||
      !nullableText(request.resolvedByUser) ||
      !nullableText(request.resolutionNote)
    )
      return corrupt("Format-3 Deletion Request fields or values are invalid");
  }
  return ok(undefined);
}

const MEMO_V3_FIELDS = [
  "id",
  "projectId",
  "title",
  "bodyContent",
  "state",
  "rowVersion",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "closedAt",
  "closedBy",
];

function memoRecordV3(memo: Memo): Record<string, unknown> {
  const { body: _body, ...rest } = memo;
  return { ...rest, bodyContent: { inline: memo.body } };
}

/** One format-3 Memo export record: the public metadata plus the routed bodyContent (SHR-010, section 38.8). */
export interface SnapshotMemoV3 extends Omit<Memo, "body"> {
  bodyContent: ParsedBodyContent;
}

/** One carried Memo content file for export: the record's exact raw bytes (SHR-010). */
export interface MemoContentFileExport {
  memoId: string;
  contentId: string;
  bytes: Uint8Array;
}

/** Validate historical raw text without applying today's ingestion cap or normalizing bytes. */
export function isMemoContentBytes(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
      const chunk = bytes.subarray(offset, offset + 65536);
      if (chunk.includes(0)) return false;
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

/** Reconcile the closed Memo bodies, their owned files, and their raw identities before adoption. */
export function validateSnapshotMemoContent(
  data: Pick<SnapshotDataV3, "memos" | "memoContentFiles">,
  digests?: Readonly<Record<string, string>>,
): Result<void, AppError> {
  const carried = new Map<string, Uint8Array>();
  for (const file of data.memoContentFiles ?? []) {
    const path = memoContentFilePath(file.memoId, file.contentId);
    if (!path.ok) return path;
    if (carried.has(path.value)) return corrupt("Duplicate Memo content file identity");
    carried.set(path.value, file.bytes);
  }
  const used = new Set<string>();
  for (const memo of data.memos ?? []) {
    if (!memoObject(memo, MEMO_V3_FIELDS)) return corrupt("Format-3 Memo snapshot fields are invalid");
    const { bodyContent, ...meta } = memo;
    if (!parseMemoMetadata(meta).ok) return corrupt("Memo snapshot metadata is invalid");
    if (bodyContent === null || typeof bodyContent !== "object") return corrupt("Memo snapshot body is invalid");
    if (bodyContent.kind === "inline") {
      if (!memoObject(bodyContent, ["kind", "text"]) || !parseMemoDetail({ ...meta, body: bodyContent.text }).ok)
        return corrupt("Memo inline snapshot body is invalid");
      continue;
    }
    if (!memoObject(bodyContent, ["kind", "contentPath", "sizeBytes", "sha256"]) || bodyContent.kind !== "file-backed")
      return corrupt("Memo snapshot body representation is invalid");
    const { kind: _kind, ...wire } = bodyContent;
    const parsed = parseSnapshotBodyContent(wire);
    if (!parsed.ok) return parsed;
    const ownedPath = memoContentFilePath(memo.id, bodyContent.contentPath.split("/")[3] as string);
    if (!ownedPath.ok || ownedPath.value !== bodyContent.contentPath || used.has(ownedPath.value))
      return corrupt("Memo snapshot content ownership is invalid");
    const bytes = carried.get(ownedPath.value);
    if (bytes === undefined || bytes.byteLength !== bodyContent.sizeBytes || !isMemoContentBytes(bytes))
      return corrupt("Memo snapshot content bytes are missing or invalid");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== bodyContent.sha256 || (digests !== undefined && digests[ownedPath.value] !== digest))
      return corrupt("Memo snapshot content digest disagrees with its recorded identity");
    used.add(ownedPath.value);
  }
  // The exact `contentDigests` key-set agreement is the composed format-3
  // union check over the Memo and Channel families (channel-snapshot.ts); the
  // Memo side here proves its own carried-versus-referenced exactness and each
  // referenced file's recorded digest, never the whole map alone.
  if (used.size !== carried.size) return corrupt("Memo snapshot content inventory disagrees with its records");
  return ok(undefined);
}

/** Serializes one Memo as its format-3 shard with its inline or file-backed `bodyContent` (section 38.8). */
export function serializeMemoSnapshotV3(record: SnapshotMemoV3): Result<MemoSnapshotShard> {
  const { bodyContent, ...meta } = record;
  if (!parseMemoMetadata(meta).ok) return corrupt("Memo snapshot metadata is invalid");
  const wireBody =
    bodyContent.kind === "inline"
      ? { inline: bodyContent.text }
      : { contentPath: bodyContent.contentPath, sizeBytes: bodyContent.sizeBytes, sha256: bodyContent.sha256 };
  const parsedBody = parseSnapshotBodyContent(wireBody);
  if (!parsedBody.ok) return parsedBody;
  const path = memoSnapshotPath(record.id);
  if (!path.ok) return path;
  if (bodyContent.kind === "file-backed") {
    // The file form names a snapshots/-relative content file whose digest the
    // manifest's contentDigests map carries; the shard itself records only the
    // reference triple, never the bytes.
    const bytes = new TextEncoder().encode(
      canonicalJson({
        ...meta,
        bodyContent: {
          contentPath: bodyContent.contentPath,
          sizeBytes: bodyContent.sizeBytes,
          sha256: bodyContent.sha256,
        },
      }),
    );
    return ok({ path: path.value, bytes, digest: createHash("sha256").update(bytes).digest("hex") });
  }
  const checked = parseMemoDetail({ ...meta, body: bodyContent.text });
  if (!checked.ok) return corrupt("Memo snapshot fields are invalid");
  const bytes = new TextEncoder().encode(canonicalJson(memoRecordV3(checked.value)));
  return ok({ path: path.value, bytes, digest: createHash("sha256").update(bytes).digest("hex") });
}

/** The canonical snapshots/-relative content-file path for one file-backed Memo body. */
export function memoContentFilePath(memoId: string, contentId: string): Result<string> {
  if (!isMemoUuid(memoId) || !isMemoUuid(contentId)) return corrupt("The Memo content file identity is not canonical");
  return ok(`content/memo/${memoId}/${contentId}`);
}

/** One parsed format-3 Memo: its metadata plus the closed bodyContent union. */
export interface MemoSnapshotV3Import {
  meta: Omit<Memo, "body">;
  bodyContent: ParsedBodyContent;
}

/**
 * Parses one format-3 Memo shard (section 38.8): the record carries the closed
 * Memo field set with `bodyContent` in place of `body`. The inline form
 * returns its exact text; the file-backed form returns its reference triple —
 * a valid representation this build imports when the snapshot carries the
 * content file — and the caller owns the carried-file inventory check.
 */
export function parseMemoSnapshotV3(path: string, bytes: Uint8Array, digest: string): Result<MemoSnapshotV3Import> {
  const id = memoIdFromSnapshotPath(path);
  if (!id.ok) return id;
  if (!/^[0-9a-f]{64}$/.test(digest) || createHash("sha256").update(bytes).digest("hex") !== digest)
    return corrupt("Memo snapshot digest does not match its raw bytes");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return corrupt("Memo snapshot is not valid UTF-8");
  }
  const parsed = parseUniqueSnapshotJson(text);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!memoObject(value, MEMO_V3_FIELDS)) return corrupt("Format-3 Memo snapshot fields are invalid");
  const body = parseSnapshotBodyContent(value.bodyContent);
  if (!body.ok) return body;
  const { bodyContent: _bodyContent, ...meta } = value as Record<string, unknown>;
  if (body.value.kind === "inline") {
    // The inline form's exact stored text is the authoritative body: validate
    // the whole record against the closed schema and the frozen inline cap.
    const memo = { ...meta, body: body.value.text } as unknown as Memo;
    const detailed = parseMemoDetail(memo);
    if (!detailed.ok || detailed.value.id !== id.value)
      return corrupt("Memo snapshot record does not match its closed schema or path");
    if (canonicalJson(memoRecordV3(detailed.value)) !== text) return corrupt("Memo snapshot bytes are not canonical");
    const { body: _checkedBody, ...checkedMeta } = detailed.value;
    return ok({ meta: checkedMeta, bodyContent: { kind: "inline", text: body.value.text } });
  }
  // Lifecycle and provenance are validated without fabricating body text.
  if (!isMemoUuid(meta.id) || meta.id !== id.value) return corrupt("Memo snapshot record does not match its path");
  const ownedContent = memoContentFilePath(meta.id, body.value.contentPath.split("/")[3] as string);
  if (!ownedContent.ok || ownedContent.value !== body.value.contentPath)
    return corrupt("Memo snapshot content path does not match its owner");
  const metadata = parseMemoMetadata(meta);
  if (!metadata.ok) return corrupt("Memo snapshot record does not match its closed schema");
  const roundTrip = canonicalJson({
    ...meta,
    bodyContent: { contentPath: body.value.contentPath, sizeBytes: body.value.sizeBytes, sha256: body.value.sha256 },
  });
  if (roundTrip !== text) return corrupt("Memo snapshot bytes are not canonical");
  return ok({
    meta: metadata.value,
    bodyContent: {
      kind: "file-backed",
      contentPath: body.value.contentPath,
      sizeBytes: body.value.sizeBytes,
      sha256: body.value.sha256,
    },
  });
}

/**
 * The format-3-only Artifact record (SHR-010, section 38.8): every legacy
 * field plus the explicit containing pair — `inlineBody: string` XOR
 * `storageKey: string` — where null marks absence. The legacy
 * `SnapshotArtifact` of formats 1 and 2 stays frozen with its non-null key;
 * this distinct type carries inline bodies without widening any legacy
 * interpretation.
 */
export interface SnapshotArtifactV3 {
  id: string;
  handoffId: string;
  storageKey: string | null;
  inlineBody: string | null;
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  importedFromPath: string | null;
  materialized: boolean;
  createdAt: string;
}

/** The format-3-only Handoff record: the legacy shape over the V3 Artifact. */
export type SnapshotHandoffV3 = Omit<SnapshotHandoff, "artifact"> & { artifact: SnapshotArtifactV3 | null };

/** One exported Channel message's closed snapshot record, rebuilt under ADR-0034 (section 38.8). */
export interface SnapshotChannelMessage {
  seq: number;
  senderHandle: string;
  kind: "report" | "question" | "relay_request";
  toHandle: string | null;
  ref: string | null;
  bodyContent: SnapshotBodyContent;
  handled: boolean;
  handledAt: string | null;
  handleNote: string | null;
  createdAt: string;
}

/** One exported participant's closed snapshot record, rebuilt under ADR-0034 (section 38.8). */
export interface SnapshotChannelParticipant {
  handle: string;
  role: "main" | "worker" | "judge";
  addedAt: string;
  removedAt: string | null;
}

/** One exported Channel's closed snapshot shard, rebuilt under ADR-0034 (section 38.8). */
export interface SnapshotChannelShard {
  id: string;
  name: string;
  title: string | null;
  state: "open" | "closed";
  main: string;
  createdAt: string;
  closedAt: string | null;
  participants: SnapshotChannelParticipant[];
  messages: SnapshotChannelMessage[];
}

/** One carried Channel content file for export: the record's exact raw bytes (SHR-010). */
export interface ChannelContentFileExport {
  channelId: string;
  contentId: string;
  bytes: Uint8Array;
}

/** The format-3 export input: the legacy snapshot data over the V3 Handoff records, routed Memo bodies, and Channel shards. */
export type SnapshotDataV3 = Omit<SnapshotData, "handoffs" | "memos"> & {
  handoffs: SnapshotHandoffV3[];
  memos?: SnapshotMemoV3[];
  /** The exact raw bytes of each file-backed Memo body, carried as snapshot content files (SHR-010). */
  memoContentFiles?: MemoContentFileExport[];
  /** The exported Channel shards with their complete rosters and messages (CHN-009, SHR-010). */
  channels?: SnapshotChannelShard[];
  /** The exact raw bytes of each file-backed Channel message body, carried as snapshot content files (SHR-010). */
  channelContentFiles?: ChannelContentFileExport[];
};

/** The workspace-path redaction over the V3 shape: the same fields, honestly typed. */
export function redactSnapshotDataV3(data: SnapshotDataV3): SnapshotDataV3 {
  return {
    ...(data.memos === undefined ? {} : { memos: data.memos }),
    ...(data.memoContentFiles === undefined ? {} : { memoContentFiles: data.memoContentFiles }),
    ...(data.channels === undefined ? {} : { channels: data.channels }),
    ...(data.channelContentFiles === undefined ? {} : { channelContentFiles: data.channelContentFiles }),
    projects: data.projects.map((project) => ({
      ...project,
      bindings: project.bindings.map(({ directory: _directory, ...binding }) => binding),
    })),
    handoffs: data.handoffs.map(({ senderPathSnapshot: _senderPathSnapshot, ...handoff }) => handoff),
    events: data.events.map((event) => ({ ...event, metadata: redactEventMetadata(event.metadata) })),
  };
}

/**
 * Builds the complete format-3 export (SHR-010): the legacy serializer's
 * projects shard bytes, Handoff shards serialized directly from their V3
 * records — each Artifact carrying its closed `inlineBody` XOR `storageKey`
 * pair, an inline body's exact stored text being the authoritative bytes —
 * Memo shards carrying inline or file-backed `bodyContent` with each
 * file-backed body's exact raw bytes carried as a snapshot content file and
 * digested in `contentDigests`, and the Channel shards of TASK-109 with their
 * complete rosters, assignments, messages, and file-backed body bytes under
 * the shared content inventory. A file-backed Artifact's bytes keep arriving
 * through the committed `artifacts/` tree outside `contentDigests`, which
 * never covers Handoff Artifact files at any M9 build.
 */
export function snapshotFilesV3(
  data: SnapshotDataV3,
): Result<{ files: SnapshotFile[]; manifest: ContentSnapshotManifest }, AppError> {
  const content = validateSnapshotMemoContent(data);
  if (!content.ok) return content;
  // The projects shard reuses the legacy serializer over an empty Handoff set,
  // so its exact bytes stay shared without pretending a V3 Handoff satisfies
  // the file-only legacy shape.
  const files: SnapshotFile[] = snapshotFiles({ projects: data.projects, handoffs: [], events: [] }).filter(
    (file) => file.path === "projects.json",
  );
  const byId = [...data.handoffs].sort((a, b) => compareSnapshotStrings(a.id, b.id));
  for (const handoff of byId) {
    files.push({ path: handoffShardPath(handoff.id), content: canonicalJson(handoff) });
  }
  const memoDigests: Record<string, string> = {};
  const contentDigests: Record<string, string> = {};
  const contentCarried = new Map<string, Uint8Array>();
  for (const carried of data.memoContentFiles ?? []) {
    const carriedPath = memoContentFilePath(carried.memoId, carried.contentId);
    if (!carriedPath.ok) return carriedPath;
    if (contentCarried.has(carriedPath.value)) return corrupt("Duplicate Memo content file identity");
    contentCarried.set(carriedPath.value, carried.bytes);
    contentDigests[carriedPath.value] = createHash("sha256").update(carried.bytes).digest("hex");
  }
  const memos = data.memos ?? [];
  for (const memo of [...memos].sort((a, b) => compareSnapshotStrings(a.id, b.id))) {
    const shard = serializeMemoSnapshotV3(memo);
    if (!shard.ok) return shard;
    if (Object.hasOwn(memoDigests, shard.value.path)) return corrupt("Duplicate Memo snapshot ID");
    memoDigests[shard.value.path] = shard.value.digest;
    files.push({ path: shard.value.path, content: Buffer.from(shard.value.bytes).toString("utf8") });
    // A file-backed Memo's shard must name exactly one carried content file
    // whose bytes match the shard's recorded size and digest.
    if (memo.bodyContent.kind === "file-backed") {
      const bytes = contentCarried.get(memo.bodyContent.contentPath);
      if (bytes === undefined) {
        return corrupt("A file-backed Memo shard names a content file the export does not carry");
      }
      if (
        bytes.byteLength !== memo.bodyContent.sizeBytes ||
        contentDigests[memo.bodyContent.contentPath] !== memo.bodyContent.sha256
      ) {
        return corrupt("A file-backed Memo shard disagrees with its carried content file");
      }
      files.push({ path: memo.bodyContent.contentPath, content: bytes });
    }
  }
  // Channel content files join the same contentDigests map: each file-backed
  // Channel message body's exact raw bytes, digested over those bytes (CHN-009,
  // SHR-010).
  for (const carried of data.channelContentFiles ?? []) {
    const carriedPath = channelContentFilePath(carried.channelId, carried.contentId);
    if (!carriedPath.ok) return carriedPath;
    if (contentCarried.has(carriedPath.value)) return corrupt("Duplicate Channel content file identity");
    const proof = proveChannelContentBytes(carried.bytes);
    if (!proof.ok) return proof;
    contentCarried.set(carriedPath.value, carried.bytes);
    contentDigests[carriedPath.value] = createHash("sha256").update(carried.bytes).digest("hex");
  }
  const channels = data.channels ?? [];
  const referencedContent = new Set<string>();
  for (const memo of memos) {
    if (memo.bodyContent.kind === "file-backed") referencedContent.add(memo.bodyContent.contentPath);
  }
  const channelIds = new Set<string>();
  for (const channel of [...channels].sort((a, b) => compareSnapshotStrings(a.id, b.id))) {
    // Every shard is validated against its closed wire contract before the
    // export writes a single byte of it: an invalid record is refused here,
    // never serialized into a snapshot (section 38.8).
    const shard = validateSnapshotChannelShard(channel);
    if (!shard.ok) return shard;
    if (channelIds.has(channel.id)) return corrupt("Duplicate Channel snapshot ID");
    channelIds.add(channel.id);
    const shardPath = channelSnapshotPath(channel.id);
    if (!shardPath.ok) return shardPath;
    files.push({ path: shardPath.value, content: canonicalJson(channel) });
    // A file-backed Channel message's shard must name exactly one carried
    // content file whose bytes match the shard's recorded size and digest.
    for (const message of channel.messages) {
      if (!("contentPath" in message.bodyContent)) continue;
      const body = message.bodyContent;
      if (referencedContent.has(body.contentPath)) return corrupt("Two file-backed records name one content file");
      referencedContent.add(body.contentPath);
      const bytes = contentCarried.get(body.contentPath);
      if (bytes === undefined) {
        return corrupt("A file-backed Channel message names a content file the export does not carry");
      }
      if (bytes.byteLength !== body.sizeBytes || contentDigests[body.contentPath] !== body.sha256) {
        return corrupt("A file-backed Channel message disagrees with its carried content file");
      }
      files.push({ path: body.contentPath, content: bytes });
    }
  }
  // The carried set and the referenced set must agree exactly across both
  // families: an orphan file is an inventory disagreement, never a silent
  // extra (section 38.8).
  if (contentCarried.size !== referencedContent.size)
    return corrupt("The export carries a content file no shard names");
  for (const contentPath of contentCarried.keys()) {
    if (!referencedContent.has(contentPath)) return corrupt("The export carries a content file no shard names");
  }
  const events = data.events.map((event) => ({ ...event, memoId: event.memoId ?? null }));
  const manifest: ContentSnapshotManifest = {
    formatVersion: 3,
    counts: { ...snapshotCounts(data), memos: memos.length, channels: channels.length },
    memoDigests,
    contentDigests,
  };
  files.push({
    path: "events.jsonl",
    content: events
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      .map(canonicalJsonLine)
      .join(""),
  });
  files.push({ path: "manifest.json", content: canonicalJson(manifest) });
  return ok({ files, manifest });
}
