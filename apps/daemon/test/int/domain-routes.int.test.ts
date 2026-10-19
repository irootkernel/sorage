import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import * as handoffCommandPorts from "@sorage/adapters/src/handoff-command-ports";
import * as sqliteConnections from "@sorage/adapters/src/sqlite/connection";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { appError, err, initializeInstallation } from "@sorage/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionService } from "../../src/auth";
import { createDomainRoutes } from "../../src/domain-routes";
import { createDaemonConfigService } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";

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
      // Blocking database fixtures can outlive a pooled socket's idle timeout.
      { host: "127.0.0.1", port, path, method: init?.method ?? "GET", headers, agent: false },
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
    outgoing.on("error", (error) => {
      error.message += ` (${init?.method ?? "GET"} ${path}; reusedSocket=${outgoing.reusedSocket})`;
      reject(error);
    });
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

function json(response: TestResponse) {
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

    const archived = await call("/api/v1/projects/web-app/archive", { method: "POST", bearer: apiToken });
    expect(archived.status).toBe(200);
    expect(json(archived).data.status).toBe("archived");
    const unarchived = await call("/api/v1/projects/web-app/unarchive", { method: "POST", bearer: apiToken });
    expect(unarchived.status).toBe(200);
    expect(json(unarchived).data.status).toBe("active");
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

    // The User participates in every Handoff; this is an authorized control.
    const user = await call(`/api/v1/handoffs/${handoffId}?asUser=true`, { bearer: apiToken });
    expect(user.status).toBe(200);
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
  it("does not replay a different HTTP sender under the same key", async () => {
    const alphaDir = join(home, "sender-alpha");
    const gammaDir = join(home, "sender-gamma");
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(gammaDir, { recursive: true });
    for (const [name, dir] of [
      ["Replay Alpha", alphaDir],
      ["Replay Gamma", gammaDir],
    ]) {
      const created = await call("/api/v1/projects", {
        method: "POST",
        bearer: apiToken,
        body: { name, dir, asUser: true },
      });
      expect(created.status).toBe(201);
    }
    const key = "bda34afb-23fa-48b5-9069-4aa6719cff84";
    const request = {
      method: "POST",
      bearer: apiToken,
      extra: { "idempotency-key": key },
      body: { to: ["web-app"], title: "Sender", body: "Same" },
    };
    const first = await call("/api/v1/handoffs/import-path?as=replay-alpha", request);
    expect(first.status).toBe(201);
    const archived = await call("/api/v1/projects/replay-alpha/archive", { method: "POST", bearer: apiToken });
    expect(archived.status).toBe(200);
    const replay = await call("/api/v1/handoffs/import-path?as=replay-alpha", request);
    expect(replay.status).toBe(201);
    expect(json(replay).data.handoffs[0].handoffId).toBe(json(first).data.handoffs[0].handoffId);
    const different = await call("/api/v1/handoffs/import-path?as=replay-gamma", request);
    expect(different.status).toBe(409);
    expect(json(different)).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });
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

describe("matrix rows 10 and 11: hostile content types never render inline (WEB-006)", () => {
  it("serves an SVG and an .html Artifact as attachments, never inline", async () => {
    writeFileSync(
      join(senderDir, "badge.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n',
    );
    writeFileSync(join(senderDir, "page.html"), "<!doctype html><html><script>alert(2)</script></html>\n");
    for (const [name, file] of [
      ["SVG", "badge.svg"],
      ["HTML", "page.html"],
    ] as const) {
      const created = await call("/api/v1/handoffs/import-path", {
        method: "POST",
        bearer: apiToken,
        body: { to: ["web-app"], title: `${name} upload`, path: join(senderDir, file), asUser: true },
      });
      expect(created.status).toBe(201);
      const id = json(created).data.handoffs[0].handoffId as string;
      const served = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
      expect(served.status).toBe(200);
      // Neither hostile type is ever served with a content type a browser renders.
      expect(served.headers["content-type"]).toBe("application/octet-stream");
      expect(String(served.headers["content-disposition"])).toContain(`attachment; filename="${file}"`);
    }
  });

  it("serves Markdown as text, never as a browser-parsed document type", async () => {
    // The safe-preview contract has two halves: the server never labels a
    // document Artifact text/html, and the client script escapes before it
    // re-enables the tiny Markdown subset, so a <script> tag rides as text.
    writeFileSync(
      join(senderDir, "hostile.md"),
      '# Title\n\n<script>alert(3)</script> and <img src="https://evil.example/x.png">\n',
    );
    const created = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      body: { to: ["web-app"], title: "Hostile markdown", path: join(senderDir, "hostile.md"), asUser: true },
    });
    expect(created.status).toBe(201);
    const id = json(created).data.handoffs[0].handoffId as string;
    const served = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
    expect(served.status).toBe(200);
    expect(String(served.headers["content-type"])).toContain("text/");
    expect(String(served.headers["content-type"])).not.toContain("html");
    expect(served.body).toContain("<script>alert(3)</script>");
    // The client script escapes before building DOM nodes and never uses
    // innerHTML; the CSP of row 9 blocks the external image load.
    const script = await call("/assets/app.js", { bearer: null });
    expect(script.status).toBe(200);
    expect(script.body).not.toContain("innerHTML");
    expect(script.body).toContain("renderMarkdownSafe");
    expect(script.body).toContain('replace(/</g, "&lt;")');
  });
});

