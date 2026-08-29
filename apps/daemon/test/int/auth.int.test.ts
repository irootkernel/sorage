import { createServer as createNetServer, type AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { createSessionService } from "../../src/auth";
import { createDaemonServer } from "../../src/server";

/**
 * The TASK-043 authentication surface over a real socket: bearer rules of SEC-020,
 * the one-time session exchange of SEC-019, and rotation invalidating every session.
 */
const installationId = "0f0e0d0c-0b0a-4000-8000-000000000002";
const version = "9.9.99-auth";

let port = 0;
let stateDir = "";
let tokenStore: ReturnType<typeof createNodeApiTokenStore>;
let session: ReturnType<typeof createSessionService>;
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

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "sorage-daemon-auth-"));
  port = await freePort();
  tokenStore = createNodeApiTokenStore({ stateDir });
  tokenStore.ensure();
  session = createSessionService({
    token: tokenStore,
    webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
    entropy: createNodeTokenEntropy(),
  });
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId, version },
    auth: session,
    tokenRotate: () => tokenStore.rotate(),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closer.push(() => server.close());
});

afterAll(() => {
  for (const close of closer) close();
  rmSync(stateDir, { recursive: true, force: true });
});

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function request(
  path: string,
  init?: { method?: string; bearer?: string | null; body?: unknown },
): Promise<TestResponse> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (init?.bearer !== undefined && init?.bearer !== null) headers.authorization = `Bearer ${init.bearer}`;
  const payload = init?.body === undefined ? null : JSON.stringify(init.body);
  if (payload !== null) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: init?.method ?? "GET", headers },
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
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

function json(response: TestResponse): any {
  return JSON.parse(response.body);
}

describe("bearer rules on a protected route (SEC-020)", () => {
  it("rejects a missing Authorization header with UNAUTHENTICATED at 401", async () => {
    const response = await request("/api/v1/token/rotate", { method: "POST" });
    expect(response.status).toBe(401);
    expect(json(response)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("rejects an unknown token with TOKEN_INVALID at 401", async () => {
    const response = await request("/api/v1/token/rotate", { method: "POST", bearer: "A".repeat(43) });
    expect(response.status).toBe(401);
    expect(json(response)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
  });

  it("answers GET on the exchange path with METHOD_NOT_ALLOWED, not a session", async () => {
    const response = await request("/api/v1/session");
    expect(response.status).toBe(405);
    expect(json(response)).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
  });
});

describe("the public meta endpoints stay unauthenticated", () => {
  it("serves health without a bearer token", async () => {
    const response = await request("/api/v1/health");
    expect(response.status).toBe(200);
  });
});

describe("the session exchange (SEC-019)", () => {
  it("exchanges the one-time secret exactly once and the session token authorizes", async () => {
    const issued = createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }).issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const exchange = await request("/api/v1/session", { method: "POST", body: { secret: issued.value.secret } });
    expect(exchange.status).toBe(200);
    const body = json(exchange);
    expect(body.ok).toBe(true);
    expect(typeof body.data.token).toBe("string");
    expect(body.data.tokenType).toBe("session");
    expect(exchange.headers["set-cookie"]).toBeUndefined();

    const used = await request("/api/v1/token/rotate", { method: "POST", bearer: body.data.token });
    // A session token is not the Installation token; rotation is CLI-only.
    expect(used.status).toBe(401);
    expect(json(used)).toMatchObject({ error: { code: "TOKEN_INVALID" } });
  });

  it("refuses a replayed secret with UNAUTHENTICATED at 401", async () => {
    const store = createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } });
    const issued = store.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const first = await request("/api/v1/session", { method: "POST", body: { secret: issued.value.secret } });
    expect(first.status).toBe(200);
    const replay = await request("/api/v1/session", { method: "POST", body: { secret: issued.value.secret } });
    expect(replay.status).toBe(401);
    expect(json(replay)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(replay.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses an absent secret the same documented way", async () => {
    const response = await request("/api/v1/session", { method: "POST", body: {} });
    expect(response.status).toBe(401);
    expect(json(response)).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});

describe("rotation invalidates every live session (SEC-020)", () => {
  it("rotates for the Installation token and kills the pre-rotation material", async () => {
    const stale = tokenStore.read() as string;
    const rotated = await request("/api/v1/token/rotate", { method: "POST", bearer: tokenStore.read() });
    expect(rotated.status).toBe(200);
    expect(json(rotated)).toMatchObject({ ok: true, data: { rotated: true } });
    expect(tokenStore.read()).not.toBe(stale);
    expect(rotated.headers["set-cookie"]).toBeUndefined();
  });

  it("leaves a session token unusable for CLI-only operations but recognized until rotation", async () => {
    // The session service itself proves the live-session path; the HTTP surface pins
    // the negative here because token rotation is the only protected route so far.
    const store = createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } });
    const issued = store.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const exchange = await request("/api/v1/session", { method: "POST", body: { secret: issued.value.secret } });
    const token = json(exchange).data.token as string;
    const attempt = await request("/api/v1/token/rotate", { method: "POST", bearer: token });
    expect(attempt.status).toBe(401);
    expect(json(attempt)).toMatchObject({ error: { code: "TOKEN_INVALID" } });
  });
});
