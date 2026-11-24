import { createHash } from "node:crypto";

/** Plain non-null, non-array object guard. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Closed objects at domain boundaries; JSON null and arrays are never records. */
export function memoObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

/** The exact UTF-8 byte length of a text body; the routing measure of SHR-002. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** SHA-256 over the exact UTF-8 bytes of a text body, the digest an inline record stores. */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** SHA-256 over exact bytes; the digest every content record stores (SHR-003). */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
