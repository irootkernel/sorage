import {
  digestManagedFile,
  managedDirectory,
  managedFile,
  managedPath,
  managedRoot,
  openManagedFile,
} from "./managed-paths";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  type AppError,
  appError,
  type BindingKind,
  type Configuration,
  type DrainReport,
  err,
  expandConfigurationPath,
  isLegacyRootBinding,
  isManagedContentStorageKey,
  isManagedStorageKey,
  ok,
  type Result,
  USER_ACTOR,
  type VaultMovePorts,
  type VaultStatusPorts,
  type VaultVerifyPorts,
  workspaceRootOf,
} from "@sorage/core";
import { openAdapterContext } from "./adapter-context";
import { createNodeArtifactStore } from "./artifact-store";
import type { ReadConfiguration } from "./config-store";
import { validateArtifactContentLinks, validateChannelContentLinks, validateMemoContentLinks } from "./content-layout";
import { createSqliteEventLedger } from "./events";
import { copyFileHashed, fsyncDirectory, placeExclusive } from "./fs-atomic";
import type { HomeEnvironment } from "./home";
import { createSqliteIntentLog } from "./intent-log";
import { acquireVaultMoveLock, runStartupMaintenance } from "./maintenance";
import { storageContentionOf } from "./storage-contention";
import type { SorageSqlite } from "./sqlite/connection";
import { clearMoveFence, setMoveFenceAndCountPending } from "./sqlite/move-fence";
import { appendStructuredLog } from "./structured-log";
import { createVaultInitializer, openVault } from "./vault";

const COPY_BUFFER_BYTES = 1024 * 1024;
const MOVE_SCRATCH_MARKER = ".sorage-move-scratch.json";

export interface NodeVaultCommandPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /** The literal `--to <path>` of a move, expanded for placement. */
  targetPath?: string | undefined;
  /** Test seam for the injected mid-move failure of AJ-09. */
  afterStagedCopy?: ((relativePath: string) => void) | undefined;
  clock?: { now(): Date } | undefined;
  /** Borrowed connection: caller owns its lifetime and closes it (ADR-0036). */
  database?: SorageSqlite | undefined;
  /** Borrowed operational configuration already read by an enclosing command (ADR-0036). */
  configuration?: ReadConfiguration | undefined;
  /**
   * The invoking command family of SHR-015: when set, storage-preparation
   * contention in this composition's open, migration, and drain maps to the
   * stamped `STORAGE_INSPECTION_UNAVAILABLE` refusal with that family's
   * wording, and the operational configuration read distinguishes an
   * unreadable file. Undefined callers (vault, Memo, daemon, backup) keep
   * today's behavior exactly.
   */
  contentionSurface?: "channel" | "handoff" | undefined;
}

export interface NodeVaultCommandPorts {
  statusPorts(): Result<VaultStatusPorts, AppError>;
  verifyPorts(): Result<VaultVerifyPorts, AppError>;
  movePorts(): Result<VaultMovePorts, AppError>;
  /** The RUN-002 process-start obligation every vault command runs first. */
  drainAtStart(): Result<DrainReport, AppError>;
}

interface InstallationView {
  vaultPath: string;
  installationId: string;
  etag: string;
  graceHours: number;
  logging: Configuration["logging"];
}

/**
 * The production Vault command ports over one installation: the configuration
 * store for identity and the atomic vault.path switch, the migrated database
 * for intent and registry reads, the TASK-021 guard for the marker, and the
 * lockfile primitive for vault-move.lock, whose live holder turns every other
 * storage mutation into SERVICE_PAUSED (RUN-014).
 */
