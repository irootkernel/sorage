import { createHash } from "node:crypto";
import { appError, type AppError, type Result } from "./errors";

/**
 * Opaque pagination cursor codec (CLI-004, section 18 of interfaces-and-operations.md).
 * A cursor is base64url(payload) + "." + base64url(sha256(payload)); reusing a cursor
 * with a different filter set changes the filter hash and fails with CURSOR_INVALID
 * rather than silently paging through an inconsistent result.
 */
export interface CursorPayload {
  /** Hash of the filter set the cursor was minted under. */
  filterHash: string;
  /** Sort key of the last emitted row; the codec treats it as opaque. */
  lastSortKey: string;
  /** Page size the listing was invoked with. */
  limit: number;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hashes a filter set into the stable identity a cursor binds to. */
export function filterHash(filters: Record<string, string | number | boolean | null>): string {
  // JSON of sorted [key, value] pairs: no delimiter can collide with content.
  const canonical = JSON.stringify(
    Object.keys(filters)
      .sort()
      .map((key) => [key, filters[key]] as [string, string | number | boolean | null]),
  );
  return sha256Hex(canonical);
}

function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CursorPayload>;
  return (
    typeof candidate.filterHash === "string" &&
    typeof candidate.lastSortKey === "string" &&
    typeof candidate.limit === "number" &&
    Number.isInteger(candidate.limit) &&
    candidate.limit > 0
  );
}

/** Mints an opaque cursor for one page of one filter set; an invalid payload is a caller bug. */
export function encodeCursor(payload: CursorPayload): string {
  if (!isCursorPayload(payload)) {
    throw new RangeError(
      "cursor payload must carry a string filterHash, a string lastSortKey, and a positive integer limit",
    );
  }
  const body = JSON.stringify(payload);
  return `${toBase64Url(body)}.${Buffer.from(sha256Hex(body), "utf8").toString("base64url")}`;
}

/** Decodes a cursor, failing with CURSOR_INVALID on tampering or filter mismatch. */
export function decodeCursor(cursor: string, expectedFilterHash: string): Result<CursorPayload, AppError> {
  const parts = cursor.split(".");
  if (parts.length !== 2) {
    return { ok: false, error: invalid("malformed cursor") };
  }
  const body = fromBase64Url(parts[0] ?? "");
  const checksum = fromBase64Url(parts[1] ?? "");
  if (body === null || checksum === null) {
    return { ok: false, error: invalid("malformed cursor") };
  }
  if (sha256Hex(body) !== checksum) {
    return { ok: false, error: invalid("cursor checksum mismatch") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: invalid("cursor payload is not JSON") };
  }
  if (!isCursorPayload(parsed)) {
    return { ok: false, error: invalid("cursor payload shape is invalid") };
  }
  const payload: CursorPayload = parsed;
  if (payload.filterHash !== expectedFilterHash) {
    return { ok: false, error: invalid("cursor does not match the supplied filter set") };
  }
  return { ok: true, value: payload };
}

function invalid(message: string): AppError {
  return appError("CURSOR_INVALID", message, { cursor: true });
}
