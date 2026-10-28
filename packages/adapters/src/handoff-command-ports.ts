import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { ArtifactStore, HandoffDetailReadPorts, HandoffEventView, RevisionPorts, SendPorts } from "@sorage/core";
import { type AppError, appError, err, ok, type Result, SystemClock, UuidGenerator } from "@sorage/core";
import { createNodeArtifactStore } from "./artifact-store";
import { createArtifactBodyPorts } from "./artifact-body-ports";
import { createConfigStore, type ReadConfiguration } from "./config-store";
import { createSqliteContentStore, sqliteContentReferences } from "./content-store";
import { createSqliteEventLedger } from "./events";
import { createSqliteHandoffReadStore } from "./handoff-read-store";
import {
  type ArtifactContentBindings,
  createSqliteHandoffWriteStore,
  createSqliteRetentionStore,
  createSqliteRevisionStore,
  createSqliteTerminalStore,
} from "./handoffs";
import { createHomePaths, type HomeEnvironment } from "./home";
import { digestFile, inspectSourceFile } from "./import-source";
import { executeLegacyIntent } from "./intent-log";
import { createNodeLockProbePorts, vaultMoveLockHeld } from "./lockfile";
import { createNodeProjectPorts } from "./project-command-ports";
import { AppCommandError, carriedAppError, storageContentionOf } from "./storage-contention";
import { appendStructuredLog } from "./structured-log";
import { createSqliteReviewStore } from "./review-store";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
import { openVault } from "./vault";

/**
 * The production wiring of the `sorage send` command of TASK-029: one migrated SQLite
 * connection shared by the Project ports and the Handoff write store, the Node
 * ArtifactStore aimed at the configured Vault, and the source inspection of VLT-015.
 * A `--body` send materializes its text through a scratch file under the system temp
 * directory, which is removed after staging; the staged copy under the Vault is the
 * durable one (HND-023).
 */

export interface NodeHandoffCommandPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  /** Borrowed connection: its daemon, covered-read caller or enclosing factory owns its lifetime. */
  database?: SorageSqlite | undefined;
  /** Shared clock for domain decisions and 24-hour idempotency expiry. */
  clock?: { now(): Date } | undefined;
  /**
   * The post-commit completion warning sink of SHR-015's category (i): the
   * CLI buffers it to stderr after the committed result; the daemon logs it
   * server-side. A throwing sink never changes the committed outcome.
   */
  completionWarning?: ((text: string) => void) | undefined;
}

function databaseFor(options: NodeHandoffCommandPortsOptions, stateDir: string): SorageSqlite {
  if (options.database !== undefined) return options.database;
  const plan = productionMigrationPlan();
  try {
    return openAndMigrate(resolve(stateDir, "sorage.sqlite3"), plan.migrations, { rebuilds: plan.rebuilds }).db;
  } catch (error) {
    // A schema admission refusal keeps its public code; storage-preparation
    // contention becomes the stamped Handoff refusal (SHR-015).
    if (asSchemaAdmission(error) !== null || error instanceof AppCommandError) throw error;
    const contention = storageContentionOf(error, "handoff");
    if (contention !== null) throw carriedAppError(contention);
    throw error;
  }
}

/** Returns the operational configuration, throwing the typed carrier when absent or unreadable (SHR-015). */
function operableConfiguration(
  config: ReturnType<typeof createConfigStore>,
  home: { configFile: string },
): ReadConfiguration {
  const read = config.readForOperation();
  if (!read.ok || read.value === null) {
    throw carriedAppError(
      read.ok
        ? appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: home.configFile })
        : read.error,
    );
  }
  return read.value;
}

/** Construction owns only a connection it acquired; successful CLI ports keep process-scoped lifetime. */
function composeWithDatabase<T>(
  options: NodeHandoffCommandPortsOptions,
  stateDir: string,
  compose: (database: SorageSqlite) => T,
): T {
  const db = databaseFor(options, stateDir);
  try {
    return compose(db);
  } catch (error) {
    if (options.database === undefined) {
      try {
        db.close();
      } catch {
        // Cleanup must not replace the original configuration or construction refusal.
      }
    }
    throw error;
  }
}

/**
 * The ordinary production physical wrappers around the one shared legacy
 * executor of section 3: dependency eligibility runs inside
 * `executeLegacyIntent` before any unlink filesystem effect, and the marker /
 * live-fence precondition preserves the ArtifactStore's own mutation guard.
 * The executor's outcomes map onto the store-level results the core commands
 * already gate completion on; a deferral becomes an internal non-ok result the
 * current core callsites swallow, so the intent stays pending for the drain —
 * no fake public pause and no new error catalog entry.
 */
