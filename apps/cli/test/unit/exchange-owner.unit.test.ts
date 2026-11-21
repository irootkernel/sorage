import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeJoinGate } from "../../src/exchange-join-gate";
import { ExchangeKeeper, type MaintainExchangeLease, ownedLeaseOf, parseMaintenance } from "../../src/exchange-owner";

const exchangeId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const expiresAt = "2026-11-20T00:00:40.000Z";
const start = "2026-11-20T00:00:00.000Z";
const pair = { exchangeId, projectId };
const initial = { ...pair, claimId: exchangeId, expiresAt, cwd: "/workspace" };
const successor = { ...initial, claimId: projectId, cwd: "/workspace/subdir" };

afterEach(() => vi.useRealTimers());

describe("Exchange keeper child refusal classification", () => {
  it.each([
    ["Error: database is locked", true, "retryable"],
    ["Error: unable to open database file", true, "failed"],
    ["Error: attempt to write a readonly database", true, "failed"],
    ["no busy signature", true, "failed"],
    ["Error: database is locked", false, "failed"],
  ])("classifies the storage cause %s with stamp %s as %s", (cause, storageContention, kind) => {
    const error = { code: "STORAGE_INSPECTION_UNAVAILABLE", details: { storageContention, cause } };
    const wire = JSON.stringify({ ok: false, error });
    expect(parseMaintenance("", wire, 75, initial)).toEqual({ kind });
  });

  it("retries a typed pause but keeps an interrupted result unconfirmed", () => {
    const wire = JSON.stringify({ ok: false, error: { code: "SERVICE_PAUSED" } });
    expect(parseMaintenance("", wire, 75, initial)).toEqual({ kind: "retryable" });
    expect(parseMaintenance("", wire, null, initial)).toEqual({ kind: "failed" });
  });
});

function keeperClock(): void {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(start));
}

describe("the Exchange join gate", () => {
  it("waits for earlier identities, serializes aliases, and removes only the exact cancelled slot", () => {
    const gate = new ExchangeJoinGate();
    const firstAck = vi.fn();
    const cancelledAck = vi.fn();
    const laterAck = vi.fn();
    const peerAck = vi.fn();
    const first = gate.add(exchangeId, firstAck);
    const queued = gate.add(exchangeId, cancelledAck);
    const later = gate.add(exchangeId, laterAck);
    const peer = gate.add(exchangeId, peerAck);
    expect(queued.announce(pair)).toBe(true);
    expect(later.announce(pair)).toBe(true);
    expect(peer.announce({ ...pair, projectId: other })).toBe(true);
    expect(cancelledAck).not.toHaveBeenCalled();
    expect(peerAck).not.toHaveBeenCalled();
    expect(first.announce(pair)).toBe(true);
    expect(firstAck).toHaveBeenCalledOnce();
    expect(peerAck).toHaveBeenCalledOnce();
    expect(laterAck).not.toHaveBeenCalled();
    queued.cancel();
    queued.finish();
    expect(cancelledAck).not.toHaveBeenCalled();
    expect(laterAck).not.toHaveBeenCalled();
    first.finish();
    expect(laterAck).toHaveBeenCalledOnce();
    later.finish();
    peer.finish();
    expect(cancelledAck).not.toHaveBeenCalled();
  });

  it("does not grant further acknowledgments while closing", () => {
    const gate = new ExchangeJoinGate();
    const waitingAck = vi.fn();
    const slot = gate.add(exchangeId, waitingAck);
    gate.close();
    expect(slot.announce(pair)).toBe(true);
    expect(waitingAck).not.toHaveBeenCalled();
    slot.finish();
  });
});

