import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-044 lifecycle commands through the real CLI wiring where the runtime
 * boundary does not need a spawned daemon: the discovery failure and stale-record
 * cleanup. The spawn-and-conflict journey is AJ-11, exercised against the compiled
 * binary in the e2e suite.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

describe("sorage daemon lifecycle (RUN-006, RUN-013)", () => {
  it("reports DAEMON_UNAVAILABLE when no live record exists", () => {
    const home = tempHome("sorage-cli-daemon-none-");
    const sink = capture();
    expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports)).toBe(0);
    const status = capture();
    const code = runCli(["daemon", "status", "--json"], status.ports);
    expect(code).toBe(69);
    expect(JSON.parse(status.errText()).error.code).toBe("DAEMON_UNAVAILABLE");
  });

  it("reports DAEMON_UNAVAILABLE on stop when nothing is running", () => {
    const home = tempHome("sorage-cli-daemon-stop-");
    const sink = capture();
    expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports)).toBe(0);
    const stop = capture();
    const code = runCli(["daemon", "stop", "--json"], stop.ports);
    expect(code).toBe(69);
    expect(JSON.parse(stop.errText()).error.code).toBe("DAEMON_UNAVAILABLE");
  });

  it("refuses the lifecycle commands before initialization", () => {
    tempHome("sorage-cli-daemon-uninit-");
    const sink = capture();
    expect(runCli(["daemon", "start", "--json"], sink.ports)).toBe(78);
    expect(JSON.parse(sink.errText()).error.code).toBe("NOT_INITIALIZED");
  });
});
