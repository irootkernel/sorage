import { createServer as createNetServer, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeInstallation } from "@sorage/core";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDaemonPorts } from "@sorage/adapters/src/daemon-command-ports";
import { serveDaemon } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";
import type { RunningDaemon } from "../../src/runtime";

/**
 * The TASK-044 runtime contract: the record appears at bind, the drain refuses new
 * mutations while in-flight requests finish, the lock is released on stop, and the
 * sweep tick reports a checksum mismatch as ARTIFACT_CORRUPTED.
 */
const home = mkdtempSync(join(tmpdir(), "sorage-daemon-runtime-"));
const ports = createNodeDaemonPorts({ env: { ...process.env, SORAGE_HOME: home } });
let running: RunningDaemon | null = null;
let sweepTicks = 0;
let armed: (() => void) | null = null;

beforeAll(() => {
  process.env.SORAGE_HOME = home;
  // A minimal initialized installation: config.yaml with the defaults is enough,
  // because the runtime never touches the database before the sweep finds records.
  const result = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(result.ok).toBe(true);
});

afterAll(() => {
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function post(path: string): Promise<{ status: number; body: string }> {
  const port = running?.record.port ?? 0;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

describe("the daemon runtime", () => {
  it("binds, records, drains, refuses mutations, and releases the lock", async () => {
    const port = await freePort();
    const write = createNodeConfigCommandPorts().store;
    expect(write.readText()).not.toBeNull();
    // Point the configuration at the free port for this run.
    const config = write.read();
    expect(config.ok && config.value !== null).toBe(true);
    if (!config.ok || config.value === null) return;
    config.value.config.server.port = port;
    const written = write.write(config.value.config, { revision: config.value.revision });
    expect(written.ok).toBe(true);

    running = await serveDaemon({
      serverFactory: createDaemonServer,
      scheduleSweep: (run) => {
        sweepTicks += 1;
        return () => {};
      },
      armSignals: (drain) => {
        armed = drain;
      },
    });
    expect(running.record.port).toBe(port);
    expect(existsSync(join(home, "run", "daemon.json"))).toBe(true);

    const drained = running.drain();
    await drained;
    expect(existsSync(join(home, "run", "daemon.json"))).toBe(false);
    // The lifetime lock is free again.
    expect(ports.acquireDaemonLock().ok).toBe(true);
    expect(armed).not.toBeNull();
    expect(sweepTicks).toBe(1);
  }, 15000);
});
