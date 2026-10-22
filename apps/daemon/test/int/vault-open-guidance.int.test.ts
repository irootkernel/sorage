import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeInstallation, VAULT_OPEN_RECOVERY } from "@sorage/core";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { createSessionService } from "../../src/auth";
import { createDomainRoutes } from "../../src/domain-routes";
import { createDaemonConfigService } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";

/**
 * TASK-118 on the daemon surface: a Vault-open refusal keeps the same code and
 * HTTP mapping while carrying the state-specific recovery, and no route or DTO
 * shape changes (F1, VLT-002).
 */
const home = mkdtempSync(join(tmpdir(), "sorage-daemon-vault-open-"));
const vaultPath = join(home, "vault");
let port = 0;
let apiToken: string;
const closer: Array<() => void> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const free = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(free));
    });
    probe.on("error", reject);
  });
}

function authed(path: string, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${apiToken}` },
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
    outgoing.end();
  });
}

beforeAll(async () => {
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath });
  expect(init.ok).toBe(true);
  port = await freePort();
  const stateDir = join(home, "state");
  const tokenStore = createNodeApiTokenStore({ stateDir });
  tokenStore.ensure();
  apiToken = tokenStore.read() as string;
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: init.ok ? init.value.installationId : "x", version: "9.9.99-vault-open" },
    auth: createSessionService({
      token: tokenStore,
      webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
      entropy: createNodeTokenEntropy(),
    }),
    tokenRotate: () => tokenStore.rotate(),
    config: createDaemonConfigService({ host: "127.0.0.1", port, startedAt: "2026-10-22T00:00:00.000Z" }),
    domainRoutes: createDomainRoutes({ vaultPath: () => vaultPath, config: undefined }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closer.push(() => server.close());
  rmSync(vaultPath, { recursive: true, force: true });
});

afterAll(() => {
  for (const close of closer) close();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("the daemon Vault-open refusal (TASK-118)", () => {
  it.each([
    ["GET", "/api/v1/vault/status"],
    ["POST", "/api/v1/vault/verify"],
  ])("%s %s maps the missing Vault to 409 with its state recovery", async (method, path) => {
    const response = await authed(path, method);
    expect(response.status).toBe(409);
    const envelope = JSON.parse(response.body) as {
      ok: boolean;
      error: {
        code: string;
        message: string;
        details: Record<string, unknown>;
        recovery?: { suggestedCommand: string };
      };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("VAULT_INTEGRITY_ERROR");
    expect(envelope.error.message).toBe(`The Vault directory does not exist at ${vaultPath}.`);
    expect(envelope.error.details).toEqual({ vaultPath });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.missingDirectory);
  });
});
