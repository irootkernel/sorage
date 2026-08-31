import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDaemonServer } from "../../src/server";

/**
 * The TASK-042 contract over the three skeleton endpoints: with a pinned request-id
 * generator, installation identity, and version, every endpoint's full response —
 * status, headers, and JSON body — is pinned byte-for-byte against a golden. Refresh
 * with SORAGE_UPDATE_GOLDENS=1 and review the diff.
 */
const REQUEST_ID = "2f0ac9a0-0000-4000-8000-0000000000dd";
const INSTALLATION_ID = "1a2b3c4d-0000-4000-8000-000000000042";
const VERSION = "0.3.0-contract";

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

let port = 0;
let closeServer: () => void = () => {};

beforeAll(async () => {
  port = await freePort();
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: INSTALLATION_ID, version: VERSION },
    idGenerator: { next: () => REQUEST_ID },
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closeServer = () => server.close();
});

afterAll(() => closeServer());

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Captures a response with an explicit `Host` header; the Fetch spec forbids callers
 * from setting `Host`, so the contract is exercised through the raw `node:http` client.
 */
function capture(path: string, init?: { method?: string; host?: string }): Promise<CapturedResponse> {
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
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (name === "date" || name === "connection") continue;
            headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
          }
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function parseBody(raw: string): unknown {
  return JSON.parse(raw, (_key, value: unknown) =>
    typeof value === "string" ? value.split(`:${port}`).join(":<port>") : value,
  );
}

describe("the skeleton endpoint contract", () => {
  const goldenPath = fileURLToPath(new URL("./golden/daemon-endpoints.json", import.meta.url));
  const updateGoldens = process.env.SORAGE_UPDATE_GOLDENS === "1";

  it("pins health, readiness, version, and the rejected Host response", async () => {
    const captured = {
      health: await capture("/api/v1/health"),
      readiness: await capture("/api/v1/readiness"),
      version: await capture("/api/v1/version"),
      rejectedHost: await capture("/api/v1/health", { host: `attacker.example:${port}` }),
      unknownRoute: await capture("/api/v1/nope"),
      wrongMethod: await capture("/api/v1/health", { method: "POST" }),
    };
    // The bodies are pinned as parsed JSON so key order in the serializer never matters.
    const normalized = Object.fromEntries(
      Object.entries(captured).map(([name, response]) => [name, { ...response, body: parseBody(response.body) }]),
    );
    const serialized = `${JSON.stringify({ port: "<ephemeral>", responses: normalized }, null, 2)}\n`;
    if (updateGoldens) {
      mkdirSync(fileURLToPath(new URL("./golden/", import.meta.url)), { recursive: true });
      writeFileSync(goldenPath, serialized);
      return;
    }
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });
});
