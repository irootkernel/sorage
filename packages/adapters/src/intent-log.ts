import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  appError,
  err,
  ok,
  type AppError,
  type DrainReport,
  type GarbageCollectionOptions,
  type GarbageCollectionReport,
  type IntentLog,
  type NewPendingFsOp,
  type PendingFsOp,
  type Result,
} from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";
import { vaultMoveLockHeld } from "./lockfile";
import { openVault } from "./vault";

export interface SqliteIntentLogOptions {
  db: SorageSqlite;
  installationId: string;
  /** When provided, a live vault-move.lock pauses the drain with SERVICE_PAUSED (RUN-014). */
  runDir?: string | undefined;
}

interface PendingRow {
  id: string;
  op: string;
  from_path: string | null;
  to_path: string;
  artifact_id: string | null;
  created_at: string;
  attempts: number;
}

/**
 * The SQLite intent log (ADR-0013, VLT-021, VLT-022, RUN-002): `record` commits
 * intents in one transaction, `drain` executes every outstanding intent against
 * the filesystem state it finds and clears the resolved ones in a second
 * transaction, and `clear` is the mutation path's completion commit. The
 * durability order of write, fsync file, rename, fsync parent directory, then
 * the completion commit is spread across the caller's staging (already written
 * and fsynced), the rename plus parent fsync here, and the clearing
 * transaction; no filesystem I/O happens inside a transaction.
 */
