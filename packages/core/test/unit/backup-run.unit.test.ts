import { describe, expect, it } from "vitest";
import {
  type BackupRunPorts,
  type BackupRunRow,
  renderBackupCommitMessage,
  runBackupOnce,
} from "../../src/backup/backup-run";
import { type AppError, appError, err, ok, type Result } from "../../src/shared/errors";
import type { VaultGitRepository } from "../../src/backup/git";

/**
 * The TASK-054 run matrix (BKP-006, BKP-009, BKP-010, BKP-013, BKP-024): the
 * change test decides whether a commit exists, every attempt that held the
 * lock writes exactly one history row, every failure carries its symbolic
 * code, and commit HEAD-lookup outcomes preserve exact backup semantics.
 */

interface FakeGitOptions {
  branch?: string | undefined;
  staged?: string[] | undefined;
  stageResult?: Result<void, AppError> | undefined;
  hasChanges?: Result<boolean, AppError> | undefined;
  commitResult?: Result<{ sha: string | null }, AppError> | undefined;
  pushResult?: Result<void, AppError> | undefined;
  lockLive?: boolean | undefined;
  verifyError?: AppError | undefined;
}

function fakePorts(options: FakeGitOptions = {}) {
  const operations: string[] = [];
  const commitMessages: string[] = [];
  const rows: BackupRunRow[] = [];
  const repo: VaultGitRepository = {
    initialize: (branch) => {
      operations.push(`initialize:${branch}`);
      return ok(undefined);
    },
    autocrlf: () => {
      operations.push("autocrlf");
      return ok("false");
    },
    currentBranch: () => {
      operations.push("currentBranch");
      return ok(options.branch ?? "main");
    },
    stagedPaths: () => {
      operations.push("stagedPaths");
      return ok(options.staged ?? []);
    },
    trackedPaths: () => {
      operations.push("trackedPaths");
      return ok([]);
    },
    stageManaged: () => {
      operations.push("stageManaged");
      return options.stageResult ?? ok(undefined);
    },
    hasStagedManagedChanges: () => {
      operations.push("hasStagedManagedChanges");
      return options.hasChanges ?? ok(false);
    },
    commit: (message) => {
      operations.push("commit");
      commitMessages.push(message);
      return options.commitResult ?? ok({ sha: "abc123" });
    },
    push: (target) => {
      operations.push(`push:${target.remote}/${target.branch}`);
      return options.pushResult ?? ok(undefined);
    },
  };
  const ports: BackupRunPorts = {
    vaultPath: "/vault",
    messageTemplate: "sorage backup: {timestamp}",
    triggeredBy: "manual",
    pushEnabled: false,
    pushTarget: { remote: "origin", branch: "main" },
    configuredBranch: "main",
    lock: {
      acquire: () =>
        options.lockLive === true ? err(appError("BACKUP_IN_PROGRESS", "held", {})) : ok({ release: () => undefined }),
    },
    exportSnapshot: () =>
      ok({ files: 4, counts: { projects: 1, handoffs: 1, events: 1, artifacts: 1 }, redactedWorkspacePaths: true }),
    verifyCurrentArtifacts: () => (options.verifyError ? err(options.verifyError) : ok({ verified: 1 })),
    ensureRepository: () => ok({ initialized: false, existingReported: true }),
    prepareWritableContent: () => ok(undefined),
    git: repo,
    gitState: () => ok({ mergeInProgress: false, rebaseInProgress: false }),
    recordRun: (row) => {
      rows.push(row);
      return ok(undefined);
    },
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    nextRunId: () => "run-1",
  };
  return { ports, operations, commitMessages, rows };
}

