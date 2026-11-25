import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../../src/web/types";

const projectId = "a1000000-0000-4000-8000-000000000001";
const installationId = "a1000000-0000-4000-8000-000000000002";
type Response = { status: number; body: Record<string, unknown> };
const stub = vi.hoisted(() => ({
  impl: (_path: string, _init?: RequestInit): Promise<Response> => Promise.reject(new Error("No API stub installed")),
}));

vi.mock(import("../../../src/web/api"), async (importOriginal) => ({
  ...(await importOriginal()),
  api: <T = unknown>(path: string, init?: RequestInit) => stub.impl(path, init) as Promise<ApiResult<T>>,
}));

afterEach(() => vi.unstubAllGlobals());

async function harness() {
  vi.resetModules();
  let raw: string | null = null;
  let failWrite = false;
  let failRead = false;
  let confirm = true;
  let reply: (init: { headers: Record<string, string>; body: string }) => Promise<Response> = async () => ({
    status: 500,
    body: {},
  });
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  const globals = {
    sessionStorage: {
      getItem() {
        if (failRead) throw new Error("read");
        return raw;
      },
      setItem(_key: string, value: string) {
        if (failWrite) throw new Error("write");
        raw = value;
      },
    },
    document: { querySelectorAll: () => [], getElementById: () => null },
    location: { origin: "http://127.0.0.1:12345" },
    history: { replaceState() {} },
    window: { confirm: () => confirm, addEventListener() {} },
    fetch: () => Promise.reject(new Error("Expected the API stub")),
    crypto: { randomUUID },
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  stub.impl = async (path, init) => {
    if (path === "/api/v1/health") return { status: 200, body: { ok: true, data: { installationId } } };
    if (typeof init?.body === "string") {
      expect(JSON.parse(raw ?? "null").active).not.toBeNull();
      const call = { headers: init.headers as Record<string, string>, body: init.body };
      calls.push(call);
      return reply(call);
    }
    return { status: 200, body: { ok: true, data: {} } };
  };
  const recovery = await import("../../../src/web/memos/recovery");
  const state = await import("../../../src/web/memos/state");
  const app = {
    submit: () =>
      recovery.memoSubmit("add", projectId, null, "Reminder", { projectId, title: "Reminder", body: "한글\r\n" }),
    retry: () => {
      const pending = state.memoState.recovery.active;
      if (!pending) throw new Error("Expected an active Memo request");
      return recovery.memoDispatch(pending, true);
    },
    abandon: recovery.memoAbandon,
    state: () => state.memoState.recovery,
    locked: recovery.memoLocked,
    message: () => state.memoState.storageError || state.memoState.message,
    validate: recovery.memoStoredState,
  };
  return {
    app,
    calls,
    raw: () => raw,
    failWrite: () => {
      failWrite = true;
    },
    failRead: () => {
      failRead = true;
    },
    cancel: () => {
      confirm = false;
    },
    reply: (fn: typeof reply) => {
      reply = fn;
    },
  };
}
const refusal = () => ({
  status: 422,
  body: { ok: false, error: { code: "MEMO_INVALID_INPUT", message: "Invalid" }, meta: { requestId: randomUUID() } },
});

describe("served Memo recovery state machine", () => {
  it("persists before dispatch with no fallback after uncertainty", async () => {
    const f = await harness();
    await f.app.submit();
    const original = f.raw();
    expect(f.app.locked()).toBe(true);
    await f.app.submit();
    expect(f.calls).toHaveLength(1);
    f.reply(async () => refusal());
    await f.app.retry();
    expect(f.calls[1]?.headers["idempotency-mode"]).toBe("replay-only");
    expect(f.calls[1]?.headers["idempotency-key"]).toBe(f.calls[0]?.headers["idempotency-key"]);
    expect(f.raw()).toBe(original);
    expect(f.app.locked()).toBe(true);
  });
  it("settles only a validated first-dispatch refusal and preserves uncertain malformed responses", async () => {
    const f = await harness();
    f.reply(async () => refusal());
    await f.app.submit();
    expect(f.app.state().active).toBeNull();
    expect(f.app.locked()).toBe(false);
    const bad = await harness();
    bad.reply(async () => ({ status: 200, body: { ok: true, data: { changed: true, replayed: false, memo: {} } } }));
    await bad.app.submit();
    expect(bad.app.locked()).toBe(true);
    expect(bad.app.state().active).not.toBeNull();
  });
  it("settles a first SERVICE_PAUSED refusal at its catalogued HTTP status", async () => {
    const f = await harness();
    f.reply(async () => ({
      status: 423,
      body: {
        ok: false,
        error: { code: "SERVICE_PAUSED", message: "The service is paused" },
        meta: { requestId: randomUUID() },
      },
    }));
    await f.app.submit();
    expect(f.calls).toHaveLength(1);
    expect(f.app.state().active).toBeNull();
    expect(f.app.locked()).toBe(false);
  });
  it("never dispatches when the initial record cannot be written or read", async () => {
    for (const failure of ["failWrite", "failRead"] as const) {
      const f = await harness();
      f[failure]();
      await f.app.submit();
      expect(f.calls).toHaveLength(0);
      expect(f.app.locked()).toBe(true);
      expect(f.app.message()).toContain("storage");
    }
  });
  it("cancels abandonment without mutation and fails closed if its atomic replacement cannot be saved", async () => {
    const cancelled = await harness();
    await cancelled.app.submit();
    const original = cancelled.raw();
    cancelled.cancel();
    cancelled.app.abandon();
    expect(cancelled.raw()).toBe(original);
    const failed = await harness();
    await failed.app.submit();
    const active = failed.raw();
    failed.failWrite();
    failed.app.abandon();
    expect(failed.raw()).toBe(active);
    expect(failed.app.locked()).toBe(true);
    expect(failed.calls).toHaveLength(1);
  });
  it("atomically retires a request into a bounded metadata-only passive notice without sending", async () => {
    const f = await harness();
    await f.app.submit();
    const original = f.app.state().active;
    f.app.abandon();
    expect(f.app.state().active).toBeNull();
    expect(f.app.locked()).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.app.state().notices).toHaveLength(1);
    const notice = f.app.state().notices[0];
    expect(notice).toMatchObject({ key: original?.key, outcome: "unknown", retryDisposition: "abandoned" });
    expect(notice).not.toHaveProperty("input");
    expect(notice).not.toHaveProperty("body");
    expect(
      f.app.validate({
        version: 1,
        active: null,
        notices: Array.from({ length: 33 }, () => ({ ...notice, key: randomUUID() })),
      }),
    ).toBe(false);
  });
});
