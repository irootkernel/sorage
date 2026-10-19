import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  appError,
  canonicalJsonLine,
  err,
  ok,
  parseMemoEventAssociation,
  memoObject,
  parseStoredMemoReceipt,
  serializeMemoReceiptForStorage,
  isManagedContentStorageKey,
  isMemoContentBytes,
  validateMemoBody,
  publicMemoOf,
  type AppError,
  type Memo,
  type MemoSnapshot,
  type MemoCandidateDescriptor,
  type MemoState,
  type Result,
  type MemoListCapture,
  type MemoReader,
  type MemoRepository,
  type MemoRunOptions,
  type MemoTransaction,
  type StoredMemoReceiptLookup,
  type SnapshotMemoV3,
} from "@sorage/core";
import { fsyncDirectory, isSafeVaultRelativePath, liveFencePaused } from "./intent-log";
import { digestManagedFile, managedPath, managedRoot, openManagedFile } from "./managed-paths";
import type { SqliteContentStore } from "./content-store";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The schema-10 SQLite Memo repository (SHR-004, MEM-009, ADR-0032): reads
 * carry metadata plus immutable record references with the inline text present
 * only for inline records; the write transaction commits the domain rows, the
 * content record, any activation intent, the event, and the receipt atomically
 * behind the move fence and the optional connection-local external-commit
 * guard; list capture runs one bounded metadata batch per short read
 * transaction with SQL-side match flags; and receipts store in the dual
 * historical forms of SHR-008 — verbatim embedded inline bodies and immutable
 * record references — with neither ever rewritten.
 */

export interface MemoRepositoryOptions {
  /** The shared content store whose in-transaction primitives carry the content plans. */
  contentStore: SqliteContentStore;
}

interface MemoRow {
  id: string;
  project_id: string;
  title: string;
  content_record_id: string;
  state: MemoState;
  row_version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  closed_at: string | null;
  closed_by: string | null;
}

interface ContentJoinRow extends MemoRow {
  record_id: string;
  inline_text: string | null;
  storage_key: string | null;
  size_bytes: number;
  sha256: string;
  materialized: number;
}

function userOf(raw: string): { kind: "user"; id: null } {
  const parsed: unknown = JSON.parse(raw);
  if (!memoObject(parsed, ["kind", "id"]) || parsed.kind !== "user" || parsed.id !== null)
    throw new Error("Stored Memo actor violates its contract");
  return parsed as { kind: "user"; id: null };
}

function snapshotFromRow(row: ContentJoinRow): MemoSnapshot {
  if (row.inline_text !== null && row.storage_key === null) {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      body: row.inline_text,
      bodyRef: { recordId: row.content_record_id, sizeBytes: Number(row.size_bytes), sha256: row.sha256 },
      state: row.state,
      rowVersion: Number(row.row_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: userOf(row.created_by),
      updatedBy: userOf(row.updated_by),
      closedAt: row.closed_at,
      closedBy: row.closed_by === null ? null : userOf(row.closed_by),
    };
  }
  if (row.inline_text === null && row.storage_key !== null) {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      body: null,
      bodyRef: { recordId: row.content_record_id, sizeBytes: Number(row.size_bytes), sha256: row.sha256 },
      state: row.state,
      rowVersion: Number(row.row_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: userOf(row.created_by),
      updatedBy: userOf(row.updated_by),
      closedAt: row.closed_at,
      closedBy: row.closed_by === null ? null : userOf(row.closed_by),
    };
  }
  throw new Error(`Content record ${row.content_record_id} violates the XOR representation`);
}

const MEMO_SELECT = `SELECT m.id AS id, m.project_id AS project_id, m.title AS title, m.content_record_id AS content_record_id,
  m.state AS state, m.row_version AS row_version, m.created_at AS created_at, m.updated_at AS updated_at,
  m.created_by AS created_by, m.updated_by AS updated_by, m.closed_at AS closed_at, m.closed_by AS closed_by,
  c.id AS record_id, c.inline_text AS inline_text, c.storage_key AS storage_key, c.size_bytes AS size_bytes, c.sha256 AS sha256, c.materialized AS materialized
  FROM project_memos m LEFT JOIN content_records c ON c.id = m.content_record_id`;

