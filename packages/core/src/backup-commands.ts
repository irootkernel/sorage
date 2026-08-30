import {
  parseSnapshotManifest,
  redactSnapshotData,
  type SnapshotData,
  type SnapshotFile,
  type SnapshotManifest,
  snapshotFiles,
  snapshotManifest,
} from "./backup-snapshot";
import { createHash } from "node:crypto";
import { type Configuration, isValidTimezone, SCHEDULE_AT_PATTERN } from "./config";
import { type AppError, appError, err, ok, type Result } from "./errors";
import {
  classifyPushFailure,
  GIT_ARGS,
  type GitClient,
  gitStateConflict,
  isRuntimeTrackedPath,
  MANAGED_PATHSPECS,
  unmanagedStagedPaths,
} from "./git";
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    // Only staged work outside the managed pathspecs is a finding: a crashed
    // backup run legitimately leaves its own staged managed files behind, and
    // the next run re-stages and commits them.
    const stagedPaths = unmanagedStagedPaths(staged.value.stdout.split("\n").filter((line) => line !== ""));
    if (stagedPaths.length > 0) {
      findings.push(
        `The index holds ${stagedPaths.length} staged file(s) outside the managed pathspecs; resolve them manually, because Sorage stages only its managed content.`,
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

/**
 * The backup run engine of section 27 (TASK-054, BKP-006, BKP-009, BKP-010,
 * BKP-013, BKP-024): under `backup.lock`, export the deterministic snapshot,
 * verify every current Artifact checksum, validate the Git state, stage
 * exactly the managed pathspecs, let `git diff --cached --quiet` decide
 * whether anything changed, commit with the configured template only when it
 * did, and record exactly one `backup_runs` row whatever happened. The engine
 * never pushes, rebases, merges, or resolves a conflict, and push itself is
 * disabled until TASK-057 wires it.
 */
export interface BackupRunPorts {
  vaultPath: string;
  /** The `gitBackup.commit.messageTemplate`, with `{timestamp}` as its placeholder (BKP-010). */
  messageTemplate: string;
  triggeredBy: "manual" | "scheduled" | "catch-up";
  /** The `gitBackup.push.enabled` flag; false records the push outcome as disabled (BKP-011). */
  pushEnabled: boolean;
  /** The configured remote and branch, present whenever push is enabled (BKP-025). */
  pushTarget: { remote: string; branch: string };
  configuredBranch: string;
  lock: {
    /** Acquires backup.lock; a live holder fails with BACKUP_IN_PROGRESS (BKP-006). */
    acquire(): Result<{ release: () => void }, AppError>;
  };
  exportSnapshot(): Result<BackupExportReport, AppError>;
  /** Hashes every current Artifact against its recorded SHA-256 (VLT-023). */
  verifyCurrentArtifacts(): Result<{ verified: number }, AppError>;
  ensureRepository(): Result<VaultGitOutcome, AppError>;
  git: GitClient;
  /** Merge and rebase indicators read from the repository's state directories. */
  gitState(): Result<{ mergeInProgress: boolean; rebaseInProgress: boolean }, AppError>;
  /** Writes exactly one history row for this attempt (BKP-016). */
  recordRun(row: BackupRunRow): Result<void, AppError>;
  now(): Date;
  nextRunId(): string;
}

export interface BackupRunRow {
  id: string;
  triggeredBy: "manual" | "scheduled" | "catch-up";
  startedAt: string;
  finishedAt: string | null;
  outcome: "success" | "no-change" | "failure";
  snapshotOutcome: "success" | "skipped" | "failure";
  commitOutcome: "committed" | "no-change" | "skipped" | "failure";
  pushOutcome: "pushed" | "skipped" | "failure" | "disabled";
  commitSha: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface BackupRunReport {
  runId: string;
  outcome: "success" | "no-change" | "failure";
  snapshot: "success" | "skipped" | "failure";
  commit: "committed" | "no-change" | "skipped" | "failure";
  push: "pushed" | "skipped" | "failure" | "disabled";
  commitSha: string | null;
}

function runGit(ports: BackupRunPorts, args: string[]): Result<GitRunOutcomeShape, AppError> {
  return ports.git.run({ cwd: ports.vaultPath, args });
}

type GitRunOutcomeShape = { exitCode: number; stdout: string; stderr: string };

/** Renders the configured template with the run's UTC timestamp (BKP-010). */
export function renderBackupCommitMessage(template: string, now: Date): string {
  return template.replaceAll("{timestamp}", now.toISOString());
}

export function runBackupOnce(ports: BackupRunPorts): Result<BackupRunReport, AppError> {
  const lock = ports.lock.acquire();
  if (!lock.ok) return err(lock.error);
  const id = ports.nextRunId();
  const startedAt = ports.now();

  // An unexpected throw (an injected crash, a Git surprise) still records its
  // failure row, because the scheduler treats an unrecorded attempt as a run
  // that never happened.
  // How far the attempt got, so a late failure - a refused push above all -
  // still records the commit that exists and the snapshot that was exported.
  const progress: { snapshotDone: boolean; commitSha: string | null } = { snapshotDone: false, commitSha: null };
  let result: ReturnType<typeof runUnderBackupLock>;
  try {
    result = runUnderBackupLock(ports, progress);
  } catch (error) {
    result = err(
      appError("INTERNAL_ERROR", `The backup run failed unexpectedly: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
  const finishedAt = ports.now();
  const row: BackupRunRow = result.ok
    ? {
        id,
        triggeredBy: ports.triggeredBy,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        outcome: result.value.outcome,
        snapshotOutcome: result.value.snapshot,
        commitOutcome: result.value.commit,
        pushOutcome: result.value.push,
        commitSha: result.value.commitSha,
        failureCode: null,
        failureMessage: null,
      }
    : {
        id,
        triggeredBy: ports.triggeredBy,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        outcome: "failure",
        snapshotOutcome: progress.snapshotDone ? "success" : "failure",
        commitOutcome: progress.commitSha !== null ? "committed" : "failure",
        pushOutcome: "failure",
        commitSha: progress.commitSha,
        failureCode: result.error.code,
        failureMessage: result.error.message,
      };
  const recorded = ports.recordRun(row);
  lock.value.release();
  if (!recorded.ok) return err(recorded.error);
  if (!result.ok) return err(result.error);
  return ok({
    runId: id,
    outcome: result.value.outcome,
    snapshot: result.value.snapshot,
    commit: result.value.commit,
    push: result.value.push,
    commitSha: result.value.commitSha,
  });
}

function runUnderBackupLock(
  ports: BackupRunPorts,
  progress: { snapshotDone: boolean; commitSha: string | null },
): Result<Omit<BackupRunReport, "runId">, AppError> {
  // A Vault without a repository gets one on the first run; an existing
  // repository, including an unrelated one, is reported and left untouched.
  const repository = ports.ensureRepository();
  if (!repository.ok) return err(repository.error);

  const exported = ports.exportSnapshot();
  if (!exported.ok) return err(exported.error);
  progress.snapshotDone = true;

  // VLT-023: a Missing or Mismatched Artifact blocks backup success outright.
  const verified = ports.verifyCurrentArtifacts();
  if (!verified.ok) return err(verified.error);

  const branch = runGit(ports, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch.ok) return err(branch.error);
  const branchName = branch.value.exitCode === 0 ? branch.value.stdout.trim() : "";
  if (branchName !== ports.configuredBranch) {
    return err(
      appError(
        "GIT_BACKUP_CONFLICT",
        `The Vault repository is on '${branchName === "" ? "a detached HEAD" : branchName}', not the configured branch '${ports.configuredBranch}'; resolve the repository state manually.`,
        { branch: branchName, configuredBranch: ports.configuredBranch },
      ),
    );
  }
  const signals = ports.gitState();
  if (!signals.ok) return err(signals.error);
  if (signals.value.mergeInProgress || signals.value.rebaseInProgress) {
    return err(
      appError(
        "GIT_BACKUP_CONFLICT",
        "The Vault repository has a merge or rebase in progress; Sorage never resolves it.",
        {},
      ),
    );
  }
  const staged = runGit(ports, ["diff", "--cached", "--name-only"]);
  if (!staged.ok) return err(staged.error);
  const unmanaged = unmanagedStagedPaths(staged.value.stdout.split("\n").filter((line) => line !== ""));
  if (unmanaged.length > 0) {
    return err(
      appError(
        "GIT_BACKUP_CONFLICT",
        `The index holds staged work outside the managed pathspecs: ${unmanaged.join(", ")}.`,
        {
          unmanaged,
        },
      ),
    );
  }

  const added = runGit(ports, ["add", "--", ...MANAGED_PATHSPECS]);
  if (!added.ok) return err(added.error);
  if (added.value.exitCode !== 0) return gitStateConflict("add", added.value);

  const changeTest = runGit(ports, ["diff", "--cached", "--quiet", "--", ...MANAGED_PATHSPECS]);
  if (!changeTest.ok) return err(changeTest.error);
  if (changeTest.value.exitCode === 0) {
    // Nothing managed changed since the last commit: no commit is created (BKP-009),
    // but an enabled push still runs so a restored or previously unpushed commit
    // reaches the remote (section 30).
    if (!ports.pushEnabled) {
      return ok({ outcome: "no-change", snapshot: "success", commit: "no-change", push: "disabled", commitSha: null });
    }
    const pushed = pushToRemote(ports);
    if (!pushed.ok) return err(pushed.error);
    return ok({ outcome: "no-change", snapshot: "success", commit: "no-change", push: "pushed", commitSha: null });
  }
  if (changeTest.value.exitCode !== 1) return gitStateConflict("diff --cached --quiet", changeTest.value);

  const message = renderBackupCommitMessage(ports.messageTemplate, ports.now());
  const committed = runGit(ports, [
    "-c",
    "user.name=Sorage Backup",
    "-c",
    "user.email=sorage@localhost",
    "commit",
    "-m",
    message,
  ]);
  if (!committed.ok) return err(committed.error);
  if (committed.value.exitCode !== 0) return gitStateConflict("commit", committed.value);
  const sha = runGit(ports, ["rev-parse", "HEAD"]);
  if (!sha.ok) return err(sha.error);
  const commitSha = sha.value.exitCode === 0 ? sha.value.stdout.trim() : null;
  progress.commitSha = commitSha;
  if (!ports.pushEnabled) {
    return ok({ outcome: "success", snapshot: "success", commit: "committed", push: "disabled", commitSha });
  }
  const pushed = pushToRemote(ports);
  if (!pushed.ok) return err(pushed.error);
  return ok({ outcome: "success", snapshot: "success", commit: "committed", push: "pushed", commitSha });
}

/** One atomic fast-forward push under the batch environment; a refusal classifies as auth or conflict (BKP-014, BKP-025). */
function pushToRemote(ports: BackupRunPorts): Result<"pushed", AppError> {
  const pushed = ports.git.run({
    cwd: ports.vaultPath,
    args: ["push", "--atomic", ports.pushTarget.remote, ports.pushTarget.branch],
  });
  if (!pushed.ok) return err(pushed.error);
  if (pushed.value.exitCode !== 0) return err(classifyPushFailure(pushed.value));
  return ok("pushed");
}

/**
 * The manual run command of TASK-055 (BKP-017, section 17.3): `backup run` is
 * one of the six idempotent operations, so an `--idempotency-key` replays the
 * recorded outcome of an identical request, refuses a different request under
 * the same key with `IDEMPOTENCY_CONFLICT`, and records the outcome of a
 * completed run for 24 hours like every other keyed operation. A failed run
 * records nothing, because a retry is the wanted behavior after a failure.
 */
export interface BackupIdempotencyPort {
  lookup(key: string, scope: string): Result<{ requestHash: string; responseJson: string } | null, AppError>;
  record(input: {
    key: string;
    scope: string;
    requestHash: string;
    responseJson: string;
    expiresAt: string;
  }): Result<void, AppError>;
}

export interface BackupRunCommandPorts extends BackupRunPorts {
  idempotency: BackupIdempotencyPort;
}

export type BackupRunCommandOutcome = BackupRunReport & { replayed: boolean };

export function runBackupCommand(
  ports: BackupRunCommandPorts,
  options: { idempotencyKey?: string | undefined },
): Result<BackupRunCommandOutcome, AppError> {
  // The request identity of a manual run is the command itself over this
  // Vault: there is no per-run input besides the key, so identical requests
  // hash identically by construction.
  const requestHash = hashOf(JSON.stringify({ command: "backup run", vaultPath: ports.vaultPath }));
  if (options.idempotencyKey !== undefined) {
    const seen = ports.idempotency.lookup(options.idempotencyKey, "backup-run");
    if (!seen.ok) return err(seen.error);
    if (seen.value !== null) {
      if (seen.value.requestHash !== requestHash) {
        return err(
          appError(
            "IDEMPOTENCY_CONFLICT",
            "this idempotency key was used with a different request; use a new key or replay the identical request",
            {
              idempotencyKey: options.idempotencyKey,
            },
          ),
        );
      }
      const replayed = JSON.parse(seen.value.responseJson) as BackupRunReport;
      return ok({ ...replayed, replayed: true });
    }
  }
  const run = runBackupOnce(ports);
  if (!run.ok) return err(run.error);
  if (options.idempotencyKey !== undefined) {
    const recorded = ports.idempotency.record({
      key: options.idempotencyKey,
      scope: "backup-run",
      requestHash,
      responseJson: JSON.stringify(run.value),
      expiresAt: new Date(ports.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    if (!recorded.ok) return err(recorded.error);
  }
  return ok({ ...run.value, replayed: false });
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * `sorage backup status` (TASK-055, BKP-016, section 31): the run history
 * projected onto what an operator needs — the last attempt, the last success,
 * the last commit, the last push, and the last failure with its symbolic
 * code, next to the schedule snapshot and the repository size on disk. The
 * computed `nextDueAt` stays null until the scheduler of TASK-056 fills it,
 * because computing it is the scheduler's DST-aware job.
 */
export interface BackupStatusPorts {
  vaultPath: string;
  history(): Result<BackupRunRow[], AppError>;
  schedule: { enabled: boolean; at: string; timezone: string; catchUpAfterMissedRun: boolean };
  /** The computed next due time in the schedule zone, or null while disabled (section 31). */
  nextDueAt(): string | null;
  /** The most recent run's start, whatever triggered it, for coverage decisions. */
  lastRunAt(): Result<string | null, AppError>;
  /** Total bytes under the Vault's `.git`, or null when no repository exists. */
  repositoryBytes(): Result<number | null, AppError>;
}

export interface BackupStatusReport {
  lastAttempt: BackupRunRow | null;
  lastSuccess: BackupRunRow | null;
  lastCommit: BackupRunRow | null;
  lastPush: BackupRunRow | null;
  lastFailure: BackupRunRow | null;
  nextDueAt: string | null;
  schedule: { enabled: boolean; at: string; timezone: string; catchUpAfterMissedRun: boolean };
  repositorySizeBytes: number | null;
}

export function backupStatus(ports: BackupStatusPorts): Result<BackupStatusReport, AppError> {
  const history = ports.history();
  if (!history.ok) return err(history.error);
  const rows = [...history.value].sort((a, b) => compareTimestamps(a.startedAt, b.startedAt));
  const lastAttempt = rows.length > 0 ? (rows[rows.length - 1] as BackupRunRow) : null;
  const lastSuccess = findLast(rows, (row) => row.outcome !== "failure");
  const lastCommit = findLast(rows, (row) => row.commitSha !== null);
  const lastPush = findLast(rows, (row) => row.pushOutcome === "pushed");
  const lastFailure = findLast(rows, (row) => row.outcome === "failure");
  const bytes = ports.repositoryBytes();
  if (!bytes.ok) return err(bytes.error);
  return ok({
    lastAttempt,
    lastSuccess,
    lastCommit,
    lastPush,
    lastFailure,
    nextDueAt: ports.nextDueAt(),
    schedule: ports.schedule,
    repositorySizeBytes: bytes.value,
  });
}

function findLast(rows: BackupRunRow[], predicate: (row: BackupRunRow) => boolean): BackupRunRow | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] as BackupRunRow;
    if (predicate(row)) return row;
  }
  return null;
}

function compareTimestamps(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The four User-admin backup configuration commands of TASK-057 (BKP-002,
 * BKP-011, BKP-025, CLI-019): `enable` turns the schedule on with its local
 * time and zone, `disable` turns it off, `enable-push` names the remote and
 * branch, and `disable-push` turns the remote off. Each applies its whole
 * group of leaf writes in one configuration write, and the HTTP endpoints
 * call this same use case so the two surfaces cannot drift.
 */
export interface BackupConfigPorts {
  read(): Result<{ config: Configuration; etag: string } | null, AppError>;
  write(next: Configuration, expect: { etag: string }): Result<{ etag: string }, AppError>;
}

export type BackupConfigAction = "enable" | "disable" | "enable-push" | "disable-push";

export interface BackupConfigInput {
  action: BackupConfigAction;
  asUser: boolean;
  /** `enable`: the local `HH:MM`. */
  dailyAt?: string | undefined;
  /** `enable`: an optional IANA zone replacement. */
  timezone?: string | undefined;
  /** `enable-push`: the remote name. */
  remote?: string | undefined;
  /** `enable-push`: the branch name. */
  branch?: string | undefined;
}

export function configureBackup(
  ports: BackupConfigPorts,
  input: BackupConfigInput,
): Result<{ gitBackup: Configuration["gitBackup"] }, AppError> {
  if (!input.asUser) {
    return err(
      appError("USER_CONTEXT_REQUIRED", "backup configuration commands record a User decision and require --as-user."),
    );
  }
  const read = ports.read();
  if (!read.ok) return err(read.error);
  if (read.value === null) return err(appError("NOT_INITIALIZED", "Sorage is not initialized.", {}));
  const config = read.value.config;

  if (input.action === "enable") {
    if (input.dailyAt === undefined || !SCHEDULE_AT_PATTERN.test(input.dailyAt)) {
      return err(appError("CONFIG_INVALID", "backup enable requires --daily-at <HH:MM> with a 24-hour local time."));
    }
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
      return err(appError("CONFIG_INVALID", `The timezone '${input.timezone}' is not a known IANA zone.`));
    }
    config.gitBackup.enabled = true;
    config.gitBackup.schedule.at = input.dailyAt;
    if (input.timezone !== undefined) config.gitBackup.schedule.timezone = input.timezone;
  } else if (input.action === "disable") {
    config.gitBackup.enabled = false;
  } else if (input.action === "enable-push") {
    if (input.remote === undefined || input.remote.trim() === "") {
      return err(appError("CONFIG_INVALID", "backup enable-push requires --remote <name>."));
    }
    if (input.branch === undefined || input.branch.trim() === "") {
      return err(appError("CONFIG_INVALID", "backup enable-push requires --branch <name>."));
    }
    config.gitBackup.push.enabled = true;
    config.gitBackup.push.remote = input.remote;
    config.gitBackup.push.branch = input.branch;
  } else {
    config.gitBackup.push.enabled = false;
  }

  const written = ports.write(config, { etag: read.value.etag });
  if (!written.ok) return err(written.error);
  return ok({ gitBackup: config.gitBackup });
}
