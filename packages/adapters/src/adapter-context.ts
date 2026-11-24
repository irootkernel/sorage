import { homedir } from "node:os";
import { join } from "node:path";
import { type AppError, appError, err, ok, type Result } from "@sorage/core";
import { type ConfigStore, createConfigStore, type ReadConfiguration } from "./config-store";
import { createHomePaths, type HomeEnvironment, type HomePaths } from "./home";
import { createNodeLockProbePorts, vaultMoveLockHeld, vaultMovePauseRefusal } from "./lockfile";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
import {
  AppCommandError,
  asAppCommandError,
  carriedAppError,
  type ContentionSurface,
  storageContentionOf,
} from "./storage-contention";

/**
 * Command-local adapter composition helper (ADR-0036, TASK-157): zero caching
 * across commands, explicit per-factory open order (`db-only`, `db-first`,
 * `config-first`), no-op `close()` for any borrowed `database`, close-on-error
 * for owned connections without masking the original error, and preservation
 * of each factory's exact error ladder and configuration-read mode.
 */

export interface AdapterContextCommonOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  clock?: { now(): Date } | undefined;
  /** Borrowed connection: caller owns its lifetime and `close()` becomes a no-op. */
  database?: SorageSqlite | undefined;
  /** Borrowed operational configuration already read by an enclosing command. */
  configuration?: ReadConfiguration | undefined;
  /** Optional SHR-015 contention family for storage-preparation contention mapping. */
  contentionSurface?: ContentionSurface | undefined;
}

export interface DbOnlyAdapterContextOptions extends AdapterContextCommonOptions {
  order: "db-only";
}

export interface DbFirstAdapterContextOptions extends AdapterContextCommonOptions {
  order: "db-first";
  configMode?: "operation" | "read" | undefined;
  /** Optional custom refusal when configuration read fails or returns null. */
  onConfigurationFailure?: ((home: HomePaths, error: AppError | null) => never) | undefined;
}

export interface ConfigFirstAdapterContextOptions extends AdapterContextCommonOptions {
  order: "config-first";
}

export type OpenAdapterContextOptions =
  | DbOnlyAdapterContextOptions
  | DbFirstAdapterContextOptions
  | ConfigFirstAdapterContextOptions;

export interface DbOnlyAdapterContext {
  env: HomeEnvironment;
  userHome: string;
  home: HomePaths;
  clock: { now(): Date };
  db: SorageSqlite;
  ownsDatabase: boolean;
  close(): void;
}

export interface DbFirstAdapterContext extends DbOnlyAdapterContext {
  configStore: ConfigStore;
  configuration: ReadConfiguration;
}

export interface LazyDatabaseOptions {
  /** Custom prefix for the fallback `INTERNAL_ERROR` message. */
  errorPrefix?: string | undefined;
  /** Attach raw `cause` property on fallback `INTERNAL_ERROR` for downstream classification. */
  attachRawCause?: boolean | undefined;
}

export interface ConfigFirstAdapterContext {
  env: HomeEnvironment;
  userHome: string;
  home: HomePaths;
  clock: { now(): Date };
  configStore: ConfigStore;
  /** Reads configuration (reusing borrowed configuration unless `fresh` is true). */
  readConfiguration(mode: "operation" | "read", fresh?: boolean): Result<ReadConfiguration | null, AppError>;
  /** Runs one database callback against a borrowed handle or a lazily opened/closed handle. */
  withDatabase<T>(body: (db: SorageSqlite) => Result<T, AppError>, options?: LazyDatabaseOptions): Result<T, AppError>;
  /** Opens a dedicated writer handle, optionally checking `vault-move.lock` BEFORE `openAndMigrate`. */
  openDatabase(options?: { checkMoveLockBeforeOpen?: boolean | undefined }): SorageSqlite;
  close(): void;
}

function openOrBorrowDatabase(
  home: HomePaths,
  borrowed: SorageSqlite | undefined,
  contentionSurface: ContentionSurface | undefined,
): SorageSqlite {
  if (borrowed !== undefined) return borrowed;
  const plan = productionMigrationPlan();
  try {
    return openAndMigrate(join(home.stateDir, "sorage.sqlite3"), plan.migrations, {
      rebuilds: plan.rebuilds,
    }).db;
  } catch (error) {
    if (asSchemaAdmission(error) !== null || error instanceof AppCommandError) throw error;
    const contention = contentionSurface !== undefined ? storageContentionOf(error, contentionSurface) : null;
    if (contention !== null) throw carriedAppError(contention);
    throw error;
  }
}