function databaseResult<T>(work: () => Result<T>): Result<T> {
  try {
    return work();
  } catch {
    // A fixed body-free diagnostic: exception text and any payload it carries
    // never ride the public error (the malformed-receipt syntax path carries
    // its own fixed integrity refusal above).
    return err(appError("INTERNAL_ERROR", "Accessing Memo storage failed"));
  }
}

/** A LEFT JOIN row whose required record is missing is an honest integrity failure, never a silent absence (SHR-004). */
function requireJoinedRecord(row: ContentJoinRow): Result<ContentJoinRow> {
  if (row.record_id === null || row.record_id === undefined) {
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        `The Memo ${row.id} references content record ${row.content_record_id}, which is missing`,
        { memoId: row.id, contentRecordId: row.content_record_id },
      ),
    );
  }
  return ok(row);
}

function externalVersion(db: SorageSqlite): number {
  const row = db.prepare("PRAGMA data_version").get() as { data_version: number } | null | undefined;
  return Number(row?.data_version ?? 0);
}

function coherenceMarker(): Result<never> {
  return err(
    appError("SERVICE_PAUSED", "External database state changed during this write; the attempt rolled back", {
      coherenceMismatch: true,
    }),
  );
}

export function createSqliteMemoRepository(db: SorageSqlite, options: MemoRepositoryOptions): MemoRepository {
  const store = options.contentStore;

  const getSnapshot = (id: string): Result<MemoSnapshot | null> =>
    databaseResult(() => {
      const row = db.prepare(`${MEMO_SELECT} WHERE m.id = ?`).get(id) as ContentJoinRow | undefined;
      if (!row) return ok(null);
      const joined = requireJoinedRecord(row);
      if (!joined.ok) return joined;
      if (joined.value.inline_text !== null) {
        // This path is bounded by the fixed inline threshold and performs no
        // filesystem I/O, including when called inside a write transaction.
        const verified = store.openBody(joined.value.record_id, { verifyFileDigest: "always" });
        if (!verified.ok) return verified;
        verified.value.close();
      }
      return ok(snapshotFromRow(joined.value));
    });

  const receiptLookup = (key: string, scope: string, now: string): Result<StoredMemoReceiptLookup | null> =>
    databaseResult(() => {
      const row = db
        .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key=? AND scope=? AND expires_at > ?")
        .get(key, scope, now) as { request_hash: string; response_json: string } | undefined;
      if (!row) return ok(null);
      let value: unknown;
      try {
        value = JSON.parse(row.response_json);
      } catch {
        // Malformed stored syntax is a fixed body-free integrity refusal: the
        // raw payload and the parser's exception text never ride the error,
        // and the refusal is never absence (SHR-008, ADR-0032 plan).
        return err(
          appError("STORAGE_INTEGRITY_ERROR", `A stored Memo receipt under scope ${scope} is not valid JSON.`, {
            scope,
          }),
        );
      }
      const parsed = parseStoredMemoReceipt(value);
      if (!parsed.ok) return parsed;
      return ok({ requestHash: row.request_hash, memo: parsed.value.memo, changed: parsed.value.changed });
    });

  const transaction: MemoTransaction = {
    get: getSnapshot,
    receipt: receiptLookup,
    projectStatus: (id) =>
      databaseResult(() => {
        const row = db.prepare("SELECT status FROM projects WHERE id = ?").get(id) as
          | { status: "active" | "archived" }
          | undefined;
        return ok(row?.status ?? null);
      }),
    commitContent: (plan, ownerMemoId, createdAt) =>
      databaseResult(() => {
        if (plan.kind === "keep") return ok(undefined);
        if (plan.kind === "inline") {
          store.insertContentRecord({
            id: plan.contentId,
            inlineText: plan.text,
            storageKey: null,
            sizeBytes: plan.sizeBytes,
            sha256: plan.sha256,
            materialized: true,
            createdAt,
          });
          return ok(undefined);
        }
        if (!isSafeVaultRelativePath(plan.stagedPath) || !isManagedContentStorageKey(plan.storageKey)) {
          return err(appError("INTERNAL_ERROR", "A file content plan carries an unsafe path"));
        }
        store.insertContentRecord({
          id: plan.contentId,
          inlineText: null,
          storageKey: plan.storageKey,
          sizeBytes: plan.sizeBytes,
          sha256: plan.sha256,
          materialized: false,
          createdAt,
        });
        store.insertCommonIntent({
          id: plan.intentId,
          op: "activate",
          fromPath: plan.stagedPath,
          toPath: plan.storageKey,
          owner: { domain: "memo", ownerId: ownerMemoId },
          contentId: plan.contentId,
          createdAt,
        });
        return ok(undefined);
      }),
    insertMemo: (memo) =>
      databaseResult(() => {
        insertMemoSnapshotRow(db, memo);
        return ok(undefined);
      }),
    compareAndSetMemo: (memo, expectedRowVersion) =>
      databaseResult(() => {
        if (memo.rowVersion !== expectedRowVersion + 1)
          return err(appError("MEMO_INVALID_INPUT", "A Memo write must advance its expected version once"));
        const changed = db
          // Preserved legacy and restored actor JSON may use different key order
          // or trailing whitespace. Immutable User identity is semantic, never
          // equality against a newly serialized JSON string.
          .prepare(`UPDATE project_memos SET title=?, content_record_id=?, state=?, row_version=?, updated_at=?,
          updated_by=?, closed_at=?, closed_by=? WHERE id=? AND project_id=? AND created_at=?
          AND json_extract(created_by, '$.kind')=? AND json_type(created_by, '$.id')='null' AND row_version=?`)
          .run(
            memo.title,
            memo.bodyRef.recordId,
            memo.state,
            memo.rowVersion,
            memo.updatedAt,
            canonicalJsonLine(memo.updatedBy),
            memo.closedAt,
            memo.closedBy === null ? null : canonicalJsonLine(memo.closedBy),
            memo.id,
            memo.projectId,
            memo.createdAt,
            memo.createdBy.kind,
            expectedRowVersion,
          ) as { changes: number };
        return changed.changes === 1
          ? ok(undefined)
          : err(appError("ROW_VERSION_CONFLICT", "Memo changed since the observed Row Version"));
      }),
    appendEvent: (id, event) =>
      databaseResult(() => {
        const owner = getSnapshot(event.memoId);
        if (!owner.ok) return owner;
        if (!owner.value) return err(appError("MEMO_NOT_FOUND", "Memo event owner does not exist"));
        const checked = parseMemoEventAssociation(
          {
            id,
            handoffId: null,
            memoId: event.memoId,
            eventType: event.eventType,
            actorKind: event.actor.kind,
            actorId: event.actor.id,
            rowVersion: event.rowVersion,
            metadata: event.metadata,
            createdAt: event.createdAt,
          },
          2,
          new Map([[owner.value.id, snapshotToPublicForAssociation(owner.value)]]),
        );
        if (!checked.ok) return checked;
        db.prepare(`INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
        VALUES (?, NULL, ?, ?, 'user', NULL, ?, ?, ?)`).run(
          id,
          event.memoId,
          event.eventType,
          event.rowVersion,
          JSON.stringify(event.metadata),
          event.createdAt,
        );
        return ok(undefined);
      }),
    storeReceipt: (key, scope, hash, receipt, createdAt, expiresAt) =>
      databaseResult(() => {
        // Reuse only this expired Memo key; no global cleanup or Handoff receipt mutation.
        db.prepare("DELETE FROM idempotency_keys WHERE key=? AND scope=? AND expires_at <= ?").run(
          key,
          scope,
          createdAt,
        );
        db.prepare(
          "INSERT INTO idempotency_keys (key,scope,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,?,?)",
        ).run(key, scope, hash, serializeMemoReceiptForStorage(receipt), createdAt, expiresAt);
        return ok(undefined);
      }),
  };

  function inTransaction<T>(begin: string, work: () => Result<T>, options?: MemoRunOptions): Result<T> {
    return databaseResult(() => {
      db.exec(begin);
      try {
        if (liveFencePaused(db)) {
          db.exec("ROLLBACK");
          return err(appError("SERVICE_PAUSED", "A Vault move or restore is in progress"));
        }
        if (options?.expectedExternalVersion !== undefined && begin === "BEGIN IMMEDIATE") {
          if (externalVersion(db) !== options.expectedExternalVersion) {
            db.exec("ROLLBACK");
            return coherenceMarker();
          }
        }
        const result = work();
        db.exec(result.ok ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  return {
    get: getSnapshot,
    captureListBatch: (filter, after, batchSize) =>
      databaseResult(() => {
        db.exec("BEGIN");
        try {
          const where: string[] = [];
          const params: unknown[] = [];
          if ("projectId" in filter.scope) {
            const exists = db.prepare("SELECT id FROM projects WHERE id = ?").get(filter.scope.projectId);
            if (!exists) {
              db.exec("COMMIT");
              return err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
            }
            where.push("m.project_id = ?");
            params.push(filter.scope.projectId);
          }
          if (filter.state !== "all") {
            where.push("m.state = ?");
            params.push(filter.state);
          }
          if (after) {
            where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
            params.push(after.createdAt, after.createdAt, after.id);
          }
          const query = filter.query;
          const titleMatch = query === "" ? "0" : "instr(m.title, ?) > 0";
          const inlineMatch =
            query === "" ? "0" : "CASE WHEN c.inline_text IS NOT NULL THEN instr(c.inline_text, ?) > 0 ELSE 0 END";
          const previewSeed = "CASE WHEN c.inline_text IS NOT NULL THEN substr(c.inline_text, 1, 512) ELSE NULL END";
          const rows = db
            .prepare(
              `SELECT m.id AS id, m.project_id AS project_id, m.title AS title, m.state AS state,
              m.row_version AS row_version, m.created_at AS created_at, m.updated_at AS updated_at, m.closed_at AS closed_at,
              CASE WHEN c.inline_text IS NOT NULL THEN 'inline' ELSE 'file' END AS representation,
              c.id AS record_id, c.size_bytes AS size_bytes, c.sha256 AS sha256,
              ${titleMatch} AS title_match, ${inlineMatch} AS inline_match, ${previewSeed} AS preview_seed,
              p.slug AS slug, p.display_name AS display_name, p.status AS status
              FROM project_memos m LEFT JOIN content_records c ON c.id = m.content_record_id JOIN projects p ON p.id = m.project_id
              ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
              ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
            )
            .all(...(query === "" ? [] : [query, query]), ...params, batchSize) as unknown as Array<{
            id: string;
            project_id: string;
            title: string;
            state: MemoState;
            row_version: number;
            created_at: string;
            updated_at: string;
            closed_at: string | null;
            representation: "inline" | "file";
            record_id: string | null;
            size_bytes: number | null;
            sha256: string | null;
            title_match: number;
            inline_match: number;
            preview_seed: string | null;
            slug: string;
            display_name: string;
            status: "active" | "archived";
          }>;
          db.exec("COMMIT");
          // A captured row whose required record is missing is an honest
          // whole-page integrity failure — a LEFT JOIN must never let a
          // dangling Memo disappear from the page (SHR-004).
          const dangling = rows.find((row) => row.record_id === null || row.record_id === undefined);
          if (dangling !== undefined) {
            return err(
              appError(
                "STORAGE_INTEGRITY_ERROR",
                `The Memo ${dangling.id} references a missing content record; the page could not be assembled`,
                { memoId: dangling.id },
              ),
            );
          }
          const descriptors: MemoCandidateDescriptor[] = rows.map((row) => ({
            id: row.id,
            projectId: row.project_id,
            createdAt: row.created_at,
            title: row.title,
            state: row.state,
            rowVersion: Number(row.row_version),
            updatedAt: row.updated_at,
            closedAt: row.closed_at,
            representation: row.representation,
            recordId: row.record_id as string,
            sizeBytes: Number(row.size_bytes),
            sha256: row.sha256 as string,
            titleMatch: row.title_match === 1,
            inlineMatch: row.inline_match === 1,
            previewSeed: row.preview_seed,
            project: { slug: row.slug, displayName: row.display_name, status: row.status },
          }));
          const last = rows[rows.length - 1];
          const capture: MemoListCapture = {
            descriptors,
            exhausted: rows.length < batchSize,
            lastSortKey: last ? { createdAt: last.created_at, id: last.id } : null,
          };
          return ok(capture);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
    run: (work, options) => inTransaction("BEGIN IMMEDIATE", () => work(transaction), options),
    inspect: (work) =>
      inTransaction("BEGIN", () =>
        work({ get: getSnapshot, projectStatus: transaction.projectStatus, receipt: receiptLookup }),
      ),
  };
}

/** The appendEvent association validator expects the public detail shape; a file-backed body is complete metadata. */
function snapshotToPublicForAssociation(snapshot: MemoSnapshot): Memo {
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    title: snapshot.title,
    body: snapshot.body ?? "",
    state: snapshot.state,
    rowVersion: snapshot.rowVersion,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    createdBy: snapshot.createdBy,
    updatedBy: snapshot.updatedBy,
    closedAt: snapshot.closedAt,
    closedBy: snapshot.closedBy,
  };
}

/** Inserts one Memo row with its record reference; throws so the caller's transaction aborts. */
export function insertMemoSnapshotRow(db: SorageSqlite, memo: MemoSnapshot): void {
  db.prepare(`INSERT INTO project_memos
    (id, project_id, title, content_record_id, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    memo.id,
    memo.projectId,
    memo.title,
    memo.bodyRef.recordId,
    memo.state,
    memo.rowVersion,
    memo.createdAt,
    memo.updatedAt,
    canonicalJsonLine(memo.createdBy),
    canonicalJsonLine(memo.updatedBy),
    memo.closedAt,
    memo.closedBy === null ? null : canonicalJsonLine(memo.closedBy),
  );
}

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

/** The public metadata projection of a snapshot row, body excluded. */
function snapshotMetaOf(snapshot: MemoSnapshot): Omit<Memo, "body"> {
  const { body: _body, bodyRef: _reference, ...meta } = snapshot;
  return meta;
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
  let destination: string | undefined;
  let owned = false;
  try {
    destination = managedPath(vaultPath, storageKey, true);
    const handle = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    owned = true;
    try {
      let written = 0;
      const buffer = Buffer.from(bytes);
      while (written < buffer.byteLength) {
        written += writeSync(handle, buffer, written, buffer.byteLength - written, null);
      }
      fchmodSync(handle, 0o444);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    // Persist the entry and its ancestors before any SQL row claims that this
    // file is materialized. The managed path already uses the canonical Vault.
    const root = managedRoot(vaultPath);
    for (let directory = dirname(destination); ; directory = dirname(directory)) {
      fsyncDirectory(directory);
      if (directory === root) break;
    }
    const identity = digestManagedFile(vaultPath, storageKey);
    const expectedDigest = createHash("sha256").update(bytes).digest("hex");
    if (identity.sizeBytes !== bytes.byteLength || identity.sha256 !== expectedDigest)
      throw new Error("The placed Memo body changed identity");
    return ok({ storageKey, ...identity });
  } catch {
    if (owned && destination !== undefined) {
      try {
        rmSync(destination, { force: true });
      } catch {
        /* Owned survivor remains unreachable. */
      }
    }
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
