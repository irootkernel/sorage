import type { Server } from "node:http";
import { join } from "node:path";
import { appError, backupTickDecision, runBackupOnce, setConfigurationValue, showConfiguration } from "@sorage/core";
import { createNodeBackupCommandPorts } from "@sorage/adapters/src/backup-command-ports";
import type { Configuration } from "@sorage/core";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import {
  createNodeDaemonPorts,
  type DaemonRunRecord,
  openNodeDaemonDatabase,
} from "@sorage/adapters/src/daemon-command-ports";
import { createLogger } from "@sorage/adapters/src/logging";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { createSessionService } from "./auth";
import { createDomainRoutes } from "./domain-routes";
import { createDaemonServer, DAEMON_VERSION } from "./index";
import type { DaemonConfigService, DaemonServerOptions } from "./index";
import { createHash } from "node:crypto";

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
  /** The backup tick driver; production uses a 60-second timer, tests drive it by hand. */
  scheduleBackup?: (run: () => void) => () => void;
  /** The clock the backup tick decides against; tests drive it across DST days and sleep gaps. */
  now?: () => Date;
  /** The drain signal to arm; production arms SIGTERM and SIGINT. */
  armSignals?: (drain: () => void) => void;
  /** How the process ends after a controlled restart; tests keep the runner alive. */
  restartExit?: (code: number) => void;
}

export interface RunningDaemon {
  host: string;
  port: number;
  record: DaemonRunRecord;
  /** Performs one bounded sweep tick immediately. */
  runSweepTick(): { checked: number; mismatches: string[]; bytes: number };
  /** Performs one backup scheduler tick immediately and reports what it decided. */
  runBackupTick(): { action: string; triggeredBy?: string; nextDueAt: string | null; run?: unknown };
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
  const database = openNodeDaemonDatabase(stateDir);
  let databaseClosed = false;
  const closeDatabase = () => {
    if (databaseClosed) return;
    databaseClosed = true;
    database.close();
  };
  const token = createNodeApiTokenStore({ stateDir });
  token.ensure();
  const auth = createSessionService({
    token,
    webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
    entropy: createNodeTokenEntropy(),
  });

