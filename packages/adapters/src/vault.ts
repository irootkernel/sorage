import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ok, type AppError, type Result } from "@sorage/core";
import type { Clock } from "@sorage/core";
import type { InitVaultPort } from "@sorage/core";

/**
 * Vault initialization (VLT-001, VLT-002, VLT-024): creates the managed layout with
 * the marker, `.gitattributes` written verbatim, `.gitignore` holding `staging/`, and
 * the `artifacts/` and `staging/` directories. Every file is created exclusively, so
 * re-running initialization only fills gaps and never overwrites Vault content.
 */
const GITATTRIBUTES = `artifacts/** -text -diff
snapshots/** text eol=lf
.sorage-vault.json text eol=lf
`;

const GITIGNORE = `staging/
`;

const MARKER_SCHEMA_VERSION = 1;

export function createVaultInitializer(clock: Clock): InitVaultPort {
  return {
    initialize(vaultPath: string, installationId: string): Result<{ markerCreated: boolean }, AppError> {
      mkdirSync(join(vaultPath, "artifacts"), { recursive: true });
      mkdirSync(join(vaultPath, "staging"), { recursive: true });
      writeIfAbsent(join(vaultPath, ".gitattributes"), GITATTRIBUTES);
      writeIfAbsent(join(vaultPath, ".gitignore"), GITIGNORE);
      const marker = `${JSON.stringify(
        {
          type: "sorage-vault",
          schemaVersion: MARKER_SCHEMA_VERSION,
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
