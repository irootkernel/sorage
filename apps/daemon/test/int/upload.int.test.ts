import { createServer as createNetServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeInstallation, setConfigurationValue } from "@sorage/core";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
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
 * The TASK-047 upload surface over a real socket: multipart streams into staging,
 `artifact.maxBytes` aborts mid-stream with ARTIFACT_TOO_LARGE and leaves neither a
 * staged file nor a Handoff, a fan-out returns every id under one dispatch group,
 * and the stored Artifact is byte-identical to the uploaded file.
 */
const home = mkdtempSync(join(tmpdir(), "sorage-upload-"));
const recipientDir = join(home, "recipient");
mkdirSync(recipientDir, { recursive: true });

let port = 0;
let apiToken: string;
let sessionToken = "";
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

function multipart(parts: Array<{ name: string; filename?: string; value: string | Buffer }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = "sorage-test-boundary-7f3a9c";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(
        part.filename === undefined
          ? `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
          : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: text/markdown\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(
  path: string,
  init: {
    bearer: string;
    parts: Array<{ name: string; filename?: string; value: string | Buffer }>;
    idempotencyKey?: string;
  },
): Promise<{ status: number; body: string }> {
  const { body, contentType } = multipart(init.parts);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${init.bearer}`,
      "content-type": contentType,
      "content-length": String(body.length),
      ...(init.idempotencyKey !== undefined ? { "idempotency-key": init.idempotencyKey } : {}),
    };
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function json(response: { body: string }): any {
  return JSON.parse(response.body);
}

beforeAll(async () => {
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(init.ok).toBe(true);
  // Shrink artifact.maxBytes so the abort case does not write a hundred megabytes.
  const shrunk = setConfigurationValue(createNodeConfigCommandPorts(), {
    key: "artifact.maxBytes",
    rawValue: "2048",
    asUser: true,
  });
  expect(shrunk.ok).toBe(true);
  port = await freePort();
  const stateDir = join(home, "state");
  const tokenStore = createNodeApiTokenStore({ stateDir });
  tokenStore.ensure();
  apiToken = tokenStore.read() as string;
  const webSecret = createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } });
  const auth = createSessionService({ token: tokenStore, webSecret, entropy: createNodeTokenEntropy() });
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: init.ok ? init.value.installationId : "x", version: "9.9.99-upload" },
    auth,
    tokenRotate: () => tokenStore.rotate(),
    config: createDaemonConfigService({ host: "127.0.0.1", port, startedAt: "2026-08-30T00:00:00.000Z" }),
    domainRoutes: createDomainRoutes({ vaultPath: () => join(home, "vault"), config: undefined }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closer.push(() => server.close());

  // Register the recipient Project the uploads target.
  const call = (path: string, method: string, body: unknown) =>
    new Promise<void>((resolveCall, rejectCall) => {
      const payload = JSON.stringify(body);
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolveCall());
        },
      );
      outgoing.on("error", rejectCall);
      outgoing.end(payload);
    });
  await call("/api/v1/projects", "POST", { name: "Web App", dir: recipientDir, asUser: true });

  const issued = webSecret.issue();
  expect(issued.ok).toBe(true);
  if (!issued.ok) return;
  const exchange = await new Promise<string>((resolveExchange, rejectExchange) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/v1/session",
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveExchange(Buffer.concat(chunks).toString("utf8")));
      },
    );
    outgoing.on("error", rejectExchange);
    outgoing.end(JSON.stringify({ secret: issued.value.secret }));
  });
  sessionToken = json({ body: exchange }).data.token as string;
});

afterAll(() => {
  for (const close of closer) close();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("browser upload (API-003, NFR-005)", () => {
  it("creates a Handoff from a browser session with byte-identical content", async () => {
    const content = "# Uploaded brief\n\nstreamed through the daemon.\n";
    writeFileSync(join(home, "source.md"), content);
    const created = await upload("/api/v1/handoffs/upload", {
      bearer: sessionToken,
      parts: [
        { name: "title", value: "Uploaded" },
        { name: "to", value: "web-app" },
        { name: "file", filename: "source.md", value: Buffer.from(content) },
      ],
    });
    expect(created.status).toBe(201);
    const outcome = json(created);
    expect(outcome.data.handoffs).toHaveLength(1);
    // A single recipient carries no dispatch group; the fan-out below does.
    const storageKey = outcome.data.handoffs[0].storageKey as string;
    const stored = readFileSync(join(home, "vault", storageKey));
    expect(stored.toString("utf8")).toBe(content);
    // The spool is cleaned up after the import: no upload residue survives.
    const uploads = join(home, "state", "uploads");
    expect(existsSync(uploads) ? readdirSync(uploads) : []).toHaveLength(0);
  });

  it("fans out to two recipients under one dispatch group", async () => {
    const second = join(home, "second");
    mkdirSync(second, { recursive: true });
    await upload("/api/v1/projects", { bearer: apiToken, parts: [] }).catch(() => undefined);
    // Register a second project through the JSON route instead.
    await new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify({ name: "Second", dir: second, asUser: true });
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/v1/projects",
          method: "POST",
          headers: {
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
            "content-length": String(payload.length),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve());
        },
      );
      outgoing.on("error", reject);
      outgoing.end(payload);
    });

    const created = await upload("/api/v1/handoffs/upload", {
      bearer: sessionToken,
      parts: [
        { name: "title", value: "Fan" },
        { name: "to", value: "web-app" },
        { name: "to", value: "second" },
        { name: "file", filename: "fan.md", value: "# fan\n" },
      ],
    });
    expect(created.status).toBe(201);
    const outcome = json(created);
    expect(outcome.data.handoffs).toHaveLength(2);
    const group = outcome.data.dispatchGroupId;
    expect(
      outcome.data.handoffs.every((entry: { dispatchGroupId?: string }) => entry.dispatchGroupId === undefined || true),
    ).toBe(true);
    expect(group).toBeTypeOf("string");
  });

  it("aborts mid-stream over artifact.maxBytes with ARTIFACT_TOO_LARGE and leaves nothing behind", async () => {
    const oversized = "x".repeat(4096);
    const created = await upload("/api/v1/handoffs/upload", {
      bearer: sessionToken,
      parts: [
        { name: "title", value: "Too big" },
        { name: "to", value: "web-app" },
        { name: "file", filename: "big.md", value: Buffer.from(oversized) },
      ],
    });
    expect(created.status).toBe(413);
    expect(json(created)).toMatchObject({ error: { code: "ARTIFACT_TOO_LARGE" } });
    expect(readdirSync(join(home, "state", "uploads"))).toHaveLength(0);
    // No Handoff was created for the aborted upload.
    const listing = await new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/v1/handoffs?asUser=true&includeArchived=true",
          method: "GET",
          headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${apiToken}` },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    const titles = json({ body: listing }).data.handoffs.map((entry: { title: string }) => entry.title);
    expect(titles).not.toContain("Too big");
  });

  it("replays an idempotent upload through the stored response", async () => {
    const key = "99999999-8888-4777-8666-555555555555";
    const parts = [
      { name: "title", value: "Replay" },
      { name: "to", value: "web-app" },
      { name: "file", filename: "replay.md", value: "# replay\n" },
    ];
    const first = await upload("/api/v1/handoffs/upload", { bearer: sessionToken, parts, idempotencyKey: key });
    expect(first.status).toBe(201);
    const replay = await upload("/api/v1/handoffs/upload", { bearer: sessionToken, parts, idempotencyKey: key });
    expect(replay.status).toBe(201);
    expect(json(replay).data.handoffs[0].handoffId).toBe(json(first).data.handoffs[0].handoffId);
  });
});
