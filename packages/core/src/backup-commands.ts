import {
  parseSnapshotManifest,
  redactSnapshotData,
  type SnapshotData,
  type SnapshotFile,
  type SnapshotManifest,
  snapshotFiles,
  snapshotManifest,
} from "./backup-snapshot";
import { type AppError, appError, err, ok, type Result } from "./errors";
import type { VaultMarker } from "./vault";

/**
 * The TASK-052 use cases (BKP-003, BKP-005, BKP-007, BKP-008, BKP-021,
 * BKP-023, BKP-024, VLT-019, RUN-014, SEC-011, SEC-014). `exportSnapshot` is
 * the deterministic export the later backup-run tasks commit; `backupRestore`
 * is the audited importer that rebuilds an empty installation from a Vault
 * copy, adopts the marker's `installationId`, and never invents redacted
 * local paths back.
 */

export interface BackupExportPorts {
  vaultPath: string;
  /** The `gitBackup.snapshot.redactWorkspacePaths` policy, default `true` (BKP-003). */
  redactWorkspacePaths: boolean;
  /** Reads every snapshot row inside one consistent SQLite read transaction (BKP-007). */
  readSnapshotData(): Result<SnapshotData, AppError>;
  /** Writes the snapshot tree through temporary files and an atomic replacement (BKP-008). */
  writeSnapshotTree(files: SnapshotFile[]): Result<void, AppError>;
}

export interface BackupExportReport {
  files: number;
  counts: { projects: number; handoffs: number; events: number; artifacts: number };
  redactedWorkspacePaths: boolean;
}

export function exportSnapshot(ports: BackupExportPorts): Result<BackupExportReport, AppError> {
  const read = ports.readSnapshotData();
  if (!read.ok) return err(read.error);
  const data = ports.redactWorkspacePaths ? redactSnapshotData(read.value) : read.value;
  const files = snapshotFiles(data);
  const written = ports.writeSnapshotTree(files);
  if (!written.ok) return err(written.error);
  return ok({
    files: files.length,
    counts: snapshotManifest(data).counts,
    redactedWorkspacePaths: ports.redactWorkspacePaths,
  });
}

export interface RestorePlan {
  dryRun: true;
  sourcePath: string;
  adoptedInstallationId: string;
  wouldCreate: { projects: number; handoffs: number; reviewNotes: number; artifacts: number; events: number };
}

export interface RestoreOutcome {
  dryRun: false;
  sourcePath: string;
  adoptedInstallationId: string;
  restored: { projects: number; handoffs: number; reviewNotes: number; artifacts: number; events: number };
  /** Bindings are machine-local and never restored; the User re-binds (section 32). */
  bindingsRestored: 0;
  events: ["VAULT_ADOPTED", "RESTORE_COMPLETED"];
  apiTokenRegenerated: true;
}

export interface BackupRestorePorts {
  sourcePath: string;
  installationId: string;
  /** True while a daemon holds its lifetime lock; restore requires it stopped (section 32). */
  daemonRunning(): Result<boolean, AppError>;
  /** `vault-move.lock`, so every other storage mutation pauses with SERVICE_PAUSED (RUN-014). */
  lock: {
    acquire(): Result<{ release: () => void }, AppError>;
  };
  /** Parses the source Vault marker; a newer schemaVersion is VAULT_SCHEMA_UNSUPPORTED (VLT-019). */
  readSourceMarker(): Result<VaultMarker, AppError>;
  /** Reads and parses `snapshots/` from the source Vault into one snapshot set. */
  readSourceSnapshot(): Result<SnapshotData, AppError>;
  /** Cross-checks the manifest counts against the parsed snapshot (BKP-005). */
  readSourceManifest(): Result<SnapshotManifest, AppError>;
  /** False once any domain row or ledger row exists; the empty rule of section 32 (BKP-021). */
  targetIsEmpty(): Result<boolean, AppError>;
  /**
   * Hashes every materialized Artifact's source bytes against its recorded
   * SHA-256; a missing file or one altered byte is ARTIFACT_CORRUPTED and
   * aborts the restore (SEC-014, VLT-023).
   */
  verifyArtifacts(data: SnapshotData): Result<{ verified: number }, AppError>;
  /** Copies Artifact bytes into the target Vault, re-verifying in pass and setting 0444. */
  copyArtifacts(data: SnapshotData): Result<{ copied: number }, AppError>;
  /** Rewrites the target Vault marker with the adopted installationId (VLT-019). */
  adoptMarker(marker: VaultMarker): Result<void, AppError>;
  /** Adopts the installationId in config.yaml, fenced on the etag that was read. */
  adoptInstallationId(installationId: string): Result<void, AppError>;
  /**
   * Rebuilds Projects, Handoffs, Review Notes, deletion requests, and the
   * exported ledger verbatim in one write transaction, swaps the installation
   * identity, and appends VAULT_ADOPTED followed by RESTORE_COMPLETED.
   */
  rebuildDatabase(data: SnapshotData, marker: VaultMarker): Result<void, AppError>;
  /** Regenerates the API token; it is the only credential restore creates (BKP-021). */
  regenerateApiToken(): Result<void, AppError>;
}

function snapshotProblem(message: string): Result<never, AppError> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

/**
 * Validates the internal consistency restore depends on before any write:
 * every Project reference resolves, the ledger only names known Handoffs, and
 * the manifest counts match what was parsed, so a truncated or hand-edited
 * snapshot fails as `VAULT_INTEGRITY_ERROR` rather than as a foreign-key
 * error halfway through the rebuild.
 */
