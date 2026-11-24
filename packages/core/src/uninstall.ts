import { type Configuration, expandConfigurationPath } from "./config";
import { type AppError, appError, err, ok, type Result } from "./errors";

/**
 * Semantic background-service lifecycle port (RUN-007, RUN-011, INIT-009, INIT-016):
 * hides platform-specific agent files and service-manager commands behind install
 * and uninstall operations while keeping the user-visible output contract intact.
 */
export interface BackgroundServicePort {
  install(input: {
    program: { binaryPath: string; scriptArgs: string[] };
    sorageHome: string;
  }): Result<{ plistPath: string; bootstrapped: boolean }, AppError>;
  uninstall(): Result<{ wasLoaded: boolean; plistRemoved: boolean; plistPath: string }, AppError>;
}

/**
 * The `sorage uninstall` use case (INIT-016, milestone M3): a User-admin operation
 * that requires `--as-user --confirm`, stops a running daemon, removes the
 * background service, removes `state`, `run`, `logs`, `config.yaml`, and its
 * retained `.bak`, never deletes the Vault, and reports the retained Vault path
 * so the User knows exactly what remains.
 */
export interface UninstallPorts {
  home: string;
  stateDir: string;
  logsDir: string;
  runDir: string;
  configFile: string;
  /** The retained `.bak` sibling of `config.yaml`; removed with it. */
  configBackupFile: string;
  userHome: string;
  readConfiguration(): Result<{ config: Configuration } | null, AppError>;
  /** True when `run/daemon.json` names a live pid; the daemon is stopped before removal. */
  daemonRunning(): boolean;
  stopDaemon(): Result<{ stopped: boolean }, AppError>;
  launchAgent: BackgroundServicePort;
  removeDirectory(path: string): void;
  removeFile(path: string): void;
  /** True when the named path exists, so the report names only what was really removed. */
  exists(path: string): boolean;
}

export interface UninstallOutcome {
  removed: string[];
  retainedVaultPath: string;
  daemonStopped: boolean;
  launchAgent: {
    wasLoaded: boolean;
    plistRemoved: boolean;
    plistPath: string;
  };
}

export function uninstallInstallation(
  ports: UninstallPorts,
  input: { asUser: boolean; confirm: boolean },
): Result<UninstallOutcome, AppError> {
  if (!input.asUser) {
    return err(
      appError(
        "USER_CONTEXT_REQUIRED",
        "uninstall removes the installation and records a User decision; it requires --as-user.",
      ),
    );
  }
  if (!input.confirm) {
    return err(appError("CONFIRMATION_REQUIRED", "uninstall is destructive and requires --confirm."));
  }
  const read = ports.readConfiguration();
  if (!read.ok) return read;
  if (read.value === null) {
    return err(appError("NOT_INITIALIZED", "Sorage is not initialized; there is nothing to uninstall."));
  }
  const retainedVaultPath = expandConfigurationPath(read.value.config.vault.path, ports.userHome, ports.home);

  // The daemon holds the database and the locks under state/ and run/, and the
  // LaunchAgent would restart it at the next login, so both go before any removal.
  // A daemon that cannot be stopped aborts the uninstall: removing live state from
  // under a running process is corruption, not cleanup.
  let daemonStopped = false;
  if (ports.daemonRunning()) {
    const stopped = ports.stopDaemon();
    if (!stopped.ok) return stopped;
    if (!stopped.value.stopped) {
      return err(
        appError(
          "DAEMON_UNAVAILABLE",
          "the daemon is still running; stop it with sorage daemon stop and retry the uninstall.",
        ),
      );
    }
    daemonStopped = true;
  }
  const launchAgent = ports.launchAgent.uninstall();
  if (!launchAgent.ok) return launchAgent;

  const removed: string[] = [];
  for (const directory of [ports.stateDir, ports.runDir, ports.logsDir]) {
    if (ports.exists(directory)) {
      ports.removeDirectory(directory);
      removed.push(directory);
    }
  }
  // config.yaml is the initialization marker, so it goes last: a crash mid-uninstall
  // leaves an initialized-looking installation with empty directories rather than an
  // uninitialized home that still holds live state.
  for (const file of [ports.configFile, ports.configBackupFile]) {
    if (ports.exists(file)) {
      ports.removeFile(file);
      removed.push(file);
    }
  }
  return ok({ removed, retainedVaultPath, daemonStopped, launchAgent: launchAgent.value });
}
