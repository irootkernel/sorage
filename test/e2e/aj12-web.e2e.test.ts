import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    expect(await page.getByLabel("Body").count()).toBe(1);
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

describe("T130-R1-001 existing Web proposal retention", () => {
  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])("retains the rejected note and original observations on $name until explicit inspection", async (viewport) => {
    const evidenceDir = process.env.SORAGE_UI_EVIDENCE_DIR ?? makeTempDir("sorage-aj12-conflict-evidence-");
    mkdirSync(evidenceDir, { recursive: true });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const consoleMessages: Array<{ type: string; text: string }> = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        consoleMessages.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const proof: Record<string, unknown> = {
      browser: "Playwright Chromium",
      browserAvailability: "Browser plugin not available",
      viewport,
      consoleMessages,
      pageErrors,
    };
    try {
      const sent = sorage(
        [
          "send",
          "--as-user",
          "--to",
          "web-app",
          "--title",
          `Conflict ${viewport.name}`,
          "--body",
          "Conflict document",
          "--json",
        ],
        { home },
      );
      expect(sent.status, sent.stderr).toBe(0);
      const id = JSON.parse(sent.stdout).data.handoffs[0].handoffId as string;
      const entry = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
      expect(entry.status, entry.stderr).toBe(0);
      await page.goto(JSON.parse(entry.stdout).url as string);
      await page.waitForSelector(".counts");
      const detailUrl = `http://127.0.0.1:${port}/#/handoff/${id}`;
      await page.goto(detailUrl);
      await page.waitForSelector("dl.meta");
      await page.waitForLoadState("networkidle");
      expect(page.url()).toBe(detailUrl);
      expect(await page.title()).toBe("Sorage");
      expect((await page.locator("main").innerText()).length).toBeGreaterThan(100);
      expect(await page.locator("nextjs-portal, vite-error-overlay, webpack-dev-server-client-overlay").count()).toBe(
        0,
      );
      await page.screenshot({ path: join(evidenceDir, `${viewport.name}-initial.png`), fullPage: false });
      const proposal = " Keep this exact proposal: <script>untrusted</script>\nSecond line 가 with trailing space ";
      const note = page.getByRole("textbox", { name: "Review note", exact: true });
      await note.fill(proposal);
      const originalNode = await note.elementHandle();
      if (originalNode === null) throw new Error("the note textarea is absent");
      const filePath = join(home, `retained-${viewport.name}.md`);
      writeFileSync(filePath, "Retain selected file");
      await page.getByLabel("Replacement document").setInputFiles(filePath);
      const confirmation = `retained confirmation ${viewport.name}`;
      await page.getByLabel("Pinned deletion confirmation").fill(confirmation);
      let detailGets = 0;
      const writes: unknown[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === "GET" && path === `/api/v1/handoffs/${id}`) detailGets++;
        if (request.method() === "PUT" && path === `/api/v1/handoffs/${id}/review-note`)
          writes.push(request.postDataJSON());
      });
      const winner = sorage(
        [
          "review",
          "set",
          id,
          "--as-user",
          "--text",
          "Competing same-Revision writer",
          "--target-revision",
          "1",
          "--expected-row-version",
          "1",
          "--json",
        ],
        { home },
      );
      expect(winner.status, winner.stderr).toBe(0);
      const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"), { readOnly: true });
      const state = () =>
        Object.fromEntries(
          ["handoffs", "review_notes", "events"].map((table) => [
            table,
            db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          ]),
        );
      const before = state();
      try {
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            new URL(response.url()).pathname === `/api/v1/handoffs/${id}/review-note`,
        );
        await page.getByRole("button", { name: "Set note", exact: true }).click();
        const response = await responsePromise;
        expect(response.status()).toBe(409);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "ROW_VERSION_CONFLICT" } });
        await page.waitForFunction(
          () =>
            document.querySelector("main")?.textContent?.includes("ROW_VERSION_CONFLICT") ||
            (document.querySelector('textarea[aria-label="Review note"]') as HTMLTextAreaElement | null)?.value === "",
        );
        proof.url = page.url();
        proof.title = await page.title();
        proof.originalNodeConnected = await originalNode.evaluate((node) => node.isConnected);
        proof.draft = await note.inputValue();
        proof.detailGetsAfterConflict = detailGets;
        proof.writesAfterConflict = [...writes];
        await page.screenshot({ path: join(evidenceDir, `${viewport.name}-conflict.png`), fullPage: true });
        expect(proof.originalNodeConnected).toBe(true);
        expect(await note.inputValue()).toBe(proposal);
        expect(await page.locator("main").innerText()).toContain("ROW_VERSION_CONFLICT");
        expect(detailGets).toBe(0);
        expect(writes).toEqual([{ text: proposal, targetRevision: 1, expectedRowVersion: 1, asUser: true }]);
        expect(
          await page.getByLabel("Replacement document").evaluate((node) => (node as HTMLInputElement).files?.[0]?.name),
        ).toBe(`retained-${viewport.name}.md`);
        expect(await page.getByLabel("Pinned deletion confirmation").inputValue()).toBe(confirmation);
        expect(state()).toEqual(before);
        const retry = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            new URL(response.url()).pathname === `/api/v1/handoffs/${id}/review-note`,
        );
        await page.getByRole("button", { name: "Set note", exact: true }).click();
        expect((await retry).status()).toBe(409);
        expect(writes).toHaveLength(2);
        expect(writes[1]).toEqual(writes[0]);
        expect(detailGets).toBe(0);
        expect(state()).toEqual(before);
        // Browser reload is an explicit inspection. Only this deliberate step
        // acquires V2; the successful write still performs its normal reload.
        await page.reload();
        await page.waitForSelector("dl.meta");
        await page.waitForLoadState("networkidle");
        const afterInspectionGets = detailGets;
        const reconciled = "Explicitly reconciled report";
        await page.getByRole("textbox", { name: "Review note", exact: true }).fill(reconciled);
        const success = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            new URL(response.url()).pathname === `/api/v1/handoffs/${id}/review-note`,
        );
        await page.getByRole("button", { name: "Set note", exact: true }).click();
        expect((await success).status()).toBe(200);
        await page.waitForSelector("dl.meta");
        await page.waitForLoadState("networkidle");
        expect(detailGets).toBe(afterInspectionGets + 1);
        expect(writes[2]).toEqual({ text: reconciled, targetRevision: 1, expectedRowVersion: 2, asUser: true });
        expect(db.prepare("SELECT body FROM review_notes WHERE handoff_id=?").get(id)).toEqual({ body: reconciled });
        expect(await page.getByRole("textbox", { name: "Review note", exact: true }).inputValue()).toBe("");
        expect(pageErrors).toEqual([]);
        expect(consoleMessages.filter((message) => !/status of 409/.test(message.text))).toEqual([]);
        await page.screenshot({ path: join(evidenceDir, `${viewport.name}-success.png`), fullPage: false });
        Object.assign(proof, {
          pass: true,
          noAutomaticReloadOrRetry: true,
          originalObservationsRetained: true,
          rejectedStateUnchanged: true,
          successReload: true,
          writes,
          finalDetailGets: detailGets,
          pageIdentity: true,
          nonblank: true,
          noFrameworkOverlay: true,
        });
      } finally {
        db.close();
      }
    } finally {
      writeFileSync(join(evidenceDir, `${viewport.name}-proof.json`), `${JSON.stringify(proof, null, 2)}\n`);
      await browser.close();
    }
  });
});