function makeCloser(db: SorageSqlite, ownsDatabase: boolean): () => void {
  let closed = false;
  return () => {
    if (closed || !ownsDatabase) return;
    closed = true;
    db.close();
  };
}

function closeQuietly(close: () => void): void {
  try {
    close();
  } catch {
    // Cleanup must never mask the original configuration or construction refusal.
  }
}

export function openAdapterContext(options: DbOnlyAdapterContextOptions): DbOnlyAdapterContext;
export function openAdapterContext(options: DbFirstAdapterContextOptions): DbFirstAdapterContext;
export function openAdapterContext(options: ConfigFirstAdapterContextOptions): ConfigFirstAdapterContext;
export function openAdapterContext(
  options: OpenAdapterContextOptions,
): DbOnlyAdapterContext | DbFirstAdapterContext | ConfigFirstAdapterContext {
  const env: HomeEnvironment = options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME };
  const userHome = options.userHome ?? homedir();
  const clock = options.clock ?? { now: () => new Date() };
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);

  if (options.order === "config-first") {
    const configStore = createConfigStore({
      home,
      lockPorts: createNodeLockProbePorts(clock),
      userHome,
    });
    return {
      env,
      userHome,
      home,
      clock,
      configStore,
      readConfiguration(mode, fresh = false) {
        if (!fresh && options.configuration !== undefined) {
          return ok(options.configuration);
        }
        return mode === "operation" ? configStore.readForOperation() : configStore.read();
      },
      withDatabase<T>(
        body: (db: SorageSqlite) => Result<T, AppError>,
        dbOptions: LazyDatabaseOptions = {},
      ): Result<T, AppError> {
        try {
          if (options.database !== undefined) {
            return body(options.database);
          }
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
          const admission = asSchemaAdmission(error);
          if (admission !== null) return err(admission);
          if (options.contentionSurface !== undefined) {
            const carried = asAppCommandError(error);
            if (carried !== null) return err(carried.error);
            const contention = storageContentionOf(error, options.contentionSurface);
            if (contention !== null) return err(contention);
          }
          const prefix = dbOptions.errorPrefix ?? "Reading the database failed";
          const base = appError("INTERNAL_ERROR", `${prefix}: ${messageOf(error)}.`, { cause: String(error) });
          return err(dbOptions.attachRawCause ? { ...base, cause: error } : base);
        }
      },
      openDatabase(openOptions = {}) {
        if (openOptions.checkMoveLockBeforeOpen && vaultMoveLockHeld(home.runDir)) {
          throw carriedAppError(vaultMovePauseRefusal(home.lockFile("vault-move")));
        }
        const plan = productionMigrationPlan();
        return openAndMigrate(join(home.stateDir, "sorage.sqlite3"), plan.migrations, {
          rebuilds: plan.rebuilds,
        }).db;
      },
      close() {
        // Config-first contexts hold no persistent connection; lazy handles close per operation.
      },
    };
  }

  const ownsDatabase = options.database === undefined;
  const db = openOrBorrowDatabase(home, options.database, options.contentionSurface);
  const close = makeCloser(db, ownsDatabase);

  if (options.order === "db-only") {
    return { env, userHome, home, clock, db, ownsDatabase, close };
  }

  try {
    const configStore = createConfigStore({
      home,
      lockPorts: createNodeLockProbePorts(clock),
      userHome,
    });
    let configuration = options.configuration;
    if (configuration === undefined) {
      const mode = options.configMode ?? "operation";
      const read = mode === "operation" ? configStore.readForOperation() : configStore.read();
      if (!read.ok || read.value === null) {
        if (options.onConfigurationFailure !== undefined) {
          options.onConfigurationFailure(home, read.ok ? null : read.error);
        }
        throw carriedAppError(
          read.ok
            ? appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: home.configFile })
            : read.error,
        );
      }
      configuration = read.value;
    }
    return { env, userHome, home, clock, configStore, db, ownsDatabase, configuration, close };
  } catch (error) {
    closeQuietly(close);
    throw error;
  }
}

/**
 * Runs `build(ctx)` and closes `ctx` if `build` throws, without masking the
 * thrown error. No-op for borrowed handles whose `ctx.close()` is already a no-op.
 */
export function composeAdapterContext<Ctx extends { close(): void }, R>(ctx: Ctx, build: (ctx: Ctx) => R): R {
  try {
    return build(ctx);
  } catch (error) {
    closeQuietly(() => ctx.close());
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