describe("no route exposes filesystem browsing", () => {
  it("treats traversal-shaped ids as unknown Handoffs", async () => {
    const response = await call("/api/v1/handoffs/..%2F..%2Fetc?asUser=true", { bearer: apiToken });
    expect(response.status).toBe(404);
  });
});

describe("diagnostics schema admission", () => {
  it("preserves supported reports and maps a forward refusal through authenticated HTTP", async () => {
    const supported = await call("/api/v1/diagnostics", { bearer: apiToken });
    expect(supported.status).toBe(200);
    expect(json(supported).data.checks).toHaveLength(21);
    const database = join(home, "state/sorage.sqlite3");
    const writer = new DatabaseSync(database);
    const operationalOpen = vi.spyOn(sqliteConnections, "openSorageDatabase");
    try {
      writer.exec("INSERT INTO schema_migrations VALUES(11, 'future', '2026-01-01')");
      // Keep a known connection alive so finalizing earlier request connections
      // cannot checkpoint their WAL inside the endpoint's byte-comparison window.
      const before = readFileSync(database);
      const walFile = `${database}-wal`;
      expect(existsSync(walFile)).toBe(true);
      const beforeWal = readFileSync(walFile);
      expect(beforeWal.byteLength).toBeGreaterThan(0);
      const unauthorized = await call("/api/v1/diagnostics", { bearer: null });
      expect(unauthorized.status).toBe(401);
      const refused = await call("/api/v1/diagnostics", {
        bearer: apiToken,
        extra: { "x-request-id": "diagnostics-future" },
      });
      expect(refused.status).toBe(422);
      expect(json(refused)).toMatchObject({ ok: false, error: { code: "STORAGE_SCHEMA_UNSUPPORTED" } });
      expect(json(refused).meta.requestId).toBe(refused.headers["x-request-id"]);
      expect(readFileSync(database)).toEqual(before);
      expect(existsSync(walFile)).toBe(true);
      const afterWal = readFileSync(walFile);
      expect(afterWal.byteLength).toBe(beforeWal.byteLength);
      expect(afterWal).toEqual(beforeWal);
      expect(operationalOpen.mock.calls.filter(([path]) => path === database)).toHaveLength(0);
    } finally {
      try {
        writer.exec("DELETE FROM schema_migrations WHERE version=11");
      } finally {
        operationalOpen.mockRestore();
        writer.close();
      }
    }
  });
});

