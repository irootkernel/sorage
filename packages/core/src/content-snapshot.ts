import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonLine,
  snapshotFiles,
  snapshotManifest,
  type SnapshotData,
  type SnapshotFile,
  type SnapshotHandoff,
} from "./backup-snapshot";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { isChannelDomainEventType, isCommonContentEventType, snapshotEventTypeAllowed } from "./events";
import { validateCommonContentEventMetadata } from "./content";
import { memoObject, parseMemoDetail } from "./memo-protocol";
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

/**
 * The format-3 snapshot generation of M9 (SHR-010, interface section 38.8): one
 * coherent global snapshot whose single manifest counts the Channel family this
 * build exports as zero and digests the shared-content files this build exports
 * as none. The writer keeps the determinism, purity, redaction, and canonical
 * JSON conventions of formats 1 and 2; the reader accepts exactly the format-3
 * representations this schema can faithfully import and refuses a valid
 * later-generation structure before import with `VAULT_SCHEMA_UNSUPPORTED`
 * rather than as corruption, partial restore, fallback, or silent omission.
 */

function corrupt(message: string): Result<never, AppError> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

function unsupported(message: string): Result<never, AppError> {
  return err(appError("VAULT_SCHEMA_UNSUPPORTED", message));
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

export type SnapshotArtifactBodyClassification = "file-backed-baseline" | "inline-later" | "integrity";

/**
 * Classifies one format-3 Artifact record's body fields against the explicit
 * containing contract of section 38.8: `inlineBody` is always present and
 * exactly one of `storageKey` and `inlineBody` is non-null. A file-backed
 * record (`inlineBody: null`, managed `storageKey`) is this build's baseline;
 * an inline record (`inlineBody: string`, `storageKey: null`) is the valid
 * later representation TASK-107 adds and fails closed before import here; any
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
  if (typeof inlineBody === "string" && storageKey === null) return ok("inline-later");
  return corrupt("A format-3 Artifact record does not carry exactly one of storageKey and inlineBody");
}

export type SnapshotEventClassification = "family" | "later-channel" | "unknown";

/**
 * Classifies one snapshot event name for a format: a recognized Channel domain
 * name in format 3 is the unsupported later representation; membership in the
 * format's frozen family follows `snapshotEventTypeAllowed`; everything else is
 * an unknown name and stays an integrity failure (section 38.9).
 */
export function classifySnapshotEvent(eventType: string, formatVersion: 1 | 2 | 3): SnapshotEventClassification {
  if (formatVersion === 3 && isChannelDomainEventType(eventType)) return "later-channel";
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

/** Serializes one Memo as its format-3 shard: every Memo field with the body carried as inline `bodyContent`. */
export function serializeMemoSnapshotV3(memo: Memo): Result<MemoSnapshotShard> {
  const checked = parseMemoDetail(memo);
  if (!checked.ok) return corrupt("Memo snapshot fields are invalid");
  const path = memoSnapshotPath(memo.id);
  if (!path.ok) return path;
  const bytes = new TextEncoder().encode(canonicalJson(memoRecordV3(memo)));
  return ok({ path: path.value, bytes, digest: createHash("sha256").update(bytes).digest("hex") });
}

/**
 * Parses one format-3 Memo shard back to its legacy representation: the record
 * carries the closed Memo field set with `bodyContent` in place of `body`, this
 * build imports only the inline form, and the file-backed form is the valid
 * later representation TASK-108 adds and fails closed before import.
 */
export function parseMemoSnapshotV3(path: string, bytes: Uint8Array, digest: string): Result<Memo, AppError> {
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
  if (body.value.kind !== "inline") {
    return unsupported(
      "The snapshot carries a Vault-backed Memo body, a valid later representation this build cannot import",
    );
  }
  const { bodyContent: _bodyContent, ...rest } = value as Record<string, unknown>;
  const memo = { ...rest, body: body.value.text } as unknown as Memo;
  const detailed = parseMemoDetail(memo);
  if (!detailed.ok || detailed.value.id !== id.value)
    return corrupt("Memo snapshot record does not match its closed schema or path");
  if (canonicalJson(memoRecordV3(detailed.value)) !== text) return corrupt("Memo snapshot bytes are not canonical");
  return ok(detailed.value);
}

/** The format-3 Artifact record this build writes: every existing field plus an explicit `inlineBody: null`. */
function artifactRecordV3(artifact: NonNullable<SnapshotHandoff["artifact"]>): Record<string, unknown> {
  return { ...artifact, inlineBody: null };
}

/**
 * Builds the complete format-3 export (SHR-010): the format-2 file set with
 * Handoff Artifact records carrying their explicit null `inlineBody`, Memo
 * shards carrying `bodyContent` inline bodies, and a manifest whose Channel
 * count is zero and whose shared-content digest map is empty, because this
 * schema exports no Channel records and no file-backed shared content. A
 * file-backed Artifact's bytes keep arriving through the committed
 * `artifacts/` tree outside `contentDigests`, which never covers Handoff
 * Artifact files at any M9 build.
 */
export function snapshotFilesV3(
  data: SnapshotData,
): Result<{ files: SnapshotFile[]; manifest: ContentSnapshotManifest }, AppError> {
  const base = snapshotFiles({ projects: data.projects, handoffs: data.handoffs, events: [] }).filter(
    (file) => file.path !== "manifest.json" && file.path !== "events.jsonl",
  );
  const files: SnapshotFile[] = [];
  for (const file of base) {
    if (file.path === "projects.json") {
      files.push(file);
      continue;
    }
    const shardId = file.path
      .split("/")
      .at(-1)
      ?.replace(/\.json$/, "");
    const handoff = data.handoffs.find((candidate) => candidate.id === shardId);
    if (handoff === undefined || file.path !== `handoffs/${handoff.id.slice(0, 2)}/${handoff.id}.json`) {
      return corrupt("The handoff shard tree does not match the snapshot handoffs");
    }
    const record: Record<string, unknown> = { ...handoff };
    if (handoff.artifact !== null) record.artifact = artifactRecordV3(handoff.artifact);
    files.push({ path: file.path, content: canonicalJson(record) });
  }
  const memoDigests: Record<string, string> = {};
  for (const memo of [...(data.memos ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const shard = serializeMemoSnapshotV3(memo);
    if (!shard.ok) return shard;
    if (Object.hasOwn(memoDigests, shard.value.path)) return corrupt("Duplicate Memo snapshot ID");
    memoDigests[shard.value.path] = shard.value.digest;
    files.push({ path: shard.value.path, content: Buffer.from(shard.value.bytes).toString("utf8") });
  }
  const events = data.events.map((event) => ({ ...event, memoId: event.memoId ?? null }));
  const manifest: ContentSnapshotManifest = {
    formatVersion: 3,
    counts: { ...snapshotManifest(data).counts, memos: data.memos?.length ?? 0, channels: 0 },
    memoDigests,
    contentDigests: {},
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
