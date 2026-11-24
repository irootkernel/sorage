import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AppError, err, isManagedStorageKey, ok, type PendingFsOp, type Result } from "@sorage/core";
import { fsyncDirectory } from "./fs-atomic";
import {
  isSafeVaultRelativePath,
  managedDirectory,
  managedFile,
  type managedLstat,
  UnsafeManagedPathError,
} from "./managed-paths";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The eligibility primitive of section 3: a legacy unlink may take no physical
 * effect, clear, attempt, event, or failure report while any pending
 * activation targets the exact same persisted `to_path` — the recorded
 * activation is the dependency, and a timestamp/id ordering alone cannot
 * prevent the retired-file counterexample. SQL only; no filesystem I/O.
 */
export function pendingActivationTargets(db: SorageSqlite, toPath: string): boolean {
  const row = db
    .prepare("SELECT 1 AS pending FROM pending_fs_ops WHERE op = 'activate' AND to_path = ? LIMIT 1")
    .get(toPath) as { pending: number } | null | undefined;
  return row !== null && row !== undefined;
}

/** The internal execution outcomes of the shared legacy intent executor. */
export type LegacyIntentOutcome = "done" | "both-gone" | "destination-conflict" | "unsafe-path" | "deferred";

/**
 * The one shared dependency-aware legacy execution boundary of section 3
 * (SHR-004): eligibility runs against the exact persisted activation target
 * BEFORE any legacy unlink filesystem effect, then the managed physical
 * activate/unlink logic runs — never inside a SQL transaction.
 */
export function executeLegacyIntent(
  db: SorageSqlite,
  intent: Pick<PendingFsOp, "op" | "fromPath" | "toPath">,
  vaultPath: string,
  precondition?: () => Result<unknown, AppError>,
): Result<LegacyIntentOutcome, AppError> {
  if (precondition !== undefined) {
    const guarded = precondition();
    if (!guarded.ok) return err(guarded.error);
  }
  if (intent.op === "unlink" && pendingActivationTargets(db, intent.toPath)) {
    return ok("deferred");
  }
  return ok(executeIntent(intent, vaultPath));
}

export function executeIntent(
  intent: Pick<PendingFsOp, "op" | "fromPath" | "toPath">,
  vaultPath: string,
): "done" | "both-gone" | "destination-conflict" | "unsafe-path" {
  if (
    !isSafeVaultRelativePath(intent.toPath) ||
    (intent.fromPath !== null && !isSafeVaultRelativePath(intent.fromPath))
  ) {
    return "unsafe-path";
  }
  if (!isManagedStorageKey(intent.toPath)) {
    return "unsafe-path";
  }
  if (intent.op === "activate" && intent.fromPath !== null && !intent.fromPath.startsWith("staging/")) {
    return "unsafe-path";
  }
  if (intent.op === "activate") {
    let sourceStat: ReturnType<typeof managedLstat>;
    let destinationStat: ReturnType<typeof managedLstat>;
    try {
      const source = intent.fromPath === null ? null : managedFile(vaultPath, intent.fromPath);
      const destination = managedFile(vaultPath, intent.toPath);
      sourceStat = source === null ? undefined : source.stat;
      destinationStat = destination.stat;
    } catch (error) {
      if (error instanceof UnsafeManagedPathError) return "unsafe-path";
      throw error;
    }
    const destinationPath = join(vaultPath, intent.toPath);
    const parentKey = intent.toPath.slice(0, intent.toPath.lastIndexOf("/"));
    if (sourceStat?.isFile() && destinationStat !== undefined) {
      let refreshedSource: ReturnType<typeof managedLstat>;
      try {
        refreshedSource = managedFile(vaultPath, intent.fromPath as string).stat;
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) return "unsafe-path";
        throw error;
      }
      if (refreshedSource !== undefined) return "destination-conflict";
      try {
        destinationStat = managedFile(vaultPath, intent.toPath).stat;
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) return "unsafe-path";
        throw error;
      }
      sourceStat = undefined;
    }
    if (sourceStat?.isFile()) {
      try {
        managedDirectory(vaultPath, parentKey, true);
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) return "unsafe-path";
        throw error;
      }
      try {
        renameSync(join(vaultPath, intent.fromPath as string), destinationPath);
      } catch (error) {
        let sourceGone: boolean;
        let destinationPresent: boolean;
        try {
          sourceGone = managedFile(vaultPath, intent.fromPath as string).stat === undefined;
          destinationPresent = managedFile(vaultPath, intent.toPath).stat !== undefined;
        } catch (recheckError) {
          if (recheckError instanceof UnsafeManagedPathError) return "unsafe-path";
          throw recheckError;
        }
        if (!sourceGone || !destinationPresent) throw error;
      }
      fsyncDirectory(dirname(destinationPath));
      try {
        chmodSync(destinationPath, 0o444);
      } catch {
        // Read-only is best effort on exotic filesystems; vault verify reports it.
      }
      return "done";
    }
    if (destinationStat?.isFile()) {
      fsyncDirectory(dirname(destinationPath));
      try {
        chmodSync(destinationPath, 0o444);
      } catch {
        // Read-only is best effort on exotic filesystems; vault verify reports it.
      }
      return "done";
    }
    return "both-gone";
  }
  let targetStat: ReturnType<typeof managedLstat>;
  try {
    targetStat = managedFile(vaultPath, intent.toPath).stat;
  } catch (error) {
    if (error instanceof UnsafeManagedPathError) return "unsafe-path";
    throw error;
  }
  if (targetStat !== undefined) {
    const targetPath = join(vaultPath, intent.toPath);
    try {
      unlinkSync(targetPath);
    } catch (error) {
      if (!existsSync(targetPath)) return "done";
      throw error;
    }
    fsyncDirectory(dirname(targetPath));
  }
  return "done";
}
