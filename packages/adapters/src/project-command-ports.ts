import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ProjectCommandPorts, ProjectResolutionPorts } from "@sorage/core";
import { appError, err, ok, SystemClock, UuidGenerator } from "@sorage/core";
import { composeAdapterContext, openAdapterContext } from "./adapter-context";
import type { ReadConfiguration } from "./config-store";
import { createSqliteEventLedger } from "./events";
import { revokeExchangeClaimsInTx } from "./exchange-claims";
import { createNodeGitClient } from "./git-client";
import { createSqliteProjectHandoffStats } from "./handoff-stats";
import type { HomeEnvironment } from "./home";
import { createSqliteProjectRepository, type ProjectRepositoryFs } from "./projects";
import type { SorageSqlite } from "./sqlite/connection";
import type { ContentionSurface } from "./storage-contention";

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
  /** Borrowed connection: its daemon, covered-read caller, or enclosing factory owns its lifetime. */
  database?: SorageSqlite | undefined;
  /** Borrowed operational configuration already read by an enclosing composition (ADR-0036). */
  configuration?: ReadConfiguration | undefined;
  /**
   * The invoking command family of SHR-015: when set, storage-preparation
   * contention in this composition and its repository maps to the stamped
   * `STORAGE_INSPECTION_UNAVAILABLE` refusal with that family's wording.
   * Undefined compositions (Memo, init) keep today's unclassified behavior.
   */
  contentionSurface?: ContentionSurface | undefined;
}

export type NodeProjectCommandPorts = ProjectCommandPorts & {
  /** Releases the SQLite connection when owned by this bundle; a no-op for a borrowed connection. */
  close(): void;
};

export type GitProbe = (directory: string) => string | null;

/** Reports whether a directory is a bare Git repository (ADR-0020). */
export type BareProbe = (directory: string) => boolean;

const projectGitClient = createNodeGitClient({ timeoutMs: 10_000 });

const nativeIsBare: BareProbe = (directory) => {
  const result = projectGitClient.run({ cwd: directory, args: ["rev-parse", "--is-bare-repository"] });
  return result.ok && result.value.exitCode === 0 && result.value.stdout.trim() === "true";
};

const nativeGit: GitProbe = (directory) => {
  const result = projectGitClient.run({
    cwd: directory,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  });
  if (!result.ok || result.value.exitCode !== 0) return null;
  const common = result.value.stdout.trim();
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

export function createNodeProjectPorts(options: NodeProjectPortsOptions = {}): NodeProjectCommandPorts {
  const context = openAdapterContext({
    order: "db-first",
    configMode: "operation",
    env: options.env,
    userHome: options.userHome,
    database: options.database,
    configuration: options.configuration,
    contentionSurface: options.contentionSurface,
  });
  return composeAdapterContext(context, ({ db, configuration: effective, close }) => {
    const git = options.git ?? nativeGit;
    const isBare = options.gitIsBare ?? nativeIsBare;
    const fs = options.fs ?? { realpath: (path: string) => realpathSync(path) };
    return {
      installationId: effective.config.installationId,
      vaultPath: effective.config.vault.path,
      projects: createSqliteProjectRepository(db, {
        installationId: effective.config.installationId,
        vaultPath: effective.config.vault.path,
        fs,
        events: createSqliteEventLedger(db),
        onLocalProjectWithdrawn: (projectId) => revokeExchangeClaimsInTx(db, projectId),
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
      handoffs: createSqliteProjectHandoffStats(db),
      close,
    };
  });
}

function joinPath(home: string, rest: string): string {
  return `${home.replace(/\/+$/, "")}/${rest}`;
}
