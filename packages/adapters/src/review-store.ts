import { appError, err, ok, type ReviewMutationPort, type ReviewNoteView } from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The SQLite review store behind TASK-031: one transaction per mutation holds the Row
 * Version compare-and-set, the note upsert or delete, the first set of
 * review_engaged_at, and the ledger append, so a Note and its event can never part.
 * The handoff_id primary key is the at-most-one-Note constraint (REV-001).
 */

interface NoteRow {
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

export function createSqliteReviewStore(db: SorageSqlite, ledger: SqliteEventLedger): ReviewMutationPort {
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
        const row = db.prepare("SELECT * FROM review_notes WHERE handoff_id = ?").get(handoffId) as
          | NoteRow
          | null
          | undefined;
        return ok(row ? toNote(row) : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the review note failed: ${messageOf(error)}`));
      }
    },
    applyReviewMutation(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const assignments: string[] = ["review_state = ?", "updated_at = ?"];
          const values: unknown[] = [input.reviewState, input.event.createdAt];
          if (input.setReviewEngagedAt) {
            assignments.push("review_engaged_at = COALESCE(review_engaged_at, ?)");
            values.push(input.event.createdAt);
          }
          values.push(input.handoffId, input.expectedRowVersion);
          const changed = db
            .prepare(
              `UPDATE handoffs SET ${assignments.join(", ")}, row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
            )
            .run(...(values as never[])) as { changes: number };
          if (changed.changes !== 1) {
            db.exec("ROLLBACK");
            const row = db.prepare("SELECT row_version FROM handoffs WHERE id = ?").get(input.handoffId) as
              | { row_version: number }
              | null
              | undefined;
            if (!row) {
              return err(
                appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${input.handoffId}'`, {
                  handoffId: input.handoffId,
                }),
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
          if (input.note.op === "upsert") {
            db.prepare(
              "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(handoff_id) DO UPDATE SET author_kind = excluded.author_kind, author_project_id = excluded.author_project_id, target_revision = excluded.target_revision, body = excluded.body, updated_at = excluded.updated_at",
            ).run(
              input.handoffId,
              input.note.authorKind,
              input.note.authorProjectId,
              input.note.targetRevision,
              input.note.body,
              input.note.now,
              input.note.now,
            );
          } else {
            db.prepare("DELETE FROM review_notes WHERE handoff_id = ?").run(input.handoffId);
          }
          ledger.append(input.event);
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
        return err(
          appError("INTERNAL_ERROR", `Applying the review mutation failed: ${messageOf(error)}`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}
