import { join } from "node:path";
import type { HandoffContentIntegrity, HandoffListCandidate, LoadedHandoff } from "@sorage/core";
import { appError, err, type HandoffReadPort, type HandoffView, type ListingScope, ok } from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import { liveFencePaused } from "./sqlite/move-fence";
import { vaultMoveLockHeld } from "./lockfile";
import type { SorageSqlite } from "./sqlite/connection";
import { type ContentionSurface, storageContentionOf } from "./storage-contention";

/**
 * The SQLite read store behind inbox, outbox, get, and fetch (TASK-030). Every query
 * runs in the fixed (updated_at DESC, id DESC) keyset order with the section 18 index
 * set, reads append nothing to the ledger, and `recordFirstFetch` is the one write:
 * a short transaction that sets first_fetched_at and appends the event together.
 *
 * Every current Artifact reads through
 * its authoritative content record (SHR-004), `storageKey` is always present and
 * null exactly for inline rows (SHR-013), and a living Handoff whose record row is
 * missing surfaces the private missing-state marker instead of a silent null —
 * the core read boundary resolves that marker into the honest integrity refusal.
 *
 * The first-fetch settlement is a RUN-014 domain mutation despite its unchanged
 * Row Version: the write entry checks the live vault-move lock before opening the
 * transaction and the database move fence inside it, before any timestamp or event
 * write, pausing with the existing typed SERVICE_PAUSED and leaving the timestamp
 * and ledger untouched (RUN-014, SHR-011).
 */
export interface SqliteHandoffReadStoreOptions {
  /**
   * The known home run directory whose `vault-move.lock` guards the first-fetch
   * write, or an explicit null for home-less read-only seed fixtures. Production
   * always passes the real run directory; the null is a composition choice made
   * at construction, never an omitted default guard.
   */
  runDir: string | null;
  /**
   * The invoking command family of SHR-015: when set, a busy write-lock
   * acquisition or commit in the first-fetch fence maps to the stamped
   * `STORAGE_INSPECTION_UNAVAILABLE` refusal with that family's wording.
   */
  contentionSurface?: ContentionSurface | undefined;
}

interface ProjectedHandoffRow {
  id: string;
  dispatch_group_id: string | null;
  supersedes_handoff_id: string | null;
  title: string;
  sender_kind: string;
  sender_project_id: string | null;
  sender_workspace_key: string | null;
  sender_path_snapshot: string | null;
  recipient_project_id: string;
  current_artifact_id: string | null;
  revision: number;
  consecutive_no_change_resolutions: number;
  row_version: number;
  review_state: string;
  read_status: HandoffView["read"]["status"];
  revision_read_at: string | null;
  processing_status: HandoffView["processing"]["status"];
  processing_started_at: string | null;
  processing_completed_at: string | null;
  first_fetched_at: string | null;
  review_engaged_at: string | null;
  pinned: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  sp_slug: string | null;
  rp_slug: string | null;
  a_id: string | null;
  a_handoff_id: string | null;
  a_original_name: string | null;
  a_mime_type: string | null;
  cr_id: string | null;
  cr_storage_key: string | null;
  cr_size_bytes: number | null;
  cr_sha256: string | null;
  cr_materialized: number | null;
  rn_handoff_id: string | null;
  rn_purpose: "general" | "change_request" | null;
  rn_active: number | null;
  rn_author_kind: "user" | "registered_project" | null;
  rn_author_project_id: string | null;
  rn_target_revision: number | null;
  rn_created_at: string | null;
  rn_updated_at: string | null;
  has_pending_deletion: number;
}

