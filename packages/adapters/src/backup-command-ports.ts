import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ChannelContentFileExport,
  SnapshotChannelMessage,
  SnapshotChannelParticipant,
  SnapshotChannelShard,
} from "@sorage/core";
import {
  type AppError,
  appError,
  type BackupCensus,
  type BackupExportPorts,
  type BackupRestorePorts,
  type BackupRunRow,
  type BackupVerifyPorts,
  buildContentStorageKey,
  canonicalJson,
  canonicalJsonLine,
  channelContentFilePath,
  channelIdFromSnapshotPath,
  type DrainReport,
  ensureVaultGitRepository,
  err,
  expandConfigurationPath,
  exportSnapshot,
  type GitClient,
  isManagedContentStorageKey,
  isMemoUuid,
  legacyReportingEvidence,
  type Memo,
  type MemoContentFileExport,
  memoContentFilePath,
  nextDueAt,
  ok,
  parseChannelSnapshotShard,
  parseMemoSnapshot,
  parseMemoSnapshotV3,
  parseUniqueSnapshotJson,
  parseVaultMarker,
  parseVersionedSnapshotManifest,
  proveChannelContentBytes,
  type Result,
  type SnapshotArtifact,
  type SnapshotArtifactV3,
  type SnapshotData,
  type SnapshotDataV3,
  type SnapshotDataV4,
  type SnapshotDeletionRequest,
  type SnapshotEvent,
  type SnapshotFile,
  type SnapshotHandoff,
  type SnapshotHandoffV3,
  type SnapshotHandoffV4,
  type SnapshotMemoV3,
  type SnapshotProcessingEvidence,
  type SnapshotProject,
  type SnapshotReadEvidence,
  type SnapshotRecipientComment,
  sha256OfText,
  USER_ACTOR,
  upgradeSnapshotHandoff,
  type VaultGitOutcome,
  type VaultMarker,
  validateSnapshot,
  verifyVaultArtifacts,
} from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import { type ConfigStore, createConfigStore } from "./config-store";
import {
  createSqliteContentStore,
  receiptReferencedContentKeys,
  sqliteContentReferences,
  sweepFetchCache,
  validateArtifactContentLinks,
  validateChannelContentLinks,
  validateMemoContentLinks,
} from "./content-store";
import { createSqliteEventLedger } from "./events";
import { createNodeGitClient } from "./git-client";
import { createHomePaths, type HomeEnvironment } from "./home";
import { collectVaultGarbage, createSqliteIntentLog, fsyncDirectory } from "./intent-log";
import { acquireLock, createNodeLockProbePorts, evaluateStaleness, isPidAlive, parseLockRecord } from "./lockfile";
import { digestManagedFile, managedPath, managedRoot, openManagedFile } from "./managed-paths";
import { readMemoSnapshotFiles, readSnapshotBytes } from "./memo-snapshot-files";
import {
  insertMemoWithFileRecordRows,
  insertMemoWithInlineRecord,
  type MemoContentReference,
  placeMemoContentFile,
  readMemoContentFileBytes,
  readMemoExport,
} from "./memos";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";

/**
 * Places one file-backed Channel message body's exact carried bytes at a fresh
 * private `content/channel/<channelId>/<recordId>` managed key in the Vault,
 * following the identical durability and managed-path discipline as the Memo
 * content restore: the key is validated by the shared core builder, the path
 * is resolved through `managedPath` (rejecting ancestor symlinks and unsafe
 * roots), the file is written exclusively with O_EXCL + O_NOFOLLOW, set
 * read-only with fchmod 0444, fsync'd, every ancestor directory up to the
 * canonical managed root is fsync'd, the placed file's identity is read back
 * and compared against the source bytes, and a failure cleans the owned file
 * (CHN-009, SHR-004, SHR-005).
 */
function placeChannelContentFile(
  vaultPath: string,
  channelId: string,
  recordId: string,
  bytes: Uint8Array,
): Result<{ storageKey: string; sizeBytes: number; sha256: string }, AppError> {
  const key = buildContentStorageKey({ domain: "channel", ownerId: channelId, contentId: recordId });
  if (!key.ok) return key;
  const storageKey = key.value;
  if (!isManagedContentStorageKey(storageKey)) {
    return err(appError("INTERNAL_ERROR", "The Channel content restore target is not a managed key", { storageKey }));
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
    // Read back the placed file and verify its identity against the source.
    const identity = digestManagedFile(vaultPath, storageKey);
    const expectedDigest = createHash("sha256").update(bytes).digest("hex");
    if (identity.sizeBytes !== bytes.byteLength || identity.sha256 !== expectedDigest) {
      throw new Error("The placed Channel body changed identity");
    }
    return ok({ storageKey, ...identity });
  } catch {
    if (owned && destination !== undefined) {
      try {
        rmSync(destination, { force: true });
      } catch {
        /* Owned survivor remains unreachable. */
      }
    }
    return err(appError("INTERNAL_ERROR", "The Channel content restore file could not be placed", { channelId }));
  }
}

import { createNodeApiTokenStore } from "./token-store";
import { createVaultInitializer, openVault } from "./vault";
import { createNodeVaultCommandPorts } from "./vault-command-ports";

const COPY_BUFFER_BYTES = 1024 * 1024;
const ARTIFACT_MODE = 0o444;

export interface NodeBackupCommandPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /** The literal `--from <path>` of a restore, expanded for reading. */
  sourcePath?: string | undefined;
  clock?: { now(): Date } | undefined;
  /** Test seam for the fault-injection Git adapter the backup tests wrap (BKP-013). */
  gitClient?: GitClient | undefined;
}

export interface NodeBackupCommandPorts {
  exportPorts(): Result<BackupExportPorts, AppError>;
  restorePorts(): Result<BackupRestorePorts, AppError>;
  verifyPorts(): Result<BackupVerifyPorts, AppError>;
  runPorts(
    triggeredBy?: "manual" | "scheduled" | "catch-up",
  ): Result<import("@sorage/core").BackupRunCommandPorts, AppError>;
  statusPorts(): Result<import("@sorage/core").BackupStatusPorts, AppError>;
  /** The RUN-002 process-start obligation every backup command runs first. */
  drainAtStart(): Result<DrainReport, AppError>;
}

interface InstallationView {
  vaultPath: string;
  installationId: string;
  etag: string;
  redactWorkspacePaths: boolean;
  graceHours: number;
  /** The `gitBackup.push.branch` the Vault repository must sit on (section 31). */
  backupBranch: string;
  /** The `gitBackup.commit.messageTemplate` (BKP-010). */
  commitMessageTemplate: string;
  /** The `gitBackup.schedule` snapshot status reports (BKP-016). */
  schedule: { enabled: boolean; at: string; timezone: string; catchUpAfterMissedRun: boolean };
  /** The `gitBackup.push` settings the run engine pushes with (BKP-011, BKP-025). */
  push: { enabled: boolean; remote: string; branch: string };
}

/**
 * The production backup ports over one installation (TASK-052): the snapshot
 * reader runs inside one consistent SQLite read transaction, the snapshot tree
 * is replaced atomically through a staged sibling directory, and the restore
 * importer holds `vault-move.lock` while it adopts the source marker's
 * identity, rebuilds the rows verbatim in one write transaction, and
 * regenerates the API token.
 */
