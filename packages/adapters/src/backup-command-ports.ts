import { managedDirectory } from "./managed-paths";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
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
import {
  type AppError,
  appError,
  canonicalJson,
  canonicalJsonLine,
  type BackupCensus,
  type BackupExportPorts,
  type BackupRestorePorts,
  type BackupRunRow,
  type BackupVerifyPorts,
  type DrainReport,
  ensureVaultGitRepository,
  err,
  expandConfigurationPath,
  isMemoUuid,
  exportSnapshot,
  type GitClient,
  nextDueAt,
  ok,
  parseVersionedSnapshotManifest,
  parseMemoSnapshot,
  parseMemoSnapshotV3,
  parseUniqueSnapshotJson,
  validateSnapshot,
  type Memo,
  parseVaultMarker,
  type Result,
  type SnapshotArtifact,
  type SnapshotData,
  type SnapshotArtifactV3,
  type SnapshotDataV3,
  type SnapshotHandoffV3,
  sha256OfText,
  type SnapshotDeletionRequest,
  type SnapshotEvent,
  type SnapshotFile,
  type SnapshotHandoff,
  type SnapshotProject,
  type SnapshotReviewNote,
  USER_ACTOR,
  type VaultGitOutcome,
  type VaultMarker,
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
} from "./content-store";
import { createSqliteEventLedger } from "./events";
import { memoFromRow, insertMemoRow } from "./memos";
import { readMemoSnapshotFiles, readSnapshotBytes } from "./memo-snapshot-files";
import { createNodeGitClient } from "./git-client";
import { createHomePaths, type HomeEnvironment } from "./home";
import { collectVaultGarbage, createSqliteIntentLog, fsyncDirectory } from "./intent-log";
import { acquireLock, createNodeLockProbePorts, evaluateStaleness, isPidAlive, parseLockRecord } from "./lockfile";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
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

  /** Reads the complete snapshot set inside one consistent read transaction (BKP-007). */
  function readSnapshotData(): Result<SnapshotDataV3, AppError> {
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
      let data: Result<SnapshotDataV3, AppError>;
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
        const memos = db.prepare("SELECT * FROM project_memos ORDER BY id").all().map(memoFromRow);
        data = ok({
          ...mapSnapshotData({ projects, bindings, handoffs, artifacts, reviewNotes, deletionRequests, events }),
          memos,
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
    return (): Result<SnapshotData | SnapshotDataV3, AppError> => {
      const manifest = readSourceManifest(sourcePath)();
      if (!manifest.ok) return manifest;
      const channels = snapshotTreeFiles(join(sourcePath, "snapshots", "channels"));
      if (!channels.ok) return channels;
      const content = snapshotTreeFiles(join(sourcePath, "snapshots", "content"));
      if (!content.ok) return content;
      // Inspect filesystem safety without applying this build's empty content
      // inventory assumption to a recognized later representation.
      if (
        manifest.value.formatVersion === 3 &&
        (manifest.value.counts.channels !== 0 || Object.keys(manifest.value.contentDigests).length !== 0)
      ) {
        return err(
          appError(
            "VAULT_SCHEMA_UNSUPPORTED",
            "The snapshot carries a later Channel or shared-content representation this build cannot import",
          ),
        );
      }
      if (channels.value.length !== 0) {
        return err(
          appError(
            "VAULT_SCHEMA_UNSUPPORTED",
            "The snapshot carries Channel shards, a valid later representation this build cannot import",
          ),
        );
      }
      if (manifest.value.formatVersion === 3) {
        // The content-file inventory must agree with the map before import: an
        // empty `contentDigests` with files present is a disagreement, and a
        // nonempty map was already refused with the later-generation check.
        if (content.value.length !== 0) {
          return err(
            appError(
              "VAULT_INTEGRITY_ERROR",
              "The snapshot's exported content files disagree with its empty content digest inventory",
            ),
          );
        }
      }
      const memoFiles = readMemoSnapshotFiles(sourcePath, manifest.value);
      if (!memoFiles.ok) return memoFiles;
      const memos: Memo[] = [];
      for (const file of memoFiles.value) {
        const parsed =
          manifest.value.formatVersion === 3
            ? parseMemoSnapshotV3(file.path, file.bytes, file.digest)
            : parseMemoSnapshot(file.path, file.bytes, file.digest);
        if (!parsed.ok) return parsed;
        memos.push(parsed.value);
      }
      const projectsRaw = readSourceFile(sourcePath, "snapshots/projects.json");
      if (!projectsRaw.ok) return err(projectsRaw.error);
      const projects =
        manifest.value.formatVersion === 3
          ? parseUniqueSnapshotJson(projectsRaw.value)
          : parseJsonArray(projectsRaw.value, "snapshots/projects.json");
      if (!projects.ok) return err(projects.error);
      if (
        !Array.isArray(projects.value) ||
        (manifest.value.formatVersion === 3 && canonicalJson(projects.value) !== projectsRaw.value)
      )
        return err(appError("VAULT_INTEGRITY_ERROR", "The snapshot Project metadata is not a canonical array."));

      const shardFiles: string[] = [];
      const shardsRoot = join(sourcePath, "snapshots/handoffs");
      // Format 3 parses its distinct V3 records; formats 1 and 2 keep their
      // frozen legacy shapes and readers.
      const legacyHandoffs: SnapshotHandoff[] = [];
      const v3Handoffs: SnapshotHandoffV3[] = [];
      if (manifest.value.formatVersion === 3) {
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
          manifest.value.formatVersion === 3
            ? parseUniqueSnapshotJson(raw.value)
            : parseJsonObject(raw.value, `snapshots/${shardFile}`);
        if (!parsed.ok) return parsed;
        const value = parsed.value;
        if (manifest.value.formatVersion === 3 && canonicalJson(value) !== raw.value) {
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
          manifest.value.formatVersion === 3
            ? (value as unknown as SnapshotHandoffV3)
            : (value as unknown as SnapshotHandoff);
        if (manifest.value.formatVersion === 3 && !isMemoUuid(handoff.id)) {
          return err(appError("VAULT_INTEGRITY_ERROR", "The format-3 handoff shard does not carry a valid UUID."));
        }
        const expected = `${handoff.id}.json`;
        if (
          manifest.value.formatVersion === 3
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
        if (manifest.value.formatVersion === 3) v3Handoffs.push(value as unknown as SnapshotHandoffV3);
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
      const data: SnapshotData | SnapshotDataV3 =
        manifest.value.formatVersion === 3
          ? { projects: projects.value as unknown as SnapshotProject[], handoffs: v3Handoffs, events, memos }
          : { projects: projects.value as unknown as SnapshotProject[], handoffs: legacyHandoffs, events, memos };
      const valid = validateSnapshot(data, manifest.value);
      if (!valid.ok) return valid;
      if (manifest.value.formatVersion === 3) {
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
        // The Channel tables arrive with TASK-109; the census stays an honest
        // zero at this schema (SHR-010).
        channels: 0,
        materializing: Number(row?.materializing ?? 0),
        deletedWithArtifact: Number(row?.deleted_with_artifact ?? 0),
      });
    });
  }

  function materializedArtifacts(
    data: SnapshotData | SnapshotDataV3,
  ): Array<{ handoff: SnapshotHandoff | SnapshotHandoffV3; artifact: SnapshotArtifact | SnapshotArtifactV3 }> {
    const entries: Array<{
      handoff: SnapshotHandoff | SnapshotHandoffV3;
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
  function fileBackedArtifacts(data: SnapshotData | SnapshotDataV3): Array<{ artifact: SnapshotArtifact }> {
    const entries: Array<{ artifact: SnapshotArtifact }> = [];
    for (const { artifact } of materializedArtifacts(data)) {
      if (typeof artifact.storageKey === "string") {
        entries.push({ artifact: artifact as SnapshotArtifact });
      }
    }
    return entries;
  }

  function verifyArtifacts(sourcePath: string) {
    return (data: SnapshotData | SnapshotDataV3): Result<{ verified: number }, AppError> => {
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
    return (data: SnapshotData | SnapshotDataV3): Result<{ copied: number }, AppError> => {
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

  function rebuildDatabase(data: SnapshotData | SnapshotDataV3, marker: VaultMarker): Result<void, AppError> {
    return withDatabase((db) => {
      try {
        db.exec("BEGIN IMMEDIATE");
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
          db.prepare(
            `INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id,
              sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version,
              review_state, accepted_revision, accepted_at, declined_at, decline_reason, withdrawn_at,
              consecutive_no_change_resolutions, first_fetched_at, review_engaged_at, pinned, archived_at, deleted_at,
              created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          const note = handoff.reviewNote;
          if (note !== null) {
            db.prepare(
              `INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at)
              VALUES (?, ?, ?, ?, CAST(? AS TEXT), ?, ?)`,
            ).run(
              note.handoffId,
              note.authorKind,
              note.authorProjectId,
              note.targetRevision,
              Buffer.from(note.body, "utf8"),
              note.createdAt,
              note.updatedAt,
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
        for (const memo of data.memos ?? []) insertMemoRow(db, memo);
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
        db.exec("COMMIT");
        return ok(undefined);
      } catch (error) {
        db.exec("ROLLBACK");
        return err(
          appError("INTERNAL_ERROR", `Rebuilding the installation from the backup failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    });
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
          // The writable setup of section 26: idempotently prepare the managed
          // content/ directory inside the validated selected Vault before the
          // exact Git change test, with no sentinel file and nothing written
          // outside the Vault root. An unavailable or unsafe target fails
          // through the validated Vault safety path.
          const opened = openVault(vaultPath, view.value.installationId);
          if (!opened.ok) return err(opened.error);
          try {
            managedDirectory(vaultPath, "content", true);
            return ok(undefined);
          } catch (error) {
            return err(
              appError("INTERNAL_ERROR", `Preparing the managed content directory failed: ${messageOf(error)}.`, {
                vaultPath,
                cause: String(error),
              }),
            );
          }
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
}): SnapshotDataV3 {
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
  const noteByHandoff = new Map<string, SnapshotReviewNote>();
  for (const row of rows.reviewNotes) {
    noteByHandoff.set(str(row.handoff_id), {
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
      reviewNote: noteByHandoff.get(str(row.id)) ?? null,
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
