import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

function sha256Of(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
import {
  SystemClock,
  UuidGenerator,
  decodeCursor,
  discloseLargeContent,
  emitCompletionWarning,
  encodeCursor,
  errorSpec,
  filterHash,
  isCanonicalUtcTimestamp,
  isCanonicalUuid,
  isPlainObject,
  newRequestId,
  remainingMs,
  renderInTimezone,
  sleepWithinDeadline,
  toUtcIso,
} from "../../src/index";

describe("error catalogue", () => {
  it("maps every symbolic code to its published HTTP status and exit code", () => {
    const cursor = errorSpec("CURSOR_INVALID");
    expect(cursor.httpStatus).toBe(422);
    expect(cursor.exitCode).toBe(64);
    expect(errorSpec("INTERNAL_ERROR").exitCode).toBe(1);
    expect(errorSpec("NOT_INITIALIZED").exitCode).toBe(78);
    expect(errorSpec("ROW_VERSION_CONFLICT").exitCode).toBe(75);
    expect(errorSpec("FORBIDDEN_ACTOR").exitCode).toBe(77);
    expect(errorSpec("HANDOFF_NOT_FOUND").exitCode).toBe(66);
  });

  it("carries recovery guidance where the table documents one", () => {
    expect(errorSpec("NOT_INITIALIZED").recovery?.suggestedCommand).toBe("sorage init");
    expect(errorSpec("PROJECT_NOT_FOUND").recovery).toBeDefined();
  });
});

describe("cursor codec", () => {
  const filters = { state: "awaiting_recipient", includeArchived: false };

  it("round-trips a cursor for its own filter set", () => {
    const hash = filterHash(filters);
    const cursor = encodeCursor({ filterHash: hash, lastSortKey: "2026-01-01T00:00:00.000Z|uuid", limit: 50 });
    const decoded = decodeCursor(cursor, hash);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.lastSortKey).toBe("2026-01-01T00:00:00.000Z|uuid");
      expect(decoded.value.limit).toBe(50);
    }
  });

  it("rejects a tampered cursor with CURSOR_INVALID", () => {
    const hash = filterHash(filters);
    const cursor = encodeCursor({ filterHash: hash, lastSortKey: "k", limit: 10 });
    const [body] = cursor.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ filterHash: hash, lastSortKey: "evil", limit: 10 }),
      "utf8",
    ).toString("base64url");
    const decoded = decodeCursor(`${tamperedPayload}.${body ?? ""}`, hash);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("CURSOR_INVALID");
  });

  it("rejects a checksum-valid null payload with CURSOR_INVALID instead of throwing", () => {
    const nullBody = Buffer.from("null", "utf8").toString("base64url");
    const nullChecksum = Buffer.from(sha256Of("null"), "utf8").toString("base64url");
    const decoded = decodeCursor(`${nullBody}.${nullChecksum}`, filterHash(filters));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("CURSOR_INVALID");
  });

  it("does not collide filter hashes across delimiter-bearing filter values", () => {
    const first = filterHash({ state: "a=b" });
    const second = filterHash({ state: "a", extra: "b" });
    expect(first).not.toBe(second);
  });

  it("rejects a cursor minted under a different filter set with CURSOR_INVALID", () => {
    const cursor = encodeCursor({ filterHash: filterHash(filters), lastSortKey: "k", limit: 10 });
    const decoded = decodeCursor(cursor, filterHash({ state: "accepted" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("CURSOR_INVALID");
  });
});

describe("identifiers and time", () => {
  it("generates UUID-shaped request identifiers", () => {
    const id = newRequestId(new UuidGenerator());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("round-trips timestamps as UTC", () => {
    const iso = "2026-08-24T03:04:05.678Z";
    expect(toUtcIso(iso)).toBe(iso);
    // A zone-offset input normalizes to the same UTC instant.
    expect(toUtcIso("2026-08-24T12:04:05.678+09:00")).toBe(iso);
  });

  it("renders the same UTC instant in a selected timezone", () => {
    const instant = new Date("2026-08-24T00:00:00.000Z");
    const seoul = renderInTimezone(instant, "Asia/Seoul");
    const utc = renderInTimezone(instant, "UTC");
    expect(seoul).toContain("24");
    expect(seoul).toContain("09:00");
    expect(utc).toContain("00:00");
  });

  it("uses a real clock that reports UTC instants", () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("shared core primitives", () => {
  it("validates canonical UUIDs, UTC timestamps, and plain objects", () => {
    expect(isCanonicalUuid("0123abcd-0000-4000-8000-000000000001")).toBe(true);
    expect(isCanonicalUuid("0123ABCD-0000-4000-8000-000000000001")).toBe(false);
    expect(isCanonicalUuid(null)).toBe(false);
    expect(isCanonicalUtcTimestamp("2026-08-24T03:04:05.678Z")).toBe(true);
    expect(isCanonicalUtcTimestamp("2026-08-24T03:04:05Z")).toBe(false);
    expect(isCanonicalUtcTimestamp("not-a-date")).toBe(false);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
  });

  it("computes remaining polling budget and clamps sleeps to the deadline", () => {
    expect(remainingMs(10_000, 7_500)).toBe(2_500);
    expect(remainingMs(10_000, 12_000)).toBe(0);
    const sleeps: number[] = [];
    expect(sleepWithinDeadline(10_000, 7_500, 1_000, (ms) => sleeps.push(ms))).toBe(true);
    expect(sleepWithinDeadline(10_000, 9_400, 1_000, (ms) => sleeps.push(ms))).toBe(true);
    expect(sleepWithinDeadline(10_000, 10_000, 1_000, (ms) => sleeps.push(ms))).toBe(false);
    expect(sleeps).toEqual([1_000, 600]);
  });

  it("contains sink errors in completion warnings and large-content disclosures", () => {
    const warnings: string[] = [];
    emitCompletionWarning({ completionWarning: (text) => warnings.push(text) }, "warn");
    expect(warnings).toEqual(["warn"]);
    expect(() =>
      emitCompletionWarning(
        {
          completionWarning() {
            throw new Error("boom");
          },
        },
        "ignored",
      ),
    ).not.toThrow();

    const disclosed: Array<[number, number]> = [];
    const ports = {
      backupEnabled: true,
      thresholdBytes: 100,
      largeContent(sizeBytes: number, thresholdBytes: number) {
        disclosed.push([sizeBytes, thresholdBytes]);
      },
    };
    discloseLargeContent(ports, 100);
    discloseLargeContent(ports, 101);
    discloseLargeContent({ ...ports, backupEnabled: false }, 200);
    expect(disclosed).toEqual([[101, 100]]);
    expect(() =>
      discloseLargeContent(
        {
          backupEnabled: true,
          thresholdBytes: 10,
          largeContent() {
            throw new Error("sink error");
          },
        },
        20,
      ),
    ).not.toThrow();
  });
});
