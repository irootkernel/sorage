import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ProjectCommandPorts } from "@sorage/core";
import { appError, err, ok, SystemClock, UuidGenerator } from "@sorage/core";
import { createConfigStore } from "./config-store";
import { createSqliteEventLedger } from "./events";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts } from "./lockfile";
import { createSqliteProjectRepository, type ProjectRepositoryFs } from "./projects";
import { MIGRATIONS } from "./sqlite/migrations";
import { openAndMigrate } from "./sqlite/migrator";
import type { SorageSqlite } from "./sqlite/connection";

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
  gitIsBare?: BareProbe | undefined;
  fs?: ProjectRepositoryFs | undefined;
  /** Daemon-owned connection; CLI callers omit it and keep process-scoped ownership. */
  database?: SorageSqlite | undefined;
}

export type GitProbe = (directory: string) => string | null;

/** Reports whether a directory is a bare Git repository (ADR-0020). */
export type BareProbe = (directory: string) => boolean;

const nativeIsBare: BareProbe = (directory) => {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--is-bare-repository"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
};

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
  const db = options.database ?? openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), MIGRATIONS).db;
  const git = options.git ?? nativeGit;
  const isBare = options.gitIsBare ?? nativeIsBare;
  const fs = options.fs ?? { realpath: (path: string) => realpathSync(path) };
  // The canonical installation identity is the generated key in the effective
  // configuration; the repository never trusts a caller-supplied identity.
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.read();
  if (!read.ok || read.value === null) {
    if (options.database === undefined) db.close();
    throw new Error(`the configuration at ${home.configFile} could not be read`);
  }
  return {
    installationId: read.value.config.installationId,
    vaultPath: read.value.config.vault.path,
    projects: createSqliteProjectRepository(db, {
      installationId: read.value.config.installationId,
      fs,
      events: createSqliteEventLedger(db),
    }),
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
      physicalIdentity(path) {
        try {
          const stats = statSync(path);
          return `${stats.dev}:${stats.ino}`;
        } catch {
          return null;
        }
      },
      absentRealPath(path, currentUserHome) {
        const expanded =
          path === "~" ? currentUserHome : path.startsWith("~/") ? joinPath(currentUserHome, path.slice(2)) : path;
        const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
        // Climb to the longest existing ancestor so a symlinked prefix (for example
        // /tmp on macOS) resolves the way it did when the binding was stored; "/"
        // always exists, so the climb always terminates.
        const segments = absolute.split("/").filter((segment) => segment !== "");
        while (segments.length > 0 && !existsSync(`/${segments.join("/")}`)) {
          segments.pop();
        }
        const existing = `/${segments.join("/")}`;
        const real = fs.realpath(existing);
        const rest = absolute.slice(existing.length).replace(/^\/+|\/+$/g, "");
        return ok(rest === "" ? real : `${real}/${rest}`);
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
          if (isBare(real)) {
            // A bare repository has no working tree, so the workspace root of a
            // git_repository binding would be undefined; binding refuses instead
            // (ADR-0020, PRJ-019).
            return err(
              appError(
                "CONFIG_INVALID",
                `the directory '${real}' is a bare Git repository and has no working tree to bind; bind a non-bare clone instead`,
                { directory: real, bare: true },
              ),
            );
          }
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
          // bun:sqlite returns null for a no-row get while node:sqlite returns
          // undefined, and the test suite runs through node:sqlite, so the guard
          // must treat both shapes as absence or unbind fails on the real engine.
          const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get() as
            | { name: string }
            | null
            | undefined;
          if (!table) return ok(0);
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
