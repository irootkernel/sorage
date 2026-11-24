import { type AppError, appError, err, ok, type Result } from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The schema version at which `artifacts` gained its normalized
 * `content_record_id` reference — the TASK-107 Handoff adoption rebuild
 * (interface section 38.7). A database whose applied history is at or above
 * this version must carry the reference column; one below it legitimately
 * keeps the legacy mirrored columns and has no Artifact content references.
 */
export const HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION = 9;

/**
 * The verified storage-layout distinction for read-only Artifact surfaces
 * (SHR-014, section 35): which physical columns `artifacts` carries is decided
 * from the table's actual shape together with the applied migration history —
 * never from catching a missing-column SQL error and guessing.
 */
export type ArtifactStorageLayout = "content-records" | "legacy-columns" | "pre-adoption" | "inconsistent";

function appliedSchemaMaximum(db: SorageSqlite): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | null
    | undefined;
  return row?.version ?? 0;
}

export function inspectArtifactStorageLayout(db: SorageSqlite): ArtifactStorageLayout {
  const columns = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return appliedSchemaMaximum(db) >= HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION ? "inconsistent" : "pre-adoption";
  }
  if (columns.some((column) => column.name === "content_record_id")) return "content-records";
  return appliedSchemaMaximum(db) >= HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION ? "inconsistent" : "legacy-columns";
}

/**
 * The shared read guard for every checksum-census and physical-GC protection
 * boundary (SHR-004, SHR-008, SHR-014): in the normalized layout every
 * `artifacts` row must carry an authoritative content record — an INNER JOIN
 * would silently drop an Artifact whose referenced record row is missing and
 * report a false healthy empty census or an incomplete live-key proof.
 */
export function validateArtifactContentLinks(db: SorageSqlite): Result<void, AppError> {
  try {
    const layout = inspectArtifactStorageLayout(db);
    if (layout === "pre-adoption" || layout === "legacy-columns") return ok(undefined);
    if (layout === "inconsistent") {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The applied schema is at or above version ${String(HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION)} but the artifacts table is missing or has no content_record_id column; the Artifact content links could not be verified.`,
          { cause: "artifacts-storage-layout-inconsistent" },
        ),
      );
    }
    const recordTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
      .get() as { name: string } | null | undefined;
    if (recordTable === null || recordTable === undefined) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The applied schema is at or above version ${String(HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION)} but the content_records table is missing; the Artifact content links could not be verified.`,
          { cause: "content-records-table-missing" },
        ),
      );
    }
    const dangling = db
      .prepare(
        "SELECT a.id AS artifact_id, a.content_record_id AS content_record_id FROM artifacts a LEFT JOIN content_records c ON c.id = a.content_record_id WHERE c.id IS NULL LIMIT 1",
      )
      .get() as { artifact_id: string; content_record_id: string } | null | undefined;
    if (dangling !== null && dangling !== undefined) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The Artifact ${dangling.artifact_id} references content record ${dangling.content_record_id}, which is missing; the Artifact content links could not be verified.`,
          { artifactId: dangling.artifact_id, contentRecordId: dangling.content_record_id },
        ),
      );
    }
    return validateLivingHandoffArtifactLinks(db);
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Verifying the Artifact content links failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

/** The applied-history-aware Memo storage layouts the Memo link guard understands. */
export type MemoStorageLayout = "pre-memo" | "legacy-body" | "content-records" | "inconsistent";

/** The Memo adoption schema version; at or above it the normalized layout is required (SHR-009). */
export const MEMO_CONTENT_ADOPTION_SCHEMA_VERSION = 10;

export function inspectMemoStorageLayout(db: SorageSqlite): MemoStorageLayout {
  const columns = db.prepare("PRAGMA table_info(project_memos)").all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return appliedSchemaMaximum(db) >= 7 ? "inconsistent" : "pre-memo";
  }
  if (columns.some((column) => column.name === "content_record_id")) return "content-records";
  return appliedSchemaMaximum(db) >= MEMO_CONTENT_ADOPTION_SCHEMA_VERSION ? "inconsistent" : "legacy-body";
}

export function validateMemoContentLinks(db: SorageSqlite): Result<void, AppError> {
  try {
    const layout = inspectMemoStorageLayout(db);
    if (layout === "pre-memo" || layout === "legacy-body") return ok(undefined);
    if (layout === "inconsistent") {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The applied schema is at or above version ${String(MEMO_CONTENT_ADOPTION_SCHEMA_VERSION)} but the project_memos table is missing or has no content_record_id column; the Memo content links could not be verified.`,
          { cause: "memo-storage-layout-inconsistent" },
        ),
      );
    }
    const recordTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
      .get() as { name: string } | null | undefined;
    if (recordTable === null || recordTable === undefined) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The applied schema is at or above version ${String(MEMO_CONTENT_ADOPTION_SCHEMA_VERSION)} but the content_records table is missing; the Memo content links could not be verified.`,
          { cause: "content-records-table-missing" },
        ),
      );
    }
    const dangling = db
      .prepare(
        "SELECT m.id AS memo_id, m.content_record_id AS content_record_id FROM project_memos m LEFT JOIN content_records c ON c.id = m.content_record_id WHERE c.id IS NULL OR m.content_record_id IS NULL LIMIT 1",
      )
      .get() as { memo_id: string; content_record_id: string | null } | null | undefined;
    if (dangling !== null && dangling !== undefined) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The Memo ${dangling.memo_id} references content record ${String(dangling.content_record_id)}, which is missing; the Memo content links could not be verified.`,
          { memoId: dangling.memo_id, contentRecordId: dangling.content_record_id },
        ),
      );
    }
    return ok(undefined);
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Verifying the Memo content links failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

