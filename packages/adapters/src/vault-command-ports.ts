import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appError,
  err,
  expandConfigurationPath,
  ok,
  type AppError,
  type DrainReport,
  type Result,
  type VaultMovePorts,
  type VaultStatusPorts,
  type VaultVerifyPorts,
} from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import { createConfigStore, type ConfigStore } from "./config-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { collectVaultGarbage, createSqliteIntentLog, fsyncDirectory } from "./intent-log";
import { acquireLock, createNodeLockProbePorts } from "./lockfile";
import { openAndMigrate } from "./sqlite/migrator";
import { MIGRATIONS } from "./sqlite/migrations";
import { createVaultInitializer, openVault } from "./vault";

const COPY_BUFFER_BYTES = 1024 * 1024;

export interface NodeVaultCommandPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /** The literal `--to <path>` of a move, expanded for placement. */
  targetPath?: string | undefined;
  /** Test seam for the injected mid-move failure of AJ-09. */
  afterStagedCopy?: ((relativePath: string) => void) | undefined;
  clock?: { now(): Date } | undefined;
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
}

/**
 * The production Vault command ports over one installation: the configuration
 * store for identity and the atomic vault.path switch, the migrated database
 * for intent and registry reads, the TASK-021 guard for the marker, and the
 * lockfile primitive for vault-move.lock, whose live holder turns every other
 * storage mutation into SERVICE_PAUSED (RUN-014).
 */
