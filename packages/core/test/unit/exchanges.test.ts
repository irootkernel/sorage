import { describe, expect, it, vi } from "vitest";
import { appError, err, ok } from "../../src/shared/errors";
import {
  commitExchangeBusiness,
  type ExchangeBusinessRepository,
  planExchangeBusiness,
} from "../../src/exchange/exchange-use-cases";
import {
  authorizeExchangeJoin,
  type ExchangeBusinessInput,
  type ExchangeCommandPorts,
  exchangeFingerprint,
  exchangeWorkflowText,
  normalizeExchangeRanges,
  requireExchangeAcceptance,
  requireExchangeClaim,
  requireExchangeReport,
  runExchangeCommand,
  unconfirmedExchangeRanges,
  validateExchangeExternal,
} from "../../src/exchange/exchanges";

const exchangeId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-11-20T00:00:00.000Z");
const send: ExchangeBusinessInput = {
  kind: "send",
  exchangeId,
  claim: "current",
  operationId: "send-1",
  replayOnly: false,
  messageKind: "progress",
  body: { text: "Measured result" },
  accept: [],
};

describe("core Exchange admission and fences", () => {
  it("uses the completed read decision for ordinary replay and never opens a writer for explicit recovery", () => {
    const executeFresh = vi.fn<ExchangeCommandPorts["executeFresh"]>();
    const replayed = { kind: "send" as const, exchangeId, seq: 2, materialId: exchangeId, replayed: true };
    const ports: ExchangeCommandPorts = {
      inspect: vi.fn(() => ok({ data: replayed })),
      executeFresh,
    };
    expect(runExchangeCommand(ports, send)).toEqual(ok(replayed));
    expect(runExchangeCommand(ports, { ...send, replayOnly: true })).toEqual(ok(replayed));
    for (const code of [
      "EXCHANGE_REPLAY_UNAVAILABLE",
      "FORBIDDEN_ACTOR",
      "IDEMPOTENCY_CONFLICT",
      "STORAGE_MIGRATION_REQUIRED",
    ] as const) {
      const refusal = err(appError(code, "read decision"));
      expect(runExchangeCommand({ ...ports, inspect: () => refusal }, { ...send, replayOnly: true })).toEqual(refusal);
      expect(runExchangeCommand({ ...ports, inspect: () => refusal }, { kind: "inspect", exchangeId })).toEqual(
        refusal,
      );
    }
    expect(executeFresh).not.toHaveBeenCalled();
  });

  it("passes the inspected fingerprint only into a fresh execution and permits actual older-schema writers", () => {
    const sent = { kind: "send" as const, exchangeId, seq: 3, materialId: exchangeId, replayed: false };
    const executeFresh = vi.fn<ExchangeCommandPorts["executeFresh"]>(() => ok(sent));
    expect(runExchangeCommand({ inspect: () => ok({ fingerprint: "observed" }), executeFresh }, send)).toEqual(
      ok(sent),
    );
    expect(executeFresh).toHaveBeenLastCalledWith(send, "observed");
    const older = err(appError("STORAGE_MIGRATION_REQUIRED", "a known earlier schema"));
    expect(runExchangeCommand({ inspect: () => older, executeFresh }, send)).toEqual(ok(sent));
    expect(executeFresh).toHaveBeenLastCalledWith(send, undefined);
    const denied = err(appError("FORBIDDEN_ACTOR", "current access denied"));
    expect(runExchangeCommand({ inspect: () => denied, executeFresh }, send)).toEqual(denied);
    expect(executeFresh).toHaveBeenCalledTimes(2);
  });

  it("separates the public competing claim observation from its write authority and refuses expiry at the fence", () => {
    const live = { claimId: "private-fence", expiresAt: "2026-11-20T00:00:01.000Z" };
    const observed = exchangeFingerprint({ competingClaim: live.claimId });
    expect(requireExchangeClaim(live, live.claimId, now).ok).toBe(true);
    expect(requireExchangeClaim(live, observed, now).ok).toBe(false);
    expect(requireExchangeClaim(live, live.claimId, new Date(live.expiresAt)).ok).toBe(false);
    expect(authorizeExchangeJoin(live, undefined, false, now)).toMatchObject({
      ok: false,
      error: { code: "EXCHANGE_CLAIM_CONFLICT", details: { observedClaim: observed } },
    });
    expect(authorizeExchangeJoin(live, observed, false, now)).toMatchObject({
      error: { code: "CONFIRMATION_REQUIRED" },
    });
    expect(authorizeExchangeJoin(live, observed, true, now).ok).toBe(true);
    expect(authorizeExchangeJoin({ ...live, claimId: "successor" }, observed, true, now).ok).toBe(false);
  });

  it("fences actual ownership and observed report versions independently of claims", () => {
    const request = {
      id: exchangeId,
      requesterId: "alpha",
      assigneeId: "beta",
      assignmentVersion: 2,
      condition: "Check the repair",
      criteria: ["Observe the edge"],
    };
    expect(requireExchangeReport(request, "beta", 2).ok).toBe(true);
    expect(requireExchangeReport(request, "beta", 1)).toMatchObject({ error: { code: "ROW_VERSION_CONFLICT" } });
    expect(requireExchangeReport(request, "alpha", 2)).toMatchObject({ error: { code: "FORBIDDEN_ACTOR" } });
    expect(requireExchangeAcceptance(request, "alpha", 3, 3, false).ok).toBe(true);
    expect(requireExchangeAcceptance(request, "alpha", 2, 3, false)).toMatchObject({
      error: { code: "ROW_VERSION_CONFLICT" },
    });
    expect(requireExchangeAcceptance(request, "beta", 3, 3, false)).toMatchObject({
      error: { code: "FORBIDDEN_ACTOR" },
    });
    expect(requireExchangeAcceptance(request, "alpha", 3, 3, true).ok).toBe(false);
  });

  it("counts aggregate UTF-8 workflow text, preserves gaps and keeps external descriptors inert", () => {
    expect(exchangeWorkflowText("é".repeat(4_094), ["ab", "cd"])).toBe(true);
    expect(exchangeWorkflowText("é".repeat(4_094), ["ab", "cde"])).toBe(false);
    expect(
      normalizeExchangeRanges([
        { firstSeq: 6, lastSeq: 7 },
        { firstSeq: 1, lastSeq: 2 },
        { firstSeq: 7, lastSeq: 8 },
      ]),
    ).toEqual(
      ok([
        { firstSeq: 1, lastSeq: 2 },
        { firstSeq: 6, lastSeq: 8 },
      ]),
    );
    expect(validateExchangeExternal({ access: "run-id", value: "ci/qualified-001" })).toBe(true);
    expect(validateExchangeExternal({ access: "url", value: "https://ci.example.test/runs/001" })).toBe(true);
    expect(validateExchangeExternal({ access: "url", value: "https://ci.example.test/runs/001?token=synthetic" })).toBe(
      false,
    );
    expect(validateExchangeExternal({ access: "query", value: "authorization: bounded-placeholder" })).toBe(false);
  });

  it("subtracts only already-confirmed sequences from normalized requests", () => {
    const covered = [
      { firstSeq: 1, lastSeq: 2 },
      { firstSeq: 5, lastSeq: 5 },
    ];
    expect(unconfirmedExchangeRanges([{ firstSeq: 1, lastSeq: 2 }], covered)).toEqual([]);
    expect(unconfirmedExchangeRanges([{ firstSeq: 5, lastSeq: 6 }], covered)).toEqual([{ firstSeq: 6, lastSeq: 6 }]);
    expect(unconfirmedExchangeRanges([{ firstSeq: 4, lastSeq: 6 }], covered)).toEqual([
      { firstSeq: 4, lastSeq: 4 },
      { firstSeq: 6, lastSeq: 6 },
    ]);
    expect(
      unconfirmedExchangeRanges(
        [
          { firstSeq: 1, lastSeq: 2 },
          { firstSeq: 4, lastSeq: 6 },
        ],
        [{ firstSeq: 2, lastSeq: 5 }],
      ),
    ).toEqual([
      { firstSeq: 1, lastSeq: 1 },
      { firstSeq: 6, lastSeq: 6 },
    ]);
  });

  it("normalizes named acceptances as a set and checks every role before calling mutation ports", () => {
    const otherRequest = "22222222-2222-4222-8222-222222222222";
    const addAcceptance = vi.fn<ExchangeBusinessRepository["addAcceptance"]>();
    const saveOutcome = vi.fn<ExchangeBusinessRepository["saveOutcome"]>();
    const appendMessage = vi.fn<ExchangeBusinessRepository["appendMessage"]>();
    const repo: ExchangeBusinessRepository = {
      actorId: "alpha",
      project: () => ok(null),
      activeMember: () => true,
      hasMessage: () => true,
      hasMaterial: () => true,
      request: (_id, requestId) => ({
        id: requestId,
        requesterId: requestId === otherRequest ? "beta" : "alpha",
        assigneeId: "peer",
        assignmentVersion: 1,
        condition: "Verify actual evidence",
        criteria: ["Check both pages"],
      }),
      latestReport: () => 1,
      isAccepted: () => false,
      claim: () => ({ claimId: "current", expiresAt: "2026-11-20T00:00:01.000Z" }),
      now: () => now,
      newId: () => exchangeId,
      createExchange: vi.fn(),
      addMaterial: () => exchangeId,
      addRequest: vi.fn(),
      addReport: vi.fn(),
      addAcceptance,
      appendMessage,
      saveOutcome,
    };
    const input = {
      kind: "accept",
      exchangeId,
      claim: "current",
      operationId: "named",
      replayOnly: false,
      accept: [
        { requestId: exchangeId, reportVersion: 1 },
        { requestId: otherRequest, reportVersion: 1 },
      ],
    } satisfies ExchangeBusinessInput;
    const prepared = planExchangeBusiness(repo, input, {});
    const reversed = planExchangeBusiness(repo, { ...input, accept: [...input.accept].reverse() }, {});
    if (!prepared.ok || !reversed.ok) throw new Error("Expected both valid input plans.");
    expect(reversed.value.fingerprint).toBe(prepared.value.fingerprint);
    expect(commitExchangeBusiness(repo, input, prepared.value, () => {})).toMatchObject({
      error: { code: "FORBIDDEN_ACTOR" },
    });
    expect(addAcceptance).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(saveOutcome).not.toHaveBeenCalled();
  });
});
