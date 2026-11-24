import {
  type AppError,
  appError,
  type ContentReferences,
  err,
  ok,
  parseStoredMemoReceipt,
  type Result,
} from "@sorage/core";
import {
  CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION,
  HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION,
  inspectArtifactStorageLayout,
  inspectChannelStorageLayout,
  inspectMemoStorageLayout,
  MEMO_CONTENT_ADOPTION_SCHEMA_VERSION,
} from "./content-layout";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The default SQL reference provider (SHR-004, SHR-008, SHR-014): reads
 * Artifact, Memo, and Channel content-record references through the verified
 * storage layouts and resolves unexpired Memo-scope retained-response receipts.
 */
export function sqliteContentReferences(db: SorageSqlite): ContentReferences {
  return {
    domainReferencedRecordIds() {
      try {
        const layout = inspectArtifactStorageLayout(db);
        if (layout === "inconsistent") {
          return err(
            appError(
              "STORAGE_INTEGRITY_ERROR",
              `The applied schema is at or above version ${String(HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION)} but the artifacts table is missing or has no content_record_id column; the Artifact content references could not be read.`,
              { cause: "artifacts-storage-layout-inconsistent" },
            ),
          );
        }
        const artifactIds =
          layout === "legacy-columns" || layout === "pre-adoption"
            ? []
            : (
                db
                  .prepare("SELECT content_record_id FROM artifacts WHERE content_record_id IS NOT NULL")
                  .all() as unknown as Array<{ content_record_id: string }>
              ).map((row) => row.content_record_id);
        const memoLayout = inspectMemoStorageLayout(db);
        if (memoLayout === "inconsistent") {
          return err(
            appError(
              "STORAGE_INTEGRITY_ERROR",
              `The applied schema is at or above version ${String(MEMO_CONTENT_ADOPTION_SCHEMA_VERSION)} but the project_memos table is missing or has no content_record_id column; the Memo content references could not be read.`,
              { cause: "memo-storage-layout-inconsistent" },
            ),
          );
        }
        const memoIds =
          memoLayout === "content-records"
            ? (
                db
                  .prepare("SELECT content_record_id FROM project_memos WHERE content_record_id IS NOT NULL")
                  .all() as unknown as Array<{ content_record_id: string }>
              ).map((row) => row.content_record_id)
            : [];
        const channelLayout = inspectChannelStorageLayout(db);
        if (channelLayout === "inconsistent") {
          return err(
            appError(
              "STORAGE_INTEGRITY_ERROR",
              `The applied schema is at or above version ${String(CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION)} but the channel_messages table is missing or has no content_record_id column; the Channel content references could not be read.`,
              { cause: "channel-storage-layout-inconsistent" },
            ),
          );
        }
        const channelIds =
          channelLayout === "channel-records"
            ? (
                db
                  .prepare("SELECT content_record_id FROM channel_messages WHERE content_record_id IS NOT NULL")
                  .all() as unknown as Array<{ content_record_id: string }>
              ).map((row) => row.content_record_id)
            : [];
        return ok([...artifactIds, ...memoIds, ...channelIds]);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the content references failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    receiptReferencedRecordIds(now: Date) {
      try {
        const rows = db
          .prepare(
            "SELECT scope, response_json FROM idempotency_keys WHERE scope >= 'memo:' AND scope < 'memo;' AND expires_at > ?",
          )
          .all(now.toISOString()) as unknown as Array<{ scope: string; response_json: string }>;
        const ids: string[] = [];
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.response_json);
          } catch {
            return err(
              appError("STORAGE_INTEGRITY_ERROR", `A stored Memo receipt under scope ${row.scope} is not valid JSON.`, {
                scope: row.scope,
              }),
            );
          }
          const receipt = parseStoredMemoReceipt(parsed);
          if (!receipt.ok) return receipt;
          if (receipt.value.memo.body === null) ids.push(receipt.value.memo.bodyRef.recordId);
        }
        return ok(ids);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the retained Memo receipt references failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    isDomainReferenced(recordId: string) {
      try {
        const layout = inspectArtifactStorageLayout(db);
        if (layout === "inconsistent") {
          return err(
            appError(
              "STORAGE_INTEGRITY_ERROR",
              `The applied schema is at or above version ${String(HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION)} but the artifacts table is missing or has no content_record_id column; the Artifact content references could not be read.`,
              { cause: "artifacts-storage-layout-inconsistent" },
            ),
          );
        }
        const memoLayout = inspectMemoStorageLayout(db);
        if (memoLayout === "inconsistent") {
          return err(
            appError(
              "STORAGE_INTEGRITY_ERROR",
              `The applied schema is at or above version ${String(MEMO_CONTENT_ADOPTION_SCHEMA_VERSION)} but the project_memos table is missing or has no content_record_id column; the Memo content references could not be read.`,
              { cause: "memo-storage-layout-inconsistent" },
            ),
          );
        }
        const channelLayout = inspectChannelStorageLayout(db);
        if (channelLayout === "inconsistent") {
          return err(
            appError(
              "STORAGE_INTEGRITY_ERROR",
              `The applied schema is at or above version ${String(CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION)} but the channel_messages table is missing or has no content_record_id column; the Channel content references could not be read.`,
              { cause: "channel-storage-layout-inconsistent" },
            ),
          );
        }
        if (
          layout === "content-records" &&
          Boolean(db.prepare("SELECT 1 FROM artifacts WHERE content_record_id = ? LIMIT 1").get(recordId))
        ) {
          return ok(true);
        }
        if (
          memoLayout === "content-records" &&
          Boolean(db.prepare("SELECT 1 FROM project_memos WHERE content_record_id = ? LIMIT 1").get(recordId))
        ) {
          return ok(true);
        }
        if (
          channelLayout === "channel-records" &&
          Boolean(db.prepare("SELECT 1 FROM channel_messages WHERE content_record_id = ? LIMIT 1").get(recordId))
        ) {
          return ok(true);
        }
        return ok(false);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the content references failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    isReceiptReferenced(recordId: string, now: Date) {
      try {
        const rows = db
          .prepare(
            "SELECT scope, response_json FROM idempotency_keys WHERE scope >= 'memo:' AND scope < 'memo;' AND expires_at > ?",
          )
          .all(now.toISOString()) as unknown as Array<{ scope: string; response_json: string }>;
        let referenced = false;
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.response_json);
          } catch {
            return err(
              appError("STORAGE_INTEGRITY_ERROR", `A stored Memo receipt under scope ${row.scope} is not valid JSON.`, {
                scope: row.scope,
              }),
            );
          }
          const receipt = parseStoredMemoReceipt(parsed);
          if (!receipt.ok) return receipt;
          if (receipt.value.memo.body === null && receipt.value.memo.bodyRef.recordId === recordId) {
            referenced = true;
          }
        }
        return ok(referenced);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the retained Memo receipt references failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}

/**
 * Derives the physical GC key guard from the record-based reference providers
 * (SHR-008, SHR-011): the keys of records unexpired retained responses name.
 */
export function receiptReferencedContentKeys(
  db: SorageSqlite,
  now: Date,
  references: ContentReferences = sqliteContentReferences(db),
): Result<string[], AppError> {
  const ids = references.receiptReferencedRecordIds(now);
  if (!ids.ok) return ids;
  if (ids.value.length === 0) return ok([]);
  try {
    const placeholders = ids.value.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT storage_key FROM content_records WHERE storage_key IS NOT NULL AND id IN (${placeholders})`)
      .all(...ids.value) as unknown as Array<{ storage_key: string }>;
    return ok(rows.map((row) => row.storage_key));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Resolving retained-response content references failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
