import type { IncomingMessage, ServerResponse } from "node:http";
import { createNodeMemoPorts, type NodeMemoPortsOptions } from "@sorage/adapters/src/memo-command-ports";
import {
  addMemo,
  appError,
  decodeMemoJson,
  err,
  errorEnvelope,
  errorSpec,
  listMemos,
  MEMO_REQUEST_BYTES,
  memoError,
  mutateMemo,
  ok,
  parseMemoExecution,
  showMemo,
  successEnvelope,
  type Result,
} from "@sorage/core";
import type { RouteEntryInternal } from "./route-kit";
import { SECURITY_HEADERS, type DaemonRequestContext } from "./server";

/** Collect bytes before one fatal decode. Overflow stops accumulation without destroying the response socket. */
function readMemoBody(request: IncomingMessage): Promise<Result<unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: Result<unknown>) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolve(result);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > MEMO_REQUEST_BYTES) finish(err(appError("MEMO_TOO_LARGE", "Memo request exceeds 512 KiB")));
      else chunks.push(chunk);
    });
    request.once("end", () => {
      if (!settled) finish(decodeMemoJson(Buffer.concat(chunks)));
    });
    const interrupted = () => finish(err(appError("MEMO_INVALID_INPUT", "Memo request body was interrupted")));
    request.once("aborted", interrupted);
    request.once("error", interrupted);
  });
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) values.push(request.rawHeaders[i + 1] ?? "");
  return values;
}

function queryInput(request: IncomingMessage, list: boolean): Result<Record<string, unknown>> {
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const allowed = list ? ["projectId", "allProjects", "state", "query", "limit", "cursor"] : ["projectId"];
  const input: Record<string, unknown> = {};
  for (const [name, value] of query) {
    if (!allowed.includes(name) || Object.hasOwn(input, name))
      return err(appError("MEMO_INVALID_INPUT", "Invalid or repeated Memo query field"));
    input[name] =
      name === "allProjects"
        ? value === "true"
          ? true
          : value
        : name === "limit"
          ? /^\d+$/.test(value)
            ? Number(value)
            : Number.NaN
          : value;
  }
  return ok(input);
}

function respond(response: ServerResponse, context: DaemonRequestContext, result: Result<unknown>): void {
  const error = result.ok ? null : memoError(result.error);
  response.statusCode = error ? errorSpec(error.code).httpStatus : 200;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Request-Id", context.requestId);
  response.end(
    `${JSON.stringify(error ? errorEnvelope(error, context.requestId) : successEnvelope(result.ok ? result.value : null, context.requestId), null, 2)}\n`,
  );
}

/** Memo deliberately never sets idempotent: the shared DB receipt is its sole replay authority. */
export function createMemoRoutes(options: NodeMemoPortsOptions = {}): RouteEntryInternal[] {
  const definitions = [
    ["GET", "/api/v1/memos", "list"],
    ["POST", "/api/v1/memos", "add"],
    ["GET", "/api/v1/memos/{id}", "show"],
    ["PATCH", "/api/v1/memos/{id}", "update"],
    ["POST", "/api/v1/memos/{id}/done", "done"],
    ["POST", "/api/v1/memos/{id}/dismiss", "dismiss"],
    ["POST", "/api/v1/memos/{id}/reopen", "reopen"],
  ] as const;
  return definitions.map(([method, pattern, operation]) => ({
    method,
    pattern,
    handler: async (request, response, context) => {
      const mutation = method !== "GET";
      const body = mutation ? await readMemoBody(request) : queryInput(request, operation === "list");
      if (!body.ok) {
        respond(response, context, body);
        return;
      }
      // Mutations take only their documented JSON fields; query scope belongs to GET.
      if (mutation && new URL(request.url ?? "/", "http://localhost").search !== "") {
        respond(response, context, err(appError("MEMO_INVALID_INPUT", "Memo mutation inputs belong in JSON")));
        return;
      }
      const keys = rawHeaderValues(request, "idempotency-key");
      const policy = parseMemoExecution(
        rawHeaderValues(request, "idempotency-mode"),
        keys.length > 1 ? keys : keys[0],
        mutation,
      );
      if (!policy.ok) {
        respond(response, context, policy);
        return;
      }
      const ports = createNodeMemoPorts(options);
      try {
        const id = context.params?.id ?? "";
        const result =
          operation === "add"
            ? addMemo(ports, body.value, policy.value)
            : operation === "list"
              ? listMemos(ports, body.value)
              : operation === "show"
                ? showMemo(ports, id, (body.value as { projectId?: string }).projectId)
                : mutateMemo(ports, operation, id, body.value, policy.value);
        respond(response, context, result);
      } finally {
        ports.close();
      }
    },
  }));
}
