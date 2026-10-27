import { dirname } from "node:path";
import {
  type ActorRef,
  type AppError,
  appError,
  type ContentRecord,
  type ContentRecordRemovalPlan,
  err,
  type FanoutCommit,
  type HandoffWritePort,
  ok,
  type Result,
} from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import { liveFencePaused } from "./intent-log";
import type { SorageSqlite } from "./sqlite/connection";
import { type ContentionSurface, storageContentionOf } from "./storage-contention";

export interface IdempotencyLookupOptions {
  now?: (() => Date) | undefined;
  /**
   * The invoking command family of SHR-015: when set, a busy write-lock
   * acquisition or commit in this store's transactions maps to the stamped
   * `STORAGE_INSPECTION_UNAVAILABLE` refusal with that family's wording.
   */
  contentionSurface?: ContentionSurface | undefined;
}

/**
 * The normalized Artifact-content bindings of schema 9 (SHR-004, section 38.7):
 * every Handoff mutation store receives the shared content store's
 * transaction-composable primitives so the Artifact row, its immutable content
 * record, and the domain change commit in one transaction. Record creation
 * throws to abort the enclosing transaction; reference-proof removal returns
 * its Result so the caller aborts on refusal and keeps a legitimately retained
 * record (for example one whose activation is still pending) in place. Content
 * UUIDs come from the shared id generator and are independent of the Artifact's
 * own id, which is never reused.
 */
export interface ArtifactContentBindings {
  /** Inserts one content record inside the caller's open transaction; throws so that transaction aborts. */
  insertArtifactContentRecord(record: ContentRecord): void;
  /** The shared reference-proof removal, executed inside the caller's open transaction. */
  removeArtifactContentRecord(recordId: string): Result<ContentRecordRemovalPlan, AppError>;
  /** One fresh immutable content-record UUID for a newly created Artifact. */
  nextContentRecordId(): string;
}

function removeExpiredIdempotency(db: SorageSqlite, options: IdempotencyLookupOptions): void {
  const now = (options.now ?? (() => new Date()))().toISOString();
  db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(now);
}

function atOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

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

/** The surfaced contention refusal for a store transaction failure, or null (SHR-015). */
function contentionRefusal(error: unknown, surface: ContentionSurface | undefined): AppError | null {
  return surface !== undefined ? storageContentionOf(error, surface) : null;
}

/**
 * The SQLite write port behind Handoff creation (TASK-029). `createFanout` inserts
 * every row of the fan-out and appends every event inside one transaction, so the
 * dispatch group is all-or-nothing in the database (HND-008) and a duplicate
 * idempotency key in one scope surfaces as the database's own rejection.
 */
