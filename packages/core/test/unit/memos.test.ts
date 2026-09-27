import { describe, expect, it } from "vitest";
import {
  type Memo,
  type MemoChange,
  MEMO_STATES,
  changeMemo,
  createMemo,
  normalizeMemoTitle,
  parseMemoCreate,
  parseMemoUpdate,
  parseMemoStateRequest,
  parseMemoExecution,
  parseMemoListFilter,
  parseMemoDetail,
  parseMemoReceipt,
  parseMemoSummary,
  parseMemoPage,
  summarizeMemo,
  validateMemoBody,
  validateMemoQuery,
  decodeMemoJson,
} from "../../src/index";

const id = "ab000000-0000-4000-8000-000000000001";
const projectId = "cd000000-0000-4000-8000-000000000001";
const now = "2026-09-27T00:00:00.000Z";
const later = "2026-09-27T01:00:00.000Z";
function initial(): Memo {
  const result = createMemo(id, projectId, { title: " Reminder ", body: "literal body\r\n" }, now);
  if (!result.ok) throw new Error(result.error.code);
  return result.value.memo;
}
function inState(state: Memo["state"]): Memo {
  const memo = initial();
  if (state === "open") return memo;
  const result = changeMemo(memo, { operation: state === "done" ? "done" : "dismiss", expectedRowVersion: 1 }, now);
  if (!result.ok) throw new Error(result.error.code);
  return result.value.memo;
}