describe("the serving boundary over authenticated HTTP", () => {
  function withDatabase<T>(body: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(home, "state/sorage.sqlite3"));
    try {
      return body(db);
    } finally {
      db.close();
    }
  }

  function firstFetchedAt(handoffId: string): string | null {
    return withDatabase(
      (db) =>
        (
          db.prepare("SELECT first_fetched_at FROM handoffs WHERE id = ?").get(handoffId) as {
            first_fetched_at: string | null;
          }
        ).first_fetched_at,
    );
  }

  function fetchEvents(handoffId: string): number {
    return withDatabase(
      (db) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM events WHERE handoff_id = ? AND event_type = 'ARTIFACT_FETCHED_FIRST_TIME'",
            )
            .get(handoffId) as { count: number }
        ).count,
    );
  }

  async function createFreshHandoff(title: string, fileName: string, content: string | Buffer): Promise<string> {
    writeFileSync(join(senderDir, fileName), content);
    const created = await call("/api/v1/handoffs/import-path", {
      method: "POST",
      bearer: apiToken,
      body: { to: ["web-app"], title, path: join(senderDir, fileName), asUser: true },
    });
    expect(created.status).toBe(201);
    const id = json(created).data.handoffs[0].handoffId as string;
    expect(typeof id).toBe("string");
    return id;
  }

  function leafOf(handoffId: string): string {
    return withDatabase((db) => {
      const row = db
        .prepare(
          "SELECT c.storage_key AS storage_key FROM handoffs h JOIN artifacts a ON a.id = h.current_artifact_id JOIN content_records c ON c.id = a.content_record_id WHERE h.id = ?",
        )
        .get(handoffId) as { storage_key: string };
      return join(home, "vault", row.storage_key);
    });
  }

  it.each(["md", "bin"] as const)(
    "preserves %s headers on a quiet 416, then settles on admission",
    async (extension) => {
      const name = `range-admission.${extension}`;
      const id = await createFreshHandoff("Range admission", name, "# Range admission\n");
      const detail = await call(`/api/v1/handoffs/${id}?as=web-app`, { bearer: apiToken });
      expect(detail.status).toBe(200);
      const digest = json(detail).data.currentArtifact.sha256 as string;
      const refused = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, {
        bearer: apiToken,
        extra: { range: "bytes=999999-" },
      });
      expect(refused.status).toBe(416);
      expect(String(refused.headers["content-range"])).toMatch(/^bytes \*\//);
      expect(refused.headers.etag).toBe(`"${digest}"`);
      expect(refused.headers["accept-ranges"]).toBe("bytes");
      expect(refused.headers["x-content-type-options"]).toBe("nosniff");
      expect(typeof refused.headers["x-request-id"]).toBe("string");
      expect(refused.headers["content-type"]).toBe(
        extension === "md" ? "text/plain; charset=utf-8" : "application/octet-stream",
      );
      expect(refused.headers["content-disposition"]).toBe(
        extension === "md" ? undefined : `attachment; filename="${name}"`,
      );
      expect(refused.body).toBe("");
      expect(firstFetchedAt(id)).toBeNull();
      expect(fetchEvents(id)).toBe(0);
      const served = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
      expect(served.status).toBe(200);
      expect(firstFetchedAt(id)).not.toBeNull();
      expect(fetchEvents(id)).toBe(1);
    },
  );

  it("reveal returns the readable local path without settling a first fetch", async () => {
    const id = await createFreshHandoff("Reveal silence", "reveal-silence.md", "# Reveal silence\n");
    const revealed = await call(`/api/v1/handoffs/${id}/artifact/reveal?as=web-app`, {
      method: "POST",
      bearer: apiToken,
      body: {},
    });
    expect(revealed.status).toBe(200);
    const localPath = json(revealed).data.localPath as string;
    expect(typeof localPath).toBe("string");
    expect(readFileSync(localPath, "utf8")).toBe("# Reveal silence\n");
    expect(firstFetchedAt(id)).toBeNull();
    expect(fetchEvents(id)).toBe(0);
  });

  it("hides live and deleted Handoffs from an unrelated Project before any content work", async () => {
    const outsiderDir = join(home, "unrelated-reader");
    mkdirSync(outsiderDir);
    const registered = await call("/api/v1/projects", {
      method: "POST",
      bearer: apiToken,
      body: { name: "Unrelated Reader", dir: outsiderDir, asUser: true },
    });
    expect(registered.status).toBe(201);
    const outsider = json(registered).data.project.slug as string;
    const live = await createFreshHandoff("Private live", "private-live.md", "# Private live\n");
    const deleted = await createFreshHandoff("Private tombstone", "private-tombstone.md", "# Private tombstone\n");
    const declined = await call(`/api/v1/handoffs/${deleted}/decline`, {
      method: "POST",
      bearer: apiToken,
      body: { as: "web-app", reason: "Finish this fixture", expectedRowVersion: 1 },
    });
    expect(declined.status).toBe(200);
    const requested = await call(`/api/v1/handoffs/${deleted}/deletion-request`, {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true, expectedRowVersion: json(declined).data.rowVersion },
    });
    expect(requested.status).toBe(200);
    const approved = await call(`/api/v1/handoffs/${deleted}/deletion-approve`, {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true, confirm: true, expectedRowVersion: json(requested).data.rowVersion },
    });
    expect(approved.status).toBe(200);
    expect(json(approved).data.deleted).toBe(true);
    const original = handoffCommandPorts.createNodeHandoffReadPorts;
    const calls = { checksum: 0, path: 0, open: 0, settle: 0 };
    const factory = vi.spyOn(handoffCommandPorts, "createNodeHandoffReadPorts").mockImplementation((options) => {
      const ports = original(options);
      return {
        ...ports,
        // Even an enabled checksum policy must remain behind participant and
        // authorized-tombstone checks. SQL, files and HTTP stay real.
        config: { ...ports.config, verifyChecksumOnFetch: true },
        handoffs: {
          ...ports.handoffs,
          recordFirstFetch: (id, event) => {
            calls.settle += 1;
            return ports.handoffs.recordFirstFetch(id, event);
          },
        },
        artifact: {
          verifyArtifactBody: (id, policy) => {
            calls.checksum += 1;
            return ports.artifact.verifyArtifactBody(id, policy);
          },
          localPathOfArtifact: (id) => {
            calls.path += 1;
            return ports.artifact.localPathOfArtifact(id);
          },
          openArtifactBody: (id, policy) => {
            calls.open += 1;
            return ports.artifact.openArtifactBody(id, policy);
          },
        },
      };
    });
    try {
      for (const surface of ["content", "reveal"] as const) {
        const failures: Array<{ code: string; message: string }> = [];
        for (const id of [live, deleted]) {
          const refused = await call(`/api/v1/handoffs/${id}/artifact/${surface}?as=${outsider}`, {
            method: surface === "content" ? "GET" : "POST",
            bearer: apiToken,
          });
          expect(refused.status).toBe(404);
          const error = json(refused).error as { code: string; message: string };
          expect(error.code).toBe("HANDOFF_NOT_FOUND");
          expect(refused.body).not.toContain("# Private");
          failures.push({ code: error.code, message: error.message });
        }
        expect(failures[0]).toEqual(failures[1]);
        for (const actor of ["as=web-app", "asUser=true"]) {
          const tombstone = await call(`/api/v1/handoffs/${deleted}/artifact/${surface}?${actor}`, {
            method: surface === "content" ? "GET" : "POST",
            bearer: apiToken,
          });
          expect(tombstone.status).toBe(409);
          expect(json(tombstone).error.code).toBe("HANDOFF_DELETED");
        }
      }
      expect(calls).toEqual({ checksum: 0, path: 0, open: 0, settle: 0 });
      for (const id of [live, deleted]) {
        expect(firstFetchedAt(id)).toBeNull();
        expect(fetchEvents(id)).toBe(0);
      }
    } finally {
      factory.mockRestore();
    }
  });

  it.each(["typed", "thrown"] as const)("closes the acquired body on a %s settlement failure", async (kind) => {
    const id = await createFreshHandoff(`Settlement ${kind}`, `settlement-${kind}.md`, "# Not yet served\n");
    const original = handoffCommandPorts.createNodeHandoffReadPorts;
    let opens = 0;
    let closes = 0;
    let settlements = 0;
    const factory = vi.spyOn(handoffCommandPorts, "createNodeHandoffReadPorts").mockImplementation((options) => {
      const ports = original(options);
      return {
        ...ports,
        handoffs: {
          ...ports.handoffs,
          recordFirstFetch: () => {
            settlements += 1;
            if (kind === "thrown") throw new Error("injected settlement failure");
            return err(appError("INTERNAL_ERROR", "injected settlement failure"));
          },
        },
        artifact: {
          ...ports.artifact,
          openArtifactBody: (id, policy) => {
            const opened = ports.artifact.openArtifactBody(id, policy);
            if (!opened.ok) return opened;
            opens += 1;
            let closed = false;
            return {
              ok: true,
              value: {
                ...opened.value,
                close: () => {
                  if (closed) return;
                  closed = true;
                  closes += 1;
                  opened.value.close();
                },
              },
            };
          },
        },
      };
    });
    try {
      const refused = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
      expect(refused.status).toBe(500);
      expect(json(refused)).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
      expect(opens).toBe(1);
      expect(settlements).toBe(1);
      expect(closes).toBe(1);
      expect(firstFetchedAt(id)).toBeNull();
      expect(fetchEvents(id)).toBe(0);
    } finally {
      factory.mockRestore();
    }
    const healthy = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
    expect(healthy.status).toBe(200);
    expect(healthy.body).toBe("# Not yet served\n");
    expect(fetchEvents(id)).toBe(1);
  });

  it.each(["leaf", "parent", "fifo", "missing"] as const)("refuses %s over HTTP before settling", async (kind) => {
    const id = await createFreshHandoff("Symlink canary", "symlink-canary.bin", "# Symlink canary\n");
    const leaf = leafOf(id);
    const outsideDir = join(home, `owned-outside-${kind}`);
    mkdirSync(outsideDir);
    const outside = join(outsideDir, basename(leaf));
    writeFileSync(outside, "owned bytes outside the Vault");
    const outsideInventory = readdirSync(outsideDir);
    rmSync(leaf);
    if (kind === "leaf") symlinkSync(outside, leaf);
    if (kind === "parent") {
      rmSync(dirname(leaf), { recursive: true });
      symlinkSync(outsideDir, dirname(leaf));
    }
    if (kind === "fifo") expect(spawnSync("mkfifo", [leaf]).status).toBe(0);
    const refused = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
    expect(refused.status).not.toBe(200);
    expect(json(refused)).toMatchObject({ ok: false, error: { code: "ARTIFACT_CORRUPTED" } });
    expect(refused.body).not.toContain("owned bytes outside the Vault");
    expect(readFileSync(outside, "utf8")).toBe("owned bytes outside the Vault");
    expect(readdirSync(outsideDir)).toEqual(outsideInventory);
    expect(firstFetchedAt(id)).toBeNull();
    expect(fetchEvents(id)).toBe(0);
  });

  it("terminates a client-aborted stream within bounds and keeps the daemon serving", async () => {
    const large = Buffer.alloc(3 * 1024 * 1024, 0x62);
    const id = await createFreshHandoff("Abort mid stream", "abort-stream.bin", large);
    const aborted = await new Promise<boolean>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/api/v1/handoffs/${id}/artifact/content?as=web-app`,
          headers: { authorization: `Bearer ${apiToken}` },
        },
        (response) => {
          response.once("data", () => outgoing.destroy());
          response.on("aborted", () => resolve(true));
          response.on("end", () => resolve(false));
        },
      );
      outgoing.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(true);
        else reject(error);
      });
      outgoing.end();
    });
    expect(aborted).toBe(true);
    // The aborted exchange was admitted, so its first fetch settled at
    // admission; the daemon itself stays healthy and serves the whole body.
    expect(firstFetchedAt(id)).not.toBeNull();
    const served = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
    expect(served.status).toBe(200);
    expect(Buffer.byteLength(served.body, "utf8")).toBe(large.byteLength);
  });

  // ---- Selected-read Artifact ownership (SHR-004) ---------------------------
  function rowVersionOf(handoffId: string): number {
    return withDatabase(
      (db) =>
        (db.prepare("SELECT row_version FROM handoffs WHERE id = ?").get(handoffId) as { row_version: number })
          .row_version,
    );
  }

  /** Full row dumps, not counts: refusals must leave every affected table byte-identical. */
  function fullSqlState(): Record<string, unknown[]> {
    return withDatabase((db) => ({
      handoffs: db.prepare("SELECT * FROM handoffs ORDER BY rowid").all(),
      artifacts: db.prepare("SELECT * FROM artifacts ORDER BY rowid").all(),
      records: db.prepare("SELECT * FROM content_records ORDER BY rowid").all(),
      notes: db.prepare("SELECT * FROM review_notes ORDER BY rowid").all(),
      events: db.prepare("SELECT * FROM events ORDER BY rowid").all(),
      intents: db.prepare("SELECT * FROM pending_fs_ops ORDER BY rowid").all(),
      receipts: db.prepare("SELECT * FROM idempotency_keys ORDER BY rowid").all(),
      deletionRequests: db.prepare("SELECT * FROM deletion_requests ORDER BY rowid").all(),
    }));
  }

  function storageKeyOf(handoffId: string): string | null {
    return withDatabase(
      (db) =>
        (
          db
            .prepare(
              "SELECT c.storage_key AS storage_key FROM handoffs h JOIN artifacts a ON a.id = h.current_artifact_id JOIN content_records c ON c.id = a.content_record_id WHERE h.id = ?",
            )
            .get(handoffId) as { storage_key: string | null }
        ).storage_key,
    );
  }

  function currentArtifactOf(handoffId: string): string {
    return withDatabase(
      (db) =>
        (
          db.prepare("SELECT current_artifact_id FROM handoffs WHERE id = ?").get(handoffId) as {
            current_artifact_id: string;
          }
        ).current_artifact_id,
    );
  }

  function repointCurrentArtifact(handoffId: string, artifactId: string): void {
    withDatabase((db) =>
      db.prepare("UPDATE handoffs SET current_artifact_id = ? WHERE id = ?").run(artifactId, handoffId),
    );
  }

  it.each(["inline-md", "file-bin"] as const)(
    "never projects another Handoff's %s Artifact body: reads refuse, mutations fail closed, the neighbor stays healthy",
    async (representation) => {
      const extension = representation === "inline-md" ? "md" : "bin";
      const ownBody =
        representation === "inline-md" ? "# Alpha private brief\n" : Buffer.from([0x0a, 0x0b, 0xfc, 0xfd]);
      const otherBody =
        representation === "inline-md" ? "# Beta private brief\n" : Buffer.from([0x7a, 0x7b, 0x7c, 0x7d]);
      // A second recipient Project owns the Artifact whose id the fault will
      // borrow: both bodies come from the real producer, and the dotted
      // logical names prove each production representation before the fault.
      const secondDir = join(home, `owner-second-${representation}`);
      mkdirSync(secondDir);
      const registered = await call("/api/v1/projects", {
        method: "POST",
        bearer: apiToken,
        body: { name: `Owner Second ${representation}`, dir: secondDir, asUser: true },
      });
      expect(registered.status).toBe(201);
      const secondSlug = json(registered).data.project.slug as string;
      writeFileSync(join(senderDir, `owner-beta.${extension}`), otherBody);
      const betaCreated = await call("/api/v1/handoffs/import-path", {
        method: "POST",
        bearer: apiToken,
        body: {
          to: [secondSlug],
          title: `Owner beta ${representation}`,
          path: join(senderDir, `owner-beta.${extension}`),
          asUser: true,
        },
      });
      expect(betaCreated.status).toBe(201);
      const betaId = json(betaCreated).data.handoffs[0].handoffId as string;
      expect(storageKeyOf(betaId)).toEqual(representation === "inline-md" ? null : expect.any(String));
      const unrelated = await call(`/api/v1/handoffs/${betaId}?as=web-app`, { bearer: apiToken });
      expect(unrelated.status).toBe(404);
      expect(json(unrelated)).toMatchObject({ error: { code: "HANDOFF_NOT_FOUND" } });

      // Three fault targets: a note-free awaiting Handoff isolates the accept
      // gate, a noted twin carries revise and no-change, a terminal twin
      // carries the deletion approval.
      const alphaClean = await createFreshHandoff(
        `Owner alpha clean ${representation}`,
        `owner-alpha-clean.${extension}`,
        ownBody,
      );
      const alphaId = await createFreshHandoff(`Owner alpha ${representation}`, `owner-alpha.${extension}`, ownBody);
      expect(storageKeyOf(alphaId)).toEqual(representation === "inline-md" ? null : expect.any(String));
      const noted = await call(`/api/v1/handoffs/${alphaId}/review-note`, {
        method: "PUT",
        bearer: apiToken,
        body: { as: "web-app", text: "Clarify ownership", targetRevision: 1, expectedRowVersion: 1 },
      });
      expect(noted.status).toBe(200);
      const alphaTerminal = await createFreshHandoff(
        `Owner alpha terminal ${representation}`,
        `owner-alpha-term.${extension}`,
        ownBody,
      );
      const declined = await call(`/api/v1/handoffs/${alphaTerminal}/decline`, {
        method: "POST",
        bearer: apiToken,
        body: { as: "web-app", reason: "ownership probe", expectedRowVersion: 1 },
      });
      expect(declined.status).toBe(200);
      const requested = await call(`/api/v1/handoffs/${alphaTerminal}/deletion-request`, {
        method: "POST",
        bearer: apiToken,
        body: { asUser: true, expectedRowVersion: json(declined).data.rowVersion },
      });
      expect(requested.status).toBe(200);

      // The SQL fault: FK-legal keys, empty foreign_key_check, wrong owner.
      // The full-state baseline is captured AFTER the fault and the
      // preconditions, so only the refused operations' zero-effect is judged.
      const betaArtifact = currentArtifactOf(betaId);
      const originalArtifacts = [alphaClean, alphaId, alphaTerminal].map((id) => [id, currentArtifactOf(id)] as const);
      try {
        for (const id of [alphaClean, alphaId, alphaTerminal]) repointCurrentArtifact(id, betaArtifact);
        expect(withDatabase((db) => (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length)).toBe(0);
        const baseline = fullSqlState();
        const cleanVersion = rowVersionOf(alphaClean);
        const notedVersion = rowVersionOf(alphaId);
        const terminalVersion = rowVersionOf(alphaTerminal);

        // Reads refuse without ever carrying the beta bytes.
        for (const id of [alphaClean, alphaId, alphaTerminal]) {
          const detail = await call(`/api/v1/handoffs/${id}?as=web-app`, { bearer: apiToken });
          expect(detail.status).toBe(409);
          expect(json(detail)).toMatchObject({ ok: false, error: { code: "ARTIFACT_CORRUPTED" } });
          expect(detail.body).not.toContain("Beta private");
          const content = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
          expect(content.status).toBe(409);
          expect(json(content)).toMatchObject({ ok: false, error: { code: "ARTIFACT_CORRUPTED" } });
          expect(content.body).not.toContain("Beta private");
          expect(firstFetchedAt(id)).toBeNull();
          expect(fetchEvents(id)).toBe(0);
        }
        // A participant of the other Handoff learns nothing about either.
        const outsider = await call(`/api/v1/handoffs/${alphaId}?as=${secondSlug}`, { bearer: apiToken });
        expect(outsider.status).toBe(404);
        expect(json(outsider)).toMatchObject({ error: { code: "HANDOFF_NOT_FOUND" } });

        // The mutations all fail closed against the borrowed body.
        const accepted = await call(`/api/v1/handoffs/${alphaClean}/accept`, {
          method: "POST",
          bearer: apiToken,
          body: { as: "web-app", expectedRevision: 1, expectedRowVersion: cleanVersion },
        });
        expect(accepted.status).toBe(409);
        expect(json(accepted)).toMatchObject({ error: { code: "ARTIFACT_CORRUPTED" } });
        const replacement = join(senderDir, `owner-replacement.${extension}`);
        writeFileSync(
          replacement,
          representation === "inline-md" ? "# Clean replacement\n" : Buffer.from([0x01, 0x02]),
        );
        const revised = await call(`/api/v1/handoffs/${alphaId}/revise`, {
          method: "POST",
          bearer: apiToken,
          body: { path: replacement, asUser: true, allowExternalSource: true, expectedRowVersion: notedVersion },
        });
        expect(revised.status).toBe(409);
        expect(json(revised)).toMatchObject({ error: { code: "ARTIFACT_CORRUPTED" } });
        const noChange = await call(`/api/v1/handoffs/${alphaId}/revise`, {
          method: "POST",
          bearer: apiToken,
          body: { noChange: true, reason: "ownership probe", asUser: true, expectedRowVersion: notedVersion },
        });
        expect(noChange.status).toBe(409);
        expect(json(noChange)).toMatchObject({ error: { code: "ARTIFACT_CORRUPTED" } });
        const approved = await call(`/api/v1/handoffs/${alphaTerminal}/deletion-approve`, {
          method: "POST",
          bearer: apiToken,
          body: { asUser: true, confirm: true, expectedRowVersion: terminalVersion },
        });
        expect(approved.status).toBe(409);
        expect(json(approved)).toMatchObject({ error: { code: "ARTIFACT_CORRUPTED" } });

        // Nothing mutated, and the borrowed-from neighbor still serves exactly.
        expect(fullSqlState()).toEqual(baseline);
        const betaServed = await call(`/api/v1/handoffs/${betaId}/artifact/content?as=${secondSlug}`, {
          bearer: apiToken,
        });
        expect(betaServed.status).toBe(200);
        expect(betaServed.body).toContain(
          representation === "inline-md" ? "# Beta private brief" : String.fromCharCode(0x7a, 0x7b, 0x7c, 0x7d),
        );
      } finally {
        // Undo only this test's injected corruption. Later deletion controls
        // need a complete global reference proof before removing any record.
        for (const [id, artifactId] of originalArtifacts) repointCurrentArtifact(id, artifactId);
      }
    },
  );

  it("keeps a legitimate tombstone with a NULL current Artifact readable after its Artifact row is gone", async () => {
    const id = await createFreshHandoff("Tombstone owner control", "tombstone-owner.md", "# Tombstone control\n");
    const declined = await call(`/api/v1/handoffs/${id}/decline`, {
      method: "POST",
      bearer: apiToken,
      body: { as: "web-app", reason: "done", expectedRowVersion: 1 },
    });
    expect(declined.status).toBe(200);
    const requested = await call(`/api/v1/handoffs/${id}/deletion-request`, {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true, expectedRowVersion: json(declined).data.rowVersion },
    });
    expect(requested.status).toBe(200);
    const approved = await call(`/api/v1/handoffs/${id}/deletion-approve`, {
      method: "POST",
      bearer: apiToken,
      body: { asUser: true, confirm: true, expectedRowVersion: json(requested).data.rowVersion },
    });
    expect(approved.status).toBe(200);
    expect(json(approved).data.deleted).toBe(true);
    // The legitimate tombstone keeps metadata readability with its NULL
    // current Artifact: no wrong-owner pointer, no CHECK tampering.
    const detail = await call(`/api/v1/handoffs/${id}?as=web-app`, { bearer: apiToken });
    expect(detail.status).toBe(200);
    expect(json(detail).data.currentArtifact).toBeNull();
  });

  // ---- Actual opened-descriptor extent (section 11.3) ------------------------
  function growLeaf(id: string, extra: string): void {
    const leaf = leafOf(id);
    chmodSync(leaf, 0o644);
    appendFileSync(leaf, extra);
    chmodSync(leaf, 0o444);
  }

  function shrinkLeaf(id: string, shorter: Buffer): void {
    const leaf = leafOf(id);
    chmodSync(leaf, 0o644);
    writeFileSync(leaf, shorter);
    chmodSync(leaf, 0o444);
  }

  it("serves a file that grew on disk at its true extent and settles exactly once", async () => {
    const original = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const id = await createFreshHandoff("Grown file", "grown-file.bin", original);
    const appended = "GROWN-TAIL";
    growLeaf(id, appended);
    const leaf = leafOf(id);
    expect(statSync(leaf).size).toBe(original.byteLength + appended.length);
    const served = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
    expect(served.status).toBe(200);
    expect(Buffer.byteLength(served.body, "utf8")).toBe(original.byteLength + appended.length);
    expect(served.headers["content-length"]).toBe(String(original.byteLength + appended.length));
    expect(served.body.endsWith(appended)).toBe(true);
    const metadata = await call(`/api/v1/handoffs/${id}?as=web-app`, { bearer: apiToken });
    expect(json(metadata).data.currentArtifact.sizeBytes).toBe(original.byteLength);
    expect(served.headers.etag).toBe(`"${json(metadata).data.currentArtifact.sha256}"`);
    expect(firstFetchedAt(id)).not.toBeNull();
    expect(fetchEvents(id)).toBe(1);
    const suffix = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=-5" },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.body).toBe("-TAIL");
    const tail = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=4-8" },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers["content-range"]).toBe(`bytes 4-8/${original.byteLength + appended.length}`);
    expect(tail.body).toBe("GROWN");
    expect(fetchEvents(id)).toBe(1);
    expect(rowVersionOf(id)).toBe(1);
    const beyond = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: `bytes=${original.byteLength + appended.length + 10}-` },
    });
    expect(beyond.status).toBe(416);
  });

  it("answers a fresh grown Handoff's beyond-extent range with a quiet 416", async () => {
    const id = await createFreshHandoff("Grown quiet 416", "grown-quiet.bin", Buffer.from([0x51, 0x52]));
    growLeaf(id, "!");
    const refused = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=999999-" },
    });
    expect(refused.status).toBe(416);
    expect(firstFetchedAt(id)).toBeNull();
    expect(fetchEvents(id)).toBe(0);
  });

  it("serves a file already shrunk before open at its true short extent, and 416s beyond it before any settlement", async () => {
    const id = await createFreshHandoff("Shrunk file", "shrunk-file.bin", Buffer.alloc(64, 0x64));
    const shorter = Buffer.from([0x01, 0x02, 0x03]);
    shrinkLeaf(id, shorter);
    const served = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
    expect(served.status).toBe(200);
    expect(Buffer.byteLength(served.body, "utf8")).toBe(shorter.byteLength);
    expect(served.headers["content-length"]).toBe(String(shorter.byteLength));
    expect(firstFetchedAt(id)).not.toBeNull();
    expect(fetchEvents(id)).toBe(1);
    const suffix = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=-2" },
    });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(suffix.body)).toEqual(shorter.subarray(1));

    const fresh = await createFreshHandoff("Shrunk quiet 416", "shrunk-quiet.bin", Buffer.alloc(64, 0x65));
    shrinkLeaf(fresh, Buffer.from([0x0a]));
    const refused = await call(`/api/v1/handoffs/${fresh}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=50-" },
    });
    expect(refused.status).toBe(416);
    expect(firstFetchedAt(fresh)).toBeNull();
    expect(fetchEvents(fresh)).toBe(0);
    // The true extent admits a real range of the short body.
    const ranged = await call(`/api/v1/handoffs/${fresh}/artifact/content?as=web-app`, {
      bearer: apiToken,
      extra: { range: "bytes=0-0" },
    });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(ranged.body)[0]).toBe(0x0a);
  });

  it.each(["growth", "shrink"] as const)(
    "refuses %s under the strict recorded-size and hash policy before any settlement",
    async (fault) => {
      const id = await createFreshHandoff(`Strict ${fault}`, `strict-${fault}.bin`, Buffer.from([0x71, 0x72, 0x73]));
      if (fault === "growth") growLeaf(id, "DIVERGENT");
      else shrinkLeaf(id, Buffer.from("x"));
      const original = handoffCommandPorts.createNodeHandoffReadPorts;
      const factory = vi.spyOn(handoffCommandPorts, "createNodeHandoffReadPorts").mockImplementation((options) => {
        const ports = original(options);
        return { ...ports, config: { ...ports.config, verifyChecksumOnFetch: true } };
      });
      try {
        const refused = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
        expect(refused.status).not.toBe(200);
        expect(json(refused)).toMatchObject({ ok: false, error: { code: "ARTIFACT_CORRUPTED" } });
        expect(firstFetchedAt(id)).toBeNull();
        expect(fetchEvents(id)).toBe(0);
        // No handle can have been handed out past the strict gate, so a repeat
        // request after the policy is dropped still serves coherently.
      } finally {
        factory.mockRestore();
      }
      const relaxed = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
      expect(relaxed.status).toBe(200);
      expect(relaxed.body).toBe(fault === "growth" ? "qrsDIVERGENT" : "x");
      expect(fetchEvents(id)).toBe(1);
    },
  );

  it("closes the acquired body handle once a true-extent serve completes", async () => {
    const id = await createFreshHandoff("Closure serve", "closure-serve.bin", Buffer.from([0x81, 0x82, 0x83, 0x84]));
    const original = handoffCommandPorts.createNodeHandoffReadPorts;
    let opens = 0;
    let closes = 0;
    const factory = vi.spyOn(handoffCommandPorts, "createNodeHandoffReadPorts").mockImplementation((options) => {
      const ports = original(options);
      return {
        ...ports,
        artifact: {
          ...ports.artifact,
          openArtifactBody: (artifactId: string, policy: unknown) => {
            const opened = ports.artifact.openArtifactBody(artifactId, policy as never);
            if (!opened.ok) return opened;
            opens += 1;
            let closed = false;
            return {
              ok: true as const,
              value: {
                ...opened.value,
                close: () => {
                  if (closed) return;
                  closed = true;
                  closes += 1;
                  opened.value.close();
                },
              },
            };
          },
        },
      };
    });
    try {
      const served = await call(`/api/v1/handoffs/${id}/artifact/content?as=web-app`, { bearer: apiToken });
      expect(served.status).toBe(200);
      expect(opens).toBe(1);
      expect(closes).toBe(1);
      expect(fetchEvents(id)).toBe(1);
    } finally {
      factory.mockRestore();
    }
  });

  // ---- Inline tamper read surface over a real producer (SHR-003) -------------
  // The four-gate mutation matrix for file/inline-text/inline-SHA tampering
  // lives at the adapters layer over the real stores; this HTTP case proves
  // only what the transport uniquely shows — the typed refusal carries no
  // tampered bytes and settles nothing.
  it.each(["text", "sha"] as const)(
    "refuses an inline %s tamper at the content boundary without settling",
    async (variant) => {
      const alphaId = await createFreshHandoff(
        `Inline tamper ${variant}`,
        `inline-tamper-${variant}.md`,
        "# Original inline brief\n",
      );
      const neighborId = await createFreshHandoff(
        `Inline neighbor ${variant}`,
        `inline-neighbor-${variant}.md`,
        "# Neighbor intact\n",
      );
      expect(storageKeyOf(alphaId)).toBeNull();
      const recordId = withDatabase((db) => {
        const row = db
          .prepare(
            "SELECT c.id AS id FROM handoffs h JOIN artifacts a ON a.id = h.current_artifact_id JOIN content_records c ON c.id = a.content_record_id WHERE h.id = ?",
          )
          .get(alphaId) as { id: string };
        return row.id;
      });
      withDatabase((db) => {
        if (variant === "text") {
          db.prepare("UPDATE content_records SET inline_text = ? WHERE id = ?").run(
            "# Tampered inline brief\n",
            recordId,
          );
        } else {
          db.prepare("UPDATE content_records SET sha256 = ? WHERE id = ?").run("ab".repeat(32), recordId);
        }
      });
      const baseline = fullSqlState();
      const refused = await call(`/api/v1/handoffs/${alphaId}/artifact/content?as=web-app`, { bearer: apiToken });
      expect(refused.status).not.toBe(200);
      expect(json(refused)).toMatchObject({ ok: false, error: { code: "ARTIFACT_CORRUPTED" } });
      expect(refused.body).not.toContain("Tampered inline brief");
      expect(refused.body).not.toContain("Original inline brief");
      expect(firstFetchedAt(alphaId)).toBeNull();
      expect(fetchEvents(alphaId)).toBe(0);
      expect(fullSqlState()).toEqual(baseline);
      const neighbor = await call(`/api/v1/handoffs/${neighborId}/artifact/content?as=web-app`, { bearer: apiToken });
      expect(neighbor.status).toBe(200);
      expect(neighbor.body).toBe("# Neighbor intact\n");
    },
  );
});
