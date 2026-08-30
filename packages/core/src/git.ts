import { type AppError, appError, err, type Result } from "./errors";

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
  init: () => ["init"],
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

/**
 * The runtime files section 26 excludes from every backup (BKP-004): the
 * SQLite database and its WAL and SHM siblings, logs, the API token, the web
 * secret, and anything that names itself a credential. They normally live
 * outside the Vault entirely; `git ls-files` proves none was ever committed by
 * accident.
 */
export function isRuntimeTrackedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name.endsWith(".sqlite3") || name.endsWith(".sqlite3-wal") || name.endsWith(".sqlite3-shm")) return true;
  if (name.endsWith(".log")) return true;
  if (name === "api-token" || name === "web-secret") return true;
  if (name.includes("credential")) return true;
  return false;
}

/** The five managed pathspecs section 26 permits Sorage to stage and commit. */
export const MANAGED_PATHSPECS = [
  ".sorage-vault.json",
  ".gitattributes",
  ".gitignore",
  "artifacts",
  "snapshots",
] as const;

/** True when one staged or tracked path belongs to the managed pathspecs (section 28). */
export function isManagedVaultPath(path: string): boolean {
  return (
    path === ".sorage-vault.json" ||
    path === ".gitattributes" ||
    path === ".gitignore" ||
    path.startsWith("artifacts/") ||
    path.startsWith("snapshots/")
  );
}

/** The staged paths outside the managed set — the only ones section 28 refuses. */
export function unmanagedStagedPaths(staged: string[]): string[] {
  return staged.filter((path) => !isManagedVaultPath(path));
}
