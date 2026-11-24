import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "../shared/errors";
import type { BackupExportReport } from "./backup-export";
import { type AsyncVaultGitRepository, unmanagedStagedPaths, type VaultGitRepository } from "./git";
import type { VaultGitOutcome } from "./vault-git";

/**
 * The backup run engine of section 27 (TASK-054, BKP-006, BKP-009, BKP-010,
 * BKP-013, BKP-024): under `backup.lock`, export the deterministic snapshot,
 * verify every current Artifact checksum, validate the Git state, stage
 * exactly the managed pathspecs, let `git diff --cached --quiet` decide
 * whether anything changed, commit with the configured template only when it
 * did, and record exactly one `backup_runs` row whatever happened. The engine
 * never rebases, merges, or resolves a conflict, and it pushes only when
 * `gitBackup.push.enabled` is set (BKP-011, BKP-013).
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
  /**
   * The backup run's writable setup (SHR-011, section 26): idempotently prepares
   * the managed `content/` directory inside the validated selected Vault before
   * the exact Git change test, on every supported Vault, without a sentinel
   * file and without writing outside the Vault root. Read-only surfaces never
   * call it, so verify, dry-run, and preflight leave an absent directory absent.
   */
  prepareWritableContent(): Result<void, AppError>;
  git: VaultGitRepository;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const branch = ports.git.currentBranch();
  if (!branch.ok) return err(branch.error);
  const branchName = branch.value;
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
  const staged = ports.git.stagedPaths();
  if (!staged.ok) return err(staged.error);
  const unmanaged = unmanagedStagedPaths(staged.value);
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

  // The writable setup precedes staging: the change test uses the managed
  // pathspecs unchanged, so an absent `content/` path would be a hard Git error
  // rather than a match of nothing (section 26). Preparation creates no
  // sentinel file, so an empty directory stages nothing and a run with no other
  // change still reaches the clean no-change exit.
  const preparedContent = ports.prepareWritableContent();
  if (!preparedContent.ok) return err(preparedContent.error);

  const added = ports.git.stageManaged();
  if (!added.ok) return err(added.error);

  const changed = ports.git.hasStagedManagedChanges();
  if (!changed.ok) return err(changed.error);
  if (!changed.value) {
    // Nothing managed changed since the last commit: no commit is created (BKP-009),
    // but an enabled push still runs so a restored or previously unpushed commit
    // reaches the remote (section 30).
    if (!ports.pushEnabled) {
      return ok({ outcome: "no-change", snapshot: "success", commit: "no-change", push: "disabled", commitSha: null });
    }
    const pushed = ports.git.push(ports.pushTarget);
    if (!pushed.ok) return err(pushed.error);
    return ok({ outcome: "no-change", snapshot: "success", commit: "no-change", push: "pushed", commitSha: null });
  }

  const message = renderBackupCommitMessage(ports.messageTemplate, ports.now());
  const committed = ports.git.commit(message);
  if (!committed.ok) return err(committed.error);
  const commitSha = committed.value.sha;
  progress.commitSha = commitSha;
  if (!ports.pushEnabled) {
    return ok({ outcome: "success", snapshot: "success", commit: "committed", push: "disabled", commitSha });
  }
  const pushed = ports.git.push(ports.pushTarget);
  if (!pushed.ok) return err(pushed.error);
  return ok({ outcome: "success", snapshot: "success", commit: "committed", push: "pushed", commitSha });
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

export interface AsyncBackupRunPorts
  extends Omit<BackupRunPorts, "exportSnapshot" | "verifyCurrentArtifacts" | "ensureRepository" | "git"> {
  exportSnapshot(): Result<BackupExportReport, AppError> | Promise<Result<BackupExportReport, AppError>>;
  verifyCurrentArtifacts(): Promise<Result<{ verified: number }, AppError>>;
  ensureRepository(): Promise<Result<VaultGitOutcome, AppError>>;
  git: AsyncVaultGitRepository;
}

export interface AsyncBackupRunCommandPorts extends AsyncBackupRunPorts {
  idempotency: BackupIdempotencyPort;
}

/** Asynchronous counterpart of `runBackupOnce` for daemon HTTP and scheduler backup runs (RUN-005, BKP-006). */
export async function runBackupOnceAsync(ports: AsyncBackupRunPorts): Promise<Result<BackupRunReport, AppError>> {
  const lock = ports.lock.acquire();
  if (!lock.ok) return err(lock.error);
  try {
    const id = ports.nextRunId();
    const startedAt = ports.now();
    const progress: { snapshotDone: boolean; commitSha: string | null } = { snapshotDone: false, commitSha: null };
    let result: Result<Omit<BackupRunReport, "runId">, AppError>;
    try {
      result = await runUnderBackupLockAsync(ports, progress);
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
  } finally {
    lock.value.release();
  }
}

async function runUnderBackupLockAsync(
  ports: AsyncBackupRunPorts,
  progress: { snapshotDone: boolean; commitSha: string | null },
): Promise<Result<Omit<BackupRunReport, "runId">, AppError>> {
  const repository = await ports.ensureRepository();
  if (!repository.ok) return err(repository.error);

  const exported = await ports.exportSnapshot();
  if (!exported.ok) return err(exported.error);
  progress.snapshotDone = true;

  const verified = await ports.verifyCurrentArtifacts();
  if (!verified.ok) return err(verified.error);

  const branch = await ports.git.currentBranch();
  if (!branch.ok) return err(branch.error);
  const branchName = branch.value;
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
  const staged = await ports.git.stagedPaths();
  if (!staged.ok) return err(staged.error);
  const unmanaged = unmanagedStagedPaths(staged.value);
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

  const preparedContent = ports.prepareWritableContent();
  if (!preparedContent.ok) return err(preparedContent.error);

  const added = await ports.git.stageManaged();
  if (!added.ok) return err(added.error);

  const changed = await ports.git.hasStagedManagedChanges();
  if (!changed.ok) return err(changed.error);
  if (!changed.value) {
    if (!ports.pushEnabled) {
      return ok({ outcome: "no-change", snapshot: "success", commit: "no-change", push: "disabled", commitSha: null });
    }
    const pushed = await ports.git.push(ports.pushTarget);
    if (!pushed.ok) return err(pushed.error);
    return ok({ outcome: "no-change", snapshot: "success", commit: "no-change", push: "pushed", commitSha: null });
  }

  const message = renderBackupCommitMessage(ports.messageTemplate, ports.now());
  const committed = await ports.git.commit(message);
  if (!committed.ok) return err(committed.error);
  const commitSha = committed.value.sha;
  progress.commitSha = commitSha;
  if (!ports.pushEnabled) {
    return ok({ outcome: "success", snapshot: "success", commit: "committed", push: "disabled", commitSha });
  }
  const pushed = await ports.git.push(ports.pushTarget);
  if (!pushed.ok) return err(pushed.error);
  return ok({ outcome: "success", snapshot: "success", commit: "committed", push: "pushed", commitSha });
}

/** Asynchronous counterpart of `runBackupCommand` for `POST /api/v1/backup/run`. */
export async function runBackupCommandAsync(
  ports: AsyncBackupRunCommandPorts,
  options: { idempotencyKey?: string | undefined },
): Promise<Result<BackupRunCommandOutcome, AppError>> {
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
  const run = await runBackupOnceAsync(ports);
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
