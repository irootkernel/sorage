import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

/**
 * AJ-12: the Web session and the local network boundary, against the compiled
 * binary, a real daemon, and a real browser (RUN-012, SEC-001, SEC-017 to SEC-020).
 */
const home = makeTempDir("sorage-aj12-home-");
let port = 0;
let secret = "";
let sessionToken = "";
const cleanup: Array<() => void> = [];

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

function raw(
  path: string,
  init: { method?: string; host?: string; bearer?: string; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: init.host ?? `127.0.0.1:${port}` };
    if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
    const payload = init.body ?? null;
    if (payload !== null) headers["content-type"] = "application/json";
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers },
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

beforeAll(async () => {
  port = await freePort();
  expect(sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--json"], { home }).status).toBe(0);
  expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
  // A recipient Project and one Handoff give the dashboard real counts.
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "brief.md"), "# The web brief\n");
  expect(sorage(["project", "add", "--name", "Web App", "--dir", work, "--json"], { home, cwd: work }).status).toBe(0);
  expect(
    sorage(["send", "--to", "web-app", "--title", "The web brief", "--file", join(work, "brief.md"), "--json"], {
      home,
      cwd: work,
    }).status,
  ).toBe(0);
  expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
  cleanup.push(() => sorage(["daemon", "stop", "--json"], { home }));

  // sorage web issues the one-time secret and prints the fragment URL.
  const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
  expect(web.status).toBe(0);
  const url = (JSON.parse(web.stdout) as { url: string }).url;
  secret = /#s=(.+)$/.exec(url)?.[1] ?? "";
  expect(secret).not.toBe("");

  const exchange = await raw("/api/v1/session", { method: "POST", body: JSON.stringify({ secret }) });
  expect(exchange.status).toBe(200);
  sessionToken = (JSON.parse(exchange.body) as { data: { token: string } }).data.token;
});

afterAll(() => {
  for (const close of cleanup.reverse()) close();
});

describe("AJ-12 web session and the local network boundary", () => {
  it("walks the browser session and the boundary checks", async () => {
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();

    // 1-2. The browser opens the fragment URL and the SPA exchanges the secret.
    // A fresh secret: the one used above is already spent, so issue another.
    const second = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
    const secondUrl = (JSON.parse(second.stdout) as { url: string }).url;
    await page.goto(secondUrl);
    await page.waitForFunction(() => window.document.querySelector("#session-note")?.textContent === "");
    expect(await page.evaluate(() => sessionStorage.getItem("sorage-session"))).toBeTruthy();
    // The fragment is cleared from the address bar.
    expect(await page.evaluate(() => window.location.hash)).toBe("");

    // The dashboard renders the review-state counts.
    await page.waitForSelector(".counts");
    expect(await page.textContent("main")).toContain("awaiting_recipient");

    // The inbox filter is URL-addressable and survives a reload.
    await page.goto(`http://127.0.0.1:${port}/#/inbox?state=awaiting_recipient`);
    await page.waitForSelector("table tbody tr");
    expect(await page.$$eval("table tbody tr", (rows) => rows.length)).toBeGreaterThan(0);
    const filteredUrl = await page.evaluate(() => window.location.href);
    await page.reload();
    await page.waitForSelector("table tbody tr");
    expect(await page.$$eval("table tbody tr", (rows) => rows.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.location.href)).toBe(filteredUrl);
    expect(await page.getByLabel("Include archived").count()).toBe(1);
    expect(await page.getByLabel("Include deleted").count()).toBe(1);

    // Every editable control and the Projects action column has a semantic name.
    await page.goto(`http://127.0.0.1:${port}/#/compose`);
    expect(await page.getByLabel("Title").count()).toBe(1);
    expect(await page.getByLabel("To").count()).toBe(1);
    expect(await page.getByLabel("Document").count()).toBe(1);
    await page.goto(`http://127.0.0.1:${port}/#/projects`);
    await page.waitForSelector("table tbody tr");
    expect(await page.getByRole("columnheader", { name: "Actions" }).count()).toBe(1);
    await page.goto(`http://127.0.0.1:${port}/#/settings`);
    expect(await page.getByLabel("Default page size").count()).toBe(1);
    expect(await page.getByLabel("Inbox marker").count()).toBe(1);

    // The detail view shows the identity, revision, and row version.
    await page.goto(filteredUrl);
    await page.waitForSelector("table tbody tr");
    const detailHref = await page.$eval("table tbody a", (link) => link.getAttribute("href"));
    await page.goto(`http://127.0.0.1:${port}${detailHref ?? ""}`);
    await page.waitForSelector("dl.meta");
    const detailText = await page.textContent("main");
    expect(detailText).toContain("revision");
    expect(detailText).toContain("row version");
    expect(detailText).toContain("next actor");

    // 3. A replayed secret is refused with UNAUTHENTICATED at 401.
    const replay = await raw("/api/v1/session", {
      method: "POST",
      body: JSON.stringify({ secret: /#s=(.+)$/.exec(secondUrl)?.[1] }),
    });
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.body)).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    // 4. Direct navigation without a session renders a refusal and fetches nothing.
    const bare = await browser.newPage();
    await bare.goto(`http://127.0.0.1:${port}/`);
    await bare.waitForSelector("#session-note");
    expect(await bare.textContent("#session-note")).toContain("sorage web");
    await bare.close();

    // 5. A mismatched Host is rejected with HOST_NOT_ALLOWED at 421 before
    //    routing and before authentication, while every allowlisted name works.
    const rebinding = await raw("/api/v1/handoffs?asUser=true", {
      host: `attacker.example:${port}`,
      bearer: sessionToken,
    });
    expect(rebinding.status).toBe(421);
    expect(JSON.parse(rebinding.body)).toMatchObject({ error: { code: "HOST_NOT_ALLOWED" } });
    for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
      const allowed = await raw("/api/v1/health", { host: `${name}:${port}` });
      expect(allowed.status).toBe(200);
    }

    // 6. A request without an Authorization header is UNAUTHENTICATED.
    const anonymous = await raw("/api/v1/handoffs?asUser=true");
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body)).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    // 7. Every response carries the three security headers and never Set-Cookie.
    for (const response of [
      rebinding,
      anonymous,
      await raw("/api/v1/health"),
      await raw("/api/v1/handoffs?asUser=true", { bearer: sessionToken }),
    ]) {
      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }

    // 8. Rotation invalidates the live browser session.
    expect(sorage(["token", "rotate", "--as-user", "--json"], { home }).status).toBe(0);
    const invalidated = await raw("/api/v1/handoffs?asUser=true", { bearer: sessionToken });
    expect(invalidated.status).toBe(401);
    expect(JSON.parse(invalidated.body)).toMatchObject({ error: { code: "TOKEN_INVALID" } });
  }, 60000);
});
