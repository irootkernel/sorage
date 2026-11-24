import { appError, err, ok, type ProjectHandoffStatsPort } from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * Handoff-owned SQLite stats adapter behind `ProjectHandoffStatsPort` (PRJ-022, HPR-011).
 * Counts recipient-scoped non-deleted Handoffs in `awaiting_recipient` or
 * `changes_requested`, plus non-deleted `accepted` Handoffs with recorded
 * `not_started` or `in_progress` processing (including archived ones, counting
 * each Handoff once and excluding legacy `unrecorded` processing).
 */
export function createSqliteProjectHandoffStats(db: SorageSqlite): ProjectHandoffStatsPort {
  return {
    openHandoffCount(projectId) {
      try {
        // bun:sqlite returns null for a no-row get while node:sqlite returns
        // undefined, and the test suite runs through node:sqlite, so the guard
        // must treat both shapes as absence or unbind fails on the real engine.
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get() as
          | { name: string }
          | null
          | undefined;
        if (!table) return ok(0);
        const row = db
          .prepare(
            "SELECT COUNT(*) AS count FROM handoffs WHERE recipient_project_id = ? AND (review_state IN ('awaiting_recipient', 'changes_requested') OR (review_state = 'accepted' AND processing_status IN ('not_started', 'in_progress'))) AND deleted_at IS NULL",
          )
          .get(projectId) as { count: number };
        return ok(row.count);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `the open Handoff count failed: ${String(error)}`));
      }
    },
  };
}