export function createNodeVaultCommandPorts(options: NodeVaultCommandPortsOptions = {}): NodeVaultCommandPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const clock = options.clock ?? { now: () => new Date() };
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
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
      graceHours: config.gc.graceHours,
    });
  }

  function withDatabase<T>(
    body: (db: ReturnType<typeof openAndMigrate>["db"]) => Result<T, AppError>,
  ): Result<T, AppError> {
    try {
      const migrated = openAndMigrate(join(home.stateDir, "sorage.sqlite3"), MIGRATIONS);
      try {
        return body(migrated.db);
      } finally {
        migrated.db.close();
      }
    } catch (error) {
      return err(
        appError("INTERNAL_ERROR", `Reading the database failed: ${messageOf(error)}.`, { cause: String(error) }),
      );
    }
  }

  function pendingIntentCount(): Result<number, AppError> {
    return withDatabase((db) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as
        | Record<string, unknown>
        | undefined;
      return ok(Number(row?.["count"] ?? 0));
    });
  }

  /** The recorded current Artifacts; empty while the TASK-027 registry is absent. */
  function recordedArtifacts(): Result<Array<{ storageKey: string; sha256: string }>, AppError> {
    return withDatabase((db) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'").get() as
        | { name: string }
        | null
        | undefined;
      if (!table) return ok([]);
      const rows = db
        .prepare("SELECT storage_key, sha256 FROM artifacts WHERE materialized = 1")
        .all() as unknown as Array<{ storage_key: string; sha256: string }>;
      return ok(rows.map((row) => ({ storageKey: row.storage_key, sha256: row.sha256 })));
    });
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
    }
  }

  interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
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
      const artifactsRoot = join(vaultPath, "artifacts");
      const targetArtifacts = join(targetPath, "artifacts");
      const targetStaging = join(targetPath, "staging");

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
            // holds the very lock other processes would pause on.
            const log = createSqliteIntentLog({ db, installationId });
            return log.drain(vaultPath);
          }),
        pendingIntentCount,
        bindingDirectories: () =>
          withDatabase((db) => {
            const table = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_bindings'")
              .get() as { name: string } | null | undefined;
            if (!table) return ok([]);
            const rows = db.prepare("SELECT directory FROM project_bindings").all() as unknown as Array<{
              directory: string;
            }>;
            return ok(rows.map((row) => resolvePhysicalPath(row.directory)));
          }),
        lock: { acquire: acquireVaultMoveLock },
        target: {
          prepare(): Result<{ reusedScratch: boolean }, AppError> {
            let existed = false;
            try {
              existed = statSync(targetPath).isDirectory();
            } catch {
              existed = false;
            }
            if (existed) {
              const foreign = readdirSync(targetPath).filter((entry) => entry !== "staging" && entry !== "artifacts");
              if (foreign.length > 0) {
                return err(
                  appError(
                    "VAULT_INTEGRITY_ERROR",
                    `Refusing to move into the non-empty directory ${targetPath} because it is not a Vault target (VLT-003).`,
                    { targetPath, foreignEntries: foreign },
                  ),
                );
              }
            }
            // Clear scratch a failed attempt left behind, then prepare the layout.
            try {
              rmSync(targetStaging, { recursive: true, force: true });
              rmSync(targetArtifacts, { recursive: true, force: true });
              mkdirSync(targetStaging, { recursive: true });
              mkdirSync(targetArtifacts, { recursive: true });
            } catch (error) {
              return err(
                appError("INTERNAL_ERROR", `Preparing the move target failed: ${messageOf(error)}.`, {
                  targetPath,
                  cause: String(error),
                }),
              );
            }
            return ok({ reusedScratch: existed });
          },
          managedFiles(): Result<string[], AppError> {
            const files: string[] = [];
            try {
              for (const file of filesUnder(artifactsRoot)) {
                files.push(file.slice(artifactsRoot.length + 1));
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
            const source = join(artifactsRoot, relativePath);
            const stagedPath = join(targetStaging, randomUUID());
            try {
              return ok({ stagedPath, sha256: streamCopy(source, stagedPath) });
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
              return ok(hashFile(join(artifactsRoot, relativePath)));
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
            const destination = join(targetArtifacts, relativePath);
            try {
              mkdirSync(dirname(destination), { recursive: true });
              renameSync(stagedPath, destination);
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
            return ok(undefined);
          },
        },
        config: {
          current: () => {
            const now = installation();
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
          // The audit event ledger lands with TASK-028; until then the command
          // result and the structured process log carry the event.
          logVaultMoved(fromPath, toPath, artifactsMoved);
        },
        afterStagedCopy: options.afterStagedCopy,
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
        });
        const drained = log.drain(view.value.vaultPath);
        if (!drained.ok) return drained;
        // Garbage collection runs only after the drain, over the surviving
        // intents and the recorded storage keys (VLT-013, VLT-014); the
        // daemon's scheduled job takes the recurring pass over in 0.2. A failed
        // sweep never fails the command: doctor's vault.writable reports the
        // underlying condition.
        const surviving = log.pending();
        const recorded = recordedArtifacts();
        if (surviving.ok && recorded.ok) {
          void collectVaultGarbage(view.value.vaultPath, surviving.value, {
            liveStorageKeys: recorded.value.map((row) => row.storageKey),
            graceHours: view.value.graceHours,
            now: clock.now(),
          });
        }
        return drained;
      });
    },
  };
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
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  try {
    const resolved = realpathSync(current);
    return tail.length === 0 ? resolved : join(resolved, ...tail);
  } catch {
    return path;
  }
}

function logVaultMoved(fromPath: string, toPath: string, artifactsMoved: number): void {
  try {
    const home = createHomePaths({ SORAGE_HOME: process.env.SORAGE_HOME }, homedir());
    mkdirSync(home.logsDir, { recursive: true });
    const handle = openSync(join(home.logsDir, "sorage.log"), "a");
    try {
      writeSync(
        handle,
        `${new Date().toISOString()} ${JSON.stringify({ event: "VAULT_MOVED", fromPath, toPath, artifactsMoved })}\n`,
      );
    } finally {
      closeSync(handle);
    }
  } catch {
    // A log write never fails the move.
  }
}

/** Copies one file streaming through a fixed buffer, hashing in the same pass. */
function streamCopy(source: string, destination: string): string {
  const input = openSync(source, "r");
  let output: number | undefined;
  try {
    output = openSync(destination, "wx");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    for (;;) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      // A partial write must never pass the copy verification, which compares
      // two hashes of the same in-memory bytes and cannot see truncation.
      let written = 0;
      while (written < read) {
        const count = writeSync(output, buffer, written, read - written);
        if (count <= 0) throw new Error(`The move copy made no progress after ${written} of ${read} bytes.`);
        written += count;
      }
    }
    fsyncSync(output);
    closeSync(output);
    output = undefined;
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
