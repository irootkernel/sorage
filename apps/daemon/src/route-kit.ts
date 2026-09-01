import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appError } from "@sorage/core";
import type { DaemonRequestContext } from "./server";

export type { DaemonRequestContext as RouteContext };

/**
 * The tiny routing kit the `/api/v1` surface shares: pattern routes with `{param}`
 * segments, per-route CLI-token restriction (API-004), and the `Idempotency-Key`
 * replay cache that runs before any Row Version precondition (API-012).
 */
export interface RouteEntryInternal {
  method: string;
  pattern: string;
  handler: (request: IncomingMessage, response: ServerResponse, context: DaemonRequestContext) => Promise<void> | void;
  /** True when a browser session token must not call this route (API-004). */
  cliTokenOnly?: boolean;
  /** True when the route participates in `Idempotency-Key` replay (API-012). */
  idempotent?: boolean;
  /** Maximum bytes the replay spool accepts before the route consumes the body. */
  idempotencyBodyLimit?: (() => number) | undefined;
}

export interface MatchedRoute {
  route: RouteEntryInternal;
  params: Record<string, string>;
}

export function matchRoute(routes: RouteEntryInternal[], method: string, pathname: string): MatchedRoute | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternSegments = route.pattern.split("/");
    const pathSegments = pathname.split("/");
    if (patternSegments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const pattern = patternSegments[i] as string;
      const segment = pathSegments[i] as string;
      if (pattern.startsWith("{") && pattern.endsWith("}")) {
        params[pattern.slice(1, -1)] = decodeURIComponent(segment);
      } else if (pattern !== segment) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

/** Collects the method-allowed set of a path across routes, for 405 responses. */
export function allowedMethods(routes: RouteEntryInternal[], pathname: string): string[] {
  return routes.filter((route) => matchPath(route.pattern, pathname)).map((route) => route.method);
}

function matchPath(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return false;
  for (let i = 0; i < patternSegments.length; i++) {
    const pattern = patternSegments[i] as string;
    const segment = pathSegments[i] as string;
    if (!(pattern.startsWith("{") && pattern.endsWith("}")) && pattern !== segment) return false;
  }
  return true;
}

export interface ReplayOutcome {
  replayed: boolean;
  status?: number;
  body?: unknown;
  error?: ReturnType<typeof appError>;
}

/**
 * Evaluates one idempotent request: the same key with the same request hash replays
 * the stored response verbatim, and the same key with a different hash is
 * `IDEMPOTENCY_CONFLICT`; both run before any Row Version precondition (API-012).
 */
export function evaluateIdempotency(
  store: Map<string, { requestHash: string; status: number; body: unknown }>,
  key: string | undefined,
  requestIdentity: string,
): ReplayOutcome {
  if (key === undefined) return { replayed: false };
  const requestHash = createHash("sha256").update(requestIdentity).digest("hex");
  const stored = store.get(key);
  if (stored === undefined) {
    store.set(key, { requestHash, status: -1, body: null });
    return { replayed: false };
  }
  if (stored.status === -1) {
    // A response is still being produced: a concurrent duplicate must not execute
    // the mutation a second time (API-012).
    return {
      replayed: false,
      error: appError("IDEMPOTENCY_CONFLICT", "the same Idempotency-Key is still in flight; retry after it completes"),
    };
  }
  if (stored.requestHash !== requestHash) {
    return {
      replayed: false,
      error: appError("IDEMPOTENCY_CONFLICT", "the same Idempotency-Key was reused with a different request"),
    };
  }
  return { replayed: true, status: stored.status, body: stored.body };
}

export function storeReplay(
  store: Map<string, { requestHash: string; status: number; body: unknown }>,
  key: string | undefined,
  requestIdentity: string,
  status: number,
  body: unknown,
): void {
  if (key === undefined) return;
  // Only completed mutations are replayable. Refusals and failures describe
  // conditions that may clear before the client retries (for example a held
  // backup lock), so retaining them would turn a transient response permanent.
  if (status < 200 || status >= 300) {
    store.delete(key);
    return;
  }
  const requestHash = createHash("sha256").update(requestIdentity).digest("hex");
  store.set(key, { requestHash, status, body });
}

/**
 * Releases an in-flight marker so a failed execution leaves the key retryable: a
 * handler that throws must not pin its Idempotency-Key as permanently in flight.
 */
export function discardReplay(
  store: Map<string, { requestHash: string; status: number; body: unknown }>,
  key: string | undefined,
): void {
  if (key === undefined) return;
  const stored = store.get(key);
  if (stored !== undefined && stored.status === -1) store.delete(key);
}
