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
import { GIT_ARGS, type GitClient, gitStateConflict, isRuntimeTrackedPath } from "./git";
import type { VaultMarker } from "./vault";
import { type VaultVerifyPorts, vaultVerify } from "./vault-commands";

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

/**
 * Vault Git initialization (TASK-053, INIT-007, BKP-001, BKP-022): Sorage
 * initializes a repository in the Vault only when none exists, sets
 * `core.autocrlf=false` repository-locally, and re-asserts the managed policy
 * files idempotently. An existing repository — including an unrelated one — is
 * reported, never reinitialized and never reconfigured, because rewriting a
 * repository the user brought with them is exactly the destructive surprise
 * the safety rules forbid.
 */
export interface VaultGitPorts {
  vaultPath: string;
  /** True when a `.git` exists at the Vault path, whatever created it. */
  repositoryExists(): Result<boolean, AppError>;
  /** Re-runs the idempotent Vault initializer so the policy files and marker are re-asserted (VLT-024). */
  reassertPolicyFiles(): Result<void, AppError>;
  git: GitClient;
}

export interface VaultGitOutcome {
  /** True when this call created the repository. */
  initialized: boolean;
  /** True when an existing repository was found and left untouched. */
  existingReported: boolean;
}

export function ensureVaultGitRepository(ports: VaultGitPorts): Result<VaultGitOutcome, AppError> {
  const existing = ports.repositoryExists();
  if (!existing.ok) return err(existing.error);
  if (existing.value) {
    // An existing repository is adoption-shaped, not initialization-shaped:
    // Sorage verifies it but never rewrites its history or configuration.
    return ok({ initialized: false, existingReported: true });
  }
  const init = ports.git.run({ cwd: ports.vaultPath, args: GIT_ARGS.init() });
  if (!init.ok) return err(init.error);
  if (init.value.exitCode !== 0) return gitStateConflict("init", init.value);
  const autocrlf = ports.git.run({
    cwd: ports.vaultPath,
    args: GIT_ARGS.configSet("core.autocrlf", "false"),
  });
  if (!autocrlf.ok) return err(autocrlf.error);
  if (autocrlf.value.exitCode !== 0) return gitStateConflict("config core.autocrlf=false", autocrlf.value);
  const reasserted = ports.reassertPolicyFiles();
  if (!reasserted.ok) return err(reasserted.error);
  return ok({ initialized: true, existingReported: false });
}

/** The database-side census the backup verification cross-checks the manifest against. */
export interface BackupCensus {
  projects: number;
  handoffs: number;
  events: number;
  artifacts: number;
  /** Live Handoffs whose current Artifact has `materialized = 0`. */
  materializing: number;
  /** Tombstoned Handoffs that still hold an active Artifact row. */
  deletedWithArtifact: number;
}

export interface BackupVerifyPorts extends VaultVerifyPorts {
  git: GitClient;
  /** The configured `gitBackup.push.branch`; the repository must sit on it (section 31). */
  configuredBranch: string;
  /** True when a `.git` exists at the Vault path. */
  repositoryExists(): Result<boolean, AppError>;
  /** Merge and rebase indicators read from the repository's state directories. */
  repositorySignals(): Result<{ mergeInProgress: boolean; rebaseInProgress: boolean }, AppError>;
  census(): Result<BackupCensus, AppError>;
  /** Reads `snapshots/manifest.json`; null when the file is absent. */
  readManifest(): Result<SnapshotManifest | null, AppError>;
  /** Counts the exported Handoff shard files under `snapshots/handoffs/`. */
  countShards(): Result<number, AppError>;
  /** Counts the ledger lines in `snapshots/events.jsonl`. */
  countEventLines(): Result<number, AppError>;
}

export interface BackupVerifyReport {
  findings: string[];
  /** Non-fatal conditions the run reports without failing, today only the unmaterialized Artifact (section 31). */
  warnings: string[];
  checked: {
    vault: { artifacts: number; recordedArtifacts: number; stagedFiles: number };
    manifest: { present: boolean; projects: number; handoffs: number; events: number; artifacts: number };
    trackedFiles: number;
  };
}

/**
 * `sorage backup verify` (TASK-053, BKP-022, section 31): every `vault verify`
 * check plus the Git-backed ones — the three `.gitattributes` lines,
 * `core.autocrlf=false`, the managed branch, no merge or rebase in progress,
 * no unrelated staged work, no runtime file ever tracked, and a manifest whose
 * counts agree with both the database census and the exported tree. The
 * command never rewrites history and never repairs; it reports, and an
 * unmaterialized current Artifact is a warning rather than a failure.
 */
