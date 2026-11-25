import type { IncomingMessage, ServerResponse } from "node:http";
import { type AppError, appError, errorEnvelope, errorSpec, type Result, successEnvelope } from "@sorage/core";
import type { AuthenticatedContext } from "./auth";

/** The exact `Content-Security-Policy` every daemon response carries (SEC-018). */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The three security headers every daemon response, success and failure alike (SEC-018). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

export interface DaemonRequestContext {
  requestId: string;
  /** The authenticated bearer kind; present on every route that requires authentication. */
  auth?: AuthenticatedContext;
  /** Path parameters captured by the domain routing kit. */
  params?: Record<string, string>;
  /** The acting Project slug named by the request, mirroring the CLI's `--as`. */
  as?: string | undefined;
  /** True when the request asserts the local User, mirroring `--as-user`. */
  asUser?: boolean | undefined;
  /** The `Idempotency-Key` header of an idempotent route (API-012). */
  idempotencyKey?: string | undefined;
}

export function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) values.push(request.rawHeaders[i + 1] ?? "");
  return values;
}

export function sendJson(response: ServerResponse, status: number, requestId: string, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.statusCode = status;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Request-Id", requestId);
  response.end(`${payload}\n`);
}

export function sendError(response: ServerResponse, requestId: string, error: AppError): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const allow = error.details?.allow;
  const spec = errorSpec(error.code);
  if (typeof allow === "string") response.setHeader("Allow", allow);
  sendJson(response, spec.httpStatus, requestId, errorEnvelope(error, requestId));
}

export function sendRaw(
  response: ServerResponse,
  status: number,
  requestId: string,
  contentType: string,
  body: string,
): void {
  response.statusCode = status;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader("Content-Type", contentType);
  response.setHeader("X-Request-Id", requestId);
  response.end(body);
}

export const MAX_JSON_BODY_BYTES = 1_048_576;

export async function readJsonBody(
  request: IncomingMessage,
  limits: {
    maxBytes?: number;
    code?: Parameters<typeof appError>[0];
    message?: string;
    invalidMessage?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const maxBytes = limits.maxBytes ?? MAX_JSON_BODY_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw appError(limits.code ?? "CONFIG_INVALID", limits.message ?? "the request body is too large");
    }
    if (buffer.length > 0) chunks.push(buffer);
  }
  if (size === 0) return {};
  const invalidCode = limits.code ?? "CONFIG_INVALID";
  const invalidMessage = limits.invalidMessage ?? "the request body must be a valid JSON object";
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw appError(invalidCode, invalidMessage);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw appError(invalidCode, invalidMessage);
  }
  return parsed as Record<string, unknown>;
}

export function respond(
  response: ServerResponse,
  context: { requestId: string },
  result: Result<unknown, AppError>,
  successStatus = 200,
): void {
  if (!result.ok) {
    respondError(response, context, result.error);
    return;
  }
  sendJson(response, successStatus, context.requestId, successEnvelope(result.value, context.requestId));
}

export function respondError(response: ServerResponse, context: { requestId: string }, error: AppError): void {
  sendJson(response, errorSpec(error.code).httpStatus, context.requestId, errorEnvelope(error, context.requestId));
}
