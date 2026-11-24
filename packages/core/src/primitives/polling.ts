/** Remaining wait budget in milliseconds, clamped at zero. */
export function remainingMs(deadlineMs: number, nowMs: number): number {
  return Math.max(0, deadlineMs - nowMs);
}

/**
 * Sleeps up to `intervalMs` within the remaining deadline budget.
 * Returns `false` without sleeping when the deadline has been reached.
 */
export function sleepWithinDeadline(
  deadlineMs: number,
  nowMs: number,
  intervalMs: number,
  sleepMs: (milliseconds: number) => void,
): boolean {
  const remaining = remainingMs(deadlineMs, nowMs);
  if (remaining <= 0) return false;
  sleepMs(Math.min(intervalMs, remaining));
  return true;
}
