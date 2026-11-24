import { spawn, spawnSync } from "node:child_process";
import { type AppError, appError, err, type Result } from "@sorage/core";

/**
 * The Git client port of section 16 of domain-and-architecture.md and the Git
 * safety rules of section 13 of security-reliability.md (SEC-004, SEC-005,
 * BKP-025): every invocation runs as an argument array with `shell: false`,
 * carries the batch-mode environment so a credential prompt fails instead of
 * hanging, and is bounded by the 60-second per-invocation timeout. The port
 * returns any completed spawn as data — callers decide whether an exit code is
 * a finding, a typed failure, or an expected absence — while a missing
 * executable or a timeout is the typed failure it is.
 */

/** One Git invocation: a working directory and an argument array, never a shell string. */
export interface GitRunRequest {
  cwd: string;
  args: string[];
}

export interface GitRunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitClient {
  run(request: GitRunRequest): Result<GitRunOutcome, AppError>;
}

/** Asynchronous Git client used by the daemon runtime so `git` never blocks the HTTP event loop. */
export interface AsyncGitClient {
  run(request: GitRunRequest): Promise<Result<GitRunOutcome, AppError>>;
}

/** The per-invocation timeout every Git call runs under (BKP-025). */
export const GIT_TIMEOUT_MS = 60_000;

/** The batch-mode environment the adapter injects into every Git invocation (BKP-025). */
export const GIT_BATCH_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/true",
  SSH_ASKPASS_REQUIRE: "never",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
} as const;

/** Argument arrays for the operations the backup surface uses; never interpolated shell strings. */
export const GIT_ARGS = {
  init: (branch: string) => ["init", "-b", branch],
  configSet: (key: string, value: string) => ["config", "--local", key, value],
  configGet: (key: string) => ["config", "--local", "--get", key],
  lsFiles: () => ["ls-files"],
  stagedFiles: () => ["diff", "--cached", "--name-only"],
  currentBranch: () => ["symbolic-ref", "--short", "HEAD"],
} as const;

/** Builds the typed failure for a Git invocation that cannot complete at all. */
export function gitInvocationError(context: string, cause: unknown): Result<never, AppError> {
  return err(
    appError(
      "INTERNAL_ERROR",
      `Running git ${context} failed: ${cause instanceof Error ? cause.message : String(cause)}.`,
      {
        cause: String(cause),
      },
    ),
  );
}

/** Builds the typed failure for a Git invocation that completed but may not proceed (section 28). */
export function gitStateConflict(
  context: string,
  outcome: { exitCode: number; stderr: string },
): Result<never, AppError> {
  return err(
    appError("GIT_BACKUP_CONFLICT", `git ${context} refused: ${outcome.stderr.trim() || `exit ${outcome.exitCode}`}.`, {
      exitCode: outcome.exitCode,
    }),
  );
}

const AUTH_FAILURE_PATTERNS = [
  "terminal prompts disabled",
  "could not read username",
  "unable to get password from user",
  "authentication failed",
  "permission denied",
  "publickey",
  "batchmode",
];

/**
 * Classifies a refused push (BKP-014, BKP-025): with prompts disabled, a
 * missing credential announces itself as a disabled prompt or an
 * authentication refusal, and everything else - a non-fast-forward above all -
 * is the manual Git state the User must resolve.
 */
export function classifyPushFailure(outcome: { exitCode: number; stderr: string; stdout: string }): AppError {
  const text = `${outcome.stderr}
${outcome.stdout}`.toLowerCase();
  if (AUTH_FAILURE_PATTERNS.some((pattern) => text.includes(pattern))) {
    return appError(
      "GIT_AUTH_REQUIRED",
      `Pushing to the remote needs a credential that batch mode cannot supply: ${outcome.stderr.trim().split("\n")[0] ?? ""}`.trim(),
      { exitCode: outcome.exitCode },
    );
  }
  return appError(
    "GIT_BACKUP_CONFLICT",
    `The push was refused; resolve the remote state manually, Sorage never force pushes: ${outcome.stderr.trim().split("\n")[0] ?? ""}`.trim(),
    { exitCode: outcome.exitCode },
  );
}

/** Generous per-stream capture bound (16 MiB) so large Vault diffs succeed while runaway output cannot OOM the daemon. */
const MAX_ASYNC_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

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

/**
 * Asynchronous counterpart of `createNodeGitClient` for the daemon event loop
 * (RUN-005, BKP-025): spawns `git` with `shell: false` and `GIT_BATCH_ENV`,
 * bounds captured stdout/stderr, enforces `timeoutMs` with `SIGTERM` followed by
 * an unref'd `SIGKILL` backstop, and settles at most once across sync throws,
 * spawn errors, timeouts, and normal closes.
 */
export function createNodeAsyncGitClient(
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): AsyncGitClient {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_ASYNC_GIT_OUTPUT_BYTES;
  return {
    run(request: GitRunRequest): Promise<Result<GitRunOutcome, AppError>> {
      const context = request.args.join(" ");
      return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn("git", request.args, {
            cwd: request.cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...GIT_BATCH_ENV },
          });
        } catch (error) {
          resolve(gitInvocationError(context, error));
          return;
        }

        let settled = false;
        let timedOut = false;
        let outputOverflowed = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTimers = () => {
          if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
          }
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
            killTimer = undefined;
          }
        };

        const terminateChild = () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          try {
            child.kill("SIGTERM");
          } catch {
            // Best-effort termination; the child may have already exited.
          }
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // Already exited.
            }
          }, 1_000);
          killTimer.unref?.();
        };

        const settle = (outcome: Result<GitRunOutcome, AppError>) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        timeoutTimer = setTimeout(() => {
          timedOut = true;
          if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
          }
          terminateChild();
          const error = Object.assign(new Error(`git ${context} timed out after ${timeoutMs}ms`), {
            code: "ETIMEDOUT",
          });
          settle(gitInvocationError(context, error));
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          if (settled || outputOverflowed) return;
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > maxOutputBytes) {
            outputOverflowed = true;
            clearTimers();
            terminateChild();
            settle(
              gitInvocationError(
                context,
                new Error(`git ${context} stdout exceeded the ${maxOutputBytes}-byte capture bound`),
              ),
            );
            return;
          }
          stdoutChunks.push(chunk);
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          if (settled || outputOverflowed) return;
          stderrBytes += chunk.byteLength;
          if (stderrBytes > maxOutputBytes) {
            outputOverflowed = true;
            clearTimers();
            terminateChild();
            settle(
              gitInvocationError(
                context,
                new Error(`git ${context} stderr exceeded the ${maxOutputBytes}-byte capture bound`),
              ),
            );
            return;
          }
          stderrChunks.push(chunk);
        });

        child.once("error", (error) => {
          clearTimers();
          settle(gitInvocationError(context, error));
        });

        child.once("close", (code) => {
          clearTimers();
          if (timedOut) {
            const error = Object.assign(new Error(`git ${context} timed out after ${timeoutMs}ms`), {
              code: "ETIMEDOUT",
            });
            settle(gitInvocationError(context, error));
            return;
          }
          if (outputOverflowed) return;
          settle({
            ok: true,
            value: {
              exitCode: code ?? -1,
              stdout: Buffer.concat(stdoutChunks).toString("utf8"),
              stderr: Buffer.concat(stderrChunks).toString("utf8"),
            },
          });
        });
      });
    },
  };
}
