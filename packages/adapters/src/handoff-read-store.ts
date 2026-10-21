import { join } from "node:path";
import { appError, err, type HandoffReadPort, type HandoffView, type ListingScope, ok } from "@sorage/core";
import type { HandoffContentIntegrity, HandoffListCandidate, LoadedHandoff } from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import { liveFencePaused } from "./intent-log";
import { vaultMoveLockHeld } from "./lockfile";
import { storageContentionOf, type ContentionSurface } from "./storage-contention";
import type { SorageSqlite } from "./sqlite/connection";

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
  handoff_id: string;
  original_name: string;
  mime_type: string;
  content_record_id: string;
}

interface ContentRecordRow {
  storage_key: string | null;
  size_bytes: number;
  sha256: string;
  materialized: number;
}

export function createSqliteHandoffReadStore(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
  options: SqliteHandoffReadStoreOptions,
): HandoffReadPort {
  const { runDir } = options;
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
  const artifactStatement = db.prepare(
    "SELECT id, handoff_id, original_name, mime_type, content_record_id FROM artifacts WHERE id = ?",
  );
  const recordStatement = db.prepare(
    "SELECT storage_key, size_bytes, sha256, materialized FROM content_records WHERE id = ?",
  );
  /**
   * One current Artifact read through its authoritative record, or the
   * missing-metadata marker. The marker covers every shape in which the
   * Handoff's named current Artifact has no honest authoritative body here: a
   * deleted Artifact row, a vanished record row, or an Artifact row that
   * belongs to a different Handoff — wrong-owner bytes are never projected
   * into this Handoff's view (SHR-004).
   */
  const artifactOf = (
    handoffId: string,
    artifactId: string | null,
  ): { artifact: HandoffView["currentArtifact"]; integrity: HandoffContentIntegrity } => {
    if (artifactId === null) return { artifact: null, integrity: "ok" };
    const artifactRow = artifactStatement.get(artifactId) as ArtifactRow | null | undefined;
    if (artifactRow === null || artifactRow === undefined) {
      return { artifact: null, integrity: "artifact-record-missing" };
    }
    if (artifactRow.handoff_id !== handoffId) {
      // The Artifact row exists but answers to another Handoff: the stored
      // ownership is immutable, so a mismatch is stored corruption, and the
      // marker never fabricates a currentArtifact for the wrong body.
      return { artifact: null, integrity: "artifact-record-missing" };
    }
    const recordRow = recordStatement.get(artifactRow.content_record_id) as ContentRecordRow | null | undefined;
    if (recordRow === null || recordRow === undefined) {
      return { artifact: null, integrity: "artifact-record-missing" };
    }
    return {
      artifact: {
        id: artifactRow.id,
        // Always present and null exactly for inline rows (SHR-013).
        storageKey: recordRow.storage_key,
        originalName: artifactRow.original_name,
        mimeType: artifactRow.mime_type,
        sizeBytes: Number(recordRow.size_bytes),
        sha256: recordRow.sha256,
        materialized: recordRow.materialized === 1,
      },
      integrity: "ok",
    };
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
  const toCandidate = (row: HandoffRow): HandoffListCandidate => {
    const tombstone = row.deleted_at !== null;
    const terminal =
      row.review_state === "accepted" || row.review_state === "declined" || row.review_state === "withdrawn";
    // Section 6: a pending Deletion Request adds the User beside the review next
    // actor, and an integrity failure — a current Artifact that never materialized
    // or whose authoritative record is missing — belongs to the User as well.
    const { artifact, integrity } = artifactOf(row.id, row.current_artifact_id);
    const integrityFailure = artifact !== null ? artifact.materialized !== true : integrity !== "ok";
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
      contentIntegrity: integrity,
      view: {
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
        currentArtifact: artifact,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        pendingDeletionRequest: pendingDeletion(row.id),
        hasReviewNote: noteExists(row.id),
        consecutiveNoChangeResolutions: row.consecutive_no_change_resolutions,
      },
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
        const row = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | null | undefined;
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

    recordFirstFetch(handoffId, event) {
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
