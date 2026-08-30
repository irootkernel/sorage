import { spawnSync } from "node:child_process";
import {
  type AppError,
  GIT_BATCH_ENV,
  GIT_TIMEOUT_MS,
  type GitClient,
  type GitRunOutcome,
  type GitRunRequest,
  gitInvocationError,
  type Result,
} from "@sorage/core";

/**
 * The production Git client (SEC-004, SEC-005, BKP-025): every invocation
 * spawns `git` with an argument array under `shell: false`, carries the
 * batch-mode environment so a missing credential fails fast instead of
 * prompting, and is bounded by the 60-second per-invocation timeout. A
 * completed spawn returns as data whatever its exit code, because callers like
 * `backup verify` read non-zero exits as findings; only a missing executable
 * or a timeout is a typed failure.
 */
export function createNodeGitClient(options: { timeoutMs?: number } = {}): GitClient {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  return {
    run(request: GitRunRequest): Result<GitRunOutcome, AppError> {
      let completed: ReturnType<typeof spawnSync>;
      try {
        completed = spawnSync("git", request.args, {
          cwd: request.cwd,
          shell: false,
          timeout: timeoutMs,
          encoding: "utf8",
          env: { ...process.env, ...GIT_BATCH_ENV },
        });
      } catch (error) {
        return gitInvocationError(request.args.join(" "), error);
      }
      if (completed.error !== undefined) {
        return gitInvocationError(request.args.join(" "), completed.error);
      }
      return {
        ok: true,
        value: {
          exitCode: completed.status ?? -1,
          stdout: typeof completed.stdout === "string" ? completed.stdout : "",
          stderr: typeof completed.stderr === "string" ? completed.stderr : "",
        },
      };
    },
  };
}
