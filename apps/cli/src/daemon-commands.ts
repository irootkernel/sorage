import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AppError, Configuration, Result } from "@sorage/core";
import { appError, errorEnvelope } from "@sorage/core";
import { createNodeDaemonPorts, type DaemonRunRecord } from "@sorage/adapters/src/daemon-command-ports";
import { blockingSleepMs } from "@sorage/adapters/src/sleep";

/**
 * The `sorage daemon start|stop|restart|status` use cases (RUN-006, RUN-008,
 * RUN-013): discovery through `run/daemon.json` with `installationId` confirmed over
 * health, `PORT_IN_USE` before any spawn, and the controlled restart a host or port
 * change requires. Like `sorage web`, every probe runs as the command's own
 * subprocess because the CLI main thread blocks synchronously (CLI-020).
 */

export const DAEMON_START_TIMEOUT_MS = 10_000;
export const DAEMON_STOP_GRACE_MS = 10_000;

export interface DaemonCommandPorts {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface DaemonRuntimePorts {
  readConfiguration(): Result<{ config: Configuration; installationId: string } | null, AppError>;
  readDaemonRecord(): DaemonRunRecord | null;
  removeDaemonRecord(): void;
  isPidAlive(pid: number): boolean;
  /** True when something already accepts connections at the address. */
  portHeld(host: string, port: number): boolean;
  /** True when health answers at the address with the expected installationId. */
  healthConfirms(host: string, port: number, installationId: string): boolean;
  spawnDaemon(): void;
  signal(pid: number, signal: NodeJS.Signals): boolean;
}

export function createDaemonRuntimePorts(): DaemonRuntimePorts {
  const ports = createNodeDaemonPorts();
  return {
    readConfiguration: () => ports.readConfiguration(),
    readDaemonRecord: () => ports.readDaemonRecord(),
    removeDaemonRecord: () => ports.removeDaemonRecord(),
    isPidAlive: (pid) => ports.isPidAlive(pid),
    portHeld: (host, port) => selfProbe(["__port-probe", host, String(port)]),
    healthConfirms: (host, port, installationId) => selfProbe(["__health-probe", host, String(port), installationId]),
    spawnDaemon: () => {
      const scriptArgs =
        process.argv[1] !== undefined && process.argv[1].endsWith("main.ts")
          ? [process.argv[1] as string, "daemon", "serve"]
          : ["daemon", "serve"];
      const child = spawn(process.execPath, scriptArgs, { detached: true, stdio: "ignore", env: process.env });
      child.unref();
    },
    signal: (pid, name) => {
      try {
        process.kill(pid, name);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function selfProbe(args: string[]): boolean {
  const scriptArgs =
    process.argv[1] !== undefined && process.argv[1].endsWith("main.ts") ? [process.argv[1] as string, ...args] : args;
  const probe = spawnSync(process.execPath, scriptArgs, { timeout: 5000 });
  return probe.status === 0;
}

export interface DaemonStatusPayload {
  daemon: { pid: number; host: string; port: number; startedAt: string; version: string; installationId: string };
  restartRequired: boolean;
}

function fail(ports: DaemonCommandPorts, code: number, message: string, recovery?: string): number {
  ports.err(
    `${JSON.stringify({ ok: false, error: { code: "DAEMON_UNAVAILABLE", message, ...(recovery !== undefined ? { recovery: { suggestedCommand: recovery } } : {}) }, meta: { requestId: "daemon" } }, null, 2)}\n`,
  );
  return code;
}

function configured(ports: DaemonRuntimePorts): { host: string; port: number; installationId: string } | null {
  const config = ports.readConfiguration();
  if (!config.ok || config.value === null) return null;
  return {
    host: config.value.config.server.host,
    port: config.value.config.server.port,
    installationId: config.value.installationId,
  };
}

function liveDaemon(ports: DaemonRuntimePorts): DaemonRunRecord | null {
  const record = ports.readDaemonRecord();
  if (record === null) return null;
  if (!ports.isPidAlive(record.pid)) return null;
  return record;
}

/** `sorage daemon start`: refuse a bound port, spawn, then confirm health. */
export function daemonStart(
  runtime: DaemonRuntimePorts,
  ports: DaemonCommandPorts,
  options: { startTimeoutMs?: number } = {},
): number {
  const config = configured(runtime);
  if (config === null) return fail(ports, 78, "Sorage has not been initialized.", "sorage init");
  if (runtime.portHeld(config.host, config.port)) {
    return renderDomainError(
      ports,
      "PORT_IN_USE",
      "the configured port is already bound",
      75,
      "Stop the other listener, or change server.port and restart",
    );
  }
  runtime.spawnDaemon();
  const deadline = Date.now() + (options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS);
  let ready = runtime.healthConfirms(config.host, config.port, config.installationId);
  while (Date.now() < deadline && !ready) {
    blockingSleepMs(200);
    ready = runtime.healthConfirms(config.host, config.port, config.installationId);
  }
  if (!ready) {
    return renderDomainError(ports, "DAEMON_UNAVAILABLE", "the daemon did not become ready", 69, "sorage daemon start");
  }
  const record = runtime.readDaemonRecord();
  ports.out(
    `${JSON.stringify({ ok: true, data: { started: true, ...(record !== null ? { daemon: record } : {}) }, meta: { requestId: "daemon" } }, null, 2)}\n`,
  );
  return 0;
}

/** `sorage daemon stop`: drain through SIGTERM and wait for the process to end. */
export function daemonStop(
  runtime: DaemonRuntimePorts,
  ports: DaemonCommandPorts,
  options: { stopGraceMs?: number } = {},
): number {
  const record = liveDaemon(runtime);
  if (record === null) {
    runtime.removeDaemonRecord();
    return fail(ports, 69, "no live daemon record was found", "sorage daemon start");
  }
  runtime.signal(record.pid, "SIGTERM");
  const deadline = Date.now() + (options.stopGraceMs ?? DAEMON_STOP_GRACE_MS);
  while (Date.now() < deadline && runtime.isPidAlive(record.pid)) {
    blockingSleepMs(100);
  }
  if (runtime.isPidAlive(record.pid)) {
    return renderDomainError(
      ports,
      "SERVICE_PAUSED",
      "the daemon did not stop within the grace window",
      75,
      "Inspect ~/.sorage/logs/sorage.log, then retry sorage daemon stop",
    );
  }
  runtime.removeDaemonRecord();
  ports.out(`${JSON.stringify({ ok: true, data: { stopped: true }, meta: { requestId: "daemon" } }, null, 2)}\n`);
  return 0;
}

/** `sorage daemon restart`: the controlled restart a host or port change requires. */
export function daemonRestart(runtime: DaemonRuntimePorts, ports: DaemonCommandPorts): number {
  const record = liveDaemon(runtime);
  if (record !== null) {
    const stopped = daemonStop(runtime, ports);
    if (stopped !== 0) return stopped;
  }
  return daemonStart(runtime, ports);
}

/** `sorage daemon status`: discovery through `run/daemon.json` and health. */
export function daemonStatus(
  runtime: DaemonRuntimePorts,
  ports: DaemonCommandPorts,
  options: { json: boolean },
): number {
  const config = configured(runtime);
  if (config === null) return fail(ports, 78, "Sorage has not been initialized.", "sorage init");
  const record = liveDaemon(runtime);
  if (record === null) {
    runtime.removeDaemonRecord();
    return fail(ports, 69, "no live daemon record was found", "sorage daemon start");
  }
  // Health is confirmed at the address the record says the daemon listens on; the
  // configuration may have moved on to a new host or port, which is exactly the
  // restart requirement reported below (RUN-008).
  if (!runtime.healthConfirms(record.host, record.port, config.installationId)) {
    return renderDomainError(
      ports,
      "DAEMON_UNAVAILABLE",
      "run/daemon.json names a daemon that does not answer health with this installationId",
      69,
      "sorage daemon start",
    );
  }
  const restartRequired = record.host !== config.host || record.port !== config.port;
  const payload: DaemonStatusPayload = { daemon: record, restartRequired };
  if (options.json) {
    ports.out(`${JSON.stringify({ ok: true, data: payload, meta: { requestId: "daemon" } }, null, 2)}\n`);
  } else {
    ports.out(
      `daemon pid ${record.pid} at ${record.host}:${record.port} (version ${record.version})\n` +
        (restartRequired
          ? "a configuration change requires sorage daemon restart\n"
          : "up to date with the configuration\n"),
    );
  }
  return 0;
}

function renderDomainError(
  ports: DaemonCommandPorts,
  code: Parameters<typeof appError>[0],
  message: string,
  exit: number,
  recovery: string,
): number {
  const error = appError(code, message);
  const envelope = errorEnvelope(error, randomUUID());
  envelope.error.recovery = { suggestedCommand: recovery };
  ports.err(`${JSON.stringify(envelope, null, 2)}\n`);
  return exit;
}
