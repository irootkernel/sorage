import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import {
  type AppError,
  appError,
  errorEnvelope,
  errorSpec,
  type IdGenerator,
  newRequestId,
  successEnvelope,
} from "@sorage/core";
import { bearerValue, type AuthenticatedContext, type SessionService } from "./auth";

/**
 * The daemon HTTP skeleton of TASK-042: loopback-only bind, the `Host` allowlist of
 * SEC-017 checked before routing, the mandatory security headers of SEC-018 on every
 * response, request identifiers, the error middleware that renders API-006 bodies, and
 * the health, readiness, and version endpoints of section 18.1.
 */

/** The exact `Content-Security-Policy` every daemon response carries (SEC-018). */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The three security headers every daemon response, success and failure alike (SEC-018). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

/** The bind addresses the daemon accepts; a name such as `localhost` is refused (SEC-001). */
const LOOPBACK_BIND_ADDRESSES = new Set(["127.0.0.1", "::1"]);

/** The `Host` header names the allowlist keeps alongside the bind enum (SEC-017). */
const ALLOWED_HOST_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export interface DaemonEndpoints {
  /** The Installation the daemon serves; health returns it so a stale `daemon.json` is detectable. */
  installationId: string;
  /** The build version of the running daemon binary. */
  version: string;
}

export interface ReadinessReport {
  ready: boolean;
}

export interface DaemonRequestContext {
  requestId: string;
  /** The authenticated bearer kind; present on every route that requires authentication. */
  auth?: AuthenticatedContext;
}

export type DaemonRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonRequestContext,
) => Promise<void> | void;

interface RouteEntry {
  method: string;
  path: string;
  handler: DaemonRouteHandler;
}

export interface DaemonServerOptions {
  /** The configured bind address; only the loopback literals are accepted. */
  host: string;
  /** The configured port; part of the `Host` allowlist. */
  port: number;
  endpoints: DaemonEndpoints;
  /** Supplies readiness; defaults to always ready until later milestones add real checks. */
  readiness?: () => ReadinessReport | Promise<ReadinessReport>;
  /** Request identifier generation; tests inject a deterministic generator. */
  idGenerator?: IdGenerator;
  /**
   * The bearer authentication layer of section 17.1. When absent, only the public
   * meta endpoints answer; every protected route requires it from TASK-043 on.
   */
  auth?: SessionService;
  /** Rotates the Installation API token for `POST /api/v1/token/rotate`. */
  tokenRotate?: () => { ok: true; value: { rotated: true } } | { ok: false; error: AppError };
  /** True while the daemon drains: new mutations are refused with SERVICE_PAUSED (SEC-015). */
  isDraining?: () => boolean;
  /** In-flight bookkeeping the graceful drain waits on. */
  onRequestStart?: () => void;
  onRequestEnd?: () => void;
}

/** True only for the loopback literals; a name is never a valid bind address (SEC-001). */
export function isLoopbackBindAddress(host: string): boolean {
  return LOOPBACK_BIND_ADDRESSES.has(host);
}

/**
 * Decides whether a `Host` header value is inside the allowlist
 * `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` (SEC-017). The value must carry
 * the configured port; `::1` is bracketed in a `Host` header.
 */
export function isHostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  let name = hostHeader.trim().toLowerCase();
  if (name.startsWith("[")) {
    const close = name.indexOf("]");
    if (close === -1) return false;
    const hostPort = name.slice(close + 1);
    if (hostPort !== `:${port}`) return false;
    name = name.slice(1, close);
  } else {
    const colon = name.lastIndexOf(":");
    if (colon === -1) return false;
    if (Number(name.slice(colon + 1)) !== port) return false;
    name = name.slice(0, colon);
  }
  return ALLOWED_HOST_NAMES.has(name);
}

function sendJson(response: ServerResponse, status: number, requestId: string, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.statusCode = status;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Request-Id", requestId);
  response.end(`${payload}\n`);
}

function sendError(response: ServerResponse, requestId: string, error: AppError): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const allow = error.details?.allow;
  const spec = errorSpec(error.code);
  if (typeof allow === "string") response.setHeader("Allow", allow);
  sendJson(response, spec.httpStatus, requestId, errorEnvelope(error, requestId));
}