export function createNodeBackupCommandPorts(options: NodeBackupCommandPortsOptions = {}): NodeBackupCommandPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const clock = options.clock ?? { now: () => new Date() };
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const gitClient = options.gitClient ?? createNodeGitClient();
  const store: ConfigStore = createConfigStore({
    home,
    lockPorts: createNodeLockProbePorts(clock),
    userHome,
  });

  function installation(): Result<InstallationView, AppError> {
    const read = store.read();
    if (!read.ok) return err(read.error);
    if (read.value === null) {
      return err(
        appError("NOT_INITIALIZED", `Sorage is not initialized; expected configuration file: ${home.configFile}`, {
          expectedConfigPath: home.configFile,
        }),
      );
    }
    const config = read.value.config;
    return ok({
      vaultPath: expandConfigurationPath(config.vault.path, userHome, home.home),
      installationId: config.installationId,
      etag: read.value.etag,
      redactWorkspacePaths: config.gitBackup.snapshot.redactWorkspacePaths,
      graceHours: config.gc.graceHours,
      backupBranch: config.gitBackup.push.branch,
      commitMessageTemplate: config.gitBackup.commit.messageTemplate,
      push: {
        enabled: config.gitBackup.push.enabled,
        remote: config.gitBackup.push.remote,
        branch: config.gitBackup.push.branch,
      },
      schedule: {
        enabled: config.gitBackup.enabled,
        at: config.gitBackup.schedule.at,
        timezone: config.gitBackup.schedule.timezone,
        catchUpAfterMissedRun: config.gitBackup.schedule.catchUpAfterMissedRun,
      },
    });
  }

  function withDatabase<T>(
    body: (db: ReturnType<typeof openAndMigrate>["db"]) => Result<T, AppError>,
  ): Result<T, AppError> {
    try {
      const plan = productionMigrationPlan();
      const migrated = openAndMigrate(join(home.stateDir, "sorage.sqlite3"), plan.migrations, {
        rebuilds: plan.rebuilds,
      });
      try {
        return body(migrated.db);
      } finally {
        migrated.db.close();
      }
    } catch (error) {
      // A schema admission refusal keeps its public code instead of collapsing
      // into INTERNAL_ERROR (SHR-009).
      const admission = asSchemaAdmission(error);
      if (admission !== null) return err(admission);
      return err(
        appError("INTERNAL_ERROR", `Accessing the database failed: ${messageOf(error)}.`, { cause: String(error) }),
      );
    }
  }

  /** One file-backed Channel message's content reference for the export. */
  interface ChannelContentReference {
    channelId: string;
    seq: number;
    contentId: string;
    contentPath: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  }

  /**
   * Reads every Channel with its complete participant roster and all messages
   * as their routed format-3 export records (CHN-009, section 38.8, ADR-0034).
   * The wire `BodyContent` union carries exactly `inline` or the file-backed
   * triple — no internal discriminator — and the file-backed form's raw bytes
   * are carried as snapshot content files digested in `contentDigests`. An
   * unmaterialized file-backed current body fails the export closed with
   * `CONTENT_MATERIALIZING`.
   */
  function readChannelExport(
    db: SorageSqlite,
  ): Result<{ channels: SnapshotChannelShard[]; contentFiles: ChannelContentReference[] }, AppError> {
    try {
      const channels: SnapshotChannelShard[] = [];
      const contentFiles: ChannelContentReference[] = [];
      const channelRows = db.prepare("SELECT * FROM channels ORDER BY id").all() as unknown as Array<
        Record<string, unknown>
      >;
      for (const channelRow of channelRows) {
        const channelId = channelRow.id as string;
        const participants: SnapshotChannelParticipant[] = (
          db
            .prepare("SELECT * FROM channel_participants WHERE channel_id = ? ORDER BY handle COLLATE BINARY")
            .all(channelId) as unknown as Array<Record<string, unknown>>
        ).map((row) => ({
          handle: row.handle as string,
          role: row.role as SnapshotChannelParticipant["role"],
          addedAt: row.added_at as string,
          removedAt: (row.removed_at as string | null) ?? null,
        }));
        const main = participants.find((participant) => participant.role === "main");
        const messages: SnapshotChannelMessage[] = [];
        const messageRows = db
          .prepare(
            `SELECT m.*, c.inline_text AS c_inline_text, c.storage_key AS c_storage_key,
               c.size_bytes AS c_size_bytes, c.sha256 AS c_sha256, c.materialized AS c_materialized
             FROM channel_messages m JOIN content_records c ON c.id = m.content_record_id
             WHERE m.channel_id = ? ORDER BY m.seq`,
          )
          .all(channelId) as unknown as Array<Record<string, unknown>>;
        for (const row of messageRows) {
          const inlineText = row.c_inline_text as string | null;
          const contentId = row.content_record_id as string;
          let bodyContent: SnapshotChannelMessage["bodyContent"];
          if (inlineText !== null) {
            bodyContent = { inline: inlineText };
          } else {
            if (row.c_materialized === 0) {
              return err(
                appError(
                  "CONTENT_MATERIALIZING",
                  `Channel ${channelId} message ${String(row.seq)} is waiting for its committed activation`,
                ),
              );
            }
            const contentPath = channelContentFilePath(channelId, contentId);
            if (!contentPath.ok) {
              return err(
                appError(
                  "STORAGE_INTEGRITY_ERROR",
                  `Channel ${channelId} message ${String(row.seq)} carries a noncanonical content identity.`,
                  { channelId, contentId },
                ),
              );
            }
            bodyContent = {
              contentPath: contentPath.value,
              sizeBytes: row.c_size_bytes as number,
              sha256: row.c_sha256 as string,
            };
            contentFiles.push({
              channelId,
              seq: Number(row.seq),
              contentId,
              contentPath: contentPath.value,
              sizeBytes: row.c_size_bytes as number,
              sha256: row.c_sha256 as string,
              storageKey: row.c_storage_key as string,
            });
          }
          messages.push({
            seq: Number(row.seq),
            senderHandle: row.sender_handle as string,
            kind: row.kind as SnapshotChannelMessage["kind"],
            toHandle: (row.to_handle as string | null) ?? null,
            ref: (row.ref as string | null) ?? null,
            bodyContent,
            handled: row.handled === 1,
            handledAt: (row.handled_at as string | null) ?? null,
            handleNote: (row.handle_note as string | null) ?? null,
            createdAt: row.created_at as string,
          });
        }
        channels.push({
          id: channelId,
          name: channelRow.name as string,
          title: (channelRow.title as string | null) ?? null,
          state: (channelRow.state === "closed" ? "closed" : "open") as SnapshotChannelShard["state"],
          main: main === undefined ? "" : main.handle,
          createdAt: channelRow.created_at as string,
          closedAt: (channelRow.closed_at as string | null) ?? null,
          participants,
          messages,
        });
      }
      return ok({ channels, contentFiles });
    } catch (error) {
      return err(
        appError("INTERNAL_ERROR", `Reading the Channels for export failed: ${messageOf(error)}.`, {
          cause: String(error),
        }),
      );
    }
  }

  /**
   * Reads each file-backed Channel message reference's exact raw Vault bytes
   * through the managed-path safety seams after the consistent export read
   * commits (CHN-009, SHR-010, W1): a guarded managed open that refuses
   * symlinked or unsafe files, a full read whose digest, size, and
   * modification time are re-verified against the opened handle with no extra
   * byte behind it, and the whole-bytes semantic proof — fatal UTF-8,
   * NUL-free, and nonempty after trimming — so a valid size and digest alone
   * never substitutes for the domain's body rules. The carried bytes stay
   * verbatim: a byte-order mark, CRLF, and the presence or absence of a final
   * newline are preserved exactly.
   */
  function readChannelContentFileBytes(
    vaultPath: string,
    references: ChannelContentReference[],
  ): Result<ChannelContentFileExport[], AppError> {
    const carried: ChannelContentFileExport[] = [];
    for (const reference of references) {
      if (!isManagedContentStorageKey(reference.storageKey)) {
        return err(
          appError(
            "STORAGE_INTEGRITY_ERROR",
            `The Channel content reference for ${reference.channelId} message ${String(reference.seq)} is not a managed key.`,
            {
              channelId: reference.channelId,
              seq: reference.seq,
            },
          ),
        );
      }
      try {
        const handle = openManagedFile(vaultPath, reference.storageKey);
        try {
          const stat = fstatSync(handle);
          if (stat.size !== reference.sizeBytes)
            return err(appError("VAULT_INTEGRITY_ERROR", "A Channel content file disagrees with its recorded size."));
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
                `The Channel content file for ${reference.channelId} message ${String(reference.seq)} changed while being read.`,
                {
                  channelId: reference.channelId,
                  seq: reference.seq,
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
            readSync(handle, extra, 0, 1, null) !== 0
          ) {
            return err(
              appError("VAULT_INTEGRITY_ERROR", "A Channel content file disagrees with its recorded digest.", {
                storageKey: reference.storageKey,
              }),
            );
          }
          const proof = proveChannelContentBytes(buffer);
          if (!proof.ok) return proof;
          carried.push({ channelId: reference.channelId, contentId: reference.contentId, bytes: buffer });
        } finally {
          closeSync(handle);
        }
      } catch (error) {
        return err(
          appError(
            "STORAGE_INTEGRITY_ERROR",
            `A Channel content file could not be read from the Vault: ${messageOf(error)}.`,
            {
              storageKey: reference.storageKey,
            },
          ),
        );
      }
    }
    return ok(carried);
  }

  /** Reads the complete snapshot set inside one consistent read transaction (BKP-007). */
  function readSnapshotData(): Result<SnapshotDataV4, AppError> {
    return withDatabase((db) => {
      try {
        db.exec("BEGIN");
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Beginning the snapshot read failed: ${messageOf(error)}.`));
      }
      // The shared content-link guard runs inside this consistent read
      // transaction, before any joined projection and before a snapshot tree
      // can be written: an Artifact whose authoritative record row is missing
      // fails the export here with an explicit rollback — a later checksum
      // gate alone would be too late and the INNER JOIN would have silently
      // omitted the broken Artifact from the snapshot (SHR-004, BKP-023).
      const links = validateArtifactContentLinks(db);
      if (!links.ok) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The read transaction may already have been rolled back; the guard
          // error is the primary report.
        }
        return links;
      }
      let data: Result<SnapshotDataV4, AppError>;
      let pendingContentFiles: MemoContentReference[] = [];
      let pendingChannelContentFiles: ChannelContentReference[] = [];
      try {
        const projects = db.prepare("SELECT * FROM projects ORDER BY id").all() as unknown as Row[];
        const bindings = db.prepare("SELECT * FROM project_bindings ORDER BY id").all() as unknown as Row[];
        const handoffs = db.prepare("SELECT * FROM handoffs ORDER BY id").all() as unknown as Row[];
        const artifacts = db
          .prepare(
            "SELECT a.id AS id, a.handoff_id AS handoff_id, a.original_name AS original_name, a.stored_name AS stored_name, a.mime_type AS mime_type, a.imported_from_path AS imported_from_path, a.created_at AS created_at, c.inline_text AS inline_text, c.storage_key AS storage_key, c.size_bytes AS size_bytes, c.sha256 AS sha256, c.materialized AS materialized FROM artifacts a JOIN content_records c ON c.id = a.content_record_id ORDER BY a.id",
          )
          .all() as unknown as Row[];
        const reviewNotes = db.prepare("SELECT * FROM review_notes ORDER BY handoff_id").all() as unknown as Row[];
        const deletionRequests = db.prepare("SELECT * FROM deletion_requests ORDER BY id").all() as unknown as Row[];
        const events = db.prepare("SELECT * FROM events ORDER BY created_at, id").all() as unknown as Row[];
        // The consistent export guard runs before the Memo read: a schema-10
        // database whose Memo links are broken must fail the export loudly,
        // never produce a silently reduced or empty Memo inventory.
        const memoLinks = validateMemoContentLinks(db);
        if (!memoLinks.ok) {
          db.exec("ROLLBACK");
          return memoLinks;
        }
        // The Channel link guard joins the consistent export read under the
        // same rule: a schema-11 database whose message rows lost their record
        // references fails the export loudly, never a silently reduced or
        // empty inventory over broken links (SHR-004, the TASK-109 plan).
        const channelLinks = validateChannelContentLinks(db);
        if (!channelLinks.ok) {
          db.exec("ROLLBACK");
          return channelLinks;
        }
        const memosResult = readMemoExport(db);
        if (!memosResult.ok) {
          db.exec("ROLLBACK");
          return memosResult;
        }
        // The Channel export: every Channel with its complete rosters, all
        // assignments, and all messages with their content-record identity
        // (CHN-009, section 38.8). An unmaterialized file-backed current body
        // fails the export closed: the snapshot cannot carry bytes the Vault
        // has not yet placed at the managed key, and guessing or discarding
        // the message would violate the exact-bytes contract.
        const channelsResult = readChannelExport(db);
        if (!channelsResult.ok) {
          db.exec("ROLLBACK");
          return channelsResult;
        }
        // Only rows were read inside the transaction; the file-backed bodies'
        // bytes are read from the Vault AFTER the snapshot read commits, so
        // no filesystem I/O rides the read transaction (W1, SHR-012).
        pendingContentFiles = memosResult.value.contentFiles;
        pendingChannelContentFiles = channelsResult.value.contentFiles;
        data = ok({
          ...mapSnapshotData({ projects, bindings, handoffs, artifacts, reviewNotes, deletionRequests, events }),
          memos: memosResult.value.memos,
          channels: channelsResult.value.channels,
        });
      } catch (error) {
        db.exec("ROLLBACK");
        return err(
          appError("INTERNAL_ERROR", `Reading the snapshot rows failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
      db.exec("COMMIT");
      if (pendingContentFiles.length > 0 || pendingChannelContentFiles.length > 0) {
        const configRead = store.read();
        if (!configRead.ok || configRead.value === null) {
          return err(appError("NOT_INITIALIZED", "Sorage is not initialized."));
        }
        const vaultPath = expandConfigurationPath(configRead.value.config.vault.path, userHome, home.home);
        if (pendingContentFiles.length > 0) {
          const memoFilesResult = readMemoContentFileBytes(vaultPath, pendingContentFiles);
          if (!memoFilesResult.ok) return memoFilesResult;
          if (data.ok) {
            data = ok({ ...data.value, memoContentFiles: memoFilesResult.value });
          }
        }
        // Channel content file bytes are read from the Vault after the
        // consistent read commits: each file-backed message body's exact raw
        // bytes at its managed storage key, digest-verified and semantically
        // proven over the whole bytes (CHN-009, SHR-010, W1).
        if (pendingChannelContentFiles.length > 0 && data.ok) {
          const channelContentFiles = readChannelContentFileBytes(vaultPath, pendingChannelContentFiles);
          if (!channelContentFiles.ok) return channelContentFiles;
          data = ok({ ...data.value, channelContentFiles: channelContentFiles.value });
        }
      }
      return data;
    });
  }

  /**
   * Replaces `<vault>/snapshots` atomically: the new tree is staged under a
   * process-private sibling, the previous tree is moved aside, the staged tree
   * takes its place, and the aside copy is removed. Scratch either side of the
   * swap left by a crashed export is cleared first, so a retry converges and no
   * stray directory escapes the managed `snapshots` pathspec (BKP-008).
   */
  function writeSnapshotTree(vaultPath: string) {
    return (files: SnapshotFile[]): Result<void, AppError> => {
      const root = join(vaultPath, "snapshots");
      const staging = join(vaultPath, `.snapshots.tmp-${process.pid}`);
      const aside = join(vaultPath, `.snapshots.old-${process.pid}`);
      try {
        for (const name of readdirSync(vaultPath)) {
          if (name.startsWith(".snapshots.tmp-") || name.startsWith(".snapshots.old-")) {
            rmSync(join(vaultPath, name), { recursive: true, force: true });
          }
        }
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true });
        for (const file of files) {
          const destination = join(staging, file.path);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, file.content, { flag: "wx" });
          const handle = openSync(destination, "r");
          try {
            fsyncSync(handle);
          } finally {
            closeSync(handle);
          }
        }
        const hadPrevious = existsSync(root);
        if (hadPrevious) renameSync(root, aside);
        try {
          renameSync(staging, root);
        } catch (error) {
          if (hadPrevious) renameSync(aside, root);
          throw error;
        }
        if (hadPrevious) rmSync(aside, { recursive: true, force: true });
        fsyncDirectory(vaultPath);
        return ok(undefined);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Writing the snapshot tree failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    };
  }

  /** backup.lock; a live holder refuses the run with BACKUP_IN_PROGRESS (BKP-006). */
  function acquireBackupLock(): Result<{ release: () => void }, AppError> {
    const acquired = acquireLock({
      path: home.lockFile("backup"),
      lock: "backup",
      ports: createNodeLockProbePorts(clock),
    });
    if (acquired.ok) return ok({ release: acquired.release });
    return err(
      appError(
        "BACKUP_IN_PROGRESS",
        `A backup run already holds backup.lock (pid ${String(acquired.error.record?.pid)}); this run refused instead of racing it.`,
        { lockPath: home.lockFile("backup") },
      ),
    );
  }

  /** The recorded current Artifacts the run verifies before it commits (VLT-023). */
  function recordedArtifactPairs(): Result<Array<{ storageKey: string; sha256: string }>, AppError> {
    return withDatabase((db) => {
      // The same relationship guard protects the pre-commit checksum gate: a
      // missing authoritative record must fail verification, not vanish from
      // the INNER JOIN (SHR-004, VLT-023).
      const links = validateArtifactContentLinks(db);
      if (!links.ok) return links;
      // Inline rows join the same gate: their exact stored text must digest to
      // the recorded SHA-256 before the backup commits (SHR-003, SHR-010).
      const inline = db
        .prepare(
          "SELECT c.inline_text AS inline_text, c.sha256 AS sha256 FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE c.inline_text IS NOT NULL",
        )
        .all() as unknown as Array<{ inline_text: string; sha256: string }>;
      for (const row of inline) {
        if (sha256OfText(row.inline_text) !== row.sha256.toLowerCase()) {
          return err(
            appError(
              "ARTIFACT_CORRUPTED",
              "An inline current Artifact body does not match its recorded checksum; the backup run refuses to commit.",
              { recorded: row.sha256 },
            ),
          );
        }
      }
      const rows = db
        .prepare(
          "SELECT c.storage_key AS storage_key, c.sha256 AS sha256 FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE c.materialized = 1 AND c.storage_key IS NOT NULL",
        )
        .all() as unknown as Array<{ storage_key: string; sha256: string }>;
      return ok(rows.map((row) => ({ storageKey: row.storage_key, sha256: row.sha256 })));
    });
  }

  function acquireVaultMoveLock(): Result<{ release: () => void }, AppError> {
    const acquired = acquireLock({
      path: home.lockFile("vault-move"),
      lock: "vault-move",
      ports: createNodeLockProbePorts(clock),
    });
    if (acquired.ok) return ok({ release: acquired.release });
    return err(
      appError(
        "SERVICE_PAUSED",
        `A Vault move or restore is in progress (vault-move.lock held by pid ${String(
          acquired.error.record?.pid,
        )}); this operation paused instead of racing it.`,
        { lockPath: home.lockFile("vault-move") },
      ),
    );
  }

  /** A daemon holds its lifetime lock while running; a live record means restore must refuse (section 32). */
  function daemonRunning(): Result<boolean, AppError> {
    try {
      const text = readLockText(home.lockFile("daemon"));
      if (text === null) return ok(false);
      const verdict = evaluateStaleness("daemon", parseLockRecord(text), clock.now(), isPidAlive);
      return ok(!verdict.stale);
    } catch (error) {
      return err(
        appError("INTERNAL_ERROR", `Probing the daemon lock failed: ${messageOf(error)}.`, { cause: String(error) }),
      );
    }
  }

  function readSourceFile(sourcePath: string, relativePath: string): Result<string, AppError> {
    try {
      // The existing Vault marker keeps its format-1 reader and diagnostic contract.
      if (relativePath === ".sorage-vault.json") return ok(readFileSync(join(sourcePath, relativePath), "utf8"));
      const read = readSnapshotBytes(sourcePath, relativePath);
      if (!read.ok) return read;
      return ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.value));
    } catch (error) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The backup copy does not contain ${relativePath}: ${messageOf(error)}.`, {
          sourcePath,
          relativePath,
        }),
      );
    }
  }

  function readSourceSnapshot(sourcePath: string) {
    return (): Result<SnapshotData | SnapshotDataV3 | SnapshotDataV4, AppError> => {
      const manifest = readSourceManifest(sourcePath)();
      if (!manifest.ok) return manifest;
      const channels = snapshotTreeFiles(join(sourcePath, "snapshots", "channels"));
      if (!channels.ok) return channels;
      const content = snapshotTreeFiles(join(sourcePath, "snapshots", "content"));
      if (!content.ok) return content;
      const contentDigests =
        manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4 ? manifest.value.contentDigests : {};
      if (manifest.value.formatVersion !== 3 && manifest.value.formatVersion !== 4 && content.value.length !== 0)
        return err(appError("VAULT_INTEGRITY_ERROR", "A legacy snapshot carries unexpected content files"));
      /** Read one carried content file's exact bytes; the map's digests were already shape-checked. */
      const readContentFile = (relative: string): Result<Uint8Array, AppError> => {
        const read = readSnapshotBytes(join(sourcePath, "snapshots"), relative);
        if (!read.ok) return err(read.error);
        const entry = contentDigests[relative];
        if (entry === undefined || createHash("sha256").update(read.value).digest("hex") !== entry) {
          return err(
            appError(
              "VAULT_INTEGRITY_ERROR",
              `The carried content file ${relative} disagrees with its manifest digest.`,
              {
                relative,
              },
            ),
          );
        }
        return ok(read.value);
      };
      if (manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) {
        // The content-file inventory must agree with the map exactly: a file
        // the map omits, a map key with no regular file, or a non-Memo content
        // path this build cannot faithfully import is refused before adoption.
        const contentNames = new Set(content.value.map((file) => `content/${file}`));
        const mapKeys = Object.keys(manifest.value.contentDigests);
        if (
          mapKeys.some((key) => !contentNames.has(key)) ||
          [...contentNames].some((name) => !(name in contentDigests))
        ) {
          return err(
            appError(
              "VAULT_INTEGRITY_ERROR",
              "The snapshot's exported content files disagree with its content digest inventory",
            ),
          );
        }
        for (const key of mapKeys) {
          if (!/^content\/(memo|channel)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) {
            return err(
              appError(
                "VAULT_SCHEMA_UNSUPPORTED",
                "The snapshot carries shared content outside the Memo and Channel content families this build cannot import",
              ),
            );
          }
        }
      }
      const memoFiles = readMemoSnapshotFiles(sourcePath, manifest.value);
      if (!memoFiles.ok) return memoFiles;
      const memos: Memo[] = [];
      const memoExports: SnapshotMemoV3[] = [];
      const memoContentFiles: MemoContentFileExport[] = [];
      for (const file of memoFiles.value) {
        if (manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) {
          const parsed = parseMemoSnapshotV3(file.path, file.bytes, file.digest);
          if (!parsed.ok) return parsed;
          const imported = parsed.value;
          if (imported.bodyContent.kind === "inline") {
            memoExports.push({ ...imported.meta, bodyContent: { kind: "inline", text: imported.bodyContent.text } });
          } else {
            // The file-backed form: the carried content file must exist, match
            // the shard's recorded size and digest, and live under this Memo's
            // own identity path; the metadata is validated independently of the carried body.
            const contentPath = imported.bodyContent.contentPath;
            const canonicalContentPath = memoContentFilePath(imported.meta.id, contentPath.split("/")[3] as string);
            if (!canonicalContentPath.ok || canonicalContentPath.value !== contentPath) {
              return err(
                appError(
                  "VAULT_INTEGRITY_ERROR",
                  `The Memo shard names a content file outside its own identity path.`,
                  {
                    memoId: imported.meta.id,
                  },
                ),
              );
            }
            const bytes = readContentFile(contentPath);
            if (!bytes.ok) return bytes;
            if (bytes.value.byteLength !== imported.bodyContent.sizeBytes) {
              return err(
                appError(
                  "VAULT_INTEGRITY_ERROR",
                  `The carried content file for Memo ${imported.meta.id} disagrees with its recorded size.`,
                ),
              );
            }
            const contentId = contentPath.split("/")[3] as string;
            memoContentFiles.push({ memoId: imported.meta.id, contentId, bytes: bytes.value });
            memoExports.push({
              ...imported.meta,
              bodyContent: {
                kind: "file-backed",
                contentPath,
                sizeBytes: imported.bodyContent.sizeBytes,
                sha256: imported.bodyContent.sha256,
              },
            });
          }
        } else {
          const parsed = parseMemoSnapshot(file.path, file.bytes, file.digest);
          if (!parsed.ok) return parsed;
          memos.push(parsed.value);
        }
      }
      const projectsRaw = readSourceFile(sourcePath, "snapshots/projects.json");
      if (!projectsRaw.ok) return err(projectsRaw.error);
      const projects =
        manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4
          ? parseUniqueSnapshotJson(projectsRaw.value)
          : parseJsonArray(projectsRaw.value, "snapshots/projects.json");
      if (!projects.ok) return err(projects.error);
      if (
        !Array.isArray(projects.value) ||
        ((manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) &&
          canonicalJson(projects.value) !== projectsRaw.value)
      )
        return err(appError("VAULT_INTEGRITY_ERROR", "The snapshot Project metadata is not a canonical array."));

      const shardFiles: string[] = [];
      const shardsRoot = join(sourcePath, "snapshots/handoffs");
      // Format 3 parses its distinct V3 records; formats 1 and 2 keep their
      // frozen legacy shapes and readers.
      const legacyHandoffs: SnapshotHandoff[] = [];
      const v3Handoffs: SnapshotHandoffV3[] = [];
      const v4Handoffs: SnapshotHandoffV4[] = [];
      if (manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) {
        const files = snapshotTreeFiles(shardsRoot);
        if (!files.ok) return files;
        shardFiles.push(...files.value.map((file) => `handoffs/${file}`));
      } else
        try {
          for (const shard of existsSync(shardsRoot) ? readdirSync(shardsRoot) : []) {
            const shardPath = join(shardsRoot, shard);
            if (!statSync(shardPath).isDirectory()) continue;
            for (const name of readdirSync(shardPath)) {
              if (name.endsWith(".json")) shardFiles.push(`handoffs/${shard}/${name}`);
            }
          }
        } catch (error) {
          return err(
            appError("VAULT_INTEGRITY_ERROR", `The backup copy has no readable handoff shards: ${messageOf(error)}.`, {
              sourcePath,
            }),
          );
        }
      shardFiles.sort();
      for (const shardFile of shardFiles) {
        const raw = readSourceFile(sourcePath, `snapshots/${shardFile}`);
        if (!raw.ok) return err(raw.error);
        // Format 3 parses its Handoff shards with the duplicate-key-rejecting
        // parser of the Memo contract, over the same safe bounded reader the
        // memo shards use; formats 1 and 2 keep their existing parser and rules.
        const parsed =
          manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4
            ? parseUniqueSnapshotJson(raw.value)
            : parseJsonObject(raw.value, `snapshots/${shardFile}`);
        if (!parsed.ok) return parsed;
        const value = parsed.value;
        if (
          (manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) &&
          canonicalJson(value) !== raw.value
        ) {
          return err(
            appError("VAULT_INTEGRITY_ERROR", `The handoff shard ${shardFile} does not carry canonical bytes.`),
          );
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return err(
            appError("VAULT_INTEGRITY_ERROR", `The backup entry snapshots/${shardFile} is not a JSON object.`),
          );
        }
        const handoff =
          manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4
            ? (value as unknown as SnapshotHandoffV3)
            : (value as unknown as SnapshotHandoff);
        if ((manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) && !isMemoUuid(handoff.id)) {
          return err(appError("VAULT_INTEGRITY_ERROR", "The format-3 handoff shard does not carry a valid UUID."));
        }
        const expected = `${handoff.id}.json`;
        if (
          manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4
            ? typeof handoff.id !== "string" || shardFile !== `handoffs/${handoff.id.slice(0, 2)}/${expected}`
            : !shardFile.endsWith(`/${expected}`)
        ) {
          return err(
            appError(
              "VAULT_INTEGRITY_ERROR",
              `The handoff shard ${shardFile} does not match the handoff id it carries (${handoff.id}).`,
              { sourcePath, shardFile },
            ),
          );
        }
        if (manifest.value.formatVersion === 4) v4Handoffs.push(value as unknown as SnapshotHandoffV4);
        else if (manifest.value.formatVersion === 3) v3Handoffs.push(value as unknown as SnapshotHandoffV3);
        else legacyHandoffs.push(value as unknown as SnapshotHandoff);
      }

      const eventsRaw = readSourceFile(sourcePath, "snapshots/events.jsonl");
      if (!eventsRaw.ok) return err(eventsRaw.error);
      const events: SnapshotEvent[] = [];
      for (const [index, line] of eventsRaw.value.split("\n").entries()) {
        if (line === "") continue;
        const unique = parseUniqueSnapshotJson(line);
        if (!unique.ok) return unique;
        const parsed = parseJsonObject(line, `snapshots/events.jsonl line ${index + 1}`);
        if (!parsed.ok) return err(parsed.error);
        events.push(parsed.value as unknown as SnapshotEvent);
      }
      // Format-3 Channel shard reading: each shard at
      // `snapshots/channels/<xx>/<id>.json` is parsed by the closed typed
      // parser — never a cast — so a null, array, unknown-shape, unknown-key,
      // duplicate-key, or noncanonical shard is a typed VAULT_INTEGRITY_ERROR
      // before any property access or adoption, and its file-backed messages
      // reference carried content files under this Channel's own identity
      // path (section 38.8, CHN-009).
      const channelShards: SnapshotChannelShard[] = [];
      const channelContentFileExports: ChannelContentFileExport[] = [];
      if (manifest.value.formatVersion !== 3 && manifest.value.formatVersion !== 4 && channels.value.length !== 0)
        return err(appError("VAULT_INTEGRITY_ERROR", "A legacy snapshot carries unexpected Channel shards"));
      if (manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) {
        for (const channelFile of channels.value) {
          const shardPath = `channels/${channelFile}`;
          if (!channelIdFromSnapshotPath(shardPath).ok) {
            return err(appError("VAULT_INTEGRITY_ERROR", `A Channel shard path is malformed: ${channelFile}`));
          }
          const bytes = readSnapshotBytes(join(sourcePath, "snapshots"), shardPath);
          if (!bytes.ok) return err(bytes.error);
          const shard = parseChannelSnapshotShard(shardPath, bytes.value);
          if (!shard.ok) return shard;
          for (const message of shard.value.messages) {
            if (!("contentPath" in message.bodyContent)) continue;
            const bytesOfFile = readContentFile(message.bodyContent.contentPath);
            if (!bytesOfFile.ok) return bytesOfFile;
            if (bytesOfFile.value.byteLength !== message.bodyContent.sizeBytes) {
              return err(
                appError("VAULT_INTEGRITY_ERROR", `A carried Channel content file disagrees with its recorded size.`),
              );
            }
            const contentId = message.bodyContent.contentPath.split("/")[3] as string;
            channelContentFileExports.push({
              channelId: shard.value.id,
              contentId,
              bytes: bytesOfFile.value,
            });
          }
          channelShards.push(shard.value);
        }
        // The manifest's Channel count must match the shard family exactly: a
        // positive count with zero shards and a zero count with stray shards
        // are both inventory disagreements (section 38.8).
        if (manifest.value.counts.channels !== channelShards.length) {
          return err(
            appError("VAULT_INTEGRITY_ERROR", `The manifest's Channel count disagrees with the shard family.`),
          );
        }
      }
      const common = {
        projects: projects.value as unknown as SnapshotProject[],
        events,
        memos: memoExports,
        memoContentFiles,
        ...(channelShards.length > 0 ? { channels: channelShards } : {}),
        ...(channelContentFileExports.length > 0 ? { channelContentFiles: channelContentFileExports } : {}),
      };
      const data: SnapshotData | SnapshotDataV3 | SnapshotDataV4 =
        manifest.value.formatVersion === 4
          ? { ...common, handoffs: v4Handoffs }
          : manifest.value.formatVersion === 3
            ? { ...common, handoffs: v3Handoffs }
            : { projects: common.projects, handoffs: legacyHandoffs, events, memos };
      const valid = validateSnapshot(data, manifest.value);
      if (!valid.ok) return valid;
      if (manifest.value.formatVersion === 3 || manifest.value.formatVersion === 4) {
        const canonicalLedger = [...events]
          .sort((a, b) =>
            a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          )
          .map(canonicalJsonLine)
          .join("");
        if (canonicalLedger !== eventsRaw.value)
          return err(
            appError("VAULT_INTEGRITY_ERROR", "The snapshot ledger does not carry canonical ordered JSONL bytes."),
          );
      }
      return ok(data);
    };
  }

  /** Only confirmed absence is empty; unreadable and nonregular entries fail closed. */
  function snapshotTreeFiles(root: string): Result<string[], AppError> {
    try {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe snapshot directory");
      const files: string[] = [];
      const walk = (directory: string, prefix: string): void => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          const stat = lstatSync(path);
          if (stat.isSymbolicLink()) throw new Error("Linked snapshot entry");
          const relativePath = `${prefix}${name}`;
          if (stat.isDirectory()) walk(path, `${relativePath}/`);
          else if (stat.isFile()) files.push(relativePath);
          else throw new Error("Nonregular snapshot entry");
        }
      };
      walk(root, "");
      return ok(files.sort());
    } catch (error) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The snapshot inventory is unsafe or unreadable: ${messageOf(error)}.`, {
          root,
        }),
      );
    }
  }

  function readSourceManifest(sourcePath: string) {
    return () => {
      const raw = readSourceFile(sourcePath, "snapshots/manifest.json");
      if (!raw.ok) return err(raw.error);
      // A newer snapshot format classifies as VAULT_SCHEMA_UNSUPPORTED (core parser).
      return parseVersionedSnapshotManifest(raw.value);
    };
  }

  function targetIsEmpty(): Result<boolean, AppError> {
    return withDatabase((db) => {
      const tables = [
        "projects",
        "handoffs",
        "artifacts",
        "review_notes",
        "deletion_requests",
        "events",
        "project_memos",
        // The Channel domain tables join the emptiness census (CHN-009,
        // section 32): an installation holding only Channel records — even one
        // whose ledger rows were lost — is not an empty target.
        "channels",
        "channel_participants",
        "channel_messages",
      ];
      for (const table of tables) {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown> | undefined;
        if (Number(row?.count ?? 0) > 0) return ok(false);
      }
      return ok(true);
    });
  }

  /** The database-side census `backup verify` cross-checks the manifest against. */
  function readCensus(): Result<BackupCensus, AppError> {
    return withDatabase((db) => {
      const row = db
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM projects) AS projects,
            (SELECT COUNT(*) FROM handoffs) AS handoffs,
            (SELECT COUNT(*) FROM events) AS events,
            (SELECT COUNT(*) FROM artifacts) AS artifacts,
            (SELECT COUNT(*) FROM project_memos) AS memos,
            (SELECT COUNT(*) FROM handoffs h JOIN artifacts a ON a.id = h.current_artifact_id
              JOIN content_records c ON c.id = a.content_record_id
              WHERE h.deleted_at IS NULL AND c.materialized = 0) AS materializing,
            (SELECT COUNT(*) FROM handoffs h WHERE h.deleted_at IS NOT NULL
              AND (h.current_artifact_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM artifacts a WHERE a.handoff_id = h.id))) AS deleted_with_artifact`,
        )
        .get() as Record<string, unknown> | undefined;
      return ok({
        projects: Number(row?.projects ?? 0),
        handoffs: Number(row?.handoffs ?? 0),
        events: Number(row?.events ?? 0),
        artifacts: Number(row?.artifacts ?? 0),
        memos: Number(row?.memos ?? 0),
        // The Channel census reads the actual Channel count: a schema-11
        // database with zero channels contributes zero, a database with
        // channels contributes its true count, and a pre-Channel database
        // contributes zero through the missing-table check (SHR-010,
        // CHN-009).
        channels: (() => {
          try {
            return Number((db.prepare("SELECT COUNT(*) AS count FROM channels").get() as { count: number }).count);
          } catch {
            return 0;
          }
        })(),
        materializing: Number(row?.materializing ?? 0),
        deletedWithArtifact: Number(row?.deleted_with_artifact ?? 0),
      });
    });
  }

  function materializedArtifacts(data: SnapshotData | SnapshotDataV3 | SnapshotDataV4): Array<{
    handoff: SnapshotHandoff | SnapshotHandoffV3 | SnapshotHandoffV4;
    artifact: SnapshotArtifact | SnapshotArtifactV3;
  }> {
    const entries: Array<{
      handoff: SnapshotHandoff | SnapshotHandoffV3 | SnapshotHandoffV4;
      artifact: SnapshotArtifact | SnapshotArtifactV3;
    }> = [];
    for (const handoff of data.handoffs) {
      if (handoff.artifact?.materialized) {
        entries.push({ handoff, artifact: handoff.artifact });
      }
    }
    return entries;
  }

  /** The file-backed subset a backup tree actually carries; an inline body's bytes live in its shard. */
  function fileBackedArtifacts(
    data: SnapshotData | SnapshotDataV3 | SnapshotDataV4,
  ): Array<{ artifact: SnapshotArtifact }> {
    const entries: Array<{ artifact: SnapshotArtifact }> = [];
    for (const { artifact } of materializedArtifacts(data)) {
      if (typeof artifact.storageKey === "string") {
        entries.push({ artifact: artifact as SnapshotArtifact });
      }
    }
    return entries;
  }

  function verifyArtifacts(sourcePath: string) {
    return (data: SnapshotData | SnapshotDataV3 | SnapshotDataV4): Result<{ verified: number }, AppError> => {
      // An inline body's exact bytes live in its shard: the gate re-digests
      // the stored text, the same success gate the shape validator applied
      // (SHR-003, SHR-010).
      let verified = 0;
      for (const { artifact } of materializedArtifacts(data)) {
        if (typeof artifact.storageKey !== "string") {
          const inline = artifact as SnapshotArtifactV3;
          if (sha256OfText(inline.inlineBody as string) !== inline.sha256.toLowerCase()) {
            return err(
              appError(
                "ARTIFACT_CORRUPTED",
                `The inline Artifact body of ${inline.id} does not match the recorded checksum; a single altered byte aborts the restore.`,
                { artifactId: inline.id, recorded: inline.sha256 },
              ),
            );
          }
          verified++;
          continue;
        }
        const fileArtifact = artifact as SnapshotArtifact;
        const contained = containedSourceArtifact(sourcePath, fileArtifact.storageKey);
        if (!contained.ok) return err(contained.error);
        const source = contained.value;
        let digest: string;
        try {
          digest = hashFile(source);
        } catch {
          return err(
            appError(
              "ARTIFACT_CORRUPTED",
              `The backup copy is missing the Artifact bytes at ${fileArtifact.storageKey}.`,
              {
                storageKey: fileArtifact.storageKey,
              },
            ),
          );
        }
        if (digest.toLowerCase() !== fileArtifact.sha256.toLowerCase()) {
          return err(
            appError(
              "ARTIFACT_CORRUPTED",
              `The Artifact bytes at ${fileArtifact.storageKey} do not match the recorded checksum; a single altered byte aborts the restore.`,
              { storageKey: fileArtifact.storageKey, recorded: fileArtifact.sha256 },
            ),
          );
        }
        verified++;
      }
      return ok({ verified });
    };
  }

  function copyArtifacts(vaultPath: string, sourcePath: string) {
    return (data: SnapshotData | SnapshotDataV3 | SnapshotDataV4): Result<{ copied: number }, AppError> => {
      let copied = 0;
      // Only the file representation has bytes in the backup tree to copy; an
      // inline record restores through the database rebuild alone.
      for (const { artifact } of fileBackedArtifacts(data)) {
        const containedSource = containedSourceArtifact(sourcePath, artifact.storageKey);
        if (!containedSource.ok) return err(containedSource.error);
        const containedDestination = containedRestoreDestination(vaultPath, artifact.storageKey);
        if (!containedDestination.ok) return err(containedDestination.error);
        const source = containedSource.value;
        const destination = containedDestination.value;
        try {
          mkdirSync(dirname(destination), { recursive: true });
          const digest = streamCopy(source, destination);
          if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
            return err(
              appError("ARTIFACT_CORRUPTED", `The copied bytes for ${artifact.storageKey} failed verification.`, {
                storageKey: artifact.storageKey,
              }),
            );
          }
          // Git checks out 0644; managed Artifact files are read-only (section 32).
          chmodSync(destination, ARTIFACT_MODE);
          copied++;
        } catch (error) {
          return err(
            appError("INTERNAL_ERROR", `Copying ${artifact.storageKey} failed: ${messageOf(error)}.`, {
              storageKey: artifact.storageKey,
              cause: String(error),
            }),
          );
        }
      }
      return ok({ copied });
    };
  }

  function adoptMarker(vaultPath: string) {
    return (marker: VaultMarker): Result<void, AppError> => {
      const body = `${JSON.stringify(
        {
          type: "sorage-vault",
          schemaVersion: marker.schemaVersion,
          installationId: marker.installationId,
          createdAt: marker.createdAt,
        },
        null,
        2,
      )}\n`;
      try {
        const markerPath = join(vaultPath, ".sorage-vault.json");
        const temporary = join(vaultPath, `.sorage-vault.json.tmp-${process.pid}`);
        writeFileSync(temporary, body, { flag: "wx" });
        const handle = openSync(temporary, "r");
        try {
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
        renameSync(temporary, markerPath);
        fsyncDirectory(vaultPath);
        return ok(undefined);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Adopting the Vault marker failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    };
  }

  function adoptInstallationId(installationId: string): Result<void, AppError> {
    const read = store.read();
    if (!read.ok) return err(read.error);
    if (read.value === null) return err(appError("NOT_INITIALIZED", "Sorage is not initialized.", {}));
    const config = read.value.config;
    config.installationId = installationId;
    const written = store.write(config, { etag: read.value.etag });
    if (!written.ok) return err(written.error);
    return ok(undefined);
  }

  function rebuildDatabase(
    data: SnapshotData | SnapshotDataV3 | SnapshotDataV4,
    marker: VaultMarker,
  ): Result<void, AppError> {
    const resolvedInstallation = installation();
    if (!resolvedInstallation.ok) return err(resolvedInstallation.error);
    const vaultPath = resolvedInstallation.value.vaultPath;
    // Every file-backed Memo's carried bytes are placed, fsynced, and
    // digest-verified at fresh private managed keys BEFORE the SQL transaction
    // opens: the transaction then inserts only rows — metadata-only, no
    // filesystem I/O inside it (MEM-009, P5). A placement failure leaves the
    // database untouched and removes every placed file of this restore.
    const carriedMemoContent = new Map(
      ((data as SnapshotDataV3).memoContentFiles ?? []).map((carried) => [
        `${carried.memoId}:${carried.contentId}`,
        carried.bytes,
      ]),
    );
    // The carried Channel content bytes, keyed by the exported content path
    // segment pair for the same pre-transaction placement discipline (CHN-009,
    // SHR-004, section 38.7).
    const carriedChannelContent = new Map(
      ((data as SnapshotDataV3).channelContentFiles ?? []).map((carried) => [
        `${carried.channelId}:${carried.contentId}`,
        carried.bytes,
      ]),
    );
    const placedFiles: Array<{
      meta: Omit<Memo, "body">;
      recordId: string;
      identity: { sizeBytes: number; sha256: string };
      storageKey: string;
    }> = [];
    const placedKeys: string[] = [];
    const discardPlacedFiles = (): void => {
      for (const key of placedKeys) {
        try {
          rmSync(join(vaultPath, key), { force: true });
        } catch {
          /* Unreachable owned files may remain. */
        }
      }
    };
    for (const memo of data.memos ?? []) {
      if (!("bodyContent" in memo) || memo.bodyContent.kind !== "file-backed") continue;
      const exportedContentId = memo.bodyContent.contentPath.split("/")[3] as string;
      const bytes = carriedMemoContent.get(`${memo.id}:${exportedContentId}`);
      if (bytes === undefined) {
        discardPlacedFiles();
        return err(
          appError("VAULT_INTEGRITY_ERROR", `The Memo ${memo.id} names a content file the snapshot does not carry`, {
            memoId: memo.id,
          }),
        );
      }
      const { bodyContent: _file, ...meta } = memo;
      const recordId = randomUUID();
      const placed = placeMemoContentFile(vaultPath, memo.id, recordId, bytes);
      if (!placed.ok) {
        discardPlacedFiles();
        return placed;
      }
      if (placed.value.sizeBytes !== memo.bodyContent.sizeBytes || placed.value.sha256 !== memo.bodyContent.sha256) {
        placedKeys.push(placed.value.storageKey);
        discardPlacedFiles();
        return err(
          appError(
            "VAULT_INTEGRITY_ERROR",
            `The Memo ${memo.id} carried bytes disagree with its shard's recorded identity`,
            {
              memoId: memo.id,
            },
          ),
        );
      }
      placedKeys.push(placed.value.storageKey);
      placedFiles.push({
        meta,
        recordId,
        identity: { sizeBytes: placed.value.sizeBytes, sha256: placed.value.sha256 },
        storageKey: placed.value.storageKey,
      });
    }
    const placedByMemo = new Map(placedFiles.map((entry) => [entry.meta.id, entry]));
    // Channel file-backed content placement: the same digest-verified
    // pre-transaction discipline, placing each file-backed message body's
    // exact carried bytes at a fresh private `content/channel/` managed key
    // BEFORE the SQL transaction opens. A placement failure discards every
    // placed file of this restore and leaves the database untouched.
    const placedChannelFiles: Array<{
      channelId: string;
      seq: number;
      recordId: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    }> = [];
    for (const channel of (data as SnapshotDataV3).channels ?? []) {
      for (const message of channel.messages) {
        if (!("contentPath" in message.bodyContent)) continue;
        const exportedContentId = message.bodyContent.contentPath.split("/")[3] as string;
        const bytes = carriedChannelContent.get(`${channel.id}:${exportedContentId}`);
        if (bytes === undefined) {
          discardPlacedFiles();
          return err(
            appError("VAULT_INTEGRITY_ERROR", `The Channel message names a content file the snapshot does not carry`, {
              channelId: channel.id,
              seq: message.seq,
            }),
          );
        }
        const recordId = randomUUID();
        const placed = placeChannelContentFile(vaultPath, channel.id, recordId, bytes);
        if (!placed.ok) {
          discardPlacedFiles();
          return placed;
        }
        if (
          placed.value.sizeBytes !== message.bodyContent.sizeBytes ||
          placed.value.sha256 !== message.bodyContent.sha256
        ) {
          placedKeys.push(placed.value.storageKey);
          discardPlacedFiles();
          return err(
            appError(
              "VAULT_INTEGRITY_ERROR",
              `The Channel message's carried bytes disagree with its shard's recorded identity`,
              {
                channelId: channel.id,
                seq: message.seq,
              },
            ),
          );
        }
        placedKeys.push(placed.value.storageKey);
        placedChannelFiles.push({
          channelId: channel.id,
          seq: message.seq,
          recordId,
          storageKey: placed.value.storageKey,
          sizeBytes: placed.value.sizeBytes,
          sha256: placed.value.sha256,
        });
      }
    }
    const placedChannelByMessage = new Map(
      placedChannelFiles.map((entry) => [`${entry.channelId}:${String(entry.seq)}`, entry]),
    );
    let committed = false;
    let cleanupSafe = true;
    let commitAttempted = false;
    const rebuilt = withDatabase((db) => {
      try {
        db.exec("BEGIN IMMEDIATE");
        cleanupSafe = false;
      } catch (error) {
        return err(appError("INTERNAL_ERROR", `Beginning the restore rebuild failed: ${messageOf(error)}.`));
      }
      try {
        // The installation identity lives in config.yaml and the Vault marker,
        // not in a database row; the two adoption writes already ran when the
        // rebuild starts, so this transaction owns exactly the restored rows.
        for (const project of [...data.projects].sort(byCreatedThenId)) {
          db.prepare(
            "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            project.id,
            project.slug,
            project.displayName,
            project.description,
            project.status,
            project.createdAt,
            project.updatedAt,
          );
        }
        // `supersedes_handoff_id` is a plain foreign key, so the older Handoff
        // rows insert first; both artifact references defer to the commit.
        for (const handoff of [...data.handoffs].sort(byCreatedThenId)) {
          const report = "comment" in handoff ? handoff : { ...legacyReportingEvidence(handoff.revision) };
          db.prepare(
            `INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id,
              sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version,
              review_state, accepted_revision, accepted_at, declined_at, decline_reason, withdrawn_at,
              consecutive_no_change_resolutions, first_fetched_at, review_engaged_at, pinned, archived_at, deleted_at,
              created_at, updated_at, read_status, read_revision, revision_read_at,
              processing_status, processing_started_at, processing_completed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            handoff.id,
            handoff.dispatchGroupId,
            handoff.supersedesHandoffId,
            handoff.title,
            handoff.senderKind,
            handoff.senderProjectId,
            handoff.senderWorkspaceKey,
            handoff.senderPathSnapshot ?? null,
            handoff.recipientProjectId,
            handoff.currentArtifactId,
            handoff.revision,
            handoff.rowVersion,
            handoff.reviewState,
            handoff.acceptedRevision,
            handoff.acceptedAt,
            handoff.declinedAt,
            handoff.declineReason,
            handoff.withdrawnAt,
            handoff.consecutiveNoChangeResolutions,
            handoff.firstFetchedAt,
            handoff.reviewEngagedAt,
            handoff.pinned ? 1 : 0,
            handoff.archivedAt,
            handoff.deletedAt,
            handoff.createdAt,
            handoff.updatedAt,
            report.read.status,
            report.read.status === "read" ? handoff.revision : null,
            report.read.readAt,
            report.processing.status,
            report.processing.startedAt,
            report.processing.completedAt,
          );
        }
        for (const handoff of data.handoffs) {
          const artifact = handoff.artifact as SnapshotArtifact | SnapshotArtifactV3 | null;
          if (artifact !== null) {
            // The restored Artifact keeps its exported identity and body bytes
            // exactly, while its immutable record receives a fresh independent
            // content UUID — snapshots never carry record ids, and restore
            // never reuses an exported Artifact id as a record id (SHR-004,
            // section 38.7). An inline record restores materialized with its
            // exact stored text; a file-backed one keeps its key and bytes.
            const inline = typeof artifact.storageKey !== "string";
            const contentRecordId = randomUUID();
            // The inline text binds as exact UTF-8 bytes with the SQL-side
            // CAST, never as a raw JS string: the pinned native engine can
            // strip a leading byte-order mark from a raw string binding, and
            // the byte-binding shape is the one the shared content store's own
            // inserts already use (SHR-003, section 38.8 exact-bytes rule).
            db.prepare(
              `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
              VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, ?)`,
            ).run(
              contentRecordId,
              inline ? Buffer.from((artifact as SnapshotArtifactV3).inlineBody as string, "utf8") : null,
              inline ? null : artifact.storageKey,
              artifact.sizeBytes,
              artifact.sha256,
              inline ? 1 : artifact.materialized ? 1 : 0,
              artifact.createdAt,
            );
            db.prepare(
              `INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              artifact.id,
              artifact.handoffId,
              artifact.originalName,
              artifact.storedName,
              artifact.mimeType,
              artifact.importedFromPath,
              artifact.createdAt,
              contentRecordId,
            );
          }
          const note = ("comment" in handoff ? handoff : upgradeSnapshotHandoff(handoff as SnapshotHandoffV3)).comment;
          if (note !== null) {
            db.prepare(
              `INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at, purpose, active)
              VALUES (?, ?, ?, ?, CAST(? AS TEXT), ?, ?, ?, ?)`,
            ).run(
              note.handoffId,
              note.authorKind,
              note.authorProjectId,
              note.targetRevision,
              Buffer.from(note.body, "utf8"),
              note.createdAt,
              note.updatedAt,
              note.purpose,
              note.active ? 1 : 0,
            );
          }
          for (const request of handoff.deletionRequests) {
            db.prepare(
              `INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status,
              requested_at, resolved_at, resolved_by_user, resolution_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              request.id,
              request.handoffId,
              request.requestedByKind,
              request.requestedById,
              request.reason,
              request.status,
              request.requestedAt,
              request.resolvedAt,
              request.resolvedByUser,
              request.resolutionNote,
            );
          }
        }
        for (const memo of data.memos ?? []) {
          if (!("bodyContent" in memo)) {
            insertMemoWithInlineRecord(db, memo, randomUUID());
          } else if (memo.bodyContent.kind === "inline") {
            const { bodyContent, ...meta } = memo;
            insertMemoWithInlineRecord(db, { ...meta, body: bodyContent.text }, randomUUID());
          } else {
            const placed = placedByMemo.get(memo.id);
            if (placed === undefined) throw new Error("A Memo lost its prepared content placement");
            insertMemoWithFileRecordRows(db, placed.meta, placed.identity, placed.recordId, placed.storageKey);
          }
        }
        // Channel restore (CHN-009, section 38.8): logical IDs, associations,
        // and the exact metadata ledger are preserved; each message's immutable
        // record receives a fresh private content UUID; verbatim text fields
        // bind their exact UTF-8 bytes with CAST; the sender handle is derived
        // from the preserved roster; and the processing row version is derived
        // from the immutable handled flag.
        const channelsData = (data as SnapshotDataV3).channels ?? [];
        for (const channel of channelsData) {
          db.prepare(
            `INSERT INTO channels (id, name, title, state, created_at, closed_at)
             VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?)`,
          ).run(
            channel.id,
            Buffer.from(channel.name, "utf8"),
            channel.title,
            channel.state,
            channel.createdAt,
            channel.closedAt,
          );
        }
        for (const channel of channelsData) {
          for (const participant of channel.participants) {
            db.prepare(
              `INSERT INTO channel_participants (channel_id, handle, role, added_at, removed_at)
               VALUES (?, CAST(? AS TEXT), ?, ?, ?)`,
            ).run(
              channel.id,
              Buffer.from(participant.handle, "utf8"),
              participant.role,
              participant.addedAt,
              participant.removedAt,
            );
          }
          for (const message of channel.messages) {
            // Each message's immutable record receives a fresh private content
            // UUID: snapshots never carry record ids, and restore never reuses
            // an exported logical id as a record id (SHR-004, section 38.7).
            let contentRecordId: string;
            if ("inline" in message.bodyContent) {
              contentRecordId = randomUUID();
              db.prepare(
                `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
                 VALUES (?, CAST(? AS TEXT), NULL, ?, ?, 1, ?)`,
              ).run(
                contentRecordId,
                Buffer.from(message.bodyContent.inline, "utf8"),
                Buffer.byteLength(message.bodyContent.inline, "utf8"),
                createHash("sha256").update(message.bodyContent.inline, "utf8").digest("hex"),
                message.createdAt,
              );
            } else {
              // The file-backed form: the pre-transaction placement already
              // placed the carried bytes at a fresh managed key and verified
              // their size and digest; the SQL transaction inserts only rows.
              const placed = placedChannelByMessage.get(`${channel.id}:${String(message.seq)}`);
              if (placed === undefined) throw new Error("A Channel message lost its prepared content placement");
              contentRecordId = placed.recordId;
              db.prepare(
                `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
                 VALUES (?, NULL, ?, ?, ?, 1, ?)`,
              ).run(placed.recordId, placed.storageKey, placed.sizeBytes, placed.sha256, message.createdAt);
            }
            db.prepare(
              `INSERT INTO channel_messages (channel_id, seq, sender_handle, kind, to_handle, ref, content_record_id,
                 handled, handled_at, handle_note, created_at)
               VALUES (?, ?, CAST(? AS TEXT), ?, CAST(? AS TEXT), CAST(? AS TEXT), ?, ?, ?, CAST(? AS TEXT), ?)`,
            ).run(
              channel.id,
              message.seq,
              Buffer.from(message.senderHandle, "utf8"),
              message.kind,
              message.toHandle === null ? null : Buffer.from(message.toHandle, "utf8"),
              message.ref === null ? null : Buffer.from(message.ref, "utf8"),
              contentRecordId,
              message.handled ? 1 : 0,
              message.handledAt,
              message.handleNote === null ? null : Buffer.from(message.handleNote, "utf8"),
              message.createdAt,
            );
          }
        }
        // Operational receipts are deliberately neither read nor reconstructed from snapshots.
        db.prepare("DELETE FROM idempotency_keys").run();
        for (const event of [...data.events].sort(byEventOrder)) {
          db.prepare(
            "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            event.id,
            event.handoffId,
            event.memoId ?? null,
            event.eventType,
            event.actorKind,
            event.actorId,
            event.rowVersion,
            JSON.stringify(event.metadata),
            event.createdAt,
          );
        }
        const now = clock.now().toISOString();
        db.prepare(
          "INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(),
          null,
          "VAULT_ADOPTED",
          USER_ACTOR.kind,
          USER_ACTOR.id,
          null,
          JSON.stringify({ adoptedInstallationId: marker.installationId }),
          now,
        );
        db.prepare(
          "INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(),
          null,
          "RESTORE_COMPLETED",
          USER_ACTOR.kind,
          USER_ACTOR.id,
          null,
          JSON.stringify({
            projects: data.projects.length,
            handoffs: data.handoffs.length,
            events: data.events.length,
          }),
          now,
        );
        commitAttempted = true;
        db.exec("COMMIT");
        committed = true;
        return ok(undefined);
      } catch (error) {
        try {
          db.exec("ROLLBACK");
          if (!commitAttempted) cleanupSafe = true;
        } catch {
          // Never delete files whose authoritative row outcome is uncertain.
        }
        return err(
          appError("INTERNAL_ERROR", `Rebuilding the installation from the backup failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    });
    if (!rebuilt.ok && cleanupSafe) discardPlacedFiles();
    if (!rebuilt.ok && committed)
      return err({
        ...appError("INTERNAL_ERROR", "The restore rebuild committed, but closing its database connection failed"),
        recovery: { suggestedCommand: "Inspect the restored installation read-only before attempting recovery" },
      });
    if (!rebuilt.ok && !cleanupSafe)
      return err({
        ...appError(
          "INTERNAL_ERROR",
          "The restore rebuild outcome is uncertain; its prepared content files were preserved",
        ),
        recovery: { suggestedCommand: "Inspect the target installation read-only before retrying restore" },
      });
    return rebuilt;
  }

  function regenerateApiToken(): Result<void, AppError> {
    const rotated = createNodeApiTokenStore({ stateDir: home.stateDir }).rotate();
    if (!rotated.ok) return err(rotated.error);
    return ok(undefined);
  }

  return {
    exportPorts(): Result<BackupExportPorts, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      const vaultPath = view.value.vaultPath;
      return ok({
        vaultPath,
        redactWorkspacePaths: view.value.redactWorkspacePaths,
        readSnapshotData,
        writeSnapshotTree: writeSnapshotTree(vaultPath),
      });
    },

    restorePorts(): Result<BackupRestorePorts, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      if (options.sourcePath === undefined || options.sourcePath.trim() === "") {
        return err(appError("NOT_INITIALIZED", "sorage backup restore requires --from <vault-path>.", {}));
      }
      const sourcePath = expandConfigurationPath(options.sourcePath, userHome, home.home);
      const vaultPath = view.value.vaultPath;
      return ok({
        sourcePath,
        installationId: view.value.installationId,
        daemonRunning,
        lock: { acquire: acquireVaultMoveLock },
        readSourceMarker: () => {
          const raw = readSourceFile(sourcePath, ".sorage-vault.json");
          if (!raw.ok) return err(raw.error);
          return parseVaultMarker(raw.value);
        },
        readSourceSnapshot: readSourceSnapshot(sourcePath),
        readSourceManifest: readSourceManifest(sourcePath),
        targetIsEmpty,
        verifyArtifacts: verifyArtifacts(sourcePath),
        copyArtifacts: copyArtifacts(vaultPath, sourcePath),
        adoptMarker: adoptMarker(vaultPath),
        adoptInstallationId,
        rebuildDatabase,
        regenerateApiToken,
      });
    },

    verifyPorts(): Result<BackupVerifyPorts, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      const vaultPath = view.value.vaultPath;
      // The Git-independent checks are exactly `vault verify`'s, composed from
      // the same port builder so the two commands can never drift.
      const vaultPorts = createNodeVaultCommandPorts({ env: env as HomeEnvironment, userHome, clock }).verifyPorts();
      if (!vaultPorts.ok) return err(vaultPorts.error);
      return ok({
        ...vaultPorts.value,
        git: createNodeGitClient(),
        configuredBranch: view.value.backupBranch,
        repositoryExists: () => ok(existsSync(join(vaultPath, ".git"))),
        repositorySignals: () =>
          ok({
            mergeInProgress: existsSync(join(vaultPath, ".git", "MERGE_HEAD")),
            rebaseInProgress:
              existsSync(join(vaultPath, ".git", "rebase-merge")) ||
              existsSync(join(vaultPath, ".git", "rebase-apply")),
          }),
        census: () => readCensus(),
        readManifest: () => {
          const raw = readSourceFile(vaultPath, "snapshots/manifest.json");
          if (!raw.ok) return existsSync(join(vaultPath, "snapshots/manifest.json")) ? raw : ok(null);
          const manifest = parseVersionedSnapshotManifest(raw.value);
          if (!manifest.ok) return manifest;
          const snapshot = readSourceSnapshot(vaultPath)();
          if (!snapshot.ok) return snapshot;
          return manifest;
        },
        countShards: () => {
          const shardsRoot = join(vaultPath, "snapshots/handoffs");
          let count = 0;
          try {
            for (const shard of existsSync(shardsRoot) ? readdirSync(shardsRoot) : []) {
              const shardPath = join(shardsRoot, shard);
              if (!statSync(shardPath).isDirectory()) continue;
              count += readdirSync(shardPath).filter((name) => name.endsWith(".json")).length;
            }
          } catch {
            // An absent shard tree holds no shards; the manifest finding names it.
          }
          return ok(count);
        },
        countEventLines: () => {
          const raw = readSourceFile(vaultPath, "snapshots/events.jsonl");
          if (!raw.ok) return ok(0);
          return ok(raw.value.split("\n").filter((line) => line !== "").length);
        },
      });
    },

    runPorts(
      triggeredBy: "manual" | "scheduled" | "catch-up" = "manual",
    ): Result<import("@sorage/core").BackupRunCommandPorts, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      const vaultPath = view.value.vaultPath;
      const git = gitClient;
      return ok({
        vaultPath,
        messageTemplate: view.value.commitMessageTemplate,
        triggeredBy,
        pushEnabled: view.value.push.enabled,
        pushTarget: { remote: view.value.push.remote, branch: view.value.push.branch },
        configuredBranch: view.value.backupBranch,
        lock: { acquire: acquireBackupLock },
        exportSnapshot: () => {
          const ports = createNodeBackupCommandPorts({ env: env as HomeEnvironment, userHome, clock }).exportPorts();
          if (!ports.ok) return err(ports.error);
          return exportSnapshot(ports.value);
        },
        verifyCurrentArtifacts: () => {
          const recorded = recordedArtifactPairs();
          if (!recorded.ok) return err(recorded.error);
          const store = createNodeArtifactStore({
            vaultPath,
            installationId: view.value.installationId,
          });
          const integrity = verifyVaultArtifacts({ artifactStore: store }, recorded.value);
          if (!integrity.ok) return err(integrity.error);
          if (integrity.value.length > 0) {
            return err(
              appError("ARTIFACT_CORRUPTED", integrity.value.join(" "), {
                affected: integrity.value.length,
              }),
            );
          }
          return ok({ verified: recorded.value.length });
        },
        ensureRepository: () =>
          nodeEnsureVaultGit(vaultPath, view.value.installationId, clock, view.value.backupBranch),
        prepareWritableContent: (): Result<void, AppError> => {
          // The writable setup of section 26 and the M9 policy reassertion of
          // VLT-024/SHR-011: the existing guarded initializer idempotently
          // prepares the managed directories and re-asserts the `.gitattributes`
          // M9 lines (preserving non-managed lines and order), inside the
          // validated selected Vault before the exact Git change test, with no
          // sentinel file. The Result propagates the initializer's typed
          // filesystem error unchanged — a failed preparation never reaches
          // Git staging or the backup commit.
          const opened = openVault(vaultPath, view.value.installationId);
          if (!opened.ok) return err(opened.error);
          const initialized = createVaultInitializer(clock).initialize(vaultPath, view.value.installationId);
          if (!initialized.ok) return initialized;
          return ok(undefined);
        },
        git,
        gitState: () =>
          ok({
            mergeInProgress: existsSync(join(vaultPath, ".git", "MERGE_HEAD")),
            rebaseInProgress:
              existsSync(join(vaultPath, ".git", "rebase-merge")) ||
              existsSync(join(vaultPath, ".git", "rebase-apply")),
          }),
        recordRun: (row: BackupRunRow) =>
          withDatabase((db) => {
            try {
              db.prepare(
                `INSERT INTO backup_runs (id, triggered_by, started_at, finished_at, outcome, snapshot_outcome,
                  commit_outcome, push_outcome, commit_sha, failure_code, failure_message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                row.id,
                row.triggeredBy,
                row.startedAt,
                row.finishedAt,
                row.outcome,
                row.snapshotOutcome,
                row.commitOutcome,
                row.pushOutcome,
                row.commitSha,
                row.failureCode,
                row.failureMessage,
              );
              return ok(undefined);
            } catch (error) {
              return err(
                appError("INTERNAL_ERROR", `Recording the backup run failed: ${messageOf(error)}.`, {
                  cause: String(error),
                }),
              );
            }
          }),
        now: () => clock.now(),
        nextRunId: () => randomUUID(),
        idempotency: {
          lookup: (key, scope) =>
            withDatabase((db) => {
              try {
                db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(clock.now().toISOString());
                const row = db
                  .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
                  .get(key, scope) as { request_hash: string; response_json: string } | null | undefined;
                return ok(row ? { requestHash: row.request_hash, responseJson: row.response_json } : null);
              } catch (error) {
                return err(appError("INTERNAL_ERROR", `Reading the idempotency key failed: ${messageOf(error)}.`));
              }
            }),
          record: (input) =>
            withDatabase((db) => {
              try {
                db.prepare(
                  "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                ).run(
                  input.key,
                  input.scope,
                  input.requestHash,
                  input.responseJson,
                  clock.now().toISOString(),
                  input.expiresAt,
                );
                return ok(undefined);
              } catch (error) {
                return err(appError("INTERNAL_ERROR", `Recording the idempotency key failed: ${messageOf(error)}.`));
              }
            }),
        },
      });
    },

    statusPorts(): Result<import("@sorage/core").BackupStatusPorts, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      const vaultPath = view.value.vaultPath;
      return ok({
        vaultPath,
        history: () =>
          withDatabase((db) => {
            try {
              const rows = db.prepare("SELECT * FROM backup_runs").all() as unknown as Array<Record<string, unknown>>;
              return ok(rows.map(mapBackupRunRow));
            } catch (error) {
              return err(appError("INTERNAL_ERROR", `Reading the backup history failed: ${messageOf(error)}.`));
            }
          }),
        schedule: view.value.schedule,
        nextDueAt: () =>
          nextDueAt(
            view.value.schedule.enabled ? view.value.schedule : { ...view.value.schedule, enabled: false },
            clock.now(),
          ),
        lastRunAt: () =>
          withDatabase((db) => {
            const row = db.prepare("SELECT started_at FROM backup_runs ORDER BY started_at DESC LIMIT 1").get() as
              | { started_at: string }
              | null
              | undefined;
            return ok(row?.started_at ?? null);
          }),
        repositoryBytes: () => {
          const gitDir = join(vaultPath, ".git");
          if (!existsSync(gitDir)) return ok(null);
          try {
            let total = 0;
            const walk = (directory: string) => {
              for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const path = join(directory, entry.name);
                if (entry.isDirectory()) walk(path);
                else total += statSync(path).size;
              }
            };
            walk(gitDir);
            return ok(total);
          } catch (error) {
            return err(
              appError("INTERNAL_ERROR", `Measuring the repository failed: ${messageOf(error)}.`, {
                cause: String(error),
              }),
            );
          }
        },
      });
    },

    drainAtStart(): Result<DrainReport, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      return withDatabase((db) => {
        const log = createSqliteIntentLog({
          db,
          installationId: view.value.installationId,
          runDir: home.runDir,
          events: createSqliteEventLedger(db),
        });
        const drained = log.drain(view.value.vaultPath);
        if (!drained.ok) return drained;
        // The same pre-backup maintenance order as the Vault maintenance flow
        // (SHR-004, SHR-011): drain, then the reference-proof cleanup in its own
        // single BEGIN IMMEDIATE, then the freshly recomputed protection set,
        // then the physical GC, then the cache sweep. A failed cleanup — a live
        // fence aborting it atomically included — skips the physical GC for
        // this run and surfaces the exact cleanup error.
        const cleanup = createSqliteContentStore({
          db,
          vaultPath: view.value.vaultPath,
          installationId: view.value.installationId,
          // The same late-handoff entry guard as the Vault maintenance flow:
          // a vault-move.lock acquired after the successful drain, before the
          // cleanup transaction opens, must pause the pre-backup cleanup —
          // the SQL fence alone is set only later at switch time (RUN-014).
          runDir: home.runDir,
        }).cleanup(sqliteContentReferences(db), clock.now());
        if (!cleanup.ok) {
          // The same pre-backup maintenance failure semantics: the exact
          // cleanup error propagates and no GC or cache sweep runs after a
          // failed proof (SHR-004, SHR-011).
          return err(cleanup.error);
        }
        const surviving = log.pending();
        const recorded = readRecordedStorageKeys(db);
        const contentKeys = readRecordedContentKeys(db);
        const receiptKeys = receiptReferencedContentKeys(db, clock.now());
        // The physical GC runs only over a complete protection proof: a failed
        // link guard, an unreadable key set, or any other unavailable proof
        // skips the collector for this run rather than age-deleting files whose
        // protection cannot be established (SHR-008, SHR-014).
        if (surviving.ok && recorded.ok && contentKeys.ok && receiptKeys.ok) {
          void collectVaultGarbage(view.value.vaultPath, surviving.value, {
            liveStorageKeys: recorded.value,
            liveContentKeys: contentKeys.value,
            receiptReferencedKeys: receiptKeys.value,
            graceHours: view.value.graceHours,
            now: clock.now(),
          });
        }
        sweepFetchCache(home.stateDir, { graceHours: view.value.graceHours, now: clock.now() });
        return drained;
      });
    },
  };
}

/** The managed `content/` keys live content records name, the GC guard input. */
function readRecordedContentKeys(db: ReturnType<typeof openAndMigrate>["db"]): Result<string[], AppError> {
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
      .get() as { name: string } | null | undefined;
    if (!table) return ok([]);
    const rows = db
      .prepare("SELECT storage_key FROM content_records WHERE storage_key IS NOT NULL")
      .all() as unknown as Row[];
    return ok(rows.map((row) => String(row.storage_key ?? "")));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Reading the content keys failed: ${messageOf(error)}.`, { cause: String(error) }),
    );
  }
}

interface Row {
  [column: string]: unknown;
}

function mapSnapshotData(rows: {
  projects: Row[];
  bindings: Row[];
  handoffs: Row[];
  artifacts: Row[];
  reviewNotes: Row[];
  deletionRequests: Row[];
  events: Row[];
}): SnapshotDataV4 {
  const bindingsByProject = new Map<string, SnapshotProject["bindings"]>();
  for (const row of rows.bindings) {
    const list = bindingsByProject.get(str(row.project_id)) ?? [];
    list.push({
      id: str(row.id),
      installationId: str(row.installation_id),
      bindingKind: str(row.binding_kind),
      directory: str(row.directory),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    });
    bindingsByProject.set(str(row.project_id), list);
  }
  const artifactByHandoff = new Map<string, SnapshotArtifactV3>();
  for (const row of rows.artifacts) {
    // The closed pair exactly as the record stores it: an inline row carries
    // its text with a null key, a file row its key with null text (SHR-004).
    artifactByHandoff.set(str(row.handoff_id), {
      id: str(row.id),
      handoffId: str(row.handoff_id),
      storageKey: nullableStr(row.storage_key),
      inlineBody: nullableStr(row.inline_text),
      originalName: str(row.original_name),
      storedName: str(row.stored_name),
      mimeType: str(row.mime_type),
      sizeBytes: num(row.size_bytes),
      sha256: str(row.sha256),
      importedFromPath: nullableStr(row.imported_from_path),
      materialized: num(row.materialized) === 1,
      createdAt: str(row.created_at),
    });
  }
  const noteByHandoff = new Map<string, SnapshotRecipientComment>();
  for (const row of rows.reviewNotes) {
    noteByHandoff.set(str(row.handoff_id), {
      purpose: str(row.purpose) as SnapshotRecipientComment["purpose"],
      active: num(row.active) === 1,
      handoffId: str(row.handoff_id),
      authorKind: str(row.author_kind),
      authorProjectId: nullableStr(row.author_project_id),
      targetRevision: num(row.target_revision),
      body: str(row.body),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    });
  }
  const deletionByHandoff = new Map<string, SnapshotDeletionRequest[]>();
  for (const row of rows.deletionRequests) {
    const list = deletionByHandoff.get(str(row.handoff_id)) ?? [];
    list.push({
      id: str(row.id),
      handoffId: str(row.handoff_id),
      requestedByKind: str(row.requested_by_kind),
      requestedById: nullableStr(row.requested_by_id),
      reason: nullableStr(row.reason),
      status: str(row.status),
      requestedAt: str(row.requested_at),
      resolvedAt: nullableStr(row.resolved_at),
      resolvedByUser: nullableStr(row.resolved_by_user),
      resolutionNote: nullableStr(row.resolution_note),
    });
    deletionByHandoff.set(str(row.handoff_id), list);
  }
  return {
    projects: rows.projects.map((row) => ({
      id: str(row.id),
      slug: str(row.slug),
      displayName: str(row.display_name),
      description: nullableStr(row.description),
      status: str(row.status),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      bindings: (bindingsByProject.get(str(row.id)) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1)),
    })),
    handoffs: rows.handoffs.map((row) => ({
      id: str(row.id),
      dispatchGroupId: nullableStr(row.dispatch_group_id),
      supersedesHandoffId: nullableStr(row.supersedes_handoff_id),
      title: str(row.title),
      senderKind: str(row.sender_kind),
      senderProjectId: nullableStr(row.sender_project_id),
      senderWorkspaceKey: nullableStr(row.sender_workspace_key),
      senderPathSnapshot: nullableStr(row.sender_path_snapshot),
      recipientProjectId: str(row.recipient_project_id),
      currentArtifactId: nullableStr(row.current_artifact_id),
      revision: num(row.revision),
      rowVersion: num(row.row_version),
      reviewState: str(row.review_state),
      acceptedRevision: nullableNum(row.accepted_revision),
      acceptedAt: nullableStr(row.accepted_at),
      declinedAt: nullableStr(row.declined_at),
      declineReason: nullableStr(row.decline_reason),
      withdrawnAt: nullableStr(row.withdrawn_at),
      consecutiveNoChangeResolutions: num(row.consecutive_no_change_resolutions),
      firstFetchedAt: nullableStr(row.first_fetched_at),
      reviewEngagedAt: nullableStr(row.review_engaged_at),
      pinned: num(row.pinned) === 1,
      archivedAt: nullableStr(row.archived_at),
      deletedAt: nullableStr(row.deleted_at),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      artifact: artifactByHandoff.get(str(row.id)) ?? null,
      comment: noteByHandoff.get(str(row.id)) ?? null,
      read: {
        revision: num(row.revision),
        status: str(row.read_status) as SnapshotReadEvidence["status"],
        readAt: nullableStr(row.revision_read_at),
      },
      processing: {
        revision: num(row.revision),
        status: str(row.processing_status) as SnapshotProcessingEvidence["status"],
        startedAt: nullableStr(row.processing_started_at),
        completedAt: nullableStr(row.processing_completed_at),
      },
      deletionRequests: deletionByHandoff.get(str(row.id)) ?? [],
    })),
    events: rows.events.map((row) => ({
      id: str(row.id),
      handoffId: nullableStr(row.handoff_id),
      memoId: nullableStr(row.memo_id),
      eventType: str(row.event_type),
      actorKind: str(row.actor_kind),
      actorId: nullableStr(row.actor_id),
      rowVersion: nullableNum(row.row_version),
      metadata: parseMetadata(row.metadata_json),
      createdAt: str(row.created_at),
    })),
  };
}

function mapBackupRunRow(row: Record<string, unknown>): import("@sorage/core").BackupRunRow {
  return {
    id: String(row.id ?? ""),
    triggeredBy: (row.triggered_by ?? "manual") as import("@sorage/core").BackupRunRow["triggeredBy"],
    startedAt: String(row.started_at ?? ""),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    outcome: (row.outcome ?? "failure") as import("@sorage/core").BackupRunRow["outcome"],
    snapshotOutcome: (row.snapshot_outcome ?? "failure") as import("@sorage/core").BackupRunRow["snapshotOutcome"],
    commitOutcome: (row.commit_outcome ?? "failure") as import("@sorage/core").BackupRunRow["commitOutcome"],
    pushOutcome: (row.push_outcome ?? "disabled") as import("@sorage/core").BackupRunRow["pushOutcome"],
    commitSha: row.commit_sha === null ? null : String(row.commit_sha),
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    failureMessage: row.failure_message === null ? null : String(row.failure_message),
  };
}

function readRecordedStorageKeys(db: ReturnType<typeof openAndMigrate>["db"]): Result<string[], AppError> {
  // The GC live-key proof validates every Artifact's record link before
  // collecting keys: an INNER JOIN would silently drop an Artifact whose
  // record row is missing and hand the collector an incomplete protection set
  // that can age-delete a live file (SHR-004, SHR-008). An unavailable proof
  // is an error the drain gate consumes by skipping the physical GC.
  const links = validateArtifactContentLinks(db);
  if (!links.ok) return links;
  try {
    const rows = db
      .prepare(
        "SELECT c.storage_key AS storage_key FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE c.storage_key IS NOT NULL",
      )
      .all() as unknown as Row[];
    return ok(rows.map((row) => str(row.storage_key)));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Reading the recorded Artifact storage keys failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string, origin: string): Result<unknown[], AppError> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return ok(parsed);
  } catch {
    return err(appError("VAULT_INTEGRITY_ERROR", `The backup file ${origin} is not a JSON array.`));
  }
}

function parseJsonObject(raw: string, origin: string): Result<Record<string, unknown>, AppError> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return ok(parsed as Record<string, unknown>);
  } catch {
    return err(appError("VAULT_INTEGRITY_ERROR", `The backup entry ${origin} is not a JSON object.`));
  }
}