describe("runBackupOnce", () => {
  it("stages managed content and commits with the templated message when changes exist", () => {
    const { ports, operations, commitMessages, rows } = fakePorts({
      hasChanges: ok(true),
      commitResult: ok({ sha: "abc123" }),
    });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("success");
      expect(report.value.commit).toBe("committed");
      expect(report.value.commitSha).toBe("abc123");
      expect(report.value.push).toBe("disabled");
    }
    expect(operations).toEqual(["currentBranch", "stagedPaths", "stageManaged", "hasStagedManagedChanges", "commit"]);
    expect(commitMessages).toEqual(["sorage backup: 2026-08-30T00:00:00.000Z"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "success",
      commitOutcome: "committed",
      commitSha: "abc123",
      failureCode: null,
    });
  });

  it("still succeeds with commitSha: null when commit succeeds but HEAD lookup exited non-zero", () => {
    const { ports, rows } = fakePorts({
      hasChanges: ok(true),
      commitResult: ok({ sha: null }),
    });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("success");
      expect(report.value.commit).toBe("committed");
      expect(report.value.commitSha).toBeNull();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "success",
      commitOutcome: "committed",
      commitSha: null,
      failureCode: null,
    });
  });

  it("records INTERNAL_ERROR when commit HEAD lookup fails to spawn", () => {
    const { ports, rows } = fakePorts({
      hasChanges: ok(true),
      commitResult: err(appError("INTERNAL_ERROR", "Running git rev-parse HEAD failed: ENOENT.")),
    });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("INTERNAL_ERROR");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      snapshotOutcome: "success",
      commitOutcome: "failure",
      commitSha: null,
      failureCode: "INTERNAL_ERROR",
    });
  });

  it("creates no commit when nothing managed changed", () => {
    const { ports, operations, rows } = fakePorts({ hasChanges: ok(false) });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("no-change");
      expect(report.value.commit).toBe("no-change");
      expect(report.value.commitSha).toBeNull();
    }
    expect(operations).not.toContain("commit");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "no-change", commitOutcome: "no-change" });
  });

  it("records the failure row and never stages or commits when an Artifact checksum fails (VLT-023)", () => {
    const { ports, operations, rows } = fakePorts({
      verifyError: appError("ARTIFACT_CORRUPTED", "altered", {}),
    });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(operations).not.toContain("stageManaged");
    expect(operations).not.toContain("commit");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failure", failureCode: "ARTIFACT_CORRUPTED" });
  });

  it("refuses a wrong branch, an in-progress merge, and unmanaged staged work with GIT_BACKUP_CONFLICT", () => {
    const wrongBranch = fakePorts({ branch: "master" });
    const branchResult = runBackupOnce(wrongBranch.ports);
    expect(!branchResult.ok && branchResult.error.code).toBe("GIT_BACKUP_CONFLICT");
    expect(wrongBranch.rows[0]?.failureCode).toBe("GIT_BACKUP_CONFLICT");

    const merging = fakePorts();
    merging.ports.gitState = () => ok({ mergeInProgress: true, rebaseInProgress: false });
    const merged = runBackupOnce(merging.ports);
    expect(!merged.ok && merged.error.code).toBe("GIT_BACKUP_CONFLICT");

    const unmanaged = fakePorts({ staged: ["foreign.txt"] });
    const foreign = runBackupOnce(unmanaged.ports);
    expect(!foreign.ok && foreign.error.code).toBe("GIT_BACKUP_CONFLICT");
  });

  it("proceeds past staged managed files a crashed run left behind", () => {
    const { ports } = fakePorts({ staged: ["snapshots/manifest.json"], hasChanges: ok(false) });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
  });

  it("returns BACKUP_IN_PROGRESS without recording an attempt when the lock is held", () => {
    const { ports, rows } = fakePorts({ lockLive: true });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("BACKUP_IN_PROGRESS");
    expect(rows).toHaveLength(0);
  });
});

describe("renderBackupCommitMessage", () => {
  it("substitutes the {timestamp} placeholder and leaves a template without one unchanged", () => {
    const now = new Date("2026-08-30T01:02:03.000Z");
    expect(renderBackupCommitMessage("sorage backup: {timestamp}", now)).toBe(
      "sorage backup: 2026-08-30T01:02:03.000Z",
    );
    expect(renderBackupCommitMessage("nightly vault snapshot", now)).toBe("nightly vault snapshot");
  });
});
