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
import { basename, dirname, join, relative } from "node:path";
import {
  type AppError,
  appError,
  type ArtifactBodyPrepareRequest,
  buildContentStorageKey,
  type Clock,
  type CommonContentFailureReason,
  type ContentCleanupReport,
  type ContentBodyHandle,
  type ContentBodyOpenPolicy,
  type ContentLocalPathPolicy,
  type ContentOwnerDomain,
  type ContentRead,
  type ContentRecord,
  type ContentRecordRemovalPlan,
  type ContentReferences,
  type ContentStore,
  type PreparedArtifactBody,
  type StagedContentFile,
  type StageContentRequest,
  SYSTEM_ACTOR,
  SystemClock,
  type WriteContentFileInput,
  type WriteContentOutcome,
  type WriteInlineInput,
  type WriteInlineOutcome,
  classifyPreparedBody,
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
  planContentRecordRemoval,
  type Result,
  sanitizeStoredName,
  sha256OfBytes,
  sha256OfText,
  UuidGenerator,
  validateContentRecord,
  CONTENT_INLINE_MAX_UTF8_BYTES,
  classifyContentIntentOwnership,
  contentIntentIntegrityError,
  parseStoredMemoReceipt,
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
  /**
   * The in-transaction reference-proof removal of sections 1 and 3: reads the
   * reference, receipt, fence, and pending-intent proof inside the caller's
   * open transaction, decides through the shared core planner, deletes the
   * record row only for a removable plan, and never inserts an intent, touches
   * the filesystem, or appends an event — the caller owns the physical
   * disposition the returned plan names. A malformed stored key refuses with
   * `STORAGE_INTEGRITY_ERROR` and a common owner-identity mismatch refuses with
   * its existing error, both before any deletion; every refusal must make the
   * caller abort its enclosing transaction. A live move fence pauses with
   * `SERVICE_PAUSED`; a SQL failure throws so the caller's transaction aborts.
   */
  removeContentRecordInTx(
    recordId: string,
    options: { references: ContentReferences; now: Date },
  ): Result<ContentRecordRemovalPlan, AppError>;
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
      const report: ContentCleanupReport = { removedInlineIds: [], scheduledUnlinkIds: [], removedFileOnlyIds: [] };
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
          // The strengthened metadata guard runs inside this writer
          // transaction before any deletion: a living Handoff whose current
          // Artifact row, association, or record is broken must refuse the
          // reference proof and roll back here, because the artifact-keyed
          // reference provider reads only surviving artifact rows and would
          // otherwise free the orphaned record before any later census could
          // see the damage (SHR-004, SHR-008, SHR-014).
          const livingLinks = validateArtifactContentLinks(db);
          if (!livingLinks.ok) {
            db.exec("ROLLBACK");
            return livingLinks;
          }
          // The Memo-side link guard runs in the same writer transaction and
          // before the first deletion: a schema-10 database whose Memo rows
          // lost their record references must refuse the proof exactly like a
          // broken Artifact link, never pass as a healthy empty reference set
          // that frees owned records (SHR-004, SHR-014, ADR-0032 plan).
          const livingMemoLinks = validateMemoContentLinks(db);
          if (!livingMemoLinks.ok) {
            db.exec("ROLLBACK");
            return livingMemoLinks;
          }
          // The Channel-side link guard joins the same writer transaction and
          // the same before-first-delete rule: a schema-11 database whose
          // message rows lost their record references — NULL or dangling —
          // refuses the proof and rolls the whole cleanup batch back, never
          // frees the orphaned records before any census could see the damage
          // (SHR-004, SHR-014, the TASK-109 reviewed plan).
          const livingChannelLinks = validateChannelContentLinks(db);
          if (!livingChannelLinks.ok) {
            db.exec("ROLLBACK");
            return livingChannelLinks;
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
          // The temporary recovery-safety guards, read inside the same writer
          // transaction: a record whose activation intent is still pending is
          // preserved until that intent resolves, because deleting it first
          // would strand the retained staged file and destination as a
          // permanent missing_content failure for work the database still
          // promises; and a record whose physical key any pending intent still
          // names stays until that intent settles. Neither is permanent
          // retention; once the intent clears, the ordinary reference rule owns
          // the record again.
          const pendingActivations = new Set(
            (
              db
                .prepare(
                  "SELECT DISTINCT content_id FROM pending_fs_ops WHERE op = 'activate' AND content_id IS NOT NULL",
                )
                .all() as unknown as Array<{ content_id: string }>
            ).map((row) => row.content_id),
          );
          const pendingToPaths = new Set(
            (db.prepare("SELECT to_path FROM pending_fs_ops").all() as unknown as Array<{ to_path: string }>).map(
              (row) => row.to_path,
            ),
          );
          const proof = {
            domainReferencedRecordIds: new Set(domainIds.value),
            receiptReferencedRecordIds: new Set(receiptIds.value),
            pendingCommonActivationContentIds: pendingActivations,
            pendingPhysicalToPaths: pendingToPaths,
            // The live fence above already pauses the whole run; the planner's
            // fence branch serves read-only planning callers.
            moveFencePaused: false,
          };
          const rows = db.prepare("SELECT * FROM content_records ORDER BY id").all() as unknown as ContentRow[];
          for (const row of rows) {
            const plan = planContentRecordRemoval(toRecord(row), proof);
            if (!plan.ok) {
              // A malformed stored key is a storage-integrity refusal: roll back
              // every earlier deletion of this batch, preserve the rows, and
              // surface the error — never a partially deleted committed batch.
              db.exec("ROLLBACK");
              return plan;
            }
            if (plan.value.action === "retain") continue;
            if (plan.value.action === "remove-inline") {
              // Inline bodies are removed by the reference rule alone: no file,
              // no intent, and no physical event (SHR-004).
              db.prepare("DELETE FROM content_records WHERE id = ?").run(row.id);
              report.removedInlineIds.push(row.id);
              continue;
            }
            const key = row.storage_key as string;
            if (plan.value.physicalUnlink === "owed-elsewhere") {
              // An artifacts/-keyed record's physical removal is owed to the
              // legacy Artifact unlink intent, never to a fabricated common
              // owner (section 38.1, security section 10.1).
              db.prepare("DELETE FROM content_records WHERE id = ?").run(row.id);
              report.removedFileOnlyIds.push(row.id);
              continue;
            }
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

    openBody(recordId: string, policy: ContentBodyOpenPolicy): Result<ContentBodyHandle, AppError> {
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
        // Inline bodies are bounded by the routing threshold, so verifying the
        // stored text at open is one bounded pass, never a large-file cost.
        const bytes = Buffer.from(row.inline_text, "utf8");
        if (bytes.byteLength !== sizeBytes || sha256OfBytes(bytes) !== row.sha256) {
          return err(
            appError("CONTENT_CORRUPTED", "The inline bytes do not match their recorded size and SHA-256.", {
              recordId,
            }),
          );
        }
        return ok(inlineBodyHandle({ recordId: row.id, sizeBytes, sha256: row.sha256 }, bytes));
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
      const verify =
        policy.verifyFileDigest === "always" ||
        (policy.verifyFileDigest === "if-configured" && policy.verifyChecksumOnFetch === true);
      let fd: number;
      try {
        fd = openManagedFile(vaultPath, key);
      } catch (error) {
        return err(
          appError("CONTENT_CORRUPTED", `The content at ${key} is missing, unsafe, or unreadable.`, {
            recordId,
            storageKey: key,
            cause: String(error),
          }),
        );
      }
      // The actually-opened descriptor is the one authority for the body's
      // byte extent (section 11.3): a file that grew or shrank on disk serves
      // its true current length — never a silent recorded-length prefix of a
      // grown file — and the strict recorded-size and hash gate below still
      // refuses any divergence whenever the policy demands it. An fstat
      // failure disposes best-effort and refuses typed with no engagement; a
      // failed disposal never masks the body-integrity refusal (a raw close
      // exception must not replace it, and the descriptor number may already
      // be closed by the failing syscall, so no retry may close it again).
      let actualSizeBytes: number;
      try {
        actualSizeBytes = fstatSync(fd).size;
      } catch (error) {
        disposeOpenedDescriptor(fd);
        return err(
          appError("CONTENT_CORRUPTED", `The content at ${key} could not be measured for serving.`, {
            recordId,
            storageKey: key,
            cause: String(error),
          }),
        );
      }
      if (verify) {
        // One bounded streamed digest over the opened descriptor: the handle
        // hands over bytes from the same open it verified. The digest reads
        // exactly the recorded size and probes one byte beyond, so a grown or
        // shortened file fails this gate before any acquisition-dependent
        // settlement (SHR-003). Disposal on refusal is one best-effort close
        // for the same reason as the fstat exit.
        const digest = digestOfFd(fd, sizeBytes);
        if (!digest.ok) {
          disposeOpenedDescriptor(fd);
          return err(digest.error);
        }
        if (digest.value !== row.sha256.toLowerCase()) {
          disposeOpenedDescriptor(fd);
          return err(
            appError("CONTENT_CORRUPTED", "The content bytes do not match their recorded SHA-256.", {
              recordId,
              storageKey: key,
            }),
          );
        }
      }
      return ok(
        fileBodyHandle({ recordId: row.id, sizeBytes: actualSizeBytes, sha256: row.sha256, storageKey: key }, fd),
      );
    },

    materializeLocalPath(recordId: string, policy: ContentLocalPathPolicy): Result<string, AppError> {
      const row = readContentRow(recordId);
      if (row === null) {
        return err(appError("CONTENT_CORRUPTED", "The referenced content record is missing.", { recordId }));
      }
      const valid = validateContentRecord(toRecord(row));
      if (!valid.ok) {
        return err(appError("CONTENT_CORRUPTED", "The stored content representation is invalid.", { recordId }));
      }
      if (row.inline_text !== null) {
        const bytes = Buffer.from(row.inline_text, "utf8");
        if (bytes.byteLength !== Number(row.size_bytes) || sha256OfBytes(bytes) !== row.sha256) {
          return err(
            appError("CONTENT_CORRUPTED", "The inline bytes do not match their recorded size and SHA-256.", {
              recordId,
            }),
          );
        }
        const cached = materializeFetchCacheFile(policy.stateDir, row.sha256, bytes);
        if (!cached.ok) return cached;
        return ok(cached.value.path);
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
      // The uniform port promises a readable local path: resolve through the
      // managed no-follow guard, which refuses links and special entries, and
      // treat an absent regular file as a visible missing-content failure. This
      // resolution proves presence and safety only — never a checksum claim.
      try {
        const resolved = managedFile(vaultPath, key);
        if (resolved.stat === undefined) {
          return err(
            appError("CONTENT_CORRUPTED", `The content at ${key} is missing at its storage key.`, {
              recordId,
              storageKey: key,
            }),
          );
        }
        const descriptor = openManagedFile(vaultPath, key);
        closeSync(descriptor);
        return ok(resolved.path);
      } catch (error) {
        return err(
          appError("CONTENT_CORRUPTED", `The content path ${key} is not a safe managed regular file.`, {
            recordId,
            storageKey: key,
            cause: String(error),
          }),
        );
      }
    },

    prepareArtifactBody(request: ArtifactBodyPrepareRequest): Result<PreparedArtifactBody, AppError> {
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      const tooLarge = request.bounds.tooLargeCode ?? "ARTIFACT_TOO_LARGE";
      const contextBase = {
        classification: request.classification,
        handoffId: request.identities.handoffId,
        artifactId: request.identities.artifactId,
        maxBytes: request.bounds.maxBytes,
        ...(request.bounds.tooLargeCode === undefined ? {} : { tooLargeCode: request.bounds.tooLargeCode }),
      };
      const importedFromPath = request.provenance.importedFromPath;
      if (request.body.kind === "text") {
        // A text body's logical name already carries the naming rule; its exact
        // UTF-8 bytes are the accepted bytes (SHR-002, SHR-003). Validate
        // byte-exactness BEFORE encoding: Buffer.from silently replaces an
        // unpaired surrogate with U+FFFD, which writeInline and write reject at
        // this same boundary, so prepare refuses both a short and an
        // over-threshold surrogate text with no staged file and no record.
        if (!isUtf8ExactText(request.body.text)) {
          return err(
            appError(
              "INTERNAL_ERROR",
              "The accepted text cannot be stored byte-exactly; reject it at the surface before it reaches the shared store.",
            ),
          );
        }
        const bytes = Buffer.from(request.body.text, "utf8");
        const routing = classifyPreparedBody(
          {
            ...contextBase,
            logicalName: request.body.logicalName,
            storedName: sanitizeStoredName(request.body.logicalName),
          },
          bytes,
        );
        if (!routing.ok) return routing;
        if (routing.value.kind === "inline") {
          return ok({
            kind: "inline",
            text: routing.value.text,
            sizeBytes: routing.value.sizeBytes,
            sha256: routing.value.sha256,
            mimeType: routing.value.mimeType,
            storageKey: null,
            logicalName: request.body.logicalName,
            importedFromPath,
          });
        }
        const staged = stageBytes(bytes, request.bounds.maxBytes, tooLarge);
        if (!staged.ok) return staged;
        return ok({
          kind: "file",
          // Legacy Artifact intents derive their relative source from the
          // selected Vault notation. Shared staging itself stays canonical;
          // preserve a configured root alias at this Handoff-only boundary.
          stagingPath: join(vaultPath, "staging", basename(staged.value.stagingPath)),
          sizeBytes: staged.value.sizeBytes,
          sha256: staged.value.sha256,
          mimeType: routing.value.mimeType,
          storageKey: routing.value.storageKey,
          logicalName: request.body.logicalName,
          importedFromPath,
        });
      }
      // A file body is classified only by its logical original name: the spool
      // path of an authenticated upload is opaque and extensionless, and a
      // client-declared type is never trusted (section 4, section 11.2).
      const source = request.body;
      let sourceStat: ReturnType<typeof statSync>;
      try {
        sourceStat = statSync(source.physicalPath);
      } catch (error) {
        return err(unreadableSource(source.physicalPath, error));
      }
      if (!sourceStat.isFile()) {
        return err(
          appError(
            "INTERNAL_ERROR",
            `The source is not a regular file and cannot be imported: ${source.physicalPath}.`,
            {
              sourcePath: source.physicalPath,
            },
          ),
        );
      }
      if (sourceStat.size > request.bounds.maxBytes) {
        return err(
          appError(
            tooLarge,
            `The source ${source.physicalPath} exceeds the shared bound artifact.maxBytes ${String(request.bounds.maxBytes)} bytes.`,
            { sourcePath: source.physicalPath, maxBytes: request.bounds.maxBytes },
          ),
        );
      }
      // The bounded pre-read stops at the routing threshold plus one byte: an
      // inline decision needs exactly the whole body, and anything longer is
      // Vault-routed by the streamed staging pass that enforces the bound
      // mid-stream rather than by buffering the whole body here.
      const limit = Math.min(CONTENT_INLINE_MAX_UTF8_BYTES + 1, request.bounds.maxBytes + 1);
      const preRead = preReadSource(source.physicalPath, limit);
      if (!preRead.ok) return preRead;
      const routing = classifyPreparedBody(
        {
          ...contextBase,
          logicalName: source.logicalOriginalName,
          storedName: sanitizeStoredName(source.logicalOriginalName),
        },
        preRead.value.bytes,
      );
      if (!routing.ok) return routing;
      if (routing.value.kind === "inline") {
        if (!preRead.value.complete) {
          return err(
            appError("INTERNAL_ERROR", "An inline routing decision requires a complete bounded pre-read.", {
              sourcePath: source.physicalPath,
            }),
          );
        }
        return ok({
          kind: "inline",
          text: routing.value.text,
          sizeBytes: routing.value.sizeBytes,
          sha256: routing.value.sha256,
          mimeType: routing.value.mimeType,
          storageKey: null,
          logicalName: source.logicalOriginalName,
          importedFromPath,
        });
      }
      const staged = this.stage({
        sourcePath: source.physicalPath,
        maxBytes: request.bounds.maxBytes,
        ...(request.bounds.tooLargeCode === undefined ? {} : { tooLargeCode: request.bounds.tooLargeCode }),
      });
      if (!staged.ok) return staged;
      return ok({
        kind: "file",
        // Legacy Artifact intents derive their relative source from the
        // selected Vault notation. Shared staging itself stays canonical;
        // preserve a configured root alias at this Handoff-only boundary.
        stagingPath: join(vaultPath, "staging", basename(staged.value.stagingPath)),
        sizeBytes: staged.value.sizeBytes,
        sha256: staged.value.sha256,
        mimeType: routing.value.mimeType,
        storageKey: routing.value.storageKey,
        logicalName: source.logicalOriginalName,
        importedFromPath,
      });
    },

    removeContentRecordInTx(
      recordId: string,
      options: { references: ContentReferences; now: Date },
    ): Result<ContentRecordRemovalPlan, AppError> {
      // The caller holds the open write transaction; every read below runs
      // inside it, so the proof and the deletion serialize on one lock.
      const paused = liveFencePaused(db);
      if (paused) {
        return err(
          appError(
            "SERVICE_PAUSED",
            "A Vault move or restore is in progress; the content removal paused instead of racing it.",
            { moveFencePid: paused.pid },
          ),
        );
      }
      // The strengthened metadata guard joins the reference proof inside the
      // caller's open transaction: a broken living-Handoff link refuses the
      // removal before any row changes, and the caller aborts the enclosing
      // transaction on this Result (SHR-004, SHR-014). Legitimate revision and
      // retention flows keep metadata coherent at proof time — the revision
      // inserts its new Artifact before removing superseded records, and the
      // tombstone already names no current Artifact — so only a real fault
      // refuses here.
      const livingLinks = validateArtifactContentLinks(db);
      if (!livingLinks.ok) return livingLinks;
      // The Memo link guard joins this same open transaction before the first
      // deletion, mirroring the cleanup path: a schema-10 Memo reference fault
      // refuses the removal instead of freeing an owned record (SHR-004).
      const livingMemoLinks = validateMemoContentLinks(db);
      if (!livingMemoLinks.ok) return livingMemoLinks;
      // The Channel link guard joins the same open transaction under the same
      // rule: a schema-11 Channel reference fault — a NULL or dangling message
      // reference — refuses the removal before any row changes and the caller
      // aborts its enclosing transaction (SHR-004, the TASK-109 reviewed plan).
      const livingChannelLinks = validateChannelContentLinks(db);
      if (!livingChannelLinks.ok) return livingChannelLinks;
      const domainIds = options.references.domainReferencedRecordIds();
      if (!domainIds.ok) return domainIds;
      const receiptIds = options.references.receiptReferencedRecordIds(options.now);
      if (!receiptIds.ok) return receiptIds;
      const pendingActivations = new Set(
        (
          db
            .prepare("SELECT DISTINCT content_id FROM pending_fs_ops WHERE op = 'activate' AND content_id IS NOT NULL")
            .all() as unknown as Array<{ content_id: string }>
        ).map((row) => row.content_id),
      );
      const pendingToPaths = new Set(
        (db.prepare("SELECT to_path FROM pending_fs_ops").all() as unknown as Array<{ to_path: string }>).map(
          (row) => row.to_path,
        ),
      );
      const row = readContentRow(recordId);
      if (row === null) {
        return err(appError("CONTENT_CORRUPTED", "The referenced content record is missing.", { recordId }));
      }
      const plan = planContentRecordRemoval(toRecord(row), {
        domainReferencedRecordIds: new Set(domainIds.value),
        receiptReferencedRecordIds: new Set(receiptIds.value),
        pendingCommonActivationContentIds: pendingActivations,
        pendingPhysicalToPaths: pendingToPaths,
        moveFencePaused: false,
      });
      // A planner refusal (a malformed stored key) or a common-ownership proof
      // failure propagates before any deletion: the row is preserved and the
      // caller must abort its enclosing transaction on this Result.
      if (!plan.ok) return plan;
      if (plan.value.action === "remove-record" && plan.value.physicalUnlink === "common-intent") {
        // The helper never bypasses the common owner proof the cleanup path
        // runs: a content/-shaped key whose record segment mismatches its row
        // refuses here exactly as it refuses there.
        const owner = contentOwnerFromStorageKey({ id: row.id, storageKey: row.storage_key as string });
        if (!owner.ok) return owner;
      }
      if (plan.value.action !== "retain") {
        // No intent, no event, no filesystem effect: the physical disposition
        // the plan names belongs to the caller's transaction.
        db.prepare("DELETE FROM content_records WHERE id = ?").run(recordId);
      }
      return ok(plan.value);
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
      } catch (error) {
        // Only a rename error reaches this re-evaluation: a concurrent
        // executor may have completed the same physical effect, and the
        // managed validated destination then carries the competitor's result
        // through the recorded size/hash verification. Anything else keeps its
        // original error semantics.
        if (
          managedFile(input.vaultPath, input.fromPath).stat === undefined &&
          managedFile(input.vaultPath, input.toPath).stat !== undefined
        ) {
          return durableVerifiedDestination(input.vaultPath, input.toPath, input.expect);
        }
        throw error;
      }
      // The parent directory entry must fsync successfully before this
      // activation may report done: an fsync failure is never converted into
      // success by existence or content checks (VLT-022, SHR-005).
      fsyncDirectory(dirname(target));
      try {
        chmodSync(target, READ_ONLY_MODE);
      } catch {
        // Read-only is best effort where the filesystem supports it (VLT-008);
        // the content census reports the condition.
      }
      return { status: "done" };
    }
    if (destination.stat !== undefined) {
      // The source-absent/destination-present retry completes only through the
      // recorded size/hash verification AND a successful parent fsync:
      // verified bytes do not prove the directory entry is durable.
      return durableVerifiedDestination(input.vaultPath, input.toPath, input.expect);
    }
    return { status: "failed", reason: "missing_content" };
  } catch (error) {
    return { status: "failed", reason: error instanceof UnsafeManagedPathError ? "unsafe_path" : "io_error" };
  }
}

/** The verified destination retry's durability half: the recorded bytes verify first, then the parent entry must fsync, and the same best-effort read-only mark as a fresh placement follows. */
function durableVerifiedDestination(
  vaultPath: string,
  toPath: string,
  expect: { sizeBytes: number; sha256: string },
): CommonExecutionOutcome {
  const verified = verifyDestination(vaultPath, toPath, expect);
  if (verified.status !== "done") return verified;
  const target = managedPath(vaultPath, toPath);
  fsyncDirectory(dirname(target));
  try {
    chmodSync(target, READ_ONLY_MODE);
  } catch {
    // Read-only is best effort where the filesystem supports it (VLT-008);
    // the content census reports the condition.
  }
  return verified;
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
 * The bounded prepare pre-read of section 4: at most `limit` bytes of a source
 * file, with `complete` true only when the whole body fit inside the clamp, so
 * an inline decision never rests on partial bytes and a Vault routing never
 * buffers more than the routing threshold plus one byte in memory.
 */
function preReadSource(sourcePath: string, limit: number): Result<{ bytes: Buffer; complete: boolean }, AppError> {
  let source: number | undefined;
  try {
    try {
      source = openSync(sourcePath, "r");
    } catch (error) {
      return err(unreadableSource(sourcePath, error));
    }
    const bytes = Buffer.allocUnsafe(limit);
    let length = 0;
    while (length < limit) {
      const count = readSync(source, bytes, length, limit - length, null);
      if (count === 0) return ok({ bytes: bytes.subarray(0, length), complete: true });
      length += count;
    }
    return ok({ bytes, complete: false });
  } catch (error) {
    return err(unreadableSource(sourcePath, error));
  } finally {
    if (source !== undefined) {
      try {
        closeSync(source);
      } catch {
        // Best effort on the abort path.
      }
    }
  }
}

/** One bounded streamed SHA-256 over an already-opened regular-file descriptor. */
function digestOfFd(fd: number, sizeBytes: number): Result<string, AppError> {
  try {
    const onDiskBytes = fstatSync(fd).size;
    if (onDiskBytes !== sizeBytes) {
      return err(
        appError("CONTENT_CORRUPTED", "The content file does not match its recorded byte size.", {
          sizeBytes,
          onDiskBytes,
        }),
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
    let position = 0;
    while (position < sizeBytes) {
      const count = readSync(fd, buffer, 0, Math.min(STREAM_BUFFER_BYTES, sizeBytes - position), position);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (position !== sizeBytes) {
      return err(
        appError("CONTENT_CORRUPTED", "The content file is shorter than its recorded byte size.", { sizeBytes }),
      );
    }
    // A byte beyond the recorded size means the file grew: appended bytes must
    // not escape mandatory verification, exactly like readFileBounded's probe.
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, sizeBytes) !== 0) {
      return err(
        appError("CONTENT_CORRUPTED", "The content file is longer than its recorded byte size.", { sizeBytes }),
      );
    }
    return ok(hash.digest("hex"));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Digesting the opened content failed: ${messageOf(error)}.`, { cause: String(error) }),
    );
  }
}

function invalidBoundedRead(): AppError {
  return appError("INTERNAL_ERROR", "A bounded body read needs a nonnegative position and a positive maxLength.");
}

/**
 * One best-effort close of a descriptor an error path already owns: a failing
 * OS close may still have closed the descriptor, and the swallowed disposal
 * failure never masks the typed body-integrity refusal that follows it. Each
 * error path calls this exactly once per descriptor; the success handle's own
 * ownership is unchanged.
 */
function disposeOpenedDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort only: the typed refusal is the answer the caller receives.
  }
}

interface BodyHandleMeta {
  recordId: string;
  sizeBytes: number;
  sha256: string;
}

/** The inline handle: exact verified bytes already in memory, bounded by the routing threshold. */
function inlineBodyHandle(meta: BodyHandleMeta, bytes: Buffer): ContentBodyHandle {
  return {
    recordId: meta.recordId,
    representation: "inline",
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
    storageKey: null,
    read(position: number, maxLength: number): Result<Uint8Array, AppError> {
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(maxLength) || position < 0 || maxLength <= 0) {
        return err(invalidBoundedRead());
      }
      if (position >= bytes.byteLength) return ok(new Uint8Array(0));
      const length = Math.min(maxLength, bytes.byteLength - position);
      const out = new Uint8Array(length);
      out.set(bytes.subarray(position, position + length));
      return ok(out);
    },
    close(): void {
      // The inline buffer holds no opened resource.
    },
  };
}

/**
 * The file handle: one validated managed no-follow descriptor, the actually
 * opened file's true byte extent as its size authority, bounded positional
 * reads that never buffer the whole body, and explicit disposal. The recorded
 * digest rides along for ETag and policy verification; the strict
 * recorded-size and hash gate runs at open time whenever the digest policy
 * demands it, so the default-false hot path never pays a hash while still
 * serving only bytes the descriptor truly holds.
 */
function fileBodyHandle(meta: BodyHandleMeta & { storageKey: string }, fd: number): ContentBodyHandle {
  let open: number | null = fd;
  return {
    recordId: meta.recordId,
    representation: "file",
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
    storageKey: meta.storageKey,
    read(position: number, maxLength: number): Result<Uint8Array, AppError> {
      if (open === null) return err(appError("INTERNAL_ERROR", "The body handle is already closed."));
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(maxLength) || position < 0 || maxLength <= 0) {
        return err(invalidBoundedRead());
      }
      if (position >= meta.sizeBytes) return ok(new Uint8Array(0));
      // One read returns at most the fixed streaming buffer, so a caller's huge
      // requested range never allocates a whole large body (section 2).
      const length = Math.min(maxLength, STREAM_BUFFER_BYTES, meta.sizeBytes - position);
      const out = Buffer.allocUnsafe(length);
      let done = 0;
      try {
        while (done < length) {
          const count = readSync(open, out, done, length - done, position + done);
          if (count <= 0) break;
          done += count;
        }
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the body at ${meta.storageKey} failed: ${messageOf(error)}.`, {
            storageKey: meta.storageKey,
            cause: String(error),
          }),
        );
      }
      if (done < length) {
        // A short read inside the opened extent is structural truncation,
        // visible without any digest-verification claim.
        return err(
          appError("CONTENT_CORRUPTED", "The content file is shorter than its opened byte extent.", {
            storageKey: meta.storageKey,
          }),
        );
      }
      return ok(out);
    },
    close(): void {
      if (open !== null) {
        const closing = open;
        open = null;
        closeSync(closing);
      }
    },
  };
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
 * The schema version at which `artifacts` gained its normalized
 * `content_record_id` reference — the TASK-107 Handoff adoption rebuild
 * (interface section 38.7). A database whose applied history is at or above
 * this version must carry the reference column; one below it legitimately
 * keeps the legacy mirrored columns and has no Artifact content references.
 */
