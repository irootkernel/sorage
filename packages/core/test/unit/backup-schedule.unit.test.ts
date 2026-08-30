import { describe, expect, it } from "vitest";
import {
  backupTickDecision,
  localWallInstants,
  nextDueAt,
  nextScheduledInstant,
  previousScheduledInstant,
} from "../../src/backup-schedule";

/**
 * The DST and catch-up matrix of section 29 (BKP-026, BKP-015) against the
 * zone's own offset table: America/New_York springs forward on 2026-03-08 and
 * falls back on 2026-11-01; Asia/Seoul has no transition and pins the
 * transition-free path.
 */
const NEW_YORK = "America/New_York";

function specOf(overrides: Partial<Parameters<typeof nextScheduledInstant>[0]> = {}) {
  return { enabled: true, at: "03:00", timezone: "UTC", catchUpAfterMissedRun: true, ...overrides };
}

describe("localWallInstants", () => {
  it("returns one instant for an ordinary wall time", () => {
    const instants = localWallInstants(NEW_YORK, { year: 2026, month: 3, day: 7, hour: 3, minute: 0 });
    expect(instants).toHaveLength(1);
    expect(new Date(instants[0] as number).toISOString()).toBe("2026-03-07T08:00:00.000Z");
  });

  it("returns the transition instant for a wall time that does not exist on a spring-forward day", () => {
    // 02:30 does not exist on 2026-03-08 in New York; the clocks jump 02:00 to 03:00.
    const instants = localWallInstants(NEW_YORK, { year: 2026, month: 3, day: 8, hour: 2, minute: 30 });
    expect(instants).toHaveLength(0);
  });

  it("returns two instants for a wall time that occurs twice on a fall-back day", () => {
    const instants = localWallInstants(NEW_YORK, { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(instants).toHaveLength(2);
    // First occurrence: EDT (UTC-4); second: EST (UTC-5).
    expect(new Date(instants[0] as number).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(new Date(instants[1] as number).toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});

describe("nextScheduledInstant", () => {
  it("runs a nonexistent spring-forward time at the next valid instant", () => {
    const spec = specOf({ at: "02:30", timezone: NEW_YORK });
    // 02:30 on 2026-03-08 does not exist; the next valid instant is 03:00 EDT.
    const instant = nextScheduledInstant(spec, new Date("2026-03-07T12:00:00.000Z"));
    expect(instant).not.toBeNull();
    expect(new Date(instant as number).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("runs a repeated fall-back time at its first occurrence", () => {
    const spec = specOf({ at: "01:30", timezone: NEW_YORK });
    const instant = nextScheduledInstant(spec, new Date("2026-10-31T12:00:00.000Z"));
    expect(instant).not.toBeNull();
    expect(new Date(instant as number).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("computes the next day's instant after today's has passed, transition-free", () => {
    const spec = specOf({ timezone: "Asia/Seoul" });
    const instant = nextScheduledInstant(spec, new Date("2026-08-30T04:00:00.000Z"));
    // 03:00 KST on 2026-08-31 is 18:00 UTC on 2026-08-30.
    expect(new Date(instant as number).toISOString()).toBe("2026-08-30T18:00:00.000Z");
  });

  it("returns null for a disabled schedule through nextDueAt and an ISO string otherwise", () => {
    expect(nextDueAt(specOf({ enabled: false }), new Date())).toBeNull();
    const due = nextDueAt(specOf(), new Date("2026-08-30T00:00:00.000Z"));
    expect(due).toBe("2026-08-30T03:00:00.000Z");
  });
});

describe("previousScheduledInstant", () => {
  it("finds the most recent scheduled instant across a sleep gap", () => {
    const spec = specOf();
    const previous = previousScheduledInstant(spec, new Date("2026-08-30T09:00:00.000Z"));
    expect(previous).not.toBeNull();
    expect(new Date(previous as number).toISOString()).toBe("2026-08-30T03:00:00.000Z");
  });
});

describe("backupTickDecision", () => {
  it("runs an uncovered instant inside the grace window as scheduled", () => {
    const decision = backupTickDecision(specOf(), new Date("2026-08-30T03:00:30.000Z"), null);
    expect(decision.action).toBe("run");
    expect(decision.triggeredBy).toBe("scheduled");
  });

  it("catches a missed run up exactly once after a sleep gap", () => {
    const spec = specOf();
    const gap = new Date("2026-08-30T09:00:00.000Z");
    const first = backupTickDecision(spec, gap, null);
    expect(first.action).toBe("run");
    expect(first.triggeredBy).toBe("catch-up");
    // The catch-up run's own row covers the gap: the next tick does nothing.
    const second = backupTickDecision(spec, new Date("2026-08-30T09:01:00.000Z"), "2026-08-30T09:00:05.000Z");
    expect(second.action).toBe("none");
    // Repeated missed intervals still produce at most one run.
    const days = backupTickDecision(spec, new Date("2026-09-02T09:00:00.000Z"), null);
    expect(days.action).toBe("run");
    expect(days.triggeredBy).toBe("catch-up");
  });

  it("counts only the first occurrence of a repeated fall-back time as the day's due instant", () => {
    const spec = specOf({ at: "01:30", timezone: NEW_YORK });
    // 01:30 occurs twice on 2026-11-01 in New York: 05:30 UTC (EDT) then 06:30 UTC (EST).
    // A run that covered the first occurrence at 05:35 UTC must read as covered
    // even though the second occurrence is now also in the past.
    const decision = backupTickDecision(spec, new Date("2026-11-01T07:00:00.000Z"), "2026-11-01T05:35:00.000Z");
    expect(decision.action).toBe("none");
    // Before the first occurrence, the previous due instant is yesterday's first occurrence.
    const before = previousScheduledInstant(spec, new Date("2026-11-01T05:00:00.000Z"));
    expect(new Date(before as number).toISOString()).toBe("2026-10-31T05:30:00.000Z");
  });

  it("never catches up when the policy is disabled", () => {
    const spec = specOf({ catchUpAfterMissedRun: false });
    const decision = backupTickDecision(spec, new Date("2026-08-30T09:00:00.000Z"), null);
    expect(decision.action).toBe("none");
    expect(decision.overdueSince).toBe("2026-08-30T03:00:00.000Z");
    expect(decision.nextDueAt).toBe("2026-08-31T03:00:00.000Z");
  });

  it("treats a manual run started after the instant as coverage, and one before it as a miss", () => {
    const covered = backupTickDecision(specOf(), new Date("2026-08-30T09:00:00.000Z"), "2026-08-30T08:59:00.000Z");
    expect(covered.action).toBe("none");
    const missed = backupTickDecision(specOf(), new Date("2026-08-30T09:00:00.000Z"), "2026-08-30T02:59:00.000Z");
    expect(missed.action).toBe("run");
    expect(missed.triggeredBy).toBe("catch-up");
  });

  it("does nothing while the schedule is disabled", () => {
    const decision = backupTickDecision(specOf({ enabled: false }), new Date(), new Date(0).toISOString());
    expect(decision.action).toBe("none");
    expect(decision.nextDueAt).toBeNull();
  });
});
