import { describe, expect, it } from "vitest";
import { waitForChannelMessages } from "../../src/channels";
import { type AppError, appError, err, ok, type Result } from "../../src/errors";

/**
 * The rebuilt Channel wait of CHN-007 and section 38.5: pending-inclusive,
 * polling at the interval from a deadline measured at invocation, retrying
 * read-side `STORAGE_INSPECTION_UNAVAILABLE` until the deadline, failing at
 * once on every other code — `SERVICE_PAUSED` from the start admission
 * included — and reporting the empty timeout outcome separately from a
 * persistent typed failure. The loop itself consults no lock between polls;
 * the admission ran once at the wait's start in the CLI composition.
 */

/** A deadline the given seconds from now, as the CLI measures it at invocation. */
const deadlineIn = (seconds: number): number => Date.now() + seconds * 1000;

function recorder(script: Array<Result<string[], AppError>>): { poll: () => Result<string[], AppError> } {
  let calls = 0;
  return {
    poll: () => {
      const next = script[Math.min(calls, script.length - 1)] as Result<string[], AppError>;
      calls += 1;
      return next;
    },
  };
}

const contention = (): AppError => appError("STORAGE_INSPECTION_UNAVAILABLE", "contended");
const paused = (): AppError => appError("SERVICE_PAUSED", "A Vault move or restore is in progress");

describe("the rebuilt Channel wait loop", () => {
  it("returns immediately when a poll finds a matching unhandled message", () => {
    const sleeps: number[] = [];
    const harness = recorder([ok([]), ok(["m1"])]);
    const waited = waitForChannelMessages({
      intervalSeconds: 1,
      deadlineAt: deadlineIn(30),
      sleepMs: (ms) => sleeps.push(ms),
      poll: harness.poll,
    });
    expect(waited.ok).toBe(true);
    if (waited.ok) {
      expect(waited.value.timedOut).toBe(false);
      expect(waited.value.items).toEqual(["m1"]);
    }
    expect(sleeps.length).toBe(1);
  });

  it("times out with the empty outcome when no arrival appears", () => {
    const sleeps: number[] = [];
    const harness = recorder([ok([])]);
    const start = Date.now();
    const waited = waitForChannelMessages({
      intervalSeconds: 1,
      deadlineAt: deadlineIn(0),
      sleepMs: (ms) => sleeps.push(ms),
      poll: harness.poll,
    });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(waited.ok).toBe(true);
    if (waited.ok) {
      expect(waited.value.timedOut).toBe(true);
      expect(waited.value.items).toEqual([]);
    }
    expect(sleeps).toEqual([]);
  });

  it("retries read-side storage contention until the deadline and reports a persistent failure as that typed error", () => {
    const sleeps: number[] = [];
    const harness = recorder([err(contention())]);
    const waited = waitForChannelMessages({
      intervalSeconds: 1,
      deadlineAt: deadlineIn(0),
      sleepMs: (ms) => sleeps.push(ms),
      poll: harness.poll,
    });
    expect(waited.ok).toBe(false);
    if (!waited.ok) expect(waited.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
  });

  it("clears an earlier retried failure on a later successful poll", () => {
    const sleeps: number[] = [];
    const script: Array<Result<string[], AppError>> = [err(contention()), ok([]), ok(["m2"])];
    let calls = 0;
    const waited = waitForChannelMessages({
      intervalSeconds: 1,
      deadlineAt: deadlineIn(60),
      sleepMs: (ms) => sleeps.push(ms),
      poll: () => {
        const next = script[Math.min(calls, script.length - 1)] as Result<string[], AppError>;
        calls += 1;
        return next;
      },
    });
    expect(waited.ok).toBe(true);
    if (waited.ok) expect(waited.value.items).toEqual(["m2"]);
  });

  it("fails at once on a non-retryable code, the start admission's SERVICE_PAUSED included", () => {
    for (const error of [paused(), appError("CHN_PARTICIPANT_NOT_FOUND", "x"), appError("CONTENT_CORRUPTED", "x")]) {
      const sleeps: number[] = [];
      let calls = 0;
      const waited = waitForChannelMessages({
        intervalSeconds: 1,
        deadlineAt: deadlineIn(60),
        sleepMs: (ms) => sleeps.push(ms),
        poll: () => {
          calls += 1;
          return err(error);
        },
      });
      expect(waited.ok).toBe(false);
      if (!waited.ok) expect(waited.error.code).toBe(error.code);
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("never sleeps past the deadline: the final wait is the remaining time", () => {
    const sleeps: number[] = [];
    const harness = recorder([ok([])]);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const waited = waitForChannelMessages({
      intervalSeconds: 30,
      deadlineAt: deadlineIn(1),
      // A real synchronous sleep, so the poll loop advances the wall clock.
      sleepMs: (ms) => {
        sleeps.push(ms);
        Atomics.wait(wait, 0, 0, ms);
      },
      poll: harness.poll,
    });
    expect(waited.ok).toBe(true);
    if (waited.ok) expect(waited.value.timedOut).toBe(true);
    // The single sleep is the remaining budget, not the full interval.
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeLessThanOrEqual(1000);
  });
});
