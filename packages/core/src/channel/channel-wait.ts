import type { Clock } from "../primitives/ids";
import { sleepWithinDeadline } from "../primitives/polling";
import { type AppError, err, isRetryableWaitListingFailure, ok, type Result } from "../shared/errors";

export interface ChannelWaitOptions<T> {
  intervalSeconds: number;
  /** The deadline instant, measured by the caller at invocation (section 38.5). */
  deadlineAt: number;
  /** The clock used to measure remaining wait time against the deadline. */
  clock: Clock;
  sleepMs: (ms: number) => void;
  /**
   * One poll: opens storage afresh, validates the Channel and the `--from`
   * handle on the first successful poll, and returns the matching unhandled
   * page. Every poll's storage refusal flows back here so the wait's own
   * retry classification decides it (CHN-007).
   */
  poll: () => Result<T[], AppError>;
}

/**
 * The Channel wait of CHN-007 and section 38.5: pending-inclusive — it returns
 * immediately when any unhandled message matches its filter at invocation —
 * and otherwise polls at the interval until an arrival or the deadline
 * measured from invocation. A retried read-side
 * `STORAGE_INSPECTION_UNAVAILABLE` keeps the wait polling and only a failure
 * persisting at the deadline is reported as that typed error; every other
 * failure ends the wait at once. The wait never mutates anything, and its
 * admission ran once at its start: a poll consults no lock (RDR-001, RDR-005).
 */
export function waitForChannelMessages<T>(options: ChannelWaitOptions<T>): Result<{ timedOut: boolean; items: T[] }> {
  const deadline = options.deadlineAt;
  let tracked: AppError | null = null;
  for (;;) {
    const page = options.poll();
    if (page.ok) {
      if (page.value.length > 0) return ok({ timedOut: false, items: page.value });
      // A later successful poll clears an earlier retried failure: only a
      // failure that persists at the deadline is reported.
      tracked = null;
    } else if (isRetryableWaitListingFailure(page.error)) {
      tracked = page.error;
    } else {
      return err(page.error);
    }
    if (
      !sleepWithinDeadline(deadline, options.clock.now().getTime(), options.intervalSeconds * 1000, options.sleepMs)
    ) {
      if (tracked !== null) return err(tracked);
      return ok({ timedOut: true, items: [] });
    }
  }
}
