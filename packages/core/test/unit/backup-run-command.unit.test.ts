import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type BackupIdempotencyPort,
  type BackupRunCommandPorts,
  type BackupRunRow,
  type BackupStatusPorts,
  type BackupStatusReport,
  backupStatus,
  runBackupCommand,
} from "../../src/backup-commands";
import { type AppError, appError, err, ok, type Result } from "../../src/errors";
import type { GitClient, GitRunOutcome } from "../../src/git";

/**
 * The TASK-055 command surface (BKP-016, BKP-017): the idempotency replay
 * contract of section 17.3 over the run engine, and the status projection
 * that exposes last attempt, success, commit, push, and failure from
 * backup_runs.
 */

function portsOf(
  options: { recorded?: { requestHash: string; responseJson: string }; runError?: AppError } = {},
): BackupRunCommandPorts {
  const git: GitClient = {
    run: (request) =>
      ok({
        exitCode: 0,
        stdout: request.args[0] === "symbolic-ref" ? "main\n" : "",
        stderr: "",
      } satisfies GitRunOutcome),
  };
  const idempotency: BackupIdempotencyPort = {
    lookup: (key, scope) =>
      options.recorded !== undefined && key === "same-key" && scope === "backup-run" ? ok(options.recorded) : ok(null),
    record: () => ok(undefined),
  };
  return {
    vaultPath: "/vault",
    messageTemplate: "sorage backup: {timestamp}",
    triggeredBy: "manual",
    pushEnabled: false,
    configuredBranch: "main",
    lock: { acquire: () => ok({ release: () => undefined }) },
    exportSnapshot: () =>
      ok({ files: 4, counts: { projects: 1, handoffs: 1, events: 1, artifacts: 1 }, redactedWorkspacePaths: true }),
    verifyCurrentArtifacts: () => ok({ verified: 1 }),
    ensureRepository: () => ok({ initialized: false, existingReported: true }),
    git,
    gitState: () => ok({ mergeInProgress: false, rebaseInProgress: false }),
    recordRun: () => ok(undefined),
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    nextRunId: () => "run-1",
    idempotency,
    // The engine path is exercised by its own suite; the wrapper under test
    // stubs the pieces it needs and lets the scripted no-change path run.
    ...(options.runError !== undefined
      ? {
          exportSnapshot: () => err(options.runError as AppError),
        }
      : {}),
  } as BackupRunCommandPorts;
}

describe("runBackupCommand idempotency", () => {
  it("replays the recorded outcome of an identical request without running again", () => {
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ command: "backup run", vaultPath: "/vault" }))
      .digest("hex");
    let runs = 0;
    const ports = portsOf({
      recorded: {
        requestHash,
        responseJson: JSON.stringify({
          runId: "old-run",
          outcome: "success",
          snapshot: "success",
          commit: "committed",
          push: "disabled",
          commitSha: "abc",
        }),
      },
    });
    ports.exportSnapshot = () => {
      runs++;
      return ok({
        files: 4,
        counts: { projects: 1, handoffs: 1, events: 1, artifacts: 1 },
        redactedWorkspacePaths: true,
      });
    };
    const result = runBackupCommand(ports, { idempotencyKey: "same-key" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.replayed).toBe(true);
      expect(result.value.runId).toBe("old-run");
      expect(result.value.commitSha).toBe("abc");
    }
    expect(runs).toBe(0);
  });

  it("refuses a different request under the same key with IDEMPOTENCY_CONFLICT", () => {
    const ports = portsOf({
      recorded: { requestHash: "different-hash", responseJson: "{}" },
    });
    const result = runBackupCommand(ports, { idempotencyKey: "same-key" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("runs and reports without a key, and records the outcome under a fresh key", () => {
    let runs = 0;
    let recordedKeys = 0;
    const ports = portsOf();
    ports.exportSnapshot = () => {
      runs++;
      return ok({
        files: 4,
        counts: { projects: 1, handoffs: 1, events: 1, artifacts: 1 },
        redactedWorkspacePaths: true,
      });
    };
    ports.idempotency = {
      lookup: () => ok(null),
      record: () => {
        recordedKeys++;
        return ok(undefined);
      },
    };
    const result = runBackupCommand(ports, { idempotencyKey: "new-key" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.replayed).toBe(false);
      expect(result.value.outcome).toBe("no-change");
    }
    expect(runs).toBe(1);
    expect(recordedKeys).toBe(1);
  });
});

describe("backupStatus", () => {
  const row = (overrides: Partial<BackupRunRow>): BackupRunRow => ({
    id: "r1",
    triggeredBy: "manual",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:01.000Z",
    outcome: "success",
    snapshotOutcome: "success",
    commitOutcome: "committed",
    pushOutcome: "disabled",
    commitSha: "abc",
    failureCode: null,
    failureMessage: null,
    ...overrides,
  });

  function statusPortsOf(rows: BackupRunRow[]): BackupStatusPorts {
    return {
      vaultPath: "/vault",
      history: () => ok(rows),
      schedule: { enabled: false, at: "03:00", timezone: "UTC", catchUpAfterMissedRun: true },
      repositoryBytes: () => ok(1024),
    };
  }

  it("exposes last attempt, success, commit, and failure from an empty history as null", () => {
    const report = backupStatus(statusPortsOf([]));
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.lastAttempt).toBeNull();
      expect(report.value.lastSuccess).toBeNull();
      expect(report.value.lastCommit).toBeNull();
      expect(report.value.lastPush).toBeNull();
      expect(report.value.lastFailure).toBeNull();
      expect(report.value.nextDueAt).toBeNull();
      expect(report.value.repositorySizeBytes).toBe(1024);
    }
  });

  it("projects a mixed history onto the five exposures (BKP-016)", (): void => {
    const rows = [
      row({ id: "r1", startedAt: "2026-08-30T01:00:00.000Z", outcome: "success", commitSha: "sha-1" }),
      row({
        id: "r2",
        startedAt: "2026-08-30T02:00:00.000Z",
        outcome: "failure",
        commitSha: null,
        failureCode: "ARTIFACT_CORRUPTED",
        failureMessage: "altered",
      }),
      row({ id: "r3", startedAt: "2026-08-30T03:00:00.000Z", outcome: "no-change", commitSha: null }),
    ];
    const report = backupStatus(statusPortsOf(rows));
    expect(report.ok).toBe(true);
    const value = (report as { ok: true; value: BackupStatusReport }).value;
    expect(value.lastAttempt?.id).toBe("r3");
    expect(value.lastSuccess?.id).toBe("r3");
    expect(value.lastCommit?.id).toBe("r1");
    expect(value.lastCommit?.commitSha).toBe("sha-1");
    expect(value.lastPush).toBeNull();
    expect(value.lastFailure?.id).toBe("r2");
    expect(value.lastFailure?.failureCode).toBe("ARTIFACT_CORRUPTED");
  });
});