const HANDOFF_CONTENT_ADOPTION_SCHEMA_VERSION = 9;

/**
 * The verified storage-layout distinction for read-only Artifact surfaces
 * (SHR-014, section 35): which physical columns `artifacts` carries is decided
 * from the table's actual shape together with the applied migration history —
 * never from catching a missing-column SQL error and guessing. A database below
 * the adoption version legitimately has no Artifact content references, whether
 * its pre-adoption `artifacts` table carries the legacy mirrored columns or the
 * table has not arrived yet; a database at or above the adoption version must
 * carry both the table and its `content_record_id` reference, and either's
 * absence is inconsistent (SHR-004: a history-only admission check does not
 * establish the required structure of an already-current database).
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
 * report a false healthy empty census or an incomplete live-key proof. The
 * guard is layout-aware (a legitimate pre-adoption database keeps its legacy
 * census and vacuous passes; an adoption-version database missing the required
 * table or column is inconsistent) and bounded: one LEFT JOIN metadata query,
 * never a body read, never filesystem I/O, never a global schema validation.
 * Callers must invoke it BEFORE any materialized, file, or cursor filters, and
 * an unavailable proof is an error — never an empty list.
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
    // The required normalized record table itself must exist: its absence at
    // this layout is the same integrity classification, not an operational SQL
    // failure, and must never fall through to an empty proof.
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
    // The normalized reference is required on every artifacts row, so no
    // null-filter may hide a broken relationship: any row whose target record
    // row is absent is a missing authoritative record, whatever its shape.
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
    // Every living Handoff must resolve its named current Artifact to a row of
    // its own that carries an authoritative record: a deleted Artifact row, a
    // wrong-Handoff association, or a vanished record behind it is the same
    // fail-closed integrity refusal. Tombstones legitimately name no current
    // Artifact, and a present-but-unmaterialized file link is complete
    // metadata, never corruption (SHR-004, SHR-014).
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

/**
 * Inspects the Memo storage layout against the applied migration history: a
 * database below version 7 legitimately has no Memo table, versions 7 through
 * 9 legitimately keep the inline `body` column, and a database at or above the
 * adoption version must carry the normalized `content_record_id` reference —
 * its absence is inconsistency, never a legacy layout (SHR-004, SHR-014).
 */