export function createNodeVaultCommandPorts(options: NodeVaultCommandPortsOptions = {}): NodeVaultCommandPorts {
  const context = openAdapterContext({
    order: "config-first",
    env: options.env,
    userHome: options.userHome,
    clock: options.clock,
    database: options.database,
    configuration: options.configuration,
    contentionSurface: options.contentionSurface,
  });
  const { userHome, clock, home, configStore: store } = context;

  function installation(fresh = false): Result<InstallationView, AppError> {
    // A surfaced composition reads operationally: an unreadable configuration
    // is CONFIG_INVALID rather than the swallowed-absence NOT_INITIALIZED.
    const read = context.readConfiguration(options.contentionSurface !== undefined ? "operation" : "read", fresh);
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
      graceHours: config.gc.graceHours,
      logging: config.logging,
    });
  }

  function withDatabase<T>(body: (db: SorageSqlite) => Result<T, AppError>): Result<T, AppError> {
    return context.withDatabase(body, { errorPrefix: "Reading the database failed", attachRawCause: true });
  }

  function pendingIntentCount(): Result<number, AppError> {
    return withDatabase((db) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as
        | Record<string, unknown>
        | undefined;
      return ok(Number(row?.count ?? 0));
    });
  }

  function recordedArtifactsOn(db: SorageSqlite): Result<Array<{ storageKey: string; sha256: string }>, AppError> {
    try {
      // The shared content-link guard runs before the missing-table empty
      // branch: a normalized database whose artifacts table or referenced
      // record rows are missing must surface as an integrity error — the
      // verify census and the GC live-key proof would otherwise silently omit
      // Artifacts they could not resolve (SHR-004, SHR-008, SHR-014).
      const links = validateArtifactContentLinks(db);
      if (!links.ok) return links;
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'").get() as
        | { name: string }
        | null
        | undefined;
      if (!table) return ok([]);
      const rows = db
        .prepare(
          "SELECT c.storage_key AS storage_key, c.sha256 AS sha256 FROM artifacts a JOIN content_records c ON c.id = a.content_record_id WHERE c.materialized = 1 AND c.storage_key IS NOT NULL",
        )
        .all() as unknown as Array<{ storage_key: string; sha256: string }>;
      return ok(rows.map((row) => ({ storageKey: row.storage_key, sha256: row.sha256 })));
    } catch (error) {
      return err(
        appError("INTERNAL_ERROR", `Reading the recorded artifacts failed: ${messageOf(error)}.`, {
          cause: String(error),
        }),
      );
    }
  }

  /** The recorded current Artifacts; empty while the TASK-027 registry is absent. */
  function recordedArtifacts(): Result<Array<{ storageKey: string; sha256: string }>, AppError> {
    return withDatabase(recordedArtifactsOn);
  }

  function directoryStats(path: string): Result<{ count: number; bytes: number }, AppError> {
    let count = 0;
    let bytes = 0;
    try {
      for (const file of filesUnder(path)) {
        count++;
        bytes += statSync(file).size;
      }
      return ok({ count, bytes });
    } catch (error) {
      return err(appError("INTERNAL_ERROR", `Reading ${path} failed: ${messageOf(error)}.`, { cause: String(error) }));
    }
  }

  function* filesUnder(root: string): Generator<string> {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true }) as unknown as Dirent[];
    } catch (error) {
      // An absent root holds no files; every other failure — an unreadable
      // directory among them — must surface, or a census would silently omit
      // managed bytes it could not list and a move would relocate incomplete.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) yield* filesUnder(path);
      else if (entry.isFile()) yield path;
      else throw new Error(`The managed tree contains an unsafe entry: ${path}`);
    }
  }

  interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  const acquireMoveLock = (): Result<{ release: () => void }, AppError> => acquireVaultMoveLock(home, clock);

  return {
    statusPorts(): Result<VaultStatusPorts, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      const vaultPath = view.value.vaultPath;
      return ok({
        vaultPath,
        openVault: () => openVault(vaultPath, view.value.installationId),
        artifactsStats: () => directoryStats(join(vaultPath, "artifacts")),
        stagingStats: () => directoryStats(join(vaultPath, "staging")),
        pendingIntentCount,
      });
    },

    verifyPorts(): Result<VaultVerifyPorts, AppError> {
      // One installation read builds every port, so a relocation that switches
      // the configuration mid-call cannot leave status ports aimed at one Vault
      // and an artifact store at another.
      const view = installation();
      if (!view.ok) return err(view.error);
      const vaultPath = view.value.vaultPath;
      return ok({
        vaultPath,
        openVault: () => openVault(vaultPath, view.value.installationId),
        artifactsStats: () => directoryStats(join(vaultPath, "artifacts")),
        stagingStats: () => directoryStats(join(vaultPath, "staging")),
        pendingIntentCount,
        artifactStore: createNodeArtifactStore({ vaultPath, installationId: view.value.installationId }),
        graceHours: view.value.graceHours,
        recordedArtifacts,
        recordedContent: () =>
          withDatabase((db) => {
            // The Memo link guard runs at this census boundary itself, not only
            // through the maintenance cleanup: a schema-10 database whose Memo
            // rows lost their record references fails the verify proof loudly
            // (SHR-004, SHR-014).
            const memoLinks = validateMemoContentLinks(db);
            if (!memoLinks.ok) return memoLinks;
            // The Channel link guard joins the same census boundary under the
            // same rule: a schema-11 database whose message rows lost their
            // record references fails the verify proof loudly, never a healthy
            // census over broken links (SHR-004, the TASK-109 reviewed plan).
            const channelLinks = validateChannelContentLinks(db);
            if (!channelLinks.ok) return channelLinks;
            const table = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
              .get() as { name: string } | null | undefined;
            if (!table) return ok([]);
            const rows = db
              .prepare("SELECT storage_key, inline_text, sha256 FROM content_records WHERE materialized = 1")
              .all() as unknown as Array<{ storage_key: string | null; inline_text: string | null; sha256: string }>;
            return ok(
              rows.map((row) => ({ storageKey: row.storage_key, inlineText: row.inline_text, sha256: row.sha256 })),
            );
          }),
        contentChecksum: (storageKey: string) => {
          if (!isManagedContentStorageKey(storageKey) && !isManagedStorageKey(storageKey)) {
            return err(
              appError("CONTENT_CORRUPTED", `A content record names the non-managed storage key ${storageKey}.`, {
                storageKey,
              }),
            );
          }
          try {
            return ok(digestManagedFile(vaultPath, storageKey).sha256);
          } catch {
            return err(
              appError("CONTENT_CORRUPTED", `Content is missing or unreadable at the managed key ${storageKey}.`, {
                storageKey,
              }),
            );
          }
        },
        stagingEntries: () => {
          const entries: Array<{ name: string; mtimeMs: number }> = [];
          try {
            for (const name of readdirSync(join(vaultPath, "staging"))) {
              const stats = statSync(join(vaultPath, "staging", name));
              if (stats.isFile()) entries.push({ name, mtimeMs: stats.mtimeMs });
            }
          } catch {
            // An absent staging directory holds no entries.
          }
          return ok(entries);
        },
      });
    },

    movePorts(): Result<VaultMovePorts, AppError> {
      const view = installation();
      if (!view.ok) return err(view.error);
      if (options.targetPath === undefined || options.targetPath.trim() === "") {
        return err(appError("NOT_INITIALIZED", "sorage vault move requires --to <path>.", {}));
      }
      const vaultPath = view.value.vaultPath;
      const targetPath = expandConfigurationPath(options.targetPath, userHome, home.home);
      const installationId = view.value.installationId;

      return ok({
        vaultPath,
        targetPath,
        installationId,
        resolvedVaultPath: resolvePhysicalPath(vaultPath),
        resolvedTargetPath: resolvePhysicalPath(targetPath),
        openVault: (path) => openVault(path, installationId),
        drainUnderLock: () =>
          withDatabase((db) => {
            // The lock owner's own drain: no pause guard, because this process
            // holds the very lock other processes would pause on. The real
            // ledger is wired so the mover's drain is a first-class completion
            // path whose success and failure events land like any production
            // drain's (SEC-012).
            const log = createSqliteIntentLog({
              db,
              installationId,
              events: createSqliteEventLedger(db),
            });
            return log.drain(vaultPath);
          }),
        fenceAndCountPendingIntents: () =>
          withDatabase((db) => setMoveFenceAndCountPending(db, process.pid, clock.now().toISOString())),
        releaseSwitchFence: () => withDatabase((db) => clearMoveFence(db)),
        bindingDirectories: () =>
          withDatabase((db) => {
            const table = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_bindings'")
              .get() as { name: string } | null | undefined;
            if (!table) return ok([]);
            const rows = db.prepare("SELECT directory, binding_kind FROM project_bindings").all() as unknown as Array<{
              directory: string;
              binding_kind: string;
            }>;
            return ok(resolveContainmentBindingDirectories(rows));
          }),
        lock: { acquire: acquireMoveLock },
        target: {
          prepare(): Result<{ reusedScratch: boolean }, AppError> {
            try {
              const existed = existsSync(targetPath);
              const root = managedRoot(targetPath, true);
              const entries = readdirSync(root);
              let reusedScratch = false;
              if (existed && entries.length > 0) {
                const marker = readMoveScratchMarker(root);
                const foreign = entries.filter(
                  (entry) => ![MOVE_SCRATCH_MARKER, "staging", "artifacts", "content"].includes(entry),
                );
                if (
                  marker === null ||
                  marker.installationId !== installationId ||
                  marker.sourceVaultPath !== resolvePhysicalPath(vaultPath) ||
                  foreign.length > 0
                )
                  return err(
                    appError(
                      "VAULT_INTEGRITY_ERROR",
                      "The nonempty move target does not carry this Installation's exact scratch ownership.",
                      { targetPath, foreignEntries: foreign },
                    ),
                  );
                reusedScratch = true;
              }
              // Check every owned subtree before creating a marker or removing scratch.
              for (const key of ["staging", "artifacts", "content"]) {
                const directory = managedDirectory(root, key);
                if (directory !== undefined)
                  for (const file of filesUnder(directory)) {
                    void file;
                  }
              }
              if (!reusedScratch)
                writeMoveScratchMarker(join(root, MOVE_SCRATCH_MARKER), {
                  installationId,
                  sourceVaultPath: resolvePhysicalPath(vaultPath),
                });
              for (const key of ["staging", "artifacts", "content"]) {
                const directory = managedDirectory(root, key);
                if (directory !== undefined) rmSync(directory, { recursive: true });
                managedDirectory(root, key, true);
              }
              return ok({ reusedScratch });
            } catch (error) {
              return err(
                appError("VAULT_INTEGRITY_ERROR", `Preparing the owned move target failed: ${messageOf(error)}.`, {
                  targetPath,
                  cause: String(error),
                }),
              );
            }
          },
          managedFiles(): Result<string[], AppError> {
            const files: string[] = [];
            try {
              // Root-relative managed paths, so one mechanism relocates the
              // `artifacts/` tree and the M9 `content/` subtree together and
              // the copy, verify, and activate arms stay identical.
              const sourceRoot = managedRoot(vaultPath);
              for (const key of ["artifacts", "content"] as const) {
                const directory = managedDirectory(sourceRoot, key);
                if (directory === undefined) continue;
                for (const file of filesUnder(directory)) files.push(relative(sourceRoot, file));
              }
            } catch (error) {
              return err(
                appError("INTERNAL_ERROR", `Listing managed files failed: ${messageOf(error)}.`, {
                  cause: String(error),
                }),
              );
            }
            return ok(files);
          },
          stageCopy(relativePath: string): Result<{ stagedPath: string; sha256: string }, AppError> {
            try {
              const stagedPath = managedPath(targetPath, `staging/${randomUUID()}`);
              return ok({ stagedPath, sha256: streamCopy(vaultPath, relativePath, stagedPath) });
            } catch (error) {
              return err(
                appError("INTERNAL_ERROR", `Copying ${relativePath} failed: ${messageOf(error)}.`, {
                  relativePath,
                  cause: String(error),
                }),
              );
            }
          },
          sourceChecksum(relativePath: string): Result<string, AppError> {
            try {
              return ok(digestManagedFile(vaultPath, relativePath).sha256);
            } catch (error) {
              return err(
                appError("INTERNAL_ERROR", `Hashing ${relativePath} failed: ${messageOf(error)}.`, {
                  relativePath,
                  cause: String(error),
                }),
              );
            }
          },
          activate(relativePath: string, stagedPath: string): Result<void, AppError> {
            try {
              const sourceKey = relative(managedRoot(targetPath), stagedPath);
              const source = managedFile(targetPath, sourceKey);
              if (source.stat === undefined) throw new Error("The staged move copy is missing");
              const destination = managedPath(targetPath, relativePath, true);
              managedFile(targetPath, relativePath);
              renameSync(source.path, destination);
              fsyncDirectory(dirname(destination));
              return ok(undefined);
            } catch (error) {
              return err(
                appError("INTERNAL_ERROR", `Placing ${relativePath} in the target failed: ${messageOf(error)}.`, {
                  relativePath,
                  cause: String(error),
                }),
              );
            }
          },
          finalize(): Result<void, AppError> {
            const created = createVaultInitializer(clock).initialize(targetPath, installationId);
            if (!created.ok) return err(created.error);
            rmSync(join(targetPath, MOVE_SCRATCH_MARKER), { force: true });
            fsyncDirectory(targetPath);
            return ok(undefined);
          },
        },
        config: {
          current: () => {
            const now = installation(true);
            if (!now.ok) return err(now.error);
            return ok({ vaultPath: now.value.vaultPath, etag: now.value.etag });
          },
          updateVaultPath(nextPath: string, etag: string): Result<void, AppError> {
            const read = store.read();
            if (!read.ok) return err(read.error);
            if (read.value === null) {
              return err(appError("NOT_INITIALIZED", "Sorage is not initialized.", {}));
            }
            const config = read.value.config;
            config.vault.path = nextPath;
            const written = store.write(config, { etag });
            if (!written.ok) return err(written.error);
            return ok(undefined);
          },
        },
        emitMoved: (fromPath, toPath, artifactsMoved) => {
          // The audit event lands in the append-only ledger; the structured process
          // log keeps its line, and the ledger is the durable record (SEC-012).
          const recorded = withDatabase((db) => {
            const ledger = createSqliteEventLedger(db);
            return ledger.appendStandalone({
              id: crypto.randomUUID(),
              eventType: "VAULT_MOVED",
              actor: USER_ACTOR,
              metadata: { fromPath, toPath, artifactsMoved },
              createdAt: clock.now().toISOString(),
            });
          });
          if (!recorded.ok) return recorded;
          appendStructuredLog(
            { level: "warn", event: "VAULT_MOVED", fromPath, toPath, artifactsMoved },
            home,
            view.value.logging,
          );
          return ok(undefined);
        },
        afterStagedCopy: options.afterStagedCopy,
      });
    },

    drainAtStart(): Result<DrainReport, AppError> {
      // A surfaced composition maps a contention-signature drain failure onto
      // the stamped refusal; every other error result keeps its own code.
      const classifyDrainError = (error: AppError): AppError =>
        options.contentionSurface !== undefined
          ? (storageContentionOf(error, options.contentionSurface) ?? error)
          : error;
      const view = installation();
      if (!view.ok) return err(view.error);
      return withDatabase((db) =>
        runStartupMaintenance(db, {
          home,
          vaultPath: view.value.vaultPath,
          installationId: view.value.installationId,
          graceHours: view.value.graceHours,
          clock,
          liveStorageKeys: (database) => {
            const recorded = recordedArtifactsOn(database);
            return recorded.ok ? ok(recorded.value.map((row) => row.storageKey)) : recorded;
          },
          classify: classifyDrainError,
        }),
      );
    },
  };
}

