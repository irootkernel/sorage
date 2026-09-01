import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { HandoffDetailReadPorts, HandoffEventView, HandoffReadPorts, SendPorts } from "@sorage/core";
import { type AppError, type Result, appError, err, ok, SystemClock, UuidGenerator } from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import { createConfigStore } from "./config-store";
import { createSqliteEventLedger } from "./events";
import {
  createSqliteHandoffWriteStore,
  createSqliteRetentionStore,
  createSqliteRevisionStore,
  createSqliteTerminalStore,
} from "./handoffs";
import { createSqliteHandoffReadStore } from "./handoff-read-store";
import { createSqliteReviewStore } from "./review-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts } from "./lockfile";
import { inspectSourceFile } from "./import-source";
import { createNodeProjectPorts } from "./project-command-ports";
import { MIGRATIONS } from "./sqlite/migrations";
import { openAndMigrate } from "./sqlite/migrator";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The production wiring of the `sorage send` command of TASK-029: one migrated SQLite
 * connection shared by the Project ports and the Handoff write store, the Node
 * ArtifactStore aimed at the configured Vault, and the source inspection of VLT-015.
 * A `--body` send materializes its text through a scratch file under the system temp
 * directory, which is removed after staging; the staged copy under the Vault is the
 * durable one (HND-023).
 */

const DIGEST_BUFFER_BYTES = 1024 * 1024;

