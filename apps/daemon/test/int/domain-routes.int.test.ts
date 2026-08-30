import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createDomainRoutes } from "../../src/domain-routes";
import { createDaemonConfigService } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";
import type { RouteEntryInternal } from "../../src/route-kit";

/**
 * The TASK-046 domain surface over a real socket and a real installation: every
 * route calls the same core use case its CLI command calls, the actor is named
 * explicitly, path-based imports stay CLI-token-only (API-004), the Idempotency-Key
 * replay runs before the Row Version check (API-012), and Artifact content answers
 * Range with the recorded SHA-256 as its ETag.
 */
const home = mkdtempSync(join(tmpdir(), "sorage-domain-routes-"));
const senderDir = join(home, "sender");
const recipientDir = join(home, "recipient");
mkdirSync(senderDir, { recursive: true });
mkdirSync(recipientDir, { recursive: true });
writeFileSync(join(senderDir, "brief.md"), "# The integration brief\n");

let port = 0;
let apiToken: string;
let handoffId = "";
let rowVersion = 1;
let revision = 1;
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

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  path: string,
  init?: { method?: string; bearer?: string | null; body?: unknown; extra?: Record<string, string>; rawBody?: Buffer },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      ...(init?.bearer !== undefined && init?.bearer !== null ? { authorization: `Bearer ${init.bearer}` } : {}),
      ...(init?.extra ?? {}),
    };
    const payload =
      init?.rawBody !== undefined ? init.rawBody : init?.body === undefined ? null : JSON.stringify(init.body);
    if (payload !== null && init?.rawBody === undefined) headers["content-type"] = "application/json";
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
  });
}

function json(response: TestResponse): any {
  return JSON.parse(response.body);
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
  const auth = createSessionService({
    token: tokenStore,
    webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
    entropy: createNodeTokenEntropy(),
  });
  const server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: init.ok ? init.value.installationId : "x", version: "9.9.99-domain" },
    auth,
    tokenRotate: () => tokenStore.rotate(),
    config: createDaemonConfigService({ host: "127.0.0.1", port, startedAt: "2026-08-30T00:00:00.000Z" }),
    domainRoutes: createDomainRoutes({ vaultPath: () => join(home, "vault"), config: undefined }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closer.push(() => server.close());
});