/** The applied-history-aware Channel storage layouts the Channel link guard understands. */
export type ChannelStorageLayout = "pre-channel" | "channel-records" | "inconsistent";

/** The Channel domain schema version; at or above it the Channel tables and their reference are required (SHR-009). */
export const CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION = 11;

export function inspectChannelStorageLayout(db: SorageSqlite): ChannelStorageLayout {
  const columns = db.prepare("PRAGMA table_info(channel_messages)").all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return appliedSchemaMaximum(db) >= CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION ? "inconsistent" : "pre-channel";
  }
  if (columns.some((column) => column.name === "content_record_id")) return "channel-records";
  return "inconsistent";
}

export function validateChannelContentLinks(db: SorageSqlite): Result<void, AppError> {
  try {
    const layout = inspectChannelStorageLayout(db);
    if (layout === "pre-channel") return ok(undefined);
    if (layout === "inconsistent") {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The applied schema is at or above version ${String(CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION)} but the channel_messages table is missing or has no content_record_id column; the Channel content links could not be verified.`,
          { cause: "channel-storage-layout-inconsistent" },
        ),
      );
    }
    const recordTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
      .get() as { name: string } | null | undefined;
    if (recordTable === null || recordTable === undefined) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The applied schema is at or above version ${String(CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION)} but the content_records table is missing; the Channel content links could not be verified.`,
          { cause: "content-records-table-missing" },
        ),
      );
    }
    const dangling = db
      .prepare(
        "SELECT m.channel_id AS channel_id, m.seq AS seq, m.content_record_id AS content_record_id FROM channel_messages m LEFT JOIN content_records c ON c.id = m.content_record_id WHERE c.id IS NULL OR m.content_record_id IS NULL LIMIT 1",
      )
      .get() as { channel_id: string; seq: number; content_record_id: string | null } | null | undefined;
    if (dangling !== null && dangling !== undefined) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The Channel ${dangling.channel_id} message ${String(dangling.seq)} references content record ${String(dangling.content_record_id)}, which is missing; the Channel content links could not be verified.`,
          { channelId: dangling.channel_id, seq: dangling.seq, contentRecordId: dangling.content_record_id },
        ),
      );
    }
    return ok(undefined);
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Verifying the Channel content links failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

function validateLivingHandoffArtifactLinks(db: SorageSqlite): Result<void, AppError> {
  try {
    const broken = db
      .prepare(
        `SELECT h.id AS handoff_id, h.current_artifact_id AS artifact_id, a.handoff_id AS owner_handoff_id,
           a.content_record_id AS content_record_id
         FROM handoffs h LEFT JOIN artifacts a ON a.id = h.current_artifact_id
         WHERE h.deleted_at IS NULL
           AND (a.id IS NULL OR a.handoff_id != h.id OR NOT EXISTS (SELECT 1 FROM content_records c WHERE c.id = a.content_record_id))
         LIMIT 1`,
      )
      .get() as
      | {
          handoff_id: string;
          artifact_id: string | null;
          owner_handoff_id: string | null;
          content_record_id: string | null;
        }
      | null
      | undefined;
    if (broken === null || broken === undefined) return ok(undefined);
    if (broken.owner_handoff_id === null) {
      if (broken.artifact_id === null) {
        return err(
          appError(
            "STORAGE_INTEGRITY_ERROR",
            `The living Handoff ${broken.handoff_id} names no current Artifact; the Artifact content links could not be verified.`,
            { handoffId: broken.handoff_id, cause: "current-artifact-id-missing" },
          ),
        );
      }
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The living Handoff ${broken.handoff_id} names current Artifact ${broken.artifact_id}, whose row is missing; the Artifact content links could not be verified.`,
          { handoffId: broken.handoff_id, artifactId: broken.artifact_id, cause: "current-artifact-row-missing" },
        ),
      );
    }
    if (broken.owner_handoff_id !== broken.handoff_id) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The current Artifact ${String(broken.artifact_id)} of living Handoff ${broken.handoff_id} belongs to Handoff ${broken.owner_handoff_id}; the Artifact content links could not be verified.`,
          {
            handoffId: broken.handoff_id,
            artifactId: broken.artifact_id,
            ownerHandoffId: broken.owner_handoff_id,
            cause: "current-artifact-wrong-association",
          },
        ),
      );
    }
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        `The current Artifact ${String(broken.artifact_id)} of living Handoff ${broken.handoff_id} references content record ${String(broken.content_record_id)}, which is missing; the Artifact content links could not be verified.`,
        {
          handoffId: broken.handoff_id,
          artifactId: broken.artifact_id,
          contentRecordId: broken.content_record_id,
          cause: "current-artifact-record-missing",
        },
      ),
    );
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Verifying the living Handoff Artifact links failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
