import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import {
  type AppError,
  appError,
  type ArtifactBodyPrepareRequest,
  buildContentStorageKey,
  classifyContentIntentOwnership,
  classifyPreparedBody,
  classifyTextRouting,
  type Clock,
  CONTENT_INLINE_MAX_UTF8_BYTES,
  type ContentBodyHandle,
  type ContentBodyOpenPolicy,
  type ContentCleanupReport,
  type ContentLocalPathPolicy,
  type ContentOwnerDomain,
  contentOwnerFromStorageKey,
  type ContentRead,
  type ContentRecord,
  type ContentRecordRemovalPlan,
  type ContentReferences,
  type ContentStore,
  err,
  type IdGenerator,
  isUtf8ExactText,
  ok,
  planContentRecordRemoval,
  type PreparedArtifactBody,
  type Result,
  sanitizeStoredName,
  sha256OfBytes,
  sha256OfText,
  type StageContentRequest,
  type StagedContentFile,
  SystemClock,
  UuidGenerator,
  validateContentRecord,
  type WriteContentFileInput,
  type WriteContentOutcome,
  type WriteInlineInput,
  type WriteInlineOutcome,
} from "@sorage/core";
import {
  activateCommonFile,
  type CommonCompletion,
  type CommonExecutionOutcome,
  completeCommonIntentTx,
} from "./common-intent";
import {
  digestOfFd,
  disposeOpenedDescriptor,
  fileBodyHandle,
  inlineBodyHandle,
  preReadSource,
  readFileBounded,
  STREAM_BUFFER_BYTES,
  unreadableSource,
} from "./content-file-io";
import { validateArtifactContentLinks, validateChannelContentLinks, validateMemoContentLinks } from "./content-layout";
import { createSqliteEventLedger, type SqliteEventLedger } from "./events";
import { materializeFetchCacheFile } from "./fetch-cache";
import { vaultMoveLockHeld } from "./lockfile";
import { isSafeVaultRelativePath, managedFile, managedPath, managedRoot, openManagedFile } from "./managed-paths";
import type { SorageSqlite } from "./sqlite/connection";
import { liveFencePaused } from "./sqlite/move-fence";
import { runInTransaction } from "./sqlite/transaction";
import { openVault } from "./vault";

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
   * the filesystem, or appends an event.
   */
  removeContentRecordInTx(
    recordId: string,
    options: { references: ContentReferences; now: Date },
  ): Result<ContentRecordRemovalPlan, AppError>;
  /** Stages in-memory bytes directly into Vault staging under managed-path, Vault-guard, and move-fence checks. */
  stageBytes(request: {
    bytes: Uint8Array;
    maxBytes: number;
    tooLargeCode?: StageContentRequest["tooLargeCode"];
  }): Result<StagedContentFile, AppError>;
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

