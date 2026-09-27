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

describe("AJ-21-B: storage and response failure boundaries", () => {
  it("refuses incomplete retained inputs but permits explicit metadata-only abandonment", async () => {
    const f = await fixture();
    let sends = 0;
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      sends++;
      await route.fetch();
      await route.abort("failed");
    });
    await f.list();
    await createThroughUi(f.page, "Missing original body", "Body");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    await f.page.evaluate((key) => {
      const value = JSON.parse(sessionStorage.getItem(key) as string);
      delete value.active.input.body;
      sessionStorage.setItem(key, JSON.stringify(value));
    }, MEMO_STORAGE);
    await f.page.reload();
    const before = f.inventory();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Original request material");
    expect(sends).toBe(1);
    expect(f.inventory()).toEqual(before);
    f.page.once("dialog", (dialog) => dialog.accept());
    await f.page.getByRole("button", { name: "Abandon retry and continue", exact: true }).click();
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeEnabled();
    expect((await recovery(f.page)).notices).toHaveLength(1);
    expect(sends).toBe(1);
  });
  it.each(["read", "write", "malformed"])("blocks first dispatch on %s recovery storage failure", async (failure) => {
    const f = await fixture();
    let sends = 0;
    f.page.on("request", (request) => {
      if (request.url().includes("/api/v1/memos") && request.method() !== "GET") sends++;
    });
    const before = f.inventory();
    await f.list();
    if (failure === "write") {
      await f.page.evaluate((key) => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name, value) {
          if (name === key) throw new Error("quota");
          return set.call(this, name, value);
        };
      }, MEMO_STORAGE);
      await createThroughUi(f.page, "Draft preserved", "No dispatch");
    } else {
      if (failure === "malformed")
        await f.page.evaluate(
          (key) => sessionStorage.setItem(key, '{"version":1,"active":{"incomplete":true},"notices":[]}'),
          MEMO_STORAGE,
        );
      else
        await f.page.addInitScript((key) => {
          const get = Storage.prototype.getItem;
          Storage.prototype.getItem = function (name) {
            if (name === key) throw new Error("denied");
            return get.call(this, name);
          };
        }, MEMO_STORAGE);
      await f.page.reload();
      await f.page.getByLabel("Memo title", { exact: true }).fill("Blocked draft");
      await f.page.getByRole("button", { name: "Create Memo", exact: true }).dispatchEvent("click");
    }
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("storage");
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
    expect(sends).toBe(0);
    expect(f.inventory()).toEqual(before);
  });

  it("keeps writes blocked if clearing a confirmed active record fails, then safely recovers after reload", async () => {
    const f = await fixture();
    await f.list();
    await f.page.evaluate((key) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key && JSON.parse(value).active === null) throw new Error("clear failed");
        return set.call(this, name, value);
      };
    }, MEMO_STORAGE);
    await createThroughUi(f.page, "Committed but retained", "Exact request");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("could not be saved");
    const original = (await recovery(f.page)).active;
    expect(original).not.toBeNull();
    const before = f.inventory();
    expect(before[0]).toHaveLength(1);
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
    await f.page.reload();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
    expect((await recovery(f.page)).active).toBeNull();
    expect(f.inventory()).toEqual(before);
  });

  it("rejects visible input overflows and settles only a definitive original refusal while preserving the draft", async () => {
    const f = await fixture();
    await f.list();
    let sends = 0;
    f.page.on("request", (request) => {
      if (request.url().includes("/api/v1/memos") && request.method() !== "GET") sends++;
    });
    await createThroughUi(f.page, "x".repeat(201), "");
    await browserExpect(f.page.locator("main")).toContainText("201/200");
    await createThroughUi(f.page, "Valid title", "x".repeat(65537));
    await browserExpect(f.page.locator("main")).toContainText("65537/65536");
    expect(sends).toBe(0);
    expect((await recovery(f.page)).active).toBeNull();
    f.run(["project", "archive", "alpha", "--as-user"]);
    await createThroughUi(f.page, "Still my draft", "Preserve this");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("PROJECT_ARCHIVED");
    expect((await recovery(f.page)).active).toBeNull();
    expect(sends).toBe(1);
    expect(await f.page.getByLabel("Memo body", { exact: true }).inputValue()).toBe("Preserve this");
    expect(f.inventory()[0]).toHaveLength(0);
  });

  it("retains malformed success and later authentication failure as unknown without changing retry material", async () => {
    const f = await fixture();
    let count = 0;
    const modes: string[] = [];
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      modes.push(route.request().headers()["idempotency-mode"] ?? "missing");
      if (count++ === 0) {
        await route.fetch();
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"data":{}}' });
      } else await route.continue({ headers: { ...route.request().headers(), authorization: "Bearer invalid-token" } });
    });
    await f.list();
    await createThroughUi(f.page, "Malformed receipt");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Unrecognized response");
    const original = (await recovery(f.page)).active;
    const before = f.inventory();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("TOKEN_INVALID");
    expect((await recovery(f.page)).active).toEqual(original);
    expect(f.inventory()).toEqual(before);
    expect(modes).toEqual(["execute", "replay-only"]);
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
  });

  it("retains a timed-out request even after aborting its local fetch", async () => {
    const f = await fixture();
    await f.page.clock.install();
    let release = () => {};
    let held = false;
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      const response = await route.fetch();
      await new Promise<void>((resolve) => {
        release = resolve;
        held = true;
      });
      // An aborted browser request may no longer accept a response.
      await route.fulfill({ response }).catch(() => {});
    });
    try {
      await f.list();
      await createThroughUi(f.page, "Timed out");
      await browserExpect.poll(() => held).toBe(true);
      const original = (await recovery(f.page)).active;
      await f.page.clock.fastForward(15001);
      await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
      expect((await recovery(f.page)).active).toEqual(original);
      expect(f.inventory()[0]).toHaveLength(1);
      await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
    } finally {
      release();
    }
  });
});
