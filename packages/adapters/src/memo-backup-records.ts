import { createHash } from "node:crypto";
import { closeSync, fstatSync, readSync } from "node:fs";
import {
  type AppError,
  appError,
  err,
  isManagedContentStorageKey,
  isMemoContentBytes,
  type Memo,
  ok,
  type Result,
  type SnapshotMemoV3,
  validateMemoBody,
} from "@sorage/core";
import { placeExclusive } from "./fs-atomic";
import { digestManagedFile, managedPath, managedRoot, openManagedFile } from "./managed-paths";
import {
  type ContentJoinRow,
  insertMemoSnapshotRow,
  MEMO_SELECT,
  requireJoinedRecord,
  snapshotFromRow,
  snapshotMetaOf,
} from "./memo-rows";
import type { SorageSqlite } from "./sqlite/connection";

/** One file-backed Memo body the export carries: its immutable reference plus the raw Vault bytes (SHR-010). */
export interface MemoContentReference {
  memoId: string;
  contentId: string;
  contentPath: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

/** Reads every Memo as its routed format-3 export record, plus the file-backed references' identities (SHR-010). */
export function readMemoExport(
  db: SorageSqlite,
): Result<{ memos: SnapshotMemoV3[]; contentFiles: MemoContentReference[] }, AppError> {
  try {
    const rows = db.prepare(`${MEMO_SELECT} ORDER BY m.id`).all() as unknown as ContentJoinRow[];
    const memos: SnapshotMemoV3[] = [];
    const contentFiles: MemoContentReference[] = [];
    for (const row of rows) {
      const joined = requireJoinedRecord(row);
      if (!joined.ok) return joined;
      const snapshot = snapshotFromRow(joined.value);
      if (snapshot.body !== null) {
        if (
          !validateMemoBody(snapshot.body).ok ||
          Buffer.byteLength(snapshot.body, "utf8") !== snapshot.bodyRef.sizeBytes ||
          createHash("sha256").update(snapshot.body).digest("hex") !== snapshot.bodyRef.sha256
        )
          return err(appError("STORAGE_INTEGRITY_ERROR", "A Memo inline body disagrees with its recorded identity"));
        const meta = snapshotMetaOf(snapshot);
        memos.push({ ...meta, bodyContent: { kind: "inline", text: snapshot.body } });
      } else {
        if (row.materialized === 0) {
          return err(appError("CONTENT_MATERIALIZING", "A Memo body is waiting for its committed activation"));
        }
        const contentId = snapshot.bodyRef.recordId;
        const contentPath = `content/memo/${snapshot.id}/${contentId}`;
        memos.push({
          ...snapshotMetaOf(snapshot),
          bodyContent: {
            kind: "file-backed",
            contentPath,
            sizeBytes: snapshot.bodyRef.sizeBytes,
            sha256: snapshot.bodyRef.sha256,
          },
        });
        contentFiles.push({
          memoId: snapshot.id,
          contentId,
          contentPath,
          sizeBytes: snapshot.bodyRef.sizeBytes,
          sha256: snapshot.bodyRef.sha256,
          storageKey: joined.value.storage_key as string,
        });
      }
    }
    return ok({ memos, contentFiles });
  } catch {
    return err(appError("INTERNAL_ERROR", "Reading the Memos for export failed"));
  }
}

/** Restores one exported file-backed Memo: the SQL half only — prepared metadata inserts atomically, no filesystem I/O inside the restore transaction (SHR-004, section 38.7, P5). */
export function insertMemoWithFileRecordRows(
  db: SorageSqlite,
  meta: Omit<Memo, "body">,
  bytes: { sizeBytes: number; sha256: string },
  recordId: string,
  storageKey: string,
): void {
  db.prepare(
    `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
    VALUES (?, NULL, ?, ?, ?, 1, ?)`,
  ).run(recordId, storageKey, bytes.sizeBytes, bytes.sha256, meta.createdAt);
  insertMemoSnapshotRow(db, {
    id: meta.id,
    projectId: meta.projectId,
    title: meta.title,
    body: null,
    bodyRef: { recordId, sizeBytes: bytes.sizeBytes, sha256: bytes.sha256 },
    state: meta.state,
    rowVersion: meta.rowVersion,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    createdBy: meta.createdBy,
    updatedBy: meta.updatedBy,
    closedAt: meta.closedAt,
    closedBy: meta.closedBy,
  });
}

/**
 * Places one file-backed Memo restore's carried bytes at the fresh managed
 * key through the managed-path safety seams, OUTSIDE the SQL transaction: a
 * guarded destination under the bound Vault, an exclusive read-only file
 * written and fsynced before the rows commit, and a digest recomputed over the
 * written bytes so a torn placement never reaches adoption (SHR-004, SHR-005).
 */
export function placeMemoContentFile(
  vaultPath: string,
  memoId: string,
  recordId: string,
  bytes: Uint8Array,
): Result<{ storageKey: string; sizeBytes: number; sha256: string }, AppError> {
  const storageKey = `content/memo/${memoId}/${recordId}`;
  if (!isManagedContentStorageKey(storageKey)) {
    return err(appError("INTERNAL_ERROR", "The Memo content restore target is not a managed key", { storageKey }));
  }
  try {
    const destination = managedPath(vaultPath, storageKey, true);
    const identity = placeExclusive(destination, bytes, {
      createMode: 0o644,
      finalMode: 0o444,
      noFollow: true,
      fileFsync: true,
      syncAncestorsTo: managedRoot(vaultPath),
      verifyReadback: true,
      readback: () => digestManagedFile(vaultPath, storageKey),
      cleanupOwnedOnError: true,
    });
    return ok({ storageKey, ...identity });
  } catch {
    return err(appError("INTERNAL_ERROR", "The Memo content restore file could not be placed", { memoId }));
  }
}

/** Reads each file-backed reference's exact raw Vault bytes through managed-path guards; the export carries them as snapshot content files (SHR-010). */
export function readMemoContentFileBytes(
  vaultPath: string,
  references: MemoContentReference[],
): Result<Array<{ memoId: string; contentId: string; bytes: Uint8Array }>, AppError> {
  const carried: Array<{ memoId: string; contentId: string; bytes: Uint8Array }> = [];
  for (const reference of references) {
    if (!isManagedContentStorageKey(reference.storageKey)) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The Memo content reference for ${reference.memoId} is not a managed key.`,
          {
            memoId: reference.memoId,
          },
        ),
      );
    }
    try {
      const handle = openManagedFile(vaultPath, reference.storageKey);
      try {
        const stat = fstatSync(handle);
        if (stat.size !== reference.sizeBytes)
          return err(appError("VAULT_INTEGRITY_ERROR", "A Memo content file disagrees with its recorded size"));
        const buffer = Buffer.alloc(stat.size);
        let read = 0;
        while (read < stat.size) {
          const count = readSync(handle, buffer, read, stat.size - read, null);
          if (count === 0) break;
          read += count;
        }
        if (read !== stat.size) {
          return err(
            appError(
              "VAULT_INTEGRITY_ERROR",
              `The Memo content file for ${reference.memoId} changed while being read.`,
              {
                memoId: reference.memoId,
              },
            ),
          );
        }
        const digest = createHash("sha256").update(buffer).digest("hex");
        const after = fstatSync(handle);
        const extra = Buffer.alloc(1);
        if (
          digest !== reference.sha256 ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          readSync(handle, extra, 0, 1, null) !== 0 ||
          !isMemoContentBytes(buffer)
        ) {
          return err(
            appError(
              "VAULT_INTEGRITY_ERROR",
              `The Memo content file for ${reference.memoId} disagrees with its recorded digest.`,
              {
                memoId: reference.memoId,
              },
            ),
          );
        }
        carried.push({ memoId: reference.memoId, contentId: reference.contentId, bytes: buffer });
      } finally {
        closeSync(handle);
      }
    } catch {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The Memo content file for ${reference.memoId} could not be read.`, {
          memoId: reference.memoId,
        }),
      );
    }
  }
  return ok(carried);
}

/** Restores one exported Memo: a fresh independent content record carries its exact inline bytes (SHR-004, section 38.7). */
export function insertMemoWithInlineRecord(db: SorageSqlite, memo: Memo, recordId: string): void {
  const digest = createHash("sha256").update(Buffer.from(memo.body, "utf8")).digest("hex");
  const sizeBytes = Buffer.byteLength(memo.body, "utf8");
  db.prepare(
    `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
    VALUES (?, CAST(? AS TEXT), NULL, ?, ?, 1, ?)`,
  ).run(recordId, Buffer.from(memo.body, "utf8"), sizeBytes, digest, memo.createdAt);
  insertMemoSnapshotRow(db, {
    id: memo.id,
    projectId: memo.projectId,
    title: memo.title,
    body: memo.body,
    bodyRef: { recordId, sizeBytes, sha256: digest },
    state: memo.state,
    rowVersion: memo.rowVersion,
    createdAt: memo.createdAt,
    updatedAt: memo.updatedAt,
    createdBy: memo.createdBy,
    updatedBy: memo.updatedBy,
    closedAt: memo.closedAt,
    closedBy: memo.closedBy,
  });
}
