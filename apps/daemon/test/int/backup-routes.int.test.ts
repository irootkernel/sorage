import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureBackup, initializeInstallation, ok } from "@sorage/core";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
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
 * The TASK-057 endpoint half of the four backup configuration commands: the
 * section 18.7 routes enable, disable, enable-push, and disable-push must each
 * produce the same configuration the matching CLI command produces, because
 * both drive the one `configureBackup` use case (BKP-025, BKP-017). The CLI
 * comparison fixture applies the same actions through the exact store shim
 * `apps/cli/src/main.ts` `backupConfigPorts` builds, then the endpoint-written
 * and CLI-written `gitBackup` subtrees must stay deep-equal after every action.
 */
const endpointHome = mkdtempSync(join(tmpdir(), "sorage-backup-routes-"));
const cliHome = mkdtempSync(join(tmpdir(), "sorage-backup-routes-cli-"));
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

function call(path: string, init?: { method?: string; bearer?: string; body?: unknown }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      ...(init?.bearer !== undefined ? { authorization: `Bearer ${init.bearer}` } : {}),
    };
    const payload = init?.body === undefined ? null : JSON.stringify(init.body);
    if (payload !== null) headers["content-type"] = "application/json";
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: init?.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", reject);
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

function readGitBackup(): Record<string, unknown> {
  const store = createNodeConfigCommandPorts().store;
  const read = store.read();
  if (!read.ok || read.value === null) throw new Error("reading the configuration failed");
  return read.value.config.gitBackup as Record<string, unknown>;
}

/** Applies one action exactly the way the CLI's backupConfigPorts shim does. */
function cliApply(action: "enable" | "disable" | "enable-push" | "disable-push", options: Record<string, unknown>) {
  const previous = process.env.SORAGE_HOME;
  process.env.SORAGE_HOME = cliHome;
  try {
    const store = createNodeConfigCommandPorts().store;
    const result = configureBackup(
      {
        read: () => {
          const read = store.read();
          if (!read.ok) return read;
          if (read.value === null) return ok(null);
          return ok({ config: read.value.config, etag: read.value.etag });
        },
        write: (next, expect) => {
          const written = store.write(next, { etag: expect.etag });
          if (!written.ok) return written;
          return ok({ etag: written.value.etag });
        },
      },
      { action, asUser: true, ...options },
    );
    expect(result.ok).toBe(true);
  } finally {
    process.env.SORAGE_HOME = previous;
  }
}

beforeAll(async () => {
  process.env.SORAGE_HOME = endpointHome;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath: join(endpointHome, "vault") });
  expect(init.ok).toBe(true);
  process.env.SORAGE_HOME = cliHome;
  const cliInit = initializeInstallation(createNodeInitPorts(), { vaultPath: join(cliHome, "vault") });
  expect(cliInit.ok).toBe(true);
  process.env.SORAGE_HOME = endpointHome;
  port = await freePort();
  const stateDir = join(endpointHome, "state");
  const tokenStore = createNodeApiTokenStore({ stateDir });
  tokenStore.ensure();
  apiToken = tokenStore.read() as string;
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: init.ok ? init.value.installationId : "x", version: "9.99.99-backup-routes" },
    auth: createSessionService({
      token: tokenStore,
      webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
      entropy: createNodeTokenEntropy(),
    }),
    tokenRotate: () => tokenStore.rotate(),
    config: createDaemonConfigService({ host: "127.0.0.1", port, startedAt: "2026-08-30T00:00:00.000Z" }),
    domainRoutes: createDomainRoutes({ vaultPath: () => join(endpointHome, "vault"), config: undefined }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closer.push(() => server.close());
});

afterAll(() => {
  for (const close of closer) close();
  delete process.env.SORAGE_HOME;
  rmSync(endpointHome, { recursive: true, force: true });
  rmSync(cliHome, { recursive: true, force: true });
});

function readCliGitBackup(): Record<string, unknown> {
  const previous = process.env.SORAGE_HOME;
  process.env.SORAGE_HOME = cliHome;
  try {
    return readGitBackup();
  } finally {
    process.env.SORAGE_HOME = previous;
  }
}

describe("the backup configuration endpoints (TASK-057, BKP-025)", () => {
  it("refuses an action that names no User context", async () => {
    const response = await call("/api/v1/backup/enable", { method: "POST", bearer: apiToken, body: {} });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "USER_CONTEXT_REQUIRED" } });
  });

  it("enable produces the same configuration the CLI command produces", async () => {
    cliApply("enable", { dailyAt: "03:00", timezone: "Asia/Seoul" });
    const response = await call("/api/v1/backup/enable", {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true, dailyAt: "03:00", timezone: "Asia/Seoul" },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
    expect(readGitBackup()).toEqual(readCliGitBackup());
  });

  it("enable-push produces the same configuration the CLI command produces", async () => {
    cliApply("enable-push", { remote: "origin", branch: "main" });
    const response = await call("/api/v1/backup/enable-push", {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true, remote: "origin", branch: "main" },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
    expect(readGitBackup()).toEqual(readCliGitBackup());
  });

  it("disable-push produces the same configuration the CLI command produces", async () => {
    cliApply("disable-push", {});
    const response = await call("/api/v1/backup/disable-push", {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
    expect(readGitBackup()).toEqual(readCliGitBackup());
  });

  it("disable produces the same configuration the CLI command produces", async () => {
    cliApply("disable", {});
    const response = await call("/api/v1/backup/disable", {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
    expect(readGitBackup()).toEqual(readCliGitBackup());
  });
});
