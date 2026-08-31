import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiTokenStorePort, WebSecretPort } from "@sorage/core";
import { createSessionService } from "../../src/auth";
import { createDaemonServer } from "../../src/server";

/**
 * The TASK-043 contract over the authentication surface: with pinned request ids,
 * tokens, and secrets, the UNAUTHENTICATED and TOKEN_INVALID rejections, the one-time
 * session exchange with its replay refusal, and the CLI-only rotation are pinned
 * byte-for-byte against a golden. Refresh with SORAGE_UPDATE_GOLDENS=1.
 */
const REQUEST_ID = "2f0ac9a0-0000-4000-8000-0000000000ee";
const API_TOKEN = "T".repeat(48);
const SESSION_TOKEN = "K".repeat(48);
const ONE_TIME_SECRET = "R".repeat(48);

let port = 0;
let closeServer: () => void = () => {};
let pendingSecret: string | null = ONE_TIME_SECRET;

beforeAll(async () => {
  port = await freePort();
  const token: ApiTokenStorePort = {
    path: "<state>/api-token",
    read: () => API_TOKEN,
    ensure: () => ({ ok: true as const, value: { created: false } }),
    rotate: () => ({ ok: true as const, value: { rotated: true as const } }),
  };
  const webSecret: WebSecretPort = {
    issue: () => ({ ok: true as const, value: { secret: ONE_TIME_SECRET, expiresAt: "2026-08-30T00:05:00.000Z" } }),
    consume: (candidate: string) => {
      const matches = pendingSecret !== null && candidate === pendingSecret;
      pendingSecret = null;
      return matches;
    },
  };
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: "1a2b3c4d-0000-4000-8000-000000000043", version: "0.3.0-contract" },
    idGenerator: { next: () => REQUEST_ID },
    auth: createSessionService({ token, webSecret, entropy: { next: () => SESSION_TOKEN } }),
    tokenRotate: () => token.rotate(),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closeServer = () => server.close();
});

afterAll(() => closeServer());

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

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function capture(path: string, init?: { method?: string; bearer?: string; body?: unknown }): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (init?.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
    const payload = init?.body === undefined ? null : JSON.stringify(init.body);
    if (payload !== null) headers["content-type"] = "application/json";
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: init?.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (name === "date" || name === "connection") continue;
            flat[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: flat,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

describe("the authentication contract", () => {
  it("pins the bearer rejections, the session exchange, and rotation", async () => {
    const exchange = await capture("/api/v1/session", { method: "POST", body: { secret: ONE_TIME_SECRET } });
    const captured = {
      unauthenticated: await capture("/api/v1/token/rotate", { method: "POST" }),
      tokenInvalid: await capture("/api/v1/token/rotate", { method: "POST", bearer: "A".repeat(48) }),
      sessionExchange: exchange,
      sessionReplay: await capture("/api/v1/session", { method: "POST", body: { secret: ONE_TIME_SECRET } }),
      sessionOnCliOnlyRoute: await capture("/api/v1/token/rotate", { method: "POST", bearer: SESSION_TOKEN }),
      rotateWithApiToken: await capture("/api/v1/token/rotate", { method: "POST", bearer: API_TOKEN }),
      healthWithoutBearer: await capture("/api/v1/health"),
    };
    for (const response of Object.values(captured)) {
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const serialized = `${JSON.stringify({ port: "<ephemeral>", responses: captured }, null, 2)}\n`;
    const goldenPath = fileURLToPath(new URL("./golden/daemon-auth.json", import.meta.url));
    if (process.env.SORAGE_UPDATE_GOLDENS === "1") {
      mkdirSync(fileURLToPath(new URL("./golden/", import.meta.url)), { recursive: true });
      writeFileSync(goldenPath, serialized);
      return;
    }
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });
});
