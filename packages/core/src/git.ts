import type { AppError, Result } from "./errors";

/**
 * Semantic Git repository ports and managed-path policy for Vault backups
 * (BKP-004, BKP-024, BKP-025). Raw Git CLI arguments, invocation error
 * formatting, and push failure classification live in `@sorage/adapters`.
 */

export interface VaultGitRepository {
  /** Initializes the Vault repository on `branch` and sets `core.autocrlf=false`. */
  initialize(branch: string): Result<void, AppError>;
  /** Reads repository-local `core.autocrlf`, or `""` when unset. */
  autocrlf(): Result<string, AppError>;
  /** Reads the current branch name, or `""` on a detached HEAD. */
  currentBranch(): Result<string, AppError>;
  /** Lists currently staged paths relative to the Vault root. */
  stagedPaths(): Result<string[], AppError>;
  /** Lists tracked paths relative to the Vault root. */
  trackedPaths(): Result<string[], AppError>;
  /** Stages exactly `MANAGED_PATHSPECS`. */
  stageManaged(): Result<void, AppError>;
  /** Returns true when staged managed paths differ from HEAD. */
  hasStagedManagedChanges(): Result<boolean, AppError>;
  /** Commits staged changes and resolves HEAD (`sha: null` when rev-parse exits non-zero). */
  commit(message: string): Result<{ sha: string | null }, AppError>;
  /** Pushes atomically to the configured remote and branch. */
  push(target: { remote: string; branch: string }): Result<void, AppError>;
}

/** Asynchronous mirror of `VaultGitRepository` for daemon backup runs. */
export interface AsyncVaultGitRepository {
  initialize(branch: string): Promise<Result<void, AppError>>;
  autocrlf(): Promise<Result<string, AppError>>;
  currentBranch(): Promise<Result<string, AppError>>;
  stagedPaths(): Promise<Result<string[], AppError>>;
  trackedPaths(): Promise<Result<string[], AppError>>;
  stageManaged(): Promise<Result<void, AppError>>;
  hasStagedManagedChanges(): Promise<Result<boolean, AppError>>;
  commit(message: string): Promise<Result<{ sha: string | null }, AppError>>;
  push(target: { remote: string; branch: string }): Promise<Result<void, AppError>>;
}

/**
 * The runtime files section 26 excludes from every backup (BKP-004): the
 * SQLite database and its WAL and SHM siblings, logs, the API token, the web
 * secret, and anything that names itself a credential. They normally live
 * outside the Vault entirely; `trackedPaths` proves none was ever committed by
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

/** The managed pathspecs section 26 permits Sorage to stage and commit; `content` exists from M9 (SHR-011). */
export const MANAGED_PATHSPECS = [
  ".sorage-vault.json",
  ".gitattributes",
  ".gitignore",
  "artifacts",
  "content",
  "snapshots",
] as const;

/** True when one staged or tracked path belongs to the managed pathspecs (section 28). */
export function isManagedVaultPath(path: string): boolean {
  return (
    path === ".sorage-vault.json" ||
    path === ".gitattributes" ||
    path === ".gitignore" ||
    path.startsWith("artifacts/") ||
    path.startsWith("content/") ||
    path.startsWith("snapshots/")
  );
}

/** The staged paths outside the managed set — the only ones section 28 refuses. */
export function unmanagedStagedPaths(staged: string[]): string[] {
  return staged.filter((path) => !isManagedVaultPath(path));
}
