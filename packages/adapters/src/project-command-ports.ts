import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ProjectCommandPorts } from "@sorage/core";
import { appError, err, ok, SystemClock, UuidGenerator } from "@sorage/core";
import { createConfigStore } from "./config-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts } from "./lockfile";
import { createSqliteProjectRepository, type ProjectRepositoryFs } from "./projects";
import { MIGRATIONS } from "./sqlite/migrations";
import { openAndMigrate } from "./sqlite/migrator";

/**
 * The production wiring of the `sorage project` commands: the migrated SQLite database,
 * the Project repository, and the binding path rules — `~` expansion, absolutization,
 * symlink resolution, an existing-directory requirement, and folding a directory inside
 * a git working tree onto its git common directory (PRJ-006, PRJ-017). Git runs as an
 * argument array with no shell and no inherited prompts (SEC-004, SEC-005).
 */

export interface NodeProjectPortsOptions {
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
  git?: GitProbe | undefined;
  fs?: ProjectRepositoryFs | undefined;
}

export type GitProbe = (directory: string) => string | null;

const nativeGit: GitProbe = (directory) => {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const common = (result.stdout ?? "").trim();
  return common === "" ? null : common;
};

export function createNodeProjectPorts(options: NodeProjectPortsOptions = {}): ProjectCommandPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const { db } = openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS);
  const git = options.git ?? nativeGit;
  const fs = options.fs ?? { realpath: (path) => realpathSync(path) };
  // The canonical installation identity is the generated key in the effective
  // configuration; the repository never trusts a caller-supplied identity.
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    db.close();
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  return {
    installationId: read.value.config.installationId,
    projects: createSqliteProjectRepository(db, { installationId: read.value.config.installationId, fs }),
    clock: new SystemClock(),
    ids: new UuidGenerator(),
    bindings: {
      realPath(path, currentUserHome) {
        const expanded =
          path === "~" ? currentUserHome : path.startsWith("~/") ? joinPath(currentUserHome, path.slice(2)) : path;
        const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
        if (!existsSync(absolute)) {
          return err(appError("CONFIG_INVALID", `the directory '${absolute}' does not exist`, { directory: absolute }));
        }
        return ok(fs.realpath(absolute));
      },
      gitCommonDirectory(path) {
        const common = git(path);
        return common === null ? null : fs.realpath(common);
      },
      resolveDirectory(path, currentUserHome) {
        const expanded =
          path === "~" ? currentUserHome : path.startsWith("~/") ? joinPath(currentUserHome, path.slice(2)) : path;
        const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
          return err(
            appError("CONFIG_INVALID", `the directory '${absolute}' does not exist or is not a directory`, {
              directory: absolute,
            }),
          );
        }
        const real = fs.realpath(absolute);
        const common = git(real);
        if (common !== null) {
          // Every worktree of one repository shares the git common directory, so the
          // binding stores that one directory and records `git_repository` (PRJ-017).
          return ok({ directory: fs.realpath(common), bindingKind: "git_repository" });
        }
        return ok({ directory: real, bindingKind: "directory" });
      },
    },
    handoffs: {
      // The handoffs table arrives with EPIC-005; until then no Handoff can be open, so
      // the honest count is zero and the unbind confirmation rule is dormant.
      openHandoffCount(projectId) {
        try {
          const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get() as
            | { name: string }
            | undefined;
          if (table === undefined) return ok(0);
          const row = db
            .prepare(
              "SELECT COUNT(*) AS count FROM handoffs WHERE recipient_project_id = ? AND review_state IN ('awaiting_recipient', 'changes_requested') AND deleted_at IS NULL",
            )
            .get(projectId) as { count: number };
          return ok(row.count);
        } catch (error) {
          return err(appError("INTERNAL_ERROR", `the open Handoff count failed: ${String(error)}`));
        }
      },
    },
  };
}

function joinPath(home: string, rest: string): string {
  return `${home.replace(/\/+$/, "")}/${rest}`;
}
