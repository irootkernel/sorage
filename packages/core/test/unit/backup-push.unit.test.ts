import { describe, expect, it } from "vitest";
import { configureBackup, type BackupRunPorts, runBackupOnce } from "../../src/backup-commands";
import { classifyPushFailure } from "../../src/git";
import { type AppError, appError, err, ok, type Result } from "../../src/errors";
import type { GitClient, GitRunOutcome } from "../../src/git";

/**
 * The TASK-057 push and configuration matrix (BKP-011, BKP-014, BKP-025,
 * CLI-019): a refused push classifies as a missing credential or a manual
 * conflict, the engine records the push outcome separately, and the four
 * User-admin commands apply their whole group in one write.
 */

describe("classifyPushFailure", () => {
  it("maps a disabled credential prompt to GIT_AUTH_REQUIRED", () => {
    const error = classifyPushFailure({
      exitCode: 128,
      stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
      stdout: "",
    });
    expect(error.code).toBe("GIT_AUTH_REQUIRED");
  });

  it("maps an authentication refusal to GIT_AUTH_REQUIRED", () => {
    const error = classifyPushFailure({
      exitCode: 128,
      stderr: "git@example.com: Permission denied (publickey).",
      stdout: "",
    });
    expect(error.code).toBe("GIT_AUTH_REQUIRED");
  });

  it("maps a non-fast-forward rejection to GIT_BACKUP_CONFLICT", () => {
    const error = classifyPushFailure({
      exitCode: 1,
      stderr: "To origin\n ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs",
      stdout: "",
    });
    expect(error.code).toBe("GIT_BACKUP_CONFLICT");
  });
});

function pushPorts(script: Array<(args: string[]) => GitRunOutcome | null>, options: { pushEnabled?: boolean } = {}) {
  const invocations: string[][] = [];
  const client: GitClient = {
    run: (request) => {
      invocations.push(request.args);
      for (const respond of script) {
        const outcome = respond(request.args);
        if (outcome !== null) return ok(outcome);
      }
      return ok({ exitCode: 0, stdout: request.args[0] === "symbolic-ref" ? "main\n" : "", stderr: "" });
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
    git: client,
    gitState: () => ok({ mergeInProgress: false, rebaseInProgress: false }),
    recordRun: () => ok(undefined),
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    nextRunId: () => "run-1",
  };
  return { ports, invocations };
}

describe("runBackupOnce push paths", () => {
  it("pushes atomically after a commit and records the pushed outcome", () => {
    const { ports, invocations } = pushPorts(
      [
        (args) =>
          args.includes("--quiet") && !args.includes("--name-only") ? { exitCode: 1, stdout: "", stderr: "" } : null,
        (args) => (args[0] === "rev-parse" ? { exitCode: 0, stdout: "abc\n", stderr: "" } : null),
      ],
      { pushEnabled: true },
    );
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("success");
      expect(report.value.push).toBe("pushed");
    }
    const push = invocations.find((args) => args[0] === "push");
    expect(push).toEqual(["push", "--atomic", "origin", "main"]);
  });

  it("still pushes on a no-change run so an unpushed commit reaches the remote", () => {
    const { ports, invocations } = pushPorts([], { pushEnabled: true });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("no-change");
      expect(report.value.push).toBe("pushed");
    }
    expect(invocations.some((args) => args[0] === "push")).toBe(true);
  });

  it("records the push failure with its symbolic code and keeps the commit recorded", () => {
    const rows: Array<Record<string, unknown>> = [];
    const { ports } = pushPorts(
      [
        (args) =>
          args.includes("--quiet") && !args.includes("--name-only") ? { exitCode: 1, stdout: "", stderr: "" } : null,
        (args) => (args[0] === "rev-parse" ? { exitCode: 0, stdout: "abc\n", stderr: "" } : null),
        (args) =>
          args[0] === "push"
            ? { exitCode: 1, stdout: "", stderr: " ! [rejected] main -> main (non-fast-forward)" }
            : null,
      ],
      { pushEnabled: true },
    );
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

  it("classifies the disabled credential prompt as GIT_AUTH_REQUIRED", () => {
    const { ports } = pushPorts(
      [
        (args) =>
          args.includes("--quiet") && !args.includes("--name-only") ? { exitCode: 1, stdout: "", stderr: "" } : null,
        (args) =>
          args[0] === "push"
            ? { exitCode: 128, stdout: "", stderr: "fatal: could not read Username: terminal prompts disabled" }
            : null,
      ],
      { pushEnabled: true },
    );
    const report = runBackupOnce(ports);
    expect(!report.ok && report.error.code).toBe("GIT_AUTH_REQUIRED");
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
      : import("../../src/config").Configuration;
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
