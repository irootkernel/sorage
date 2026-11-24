import { type AppError, appError, err, ok, type Result } from "@sorage/core";
import type { SorageSqlite } from "./connection";

export interface FenceRow {
  move_fence_pid: number | null;
  move_fence_at: string | null;
}

/** True when a process with this pid is alive; a dead fence pid is stale. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live fence that must pause intent commits, or null when absent or stale. */
export function liveFencePaused(db: SorageSqlite): { pid: number } | null {
  const row = db.prepare("SELECT move_fence_pid, move_fence_at FROM vault_state WHERE id = 1").get() as
    | FenceRow
    | null
    | undefined;
  const pid = row?.move_fence_pid ?? null;
  if (pid === null) return null;
  return pidIsAlive(pid) ? { pid } : null;
}

/**
 * The mover's fence-and-count (TASK-029, the EPIC-004 accepted seam): one write
 * transaction sets the fence row and counts the outstanding intents, so an intent
 * commit either lands before it and is counted, or waits on the write lock and then
 * sees the fence and pauses. Returns the count the switch decision needs.
 */
export function setMoveFenceAndCountPending(db: SorageSqlite, pid: number, at: string): Result<number, AppError> {
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET move_fence_pid = excluded.move_fence_pid, move_fence_at = excluded.move_fence_at",
      ).run(pid, at);
      const row = db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as { count: number };
      db.exec("COMMIT");
      return ok(row.count);
    } catch (transactionError) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing left to roll back.
      }
      throw transactionError;
    }
  } catch (error) {
    return err(
      appError(
        "INTERNAL_ERROR",
        `Fencing the Vault switch failed: ${error instanceof Error ? error.message : String(error)}.`,
        { cause: String(error) },
      ),
    );
  }
}

/** Clears the fence after the switch completes or the move abandons the switch. */
export function clearMoveFence(db: SorageSqlite): Result<void, AppError> {
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE vault_state SET move_fence_pid = NULL, move_fence_at = NULL WHERE id = 1").run();
      db.exec("COMMIT");
      return ok(undefined);
    } catch (transactionError) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing left to roll back.
      }
      throw transactionError;
    }
  } catch (error) {
    return err(
      appError(
        "INTERNAL_ERROR",
        `Clearing the Vault switch fence failed: ${error instanceof Error ? error.message : String(error)}.`,
        { cause: String(error) },
      ),
    );
  }
}
