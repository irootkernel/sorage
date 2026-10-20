import { afterEach } from "vitest";

// The Vitest worker transport acknowledges runner RPCs (for example the
// onTaskUpdate notifications) only when the event loop receives a turn. A long
// synchronous integration or E2E suite can starve that turn past the
// transport's fixed deadline and fail an otherwise green run, so every test
// hands the loop one real macrotask turn before the next one starts. The
// native setImmediate is captured before any test can install fake timers, and
// the turn adds no assertion, timeout, retry, or pool behavior.
const nativeSetImmediate = setImmediate;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    nativeSetImmediate(resolve);
  });
});