const HANDOFF_PROJECTION_SQL = `SELECT
  h.id,
  h.dispatch_group_id,
  h.supersedes_handoff_id,
  h.title,
  h.sender_kind,
  h.sender_project_id,
  h.sender_workspace_key,
  h.sender_path_snapshot,
  h.recipient_project_id,
  h.current_artifact_id,
  h.revision,
  h.consecutive_no_change_resolutions,
  h.row_version,
  h.review_state,
  h.read_status,
  h.revision_read_at,
  h.processing_status,
  h.processing_started_at,
  h.processing_completed_at,
  h.first_fetched_at,
  h.review_engaged_at,
  h.pinned,
  h.archived_at,
  h.deleted_at,
  h.created_at,
  h.updated_at,
  sp.slug AS sp_slug,
  rp.slug AS rp_slug,
  a.id AS a_id,
  a.handoff_id AS a_handoff_id,
  a.original_name AS a_original_name,
  a.mime_type AS a_mime_type,
  cr.id AS cr_id,
  cr.storage_key AS cr_storage_key,
  cr.size_bytes AS cr_size_bytes,
  cr.sha256 AS cr_sha256,
  cr.materialized AS cr_materialized,
  rn.handoff_id AS rn_handoff_id,
  rn.purpose AS rn_purpose,
  rn.active AS rn_active,
  rn.author_kind AS rn_author_kind,
  rn.author_project_id AS rn_author_project_id,
  rn.target_revision AS rn_target_revision,
  rn.created_at AS rn_created_at,
  rn.updated_at AS rn_updated_at,
  EXISTS(
    SELECT 1 FROM deletion_requests dr WHERE dr.handoff_id = h.id AND dr.status = 'pending'
  ) AS has_pending_deletion
FROM handoffs h
LEFT JOIN projects sp ON sp.id = h.sender_project_id
LEFT JOIN projects rp ON rp.id = h.recipient_project_id
LEFT JOIN artifacts a ON a.id = h.current_artifact_id
LEFT JOIN content_records cr ON cr.id = a.content_record_id
LEFT JOIN review_notes rn ON rn.handoff_id = h.id`;

