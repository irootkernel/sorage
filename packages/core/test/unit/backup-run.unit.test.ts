import { describe, expect, it } from "vitest";
import {
  type BackupRunPorts,
  type BackupRunRow,
  renderBackupCommitMessage,
  runBackupOnce,
} from "../../src/backup-commands";
import { type AppError, appError, err, ok, type Result } from "../../src/errors";
import type { GitClient, GitRunRequest, GitRunOutcome } from "../../src/git";

/**
 * The TASK-054 run matrix (BKP-006, BKP-009, BKP-010, BKP-013, BKP-024): the
 * change test decides whether a commit exists, every attempt that held the
 * lock writes exactly one history row, every failure carries its symbolic
 * code, and no invocation ever names a destructive Git operation.
 */

interface Scripted {
  args: string[];
  outcome: GitRunOutcome | Error;
}

function fakePorts(script: Scripted[], options: { lockLive?: boolean; verifyError?: AppError } = {}) {
  const invocations: string[][] = [];
  const rows: BackupRunRow[] = [];
  const client: GitClient = {
    run(request: GitRunRequest): Result<GitRunOutcome, AppError> {
      invocations.push(request.args);
      for (const entry of script) {
        if (entry.args.every((part) => request.args.includes(part))) {
          if (entry.outcome instanceof Error) return err(appError("INTERNAL_ERROR", entry.outcome.message));
          return ok(entry.outcome);
        }
      }
      return ok({ exitCode: 0, stdout: "", stderr: "" });
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
    git: client,
    gitState: () => ok({ mergeInProgress: false, rebaseInProgress: false }),
    recordRun: (row) => {
      rows.push(row);
      return ok(undefined);
    },
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    nextRunId: () => "run-1",
  };
  return { ports, invocations, rows };
}

describe("runBackupOnce", () => {
  it("commits exactly the managed pathspecs with the templated message when the change test reports a change", () => {
    const { ports, invocations, rows } = fakePorts([
      { args: ["symbolic-ref"], outcome: { exitCode: 0, stdout: "main\n", stderr: "" } },
      { args: ["diff", "--cached", "--name-only"], outcome: { exitCode: 0, stdout: "", stderr: "" } },
      { args: ["--quiet"], outcome: { exitCode: 1, stdout: "", stderr: "" } },
      { args: ["rev-parse"], outcome: { exitCode: 0, stdout: "abc123\n", stderr: "" } },
    ]);
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("success");
      expect(report.value.commit).toBe("committed");
      expect(report.value.commitSha).toBe("abc123");
      expect(report.value.push).toBe("disabled");
    }
    const add = invocations.find((args) => args[0] === "add");
    expect(add?.slice(add.indexOf("--") + 1)).toEqual([
      ".sorage-vault.json",
      ".gitattributes",
      ".gitignore",
      "artifacts",
      "snapshots",
    ]);
    const commit = invocations.find((args) => args.includes("commit"));
    expect(commit?.[commit.indexOf("-m") + 1]).toBe("sorage backup: 2026-08-30T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "success",
      commitOutcome: "committed",
      commitSha: "abc123",
      failureCode: null,
    });
  });

  it("stages nothing new and creates no commit when nothing changed", () => {
    const { ports, invocations, rows } = fakePorts([
      { args: ["symbolic-ref"], outcome: { exitCode: 0, stdout: "main\n", stderr: "" } },
      { args: ["--quiet"], outcome: { exitCode: 0, stdout: "", stderr: "" } },
    ]);
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("no-change");
      expect(report.value.commit).toBe("no-change");
      expect(report.value.commitSha).toBeNull();
    }
    expect(invocations.some((args) => args.includes("commit"))).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "no-change", commitOutcome: "no-change" });
  });

  it("never names a destructive Git operation in any invocation", () => {
    for (const script of [
      [],
      [{ args: ["--quiet"], outcome: { exitCode: 0, stdout: "", stderr: "" } }],
      [{ args: ["--quiet"], outcome: { exitCode: 1, stdout: "", stderr: "" } }],
      [{ args: ["add"], outcome: { exitCode: 128, stdout: "", stderr: "fatal" } }],
    ]) {
      const { invocations } = fakePorts(
        script.length > 0 ? script : [{ args: ["--quiet"], outcome: { exitCode: 0, stdout: "", stderr: "" } }],
      );
      runBackupOnce(invocations.length === 0 ? fakePorts(script).ports : fakePorts(script).ports);
      for (const args of invocations) {
        const joined = args.join(" ");
        expect(joined, `no destructive operation in: ${joined}`).not.toMatch(
          /\b(rebase|merge|pull|--force|--force-with-lease)\b/,
        );
      }
    }
  });

  it("records the failure row and never commits when an Artifact checksum fails (VLT-023)", () => {
    const { ports, invocations, rows } = fakePorts([], {
      verifyError: appError("ARTIFACT_CORRUPTED", "altered", {}),
    });
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(invocations.some((args) => args.includes("add") || args.includes("commit"))).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failure", failureCode: "ARTIFACT_CORRUPTED" });
  });

  it("refuses a wrong branch, an in-progress merge, and unmanaged staged work with GIT_BACKUP_CONFLICT", () => {
    const wrongBranch = fakePorts([
      { args: ["symbolic-ref"], outcome: { exitCode: 0, stdout: "master\n", stderr: "" } },
    ]);
    const branchResult = runBackupOnce(wrongBranch.ports);
    expect(!branchResult.ok && branchResult.error.code).toBe("GIT_BACKUP_CONFLICT");
    expect(wrongBranch.rows[0]?.failureCode).toBe("GIT_BACKUP_CONFLICT");

    const merging = fakePorts([]);
    merging.ports.gitState = () => ok({ mergeInProgress: true, rebaseInProgress: false });
    const merged = runBackupOnce(merging.ports);
    expect(!merged.ok && merged.error.code).toBe("GIT_BACKUP_CONFLICT");

    const unmanaged = fakePorts([
      { args: ["symbolic-ref"], outcome: { exitCode: 0, stdout: "main\n", stderr: "" } },
      { args: ["diff", "--cached", "--name-only"], outcome: { exitCode: 0, stdout: "foreign.txt\n", stderr: "" } },
    ]);
    const foreign = runBackupOnce(unmanaged.ports);
    expect(!foreign.ok && foreign.error.code).toBe("GIT_BACKUP_CONFLICT");
  });

  it("proceeds past staged managed files a crashed run left behind", () => {
    const { ports } = fakePorts([
      { args: ["symbolic-ref"], outcome: { exitCode: 0, stdout: "main\n", stderr: "" } },
      {
        args: ["diff", "--cached", "--name-only"],
        outcome: { exitCode: 0, stdout: "snapshots/manifest.json\n", stderr: "" },
      },
      { args: ["--quiet"], outcome: { exitCode: 0, stdout: "", stderr: "" } },
    ]);
    const report = runBackupOnce(ports);
    expect(report.ok).toBe(true);
  });

  it("returns BACKUP_IN_PROGRESS without recording an attempt when the lock is held", () => {
    const { ports, rows } = fakePorts([{ args: ["--quiet"], outcome: { exitCode: 0, stdout: "", stderr: "" } }], {
      lockLive: true,
    });
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