export function createSqliteHandoffWriteStore(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
  options: IdempotencyLookupOptions = {},
  content: ArtifactContentBindings,
): HandoffWritePort {
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
          const bindingRows =
            commit.unregisteredSenderPath !== undefined || commit.registeredSender !== undefined
              ? (db
                  .prepare(
                    "SELECT b.id, b.project_id, b.directory, b.binding_kind, p.slug, p.status FROM project_bindings b JOIN projects p ON p.id = b.project_id",
                  )
                  .all() as Array<{
                  id: string;
                  project_id: string;
                  directory: string;
                  binding_kind: string;
                  slug: string;
                  status: string;
                }>)
              : [];
          if (commit.registeredSender !== undefined) {
            const sender = commit.registeredSender;
            if (sender.asOverride) {
              if (!bindingRows.some((row) => row.project_id === sender.projectId)) {
                db.exec("ROLLBACK");
                return err(
                  appError(
                    "PROJECT_UNBOUND",
                    "the sender Project lost its last binding while the Handoff was prepared",
                  ),
                );
              }
            } else {
              const gitOwner = bindingRows.find(
                (row) => row.binding_kind === "git_repository" && row.directory === sender.gitCommonDirectory,
              );
              const directoryOwner = bindingRows
                .filter(
                  (row) =>
                    row.binding_kind === "directory" &&
                    (sender.directory === row.directory || sender.directory.startsWith(`${row.directory}/`)),
                )
                .sort((a, b) => b.directory.length - a.directory.length)[0];
              const owner = gitOwner ?? directoryOwner;
              if (owner?.id !== sender.bindingId || owner.project_id !== sender.projectId) {
                db.exec("ROLLBACK");
                return err(
                  owner?.status === "archived"
                    ? appError(
                        "PROJECT_ARCHIVED",
                        "the sender path changed to an archived Project while the Handoff was prepared",
                        {
                          slug: owner.slug,
                        },
                      )
                    : appError(
                        "SENDER_IDENTITY_DOWNGRADE",
                        "the sender path changed Project identity while the Handoff was prepared; retry the send",
                        {
                          slug: owner?.slug,
                        },
                      ),
                );
              }
            }
          }
          if (commit.unregisteredSenderPath !== undefined) {
            const { directory, gitCommonDirectory, allowUnregistered } = commit.unregisteredSenderPath;
            const gitOwner = bindingRows.find(
              (row) => row.binding_kind === "git_repository" && row.directory === gitCommonDirectory,
            );
            const directoryOwner = bindingRows
              .filter(
                (row) =>
                  row.binding_kind === "directory" &&
                  (directory === row.directory || directory.startsWith(`${row.directory}/`)),
              )
              .sort((a, b) => b.directory.length - a.directory.length)[0];
            const owner = gitOwner ?? directoryOwner;
            const unresolvedRoot = bindingRows.find((row) => {
              const root = row.binding_kind === "directory" ? row.directory : dirname(row.directory);
              return atOrBelow(root, directory) || atOrBelow(directory, root);
            });
            if (owner !== undefined || (!allowUnregistered && unresolvedRoot !== undefined)) {
              db.exec("ROLLBACK");
              return err(
                owner?.status === "archived"
                  ? appError("PROJECT_ARCHIVED", "the sender Project was archived while the Handoff was prepared", {
                      slug: owner.slug,
                    })
                  : appError(
                      "SENDER_IDENTITY_DOWNGRADE",
                      "the sender Workspace overlapped a registered Project while the Handoff was prepared; retry the send",
                      { slug: (owner ?? unresolvedRoot)?.slug },
                    ),
              );
            }
          }
          const projectStatus = db.prepare("SELECT slug, status FROM projects WHERE id = ?");
          const participants = new Set<string>();
          for (const handoff of commit.handoffs) {
            if (handoff.senderProjectId !== null) participants.add(handoff.senderProjectId);
            participants.add(handoff.recipientProjectId);
          }
          for (const projectId of participants) {
            const project = projectStatus.get(projectId) as { slug: string; status: string } | null | undefined;
            if (project?.status === "archived") {
              db.exec("ROLLBACK");
              return err(
                appError("PROJECT_ARCHIVED", "an archived Project cannot start a new Handoff", {
                  slug: project.slug,
                }),
              );
            }
            const binding = db.prepare("SELECT 1 FROM project_bindings WHERE project_id = ? LIMIT 1").get(projectId);
            if (binding === null || binding === undefined) {
              db.exec("ROLLBACK");
              return err(
                appError("PROJECT_UNBOUND", "a Project lost its last binding while the Handoff was prepared", {
                  slug: project?.slug,
                }),
              );
            }
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
            "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          );
          for (const artifact of commit.artifacts) {
            // The immutable content record is the single physical authority
            // (SHR-004): an inline body commits materialized with no file and
            // no physical event, while a file-backed Artifact commits with its
            // activation still owed, exactly as the mirrored columns did
            // before.
            const contentRecordId = content.nextContentRecordId();
            content.insertArtifactContentRecord({
              id: contentRecordId,
              inlineText: artifact.inlineBody,
              storageKey: artifact.storageKey,
              sizeBytes: artifact.sizeBytes,
              sha256: artifact.sha256,
              materialized: artifact.inlineBody !== null,
              createdAt: artifact.createdAt,
            });
            insertArtifact.run(
              artifact.id,
              artifact.handoffId,
              artifact.originalName,
              artifact.storedName,
              artifact.mimeType,
              artifact.importedFromPath,
              artifact.createdAt,
              contentRecordId,
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
        const contention = contentionRefusal(error, options.contentionSurface);
        if (contention !== null) return err(contention);
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
          let winners = 0;
          for (const completion of completions) {
            // The persisted pending row — read and retained before this
            // completion's own DELETE — is the authority for the physical
            // target and the event attribution; only the own-DELETE winner
            // settles the record state and appends (SHR-004, section 3).
            if (
              settleLegacyCompletion(db, ledger, {
                intentId: completion.intentId,
                expectOp: "activate",
                expectedArtifactId: completion.artifactId,
                eventHandoffId: completion.event.handoffId,
                eventId: completion.event.id,
                eventType: "ARTIFACT_ACTIVATED",
                actor: completion.event.actor,
                createdAt: completion.event.createdAt,
              })
            ) {
              winners += 1;
            }
          }
          db.exec("COMMIT");
          return ok({ completed: winners });
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
        removeExpiredIdempotency(db, options);
        const row = db
          .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
          .get(key, scope) as { request_hash: string; response_json: string } | null | undefined;
        return ok(row ? { requestHash: row.request_hash, responseJson: row.response_json } : null);
      } catch (error) {
        // The keyed lookups' expiry cleanup is a write-lock acquisition during
        // the command's write preparation, so a surfaced composition maps its
        // busy signature to the stamped refusal rather than INTERNAL_ERROR
        // (SHR-015).
        const contention = contentionRefusal(error, options.contentionSurface);
        if (contention !== null) return err(contention);
        return err(appError("INTERNAL_ERROR", `Reading the idempotency key failed: ${messageOf(error)}`));
      }
    },
    senderOfHandoff(id) {
      try {
        const row = db
          .prepare("SELECT sender_kind, sender_project_id, sender_workspace_key FROM handoffs WHERE id = ?")
          .get(id) as
          | {
              sender_kind: "registered_project" | "unregistered_workspace" | "user";
              sender_project_id: string | null;
              sender_workspace_key: string | null;
            }
          | null
          | undefined;
        return ok(
          row
            ? { kind: row.sender_kind, projectId: row.sender_project_id, workspaceKey: row.sender_workspace_key }
            : null,
        );
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the original Handoff sender failed: ${messageOf(error)}`));
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
  options: IdempotencyLookupOptions = {},
  content: ArtifactContentBindings,
): import("@sorage/core").RevisionMutationPort {
  const write = createSqliteHandoffWriteStore(db, ledger, options, content);
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
              "UPDATE handoffs SET revision = revision + 1, read_status = 'unrecorded', read_revision = NULL, revision_read_at = NULL, processing_status = 'unrecorded', processing_started_at = NULL, processing_completed_at = NULL, review_state = ?, current_artifact_id = ?, consecutive_no_change_resolutions = 0, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ?",
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
          // The replacement lands first, so the living Handoff's metadata is
          // coherent at reference-proof time: the strengthened proof inside
          // the shared removal would otherwise see the CAS'd current Artifact
          // id with no row yet and refuse every legitimate revision. The new
          // Artifact id is fresh, so it never collides with a superseded row.
          const contentRecordId = content.nextContentRecordId();
          content.insertArtifactContentRecord({
            id: contentRecordId,
            // An inline replacement body commits materialized with no file and
            // no physical intent; a file-backed one owes its activation
            // exactly as a new send does (SHR-004, section 38.2).
            inlineText: input.newArtifact.inlineBody,
            storageKey: input.newArtifact.storageKey,
            sizeBytes: input.newArtifact.sizeBytes,
            sha256: input.newArtifact.sha256,
            materialized: input.newArtifact.inlineBody !== null,
            createdAt: input.newArtifact.createdAt,
          });
          db.prepare(
            "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            input.newArtifact.id,
            input.newArtifact.handoffId,
            input.newArtifact.originalName,
            input.newArtifact.storedName,
            input.newArtifact.mimeType,
            input.newArtifact.importedFromPath,
            input.newArtifact.createdAt,
            contentRecordId,
          );
          // The superseded Artifact rows vanish in this same transaction, and
          // their content records leave through the shared reference-proof
          // removal: the proof runs inside this transaction after the
          // referencing rows are gone, a refusal aborts the whole revision, and
          // a legitimately retained record — one whose activation is still
          // pending — stays for the maintenance cleanup to reevaluate.
          const supersededRecords = db
            .prepare("SELECT content_record_id FROM artifacts WHERE handoff_id = ? AND id != ?")
            .all(input.handoffId, input.newArtifact.id) as Array<{ content_record_id: string }>;
          db.prepare("DELETE FROM artifacts WHERE handoff_id = ? AND id != ?").run(
            input.handoffId,
            input.newArtifact.id,
          );
          for (const superseded of supersededRecords) {
            const removal = content.removeArtifactContentRecord(superseded.content_record_id);
            if (!removal.ok) {
              // A refusal aborts the whole revision inside this open
              // transaction: roll back every earlier mutation of this call
              // before propagating the existing error code.
              db.exec("ROLLBACK");
              return err(removal.error);
            }
          }
          const intents = insertIntent();
          if (input.activateIntent !== null) {
            intents.run(
              input.activateIntent.id,
              input.activateIntent.op,
              input.activateIntent.fromPath,
              input.activateIntent.toPath,
              input.activateIntent.artifactId,
              input.activateIntent.createdAt,
            );
          }
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
        const contention = contentionRefusal(error, options.contentionSurface);
        if (contention !== null) return err(contention);
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
        const contention = contentionRefusal(error, options.contentionSurface);
        if (contention !== null) return err(contention);
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
          let winners = 0;
          for (const completion of completions) {
            // Exactly-once over the persisted row: the live pending intent's
            // own to_path, ownership, and exactly-matching authorized
            // ArtifactID are retained before this completion's DELETE, and
            // only that winner appends — with the association and digest
            // derived from the authoritative Artifact row first, preserving
            // the ordinary command's Handoff association when that row was
            // already superseded, never from the caller's event metadata or a
            // pathname (VLT-014, VLT-022).
            if (
              settleLegacyCompletion(db, ledger, {
                intentId: completion.intentId,
                expectOp: "unlink",
                expectedArtifactId: completion.artifactId,
                eventHandoffId: completion.event.handoffId,
                eventId: completion.event.id,
                eventType: "ARTIFACT_UNLINKED",
                actor: completion.event.actor,
                createdAt: completion.event.createdAt,
              })
            ) {
              winners += 1;
            }
          }
          db.exec("COMMIT");
          return ok({ completed: winners });
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

/**
 * The shared legacy settlement of the ordinary mutation paths (VLT-014,
 * VLT-022): inside the caller's open BEGIN IMMEDIATE, the live pending
 * row's persisted op, to_path, and artifact ownership are read and retained
 * BEFORE this completion's own DELETE — only the own-DELETE winner settles.
 * An unlink additionally requires the supplied expected ArtifactID to exactly
 * match the persisted artifact_id before anything is cleared: a mismatch is
 * not this completion's row and returns with the row, state, attempts, and
 * events completely untouched. The winner pins the content-record state
 * update to the persisted exact stored key, keeps the persisted to_path as
 * the sole physical target and metadata storageKey authority, and resolves
 * the event association from the authoritative Artifact row first; when that
 * row is already gone — the ordinary supersede/delete shape, where the
 * command's own earlier transaction removed it — the matched non-null
 * expected ArtifactID plus a present string event.handoffId (trusted core
 * context, never event.metadata or a parsed path) preserves the ordinary
 * Handoff association, and a null===null context-free legacy row wins without
 * any fabricated association. An activation keeps the authoritative-row
 * association and digest rules with an omitted unavailable digest. The
 * caller's event id, actor, and clock are always preserved.
 */
function settleLegacyCompletion(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
  input: {
    intentId: string;
    expectOp: "activate" | "unlink";
    expectedArtifactId: string | null;
    eventHandoffId: string | null | undefined;
    eventId: string;
    eventType: "ARTIFACT_ACTIVATED" | "ARTIFACT_UNLINKED";
    actor: ActorRef;
    createdAt: string;
  },
): boolean {
  // The persisted row's operation AND ownership are validated inside the
  // winning transaction: the shared pending table also carries Memo/Channel
  // common intents (the complete owner triple), and an ordinary legacy
  // completion must never clear a common-owned row or append an Artifact event
  // to it. Legitimate legacy ownership is all-null owners with the artifact_id
  // free to be null — the valid legacy shapes stay winners exactly as before.
  const row = db
    .prepare("SELECT op, to_path, artifact_id, owner_domain, owner_id, content_id FROM pending_fs_ops WHERE id = ?")
    .get(input.intentId) as
    | {
        op: string;
        to_path: string;
        artifact_id: string | null;
        owner_domain: string | null;
        owner_id: string | null;
        content_id: string | null;
      }
    | null
    | undefined;
  if (
    row === null ||
    row === undefined ||
    row.op !== input.expectOp ||
    row.owner_domain !== null ||
    row.owner_id !== null ||
    row.content_id !== null
  ) {
    return false;
  }
  // The unlink's authorized retired Artifact must exactly match the persisted
  // intent's artifact row BEFORE any DELETE, state change, or event: a
  // mismatched completion is not this row's winner and leaves everything
  // untouched (null === null is the legitimate context-free legacy shape).
  if (input.expectOp === "unlink" && row.artifact_id !== input.expectedArtifactId) {
    return false;
  }
  const cleared = db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(input.intentId) as { changes: number };
  if (cleared.changes !== 1) return false;
  if (input.expectOp === "activate" && row.artifact_id !== null) {
    db.prepare(
      "UPDATE content_records SET materialized = 1 WHERE storage_key = ? AND inline_text IS NULL AND (id = (SELECT content_record_id FROM artifacts WHERE id = ?) OR materialized = 0)",
    ).run(row.to_path, row.artifact_id);
  }
  const artifact =
    row.artifact_id === null
      ? null
      : ((db
          .prepare(
            "SELECT a.handoff_id, cr.sha256 FROM artifacts a JOIN content_records cr ON cr.id = a.content_record_id WHERE a.id = ?",
          )
          .get(row.artifact_id) as { handoff_id: string; sha256: string } | null | undefined) ?? null);
  // The authoritative Artifact row is the primary association authority. When
  // it is already gone — the ordinary supersede/delete shape — the matched
  // non-null expected ArtifactID plus a present string event.handoffId carries
  // the ordinary command's trusted association; an absent association is never
  // inferred from the persisted path.
  let association: string | null = artifact === null ? null : artifact.handoff_id;
  if (
    artifact === null &&
    input.expectOp === "unlink" &&
    row.artifact_id !== null &&
    input.expectedArtifactId === row.artifact_id &&
    typeof input.eventHandoffId === "string"
  ) {
    association = input.eventHandoffId;
  }
  const metadata: Record<string, unknown> = { storageKey: row.to_path };
  if (input.expectOp === "activate" && artifact !== null) {
    metadata.sha256 = artifact.sha256;
  }
  ledger.append({
    id: input.eventId,
    handoffId: association,
    eventType: input.eventType,
    actor: input.actor,
    rowVersion: null,
    metadata,
    createdAt: input.createdAt,
  });
  return true;
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
  options: { contentionSurface?: ContentionSurface | undefined } = {},
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
          if (input.assignments.review_state !== undefined && input.assignments.review_state !== "changes_requested") {
            db.prepare("UPDATE review_notes SET active = 0 WHERE handoff_id = ?").run(input.handoffId);
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
        const contention = contentionRefusal(error, options.contentionSurface);
        if (contention !== null) return err(contention);
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
  options: IdempotencyLookupOptions = {},
  content: ArtifactContentBindings,
): import("@sorage/core").RetentionMutationPort {
  return {
    applyRetentionMutation(input) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          // The vault-move fence pauses the content-committing decisions: a
          // deletion approval removes current content — its file unlink intent
          // or its inline record — so it races the mover the same way a
          // creation or revision does, while a pin or archive that touches no
          // content may proceed (RUN-002, SHR-011).
          const contentRemoval = input.unlinkIntent !== undefined || input.removeContent === true;
          const pausedRetention = contentRemoval ? liveFencePaused(db) : null;
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
          // The honest logical-deletion signal removes current content in this
          // same domain transaction whether or not a physical unlink intent
          // exists: an approved inline Artifact leaves no file to unlink, and
          // no fake key or intent is manufactured to trigger the cleanup
          // (SHR-004, SHR-008).
          if (input.unlinkIntent !== undefined || input.removeContent === true) {
            db.prepare("DELETE FROM review_notes WHERE handoff_id = ?").run(input.handoffId);
            db.prepare(
              "UPDATE handoffs SET read_status = 'unrecorded', read_revision = NULL, revision_read_at = NULL, processing_status = 'unrecorded', processing_started_at = NULL, processing_completed_at = NULL WHERE id = ?",
            ).run(input.handoffId);
            // The tombstoned Handoff's Artifact rows vanish in this same
            // transaction; their content records leave through the shared
            // reference-proof removal inside it, with the same refusal and
            // retained-record semantics as a revision.
            const tombstonedRecords = db
              .prepare("SELECT content_record_id FROM artifacts WHERE handoff_id = ?")
              .all(input.handoffId) as Array<{ content_record_id: string }>;
            db.prepare("DELETE FROM artifacts WHERE handoff_id = ?").run(input.handoffId);
            for (const tombstoned of tombstonedRecords) {
              const removal = content.removeArtifactContentRecord(tombstoned.content_record_id);
              if (!removal.ok) {
                // Same abort discipline as a revision: no partial retention
                // mutation survives a removal refusal.
                db.exec("ROLLBACK");
                return err(removal.error);
              }
            }
            if (input.unlinkIntent !== undefined) {
              db.prepare(
                "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'unlink', NULL, ?, ?, ?, 0)",
              ).run(
                input.unlinkIntent.id,
                input.unlinkIntent.toPath,
                input.unlinkIntent.artifactId,
                input.events[0]?.createdAt ?? new Date().toISOString(),
              );
            }
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
        const contention = contentionRefusal(error, options.contentionSurface);
        if (contention !== null) return err(contention);
        return err(
          appError("INTERNAL_ERROR", `Applying the retention decision failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    idempotencyLookup(key, scope) {
      try {
        removeExpiredIdempotency(db, options);
        const row = db
          .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
          .get(key, scope) as { request_hash: string; response_json: string } | null | undefined;
        return ok(row ? { requestHash: row.request_hash, responseJson: row.response_json } : null);
      } catch (error) {
        // The keyed lookup's expiry cleanup is a write-lock acquisition during
        // write preparation; a surfaced composition maps its busy signature to
        // the stamped refusal rather than INTERNAL_ERROR (SHR-015).
        const contention = contentionRefusal(error, options.contentionSurface);
        if (contention !== null) return err(contention);
        return err(
          appError("INTERNAL_ERROR", `Reading the idempotency record failed: ${messageOf(error)}`, {
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
          // Exactly-once over the persisted row: the live pending intent's own
          // to_path, ownership, and exactly-matching authorized ArtifactID are
          // retained before this completion's DELETE, and only that winner
          // appends — with the association derived from the authoritative
          // Artifact row first, preserving the ordinary command's Handoff
          // association when that row was already deleted, never from the
          // caller's event metadata or a pathname (VLT-014, VLT-022).
          const settled = settleLegacyCompletion(db, ledger, {
            intentId: input.intentId,
            expectOp: "unlink",
            expectedArtifactId: input.artifactId,
            eventHandoffId: input.event.handoffId,
            eventId: input.event.id,
            eventType: "ARTIFACT_UNLINKED",
            actor: input.event.actor,
            createdAt: input.event.createdAt,
          });
          db.exec("COMMIT");
          return ok({ completed: settled ? 1 : 0 });
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
