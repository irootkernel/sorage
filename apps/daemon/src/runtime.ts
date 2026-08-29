import { showConfiguration } from "@sorage/core";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { createSessionService } from "./auth";
import { createDaemonServer, DAEMON_VERSION } from "./index";

/**
 * The in-process daemon runtime behind `daemon serve` and `sorage web`'s spawned
 * child (RUN-005, SEC-020): loads the resolved configuration, wires the token and
 * web-secret stores into the session service, and listens on the configured loopback
 * address. TASK-044 grows this into the full lifecycle with `run/daemon.json`.
 */
export function serveDaemon(onBound?: (host: string, port: number) => void): Promise<{ close: () => void }> {
  const config = showConfiguration(createNodeConfigCommandPorts());
  if (!config.ok) {
    return Promise.reject(config.error);
  }
  const { host, port } = config.value.server;
  const stateDir = createStateDir();
  const token = createNodeApiTokenStore({ stateDir });
  token.ensure();
  const auth = createSessionService({
    token,
    webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
    entropy: createNodeTokenEntropy(),
  });
  const server = createDaemonServer({
    host,
    port,
    endpoints: { installationId: config.value.installationId, version: DAEMON_VERSION },
    auth,
    tokenRotate: () => token.rotate(),
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: Error) => reject(error));
    server.listen(port, host, () => {
      onBound?.(host, port);
      resolve({ close: () => server.close() });
    });
  });
}

function createStateDir(): string {
  // The state directory is `<home>/state`; resolve it through the shared home service
  // so `SORAGE_HOME` governs the daemon exactly as it governs every other process.
  return createNodeHomePaths().stateDir;
}
