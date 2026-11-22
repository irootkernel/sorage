import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeDaemonPorts } from "../../src/daemon-command-ports";

const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

describe("createNodeDaemonPorts acquireDaemonLock owner-checked release (TASK-149 #8)", () => {
  it("removes daemon.lock when still owned and preserves a lock taken over by another owner", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-daemon-lock-"));
    homes.push(home);
    const ports = createNodeDaemonPorts({ env: { SORAGE_HOME: home, HOME: home } });
    const lockPath = ports.home.lockFile("daemon");

    // Normal acquire & release removes own lock.
    const first = ports.acquireDaemonLock();
    expect(first.ok).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    first.release?.();
    expect(existsSync(lockPath)).toBe(false);

    // If another owner takes over daemon.lock, releasing the prior handle must NOT delete it.
    const second = ports.acquireDaemonLock();
    expect(second.ok).toBe(true);
    const takeoverRecord = `${JSON.stringify({ pid: process.pid + 1, startedAt: "2026-11-22T12:00:00.000Z", hostname: "other-host" })}\n`;
    writeFileSync(lockPath, takeoverRecord, "utf8");

    second.release?.();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(takeoverRecord);
  });
});