/** The health, readiness, and version endpoints of section 18.1. */
export function daemonRoutes(options: {
  endpoints: DaemonEndpoints;
  readiness: () => ReadinessReport | Promise<ReadinessReport>;
}): RouteEntry[] {
  const { endpoints, readiness } = options;
  return [
    {
      method: "GET",
      path: "/api/v1/health",
      handler: (_request, response, context) => {
        sendJson(
          response,
          200,
          context.requestId,
          successEnvelope(
            {
              installationId: endpoints.installationId,
              version: endpoints.version,
            },
            context.requestId,
          ),
        );
      },
    },
    {
      method: "GET",
      path: "/api/v1/readiness",
      handler: async (_request, response, context) => {
        const report = await readiness();
        sendJson(response, report.ready ? 200 : 503, context.requestId, successEnvelope(report, context.requestId));
      },
    },
    {
      method: "GET",
      path: "/api/v1/version",
      handler: (_request, response, context) => {
        sendJson(
          response,
          200,
          context.requestId,
          successEnvelope(
            {
              daemon: "sorage-daemon",
              version: endpoints.version,
            },
            context.requestId,
          ),
        );
      },
    },
  ];
}

export type DaemonRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * The paths the section 18.1 catalog exposes without a bearer token: the three meta
 * endpoints a daemon-discovery probe needs before any credential exists in context.
 */
const PUBLIC_PATHS = new Set(["/api/v1/health", "/api/v1/readiness", "/api/v1/version"]);

