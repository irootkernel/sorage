import { type AppError, appError, err, type FanoutCommit, type HandoffWritePort, ok, type Result } from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import { liveFencePaused } from "./intent-log";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The Row Version compare-and-set of section 19 and section 7 of security-reliability.md
 * (HND-014, HND-025, SEC-008): one statement assigns the domain columns and bumps
 * `row_version` together, the driver's affected-row count is the verdict, and a stale
 * expectation fails with `ROW_VERSION_CONFLICT` without retrying. Domain column
 * assignments join the same statement, so the check and the write cannot separate.
 * The same module carries the creation transaction: `createFanout` commits every
 * Handoff row, Artifact row, intent, event, and idempotency response of one send in
 * a single all-or-nothing transaction (HND-008), and `completeActivations` is the
 * short completion transaction of ADR-0013.
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

/**
 * The SQLite write port behind Handoff creation (TASK-029). `createFanout` inserts
 * every row of the fan-out and appends every event inside one transaction, so the
 * dispatch group is all-or-nothing in the database (HND-008) and a duplicate
 * idempotency key in one scope surfaces as the database's own rejection.
 */
export function createSqliteHandoffWriteStore(db: SorageSqlite, ledger: SqliteEventLedger): HandoffWritePort {
  const insertIntent = () =>
    db.prepare(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)",
    );
  return {
    createFanout(commit: FanoutCommit): Result<{ recorded: number }, AppError> {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          // The vault-move fence pauses creation exactly as it pauses intent records:
          // a fan-out's committed intents are promises about the current Vault
          // (RUN-002, the closed EPIC-004 seam).
          const paused = liveFencePaused(db);
          if (paused) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; the Handoff creation paused instead of racing it.",
                {
                  moveFencePid: paused.pid,
                },
              ),
            );
          }
          const insertHandoff = db.prepare(
            "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'awaiting_recipient', 0, 0, ?, ?)",
          );
          for (const handoff of commit.handoffs) {
            insertHandoff.run(
              handoff.id,
              handoff.dispatchGroupId,
              handoff.supersedesHandoffId,
              handoff.title,
              handoff.senderKind,
              handoff.senderProjectId,
              handoff.senderWorkspaceKey,
              handoff.senderPathSnapshot,
              handoff.recipientProjectId,
              handoff.currentArtifactId,
              handoff.createdAt,
              handoff.createdAt,
            );
          }
          const insertArtifact = db.prepare(
            "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
          );
          for (const artifact of commit.artifacts) {
            insertArtifact.run(
              artifact.id,
              artifact.handoffId,
              artifact.storageKey,
              artifact.originalName,
              artifact.storedName,
              artifact.mimeType,
              artifact.sizeBytes,
              artifact.sha256,
              artifact.importedFromPath,
              artifact.createdAt,
            );
          }
          const intents = insertIntent();
          for (const intent of commit.intents) {
            intents.run(intent.id, intent.op, intent.fromPath, intent.toPath, intent.artifactId, intent.createdAt);
          }
          for (const event of commit.events) {
            ledger.append(event);
          }
          if (commit.idempotency !== undefined) {
            db.prepare(
              "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              commit.idempotency.key,
              commit.idempotency.scope,
              commit.idempotency.requestHash,
              commit.idempotency.responseJson,
              commit.events[0]?.createdAt ?? new Date().toISOString(),
              commit.idempotency.expiresAt,
            );
          }
          db.exec("COMMIT");
          return ok({ recorded: commit.handoffs.length });
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction never opened or the connection already rolled back.
          }
          throw transactionError;
        }
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Creating the Handoff fan-out failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    completeActivations(completions): Result<{ completed: number }, AppError> {
      if (completions.length === 0) return ok({ completed: 0 });
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const completion of completions) {
            db.prepare("UPDATE artifacts SET materialized = 1 WHERE id = ?").run(completion.artifactId);
            db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(completion.intentId);
            ledger.append(completion.event);
          }
          db.exec("COMMIT");
          return ok({ completed: completions.length });
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
          appError("INTERNAL_ERROR", `Completing Artifact activations failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    findSupersedesTarget(id) {
      try {
        const row = db.prepare("SELECT review_state, deleted_at FROM handoffs WHERE id = ?").get(id) as
          | { review_state: string; deleted_at: string | null }
          | null
          | undefined;
        return ok(row ? { reviewState: row.review_state, deletedAt: row.deleted_at } : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the supersedes target failed: ${messageOf(error)}`));
      }
    },

    idempotencyLookup(key, scope) {
      try {
        const row = db
          .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
          .get(key, scope) as { request_hash: string; response_json: string } | null | undefined;
        return ok(row ? { requestHash: row.request_hash, responseJson: row.response_json } : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the idempotency key failed: ${messageOf(error)}`));
      }
    },
  };
}
