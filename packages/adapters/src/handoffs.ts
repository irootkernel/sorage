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

/**
 * The SQLite revision store behind TASK-032: `applyContentRevision` is the one
 * transaction of section 20.4 — the compare-and-set that bumps Revision and swaps the
 * current Artifact reference, the Review Note deletion, the old Artifact row deletion,
 * the new Artifact row, the activate and unlink intents, the events, and the keyed
 * idempotency response — and `applyNoChangeResolution` is its contentless sibling.
 */
export function createSqliteRevisionStore(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
): import("@sorage/core").RevisionMutationPort {
  const write = createSqliteHandoffWriteStore(db, ledger);
  const insertIntent = () =>
    db.prepare(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)",
    );
  return {
    idempotencyLookup: (key, scope) => write.idempotencyLookup(key, scope),
    applyContentRevision(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          // The vault-move fence pauses revision exactly as it pauses creation: a
          // committed intent is a promise about the current Vault (RUN-002).
          const pausedRevision = liveFencePaused(db);
          if (pausedRevision) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; the revision paused instead of racing it.",
                {
                  moveFencePid: pausedRevision.pid,
                },
              ),
            );
          }
          const changed = db
            .prepare(
              "UPDATE handoffs SET revision = revision + 1, review_state = ?, current_artifact_id = ?, consecutive_no_change_resolutions = 0, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ?",
            )
            .run(
              "awaiting_recipient",
              input.newArtifact.id,
              input.events[0]?.createdAt ?? new Date().toISOString(),
              input.handoffId,
              input.expectedRowVersion,
            ) as { changes: number };
          if (changed.changes !== 1) {
            return rollbackWithConflict(db, input.handoffId, input.expectedRowVersion);
          }
          db.prepare("DELETE FROM review_notes WHERE handoff_id = ?").run(input.handoffId);
          db.prepare("DELETE FROM artifacts WHERE handoff_id = ? AND id != ?").run(
            input.handoffId,
            input.newArtifact.id,
          );
          db.prepare(
            "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
          ).run(
            input.newArtifact.id,
            input.newArtifact.handoffId,
            input.newArtifact.storageKey,
            input.newArtifact.originalName,
            input.newArtifact.storedName,
            input.newArtifact.mimeType,
            input.newArtifact.sizeBytes,
            input.newArtifact.sha256,
            input.newArtifact.importedFromPath,
            input.newArtifact.createdAt,
          );
          const intents = insertIntent();
          intents.run(
            input.activateIntent.id,
            input.activateIntent.op,
            input.activateIntent.fromPath,
            input.activateIntent.toPath,
            input.activateIntent.artifactId,
            input.activateIntent.createdAt,
          );
          if (input.unlinkIntent !== null) {
            intents.run(
              input.unlinkIntent.id,
              input.unlinkIntent.op,
              input.unlinkIntent.fromPath,
              input.unlinkIntent.toPath,
              input.unlinkIntent.artifactId,
              input.unlinkIntent.createdAt,
            );
          }
          for (const event of input.events) {
            ledger.append(event);
          }
          if (input.idempotency !== undefined) {
            db.prepare(
              "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              input.idempotency.key,
              input.idempotency.scope,
              input.idempotency.requestHash,
              input.idempotency.responseJson,
              input.events[0]?.createdAt ?? new Date().toISOString(),
              input.idempotency.expiresAt,
            );
          }
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
          appError("INTERNAL_ERROR", `Applying the content revision failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    applyNoChangeResolution(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const changed = db
            .prepare(
              "UPDATE handoffs SET review_state = ?, consecutive_no_change_resolutions = consecutive_no_change_resolutions + 1, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ?",
            )
            .run(
              "awaiting_recipient",
              input.events[0]?.createdAt ?? new Date().toISOString(),
              input.handoffId,
              input.expectedRowVersion,
            ) as {
            changes: number;
          };
          if (changed.changes !== 1) {
            return rollbackWithConflict(db, input.handoffId, input.expectedRowVersion);
          }
          db.prepare("DELETE FROM review_notes WHERE handoff_id = ?").run(input.handoffId);
          for (const event of input.events) {
            ledger.append(event);
          }
          if (input.idempotency !== undefined) {
            db.prepare(
              "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              input.idempotency.key,
              input.idempotency.scope,
              input.idempotency.requestHash,
              input.idempotency.responseJson,
              input.events[0]?.createdAt ?? new Date().toISOString(),
              input.idempotency.expiresAt,
            );
          }
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
          appError("INTERNAL_ERROR", `Applying the no-change resolution failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    completeActivations: (completions) => write.completeActivations(completions),
    completeUnlinks(completions) {
      if (completions.length === 0) return ok({ completed: 0 });
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const completion of completions) {
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
          appError("INTERNAL_ERROR", `Completing the unlinks failed: ${messageOf(error)}.`, { cause: String(error) }),
        );
      }
    },
  };
}

