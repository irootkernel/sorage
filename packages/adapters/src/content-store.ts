import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  type AppError,
  appError,
  buildContentStorageKey,
  type Clock,
  type CommonContentFailureReason,
  type ContentCleanupReport,
  type ContentOwnerDomain,
  type ContentRead,
  type ContentRecord,
  type ContentReferences,
  type ContentStore,
  type StagedContentFile,
  type StageContentRequest,
  SYSTEM_ACTOR,
  SystemClock,
  type WriteContentFileInput,
  type WriteContentOutcome,
  type WriteInlineInput,
  type WriteInlineOutcome,
  classifyTextRouting,
  commonContentFailureMetadata,
  commonContentSuccessMetadata,
  contentOwnerFromStorageKey,
  err,
  FETCH_CACHE_DIRECTORY,
  type IdGenerator,
  isManagedContentStorageKey,
  isUtf8ExactText,
  ok,
  type Result,
  sha256OfBytes,
  sha256OfText,
  UuidGenerator,
  validateContentRecord,
  CONTENT_INLINE_MAX_UTF8_BYTES,
  classifyContentIntentOwnership,
  contentIntentIntegrityError,
} from "@sorage/core";
import { createSqliteEventLedger, type SqliteEventLedger } from "./events";
import { fsyncDirectory, isSafeVaultRelativePath, liveFencePaused } from "./intent-log";
import { vaultMoveLockHeld } from "./lockfile";
import type { SorageSqlite } from "./sqlite/connection";
import { openVault } from "./vault";
import {
  managedPath,
  managedRoot,
  managedDirectory,
  managedFile,
  managedLstat,
  openManagedFile,
  UnsafeManagedPathError,
} from "./managed-paths";

/** One mebibyte: the fixed buffer that keeps every streaming copy memory bounded (NFR-005). */
const STREAM_BUFFER_BYTES = 1024 * 1024;

const READ_ONLY_MODE = 0o444;
const OWNER_ONLY_DIR = 0o700;

export interface SqliteContentStoreOptions {
  db: SorageSqlite;
  vaultPath: string;
  installationId: string;
  ids?: IdGenerator;
  clock?: Clock;
  /** When provided, a live vault-move.lock pauses every mutation with SERVICE_PAUSED (RUN-014, SHR-011). */
  runDir?: string;
  /** The ledger that carries the common physical-content events (SEC-012, section 10.1). */
  ledger?: SqliteEventLedger;
  /** Deterministic event ids and timestamps for tests. */
  eventIds?: () => string;
  now?: () => string;
  /** The `gitBackup.largeArtifactWarningBytes` disclosure threshold extended to shared content (SHR-011). */
  largeWarningBytes?: number;
}

/** The committed outcome of one common intent's filesystem assessment. */
export type CommonExecutionOutcome = { status: "done" } | { status: "failed"; reason: CommonContentFailureReason };

/** What the shared completion transaction observed. */
export type CommonCompletion =
  | { status: "completed" }
  | { status: "already-completed" }
  | { status: "failed"; reason: CommonContentFailureReason; attempt: number };

/** One common intent row as the completion transaction re-reads it. */
export interface CommonIntentRow {
  id: string;
  op: "activate" | "unlink";
  fromPath: string | null;
  toPath: string;
  ownerDomain: ContentOwnerDomain;
  ownerId: string;
  contentId: string;
  attempts: number;
}

/** The concrete store beyond the core port: in-transaction primitives a domain composition composes. */
export interface SqliteContentStore extends ContentStore {
  /** Inserts one content record inside the caller's open transaction; throws so that transaction aborts. */
  insertContentRecord(record: ContentRecord): void;
  /** Inserts one common intent inside the caller's open transaction; throws so that transaction aborts. */
  insertCommonIntent(intent: {
    id: string;
    op: "activate" | "unlink";
    fromPath: string | null;
    toPath: string;
    owner: { domain: ContentOwnerDomain; ownerId: string };
    contentId: string;
    createdAt: string;
  }): void;
  /** The shared completion transaction the ordinary path and the start-up drain both use. */
  completeCommonIntent(intentId: string, outcome: CommonExecutionOutcome): Result<CommonCompletion, AppError>;
  /** Reads one record row; null when no such record exists. */
  readRecord(recordId: string): Result<ContentRecord | null, AppError>;
  /** Lists every record row, the cleanup and census read. */
  listRecords(): Result<ContentRecord[], AppError>;
}

interface ContentRow {
  id: string;
  inline_text: string | null;
  storage_key: string | null;
  size_bytes: number;
  sha256: string;
  materialized: number;
  created_at: string;
}

interface PendingRow {
  id: string;
  op: string;
  from_path: string | null;
  to_path: string;
  artifact_id: string | null;
  owner_domain: string | null;
  owner_id: string | null;
  content_id: string | null;
  created_at: string;
  attempts: number;
}

/**
 * The SQLite and filesystem content store behind the core port (SHR-001 to
 * SHR-006, SHR-008, SHR-011, section 38.1): file-backed writes stage outside
 * the transaction, commit the record and its activation intent in one
 * `BEGIN IMMEDIATE` transaction with the vault-move fence read inside it,
 * activate on the filesystem, and complete through the one shared completion
 * transaction that clears the intent and appends the success event together;
 * a failed assessment retains the intent and appends its failure event
 * atomically. Inline content never creates files or physical events, and
 * reference-aware cleanup is the only deleter of records.
 */