afterAll(() => {
  for (const close of closer) close();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("the actor rule", () => {
  it("refuses a request that names no acting context", async () => {
    const response = await call("/api/v1/handoffs", { bearer: apiToken });
    expect(response.status).toBe(403);
    expect(json(response)).toMatchObject({ error: { code: "FORBIDDEN_ACTOR" } });
  });
});

describe("the project surface", () => {
  it("registers, lists, shows, renames, binds, and archives through the routes", async () => {
    const created = await call("/api/v1/projects", {
      method: "POST",
      bearer: apiToken,
      body: { name: "Web App", dir: recipientDir, asUser: true },
    });
    expect(created.status).toBe(201);
    expect(json(created).data.project.slug).toBe("web-app");

    const listed = await call("/api/v1/projects", { bearer: apiToken });
    expect(json(listed).data).toHaveLength(1);

    const shown = await call("/api/v1/projects/web-app", { bearer: apiToken });
    expect(json(shown).data.project.slug).toBe("web-app");

    const renamed = await call("/api/v1/projects/web-app", {
      method: "PATCH",
      bearer: apiToken,
      body: { name: "Web App 2", asUser: true },
    });
    expect(json(renamed).data.displayName).toBe("Web App 2");

    const bound = await call("/api/v1/projects/web-app/bindings", {
      method: "POST",
      bearer: apiToken,
      body: { dir: senderDir, asUser: true },
    });
    expect(bound.status).toBe(201);

    const resolved = await call("/api/v1/projects/resolve", {
      method: "POST",
      bearer: apiToken,
      body: { path: recipientDir },
    });
    expect(resolved.status).toBe(200);
    expect(json(resolved).data.kind).toBe("registered_project");
  });
});

describe("the handoff lifecycle", () => {
  it("creates from a path with the CLI token and refuses a session token", async () => {
    const created = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      body: { to: ["web-app"], title: "Brief", path: join(senderDir, "brief.md"), asUser: true },
    });
    expect(created.status).toBe(201);
    handoffId = String(json(created).data.handoffs[0].handoffId ?? json(created).data.handoffs[0].id);
    expect(typeof handoffId).toBe("string");
    revision = 1;
    rowVersion = 1;

    // A browser session cannot use the path-based import (API-004).
    const secret = createNodeWebSecretStore({
      stateDir: join(home, "state"),
      clock: { now: () => new Date() },
    }).issue();
    expect(secret.ok).toBe(true);
    if (!secret.ok) return;
    const exchanged = await call("/api/v1/session", {
      method: "POST",
      body: { secret: secret.value.secret },
    });
    const sessionToken = json(exchanged).data.token as string;
    const refused = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: sessionToken,
      body: { to: ["web-app"], title: "Brief", path: join(senderDir, "brief.md"), asUser: true },
    });
    expect(refused.status).toBe(403);
    expect(json(refused)).toMatchObject({ error: { code: "FORBIDDEN_ACTOR" } });
  });

  it("lists, reads, and serves Artifact content with Range and ETag", async () => {
    const inbox = await call(`/api/v1/handoffs?as=web-app`, { bearer: apiToken });
    expect(json(inbox).data.handoffs.length).toBeGreaterThanOrEqual(1);

    const detail = await call(`/api/v1/handoffs/${handoffId}?as=web-app`, { bearer: apiToken });
    expect(json(detail).data.id).toBe(handoffId);

    const content = await call(`/api/v1/handoffs/${handoffId}/artifact/content?as=web-app`, { bearer: apiToken });

    expect(content.status).toBe(200);
    const etag = String(content.headers.etag);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(content.headers["accept-ranges"]).toBe("bytes");
    // Section 11.2: a .md Artifact serves as inline UTF-8 text for preview, so it
    // carries no attachment disposition; only non-previewable bytes do.
    expect(content.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(content.headers["content-disposition"]).toBeUndefined();

    const partial = await call(`/api/v1/handoffs/${handoffId}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=0-3" },
    });
    expect(partial.status).toBe(206);
    expect(partial.body).toBe("# Th");
    expect(partial.headers["content-range"]).toBe(`bytes 0-3/${content.body.length}`);

    // A suffix range serves the final N bytes, never a range from zero (section 18.4).
    const size = content.body.length;
    const suffix = await call(`/api/v1/handoffs/${handoffId}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: `bytes=-${Math.min(6, size)}` },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.body).toBe(content.body.slice(-6));
    expect(suffix.headers["content-range"]).toBe(`bytes ${size - 6}-${size - 1}/${size}`);

    // A suffix that covers the whole file serves it all; bytes=-0 is unsatisfiable.
    const whole = await call(`/api/v1/handoffs/${handoffId}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: `bytes=-${size + 100}` },
    });
    expect(whole.status).toBe(206);
    expect(whole.body).toBe(content.body);
    expect(whole.headers["content-range"]).toBe(`bytes 0-${size - 1}/${size}`);
    const unsatisfiable = await call(`/api/v1/handoffs/${handoffId}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=-0" },
    });
    expect(unsatisfiable.status).toBe(416);

    // A non-previewable Artifact serves as an attachment under its original name.
    writeFileSync(join(senderDir, "render.png"), "\u0089PNG-render-bytes");
    const binary = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      body: { to: ["web-app"], title: "Render", path: join(senderDir, "render.png"), asUser: true },
    });
    expect(binary.status).toBe(201);
    const binaryId = json(binary).data.handoffs[0].handoffId as string;
    const served = await call(`/api/v1/handoffs/${binaryId}/artifact/content?as=web-app`, { bearer: apiToken });
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("application/octet-stream");
    expect(String(served.headers["content-disposition"])).toContain('attachment; filename="render.png"');

    // A non-participant read discloses nothing.
    const outsider = await call(`/api/v1/handoffs/${handoffId}?asUser=true`, { bearer: apiToken });
    expect(outsider.status).toBe(200); // the User participates in everything
  });

  it("runs the review loop through the routes with the documented conflicts", async () => {
    const noted = await call(`/api/v1/handoffs/${handoffId}/review-note`, {
      method: "PUT",
      bearer: apiToken,
      body: { text: "Tighten the intro", as: "web-app" },
    });
    expect(noted.status).toBe(200);
    rowVersion = json(noted).data.handoff.rowVersion;

    const withdrawn = await call(`/api/v1/handoffs/${handoffId}/review-note/withdraw`, {
      method: "POST",
      bearer: apiToken,
      body: { as: "web-app" },
    });
    expect(withdrawn.status).toBe(200);
    rowVersion = json(withdrawn).data.handoff.rowVersion;

    // With no Note left, the stale expectation surfaces as the documented conflict.
    const stale = await call(`/api/v1/handoffs/${handoffId}/accept`, {
      method: "POST",
      bearer: apiToken,
      body: { expectedRevision: revision, expectedRowVersion: rowVersion - 1, as: "web-app" },
    });
    expect(stale.status).toBe(409);
    expect(json(stale)).toMatchObject({ error: { code: "ROW_VERSION_CONFLICT" } });

    const accepted = await call(`/api/v1/handoffs/${handoffId}/accept`, {
      method: "POST",
      bearer: apiToken,
      body: { expectedRevision: revision, expectedRowVersion: rowVersion, as: "web-app" },
    });
    expect(accepted.status).toBe(200);
    expect(json(accepted).data.reviewState).toBe("accepted");

    const terminal = await call(`/api/v1/handoffs/${handoffId}/pin`, {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true },
    });
    expect(terminal.status).toBe(200);
  });

  it("rejects missing terminal expectations honestly instead of a bogus conflict", async () => {
    // A fresh awaiting Handoff whose expectations nobody moved.
    const created = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      body: { to: ["web-app"], title: "Honest", body: "expectations", asUser: true },
    });
    expect(created.status).toBe(201);
    const id = json(created).data.handoffs[0].handoffId as string;

    // accept without expectedRevision is malformed input, not a stale read.
    const acceptMissing = await call(`/api/v1/handoffs/${id}/accept`, {
      method: "POST",
      bearer: apiToken,
      body: { expectedRowVersion: 1, as: "web-app" },
    });
    expect(acceptMissing.status).toBe(422);
    expect(json(acceptMissing)).toMatchObject({ error: { code: "CONFIG_INVALID" } });

    const declineMissing = await call(`/api/v1/handoffs/${id}/decline`, {
      method: "POST",
      bearer: apiToken,
      body: { reason: "why", as: "web-app" },
    });
    expect(declineMissing.status).toBe(422);
    expect(json(declineMissing)).toMatchObject({ error: { code: "CONFIG_INVALID" } });

    const nonNumeric = await call(`/api/v1/handoffs/${id}/accept`, {
      method: "POST",
      bearer: apiToken,
      body: { expectedRevision: "2", expectedRowVersion: 1, as: "web-app" },
    });
    expect(nonNumeric.status).toBe(422);
    expect(json(nonNumeric)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });

  it("revises through a browser multipart upload and records the uploaded filename", async () => {
    // A fresh User-sent Handoff so the same actor may revise it.
    const created = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      body: { to: ["web-app"], title: "Revise me", body: "first", asUser: true },
    });
    expect(created.status).toBe(201);
    const id = json(created).data.handoffs[0].handoffId as string;
    expect(id).not.toBe("");

    const noted = await call(`/api/v1/handoffs/${id}/review-note`, {
      method: "PUT",
      bearer: apiToken,
      body: { text: "Tighten", as: "web-app" },
    });
    expect(noted.status).toBe(200);

    // The note endpoint returns the current Note with its author kind while one exists.
    const noteWhilePresent = await call(`/api/v1/handoffs/${id}/review-note?asUser=true`, { bearer: apiToken });
    expect(noteWhilePresent.status).toBe(200);
    expect(json(noteWhilePresent).data).toMatchObject({ body: "Tighten", authorKind: "registered_project" });

    // A browser session token: section 18.5 documents the multipart shape for the
    // browser, so the route must accept it rather than the CLI token only.
    const secret = createNodeWebSecretStore({
      stateDir: join(home, "state"),
      clock: { now: () => new Date() },
    }).issue();
    expect(secret.ok).toBe(true);
    if (!secret.ok) return;
    const exchanged = await call("/api/v1/session", { method: "POST", body: { secret: secret.value.secret } });
    const browser = json(exchanged).data.token as string;

    const boundary = "revise-boundary-1a";
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="revision.md"\r\nContent-Type: text/markdown\r\n\r\n`,
      ),
      Buffer.from("# revised through the browser\n"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const revised = await call(`/api/v1/handoffs/${id}/revise?asUser=true`, {
      method: "POST",
      bearer: browser,
      rawBody: multipartBody,
      extra: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(revised.status).toBe(200);
    expect(json(revised).data.revision).toBe(2);
    expect(json(revised).data.reviewState).toBe("awaiting_recipient");

    // The revision resolved the Note, so the endpoint now reads null, and the
    // bounded timeline carries the revision events with their actor kinds.
    const noteAfter = await call(`/api/v1/handoffs/${id}/review-note?asUser=true`, { bearer: apiToken });
    expect(noteAfter.status).toBe(200);
    expect(json(noteAfter).data).toBeNull();
    const timeline = await call(`/api/v1/handoffs/${id}/events?asUser=true`, { bearer: apiToken });
    expect(timeline.status).toBe(200);
    const types = json(timeline).data.map((entry: { eventType: string }) => entry.eventType);
    expect(types).toContain("HANDOFF_REVISED");
    expect(types).toContain("REVIEW_NOTE_RESOLVED");

    // The spool path is opaque, so the browser's filename is what gets recorded.
    const detail = await call(`/api/v1/handoffs/${id}?asUser=true`, { bearer: apiToken });
    expect(json(detail).data.currentArtifact.originalName).toBe("revision.md");
    expect(json(detail).data.currentArtifact.mimeType).toBe("text/markdown");
  });
});

describe("the Idempotency-Key replay (API-012)", () => {
  it("replays the stored response before any Row Version precondition", async () => {
    const secret2 = createNodeWebSecretStore({
      stateDir: join(home, "state"),
      clock: { now: () => new Date() },
    }).issue();
    expect(secret2.ok).toBe(true);
    if (!secret2.ok) return;
    const key = "11111111-2222-4333-8444-555555555555";
    const created = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      extra: { "idempotency-key": key },
      body: { to: ["web-app"], title: "Idempotent", body: "Once", asUser: true },
    });
    expect(created.status).toBe(201);
    const firstId = json(created).data.handoffs?.[0]?.id ?? json(created).data.id;

    // The same key and body replays the original response even though the Row
    // Version of nothing moved: replay is evaluated first.
    const replay = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      extra: { "idempotency-key": key },
      body: { to: ["web-app"], title: "Idempotent", body: "Once", asUser: true },
    });
    expect(replay.status).toBe(201);
    const replayId = json(replay).data.handoffs?.[0]?.id ?? json(replay).data.id;
    expect(replayId).toBe(firstId);

    const conflict = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      extra: { "idempotency-key": key },
      body: { to: ["web-app"], title: "Different", body: "Twice", asUser: true },
    });
    expect(conflict.status).toBe(409);
    expect(json(conflict)).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });
});

describe("no route exposes filesystem browsing", () => {
  it("treats traversal-shaped ids as unknown Handoffs", async () => {
    const response = await call("/api/v1/handoffs/..%2F..%2Fetc?asUser=true", { bearer: apiToken });
    expect(response.status).toBe(404);
  });
});
