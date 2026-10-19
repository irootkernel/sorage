import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "./lockfile";

/**
 * The owned private accepted-input area for large Memo bodies (SHR-012, the
 * ADR-0032 reviewed plan): one operation's spool lives under
 * `<state>/memo-input/` — inside the existing `state` tree, never a new
 * top-level home directory — is written once during capture, streamed for the
 * request hash and Vault staging, removed best-effort on every operation exit,
 * and backstopped by a narrow sweep that reaps only this area's own
 * UUID-and-pid-named spool files whose owning process is dead and whose
 * modification time fell out of the configured grace window. A live owner pid
 * protects its spool regardless of age — a paused or long-running operation
 * never loses its accepted input — and neither the directory nor any entry is
 * ever followed through a symlink, so nothing outside the owned directory can
 * be created or deleted through this area.
 */

export const MEMO_INPUT_DIRECTORY = "memo-input";
const SPOOL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(\d+)\.spool$/;

export function memoInputDirectory(stateDir: string): string {
  return join(stateDir, MEMO_INPUT_DIRECTORY);
}

/**
 * Creates the owned directory once a capture actually needs to spill;
 * read-only surfaces never create it. A path that exists but is not a real
 * directory — a symlink riding the name — is refused instead of followed, so
 * no capture can write outside the owned tree.
 */
export function ensureMemoInputDirectory(stateDir: string): string {
  const directory = memoInputDirectory(stateDir);
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("The Memo accepted-input directory is not a real directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") mkdirSync(directory, { recursive: true, mode: 0o700 });
    else throw error;
  }
  return directory;
}

/** The one owned spool path for an operation: the capture's UUID plus the owning pid, so the sweep can protect live owners. */
export function memoInputSpoolPath(stateDir: string, spoolId: string): string {
  return join(memoInputDirectory(stateDir), `${spoolId}.${String(process.pid)}.spool`);
}

/** Best-effort removal on every operation exit; the sweep is the crash backstop. */
export function releaseMemoInputSpool(spoolPath: string): void {
  try {
    unlinkSync(spoolPath);
  } catch {
    // Already gone, or the sweep will take it once the owner pid is dead and the grace window passes.
  }
}

/**
 * The crash-orphan backstop: reaps only this area's own `<uuid>.<pid>.spool`
 * files whose recorded owner pid is dead and whose modification time fell out
 * of the configured grace window. A live owner pid protects its spool at any
 * age; every entry is inspected with `lstatSync` so a symlink riding a spool
 * name is never followed; and an owned directory that is itself a symlink is
 * refused rather than traversed — nothing outside the owned tree is ever
 * deleted, and unrecognized names are never touched.
 */
export function sweepMemoInputSpool(stateDir: string, options: { graceHours: number; now: Date }): number {
  const directory = memoInputDirectory(stateDir);
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(directory);
  } catch {
    return 0;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return removed;
  }
  const cutoff = options.now.getTime() - options.graceHours * 3_600_000;
  for (const entry of entries) {
    const match = SPOOL_PATTERN.exec(entry);
    if (match === null) continue;
    const path = join(directory, entry);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (isPidAlive(Number(match[1]))) continue;
      if (stat.mtimeMs > cutoff) continue;
      rmSync(path, { force: true });
      removed++;
    } catch {
      // A concurrently released spool or an unreadable entry is skipped; the next sweep retries.
    }
  }
  return removed;
}

/** Opens one fresh spool for writing; the caller streams, hashes, and fsyncs before closing. */
export function openMemoInputSpool(path: string): number {
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

/** Closes one descriptor best-effort; a close failure never skips the remaining cleanup. */
export function closeDescriptor(handle: number | undefined): void {
  if (handle === undefined) return;
  try {
    closeSync(handle);
  } catch {
    // Independent disposal: the spool release below is the durable cleanup.
  }
}