export function backupVerify(ports: BackupVerifyPorts, options: { now: Date }): Result<BackupVerifyReport, AppError> {
  const vault = vaultVerify(ports, options);
  if (!vault.ok) return err(vault.error);
  const findings = [...vault.value.findings];
  const warnings: string[] = [];

  const census = ports.census();
  if (!census.ok) return err(census.error);
  if (census.value.materializing > 0) {
    warnings.push(
      `${census.value.materializing} Handoff(s) have a current Artifact with materialized = 0; they are skipped by this verification until a drain materializes them.`,
    );
  }
  if (census.value.deletedWithArtifact > 0) {
    findings.push(
      `${census.value.deletedWithArtifact} deleted Handoff(s) still hold an active Artifact row; deletion approval removes the current Artifact row.`,
    );
  }

  const existing = ports.repositoryExists();
  if (!existing.ok) return err(existing.error);
  let trackedCount = 0;
  if (!existing.value) {
    findings.push("The Vault has no Git repository; re-run sorage init --initialize-git to initialize one.");
  } else {
    const autocrlf = ports.git.run({ cwd: ports.vaultPath, args: GIT_ARGS.configGet("core.autocrlf") });
    if (!autocrlf.ok) return err(autocrlf.error);
    const value = autocrlf.value.exitCode === 0 ? autocrlf.value.stdout.trim() : "";
    if (value !== "false") {
      findings.push(
        `core.autocrlf is '${value === "" ? "unset" : value}' in the Vault repository; run git config core.autocrlf false inside the Vault, because a clone with autocrlf true would rewrite managed bytes and break their checksums.`,
      );
    }
    const branch = ports.git.run({ cwd: ports.vaultPath, args: GIT_ARGS.currentBranch() });
    if (!branch.ok) return err(branch.error);
    const branchName = branch.value.exitCode === 0 ? branch.value.stdout.trim() : "";
    if (branchName !== ports.configuredBranch) {
      findings.push(
        `The Vault repository is on '${branchName === "" ? "a detached HEAD" : branchName}', not the configured branch '${ports.configuredBranch}'; Sorage commits only on the configured branch.`,
      );
    }
    const signals = ports.repositorySignals();
    if (!signals.ok) return err(signals.error);
    if (signals.value.mergeInProgress) {
      findings.push("A merge is in progress in the Vault repository; resolve it manually, Sorage never merges.");
    }
    if (signals.value.rebaseInProgress) {
      findings.push("A rebase is in progress in the Vault repository; resolve it manually, Sorage never rebases.");
    }
    const staged = ports.git.run({ cwd: ports.vaultPath, args: GIT_ARGS.stagedFiles() });
    if (!staged.ok) return err(staged.error);
    const stagedPaths = staged.value.stdout.split("\n").filter((line) => line !== "");
    if (stagedPaths.length > 0) {
      findings.push(
        `The index holds ${stagedPaths.length} staged file(s) outside a backup run; resolve them manually, because Sorage stages only its managed pathspecs.`,
      );
    }
    const tracked = ports.git.run({ cwd: ports.vaultPath, args: GIT_ARGS.lsFiles() });
    if (!tracked.ok) return err(tracked.error);
    const trackedPaths = tracked.value.stdout.split("\n").filter((line) => line !== "");
    trackedCount = trackedPaths.length;
    const runtimeTracked = trackedPaths.filter(isRuntimeTrackedPath);
    if (runtimeTracked.length > 0) {
      findings.push(
        `Runtime file(s) are tracked in the Vault repository: ${runtimeTracked.join(", ")}; the database, logs, tokens, and credentials are never committed (BKP-004).`,
      );
    }
  }

  const manifest = ports.readManifest();
  if (!manifest.ok) return err(manifest.error);
  let manifestChecked = { present: false, projects: 0, handoffs: 0, events: 0, artifacts: 0 };
  if (manifest.value === null) {
    findings.push("snapshots/manifest.json is missing; a backup run has not exported the current snapshots yet.");
  } else {
    manifestChecked = { present: true, ...manifest.value.counts };
    const shards = ports.countShards();
    if (!shards.ok) return err(shards.error);
    const eventLines = ports.countEventLines();
    if (!eventLines.ok) return err(eventLines.error);
    if (manifest.value.counts.projects !== census.value.projects) {
      findings.push(
        `The manifest counts ${manifest.value.counts.projects} project(s) against the database's ${census.value.projects}.`,
      );
    }
    if (manifest.value.counts.handoffs !== census.value.handoffs || shards.value !== census.value.handoffs) {
      findings.push(
        `The manifest counts ${manifest.value.counts.handoffs} handoff(s), the shard tree holds ${shards.value}, and the database holds ${census.value.handoffs}.`,
      );
    }
    if (manifest.value.counts.events !== census.value.events || eventLines.value !== census.value.events) {
      findings.push(
        `The manifest counts ${manifest.value.counts.events} ledger event(s), the ledger export holds ${eventLines.value}, and the database holds ${census.value.events}.`,
      );
    }
    if (manifest.value.counts.artifacts !== census.value.artifacts) {
      findings.push(
        `The manifest counts ${manifest.value.counts.artifacts} artifact(s) against the database's ${census.value.artifacts}.`,
      );
    }
  }

  return ok({
    findings,
    warnings,
    checked: {
      vault: vault.value.checked,
      manifest: manifestChecked,
      trackedFiles: trackedCount,
    },
  });
}
