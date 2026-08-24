/**
 * Deterministic fakes for the Clock and IdGenerator ports that TASK-004 defines.
 * Tests use these instead of wall-clock time and random identifiers.
 */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

const ISO_EPOCH = "2026-01-01T00:00:00.000Z";

/** A clock whose time only advances when the test advances it, in UTC. */
export class FakeClock implements Clock {
  private currentMs: number;

  constructor(startMs = Date.parse(ISO_EPOCH)) {
    this.currentMs = startMs;
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

/** An id generator that yields `prefix-000001`, `prefix-000002`, and so on. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "id") {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter.toString().padStart(6, "0")}`;
  }
}
