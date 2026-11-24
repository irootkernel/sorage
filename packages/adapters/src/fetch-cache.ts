import { readdirSync, unlinkSync } from "node:fs";
import { type AppError, appError, err, FETCH_CACHE_DIRECTORY, ok, type Result, sha256OfBytes } from "@sorage/core";
import { readFileBounded } from "./content-file-io";
import { writeFileAtomic } from "./fs-atomic";
import {
  managedDirectory,
  managedFile,
  managedLstat,
  managedPath,
  managedRoot,
  UnsafeManagedPathError,
} from "./managed-paths";

const READ_ONLY_MODE = 0o444;
const OWNER_ONLY_DIR = 0o700;

/**
 * The derived inline fetch cache of SHR-006: `<state>/fetch-cache/<sha256>`,
 * created owner-only and lazily on first use, written read-only and fsynced
 * before its path is returned, the same checksum always mapping to the same
 * path so repeated fetches reuse it. The cache is never a source of truth: a
 * corrupted entry is replaced, never trusted.
 */
export function materializeFetchCacheFile(
  stateDir: string,
  sha256: string,
  bytes: Uint8Array,
): Result<{ path: string }, AppError> {
  if (!/^[0-9a-f]{64}$/.test(sha256) || sha256OfBytes(bytes) !== sha256)
    return err(appError("INTERNAL_ERROR", "The fetch cache identity must digest the supplied bytes."));
  try {
    stateDir = cacheStateRoot(stateDir, true) as string;
    managedDirectory(stateDir, FETCH_CACHE_DIRECTORY, true, OWNER_ONLY_DIR);
    const key = `${FETCH_CACHE_DIRECTORY}/${sha256}`;
    const target = managedFile(stateDir, key);
    if (target.stat !== undefined) {
      const current = readFileBounded(stateDir, key, bytes.byteLength);
      if (current.ok && Buffer.compare(current.value, Buffer.from(bytes)) === 0) return ok({ path: target.path });
      // Only a checked regular cache file may be replaced; links are refused above.
      unlinkSync(managedFile(stateDir, key).path);
    }
    const destination = managedPath(stateDir, key);
    writeFileAtomic(destination, bytes, {
      tempName: "uuid",
      exclusiveTemp: true,
      noFollow: true,
      createMode: 0o600,
      finalMode: READ_ONLY_MODE,
      fileFsync: true,
      dirFsync: "required",
    });
    return ok({ path: destination });
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Materializing the derived fetch cache failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

/** Unsafe roots and entries are skipped without following them or reporting a removal. */
export function sweepFetchCache(stateDir: string, options: { graceHours: number; now: Date }): string[] {
  const swept: string[] = [];
  const cutoffMs = options.now.getTime() - options.graceHours * 3_600_000;
  try {
    const root = cacheStateRoot(stateDir, false);
    if (root === undefined) return swept;
    stateDir = root;
    const directory = managedDirectory(stateDir, FETCH_CACHE_DIRECTORY);
    if (directory === undefined) return swept;
    for (const entry of readdirSync(directory)) {
      try {
        const file = managedFile(stateDir, `${FETCH_CACHE_DIRECTORY}/${entry}`);
        if (file.stat !== undefined && file.stat.mtimeMs < cutoffMs) {
          unlinkSync(file.path);
          swept.push(file.path);
        }
      } catch {
        /* Linked, special, unreadable or concurrently removed entries are not candidates. */
      }
    }
  } catch {
    /* Missing or unsafe cache roots are never traversed. */
  }
  return swept;
}

function cacheStateRoot(stateDir: string, create: boolean): string | undefined {
  const stat = managedLstat(stateDir);
  if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw new UnsafeManagedPathError("The managed state directory is a link or special entry");
  if (stat === undefined && !create) return undefined;
  return managedRoot(stateDir, create);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
