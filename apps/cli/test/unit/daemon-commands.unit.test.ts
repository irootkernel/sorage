import { describe, expect, it } from "vitest";
import { ok } from "@sorage/core";
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
    const harness = sink();
    expect(daemonStart(runtime, harness.ports)).toBe(75);
    expect(JSON.parse(harness.err.join("")).error.code).toBe("PORT_IN_USE");
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
