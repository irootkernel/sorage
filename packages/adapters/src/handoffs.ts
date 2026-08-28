import { type AppError, appError, err, ok, type Result } from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The Row Version compare-and-set of section 19 and section 7 of security-reliability.md
 * (HND-014, HND-025, SEC-008): one statement assigns the domain columns and bumps
 * `row_version` together, the driver's affected-row count is the verdict, and a stale
 * expectation fails with `ROW_VERSION_CONFLICT` without retrying. Domain column
 * assignments join the same statement, so the check and the write cannot separate.
 */

export interface HandoffRowSnapshot {
  id: string;
  rowVersion: number;
}

/** Column values an update may carry; the statement builder whitelists the keys. */
export type HandoffAssignment =
  | "review_state"
  | "revision"
  | "current_artifact_id"
  | "accepted_revision"
  | "accepted_at"
  | "declined_at"
  | "decline_reason"
  | "withdrawn_at"
  | "consecutive_no_change_resolutions"
  | "first_fetched_at"
  | "review_engaged_at"
  | "pinned"
  | "archived_at"
  | "deleted_at"
  | "updated_at";

const ASSIGNABLE: readonly HandoffAssignment[] = [
  "review_state",
  "revision",
  "current_artifact_id",
  "accepted_revision",
  "accepted_at",
  "declined_at",
  "decline_reason",
  "withdrawn_at",
  "consecutive_no_change_resolutions",
  "first_fetched_at",
  "review_engaged_at",
  "pinned",
  "archived_at",
  "deleted_at",
  "updated_at",
];

export interface SqliteHandoffRowStore {
  /**
   * Runs the compare-and-set for one Handoff. `changes === 1` means the row moved from
   * the expected version to its successor; anything else means another writer moved it
   * first, or the row is absent.
   */
  compareAndSet(
    handoffId: string,
    expectedRowVersion: number,
    assignments: Partial<Record<HandoffAssignment, unknown>>,
  ): Result<{ rowVersion: number }, AppError>;
  /** Loads one row's Row Version; the row-mapping read side arrives with TASK-030. */
  rowVersionOf(handoffId: string): Result<number | null, AppError>;
}

export function createSqliteHandoffRowStore(db: SorageSqlite): SqliteHandoffRowStore {
  return {
    compareAndSet(handoffId, expectedRowVersion, assignments) {
      const columns = Object.keys(assignments).filter((column) => (ASSIGNABLE as readonly string[]).includes(column));
      if (columns.length === 0) {
        return err(appError("INTERNAL_ERROR", "the compare-and-set requires at least one assignable Handoff column"));
      }
      const sets = columns.map((column) => `${column} = ?`).join(", ");
      const values = columns.map((column) => (assignments as Record<string, unknown>)[column]);
      try {
        const changed = db
          .prepare(`UPDATE handoffs SET ${sets}, row_version = row_version + 1 WHERE id = ? AND row_version = ?`)
          .run(...(values as never[]), handoffId, expectedRowVersion) as { changes: number };
        if (changed.changes === 1) {
          return ok({ rowVersion: expectedRowVersion + 1 });
        }
        const current = db.prepare("SELECT row_version FROM handoffs WHERE id = ?").get(handoffId) as
          | { row_version: number }
          | null
          | undefined;
        if (!current) {
          return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${handoffId}'`, { handoffId }));
        }
        return err(
          appError(
            "ROW_VERSION_CONFLICT",
            "the Handoff changed since it was last read; re-read it and retry with the new Row Version",
            { handoffId, expectedRowVersion, currentRowVersion: current.row_version },
          ),
        );
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `the Handoff compare-and-set failed: ${messageOf(error)}`, {
            handoffId,
            cause: String(error),
          }),
        );
      }
    },
    rowVersionOf(handoffId) {
      try {
        const row = db.prepare("SELECT row_version FROM handoffs WHERE id = ?").get(handoffId) as
          | { row_version: number }
          | null
          | undefined;
        return ok(row ? row.row_version : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `reading the Handoff Row Version failed: ${messageOf(error)}`));
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
