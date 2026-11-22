import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeAsyncGitClient } from "../../src/git-client";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("createNodeAsyncGitClient (RUN-005, BKP-025)", () => {
  it("runs git asynchronously, returns non-zero exits as data, and handles invalid cwd as INTERNAL_ERROR", async () => {
    const dir = tempDir("sorage-async-git-");
    const client = createNodeAsyncGitClient();

    const version = await client.run({ cwd: dir, args: ["--version"] });
    expect(version.ok).toBe(true);
    if (version.ok) {
      expect(version.value.exitCode).toBe(0);
      expect(version.value.stdout.toLowerCase()).toContain("git version");
    }

    // Non-zero exit returns as data (matching createNodeGitClient).
    const status = await client.run({ cwd: dir, args: ["rev-parse", "--is-inside-work-tree"] });
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.exitCode).not.toBe(0);
      expect(status.value.stderr.length).toBeGreaterThan(0);
    }

    // Missing cwd surfaces as INTERNAL_ERROR via gitInvocationError.
    const badCwd = await client.run({ cwd: join(dir, "does-not-exist"), args: ["--version"] });
    expect(badCwd.ok).toBe(false);
    if (!badCwd.ok) {
      expect(badCwd.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("enforces timeoutMs with INTERNAL_ERROR without blocking the event loop", async () => {
    const root = tempDir("sorage-async-git-timeout-");
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "a.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-m", "init"]);

    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nsleep 5\nexit 0\n");
    chmodSync(hook, 0o755);

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      const client = createNodeAsyncGitClient({ timeoutMs: 250 });
      const started = performance.now();
      const outcome = await client.run({ cwd: repo, args: ["push", "--atomic", "origin", "main"] });
      const elapsed = performance.now() - started;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe("INTERNAL_ERROR");
        expect(outcome.error.message).toContain("timed out");
      }
      expect(elapsed).toBeLessThan(2_000);
      expect(ticks).toBeGreaterThanOrEqual(4);
    } finally {
      clearInterval(ticker);
    }
  }, 15_000);

  it("rejects runaway stdout past maxOutputBytes with INTERNAL_ERROR", async () => {
    const dir = tempDir("sorage-async-git-cap-");
    const client = createNodeAsyncGitClient({ maxOutputBytes: 8 });
    const outcome = await client.run({ cwd: dir, args: ["--version"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INTERNAL_ERROR");
      expect(outcome.error.message).toContain("capture bound");
    }
  });
});
