import { describe, expect, it } from "vitest";
import { configureBackup } from "../../src/backup/backup-configure";
import { type BackupRunPorts, runBackupOnce } from "../../src/backup/backup-run";
import { type AppError, appError, err, ok, type Result } from "../../src/shared/errors";
import type { VaultGitRepository } from "../../src/backup/git";

/**
 * The TASK-057 push and configuration matrix (BKP-011, BKP-014, BKP-025,
 * CLI-019): the run engine propagates classified push failures, records the
 * push outcome separately, and the four User-admin commands apply their whole
 * group in one write.
 */

interface PushFakeOptions {
  pushEnabled?: boolean | undefined;
  hasChanges?: boolean | undefined;
  commitResult?: Result<{ sha: string | null }, AppError> | undefined;
  pushResult?: Result<void, AppError> | undefined;
}

function pushPorts(options: PushFakeOptions = {}) {
  const pushTargets: Array<{ remote: string; branch: string }> = [];
  const repo: VaultGitRepository = {
    initialize: () => ok(undefined),
    autocrlf: () => ok("false"),
    currentBranch: () => ok("main"),
    stagedPaths: () => ok([]),
    trackedPaths: () => ok([]),
    stageManaged: () => ok(undefined),
    hasStagedManagedChanges: () => ok(options.hasChanges ?? false),
    commit: () => options.commitResult ?? ok({ sha: "abc" }),
    push: (target) => {
      pushTargets.push(target);
      return options.pushResult ?? ok(undefined);
    },
  };
  const ports: BackupRunPorts = {
    vaultPath: "/vault",
    messageTemplate: "sorage backup: {timestamp}",
    triggeredBy: "scheduled",
    pushEnabled: options.pushEnabled ?? false,
    pushTarget: { remote: "origin", branch: "main" },
    configuredBranch: "main",
    lock: { acquire: () => ok({ release: () => undefined }) },
    exportSnapshot: () =>
      ok({ files: 4, counts: { projects: 1, handoffs: 1, events: 1, artifacts: 1 }, redactedWorkspacePaths: true }),
    verifyCurrentArtifacts: () => ok({ verified: 1 }),
    ensureRepository: () => ok({ initialized: false, existingReported: true }),
    prepareWritableContent: () => ok(undefined),
    git: repo,
    gitState: () => ok({ mergeInProgress: false, rebaseInProgress: false }),
    recordRun: () => ok(undefined),
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    nextRunId: () => "run-1",
  };
  return { ports, pushTargets };
}

describe("runBackupOnce push paths", () => {
  it("pushes atomically after a commit and records the pushed outcome", () => {
    const { ports, pushTargets } = pushPorts({
      hasChanges: true,
      commitResult: ok({ sha: "abc" }),
      pushEnabled: true,
    });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("success");
      expect(report.value.push).toBe("pushed");
    }
    expect(pushTargets).toEqual([{ remote: "origin", branch: "main" }]);
  });

  it("still pushes on a no-change run so an unpushed commit reaches the remote", () => {
    const { ports, pushTargets } = pushPorts({ hasChanges: false, pushEnabled: true });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("no-change");
      expect(report.value.push).toBe("pushed");
    }
    expect(pushTargets).toEqual([{ remote: "origin", branch: "main" }]);
  });

  it("records a GIT_BACKUP_CONFLICT push failure with its symbolic code and keeps the commit recorded", () => {
    const rows: Array<Record<string, unknown>> = [];
    const { ports } = pushPorts({
      hasChanges: true,
      commitResult: ok({ sha: "abc" }),
      pushEnabled: true,
      pushResult: err(
        appError(
          "GIT_BACKUP_CONFLICT",
          "The push was refused; resolve the remote state manually, Sorage never force pushes: ! [rejected] main -> main (non-fast-forward)",
          { exitCode: 1 },
        ),
      ),
    });
    ports.recordRun = (row) => {
      rows.push({ ...row });
      return ok(undefined);
    };
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("GIT_BACKUP_CONFLICT");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      commitOutcome: "committed",
      commitSha: "abc",
      failureCode: "GIT_BACKUP_CONFLICT",
    });
  });

  it("records a GIT_AUTH_REQUIRED push failure when batch credentials are missing", () => {
    const rows: Array<Record<string, unknown>> = [];
    const { ports } = pushPorts({
      hasChanges: true,
      commitResult: ok({ sha: "abc" }),
      pushEnabled: true,
      pushResult: err(
        appError(
          "GIT_AUTH_REQUIRED",
          "Pushing to the remote needs a credential that batch mode cannot supply: fatal: could not read Username: terminal prompts disabled",
          { exitCode: 128 },
        ),
      ),
    });
    ports.recordRun = (row) => {
      rows.push({ ...row });
      return ok(undefined);
    };
    const report = runBackupOnce(ports);
    expect(!report.ok && report.error.code).toBe("GIT_AUTH_REQUIRED");
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      commitOutcome: "committed",
      commitSha: "abc",
      failureCode: "GIT_AUTH_REQUIRED",
    });
  });
});