const MAX_SESSION_BODY_BYTES = 8192;

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_SESSION_BODY_BYTES) throw appError("UNAUTHENTICATED", "the session exchange body is too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Builds the full request pipeline: request identifier, `Host` allowlist before routing
 * and before authentication (SEC-017), bearer authentication (SEC-019, SEC-020), route
 * dispatch, and the error middleware that renders an API-006 body for every failure.
 */
export function createDaemonRequestHandler(options: DaemonServerOptions): DaemonRequestHandler {
  const routes = [
    ...daemonRoutes({
      endpoints: options.endpoints,
      readiness: options.readiness ?? (() => ({ ready: true })),
    }),
  ];
  const sessionPath = "/api/v1/session";
  const rotatePath = "/api/v1/token/rotate";
  const paths = new Set([...routes.map((route) => route.path), sessionPath, rotatePath]);

  return async (request, response) => {
    const requestId = newRequestId(options.idGenerator ?? idGenerator);
    options.onRequestStart?.();
    response.on("close", () => options.onRequestEnd?.());
    try {
      // A draining daemon refuses new mutations before storage shutdown, while the
      // requests already in flight finish normally (SEC-015).
      const method = request.method ?? "GET";
      if (options.isDraining?.() === true && method !== "GET" && method !== "HEAD") {
        sendError(
          response,
          requestId,
          appError("SERVICE_PAUSED", "the daemon is draining and refuses new mutations before it stops"),
        );
        return;
      }
      // Host validation runs before routing and before authentication (SEC-017), so a
      // DNS-rebinding request is turned away before any handler or credential check.
      if (!isHostAllowed(request.headers.host, options.port)) {
        sendError(
          response,
          requestId,
          appError(
            "HOST_NOT_ALLOWED",
            `the Host header ${JSON.stringify(request.headers.host ?? "")} is outside the allowlist`,
            { host: request.headers.host ?? null },
          ),
        );
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const isPublicPath = PUBLIC_PATHS.has(url.pathname);
      const route = routes.find((entry) => entry.path === url.pathname && entry.method === method);

      // The public meta endpoints answer without a credential; their method rule is
      // still enforced, so a wrong verb on a public path is a 405, not a 401.
      if (isPublicPath) {
        if (route !== undefined) {
          await route.handler(request, response, { requestId });
          return;
        }
        sendError(
          response,
          requestId,
          appError("METHOD_NOT_ALLOWED", `${method} is not accepted by ${url.pathname}`, {
            path: url.pathname,
            allow: routes
              .filter((entry) => entry.path === url.pathname)
              .map((entry) => entry.method)
              .join(", "),
          }),
        );
        return;
      }

      // The session exchange is the only endpoint that takes the one-time fragment
      // secret instead of a bearer token (SEC-019); every other non-public route
      // authenticates strictly before its handler runs.
      if (url.pathname === sessionPath) {
        if (method !== "POST") {
          sendError(
            response,
            requestId,
            appError("METHOD_NOT_ALLOWED", `${method} is not accepted by ${sessionPath}`, {
              path: sessionPath,
              allow: "POST",
            }),
          );
          return;
        }
        if (options.auth === undefined) {
          sendError(response, requestId, appError("NOT_FOUND", `no endpoint at ${sessionPath}`, { path: sessionPath }));
          return;
        }
        const body = await readJsonBody(request);
        const secret = typeof body.secret === "string" ? body.secret : "";
        const exchange = options.auth.exchange(secret);
        if (!exchange.ok) {
          sendError(response, requestId, exchange.error);
          return;
        }
        sendJson(response, 200, requestId, successEnvelope({ token: exchange.token, tokenType: "session" }, requestId));
        return;
      }

      // Authentication precedes routing for every other path (section 17.2), so an
      // unauthenticated probe learns nothing about which routes exist.
      const presented = bearerValue(request.headers.authorization);
      if (presented === null) {
        sendError(
          response,
          requestId,
          appError("UNAUTHENTICATED", "no Authorization header was presented", { path: url.pathname }),
        );
        return;
      }
      if (options.auth === undefined) {
        sendError(response, requestId, appError("NOT_FOUND", `no endpoint at ${url.pathname}`, { path: url.pathname }));
        return;
      }
      const auth = options.auth.authenticate(presented);
      if (!auth.ok) {
        sendError(response, requestId, auth.error);
        return;
      }

      if (url.pathname === rotatePath) {
        if (method !== "POST") {
          sendError(
            response,
            requestId,
            appError("METHOD_NOT_ALLOWED", `${method} is not accepted by ${rotatePath}`, {
              path: rotatePath,
              allow: "POST",
            }),
          );
          return;
        }
        if (auth.context.kind !== "api-token") {
          sendError(
            response,
            requestId,
            appError("TOKEN_INVALID", "token rotation is a CLI operation and requires the Installation API token"),
          );
          return;
        }
        if (options.tokenRotate === undefined) {
          sendError(response, requestId, appError("NOT_FOUND", `no endpoint at ${rotatePath}`, { path: rotatePath }));
          return;
        }
        const rotated = options.tokenRotate();
        if (!rotated.ok) {
          sendError(response, requestId, rotated.error);
          return;
        }
        sendJson(response, 200, requestId, successEnvelope({ rotated: true }, requestId));
        return;
      }

      if (route !== undefined) {
        await route.handler(request, response, { requestId, auth: auth.context });
        return;
      }
      if (paths.has(url.pathname)) {
        const allowed = routes
          .filter((entry) => entry.path === url.pathname)
          .map((entry) => entry.method)
          .concat(url.pathname === sessionPath ? ["POST"] : []);
        sendError(
          response,
          requestId,
          appError("METHOD_NOT_ALLOWED", `${method} is not accepted by ${url.pathname}`, {
            path: url.pathname,
            allow: allowed.join(", "),
          }),
        );
        return;
      }
      sendError(response, requestId, appError("NOT_FOUND", `no endpoint at ${url.pathname}`, { path: url.pathname }));
    } catch (cause) {
      const error: AppError = isAppError(cause)
        ? cause
        : appError("INTERNAL_ERROR", "the daemon failed while handling the request", { cause: String(cause) });
      sendError(response, requestId, error);
    }
  };
}

function isAppError(value: unknown): value is AppError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

const idGenerator: IdGenerator = { next: () => randomUUID() };

/**
 * Creates the daemon `http.Server` bound to the configured loopback address. A
 * non-loopback bind address fails here at startup, before the socket exists (SEC-001).
 */
export function createDaemonServer(options: DaemonServerOptions): Server {
  if (!isLoopbackBindAddress(options.host)) {
    throw appError(
      "CONFIG_INVALID",
      `server.host must be the loopback literal 127.0.0.1 or ::1, never a name such as localhost; got ${JSON.stringify(options.host)}`,
      { field: "server.host", host: options.host },
    );
  }
  const handler = createDaemonRequestHandler(options);
  return createServer((request, response) => {
    void handler(request, response);
  });
}
