import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GitClient, GitRunOutcome, GitRunRequest } from "@sorage/core";
import { backupStatus, initializeInstallation, ok, runBackupCommand, runBackupOnce } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts, nodeEnsureVaultGit } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The TASK-054 run matrix over a real installation (BKP-006, BKP-009,
 * BKP-013, BKP-024): the first run commits exactly the managed pathspecs, a
 * second run with nothing changed creates no commit, an injected crash after
 * staging leaves the next run converging instead of refusing its own staged
 * files, a held backup.lock refuses with BACKUP_IN_PROGRESS, and every
 * attempt that held the lock writes exactly one history row.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function initializedHome(prefix: string): { home: string; vault: string } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  const result = initializeInstallation(ports, { vaultPath: vault });
  if (!result.ok) throw new Error(result.error.message);
  return { home, vault };
}

const HANDOFF_ID = "1a111111-1111-4111-8111-111111111111";

function seedOneHandoff(home: string, vault: string): void {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at)
    VALUES ('p-1', 'beta', 'Beta', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  const artifactBytes = "# The brief\n";
  mkdirSync(join(vault, "artifacts", HANDOFF_ID, "a-1"), { recursive: true });
  writeFileSync(join(vault, `artifacts/${HANDOFF_ID}/a-1/brief.md`), artifactBytes);
  db.prepare(
    `INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version,
      review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at)
    VALUES (?, 'Brief', 'user', 'p-1', 'a-1', 1, 1, 'awaiting_recipient', 0, 0,
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  ).run(HANDOFF_ID);
  db.prepare(
    `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256,
      materialized, created_at) VALUES ('a-1', ?, ?, 'brief.md', 'brief.md', 'text/markdown', ?, ?, 1, '2026-01-02T00:00:00.000Z')`,
  ).run(
    HANDOFF_ID,
    `artifacts/${HANDOFF_ID}/a-1/brief.md`,
    artifactBytes.length,
    createHash("sha256").update(artifactBytes).digest("hex"),
  );
  db.prepare(
    `INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
    VALUES ('e-1', ?, 'HANDOFF_CREATED', 'user', NULL, 1, '{}', '2026-01-02T00:00:00.000Z')`,
  ).run(HANDOFF_ID);
  db.exec("COMMIT");
  db.close();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function runOnce(home: string, options: { gitClient?: GitClient } = {}) {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, ...options });
  const runPorts = ports.runPorts();
  if (!runPorts.ok) throw new Error(runPorts.error.message);
  return runBackupOnce(runPorts.value);
}

function backupRunRows(home: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    return db.prepare("SELECT * FROM backup_runs ORDER BY started_at").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("runBackupOnce over a real installation", () => {
  it("commits the managed pathspecs on the first run and records a success row", () => {
    const { home, vault } = initializedHome("sorage-run-first-");
    seedOneHandoff(home, vault);
    const report = runOnce(home);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.outcome).toBe("success");
      expect(report.value.commitSha).toBe(git(vault, "rev-parse", "HEAD").trim());
    }
    const tracked = git(vault, "ls-files")
      .split("\n")
      .filter((line) => line !== "");
    expect(tracked).toContain(".sorage-vault.json");
    expect(tracked).toContain(`artifacts/${HANDOFF_ID}/a-1/brief.md`);
    expect(tracked).toContain("snapshots/manifest.json");
    expect(git(vault, "log", "-1", "--pretty=%s")).toContain("sorage backup:");
    const rows = backupRunRows(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", commit_outcome: "committed", push_outcome: "disabled" });
  });

  it("creates no commit on a second run with nothing changed", () => {
    const { home, vault } = initializedHome("sorage-run-second-");
    seedOneHandoff(home, vault);
    expect(runOnce(home).ok).toBe(true);
    const headBefore = git(vault, "rev-parse", "HEAD").trim();
    const second = runOnce(home);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.outcome).toBe("no-change");
    expect(git(vault, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(vault, "rev-list", "--count", "HEAD").trim()).toBe("1");
    const rows = backupRunRows(home);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ outcome: "no-change", commit_outcome: "no-change", commit_sha: null });
  });

  it("refuses with BACKUP_IN_PROGRESS while another process holds backup.lock and records nothing", () => {
    const { home, vault } = initializedHome("sorage-run-lock-");
    seedOneHandoff(home, vault);
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(
      join(home, "run", "backup.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
    );
    const report = runOnce(home);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("BACKUP_IN_PROGRESS");
    expect(backupRunRows(home)).toHaveLength(0);
    expect(existsSync(join(vault, ".git"))).toBe(false);
  });

  it("fails the run with ARTIFACT_CORRUPTED, records the failure, and creates no commit", () => {
    const { home, vault } = initializedHome("sorage-run-corrupt-");
    seedOneHandoff(home, vault);
    chmodManaged(vault, true);
    writeFileSync(join(vault, `artifacts/${HANDOFF_ID}/a-1/brief.md`), "# The brief, altered\n");
    chmodManaged(vault, false);
    const report = runOnce(home);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("ARTIFACT_CORRUPTED");
    const rows = backupRunRows(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failure", failure_code: "ARTIFACT_CORRUPTED" });
    expect(existsSync(join(vault, ".git"))).toBe(true);
    // A repository exists because the run ensures one before it verifies; no commit was made.
    expect(() => git(vault, "rev-parse", "HEAD")).toThrowError();
  });

  it("recovers from a crash after staging: the retry commits its own staged managed files", () => {
    const { home, vault } = initializedHome("sorage-run-crash-");
    seedOneHandoff(home, vault);
    const seen: string[] = [];
    const crashAfterStaging = delegatingClient((request, run) => {
      seen.push(request.args.join(" "));
      const outcome = run(request);
      if (request.args[0] === "add") {
        throw new Error("injected crash after staging");
      }
      return outcome;
    });
    const crashed = runOnce(home, { gitClient: crashAfterStaging });
    expect(crashed.ok).toBe(false);
    expect(backupRunRows(home)).toHaveLength(1);
    // The index now holds the crashed run's staged managed files; the retry
    // must treat them as its own instead of refusing them as unrelated work.
    const retry = runOnce(home);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.outcome).toBe("success");
    expect(git(vault, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(backupRunRows(home)).toHaveLength(2);
    for (const invocation of seen) {
      expect(invocation).not.toMatch(/\b(rebase|merge|pull|--force)\b/);
    }
  });

  it("never invokes a destructive Git operation across a full committed run", () => {
    const { home, vault } = initializedHome("sorage-run-safety-");
    seedOneHandoff(home, vault);
    const seen: string[] = [];
    const report = runOnce(home, {
      gitClient: delegatingClient((request, run) => {
        seen.push(request.args.join(" "));
        return run(request);
      }),
    });
    expect(report.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const invocation of seen) {
      expect(invocation, `destructive operation in: ${invocation}`).not.toMatch(/\b(rebase|merge|pull|--force)\b/);
    }
  });
});

function chmodManaged(vault: string, writable: boolean): void {
  spawnSync("chmod", [writable ? "u+w" : "444", join(vault, `artifacts/${HANDOFF_ID}/a-1/brief.md`)]);
}

/** Runs one real Git invocation, the delegate every wrapping client forwards to. */
function realGitRun(request: GitRunRequest): ReturnType<GitClient["run"]> {
  const completed = spawnSync("git", request.args, { cwd: request.cwd, encoding: "utf8" });
  return ok({
    exitCode: completed.status ?? -1,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
  } satisfies GitRunOutcome);
}

/** Wraps real Git execution with per-invocation behavior (the fault-injection seam of BKP-013). */
function delegatingClient(
  around: (
    request: GitRunRequest,
    run: (request: GitRunRequest) => ReturnType<GitClient["run"]>,
  ) => ReturnType<GitClient["run"]>,
): GitClient {
  return {
    run(request: GitRunRequest) {
      return around(request, realGitRun);
    },
  };
}

describe("backup run command surface and status over a real installation", () => {
  it("runs keyed, replays under the same key, and creates exactly one run and one commit", () => {
    const { home, vault } = initializedHome("sorage-run-cmd-");
    seedOneHandoff(home, vault);
    const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: home });
    const runPorts = ports.runPorts();
    if (!runPorts.ok) throw new Error(runPorts.error.message);
    const first = runBackupCommand(runPorts.value, { idempotencyKey: "key-1" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.replayed).toBe(false);
    const headAfterFirst = git(vault, "rev-parse", "HEAD").trim();

    const replayed = runBackupCommand(runPorts.value, { idempotencyKey: "key-1" });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.replayed).toBe(true);
      expect(replayed.value.runId).toBe(first.ok ? first.value.runId : "");
    }
    expect(git(vault, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(git(vault, "rev-parse", "HEAD").trim()).toBe(headAfterFirst);
    expect(backupRunRows(home)).toHaveLength(1);
  });

  it("treats the same backup key as a new request after 24 hours", () => {
    const { home, vault } = initializedHome("sorage-run-cmd-expiry-");
    seedOneHandoff(home, vault);
    const clock = new FakeClock();
    const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, clock });
    const runPorts = ports.runPorts();
    if (!runPorts.ok) throw new Error(runPorts.error.message);

    const first = runBackupCommand(runPorts.value, { idempotencyKey: "key-expiring" });
    expect(first.ok).toBe(true);
    clock.advance(24 * 3_600_000);
    const afterExpiry = runBackupCommand(runPorts.value, { idempotencyKey: "key-expiring" });

    expect(afterExpiry.ok).toBe(true);
    if (afterExpiry.ok) expect(afterExpiry.value.replayed).toBe(false);
    expect(backupRunRows(home)).toHaveLength(2);
  });

  it("exposes last attempt, success, commit, and failure through sorage backup status ports", () => {
    const { home, vault } = initializedHome("sorage-run-status-");
    seedOneHandoff(home, vault);
    const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: home });
    const runPorts = ports.runPorts();
    if (!runPorts.ok) throw new Error(runPorts.error.message);
    expect(runBackupCommand(runPorts.value, {}).ok).toBe(true);

    const statusPorts = ports.statusPorts();
    if (!statusPorts.ok) throw new Error(statusPorts.error.message);
    const report = backupStatus(statusPorts.value);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.lastAttempt?.outcome).toBe("success");
      expect(report.value.lastSuccess?.outcome).toBe("success");
      expect(report.value.lastCommit?.commitSha).toBe(git(vault, "rev-parse", "HEAD").trim());
      expect(report.value.lastPush).toBeNull();
      expect(report.value.lastFailure).toBeNull();
      expect(report.value.schedule.enabled).toBe(false);
      expect(report.value.nextDueAt).toBeNull();
      expect(typeof report.value.repositorySizeBytes).toBe("number");
    }
  });
});
