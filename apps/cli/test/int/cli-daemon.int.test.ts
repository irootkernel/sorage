import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/program";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  it("reports DAEMON_UNAVAILABLE with per-invocation UUIDs in JSON and human stderr when no live record exists", () => {
    const home = tempHome("sorage-cli-daemon-none-");
    const sink = capture();
    expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports)).toBe(0);
    const status1 = capture();
    const status2 = capture();
    expect(runCli(["daemon", "status", "--json"], status1.ports)).toBe(69);
    expect(runCli(["daemon", "status", "--json"], status2.ports)).toBe(69);
    expect(status1.outText()).toBe("");
    const env1 = JSON.parse(status1.errText());
    const env2 = JSON.parse(status2.errText());
    expect(env1).toMatchObject({
      ok: false,
      error: {
        code: "DAEMON_UNAVAILABLE",
        message: "no live daemon record was found",
        details: {},
        recovery: { suggestedCommand: "sorage daemon start" },
      },
    });
    expect(env1.meta.requestId).toMatch(UUID_RE);
    expect(env2.meta.requestId).toMatch(UUID_RE);
    expect(env1.meta.requestId).not.toBe(env2.meta.requestId);

    const human = capture();
    expect(runCli(["daemon", "status"], human.ports)).toBe(69);
    expect(human.outText()).toBe("");
    expect(human.errText()).toBe(
      "DAEMON_UNAVAILABLE: no live daemon record was found\nRecovery: sorage daemon start\n",
    );
  });

  it("reports DAEMON_UNAVAILABLE on stop in JSON and human forms when nothing is running", () => {
    const home = tempHome("sorage-cli-daemon-stop-");
    const sink = capture();
    expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports)).toBe(0);
    const stop = capture();
    const code = runCli(["daemon", "stop", "--json"], stop.ports);
    expect(code).toBe(69);
    expect(stop.outText()).toBe("");
    const envelope = JSON.parse(stop.errText());
    expect(envelope.error.code).toBe("DAEMON_UNAVAILABLE");
    expect(envelope.error.details).toEqual({});
    expect(envelope.meta.requestId).toMatch(UUID_RE);

    const human = capture();
    expect(runCli(["daemon", "stop"], human.ports)).toBe(69);
    expect(human.outText()).toBe("");
    expect(human.errText()).toBe(
      "DAEMON_UNAVAILABLE: no live daemon record was found\nRecovery: sorage daemon start\n",
    );
  });

  it("refuses the lifecycle and web commands before initialization with NOT_INITIALIZED", () => {
    tempHome("sorage-cli-daemon-uninit-");
    const daemonSink = capture();
    expect(runCli(["daemon", "start", "--json"], daemonSink.ports)).toBe(78);
    expect(daemonSink.outText()).toBe("");
    const daemonErr = JSON.parse(daemonSink.errText());
    expect(daemonErr.error.code).toBe("NOT_INITIALIZED");
    expect(daemonErr.error.details.expectedConfigPath).toBeTypeOf("string");

    const webSink = capture();
    expect(runCli(["web", "--json"], webSink.ports)).toBe(78);
    expect(webSink.outText()).toBe("");
    const webErr = JSON.parse(webSink.errText());
    expect(webErr.error.code).toBe("NOT_INITIALIZED");
    expect(webErr.meta.requestId).toMatch(UUID_RE);
  });
});
