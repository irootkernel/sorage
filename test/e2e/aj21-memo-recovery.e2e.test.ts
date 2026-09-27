import { join } from "node:path";
import { expect as browserExpect } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanups, makeTempDir, registerCleanup, sorage } from "./helpers";
import { memoBrowserFixture, recovery, createThroughUi } from "./memo-browser-fixture";

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

describe("AJ-21-B: original-request recovery boundaries", () => {
  it("keeps a persistence-before-dispatch crash unknown and never executes its recovery", async () => {
    const f = await fixture();
    const before = f.inventory();
    let blocked = false;
    const modes: string[] = [];
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      modes.push(route.request().headers()["idempotency-mode"] ?? "missing");
      if (!blocked) {
        blocked = true;
        await route.abort("failed");
      } else await route.continue();
    });
    await f.list();
    await createThroughUi(f.page, "Never arrived", "Original input");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    const original = (await recovery(f.page)).active;
    expect(f.inventory()).toEqual(before);
    await f.page.reload();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("MEMO_REPLAY_UNAVAILABLE");
    expect(modes).toEqual(["execute", "replay-only"]);
    expect((await recovery(f.page)).active).toEqual(original);
    expect(f.inventory()).toEqual(before);
  });

  it("keeps an expired receipt unknown even when client time and original Installation still look valid", async () => {
    const f = await fixture();
    let lost = false;
    const modes: string[] = [];
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      modes.push(route.request().headers()["idempotency-mode"] ?? "missing");
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else {
        // Expire on the server after the browser has dispatched its recovery.
        f.sql(
          "UPDATE idempotency_keys SET expires_at=? WHERE key=?",
          "2000-01-01T00:00:00.000Z",
          route.request().headers()["idempotency-key"] as string,
        );
        await route.continue();
      }
    });
    await f.list();
    await createThroughUi(f.page, "Expired A");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    const original = (await recovery(f.page)).active;
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("MEMO_REPLAY_UNAVAILABLE");
    const before = f.inventory();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(
      f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }),
    ).toBeEnabled();
    expect(f.inventory()).toEqual(before);
    expect((await recovery(f.page)).active).toEqual(original);
    expect(modes).toEqual(["execute", "replay-only", "replay-only"]);
  });

  it.each([false, true])(
    "preserves a lost create after real same-Installation restore (snapshot after create: %s)",
    async (containsMemo) => {
      const f = await fixture();
      if (!containsMemo) f.run(["backup", "run", "--as-user"]);
      let lost = false;
      const modes: string[] = [];
      await f.page.route("**/api/v1/memos", async (route) => {
        if (route.request().method() === "GET") return route.continue();
        modes.push(route.request().headers()["idempotency-mode"] ?? "missing");
        if (!lost) {
          lost = true;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      });
      await f.list();
      await createThroughUi(f.page, "Restored A", "Retained input");
      await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
      const original = (await recovery(f.page)).active;
      if (containsMemo) f.run(["backup", "run", "--as-user"]);
      f.run(["daemon", "stop"]);
      const target = makeTempDir("aj21-restored-");
      f.run(["init", "--non-interactive"], target);
      f.run(["backup", "restore", "--from", join(f.home, "vault"), "--as-user", "--confirm"], target);
      f.run(["config", "set", "server.port", String(f.port), "--as-user"], target);
      f.run(["daemon", "start"], target);
      registerCleanup(() => {
        sorage(["daemon", "stop"], { home: target });
      });
      await f.authenticate(f.page, target);
      await f.list();
      expect((await recovery(f.page)).active).toEqual(original);
      const before = f.inventory(target);
      expect(before[0]).toHaveLength(containsMemo ? 1 : 0);
      await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
      await browserExpect(f.page.locator("#memo-recovery")).toContainText("MEMO_REPLAY_UNAVAILABLE");
      expect((await recovery(f.page)).active).toEqual(original);
      expect(f.inventory(target)).toEqual(before);
      expect(modes).toEqual(["execute", "replay-only"]);
      await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
    },
  );

  it("recovers after an actual daemon restart and refuses dispatch to a known different Installation", async () => {
    const f = await fixture();
    let lost = false;
    const modes: string[] = [];
    await f.page.route("**/api/v1/memos", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      modes.push(route.request().headers()["idempotency-mode"] ?? "missing");
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await f.list();
    await createThroughUi(f.page, "Restart A");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    f.run(["daemon", "stop"]);
    f.run(["daemon", "start"]);
    await f.authenticate();
    await f.list();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
    expect((await recovery(f.page)).active).toBeNull();
    expect(modes).toEqual(["execute", "replay-only"]);
    lost = false;
    await f.list();
    await createThroughUi(f.page, "Unknown before Installation replacement");
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    const original = (await recovery(f.page)).active;
    f.run(["daemon", "stop"]);
    const different = makeTempDir("aj21-different-");
    f.run(["init", "--non-interactive"], different);
    f.run(["config", "set", "server.port", String(f.port), "--as-user"], different);
    f.run(["daemon", "start"], different);
    registerCleanup(() => {
      sorage(["daemon", "stop"], { home: different });
    });
    await f.authenticate(f.page, different);
    const before = f.inventory(different);
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Installation does not match");
    expect(modes).toEqual(["execute", "replay-only", "execute"]);
    expect((await recovery(f.page)).active).toEqual(original);
    expect(f.inventory(different)).toEqual(before);
  });
});
