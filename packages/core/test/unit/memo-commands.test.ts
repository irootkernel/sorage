import { describe, expect, it } from "vitest";
import { addMemo, mutateMemo, listMemos, showMemo, type MemoCommandPorts, type MemoRepository } from "../../src/index";

const id = "ab000000-0000-4000-8000-000000000001";
const projectId = "cd000000-0000-4000-8000-000000000001";

describe("Memo application validation before storage", () => {
  const ports: MemoCommandPorts = {
    installationId: id,
    defaultPageSize: 20,
    memos: new Proxy({} as MemoRepository, {
      get() {
        throw new Error("Invalid input reached storage");
      },
    }),
    clock: {
      now() {
        throw new Error("Invalid input sampled Clock");
      },
    },
    ids: {
      next() {
        throw new Error("Invalid input allocated identity");
      },
    },
  };
  it("rejects invalid current input even when the key could name a committed receipt", () => {
    const policy = { mode: "replay-only" as const, idempotencyKey: id };
    for (const input of [
      { projectId, title: "\ud800" },
      { projectId, title: "valid", body: "\udfff" },
      { projectId, title: "valid", body: "x".repeat(65537) },
      { projectId, title: "valid", body: null },
      { projectId, title: "valid", createdBy: { kind: "user", id: null } },
    ])
      expect(addMemo(ports, input, policy).ok).toBe(false);
    expect(mutateMemo(ports, "update", id, { expectedRowVersion: 1, body: null }, policy).ok).toBe(false);
    expect(mutateMemo(ports, "done", id, { expectedRowVersion: Number.MAX_SAFE_INTEGER + 1 }, policy).ok).toBe(false);
    expect(addMemo(ports, { projectId, title: "valid" }, { mode: "replay-only" }).ok).toBe(false);
    expect(addMemo({ ...ports, installationId: "invalid" }, { projectId, title: "valid" }, policy).ok).toBe(false);
  });
  it("rejects malformed read targets and cursors instead of falling back to broad discovery", () => {
    expect(showMemo(ports, "invalid").ok).toBe(false);
    expect(showMemo(ports, id, "invalid").ok).toBe(false);
    for (const input of [
      {},
      { projectId, allProjects: true },
      { projectId, cursor: "tampered" },
      { projectId, limit: 201 },
      { projectId, query: "x".repeat(201) },
    ])
      expect(listMemos(ports, input).ok).toBe(false);
  });
});