/** Digests a file with a bounded read, shared by the send and revise wirings. */
function digestFile(path: string): Result<string, AppError> {
  const inspected = inspectSourceFile(path);
  if (!inspected.ok) return err(inspected.error);
  try {
    const digest = createHash("sha256");
    const handle = openSync(inspected.value.resolvedPath, "r");
    try {
      const buffer = Buffer.alloc(DIGEST_BUFFER_BYTES);
      for (;;) {
        const read_ = readSync(handle, buffer, 0, DIGEST_BUFFER_BYTES, null);
        if (read_ === 0) break;
        digest.update(buffer.subarray(0, read_));
      }
    } finally {
      closeSync(handle);
    }
    return ok(digest.digest("hex"));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Digesting the source ${path} failed: ${String(error)}.`, { cause: String(error) }),
    );
  }
}

export interface NodeHandoffCommandPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /** Daemon-owned connection shared by every request route and closed on drain. */
  database?: SorageSqlite | undefined;
}

function databaseFor(options: NodeHandoffCommandPortsOptions, stateDir: string): SorageSqlite {
  return options.database ?? openAndMigrate(resolve(stateDir, "sorage.sqlite3"), MIGRATIONS).db;
}

function closeOwnedDatabase(options: NodeHandoffCommandPortsOptions, db: SorageSqlite): void {
  if (options.database === undefined) db.close();
}

export function createNodeSendPorts(options: NodeHandoffCommandPortsOptions = {}): SendPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const db = databaseFor(options, home.stateDir);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    closeOwnedDatabase(options, db);
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  const effective = read.value.config;
  const ledger = createSqliteEventLedger(db);
  return {
    projectPorts: createNodeProjectPorts({ env: env as HomeEnvironment, userHome, database: db }),
    handoffs: createSqliteHandoffWriteStore(db, ledger),
    artifactStore: createNodeArtifactStore({
      vaultPath: effective.vault.path,
      installationId: effective.installationId,
    }),
    ids: new UuidGenerator(),
    clock: new SystemClock(),
    config: {
      vaultPath: effective.vault.path,
      maxBytes: effective.artifact.maxBytes,
      allowUnregisteredSenders: effective.handoff.allowUnregisteredSenders,
    },
    bindingDirectories: bindingDirectoriesOf(db),
    inspectSource(path, currentUserHome) {
      const expanded = expandHome(path, currentUserHome);
      const inspected = inspectSourceFile(expanded);
      if (!inspected.ok) return err(inspected.error);
      return ok({
        resolvedSourcePath: inspected.value.resolvedPath,
        originalName: basename(inspected.value.resolvedPath),
      });
    },
    writeBodySource(text, storedName) {
      try {
        const directory = mkdtempSync(join(tmpdir(), "sorage-body-"));
        const sourcePath = join(directory, storedName);
        const handle = openSync(sourcePath, "wx");
        try {
          writeSync(handle, text, null, "utf8");
        } finally {
          closeSync(handle);
        }
        return ok({
          sourcePath,
          cleanup: () => {
            rmSync(directory, { recursive: true, force: true });
          },
        });
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Writing the --body scratch source failed: ${String(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    digestSource(path) {
      return digestFile(expandHome(path, userHome));
    },
  };
}

function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  if (path.startsWith("~/")) return join(userHome, path.slice(2));
  return resolve(path);
}

/** The production retention wiring of pin, archive, and deletion (TASK-034). */
export function createNodeRetentionPorts(options: NodeHandoffCommandPortsOptions = {}): ReturnType<
  typeof createNodeReviewPorts
> & {
  retention: ReturnType<typeof createSqliteRetentionStore>;
  artifact: {
    checksum: (storageKey: string) => Result<string, AppError>;
    remove: (storageKey: string) => Result<void, AppError>;
  };
} {
  const reviews = createNodeReviewPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const db = databaseFor(options, home.stateDir);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    closeOwnedDatabase(options, db);
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  const artifactStore = createNodeArtifactStore({
    vaultPath: read.value.config.vault.path,
    installationId: read.value.config.installationId,
  });
  return {
    ...reviews,
    retention: createSqliteRetentionStore(db, createSqliteEventLedger(db)),
    artifact: {
      checksum: (key) => artifactStore.checksum(key),
      pathOf: (key) => artifactStore.pathOf(key),
      remove: (key) => artifactStore.remove(key),
    },
  };
}

/** The production terminal wiring of accept, decline, and withdraw (TASK-033). */
export function createNodeTerminalPorts(options: NodeHandoffCommandPortsOptions = {}): ReturnType<
  typeof createNodeReviewPorts
> & {
  terminals: ReturnType<typeof createSqliteTerminalStore>;
} {
  const reviews = createNodeReviewPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const db = databaseFor(options, home.stateDir);
  return { ...reviews, terminals: createSqliteTerminalStore(db, createSqliteEventLedger(db)) };
}

/** The production revision wiring of `sorage revise` (TASK-032). */
export function createNodeRevisionPorts(options: NodeHandoffCommandPortsOptions = {}): ReturnType<
  typeof createNodeReviewPorts
> & {
  revisions: ReturnType<typeof createSqliteRevisionStore>;
  artifactStore: ReturnType<typeof createNodeArtifactStore>;
  config: { vaultPath: string; maxBytes: number; verifyChecksumOnFetch: boolean };
  bindingDirectories: string[];
  digestSource: (path: string) => Result<string, AppError>;
} {
  const reviews = createNodeReviewPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const db = databaseFor(options, home.stateDir);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    closeOwnedDatabase(options, db);
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  const effective = read.value.config;
  const artifactStore = createNodeArtifactStore({
    vaultPath: effective.vault.path,
    installationId: effective.installationId,
  });
  return {
    ...reviews,
    revisions: createSqliteRevisionStore(db, createSqliteEventLedger(db)),
    artifactStore,
    config: {
      vaultPath: effective.vault.path,
      maxBytes: effective.artifact.maxBytes,
      verifyChecksumOnFetch: effective.artifact.verifyChecksumOnFetch,
    },
    bindingDirectories: bindingDirectoriesOf(db),
    digestSource(path: string) {
      return digestFile(path);
    },
  };
}

/** The production read wiring of `sorage inbox`, `outbox`, `get`, and `fetch` (TASK-030). */
export function createNodeReviewPorts(
  options: NodeHandoffCommandPortsOptions = {},
): ReturnType<typeof createNodeHandoffReadPorts> & { reviews: ReturnType<typeof createSqliteReviewStore> } {
  const read = createNodeHandoffReadPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const db = databaseFor(options, home.stateDir);
  return { ...read, reviews: createSqliteReviewStore(db, createSqliteEventLedger(db)) };
}

export function createNodeHandoffReadPorts(options: NodeHandoffCommandPortsOptions = {}): HandoffDetailReadPorts {
  const send = createNodeSendPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const db = databaseFor(options, home.stateDir);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    closeOwnedDatabase(options, db);
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  const effective = read.value.config;
  return {
    projectPorts: send.projectPorts,
    handoffs: createSqliteHandoffReadStore(db, createSqliteEventLedger(db)),
    // The note read the detail surface needs is the same findNote seam the review
    // mutations load through, so the two can never disagree on the current Note.
    reviews: createSqliteReviewStore(db, createSqliteEventLedger(db)),
    events: {
      listRecent(handoffId: string, limit: number): Result<HandoffEventView[], AppError> {
        try {
          const rows = db
            .prepare(
              "SELECT id, event_type, actor_kind, actor_id, row_version, created_at FROM events WHERE handoff_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(handoffId, limit) as Array<{
            id: string;
            event_type: string;
            actor_kind: HandoffEventView["actorKind"];
            actor_id: string | null;
            row_version: number | null;
            created_at: string;
          }>;
          return ok(
            rows.map((row) => ({
              id: row.id,
              eventType: row.event_type,
              actorKind: row.actor_kind,
              actorId: row.actor_id,
              rowVersion: row.row_version,
              createdAt: row.created_at,
            })),
          );
        } catch (error) {
          return err(appError("INTERNAL_ERROR", `Reading the Handoff timeline failed: ${String(error)}`));
        }
      },
    },
    config: { vaultPath: effective.vault.path, verifyChecksumOnFetch: effective.artifact.verifyChecksumOnFetch },
    artifact: send.artifactStore,
    ids: send.ids,
    clock: send.clock,
  };
}

/** The resolved binding directories the Vault containment check runs against (VLT-017). */
function bindingDirectoriesOf(db: { prepare(sql: string): { all(...params: unknown[]): unknown } }): string[] {
  try {
    const rows = db.prepare("SELECT directory FROM project_bindings").all() as Array<{ directory: string }>;
    return rows.map((row) => row.directory);
  } catch {
    return [];
  }
}
