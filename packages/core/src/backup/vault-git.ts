import { type AppError, err, ok, type Result } from "../shared/errors";
import type { AsyncVaultGitRepository, VaultGitRepository } from "./git";

/**
 * Vault Git initialization (TASK-053, INIT-007, BKP-001, BKP-022): Sorage
 * initializes a repository in the Vault only when none exists, sets
 * `core.autocrlf=false` repository-locally, and re-asserts the managed policy
 * files idempotently. An existing repository — including an unrelated one — is
 * reported, never reinitialized and never reconfigured, because rewriting a
 * repository the user brought with them is exactly the destructive surprise
 * the safety rules forbid.
 */
export interface VaultGitPorts {
  vaultPath: string;
  /** The `gitBackup.push.branch` a freshly initialized repository must carry. */
  configuredBranch: string;
  /** True when a `.git` exists at the Vault path, whatever created it. */
  repositoryExists(): Result<boolean, AppError>;
  /** Re-runs the idempotent Vault initializer so the policy files and marker are re-asserted (VLT-024). */
  reassertPolicyFiles(): Result<void, AppError>;
  git: VaultGitRepository;
}

export interface VaultGitOutcome {
  /** True when this call created the repository. */
  initialized: boolean;
  /** True when an existing repository was found and left untouched. */
  existingReported: boolean;
}

export function ensureVaultGitRepository(ports: VaultGitPorts): Result<VaultGitOutcome, AppError> {
  const existing = ports.repositoryExists();
  if (!existing.ok) return err(existing.error);
  if (existing.value) {
    // An existing repository is adoption-shaped, not initialization-shaped:
    // Sorage verifies it but never rewrites its history or configuration.
    return ok({ initialized: false, existingReported: true });
  }
  const initialized = ports.git.initialize(ports.configuredBranch);
  if (!initialized.ok) return err(initialized.error);
  const reasserted = ports.reassertPolicyFiles();
  if (!reasserted.ok) return err(reasserted.error);
  return ok({ initialized: true, existingReported: false });
}

export interface AsyncVaultGitPorts extends Omit<VaultGitPorts, "git"> {
  git: AsyncVaultGitRepository;
}

/** Asynchronous counterpart of `ensureVaultGitRepository` for daemon backup runs. */
export async function ensureVaultGitRepositoryAsync(
  ports: AsyncVaultGitPorts,
): Promise<Result<VaultGitOutcome, AppError>> {
  const existing = ports.repositoryExists();
  if (!existing.ok) return err(existing.error);
  if (existing.value) {
    return ok({ initialized: false, existingReported: true });
  }
  const initialized = await ports.git.initialize(ports.configuredBranch);
  if (!initialized.ok) return err(initialized.error);
  const reasserted = ports.reassertPolicyFiles();
  if (!reasserted.ok) return err(reasserted.error);
  return ok({ initialized: true, existingReported: false });
}