export function createSqliteHandoffReadStore(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
  options: SqliteHandoffReadStoreOptions,
): HandoffReadPort {
  const { runDir } = options;

  /**
   * Projects one joined current Artifact through its authoritative record, or
   * the missing-metadata marker. Checks `cr_id === null` (never `storage_key`,
   * which is null for inline rows) and verifies `a_handoff_id === row.id` so
   * wrong-owner bytes are never projected into this Handoff's view (SHR-004).
   */
  const artifactOf = (
    row: ProjectedHandoffRow,
  ): { artifact: HandoffView["currentArtifact"]; integrity: HandoffContentIntegrity } => {
    if (row.current_artifact_id === null) return { artifact: null, integrity: "ok" };
    if (row.a_id === null || row.a_handoff_id !== row.id || row.cr_id === null) {
      return { artifact: null, integrity: "artifact-record-missing" };
    }
    return {
      artifact: {
        id: row.a_id,
        // Always present and null exactly for inline rows (SHR-013).
        storageKey: row.cr_storage_key,
        originalName: row.a_original_name as string,
        mimeType: row.a_mime_type as string,
        sizeBytes: Number(row.cr_size_bytes),
        sha256: row.cr_sha256 as string,
        materialized: row.cr_materialized === 1,
      },
      integrity: "ok",
    };
  };

  const commentOf = (row: ProjectedHandoffRow): HandoffView["comment"] => {
    if (row.rn_handoff_id === null) return null;
    return {
      handoffId: row.rn_handoff_id,
      purpose: row.rn_purpose as "general" | "change_request",
      active: row.rn_active === 1,
      authorKind: row.rn_author_kind as "user" | "registered_project",
      authorProjectId: row.rn_author_project_id,
      targetRevision: row.rn_target_revision as number,
      createdAt: row.rn_created_at as string,
      updatedAt: row.rn_updated_at as string,
    };
  };

  const toCandidate = (row: ProjectedHandoffRow): HandoffListCandidate => {
    const tombstone = row.deleted_at !== null;
    const terminal =
      row.review_state === "accepted" || row.review_state === "declined" || row.review_state === "withdrawn";
    // Section 6: a pending Deletion Request adds the User beside the review next
    // actor, and an integrity failure — a current Artifact that never materialized
    // or whose authoritative record is missing — belongs to the User as well.
    const { artifact, integrity } = artifactOf(row);
    const integrityFailure = artifact !== null ? artifact.materialized !== true : integrity !== "ok";
    const hasPendingDeletion = row.has_pending_deletion === 1;
    const nextActors = {
      reviewNextActor:
        tombstone || terminal
          ? null
          : row.review_state === "awaiting_recipient"
            ? ("recipient" as const)
            : ("sender" as const),
      administrativeNextActor: hasPendingDeletion || integrityFailure ? ("user" as const) : null,
    };
    return {
      contentIntegrity: integrity,
      view: {
        id: row.id,
        dispatchGroupId: row.dispatch_group_id,
        supersedesHandoffId: row.supersedes_handoff_id,
        title: row.title,
        senderKind: row.sender_kind as HandoffView["senderKind"],
        senderProjectId: row.sender_project_id,
        senderProjectSlug: row.sender_project_id === null ? null : row.sp_slug,
        senderWorkspaceKey: row.sender_workspace_key,
        senderPathSnapshot: row.sender_path_snapshot,
        recipientProjectId: row.recipient_project_id,
        recipientProjectSlug: row.rp_slug ?? row.recipient_project_id,
        revision: row.revision,
        rowVersion: row.row_version,
        reviewState: row.review_state as HandoffView["reviewState"],
        nextActors,
        read: {
          revision: row.revision,
          status: tombstone ? "unrecorded" : row.read_status,
          readAt: tombstone ? null : row.revision_read_at,
        },
        processing: {
          revision: row.revision,
          status: tombstone ? "unrecorded" : row.processing_status,
          startedAt: tombstone ? null : row.processing_started_at,
          completedAt: tombstone ? null : row.processing_completed_at,
        },
        comment: tombstone ? null : commentOf(row),
        firstFetchedAt: row.first_fetched_at,
        reviewEngagedAt: row.review_engaged_at,
        pinned: row.pinned === 1,
        archivedAt: row.archived_at,
        deletedAt: row.deleted_at,
        currentArtifact: artifact,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        pendingDeletionRequest: hasPendingDeletion,
        hasReviewNote: row.rn_handoff_id !== null && row.rn_purpose === "change_request" && row.rn_active === 1,
        consecutiveNoChangeResolutions: row.consecutive_no_change_resolutions,
      },
    };
  };

  function scopeSql(scope: ListingScope, params: unknown[]): string {
    switch (scope.kind) {
      case "inbox":
        params.push(scope.recipientProjectId);
        return "h.recipient_project_id = ?";
      case "outbox_project":
        params.push(scope.senderProjectId);
        return "h.sender_project_id = ?";
      case "outbox_workspace":
        params.push(scope.workspaceKey);
        return "h.sender_workspace_key = ?";
      default:
        return "1 = 1";
    }
  }

  return {
    listPage(scope, filters, limit, afterSortKey) {
      try {
        const params: unknown[] = [];
        const clauses = [scopeSql(scope, params)];
        if (filters.state !== undefined) {
          clauses.push("h.review_state = ?");
          params.push(filters.state);
        }
        if (filters.senderSlug !== undefined) {
          clauses.push("h.sender_project_id = (SELECT id FROM projects WHERE slug = ? COLLATE NOCASE)");
          params.push(filters.senderSlug);
        }
        if (filters.recipientSlug !== undefined) {
          clauses.push("h.recipient_project_id = (SELECT id FROM projects WHERE slug = ? COLLATE NOCASE)");
          params.push(filters.recipientSlug);
        }
        if (filters.updatedSince !== undefined) {
          clauses.push("h.updated_at >= ?");
          params.push(filters.updatedSince);
        }
        if (filters.updatedUntil !== undefined) {
          clauses.push("h.updated_at <= ?");
          params.push(filters.updatedUntil);
        }
        if (!filters.includeArchived) clauses.push("h.archived_at IS NULL");
        if (!filters.includeDeleted) clauses.push("h.deleted_at IS NULL");
        if (afterSortKey !== null) {
          const separator = afterSortKey.lastIndexOf("|");
          const afterUpdated = afterSortKey.slice(0, separator);
          const afterId = afterSortKey.slice(separator + 1);
          clauses.push("(h.updated_at < ? OR (h.updated_at = ? AND h.id < ?))");
          params.push(afterUpdated, afterUpdated, afterId);
        }
        params.push(limit);
        const rows = db
          .prepare(
            `${HANDOFF_PROJECTION_SQL} WHERE ${clauses.join(" AND ")} ORDER BY h.updated_at DESC, h.id DESC LIMIT ?`,
          )
          .all(...(params as never[])) as unknown as ProjectedHandoffRow[];
        // Candidates carry the private missing-record marker; the core trims the
        // visible page before resolving it, so an overflow row never leaks or
        // fails a page it is not part of (SHR-004, SHR-014).
        const items = rows.map(toCandidate);
        const last = items[items.length - 1];
        return ok({ items, lastSortKey: last ? `${last.view.updatedAt}|${last.view.id}` : null });
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Listing Handoffs failed: ${messageOf(error)}`, { cause: String(error) }),
        );
      }
    },

    loadHandoff(id) {
      try {
        const row = db.prepare(`${HANDOFF_PROJECTION_SQL} WHERE h.id = ?`).get(id) as
          | ProjectedHandoffRow
          | null
          | undefined;
        return ok(row ? toCandidate(row) : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the Handoff failed: ${messageOf(error)}`));
      }
    },

    findHandoffView(id) {
      const loaded = this.loadHandoff(id);
      if (!loaded.ok) return loaded;
      return ok(loaded.value === null ? null : loaded.value.view);
    },

    recordFirstFetch(handoffId, event, delivered) {
      // The write entry observes the live vault-move lock before any SQL runs;
      // filesystem lock inspection stays outside transactions (NFR-014).
      if (runDir !== null && vaultMoveLockHeld(runDir)) {
        return err(
          appError(
            "SERVICE_PAUSED",
            "A Vault move or restore is in progress; this first-fetch settlement paused instead of racing it.",
            { lockPath: join(runDir, "vault-move.lock") },
          ),
        );
      }
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          // Inside the writer transaction the database move fence serializes
          // against the mover's fence-and-count transaction: the settlement
          // either lands before the fence or waits on the write lock and then
          // sees the fence and pauses (RUN-014, SHR-011).
          const fence = liveFencePaused(db);
          if (fence !== null) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; this first-fetch settlement paused instead of racing it.",
                { moveFencePid: fence.pid },
              ),
            );
          }
          {
            const current = db
              .prepare(
                "SELECT current_artifact_id, revision, row_version FROM handoffs WHERE id = ? AND deleted_at IS NULL",
              )
              .get(handoffId) as
              | { current_artifact_id: string | null; revision: number; row_version: number }
              | null
              | undefined;
            if (!current) {
              db.exec("ROLLBACK");
              return ok(undefined);
            }
            if (
              delivered !== undefined &&
              current.current_artifact_id === delivered.artifactId &&
              current.revision === delivered.revision
            ) {
              const read = db
                .prepare(
                  "UPDATE handoffs SET read_status = 'read', read_revision = revision, revision_read_at = ? WHERE id = ? AND read_status != 'read'",
                )
                .run(delivered.readEvent.createdAt, handoffId) as { changes: number };
              if (read.changes === 1) ledger.append({ ...delivered.readEvent, rowVersion: current.row_version });
            }
            // Successful delivery of an older acquired body still owes the
            // independent historical first-fetch marker below (HND-012/021).
            // Only the current-Revision receipt is fenced by Artifact identity.
          }
          const changed = db
            .prepare("UPDATE handoffs SET first_fetched_at = ? WHERE id = ? AND first_fetched_at IS NULL")
            .run(event.createdAt, handoffId) as { changes: number };
          if (changed.changes === 1) ledger.append(event);
          db.exec("COMMIT");
          return ok(undefined);
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
        return err(appError("INTERNAL_ERROR", `Recording the first fetch failed: ${messageOf(error)}`, { handoffId }));
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { HandoffListCandidate, LoadedHandoff };
