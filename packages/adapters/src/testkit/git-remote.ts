import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitRemoteFixture {
  /** Directory holding the bare repository that acts as the remote. */
  remotePath: string;
  /** A second clone of the remote, as a distinct working directory. */
  clonePath: string;
  /** The original working clone used to seed remote content. */
  seedPath: string;
  cleanup: () => void;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
}

/**
 * Creates a bare Git remote plus a second clone, for tests that need two working
 * directories of one repository (for example worktree-folding or backup drills).
 */
export function makeGitRemote(): GitRemoteFixture {
  const root = mkdtempSync(join(tmpdir(), "sorage-test-git-"));
  const remotePath = join(root, "remote.git");
  const seedPath = join(root, "seed");
  const clonePath = join(root, "clone");
  git(root, "init", "--bare", remotePath);
  git(root, "clone", remotePath, seedPath);
  git(seedPath, "config", "user.email", "test@sorage.invalid");
  git(seedPath, "config", "user.name", "Sorage Test");
  writeFileSync(join(seedPath, "README.md"), "# seed\n");
  git(seedPath, "add", "README.md");
  git(seedPath, "commit", "-m", "seed");
  git(seedPath, "push", "origin", "HEAD:refs/heads/main");
  git(root, "clone", remotePath, clonePath);
  return {
    remotePath,
    clonePath,
    seedPath,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
