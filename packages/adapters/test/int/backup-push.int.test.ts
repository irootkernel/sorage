import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type GitClient,
  type GitRunOutcome,
  type GitRunRequest,
  initializeInstallation,
  ok,
  runBackupOnce,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts, nodeEnsureVaultGit } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { FakeClock } from "../../src/testkit";

/**
 * The TASK-057 push matrix over a real bare remote (BKP-011, BKP-012,
 * BKP-014, BKP-025): an enabled push reaches the remote atomically after the
 * commit, a divergent remote refuses with GIT_BACKUP_CONFLICT while the local
 * commit and the remote stay intact, and a credential demand under batch mode
 * classifies as GIT_AUTH_REQUIRED without ever prompting.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)();
  delete process.env.SORAGE_HOME;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function initializedHome(prefix: string): { home: string; vault: string } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: homedir(), clock: new FakeClock() });
  if (!initializeInstallation(ports, { vaultPath: vault }).ok) throw new Error("init failed");
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

function enablePush(home: string, vault: string, remotePath: string): void {
  nodeEnsureVaultGit(vault, "installation", new FakeClock(), "main");
  git(vault, "remote", "add", "origin", remotePath);
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  const config = readFileSync(join(home, "config.yaml"), "utf8");
  writeFileSync(join(home, "config.yaml"), config.replace("push:\n    enabled: false", "push:\n    enabled: true"));
  db.close();
}

function runOnce(home: string, options: { gitClient?: GitClient } = {}) {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: homedir(), ...options });
  const runPorts = ports.runPorts();
  if (!runPorts.ok) throw new Error(runPorts.error.message);
  return runBackupOnce(runPorts.value);
}

function rowsOf(home: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    return db.prepare("SELECT * FROM backup_runs ORDER BY started_at").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("runBackupOnce with an enabled push", () => {
  function emptyBareRemote(): { remotePath: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "sorage-push-remote-"));
    const remotePath = join(root, "remote.git");
    execFileSync("git", ["-C", root, "init", "--bare", remotePath]);
    return { remotePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("pushes the commit to the bare remote atomically and records the pushed outcome", () => {
    const fixture = emptyBareRemote();
    cleanups.push(fixture.cleanup);
    const { home, vault } = initializedHome("sorage-push-ok-");
    seedOneHandoff(home, vault);
    enablePush(home, vault, fixture.remotePath);

    const report = runOnce(home);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.push).toBe("pushed");
      expect(report.value.commitSha).toBe(git(fixture.remotePath, "rev-parse", "main").trim());
    }
    expect(git(fixture.remotePath, "rev-parse", "main").trim()).toBe(git(vault, "rev-parse", "HEAD").trim());
    expect(rowsOf(home)[0]).toMatchObject({ outcome: "success", push_outcome: "pushed" });
  });

  it("refuses a divergent remote with GIT_BACKUP_CONFLICT, leaving the local commit and the remote intact", () => {
    const fixture = emptyBareRemote();
    cleanups.push(fixture.cleanup);
    const { home, vault } = initializedHome("sorage-push-conflict-");
    seedOneHandoff(home, vault);
    enablePush(home, vault, fixture.remotePath);

    // The first run pushes commit A; the remote now shares the Vault's history.
    expect(runOnce(home).ok).toBe(true);

    // Diverge the remote: a second clone commits and pushes ahead of the Vault.
    execFileSync("git", ["clone", fixture.remotePath, join(fixture.remotePath, "..", "second-clone")], {
      cwd: fixture.remotePath,
    });
    const secondClone = join(fixture.remotePath, "..", "second-clone");
    writeFileSync(join(secondClone, "divergent.txt"), "ahead\n");
    git(secondClone, "add", "divergent.txt");
    git(secondClone, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "divergent");
    git(secondClone, "push", "origin", "main");
    const remoteHead = git(fixture.remotePath, "rev-parse", "main").trim();

    // New Vault content produces a local commit the remote refuses.
    writeFileSync(join(vault, ".gitattributes"), `${readFileSync(join(vault, ".gitattributes"), "utf8")}`);
    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    db.prepare(
      "INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES ('e-2', NULL, 'CONFIG_CHANGED', 'user', NULL, NULL, '{}', '2026-01-03T00:00:00.000Z')",
    ).run();
    db.close();
    const report = runOnce(home);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("GIT_BACKUP_CONFLICT");
    // The local commits exist and the remote is unchanged; no force was attempted.
    expect(Number(git(vault, "rev-list", "--count", "HEAD").trim())).toBeGreaterThanOrEqual(2);
    expect(git(fixture.remotePath, "rev-parse", "main").trim()).toBe(remoteHead);
    const rows = rowsOf(home);
    expect(rows[rows.length - 1]).toMatchObject({
      outcome: "failure",
      commit_outcome: "committed",
      push_outcome: "failure",
      failure_code: "GIT_BACKUP_CONFLICT",
    });
  });

  it("classifies a batch-mode credential demand as GIT_AUTH_REQUIRED without prompting", () => {
    const fixture = emptyBareRemote();
    cleanups.push(fixture.cleanup);
    const { home, vault } = initializedHome("sorage-push-auth-");
    seedOneHandoff(home, vault);
    enablePush(home, vault, fixture.remotePath);

    // The fault-injection seam the SoT names: simulate the disabled-credential
    // prompt git itself produces under GIT_TERMINAL_PROMPT=0.
    const demandingCredentials: GitClient = {
      run(request: GitRunRequest) {
        if (request.args[0] !== "push") return realRun(request);
        return ok({
          exitCode: 128,
          stdout: "",
          stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
        } satisfies GitRunOutcome);
      },
    };
    const report = runOnce(home, { gitClient: demandingCredentials });
    expect(report.ok).toBe(false);
    expect(!report.ok && report.error.code).toBe("GIT_AUTH_REQUIRED");
    expect(rowsOf(home)[0]).toMatchObject({ failure_code: "GIT_AUTH_REQUIRED" });
  });
});

function realRun(request: GitRunRequest): ReturnType<GitClient["run"]> {
  const completed = spawnSync("git", request.args, { cwd: request.cwd, encoding: "utf8" });
  return ok({
    exitCode: completed.status ?? -1,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
  } satisfies GitRunOutcome);
}