interface MoveScratchMarker {
  installationId: string;
  sourceVaultPath: string;
}

function readMoveScratchMarker(root: string): MoveScratchMarker | null {
  let handle: number | undefined;
  try {
    handle = openManagedFile(root, MOVE_SCRATCH_MARKER);
    const parsed = JSON.parse(readFileSync(handle, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const marker = parsed as Partial<MoveScratchMarker> & { type?: unknown };
    if (
      marker.type !== "sorage-vault-move-scratch" ||
      typeof marker.installationId !== "string" ||
      typeof marker.sourceVaultPath !== "string"
    ) {
      return null;
    }
    return { installationId: marker.installationId, sourceVaultPath: marker.sourceVaultPath };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function writeMoveScratchMarker(path: string, marker: MoveScratchMarker): void {
  placeExclusive(path, `${JSON.stringify({ type: "sorage-vault-move-scratch", ...marker }, null, 2)}\n`, {
    noFollow: false,
    fileFsync: true,
    dirFsync: "required",
    cleanupOwnedOnError: false,
  });
}

/**
 * Builds the deduplicated, physically resolved binding directory census used by
 * runtime Vault containment checks (`send`, `revise`, `vault move`, VLT-017,
 * ADR-0041): excludes pre-existing legacy `"/"` rows first so one invalid row
 * cannot break unrelated valid Projects, and for every valid binding emits its
 * physically resolved `workspaceRootOf` plus its physically resolved stored
 * `directory` when distinct (covering `git_repository` working trees).
 */
export function resolveContainmentBindingDirectories(
  rows: ReadonlyArray<{ directory: string; binding_kind: string }>,
): string[] {
  const resolved = new Set<string>();
  for (const row of rows) {
    const bindingKind: BindingKind = row.binding_kind === "git_repository" ? "git_repository" : "directory";
    if (isLegacyRootBinding({ directory: row.directory, bindingKind })) continue;
    const root = workspaceRootOf({ directory: row.directory, bindingKind });
    const physicalRoot = resolvePhysicalPath(root);
    resolved.add(physicalRoot);
    const physicalDir = resolvePhysicalPath(row.directory);
    if (physicalDir !== physicalRoot) {
      resolved.add(physicalDir);
    }
  }
  return [...resolved];
}

/**
 * Resolves one path to its physical spelling through the nearest existing
 * ancestor, so a symlink or a platform prefix such as /private on darwin
 * cannot disguise a nested layout from a prefix comparison. A path whose
 * root does not resolve at all is returned unchanged.
 */
export function resolvePhysicalPath(path: string): string {
  const tail: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(parent === "/" ? current.slice(1) : current.slice(parent.length + 1));
    current = parent;
  }
  try {
    const resolved = realpathSync(current);
    return tail.length === 0 ? resolved : join(resolved, ...tail);
  } catch {
    return path;
  }
}

/** Copies one file streaming through a fixed buffer, hashing in the same pass. */
function streamCopy(sourceRoot: string, sourceKey: string, destination: string): string {
  const input = openManagedFile(sourceRoot, sourceKey);
  try {
    return copyFileHashed(input, destination, {
      mode: "exclusive-direct",
      fileFsync: true,
      dirFsync: "none",
      bufferBytes: COPY_BUFFER_BYTES,
    });
  } finally {
    closeSync(input);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
