import { appError, err, ok, type AppError, type Result } from "./errors";
import type { ArtifactStore } from "./artifacts";

/**
 * The materialization read path and the exhaustive integrity verifier
 * (VLT-023, SEC-014, section 20.7): a read of an Artifact whose row still says
 * `materialized = 0` returns `ARTIFACT_MATERIALIZING` because the row is real
 * and the next drain finishes the work; a current Artifact that is missing from
 * its storageKey or whose recomputed SHA-256 differs from the recorded value is
 * handled the same way and reported as `ARTIFACT_CORRUPTED`. No process sweeps
 * checksums at start-up: the drain never hashes, and the exhaustive pass runs
 * only inside `doctor` through `artifacts.checksums` and inside
 * `sorage vault verify`.
 */
export interface ArtifactReadRecord {
  storageKey: string;
  /** The recorded lowercase hexadecimal SHA-256. */
  sha256: string;
  /** False between the transaction that created the row and the completion commit. */
  materialized: boolean;
}

export interface ReadArtifactOptions {
  /** The configured `artifact.verifyChecksumOnFetch`; off by default on the hot path. */
  verifyChecksum: boolean;
}

/**
 * Resolves the read-only in-Vault path of a current Artifact (section 11.3): a
 * not-yet-materialized Artifact fails with `ARTIFACT_MATERIALIZING` at exit 75
 * and succeeds after the drain flips the row; a missing Artifact fails with
 * `ARTIFACT_CORRUPTED`, and so does a mismatched one when the caller enabled
 * checksum verification for this read.
 */
export function resolveArtifactForRead(
  ports: { artifactStore: ArtifactStore },
  record: ArtifactReadRecord,
  options: ReadArtifactOptions,
): Result<{ path: string }, AppError> {
  if (!record.materialized) {
    return err(
      appError(
        "ARTIFACT_MATERIALIZING",
        `The current Artifact ${record.storageKey} has not reached its storageKey yet.`,
        { storageKey: record.storageKey },
      ),
    );
  }
  const present = ports.artifactStore.exists(record.storageKey);
  if (!present.ok) return err(present.error);
  if (!present.value) {
    return err(missingArtifact(record));
  }
  if (options.verifyChecksum) {
    const actual = ports.artifactStore.checksum(record.storageKey);
    if (!actual.ok) return err(actual.error);
    if (!checksumsEqual(actual.value, record.sha256)) {
      return err(mismatchedArtifact(record, actual.value));
    }
  }
  const path = ports.artifactStore.pathOf(record.storageKey);
  if (!path.ok) return err(path.error);
  return ok({ path: path.value });
}

/** One recorded current Artifact the exhaustive pass found a problem with. */
export interface ArtifactIntegrityFinding {
  storageKey: string;
  recordedSha256: string;
  problem: "missing" | "mismatched";
  message: string;
}

/**
 * The exhaustive verification behind `doctor`'s `artifacts.checksums` and
 * `sorage vault verify` (VLT-023, SEC-014): every recorded current Artifact must
 * exist at its storageKey and match its recorded SHA-256. A Missing Artifact and
 * a Mismatched Artifact are reported alike, because both mean the recorded bytes
 * are gone; the caller classifies severity and attaches recovery text.
 */
export function verifyVaultArtifacts(
  ports: { artifactStore: ArtifactStore },
  records: Array<{ storageKey: string; sha256: string }>,
): Result<ArtifactIntegrityFinding[], AppError> {
  const findings: ArtifactIntegrityFinding[] = [];
  for (const record of records) {
    const present = ports.artifactStore.exists(record.storageKey);
    if (!present.ok) return err(present.error);
    if (!present.value) {
      findings.push({
        storageKey: record.storageKey,
        recordedSha256: record.sha256,
        problem: "missing",
        message: `The current Artifact ${record.storageKey} is missing from its storageKey.`,
      });
      continue;
    }
    const actual = ports.artifactStore.checksum(record.storageKey);
    if (!actual.ok) return err(actual.error);
    if (!checksumsEqual(actual.value, record.sha256)) {
      findings.push({
        storageKey: record.storageKey,
        recordedSha256: record.sha256,
        problem: "mismatched",
        message: `The current Artifact ${record.storageKey} does not match its recorded SHA-256.`,
      });
    }
  }
  return ok(findings);
}

function missingArtifact(record: ArtifactReadRecord): AppError {
  return appError("ARTIFACT_CORRUPTED", `The current Artifact ${record.storageKey} is missing from its storageKey.`, {
    storageKey: record.storageKey,
    problem: "missing",
  });
}

function mismatchedArtifact(record: ArtifactReadRecord, actual: string): AppError {
  return appError(
    "ARTIFACT_CORRUPTED",
    `The current Artifact ${record.storageKey} does not match its recorded SHA-256.`,
    { storageKey: record.storageKey, problem: "mismatched", recordedSha256: record.sha256, actualSha256: actual },
  );
}

function checksumsEqual(actual: string, recorded: string): boolean {
  return actual.toLowerCase() === recorded.toLowerCase();
}
