import { type AppError, appError, err, type Result } from "@sorage/core";
import type { HomePaths } from "./home";
import { acquireLock, createNodeLockProbePorts } from "./lockfile";

/** Serializes derived marker refresh and retired-path cleanup across processes. */
export function withInboxMarkerLock<T>(home: HomePaths, body: () => Result<T, AppError>): Result<T, AppError> {
  const deadline = Date.now() + 5_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let acquired: ReturnType<typeof acquireLock>;
    try {
      acquired = acquireLock({
        path: home.lockFile("inbox-marker"),
        lock: "inbox-marker",
        ports: createNodeLockProbePorts(),
      });
    } catch (error) {
      return err(
        appError(
          "INTERNAL_ERROR",
          `the inbox marker lock could not be acquired: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if (acquired.ok) {
      try {
        return body();
      } finally {
        acquired.release();
      }
    }
    if (Date.now() >= deadline) {
      return err(appError("INTERNAL_ERROR", "the inbox marker is busy; retry the operation"));
    }
    Atomics.wait(waitCell, 0, 0, 10);
  }
}
