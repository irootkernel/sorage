import { basename, dirname, join } from "node:path";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import {
  acceptHandoff,
  appError,
  approveDeletion,
  archiveHandoff,
  declineHandoff,
  pinHandoff,
  readRecipientComment,
  setRecipientComment,
  startProcessing,
  completeProcessing,
  parseUniqueSnapshotJson,
  rejectDeletion,
  removeReviewNote,
  requestDeletion,
  reviseHandoff,
  sendHandoffs,
  setReviewNote,
  unarchiveHandoff,
  unpinHandoff,
  withdrawHandoff,
  withdrawReviewNote,
} from "@sorage/core";
import { readJsonBody, respond, respondError, MAX_JSON_BODY_BYTES, type DaemonRequestContext } from "../http-kit";
import { type RouteContext, numericExpectations } from "./context";
import type { RouteEntryInternal } from "../route-kit";
import { consumeMultipartUpload } from "../upload";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createHandoffMutationRoutes(context: RouteContext): RouteEntryInternal[] {
  const {
    userHome,
    homeOf,
    withPorts,
    createNodeSendPorts,
    withHandoffRead,
    createNodeReviewPorts,
    createNodeRevisionPorts,
    createNodeTerminalPorts,
    createNodeRetentionPorts,
    actorInputOf,
    contextActor,
  } = context;
  const routes: RouteEntryInternal[] = [];
  const add = (entry: RouteEntryInternal) => routes.push(entry);

  // ---- Browser streaming upload (API-003, NFR-005) --------------------------
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/upload",
    idempotencyScope: "send",
    handler: async (request, response, context) => {
      const configPorts = createNodeConfigCommandPorts();
      const current = configPorts.store.read();
      if (!current.ok || current.value === null) {
        return void respondError(response, context, appError("NOT_INITIALIZED", "Sorage has not been initialized."));
      }
      const maxBytes = current.value.config.artifact.maxBytes;
      const upload = await consumeMultipartUpload(request, { maxBytes, spoolDir: join(homeOf(), "state", "uploads") });
      if (!upload.ok) return void respondError(response, context, upload.error);
      try {
        const file = upload.value.file;
        const bodyPart = upload.value.body;
        if (file !== null && bodyPart !== null) {
          return void respondError(
            response,
            context,
            appError("CONFIG_INVALID", "the upload carries both a file part and a body field"),
          );
        }
        if (file === null && bodyPart === null) {
          return void respondError(
            response,
            context,
            appError("CONFIG_INVALID", "the upload must carry a file part or a body field"),
          );
        }
        const to = upload.value.fields.to ?? [];
        const title = (upload.value.fields.title ?? (file !== null ? [file.filename] : []))[0] ?? file?.filename ?? "";
        const result = withPorts(createNodeSendPorts(), (ports) =>
          sendHandoffs(ports, {
            to,
            title,
            ...(file !== null
              ? {
                  file: file.path,
                  // The spool path is an opaque UUID, so the browser's filename is the
                  // original name the Artifact must record (VLT-007), and the source is
                  // an authenticated upload rather than a workspace path import (API-003).
                  originalName: file.filename,
                  fileSourceKind: "authenticated-spool" as const,
                }
              : { bodyFile: bodyPart?.path }),
            allowExternalSource: true, // the browser upload is already the authenticated source
            allowUnregistered: false,
            ...(context.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
            path: "",
            userHome,
            asUser: true,
          }),
        );
        return void respond(response, context, result, 201);
      } finally {
        upload.value.cleanup();
      }
    },
  });

  // ---- Handoff creation from a path (CLI token only, API-004) --------------
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/import-path",
    cliTokenOnly: true,
    idempotencyScope: "send",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const idempotencyKey = readIdempotencyKey(body, context.idempotencyKey);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const to = Array.isArray(body.to) ? body.to.map(String) : typeof body.to === "string" ? [body.to] : [];
      const result = withPorts(createNodeSendPorts(), (ports) =>
        sendHandoffs(ports, {
          to,
          title: String(body.title ?? ""),
          ...(typeof body.path === "string"
            ? {
                file: body.path,
                // A path import records its own basename, so an original name's
                // presence alone never identifies an upload spool (VLT-007).
                originalName: basename(body.path),
              }
            : {}),
          ...(typeof body.body === "string" ? { body: body.body } : {}),
          ...(typeof body.supersedes === "string" ? { supersedes: body.supersedes } : {}),
          allowExternalSource: body.allowExternalSource === true,
          allowUnregistered: body.allowUnregistered === true,
          idempotencyKey,
          // The CLI's working directory travels with the request: the daemon has no
          // working directory of the caller's, and the sender workspace governs the
          // external-source policy of the import (VLT-016).
          path:
            typeof body.senderPath === "string"
              ? body.senderPath
              : typeof body.path === "string"
                ? dirname(body.path)
                : "",
          userHome,
          as: actor.value.as,
          asUser: actor.value.asUser,
        }),
      );
      return void respond(response, context, result, 201);
    },
  });

  // ---- Recipient reporting (interface section 40) ---------------------------
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}/comment",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respond(response, context, actor);
      return void respond(
        response,
        context,
        withHandoffRead((ports) => readRecipientComment(ports, actor.value, context.params?.id ?? "")),
      );
    },
  });
  for (const operation of ["comment", "start", "complete"] as const) {
    add({
      method: operation === "comment" ? "PUT" : "POST",
      pattern: `/api/v1/handoffs/{id}/${operation === "comment" ? "comment" : `processing/${operation}`}`,
      handler: async (request, response, context) => {
        const body = await readReportJsonBody(request, operation === "comment");
        const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
        if (!actor.ok) return void respond(response, context, actor);
        const input = {
          ...actor.value,
          handoffId: context.params?.id ?? "",
          expectedRevision: body.expectedRevision as number,
          expectedRowVersion: body.expectedRowVersion as number,
        };
        const result = withPorts(createNodeReviewPorts(), (ports) =>
          operation === "comment"
            ? setRecipientComment(ports, {
                ...input,
                text: body.text as string,
                ...(body.purpose !== undefined ? { purpose: body.purpose as "general" | "change_request" } : {}),
              })
            : (operation === "start" ? startProcessing : completeProcessing)(ports, {
                ...input,
                ...(body.comment !== undefined ? { comment: body.comment as string } : {}),
              }),
        );
        return void respond(response, context, result);
      },
    });
  }

  // ---- Review, revision, terminal ------------------------------------------
  add({
    method: "PUT",
    pattern: "/api/v1/handoffs/{id}/review-note",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = withPorts(createNodeReviewPorts(), (ports) =>
        setReviewNote(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          text: String(body.text ?? ""),
          ...(body.targetRevision !== undefined ? { targetRevision: body.targetRevision as number } : {}),
          ...(body.expectedRowVersion !== undefined ? { expectedRowVersion: body.expectedRowVersion as number } : {}),
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "DELETE",
    pattern: "/api/v1/handoffs/{id}/review-note",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = actorInputOf(url.searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = withPorts(createNodeReviewPorts(), (ports) =>
        removeReviewNote(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          confirm: url.searchParams.get("confirm") === "true" || body.confirm === true,
          ...(body.expectedRowVersion !== undefined ? { expectedRowVersion: body.expectedRowVersion as number } : {}),
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/review-note/withdraw",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = withPorts(createNodeReviewPorts(), (ports) =>
        withdrawReviewNote(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          ...(body.expectedRowVersion !== undefined ? { expectedRowVersion: body.expectedRowVersion as number } : {}),
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/revise",
    idempotencyScope: "revise",
    handler: async (request, response, context) => {
      // Section 18.5: revise accepts a streaming multipart upload for the browser
      // session, a JSON body naming a local path for the CLI context, and the
      // no-change JSON resolution - so the route must not be CLI-token-only.
      const contentType = String(request.headers["content-type"] ?? "");
      if (contentType.startsWith("multipart/form-data")) {
        const configPorts = createNodeConfigCommandPorts();
        const current = configPorts.store.read();
        if (!current.ok || current.value === null) {
          return void respondError(response, context, appError("NOT_INITIALIZED", "Sorage has not been initialized."));
        }
        const upload = await consumeMultipartUpload(request, {
          maxBytes: current.value.config.artifact.maxBytes,
          spoolDir: join(homeOf(), "state", "uploads"),
        });
        if (!upload.ok) return void respondError(response, context, upload.error);
        try {
          const file = upload.value.file;
          if (file === null) {
            return void respondError(
              response,
              context,
              appError("CONFIG_INVALID", "the revise upload carried no file part"),
            );
          }
          const fields = upload.value.fields;
          const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
          const asField = fields.as?.[0];
          const asUserField = fields.asUser?.[0] === "true";
          const actor = actorInputOf(query, {
            ...(typeof asField === "string" ? { as: asField } : {}),
            ...(asUserField ? { asUser: true } : {}),
          });
          if (!actor.ok) {
            return void respondError(response, context, actor.error);
          }
          const rowVersionField = fields.expectedRowVersion?.[0];
          const result = withPorts(createNodeRevisionPorts(), (ports) =>
            reviseHandoff(ports, {
              ...actor.value,
              handoffId: (context.params?.id ?? "") as string,
              file: file.path,
              // The spool path is an opaque UUID, so the browser's filename is the
              // original name the replacement Artifact must record (VLT-007).
              originalName: file.filename,
              fileSourceKind: "authenticated-spool",
              allowExternalSource: true, // the browser upload is already the authenticated source
              ...(fields.noChange?.[0] === "true" ? { noChange: true } : {}),
              ...(typeof fields.reason?.[0] === "string" ? { reason: fields.reason[0] } : {}),
              ...(context.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
              ...(rowVersionField !== undefined ? { expectedRowVersion: Number(rowVersionField) } : {}),
            }),
          );
          return void respond(response, context, result);
        } finally {
          upload.value.cleanup();
        }
      }
      const body = await readJsonBody(request);
      const idempotencyKey = readIdempotencyKey(body, context.idempotencyKey);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = withPorts(createNodeRevisionPorts(), (ports) =>
        reviseHandoff(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          ...(typeof body.path === "string" ? { file: body.path, originalName: basename(body.path) } : {}),
          ...(body.noChange === true ? { noChange: true } : {}),
          ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
          idempotencyKey,
          ...(body.allowExternalSource === true ? { allowExternalSource: true } : {}),
          ...(body.expectedRowVersion !== undefined ? { expectedRowVersion: body.expectedRowVersion as number } : {}),
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/accept",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      // HND-014 requires both expectations; a missing one is a malformed request,
      // not a stale one, so it answers CONFIG_INVALID instead of a bogus conflict.
      const expectations = numericExpectations(body, ["expectedRevision", "expectedRowVersion"]);
      if (!expectations.ok) return void respondError(response, context, expectations.error);
      const result = withPorts(createNodeTerminalPorts(), (ports) =>
        acceptHandoff(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          expectedRevision: expectations.value.expectedRevision,
          expectedRowVersion: expectations.value.expectedRowVersion,
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/decline",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const expectations = numericExpectations(body, ["expectedRowVersion"]);
      if (!expectations.ok) return void respondError(response, context, expectations.error);
      const result = withPorts(createNodeTerminalPorts(), (ports) =>
        declineHandoff(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          reason: String(body.reason ?? ""),
          expectedRowVersion: expectations.value.expectedRowVersion,
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/withdraw",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = withPorts(createNodeTerminalPorts(), (ports) =>
        withdrawHandoff(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
        }),
      );
      return void respond(response, context, result);
    },
  });

  // ---- Retention and deletion ----------------------------------------------
  add({ method: "POST", pattern: "/api/v1/handoffs/{id}/pin", handler: retention("pin") });
  add({ method: "POST", pattern: "/api/v1/handoffs/{id}/unpin", handler: retention("unpin") });
  add({ method: "POST", pattern: "/api/v1/handoffs/{id}/archive", handler: retention("archive") });
  add({ method: "POST", pattern: "/api/v1/handoffs/{id}/unarchive", handler: retention("unarchive") });
  add({ method: "POST", pattern: "/api/v1/handoffs/{id}/deletion-request", handler: retention("deletion-request") });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/deletion-approve",
    idempotencyScope: "deletion-approve",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const idempotencyKey = readIdempotencyKey(body, context.idempotencyKey);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = actorInputOf(url.searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = withPorts(createNodeRetentionPorts(), (ports) =>
        approveDeletion(ports, {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          confirm: url.searchParams.get("confirm") === "true" || body.confirm === true,
          ...(typeof body.confirmPinned === "string" ? { confirmPinned: body.confirmPinned } : {}),
          idempotencyKey,
          ...(body.expectedRowVersion !== undefined ? { expectedRowVersion: body.expectedRowVersion as number } : {}),
        }),
      );
      return void respond(response, context, result);
    },
  });
  add({ method: "POST", pattern: "/api/v1/handoffs/{id}/deletion-reject", handler: retention("deletion-reject") });

  function retention(kind: "pin" | "unpin" | "archive" | "unarchive" | "deletion-request" | "deletion-reject") {
    return async (request: IncomingMessage, response: ServerResponse, context: DaemonRequestContext) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = actorInputOf(url.searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const base = {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      };
      const result = withPorts(createNodeRetentionPorts(), (ports) =>
        kind === "pin"
          ? pinHandoff(ports, base)
          : kind === "unpin"
            ? unpinHandoff(ports, base)
            : kind === "archive"
              ? archiveHandoff(ports, base)
              : kind === "unarchive"
                ? unarchiveHandoff(ports, base)
                : kind === "deletion-request"
                  ? requestDeletion(ports, base)
                  : rejectDeletion(ports, {
                      ...base,
                      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
                    }),
      );
      return void respond(response, context, result);
    };
  }

  return routes;
}

/** The new reporting JSON contract: fatal decoding, unique/closed fields and no server-local file input. */
async function readReportJsonBody(request: IncomingMessage, commentSet: boolean): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_JSON_BODY_BYTES) throw appError("CONFIG_INVALID", "the request body is too large");
    chunks.push(chunk as Buffer);
  }
  const invalid = () =>
    appError(
      "HANDOFF_INVALID_INPUT",
      "report JSON must have unique known fields, valid types and observed positive safe integers",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw invalid();
  }
  const parsed = parseUniqueSnapshotJson(text);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value))
    throw invalid();
  const body = parsed.value as Record<string, unknown>;
  const allowed = new Set([
    "as",
    "asUser",
    "expectedRevision",
    "expectedRowVersion",
    ...(commentSet ? ["text", "purpose"] : ["comment"]),
  ]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw invalid();
  for (const key of ["expectedRevision", "expectedRowVersion"]) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid();
  }
  if (
    (body.as !== undefined && typeof body.as !== "string") ||
    (body.asUser !== undefined && typeof body.asUser !== "boolean")
  )
    throw invalid();
  if (commentSet) {
    if (
      typeof body.text !== "string" ||
      (body.purpose !== undefined && body.purpose !== "general" && body.purpose !== "change_request")
    )
      throw invalid();
  } else if (body.comment !== undefined && typeof body.comment !== "string") throw invalid();
  return body;
}

function readIdempotencyKey(body: Record<string, unknown>, headerKey: string | undefined): string | undefined {
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  if (headerKey !== undefined && bodyKey !== undefined && bodyKey.trim() !== headerKey) {
    throw appError("CONFIG_INVALID", "Idempotency-Key header and body must match");
  }
  return headerKey ?? bodyKey;
}
