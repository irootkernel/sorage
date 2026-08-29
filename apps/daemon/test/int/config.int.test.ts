import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeInstallation } from "@sorage/core";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { createSessionService } from "../../src/auth";
import { createDaemonConfigService } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";

/**
 * The TASK-045 configuration surface over a real socket: the ETag-fenced write, the
 * documented CONFIG_CONFLICT, the reload that reports the restart a port change
 * requires, and the static settings shell behind the daemon's own CSP.
 */
const home = mkdtempSync(join(tmpdir(), "sorage-daemon-config-"));
let port = 0;
let apiToken: string;
let etag: string;
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

function authed(
  path: string,
  init?: { method?: string; bearer?: string; body?: unknown; extra?: Record<string, string> },
) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const headers: Record<string, string> = {
        host: `127.0.0.1:${port}`,
        ...(init?.bearer !== undefined ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init?.extra ?? {}),
      };
      const payload = init?.body === undefined ? null : JSON.stringify(init.body);
      if (payload !== null) headers["content-type"] = "application/json";
      const outgoing = httpRequest(
        { host: "127.0.0.1", port, path, method: init?.method ?? "GET", headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      outgoing.on("error", reject);
      if (payload !== null) outgoing.write(payload);
      outgoing.end();
    },
  );
}

beforeAll(async () => {
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(init.ok).toBe(true);
  port = await freePort();
  const stateDir = join(home, "state");
  const tokenStore = createNodeApiTokenStore({ stateDir });
  tokenStore.ensure();
  apiToken = tokenStore.read() as string;
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: init.ok ? init.value.installationId : "x", version: "9.9.99-config" },
    auth: createSessionService({
      token: tokenStore,
      webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
      entropy: createNodeTokenEntropy(),
    }),
    tokenRotate: () => tokenStore.rotate(),
    config: createDaemonConfigService({ host: "127.0.0.1", port, startedAt: "2026-08-30T00:00:00.000Z" }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closer.push(() => server.close());
  const current = await authed("/api/v1/config", { bearer: apiToken });
  etag = String(current.headers.etag);
});

afterAll(() => {
  for (const close of closer) close();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("the configuration endpoints (CFG-016, CFG-019)", () => {
  it("returns the configuration with its canonical YAML and ETag", async () => {
    const response = await authed("/api/v1/config", { bearer: apiToken });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(typeof body.data.yaml).toBe("string");
    expect(body.data.yaml).toContain("installationId");
    expect(body.data.configFile).toContain("config.yaml");
    expect(response.headers.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses an unauthenticated read", async () => {
    const response = await authed("/api/v1/config");
    expect(response.status).toBe(401);
  });

  it("applies a typed change fenced on the current ETag", async () => {
    const response = await authed("/api/v1/config", {
      method: "PUT",
      bearer: apiToken,
      extra: { "if-match": etag },
      body: { key: "ui.defaultPageSize", value: "25" },
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.data.key).toBe("ui.defaultPageSize");
    expect(body.data.etag).not.toBe(etag);
    etag = body.data.etag;
  });

  it("rejects a stale If-Match with CONFIG_CONFLICT at 409", async () => {
    const response = await authed("/api/v1/config", {
      method: "PUT",
      bearer: apiToken,
      extra: { "if-match": "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      body: { key: "ui.defaultPageSize", value: "30" },
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "CONFIG_CONFLICT" } });
  });

  it("rejects a write without If-Match and one with an unknown key", async () => {
    const missing = await authed("/api/v1/config", {
      method: "PUT",
      bearer: apiToken,
      body: { key: "ui.defaultPageSize", value: "30" },
    });
    expect(missing.status).toBe(422);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: "CONFIG_INVALID" } });

    const unknown = await authed("/api/v1/config", {
      method: "PUT",
      bearer: apiToken,
      extra: { "if-match": etag },
      body: { key: "not.a.key", value: "1" },
    });
    expect(unknown.status).toBe(422);
  });
});

describe("the runtime endpoints (RUN-008)", () => {
  it("reports the restart a port change requires and applies reloads", async () => {
    const changed = await authed("/api/v1/config", {
      method: "PUT",
      bearer: apiToken,
      extra: { "if-match": etag },
      body: { key: "server.port", value: String(port + 1) },
    });
    expect(changed.status).toBe(200);
    etag = JSON.parse(changed.body).data.etag;

    const status = await authed("/api/v1/runtime/status", { bearer: apiToken });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ data: { restartRequired: ["server.port"] } });

    const reload = await authed("/api/v1/runtime/reload", { method: "POST", bearer: apiToken });
    expect(reload.status).toBe(200);
    const body = JSON.parse(reload.body);
    expect(body.data.restartRequired).toContain("server.port");
    expect(body.data.applied.length).toBeGreaterThan(0);
  });
});

describe("the static settings shell (SEC-018, SEC-019)", () => {
  it("serves the root refusal, the settings page, and the external script with the security headers", async () => {
    for (const path of ["/", "/settings", "/assets/settings.js"]) {
      const response = await authed(path);
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
    const root = await authed("/");
    expect(root.body).toContain("sorage web");
    const settings = await authed("/settings");
    expect(settings.body).not.toContain("<script>"); // the CSP allows only external scripts
    expect(settings.body).toContain("Canonical configuration");
    expect(settings.body).toContain('script src="/assets/settings.js"');
  });
});
