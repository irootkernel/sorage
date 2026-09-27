import { homedir } from "node:os";
import { resolve } from "node:path";
import { SystemClock, UuidGenerator, type Clock, type MemoCommandPorts, type ProjectCommandPorts } from "@sorage/core";
import { createConfigStore } from "./config-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts } from "./lockfile";
import { createSqliteMemoRepository } from "./memos";
import { createNodeProjectPorts } from "./project-command-ports";
import type { SorageSqlite } from "./sqlite/connection";
import { MIGRATIONS } from "./sqlite/migrations";
import { openAndMigrate } from "./sqlite/migrator";

export interface NodeMemoPortsOptions {
  env?: HomeEnvironment;
  userHome?: string;
  database?: SorageSqlite;
  clock?: Clock;
}

/** CLI owns and closes its connection; the daemon supplies its existing shared connection. */
export function createNodeMemoPorts(
  options: NodeMemoPortsOptions = {},
): MemoCommandPorts & { projectPorts: ProjectCommandPorts; close(): void } {
  const env: HomeEnvironment = options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME };
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const read = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome }).read();
  if (!read.ok || !read.value) throw new Error("Memo configuration could not be read");
  const db = options.database ?? openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS).db;
  try {
    return {
      installationId: read.value.config.installationId,
      defaultPageSize: read.value.config.ui.defaultPageSize,
      clock: options.clock ?? new SystemClock(),
      ids: new UuidGenerator(),
      memos: createSqliteMemoRepository(db),
      projectPorts: createNodeProjectPorts({ env, userHome, database: db }),
      close: () => {
        if (!options.database) db.close();
      },
    };
  } catch (error) {
    if (!options.database) db.close();
    throw error;
  }
}
