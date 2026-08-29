import { timingSafeEqual } from "node:crypto";
import { err, ok, type AppError, type Result } from "./errors";

/**
 * The token model of milestone 0.2 (SEC-002, SEC-019, SEC-020): the Installation API
 * token lives outside `config.yaml` at `~/.sorage/state/api-token` as at least 32
 * random bytes encoded base64url with owner-only permissions, is compared in constant
 * time, and is never logged, echoed, or embedded in an error body.
 */

/** The minimum decoded token length in bytes (SEC-020). */
export const MINIMUM_TOKEN_BYTES = 32;

/** The lifetime of a one-time browser secret, in milliseconds. */
export const WEB_SECRET_TTL_MS = 5 * 60 * 1000;

/** True when a candidate is a base64url string decoding to at least 32 bytes. */
export function isWellFormedToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decodedLength = Math.floor((value.length * 6) / 8);
  return decodedLength >= MINIMUM_TOKEN_BYTES;
}

/**
 * Constant-time equality for token material; the length comparison is also folded in
 * so a caller cannot learn the stored length one early exit at a time (SEC-020).
 */
export function tokensEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    // Still perform one comparison of equal-length stand-ins so timing does not bail
    // on the length branch alone.
    const standIn = Buffer.alloc(bufferA.length, 0);
    timingSafeEqualFixed(standIn, standIn);
    return false;
  }
  return timingSafeEqualFixed(bufferA, bufferB);
}

function timingSafeEqualFixed(a: Buffer, b: Buffer): boolean {
  return timingSafeEqual(a, b);
}

/** The entropy source every token and secret is drawn from. */
export interface TokenEntropyPort {
  /** Returns one fresh base64url token of at least `MINIMUM_TOKEN_BYTES` bytes. */
  next(): string;
}

/** The Installation API token file port (SEC-020). */
export interface ApiTokenStorePort {
  /** The canonical token path, for diagnostics that never include the material. */
  readonly path: string;
  /** Reads the current token, or null before the first creation. */
  read(): string | null;
  /** Creates the token when absent without ever replacing an existing one. */
  ensure(): Result<{ created: boolean }, AppError>;
  /** Replaces the token; every previous token and session stops validating. */
  rotate(): Result<{ rotated: true }, AppError>;
}

/** The one-time browser secret port behind `sorage web` (SEC-019, RUN-012). */
export interface WebSecretPort {
  /** Writes a fresh single-use secret and returns it with its expiry. */
  issue(): Result<{ secret: string; expiresAt: string }, AppError>;
  /**
   * Consumes the pending secret exactly once: a matching, unexpired secret is deleted
   * from the store and returns true; anything else returns false with no state change
   * beyond deleting an expired record.
   */
  consume(candidate: string): boolean;
}

/** The `sorage token rotate --as-user` use case (SEC-020). */
export function rotateApiToken(
  ports: { token: ApiTokenStorePort },
  options: { asUser: boolean },
): Result<{ rotated: true }, AppError> {
  if (options.asUser !== true) {
    return err({ code: "USER_CONTEXT_REQUIRED", message: "token rotate expresses User intent and requires --as-user" });
  }
  return ports.token.rotate();
}

/** Guards that a freshly generated token meets the documented shape. */
export function validateGeneratedToken(token: string): Result<{ token: string }, AppError> {
  if (!isWellFormedToken(token)) {
    return err({ code: "INTERNAL_ERROR", message: "the generated token material does not meet the documented shape" });
  }
  return ok({ token });
}
