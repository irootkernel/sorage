import {
  type AppError,
  appError,
  err,
  type HandoffListFilters,
  type HandoffReadPort,
  type HandoffView,
  type ListingScope,
  ok,
  type Result,
} from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The SQLite read store behind inbox, outbox, get, and fetch (TASK-030). Every query
 * runs in the fixed (updated_at DESC, id DESC) keyset order with the section 18 index
 * set, reads append nothing to the ledger, and `recordFirstFetch` is the one write:
 * a short transaction that sets first_fetched_at and appends the event together.
 */

interface HandoffRow {
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
  first_fetched_at: string | null;
  review_engaged_at: string | null;
  pinned: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  materialized: number;
}

export function createSqliteHandoffReadStore(db: SorageSqlite, ledger: SqliteEventLedger): HandoffReadPort {
  const slugStatement = db.prepare("SELECT slug FROM projects WHERE id = ?");
  const slugMemo = new Map<string, string | null>();
  const slugOf = (projectId: string | null): string | null => {
    if (projectId === null) return null;
    const memoized = slugMemo.get(projectId);
    if (memoized !== undefined) return memoized;
    const row = slugStatement.get(projectId) as { slug: string } | null | undefined;
    const slug = row ? row.slug : null;
    slugMemo.set(projectId, slug);
    return slug;
  };
  const artifactStatement = db.prepare("SELECT * FROM artifacts WHERE id = ?");
  const artifactOf = (artifactId: string | null) => {
    if (artifactId === null) return null;
    const row = artifactStatement.get(artifactId) as ArtifactRow | null | undefined;
    return row
      ? {
          id: row.id,
          storageKey: row.storage_key,
          originalName: row.original_name,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
          materialized: row.materialized === 1,
        }
      : null;
  };
  const noteStatement = db.prepare("SELECT 1 AS one FROM review_notes WHERE handoff_id = ?");
  const noteExists = (handoffId: string): boolean => {
    const row = noteStatement.get(handoffId) as { one: number } | null | undefined;
    return row !== null && row !== undefined;
  };
  const pendingStatement = db.prepare(
    "SELECT 1 AS one FROM deletion_requests WHERE handoff_id = ? AND status = 'pending'",
  );
  const pendingDeletion = (handoffId: string): boolean => {
    const row = pendingStatement.get(handoffId) as { one: number } | null | undefined;
    return row !== null && row !== undefined;
  };
  const toView = (row: HandoffRow): HandoffView => {
    const tombstone = row.deleted_at !== null;
    const terminal =
      row.review_state === "accepted" || row.review_state === "declined" || row.review_state === "withdrawn";
    // Section 6: a pending Deletion Request adds the User beside the review next
    // actor, and an integrity failure — a current Artifact that never materialized —
    // belongs to the User as well.
    const currentArtifact = artifactOf(row.current_artifact_id);
    const integrityFailure = currentArtifact !== null && currentArtifact.materialized !== true;
    const nextActors = {
      reviewNextActor:
        tombstone || terminal
          ? null
          : row.review_state === "awaiting_recipient"
            ? ("recipient" as const)
            : ("sender" as const),
      administrativeNextActor: pendingDeletion(row.id) || integrityFailure ? ("user" as const) : null,
    };
    return {
      id: row.id,
      dispatchGroupId: row.dispatch_group_id,
      supersedesHandoffId: row.supersedes_handoff_id,
      title: row.title,
      senderKind: row.sender_kind as HandoffView["senderKind"],
      senderProjectId: row.sender_project_id,
      senderProjectSlug: slugOf(row.sender_project_id),
      senderWorkspaceKey: row.sender_workspace_key,
      senderPathSnapshot: row.sender_path_snapshot,
      recipientProjectId: row.recipient_project_id,
      recipientProjectSlug: slugOf(row.recipient_project_id) ?? row.recipient_project_id,
      revision: row.revision,
      rowVersion: row.row_version,
      reviewState: row.review_state as HandoffView["reviewState"],
      nextActors,
      firstFetchedAt: row.first_fetched_at,
      reviewEngagedAt: row.review_engaged_at,
      pinned: row.pinned === 1,
      archivedAt: row.archived_at,
      deletedAt: row.deleted_at,
      currentArtifact,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pendingDeletionRequest: pendingDeletion(row.id),
      hasReviewNote: noteExists(row.id),
      consecutiveNoChangeResolutions: row.consecutive_no_change_resolutions,
    };
  };

  function scopeSql(scope: ListingScope, params: unknown[]): string {
    switch (scope.kind) {
      case "inbox":
        params.push(scope.recipientProjectId);
        return "recipient_project_id = ?";
      case "outbox_project":
        params.push(scope.senderProjectId);
        return "sender_project_id = ?";
      case "outbox_workspace":
        params.push(scope.workspaceKey);
        return "sender_workspace_key = ?";
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
          clauses.push("review_state = ?");
          params.push(filters.state);
        }
        if (filters.senderSlug !== undefined) {
          clauses.push("sender_project_id = (SELECT id FROM projects WHERE slug = ? COLLATE NOCASE)");
          params.push(filters.senderSlug);
        }
        if (filters.recipientSlug !== undefined) {
          clauses.push("recipient_project_id = (SELECT id FROM projects WHERE slug = ? COLLATE NOCASE)");
          params.push(filters.recipientSlug);
        }
        if (filters.updatedSince !== undefined) {
          clauses.push("updated_at >= ?");
          params.push(filters.updatedSince);
        }
        if (filters.updatedUntil !== undefined) {
          clauses.push("updated_at <= ?");
          params.push(filters.updatedUntil);
        }
        if (!filters.includeArchived) clauses.push("archived_at IS NULL");
        if (!filters.includeDeleted) clauses.push("deleted_at IS NULL");
        if (afterSortKey !== null) {
          const separator = afterSortKey.lastIndexOf("|");
          const afterUpdated = afterSortKey.slice(0, separator);
          const afterId = afterSortKey.slice(separator + 1);
          clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
          params.push(afterUpdated, afterUpdated, afterId);
        }
        params.push(limit);
        const rows = db
          .prepare(`SELECT * FROM handoffs WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`)
          .all(...(params as never[])) as unknown as HandoffRow[];
        const items = rows.map(toView);
        const last = items[items.length - 1];
        return ok({ items, lastSortKey: last ? `${last.updatedAt}|${last.id}` : null });
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Listing Handoffs failed: ${messageOf(error)}`, { cause: String(error) }),
        );
      }
    },

    findHandoffView(id) {
      try {
        const row = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | null | undefined;
        return ok(row ? toView(row) : null);
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Reading the Handoff failed: ${messageOf(error)}`));
      }
    },

    recordFirstFetch(handoffId, event) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const changed = db
            .prepare("UPDATE handoffs SET first_fetched_at = ? WHERE id = ? AND first_fetched_at IS NULL")
            .run(event.createdAt, handoffId) as { changes: number };
          if (changed.changes !== 1) {
            db.exec("ROLLBACK");
            return ok(undefined);
          }
          ledger.append(event);
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
        return err(appError("INTERNAL_ERROR", `Recording the first fetch failed: ${messageOf(error)}`, { handoffId }));
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
