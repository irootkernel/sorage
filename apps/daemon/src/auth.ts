import { appError, tokensEqual, type AppError } from "@sorage/core";
import type { ApiTokenStorePort, TokenEntropyPort, WebSecretPort } from "@sorage/core";

/**
 * The bearer authentication layer of section 17 (SEC-002, SEC-003, SEC-019,
 * SEC-020): a request with no `Authorization` header is `UNAUTHENTICATED`, a
 * presented token that is neither the Installation API token nor a live browser
 * session is `TOKEN_INVALID`, and every live session dies the moment the API token
 * file changes, which is what `sorage token rotate` invalidates them through.
 */

export type AuthenticatedKind = "api-token" | "session";

export interface AuthenticatedContext {
  kind: AuthenticatedKind;
}

export type AuthResult = { ok: true; context: AuthenticatedContext } | { ok: false; error: AppError };

export interface SessionService {
  /**
   * Consumes the one-time browser secret and returns a fresh session token, or an
   * `UNAUTHENTICATED` failure for an absent, expired, already-used, or wrong secret.
   */
  exchange(secret: string): AuthResult & { token?: string };
  /** Evaluates a presented bearer token against the API token and live sessions. */
  authenticate(presented: string): AuthResult;
}

export interface SessionServiceOptions {
  token: ApiTokenStorePort;
  webSecret: WebSecretPort;
  entropy: TokenEntropyPort;
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  // Sessions carry the API-token material they were issued under; a rotation writes a
  // different token file and thereby invalidates every session at once.
  const sessions = new Map<string, string>();

  const apiTokenMatches = (presented: string): boolean => {
    const current = options.token.read();
    return current !== null && tokensEqual(current, presented);
  };

  return {
    exchange: (secret: string) => {
      if (!options.webSecret.consume(secret)) {
        return {
          ok: false,
          error: appError("UNAUTHENTICATED", "the one-time browser secret is absent, expired, or already used"),
        };
      }
      const token = options.entropy.next();
      const current = options.token.read();
      if (current === null) {
        return {
          ok: false,
          error: appError("UNAUTHENTICATED", "this installation has no API token to anchor a session"),
        };
      }
      sessions.set(token, current);
      return { ok: true, context: { kind: "session" }, token };
    },
    authenticate: (presented: string) => {
      if (apiTokenMatches(presented)) return { ok: true, context: { kind: "api-token" } };
      const anchored = sessions.get(presented);
      if (anchored !== undefined && apiTokenMatches(anchored)) {
        return { ok: true, context: { kind: "session" } };
      }
      return { ok: false, error: appError("TOKEN_INVALID", "the presented token is unknown, rotated, or expired") };
    },
  };
}

/** Extracts the bearer value from an `Authorization` header, or null when absent. */
export function bearerValue(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  return match === null ? null : (match[1] ?? null);
}
