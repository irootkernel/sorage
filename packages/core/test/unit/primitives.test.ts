import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

function sha256Of(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
import {
  SystemClock,
  UuidGenerator,
  decodeCursor,
  encodeCursor,
  errorSpec,
  filterHash,
  newRequestId,
  renderInTimezone,
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