  let draining = false;
  let inFlight = 0;
  // Late-bound so the restart hook and the listen callback share one drain.
  let drain: () => Promise<void> = async () => {};
  const serverFactory = options.serverFactory ?? createDaemonServer;
  const configService = createDaemonConfigService({
    host,
    port,
    startedAt: new Date().toISOString(),
  });
  const server = serverFactory({
    host,
    port,
    endpoints: { installationId: config.value.installationId, version: DAEMON_VERSION },
    auth,
    tokenRotate: () => token.rotate(),
    config: configService,
    domainRoutes: createDomainRoutes({
      vaultPath: () => ports.vaultPath(),
      config: configService,
      database,
    }),
    vaultPath: () => ports.vaultPath(),
    onRestartRequest: () => {
      // The controlled restart of RUN-008: answer, then run the same graceful
      // drain SEC-015 mandates for a stop - refuse mutations, let in-flight
      // requests finish - before the listener, the record, and the lock go.
      setTimeout(() => {
        void drain().then(() => (options.restartExit ?? ((code: number) => process.exit(code)))(0));
      }, 50);
    },
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

  // The backup scheduler of section 29 (RUN-002): only the daemon schedules.
  // Every tick re-reads the configuration so a reloaded gitBackup.* key takes
  // effect on the next tick, and every run it triggers goes through the same
  // engine and backup.lock a manual run uses.
  const runBackupTick = () => {
    const current = showConfiguration(createNodeConfigCommandPorts());
    if (!current.ok) return { action: "none", nextDueAt: null };
    const spec = {
      enabled: current.value.gitBackup.enabled,
      at: current.value.gitBackup.schedule.at,
      timezone: current.value.gitBackup.schedule.timezone,
      catchUpAfterMissedRun: current.value.gitBackup.schedule.catchUpAfterMissedRun,
    };
    const backupPorts = createNodeBackupCommandPorts();
    const statusPorts = backupPorts.statusPorts();
    const lastRunAt = statusPorts.ok ? statusPorts.value.lastRunAt() : { ok: false as const };
    const decision = backupTickDecision(
      spec,
      (options.now ?? (() => new Date()))(),
      lastRunAt.ok ? lastRunAt.value : null,
    );
    if (decision.action !== "run") {
      return { action: "none", nextDueAt: decision.nextDueAt };
    }
    const runPorts = backupPorts.runPorts(decision.triggeredBy);
    if (!runPorts.ok) {
      sweepLogger().warn("daemon.backup_run_refused", { code: runPorts.error.code });
      return { action: "refused", triggeredBy: decision.triggeredBy, nextDueAt: decision.nextDueAt };
    }
    const run = runBackupOnce(runPorts.value);
    if (!run.ok) {
      // BACKUP_IN_PROGRESS from a concurrent holder is an expected refusal;
      // the next tick re-evaluates coverage once that run finishes.
      sweepLogger().warn("daemon.backup_run_failed", { code: run.error.code, triggeredBy: decision.triggeredBy });
      return { action: "failed", triggeredBy: decision.triggeredBy, nextDueAt: decision.nextDueAt };
    }
    return {
      action: "ran",
      triggeredBy: decision.triggeredBy,
      nextDueAt: decision.nextDueAt,
      run: run.value,
    };
  };

  const stopBackup =
    options.scheduleBackup === undefined ? scheduleTimer(runBackupTick) : options.scheduleBackup(runBackupTick);

  return new Promise((resolve, reject) => {
    server.once("error", (error: Error) => {
      closeDatabase();
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
      drain = async () => {
        // Refuse new mutations first; the requests already in flight finish, and
        // only then do the listener and the storage close (SEC-015).
        draining = true;
        stopSweep();
        stopBackup();
        // Yield once so requests already queued in the event loop are admitted and
        // answered with SERVICE_PAUSED rather than losing their connection.
        await new Promise((wake) => setImmediate(wake));
        const deadline = Date.now() + 10_000;
        while (inFlight > 0 && Date.now() < deadline) {
          await new Promise((wake) => setTimeout(wake, 50));
        }
        server.close();
        closeDatabase();
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
        runBackupTick,
        drain: async () => {
          await drain();
          server.closeAllConnections?.();
        },
      });
    });
  });
}

/**
 * The daemon-side configuration service (CFG-016, CFG-019): while the daemon runs it
 * is the only writer of `config.yaml`, so reads return the canonical text and the
 * content-hash ETag, writes are fenced on that hash exactly like the CLI's revision
 * fence, and a reload reports which fields still require a restart (RUN-008).
 */
export function createDaemonConfigService(running: {
  host: string;
  port: number;
  startedAt: string;
}): DaemonConfigService {
  const ports = createNodeConfigCommandPorts();
  const restartRequiredOf = (config: Configuration): string[] => {
    const fields: string[] = [];
    if (config.server.host !== running.host) fields.push("server.host");
    if (config.server.port !== running.port) fields.push("server.port");
    return fields;
  };
  return {
    get: () => {
      const current = ports.store.read();
      if (!current.ok) return current;
      if (current.value === null) {
        return { ok: false, error: appError("NOT_INITIALIZED", "Sorage has not been initialized.") };
      }
      const yaml = ports.store.readText();
      if (yaml === null) {
        return { ok: false, error: appError("NOT_INITIALIZED", "Sorage has not been initialized.") };
      }
      return {
        ok: true,
        value: {
          config: current.value.config as unknown as Record<string, unknown>,
          yaml,
          etag: `sha256:${createHash("sha256").update(yaml).digest("hex")}`,
          configRevision: current.value.config.configRevision,
          configFile: ports.configFile,
        },
      };
    },
    set: (input) => {
      // The If-Match fence: a caller holding an older content hash conflicts exactly
      // like a stale revision does (CFG-019), before any write is attempted.
      const current = ports.store.read();
      if (!current.ok) return current;
      if (current.value === null) {
        return { ok: false, error: appError("NOT_INITIALIZED", "Sorage has not been initialized.") };
      }
      if (current.value.etag !== input.etag.replace(/^sha256:/, "")) {
        return {
          ok: false,
          error: appError("CONFIG_CONFLICT", "the configuration changed since it was read; reload it and retry", {
            expected: input.etag,
          }),
        };
      }
      const changed = setConfigurationValue(ports, { key: input.key, rawValue: input.rawValue, asUser: true });
      if (!changed.ok) return changed;
      const snapshot = ports.store.readText();
      if (snapshot === null) {
        return { ok: false, error: appError("INTERNAL_ERROR", "the configuration vanished after the write") };
      }
      return {
        ok: true,
        value: {
          key: changed.value.key,
          configRevision: changed.value.configRevision,
          etag: `sha256:${createHash("sha256").update(snapshot).digest("hex")}`,
        },
      };
    },
    reload: () => {
      const current = ports.store.read();
      if (!current.ok) return current;
      if (current.value === null) {
        return { ok: false, error: appError("NOT_INITIALIZED", "Sorage has not been initialized.") };
      }
      return {
        ok: true,
        value: {
          applied: [
            "handoff.*",
            "artifact.*",
            "gitBackup.*",
            "ui.*",
            "logging.*",
            "server.autoStart",
            "server.openBrowserOnStart",
          ],
          restartRequired: restartRequiredOf(current.value.config),
        },
      };
    },
    status: () => {
      const current = ports.store.read();
      if (!current.ok) return current;
      if (current.value === null) {
        return { ok: false, error: appError("NOT_INITIALIZED", "Sorage has not been initialized.") };
      }
      return {
        ok: true,
        value: {
          startedAt: running.startedAt,
          host: running.host,
          port: running.port,
          restartRequired: restartRequiredOf(current.value.config),
        },
      };
    },
  };
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
