import { expect as browserExpect } from "@playwright/test";
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

describe("AJ-21-B: explicit recovery abandonment", () => {
  it("cancels or atomically abandons A, then keeps a late A response from clearing or painting B", async () => {
    const f = await fixture();
    const release: Array<() => void> = [];
    const delivered: number[] = [];
    const requests: Array<{ key: string; mode: string }> = [];
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      const index = requests.length;
      requests.push({
        key: route.request().headers()["idempotency-key"] as string,
        mode: route.request().headers()["idempotency-mode"] as string,
      });
      const response = await route.fetch();
      await new Promise<void>((resolve) => {
        release[index] = resolve;
      });
      await route.fulfill({ response });
      delivered.push(index);
    });
    try {
      await f.list();
      await createThroughUi(f.page, "Unknown A", "Private A body");
      await browserExpect.poll(() => release.length).toBe(1);
      const original = (await recovery(f.page)).active;
      const before = f.inventory();
      f.page.once("dialog", (dialog) => dialog.dismiss());
      await f.page.getByRole("button", { name: "Abandon retry and continue", exact: true }).click();
      expect((await recovery(f.page)).active).toEqual(original);
      f.page.once("dialog", (dialog) => dialog.accept());
      await f.page.getByRole("button", { name: "Abandon retry and continue", exact: true }).click();
      await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeEnabled();
      expect(f.inventory()).toEqual(before);
      const abandoned = await recovery(f.page);
      expect(abandoned.active).toBeNull();
      expect(abandoned.notices).toHaveLength(1);
      expect(abandoned.notices[0]).toMatchObject({
        key: original?.key,
        outcome: "unknown",
        retryDisposition: "abandoned",
      });
      expect(abandoned.notices[0]).not.toHaveProperty("input");
      expect(abandoned.notices[0]).not.toHaveProperty("body");
      expect(requests).toHaveLength(1);
      await createThroughUi(f.page, "Unrelated B", "B body");
      await browserExpect.poll(() => release.length).toBe(2);
      const pendingB = (await recovery(f.page)).active;
      expect(pendingB?.key).not.toBe(original?.key);
      release[0]?.();
      await browserExpect.poll(() => delivered).toContain(0);
      expect((await recovery(f.page)).active).toEqual(pendingB);
      await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
      expect(new URL(f.page.url()).hash).toContain("/memos?");
      expect((await recovery(f.page)).notices[0]).toMatchObject({ outcome: "unknown", retryDisposition: "abandoned" });
      release[1]?.();
      await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
      await browserExpect(f.page.locator("main h3")).toHaveText("Unrelated B");
      await f.page.reload();
      await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
      expect((await recovery(f.page)).active).toBeNull();
      expect((await recovery(f.page)).notices).toHaveLength(1);
      expect(requests.map((request) => request.mode)).toEqual(["execute", "execute"]);
      await f.page.locator("#memo-recovery summary").click();
      const copy = f.page.getByLabel(`Copy unknown-outcome notice ${original?.key}`, { exact: true });
      expect(await copy.inputValue()).not.toContain("Private A body");
      await copy.focus();
      await f.page.keyboard.press("Meta+A");
      await f.page.setViewportSize({ width: 390, height: 844 });
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await f.page.screenshot({ path: "/tmp/sorage-aj21-mobile-notice.png", fullPage: true });
    } finally {
      for (const resume of release) resume();
    }
  });

  it("keeps the active gate on failed abandonment and requires explicit notice removal at the 32-notice limit", async () => {
    const f = await fixture();
    let sends = 0;
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      sends++;
      await route.fetch();
      await route.abort("failed");
    });
    await f.list();
    await createThroughUi(f.page, "Active A", "Do not retain this in a passive notice");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    const original = (await recovery(f.page)).active;
    await f.page.evaluate((key) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new Error("quota");
        return set.call(this, name, value);
      };
    }, MEMO_STORAGE);
    f.page.once("dialog", (dialog) => dialog.accept());
    await f.page.getByRole("button", { name: "Abandon retry and continue", exact: true }).click();
    expect((await recovery(f.page)).active).toEqual(original);
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
    expect(sends).toBe(1);
    await f.page.reload();
    await f.page.evaluate((key) => {
      const value = JSON.parse(sessionStorage.getItem(key) as string);
      const { input, ...metadata } = value.active;
      value.notices = Array.from({ length: 32 }, (_, index) => ({
        ...metadata,
        key: crypto.randomUUID(),
        title: `Older notice ${index}`,
        expectedRowVersion: input.expectedRowVersion || null,
        abandonedAt: new Date().toISOString(),
        outcome: "unknown",
        retryDisposition: "abandoned",
      }));
      sessionStorage.setItem(key, JSON.stringify(value));
    }, MEMO_STORAGE);
    await f.page.reload();
    await f.page.getByRole("button", { name: "Abandon retry and continue", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("32 unknown-outcome notices");
    expect((await recovery(f.page)).active).toEqual(original);
    expect((await recovery(f.page)).notices).toHaveLength(32);
    const oldest = f.page.locator("#memo-recovery details").first();
    await oldest.locator("summary").click();
    f.page.once("dialog", (dialog) => dialog.accept());
    await oldest.getByRole("button", { name: "Remove browser-only notice", exact: true }).click();
    expect((await recovery(f.page)).notices).toHaveLength(31);
    f.page.once("dialog", (dialog) => dialog.accept());
    await f.page.getByRole("button", { name: "Abandon retry and continue", exact: true }).click();
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeEnabled();
    const final = await recovery(f.page);
    expect(final.active).toBeNull();
    expect(final.notices).toHaveLength(32);
    expect(final.notices.at(-1)?.key).toBe(original?.key);
    expect(sends).toBe(1);
  });
});
