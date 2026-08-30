import { describe, expect, it } from "vitest";
import { backupVerify, ensureVaultGitRepository } from "../../src/backup-commands";
import { type BackupCensus } from "../../src/backup-commands";
import { GIT_ARGS, type GitClient, type GitRunRequest, type GitRunOutcome, isRuntimeTrackedPath } from "../../src/git";
import type { AppError } from "../../src/errors";
import { ok, type Result } from "../../src/errors";

/**
 * The TASK-053 decision matrix (INIT-007, BKP-001, BKP-004, BKP-022): Git
 * initialization touches only a Vault without a repository, and `backup
 * verify` names the fix for every wrong Git configuration, snapshot
 * inconsistency, or tracked runtime file while an unmaterialized Artifact
 * stays a warning.
 */

function recordingGit(responses: Array<(request: GitRunRequest) => GitRunOutcome | null>) {
  const calls: GitRunRequest[] = [];
  const client: GitClient = {
    run(request: GitRunRequest): Result<GitRunOutcome, AppError> {
      calls.push(request);
      for (const respond of responses) {
        const outcome = respond(request);
        if (outcome !== null) return ok(outcome);
      }
      return ok({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  return { calls, client };
}

describe("ensureVaultGitRepository", () => {
  it("reports an existing repository without running any Git command", () => {
    const { calls, client } = recordingGit([]);
    const result = ensureVaultGitRepository({
      vaultPath: "/vault",
      repositoryExists: () => ok(true),
      reassertPolicyFiles: () => ok(undefined),
      git: client,
    });
    expect(result.ok && result.value).toEqual({ initialized: false, existingReported: true });
    expect(calls).toEqual([]);
  });

  it("initializes and configures autocrlf when no repository exists, then re-asserts the policy files", () => {
    const { calls, client } = recordingGit([]);
    const reassertions: string[] = [];
    const result = ensureVaultGitRepository({
      vaultPath: "/vault",
      repositoryExists: () => ok(false),
      reassertPolicyFiles: () => {
        reassertions.push("/vault");
        return ok(undefined);
      },
      git: client,
    });
    expect(result.ok && result.value).toEqual({ initialized: true, existingReported: false });
    expect(calls.map((call) => call.args)).toEqual([GIT_ARGS.init(), GIT_ARGS.configSet("core.autocrlf", "false")]);
    expect(reassertions).toEqual(["/vault"]);
  });

  it("fails a refused init with GIT_BACKUP_CONFLICT", () => {
    const { client } = recordingGit([
      (request) => (request.args[0] === "init" ? { exitCode: 128, stdout: "", stderr: "fatal: already exists" } : null),
    ]);
    const result = ensureVaultGitRepository({
      vaultPath: "/vault",
      repositoryExists: () => ok(false),
      reassertPolicyFiles: () => ok(undefined),
      git: client,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("GIT_BACKUP_CONFLICT");
  });
});

describe("isRuntimeTrackedPath", () => {
  it("matches the database, its WAL and SHM siblings, logs, tokens, and credentials", () => {
    expect(isRuntimeTrackedPath("state/sorage.sqlite3")).toBe(true);
    expect(isRuntimeTrackedPath("state/sorage.sqlite3-wal")).toBe(true);
    expect(isRuntimeTrackedPath("state/sorage.sqlite3-shm")).toBe(true);
    expect(isRuntimeTrackedPath("logs/sorage.log")).toBe(true);
    expect(isRuntimeTrackedPath("state/api-token")).toBe(true);
    expect(isRuntimeTrackedPath("state/web-secret")).toBe(true);
    expect(isRuntimeTrackedPath("home/.git-credentials")).toBe(true);
  });

  it("keeps managed Vault content trackable", () => {
    expect(isRuntimeTrackedPath("artifacts/h/a/brief.md")).toBe(false);
    expect(isRuntimeTrackedPath("snapshots/manifest.json")).toBe(false);
    expect(isRuntimeTrackedPath(".sorage-vault.json")).toBe(false);
  });
});

interface VerifyFixture {
  repository?: boolean;
  autocrlf?: string;
  branch?: string;
  tracked?: string[];
  staged?: string[];
  merge?: boolean;
  rebase?: boolean;
  manifest?: { counts: { projects: number; handoffs: number; events: number; artifacts: number } } | null;
  shards?: number;
  eventLines?: number;
  census?: Partial<BackupCensus>;
  vaultFindings?: string[];
}

function verifyPortsOf(fixture: VerifyFixture) {
  const { calls, client } = recordingGit([
    (request) =>
      request.args[0] === "config" && request.args.includes("--get")
        ? { exitCode: 0, stdout: fixture.autocrlf ?? "false", stderr: "" }
        : null,
    (request) =>
      request.args[0] === "symbolic-ref" ? { exitCode: 0, stdout: fixture.branch ?? "main", stderr: "" } : null,
    (request) =>
      request.args[0] === "diff" ? { exitCode: 0, stdout: (fixture.staged ?? []).join("\n"), stderr: "" } : null,
    (request) =>
      request.args[0] === "ls-files" ? { exitCode: 0, stdout: (fixture.tracked ?? []).join("\n"), stderr: "" } : null,
  ]);
  const census: BackupCensus = {
    projects: 1,
    handoffs: 2,
    events: 3,
    artifacts: 2,
    materializing: 0,
    deletedWithArtifact: 0,
    ...fixture.census,
  };
  const manifest =
    fixture.manifest === undefined
      ? {
          counts: {
            projects: census.projects,
            handoffs: census.handoffs,
            events: census.events,
            artifacts: census.artifacts,
          },
        }
      : fixture.manifest;
  return {
    calls,
    ports: {
      vaultPath: "/vault",
      openVault: () => ok({ marker: markerOf(), layoutProblems: [] }),
      artifactsStats: () => ok({ count: census.artifacts, bytes: 10 }),
      stagingStats: () => ok({ count: 0, bytes: 0 }),
      pendingIntentCount: () => ok(0),
      artifactStore: {
        read() {
          return ok({ body: "" });
        },
      } as never,
      graceHours: 24,
      recordedArtifacts: () => ok([]),
      stagingEntries: () => ok([]),
      git: client,
      configuredBranch: "main",
      repositoryExists: () => ok(fixture.repository ?? true),
      repositorySignals: () =>
        ok({ mergeInProgress: fixture.merge ?? false, rebaseInProgress: fixture.rebase ?? false }),
      census: () => ok(census),
      readManifest: () => ok(manifest),
      countShards: () => ok(fixture.shards ?? census.handoffs),
      countEventLines: () => ok(fixture.eventLines ?? census.events),
    },
  };
}

function markerOf() {
  return {
    type: "sorage-vault" as const,
    schemaVersion: 1,
    installationId: "i",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("backupVerify", () => {
  it("reports zero findings and zero warnings on a fully consistent fixture", () => {
    const { ports } = verifyPortsOf({});
    const report = backupVerify(ports as never, { now: new Date() });
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.findings).toEqual([]);
      expect(report.value.warnings).toEqual([]);
      expect(report.value.checked.manifest.present).toBe(true);
    }
  });

  it("names the missing Git repository", () => {
    const { ports } = verifyPortsOf({ repository: false });
    const report = backupVerify(ports as never, { now: new Date() });
    expect(report.ok && report.value.findings.some((f) => f.includes("no Git repository"))).toBe(true);
  });

  it("names the fix when core.autocrlf is wrong", () => {
    const { ports } = verifyPortsOf({ autocrlf: "true" });
    const report = backupVerify(ports as never, { now: new Date() });
    expect(
      report.ok &&
        report.value.findings.some(
          (f) => f.includes("core.autocrlf is 'true'") && f.includes("git config core.autocrlf false"),
        ),
    ).toBe(true);
  });

  it("reports a branch other than the configured one", () => {
    const { ports } = verifyPortsOf({ branch: "master" });
    const report = backupVerify(ports as never, { now: new Date() });
    expect(report.ok && report.value.findings.some((f) => f.includes("not the configured branch 'main'"))).toBe(true);
  });

  it("reports an in-progress merge and rebase", () => {
    const merged = backupVerify(verifyPortsOf({ merge: true }).ports as never, { now: new Date() });
    expect(merged.ok && merged.value.findings.some((f) => f.includes("merge is in progress"))).toBe(true);
    const rebased = backupVerify(verifyPortsOf({ rebase: true }).ports as never, { now: new Date() });
    expect(rebased.ok && rebased.value.findings.some((f) => f.includes("rebase is in progress"))).toBe(true);
  });

  it("reports staged work outside a backup run", () => {
    const { ports } = verifyPortsOf({ staged: ["notes.txt"] });
    const report = backupVerify(ports as never, { now: new Date() });
    expect(
      report.ok && report.value.findings.some((f) => f.includes("staged file(s) outside the managed pathspecs")),
    ).toBe(true);
  });

  it("reports tracked runtime files by name (BKP-004)", () => {
    const { ports } = verifyPortsOf({ tracked: ["artifacts/h/a/brief.md", "state/sorage.sqlite3"] });
    const report = backupVerify(ports as never, { now: new Date() });
    expect(
      report.ok &&
        report.value.findings.some((f) => f.includes("state/sorage.sqlite3") && f.includes("never committed")),
    ).toBe(true);
  });

  it("reports a missing manifest and count mismatches", () => {
    const missing = backupVerify(verifyPortsOf({ manifest: null }).ports as never, { now: new Date() });
    expect(missing.ok && missing.value.findings.some((f) => f.includes("manifest.json is missing"))).toBe(true);
    const mismatched = verifyPortsOf({
      manifest: { counts: { projects: 9, handoffs: 2, events: 3, artifacts: 2 } },
    });
    const report = backupVerify(mismatched.ports as never, { now: new Date() });
    expect(report.ok && report.value.findings.some((f) => f.includes("9 project(s)"))).toBe(true);
  });

  it("keeps an unmaterialized current Artifact a warning and a lingering deleted Artifact a finding", () => {
    const { ports } = verifyPortsOf({ census: { materializing: 1, deletedWithArtifact: 1 } });
    const report = backupVerify(ports as never, { now: new Date() });
    expect(report.ok && report.value.warnings.some((w) => w.includes("materialized = 0"))).toBe(true);
    expect(report.ok && report.value.findings.some((f) => f.includes("deleted Handoff(s) still hold"))).toBe(true);
  });
});