describe("Memo Unicode and input contracts", () => {
  it("trims titles without normalizing Unicode or body line endings", () => {
    expect(normalizeMemoTitle("  e\u0301 한글 😀  ")).toEqual({ ok: true, value: "e\u0301 한글 😀" });
    expect(validateMemoBody("\r\n\t e\u0301 �\n")).toEqual({ ok: true, value: "\r\n\t e\u0301 �\n" });
    expect(validateMemoBody("").ok).toBe(true);
  });
  it("counts scalars and UTF-8 bytes independently", () => {
    expect(normalizeMemoTitle("😀".repeat(200)).ok).toBe(true);
    expect(normalizeMemoTitle("😀".repeat(201)).ok).toBe(false);
    expect(normalizeMemoTitle("a".repeat(201)).ok).toBe(false);
    expect(validateMemoBody("😀".repeat(16_384)).ok).toBe(true);
    expect(validateMemoBody(`${"😀".repeat(16_384)}a`)).toMatchObject({ ok: false, error: { code: "MEMO_TOO_LARGE" } });
  });
  it.each([
    "",
    "   ",
    "a\nb",
    "\ttitle",
    "title\r",
    "a\u007fb",
    "a\u0085b",
    "a\u2028b",
    "a\u2029b",
    "\ud800",
    "\udc00",
  ])("rejects invalid title %j", (title) => {
    expect(normalizeMemoTitle(title)).toMatchObject({ ok: false, error: { code: "MEMO_INVALID_INPUT" } });
  });
  it.each(["a\0b", "\ud800", "x\udc00", null, 4])("rejects invalid body %j", (body) => {
    expect(validateMemoBody(body)).toMatchObject({ ok: false, error: { code: "MEMO_INVALID_INPUT" } });
  });
  it("normalizes creation defaults and preserves update omission versus empty body", () => {
    expect(parseMemoCreate({ projectId, title: "  Task  " })).toEqual({
      ok: true,
      value: { projectId, title: "Task", body: "" },
    });
    expect(parseMemoUpdate({ expectedRowVersion: 1, title: " Task " })).toEqual({
      ok: true,
      value: { expectedRowVersion: 1, title: "Task" },
    });
    expect(parseMemoUpdate({ expectedRowVersion: 1, body: "" })).toEqual({
      ok: true,
      value: { expectedRowVersion: 1, body: "" },
    });
  });
  it.each([
    null,
    [],
    {},
    { projectId, title: null },
    { projectId, title: "a", body: null },
    { projectId, title: "a", state: "done" },
    { projectId, title: "a", id },
  ])("rejects invalid create %j", (input) => {
    expect(parseMemoCreate(input).ok).toBe(false);
  });
  it.each([
    {},
    { title: "a" },
    { expectedRowVersion: 1 },
    { expectedRowVersion: 1, body: null },
    { expectedRowVersion: 1, body: "", extra: true },
  ])("rejects invalid update %j", (input) => {
    expect(parseMemoUpdate(input).ok).toBe(false);
  });
  it.each([undefined, null, 0, -1, 1.1, "1", Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects invalid expectation %j",
    (expectedRowVersion) => {
      expect(parseMemoStateRequest({ expectedRowVersion }).ok).toBe(false);
      expect(parseMemoUpdate({ expectedRowVersion, body: "" }).ok).toBe(false);
    },
  );
  it("validates closed request fields and optional UUID scope assertions", () => {
    expect(parseMemoStateRequest({ expectedRowVersion: Number.MAX_SAFE_INTEGER, projectId }).ok).toBe(true);
    expect(parseMemoStateRequest({ expectedRowVersion: 1, projectId: null }).ok).toBe(false);
    expect(parseMemoStateRequest({ expectedRowVersion: 1, state: "done" }).ok).toBe(false);
  });
  it("separates execution mode from the business DTO and requires original replay identity", () => {
    expect(parseMemoExecution([], undefined, true)).toEqual({ ok: true, value: { mode: "execute" } });
    expect(parseMemoExecution([], undefined, false)).toEqual({ ok: true, value: { mode: "execute" } });
    expect(parseMemoExecution(["execute"], id, true)).toEqual({
      ok: true,
      value: { mode: "execute", idempotencyKey: id },
    });
    expect(parseMemoExecution(["replay-only"], id, true)).toEqual({
      ok: true,
      value: { mode: "replay-only", idempotencyKey: id },
    });
    expect(parseMemoCreate({ projectId, title: "a", mode: "replay-only" }).ok).toBe(false);
    for (const modes of [[""], ["unknown"], ["execute,replay-only"], ["execute", "execute"]])
      expect(parseMemoExecution(modes, id, true).ok).toBe(false);
    expect(parseMemoExecution(["replay-only"], undefined, true).ok).toBe(false);
    expect(parseMemoExecution(["replay-only"], "bad", true).ok).toBe(false);
    expect(parseMemoExecution(["execute"], id, false).ok).toBe(false);
    expect(parseMemoExecution(["replay-only"], id, false).ok).toBe(false);
  });
  it("requires one list scope and keeps query literal, case-sensitive and unnormalized", () => {
    expect(parseMemoListFilter({ projectId }, 50)).toEqual({
      ok: true,
      value: { scope: { projectId }, state: "open", query: "", limit: 50 },
    });
    expect(parseMemoListFilter({ allProjects: true, state: "all", query: "%_.* e\u0301" }, 50)).toMatchObject({
      ok: true,
      value: { query: "%_.* e\u0301" },
    });
    expect(validateMemoQuery("😀".repeat(200)).ok).toBe(true);
    expect(validateMemoQuery("😀".repeat(201)).ok).toBe(false);
    for (const limit of [1, 200])
      expect(parseMemoListFilter({ projectId, limit }, 50)).toMatchObject({ ok: true, value: { limit } });
    for (const input of [
      {},
      { projectId, allProjects: true },
      { allProjects: false },
      { projectId, state: null },
      { projectId, query: null },
      { projectId, limit: 0 },
      { projectId, limit: 201 },
      { projectId, limit: 1.5 },
      { projectId, limit: "50" },
      { projectId, cursor: "" },
    ])
      expect(parseMemoListFilter(input, 50).ok).toBe(false);
  });
  it("decodes fatal UTF-8, preserves U+FFFD and checks escaped decoded text separately", () => {
    const wire = new TextEncoder().encode(JSON.stringify({ projectId, title: "😀�" }));
    expect(decodeMemoJson(wire)).toMatchObject({ ok: true, value: { title: "😀�" } });
    for (const bytes of [
      new Uint8Array([0xff]),
      new Uint8Array([0xe2, 0x82]),
      new TextEncoder().encode("[1]"),
      new TextEncoder().encode("null"),
      new TextEncoder().encode("{"),
    ])
      expect(decodeMemoJson(bytes)).toMatchObject({ ok: false, error: { code: "MEMO_INVALID_INPUT" } });
    const escaped = decodeMemoJson(new TextEncoder().encode(`{"projectId":"${projectId}","title":"\\uD800"}`));
    expect(escaped.ok && parseMemoCreate(escaped.value).ok).toBe(false);
    const big = decodeMemoJson(
      new TextEncoder().encode(`{"projectId":"${projectId}","title":"a","body":"${"\\u0001".repeat(65_536)}"}`),
    );
    expect(big.ok && parseMemoCreate(big.value).ok).toBe(true);
    const atCap = JSON.stringify({ projectId, title: "a" }).padEnd(512 * 1024, " ");
    expect(new TextEncoder().encode(atCap).byteLength).toBe(512 * 1024);
    const decodedAtCap = decodeMemoJson(new TextEncoder().encode(atCap));
    expect(decodedAtCap.ok && parseMemoCreate(decodedAtCap.value).ok).toBe(true);
    expect(decodeMemoJson(new Uint8Array(512 * 1024 + 1))).toMatchObject({
      ok: false,
      error: { code: "MEMO_TOO_LARGE" },
    });
  });
});

describe("Memo lifecycle", () => {
  it("requires matching closing and update times through detail, receipt, summary and page boundaries", () => {
    for (const state of ["done", "dismissed"] as const) {
      const memo = inState(state);
      const summary = summarizeMemo(memo, { id: projectId, slug: "project", displayName: "Project", status: "active" });
      if (!summary.ok) throw new Error(summary.error.code);
      expect(parseMemoReceipt({ memo, changed: true, replayed: false }).ok).toBe(true);
      expect(parseMemoPage({ items: [summary.value], nextCursor: null }).ok).toBe(true);
      for (const closedAt of ["2026-09-26T23:00:00.000Z", later]) {
        const invalid = { ...memo, closedAt };
        const invalidSummary = { ...summary.value, closedAt };
        expect(parseMemoDetail(invalid).ok).toBe(false);
        expect(parseMemoReceipt({ memo: invalid, changed: true, replayed: false }).ok).toBe(false);
        expect(parseMemoSummary(invalidSummary).ok).toBe(false);
        expect(parseMemoPage({ items: [invalidSummary], nextCursor: null }).ok).toBe(false);
      }
    }
  });
  it("rejects closed creation versions through detail, receipt, summary and page boundaries", () => {
    for (const operation of ["done", "dismiss"] as const) {
      const result = changeMemo(initial(), { operation, expectedRowVersion: 1 }, later);
      if (!result.ok) throw new Error(result.error.code);
      const memo = result.value.memo;
      expect(parseMemoDetail(memo).ok).toBe(true);
      expect(parseMemoDetail({ ...memo, rowVersion: 1 }).ok).toBe(false);
      expect(parseMemoReceipt({ memo: { ...memo, rowVersion: 1 }, changed: true, replayed: false }).ok).toBe(false);
      const summary = summarizeMemo(memo, { id: projectId, slug: "project", displayName: "Project", status: "active" });
      if (!summary.ok) throw new Error(summary.error.code);
      expect(parseMemoSummary(summary.value).ok).toBe(true);
      expect(parseMemoSummary({ ...summary.value, rowVersion: 1 }).ok).toBe(false);
      expect(parseMemoPage({ items: [{ ...summary.value, rowVersion: 1 }], nextCursor: null }).ok).toBe(false);
    }
  });
  it("preserves valid UTC wall-clock values when a changed operation observes an earlier instant", () => {
    const earlier = "2026-09-26T23:00:00.000Z";
    const result = changeMemo(initial(), { operation: "done", expectedRowVersion: 1 }, earlier);
    if (!result.ok) throw new Error(result.error.code);
    expect(parseMemoDetail(result.value.memo).ok).toBe(true);
    expect(result.value.memo).toMatchObject({ createdAt: now, updatedAt: earlier, closedAt: earlier, rowVersion: 2 });
  });
  it("creates an independent User reminder without external completion evidence", () => {
    const result = createMemo(id, projectId, { title: "EPIC-013: validate", body: "git push" }, now);
    expect(result).toMatchObject({
      ok: true,
      value: {
        memo: { state: "open", rowVersion: 1, createdBy: { kind: "user", id: null }, closedAt: null },
        event: { eventType: "MEMO_CREATED", handoffId: null },
      },
    });
    if (!result.ok) return;
    expect(result.value.event).toEqual({
      memoId: id,
      handoffId: null,
      eventType: "MEMO_CREATED",
      actor: { kind: "user", id: null },
      rowVersion: 1,
      createdAt: now,
      metadata: { projectId, memoId: id, rowVersion: 1, toState: "open" },
    });
    expect(JSON.stringify(result.value.event)).not.toContain("git push");
    expect(JSON.stringify(result.value.event)).not.toContain("EPIC-013");
  });
  for (const state of MEMO_STATES) {
    for (const operation of ["update", "done", "dismiss", "reopen"] as const) {
      it(`${state} + ${operation}: state matrix and stale expectation precedence`, () => {
        const memo = inState(state);
        const version = memo.rowVersion;
        expect(parseMemoDetail(memo).ok).toBe(true);
        const request: MemoChange =
          operation === "update"
            ? { operation, expectedRowVersion: version, body: "edited" }
            : { operation, expectedRowVersion: version };
        const result = changeMemo(memo, request, later);
        const target = operation === "done" ? "done" : operation === "dismiss" ? "dismissed" : "open";
        const forbidden = state !== "open" && (operation === "update" || (target !== "open" && target !== state));
        if (forbidden) expect(result).toMatchObject({ ok: false, error: { code: "MEMO_NOT_OPEN" } });
        else {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const changed = operation === "update" || state !== target;
          expect(result.value.changed).toBe(changed);
          expect(result.value.memo).toMatchObject({
            state: target,
            rowVersion: changed ? version + 1 : version,
            createdAt: now,
            updatedAt: changed ? later : memo.updatedAt,
          });
          expect(parseMemoDetail(result.value.memo).ok).toBe(true);
          if (changed) {
            expect(result.value.memo.createdBy).toEqual(memo.createdBy);
            expect(result.value.memo.updatedBy).toEqual({ kind: "user", id: null });
            const eventTypes = {
              update: "MEMO_UPDATED",
              done: "MEMO_MARKED_DONE",
              dismiss: "MEMO_DISMISSED",
              reopen: "MEMO_REOPENED",
            };
            expect(result.value.event).toEqual({
              memoId: id,
              handoffId: null,
              eventType: eventTypes[operation],
              actor: { kind: "user", id: null },
              rowVersion: version + 1,
              createdAt: later,
              metadata: {
                projectId,
                memoId: id,
                rowVersion: version + 1,
                ...(operation === "update" ? { changedFields: ["body"] } : { fromState: state, toState: target }),
              },
            });
            const metadata = JSON.stringify(result.value.event);
            for (const content of [memo.title, memo.body, "edited"]) expect(metadata).not.toContain(content);
            expect(result.value.memo.closedAt).toBe(target === "open" ? null : later);
            expect(result.value.memo.closedBy).toEqual(target === "open" ? null : { kind: "user", id: null });
          } else {
            expect(result.value.memo).toBe(memo);
            expect(result.value.event).toBeNull();
          }
        }
        expect(changeMemo(memo, { ...request, expectedRowVersion: version + 1 }, later)).toMatchObject({
          ok: false,
          error: { code: "ROW_VERSION_CONFLICT" },
        });
        expect(memo.rowVersion).toBe(version);
      });
    }
  }
  it("normalizes updates before detecting no-op and emits changed field names only", () => {
    const memo = initial();
    expect(
      changeMemo(memo, { operation: "update", expectedRowVersion: 1, title: " Reminder ", body: memo.body }, later),
    ).toEqual({ ok: true, value: { memo, changed: false, event: null } });
    const updated = changeMemo(memo, { operation: "update", expectedRowVersion: 1, title: "new", body: "" }, later);
    expect(updated).toMatchObject({
      ok: true,
      value: { event: { eventType: "MEMO_UPDATED", metadata: { changedFields: ["title", "body"] } } },
    });
  });
  it("refuses overflow without rejecting an unchanged maximum-version no-op", () => {
    const memo = { ...initial(), rowVersion: Number.MAX_SAFE_INTEGER };
    expect(changeMemo(memo, { operation: "done", expectedRowVersion: memo.rowVersion }, later)).toMatchObject({
      ok: false,
      error: { code: "MEMO_INVALID_INPUT" },
    });
    expect(changeMemo(memo, { operation: "reopen", expectedRowVersion: memo.rowVersion }, later)).toMatchObject({
      ok: true,
      value: { changed: false },
    });
  });
  it("rejects invalid direct identity, Clock and expected-version inputs", () => {
    for (const [memoId, ownerId, time] of [
      ["bad", projectId, now],
      [id, "bad", now],
      [id, projectId, "yesterday"],
      [id, projectId, "2026-09-27T00:00:00Z"],
    ] as const) {
      expect(createMemo(memoId, ownerId, { title: "a", body: "" }, time)).toMatchObject({
        ok: false,
        error: { code: "MEMO_INVALID_INPUT" },
      });
    }
    for (const expectedRowVersion of [0, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(changeMemo(initial(), { operation: "done", expectedRowVersion }, now)).toMatchObject({
        ok: false,
        error: { code: "MEMO_INVALID_INPUT" },
      });
    expect(changeMemo(initial(), { operation: "done", expectedRowVersion: 1 }, "2026-09-27T00:00:00Z")).toMatchObject({
      ok: false,
      error: { code: "MEMO_INVALID_INPUT" },
    });
  });
  it("validates complete detail and receipt fields, closing metadata and provenance", () => {
    const memo = initial();
    expect(parseMemoDetail(memo).ok).toBe(true);
    expect(parseMemoReceipt({ memo, changed: false, replayed: true }).ok).toBe(true);
    for (const patch of [
      { extra: true },
      { rowVersion: 0 },
      { createdBy: { kind: "system", id: null } },
      { closedAt: now },
      { title: " untrimmed " },
      { state: "done" },
      { updatedAt: "yesterday" },
    ])
      expect(parseMemoDetail({ ...memo, ...patch }).ok).toBe(false);
    expect(parseMemoReceipt({ memo, changed: "false", replayed: false }).ok).toBe(false);
  });
  it("truncates previews on scalar boundaries and joins current Project labels", () => {
    const project = { id: projectId, slug: "sorage", displayName: "Renamed", status: "archived" as const };
    const memo = { ...initial(), body: `${"a".repeat(510)}😀tail` };
    expect(summarizeMemo(memo, project)).toMatchObject({
      ok: true,
      value: {
        bodyPreview: "a".repeat(510),
        bodyPreviewTruncated: true,
        projectDisplayName: "Renamed",
        projectStatus: "archived",
      },
    });
    expect(summarizeMemo({ ...memo, body: "😀".repeat(128) }, project)).toMatchObject({
      ok: true,
      value: { bodyPreviewTruncated: false },
    });
    expect(summarizeMemo(memo, { ...project, id }).ok).toBe(false);
  });
});
