import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ProjectCommandPorts, ProjectResolutionPorts } from "@sorage/core";
import { appError, err, ok, SystemClock, UuidGenerator } from "@sorage/core";
import { createConfigStore } from "./config-store";
import { createSqliteEventLedger } from "./events";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts } from "./lockfile";
import { createSqliteProjectRepository, type ProjectRepositoryFs } from "./projects";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
import { AppCommandError, type ContentionSurface, carriedAppError, storageContentionOf } from "./storage-contention";

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
  /**
   * The invoking command family of SHR-015: when set, storage-preparation
   * contention in this composition and its repository maps to the stamped
   * `STORAGE_INSPECTION_UNAVAILABLE` refusal with that family's wording.
   * Undefined compositions (Memo, init) keep today's unclassified behavior.
   */
  contentionSurface?: ContentionSurface | undefined;
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

/** Filesystem/Git probes shared with inspection, without configuration or database wiring. */
export function createNodeResolutionBindings(
  options: Pick<NodeProjectPortsOptions, "git" | "fs"> = {},
): ProjectResolutionPorts["bindings"] {
  const git = options.git ?? nativeGit;
  const fs = options.fs ?? { realpath: (path: string) => realpathSync(path) };
  return {
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
    gitCommonDirectory(path) {
      const common = git(path);
      return common === null ? null : fs.realpath(common);
    },
  };
}

export function createNodeProjectPorts(options: NodeProjectPortsOptions = {}): ProjectCommandPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const plan = productionMigrationPlan();
  let db: SorageSqlite;
  try {
    db =
      options.database ??
      openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), plan.migrations, {
        rebuilds: plan.rebuilds,
      }).db;
  } catch (error) {
    // A schema admission refusal keeps its public code; contention maps to the
    // stamped refusal only for a surfaced composition; everything else stays raw.
    if (asSchemaAdmission(error) !== null || error instanceof AppCommandError) throw error;
    const contention =
      options.contentionSurface !== undefined ? storageContentionOf(error, options.contentionSurface) : null;
    if (contention !== null) throw carriedAppError(contention);
    throw error;
  }
  const git = options.git ?? nativeGit;
  const isBare = options.gitIsBare ?? nativeIsBare;
  const fs = options.fs ?? { realpath: (path: string) => realpathSync(path) };
  // The canonical installation identity is the generated key in the effective
  // configuration; the repository never trusts a caller-supplied identity.
  // An operational read distinguishes an unreadable configuration from an
  // absent one and carries both as typed errors (SHR-015, W7).
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const read = config.readForOperation();
  if (!read.ok || read.value === null) {
    if (options.database === undefined) db.close();
    throw carriedAppError(
      read.ok
        ? appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: home.configFile })
        : read.error,
    );
  }
  return {
    installationId: read.value.config.installationId,
    vaultPath: read.value.config.vault.path,
    projects: createSqliteProjectRepository(db, {
      installationId: read.value.config.installationId,
      vaultPath: read.value.config.vault.path,
      fs,
      events: createSqliteEventLedger(db),
      ...(options.contentionSurface !== undefined ? { contentionSurface: options.contentionSurface } : {}),
    }),
    clock: new SystemClock(),
    ids: new UuidGenerator(),
    bindings: {
      ...createNodeResolutionBindings({ git, fs }),
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
              "SELECT COUNT(*) AS count FROM handoffs WHERE recipient_project_id = ? AND (review_state IN ('awaiting_recipient', 'changes_requested') OR (review_state = 'accepted' AND processing_status IN ('not_started', 'in_progress'))) AND deleted_at IS NULL",
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
