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
function request(
  path: string,
  init?: { method?: string; host?: string; origin?: string; extra?: Record<string, string> },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init?.method ?? "GET",
        headers: {
          host: init?.host ?? `127.0.0.1:${port}`,
          ...(init?.origin !== undefined ? { origin: init.origin } : {}),
          ...(init?.extra ?? {}),
        },
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

function json(response: TestResponse) {
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
const _baseUrl = "";
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

describe("per-server in-flight keys", () => {
  it("guards after authentication, isolates scopes, and releases keys when dispatch throws", async () => {
    const testPort = await freePort();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let attempts = 0;
    const server = createDaemonServer({
      host: "127.0.0.1",
      port: testPort,
      endpoints: { installationId, version },
      auth: {
        exchange: () => ({ ok: true, context: { kind: "session" }, token: "unused" }),
        authenticate: (token) => ({ ok: true, context: { kind: token === "cli" ? "api-token" : "session" } }),
      },
      domainRoutes: [
        {
          method: "POST",
          pattern: "/api/v1/import",
          cliTokenOnly: true,
          idempotencyScope: "send",
          handler: async (_request, response) => {
            if (++attempts === 1) {
              started.resolve();
              await finish.promise;
              throw new Error("injected failure");
            }
            response.statusCode = 201;
            response.end();
          },
        },
        {
          method: "POST",
          pattern: "/api/v1/backup",
          idempotencyScope: "backup-run",
          handler: (_request, response) => {
            response.statusCode = 204;
            response.end();
          },
        },
      ],
    });
    await new Promise<void>((resolve) => server.listen(testPort, "127.0.0.1", resolve));
    cleanup.push(() => server.close());
    const url = `http://127.0.0.1:${testPort}/api/v1`;
    const key = "in-flight";
    const keyHeaders = { "idempotency-key": key };
    const headers = { authorization: "Bearer cli", ...keyHeaders };
    const first = fetch(`${url}/import`, { method: "POST", headers });
    try {
      await started.promise;
      const unauthorized = await fetch(`${url}/import`, { method: "POST", headers: keyHeaders });
      expect(unauthorized.status).toBe(401);
      const session = await fetch(`${url}/import`, {
        method: "POST",
        headers: { authorization: "Bearer browser", ...keyHeaders },
      });
      expect(session.status).toBe(403);
      expect(await session.json()).toMatchObject({ error: { code: "FORBIDDEN_ACTOR" } });
      const duplicate = await fetch(`${url}/import`, { method: "POST", headers });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      expect((await fetch(`${url}/backup`, { method: "POST", headers })).status).toBe(204);
      expect(attempts).toBe(1);
    } finally {
      finish.resolve();
    }
    expect((await first).status).toBe(500);
    expect((await fetch(`${url}/import`, { method: "POST", headers })).status).toBe(201);
    expect(attempts).toBe(2);
  });

  it("releases a reservation when a partially streamed request disconnects", async () => {
    const testPort = await freePort();
    const received = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const server = createDaemonServer({
      host: "127.0.0.1",
      port: testPort,
      endpoints: { installationId, version },
      auth: {
        exchange: () => ({ ok: true, context: { kind: "session" }, token: "unused" }),
        authenticate: () => ({ ok: true, context: { kind: "api-token" } }),
      },
      domainRoutes: [
        {
          method: "POST",
          pattern: "/api/v1/upload",
          idempotencyScope: "send",
          handler: async (request, response) => {
            try {
              for await (const _chunk of request) received.resolve();
              response.statusCode = 201;
              response.end();
            } finally {
              released.resolve();
            }
          },
        },
      ],
    });
    await new Promise<void>((resolve) => server.listen(testPort, "127.0.0.1", resolve));
    cleanup.push(() => server.close());
    const headers = { authorization: "Bearer cli", "idempotency-key": "interrupted-upload" };
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: testPort,
      path: "/api/v1/upload",
      method: "POST",
      headers: { ...headers, "content-length": "16" },
      agent: false,
    });
    outgoing.on("error", () => undefined);
    try {
      outgoing.write("partial");
      await received.promise;
    } finally {
      outgoing.destroy();
    }
    await released.promise;
    const retry = await fetch(`http://127.0.0.1:${testPort}/api/v1/upload`, {
      method: "POST",
      headers,
      body: "complete",
    });
    expect(retry.status).toBe(201);
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
  it("renders an unknown route without credentials as a 401 UNAUTHENTICATED envelope", async () => {
    // Authentication precedes routing (section 17.2), so an unauthenticated probe
    // learns nothing about which routes exist; the 404 needs a valid bearer token.
    const response = await request("/api/v1/does-not-exist");
    expect(response.status).toBe(401);
    const body = json(response);
    expect(body).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
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

describe("the cross-origin posture (SEC row 8: no CORS allowance, no ambient credential)", () => {
  // A browser page from another origin must not be able to read anything: the
  // server grants no CORS allowance, so a fetch from it fails the preflight and
  // carries no ambient credential, because nothing ever sets a cookie.
  const responses: Array<{ name: string; run: () => Promise<TestResponse> }> = [
    {
      name: "preflight with a foreign Origin",
      run: () =>
        request("/api/v1/handoffs", {
          method: "OPTIONS",
          origin: "https://evil.example",
          extra: { "access-control-request-method": "GET" },
        }),
    },
    { name: "GET with a foreign Origin", run: () => request("/api/v1/health", { origin: "https://evil.example" }) },
    {
      name: "rejected host with a foreign Origin",
      run: () => request("/api/v1/health", { host: `evil.example:${port}`, origin: "https://evil.example" }),
    },
  ];

  for (const { name, run } of responses) {
    it(`grants no CORS allowance on the ${name} response`, async () => {
      const response = await run();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(response.headers["access-control-allow-headers"]).toBeUndefined();
      expect(response.headers["access-control-allow-methods"]).toBeUndefined();
      // There is no ambient credential to attach: no response ever sets a cookie.
      expect(response.headers["set-cookie"]).toBeUndefined();
    });
  }
});
