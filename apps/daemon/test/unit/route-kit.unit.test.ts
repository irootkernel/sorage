import { describe, expect, it } from "vitest";
import { discardReplay, evaluateIdempotency, storeReplay } from "../../src/route-kit";

/**
 * The Idempotency-Key seam of API-012: a duplicate that arrives while the first
 * execution is still in flight is refused instead of executed twice, and a failed
 * execution releases its marker so the key stays retryable.
 */
type Store = Map<string, { requestHash: string; status: number; body: unknown }>;

describe("the idempotency store (API-012)", () => {
  it("refuses a duplicate whose key is still in flight", () => {
    const store: Store = new Map();
    const key = "aaaaaaaa-0000-4000-8000-000000000001";
    const first = evaluateIdempotency(store, key, "POST /one body-a");
    expect(first.replayed).toBe(false);
    expect(first.error).toBeUndefined();
    // The first execution has not stored its response yet: a concurrent duplicate
    // must not execute the mutation a second time.
    const duplicate = evaluateIdempotency(store, key, "POST /one body-a");
    expect(duplicate.replayed).toBe(false);
    expect(duplicate.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(String(duplicate.error?.message)).toContain("still in flight");
  });

  it("releases the in-flight marker when the execution fails, keeping the key retryable", () => {
    const store: Store = new Map();
    const key = "aaaaaaaa-0000-4000-8000-000000000002";
    expect(evaluateIdempotency(store, key, "POST /two body-a").replayed).toBe(false);
    discardReplay(store, key);
    // After the failure the same key evaluates fresh again instead of conflicting
    // forever, and a stored response is never discarded by the failure path.
    const retry = evaluateIdempotency(store, key, "POST /two body-a");
    expect(retry.replayed).toBe(false);
    expect(retry.error).toBeUndefined();

    storeReplay(store, key, "POST /two body-a", 201, { ok: true });
    discardReplay(store, key);
    const replay = evaluateIdempotency(store, key, "POST /two body-a");
    expect(replay.replayed).toBe(true);
  });

  it("conflicts on a different request under the same key and replays the same one", () => {
    const store: Store = new Map();
    const key = "aaaaaaaa-0000-4000-8000-000000000003";
    expect(evaluateIdempotency(store, key, "POST /three body-a").replayed).toBe(false);
    storeReplay(store, key, "POST /three body-a", 201, { marker: "stored" });
    const replayed = evaluateIdempotency(store, key, "POST /three body-a");
    expect(replayed.replayed).toBe(true);
    expect(replayed.body).toEqual({ marker: "stored" });
    const diverged = evaluateIdempotency(store, key, "POST /three body-b");
    expect(diverged.replayed).toBe(false);
    expect(diverged.error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