/**
 * The SQLite and filesystem content store behind the core port (SHR-001 to
 * SHR-006, SHR-008, SHR-011, section 38.1).
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

    stageBytes(request: {
      bytes: Uint8Array;
      maxBytes: number;
      tooLargeCode?: StageContentRequest["tooLargeCode"];
    }): Result<StagedContentFile, AppError> {
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      if (pausedNow()) return err(pauseError());
      const buffer = Buffer.isBuffer(request.bytes)
        ? request.bytes
        : Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
      return stageBytes(buffer, request.maxBytes, request.tooLargeCode ?? "ARTIFACT_TOO_LARGE");
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
      const committed = runInTransaction(
        db,
        "BEGIN IMMEDIATE",
        () => {
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
          return ok(undefined);
        },
        {
          checkFence: true,
          fenceError: (pid) =>
            appError(
              "SERVICE_PAUSED",
              "A Vault move or restore is in progress; the content commit paused instead of racing it.",
              { moveFencePid: pid },
            ),
          failure: (error) =>
            appError("INTERNAL_ERROR", `Committing the content record failed: ${messageOf(error)}.`, {
              contentId: input.contentId,
              cause: String(error),
            }),
        },
      );
      if (!committed.ok) return committed;
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
      return runInTransaction(
        db,
        "BEGIN IMMEDIATE",
        () => {
          insertRecordSql().run(
            record.id,
            Buffer.from(input.text, "utf8"),
            record.storageKey,
            record.sizeBytes,
            record.sha256,
            1,
            record.createdAt,
          );
          return ok({ recordId: record.id, sizeBytes, sha256: record.sha256 });
        },
        {
          checkFence: true,
          fenceError: (pid) =>
            appError(
              "SERVICE_PAUSED",
              "A Vault move or restore is in progress; the content commit paused instead of racing it.",
              { moveFencePid: pid },
            ),
          failure: (error) =>
            appError("INTERNAL_ERROR", `Committing the inline content record failed: ${messageOf(error)}.`, {
              contentId: input.contentId,
              cause: String(error),
            }),
        },
      );
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
      const bytesResult = readFileBounded(vaultPath, key, sizeBytes);
      if (!bytesResult.ok) return bytesResult;
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
      return runInTransaction(
        db,
        "BEGIN IMMEDIATE",
        () => {
          const report: ContentCleanupReport = { removedInlineIds: [], scheduledUnlinkIds: [], removedFileOnlyIds: [] };
          const livingLinks = validateArtifactContentLinks(db);
          if (!livingLinks.ok) return livingLinks;
          const livingMemoLinks = validateMemoContentLinks(db);
          if (!livingMemoLinks.ok) return livingMemoLinks;
          const livingChannelLinks = validateChannelContentLinks(db);
          if (!livingChannelLinks.ok) return livingChannelLinks;
          const domainIds = references.domainReferencedRecordIds();
          if (!domainIds.ok) return domainIds;
          const receiptIds = references.receiptReferencedRecordIds(now);
          if (!receiptIds.ok) return receiptIds;
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
            moveFencePaused: false,
          };
          const rows = db.prepare("SELECT * FROM content_records ORDER BY id").all() as unknown as ContentRow[];
          for (const row of rows) {
            const plan = planContentRecordRemoval(toRecord(row), proof);
            if (!plan.ok) return plan;
            if (plan.value.action === "retain") continue;
            if (plan.value.action === "remove-inline") {
              db.prepare("DELETE FROM content_records WHERE id = ?").run(row.id);
              report.removedInlineIds.push(row.id);
              continue;
            }
            const key = row.storage_key as string;
            if (plan.value.physicalUnlink === "owed-elsewhere") {
              db.prepare("DELETE FROM content_records WHERE id = ?").run(row.id);
              report.removedFileOnlyIds.push(row.id);
              continue;
            }
            const owner = contentOwnerFromStorageKey({ id: row.id, storageKey: key });
            if (!owner.ok) return owner;
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
          return ok(report);
        },
        {
          checkFence: true,
          fenceError: (pid) =>
            appError(
              "SERVICE_PAUSED",
              "A Vault move or restore is in progress; the cleanup paused instead of racing it.",
              { moveFencePid: pid },
            ),
          failure: (error) =>
            appError("INTERNAL_ERROR", `Reference-aware content cleanup failed: ${messageOf(error)}.`, {
              cause: String(error),
            }),
        },
      );
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
          stagingPath: join(vaultPath, "staging", basename(staged.value.stagingPath)),
          sizeBytes: staged.value.sizeBytes,
          sha256: staged.value.sha256,
          mimeType: routing.value.mimeType,
          storageKey: routing.value.storageKey,
          logicalName: request.body.logicalName,
          importedFromPath,
        });
      }
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
      const row = readContentRow(recordId);
      if (row === null) {
        return err(appError("CONTENT_CORRUPTED", "The referenced content record is missing.", { recordId }));
      }
      const domainReferenced =
        options.references.isDomainReferenced !== undefined
          ? options.references.isDomainReferenced(recordId)
          : (() => {
              const all = options.references.domainReferencedRecordIds();
              return all.ok ? ok(all.value.includes(recordId)) : all;
            })();
      if (!domainReferenced.ok) return domainReferenced;
      const receiptReferenced =
        options.references.isReceiptReferenced !== undefined
          ? options.references.isReceiptReferenced(recordId, options.now)
          : (() => {
              const all = options.references.receiptReferencedRecordIds(options.now);
              return all.ok ? ok(all.value.includes(recordId)) : all;
            })();
      if (!receiptReferenced.ok) return receiptReferenced;
      const hasPendingActivation = Boolean(
        db.prepare("SELECT 1 FROM pending_fs_ops WHERE op = 'activate' AND content_id = ? LIMIT 1").get(recordId),
      );
      const hasPendingToPath =
        row.storage_key !== null &&
        Boolean(
          db
            .prepare("SELECT 1 FROM pending_fs_ops WHERE op IN ('activate', 'unlink') AND to_path = ? LIMIT 1")
            .get(row.storage_key),
        );
      const plan = planContentRecordRemoval(toRecord(row), {
        domainReferencedRecordIds: domainReferenced.value ? new Set([recordId]) : new Set(),
        receiptReferencedRecordIds: receiptReferenced.value ? new Set([recordId]) : new Set(),
        pendingCommonActivationContentIds: hasPendingActivation ? new Set([recordId]) : new Set(),
        pendingPhysicalToPaths: hasPendingToPath && row.storage_key !== null ? new Set([row.storage_key]) : new Set(),
        moveFencePaused: false,
      });
      if (!plan.ok) return plan;
      if (plan.value.action === "remove-record" && plan.value.physicalUnlink === "common-intent") {
        const owner = contentOwnerFromStorageKey({ id: row.id, storageKey: row.storage_key as string });
        if (!owner.ok) return owner;
      }
      if (plan.value.action !== "retain") {
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
    let created = false;
    let committed = false;
    try {
      stagingPath = managedPath(vaultPath, relative(vaultPath, stagingPath));
      staged = openSync(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
      created = true;
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
      committed = true;
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
      if (created && !committed) {
        try {
          const partial = managedFile(vaultPath, relative(managedRoot(vaultPath), stagingPath));
          if (partial.stat !== undefined) unlinkSync(partial.path);
        } catch {
          // Best effort cleanup; the staging sweep after the grace window removes any survivor.
        }
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
