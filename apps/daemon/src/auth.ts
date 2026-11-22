import { type BigIntStats, statSync } from "node:fs";
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
  /** Clears cached token state and prunes every live browser session immediately. */
  invalidate?(): void;
  /** Returns the count of currently retained browser sessions. */
  activeSessionCount?(): number;
}

export interface SessionServiceOptions {
  token: ApiTokenStorePort;
  webSecret: WebSecretPort;
  entropy: TokenEntropyPort;
}

interface CachedTokenStat {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  value: string;
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  // Sessions carry the API-token material they were issued under; a rotation writes a
  // different token file and immediately prunes every stale session entry.
  const sessions = new Map<string, string>();
  let cachedStat: CachedTokenStat | null = null;
  let lastToken: string | null = null;

  const updateObservedToken = (next: string | null): string | null => {
    if (next === null) {
      sessions.clear();
      lastToken = null;
      return null;
    }
    if (lastToken !== null && !tokensEqual(lastToken, next)) {
      sessions.clear();
    }
    lastToken = next;
    return next;
  };

  const readCurrentToken = (): string | null => {
    let st: BigIntStats | null = null;
    try {
      st = statSync(options.token.path, { bigint: true });
    } catch {
      // File missing, unreadable, or synthetic path in an in-memory test store:
      // never serve a stale cached value; fall back to the port's own read().
      cachedStat = null;
      return updateObservedToken(options.token.read());
    }
    if (!st.isFile()) {
      cachedStat = null;
      return updateObservedToken(null);
    }
    if (
      cachedStat !== null &&
      cachedStat.dev === st.dev &&
      cachedStat.ino === st.ino &&
      cachedStat.mode === st.mode &&
      cachedStat.size === st.size &&
      cachedStat.mtimeNs === st.mtimeNs &&
      cachedStat.ctimeNs === st.ctimeNs
    ) {
      return cachedStat.value;
    }
    const fresh = updateObservedToken(options.token.read());
    if (fresh === null) {
      // Never negatively cache null so transient read errors or same-tick permission
      // recovery do not latch authentication closed.
      cachedStat = null;
      return null;
    }
    cachedStat = {
      dev: st.dev,
      ino: st.ino,
      mode: st.mode,
      size: st.size,
      mtimeNs: st.mtimeNs,
      ctimeNs: st.ctimeNs,
      value: fresh,
    };
    return fresh;
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
      const current = readCurrentToken();
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
      const current = readCurrentToken();
      if (current === null) {
        return { ok: false, error: appError("TOKEN_INVALID", "the presented token is unknown, rotated, or expired") };
      }
      if (tokensEqual(current, presented)) {
        return { ok: true, context: { kind: "api-token" } };
      }
      const anchored = sessions.get(presented);
      if (anchored !== undefined) {
        if (tokensEqual(current, anchored)) {
          return { ok: true, context: { kind: "session" } };
        }
        sessions.delete(presented);
      }
      return { ok: false, error: appError("TOKEN_INVALID", "the presented token is unknown, rotated, or expired") };
    },
    invalidate: () => {
      cachedStat = null;
      lastToken = null;
      sessions.clear();
    },
    activeSessionCount: () => sessions.size,
  };
}

/** Extracts the bearer value from an `Authorization` header, or null when absent. */
export function bearerValue(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  return match === null ? null : (match[1] ?? null);
}