export function createSqliteContentStore(options: SqliteContentStoreOptions): SqliteContentStore {
  const { db, vaultPath, installationId } = options;
  const ids = options.ids ?? new UuidGenerator();
  const clock = options.clock ?? new SystemClock();

  function pausedNow(): boolean {
    return options.runDir !== undefined && vaultMoveLockHeld(options.runDir);
  }

  function pauseError(): AppError {
    return appError(
      "SERVICE_PAUSED",
      "A Vault move or restore is in progress; this content mutation paused instead of racing it.",
      { lockPath: options.runDir === undefined ? undefined : join(options.runDir, "vault-move.lock") },
    );
  }

  /** Every mutation funnels through the move lock and the marker guard (RUN-014, VLT-019). */
  function guard(): Result<unknown, AppError> {
    if (pausedNow()) return err(pauseError());
    return openVault(vaultPath, installationId);
  }

  function toRecord(row: ContentRow): ContentRecord {
    return {
      id: row.id,
      inlineText: row.inline_text,
      storageKey: row.storage_key,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
      materialized: row.materialized === 1,
      createdAt: row.created_at,
    };
  }

  function readContentRow(recordId: string): ContentRow | null {
    const row = db.prepare("SELECT * FROM content_records WHERE id = ?").get(recordId) as ContentRow | null | undefined;
    return row ?? null;
  }

  const insertRecordSql = () =>
    db.prepare(
      // Binding a JS string through the pinned native Bun engine can strip a
      // leading BOM. Bind UTF-8 bytes and cast in SQLite to preserve exact TEXT.
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, ?)",
    );

  const insertIntentSql = () =>
    db.prepare(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)",
    );

  return {
    write(input) {
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      const tooLarge = input.tooLargeCode ?? "ARTIFACT_TOO_LARGE";
      const bytes = input.body.kind === "text" ? Buffer.from(input.body.text, "utf8") : Buffer.from(input.body.bytes);
      if (bytes.byteLength > input.maxBytes) {
        return err(
          appError(
            tooLarge,
            `The accepted body crossed the shared bound artifact.maxBytes ${String(input.maxBytes)} bytes.`,
            { maxBytes: input.maxBytes, sizeBytes: bytes.byteLength },
          ),
        );
      }
      if (input.body.kind === "text") {
        if (!isUtf8ExactText(input.body.text)) {
          return err(
            appError(
              "INTERNAL_ERROR",
              "The accepted text cannot be stored byte-exactly; reject it at the surface before it reaches the shared store.",
            ),
          );
        }
        const routing = classifyTextRouting(input.body.text);
        if (routing.kind === "inline") {
          const written = this.writeInline({
            contentId: ids.next(),
            text: input.body.text,
            createdAt: input.createdAt,
          });
          if (!written.ok) return written;
          return ok({
            recordId: written.value.recordId,
            representation: "inline",
            storageKey: null,
            sizeBytes: written.value.sizeBytes,
            sha256: written.value.sha256,
            largeContentWarning: false,
          });
        }
      }
      // Binary bodies and oversized text both route to the Vault; the text's
      // exact UTF-8 bytes are the accepted bytes (SHR-002, SHR-003).
      const staged = stageBytes(bytes, input.maxBytes, tooLarge);
      if (!staged.ok) return staged;
      const written = this.writeFile({
        owner: input.owner,
        contentId: ids.next(),
        staged: staged.value,
        createdAt: input.createdAt,
        intentId: ids.next(),
      });
      if (!written.ok) return written;
      return ok(written.value);
    },

    stage(request: StageContentRequest): Result<StagedContentFile, AppError> {
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      let sourceStat: ReturnType<typeof statSync>;
      try {
        sourceStat = statSync(request.sourcePath);
      } catch (error) {
        return err(unreadableSource(request.sourcePath, error));
      }
      if (!sourceStat.isFile()) {
        return err(
          appError(
            "INTERNAL_ERROR",
            `The source is not a regular file and cannot be imported: ${request.sourcePath}.`,
            {
              sourcePath: request.sourcePath,
            },
          ),
        );
      }
      if (sourceStat.size > request.maxBytes) {
        return err(
          appError(
            request.tooLargeCode ?? "ARTIFACT_TOO_LARGE",
            `The source ${request.sourcePath} exceeds the shared bound artifact.maxBytes ${String(request.maxBytes)} bytes.`,
            { sourcePath: request.sourcePath, maxBytes: request.maxBytes },
          ),
        );
      }
      let stagingPath = join(vaultPath, "staging", ids.next());
      let source: number | undefined;
      let staged: number | undefined;
      try {
        if (pausedNow()) return err(pauseError());
        try {
          source = openSync(request.sourcePath, "r");
        } catch (error) {
          return err(unreadableSource(request.sourcePath, error));
        }
        try {
          stagingPath = managedPath(vaultPath, relative(vaultPath, stagingPath));
          staged = openSync(
            stagingPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          );
        } catch (error) {
          return err(
            appError("INTERNAL_ERROR", `Writing the staged content copy ${stagingPath} failed: ${messageOf(error)}.`, {
              stagingPath,
              cause: String(error),
            }),
          );
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
        let total = 0;
        for (;;) {
          const read = readSync(source, buffer, 0, buffer.length, null);
          if (read === 0) break;
          if (total + read > request.maxBytes) {
            closeSync(source);
            closeSync(staged);
            source = undefined;
            staged = undefined;
            try {
              const safeStagingPath = managedFile(vaultPath, relative(managedRoot(vaultPath), stagingPath));
              if (safeStagingPath.stat !== undefined) unlinkSync(safeStagingPath.path);
            } catch {
              // The staging sweep after the grace window removes any survivor.
            }
            return err(
              appError(
                request.tooLargeCode ?? "ARTIFACT_TOO_LARGE",
                `The source ${request.sourcePath} crossed artifact.maxBytes ${String(request.maxBytes)} mid-stream.`,
                { sourcePath: request.sourcePath, maxBytes: request.maxBytes, readSoFar: total + read },
              ),
            );
          }
          hash.update(buffer.subarray(0, read));
          try {
            let written = 0;
            while (written < read) {
              const count = writeSync(staged, buffer, written, read - written);
              if (count <= 0) throw new Error(`The staged write made no progress after ${written} of ${read} bytes.`);
              written += count;
            }
          } catch (error) {
            return err(
              appError(
                "INTERNAL_ERROR",
                `Writing the staged content copy ${stagingPath} failed: ${messageOf(error)}.`,
                {
                  stagingPath,
                  cause: String(error),
                },
              ),
            );
          }
          total += read;
        }
        try {
          fsyncSync(staged);
        } catch (error) {
          return err(
            appError("INTERNAL_ERROR", `Writing the staged content copy ${stagingPath} failed: ${messageOf(error)}.`, {
              stagingPath,
              cause: String(error),
            }),
          );
        }
        closeSync(source);
        closeSync(staged);
        source = undefined;
        staged = undefined;
        return ok({ stagingPath, sizeBytes: total, sha256: hash.digest("hex") });
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Staging ${request.sourcePath} failed unexpectedly: ${messageOf(error)}.`, {
            sourcePath: request.sourcePath,
            stagingPath,
            cause: String(error),
          }),
        );
      } finally {
        if (source !== undefined) {
          try {
            closeSync(source);
          } catch {
            // Best effort: the descriptor closes with the process on abort paths.
          }
        }
        if (staged !== undefined) {
          try {
            closeSync(staged);
          } catch {
            // Best effort, as above.
          }
        }
      }
    },

    writeFile(input: WriteContentFileInput): Result<WriteContentOutcome, AppError> {
      if (
        classifyContentIntentOwnership({
          id: input.intentId,
          artifactId: null,
          ownerDomain: input.owner.domain,
          ownerId: input.owner.ownerId,
          contentId: input.contentId,
        }) !== "common"
      ) {
        return err(appError("INTERNAL_ERROR", "A common content write requires complete UUID ownership."));
      }
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      const key = buildContentStorageKey({
        domain: input.owner.domain,
        ownerId: input.owner.ownerId,
        contentId: input.contentId,
      });
      if (!key.ok) return key;
      const record: ContentRecord = {
        id: input.contentId,
        inlineText: null,
        storageKey: key.value,
        sizeBytes: input.staged.sizeBytes,
        sha256: input.staged.sha256,
        materialized: false,
        createdAt: input.createdAt,
      };
      const valid = validateContentRecord(record);
      if (!valid.ok) return valid;
      const stagingRelative = relative(managedRoot(vaultPath), input.staged.stagingPath);
      if (pausedNow()) return err(pauseError());
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const paused = liveFencePaused(db);
          if (paused) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; the content commit paused instead of racing it.",
                { moveFencePid: paused.pid },
              ),
            );
          }
          insertRecordSql().run(
            record.id,
            record.inlineText === null ? null : Buffer.from(record.inlineText, "utf8"),
            record.storageKey,
            record.sizeBytes,
            record.sha256,
            record.materialized ? 1 : 0,
            record.createdAt,
          );
          insertIntentSql().run(
            input.intentId,
            "activate",
            stagingRelative,
            key.value,
            input.owner.domain,
            input.owner.ownerId,
            input.contentId,
            input.createdAt,
          );
          db.exec("COMMIT");
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
          appError("INTERNAL_ERROR", `Committing the content record failed: ${messageOf(error)}.`, {
            contentId: input.contentId,
            cause: String(error),
          }),
        );
      }
      // The filesystem arm runs after the commit: activate, then complete
      // through the shared transaction that clears the intent and appends
      // CONTENT_ACTIVATED, or record the failed assessment durably.
      const outcome = activateCommonFile({
        vaultPath,
        fromPath: stagingRelative,
        toPath: key.value,
        expect: { sizeBytes: input.staged.sizeBytes, sha256: input.staged.sha256 },
      });
      const completion = this.completeCommonIntent(input.intentId, outcome);
      if (!completion.ok) return err(completion.error);
      return ok({
        recordId: input.contentId,
        representation: "file",
        storageKey: key.value,
        sizeBytes: input.staged.sizeBytes,
        sha256: input.staged.sha256,
        activated: completion.value.status === "failed" ? "failed-assessment" : "completed",
        ...(completion.value.status === "failed" ? { failureReason: completion.value.reason } : {}),
        largeContentWarning:
          options.largeWarningBytes !== undefined && input.staged.sizeBytes > options.largeWarningBytes,
      });
    },

    writeInline(input: WriteInlineInput): Result<WriteInlineOutcome, AppError> {
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      if (!isUtf8ExactText(input.text)) {
        return err(
          appError(
            "INTERNAL_ERROR",
            "Inline content must be byte-exact text; reject a body with unpaired surrogates at the surface.",
          ),
        );
      }
      const sizeBytes = Buffer.byteLength(input.text, "utf8");
      if (sizeBytes > CONTENT_INLINE_MAX_UTF8_BYTES) {
        return err(
          appError(
            "INTERNAL_ERROR",
            `Inline content exceeds the routing threshold of ${String(CONTENT_INLINE_MAX_UTF8_BYTES)} bytes; route the body through the application boundary.`,
          ),
        );
      }
      const record: ContentRecord = {
        id: input.contentId,
        inlineText: input.text,
        storageKey: null,
        sizeBytes,
        sha256: sha256OfText(input.text),
        materialized: true,
        createdAt: input.createdAt,
      };
      const valid = validateContentRecord(record);
      if (!valid.ok) return valid;
      if (pausedNow()) return err(pauseError());
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const paused = liveFencePaused(db);
          if (paused) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; the content commit paused instead of racing it.",
                { moveFencePid: paused.pid },
              ),
            );
          }
          insertRecordSql().run(
            record.id,
            Buffer.from(input.text, "utf8"),
            record.storageKey,
            record.sizeBytes,
            record.sha256,
            1,
            record.createdAt,
          );
          db.exec("COMMIT");
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
          appError("INTERNAL_ERROR", `Committing the inline content record failed: ${messageOf(error)}.`, {
            contentId: input.contentId,
            cause: String(error),
          }),
        );
      }
      return ok({ recordId: record.id, sizeBytes, sha256: record.sha256 });
    },

    read(recordId: string): Result<ContentRead, AppError> {
      const row = readContentRow(recordId);
      if (row === null) {
        return err(appError("CONTENT_CORRUPTED", "The referenced content record is missing.", { recordId }));
      }
      const valid = validateContentRecord(toRecord(row));
      if (!valid.ok) {
        return err(appError("CONTENT_CORRUPTED", "The stored content representation is invalid.", { recordId }));
      }
      const sizeBytes = Number(row.size_bytes);
      if (row.inline_text !== null) {
        const bytes = Buffer.from(row.inline_text, "utf8");
        if (bytes.byteLength !== sizeBytes || sha256OfBytes(bytes) !== row.sha256) {
          return err(
            appError("CONTENT_CORRUPTED", "The inline bytes do not match their recorded size and SHA-256.", {
              recordId,
            }),
          );
        }
        return ok({
          recordId: row.id,
          kind: "inline",
          bytes,
          sizeBytes,
          sha256: row.sha256,
          materialized: true,
        });
      }
      const key = row.storage_key as string;
      if (row.materialized !== 1) {
        return err(
          appError("CONTENT_MATERIALIZING", "The content has not reached its storage key yet.", {
            recordId,
            storageKey: key,
          }),
        );
      }
      // The generic record validator admits both managed content/ and existing
      // artifacts/ keys. Physical common-intent ownership remains Memo/Channel-only.
      const bytesResult = readFileBounded(vaultPath, key, sizeBytes);
      if (!bytesResult.ok) return bytesResult;
      // Verify the exact buffer returned to the caller, rather than hash one
      // open and then return bytes from a separate, potentially changed open.
      if (sha256OfBytes(bytesResult.value) !== row.sha256) {
        return err(
          appError("CONTENT_CORRUPTED", "The content bytes do not match their recorded SHA-256.", {
            recordId,
            storageKey: key,
          }),
        );
      }
      return ok({
        recordId: row.id,
        kind: "file",
        bytes: bytesResult.value,
        sizeBytes,
        sha256: row.sha256,
        materialized: true,
      });
    },

    cleanup(references: ContentReferences, now: Date): Result<ContentCleanupReport, AppError> {
      if (pausedNow()) return err(pauseError());
      const report: ContentCleanupReport = { removedInlineIds: [], scheduledUnlinkIds: [] };
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const paused = liveFencePaused(db);
          if (paused) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; the cleanup paused instead of racing it.",
                { moveFencePid: paused.pid },
              ),
            );
          }
          // Reference providers read inside the writer transaction, so the
          // reference snapshot and the deletions serialize on the write lock.
          const domainIds = references.domainReferencedRecordIds();
          if (!domainIds.ok) {
            db.exec("ROLLBACK");
            return domainIds;
          }
          const receiptIds = references.receiptReferencedRecordIds(now);
          if (!receiptIds.ok) {
            db.exec("ROLLBACK");
            return receiptIds;
          }
          const domain = new Set(domainIds.value);
          const receipts = new Set(receiptIds.value);
          // The temporary recovery-safety guard, read inside the same writer
          // transaction: a record whose activation intent is still pending is
          // preserved until that intent resolves, because deleting it first
          // would strand the retained staged file and destination as a
          // permanent missing_content failure for work the database still
          // promises. This is not permanent retention; once the activation
          // intent is cleared, the ordinary reference rule owns the record again.
          const pendingActivations = new Set(
            (
              db
                .prepare(
                  "SELECT DISTINCT content_id FROM pending_fs_ops WHERE op = 'activate' AND content_id IS NOT NULL",
                )
                .all() as unknown as Array<{ content_id: string }>
            ).map((row) => row.content_id),
          );
          const rows = db.prepare("SELECT * FROM content_records ORDER BY id").all() as unknown as ContentRow[];
          for (const row of rows) {
            if (domain.has(row.id) || receipts.has(row.id) || pendingActivations.has(row.id)) continue;
            if (row.inline_text !== null) {
              // Inline bodies are removed by the reference rule alone: no file,
              // no intent, and no physical event (SHR-004).
              db.prepare("DELETE FROM content_records WHERE id = ?").run(row.id);
              report.removedInlineIds.push(row.id);
              continue;
            }
            const key = row.storage_key as string;
            const owner = contentOwnerFromStorageKey({ id: row.id, storageKey: key });
            if (!owner.ok) {
              db.exec("ROLLBACK");
              return owner;
            }
            // The unlink intent retains the owner triple before the record row
            // can disappear, so the drain always knows what it is completing.
            insertIntentSql().run(
              randomUUID(),
              "unlink",
              null,
              key,
              owner.value.domain,
              owner.value.ownerId,
              row.id,
              clock.now().toISOString(),
            );
            db.prepare("DELETE FROM content_records WHERE id = ?").run(row.id);
            report.scheduledUnlinkIds.push(row.id);
          }
          db.exec("COMMIT");
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
          appError("INTERNAL_ERROR", `Reference-aware content cleanup failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
      return ok(report);
    },

    insertContentRecord(record: ContentRecord): void {
      const valid = validateContentRecord(record);
      if (!valid.ok) throw new Error(valid.error.message);
      insertRecordSql().run(
        record.id,
        record.inlineText === null ? null : Buffer.from(record.inlineText, "utf8"),
        record.storageKey,
        record.sizeBytes,
        record.sha256,
        record.materialized ? 1 : 0,
        record.createdAt,
      );
    },

    insertCommonIntent(intent: {
      id: string;
      op: "activate" | "unlink";
      fromPath: string | null;
      toPath: string;
      owner: { domain: ContentOwnerDomain; ownerId: string };
      contentId: string;
      createdAt: string;
    }): void {
      if (
        classifyContentIntentOwnership({
          id: intent.id,
          artifactId: null,
          ownerDomain: intent.owner.domain,
          ownerId: intent.owner.ownerId,
          contentId: intent.contentId,
        }) !== "common"
      ) {
        throw new Error("A common intent requires complete UUID ownership");
      }
      if (
        !isSafeVaultRelativePath(intent.toPath) ||
        (intent.fromPath !== null && !isSafeVaultRelativePath(intent.fromPath))
      ) {
        throw new Error(`the common intent toPath is not a safe Vault-relative path: ${intent.toPath}`);
      }
      insertIntentSql().run(
        intent.id,
        intent.op,
        intent.fromPath,
        intent.toPath,
        intent.owner.domain,
        intent.owner.ownerId,
        intent.contentId,
        intent.createdAt,
      );
    },

    completeCommonIntent(intentId: string, outcome: CommonExecutionOutcome): Result<CommonCompletion, AppError> {
      const ledger = options.ledger ?? createSqliteEventLedger(db);
      return completeCommonIntentTx(db, ledger, intentId, outcome, {
        eventIds: options.eventIds,
        now: options.now,
      });
    },

    readRecord(recordId: string): Result<ContentRecord | null, AppError> {
      try {
        const row = readContentRow(recordId);
        return ok(row === null ? null : toRecord(row));
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the content record failed: ${messageOf(error)}.`, {
            recordId,
            cause: String(error),
          }),
        );
      }
    },

    listRecords(): Result<ContentRecord[], AppError> {
      try {
        const rows = db.prepare("SELECT * FROM content_records ORDER BY id").all() as unknown as ContentRow[];
        return ok(rows.map(toRecord));
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the content records failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };

  /** Stages exact in-memory bytes with the same-pass hash and mid-stream bound enforcement. */
  function stageBytes(
    bytes: Buffer,
    maxBytes: number,
    tooLarge: NonNullable<StageContentRequest["tooLargeCode"]>,
  ): Result<StagedContentFile, AppError> {
    if (bytes.byteLength > maxBytes) {
      return err(
        appError(tooLarge, `The accepted body crossed the shared bound artifact.maxBytes ${String(maxBytes)} bytes.`, {
          maxBytes,
          sizeBytes: bytes.byteLength,
        }),
      );
    }
    let stagingPath = join(vaultPath, "staging", ids.next());
    let staged: number | undefined;
    try {
      stagingPath = managedPath(vaultPath, relative(vaultPath, stagingPath));
      staged = openSync(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
      let written = 0;
      while (written < bytes.byteLength) {
        const count = writeSync(staged, bytes, written, bytes.byteLength - written);
        if (count <= 0)
          throw new Error(`The staged write made no progress after ${written} of ${bytes.byteLength} bytes.`);
        written += count;
      }
      fsyncSync(staged);
      closeSync(staged);
      staged = undefined;
      return ok({
        stagingPath,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      return err(
        appError("INTERNAL_ERROR", `Writing the staged content copy ${stagingPath} failed: ${messageOf(error)}.`, {
          stagingPath,
          cause: String(error),
        }),
      );
    } finally {
      if (staged !== undefined) {
        try {
          closeSync(staged);
        } catch {
          // Best effort on the abort path.
        }
      }
    }
  }
}

/**
 * The one shared completion transaction for common intents (SHR-005, section
 * 10.1), used by both the ordinary mutation completion and the start-up drain:
 * a done assessment marks the record materialized or completes the unlink,
 * clears the intent, and appends its success event in the same transaction,
 * with an inside-transaction recheck so a competing or repeated drain that
 * finds an already-completed intent appends no duplicate success; a failed
 * assessment retains the intent, bumps its attempts, and appends exactly one
 * failure event with the closed failure metadata.
 */
export function completeCommonIntentTx(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
  intentId: string,
  outcome: CommonExecutionOutcome,
  stamps: { eventIds?: (() => string) | undefined; now?: (() => string) | undefined } = {},
): Result<CommonCompletion, AppError> {
  try {
    db.exec("BEGIN IMMEDIATE");
    let completion: CommonCompletion;
    try {
      const row = db.prepare("SELECT * FROM pending_fs_ops WHERE id = ?").get(intentId) as
        | PendingRow
        | null
        | undefined;
      if (row === null || row === undefined) {
        // A competing drain already completed this intent: no state to change,
        // and no duplicate success event (section 10.1).
        db.exec("COMMIT");
        return ok({ status: "already-completed" });
      }
      if (
        classifyContentIntentOwnership({
          id: row.id,
          artifactId: row.artifact_id,
          ownerDomain: row.owner_domain,
          ownerId: row.owner_id,
          contentId: row.content_id,
        }) !== "common"
      ) {
        db.exec("ROLLBACK");
        return err(contentIntentIntegrityError(row.id));
      }
      const identity = {
        contentId: row.content_id as string,
        ownerDomain: row.owner_domain as ContentOwnerDomain,
        ownerId: row.owner_id as string,
        intentId: row.id,
        operation: row.op === "unlink" ? ("unlink" as const) : ("activate" as const),
      };
      const attempt = Number(row.attempts) + 1;
      if (outcome.status === "done") {
        if (row.op === "activate") {
          db.prepare("UPDATE content_records SET materialized = 1 WHERE id = ?").run(row.content_id);
        }
        db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(row.id);
        const eventType = row.op === "unlink" ? "CONTENT_UNLINKED" : "CONTENT_ACTIVATED";
        ledger.appendNow({
          eventType,
          actor: SYSTEM_ACTOR,
          metadata: commonContentSuccessMetadata(identity),
          id: stamps.eventIds !== undefined ? stamps.eventIds() : crypto.randomUUID(),
          createdAt: stamps.now !== undefined ? stamps.now() : new Date().toISOString(),
        });
        completion = { status: "completed" };
      } else {
        db.prepare("UPDATE pending_fs_ops SET attempts = attempts + 1 WHERE id = ?").run(row.id);
        ledger.appendNow({
          eventType: "CONTENT_INTEGRITY_FAILED",
          actor: SYSTEM_ACTOR,
          metadata: commonContentFailureMetadata(identity, { attempt, reason: outcome.reason }),
          id: stamps.eventIds !== undefined ? stamps.eventIds() : crypto.randomUUID(),
          createdAt: stamps.now !== undefined ? stamps.now() : new Date().toISOString(),
        });
        completion = { status: "failed", reason: outcome.reason, attempt };
      }
      db.exec("COMMIT");
      return ok(completion);
    } catch (transactionError) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction never opened or already rolled back.
      }
      throw transactionError;
    }
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Completing the common intent ${intentId} failed: ${messageOf(error)}.`, {
        intentId,
        cause: String(error),
      }),
    );
  }
}

/**
 * Executes one common `activate` against the filesystem state it finds (SHR-005,
 * section 10.1): neither side of a both-present destination conflict is touched,
 * a source-absent/destination-present retry completes only after the recorded
 * destination's size and hash are verified, and every failure maps onto the
 * closed common reasons without synthesizing success.
 */
export function activateCommonFile(input: {
  vaultPath: string;
  fromPath: string;
  toPath: string;
  expect: { sizeBytes: number; sha256: string };
}): CommonExecutionOutcome {
  if (!isSafeVaultRelativePath(input.fromPath) || !isManagedContentStorageKey(input.toPath))
    return { status: "failed", reason: "unsafe_path" };
  try {
    const source = managedFile(input.vaultPath, input.fromPath);
    const destination = managedFile(input.vaultPath, input.toPath);
    if (source.stat !== undefined && destination.stat !== undefined)
      return { status: "failed", reason: "destination_conflict" };
    if (source.stat !== undefined) {
      const target = managedPath(input.vaultPath, input.toPath, true);
      try {
        renameSync(source.path, target);
        fsyncDirectory(dirname(target));
        chmodSync(target, READ_ONLY_MODE);
        return { status: "done" };
      } catch (error) {
        // A concurrent executor may have completed the same physical effect.
        if (
          managedFile(input.vaultPath, input.fromPath).stat === undefined &&
          managedFile(input.vaultPath, input.toPath).stat !== undefined
        )
          return verifyDestination(input.vaultPath, input.toPath, input.expect);
        throw error;
      }
    }
    if (destination.stat !== undefined) return verifyDestination(input.vaultPath, input.toPath, input.expect);
    return { status: "failed", reason: "missing_content" };
  } catch (error) {
    return { status: "failed", reason: error instanceof UnsafeManagedPathError ? "unsafe_path" : "io_error" };
  }
}

/** Missing targets converge; unsafe entries retain the intent and are never followed. */
export function unlinkCommonFile(input: { vaultPath: string; toPath: string }): CommonExecutionOutcome {
  if (!isManagedContentStorageKey(input.toPath)) return { status: "failed", reason: "unsafe_path" };
  try {
    const target = managedFile(input.vaultPath, input.toPath);
    if (target.stat === undefined) return { status: "done" };
    try {
      unlinkSync(target.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsyncDirectory(dirname(target.path));
    return { status: "done" };
  } catch (error) {
    return { status: "failed", reason: error instanceof UnsafeManagedPathError ? "unsafe_path" : "io_error" };
  }
}

/**
 * The drain's executor for one common intent: the activate arm reads its
 * record's recorded size and digest for the destination verification, and a
 * record that has already vanished is `missing_content`, never a synthesized
 * success. Never runs inside a transaction.
 */
export function executeCommonIntent(
  db: SorageSqlite,
  intent: { op: "activate" | "unlink"; fromPath: string | null; toPath: string; contentId: string | null },
  vaultPath: string,
): CommonExecutionOutcome {
  if (intent.op === "unlink") {
    return unlinkCommonFile({ vaultPath, toPath: intent.toPath });
  }
  if (intent.contentId === null) {
    return { status: "failed", reason: "missing_content" };
  }
  const row = db.prepare("SELECT size_bytes, sha256 FROM content_records WHERE id = ?").get(intent.contentId) as
    | { size_bytes: number; sha256: string }
    | null
    | undefined;
  if (row === null || row === undefined) {
    return { status: "failed", reason: "missing_content" };
  }
  return activateCommonFile({
    vaultPath,
    fromPath: intent.fromPath ?? "",
    toPath: intent.toPath,
    expect: { sizeBytes: Number(row.size_bytes), sha256: row.sha256 },
  });
}

function verifyDestination(
  root: string,
  key: string,
  expect: { sizeBytes: number; sha256: string },
): CommonExecutionOutcome {
  let handle: number | undefined;
  try {
    handle = openManagedFile(root, key);
    if (fstatSync(handle).size !== expect.sizeBytes) return { status: "failed", reason: "size_mismatch" };
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
    let total = 0;
    for (;;) {
      const count = readSync(handle, buffer, 0, Math.min(buffer.length, expect.sizeBytes - total + 1), null);
      if (count === 0) break;
      total += count;
      if (total > expect.sizeBytes) return { status: "failed", reason: "size_mismatch" };
      digest.update(buffer.subarray(0, count));
    }
    if (total !== expect.sizeBytes) return { status: "failed", reason: "size_mismatch" };
    if (digest.digest("hex").toLowerCase() !== expect.sha256.toLowerCase())
      return { status: "failed", reason: "checksum_mismatch" };
    return { status: "done" };
  } catch (error) {
    return { status: "failed", reason: error instanceof UnsafeManagedPathError ? "unsafe_path" : "io_error" };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/** Reads the exact expected size through one guarded regular-file descriptor. */
function readFileBounded(root: string, key: string, expectedSize: number): Result<Buffer, AppError> {
  let handle: number | undefined;
  try {
    handle = openManagedFile(root, key);
    if (fstatSync(handle).size !== expectedSize)
      return err(
        appError("CONTENT_CORRUPTED", "The content file does not match its expected byte size.", { key, expectedSize }),
      );
    const bytes = Buffer.alloc(expectedSize);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(handle, bytes, length, Math.min(STREAM_BUFFER_BYTES, bytes.length - length), null);
      if (count === 0) break;
      length += count;
    }
    if (length !== expectedSize || readSync(handle, Buffer.allocUnsafe(1), 0, 1, null) !== 0)
      return err(appError("CONTENT_CORRUPTED", "The content file changed size while being read.", { key }));
    return ok(bytes);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return err(
      appError(
        error instanceof UnsafeManagedPathError || missing ? "CONTENT_CORRUPTED" : "INTERNAL_ERROR",
        "The managed content file is missing, unsafe, or unreadable.",
        { key, cause: String(error) },
      ),
    );
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function unreadableSource(sourcePath: string, error: unknown): AppError {
  return appError("INTERNAL_ERROR", `The source ${sourcePath} could not be read: ${messageOf(error)}.`, {
    sourcePath,
    cause: String(error),
  });
}

/**
 * The derived inline fetch cache of SHR-006: `<state>/fetch-cache/<sha256>`,
 * created owner-only and lazily on first use, written read-only and fsynced
 * before its path is returned, the same checksum always mapping to the same
 * path so repeated fetches reuse it. The cache is never a source of truth: a
 * corrupted entry is replaced, never trusted.
 */
export function materializeFetchCacheFile(
  stateDir: string,
  sha256: string,
  bytes: Uint8Array,
): Result<{ path: string }, AppError> {
  if (!/^[0-9a-f]{64}$/.test(sha256) || sha256OfBytes(bytes) !== sha256)
    return err(appError("INTERNAL_ERROR", "The fetch cache identity must digest the supplied bytes."));
  let temporaryKey: string | undefined;
  try {
    stateDir = cacheStateRoot(stateDir, true) as string;
    const directory = managedDirectory(stateDir, FETCH_CACHE_DIRECTORY, true, OWNER_ONLY_DIR) as string;
    const key = `${FETCH_CACHE_DIRECTORY}/${sha256}`;
    const target = managedFile(stateDir, key);
    if (target.stat !== undefined) {
      const current = readFileBounded(stateDir, key, bytes.byteLength);
      if (current.ok && Buffer.compare(current.value, Buffer.from(bytes)) === 0) return ok({ path: target.path });
      // Only a checked regular cache file may be replaced; links are refused above.
      unlinkSync(managedFile(stateDir, key).path);
    }
    temporaryKey = `${FETCH_CACHE_DIRECTORY}/.${sha256}.${randomUUID()}.tmp`;
    const temporary = managedPath(stateDir, temporaryKey);
    const handle = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const buffer = Buffer.from(bytes);
      let written = 0;
      while (written < buffer.length) {
        const count = writeSync(handle, buffer, written, buffer.length - written);
        if (count <= 0) throw new Error("The cache write made no progress");
        written += count;
      }
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    chmodSync(temporary, READ_ONLY_MODE);
    renameSync(temporary, managedPath(stateDir, key));
    temporaryKey = undefined;
    fsyncDirectory(directory);
    return ok({ path: managedPath(stateDir, key) });
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Materializing the derived fetch cache failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  } finally {
    if (temporaryKey !== undefined) {
      try {
        const temporary = managedFile(stateDir, temporaryKey);
        if (temporary.stat !== undefined) unlinkSync(temporary.path);
      } catch {
        /* Unsafe or unavailable cleanup is left to a later safe sweep. */
      }
    }
  }
}

/** Unsafe roots and entries are skipped without following them or reporting a removal. */
export function sweepFetchCache(stateDir: string, options: { graceHours: number; now: Date }): string[] {
  const swept: string[] = [];
  const cutoffMs = options.now.getTime() - options.graceHours * 3_600_000;
  try {
    const root = cacheStateRoot(stateDir, false);
    if (root === undefined) return swept;
    stateDir = root;
    const directory = managedDirectory(stateDir, FETCH_CACHE_DIRECTORY);
    if (directory === undefined) return swept;
    for (const entry of readdirSync(directory)) {
      try {
        const file = managedFile(stateDir, `${FETCH_CACHE_DIRECTORY}/${entry}`);
        if (file.stat !== undefined && file.stat.mtimeMs < cutoffMs) {
          unlinkSync(file.path);
          swept.push(file.path);
        }
      } catch {
        /* Linked, special, unreadable or concurrently removed entries are not candidates. */
      }
    }
  } catch {
    /* Missing or unsafe cache roots are never traversed. */
  }
  return swept;
}

function cacheStateRoot(stateDir: string, create: boolean): string | undefined {
  const stat = managedLstat(stateDir);
  if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw new UnsafeManagedPathError("The managed state directory is a link or special entry");
  if (stat === undefined && !create) return undefined;
  return managedRoot(stateDir, create);
}

/**
 * The default reference providers of this build, honest about what schema-8
 * production data can express (SHR-008): no domain row references a content
 * record before the adoption Tasks of TASK-107 and TASK-108, and no schema-8
 * retained response references one either — Handoff and Memo receipts embed
 * legacy outcomes whose strings are their own copy, never record references.
 * Scanning receipt bodies for managed-key-shaped strings would classify a
 * legacy inline body that literally equals a key as a reference, so the
 * default returns no reference instead of guessing. The adoption Tasks
 * introduce the record-based reference format and its parser; a supported
 * parser must resolve what a receipt names and must never silently turn
 * malformed data into absence.
 */
export function sqliteContentReferences(db: SorageSqlite): ContentReferences {
  void db;
  return {
    domainReferencedRecordIds() {
      // No domain row references a content record at schema 8; TASK-107 and
      // TASK-108 populate this provider when their adoptions land.
      return ok([]);
    },
    receiptReferencedRecordIds(_now: Date) {
      // No schema-8 receipt format references a content record; see the
      // function doc comment for why no heuristic may substitute for that.
      return ok([]);
    },
  };
}

/**
 * Derives the physical GC key guard from the record-based reference providers
 * (SHR-008, SHR-011): the keys of records unexpired retained responses name.
 * Honest at this build — no schema-8 receipt references a content record, so
 * this is empty — and it stays correct without edits when the adoption Tasks
 * give the provider its parser, because the record remains the reference unit.
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
