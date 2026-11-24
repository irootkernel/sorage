import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { type AppError, ok, type Result, type UninstallPorts } from "@sorage/core";
import { createNodeConfigCommandPorts } from "./config-command-ports";
import { createNodeDaemonPorts } from "./daemon-command-ports";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeBackgroundServicePort } from "./launchagent-ports";

export interface NodeUninstallPortsOptions {
  stopDaemon(): Result<{ stopped: boolean }, AppError>;
  env?: HomeEnvironment | undefined;
  userHome?: string | undefined;
}

/** Production wiring for `sorage uninstall`, keeping filesystem and LaunchAgent setup out of the CLI. */
export function createNodeUninstallPorts(options: NodeUninstallPortsOptions): UninstallPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const commandPorts = createNodeConfigCommandPorts({ env: options.env, userHome });
  const daemonPorts = createNodeDaemonPorts({ env: options.env as NodeJS.ProcessEnv | undefined });
  return {
    home: home.home,
    stateDir: home.stateDir,
    logsDir: home.logsDir,
    runDir: home.runDir,
    configFile: commandPorts.configFile,
    configBackupFile: `${commandPorts.configFile}.bak`,
    userHome,
    readConfiguration: () => {
      const read = commandPorts.store.read();
      if (!read.ok) return read;
      if (read.value === null) return ok(null);
      return ok({ config: read.value.config });
    },
    daemonRunning: () => {
      const record = daemonPorts.readDaemonRecord();
      return record !== null && daemonPorts.isPidAlive(record.pid);
    },
    stopDaemon: options.stopDaemon,
    launchAgent: createNodeBackgroundServicePort(),
    removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
    removeFile: (path) => rmSync(path, { force: true }),
    exists: (path) => existsSync(path),
  };
}
