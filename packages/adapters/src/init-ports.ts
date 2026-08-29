import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appError, err, ok, type AppError, type Result } from "@sorage/core";
import type { InitDatabasePort, InitPathsPort, InitPorts } from "@sorage/core";
import { SystemClock, UuidGenerator } from "@sorage/core";
import { createConfigStore, type ConfigStoreFs } from "./config-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts, type LockClock } from "./lockfile";
import { MIGRATIONS } from "./sqlite/migrations";
import { openAndMigrate } from "./sqlite/migrator";
import { createVaultInitializer } from "./vault";
import { createNodeApiTokenStore } from "./token-store";

/**
 * The production wiring of the initialization use case: the home path service, the
 * atomic configuration store, the SQLite migration runner, and the Vault initializer
 * composed behind the core ports so the CLI stays a thin renderer.
 */
export interface NodeInitPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  clock?: LockClock | undefined;
  configFs?: ConfigStoreFs | undefined;
}

export function createNodeInitPorts(options: NodeInitPortsOptions = {}): InitPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const clock = options.clock ?? new SystemClock();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  return {
    paths: pathsFor(home),
    userHome,
    clock,
    ids: new UuidGenerator(),
    config: createConfigStore({ home, lockPorts: createNodeLockProbePorts(clock), userHome, fs: options.configFs }),
    database: databasePort(join(home.stateDir, "sorage.sqlite3")),
    vault: createVaultInitializer(clock),
    token: createNodeApiTokenStore({ stateDir: home.stateDir }),
    filesystem: {
      ensureDirectory: (path) => {
        // Node's recursive mkdir ignores existing directories, which is the contract.
        mkdirSync(path, { recursive: true });
      },
    },
  };
}

function pathsFor(home: ReturnType<typeof createHomePaths>): InitPathsPort {
  return { home: home.home, stateDir: home.stateDir, logsDir: home.logsDir, runDir: home.runDir };
}

function databasePort(databasePath: string): InitDatabasePort {
  return {
    migrate(): Result<{ appliedVersions: number[]; alreadyUpToDate: boolean }, AppError> {
      try {
        const { db, outcome } = openAndMigrate(databasePath, MIGRATIONS);
        db.close();
        return ok(outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(appError("INTERNAL_ERROR", `the database migration failed: ${message}`));
      }
    },
  };
}
