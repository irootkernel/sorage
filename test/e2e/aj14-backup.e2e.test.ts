import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BINARY, makeTempDir, registerCleanup, runCleanups, sorage } from "./helpers";

/**
 * AJ-14, the daily Git backup journey, over the compiled binary: initialize
 * the Vault repository, enable the schedule, run a backup that commits the
 * managed pathspecs, rerun it with nothing changed and observe no second
 * commit, enable push to a bare remote, meet a divergent remote with
 * GIT_BACKUP_CONFLICT and no force attempt, and verify the configuration. The
 * clock-driven DST and sleep-gap steps of the journey run in the daemon
 * scheduler integration suite, which drives the tick with an injected clock.
 */
afterAll(() => {
  runCleanups();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

describe("AJ-14 the daily Git backup", () => {
  it("walks enable, run, no-change, divergent push, and verify with the real binary", () => {
    const home = makeTempDir("sorage-aj14-home-");
    const work = makeTempDir("sorage-aj14-work-");
    const vault = join(home, "vault");

    // 1. Initialize a Vault Git repository and enable the daily schedule.
    const init = sorage(["init", "--vault", vault, "--initialize-git", "--non-interactive"], { home });
    expect(init.status).toBe(0);
    expect(existsSync(join(vault, ".git"))).toBe(true);
    const enable = sorage(["backup", "enable", "--daily-at", "03:00", "--timezone", "Asia/Seoul", "--as-user"], {
      home,
    });
    expect(enable.status).toBe(0);

    // Seed one Handoff through the real CLI so a backup has managed content.
    const brief = join(work, "brief.md");
    writeFileSync(brief, "# The AJ-14 brief\n");
    mkdirSync(join(home, "beta"), { recursive: true });
    sorage(["project", "add", "--name", "Alpha", "--dir", work, "--json"], { home, cwd: work });
    sorage(["project", "add", "--name", "Beta", "--dir", join(home, "beta"), "--json"], { home, cwd: work });
    const send = sorage(
      ["send", "--as", "alpha", "--to", "beta", "--title", "AJ-14 brief", "--file", brief, "--json"],
      { home, cwd: work },
    );
    expect(send.status).toBe(0);

    // 4. Run the backup and verify the snapshot, the ledger export, the commit, and status.
    const first = sorage(["backup", "run", "--json"], { home });
    expect(first.status).toBe(0);
    const firstEnvelope = JSON.parse(first.stdout) as { data: { outcome: string; commit: string; commitSha: string } };
    expect(firstEnvelope.data.outcome).toBe("success");
    expect(firstEnvelope.data.commit).toBe("committed");
    expect(existsSync(join(vault, "snapshots/events.jsonl"))).toBe(true);
    expect(git(vault, "log", "-1", "--pretty=%s")).toContain("sorage backup:");
    const status = sorage(["backup", "status", "--json"], { home });
    expect(status.status).toBe(0);
    const statusEnvelope = JSON.parse(status.stdout) as {
      data: { lastCommit: { commitSha: string } | null; schedule: { enabled: boolean }; nextDueAt: string | null };
    };
    expect(statusEnvelope.data.lastCommit?.commitSha).toBe(firstEnvelope.data.commitSha);
    expect(statusEnvelope.data.schedule.enabled).toBe(true);
    expect(statusEnvelope.data.nextDueAt).not.toBeNull();

    // 5. Run it again with nothing changed: no second commit.
    const headBefore = git(vault, "rev-parse", "HEAD").trim();
    const second = sorage(["backup", "run", "--json"], { home });
    expect(second.status).toBe(0);
    const secondEnvelope = JSON.parse(second.stdout) as { data: { outcome: string } };
    expect(secondEnvelope.data.outcome).toBe("no-change");
    expect(git(vault, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(vault, "rev-list", "--count", "HEAD").trim()).toBe("1");

    // 6. Enable push, diverge the remote from a second clone, and meet GIT_BACKUP_CONFLICT.
    const remoteRoot = makeTempDir("sorage-aj14-remote-");
    const remote = join(remoteRoot, "remote.git");
    execFileSync("git", ["-C", remoteRoot, "init", "--bare", remote]);
    git(vault, "remote", "add", "origin", remote);
    const enablePush = sorage(["backup", "enable-push", "--remote", "origin", "--branch", "main", "--as-user"], {
      home,
    });
    expect(enablePush.status).toBe(0);
    // The first push establishes the shared history.
    const pushed = sorage(["backup", "run", "--json"], { home });
    expect(pushed.status).toBe(0);
    expect(git(remote, "rev-parse", "main").trim()).toBe(git(vault, "rev-parse", "HEAD").trim());
    // Diverge: the second clone commits and pushes ahead of the Vault.
    execFileSync("git", ["clone", remote, join(remoteRoot, "second")]);
    const secondClone = join(remoteRoot, "second");
    writeFileSync(join(secondClone, "divergent.txt"), "ahead\n");
    git(secondClone, "add", "divergent.txt");
    git(secondClone, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "divergent");
    git(secondClone, "push", "origin", "main");
    const remoteHead = git(remote, "rev-parse", "main").trim();
    // New Vault content produces a local commit the remote refuses.
    const revised = join(work, "revised.md");
    writeFileSync(revised, "# The AJ-14 brief, revised\n");
    const handoffId = (JSON.parse(send.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId;
    sorage(["revise", handoffId as string, "--as", "alpha", "--file", revised, "--json"], { home, cwd: work });
    const conflict = sorage(["backup", "run", "--json"], { home });
    expect(conflict.status).toBe(75);
    const conflictEnvelope = JSON.parse(conflict.stderr) as { error: { code: string } };
    expect(conflictEnvelope.error.code).toBe("GIT_BACKUP_CONFLICT");
    // No force, no rebase: the local commit exists and the remote is untouched.
    expect(Number(git(vault, "rev-list", "--count", "HEAD").trim())).toBeGreaterThanOrEqual(2);
    expect(git(remote, "rev-parse", "main").trim()).toBe(remoteHead);

    // 8. The backup configuration verifies clean.
    const verify = sorage(["backup", "verify", "--json"], { home });
    expect(verify.status).toBe(0);
    expect(existsSync(BINARY)).toBe(true);
    expect(readFileSync(join(vault, ".gitattributes"), "utf8")).toContain("artifacts/** -text -diff");
  }, 60000);

  it("keeps the Git invocations prompt-free: a credential demand fails fast instead of hanging", async () => {
    const home = makeTempDir("sorage-aj14-auth-home-");
    const vault = join(home, "vault");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const init = sorage(["init", "--vault", vault, "--initialize-git", "--non-interactive"], { home });
    expect(init.status).toBe(0);

    // A server answering 401 to every request, hosted in its own process so
    // the blocking run below cannot freeze its event loop: git's smart-http
    // handshake turns the refusal into a credential demand, which batch mode
    // refuses instead of prompting.
    const helperDir = makeTempDir("sorage-aj14-auth-");
    const helperPath = join(helperDir, "auth401.cjs");
    writeFileSync(
      helperPath,
      [
        "const http = require('node:http');",
        "const server = http.createServer(function (_request, response) {",
        "  response.writeHead(401, { 'WWW-Authenticate': 'Basic realm=sorage-aj14' });",
        "  response.end('unauthorized');",
        "});",
        "server.listen(0, '127.0.0.1', function () {",
        "  process.stdout.write(String(server.address().port) + '\\n');",
        "});",
        "",
      ].join("\n"),
    );
    const serverProcess = spawn("node", [helperPath], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const bound = await new Promise<number>((resolve, reject) => {
      let seen = "";
      serverProcess.stdout?.on("data", (chunk: Buffer) => {
        seen += chunk.toString("utf8");
        const port = Number(seen.trim());
        if (Number.isInteger(port) && port > 0) resolve(port);
      });
      serverProcess.on("exit", () => reject(new Error(`the 401 helper exited early: ${seen}`)));
    });
    registerCleanup(() => {
      try {
        serverProcess.kill("SIGKILL");
      } catch {
        // The helper may already have exited.
      }
    });

    const brief = join(work, "brief.md");
    writeFileSync(brief, "# brief\n");
    sorage(["project", "add", "--name", "Alpha", "--dir", work, "--json"], { home, cwd: work });
    const sent = sorage(["send", "--as", "alpha", "--to", "alpha", "--title", "b", "--file", brief, "--json"], {
      home,
      cwd: work,
    });
    expect(sent.status).toBe(0);
    git(vault, "remote", "add", "origin", `http://127.0.0.1:${String(bound)}/vault.git`);
    const enablePush = sorage(["backup", "enable-push", "--remote", "origin", "--branch", "main", "--as-user"], {
      home,
    });
    expect(enablePush.status).toBe(0);
    const refused = spawnSync(BINARY, ["backup", "run", "--json"], {
      encoding: "utf8",
      cwd: work,
      timeout: 70_000,
      env: { ...process.env, SORAGE_HOME: home },
    });
    if (refused.status !== 77) {
      console.log(
        "AUTH DEBUG status",
        refused.status,
        "stdout:",
        refused.stdout.slice(0, 400),
        "stderr:",
        refused.stderr.slice(0, 400),
      );
    }
    expect(refused.status).toBe(77);
    const envelope = JSON.parse(refused.stderr as string) as { error: { code: string } };
    expect(envelope.error.code).toBe("GIT_AUTH_REQUIRED");
  }, 90000);
});
