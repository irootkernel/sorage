import { appError, err, ok, type RecipientComment, type ReviewMutationPort, type ReviewNoteView } from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import type { SorageSqlite } from "./sqlite/connection";
import { type ContentionSurface, storageContentionOf } from "./storage-contention";

/**
 * The SQLite review store behind TASK-031: one transaction per mutation holds the Row
 * Version compare-and-set, the note upsert or delete, the first set of
 * review_engaged_at, and the ledger append, so a Note and its event can never part.
 * The handoff_id primary key is the at-most-one-Note constraint (REV-001).
 */

interface NoteRow {
  purpose: "general" | "change_request";
  active: number;
  handoff_id: string;
  author_kind: string;
  author_project_id: string | null;
  target_revision: number;
  body: string;
  created_at: string;
  updated_at: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSqliteReviewStore(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
  options: { contentionSurface?: ContentionSurface | undefined } = {},
): ReviewMutationPort {
  const toNote = (row: NoteRow): ReviewNoteView => ({
    handoffId: row.handoff_id,
    authorKind: row.author_kind === "user" ? "user" : "registered_project",
    authorProjectId: row.author_project_id,
    targetRevision: row.target_revision,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return {
    findNote(handoffId) {
      try {
        const row = db
          .prepare("SELECT * FROM review_notes WHERE handoff_id = ? AND purpose = 'change_request' AND active = 1")
          .get(handoffId) as NoteRow | null | undefined;
        return ok(row ? toNote(row) : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the review note failed: ${messageOf(error)}`));
      }
    },
    findComment(handoffId) {
      try {
        const row = db.prepare("SELECT * FROM review_notes WHERE handoff_id = ?").get(handoffId) as
          | NoteRow
          | null
          | undefined;
        return ok(
          row ? ({ ...toNote(row), purpose: row.purpose, active: row.active === 1 } as RecipientComment) : null,
        );
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the recipient comment failed: ${messageOf(error)}`));
      }
    },
    applyReportMutation(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const assignments: string[] = ["review_state = ?", "updated_at = ?"];
          const values: unknown[] = [input.reviewState, input.now];
          if (input.engage) {
            assignments.push("review_engaged_at = COALESCE(review_engaged_at, ?)");
            values.push(input.now);
          }
          if (input.processing !== undefined) {
            assignments.push("processing_status = ?", "processing_started_at = ?", "processing_completed_at = ?");
            values.push(input.processing.status, input.processing.startedAt, input.processing.completedAt);
          }
          values.push(input.handoffId, input.expectedRowVersion);
          const changed = db
            .prepare(
              `UPDATE handoffs SET ${assignments.join(", ")}, row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
            )
            .run(...(values as never[])) as { changes: number };
          if (changed.changes !== 1) {
            db.exec("ROLLBACK");
            const row = db.prepare("SELECT revision, row_version FROM handoffs WHERE id = ?").get(input.handoffId) as
              | { revision: number; row_version: number }
              | null
              | undefined;
            if (!row) {
              return err(
                appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${input.handoffId}'`, {
                  handoffId: input.handoffId,
                }),
              );
            }
            if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) {
              return err(
                appError(
                  "REVISION_CONFLICT",
                  "the observed document Revision is stale; retain the proposal and inspect current state",
                  {
                    handoffId: input.handoffId,
                    expectedRevision: input.expectedRevision,
                    currentRevision: row.revision,
                  },
                ),
              );
            }
            return err(
              appError(
                "ROW_VERSION_CONFLICT",
                "the Handoff changed since it was last read; re-read it and retry with the new Row Version",
                {
                  handoffId: input.handoffId,
                  expectedRowVersion: input.expectedRowVersion,
                  currentRowVersion: row.row_version,
                },
              ),
            );
          }
          if (input.comment === "deactivate") {
            db.prepare("UPDATE review_notes SET active = 0 WHERE handoff_id = ?").run(input.handoffId);
          } else if (input.comment === null) {
            db.prepare("DELETE FROM review_notes WHERE handoff_id = ?").run(input.handoffId);
          } else if (input.comment !== "retain") {
            const comment = input.comment;
            db.prepare(
              "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at, purpose, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(handoff_id) DO UPDATE SET author_kind = excluded.author_kind, author_project_id = excluded.author_project_id, target_revision = excluded.target_revision, body = excluded.body, updated_at = excluded.updated_at, purpose = excluded.purpose, active = excluded.active",
            ).run(
              input.handoffId,
              comment.authorKind,
              comment.authorProjectId,
              comment.targetRevision,
              comment.body,
              comment.createdAt,
              comment.updatedAt,
              comment.purpose,
              comment.active ? 1 : 0,
            );
          }
          for (const event of input.events) ledger.append(event);
          db.exec("COMMIT");
          return ok({ rowVersion: input.expectedRowVersion + 1 });
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // As above.
          }
          throw transactionError;
        }
      } catch (error) {
        if (options.contentionSurface !== undefined) {
          const contention = storageContentionOf(error, options.contentionSurface);
          if (contention !== null) return err(contention);
        }
        return err(
          appError("INTERNAL_ERROR", `Applying the review mutation failed: ${messageOf(error)}`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}
