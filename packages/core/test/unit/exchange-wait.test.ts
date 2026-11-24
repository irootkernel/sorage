import { describe, expect, it } from "vitest";
import { appError, err, ok } from "../../src/shared/errors";
import {
  encodeExchangeHistoryCursor,
  type ExchangeHistoryCursor,
  exchangeProjection,
  readExchangeHistoryCursor,
  waitForExchangeActivity,
} from "../../src/exchange/exchange-wait";

const exchangeId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const projection = exchangeProjection("active", [projectId, other]);
const cursor: ExchangeHistoryCursor = { version: 1, exchangeId, projectId, seq: 2, projection };
const token = encodeExchangeHistoryCursor(cursor);

describe("Exchange delivery cursors", () => {
  it("validates canonical shape, pair, state projection and feasible sequence", () => {
    expect(readExchangeHistoryCursor(token, exchangeId, projectId, 3)).toEqual(ok(cursor));
    expect(exchangeProjection("active", [other, projectId])).toBe(projection);
    expect(exchangeProjection("paused", [other, projectId])).not.toBe(projection);
    expect(exchangeProjection("active", [projectId])).not.toBe(projection);
    for (const value of [
      `${token}=`,
      "",
      "invalid",
      "a".repeat(513),
      encodeExchangeHistoryCursor({ ...cursor, projectId: other }),
      encodeExchangeHistoryCursor({ ...cursor, exchangeId: other }),
      encodeExchangeHistoryCursor({ ...cursor, seq: 4 }),
      encodeExchangeHistoryCursor({ ...cursor, projection: "nondigest" }),
    ]) {
      expect(readExchangeHistoryCursor(value, exchangeId, projectId, 3)).toMatchObject({
        ok: false,
        error: { code: "EXCHANGE_INVALID_INPUT" },
      });
    }
  });

  it("carries a quiet poll cursor through one retryable failure until newly changed state", () => {
    let now = 0;
    const seen: Array<string | undefined> = [];
    const baseline = { exchangeId, projectId, messages: [], cursor: token, stateChanged: false };
    const changed = { ...baseline, stateChanged: true };
    const result = waitForExchangeActivity({
      now: () => now,
      sleep: (ms) => {
        now += ms;
      },
      timeoutSeconds: 8,
      intervalSeconds: 2,
      poll: (cursor) => {
        seen.push(cursor);
        if (seen.length === 1) return ok(baseline);
        if (seen.length === 2) return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy"));
        return ok(changed);
      },
    });
    expect(seen).toEqual([undefined, token, token]);
    expect(now).toBe(4_000);
    expect(result).toEqual(ok({ ...changed, timedOut: false }));
  });

  it("bounds quiet or unavailable polling and never turns persistent storage failure into success", () => {
    for (const available of [true, false]) {
      let now = 0;
      const baseline = { exchangeId, projectId, messages: [], cursor: token, stateChanged: false };
      const unavailable = err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy"));
      const result = waitForExchangeActivity({
        now: () => now,
        sleep: (ms) => {
          now += ms;
        },
        timeoutSeconds: 3,
        intervalSeconds: 2,
        poll: () => (available ? ok(baseline) : unavailable),
      });
      expect(now).toBe(3_000);
      expect(result).toEqual(available ? ok({ ...baseline, timedOut: true }) : unavailable);
    }
  });
});
