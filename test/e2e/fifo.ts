import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * A FIFO whose reader blocks forever: the send that stages from it must be killed
 * mid-operation, which is the externally deterministic crash of the AJ-08 journey.
 */
export function withFifo(body: (fifoPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sorage-e2e-fifo-"));
  const fifoPath = join(dir, "source.md");
  execFileSync("mkfifo", [fifoPath]);
  try {
    body(fifoPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
