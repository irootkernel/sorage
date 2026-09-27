import { chromium, expect as browserExpect } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanups } from "./helpers";
import { memoBrowserFixture, recovery, createThroughUi, MEMO_STORAGE } from "./memo-browser-fixture";

const fixtures: Awaited<ReturnType<typeof memoBrowserFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  runCleanups();
});
async function fixture() {
  const f = await memoBrowserFixture();
  fixtures.push(f);
  return f;
}
async function settled(f: Awaited<ReturnType<typeof fixture>>, version: number) {
  await browserExpect(f.page.locator("dl.meta")).toContainText(String(version));
  await f.page.waitForFunction((key) => {
    const value = sessionStorage.getItem(key);
    return value && JSON.parse(value).active === null;
  }, MEMO_STORAGE);
  await browserExpect(
    f.page.getByRole("button", { name: "Re-read current Memo (keep draft)", exact: true }),
  ).toBeVisible();
}

describe("AJ-21-B: separate Memo browser workflow", () => {
  it("creates, edits, closes, filters and safely renders real Memos with keyboard and composition guards", async () => {
    const f = await fixture();
    const { page } = f;
    const remote: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(f.origin)) remote.push(request.url());
    });
    await f.list();
    await page.screenshot({ path: "/tmp/sorage-aj21-desktop.png", fullPage: true });
    expect(await page.getByLabel("Memo state", { exact: true }).inputValue()).toBe("open");
    const body =
      "한글 😀\nSecond line\n<img src=https://attacker.invalid/a onerror=alert(1)>\n[unsafe](javascript:alert(1))\n![remote](https://attacker.invalid/b)";
    await page.getByLabel("Memo title", { exact: true }).fill("한국어 reminder");
    await page.getByLabel("Memo body", { exact: true }).focus();
    await page.getByLabel("Memo body", { exact: true }).dispatchEvent("compositionstart");
    await page.keyboard.insertText(body);
    await page.getByLabel("Memo body", { exact: true }).dispatchEvent("keydown", { key: "Enter", isComposing: true });
    expect((await recovery(page)).active).toBeNull();
    await page.getByLabel("Memo body", { exact: true }).dispatchEvent("compositionend");
    await page.getByRole("button", { name: "Create Memo", exact: true }).focus();
    await page.keyboard.press("Enter");
    await settled(f, 1);
    const id = new URL(page.url()).hash.split("/").at(-1) as string;
    expect(f.show(id).body).toBe(body);
    expect(await page.locator("main img, main script, main iframe").count()).toBe(0);
    expect(remote).toEqual([]);
    expect(await page.getByRole("button", { name: "Accepted", exact: true }).count()).toBe(0);
    expect(await page.getByLabel("To", { exact: true }).count()).toBe(0);
    await page.getByLabel("Memo title", { exact: true }).fill("Edited");
    await page.getByRole("button", { name: "Save Memo", exact: true }).click();
    await settled(f, 2);
    expect(f.show(id).title).toBe("Edited");
    await page.getByRole("button", { name: "Mark done", exact: true }).click();
    await browserExpect(page.getByRole("button", { name: "Reopen", exact: true })).toBeEnabled();
    expect(f.show(id).state).toBe("done");
    expect(await page.getByLabel("Memo body", { exact: true }).count()).toBe(0);
    await page.goto(`${f.origin}/#/memos?projectId=${f.project}&state=done`);
    await browserExpect(page.locator(".memo-row")).toHaveCount(1);
    expect(await page.getByLabel("Memo state", { exact: true }).inputValue()).toBe("done");
    await page.getByRole("link", { name: "Edited", exact: true }).click();
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await browserExpect(page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await browserExpect(page.getByRole("button", { name: "Reopen", exact: true })).toBeEnabled();
    await f.list();
    expect(await page.locator(".memo-row").count()).toBe(0);
    await page.getByLabel("Memo state", { exact: true }).selectOption("dismissed");
    await page.getByRole("button", { name: "Apply Memo filters", exact: true }).click();
    await browserExpect(page.locator(".memo-row")).toHaveCount(1);
    for (let index = 1; index <= 10; index++) f.add(`More ${index}`);
    f.add("Beta visible", "", "beta");
    await page.getByLabel("Memo Project", { exact: true }).selectOption("*");
    await page.getByLabel("Memo state", { exact: true }).selectOption("all");
    await page.getByRole("button", { name: "Apply Memo filters", exact: true }).click();
    await browserExpect(page.locator(".memo-row")).toHaveCount(10);
    await page.getByRole("link", { name: "Next Memo page", exact: true }).click();
    await browserExpect(page.locator(".memo-row")).toHaveCount(2);
    await page.getByLabel("Search Memos", { exact: true }).fill("Beta visible");
    await page.getByRole("button", { name: "Apply Memo filters", exact: true }).click();
    await browserExpect(page.locator(".memo-row")).toHaveCount(1);
    await browserExpect(page.locator(".memo-row")).toContainText("Beta");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await browserExpect(page.locator(".counts")).toBeVisible();
    await f.browser.close();
    const restartedBrowser = await chromium.launch();
    try {
      const restartedPage = await restartedBrowser.newPage();
      await f.authenticate(restartedPage);
      await restartedPage.goto(`${f.origin}/#/memo/${id}`);
      await browserExpect(restartedPage.getByLabel("Full Memo body", { exact: true })).toContainText("Second line");
      await browserExpect(restartedPage.locator("main h3")).toHaveText("Edited");
      expect((await recovery(restartedPage)).active).toBeNull();
    } finally {
      await restartedBrowser.close();
    }
  });

  it("preserves exact CRLF when only the title changes and keeps a conflicting draft for a new explicit save", async () => {
    const f = await fixture();
    const memo = f.add("CRLF", "one\r\n한글\r\n");
    await f.page.goto(`${f.origin}/#/memo/${memo.id}`);
    await f.page.getByLabel("Memo title", { exact: true }).fill("New title");
    await f.page.getByRole("button", { name: "Save Memo", exact: true }).click();
    await settled(f, 2);
    expect(f.show(memo.id).body).toBe(memo.body);
    await f.page.getByLabel("Memo body", { exact: true }).fill("Unsaved draft\n한글");
    f.run(["memo", "update", memo.id, "--body", "Other client", "--expected-row-version", "2"]);
    await f.page.getByRole("button", { name: "Save Memo", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("ROW_VERSION_CONFLICT");
    await settled(f, 3);
    expect(await f.page.getByLabel("Memo body", { exact: true }).inputValue()).toBe("Unsaved draft\n한글");
    expect(f.show(memo.id).body).toBe("Other client");
    await f.page.getByRole("button", { name: "Save Memo", exact: true }).click();
    await settled(f, 4);
    expect(f.show(memo.id).body).toBe("Unsaved draft\n한글");
    f.run(["project", "archive", "alpha", "--as-user"]);
    await f.page.reload();
    await browserExpect(f.page.locator("main")).toContainText("Archived Project");
    await f.page.getByRole("button", { name: "Mark done", exact: true }).click();
    await browserExpect(f.page.getByRole("button", { name: "Reopen", exact: true })).toBeDisabled();
    await f.page.goto(`${f.origin}/#/memos?projectId=${f.project}`);
    await browserExpect(f.page.locator("main")).toContainText("This Project is archived");
    expect(await f.page.getByRole("button", { name: "Create Memo", exact: true }).count()).toBe(0);
  });

  it("retains one lost request across every other write, navigation and reload, then recovers only its original receipt", async () => {
    const f = await fixture();
    const open = f.add("Other open", "body", "beta");
    const closed = f.add("Other closed", "body", "beta");
    f.run(["memo", "done", closed.id, "--expected-row-version", "1"]);
    let lost = false;
    const mutations: Array<{ path: string; key: string | undefined; mode: string | undefined }> = [];
    await f.page.route("**/api/v1/memos**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.continue();
      mutations.push({
        path: request.url(),
        key: request.headers()["idempotency-key"],
        mode: request.headers()["idempotency-mode"],
      });
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await f.list();
    await createThroughUi(f.page, "Lost A", "Exact\nbody");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    const original = (await recovery(f.page)).active;
    expect(original).not.toBeNull();
    const afterOriginal = f.inventory();
    await f.list(f.other);
    await f.page.getByLabel("Memo title", { exact: true }).fill("B cannot send");
    await f.page.getByRole("button", { name: "Create Memo", exact: true }).dispatchEvent("click");
    for (const memo of [open, closed]) {
      await f.page.goto(`${f.origin}/#/memo/${memo.id}`);
      await f.page.getByRole("button", { name: "Re-read current Memo (keep draft)", exact: true }).waitFor();
      for (const button of await f.page.locator("[data-memo-write]").all()) {
        await browserExpect(button).toBeDisabled();
        await button.dispatchEvent("click");
      }
    }
    await f.page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await browserExpect(f.page.locator(".counts")).toBeVisible();
    await f.list();
    await f.page.reload();
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
    expect((await recovery(f.page)).active).toEqual(original);
    expect(mutations).toHaveLength(1);
    expect(f.inventory()).toEqual(afterOriginal);
    // Another authenticated tab remains independent of this tab's pending state.
    const otherTab = await f.browser.newPage();
    await f.authenticate(otherTab);
    await f.list(f.other, otherTab);
    await createThroughUi(otherTab, "Independent tab");
    await browserExpect(otherTab.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
    await otherTab.close();
    const beforeRecovery = f.inventory();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).dblclick();
    await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({ key: original?.key, mode: "replay-only" });
    expect((await recovery(f.page)).active).toBeNull();
    expect(f.inventory()).toEqual(beforeRecovery);
  });
});
