/**
 * The backup schedule computation of section 29 (TASK-056, BKP-026, BKP-015):
 * the daemon recomputes the next due run on every 60-second tick inside
 * `gitBackup.schedule.timezone`, using a 60-second tick rather than one long
 * timer so a laptop that sleeps through the schedule wakes into a tick that
 * simply observes the run is overdue. A scheduled local time that does not
 * exist on a spring-forward day resolves to the next valid instant, and a
 * local time that occurs twice on a fall-back day resolves to its first
 * occurrence, both through the zone's own offset table rather than an
 * arithmetic guess.
 */

export interface BackupScheduleSpec {
  enabled: boolean;
  /** Local wall time `HH:MM` inside `timezone`. */
  at: string;
  timezone: string;
  catchUpAfterMissedRun: boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The largest zone offset magnitude the scan windows must cover. */
const MAX_OFFSET_MS = 14 * 60 * MINUTE_MS;

/** A local wall-clock date-time the schedule resolves into UTC instants. */
interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function offsetOf(timezone: string, atMs: number): number {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).format(
    new Date(atMs),
  );
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(formatted);
  if (match === null) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes) * MINUTE_MS;
}

function wallOf(timezone: string, atMs: number): WallTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(atMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/**
 * Every UTC instant whose local rendering in the zone is exactly this wall
 * time: two instants when the wall time occurs twice on a fall-back day, one
 * normally, and none on a spring-forward day. Sorted ascending, so the first
 * element is the first occurrence BKP-026 names.
 */
export function localWallInstants(timezone: string, wall: WallTime): number[] {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const probes = new Set<number>();
  for (const anchor of [naive - MAX_OFFSET_MS, naive, naive + MAX_OFFSET_MS]) {
    const first = naive - offsetOf(timezone, anchor);
    probes.add(first);
    probes.add(naive - offsetOf(timezone, first));
    const second = naive - offsetOf(timezone, first);
    probes.add(naive - offsetOf(timezone, second));
  }
  const instants = [...probes].filter((at) => sameWall(wallOf(timezone, at), wall));
  return [...new Set(instants)].sort((a, b) => a - b);
}

/**
 * The next valid instant at or after a wall time that does not exist, found by
 * walking the zone minute by minute until the local clock has moved past the
 * gap: on a 02:00-to-03:00 spring forward this returns the 03:00 transition
 * instant itself, which is the "next valid instant" of section 29.
 */
function firstValidInstantAfter(timezone: string, wall: WallTime): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  for (let at = naive - MAX_OFFSET_MS; at <= naive + MAX_OFFSET_MS; at += MINUTE_MS) {
    const current = wallOf(timezone, at);
    if (
      current.year > wall.year ||
      (current.year === wall.year && current.month > wall.month) ||
      (current.year === wall.year && current.month === wall.month && current.day > wall.day) ||
      (current.year === wall.year &&
        current.month === wall.month &&
        current.day === wall.day &&
        (current.hour > wall.hour || (current.hour === wall.hour && current.minute >= wall.minute)))
    ) {
      return at;
    }
  }
  return naive;
}

function parseAt(at: string): { hour: number; minute: number } {
  const [hour, minute] = at.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

/**
 * The next scheduled UTC instant strictly after `now`: for each of the next
 * four local days, resolve the wall time — the first occurrence when the day
 * has two, and the transition instant when the day has none — and return the
 * first instant that lies in the future.
 */
export function nextScheduledInstant(spec: BackupScheduleSpec, now: Date): number | null {
  const { hour, minute } = parseAt(spec.at);
  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const probe = wallOf(spec.timezone, now.getTime() + dayOffset * DAY_MS);
    const wall: WallTime = { ...probe, hour, minute };
    const instants = localWallInstants(spec.timezone, wall);
    const candidate = instants.length > 0 ? (instants[0] as number) : firstValidInstantAfter(spec.timezone, wall);
    if (candidate > now.getTime()) return candidate;
  }
  return null;
}

/**
 * The most recent scheduled UTC instant at or before `now`, across today and
 * the two preceding local days; the sleep-gap and catch-up logic compares run
 * history against it.
 */
export function previousScheduledInstant(spec: BackupScheduleSpec, now: Date): number | null {
  const { hour, minute } = parseAt(spec.at);
  let latest: number | null = null;
  for (let dayOffset = -2; dayOffset <= 0; dayOffset += 1) {
    const probe = wallOf(spec.timezone, now.getTime() + dayOffset * DAY_MS);
    const wall: WallTime = { ...probe, hour, minute };
    const instants = localWallInstants(spec.timezone, wall);
    const candidates = instants.length > 0 ? instants : [firstValidInstantAfter(spec.timezone, wall)];
    for (const candidate of candidates) {
      if (candidate <= now.getTime() && (latest === null || candidate > latest)) latest = candidate;
    }
  }
  return latest;
}

/** The computed next due time of section 31, or null while the schedule is off. */
export function nextDueAt(spec: BackupScheduleSpec, now: Date): string | null {
  if (!spec.enabled) return null;
  const instant = nextScheduledInstant(spec, now);
  return instant === null ? null : new Date(instant).toISOString();
}

/** A scheduled run this far past its instant still counts as on time, not missed. */
export const SCHEDULE_GRACE_MS = 2 * MINUTE_MS;

export interface BackupTickDecision {
  action: "run" | "none";
  /** Set when the action is a run. */
  triggeredBy: "scheduled" | "catch-up";
  /** The instant this decision answers, set for informational ticks too. */
  overdueSince: string | null;
  nextDueAt: string | null;
}

/**
 * One 60-second tick's decision (BKP-015): the most recent scheduled instant
 * that has passed is covered when any run — manual, scheduled, or catch-up —
 * started at or after it, which is also what makes the catch-up at-most-once:
 * the catch-up run's own history row covers the gap it answered, so repeated
 * missed intervals never produce a burst. An uncovered instant inside the
 * grace window runs as `scheduled`; an older one runs once as `catch-up` only
 * when the policy allows it, and never otherwise.
 */
export function backupTickDecision(spec: BackupScheduleSpec, now: Date, lastRunAt: string | null): BackupTickDecision {
  const next = nextDueAt(spec, now);
  if (!spec.enabled) return { action: "none", triggeredBy: "scheduled", overdueSince: null, nextDueAt: next };
  const previous = previousScheduledInstant(spec, now);
  if (previous === null) return { action: "none", triggeredBy: "scheduled", overdueSince: null, nextDueAt: next };
  const covered = lastRunAt !== null && Date.parse(lastRunAt) >= previous;
  if (covered) return { action: "none", triggeredBy: "scheduled", overdueSince: null, nextDueAt: next };
  const overdueMs = now.getTime() - previous;
  if (overdueMs <= SCHEDULE_GRACE_MS) {
    return { action: "run", triggeredBy: "scheduled", overdueSince: new Date(previous).toISOString(), nextDueAt: next };
  }
  if (spec.catchUpAfterMissedRun) {
    return { action: "run", triggeredBy: "catch-up", overdueSince: new Date(previous).toISOString(), nextDueAt: next };
  }
  return { action: "none", triggeredBy: "catch-up", overdueSince: new Date(previous).toISOString(), nextDueAt: next };
}
