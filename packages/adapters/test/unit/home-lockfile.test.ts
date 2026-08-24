import { describe, expect, it } from "vitest";
import { createHomePaths, resolveHome } from "../../src/home";
import { evaluateStaleness, parseLockRecord, type LockRecord } from "../../src/lockfile";

const LIVE = (pid: number): boolean => pid % 2 === 1;

function record(overrides: Partial<LockRecord> = {}): LockRecord {
  return { pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", hostname: "unit.local", ...overrides };
}

describe("home resolution", () => {
  it("honors a set SORAGE_HOME verbatim", () => {
    expect(resolveHome({ SORAGE_HOME: "/tmp/override" }, "/Users/tester")).toBe("/tmp/override");
  });

  it("falls back to ~/.sorage when the override is unset, empty, or blank", () => {
    expect(resolveHome({}, "/Users/tester")).toBe("/Users/tester/.sorage");
    expect(resolveHome({ SORAGE_HOME: undefined }, "/Users/tester")).toBe("/Users/tester/.sorage");
    expect(resolveHome({ SORAGE_HOME: "" }, "/Users/tester")).toBe("/Users/tester/.sorage");
    expect(resolveHome({ SORAGE_HOME: "   " }, "/Users/tester")).toBe("/Users/tester/.sorage");
  });

  it("exposes the canonical locations for one home", () => {
    const paths = createHomePaths({ SORAGE_HOME: "/tmp/home-a" }, "/Users/tester");
    expect(paths.home).toBe("/tmp/home-a");
    expect(paths.configFile).toBe("/tmp/home-a/config.yaml");
    expect(paths.stateDir).toBe("/tmp/home-a/state");
    expect(paths.logsDir).toBe("/tmp/home-a/logs");
    expect(paths.runDir).toBe("/tmp/home-a/run");
    expect(paths.lockFile("config")).toBe("/tmp/home-a/run/config.lock");
    expect(paths.lockFile("vault-move")).toBe("/tmp/home-a/run/vault-move.lock");
  });
});

describe("lock record parsing", () => {
  it("accepts a complete record", () => {
    expect(parseLockRecord('{"pid":7,"startedAt":"2026-01-01T00:00:00.000Z","hostname":"h"}')).toEqual({
      pid: 7,
      startedAt: "2026-01-01T00:00:00.000Z",
      hostname: "h",
    });
  });

  it("rejects anything that is not a complete record", () => {
    expect(parseLockRecord("not json")).toBeUndefined();
    expect(parseLockRecord("null")).toBeUndefined();
    expect(parseLockRecord("42")).toBeUndefined();
    expect(parseLockRecord('{"pid":7,"startedAt":"2026-01-01T00:00:00.000Z"}')).toBeUndefined();
    expect(parseLockRecord('{"pid":"7","startedAt":"2026-01-01T00:00:00.000Z","hostname":"h"}')).toBeUndefined();
  });
});

describe("staleness rules", () => {
  const now = new Date("2026-01-01T00:00:31.000Z");

  it("treats an unparsable or non-positive-pid record as stale", () => {
    expect(evaluateStaleness("config", undefined, now, LIVE)).toEqual({ stale: true, reason: "malformed" });
    expect(evaluateStaleness("daemon", record({ pid: 0 }), now, LIVE)).toEqual({ stale: true, reason: "malformed" });
    expect(evaluateStaleness("daemon", record({ startedAt: "yesterday" }), now, LIVE)).toEqual({
      stale: true,
      reason: "malformed",
    });
  });

  it("breaks every lock whose recorded pid is dead", () => {
    expect(evaluateStaleness("daemon", record({ pid: 4242 }), now, LIVE)).toEqual({ stale: true, reason: "dead-pid" });
    expect(evaluateStaleness("config", record({ pid: 4242 }), now, LIVE)).toEqual({ stale: true, reason: "dead-pid" });
  });

  it("breaks a config.lock older than 30 seconds while its pid still lives", () => {
    expect(evaluateStaleness("config", record({ pid: 4243 }), now, LIVE)).toEqual({ stale: true, reason: "expired" });
  });

  it("keeps a config.lock at or inside the 30-second window", () => {
    expect(evaluateStaleness("config", record({ pid: 4243 }), new Date("2026-01-01T00:00:30.000Z"), LIVE)).toEqual({
      stale: false,
    });
    expect(evaluateStaleness("config", record({ pid: 4243 }), new Date("2026-01-01T00:00:29.999Z"), LIVE)).toEqual({
      stale: false,
    });
  });

  it("never breaks a live daemon.lock for age because it may run long", () => {
    const muchLater = new Date("2026-01-01T09:00:00.000Z");
    expect(evaluateStaleness("daemon", record({ pid: 4243 }), muchLater, LIVE)).toEqual({ stale: false });
    expect(evaluateStaleness("backup", record({ pid: 4243 }), muchLater, LIVE)).toEqual({ stale: false });
    expect(evaluateStaleness("vault-move", record({ pid: 4243 }), muchLater, LIVE)).toEqual({ stale: false });
    expect(evaluateStaleness("migration", record({ pid: 4243 }), muchLater, LIVE)).toEqual({ stale: false });
  });
});