function rollbackWithConflict(
  db: SorageSqlite,
  handoffId: string,
  expectedRowVersion: number,
): Result<{ rowVersion: number }, AppError> {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Nothing left to roll back.
  }
  const row = db.prepare("SELECT row_version FROM handoffs WHERE id = ?").get(handoffId) as
    | { row_version: number }
    | null
    | undefined;
  if (!row) {
    return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${handoffId}'`, { handoffId }));
  }
  return err(
    appError(
      "ROW_VERSION_CONFLICT",
      "the Handoff changed since it was last read; re-read it and retry with the new Row Version",
      {
        handoffId,
        expectedRowVersion,
        currentRowVersion: row.row_version,
      },
    ),
  );
}

/**
 * The SQLite terminal store behind TASK-033: one transaction per transition holding
 * the compare-and-set with its domain assignments and the ledger append.
 */
export function createSqliteTerminalStore(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
): import("@sorage/core").TerminalMutationPort {
  return {
    applyTerminalTransition(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const columns = Object.keys(input.assignments);
          const sets = columns.map((column) => `${column} = ?`).join(", ");
          const values = columns.map((column) => input.assignments[column]);
          const changed = db
            .prepare(`UPDATE handoffs SET ${sets}, row_version = row_version + 1 WHERE id = ? AND row_version = ?`)
            .run(...(values as never[]), input.handoffId, input.expectedRowVersion) as { changes: number };
          if (changed.changes !== 1) {
            return rollbackWithConflict(db, input.handoffId, input.expectedRowVersion);
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
          appError("INTERNAL_ERROR", `Applying the terminal transition failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}

/**
 * The SQLite retention store behind TASK-034: one transaction per decision holding
 * the compare-and-set, the deletion-request insert or resolution, the optional
 * unlink intent of the approval, and the events.
 */
export function createSqliteRetentionStore(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
): import("@sorage/core").RetentionMutationPort {
  return {
    applyRetentionMutation(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          // The vault-move fence pauses the intent-committing decisions: the
          // deletion approval records an unlink intent, so it races the mover the
          // same way a creation or revision does, while a pin or archive that
          // records no intent may proceed (RUN-002).
          const pausedRetention = input.unlinkIntent !== undefined ? liveFencePaused(db) : null;
          if (pausedRetention) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; the retention decision paused instead of racing it.",
                {
                  moveFencePid: pausedRetention.pid,
                },
              ),
            );
          }
          const columns = Object.keys(input.assignments);
          const sets = columns.map((column) => `${column} = ?`).join(", ");
          const values = columns.map((column) => input.assignments[column]);
          const changed = db
            .prepare(`UPDATE handoffs SET ${sets}, row_version = row_version + 1 WHERE id = ? AND row_version = ?`)
            .run(...(values as never[]), input.handoffId, input.expectedRowVersion) as { changes: number };
          if (changed.changes !== 1) {
            return rollbackWithConflict(db, input.handoffId, input.expectedRowVersion);
          }
          if (input.deletionRequest?.op === "insert") {
            db.prepare(
              "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
            ).run(
              input.deletionRequest.id,
              input.handoffId,
              input.deletionRequest.requestedByKind,
              input.deletionRequest.requestedById,
              input.deletionRequest.reason,
              input.events[0]?.createdAt ?? new Date().toISOString(),
            );
          } else if (input.deletionRequest?.op === "resolve") {
            db.prepare(
              "UPDATE deletion_requests SET status = ?, resolved_at = ?, resolved_by_user = ?, resolution_note = ? WHERE handoff_id = ? AND status = 'pending'",
            ).run(
              input.deletionRequest.status,
              input.events[0]?.createdAt ?? new Date().toISOString(),
              input.deletionRequest.resolvedByUser,
              input.deletionRequest.resolutionNote,
              input.handoffId,
            );
          }
          if (input.unlinkIntent !== undefined) {
            db.prepare("DELETE FROM review_notes WHERE handoff_id = ?").run(input.handoffId);
            db.prepare("DELETE FROM artifacts WHERE handoff_id = ?").run(input.handoffId);
            db.prepare(
              "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'unlink', NULL, ?, ?, ?, 0)",
            ).run(
              input.unlinkIntent.id,
              input.unlinkIntent.toPath,
              input.unlinkIntent.artifactId,
              input.events[0]?.createdAt ?? new Date().toISOString(),
            );
          }
          for (const event of input.events) {
            ledger.append(event);
          }
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
          appError("INTERNAL_ERROR", `Applying the retention decision failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    findPendingRequest(handoffId) {
      try {
        const row = db
          .prepare("SELECT id FROM deletion_requests WHERE handoff_id = ? AND status = 'pending'")
          .get(handoffId) as { id: string } | null | undefined;
        return ok(row ? { id: row.id } : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the deletion request failed: ${messageOf(error)}`));
      }
    },
    completeUnlink(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(input.intentId);
          ledger.append(input.event);
          db.exec("COMMIT");
          return ok({ completed: 1 });
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
          appError("INTERNAL_ERROR", `Completing the deletion unlink failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}
