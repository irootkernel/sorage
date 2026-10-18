import { managedRoot, managedDirectory } from "./managed-paths";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appError, err, ok, type AppError, type Result } from "@sorage/core";
import type { Clock } from "@sorage/core";
import type { InitVaultPort } from "@sorage/core";
import {
  parseVaultMarker,
  REQUIRED_GITATTRIBUTES_LINES,
  SUPPORTED_VAULT_MARKER_SCHEMA,
  validateVaultMarkerForInstallation,
  type VaultMarker,
  vaultGitignoreContent,
  verifyVaultPolicyFiles,
} from "@sorage/core";

/**
 * Vault initialization (VLT-001, VLT-002, VLT-024 as amended by SHR-011):
 * creates the managed layout with the marker, `.gitignore` holding `staging/`,
 * and the `artifacts/`, `staging/`, and M9 `content/` directories. Every file
 * is created exclusively so re-running initialization only fills gaps, and the
 * `.gitattributes` assertion retains non-managed lines and reasserts the ordered
 * managed rules after other root rules, so older files gain effective M9 byte
 * protection. A file already satisfying that policy remains byte-identical.
 */
export function createVaultInitializer(clock: Clock): InitVaultPort {
  return {
    initialize(vaultPath: string, installationId: string): Result<{ markerCreated: boolean }, AppError> {
      try {
        vaultPath = managedRoot(vaultPath, true);
        managedDirectory(vaultPath, "artifacts", true);
        managedDirectory(vaultPath, "staging", true);
        // The managed shared-content subtree is an ordinary layout extension
        // like artifacts/ (section 38.1); initialization may prepare it, the
        // backup run's writable setup guarantees it, and no sentinel file is
        // ever used.
        managedDirectory(vaultPath, "content", true);
        mergeMissingGitattributesLines(join(vaultPath, ".gitattributes"));
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
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Initializing the Vault layout failed: ${messageOf(error)}.`, {
            vaultPath,
            cause: String(error),
          }),
        );
      }
    },
  };
}

/**
 * The idempotent `.gitattributes` assertion (VLT-024, SHR-011): a missing file
 * is written verbatim; non-managed lines keep their bytes and relative order.
 * Exact managed lines are ordered after other root rules, preserving trailing
 * comments and making the raw-content exceptions effective under Git precedence.
 */
function mergeMissingGitattributesLines(path: string): void {
  let existing: string;
  let mode = 0o644;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The Vault attributes path is not a regular file");
    mode = stat.mode & 0o777;
    existing = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeExact(path, `${REQUIRED_GITATTRIBUTES_LINES.join("\n")}\n`, mode);
    return;
  }
  // Keep each non-managed line's terminator as well as its content.
  const lines = existing.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const required: readonly string[] = REQUIRED_GITATTRIBUTES_LINES;
  const managed = (line: string) => required.includes(line.endsWith("\n") ? line.slice(0, -1) : line);
  const rule = (line: string) => line.trim() !== "" && !line.trimStart().startsWith("#");
  const positions = required.map((line) => lines.findIndex((stored) => stored === `${line}\n` || stored === line));
  const firstManaged = lines.findIndex(managed);
  if (
    positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1))) &&
    lines.filter(managed).length === required.length &&
    !lines.slice(firstManaged).some((line) => !managed(line) && rule(line))
  )
    return;
  const preserved = lines.filter((line) => !managed(line));
  const originalPosition =
    firstManaged < 0 ? preserved.length : lines.slice(0, firstManaged).filter((line) => !managed(line)).length;
  let insertion = originalPosition;
  for (const [index, line] of preserved.entries()) if (rule(line)) insertion = Math.max(insertion, index + 1);
  const before = preserved.slice(0, insertion).join("");
  const after = preserved.slice(insertion).join("");
  const body = `${before}${before !== "" && !before.endsWith("\n") ? "\n" : ""}${required.join("\n")}\n${after}`;
  if (body !== existing) writeExact(path, body, mode);
}

/** Replace only after the complete policy file has been written and synced. */
function writeExact(path: string, content: string, mode: number): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let handle: number | null = null;
  let created = false;
  try {
    handle = openSync(temporary, "wx", mode);
    created = true;
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(handle, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("Writing the Vault attributes file made no progress");
      offset += written;
    }
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (handle !== null) closeSync(handle);
    if (created) rmSync(temporary, { force: true });
  }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
