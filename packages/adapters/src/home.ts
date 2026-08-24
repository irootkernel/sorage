import { homedir } from "node:os";
import { join } from "node:path";
import type { LockName } from "./lockfile";

/**
 * The home path service (INIT-001, INIT-002, INIT-015): resolves the Sorage home from
 * the `SORAGE_HOME` override with the `~/.sorage` fallback and exposes the canonical
 * locations that every process shares.
 */
export interface HomePaths {
  /** The resolved Sorage home directory. */
  home: string;
  /** The canonical configuration file, `<home>/config.yaml` (INIT-002). */
  configFile: string;
  /** `<home>/state`, holding the database, the API token, and backup snapshots. */
  stateDir: string;
  /** `<home>/logs`, holding the structured log and its rotated siblings. */
  logsDir: string;
  /** `<home>/run`, holding `daemon.json` and the lockfile set. */
  runDir: string;
  /** The canonical lockfile path for one lock of the normative set. */
  lockFile(name: LockName): string;
}

/** The environment slice the home resolution reads. */
export interface HomeEnvironment {
  SORAGE_HOME?: string | undefined;
}

/**
 * Resolves the Sorage home: `SORAGE_HOME` when it is set to a non-blank value, and
 * `~/.sorage` otherwise (INIT-015). A blank override falls back rather than pointing
 * the installation at the working directory.
 */
export function resolveHome(env: HomeEnvironment, userHome: string): string {
  const override = env.SORAGE_HOME;
  if (override !== undefined && override.trim() !== "") return override;
  return join(userHome, ".sorage");
}

/** Builds the canonical location set for one resolved home. */
export function createHomePaths(env: HomeEnvironment, userHome: string): HomePaths {
  const home = resolveHome(env, userHome);
  const runDir = join(home, "run");
  return {
    home,
    configFile: join(home, "config.yaml"),
    stateDir: join(home, "state"),
    logsDir: join(home, "logs"),
    runDir,
    lockFile: (name) => join(runDir, `${name}.lock`),
  };
}

/** The production factory: the process environment and the operating-system home. */
export function createNodeHomePaths(env: NodeJS.ProcessEnv = process.env): HomePaths {
  return createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, homedir());
}
