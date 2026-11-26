import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonRunRecord } from "@sorage/adapters/src/daemon-command-ports";
import { appError, defaultConfiguration, err, ok } from "@sorage/core";
import { afterAll, describe, expect, it } from "vitest";
import type { DaemonRuntimePorts } from "../../src/daemon-commands";

/**
 * The lifecycle use cases with the runtime boundary faked: PORT_IN_USE before any
 * spawn, the health-confirmed start, the SIGTERM drain wait, the stale-record
 * recovery, the restart requirement a port change carries, and ADR-0041 `--json`
 * vs default human rendering (RUN-006, RUN-008, RUN-013).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION = "1f0ac9a0-0000-4000-8000-0000000000cc";
const RECORD: DaemonRunRecord = {
  pid: 4242,
  host: "127.0.0.1",
  port: 46321,
  startedAt: "2026-08-30T00:00:00.000Z",
  version: "0.1.2",
  installationId: INSTALLATION,
};

const isolatedHome = mkdtempSync(join(tmpdir(), "sorage-daemon-unit-"));
const previousHome = process.env.SORAGE_HOME;
process.env.SORAGE_HOME = isolatedHome;

const { daemonRestart, daemonStart, daemonStatus, daemonStop } = await import("../../src/daemon-commands");

afterAll(() => {
  if (previousHome === undefined) delete process.env.SORAGE_HOME;
  else process.env.SORAGE_HOME = previousHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

interface Behavior {
  record: DaemonRunRecord | null;
  portHeld: boolean;
  health: boolean;
  alive: boolean;
}

function ports(behavior: Partial<Behavior> = {}): DaemonRuntimePorts & {
  calls: { spawned: number; signalled: string[]; removed: boolean };
  dieOnSignal(): void;
} {
  const state = {
    spawned: 0,
    signalled: [] as string[],
    removed: false,
    record: behavior.record ?? null,
    portHeld: behavior.portHeld ?? false,
    health: behavior.health ?? true,
    alive: behavior.alive ?? true,
    diesOnSignal: false,
  };
  const view = {
    calls: {
      get spawned() {
        return state.spawned;
      },
      get signalled() {
        return state.signalled;
      },
      get removed() {
        return state.removed;
      },
    },
    dieOnSignal() {
      state.diesOnSignal = true;
    },
    readConfiguration: () => ok({ config: defaultConfiguration(INSTALLATION), installationId: INSTALLATION }),
    readDaemonRecord: () => state.record,
    removeDaemonRecord: () => {
      state.removed = true;
    },
    isPidAlive: () => state.alive,
    portHeld: () => state.portHeld,
    healthConfirms: () => state.health,
    historyAdmissionRefusal: () => null,
    spawnDaemon: () => {
      state.spawned += 1;
    },
    signal: (pid: number, name: NodeJS.Signals) => {
      state.signalled.push(`${pid}:${String(name)}`);
      if (state.diesOnSignal) state.alive = false;
      return true;
    },
  };
  return view as unknown as DaemonRuntimePorts & {
    calls: { spawned: number; signalled: string[]; removed: boolean };
    dieOnSignal(): void;
  };
}

function sink() {
  const out: string[] = [];
  const errLines: string[] = [];
  return { out, err: errLines, ports: { out: (t: string) => out.push(t), err: (t: string) => errLines.push(t) } };
}

describe("daemon start (RUN-013)", () => {
  it("refuses a bound port with PORT_IN_USE before spawning anything", () => {
    const runtime = ports({ portHeld: true });
    runtime.historyAdmissionRefusal = () => {
      throw new Error("port refusal must precede history inspection");
    };
    const harness = sink();
    expect(daemonStart(runtime, harness.ports, { json: true })).toBe(75);
    const envelope = JSON.parse(harness.err.join(""));
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "PORT_IN_USE",
        message: "the configured port is already bound",
        details: {},
        recovery: { suggestedCommand: "Stop the other listener, or change server.port and restart" },
      },
    });
    expect(envelope.meta.requestId).toMatch(UUID_RE);
    expect(runtime.calls.spawned).toBe(0);
  });

  it("aligns direct/internal missing configuration to NOT_INITIALIZED and preserves CONFIG_INVALID", () => {
    const uninit = ports();
    uninit.readConfiguration = () => ok(null);
    const uninitJson = sink();
    expect(daemonStart(uninit, uninitJson.ports, { json: true })).toBe(78);
    expect(JSON.parse(uninitJson.err.join(""))).toMatchObject({
      ok: false,
      error: {
        code: "NOT_INITIALIZED",
        message: "Sorage has not been initialized.",
        details: {},
        recovery: { suggestedCommand: "sorage init" },
      },
    });
    expect(JSON.parse(uninitJson.err.join("")).meta.requestId).toMatch(UUID_RE);

    const uninitHuman = sink();
    expect(daemonStart(uninit, uninitHuman.ports)).toBe(78);
    expect(uninitHuman.err.join("")).toBe("NOT_INITIALIZED: Sorage has not been initialized.\nRecovery: sorage init\n");

    const invalid = ports();
    invalid.readConfiguration = () => err(appError("CONFIG_INVALID", "bad yaml"));
    const invalidJson = sink();
    expect(daemonStart(invalid, invalidJson.ports, { json: true })).toBe(78);
    expect(JSON.parse(invalidJson.err.join(""))).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", message: "bad yaml", details: {} },
    });
  });

  it("preserves a confirmed schema refusal without spawning or guessing from health", () => {
    const runtime = ports();
    runtime.historyAdmissionRefusal = () => appError("STORAGE_SCHEMA_UNSUPPORTED", "future schema");
    const harness = sink();
    expect(daemonStart(runtime, harness.ports, { json: true })).toBe(78);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(runtime.calls.spawned).toBe(0);

    const human = sink();
    expect(daemonStart(runtime, human.ports)).toBe(78);
    expect(human.err.join("")).toContain("STORAGE_SCHEMA_UNSUPPORTED: future schema");
  });

  it("spawns, confirms health, and reports the record in JSON or human form", () => {
    const runtime = ports({ record: RECORD });
    const jsonHarness = sink();
    expect(daemonStart(runtime, jsonHarness.ports, { json: true })).toBe(0);
    expect(runtime.calls.spawned).toBe(1);
    const envelope = JSON.parse(jsonHarness.out.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      data: { started: true, daemon: { pid: 4242 } },
    });
    expect(envelope.meta.requestId).toMatch(UUID_RE);

    const humanWithRecord = sink();
    expect(daemonStart(ports({ record: RECORD }), humanWithRecord.ports)).toBe(0);
    expect(humanWithRecord.out.join("")).toBe("Daemon started (pid 4242 at 127.0.0.1:46321, version 0.1.2).\n");

    const humanNoRecord = sink();
    expect(daemonStart(ports({ record: null }), humanNoRecord.ports)).toBe(0);
    expect(humanNoRecord.out.join("")).toBe("Daemon started.\n");
  });

  it("fails with DAEMON_UNAVAILABLE when the child never confirms health", () => {
    const runtime = ports({ health: false });
    const harness = sink();
    expect(daemonStart(runtime, harness.ports, { json: true, startTimeoutMs: 300 })).toBe(69);
    const envelope = JSON.parse(harness.err.join(""));
    expect(envelope.error.code).toBe("DAEMON_UNAVAILABLE");
    expect(envelope.error.details).toEqual({});
    expect(envelope.meta.requestId).toMatch(UUID_RE);
  });
});

describe("daemon stop (SEC-015)", () => {
  it("signals SIGTERM, waits for the process to end, and removes the record", () => {
    const runtime = ports({ record: RECORD, alive: true });
    runtime.dieOnSignal();
    const jsonHarness = sink();
    expect(daemonStop(runtime, jsonHarness.ports, { json: true, stopGraceMs: 300 })).toBe(0);
    expect(runtime.calls.signalled).toContain("4242:SIGTERM");
    expect(runtime.calls.removed).toBe(true);
    const envelope = JSON.parse(jsonHarness.out.join(""));
    expect(envelope).toMatchObject({ ok: true, data: { stopped: true } });
    expect(envelope.meta.requestId).toMatch(UUID_RE);

    const humanRuntime = ports({ record: RECORD, alive: true });
    humanRuntime.dieOnSignal();
    const humanHarness = sink();
    expect(daemonStop(humanRuntime, humanHarness.ports, { stopGraceMs: 300 })).toBe(0);
    expect(humanHarness.out.join("")).toBe("Daemon stopped.\n");
  });

  it("fails with SERVICE_PAUSED preserving daemon-specific recovery in both JSON and human forms", () => {
    const runtime = ports({ record: RECORD, alive: true });
    const jsonHarness = sink();
    expect(daemonStop(runtime, jsonHarness.ports, { json: true, stopGraceMs: 300 })).toBe(75);
    const envelope = JSON.parse(jsonHarness.err.join(""));
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SERVICE_PAUSED",
        message: "the daemon did not stop within the grace window",
        details: {},
        recovery: { suggestedCommand: "Inspect ~/.sorage/logs/sorage.log, then retry sorage daemon stop" },
      },
    });
    expect(envelope.meta.requestId).toMatch(UUID_RE);

    const humanHarness = sink();
    expect(daemonStop(ports({ record: RECORD, alive: true }), humanHarness.ports, { stopGraceMs: 300 })).toBe(75);
    expect(humanHarness.err.join("")).toBe(
      "SERVICE_PAUSED: the daemon did not stop within the grace window\n" +
        "Recovery: Inspect ~/.sorage/logs/sorage.log, then retry sorage daemon stop\n",
    );

    const logText = readFileSync(join(isolatedHome, "logs", "sorage.log"), "utf8");
    expect(logText).toContain("SERVICE_PAUSED");
    expect(logText).toContain(envelope.meta.requestId);
  });
});

describe("daemon restart (RUN-008)", () => {
  it("suppresses intermediate stop stdout and emits exactly one final start output in JSON and human modes", () => {
    const runtime = ports({ record: RECORD, alive: true });
    runtime.dieOnSignal();
    const jsonHarness = sink();
    expect(daemonRestart(runtime, jsonHarness.ports, { json: true })).toBe(0);
    expect(runtime.calls.signalled).toContain("4242:SIGTERM");
    expect(runtime.calls.spawned).toBe(1);
    expect(jsonHarness.err.join("")).toBe("");
    const envelope = JSON.parse(jsonHarness.out.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      data: { started: true, daemon: { pid: 4242 } },
    });
    expect(envelope.meta.requestId).toMatch(UUID_RE);

    const humanRuntime = ports({ record: RECORD, alive: true });
    humanRuntime.dieOnSignal();
    const humanHarness = sink();
    expect(daemonRestart(humanRuntime, humanHarness.ports)).toBe(0);
    expect(humanHarness.out.join("")).toBe("Daemon started (pid 4242 at 127.0.0.1:46321, version 0.1.2).\n");
    expect(humanHarness.out.join("")).not.toContain("Daemon stopped.");
  });

  it("emits only the stop failure envelope and never spawns when stop fails during restart", () => {
    const runtime = ports({ record: RECORD, alive: true });
    const harness = sink();
    expect(daemonRestart(runtime, harness.ports, { json: true, stopGraceMs: 300 })).toBe(75);
    expect(runtime.calls.spawned).toBe(0);
    expect(harness.out.join("")).toBe("");
    expect(JSON.parse(harness.err.join("")).error.code).toBe("SERVICE_PAUSED");
  });

  it("starts directly when nothing is running and allocates distinct requestIds across invocations", () => {
    const first = sink();
    const second = sink();
    const r1 = ports({ alive: false });
    const r2 = ports({ alive: false });
    expect(daemonRestart(r1, first.ports, { json: true })).toBe(0);
    expect(daemonRestart(r2, second.ports, { json: true })).toBe(0);
    expect(r1.calls.signalled).toHaveLength(0);
    expect(r1.calls.spawned).toBe(1);
    const id1 = JSON.parse(first.out.join("")).meta.requestId as string;
    const id2 = JSON.parse(second.out.join("")).meta.requestId as string;
    expect(id1).toMatch(UUID_RE);
    expect(id2).toMatch(UUID_RE);
    expect(id1).not.toBe(id2);
  });
});

describe("daemon status (RUN-013)", () => {
  it("reports the record and the restart a port change requires in JSON and human modes", () => {
    const changed = { ...RECORD, port: RECORD.port + 1 };
    const runtime = ports({ record: changed });
    const jsonHarness = sink();
    expect(daemonStatus(runtime, jsonHarness.ports, { json: true })).toBe(0);
    const envelope = JSON.parse(jsonHarness.out.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      data: { daemon: { pid: 4242 }, restartRequired: true },
    });
    expect(envelope.meta.requestId).toMatch(UUID_RE);

    const humanHarness = sink();
    expect(daemonStatus(runtime, humanHarness.ports, { json: false })).toBe(0);
    expect(humanHarness.out.join("")).toBe(
      "daemon pid 4242 at 127.0.0.1:46322 (version 0.1.2)\na configuration change requires sorage daemon restart\n",
    );
  });

  it("reports a matching daemon as up to date in JSON and human modes", () => {
    const runtime = ports({ record: RECORD });
    const jsonHarness = sink();
    expect(daemonStatus(runtime, jsonHarness.ports, { json: true })).toBe(0);
    expect(JSON.parse(jsonHarness.out.join(""))).toMatchObject({ data: { restartRequired: false } });

    const humanHarness = sink();
    expect(daemonStatus(runtime, humanHarness.ports, { json: false })).toBe(0);
    expect(humanHarness.out.join("")).toBe(
      "daemon pid 4242 at 127.0.0.1:46321 (version 0.1.2)\nup to date with the configuration\n",
    );
  });

  it("treats a record whose health does not confirm this installation as stale", () => {
    const runtime = ports({ record: RECORD, health: false });
    const jsonHarness = sink();
    expect(daemonStatus(runtime, jsonHarness.ports, { json: true })).toBe(69);
    expect(JSON.parse(jsonHarness.err.join("")).error.code).toBe("DAEMON_UNAVAILABLE");

    const humanHarness = sink();
    expect(daemonStatus(runtime, humanHarness.ports, { json: false })).toBe(69);
    expect(humanHarness.err.join("")).toBe(
      "DAEMON_UNAVAILABLE: run/daemon.json names a daemon that does not answer health with this installationId\nRecovery: sorage daemon start\n",
    );
  });

  it("ignores a record whose pid is dead, removes it, and renders human or JSON error", () => {
    const runtime = ports({ record: RECORD, alive: false });
    const jsonHarness = sink();
    expect(daemonStatus(runtime, jsonHarness.ports, { json: true })).toBe(69);
    expect(runtime.calls.removed).toBe(true);
    expect(JSON.parse(jsonHarness.err.join("")).error.details).toEqual({});

    const humanHarness = sink();
    expect(daemonStatus(ports({ record: RECORD, alive: false }), humanHarness.ports, { json: false })).toBe(69);
    expect(humanHarness.err.join("")).toBe(
      "DAEMON_UNAVAILABLE: no live daemon record was found\nRecovery: sorage daemon start\n",
    );
  });

  it("aligns direct/internal uninitialized status to NOT_INITIALIZED", () => {
    const runtime = ports();
    runtime.readConfiguration = () => ok(null);
    const harness = sink();
    expect(daemonStatus(runtime, harness.ports, { json: true })).toBe(78);
    expect(JSON.parse(harness.err.join(""))).toMatchObject({
      ok: false,
      error: { code: "NOT_INITIALIZED", details: {}, recovery: { suggestedCommand: "sorage init" } },
    });
  });
});

function fakeClock(oversleepOnCall?: { index: number; extraMs: number }) {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleepMs: (ms: number) => {
      const callIndex = sleeps.length;
      sleeps.push(ms);
      const extra = oversleepOnCall && oversleepOnCall.index === callIndex ? oversleepOnCall.extraMs : 0;
      time += ms + extra;
    },
    sleeps,
  };
}

describe("daemon start/stop bounded geometric polling (TASK-160)", () => {
  it("daemonStart doubles from 200ms, caps at 1000ms, clamps before deadline, and fails cleanly when unready", () => {
    const clock = fakeClock();
    const runtime = ports({ health: false });
    const probeTimes: number[] = [];
    runtime.healthConfirms = () => {
      probeTimes.push(clock.now());
      return false;
    };
    const harness = sink();
    expect(
      daemonStart(runtime, harness.ports, {
        json: true,
        startTimeoutMs: 2_500,
        now: clock.now,
        sleepMs: clock.sleepMs,
      }),
    ).toBe(69);
    expect(clock.sleeps).toEqual([200, 400, 800, 1_000, 99]);
    expect(probeTimes).toEqual([0, 200, 600, 1_400, 2_400, 2_499]);
    expect(probeTimes.every((t) => t < 2_500)).toBe(true);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("DAEMON_UNAVAILABLE");
  });

  it("daemonStart succeeds on the strictly pre-deadline final readiness probe", () => {
    const clock = fakeClock();
    const runtime = ports({ record: RECORD, health: false });
    const probeTimes: number[] = [];
    runtime.healthConfirms = () => {
      probeTimes.push(clock.now());
      return probeTimes.length === 6;
    };
    const harness = sink();
    expect(
      daemonStart(runtime, harness.ports, {
        json: true,
        startTimeoutMs: 2_500,
        now: clock.now,
        sleepMs: clock.sleepMs,
      }),
    ).toBe(0);
    expect(clock.sleeps).toEqual([200, 400, 800, 1_000, 99]);
    expect(probeTimes).toEqual([0, 200, 600, 1_400, 2_400, 2_499]);
    expect(JSON.parse(harness.out.join("")).ok).toBe(true);
  });

  it.each([
    ["at exact deadline", 1],
    ["after deadline", 20],
  ])(
    "daemonStart refuses newly ready daemon after scheduler oversleep %s without probing post-deadline",
    (_label, extraMs) => {
      const clock = fakeClock({ index: 4, extraMs });
      const runtime = ports({ record: RECORD, health: false });
      const probeTimes: number[] = [];
      runtime.healthConfirms = () => {
        probeTimes.push(clock.now());
        return clock.now() >= 2_500;
      };
      const harness = sink();
      expect(
        daemonStart(runtime, harness.ports, {
          json: true,
          startTimeoutMs: 2_500,
          now: clock.now,
          sleepMs: clock.sleepMs,
        }),
      ).toBe(69);
      expect(clock.sleeps).toEqual([200, 400, 800, 1_000, 99]);
      expect(probeTimes).toEqual([0, 200, 600, 1_400, 2_400]);
      expect(clock.now()).toBe(2_499 + extraMs);
      expect(JSON.parse(harness.err.join("")).error.code).toBe("DAEMON_UNAVAILABLE");
    },
  );

  it("daemonStart zero-timeout oracle probes once without sleeping on both ready and unready outcomes", () => {
    for (const health of [true, false]) {
      const clock = fakeClock();
      const runtime = ports({ record: RECORD, health });
      let probes = 0;
      runtime.healthConfirms = () => {
        probes += 1;
        return health;
      };
      const harness = sink();
      expect(
        daemonStart(runtime, harness.ports, { json: true, startTimeoutMs: 0, now: clock.now, sleepMs: clock.sleepMs }),
      ).toBe(health ? 0 : 69);
      expect(clock.sleeps).toEqual([]);
      expect(probes).toBe(1);
    }
  });

  it("daemonStop doubles from 100ms, caps at 1000ms, clamps before deadline, and fails with SERVICE_PAUSED when alive", () => {
    const clock = fakeClock();
    const runtime = ports({ record: RECORD, alive: true });
    const postSignalProbeTimes: number[] = [];
    let signalled = false;
    const origSignal = runtime.signal;
    runtime.signal = (pid, name) => {
      signalled = true;
      return origSignal(pid, name);
    };
    runtime.isPidAlive = () => {
      if (signalled) postSignalProbeTimes.push(clock.now());
      return true;
    };
    const harness = sink();
    expect(
      daemonStop(runtime, harness.ports, { json: true, stopGraceMs: 3_000, now: clock.now, sleepMs: clock.sleepMs }),
    ).toBe(75);
    expect(clock.sleeps).toEqual([100, 200, 400, 800, 1_000, 499]);
    expect(postSignalProbeTimes).toEqual([0, 100, 300, 700, 1_500, 2_500, 2_999]);
    expect(postSignalProbeTimes.every((t) => t < 3_000)).toBe(true);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("SERVICE_PAUSED");
  });

  it("daemonStop succeeds when the strictly pre-deadline final probe observes process exit", () => {
    const clock = fakeClock();
    const runtime = ports({ record: RECORD, alive: true });
    const postSignalProbeTimes: number[] = [];
    let signalled = false;
    const origSignal = runtime.signal;
    runtime.signal = (pid, name) => {
      signalled = true;
      return origSignal(pid, name);
    };
    runtime.isPidAlive = () => {
      if (!signalled) return true;
      postSignalProbeTimes.push(clock.now());
      return postSignalProbeTimes.length < 7;
    };
    const harness = sink();
    expect(
      daemonStop(runtime, harness.ports, { json: true, stopGraceMs: 3_000, now: clock.now, sleepMs: clock.sleepMs }),
    ).toBe(0);
    expect(clock.sleeps).toEqual([100, 200, 400, 800, 1_000, 499]);
    expect(postSignalProbeTimes).toEqual([0, 100, 300, 700, 1_500, 2_500, 2_999]);
    expect(runtime.calls.removed).toBe(true);
  });

  it.each([
    ["at exact deadline", 1],
    ["after deadline", 20],
  ])(
    "daemonStop refuses late process exit after scheduler oversleep %s without probing post-deadline",
    (_label, extraMs) => {
      const clock = fakeClock({ index: 5, extraMs });
      const runtime = ports({ record: RECORD, alive: true });
      const postSignalProbeTimes: number[] = [];
      let signalled = false;
      const origSignal = runtime.signal;
      runtime.signal = (pid, name) => {
        signalled = true;
        return origSignal(pid, name);
      };
      runtime.isPidAlive = () => {
        if (!signalled) return true;
        postSignalProbeTimes.push(clock.now());
        return clock.now() < 3_000;
      };
      const harness = sink();
      expect(
        daemonStop(runtime, harness.ports, { json: true, stopGraceMs: 3_000, now: clock.now, sleepMs: clock.sleepMs }),
      ).toBe(75);
      expect(clock.sleeps).toEqual([100, 200, 400, 800, 1_000, 499]);
      expect(postSignalProbeTimes).toEqual([0, 100, 300, 700, 1_500, 2_500]);
      expect(clock.now()).toBe(2_999 + extraMs);
      expect(runtime.calls.removed).toBe(false);
      expect(JSON.parse(harness.err.join("")).error.code).toBe("SERVICE_PAUSED");
    },
  );

  it("daemonStop zero-timeout oracle probes once after SIGTERM without sleeping", () => {
    for (const dies of [true, false]) {
      const clock = fakeClock();
      const runtime = ports({ record: RECORD, alive: true });
      let signalled = false;
      let postSignalProbes = 0;
      const origSignal = runtime.signal;
      runtime.signal = (pid, name) => {
        signalled = true;
        return origSignal(pid, name);
      };
      runtime.isPidAlive = () => {
        if (!signalled) return true;
        postSignalProbes += 1;
        return !dies;
      };
      const harness = sink();
      expect(
        daemonStop(runtime, harness.ports, { json: true, stopGraceMs: 0, now: clock.now, sleepMs: clock.sleepMs }),
      ).toBe(dies ? 0 : 75);
      expect(clock.sleeps).toEqual([]);
      expect(postSignalProbes).toBe(1);
    }
  });
});
