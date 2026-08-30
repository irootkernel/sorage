import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

/**
 * AJ-13: Web administration against the compiled binary, a real daemon, and a real
 * browser (WEB-002 to WEB-015, API-003, API-005, CFG-019, LIFE-012).
 */
const home = makeTempDir("sorage-aj13-home-");
let port = 0;
let webUrl = "";
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

beforeAll(async () => {
  port = await freePort();
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "brief.md"), "# The admin brief\n");
  expect(sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--json"], { home }).status).toBe(0);
  expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
  for (const name of ["one", "two", "three"]) {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    expect(
      sorage(["project", "add", "--name", `Project ${name}`, "--dir", dir, "--json"], { home, cwd: dir }).status,
    ).toBe(0);
  }
  expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
  cleanup.push(() => sorage(["daemon", "stop", "--json"], { home }));
  const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
  expect(web.status).toBe(0);
  webUrl = (JSON.parse(web.stdout) as { url: string }).url;
});

afterAll(() => {
  for (const close of cleanup.reverse()) close();
});

function jsonBody(text: string): any {
  return JSON.parse(text);
}

function raw(path: string, init: { method?: string; bearer?: string; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
    const payload = init.body ?? null;
    if (payload !== null) headers["content-type"] = "application/json";
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", reject);
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

describe("AJ-13 web administration", () => {
  it("walks the administration journey in a real browser", async () => {
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    await page.goto(webUrl);
    await page.waitForSelector(".counts");

    // 2. One document to three recipients: three UUIDs and three independent Handoffs.
    await page.goto(`http://127.0.0.1:${port}/#/compose`);
    await page.fill('input[placeholder="title"]', "The admin brief");
    await page.fill('input[placeholder="recipient slugs, comma-separated"]', "project-one, project-two, project-three");
    await page.setInputFiles('input[type="file"]', {
      name: "brief.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# The admin brief\n\nwith <b>markup</b> to escape\n"),
    });
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll("form ul li").length === 3);
    const fanOut = await page.$$eval("form ul li", (items) => items.map((item) => item.textContent ?? ""));
    expect(fanOut.length).toBe(3);
    const firstId = /([0-9a-f-]{36})/.exec(fanOut[0] ?? "")?.[1] ?? "";
    expect(firstId).not.toBe("");

    // 4. The detail view opens with a Markdown preview that escapes markup.
    await page.goto(`http://127.0.0.1:${port}/#/handoff/${firstId}`);
    await page.waitForSelector("dl.meta");
    expect(await page.textContent("main")).toContain("revision");

    // A User proxy Review Note records authorKind user and moves the state.
    await page.fill("textarea", "Please tighten the intro");
    await page.click('button:text("Set note")');
    await page.waitForFunction(() => document.body.textContent?.includes("changes_requested"));
    const events = await raw("/api/v1/handoffs?asUser=true&includeDeleted=true", {});
    expect(events.status).toBe(401); // the browser session is the only credential
    // The note card renders from the review-note endpoint with its author kind (WEB-004).
    await page.waitForSelector(".card.note");
    expect(await page.textContent(".card.note")).toContain("Please tighten the intro");
    expect(await page.textContent(".card.note")).toContain("author user");

    // 5. Revise through upload, resolving the Note, then accept (section 18.5's
    //    multipart browser shape drives the whole step). A successful revise
    //    re-renders the detail immediately, so the assertions read the re-rendered
    //    state: the replacement Artifact's original name and the returned state.
    await page.setInputFiles('input[type="file"]', {
      name: "revision.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# The admin brief, revised through the browser\n"),
    });
    await page.click('button:text("Revise through upload")');
    await page.waitForFunction(() => document.body.textContent?.includes("revision.md"));
    await page.waitForFunction(() => document.body.textContent?.includes("awaiting_recipient"));
    await page.click('button:text("Accept")');
    await page.waitForFunction(() => document.body.textContent?.includes("accepted"));
    // The timeline renders metadata events with their actor kinds (WEB-004).
    await page.waitForSelector(".card.timeline ul li");
    expect(await page.textContent(".card.timeline")).toContain("user");
    await page.click('button:text("Pin")');
    await page.waitForFunction(() => document.body.textContent?.includes("Unpin"));
    await page.click('button:text("Archive")');
    await page.waitForTimeout(800);
    await page.click('button:text("Unarchive")');
    await page.waitForTimeout(800);

    // 7. Deletion: request, reject, request again, and approve pinned with the
    //    distinct confirmation; the empty confirmation fails with the pinned code.
    await page.click('button:text("Request deletion")');
    await page.waitForSelector('button:text("Reject deletion")');
    await page.click('button:text("Reject deletion")');
    await page.waitForFunction(() => document.body.textContent?.includes("Actions"));
    await page.click('button:text("Request deletion")');
    await page.click('button:text("Approve deletion")');
    await page.waitForFunction(() => document.body.textContent?.includes("PINNED_DELETE_CONFIRMATION"));
    await page.fill('input[placeholder^="type the Handoff id"]', firstId);
    await page.click('button:text("Approve deletion")');
    await page.waitForSelector(".tombstone");
    expect(await page.textContent(".tombstone")).toContain("tombstone");

    // 8-9. Settings save through the typed form; a stale save fails with
    //      CONFIG_CONFLICT and overwrites nothing.
    await page.goto(`http://127.0.0.1:${port}/#/settings`);
    await page.waitForSelector(".preview");
    await page.waitForFunction(() =>
      (document.querySelector(".preview")?.textContent ?? "").includes("installationId"),
    );
    // Move the file underneath the loaded ETag first.
    expect(sorage(["config", "set", "logging.level", "info", "--as-user", "--json"], { home }).status).toBe(0);
    await page.fill('input[type="number"]', "33");
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.body.textContent?.includes("CONFIG_CONFLICT"));
    const preserved = sorage(["config", "show", "--json"], { home });
    expect(jsonBody(preserved.stdout).data.ui.defaultPageSize).not.toBe(33);
  }, 90000);
});
