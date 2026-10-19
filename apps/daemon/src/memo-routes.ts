import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createNodeMemoPorts,
  sweepMemoAcceptedInputs,
  type NodeMemoPortsOptions,
} from "@sorage/adapters/src/memo-command-ports";
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
  type AcceptedMemoBody,
  type Result,
} from "@sorage/core";
import type { RouteEntryInternal } from "./route-kit";
import { SECURITY_HEADERS, type DaemonRequestContext } from "./server";
import { consumeMemoMultipart } from "./memo-multipart";

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
  // Startup maintenance belongs to the adapter composition, once per daemon's
  // route construction. Requests never create or clear another operation's spool.
  sweepMemoAcceptedInputs(options);
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
      const multipart =
        mutation &&
        String(request.headers["content-type"] ?? "")
          .toLowerCase()
          .startsWith("multipart/form-data");
      // The state-action routes stay JSON; only the create and update routes
      // add the multipart ingestion of interface section 38.2.
      if (multipart && operation !== "add" && operation !== "update") {
        respond(response, context, err(appError("MEMO_INVALID_INPUT", "Memo state actions take JSON only")));
        return;
      }
      // Mutations take only their documented JSON or multipart fields; query scope belongs to GET.
      if (mutation && new URL(request.url ?? "/", "http://localhost").search !== "") {
        respond(
          response,
          context,
          err(appError("MEMO_INVALID_INPUT", "Memo mutation inputs belong in the request body")),
        );
        return;
      }
      const ports = createNodeMemoPorts(options);
      let accepted: AcceptedMemoBody | undefined;
      try {
        let metaInput: Result<unknown>;
        if (multipart) {
          const ingested = await consumeMemoMultipart(request, {
            maxBytes: ports.maxBytes,
            stateDir: ports.stateDir,
            spoolId: randomUUID(),
          });
          if (!ingested.ok) {
            respond(response, context, ingested);
            return;
          }
          accepted = ingested.value.acceptedBody ?? undefined;
          metaInput = ok(ingested.value.meta);
          if (accepted === undefined && operation === "add") {
            // An absent body part on create is the existing empty body: carry
            // the JSON route's explicit empty-body field so the normalized
            // request identity matches across encodings. An absent body on
            // update stays a title-only change (section 38.2).
            metaInput = ok({ ...(ingested.value.meta as Record<string, unknown>), body: "" });
          }
        } else if (mutation) {
          const json = await readMemoBody(request);
          if (!json.ok) {
            respond(response, context, json);
            return;
          }
          metaInput = json;
        } else {
          metaInput = ok(undefined);
        }
        const body = mutation ? metaInput : queryInput(request, operation === "list");
        if (!body.ok) {
          respond(response, context, body);
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
        const id = context.params?.id ?? "";
        const result =
          operation === "add"
            ? addMemo(ports, body.value, policy.value, accepted)
            : operation === "list"
              ? listMemos(ports, body.value)
              : operation === "show"
                ? showMemo(ports, id, (body.value as { projectId?: string }).projectId)
                : mutateMemo(ports, operation, id, body.value, policy.value, accepted);
        respond(response, context, result);
      } finally {
        if (accepted !== undefined) ports.releaseAcceptedBody(accepted);
        ports.close();
      }
    },
  }));
}
