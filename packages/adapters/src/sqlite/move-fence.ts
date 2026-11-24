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
