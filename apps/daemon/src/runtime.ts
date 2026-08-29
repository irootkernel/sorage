import type { Server } from "node:http";
import { join } from "node:path";
import { appError, showConfiguration } from "@sorage/core";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDaemonPorts, type DaemonRunRecord } from "@sorage/adapters/src/daemon-command-ports";
import { createLogger } from "@sorage/adapters/src/logging";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { createSessionService } from "./auth";
import { createDaemonServer, DAEMON_VERSION } from "./index";
import type { DaemonServerOptions } from "./index";

/**
 * The in-process daemon runtime behind `daemon serve`, `sorage daemon start`, and
 * `sorage web`'s spawned child (RUN-005, RUN-013, SEC-015): the lifetime
 * `daemon.lock`, the atomically written `run/daemon.json` record at bind, the
 * graceful drain that refuses new mutations before closing, and the periodic
 * Artifact checksum sweep bounded to 64 MiB per garbage-collection tick.
 */

/** The garbage-collection tick the sweep rides on; deliberately without a configuration key. */
export const SWEEP_TICK_MS = 60_000;

/** The byte budget one sweep tick may read (domain-and-architecture section 14.2). */
export const SWEEP_BYTE_BUDGET = 64 * 1024 * 1024;

export interface ServeDaemonOptions {
  /** Wired automatically from the process when absent; tests inject a prepared server. */
  serverFactory?: (options: DaemonServerOptions) => Server;
  /** The tick driver; production uses a timer, tests drive ticks by hand. */
  scheduleSweep?: (run: () => void) => () => void;
  /** The drain signal to arm; production arms SIGTERM and SIGINT. */
  armSignals?: (drain: () => void) => void;
}

export interface RunningDaemon {
  host: string;
  port: number;
  record: DaemonRunRecord;
  /** Performs one bounded sweep tick immediately. */
  runSweepTick(): { checked: number; mismatches: string[]; bytes: number };
  /** Drains: refuses mutations, waits for in-flight requests, then closes storage. */
  drain(): Promise<void>;
}

export function serveDaemon(options: ServeDaemonOptions = {}): Promise<RunningDaemon> {
  const config = showConfiguration(createNodeConfigCommandPorts());
  if (!config.ok) return Promise.reject(config.error);
  const { host, port } = config.value.server;
  const ports = createNodeDaemonPorts();

  const lock = ports.acquireDaemonLock();
  if (!lock.ok) {
    return Promise.reject(
      appError("SERVICE_PAUSED", "another daemon holds daemon.lock; stop it before starting a new one"),
    );
  }

  const stateDir = ports.home.stateDir;
  const token = createNodeApiTokenStore({ stateDir });
  token.ensure();
  const auth = createSessionService({
    token,
    webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
    entropy: createNodeTokenEntropy(),
  });

  let draining = false;
  let inFlight = 0;
  const serverFactory = options.serverFactory ?? createDaemonServer;
  const server = serverFactory({
    host,
    port,
    endpoints: { installationId: config.value.installationId, version: DAEMON_VERSION },
    auth,
    tokenRotate: () => token.rotate(),
    isDraining: () => draining,
    onRequestStart: () => {
      inFlight += 1;
    },
    onRequestEnd: () => {
      inFlight -= 1;
    },
  });

  let sweepCursor: string | null = null;
  const runSweepTick = () => {
    const batch = ports.nextArtifactBatch(sweepCursor, SWEEP_BYTE_BUDGET);
    sweepCursor = batch.nextCursor;
    const mismatches: string[] = [];
    let bytes = 0;
    for (const record of batch.records) {
      bytes += record.bytes;
      const digest = ports.hashArtifact(record.storageKey);
      if (digest !== record.sha256) mismatches.push(record.storageKey);
    }
    if (mismatches.length > 0) {
      sweepLogger().warn("daemon.artifact_corrupted", {
        code: "ARTIFACT_CORRUPTED",
        count: mismatches.length,
        storageKeys: mismatches,
      });
    }
    return { checked: batch.records.length, mismatches, bytes };
  };

  const stopSweep =
    options.scheduleSweep === undefined ? scheduleTimer(runSweepTick) : options.scheduleSweep(runSweepTick);

  return new Promise((resolve, reject) => {
    server.once("error", (error: Error) => {
      lock.release?.();
      reject(appError("PORT_IN_USE", `the configured port is already bound: ${error.message}`));
    });
    server.listen(port, host, () => {
      const record: DaemonRunRecord = {
        pid: process.pid,
        host,
        port,
        startedAt: new Date().toISOString(),
        version: DAEMON_VERSION,
        installationId: config.value.installationId,
      };
      // The record is the bind marker: written atomically only after listen succeeded.
      ports.writeDaemonRecord(record);
      const drain = async () => {
        // Refuse new mutations first; the requests already in flight finish, and
        // only then do the listener and the storage close (SEC-015).
        draining = true;
        stopSweep();
        // Yield once so requests already queued in the event loop are admitted and
        // answered with SERVICE_PAUSED rather than losing their connection.
        await new Promise((wake) => setImmediate(wake));
        const deadline = Date.now() + 10_000;
        while (inFlight > 0 && Date.now() < deadline) {
          await new Promise((wake) => setTimeout(wake, 50));
        }
        server.close();
        ports.removeDaemonRecord();
        lock.release?.();
      };
      if (options.armSignals !== undefined) {
        options.armSignals(() => {
          void drain().then(() => process.exit(0));
        });
      }
      resolve({
        host,
        port,
        record,
        runSweepTick,
        drain: async () => {
          await drain();
          server.closeAllConnections?.();
        },
      });
    });
  });
}

function scheduleTimer(run: () => void): () => void {
  const timer = setInterval(run, SWEEP_TICK_MS);
  return () => clearInterval(timer);
}

let daemonLogger: ReturnType<typeof createLogger> | null | undefined;
function sweepLogger(): Pick<ReturnType<typeof createLogger>, "warn"> {
  if (daemonLogger !== undefined) {
    return daemonLogger ?? silentLogger;
  }
  try {
    const ports = createNodeDaemonPorts();
    daemonLogger = createLogger({
      file: join(ports.home.logsDir, "sorage.log"),
      level: "info",
      homePath: ports.home.home,
    });
  } catch {
    daemonLogger = null;
  }
  return daemonLogger ?? silentLogger;
}

const silentLogger = { warn: (_event: string, _fields?: Record<string, unknown>) => {} };
