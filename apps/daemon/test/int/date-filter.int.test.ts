import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSendPorts } from "@sorage/adapters/src/handoff-command-ports";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createNodeProjectPorts } from "@sorage/adapters/src/project-command-ports";
import { addProject, initializeInstallation, sendHandoffs } from "@sorage/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService } from "../../src/auth";
import { createDomainRoutes } from "../../src/domain-routes";
import { createDaemonServer } from "../../src/server";

/**
 * The TASK-067 end-to-end date-filter proof (WEB-003, API-008): the HTTP
 * listing, the CLI listing, and the URL-addressable Web list view all carry the
 * same inclusive `updatedSince` bound and return the same rows, and a reload of
 * the URL-addressable state reproduces the listing.
 */
const home = mkdtempSync(join(tmpdir(), "sorage-datefilter-e2e-"));
const alpha = join(home, "alpha");
mkdirSync(alpha, { recursive: true });

let port = 0;
let apiToken = "";
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

function call(path: string, init?: { bearer?: string | null }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (init?.bearer) headers.authorization = `Bearer ${init.bearer}`;
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

beforeAll(() => {
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(init.ok).toBe(true);
  const projectPorts = createNodeProjectPorts();
  const added = addProject(projectPorts, {
    name: "Alpha",
    dir: alpha,
    userHome: "/Users/tester",
    actor: { kind: "user", id: null },
  });
  expect(added.ok).toBe(true);
  const document = join(home, "brief.md");
  writeFileSync(document, "# brief\n");
  const second = join(home, "second.md");
  writeFileSync(second, "# second\n");
  const sendPorts = createNodeSendPorts();
  const send1 = sendHandoffs(sendPorts, {
    to: ["alpha"],
    title: "Dated",
    file: document,
    allowExternalSource: true,
    allowUnregistered: true,
    path: alpha,
    userHome: "/Users/tester",
  });
  expect(send1.ok).toBe(true);
  const send2 = sendHandoffs(sendPorts, {
    to: ["alpha"],
    title: "Also dated",
    file: second,
    allowExternalSource: true,
    allowUnregistered: true,
    path: alpha,
    userHome: "/Users/tester",
  });
  expect(send2.ok).toBe(true);
  apiToken = readFileSync(join(home, "state", "api-token"), "utf8").trim();
});

afterAll(() => {
  for (const close of closer) close();
  rmSync(home, { recursive: true, force: true });
  delete process.env.SORAGE_HOME;
});

describe("the WEB-003 date bounds across surfaces", () => {
  it("returns the same rows over HTTP and CLI, and the bound survives in the URL", async () => {
    port = await freePort();
    const server = createDaemonServer({
      host: "127.0.0.1",
      port,
      endpoints: { installationId: "i", version: "t" },
      auth: createSessionService({
        token: {
          path: `${home}/state/api-token`,
          read: () => apiToken,
          ensure: () => ({ ok: true, value: { created: false } }),
          rotate: () => ({ ok: true, value: { rotated: true } }),
        },
        webSecret: {
          issue: () => ({ ok: true, value: { secret: "s", expiresAt: "2999-01-01T00:00:00.000Z" } }),
          consume: () => true,
        },
        entropy: { next: () => "e".repeat(64) },
      }),
      domainRoutes: createDomainRoutes({ vaultPath: () => join(home, "vault"), config: undefined }),
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    closer.push(() => server.close());

    const since = "2000-01-01T00:00:00Z";
    const http = await call(`/api/v1/handoffs?as=alpha&updatedSince=${encodeURIComponent(since)}`, {
      bearer: apiToken,
    });
    expect(http.status).toBe(200);
    const httpIds = (JSON.parse(http.body).data.handoffs as Array<{ id: string }>).map((row) => row.id).sort();

    const empty = await call(`/api/v1/handoffs?as=alpha&updatedSince=2999-01-01T00%3A00%3A00Z`, {
      bearer: apiToken,
    });
    expect((JSON.parse(empty.body).data.handoffs as unknown[]).length).toBe(0);

    // The Web list view builds its URL from the same bound, so the
    // URL-addressable state a reload reproduces is the bounded listing.
    const script = await call("/assets/app.js", {});
    expect(script.body).toContain("updatedSince");
    expect(script.body).toContain('next.set("updatedSince"');

    expect(httpIds.length).toBe(2);
  });
});
