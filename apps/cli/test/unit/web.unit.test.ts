import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appError, defaultConfiguration, err, ok } from "@sorage/core";
import { afterAll, describe, expect, it } from "vitest";
import type { WebRuntimePorts } from "../../src/web";

/**
 * The `sorage web` orchestration (RUN-012, SEC-019, ADR-0041) with every side
 * effect faked: the daemon is probed, started when nothing answers, and outputs
 * honor `--json` (standard success/error envelopes) vs the documented 4-line
 * human default while logging failures strictly inside an isolated temp home.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = "S".repeat(48);

const isolatedHome = mkdtempSync(join(tmpdir(), "sorage-web-unit-"));
const previousHome = process.env.SORAGE_HOME;
process.env.SORAGE_HOME = isolatedHome;

const { runWebCommand } = await import("../../src/web");

afterAll(() => {
  if (previousHome === undefined) delete process.env.SORAGE_HOME;
  else process.env.SORAGE_HOME = previousHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

function ports(overrides: Partial<WebRuntimePorts>): WebRuntimePorts {
  return {
    probeDaemon: () => false,
    spawnDaemon: () => {},
    openBrowser: () => {},
    readConfig: () => ok(defaultConfiguration("1f0ac9a0-0000-4000-8000-00000000000b")),
    issueSecret: () => ok({ secret: SECRET, expiresAt: "2026-08-30T00:05:00.000Z" }),
    ...overrides,
  };
}

function sink() {
  const out: string[] = [];
  const errLines: string[] = [];
  return { out, err: errLines, ports: { out: (t: string) => out.push(t), err: (t: string) => errLines.push(t) } };
}

describe("runWebCommand", () => {
  it("uses the running daemon and emits the standard JSON envelope under --json", () => {
    const opened: string[] = [];
    const harness = sink();
    let spawned = 0;
    const code = runWebCommand(
      ports({
        probeDaemon: () => true,
        spawnDaemon: () => {
          spawned += 1;
        },
        openBrowser: (url) => opened.push(url),
      }),
      harness.ports,
      { openBrowser: true, json: true },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(harness.err.join("")).toBe("");
    expect(opened).toEqual([`http://127.0.0.1:46321/#s=${SECRET}`]);
    const envelope = JSON.parse(harness.out.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        url: `http://127.0.0.1:46321/#s=${SECRET}`,
        daemonStarted: false,
        expiresAt: "2026-08-30T00:05:00.000Z",
        note: "the fragment secret is single-use and expires; run sorage web again for a fresh one",
      },
    });
    expect(envelope.meta.requestId).toMatch(UUID_RE);
  });

  it("emits the documented 4-line human template when --json is omitted", () => {
    const runningHarness = sink();
    expect(runWebCommand(ports({ probeDaemon: () => true }), runningHarness.ports, { openBrowser: false })).toBe(0);
    expect(runningHarness.err.join("")).toBe("");
    expect(runningHarness.out.join("")).toBe(
      `Web control plane: http://127.0.0.1:46321/#s=${SECRET}\n` +
        "Daemon: already running\n" +
        "Expires: 2026-08-30T00:05:00.000Z\n" +
        "Note: the fragment secret is single-use and expires; run sorage web again for a fresh one\n",
    );

    let probes = 0;
    const startedHarness = sink();
    expect(
      runWebCommand(
        ports({
          probeDaemon: () => {
            probes += 1;
            return probes > 1;
          },
        }),
        startedHarness.ports,
        { openBrowser: false },
      ),
    ).toBe(0);
    expect(startedHarness.out.join("")).toBe(
      `Web control plane: http://127.0.0.1:46321/#s=${SECRET}\n` +
        "Daemon: started\n" +
        "Expires: 2026-08-30T00:05:00.000Z\n" +
        "Note: the fragment secret is single-use and expires; run sorage web again for a fresh one\n",
    );
  });

  it("allocates distinct per-invocation requestIds across consecutive --json calls", () => {
    const first = sink();
    const second = sink();
    expect(runWebCommand(ports({ probeDaemon: () => true }), first.ports, { openBrowser: false, json: true })).toBe(0);
    expect(runWebCommand(ports({ probeDaemon: () => true }), second.ports, { openBrowser: false, json: true })).toBe(0);
    const id1 = JSON.parse(first.out.join("")).meta.requestId as string;
    const id2 = JSON.parse(second.out.join("")).meta.requestId as string;
    expect(id1).toMatch(UUID_RE);
    expect(id2).toMatch(UUID_RE);
    expect(id1).not.toBe(id2);
  });

  it("starts the daemon when nothing answers and reports it inside data", () => {
    const opened: string[] = [];
    const harness = sink();
    let probes = 0;
    let spawned = 0;
    const code = runWebCommand(
      ports({
        probeDaemon: () => {
          probes += 1;
          return probes > 2;
        },
        spawnDaemon: () => {
          spawned += 1;
        },
        openBrowser: (url) => opened.push(url),
      }),
      harness.ports,
      { openBrowser: true, json: true },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(1);
    expect(JSON.parse(harness.out.join("")).data.daemonStarted).toBe(true);
  });

  it("fails with DAEMON_UNAVAILABLE in both JSON and human forms without leaking any secret and logs RUN-009", () => {
    const jsonHarness = sink();
    const jsonCode = runWebCommand(ports({ probeDaemon: () => false }), jsonHarness.ports, {
      openBrowser: true,
      json: true,
      startTimeoutMs: 300,
    });
    expect(jsonCode).toBe(69);
    expect(jsonHarness.out.join("")).toBe("");
    expect(jsonHarness.err.join("")).not.toContain(SECRET);
    const envelope = JSON.parse(jsonHarness.err.join(""));
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "DAEMON_UNAVAILABLE",
        message: "the daemon did not become ready",
        details: {},
        recovery: { suggestedCommand: "sorage daemon start" },
      },
    });
    expect(envelope.meta.requestId).toMatch(UUID_RE);

    const humanHarness = sink();
    const humanCode = runWebCommand(ports({ probeDaemon: () => false }), humanHarness.ports, {
      openBrowser: false,
      startTimeoutMs: 300,
    });
    expect(humanCode).toBe(69);
    expect(humanHarness.out.join("")).toBe("");
    expect(humanHarness.err.join("")).toBe(
      "DAEMON_UNAVAILABLE: the daemon did not become ready\nRecovery: sorage daemon start\n",
    );

    const logText = readFileSync(join(isolatedHome, "logs", "sorage.log"), "utf8");
    expect(logText).toContain("DAEMON_UNAVAILABLE");
    expect(logText).toContain(envelope.meta.requestId);
  });

  it("renders config and secret-issuance errors via renderAppError with matching exit codes", () => {
    const configHarness = sink();
    expect(
      runWebCommand(
        ports({ readConfig: () => err(appError("CONFIG_INVALID", "broken config")) }),
        configHarness.ports,
        { openBrowser: false, json: true },
      ),
    ).toBe(78);
    expect(configHarness.out.join("")).toBe("");
    expect(JSON.parse(configHarness.err.join(""))).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", message: "broken config", details: {} },
    });

    const uninitHarness = sink();
    expect(
      runWebCommand(
        ports({ readConfig: () => err(appError("NOT_INITIALIZED", "Sorage has not been initialized.")) }),
        uninitHarness.ports,
        { openBrowser: false, json: true },
      ),
    ).toBe(78);
    expect(JSON.parse(uninitHarness.err.join("")).error.code).toBe("NOT_INITIALIZED");

    const secretHarness = sink();
    expect(
      runWebCommand(
        ports({
          probeDaemon: () => true,
          issueSecret: () => err(appError("INTERNAL_ERROR", "secret store failed")),
        }),
        secretHarness.ports,
        { openBrowser: false, json: true },
      ),
    ).toBe(1);
    expect(secretHarness.out.join("")).toBe("");
    expect(secretHarness.err.join("")).not.toContain("#s=");
    expect(JSON.parse(secretHarness.err.join(""))).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "secret store failed", details: {} },
    });
  });

  it("does not open a browser when asked not to", () => {
    const opened: string[] = [];
    const harness = sink();
    const code = runWebCommand(
      ports({ probeDaemon: () => true, openBrowser: (url) => opened.push(url) }),
      harness.ports,
      { openBrowser: false },
    );
    expect(code).toBe(0);
    expect(opened).toEqual([]);
    expect(harness.out.join("")).toContain("#s=");
  });

  it("names the bound address so an IPv6 loopback yields a reachable URL", () => {
    const opened: string[] = [];
    const harness = sink();
    const ipv6 = defaultConfiguration("1f0ac9a0-0000-4000-8000-0000000000c");
    ipv6.server.host = "::1";
    const code = runWebCommand(
      ports({ probeDaemon: () => true, openBrowser: (url) => opened.push(url), readConfig: () => ok(ipv6) }),
      harness.ports,
      { openBrowser: true, json: true },
    );
    expect(code).toBe(0);
    // The bracketed literal is reachable in a browser; a dead 127.0.0.1 URL is not.
    expect(opened).toEqual([`http://[::1]:46321/#s=${SECRET}`]);
    expect(JSON.parse(harness.out.join("")).data.url).toBe(`http://[::1]:46321/#s=${SECRET}`);
  });

  it("doubles start polling from 200ms, caps at 1000ms, clamps before deadline, and fails cleanly when unready", () => {
    let time = 0;
    const sleeps: number[] = [];
    const postSpawnProbeTimes: number[] = [];
    let spawned = false;
    const harness = sink();
    const code = runWebCommand(
      ports({
        spawnDaemon: () => {
          spawned = true;
        },
        probeDaemon: () => {
          if (spawned) postSpawnProbeTimes.push(time);
          return false;
        },
      }),
      harness.ports,
      {
        openBrowser: false,
        startTimeoutMs: 2_500,
        now: () => time,
        sleepMs: (ms) => {
          sleeps.push(ms);
          time += ms;
        },
      },
    );
    expect(code).toBe(69);
    expect(sleeps).toEqual([200, 400, 800, 1_000, 99]);
    expect(postSpawnProbeTimes).toEqual([0, 200, 600, 1_400, 2_400, 2_499]);
    expect(postSpawnProbeTimes.every((t) => t < 2_500)).toBe(true);
    expect(harness.err.join("")).toContain("DAEMON_UNAVAILABLE");
  });

  it("succeeds when the strictly pre-deadline final readiness probe answers ready", () => {
    let time = 0;
    const sleeps: number[] = [];
    const postSpawnProbeTimes: number[] = [];
    let spawned = false;
    const harness = sink();
    const code = runWebCommand(
      ports({
        spawnDaemon: () => {
          spawned = true;
        },
        probeDaemon: () => {
          if (!spawned) return false;
          postSpawnProbeTimes.push(time);
          return postSpawnProbeTimes.length === 6;
        },
      }),
      harness.ports,
      {
        openBrowser: false,
        json: true,
        startTimeoutMs: 2_500,
        now: () => time,
        sleepMs: (ms) => {
          sleeps.push(ms);
          time += ms;
        },
      },
    );
    expect(code).toBe(0);
    expect(sleeps).toEqual([200, 400, 800, 1_000, 99]);
    expect(postSpawnProbeTimes).toEqual([0, 200, 600, 1_400, 2_400, 2_499]);
    expect(JSON.parse(harness.out.join("")).data.daemonStarted).toBe(true);
  });

  it.each([
    ["at exact deadline", 1],
    ["after deadline", 20],
  ])("refuses newly ready daemon after scheduler oversleep %s without probing post-deadline", (_label, extraMs) => {
    let time = 0;
    const sleeps: number[] = [];
    const postSpawnProbeTimes: number[] = [];
    let spawned = false;
    const harness = sink();
    const code = runWebCommand(
      ports({
        spawnDaemon: () => {
          spawned = true;
        },
        probeDaemon: () => {
          if (!spawned) return false;
          postSpawnProbeTimes.push(time);
          return time >= 2_500;
        },
      }),
      harness.ports,
      {
        openBrowser: false,
        startTimeoutMs: 2_500,
        now: () => time,
        sleepMs: (ms) => {
          const callIndex = sleeps.length;
          sleeps.push(ms);
          time += ms + (callIndex === 4 ? extraMs : 0);
        },
      },
    );
    expect(code).toBe(69);
    expect(sleeps).toEqual([200, 400, 800, 1_000, 99]);
    expect(postSpawnProbeTimes).toEqual([0, 200, 600, 1_400, 2_400]);
    expect(time).toBe(2_499 + extraMs);
    expect(harness.err.join("")).toContain("DAEMON_UNAVAILABLE");
  });

  it("zero-timeout oracle probes once post-spawn without sleeping on both ready and unready outcomes", () => {
    for (const readyAfterSpawn of [true, false]) {
      let time = 0;
      const sleeps: number[] = [];
      let probes = 0;
      const harness = sink();
      const code = runWebCommand(
        ports({
          probeDaemon: () => {
            probes += 1;
            return probes > 1 && readyAfterSpawn;
          },
        }),
        harness.ports,
        {
          openBrowser: false,
          startTimeoutMs: 0,
          now: () => time,
          sleepMs: (ms) => {
            sleeps.push(ms);
            time += ms;
          },
        },
      );
      expect(code).toBe(readyAfterSpawn ? 0 : 69);
      expect(sleeps).toEqual([]);
      expect(probes).toBe(2);
    }
  });
});
