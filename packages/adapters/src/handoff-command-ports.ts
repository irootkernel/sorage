import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { HandoffReadPorts, SendPorts } from "@sorage/core";
import { appError, err, ok, SystemClock, UuidGenerator } from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import { createConfigStore } from "./config-store";
import { createSqliteEventLedger } from "./events";
import { createSqliteHandoffWriteStore, createSqliteRevisionStore, createSqliteTerminalStore } from "./handoffs";
import { createSqliteHandoffReadStore } from "./handoff-read-store";
import { createSqliteReviewStore } from "./review-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts } from "./lockfile";
import { inspectSourceFile } from "./import-source";
import { createNodeProjectPorts } from "./project-command-ports";
import { MIGRATIONS } from "./sqlite/migrations";
import { openAndMigrate } from "./sqlite/migrator";

/**
 * The production wiring of the `sorage send` command of TASK-029: one migrated SQLite
 * connection shared by the Project ports and the Handoff write store, the Node
 * ArtifactStore aimed at the configured Vault, and the source inspection of VLT-015.
 * A `--body` send materializes its text through a scratch file under the system temp
 * directory, which is removed after staging; the staged copy under the Vault is the
 * durable one (HND-023).
 */

const DIGEST_BUFFER_BYTES = 1024 * 1024;

export interface NodeHandoffCommandPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
}

export function createNodeSendPorts(options: NodeHandoffCommandPortsOptions = {}): SendPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const { db } = openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    db.close();
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  const effective = read.value.config;
  const ledger = createSqliteEventLedger(db);
  return {
    projectPorts: createNodeProjectPorts({ env: env as HomeEnvironment, userHome }),
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
      const inspected = inspectSourceFile(expandHome(path, userHome));
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
          appError("INTERNAL_ERROR", `Digesting the source ${path} failed: ${String(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}

function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  if (path.startsWith("~/")) return join(userHome, path.slice(2));
  return resolve(path);
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
  const { db } = openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS);
  return { ...reviews, terminals: createSqliteTerminalStore(db, createSqliteEventLedger(db)) };
}

/** The production revision wiring of `sorage revise` (TASK-032). */
export function createNodeRevisionPorts(options: NodeHandoffCommandPortsOptions = {}): ReturnType<
  typeof createNodeReviewPorts
> & {
  revisions: ReturnType<typeof createSqliteRevisionStore>;
  artifactStore: ReturnType<typeof createNodeArtifactStore>;
  config: { vaultPath: string; maxBytes: number; verifyChecksumOnFetch: boolean };
} {
  const reviews = createNodeReviewPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const { db } = openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    db.close();
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
  const { db } = openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS);
  return { ...read, reviews: createSqliteReviewStore(db, createSqliteEventLedger(db)) };
}

export function createNodeHandoffReadPorts(options: NodeHandoffCommandPortsOptions = {}): HandoffReadPorts {
  const send = createNodeSendPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const { db } = openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    db.close();
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  const effective = read.value.config;
  return {
    projectPorts: send.projectPorts,
    handoffs: createSqliteHandoffReadStore(db, createSqliteEventLedger(db)),
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
