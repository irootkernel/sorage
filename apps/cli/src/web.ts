import { spawn, spawnSync } from "node:child_process";
import { showConfiguration, SystemClock } from "@sorage/core";
import type { AppError, Configuration, Result } from "@sorage/core";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { blockingSleepMs } from "@sorage/adapters/src/sleep";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";

/**
 * The `sorage web` use case (RUN-012, SEC-019): probe the daemon, start it when
 * nothing answers, issue the single-use browser secret, and hand the User a URL whose
 * fragment carries that secret so the SPA can exchange it at `POST /api/v1/session`.
 *
 * The CLI process is single threaded by design (CLI-020), so the probe runs the
 * command's own `__health-probe` subprocess synchronously instead of opening a socket
 * on the blocked main thread.
 */

export interface WebCommandPorts {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface WebRuntimePorts {
  /** Probes `GET /api/v1/health`; false when nothing answers in time. */
  probeDaemon(host: string, port: number): boolean;
  /** Starts the detached daemon process. */
  spawnDaemon(): void;
  /** Opens the operating-system browser at the URL. */
  openBrowser(url: string): void;
  /** Reads the resolved configuration. */
  readConfig(): Result<Configuration, AppError>;
  /** Issues the one-time browser secret. */
  issueSecret(): Result<{ secret: string; expiresAt: string }, AppError>;
}

/** Interpreter plus entry arguments for re-invoking this CLI as a subprocess. */
function selfInvocation(extraArgs: string[]): { interpreter: string; args: string[] } {
  // Under `bun apps/cli/src/main.ts` the interpreter and the entry are separate argv
  // slots; the compiled binary is a single executable.
  const scriptArgs =
    process.argv[1] !== undefined && process.argv[1].endsWith("main.ts")
      ? [process.argv[1] as string, ...extraArgs]
      : extraArgs;
  return { interpreter: process.execPath, args: scriptArgs };
}

export const WEB_START_TIMEOUT_MS = 10_000;

export function createWebRuntimePorts(stateDir: string): WebRuntimePorts {
  return {
    probeDaemon: (host, port) => {
      const invocation = selfInvocation(["__health-probe", host, String(port)]);
      const probe = spawnSync(invocation.interpreter, invocation.args, { timeout: 5000, encoding: "utf8" });
      return probe.status === 0;
    },
    spawnDaemon: () => {
      const invocation = selfInvocation(["daemon", "serve"]);
      const child = spawn(invocation.interpreter, invocation.args, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
    },
    openBrowser: (url) => {
      // Automation guard: a test or script that drives the URL itself suppresses
      // the system browser, which would otherwise race the driver for the
      // single-use secret; the URL and the exit path are unchanged.
      if (process.env.SORAGE_WEB_SUPPRESS_OPEN === "1") return;
      if (process.platform === "darwin") {
        const opener = spawn("open", [url], { detached: true, stdio: "ignore" });
        opener.unref();
      }
    },
    readConfig: () => showConfig(),
    issueSecret: () => createNodeWebSecretStore({ stateDir, clock: new SystemClock() }).issue(),
  };
}

function showConfig(): Result<Configuration, AppError> {
  return showConfiguration(createNodeConfigCommandPorts());
}

export interface WebOutcome {
  daemonStarted: boolean;
  url: string;
  expiresAt: string;
}

/** Runs `sorage web`: the daemon answers, the secret exists, and the browser opens. */
export function runWebCommand(
  ports: WebRuntimePorts,
  output: WebCommandPorts,
  options: { openBrowser: boolean; startTimeoutMs?: number },
): number {
  const config = ports.readConfig();
  if (!config.ok) {
    output.err(`CONFIG_INVALID: ${config.error.message}\n`);
    return 78;
  }
  const { host, port } = config.value.server;
  let daemonStarted = false;
  if (!ports.probeDaemon(host, port)) {
    ports.spawnDaemon();
    daemonStarted = true;
    const deadline = Date.now() + (options.startTimeoutMs ?? WEB_START_TIMEOUT_MS);
    let ready = ports.probeDaemon(host, port);
    while (Date.now() < deadline && !ready) {
      blockingSleepMs(200);
      ready = ports.probeDaemon(host, port);
    }
    if (!ready) {
      output.err("DAEMON_UNAVAILABLE: the daemon did not become ready\nRecovery: sorage daemon start\n");
      return 69;
    }
  }
  const secret = ports.issueSecret();
  if (!secret.ok) {
    output.err(`INTERNAL_ERROR: ${secret.error.message}\n`);
    return 1;
  }
  // The URL must name the address the daemon actually bound: an IPv6 loopback bind
  // is only reachable in bracketed form.
  const authority = config.value.server.host === "::1" ? `[::1]:${port}` : `127.0.0.1:${port}`;
  const url = `http://${authority}/#s=${secret.value.secret}`;
  if (options.openBrowser) ports.openBrowser(url);
  output.out(
    `${JSON.stringify(
      {
        url,
        daemonStarted,
        expiresAt: secret.value.expiresAt,
        note: "the fragment secret is single-use and expires; run sorage web again for a fresh one",
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

/** Reads the Installation API token for CLI-to-daemon calls (SEC-002). */
export function readApiToken(stateDir: string): string | null {
  return createNodeApiTokenStore({ stateDir, entropy: createNodeTokenEntropy() }).read();
}
