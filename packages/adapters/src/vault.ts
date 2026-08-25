import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { appError, err, ok, type AppError, type Result } from "@sorage/core";
import type { Clock } from "@sorage/core";
import type { InitVaultPort } from "@sorage/core";
import {
  parseVaultMarker,
  SUPPORTED_VAULT_MARKER_SCHEMA,
  validateVaultMarkerForInstallation,
  type VaultMarker,
  vaultGitattributesContent,
  vaultGitignoreContent,
  verifyVaultPolicyFiles,
} from "@sorage/core";

/**
 * Vault initialization (VLT-001, VLT-002, VLT-024): creates the managed layout with
 * the marker, `.gitattributes` written verbatim, `.gitignore` holding `staging/`, and
 * the `artifacts/` and `staging/` directories. Every file is created exclusively, so
 * re-running initialization only fills gaps and never overwrites Vault content.
 */
export function createVaultInitializer(clock: Clock): InitVaultPort {
  return {
    initialize(vaultPath: string, installationId: string): Result<{ markerCreated: boolean }, AppError> {
      mkdirSync(join(vaultPath, "artifacts"), { recursive: true });
      mkdirSync(join(vaultPath, "staging"), { recursive: true });
      writeIfAbsent(join(vaultPath, ".gitattributes"), vaultGitattributesContent());
      writeIfAbsent(join(vaultPath, ".gitignore"), vaultGitignoreContent());
      const marker = `${JSON.stringify(
        {
          type: "sorage-vault",
          schemaVersion: SUPPORTED_VAULT_MARKER_SCHEMA,
          installationId,
          createdAt: clock.now().toISOString(),
        },
        null,
        2,
      )}\n`;
      const markerCreated = writeIfAbsent(join(vaultPath, ".sorage-vault.json"), marker);
      return ok({ markerCreated });
    },
  };
}

/** A Vault opened for use: the validated marker plus any layout findings. */
export interface OpenedVault {
  marker: VaultMarker;
  /** One string per policy-file finding; non-fatal, because doctor reports them. */
  layoutProblems: string[];
}

/**
 * Opens a directory as this Installation's Vault (VLT-002, VLT-003, VLT-019, VLT-024).
 * Every mutation path calls this before touching Vault content: a missing Vault, a
 * directory without a valid marker, a marker of another Installation, and an
 * unreadable marker each stop the caller with `VAULT_INTEGRITY_ERROR`, and a marker
 * newer than this build stops it with `VAULT_SCHEMA_UNSUPPORTED`. Nothing is written,
 * moved, or adopted: the caller observes the marker or an error, never a mutation on
 * a directory that failed validation. Policy-file findings are reported alongside a
 * valid marker instead of blocking, because doctor carries them as warnings.
 */
export function openVault(vaultPath: string, installationId: string): Result<OpenedVault, AppError> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(vaultPath);
  } catch {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The Vault directory does not exist at ${vaultPath}; run sorage init first.`, {
        vaultPath,
      }),
    );
  }
  if (!stat.isDirectory()) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The Vault path ${vaultPath} is a file, not a directory.`, {
        vaultPath,
      }),
    );
  }
  const markerText = readMarkerText(vaultPath);
  if (markerText === null) {
    const entries = readdirSync(vaultPath);
    if (entries.length > 0) {
      return err(
        appError(
          "VAULT_INTEGRITY_ERROR",
          `Refusing to adopt the non-empty directory ${vaultPath} because it has no Vault marker (VLT-003).`,
          { vaultPath, entryCount: entries.length },
        ),
      );
    }
    return err(
      appError(
        "VAULT_INTEGRITY_ERROR",
        `The directory ${vaultPath} is empty and has not been initialized as a Vault.`,
        {
          vaultPath,
        },
      ),
    );
  }
  const marker = parseVaultMarker(markerText);
  if (!marker.ok) {
    return err(withVaultPath(marker.error, vaultPath));
  }
  const owned = validateVaultMarkerForInstallation(marker.value, installationId);
  if (!owned.ok) {
    return err(withVaultPath(owned.error, vaultPath));
  }
  const layoutProblems = verifyVaultPolicyFiles(
    readTextIfExists(join(vaultPath, ".gitattributes")),
    readTextIfExists(join(vaultPath, ".gitignore")),
  );
  return ok({ marker: owned.value, layoutProblems });
}

/** Reads the marker body, or null when the file is absent. Exported for doctor. */
export function readMarkerText(vaultPath: string): string | null {
  return readTextIfExists(join(vaultPath, ".sorage-vault.json"));
}

function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function withVaultPath(error: AppError, vaultPath: string): AppError {
  return { ...error, details: { ...error.details, vaultPath } };
}

/** Creates the file only when absent; returns false when it already existed. */
function writeIfAbsent(path: string, content: string): boolean {
  let handle: number;
  try {
    handle = openSync(path, "wx");
  } catch {
    return false;
  }
  try {
    writeSync(handle, content);
  } finally {
    closeSync(handle);
  }
  return true;
}
