import type { AppError } from "./errors";
import { appError, err, ok, type Result } from "./errors";
import type { Memo } from "./memos";

/**
 * The deterministic snapshot model of sections 26 and 27 of
 * interfaces-and-operations.md (BKP-003, BKP-005, BKP-007, BKP-008, BKP-023,
 * BKP-024). The export is a pure function of the rows it read inside one
 * consistent SQLite read transaction: object keys sort lexicographically at
 * every level, JSON uses two-space indentation with LF line endings and one
 * trailing newline, `events.jsonl` is one compact object per line ordered by
 * `createdAt` then `id`, and no wall-clock timestamp, hostname, username, pid,
 * duration, or tool version appears anywhere, `manifest.json` included. The
 * same purity is what lets `backup restore` rebuild the ledger exactly as
 * exported instead of reconstructing values it no longer has.
 */

/** Legacy generation retained for historical fixtures and rollback readers. */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** One Project Binding as the snapshot records it; `directory` never appears while redaction is on. */
export interface SnapshotBinding {
  id: string;
  installationId: string;
  bindingKind: string;
  directory?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotProject {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  bindings: SnapshotBinding[];
}

export interface SnapshotArtifact {
  id: string;
  handoffId: string;
  storageKey: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  importedFromPath: string | null;
  materialized: boolean;
  createdAt: string;
}

export interface SnapshotHandoff {
  id: string;
  dispatchGroupId: string | null;
  supersedesHandoffId: string | null;
  title: string;
  senderKind: string;
  senderProjectId: string | null;
  senderWorkspaceKey: string | null;
  /** Omitted while `redactWorkspacePaths` is enabled, which is its default (BKP-003). */
  senderPathSnapshot?: string | null;
  recipientProjectId: string;
  currentArtifactId: string | null;
  revision: number;
  rowVersion: number;
  reviewState: string;
  acceptedRevision: number | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  withdrawnAt: string | null;
  consecutiveNoChangeResolutions: number;
  firstFetchedAt: string | null;
  reviewEngagedAt: string | null;
  pinned: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  artifact: SnapshotArtifact | null;
  reviewNote: SnapshotReviewNote | null;
  /** Every Deletion Request of the Handoff, pending and resolved alike, newest last. */
  deletionRequests: SnapshotDeletionRequest[];
}

export interface SnapshotReviewNote {
  handoffId: string;
  authorKind: string;
  authorProjectId: string | null;
  targetRevision: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotDeletionRequest {
  id: string;
  handoffId: string;
  requestedByKind: string;
  requestedById: string | null;
  reason: string | null;
  status: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedByUser: string | null;
  resolutionNote: string | null;
}

export interface SnapshotEvent {
  id: string;
  memoId?: string | null;
  handoffId: string | null;
  eventType: string;
  actorKind: string;
  actorId: string | null;
  rowVersion: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** The complete export set read inside one transaction. */
export interface SnapshotData {
  projects: SnapshotProject[];
  handoffs: SnapshotHandoff[];
  events: SnapshotEvent[];
  memos?: Memo[];
}

export interface SnapshotManifest {
  formatVersion: number;
  counts: { projects: number; handoffs: number; events: number; artifacts: number; memos?: number };
  memoDigests?: Record<string, string>;
}

/** One snapshot file with its exact destination-relative path and final bytes. */
export interface SnapshotFile {
  path: string;
  content: string;
}

const PATH_FIELD_KEY = /(?:path|dir|directory)$/i;

/**
 * Recursively drops metadata keys that name a path or directory
 * (`fromPath`, `toPath`, `directory`, …), because those are the machine-local
 * values section 26 excludes from the exported ledger while stable
 * identifiers such as `storageKey` and `workspaceKey` stay (BKP-003, SEC-011).
 */
export function redactEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (PATH_FIELD_KEY.test(key)) continue;
    redacted[key] = isPlainObject(value) ? redactEventMetadata(value) : value;
  }
  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sorts object keys lexicographically at every level and prints two-space JSON with a trailing LF. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** The one-line form `events.jsonl` uses: sorted keys, compact separators, LF-terminated. */
export function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(sortKeys(value))}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/**
 * Applies the `gitBackup.snapshot.redactWorkspacePaths` policy (BKP-003): the
 * sender path snapshot, every binding directory, and every path field inside
 * event metadata is removed, so the exported ledger is the audit record minus
 * machine-local paths. Bindings survive as rows — they still prove a Project
 * was bound and of which kind — and restore never invents the removed values
 * back.
 */
export function redactSnapshotData(data: SnapshotData): SnapshotData {
  return {
    ...(data.memos === undefined ? {} : { memos: data.memos }),
    projects: data.projects.map((project) => ({
      ...project,
      bindings: project.bindings.map(({ directory: _directory, ...binding }) => binding),
    })),
    handoffs: data.handoffs.map(({ senderPathSnapshot: _senderPathSnapshot, ...handoff }) => handoff),
    events: data.events.map((event) => ({ ...event, metadata: redactEventMetadata(event.metadata) })),
  };
}

/** The shard path of one Handoff: the first two hex characters of its id (section 6). */
export function handoffShardPath(handoffId: string): string {
  return `handoffs/${handoffId.slice(0, 2)}/${handoffId}.json`;
}

/** The derived counts `manifest.json` carries and nothing else (BKP-024). */
export function snapshotManifest(data: SnapshotData): SnapshotManifest {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    counts: {
      projects: data.projects.length,
      handoffs: data.handoffs.length,
      events: data.events.length,
      artifacts: data.handoffs.filter((handoff) => handoff.artifact !== null).length,
    },
  };
}

/** Computes every snapshot file's exact bytes in a deterministic order. */
export function snapshotFiles(data: SnapshotData): SnapshotFile[] {
  const files: SnapshotFile[] = [{ path: "projects.json", content: canonicalJson(data.projects) }];
  const byId = [...data.handoffs].sort((a, b) => compareStrings(a.id, b.id));
  for (const handoff of byId) {
    files.push({ path: handoffShardPath(handoff.id), content: canonicalJson(handoff) });
  }
  const lines = [...data.events]
    .sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id))
    .map((event) => canonicalJsonLine(event))
    .join("");
  files.push({ path: "events.jsonl", content: lines });
  files.push({ path: "manifest.json", content: canonicalJson(snapshotManifest(data)) });
  return files;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads `manifest.json` bytes; used by restore to cross-check the derived counts. */
export function parseSnapshotManifest(raw: string): Result<SnapshotManifest, AppError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return err(appError("VAULT_INTEGRITY_ERROR", "The backup manifest is not valid JSON."));
  }
  if (!isPlainObject(parsed)) {
    return err(appError("VAULT_INTEGRITY_ERROR", "The backup manifest is not a JSON object."));
  }
  const formatVersion = parsed.formatVersion;
  if (formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    return err(
      appError(
        "VAULT_SCHEMA_UNSUPPORTED",
        `The backup snapshot format version ${String(formatVersion)} is newer than this build's ${SNAPSHOT_FORMAT_VERSION}; Sorage never downgrades a snapshot.`,
      ),
    );
  }
  const counts = parsed.counts;
  if (
    !isPlainObject(counts) ||
    !isCount(counts.projects) ||
    !isCount(counts.handoffs) ||
    !isCount(counts.events) ||
    !isCount(counts.artifacts)
  ) {
    return err(appError("VAULT_INTEGRITY_ERROR", "The backup manifest counts are malformed."));
  }
  return ok({
    formatVersion,
    counts: {
      projects: counts.projects,
      handoffs: counts.handoffs,
      events: counts.events,
      artifacts: counts.artifacts,
    },
  });
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
