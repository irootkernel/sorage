import { spawn, spawnSync } from "node:child_process";
import {
  createNodeDaemonPorts,
  type DaemonRunRecord,
  daemonStartAdmissionRefusal,
} from "@sorage/adapters/src/daemon-command-ports";
import { blockingSleepMs } from "@sorage/adapters/src/sleep";
import type { AppError, Configuration, Result } from "@sorage/core";
import { appError, sleepWithinDeadline, successEnvelope } from "@sorage/core";
import { renderAppError, requestId } from "./cli-output";
import { selfInvocationArgv } from "./self-invocation";

/**
 * The `sorage daemon start|stop|restart|status` use cases (RUN-006, RUN-008,
 * RUN-013): discovery through `run/daemon.json` with `installationId` confirmed over
 * health, `PORT_IN_USE` before any spawn, and the controlled restart a host or port
 * change requires. Like `sorage web`, every probe runs as the command's own
 * subprocess because the CLI main thread blocks synchronously (CLI-020).
 */

export const DAEMON_START_TIMEOUT_MS = 10_000;
export const DAEMON_STOP_GRACE_MS = 10_000;
const DAEMON_START_INITIAL_POLL_MS = 200;
const DAEMON_STOP_INITIAL_POLL_MS = 100;
const DAEMON_POLL_MAX_INTERVAL_MS = 1_000;

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
  /**
   * The non-mutating history-admission check a spawning parent runs before
   * detaching a child: the established typed refusal when the database schema
   * is confirmed unsupported, or null when the caller keeps its own behavior.
   */
  historyAdmissionRefusal(): AppError | null;
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
    historyAdmissionRefusal: () => daemonStartAdmissionRefusal(),
    spawnDaemon: () => {
      const child = spawn(process.execPath, selfInvocationArgv(["daemon", "serve"]), {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
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
  const probe = spawnSync(process.execPath, selfInvocationArgv(args), { timeout: 5000 });
  return probe.status === 0;
}

export interface DaemonStatusPayload {
  daemon: { pid: number; host: string; port: number; startedAt: string; version: string; installationId: string };
  restartRequired: boolean;
}

function withRecovery(code: Parameters<typeof appError>[0], message: string, suggestedCommand: string): AppError {
  return { ...appError(code, message), recovery: { suggestedCommand } };
}

function readConfigured(
  ports: DaemonRuntimePorts,
): Result<{ host: string; port: number; installationId: string }, AppError> {
  const config = ports.readConfiguration();
  if (!config.ok) return config;
  if (config.value === null) {
    return {
      ok: false,
      error: withRecovery("NOT_INITIALIZED", "Sorage has not been initialized.", "sorage init"),
    };
  }
  return {
    ok: true,
    value: {
      host: config.value.config.server.host,
      port: config.value.config.server.port,
      installationId: config.value.installationId,
    },
  };
}

function liveDaemon(ports: DaemonRuntimePorts): DaemonRunRecord | null {
  const record = ports.readDaemonRecord();
  if (record === null) return null;
  if (!ports.isPidAlive(record.pid)) return null;
  return record;
}

/** `sorage daemon start`: refuse a bound port, confirm history admission, spawn, then confirm health. */
export function daemonStart(
  runtime: DaemonRuntimePorts,
  ports: DaemonCommandPorts,
  options: {
    json?: boolean;
    startTimeoutMs?: number;
    now?: () => number;
    sleepMs?: (milliseconds: number) => void;
  } = {},
): number {
  const json = options.json === true;
  const configResult = readConfigured(runtime);
  if (!configResult.ok) return renderAppError(configResult.error, ports, json);
  const config = configResult.value;
  if (runtime.portHeld(config.host, config.port)) {
    return renderAppError(
      withRecovery(
        "PORT_IN_USE",
        "the configured port is already bound",
        "Stop the other listener, or change server.port and restart",
      ),
      ports,
      json,
    );
  }
  // A confirmed unsupported database history is the one refusal the parent
  // establishes itself before spawning (SHR-009): the check reads a stable
  // private copy, so the selected installation's database, WAL, SHM, history,
  // configuration, and marker stay unchanged, and only the established typed
  // refusal surfaces — anything else keeps the original lifecycle behavior.
  const admission = runtime.historyAdmissionRefusal();
  if (admission !== null) {
    return renderAppError(admission, ports, json);
  }
  runtime.spawnDaemon();
  const now = options.now ?? Date.now;
  const sleep = options.sleepMs ?? blockingSleepMs;
  const deadline = now() + (options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS);
  let intervalMs = DAEMON_START_INITIAL_POLL_MS;
  let ready = runtime.healthConfirms(config.host, config.port, config.installationId);
  while (!ready && sleepWithinDeadline(deadline - 1, now(), intervalMs, sleep)) {
    intervalMs = Math.min(intervalMs * 2, DAEMON_POLL_MAX_INTERVAL_MS);
    if (now() >= deadline) break;
    ready = runtime.healthConfirms(config.host, config.port, config.installationId);
  }
  if (!ready) {
    return renderAppError(
      withRecovery("DAEMON_UNAVAILABLE", "the daemon did not become ready", "sorage daemon start"),
      ports,
      json,
    );
  }
  const record = runtime.readDaemonRecord();
  const payload = { started: true, ...(record !== null ? { daemon: record } : {}) };
  if (json) {
    ports.out(`${JSON.stringify(successEnvelope(payload, requestId()), null, 2)}\n`);
  } else if (record !== null) {
    ports.out(`Daemon started (pid ${record.pid} at ${record.host}:${record.port}, version ${record.version}).\n`);
  } else {
    ports.out("Daemon started.\n");
  }
  return 0;
}

/** `sorage daemon stop`: drain through SIGTERM and wait for the process to end. */
export function daemonStop(
  runtime: DaemonRuntimePorts,
  ports: DaemonCommandPorts,
  options: { json?: boolean; stopGraceMs?: number; now?: () => number; sleepMs?: (milliseconds: number) => void } = {},
): number {
  const json = options.json === true;
  const record = liveDaemon(runtime);
  if (record === null) {
    runtime.removeDaemonRecord();
    return renderAppError(
      withRecovery("DAEMON_UNAVAILABLE", "no live daemon record was found", "sorage daemon start"),
      ports,
      json,
    );
  }
  runtime.signal(record.pid, "SIGTERM");
  const now = options.now ?? Date.now;
  const sleep = options.sleepMs ?? blockingSleepMs;
  const deadline = now() + (options.stopGraceMs ?? DAEMON_STOP_GRACE_MS);
  let intervalMs = DAEMON_STOP_INITIAL_POLL_MS;
  let alive = runtime.isPidAlive(record.pid);
  while (alive && sleepWithinDeadline(deadline - 1, now(), intervalMs, sleep)) {
    intervalMs = Math.min(intervalMs * 2, DAEMON_POLL_MAX_INTERVAL_MS);
    if (now() >= deadline) break;
    alive = runtime.isPidAlive(record.pid);
  }
  if (alive) {
    return renderAppError(
      withRecovery(
        "SERVICE_PAUSED",
        "the daemon did not stop within the grace window",
        "Inspect ~/.sorage/logs/sorage.log, then retry sorage daemon stop",
      ),
      ports,
      json,
    );
  }
  runtime.removeDaemonRecord();
  if (json) {
    ports.out(`${JSON.stringify(successEnvelope({ stopped: true }, requestId()), null, 2)}\n`);
  } else {
    ports.out("Daemon stopped.\n");
  }
  return 0;
}

/** `sorage daemon restart`: the controlled restart a host or port change requires. */
export function daemonRestart(
  runtime: DaemonRuntimePorts,
  ports: DaemonCommandPorts,
  options: {
    json?: boolean;
    stopGraceMs?: number;
    startTimeoutMs?: number;
    now?: () => number;
    sleepMs?: (milliseconds: number) => void;
  } = {},
): number {
  const record = liveDaemon(runtime);
  if (record !== null) {
    // Suppress intermediate stop stdout so restart emits only the final start result
    // on success, while still surfacing a stop failure cleanly on stderr.
    const stopped = daemonStop(runtime, { out: () => {}, err: ports.err }, options);
    if (stopped !== 0) return stopped;
  }
  return daemonStart(runtime, ports, options);
}

/** `sorage daemon status`: discovery through `run/daemon.json` and health. */
export function daemonStatus(
  runtime: DaemonRuntimePorts,
  ports: DaemonCommandPorts,
  options: { json: boolean },
): number {
  const json = options.json;
  const configResult = readConfigured(runtime);
  if (!configResult.ok) return renderAppError(configResult.error, ports, json);
  const config = configResult.value;
  const record = liveDaemon(runtime);
  if (record === null) {
    runtime.removeDaemonRecord();
    return renderAppError(
      withRecovery("DAEMON_UNAVAILABLE", "no live daemon record was found", "sorage daemon start"),
      ports,
      json,
    );
  }
  // Health is confirmed at the address the record says the daemon listens on; the
  // configuration may have moved on to a new host or port, which is exactly the
  // restart requirement reported below (RUN-008).
  if (!runtime.healthConfirms(record.host, record.port, config.installationId)) {
    return renderAppError(
      withRecovery(
        "DAEMON_UNAVAILABLE",
        "run/daemon.json names a daemon that does not answer health with this installationId",
        "sorage daemon start",
      ),
      ports,
      json,
    );
  }
  const restartRequired = record.host !== config.host || record.port !== config.port;
  const payload: DaemonStatusPayload = { daemon: record, restartRequired };
  if (json) {
    ports.out(`${JSON.stringify(successEnvelope(payload, requestId()), null, 2)}\n`);
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
