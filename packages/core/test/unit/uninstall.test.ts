import { describe, expect, it } from "vitest";
import { type Configuration, defaultConfiguration } from "../../src/config";
import { type AppError, ok, type Result } from "../../src/errors";
import type { LaunchAgentPorts } from "../../src/launchagent";
import { type UninstallPorts, uninstallInstallation } from "../../src/uninstall";

function portsFor(config: Configuration | null): UninstallPorts & {
  removedDirs: string[];
  removedFiles: string[];
  daemonStopCalls: number;
} {
  const removedDirs: string[] = [];
  const removedFiles: string[] = [];
  const _agentUninstalled = false;
  let daemonStopCalls = 0;
  const existing = new Set<string>([
    "/home/state",
    "/home/run",
    "/home/logs",
    "/home/config.yaml",
    "/home/config.yaml.bak",
  ]);
  const launchAgent: LaunchAgentPorts = {
    bootstrap: () => {
      throw new Error("uninstall never bootstraps");
    },
    bootout: () => ok({ wasLoaded: true }),
    isLoaded: () => true,
    writePlist: () => ok(null),
    readPlist: () => "<plist/>",
    removePlist: () => {},
    ensureDirectory: () => {},
  };
  const ports: UninstallPorts = {
    home: "/home",
    stateDir: "/home/state",
    logsDir: "/home/logs",
    runDir: "/home/run",
    configFile: "/home/config.yaml",
    configBackupFile: "/home/config.yaml.bak",
    userHome: "/users/gul",
    readConfiguration: (): Result<{ config: Configuration } | null, AppError> =>
      config === null ? ok(null) : ok({ config }),
    daemonRunning: () => true,
    stopDaemon: () => {
      daemonStopCalls += 1;
      return ok({ stopped: true });
    },
    launchAgent,
    agentsDirectory: "/users/gul/Library/LaunchAgents",
    uid: 501,
    removeDirectory: (path) => {
      removedDirs.push(path);
      existing.delete(path);
    },
    removeFile: (path) => {
      removedFiles.push(path);
      existing.delete(path);
    },
    exists: (path) => existing.has(path),
  };
  return Object.defineProperties(ports, {
    removedDirs: { value: removedDirs },
    removedFiles: { value: removedFiles },
    daemonStopCalls: { get: () => daemonStopCalls },
  }) as UninstallPorts & {
    removedDirs: string[];
    removedFiles: string[];
    daemonStopCalls: number;
  };
}

describe("sorage uninstall", () => {
  const config = defaultConfiguration("11111111-1111-4111-8111-111111111111");
  config.vault.path = "/vaults/keep-me";

  it("requires --as-user before anything else", () => {
    const ports = portsFor(config);
    const result = uninstallInstallation(ports, { asUser: false, confirm: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("USER_CONTEXT_REQUIRED");
    expect(ports.removedDirs).toEqual([]);
  });

  it("requires --confirm after --as-user", () => {
    const ports = portsFor(config);
    const result = uninstallInstallation(ports, { asUser: true, confirm: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(ports.removedDirs).toEqual([]);
  });

  it("refuses an uninitialized installation", () => {
    const ports = portsFor(null);
    const result = uninstallInstallation(ports, { asUser: true, confirm: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_INITIALIZED");
  });

  it("stops the daemon, removes the agent and the installation, and keeps the Vault", () => {
    const ports = portsFor(config);
    const result = uninstallInstallation(ports, { asUser: true, confirm: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.retainedVaultPath).toBe("/vaults/keep-me");
    expect(result.value.daemonStopped).toBe(true);
    expect(ports.daemonStopCalls).toBe(1);
    expect(result.value.launchAgent.wasLoaded).toBe(true);
    expect(ports.removedDirs).toEqual(["/home/state", "/home/run", "/home/logs"]);
    // config.yaml goes last, after the directories it no longer describes.
    expect(ports.removedFiles).toEqual(["/home/config.yaml", "/home/config.yaml.bak"]);
  });

  it("aborts with DAEMON_UNAVAILABLE and removes nothing when the daemon survives the stop", () => {
    const ports = portsFor(config);
    ports.stopDaemon = () => ok({ stopped: false });
    const result = uninstallInstallation(ports, { asUser: true, confirm: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DAEMON_UNAVAILABLE");
    expect(ports.removedDirs).toEqual([]);
    expect(ports.removedFiles).toEqual([]);
  });

  it("skips a daemon that is not running and paths that do not exist", () => {
    const ports = portsFor(config);
    ports.daemonRunning = () => false;
    ports.exists = () => false;
    const result = uninstallInstallation(ports, { asUser: true, confirm: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.daemonStopped).toBe(false);
    expect(ports.daemonStopCalls).toBe(0);
    expect(result.value.removed).toEqual([]);
    expect(result.value.launchAgent.wasLoaded).toBe(true);
  });
});