export function validateSnapshot(
  data: SnapshotData,
  manifest: {
    counts: { projects: number; handoffs: number; events: number; artifacts: number };
  },
): Result<{ reviewNotes: number }, AppError> {
  const projectIds = new Set(data.projects.map((project) => project.id));
  for (const handoff of data.handoffs) {
    if (handoff.recipientProjectId !== null && !projectIds.has(handoff.recipientProjectId)) {
      return snapshotProblem(
        `Handoff ${handoff.id} names recipient project ${handoff.recipientProjectId}, which the snapshot does not contain.`,
      );
    }
    if (handoff.senderProjectId !== null && !projectIds.has(handoff.senderProjectId)) {
      return snapshotProblem(
        `Handoff ${handoff.id} names sender project ${handoff.senderProjectId}, which the snapshot does not contain.`,
      );
    }
  }
  const handoffIds = new Set(data.handoffs.map((handoff) => handoff.id));
  for (const event of data.events) {
    if (event.handoffId !== null && !handoffIds.has(event.handoffId)) {
      return snapshotProblem(
        `Ledger event ${event.id} names handoff ${event.handoffId}, which the snapshot does not contain.`,
      );
    }
  }
  const artifactCount = data.handoffs.filter((handoff) => handoff.artifact !== null).length;
  const counts = snapshotManifest(data).counts;
  if (
    counts.projects !== manifest.counts.projects ||
    counts.handoffs !== manifest.counts.handoffs ||
    counts.events !== manifest.counts.events ||
    artifactCount !== manifest.counts.artifacts
  ) {
    return snapshotProblem(
      `The backup manifest counts do not match the snapshot content: manifest ${JSON.stringify(manifest.counts)} against parsed ${JSON.stringify({ ...counts, artifacts: artifactCount })}.`,
    );
  }
  return ok({ reviewNotes: data.handoffs.filter((handoff) => handoff.reviewNote !== null).length });
}

/**
 * The section-32 sequence: refuse a running daemon, hold `vault-move.lock`,
 * validate the source marker and snapshot, refuse a populated target, verify
 * every checksum, and only then — never in `--dry-run` — adopt the marker and
 * configuration, rebuild the database in one transaction, and regenerate the
 * API token. The writes run in the crash-convergent order: every failure
 * before the rebuild leaves the target installation still empty, so a retry
 * converges instead of wedging between two identities.
 */
export function backupRestore(
  ports: BackupRestorePorts,
  options: { dryRun: boolean },
): Result<RestorePlan | RestoreOutcome, AppError> {
  const daemon = ports.daemonRunning();
  if (!daemon.ok) return err(daemon.error);
  if (daemon.value) {
    return err(
      appError(
        "SERVICE_PAUSED",
        "The daemon is running; sorage backup restore requires the daemon stopped, because it rebuilds storage underneath it.",
        { suggestedCommand: "sorage daemon stop" },
      ),
    );
  }

  const lock = ports.lock.acquire();
  if (!lock.ok) return err(lock.error);

  let outcome: Result<RestorePlan | RestoreOutcome, AppError>;
  try {
    outcome = restoreUnderLock(ports, options);
  } finally {
    lock.value.release();
  }
  return outcome;
}

function restoreUnderLock(
  ports: BackupRestorePorts,
  options: { dryRun: boolean },
): Result<RestorePlan | RestoreOutcome, AppError> {
  const marker = ports.readSourceMarker();
  if (!marker.ok) return err(marker.error);
  const data = ports.readSourceSnapshot();
  if (!data.ok) return err(data.error);
  const manifest = ports.readSourceManifest();
  if (!manifest.ok) return err(manifest.error);
  const valid = validateSnapshot(data.value, manifest.value);
  if (!valid.ok) return err(valid.error);

  const empty = ports.targetIsEmpty();
  if (!empty.ok) return err(empty.error);
  if (!empty.value) {
    return err(
      appError(
        "RESTORE_TARGET_NOT_EMPTY",
        "The target installation already holds Sorage data; restore rebuilds only an empty installation.",
        { suggestedCommand: "sorage init (in a fresh SORAGE_HOME), then sorage backup restore --from <vault-path>" },
      ),
    );
  }

  const verified = ports.verifyArtifacts(data.value);
  if (!verified.ok) return err(verified.error);

  const plan: RestorePlan = {
    dryRun: true,
    sourcePath: ports.sourcePath,
    adoptedInstallationId: marker.value.installationId,
    wouldCreate: {
      projects: data.value.projects.length,
      handoffs: data.value.handoffs.length,
      reviewNotes: valid.value.reviewNotes,
      artifacts: data.value.handoffs.filter((handoff) => handoff.artifact !== null).length,
      events: data.value.events.length,
    },
  };
  if (options.dryRun) return ok(plan);

  const copied = ports.copyArtifacts(data.value);
  if (!copied.ok) return err(copied.error);
  // The marker and the configuration adopt adjacent to each other and before
  // the rebuild: a crash between them leaves the target still empty of domain
  // rows, so a retry re-reads the source, re-adopts, and converges.
  const marked = ports.adoptMarker(marker.value);
  if (!marked.ok) return err(marked.error);
  const configured = ports.adoptInstallationId(marker.value.installationId);
  if (!configured.ok) return err(configured.error);
  const rebuilt = ports.rebuildDatabase(data.value, marker.value);
  if (!rebuilt.ok) return err(rebuilt.error);
  const token = ports.regenerateApiToken();
  if (!token.ok) return err(token.error);

  return ok({
    ...plan,
    dryRun: false,
    restored: plan.wouldCreate,
    bindingsRestored: 0,
    events: ["VAULT_ADOPTED", "RESTORE_COMPLETED"],
    apiTokenRegenerated: true,
  });
}
