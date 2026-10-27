import type { SnapshotEvent } from "./backup-snapshot";
import { canonicalJson, handoffShardPath, type SnapshotFile, type SnapshotReviewNote } from "./backup-snapshot";
import { isUtf8ExactText } from "./content";
import {
  redactSnapshotDataV3,
  type SnapshotDataV3,
  type SnapshotHandoffV3,
  snapshotFilesV3,
  validateSnapshotHandoffV3,
} from "./content-snapshot";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { HANDOFF_REPORTING_EVENT_TYPES } from "./events";
import { memoObject } from "./memo-protocol";
import type { HandoffReportingSnapshotManifest } from "./memo-snapshot";
import { isMemoRowVersion, isMemoTimestamp } from "./memos";

/** Format 4 owns reporting fields; the format-3 representation stays frozen. */
export interface SnapshotReadEvidence {
  revision: number;
  status: "unrecorded" | "unconfirmed" | "read";
  readAt: string | null;
}
export interface SnapshotProcessingEvidence {
  revision: number;
  status: "unrecorded" | "not_started" | "in_progress" | "completed";
  startedAt: string | null;
  completedAt: string | null;
}
export interface SnapshotRecipientComment extends SnapshotReviewNote {
  purpose: "general" | "change_request";
  active: boolean;
}
export interface SnapshotHandoffV4 extends Omit<SnapshotHandoffV3, "reviewNote"> {
  comment: SnapshotRecipientComment | null;
  read: SnapshotReadEvidence;
  processing: SnapshotProcessingEvidence;
}
export interface SnapshotDataV4 extends Omit<SnapshotDataV3, "handoffs"> {
  handoffs: SnapshotHandoffV4[];
}

function corrupt(message: string): Result<never, AppError> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

export function legacyReportingEvidence(revision: number): {
  read: SnapshotReadEvidence;
  processing: SnapshotProcessingEvidence;
} {
  return {
    read: { revision, status: "unrecorded", readAt: null },
    processing: { revision, status: "unrecorded", startedAt: null, completedAt: null },
  };
}

/** Legacy conversion never infers current reading or work from acceptance. */
export function upgradeSnapshotHandoff(handoff: SnapshotHandoffV3): SnapshotHandoffV4 {
  const { reviewNote, ...rest } = handoff;
  return {
    ...rest,
    ...legacyReportingEvidence(handoff.revision),
    comment:
      reviewNote === null
        ? null
        : { ...reviewNote, purpose: "change_request", active: handoff.reviewState === "changes_requested" },
  };
}

/** A temporary structural projection for unchanged common snapshot validators. */
export function reportingSnapshotBase(handoff: SnapshotHandoffV4): SnapshotHandoffV3 {
  const { comment, read: _read, processing: _processing, ...rest } = handoff;
  if (comment === null) return { ...rest, reviewNote: null };
  const { purpose: _purpose, active: _active, ...reviewNote } = comment;
  return { ...rest, reviewNote };
}

export function reportingSnapshotDataBase(data: SnapshotDataV4): SnapshotDataV3 {
  return { ...data, handoffs: data.handoffs.map(reportingSnapshotBase) };
}

export function validateSnapshotHandoffV4(value: unknown): Result<void, AppError> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return corrupt("Format-4 Handoff is not an object");
  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, "comment") ||
    !Object.hasOwn(record, "read") ||
    !Object.hasOwn(record, "processing") ||
    Object.hasOwn(record, "reviewNote")
  )
    return corrupt("Format-4 Handoff must carry one comment and reporting fields, not reviewNote");
  const { comment, read, processing, ...base } = record;
  let reviewNote: Record<string, unknown> | null = null;
  if (comment !== null) {
    if (
      !memoObject(comment, [
        "handoffId",
        "authorKind",
        "authorProjectId",
        "targetRevision",
        "body",
        "createdAt",
        "updatedAt",
        "purpose",
        "active",
      ]) ||
      (comment.purpose !== "general" && comment.purpose !== "change_request") ||
      typeof comment.active !== "boolean" ||
      comment.active !== (comment.purpose === "change_request" && record.reviewState === "changes_requested") ||
      (comment.authorKind === "registered_project" && comment.authorProjectId !== record.recipientProjectId) ||
      typeof comment.targetRevision !== "number" ||
      typeof record.revision !== "number" ||
      comment.targetRevision > record.revision ||
      typeof comment.body !== "string" ||
      !isUtf8ExactText(comment.body)
    )
      return corrupt("Format-4 recipient comment fields, purpose or activity are invalid");
    const { purpose: _purpose, active: _active, ...note } = comment;
    reviewNote = note;
  }
  if (record.reviewState === "changes_requested" && (comment === null || comment.active !== true))
    return corrupt("An active review state must carry its active change-request comment");
  const old = validateSnapshotHandoffV3({ ...base, reviewNote });
  if (!old.ok) return old;
  if (
    !memoObject(read, ["revision", "status", "readAt"]) ||
    read.revision !== record.revision ||
    !(read.status === "unrecorded" || read.status === "unconfirmed" || read.status === "read") ||
    (read.status === "read" ? !isMemoTimestamp(read.readAt) : read.readAt !== null)
  )
    return corrupt("Format-4 current-Revision read evidence is invalid");
  if (
    !memoObject(processing, ["revision", "status", "startedAt", "completedAt"]) ||
    processing.revision !== record.revision ||
    !["unrecorded", "not_started", "in_progress", "completed"].includes(processing.status as string) ||
    (processing.status === "unrecorded" || processing.status === "not_started"
      ? processing.startedAt !== null || processing.completedAt !== null
      : processing.status === "in_progress"
        ? !isMemoTimestamp(processing.startedAt) || processing.completedAt !== null
        : !isMemoTimestamp(processing.completedAt) ||
          (processing.startedAt !== null && !isMemoTimestamp(processing.startedAt)))
  )
    return corrupt("Format-4 current-Revision processing evidence is invalid");
  if (
    record.deletedAt !== null &&
    (comment !== null ||
      read.status !== "unrecorded" ||
      processing.status !== "unrecorded" ||
      record.artifact !== null ||
      record.currentArtifactId !== null ||
      !["accepted", "declined", "withdrawn"].includes(record.reviewState as string))
  )
    return corrupt("A format-4 tombstone cannot carry live content or reporting evidence");
  return ok(undefined);
}