export function createSqliteIntentLog(options: SqliteIntentLogOptions): IntentLog {
  const { db, installationId } = options;

  function toPending(row: PendingRow): PendingFsOp {
    return {
      id: row.id,
      op: row.op === "unlink" ? "unlink" : "activate",
      fromPath: row.from_path,
      toPath: row.to_path,
      artifactId: row.artifact_id,
      createdAt: row.created_at,
      attempts: row.attempts,
    };
  }

  function listPending(): PendingFsOp[] {
    return (db.prepare<PendingRow>("SELECT * FROM pending_fs_ops ORDER BY created_at, id").all() as PendingRow[]).map(
      toPending,
    );
  }

  return {
    record(intents: NewPendingFsOp[]): Result<{ recorded: number }, AppError> {
      // A committed intent is a promise about the current Vault, so it may not
      // be committed around a relocation that would relocate the promise's
      // filesystem underneath it (RUN-014).
      if (options.runDir !== undefined && vaultMoveLockHeld(options.runDir)) {
        return err(
          appError(
            "SERVICE_PAUSED",
            "A Vault move or restore is in progress; the intent commit paused instead of racing it.",
            { lockPath: join(options.runDir, "vault-move.lock") },
          ),
        );
      }
      try {
        db.exec("BEGIN IMMEDIATE");
        const insert = db.prepare(
          "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)",
        );
        for (const intent of intents) {
          insert.run(intent.id, intent.op, intent.fromPath, intent.toPath, intent.artifactId, intent.createdAt);
        }
        db.exec("COMMIT");
        return ok({ recorded: intents.length });
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction never opened or the connection already rolled back.
        }
        return err(
          appError("INTERNAL_ERROR", `Recording filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    pending(): Result<PendingFsOp[], AppError> {
      try {
        return ok(listPending());
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading pending filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    drain(vaultPath: string): Result<DrainReport, AppError> {
      const paused = (): boolean => options.runDir !== undefined && vaultMoveLockHeld(options.runDir);
      const pauseError = (): AppError =>
        appError(
          "SERVICE_PAUSED",
          "A Vault move or restore is in progress; the intent drain paused instead of racing it.",
          { lockPath: options.runDir === undefined ? undefined : join(options.runDir, "vault-move.lock") },
        );
      // The lock is re-checked before every intent, not only at entry, so a move
      // that starts mid-drain cannot switch the Vault underneath in-flight
      // renames (RUN-014).
      if (paused()) return err(pauseError());
      const opened = openVault(vaultPath, installationId);
      if (!opened.ok) return err(opened.error);
      const report: DrainReport = { resolved: [], integrityFailed: [] };
      try {
        for (const intent of listPending()) {
          if (paused()) return err(pauseError());
          const outcome = executeIntent(intent, vaultPath);
          // The completion commit: one short transaction per intent that bumps
          // attempts and deletes the row only when the effect is complete.
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("UPDATE pending_fs_ops SET attempts = attempts + 1 WHERE id = ?").run(intent.id);
            if (outcome === "done") {
              db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(intent.id);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            return err(
              appError("INTERNAL_ERROR", `Completing intent ${intent.id} failed: ${messageOf(error)}.`, {
                intentId: intent.id,
                cause: String(error),
              }),
            );
          }
          if (outcome === "done") {
            report.resolved.push(intent.id);
          } else {
            report.integrityFailed.push({
              id: intent.id,
              op: intent.op,
              toPath: intent.toPath,
              artifactId: intent.artifactId,
              event: "ARTIFACT_INTEGRITY_FAILED",
              reason: outcome,
            });
          }
        }
        return ok(report);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Draining pending filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    clear(intentIds: string[]): Result<{ cleared: number }, AppError> {
      if (intentIds.length === 0) return ok({ cleared: 0 });
      try {
        db.exec("BEGIN IMMEDIATE");
        const remove = db.prepare("DELETE FROM pending_fs_ops WHERE id = ?");
        for (const id of intentIds) {
          remove.run(id);
        }
        db.exec("COMMIT");
        return ok({ cleared: intentIds.length });
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // As above: nothing to roll back.
        }
        return err(
          appError("INTERNAL_ERROR", `Clearing filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}

/** One intent's filesystem effect, evaluated from current state; never runs inside a transaction. */
export function executeIntent(
  intent: PendingFsOp,
  vaultPath: string,
): "done" | "both-gone" | "destination-conflict" | "unsafe-path" {
  if (!isSafeVaultRelative(intent.toPath) || (intent.fromPath !== null && !isSafeVaultRelative(intent.fromPath))) {
    // A hostile path never touches the filesystem; it stays recorded as failed.
    return "unsafe-path";
  }
  if (intent.op === "activate") {
    const source = intent.fromPath === null ? null : join(vaultPath, intent.fromPath);
    const destination = join(vaultPath, intent.toPath);
    if (source !== null && existsSync(source)) {
      if (existsSync(destination)) {
        // Both ends present: overwriting the destination would violate the
        // no-overwrite invariant the store enforces, so the row stays recorded
        // as a failure instead of silently replacing bytes a record may name.
        return "destination-conflict";
      }
      try {
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(source, destination);
        fsyncDirectory(dirname(destination));
        return "done";
      } catch (error) {
        // A concurrent drain may have renamed the source first: re-evaluate
        // from current state instead of failing the whole drain (CP-7).
        if (!existsSync(source) && existsSync(destination)) return "done";
        throw error;
      }
    }
    if (existsSync(destination)) return "done";
    return "both-gone";
  }
  const target = join(vaultPath, intent.toPath);
  if (existsSync(target)) {
    try {
      unlinkSync(target);
    } catch (error) {
      // A concurrent drain may have unlinked first; a vanished target is done.
      if (!existsSync(target)) return "done";
      throw error;
    }
    fsyncDirectory(dirname(target));
  }
  return "done";
}

/**
 * The post-drain garbage pass (VLT-013, VLT-014): sweeps `staging/` by age and
 * sweeps unreferenced files under `artifacts/` past the grace window, while a
 * path matching a live storageKey or any pending intent is never removed,
 * whatever its age. Runs only after this process's drain has finished.
 */
export function collectVaultGarbage(
  vaultPath: string,
  pendingIntents: PendingFsOp[],
  options: GarbageCollectionOptions,
): Result<GarbageCollectionReport, AppError> {
  const cutoffMs = options.now.getTime() - options.graceHours * 3_600_000;
  const guarded = new Set<string>();
  for (const key of options.liveStorageKeys) guarded.add(join(vaultPath, key));
  for (const intent of pendingIntents) {
    guarded.add(join(vaultPath, intent.toPath));
    if (intent.fromPath !== null) guarded.add(join(vaultPath, intent.fromPath));
  }
  const report: GarbageCollectionReport = { sweptStaging: [], sweptUnreferenced: [] };
  try {
    const staging = join(vaultPath, "staging");
    if (existsSync(staging)) {
      for (const entry of readdirSync(staging)) {
        const path = join(staging, entry);
        if (isSweepable(path, cutoffMs)) {
          unlinkSync(path);
          report.sweptStaging.push(path);
        }
      }
    }
    const artifacts = join(vaultPath, "artifacts");
    const registryAuthorizesSweep =
      options.liveStorageKeys.length > 0 || options.sweepArtifactsWithoutRegistry === true;
    if (registryAuthorizesSweep && existsSync(artifacts)) {
      for (const path of filesUnder(artifacts)) {
        if (guarded.has(path)) continue;
        if (isSweepable(path, cutoffMs)) {
          unlinkSync(path);
          report.sweptUnreferenced.push(path);
        }
      }
    }
    return ok(report);
  } catch (error) {
    return err(appError("INTERNAL_ERROR", `Garbage collection failed: ${messageOf(error)}.`, { cause: String(error) }));
  }
}

function isSweepable(path: string, cutoffMs: number): boolean {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  return stats.isFile() && stats.mtimeMs < cutoffMs;
}

function* filesUnder(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* filesUnder(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function isSafeVaultRelative(path: string): boolean {
  if (path === "" || path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Durability order helper: fsync the parent directory after a rename or unlink (VLT-022). */
export function fsyncDirectory(path: string): void {
  const handle = openSync(path, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
