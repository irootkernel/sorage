import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { WEB_MEMOS_JS } from "../../src/web-memos";
import { WEB_APP_JS } from "../../src/web-app";

const projectId = "a1000000-0000-4000-8000-000000000001";
const installationId = "a1000000-0000-4000-8000-000000000002";
type Response = { status: number; body: Record<string, unknown> };
function harness() {
  let raw: string | null = null;
  let failWrite = false;
  let failRead = false;
  let confirm = true;
  let reply: (init: { headers: Record<string, string>; body: string }) => Promise<Response> = async () => ({
    status: 500,
    body: {},
  });
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  const app = runInNewContext(
    WEB_MEMOS_JS +
      `;({
    submit: function () { return memoSubmit("add", "${projectId}", null, "Reminder", { projectId: "${projectId}", title: "Reminder", body: "한글\\r\\n" }); },
    retry: function () { return memoDispatch(memoRecovery.active, true); },
    abandon: memoAbandon,
    state: function () { return memoRecovery; },
    locked: memoLocked,
    message: function () { return memoStorageError || memoMessage; },
    receipt: memoReceipt,
    validate: memoStoredState
  })`,
    {
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
      window: { confirm: () => confirm },
      crypto: { randomUUID },
      TextEncoder,
      AbortController,
      setTimeout,
      clearTimeout,
      api: async (path: string, init: { headers: Record<string, string>; body: string }) => {
        if (path === "/api/v1/health") return { status: 200, body: { ok: true, data: { installationId } } };
        if (init.body) {
          expect(JSON.parse(raw ?? "null").active).not.toBeNull();
          calls.push(init);
          return reply(init);
        }
        return { status: 200, body: { ok: true, data: {} } };
      },
    },
  ) as {
    submit(): Promise<void>;
    retry(): Promise<void>;
    abandon(): void;
    state(): { active: Record<string, unknown> | null; notices: Array<Record<string, unknown>> };
    locked(): boolean;
    message(): string;
    validate(value: unknown): boolean;
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
  it("parses the assembled shipped script and persists before dispatch with no fallback after uncertainty", async () => {
    expect(() => new Function(WEB_APP_JS)).not.toThrow();
    const f = harness();
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
    const f = harness();
    f.reply(async () => refusal());
    await f.app.submit();
    expect(f.app.state().active).toBeNull();
    expect(f.app.locked()).toBe(false);
    const bad = harness();
    bad.reply(async () => ({ status: 200, body: { ok: true, data: { changed: true, replayed: false, memo: {} } } }));
    await bad.app.submit();
    expect(bad.app.locked()).toBe(true);
    expect(bad.app.state().active).not.toBeNull();
  });
  it("never dispatches when the initial record cannot be written or read", async () => {
    for (const failure of ["failWrite", "failRead"] as const) {
      const f = harness();
      f[failure]();
      await f.app.submit();
      expect(f.calls).toHaveLength(0);
      expect(f.app.locked()).toBe(true);
      expect(f.app.message()).toContain("storage");
    }
  });
  it("cancels abandonment without mutation and fails closed if its atomic replacement cannot be saved", async () => {
    const cancelled = harness();
    await cancelled.app.submit();
    const original = cancelled.raw();
    cancelled.cancel();
    cancelled.app.abandon();
    expect(cancelled.raw()).toBe(original);
    const failed = harness();
    await failed.app.submit();
    const active = failed.raw();
    failed.failWrite();
    failed.app.abandon();
    expect(failed.raw()).toBe(active);
    expect(failed.app.locked()).toBe(true);
    expect(failed.calls).toHaveLength(1);
  });
  it("atomically retires a request into a bounded metadata-only passive notice without sending", async () => {
    const f = harness();
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
