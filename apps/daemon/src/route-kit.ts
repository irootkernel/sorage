import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonRequestContext } from "./http-kit";

export type { DaemonRequestContext as RouteContext };

export interface RouteEntryInternal {
  method: string;
  pattern: string;
  handler: (request: IncomingMessage, response: ServerResponse, context: DaemonRequestContext) => Promise<void> | void;
  /** True when a browser session token must not call this route (API-004). */
  cliTokenOnly?: boolean;
  idempotencyScope?: "send" | "revise" | "deletion-approve" | "backup-run";
}

interface MatchedRoute {
  route: RouteEntryInternal;
  params: Record<string, string>;
}

interface CompiledRoute {
  route: RouteEntryInternal;
  segments: ({ literal: string } | { parameter: string })[];
}

export interface CompiledRouteTable {
  match(method: string, pathname: string): MatchedRoute | null;
  allowedMethods(pathname: string): string[];
}

function matchPath(route: CompiledRoute, path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const [index, segment] of route.segments.entries()) {
    const value = path[index] as string;
    if ("literal" in segment) {
      if (segment.literal !== value) return null;
    } else {
      try {
        params[segment.parameter] = decodeURIComponent(value);
      } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
      }
    }
  }
  return params;
}

export function compileRoutes(routes: readonly RouteEntryInternal[]): CompiledRouteTable {
  const byLength = new Map<number, CompiledRoute[]>();
  for (const route of routes) {
    const segments = route.pattern
      .split("/")
      .map((segment) =>
        segment.startsWith("{") && segment.endsWith("}") ? { parameter: segment.slice(1, -1) } : { literal: segment },
      );
    const bucket = byLength.get(segments.length);
    if (bucket === undefined) byLength.set(segments.length, [{ route, segments }]);
    else bucket.push({ route, segments });
  }
  return {
    match(method, pathname) {
      const path = pathname.split("/");
      for (const compiled of byLength.get(path.length) ?? []) {
        if (compiled.route.method !== method) continue;
        const params = matchPath(compiled, path);
        if (params !== null) return { route: compiled.route, params };
      }
      return null;
    },
    allowedMethods(pathname) {
      const path = pathname.split("/");
      return (byLength.get(path.length) ?? [])
        .filter((compiled) => matchPath(compiled, path) !== null)
        .map(({ route }) => route.method);
    },
  };
}
