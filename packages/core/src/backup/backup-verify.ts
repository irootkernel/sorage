import { type AppError, err, ok, type Result } from "../shared/errors";
import { type VaultVerifyPorts, vaultVerify } from "../vault/vault-commands";
import { isRuntimeTrackedPath, unmanagedStagedPaths, type VaultGitRepository } from "./git";
import type { SnapshotManifest } from "./snapshot/backup-snapshot";

/** The database-side census the backup verification cross-checks the manifest against. */
export interface BackupCensus {
  projects: number;
  handoffs: number;
  events: number;
  artifacts: number;
  memos?: number;
  /** Always zero at this schema: the Channel tables arrive with TASK-109 (SHR-010). */
  channels: number;
  exchanges?: number;
  /** Live Handoffs whose current Artifact has `materialized = 0`. */
  materializing: number;
  /** Tombstoned Handoffs that still hold an active Artifact row. */
  deletedWithArtifact: number;
}

export interface BackupVerifyPorts extends VaultVerifyPorts {
  git: VaultGitRepository;
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
 * check plus the Git-backed ones — the required `.gitattributes` lines of
 * section 6 for this build in their stated order,
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
    const autocrlf = ports.git.autocrlf();
    if (!autocrlf.ok) return err(autocrlf.error);
    const value = autocrlf.value;
    if (value !== "false") {
      findings.push(
        `core.autocrlf is '${value === "" ? "unset" : value}' in the Vault repository; run git config core.autocrlf false inside the Vault, because a clone with autocrlf true would rewrite managed bytes and break their checksums.`,
      );
    }
    const branch = ports.git.currentBranch();
    if (!branch.ok) return err(branch.error);
    const branchName = branch.value;
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
    const staged = ports.git.stagedPaths();
    if (!staged.ok) return err(staged.error);
    // Only staged work outside the managed pathspecs is a finding: a crashed
    // backup run legitimately leaves its own staged managed files behind, and
    // the next run re-stages and commits them.
    const stagedPaths = unmanagedStagedPaths(staged.value);
    if (stagedPaths.length > 0) {
      findings.push(
        `The index holds ${stagedPaths.length} staged file(s) outside the managed pathspecs; resolve them manually, because Sorage stages only its managed content.`,
      );
    }
    const tracked = ports.git.trackedPaths();
    if (!tracked.ok) return err(tracked.error);
    const trackedPaths = tracked.value;
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
    if (manifest.value.formatVersion === 5) {
      const { exchanges, ...publicCounts } = manifest.value.counts;
      manifestChecked = { present: true, ...publicCounts };
      if (exchanges !== census.value.exchanges) {
        findings.push(
          `The manifest counts ${exchanges} Exchange record(s) against the database's ${census.value.exchanges ?? 0}.`,
        );
      }
    } else {
      manifestChecked = { present: true, ...manifest.value.counts };
    }
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
    if ((manifest.value.counts.memos ?? 0) !== (census.value.memos ?? 0)) {
      findings.push(
        `The manifest counts ${manifest.value.counts.memos ?? 0} Memo(s) against the database's ${census.value.memos ?? 0}.`,
      );
    }
    if ("channels" in manifest.value.counts && manifest.value.counts.channels !== census.value.channels) {
      findings.push(
        `The manifest counts ${manifest.value.counts.channels} Channel record(s) against the database's ${census.value.channels}.`,
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
