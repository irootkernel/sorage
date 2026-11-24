import {
  type AppError,
  type AsyncVaultGitRepository,
  err,
  MANAGED_PATHSPECS,
  ok,
  type Result,
  type VaultGitRepository,
} from "@sorage/core";
import {
  type AsyncGitClient,
  classifyPushFailure,
  createNodeAsyncGitClient,
  createNodeGitClient,
  GIT_ARGS,
  type GitClient,
  gitStateConflict,
} from "./git-client";

const STAGE_MANAGED_ARGS = ["add", "--", ...MANAGED_PATHSPECS];
const CHANGE_TEST_ARGS = ["diff", "--cached", "--quiet", "--", ...MANAGED_PATHSPECS];
const COMMIT_ARGS = (message: string): string[] => [
  "-c",
  "user.name=Sorage Backup",
  "-c",
  "user.email=sorage@localhost",
  "commit",
  "-m",
  message,
];
const REV_PARSE_HEAD_ARGS = ["rev-parse", "HEAD"];
const PUSH_ARGS = (remote: string, branch: string): string[] => ["push", "--atomic", remote, branch];

function splitLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/**
 * Semantic Git repository adapter over `GitClient` (BKP-024, BKP-025).
 * Owns Git CLI argument arrays, exit-code translation, HEAD resolution, and
 * push failure classification while leaving managed-path policy in `@sorage/core`.
 */
export function createNodeVaultGitRepository(
  vaultPath: string,
  gitClient: GitClient = createNodeGitClient(),
): VaultGitRepository {
  const run = (args: string[]) => gitClient.run({ cwd: vaultPath, args });
  return {
    initialize(branch) {
      const init = run(GIT_ARGS.init(branch));
      if (!init.ok) return err(init.error);
      if (init.value.exitCode !== 0) return gitStateConflict("init", init.value);
      const autocrlf = run(GIT_ARGS.configSet("core.autocrlf", "false"));
      if (!autocrlf.ok) return err(autocrlf.error);
      if (autocrlf.value.exitCode !== 0) return gitStateConflict("config core.autocrlf=false", autocrlf.value);
      return ok(undefined);
    },
    autocrlf() {
      const result = run(GIT_ARGS.configGet("core.autocrlf"));
      if (!result.ok) return err(result.error);
      return ok(result.value.exitCode === 0 ? result.value.stdout.trim() : "");
    },
    currentBranch() {
      const result = run(GIT_ARGS.currentBranch());
      if (!result.ok) return err(result.error);
      return ok(result.value.exitCode === 0 ? result.value.stdout.trim() : "");
    },
    stagedPaths() {
      const result = run(GIT_ARGS.stagedFiles());
      if (!result.ok) return err(result.error);
      return ok(splitLines(result.value.stdout));
    },
    trackedPaths() {
      const result = run(GIT_ARGS.lsFiles());
      if (!result.ok) return err(result.error);
      return ok(splitLines(result.value.stdout));
    },
    stageManaged() {
      const added = run(STAGE_MANAGED_ARGS);
      if (!added.ok) return err(added.error);
      if (added.value.exitCode !== 0) return gitStateConflict("add", added.value);
      return ok(undefined);
    },
    hasStagedManagedChanges() {
      const changeTest = run(CHANGE_TEST_ARGS);
      if (!changeTest.ok) return err(changeTest.error);
      if (changeTest.value.exitCode === 0) return ok(false);
      if (changeTest.value.exitCode === 1) return ok(true);
      return gitStateConflict("diff --cached --quiet", changeTest.value);
    },
    commit(message) {
      const committed = run(COMMIT_ARGS(message));
      if (!committed.ok) return err(committed.error);
      if (committed.value.exitCode !== 0) return gitStateConflict("commit", committed.value);
      const head = run(REV_PARSE_HEAD_ARGS);
      if (!head.ok) return err(head.error);
      return ok({ sha: head.value.exitCode === 0 ? head.value.stdout.trim() : null });
    },
    push(target) {
      const pushed = run(PUSH_ARGS(target.remote, target.branch));
      if (!pushed.ok) return err(pushed.error);
      if (pushed.value.exitCode !== 0) return err(classifyPushFailure(pushed.value));
      return ok(undefined);
    },
  };
}

/** Asynchronous counterpart of `createNodeVaultGitRepository` for daemon backup runs. */
export function createNodeAsyncVaultGitRepository(
  vaultPath: string,
  gitClient: AsyncGitClient = createNodeAsyncGitClient(),
): AsyncVaultGitRepository {
  const run = (args: string[]) => gitClient.run({ cwd: vaultPath, args });
  return {
    async initialize(branch): Promise<Result<void, AppError>> {
      const init = await run(GIT_ARGS.init(branch));
      if (!init.ok) return err(init.error);
      if (init.value.exitCode !== 0) return gitStateConflict("init", init.value);
      const autocrlf = await run(GIT_ARGS.configSet("core.autocrlf", "false"));
      if (!autocrlf.ok) return err(autocrlf.error);
      if (autocrlf.value.exitCode !== 0) return gitStateConflict("config core.autocrlf=false", autocrlf.value);
      return ok(undefined);
    },
    async autocrlf(): Promise<Result<string, AppError>> {
      const result = await run(GIT_ARGS.configGet("core.autocrlf"));
      if (!result.ok) return err(result.error);
      return ok(result.value.exitCode === 0 ? result.value.stdout.trim() : "");
    },
    async currentBranch(): Promise<Result<string, AppError>> {
      const result = await run(GIT_ARGS.currentBranch());
      if (!result.ok) return err(result.error);
      return ok(result.value.exitCode === 0 ? result.value.stdout.trim() : "");
    },
    async stagedPaths(): Promise<Result<string[], AppError>> {
      const result = await run(GIT_ARGS.stagedFiles());
      if (!result.ok) return err(result.error);
      return ok(splitLines(result.value.stdout));
    },
    async trackedPaths(): Promise<Result<string[], AppError>> {
      const result = await run(GIT_ARGS.lsFiles());
      if (!result.ok) return err(result.error);
      return ok(splitLines(result.value.stdout));
    },
    async stageManaged(): Promise<Result<void, AppError>> {
      const added = await run(STAGE_MANAGED_ARGS);
      if (!added.ok) return err(added.error);
      if (added.value.exitCode !== 0) return gitStateConflict("add", added.value);
      return ok(undefined);
    },
    async hasStagedManagedChanges(): Promise<Result<boolean, AppError>> {
      const changeTest = await run(CHANGE_TEST_ARGS);
      if (!changeTest.ok) return err(changeTest.error);
      if (changeTest.value.exitCode === 0) return ok(false);
      if (changeTest.value.exitCode === 1) return ok(true);
      return gitStateConflict("diff --cached --quiet", changeTest.value);
    },
    async commit(message): Promise<Result<{ sha: string | null }, AppError>> {
      const committed = await run(COMMIT_ARGS(message));
      if (!committed.ok) return err(committed.error);
      if (committed.value.exitCode !== 0) return gitStateConflict("commit", committed.value);
      const head = await run(REV_PARSE_HEAD_ARGS);
      if (!head.ok) return err(head.error);
      return ok({ sha: head.value.exitCode === 0 ? head.value.stdout.trim() : null });
    },
    async push(target): Promise<Result<void, AppError>> {
      const pushed = await run(PUSH_ARGS(target.remote, target.branch));
      if (!pushed.ok) return err(pushed.error);
      if (pushed.value.exitCode !== 0) return err(classifyPushFailure(pushed.value));
      return ok(undefined);
    },
  };
}