function legacyActivateThroughExecutor(
  db: SorageSqlite,
  vaultPath: string,
  installationId: string,
  runDir: string,
  request: { stagingPath: string; storageKey: string },
): Result<{ path: string }, AppError> {
  const precondition = (): Result<unknown, AppError> => {
    if (vaultMoveLockHeld(runDir)) {
      return err(
        appError(
          "SERVICE_PAUSED",
          "A Vault move or restore is in progress; this mutation paused instead of racing it.",
          { lockPath: join(runDir, "vault-move.lock") },
        ),
      );
    }
    return openVault(vaultPath, installationId);
  };
  const fromPath = relative(vaultPath, request.stagingPath);
  let executed: Result<string, AppError>;
  try {
    executed = executeLegacyIntent(
      db,
      { op: "activate", fromPath, toPath: request.storageKey },
      vaultPath,
      precondition,
    );
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Placing ${request.storageKey} failed: ${String(error)}.`, {
        storageKey: request.storageKey,
      }),
    );
  }
  if (!executed.ok) return err(executed.error);
  if (executed.value === "done") return ok({ path: join(vaultPath, request.storageKey) });
  if (executed.value === "destination-conflict") {
    return err(
      appError(
        "VAULT_INTEGRITY_ERROR",
        `Refusing to overwrite the existing path ${request.storageKey}; every Artifact needs its own artifact-id slot.`,
        { storageKey: request.storageKey },
      ),
    );
  }
  return err(
    appError("INTERNAL_ERROR", `The staged source for ${request.storageKey} is unsafe or vanished.`, {
      storageKey: request.storageKey,
    }),
  );
}

function legacyRemoveThroughExecutor(
  db: SorageSqlite,
  vaultPath: string,
  installationId: string,
  runDir: string,
  storageKey: string,
): Result<void, AppError> {
  // The same marker / live-fence mutation guard the ordinary activation
  // carries: an unlink is a physical Vault mutation and may not bypass the
  // boundary the ArtifactStore enforces (RUN-014, VLT-019).
  const precondition = (): Result<unknown, AppError> => {
    if (vaultMoveLockHeld(runDir)) {
      return err(
        appError(
          "SERVICE_PAUSED",
          "A Vault move or restore is in progress; this mutation paused instead of racing it.",
          { lockPath: join(runDir, "vault-move.lock") },
        ),
      );
    }
    return openVault(vaultPath, installationId);
  };
  let executed: Result<string, AppError>;
  try {
    executed = executeLegacyIntent(db, { op: "unlink", fromPath: null, toPath: storageKey }, vaultPath, precondition);
  } catch (error) {
    return err(appError("INTERNAL_ERROR", `Removing ${storageKey} failed: ${String(error)}.`, { storageKey }));
  }
  if (!executed.ok) return err(executed.error);
  if (executed.value === "done") return ok(undefined);
  if (executed.value === "deferred") {
    return err(
      appError(
        "SERVICE_PAUSED",
        "deferred: a pending activation still targets this storage key; the startup drain will unlink it after that activation resolves",
        { storageKey },
      ),
    );
  }
  return err(
    appError("INTERNAL_ERROR", `The managed path ${storageKey} is unsafe and was not removed.`, { storageKey }),
  );
}

/** The ordinary command surface over the shared executor; staging and serving stay on the real store. */
function legacyExecutorArtifactStore(
  db: SorageSqlite,
  base: ArtifactStore,
  vaultPath: string,
  installationId: string,
  runDir: string,
): ArtifactStore {
  return {
    stage: (request) => base.stage(request),
    activate: (request) => legacyActivateThroughExecutor(db, vaultPath, installationId, runDir, request),
    pathOf: (storageKey) => base.pathOf(storageKey),
    openReadable: (storageKey) => base.openReadable(storageKey),
    exists: (storageKey) => base.exists(storageKey),
    checksum: (storageKey) => base.checksum(storageKey),
    remove: (storageKey) => legacyRemoveThroughExecutor(db, vaultPath, installationId, runDir, storageKey),
  };
}

/**
 * The schema-9 Handoff mutation binding (SHR-004): the shared content store's
 * transaction-composable primitives plus its id generator, so every Artifact
 * row and its immutable record commit in the domain's own transaction, and a
 * superseded record leaves only through the shared reference-proof removal.
 */
function artifactContentBindings(
  db: SorageSqlite,
  ledger: ReturnType<typeof createSqliteEventLedger>,
  vaultPath: string,
  installationId: string,
  now: () => Date,
): ArtifactContentBindings {
  const store = createSqliteContentStore({ db, vaultPath, installationId, ledger });
  const references = sqliteContentReferences(db);
  const ids = new UuidGenerator();
  return {
    insertArtifactContentRecord: (record) => store.insertContentRecord(record),
    removeArtifactContentRecord: (recordId) => store.removeContentRecordInTx(recordId, { references, now: now() }),
    nextContentRecordId: () => ids.next(),
  };
}

export function createNodeSendPorts(options: NodeHandoffCommandPortsOptions = {}): SendPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  return composeWithDatabase(options, home.stateDir, (db) => {
    const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
    const effective = operableConfiguration(config, home).config;
    const ledger = createSqliteEventLedger(db);
    const clock = options.clock ?? new SystemClock();
    const contentStore = createSqliteContentStore({
      db,
      vaultPath: effective.vault.path,
      installationId: effective.installationId,
      runDir: home.runDir,
    });
    return {
      projectPorts: createNodeProjectPorts({
        env: env as HomeEnvironment,
        userHome,
        database: db,
        contentionSurface: "handoff",
      }),
      handoffs: createSqliteHandoffWriteStore(
        db,
        ledger,
        { now: () => clock.now(), contentionSurface: "handoff" },
        artifactContentBindings(db, ledger, effective.vault.path, effective.installationId, () => clock.now()),
      ),
      artifactStore: legacyExecutorArtifactStore(
        db,
        createNodeArtifactStore({
          vaultPath: effective.vault.path,
          installationId: effective.installationId,
          // The base observes a vault-move.lock acquired after these ports were
          // built, so a stage that precedes the SQL transaction still pauses
          // (RUN-014, SHR-011).
          runDir: home.runDir,
        }),
        effective.vault.path,
        effective.installationId,
        home.runDir,
      ),
      content: {
        // The one shared body-prepare implementation behind every producer
        // (SHR-002, section 38.2): logical-name classification and threshold
        // routing live in the content store, never duplicated here.
        prepareArtifactBody: (request) => contentStore.prepareArtifactBody(request),
      },
      ids: new UuidGenerator(),
      clock,
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
      digestSource(path) {
        return digestFile(expandHome(path, userHome));
      },
      disclosures: {
        backupEnabled: effective.gitBackup.enabled,
        thresholdBytes: effective.gitBackup.largeArtifactWarningBytes,
        largeContent: (sizeBytes: number, thresholdBytes: number) => {
          // The CLI attaches its own stderr sink after composition; the default
          // records the structured diagnostic (never user delivery).
          appendStructuredLog(
            { level: "warn", event: "LARGE_CONTENT_DISCLOSED", domain: "handoff", sizeBytes, thresholdBytes },
            home,
            effective.logging,
          );
        },
        ...(options.completionWarning !== undefined ? { completionWarning: options.completionWarning } : {}),
      },
    };
  });
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
  artifact: ReturnType<typeof createNodeReviewPorts>["artifact"] & {
    remove: (storageKey: string) => Result<void, AppError>;
  };
  disclosures?: import("@sorage/core").RetentionPorts["disclosures"];
} {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  return composeWithDatabase(options, home.stateDir, (db) => {
    const reviews = createNodeReviewPorts({ ...options, database: db });
    const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
    const read = operableConfiguration(config, home);
    const artifactVaultPath = read.config.vault.path;
    const artifactInstallationId = read.config.installationId;
    const retentionLedger = createSqliteEventLedger(db);
    const retentionClock = () => options.clock?.now() ?? new Date();
    return {
      ...reviews,
      retention: createSqliteRetentionStore(
        db,
        retentionLedger,
        { now: retentionClock, contentionSurface: "handoff" },
        artifactContentBindings(
          db,
          retentionLedger,
          read.config.vault.path,
          read.config.installationId,
          retentionClock,
        ),
      ),
      artifact: {
        // The read-side body seam comes from the review ports' production wiring;
        // deletion approval's mandatory body gate resolves the Artifact's record
        // by id, while the physical unlink keeps the shared legacy executor.
        ...reviews.artifact,
        remove: (key: string) =>
          legacyRemoveThroughExecutor(db, artifactVaultPath, artifactInstallationId, home.runDir, key),
      },
      ...(options.completionWarning !== undefined
        ? { disclosures: { completionWarning: options.completionWarning } }
        : {}),
    };
  });
}

/** The production terminal wiring of accept, decline, and withdraw (TASK-033). */
export function createNodeTerminalPorts(options: NodeHandoffCommandPortsOptions = {}): ReturnType<
  typeof createNodeReviewPorts
> & {
  terminals: ReturnType<typeof createSqliteTerminalStore>;
} {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  return composeWithDatabase(options, home.stateDir, (db) => {
    const reviews = createNodeReviewPorts({ ...options, database: db });
    return {
      ...reviews,
      terminals: createSqliteTerminalStore(db, createSqliteEventLedger(db), { contentionSurface: "handoff" }),
    };
  });
}

/** The production revision wiring of `sorage revise` (TASK-032). */
export function createNodeRevisionPorts(options: NodeHandoffCommandPortsOptions = {}): ReturnType<
  typeof createNodeReviewPorts
> & {
  revisions: ReturnType<typeof createSqliteRevisionStore>;
  content: SendPorts["content"];
  artifactStore: ReturnType<typeof createNodeArtifactStore>;
  config: { vaultPath: string; maxBytes: number; verifyChecksumOnFetch: boolean };
  bindingDirectories: string[];
  digestSource: (path: string) => Result<string, AppError>;
  disclosures?: NonNullable<RevisionPorts["disclosures"]>;
} {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  return composeWithDatabase(options, home.stateDir, (db) => {
    const reviews = createNodeReviewPorts({ ...options, database: db });
    const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
    const effective = operableConfiguration(config, home).config;
    const artifactStore = createNodeArtifactStore({
      vaultPath: effective.vault.path,
      installationId: effective.installationId,
      // The base observes a vault-move.lock acquired after these ports were
      // built, so a revision's stage still pauses before its transaction
      // (RUN-014, SHR-011).
      runDir: home.runDir,
    });
    const revisionLedger = createSqliteEventLedger(db);
    const revisionClock = () => options.clock?.now() ?? new Date();
    return {
      ...reviews,
      content: {
        prepareArtifactBody: (request) =>
          createSqliteContentStore({
            db,
            vaultPath: effective.vault.path,
            installationId: effective.installationId,
            runDir: home.runDir,
          }).prepareArtifactBody(request),
      },
      revisions: createSqliteRevisionStore(
        db,
        revisionLedger,
        { now: revisionClock, contentionSurface: "handoff" },
        artifactContentBindings(db, revisionLedger, effective.vault.path, effective.installationId, revisionClock),
      ),
      // The ordinary revise physical steps run through the same shared legacy
      // executor as the drain (section 3): dependency-aware eligibility before
      // the unlink effect, with the store's marker/fence guard preserved.
      artifactStore: legacyExecutorArtifactStore(
        db,
        artifactStore,
        effective.vault.path,
        effective.installationId,
        home.runDir,
      ),
      config: {
        vaultPath: effective.vault.path,
        maxBytes: effective.artifact.maxBytes,
        verifyChecksumOnFetch: effective.artifact.verifyChecksumOnFetch,
      },
      bindingDirectories: bindingDirectoriesOf(db),
      digestSource(path: string) {
        return digestFile(path);
      },
      disclosures: {
        backupEnabled: effective.gitBackup.enabled,
        thresholdBytes: effective.gitBackup.largeArtifactWarningBytes,
        largeContent: (sizeBytes: number, thresholdBytes: number) => {
          appendStructuredLog(
            { level: "warn", event: "LARGE_CONTENT_DISCLOSED", domain: "handoff", sizeBytes, thresholdBytes },
            home,
            effective.logging,
          );
        },
        ...(options.completionWarning !== undefined ? { completionWarning: options.completionWarning } : {}),
      },
    };
  });
}

/** The production read wiring of `sorage inbox`, `outbox`, `get`, and `fetch` (TASK-030). */
export function createNodeReviewPorts(
  options: NodeHandoffCommandPortsOptions = {},
): ReturnType<typeof createNodeHandoffReadPorts> & { reviews: ReturnType<typeof createSqliteReviewStore> } {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  return composeWithDatabase(options, home.stateDir, (db) => {
    const read = createNodeHandoffReadPorts({ ...options, database: db });
    return {
      ...read,
      reviews: createSqliteReviewStore(db, createSqliteEventLedger(db), { contentionSurface: "handoff" }),
    };
  });
}

export function createNodeHandoffReadPorts(options: NodeHandoffCommandPortsOptions = {}): HandoffDetailReadPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  return composeWithDatabase(options, home.stateDir, (db) => {
    const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
    const effective = operableConfiguration(config, home).config;
    return {
      projectPorts: createNodeProjectPorts({
        env: env as HomeEnvironment,
        userHome,
        database: db,
        contentionSurface: "handoff",
      }),
      // The production store carries the first-fetch write fence's known run
      // directory (RUN-014, SHR-011): every CLI and HTTP settlement through these
      // ports pauses on a live vault-move lock or database move fence.
      handoffs: createSqliteHandoffReadStore(db, createSqliteEventLedger(db), {
        runDir: home.runDir,
        contentionSurface: "handoff",
      }),
      // The note read the detail surface needs is the same findNote seam the review
      // mutations load through, so the two can never disagree on the current Note.
      reviews: createSqliteReviewStore(db, createSqliteEventLedger(db), { contentionSurface: "handoff" }),
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
      artifact: createArtifactBodyPorts({
        db,
        vaultPath: effective.vault.path,
        installationId: effective.installationId,
        stateDir: home.stateDir,
      }),
      ids: new UuidGenerator(),
      clock: options.clock ?? new SystemClock(),
    };
  });
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
