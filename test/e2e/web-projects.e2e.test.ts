import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

/**
 * The TASK-050 journey over the compiled binary and a real browser: the Web Project
 * surface behaves identically to the CLI on the same fixture (PRJ-016, PRJ-022,
 * WEB-009, WEB-010).
 */
const home = makeTempDir("sorage-web-projects-home-");
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
  const first = join(home, "first");
  mkdirSync(first, { recursive: true });
  writeFileSync(join(first, "note.md"), "# hi\n");
  expect(sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--json"], { home }).status).toBe(0);
  expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
  expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
  cleanup.push(() => sorage(["daemon", "stop", "--json"], { home }));
  const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
  webUrl = (JSON.parse(web.stdout) as { url: string }).url;
});

afterAll(() => {
  for (const close of cleanup.reverse()) close();
});

describe("the Web Project surface", () => {
  it("registers, binds, unbinds, renames, and archives identically to the CLI", async () => {
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    await page.goto(webUrl);
    await page.waitForSelector(".counts");
    await page.goto(`http://127.0.0.1:${port}/#/projects`);
    await page.waitForSelector('input[placeholder="display name"]');

    // Register a Project with its first binding.
    const firstDir = join(home, "first");
    await page.fill('input[placeholder="display name"]', "Web Surface");
    await page.fill('input[placeholder="directory"]', firstDir);
    await page.click('button:text("Register")');
    await page.waitForTimeout(1500);
    await page.waitForTimeout(600);
    const row = page.locator("tbody tr", { hasText: "web-surface" }).first();
    expect(await row.count()).toBe(1);

    // Add a second binding through the binding endpoint, then remove it. Every
    // interaction waits for the re-rendered row so a fill never lands on a
    // detached input and an action never fires with an empty directory.
    const secondDir = join(home, "second");
    mkdirSync(secondDir, { recursive: true });
    const bindInput = row.locator('input[placeholder="bind directory"]');
    await bindInput.waitFor({ state: "visible" });
    await bindInput.fill(secondDir);
    await row.locator('button:text-is("Bind")').click();

    await page.waitForTimeout(500);
    await row.locator('input[placeholder="bind directory"]').fill(secondDir);
    await row.locator('button:text-is("Unbind")').click();
    await page.waitForTimeout(1500);

    await page.waitForTimeout(500);

    // Rename, archive, and unarchive; the CLI sees the same fixture state.
    await row.locator('input[placeholder="new name"]').fill("Web Surface 2");
    await row.locator('button:text("Rename")').click();
    await page.waitForFunction(() => document.body.textContent?.includes("Web Surface 2"));
    await row.locator('button:text-is("Archive")').click();
    await page.waitForFunction(() => document.body.textContent?.includes("archived"));
    await row.locator('button:text-is("Unarchive")').click();
    await page.waitForFunction(() => !document.body.textContent?.includes("archived"));

    const cliView = sorage(["project", "show", "web-surface", "--json"], { home });
    expect(cliView.status).toBe(0);
    const shown = JSON.parse(cliView.stdout).data;
    expect(shown.project.displayName).toBe("Web Surface 2");
    expect(shown.project.status).toBe("active");
    expect(shown.bindings.length).toBe(1);

    // An unregistered Workspace shows in its own section and never as a recipient.
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "loose.md"), "# loose\n");
    expect(
      sorage(["send", "--to", "web-surface", "--title", "Loose", "--file", join(outside, "loose.md"), "--json"], {
        home,
        cwd: outside,
      }).status,
    ).toBe(0);
    await page.reload();
    await page.waitForSelector('input[placeholder="display name"]');
    await page.waitForFunction(() => document.body.textContent?.includes("sent Handoff"));
    expect(await page.textContent("main")).toContain("not a recipient");
  }, 90000);
});