export function inspectMemoStorageLayout(db: SorageSqlite): MemoStorageLayout {
  const columns = db.prepare("PRAGMA table_info(project_memos)").all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return appliedSchemaMaximum(db) >= 7 ? "inconsistent" : "pre-memo";
  }
  if (columns.some((column) => column.name === "content_record_id")) return "content-records";
  return appliedSchemaMaximum(db) >= MEMO_CONTENT_ADOPTION_SCHEMA_VERSION ? "inconsistent" : "legacy-body";
}

/**
 * The Memo-side metadata guard, the symmetric twin of
 * `validateArtifactContentLinks` (SHR-004, SHR-014, ADR-0032 plan): legitimate
 * pre-adoption layouts pass, a schema-10 database missing the required table
 * or reference column is an integrity refusal, and every Memo row must
 * reference an existing content record — a dangling reference never passes as
 * a healthy empty proof that frees owned records. Bounded metadata queries
 * only; never a body read, never filesystem I/O. Called inside both deletion
 * writer transactions before the first delete, and at the Doctor census and
 * consistent-export boundaries before any healthy-empty conclusion.
 */
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

/**
 * Inspects the Channel storage layout against the applied migration history: a
 * database below version 11 legitimately has no Channel tables, and a database
 * at or above the Channel version must carry the `channel_messages` table with
 * its `content_record_id` reference — its absence is inconsistency, never a
 * legacy layout (SHR-004, SHR-014, interface section 38.7).
 */