/** Exact association/metadata admission for the four format-4 reporting events. */
export function validateReportingSnapshotEvent(
  event: SnapshotEvent,
  handoffs: readonly SnapshotHandoffV4[],
): Result<void, AppError> {
  if (!(HANDOFF_REPORTING_EVENT_TYPES as readonly string[]).includes(event.eventType)) return ok(undefined);
  const handoff = handoffs.find((value) => value.id === event.handoffId);
  if (
    handoff === undefined ||
    !isMemoRowVersion(event.rowVersion) ||
    event.rowVersion > handoff.rowVersion ||
    (event.actorKind === "user"
      ? event.actorId !== null
      : event.actorKind !== "registered_project" || event.actorId !== handoff.recipientProjectId)
  )
    return corrupt("Format-4 reporting event association is invalid");
  const metadata = event.metadata;
  const revision = event.eventType === "HANDOFF_COMMENT_SET" ? "targetRevision" : "revision";
  const fields =
    event.eventType === "HANDOFF_COMMENT_SET"
      ? ["targetRevision", "purpose", "active", "authorKind"]
      : event.eventType === "HANDOFF_REVISION_READ"
        ? ["revision", "artifactId"]
        : ["revision"];
  if (
    !memoObject(metadata, fields) ||
    !isMemoRowVersion(metadata[revision]) ||
    (metadata[revision] as number) > handoff.revision
  )
    return corrupt("Format-4 reporting event metadata is invalid");
  if (
    event.eventType === "HANDOFF_COMMENT_SET" &&
    ((metadata.purpose !== "general" && metadata.purpose !== "change_request") ||
      typeof metadata.active !== "boolean" ||
      (metadata.active && metadata.purpose !== "change_request") ||
      metadata.authorKind !== event.actorKind)
  )
    return corrupt("Format-4 comment event provenance is invalid");
  if (
    event.eventType === "HANDOFF_REVISION_READ" &&
    (typeof metadata.artifactId !== "string" ||
      !/^(?:a[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(metadata.artifactId))
  )
    return corrupt("Format-4 reading event Artifact identity is invalid");
  if (
    event.eventType === "HANDOFF_REVISION_READ" &&
    metadata.revision === handoff.revision &&
    handoff.deletedAt === null &&
    handoff.currentArtifactId !== null &&
    metadata.artifactId !== handoff.currentArtifactId
  )
    return corrupt("Format-4 reading event Artifact does not match the current Revision");
  return ok(undefined);
}

export function redactSnapshotDataV4(data: SnapshotDataV4): SnapshotDataV4 {
  const common = redactSnapshotDataV3({ ...data, handoffs: [] });
  return {
    ...common,
    handoffs: data.handoffs.map(({ senderPathSnapshot: _path, ...handoff }) => handoff),
  };
}

/** Reuse frozen common content bytes; replace each Handoff shard with its v4 record. */
export function snapshotFilesV4(
  data: SnapshotDataV4,
): Result<{ files: SnapshotFile[]; manifest: HandoffReportingSnapshotManifest }, AppError> {
  for (const handoff of data.handoffs) {
    const valid = validateSnapshotHandoffV4(handoff);
    if (!valid.ok) return valid;
  }
  for (const event of data.events) {
    const valid = validateReportingSnapshotEvent(event, data.handoffs);
    if (!valid.ok) return valid;
  }
  const legacy = snapshotFilesV3(reportingSnapshotDataBase(data));
  if (!legacy.ok) return legacy;
  const manifest: HandoffReportingSnapshotManifest = { ...legacy.value.manifest, formatVersion: 4 };
  const shards = new Map(data.handoffs.map((handoff) => [handoffShardPath(handoff.id), canonicalJson(handoff)]));
  return ok({
    manifest,
    files: legacy.value.files.map((file) =>
      file.path === "manifest.json"
        ? { ...file, content: canonicalJson(manifest) }
        : shards.has(file.path)
          ? { ...file, content: shards.get(file.path) as string }
          : file,
    ),
  });
}
