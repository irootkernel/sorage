import { expect as browserExpect } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanups } from "./helpers";
import { memoBrowserFixture, recovery } from "./memo-browser-fixture";

const fixtures: Awaited<ReturnType<typeof memoBrowserFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  runCleanups();
});

describe("AJ-21-B: edits made while a submitted write settles", () => {
  it.each([
    ["add", "delayed"],
    ["add", "replay-only"],
    ["update", "delayed"],
    ["update", "replay-only"],
  ] as const)("preserves the later %s draft after %s settlement", async (operation, mode) => {
    const f = await memoBrowserFixture();
    fixtures.push(f);
    const existing = operation === "update" ? f.add("Initial", "Initial body") : null;
    let release: (() => void) | undefined;
    const requests: string[] = [];
    await f.page.route("**/api/v1/memos**", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      requests.push(route.request().headers()["idempotency-mode"] as string);
      if (requests.length !== 1) return route.continue();
      const response = await route.fetch();
      if (mode === "replay-only") return route.abort("failed");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    });
    try {
      if (existing) await f.page.goto(`${f.origin}/#/memo/${existing.id}`);
      else await f.list();
      await f.page.getByLabel("Memo title", { exact: true }).fill("Submitted A");
      await f.page.getByLabel("Memo body", { exact: true }).fill("Submitted A body");
      await f.page.getByRole("button", { name: existing ? "Save Memo" : "Create Memo", exact: true }).click();
      if (mode === "replay-only")
        await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
      else await browserExpect.poll(() => Boolean(release)).toBe(true);
      const pending = (await recovery(f.page)).active;
      expect(pending).not.toBeNull();
      await f.page.getByLabel("Memo title", { exact: true }).fill("Later B");
      await f.page.getByLabel("Memo body", { exact: true }).fill("Later B body\n한글");
      if (mode === "replay-only")
        await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
      else release?.();
      await browserExpect(f.page.locator("main h3")).toHaveText("Submitted A");
      await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
      await browserExpect(f.page.getByLabel("Memo title", { exact: true })).toHaveValue("Later B");
      await browserExpect(f.page.getByLabel("Memo body", { exact: true })).toHaveValue("Later B body\n한글");
      expect((await recovery(f.page)).active).toBeNull();
      const id = new URL(f.page.url()).hash.split("/").at(-1) as string;
      expect(f.show(id)).toMatchObject({
        title: "Submitted A",
        body: "Submitted A body",
        rowVersion: existing ? 2 : 1,
      });
      expect(requests).toEqual(mode === "replay-only" ? ["execute", "replay-only"] : ["execute"]);
      await f.page.getByRole("button", { name: "Save Memo", exact: true }).click();
      await browserExpect(f.page.locator("main h3")).toHaveText("Later B");
      await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
      expect(f.show(id)).toMatchObject({ title: "Later B", body: "Later B body\n한글", rowVersion: existing ? 3 : 2 });
    } finally {
      release?.();
    }
  });
});
