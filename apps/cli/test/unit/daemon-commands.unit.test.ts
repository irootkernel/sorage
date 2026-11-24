import { describe, expect, it } from "vitest";
import { appError, ok } from "@sorage/core";
import { defaultConfiguration } from "@sorage/core";
import type { DaemonRunRecord } from "@sorage/adapters/src/daemon-command-ports";
import {
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  type DaemonRuntimePorts,
} from "../../src/daemon-commands";

/**
 * The lifecycle use cases with the runtime boundary faked: PORT_IN_USE before any
 * spawn, the health-confirmed start, the SIGTERM drain wait, the stale-record
 * recovery, and the restart requirement a port change carries (RUN-008, RUN-013).
 */
const INSTALLATION = "1f0ac9a0-0000-4000-8000-0000000000cc";
const RECORD: DaemonRunRecord = {
  pid: 4242,
  host: "127.0.0.1",
  port: 46321,
  startedAt: "2026-08-30T00:00:00.000Z",
  version: "0.1.2",
  installationId: INSTALLATION,
};

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
  const err: string[] = [];
  return { out, err, ports: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

describe("daemon start (RUN-013)", () => {
  it("refuses a bound port with PORT_IN_USE before spawning anything", () => {
    const runtime = ports({ portHeld: true });
    runtime.historyAdmissionRefusal = () => {
      throw new Error("port refusal must precede history inspection");
    };
    const harness = sink();
    expect(daemonStart(runtime, harness.ports)).toBe(75);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("PORT_IN_USE");
    expect(runtime.calls.spawned).toBe(0);
  });

  it("preserves a confirmed schema refusal without spawning or guessing from health", () => {
    const runtime = ports();
    runtime.historyAdmissionRefusal = () => appError("STORAGE_SCHEMA_UNSUPPORTED", "future schema");
    const harness = sink();
    expect(daemonStart(runtime, harness.ports)).toBe(78);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(runtime.calls.spawned).toBe(0);
  });

  it("spawns, confirms health, and reports the record", () => {
    const runtime = ports({ record: RECORD });
    const harness = sink();
    expect(daemonStart(runtime, harness.ports)).toBe(0);
    expect(runtime.calls.spawned).toBe(1);
    expect(JSON.parse(harness.out.join(""))).toMatchObject({
      ok: true,
      data: { started: true, daemon: { pid: 4242 } },
    });
  });

  it("fails with DAEMON_UNAVAILABLE when the child never confirms health", () => {
    const runtime = ports({ health: false });
    const harness = sink();
    expect(daemonStart(runtime, harness.ports, { startTimeoutMs: 300 })).toBe(69);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("DAEMON_UNAVAILABLE");
  });
});

describe("daemon stop (SEC-015)", () => {
  it("signals SIGTERM, waits for the process to end, and removes the record", () => {
    const runtime = ports({ record: RECORD, alive: true });
    runtime.dieOnSignal();
    const harness = sink();
    expect(daemonStop(runtime, harness.ports, { stopGraceMs: 300 })).toBe(0);
    expect(runtime.calls.signalled).toContain("4242:SIGTERM");
    expect(runtime.calls.removed).toBe(true);
  });

  it("fails when the daemon survives the grace window", () => {
    const runtime = ports({ record: RECORD, alive: true });
    const harness = sink();
    expect(daemonStop(runtime, harness.ports, { stopGraceMs: 300 })).toBe(75);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("SERVICE_PAUSED");
  });
});

describe("daemon restart (RUN-008)", () => {
  it("stops a live daemon and starts a new one", () => {
    const runtime = ports({ record: RECORD, alive: true });
    runtime.dieOnSignal();
    const harness = sink();
    expect(daemonRestart(runtime, harness.ports)).toBe(0);
    expect(runtime.calls.signalled).toContain("4242:SIGTERM");
    expect(runtime.calls.spawned).toBe(1);
  });

  it("starts directly when nothing is running", () => {
    const runtime = ports({ alive: false });
    const harness = sink();
    expect(daemonRestart(runtime, harness.ports)).toBe(0);
    expect(runtime.calls.signalled).toHaveLength(0);
    expect(runtime.calls.spawned).toBe(1);
  });
});

describe("daemon status (RUN-013)", () => {
  it("reports the record and the restart a port change requires", () => {
    const changed = { ...RECORD, port: RECORD.port + 1 };
    const runtime = ports({ record: changed });
    const harness = sink();
    expect(daemonStatus(runtime, harness.ports, { json: true })).toBe(0);
    expect(JSON.parse(harness.out.join(""))).toMatchObject({
      ok: true,
      data: { daemon: { pid: 4242 }, restartRequired: true },
    });
  });

  it("reports a matching daemon as up to date", () => {
    const runtime = ports({ record: RECORD });
    const harness = sink();
    expect(daemonStatus(runtime, harness.ports, { json: true })).toBe(0);
    expect(JSON.parse(harness.out.join(""))).toMatchObject({ data: { restartRequired: false } });
  });

  it("treats a record whose health does not confirm this installation as stale", () => {
    const runtime = ports({ record: RECORD, health: false });
    const harness = sink();
    expect(daemonStatus(runtime, harness.ports, { json: true })).toBe(69);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("DAEMON_UNAVAILABLE");
  });

  it("ignores a record whose pid is dead and removes it", () => {
    const runtime = ports({ record: RECORD, alive: false });
    const harness = sink();
    expect(daemonStatus(runtime, harness.ports, { json: true })).toBe(69);
    expect(runtime.calls.removed).toBe(true);
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
    expect(daemonStart(runtime, harness.ports, { startTimeoutMs: 2_500, now: clock.now, sleepMs: clock.sleepMs })).toBe(
      69,
    );
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
    expect(daemonStart(runtime, harness.ports, { startTimeoutMs: 2_500, now: clock.now, sleepMs: clock.sleepMs })).toBe(
      0,
    );
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
        daemonStart(runtime, harness.ports, { startTimeoutMs: 2_500, now: clock.now, sleepMs: clock.sleepMs }),
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
      expect(daemonStart(runtime, harness.ports, { startTimeoutMs: 0, now: clock.now, sleepMs: clock.sleepMs })).toBe(
        health ? 0 : 69,
      );
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
    expect(daemonStop(runtime, harness.ports, { stopGraceMs: 3_000, now: clock.now, sleepMs: clock.sleepMs })).toBe(75);
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
    expect(daemonStop(runtime, harness.ports, { stopGraceMs: 3_000, now: clock.now, sleepMs: clock.sleepMs })).toBe(0);
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
      expect(daemonStop(runtime, harness.ports, { stopGraceMs: 3_000, now: clock.now, sleepMs: clock.sleepMs })).toBe(
        75,
      );
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
      expect(daemonStop(runtime, harness.ports, { stopGraceMs: 0, now: clock.now, sleepMs: clock.sleepMs })).toBe(
        dies ? 0 : 75,
      );
      expect(clock.sleeps).toEqual([]);
      expect(postSignalProbes).toBe(1);
    }
  });
});