describe("the Exchange keeper", () => {
  it.each(["fenced", "confirmed", "retryable", "failed"] as const)(
    "ignores a delayed %s renewal from a replaced claim and releases only the successor",
    async (kind) => {
      keeperClock();
      let finishOld: (value: Awaited<ReturnType<MaintainExchangeLease>["result"]>) => void = () => {};
      const old = new Promise<Awaited<ReturnType<MaintainExchangeLease>["result"]>>((resolve) => {
        finishOld = resolve;
      });
      const maintain = vi.fn<MaintainExchangeLease>((operation, lease) => ({
        result:
          operation === "renew" && lease.claimId === initial.claimId
            ? old
            : Promise.resolve({ kind: "confirmed", expiresAt }),
        stop: vi.fn(),
      }));
      const keeper = new ExchangeKeeper(maintain);
      keeper.install(initial);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(maintain).toHaveBeenNthCalledWith(1, "renew", initial);
      keeper.install(successor);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(maintain).toHaveBeenCalledTimes(1);
      finishOld(kind === "confirmed" ? { kind, expiresAt } : { kind });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(maintain).toHaveBeenNthCalledWith(2, "renew", successor);
      await keeper.shutdown();
      expect(maintain).toHaveBeenNthCalledWith(3, "release", successor);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(maintain).toHaveBeenCalledTimes(3);
    },
  );

  it("stops a failed entry without releasing, acquiring, or mutating a different pair", async () => {
    keeperClock();
    const peer = { ...initial, projectId: other };
    const maintain = vi.fn<MaintainExchangeLease>((_operation, lease) => ({
      result: Promise.resolve(lease === initial ? { kind: "failed" } : { kind: "confirmed", expiresAt }),
      stop: vi.fn(),
    }));
    const stopped = vi.fn();
    const keeper = new ExchangeKeeper(maintain, stopped);
    keeper.install(initial);
    keeper.install(peer);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stopped).toHaveBeenCalledExactlyOnceWith("failed");
    expect(maintain.mock.calls).toEqual([
      ["renew", initial],
      ["renew", peer],
      ["renew", peer],
    ]);
    await keeper.shutdown();
    expect(maintain.mock.calls.slice(-2)).toEqual([
      ["release", initial],
      ["release", peer],
    ]);
  });

  it("retries a definitive refusal with the exact claim, then resumes the steady cadence", async () => {
    keeperClock();
    const renewedUntil = "2026-11-20T00:00:51.000Z";
    const maintain = vi
      .fn<MaintainExchangeLease>()
      .mockReturnValueOnce({ result: Promise.resolve({ kind: "retryable" }), stop: vi.fn() })
      .mockReturnValue({ result: Promise.resolve({ kind: "confirmed", expiresAt: renewedUntil }), stop: vi.fn() });
    const stopped = vi.fn();
    const keeper = new ExchangeKeeper(maintain, stopped);
    const lease = { ...initial };
    keeper.install(lease);
    await vi.advanceTimersByTimeAsync(10_999);
    expect(maintain.mock.calls).toEqual([["renew", lease]]);
    expect(lease.expiresAt).toBe(expiresAt);
    await vi.advanceTimersByTimeAsync(1);
    expect(maintain.mock.calls).toEqual([
      ["renew", lease],
      ["renew", lease],
    ]);
    expect(lease.expiresAt).toBe(renewedUntil);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(maintain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(maintain).toHaveBeenCalledTimes(3);
    expect(stopped).not.toHaveBeenCalled();
    expect(await keeper.shutdown()).toBe(true);
    expect(maintain).toHaveBeenLastCalledWith("release", lease);
  });

  it("stops at expiry without sending a scheduled retry", async () => {
    keeperClock();
    const lease = { ...initial, expiresAt: "2026-11-20T00:00:10.500Z" };
    const maintain = vi
      .fn<MaintainExchangeLease>()
      .mockReturnValue({ result: Promise.resolve({ kind: "retryable" }), stop: vi.fn() });
    const stopped = vi.fn();
    const keeper = new ExchangeKeeper(maintain, stopped);
    keeper.install(lease);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stopped).toHaveBeenCalledExactlyOnceWith("expired");
    expect(maintain.mock.calls).toEqual([["renew", lease]]);
    expect(await keeper.shutdown()).toBe(true);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("quiesces a scheduled retry and gracefully releases the retained exact claim", async () => {
    keeperClock();
    const maintain = vi
      .fn<MaintainExchangeLease>()
      .mockReturnValueOnce({ result: Promise.resolve({ kind: "retryable" }), stop: vi.fn() })
      .mockReturnValue({ result: Promise.resolve({ kind: "confirmed", expiresAt }), stop: vi.fn() });
    const keeper = new ExchangeKeeper(maintain);
    keeper.install(initial);
    await vi.advanceTimersByTimeAsync(10_000);
    keeper.quiesce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(maintain.mock.calls).toEqual([["renew", initial]]);
    expect(await keeper.shutdown()).toBe(true);
    expect(maintain.mock.calls).toEqual([
      ["renew", initial],
      ["release", initial],
    ]);
  });

  it("lets an in-flight renewal finish before releasing the exact claim on shutdown", async () => {
    keeperClock();
    let finishRenewal: (result: Awaited<ReturnType<MaintainExchangeLease>["result"]>) => void = () => {};
    const renewal = new Promise<Awaited<ReturnType<MaintainExchangeLease>["result"]>>((resolve) => {
      finishRenewal = resolve;
    });
    const stop = vi.fn();
    const maintain = vi
      .fn<MaintainExchangeLease>()
      .mockReturnValueOnce({ result: renewal, stop })
      .mockReturnValue({ result: Promise.resolve({ kind: "confirmed", expiresAt }), stop: vi.fn() });
    const keeper = new ExchangeKeeper(maintain);
    keeper.install(initial);
    await vi.advanceTimersByTimeAsync(10_000);

    const shutdown = keeper.shutdown();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(stop).not.toHaveBeenCalled();
    expect(maintain).toHaveBeenCalledExactlyOnceWith("renew", initial);
    finishRenewal({ kind: "confirmed", expiresAt });
    expect(await shutdown).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(maintain.mock.calls).toEqual([
      ["renew", initial],
      ["release", initial],
    ]);
  });

  it("only recognizes a definitive Active join result with complete exact authority", () => {
    expect(ownedLeaseOf({ ...initial, state: "active" }, initial.cwd)).toEqual(initial);
    for (const state of ["paused", "completed", undefined]) {
      expect(ownedLeaseOf({ ...initial, state }, initial.cwd)).toBeUndefined();
    }
    expect(ownedLeaseOf({ ...initial, state: "active", claimId: undefined }, initial.cwd)).toBeUndefined();
  });

  it("retries a definitive no-commit release with the same claim and reports uncertainty", async () => {
    const maintain = vi
      .fn<MaintainExchangeLease>()
      .mockReturnValueOnce({ result: Promise.resolve({ kind: "retryable" }), stop: vi.fn() })
      .mockReturnValueOnce({ result: Promise.resolve({ kind: "confirmed", expiresAt }), stop: vi.fn() });
    const keeper = new ExchangeKeeper(maintain);
    keeper.install(initial);
    expect(await keeper.shutdown()).toBe(true);
    expect(maintain.mock.calls).toEqual([
      ["release", initial],
      ["release", initial],
    ]);
    const uncertain = vi
      .fn<MaintainExchangeLease>()
      .mockReturnValue({ result: Promise.resolve({ kind: "failed" }), stop: vi.fn() });
    const other = new ExchangeKeeper(uncertain);
    other.install(successor);
    expect(await other.shutdown()).toBe(false);
    expect(uncertain.mock.calls).toEqual([["release", successor]]);
  });
});
