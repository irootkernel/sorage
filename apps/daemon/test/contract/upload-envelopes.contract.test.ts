import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
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
 * TASK-084 upload contract: file-success, body-success, and input-error envelopes.
 * Additive non-breaking. Refresh with SORAGE_UPDATE_GOLDENS=1.
 */
const home = mkdtempSync(join(tmpdir(), "sorage-upload-contract-"));
const recipientDir = join(home, "recipient");
mkdirSync(recipientDir, { recursive: true });

let port = 0;
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

function multipart(parts: Array<{ name: string; filename?: string; value: string }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = "sorage-contract-boundary";
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
    chunks.push(Buffer.from(part.value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function post(
  parts: Array<{ name: string; filename?: string; value: string }>,
): Promise<{ status: number; body: unknown }> {
  const { body, contentType } = multipart(parts);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/v1/handoffs/upload",
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${sessionToken}`,
          "content-type": contentType,
          "content-length": String(body.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHA = /[0-9a-f]{64}/gi;

function redact(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(UUID, "<uuid>").replace(SHA, "<sha256>"));
}

beforeAll(async () => {
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(init.ok).toBe(true);
  expect(
    setConfigurationValue(createNodeConfigCommandPorts(), {
      key: "artifact.maxBytes",
      rawValue: "2048",
      asUser: true,
    }).ok,
  ).toBe(true);
  port = await freePort();
  const stateDir = join(home, "state");
  const tokenStore = createNodeApiTokenStore({ stateDir });
  tokenStore.ensure();
  const webSecret = createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } });
  const auth = createSessionService({
    token: tokenStore,
    webSecret,
    entropy: createNodeTokenEntropy(),
  });
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: init.ok ? init.value.installationId : "x", version: "9.9.99-upload-contract" },
    auth,
    tokenRotate: () => tokenStore.rotate(),
    config: createDaemonConfigService({ host: "127.0.0.1", port, startedAt: "2026-08-30T00:00:00.000Z" }),
    domainRoutes: createDomainRoutes({ vaultPath: () => join(home, "vault"), config: undefined }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closer.push(() => server.close());
  await new Promise<void>((resolve, reject) => {
    const payload = JSON.stringify({ name: "Web App", dir: recipientDir, asUser: true });
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/v1/projects",
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${tokenStore.read() as string}`,
          "content-type": "application/json",
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
  const issued = webSecret.issue();
  expect(issued.ok).toBe(true);
  if (!issued.ok) return;
  const exchange = await new Promise<string>((resolve, reject) => {
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
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ secret: issued.value.secret }));
  });
  sessionToken = (JSON.parse(exchange) as { data: { token: string } }).data.token;
});

afterAll(() => {
  for (const close of closer) close();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("upload envelopes (API-013)", () => {
  const goldenPath = fileURLToPath(new URL("./golden/upload-envelopes.json", import.meta.url));

  it("pins file-success, body-success, and input-error envelopes as additive non-breaking", async () => {
    const captured = {
      fileSuccess: await post([
        { name: "title", value: "Uploaded" },
        { name: "to", value: "web-app" },
        { name: "file", filename: "source.md", value: "# file\n" },
      ]),
      bodySuccess: await post([
        { name: "title", value: "Compose Body" },
        { name: "to", value: "web-app" },
        { name: "body", value: "# body\n" },
      ]),
      inputError: await post([
        { name: "title", value: "Both" },
        { name: "to", value: "web-app" },
        { name: "file", filename: "both.md", value: "# file\n" },
        { name: "body", value: "# body\n" },
      ]),
    };
    expect(captured.fileSuccess.status).toBe(201);
    expect(captured.bodySuccess.status).toBe(201);
    expect(captured.inputError.status).toBe(422);
    const serialized = `${JSON.stringify(redact(captured), null, 2)}\n`;
    if (process.env.SORAGE_UPDATE_GOLDENS === "1") {
      mkdirSync(fileURLToPath(new URL("./golden/", import.meta.url)), { recursive: true });
      writeFileSync(goldenPath, serialized);
      return;
    }
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });
});