export function inspectChannelStorageLayout(db: SorageSqlite): ChannelStorageLayout {
  const columns = db.prepare("PRAGMA table_info(channel_messages)").all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return appliedSchemaMaximum(db) >= CHANNEL_CONTENT_ADOPTION_SCHEMA_VERSION ? "inconsistent" : "pre-channel";
  }
  if (columns.some((column) => column.name === "content_record_id")) return "channel-records";
  return "inconsistent";
}

/**
 * The Channel-side metadata guard, the third twin of the Artifact and Memo
 * guards (SHR-004, SHR-014, the TASK-109 reviewed plan): a legitimate
 * pre-Channel database contributes no references, a schema-11 database missing
 * the required table or reference column is an integrity refusal, and every
 * message row must carry a non-NULL reference that resolves to an existing
 * content record — a NULL or dangling reference never passes as a healthy
 * empty proof that frees owned records. Bounded metadata queries only; never a
 * body read, never filesystem I/O. Called inside both deletion writer
 * transactions before the first delete, and at the Vault-verify census, Doctor
 * census, and consistent-export boundaries before any healthy-empty
 * conclusion.
 */
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
        "SELECT m.id AS message_id, m.content_record_id AS content_record_id FROM channel_messages m LEFT JOIN content_records c ON c.id = m.content_record_id WHERE c.id IS NULL OR m.content_record_id IS NULL LIMIT 1",
      )
      .get() as { message_id: string; content_record_id: string | null } | null | undefined;
    if (dangling !== null && dangling !== undefined) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The Channel message ${dangling.message_id} references content record ${String(dangling.content_record_id)}, which is missing; the Channel content links could not be verified.`,
          { messageId: dangling.message_id, contentRecordId: dangling.content_record_id },
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

/**
 * The living-Handoff half of the normalized metadata guard (SHR-004,
 * SHR-014): every non-tombstone Handoff that names a current Artifact must
 * find that Artifact row, owned by the same Handoff, referencing an existing
 * content record. The check is one bounded metadata query; it never reads a
 * body, never touches the filesystem, and skips every legitimate shape —
 * tombstones, empty installations, pre-adoption layouts, and
 * present-but-unmaterialized files. The same function guards the reference
 * proof inside cleanup and removal writer transactions, where a broken link
 * must refuse the proof before any deletion.
 */
function validateLivingHandoffArtifactLinks(db: SorageSqlite): Result<void, AppError> {
  try {
    // The containing guard already established the normalized tables and
    // Artifact-to-record links. Keep owner validation private and reuse that
    // complete guard at every deletion-proof boundary.
    // One bounded LEFT JOIN over every living Handoff: a row naming no current
    // Artifact, a named row that is missing, a wrong-Handoff association, or a
    // vanished record behind it are all caught naturally — including a
    // NULL current id the schema CHECK should already prevent, which joins to
    // a missing row and refuses rather than passing vacuously.
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

/**
 * The default SQL reference provider. `domainReferencedRecordIds` reads the
 * Artifact record references through the verified Artifact storage layout, the
 * Memo record references through the verified Memo layout, and the Channel
 * message references through the verified Channel layout: a legitimate
 * pre-adoption database contributes no references of any domain, the actual
 * references are read on adoption-version databases, and a database whose
 * applied history demands a layout it does not carry is a visible integrity
 * refusal — an inconsistent current database must never pass as an empty
 * proof, because the standalone cleanup would treat that as license to delete
 * owned records. `receiptReferencedRecordIds` resolves the Memo-scope
 * retained-response family through the dual-form receipt parser: a
 * reference-form receipt names its immutable record (SHR-008), a legacy
 * embedded receipt is its own verbatim copy and references none, and a
 * malformed stored receipt is a storage-integrity refusal that stops cleanup
 * and the physical GC — never silently absence.
 */
export function sqliteContentReferences(db: SorageSqlite): ContentReferences {
  return {
    domainReferencedRecordIds() {
      try {
        // The verified Artifact layout decides: a legitimate pre-adoption database has no
        // Artifact record references, while an adoption-version database missing
        // the required table or reference column is inconsistent and must
        // surface, never pass as empty (SHR-004, SHR-014).
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
        // The Memo layout is verified the same way: a schema-10 database whose
        // Memo table lost its reference column is inconsistent, while every
        // legitimate earlier layout contributes no Memo references.
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
        // The Channel layout is verified the same way: a legitimate pre-Channel
        // database contributes no Channel references, while a schema-11
        // database whose message table lost its reference column is
        // inconsistent and must surface, never pass as empty (SHR-004).
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
      // Memo-scope receipts are the one retained-response family that can
      // reference immutable records (SHR-008): a reference-form receipt names
      // its record, and a legacy embedded receipt references none. A malformed
      // stored receipt is a storage-integrity refusal — never absence, because
      // a broken parser result must never become deletion license.
      try {
        const rows = db
          .prepare("SELECT scope, response_json FROM idempotency_keys WHERE scope LIKE 'memo:%' AND expires_at > ?")
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
