import { appError, err, ok, type AppError, type Result } from "./errors";

/**
 * The ArtifactStore port and the storage-key contract (VLT-004 to VLT-007, VLT-020,
 * NFR-005, ADR-0013): an import is a streaming copy into `staging/` that hashes in
 * the same pass and aborts the moment the size limit is crossed, a storageKey is
 * the sole path authority for an Artifact's bytes, and the `<artifact-id>` segment
 * gives every import a fresh slot so an in-place overwrite is structurally
 * impossible. Core owns the path scheme and its validation; the filesystem
 * mechanics live in adapters.
 */
export interface StagedFile {
  /** The staged path under `<Vault>/staging/`. */
  stagingPath: string;
  sizeBytes: number;
  /** Lowercase hexadecimal SHA-256 of the copied bytes. */
  sha256: string;
}

export interface StageRequest {
  sourcePath: string;
  /** The configured `artifact.maxBytes`; the copy aborts mid-stream past it. */
  maxBytes: number;
}

export interface ActivateRequest {
  stagingPath: string;
  storageKey: string;
}

export interface ArtifactStore {
  /**
   * Streams a copy of the source into `staging/` with a bounded buffer, computing
   * SHA-256 during the copy, and aborts with `ARTIFACT_TOO_LARGE` the moment the
   * stream crosses `maxBytes`, leaving no staged file behind. The source is never
   * moved, modified, or deleted (VLT-004, VLT-005).
   */
  stage(request: StageRequest): Result<StagedFile, AppError>;
  /**
   * Places a staged file at its storageKey path inside the Vault. Refuses to
   * overwrite an existing path, so a repeated or colliding key can never replace
   * bytes a record already names (VLT-020).
   */
  activate(request: ActivateRequest): Result<{ path: string }, AppError>;
  /** Resolves a storageKey to its path inside this Vault. */
  pathOf(storageKey: string): Result<string, AppError>;
  /** Reports whether the bytes at a storageKey are present (SEC-014). */
  exists(storageKey: string): Result<boolean, AppError>;
  /** Recomputes the SHA-256 of the bytes at a storageKey with a bounded buffer (SEC-014). */
  checksum(storageKey: string): Result<string, AppError>;
  /**
   * Unlinks the bytes at a storageKey and fsyncs the parent directory (VLT-012): the
   * committed unlink intent's execution arm for revision and deletion approval.
   */
  remove(storageKey: string): Result<void, AppError>;
}

export interface StorageKeyParts {
  handoffId: string;
  artifactId: string;
  storedName: string;
}

/** A storageKey segment may never carry a path separator, a traversal dot, or a control byte. */
export function isValidStorageKeySegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Builds `artifacts/<handoff-id>/<artifact-id>/<stored-name>` (VLT-020). Every
 * segment is validated, so no traversal or separator can ride a segment into a
 * managed path; the caller supplies the fresh `artifact-id` that makes the slot
 * unique (ADR-0013).
 */
export function buildStorageKey(parts: StorageKeyParts): Result<string, AppError> {
  const named: Array<[keyof StorageKeyParts, string]> = [
    ["handoffId", parts.handoffId],
    ["artifactId", parts.artifactId],
    ["storedName", parts.storedName],
  ];
  for (const [name, value] of named) {
    if (typeof value !== "string" || !isValidStorageKeySegment(value)) {
      return err(
        appError("INTERNAL_ERROR", `The storageKey segment '${name}' is not a safe path segment: ${String(value)}.`, {
          segment: name,
        }),
      );
    }
  }
  return ok(`artifacts/${parts.handoffId}/${parts.artifactId}/${parts.storedName}`);
}

/** True when a candidate is a managed `artifacts/` key with safe segments. */
export function isManagedStorageKey(candidate: string): boolean {
  if (!candidate.startsWith("artifacts/")) return false;
  const segments = candidate.split("/").slice(1);
  if (segments.length < 3) return false;
  return segments.every((segment) => isValidStorageKeySegment(segment));
}
