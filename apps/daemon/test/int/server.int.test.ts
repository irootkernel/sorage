import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDaemonServer } from "../../src/server";

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Sends a request with an explicit `Host` header; the Fetch spec forbids callers from
 * setting `Host`, so the allowlist is exercised through the raw `node:http` client.
 */
function request(path: string, init?: { method?: string; host?: string }): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init?.method ?? "GET",
        headers: { host: init?.host ?? `127.0.0.1:${port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function json(response: TestResponse): any {
  return JSON.parse(response.body);
}

/** Reserves an ephemeral loopback port so the daemon's Host allowlist can pin it. */
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

const installationId = "0f0e0d0c-0b0a-4000-8000-000000000001";
const version = "9.9.99-test";

let port = 0;
const baseUrl = "";
const cleanup: Array<() => void> = [];

beforeAll(async () => {
  port = await freePort();
  const server = createDaemonServer({ host: "127.0.0.1", port, endpoints: { installationId, version } });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
});

afterAll(() => {
  for (const close of cleanup) close();
});

describe("the daemon endpoints over a real socket", () => {
  it("serves health with the installationId and build version", async () => {
    const response = await request("/api/v1/health");
    expect(response.status).toBe(200);
    const body = json(response);
    expect(body).toEqual({
      ok: true,
      data: { installationId, version },
      meta: { requestId: body.meta.requestId },
    });
    expect(body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["x-request-id"]).toBe(body.meta.requestId);
  });

  it("serves readiness as ready by default", async () => {
    const response = await request("/api/v1/readiness");
    expect(response.status).toBe(200);
    expect(json(response)).toMatchObject({ ok: true, data: { ready: true } });
  });

  it("reports not-ready readiness with 503", async () => {
    const notReadyPort = await freePort();
    const server = createDaemonServer({
      host: "127.0.0.1",
      port: notReadyPort,
      endpoints: { installationId, version },
      readiness: () => ({ ready: false }),
    });
    await new Promise<void>((resolve) => server.listen(notReadyPort, "127.0.0.1", resolve));
    cleanup.push(() => server.close());
    const response = await fetch(`http://127.0.0.1:${notReadyPort}/api/v1/readiness`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: true, data: { ready: false } });
  });

  it("serves the daemon version", async () => {
    const response = await request("/api/v1/version");
    expect(response.status).toBe(200);
    expect(json(response)).toMatchObject({
      ok: true,
      data: { daemon: "sorage-daemon", version },
    });
  });
});

describe("the security headers on every response (SEC-018)", () => {
  const cases: Array<{ name: string; path: string; init?: { method?: string; host?: string } }> = [
    { name: "health", path: "/api/v1/health" },
    { name: "rejected host", path: "/api/v1/health", init: { host: `attacker.example:${port}` } },
    { name: "unknown route", path: "/api/v1/nope" },
    { name: "wrong method", path: "/api/v1/health", init: { method: "POST" } },
  ];

  for (const { name, path, init } of cases) {
    it(`carries them on the ${name} response`, async () => {
      const response = await request(path, init);
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    });
  }
});

describe("the Host allowlist before routing (SEC-017)", () => {
  it("rejects a foreign Host with 421 and a HOST_NOT_ALLOWED body", async () => {
    const response = await request("/api/v1/health", { host: `attacker.example:${port}` });
    expect(response.status).toBe(421);
    const body = json(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("HOST_NOT_ALLOWED");
    expect(body.error.recovery).toBeDefined();
  });

  it("rejects even when the path does not exist, proving the check precedes routing", async () => {
    const response = await request("/api/v1/nope", { host: `127.0.0.1:${port + 1}` });
    expect(response.status).toBe(421);
    expect(json(response)).toMatchObject({ error: { code: "HOST_NOT_ALLOWED" } });
  });

  it("accepts localhost and the bracketed IPv6 literal on the configured port", async () => {
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      const response = await request("/api/v1/health", { host });
      expect(response.status).toBe(200);
    }
  });
});

describe("the error middleware (API-006)", () => {
  it("renders an unknown route as a 404 NOT_FOUND envelope", async () => {
    const response = await request("/api/v1/does-not-exist");
    expect(response.status).toBe(404);
    const body = json(response);
    expect(body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(body.error.message).toContain("/api/v1/does-not-exist");
    expect(typeof body.meta.requestId).toBe("string");
  });

  it("renders an unsupported method as 405 with the symbolic code and an Allow header", async () => {
    const response = await request("/api/v1/health", { method: "POST" });
    expect(response.status).toBe(405);
    expect(json(response)).toMatchObject({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
    expect(response.headers.allow).toBe("GET");
  });

  it("ignores a query string when routing", async () => {
    const response = await request("/api/v1/health?probe=1");
    expect(response.status).toBe(200);
  });
});
