import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect as browserExpect, type Page } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope, Memo, MemoReceipt } from "../../packages/core/src/index";
import { runCleanups } from "./helpers";
import { memoBrowserFixture, recovery, MEMO_STORAGE, type PendingMemo } from "./memo-browser-fixture";

/**
 * AJ-27: the TASK-108 Web large-body journeys. These tests exercise the real
 * Chromium textarea, the real recovery gate, and the real wire: multipart
 * requests are captured byte-exact with Playwright's postDataBuffer and the
 * CR/BOM histories are seeded through the packaged CLI.
 *
 * Input-method disclosure: bulk fill stalls for these multiline fixtures in
 * the qualified headless Chromium environment, including a blank-page control.
 * The large multiline values below are prepared
 * synthetically through the HTMLTextAreaElement prototype value setter with
 * dispatched input/change events (isTrusted=false); the application's own
 * listeners then process that value like any edit. Real editing of the large
 * value is separately verified through a trusted native keyboard append in
 * journeys 1 and 7. Manual bulk paste remains unverified and is not claimed.
 */
const JSON_CAP = 524288;

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
async function gateSettled(page: Page) {
  await page.waitForFunction((key) => {
    const value = sessionStorage.getItem(key);
    const writes = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-memo-write]:not([data-memo-forbidden="true"])'),
    );
    return (
      value !== null &&
      JSON.parse(value).active === null &&
      writes.length > 0 &&
      writes.every((button) => !button.disabled)
    );
  }, MEMO_STORAGE);
}
// Observe this invocation's own successful response, registered before the
// click; a previously settled record in storage can never stand in for it.
async function settledResponse(page: Page, act: () => Promise<void>) {
  const responded = page.waitForResponse(
    (response) => response.url().includes("/api/v1/memos") && response.request().method() !== "GET",
  );
  await act();
  return responded;
}
// Synthetic bulk preparation for values whose native .fill transport stalls;
// the app's own input listener processes the value — no state or mock edits.
async function prepareTextarea(page: Page, label: string, value: string) {
  const target = page.getByLabel(label, { exact: true });
  await browserExpect(target).toBeVisible();
  await browserExpect(target).toBeEditable();
  await target.evaluate((node, text) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Expected the native textarea value setter");
    setter.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await browserExpect(target).toHaveValue(value);
  expect(Buffer.byteLength(await target.inputValue())).toBe(Buffer.byteLength(value));
}
// A real keyboard append on the prepared large value.
async function appendTrustedKey(page: Page, label: string, marker: string) {
  const target = page.getByLabel(label, { exact: true });
  await target.focus();
  await target.evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error("Expected a Memo textarea");
    node.setSelectionRange(node.value.length, node.value.length);
  });
  await page.keyboard.type(marker);
}
function rowVersionOf(page: Page) {
  return page.locator("dl.meta dt", { hasText: "Row version" }).locator("xpath=following-sibling::dd[1]");
}
async function installationIdOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/health", {
      headers: { authorization: `Bearer ${sessionStorage.getItem("sorage-session")}` },
    });
    return String((await response.json()).data.installationId);
  });
}
async function seedPending(page: Page, active: PendingMemo) {
  await page.evaluate(({ key, record }) => sessionStorage.setItem(key, record), {
    key: MEMO_STORAGE,
    record: JSON.stringify({ version: 1, active, notices: [] }),
  });
}
async function setConfig(f: Awaited<ReturnType<typeof fixture>>, key: string, value: string) {
  const token = readFileSync(join(f.home, "state", "api-token"), "utf8").trim();
  const current = (await (
    await fetch(`http://127.0.0.1:${f.port}/api/v1/config`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as Envelope<{ etag: string }>;
  if (!current.ok) throw new Error(current.error.message);
  const put = await fetch(`http://127.0.0.1:${f.port}/api/v1/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "if-match": current.data.etag, "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  expect(put.status, await put.text()).toBe(200);
}
async function setArtifactMaxBytes(f: Awaited<ReturnType<typeof fixture>>, value: number) {
  await setConfig(f, "artifact.maxBytes", String(value));
}
function expectMultipartWire(wire: { contentType: string; data: Buffer }, body: string) {
  expect(wire.contentType.startsWith("multipart/form-data; boundary=")).toBe(true);
  expect(wire.data.includes(Buffer.from(body, "utf8")), "multipart body bytes must be exact").toBe(true);
  const framing = wire.data.toString("latin1");
  expect(framing).toContain('Content-Disposition: form-data; name="meta"');
  expect(framing).toContain("Content-Type: application/json");
  expect(framing).toContain('Content-Disposition: form-data; name="body"');
  expect(framing).toContain("Content-Type: text/plain");
  expect(framing).not.toContain("filename");
}
function bodyFile(f: Awaited<ReturnType<typeof fixture>>, name: string, body: string): string {
  const file = join(f.home, name);
  writeFileSync(file, Buffer.from(body, "utf8"));
  return file;
}

describe("AJ-27: Memo large bodies in the Web", () => {
  it("keeps the small JSON path and recovers a >512 KiB textarea creation through exact multipart replay", async () => {
    const f = await fixture();
    await f.list();
    const smallBody = "small\nbody";
    const bigBody = `\uFEFF${"Large browser body 😀 line\n".repeat(19000)}`;
    expect(Buffer.byteLength(bigBody)).toBeGreaterThan(JSON_CAP);
    type Wire = { contentType: string; data: Buffer; mode: string | undefined };
    const wires: Wire[] = [];
    let lost = false;
    await f.page.route("**/api/v1/memos**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.continue();
      if (!lost && (request.postDataBuffer()?.length ?? 0) > 400000) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      wires.push({
        contentType: request.headers()["content-type"] || "",
        data: request.postDataBuffer() || Buffer.alloc(0),
        mode: request.headers()["idempotency-mode"],
      });
      return route.continue();
    });
    // A small body still takes the unchanged JSON route.
    await f.page.getByLabel("Memo title", { exact: true }).fill("Small JSON");
    await f.page.getByLabel("Memo body", { exact: true }).fill(smallBody);
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Create Memo", exact: true }).click());
    assert(wires[0]);
    expect(wires[0].contentType).toBe("application/json");
    expect((JSON.parse(wires[0].data.toString("utf8")) as Record<string, unknown>).body).toBe(smallBody);
    // Wait for the completed create's navigation before starting another editor.
    await f.page.waitForURL(/#\/memo\//);
    await f.page.getByRole("button", { name: "Save Memo", exact: true }).waitFor();
    await f.list();
    // The large creation is prepared synthetically, then genuinely edited
    // with one trusted native keypress; every later expectation uses the
    // resulting value as its single source.
    const expected = `${bigBody}x`;
    expect(Buffer.byteLength(expected)).toBe(Buffer.byteLength(bigBody) + 1);
    await f.page.getByLabel("Memo title", { exact: true }).fill("Large multipart");
    await prepareTextarea(f.page, "Memo body", bigBody);
    await appendTrustedKey(f.page, "Memo body", "x");
    await browserExpect(f.page.getByLabel("Memo body", { exact: true })).toHaveValue(expected);
    await f.page.getByRole("button", { name: "Create Memo", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    const original = (await recovery(f.page)).active;
    expect(original).not.toBeNull();
    expect(original?.input.body).toBe(expected);
    expect(typeof original?.key).toBe("string");
    const afterOriginal = f.inventory();
    await f.page.reload();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Memo outcome unknown");
    expect((await recovery(f.page)).active).toEqual(original);
    // Reauthentication: the session token is removed while the >512 KiB
    // original material stays in this tab; the same key/input survives the
    // unauthenticated state and a real reauthenticate, then settles.
    await f.page.evaluate(() => sessionStorage.removeItem("sorage-session"));
    await f.page.reload();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Memo outcome unknown");
    expect((await recovery(f.page)).active).toEqual(original);
    await f.authenticate(f.page);
    await f.list();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Memo outcome unknown");
    expect((await recovery(f.page)).active).toEqual(original);
    await settledResponse(f.page, () =>
      f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click(),
    );
    await gateSettled(f.page);
    await f.page.waitForURL(/#\/memo\//);
    const replayWire = wires.at(-1);
    assert(replayWire);
    expect(replayWire.mode).toBe("replay-only");
    expectMultipartWire(replayWire, expected);
    const id = new URL(f.page.url()).hash.split("/").at(-1) as string;
    expect(f.show(id).title).toBe("Large multipart");
    expect(f.show(id).body).toBe(expected);
    expect(f.inventory(), "replay must not mutate").toEqual(afterOriginal);
  });

  it("replays CLI-executed originals from a seeded pending with exact BOM/CR/LF multipart bytes", async () => {
    const f = await fixture();
    await f.list();
    const installationId = await installationIdOf(f.page);
    const variants = [
      { title: "Wire BOM", body: `\uFEFF${"bom wire line\n".repeat(60000)}` },
      { title: "Wire lone LF", body: "lf wire line\n".repeat(42000) },
      { title: "Wire lone CR", body: "cr wire line\r".repeat(42000) },
      { title: "Wire CRLF", body: "crlf wire line\r\n".repeat(36000) },
      { title: "Wire no final LF", body: `${"nfl wire line\r\n".repeat(36000)}tail without final newline` },
    ];
    for (const variant of variants) expect(Buffer.byteLength(variant.body)).toBeGreaterThan(JSON_CAP);
    const wires: Array<{ contentType: string; data: Buffer; mode: string | undefined }> = [];
    await f.page.route("**/api/v1/memos**", (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.continue();
      wires.push({
        contentType: request.headers()["content-type"] || "",
        data: request.postDataBuffer() || Buffer.alloc(0),
        mode: request.headers()["idempotency-mode"],
      });
      return route.continue();
    });
    for (const variant of variants) {
      const file = bodyFile(f, "wire-body.md", variant.body);
      const key = randomUUID();
      const created = f.run([
        "memo",
        "add",
        "--project",
        "alpha",
        "--title",
        variant.title,
        "--body-file",
        file,
        "--idempotency-key",
        key,
      ]) as MemoReceipt;
      const before = f.inventory();
      await seedPending(f.page, {
        origin: f.origin,
        installationId,
        key,
        projectId: created.memo.projectId,
        memoId: null,
        operation: "add",
        title: variant.title,
        firstAttemptAt: new Date().toISOString(),
        input: { projectId: created.memo.projectId, title: variant.title, body: variant.body },
      });
      await f.page.reload();
      await browserExpect(f.page.locator("#memo-recovery")).toContainText("Memo outcome unknown");
      await settledResponse(f.page, () =>
        f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click(),
      );
      await gateSettled(f.page);
      const wire = wires.at(-1);
      assert(wire);
      expect(wire.mode).toBe("replay-only");
      expectMultipartWire(wire, variant.body);
      expect(f.show(created.memo.id).body).toBe(variant.body);
      expect(f.inventory(), "replay must not mutate").toEqual(before);
    }
    expect(wires).toHaveLength(variants.length);
  });

  it("preserves exact historical bytes on title-only edits and saves retained drafts edited before or during a pending", async () => {
    const f = await fixture();
    const historic = "\uFEFFhistoric\r\nmixed\rlone\nlines\r\n".repeat(20000);
    expect(Buffer.byteLength(historic)).toBeGreaterThan(JSON_CAP);
    const file = bodyFile(f, "historic.md", historic);
    const created = f.run([
      "memo",
      "add",
      "--project",
      "alpha",
      "--title",
      "Historic",
      "--body-file",
      file,
    ]) as MemoReceipt;
    const wires: Array<{ contentType: string; data: Buffer }> = [];
    const state = { loseReply: false };
    await f.page.route("**/api/v1/memos**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.continue();
      if (state.loseReply) {
        state.loseReply = false;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      wires.push({
        contentType: request.headers()["content-type"] || "",
        data: request.postDataBuffer() || Buffer.alloc(0),
      });
      return route.continue();
    });
    await f.page.goto(`${f.origin}/#/memo/${created.memo.id}`);
    await browserExpect(f.page.locator('section[aria-label="Full Memo body"]')).toContainText("historic");
    // A title-only edit omits the unchanged body; the stored bytes stay exact.
    await f.page.getByLabel("Memo title", { exact: true }).fill("Renamed only");
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Save Memo", exact: true }).click());
    await browserExpect(rowVersionOf(f.page)).toHaveText("2");
    expect(wires).toHaveLength(1);
    assert(wires[0]);
    expect(wires[0].contentType).toBe("application/json");
    const titleOnly = JSON.parse(wires[0].data.toString("utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(titleOnly, "body")).toBe(false);
    expect(titleOnly.title).toBe("Renamed only");
    expect(f.show(created.memo.id).body).toBe(historic);
    // A body edit retained across navigation still saves its body: the
    // omission compares against the loaded server body, not the remounted draft.
    await f.page.getByLabel("Memo body", { exact: true }).fill("Edited while away\nsecond line");
    await f.page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await browserExpect(f.page.locator(".counts")).toBeVisible();
    await f.page.goto(`${f.origin}/#/memo/${created.memo.id}`);
    await f.page.getByRole("button", { name: "Save Memo", exact: true }).waitFor();
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Save Memo", exact: true }).click());
    await browserExpect(rowVersionOf(f.page)).toHaveText("3");
    expect(wires).toHaveLength(2);
    assert(wires[1]);
    expect((JSON.parse(wires[1].data.toString("utf8")) as Record<string, unknown>).body).toBe(
      "Edited while away\nsecond line",
    );
    expect(f.show(created.memo.id).body).toBe("Edited while away\nsecond line");
    // A draft edited while the original outcome is unknown is preserved, the
    // replay carries the original body, and the retained draft saves after.
    state.loseReply = true;
    await f.page.getByLabel("Memo body", { exact: true }).fill("Pending body draft\n");
    await f.page.getByRole("button", { name: "Save Memo", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("Outcome unknown");
    await f.page.getByLabel("Memo body", { exact: true }).fill("Changed while pending\n");
    await settledResponse(f.page, () =>
      f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click(),
    );
    await gateSettled(f.page);
    await f.page.getByRole("button", { name: "Save Memo", exact: true }).waitFor();
    await browserExpect(f.page.getByLabel("Memo body", { exact: true })).toHaveValue("Changed while pending\n");
    expect(wires).toHaveLength(3);
    assert(wires[2]);
    expect((JSON.parse(wires[2].data.toString("utf8")) as Record<string, unknown>).body).toBe("Pending body draft\n");
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Save Memo", exact: true }).click());
    await browserExpect(rowVersionOf(f.page)).toHaveText("5");
    expect(wires).toHaveLength(4);
    assert(wires[3]);
    expect((JSON.parse(wires[3].data.toString("utf8")) as Record<string, unknown>).body).toBe(
      "Changed while pending\n",
    );
    expect(f.show(created.memo.id).body).toBe("Changed while pending\n");
  });

  it("blocks dispatch and preserves the draft with unsent local material when the real storage quota refuses", async () => {
    const f = await fixture();
    await f.list();
    // Exhaust the real same-origin sessionStorage quota: unique filler keys
    // in bounded 64 KiB increments until the browser itself refuses. No
    // synthetic shim and no assumed quota size; above 32 MiB without a
    // native refusal the environment cannot exercise this path and fails.
    const quota = await f.page.evaluate(() => {
      let stored = 0;
      let nativeRefusal: string | null = null;
      try {
        for (let index = 0; index < 512; index++) {
          const chunk = "q".repeat(65536);
          sessionStorage.setItem(`sorage-aj27-filler-${index}`, chunk);
          stored += chunk.length;
        }
      } catch (error) {
        nativeRefusal = error instanceof DOMException ? error.name : String(error);
      }
      return { stored, nativeRefusal };
    });
    expect(quota.nativeRefusal, "the real browser quota must refuse within 32 MiB of fillers").toBe(
      "QuotaExceededError",
    );
    expect(quota.stored).toBeGreaterThan(0);
    const bigBody = "unsent large body line\n".repeat(26000);
    expect(Buffer.byteLength(bigBody)).toBeGreaterThan(JSON_CAP);
    const mutations: string[] = [];
    await f.page.route("**/api/v1/memos**", (route) => {
      const request = route.request();
      if (request.method() !== "GET") mutations.push(request.url());
      return route.continue();
    });
    const before = f.inventory();
    await f.page.getByLabel("Memo title", { exact: true }).fill("Never sent");
    await prepareTextarea(f.page, "Memo body", bigBody);
    await f.page.getByRole("button", { name: "Create Memo", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("could not be saved or verified");
    await browserExpect(f.page.getByLabel("Copy Memo recovery material", { exact: true })).toBeVisible();
    const material = await f.page.getByLabel("Copy Memo recovery material", { exact: true }).inputValue();
    const record = JSON.parse(material) as PendingMemo;
    expect(record.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.input.body).toBe(bigBody);
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("was never sent");
    expect((await recovery(f.page)).active).toBeNull();
    expect(mutations).toEqual([]);
    expect(f.inventory()).toEqual(before);
    expect(await f.page.getByLabel("Memo body", { exact: true }).inputValue()).toBe(bigBody);
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
  });

  it("keeps the recovery gate with complete material when the settlement clear is injected to fail", async () => {
    const f = await fixture();
    await f.list();
    // Deterministic fault injection on the settlement-clear write only: a
    // shrink-to-clear write cannot be exhausted by real quota, so the shim
    // refuses exactly that write; the initial pending persistence is real.
    await f.page.addInitScript(() => {
      const real = window.sessionStorage;
      let hadActive = false;
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => real.getItem(key),
          setItem: (key: string, value: string) => {
            if (key === "sorage-memo-recovery-v1") {
              if (hadActive && value.includes('"active":null'))
                throw new DOMException("quota exceeded", "QuotaExceededError");
              if (!value.includes('"active":null')) hadActive = true;
            }
            real.setItem(key, value);
          },
          removeItem: (key: string) => real.removeItem(key),
          key: (index: number) => real.key(index),
        },
      });
    });
    await f.page.reload();
    await f.page.getByRole("button", { name: "Create Memo", exact: true }).waitFor();
    const mutations: string[] = [];
    await f.page.route("**/api/v1/memos**", (route) => {
      const request = route.request();
      if (request.method() !== "GET") mutations.push(`${request.method()} ${request.url()}`);
      return route.continue();
    });
    await f.page.getByLabel("Memo title", { exact: true }).fill("Settle persist fails");
    await f.page.getByLabel("Memo body", { exact: true }).fill("body");
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Create Memo", exact: true }).click());
    // The gate, the material and the no-false-unsent-claim hold regardless of
    // which server outcome preceded the failed clear.
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("could not be saved or verified");
    await browserExpect(f.page.locator("#memo-recovery")).not.toContainText("was never sent");
    const material = await f.page.getByLabel("Copy Memo recovery material", { exact: true }).inputValue();
    const pending = JSON.parse(material) as PendingMemo;
    expect(pending.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(pending.input.body).toBe("body");
    expect((await recovery(f.page)).active?.key).toBe(pending.key);
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeDisabled();
    // The server committed the original and nothing further was dispatched.
    expect(mutations).toHaveLength(1);
    const listed = f.run(["memo", "list", "--project", "alpha"]) as { items: Memo[] };
    expect(listed.items.some((memo) => memo.title === "Settle persist fails")).toBe(true);
  });

  it("enforces a lowered artifact.maxBytes across outputs, title-only edits, refusals and replays", async () => {
    const f = await fixture();
    // Originals while the default cap still accepts large bodies.
    const bigBody = "lowered cap historic\r\nmixed\n".repeat(21000);
    expect(Buffer.byteLength(bigBody)).toBeGreaterThan(JSON_CAP);
    const historic = (
      f.run([
        "memo",
        "add",
        "--project",
        "alpha",
        "--title",
        "Historic large",
        "--body-file",
        bodyFile(f, "historic.md", bigBody),
      ]) as MemoReceipt
    ).memo;
    const replayKey = randomUUID();
    f.run([
      "memo",
      "update",
      historic.id,
      "--title",
      "Settle title",
      "--expected-row-version",
      "1",
      "--idempotency-key",
      replayKey,
    ]);
    const midBody = "mid body line for replay refusal\n".repeat(2400);
    expect(Buffer.byteLength(midBody)).toBeGreaterThan(65536);
    expect(Buffer.byteLength(midBody)).toBeLessThan(JSON_CAP);
    const midKey = randomUUID();
    const midOriginal = (
      f.run([
        "memo",
        "add",
        "--project",
        "alpha",
        "--title",
        "Replay refused",
        "--body-file",
        bodyFile(f, "mid.md", midBody),
        "--idempotency-key",
        midKey,
      ]) as MemoReceipt
    ).memo;
    const installationId = await installationIdOf(f.page);
    await setArtifactMaxBytes(f, 65536);
    const mutations: string[] = [];
    const wires: Array<{ contentType: string; data: Buffer }> = [];
    await f.page.route("**/api/v1/memos**", (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.continue();
      mutations.push(`${request.method()} ${request.url()}`);
      wires.push({
        contentType: request.headers()["content-type"] || "",
        data: request.postDataBuffer() || Buffer.alloc(0),
      });
      return route.continue();
    });
    // A new body over the lowered cap is refused before dispatch; the draft stays.
    await f.list();
    const refused = "refused body line\n".repeat(6000);
    expect(Buffer.byteLength(refused)).toBeGreaterThan(65536);
    await f.page.getByLabel("Memo title", { exact: true }).fill("Refused locally");
    await prepareTextarea(f.page, "Memo body", refused);
    await f.page.getByRole("button", { name: "Create Memo", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("at most 65536 UTF-8 bytes");
    await browserExpect(f.page.getByRole("button", { name: "Create Memo", exact: true })).toBeEnabled();
    expect(mutations).toEqual([]);
    expect((await recovery(f.page)).active).toBeNull();
    expect(await f.page.getByLabel("Memo body", { exact: true }).inputValue()).toBe(refused);
    // A historical body larger than the cap still renders in full, and a
    // title-only edit of it succeeds without resending the body.
    await f.page.goto(`${f.origin}/#/memo/${historic.id}`);
    await browserExpect(f.page.locator('section[aria-label="Full Memo body"]')).toContainText("lowered cap historic");
    await f.page.getByLabel("Memo title", { exact: true }).fill("Renamed under cap");
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Save Memo", exact: true }).click());
    await browserExpect(rowVersionOf(f.page)).toHaveText("3");
    expect(mutations).toHaveLength(1);
    assert(wires[0]);
    const titleOnly = JSON.parse(wires[0].data.toString("utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(titleOnly, "body")).toBe(false);
    expect(f.show(historic.id).title).toBe("Renamed under cap");
    expect(f.show(historic.id).body).toBe(bigBody);
    // A bodyless original settles its receipt even though the receipt's full
    // body exceeds the current cap (output validation is cap-independent).
    await seedPending(f.page, {
      origin: f.origin,
      installationId,
      key: replayKey,
      projectId: historic.projectId,
      memoId: historic.id,
      operation: "update",
      title: "Settle title",
      firstAttemptAt: new Date().toISOString(),
      input: { title: "Settle title", expectedRowVersion: 1 },
    });
    await f.page.reload();
    await settledResponse(f.page, () =>
      f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click(),
    );
    await gateSettled(f.page);
    await browserExpect(rowVersionOf(f.page)).toHaveText("3");
    // The replay settles the gate without re-executing: current state keeps
    // the Web title-only edit while the full over-cap body remains readable.
    expect(f.show(historic.id).title).toBe("Renamed under cap");
    expect(f.show(historic.id).body).toBe(bigBody);
    expect(mutations).toHaveLength(2);
    // A body-bearing replay under the lowered cap is refused locally without
    // settling the earlier unknown; after the cap is restored it settles.
    await seedPending(f.page, {
      origin: f.origin,
      installationId,
      key: midKey,
      projectId: midOriginal.projectId,
      memoId: null,
      operation: "add",
      title: "Replay refused",
      firstAttemptAt: new Date().toISOString(),
      input: { projectId: midOriginal.projectId, title: "Replay refused", body: midBody },
    });
    await f.page.reload();
    await f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click();
    await browserExpect(f.page.locator("#memo-recovery")).toContainText("refuses the original body");
    expect((await recovery(f.page)).active).not.toBeNull();
    expect(mutations).toHaveLength(2);
    await setArtifactMaxBytes(f, 104857600);
    await settledResponse(f.page, () =>
      f.page.getByRole("button", { name: "Inspect original request (replay-only)", exact: true }).click(),
    );
    await gateSettled(f.page);
    expect(mutations).toHaveLength(3);
    expect(f.show(midOriginal.id).body).toBe(midBody);
  });

  it("falls back to shape-only validation and still dispatches when the config endpoint fails", async () => {
    const f = await fixture();
    await f.list();
    const limitsOf = () => f.page.locator('form[aria-label="Create Memo"] p[role="status"]');
    await f.page.getByLabel("Memo body", { exact: true }).fill("seed\n");
    await browserExpect(limitsOf()).toContainText(/\/\d+ body bytes/);
    let configAttempts = 0;
    await f.page.route("**/api/v1/config", (route) => {
      configAttempts += 1;
      return route.abort("failed");
    });
    // A dispatch whose cap refresh failed still sends and settles: the server
    // owns the accepting cap, and a config failure never blocks dispatch.
    await f.page.getByLabel("Memo title", { exact: true }).fill("Config fallback small");
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Create Memo", exact: true }).click());
    await f.page.waitForURL(/#\/memo\//);
    expect(configAttempts).toBeGreaterThan(0);
    await f.list();
    const bigBody = "config fallback body line 😀\n".repeat(18000);
    expect(Buffer.byteLength(bigBody)).toBeGreaterThan(JSON_CAP);
    const expected = `${bigBody}x`;
    expect(Buffer.byteLength(expected)).toBe(Buffer.byteLength(bigBody) + 1);
    const wires: Array<{ contentType: string; data: Buffer }> = [];
    await f.page.route("**/api/v1/memos**", (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.continue();
      wires.push({
        contentType: request.headers()["content-type"] || "",
        data: request.postDataBuffer() || Buffer.alloc(0),
      });
      return route.continue();
    });
    await f.page.getByLabel("Memo title", { exact: true }).fill("Config fallback large");
    await prepareTextarea(f.page, "Memo body", bigBody);
    await appendTrustedKey(f.page, "Memo body", "x");
    await browserExpect(f.page.getByLabel("Memo body", { exact: true })).toHaveValue(expected);
    // The mount-time cap refresh failed: the limits line reports plain body
    // bytes and must not present any cap value as the current limit.
    const limits = await limitsOf().textContent();
    expect(limits).toContain("body bytes");
    expect(limits?.match(/\/\d+ body bytes/)).toBeNull();
    await settledResponse(f.page, () => f.page.getByRole("button", { name: "Create Memo", exact: true }).click());
    expect(wires).toHaveLength(1);
    assert(wires[0]);
    expectMultipartWire(wires[0], expected);
    await f.page.waitForURL(/#\/memo\//);
    const id = new URL(f.page.url()).hash.split("/").at(-1) as string;
    expect(f.show(id).body).toBe(expected);
  });

  it("shows conditional retention guidance and a fresh-write warning only for newly accepted over-threshold bodies", async () => {
    const f = await fixture();
    await setConfig(f, "gitBackup.enabled", "true");
    await setConfig(f, "gitBackup.largeArtifactWarningBytes", "1024");
    await f.list();
    const guidance = () => f.page.locator('form[aria-label="Create Memo"] p[role="status"]');
    const region = () => f.page.locator("#memo-recovery");
    // Observe this invocation's response before consulting storage, which can
    // still contain the previous invocation's settled record immediately after a click.
    const submit = async (name: string) => {
      const responded = await settledResponse(f.page, () => f.page.getByRole("button", { name, exact: true }).click());
      expect(responded.status()).toBe(200);
    };
    const submitCreate = async () => {
      await submit("Create Memo");
      await f.page.waitForURL(/#\/memo\//);
      await browserExpect(f.page.getByRole("button", { name: "Save Memo", exact: true })).toBeEnabled();
    };
    const state = { loseReply: false };
    await f.page.route("**/api/v1/memos**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.continue();
      if (state.loseReply) {
        state.loseReply = false;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      return route.continue();
    });
    // A current enabled sample with an over-threshold draft shows this body's
    // truthful numbers, and the confirmed fresh save appends the warning.
    await f.page.getByLabel("Memo title", { exact: true }).fill("Warned");
    await f.page.getByLabel("Memo body", { exact: true }).fill("warned draft line\n".repeat(200));
    await browserExpect(guidance()).toContainText("every committed revision of this body");
    await browserExpect(guidance()).toContainText("above gitBackup.largeArtifactWarningBytes 1024");
    await submitCreate();
    await browserExpect(region()).toContainText("A new body was accepted");
    await browserExpect(region()).toContainText("every committed revision of this body forever");
    const warnedId = new URL(f.page.url()).hash.split("/").at(-1) as string;
    // At exactly the threshold the editor keeps the threshold-scoped sentence
    // without claiming this body, and the save stays silent.
    await f.list();
    await f.page.getByLabel("Memo title", { exact: true }).fill("Boundary");
    await f.page.getByLabel("Memo body", { exact: true }).fill("y".repeat(1024));
    await browserExpect(guidance()).toContainText(
      "every committed revision of a body above gitBackup.largeArtifactWarningBytes (1024)",
    );
    await browserExpect(guidance()).not.toContainText("revision of this body");
    await submitCreate();
    await browserExpect(region()).not.toContainText("A new body was accepted");
    const boundaryId = new URL(f.page.url()).hash.split("/").at(-1) as string;
    // A lost reply never claims a fresh write; neither does its replay.
    await f.list();
    state.loseReply = true;
    await f.page.getByLabel("Memo title", { exact: true }).fill("Lost warning");
    await f.page.getByLabel("Memo body", { exact: true }).fill("lost large body\n".repeat(300));
    await f.page.getByRole("button", { name: "Create Memo", exact: true }).click();
    await browserExpect(region()).toContainText("Outcome unknown");
    await browserExpect(region()).not.toContainText("A new body was accepted");
    await submit("Inspect original request (replay-only)");
    await browserExpect(region()).toContainText("historical receipt");
    await browserExpect(region()).not.toContainText("A new body was accepted");
    // A title-only edit sends no body and a state action changes none.
    await f.page.goto(`${f.origin}/#/memo/${warnedId}`);
    await f.page.getByLabel("Memo title", { exact: true }).fill("Warned renamed");
    await submit("Save Memo");
    await browserExpect(rowVersionOf(f.page)).toHaveText("2");
    await browserExpect(region()).not.toContainText("A new body was accepted");
    await f.page.goto(`${f.origin}/#/memo/${boundaryId}`);
    await submit("Mark done");
    await browserExpect(rowVersionOf(f.page)).toHaveText("2");
    await browserExpect(region()).not.toContainText("A new body was accepted");
    await browserExpect(region()).toContainText("Memo saved");
    // A disabled configuration claims nothing, before or after a fresh save.
    await setConfig(f, "gitBackup.enabled", "false");
    await f.list();
    await f.page.getByLabel("Memo body", { exact: true }).fill("disabled large body\n".repeat(300));
    await browserExpect(guidance()).not.toContainText("Git history retains");
    await f.page.getByLabel("Memo title", { exact: true }).fill("Disabled");
    await submitCreate();
    await browserExpect(region()).not.toContainText("A new body was accepted");
    // The dispatch sample is its own refresh: a stale strict editor display
    // must not produce a warning when the save itself learns a disabled state.
    await setConfig(f, "gitBackup.enabled", "true");
    await f.list();
    await f.page.getByLabel("Memo body", { exact: true }).fill("stale sample body\n".repeat(300));
    await browserExpect(guidance()).toContainText("every committed revision of this body");
    await setConfig(f, "gitBackup.enabled", "false");
    await f.page.getByLabel("Memo title", { exact: true }).fill("Stale sample");
    await submitCreate();
    await browserExpect(region()).not.toContainText("A new body was accepted");
    // A failed config refresh shows the numberless generic sentence and the
    // dispatch still succeeds (the server owns the cap) without a warning.
    await f.page.route("**/api/v1/config", (route) => route.abort("failed"));
    await f.list();
    await f.page.getByLabel("Memo body", { exact: true }).fill("config failed body\n".repeat(300));
    await browserExpect(guidance()).toContainText(
      "every committed revision of a body above gitBackup.largeArtifactWarningBytes forever",
    );
    await browserExpect(guidance()).not.toContainText("(1024)");
    await f.page.getByLabel("Memo title", { exact: true }).fill("Config failed");
    await submitCreate();
    await browserExpect(region()).not.toContainText("A new body was accepted");
  });
});
