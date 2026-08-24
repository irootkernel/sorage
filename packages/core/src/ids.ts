import { randomUUID } from "node:crypto";

/** UTC clock port; tests inject a deterministic implementation. */
export interface Clock {
  /** Always a UTC instant; Sorage never stores local time. */
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Identifier generation port; tests inject a deterministic implementation. */
export interface IdGenerator {
  next(): string;
}

/** Generates RFC 4122 version 4 UUIDs, the identifier form of every Sorage entity. */
export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/** Generates request identifiers that travel in every envelope and log line. */
export function newRequestId(generator: IdGenerator): string {
  return generator.next();
}

/** Renders a UTC instant in an explicit IANA timezone, for human output only. */
export function renderInTimezone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  }).format(instant);
}

/** Parses an instant and returns it normalized to a UTC ISO string. */
export function toUtcIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`not a valid instant: ${value}`);
  }
  return parsed.toISOString();
}
