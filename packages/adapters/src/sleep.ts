/**
 * The blocking sleep behind `inbox --wait` (CLI-020): the CLI process is single
 * threaded by design, so one poll gap is a synchronous wait that keeps every command
 * synchronous and the process exit code deterministic. `Atomics.wait` is the only
 * portable synchronous sleep; callers that need time to flow concurrently run the
 * command as a separate process, which is exactly how the wait is specified.
 */
export function blockingSleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