describe("configureBackup", () => {
  function configPorts(initial: { enabled?: boolean; pushEnabled?: boolean } = {}) {
    let config = {
      gitBackup: {
        enabled: initial.enabled ?? false,
        schedule: { type: "daily" as const, at: "03:00", timezone: "UTC", catchUpAfterMissedRun: true },
        commit: { messageTemplate: "sorage backup: {timestamp}" },
        push: { enabled: initial.pushEnabled ?? false, remote: "origin", branch: "main" },
        largeArtifactWarningBytes: 26214400,
        snapshot: { redactWorkspacePaths: true },
      },
    } as never as Parameters<typeof configureBackup>[0] extends never
      ? never
      : import("../../src/config/config").Configuration;
    let writes = 0;
    return {
      writes: () => writes,
      ports: {
        read: () => ok({ config, etag: "etag-1" }),
        write: (next: typeof config) => {
          writes += 1;
          config = next;
          return ok({ etag: "etag-2" });
        },
      } as never,
    };
  }

  it("refuses without --as-user", () => {
    const fixture = configPorts();
    const result = configureBackup(fixture.ports, { action: "enable", asUser: false, dailyAt: "04:00" });
    expect(!result.ok && result.error.code).toBe("USER_CONTEXT_REQUIRED");
  });

  it("enables the schedule with its time and zone in one write", () => {
    const fixture = configPorts();
    const result = configureBackup(fixture.ports, {
      action: "enable",
      asUser: true,
      dailyAt: "04:30",
      timezone: "Asia/Seoul",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.gitBackup.enabled).toBe(true);
      expect(result.value.gitBackup.schedule.at).toBe("04:30");
      expect(result.value.gitBackup.schedule.timezone).toBe("Asia/Seoul");
    }
    expect(fixture.writes()).toBe(1);
  });

  it("rejects a malformed time and an unknown zone", () => {
    const fixture = configPorts();
    const malformed = configureBackup(fixture.ports, { action: "enable", asUser: true, dailyAt: "25:00" });
    expect(!malformed.ok && malformed.error.code).toBe("CONFIG_INVALID");
    const zone = configureBackup(fixture.ports, {
      action: "enable",
      asUser: true,
      dailyAt: "04:00",
      timezone: "Not/AZone",
    });
    expect(!zone.ok && zone.error.code).toBe("CONFIG_INVALID");
  });

  it("enables and disables push with the named remote and branch", () => {
    const fixture = configPorts();
    const enabled = configureBackup(fixture.ports, {
      action: "enable-push",
      asUser: true,
      remote: "mirror",
      branch: "release",
    });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) {
      expect(enabled.value.gitBackup.push).toEqual({ enabled: true, remote: "mirror", branch: "release" });
    }
    const off = configureBackup(fixture.ports, { action: "disable-push", asUser: true });
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.value.gitBackup.push.enabled).toBe(false);
  });
});