function byCreatedThenId(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byEventOrder(a: SnapshotEvent, b: SnapshotEvent): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : typeof value === "string" ? value : String(value);
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function readLockText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Copies one file streaming through a fixed buffer, hashing in the same pass. */
function streamCopy(source: string, destination: string): string {
  const input = openSync(source, "r");
  let output: number | undefined;
  const temporary = join(dirname(destination), `.${basename(destination)}.restore-${randomUUID()}.tmp`);
  try {
    // A retry may replace the exact managed destination, but it never opens that
    // path for truncation: bytes first reach an exclusive sibling and rename
    // atomically only after the copy and fsync succeed.
    output = openSync(temporary, "wx");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    for (;;) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) {
        const count = writeSync(output, buffer, written, read - written);
        if (count <= 0) throw new Error(`The restore copy made no progress after ${written} of ${read} bytes.`);
        written += count;
      }
    }
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    renameSync(temporary, destination);
    fsyncDirectory(dirname(destination));
    return hash.digest("hex");
  } finally {
    closeSync(input);
    if (output !== undefined) {
      try {
        closeSync(output);
      } catch {
        // Best effort on the error path.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort after a failed copy; the exclusive name cannot alias user data.
    }
  }
}

function isContained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function containedSourceArtifact(sourcePath: string, storageKey: string): Result<string, AppError> {
  try {
    const root = realpathSync(sourcePath);
    const candidate = realpathSync(resolve(sourcePath, storageKey));
    if (!isContained(root, candidate) || !lstatSync(candidate).isFile()) {
      return err(
        appError(
          "VAULT_INTEGRITY_ERROR",
          `The backup Artifact path ${storageKey} escapes its source or is not a file.`,
          {
            storageKey,
          },
        ),
      );
    }
    return ok(candidate);
  } catch (error) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The backup Artifact path ${storageKey} is not a contained readable file.`, {
        storageKey,
        cause: String(error),
      }),
    );
  }
}

function containedRestoreDestination(vaultPath: string, storageKey: string): Result<string, AppError> {
  try {
    const root = realpathSync(vaultPath);
    const lexical = resolve(vaultPath, storageKey);
    if (!isContained(resolve(vaultPath), lexical)) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The restore destination ${storageKey} escapes the Vault.`, { storageKey }),
      );
    }
    let existing = dirname(lexical);
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    if (!isContained(root, realpathSync(existing))) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The restore destination ${storageKey} resolves outside the Vault.`, {
          storageKey,
        }),
      );
    }
    mkdirSync(dirname(lexical), { recursive: true });
    const parent = realpathSync(dirname(lexical));
    if (!isContained(root, parent)) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", `The restore destination ${storageKey} resolves outside the Vault.`, {
          storageKey,
        }),
      );
    }
    return ok(join(parent, basename(lexical)));
  } catch (error) {
    return err(
      appError("VAULT_INTEGRITY_ERROR", `The restore destination ${storageKey} is not a safe managed path.`, {
        storageKey,
        cause: String(error),
      }),
    );
  }
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The production Git initialization of the Vault (TASK-053, INIT-007,
 * BKP-001, BKP-022): a repository appears only when none exists, the
 * repository-local `core.autocrlf` is set to false, and the managed policy
 * files are re-asserted idempotently through the Vault initializer, which
 * fills gaps without overwriting existing content. An existing repository —
 * including an unrelated one — is reported and left untouched.
 */
export function nodeEnsureVaultGit(
  vaultPath: string,
  installationId: string,
  clock: { now(): Date },
  backupBranch: string,
): Result<VaultGitOutcome, AppError> {
  return ensureVaultGitRepository({
    vaultPath,
    configuredBranch: backupBranch,
    repositoryExists: () => ok(existsSync(join(vaultPath, ".git"))),
    reassertPolicyFiles: () => {
      const reasserted = createVaultInitializer(clock).initialize(vaultPath, installationId);
      if (!reasserted.ok) return err(reasserted.error);
      return ok(undefined);
    },
    git: createNodeGitClient(),
  });
}
