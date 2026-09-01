import { createHash, randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createNodeBackupCommandPorts } from "@sorage/adapters/src/backup-command-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDoctorPorts } from "@sorage/adapters/src/doctor";
import {
  createNodeHandoffReadPorts as createHandoffReadPorts,
  createNodeRetentionPorts as createRetentionPorts,
  createNodeReviewPorts as createReviewPorts,
  createNodeRevisionPorts as createRevisionPorts,
  createNodeSendPorts as createSendPorts,
  createNodeTerminalPorts as createTerminalPorts,
} from "@sorage/adapters/src/handoff-command-ports";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { createNodeProjectPorts as createProjectPorts } from "@sorage/adapters/src/project-command-ports";
import type { SorageSqlite } from "@sorage/adapters/src/sqlite/connection";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  type ActorRef,
  type AppError,
  acceptHandoff,
  addProject,
  appError,
  approveDeletion,
  archiveHandoff,
  archiveProject,
  backupStatus,
  backupVerify,
  bindProject,
  type Result as CoreResult,
  configureBackup,
  declineHandoff,
  getHandoff,
  listInbox,
  listOutbox,
  listProjects,
  moveVault,
  ok,
  pinHandoff,
  projectActor,
  type ReadActorInput,
  readHandoffTimeline,
  readReviewNote,
  rejectDeletion,
  removeReviewNote,
  renameProject,
  requestDeletion,
  resolveWorkspaceActor,
  reviseHandoff,
  runBackupCommand,
  runDoctor,
  sendHandoffs,
  setReviewNote,
  showProject,
  successEnvelope,
  USER_ACTOR,
  unarchiveHandoff,
  unarchiveProject,
  unbindProject,
  unpinHandoff,
  validateConfigurationFile,
  vaultStatus,
  vaultVerify,
  withdrawHandoff,
  withdrawReviewNote,
} from "@sorage/core";
import type { DaemonConfigService } from "./index";
import type { RouteEntryInternal } from "./route-kit";
import type { DaemonRequestContext } from "./server";
import { consumeMultipartUpload } from "./upload";

/**
 * The `/api/v1` domain surface of TASK-046 (API-002, API-004, API-005, API-007 to
 * API-012): every route calls exactly the core use case its CLI command calls, with
 * the acting context named explicitly - `as=<slug>` for a Project, `asUser=true` for
 * the User - because an HTTP request has no working directory to resolve. Path-based
 * imports are accepted only from the CLI token (API-004), the `Idempotency-Key`
 * replay is evaluated before any Row Version precondition (API-012), and Artifact
 * content answers `Range` with the recorded SHA-256 as its `ETag`.
 */

export interface DomainRouteDeps {
  /** The installation's Vault root, for serving Artifact content. */
  vaultPath(): string | null;
  /** The configuration service the daemon was started with. */
  config: DaemonConfigService | undefined;
  /** One daemon-lifetime connection; all request port factories share it. */
  database?: SorageSqlite | undefined;
}

export function createDomainRoutes(deps: DomainRouteDeps): RouteEntryInternal[] {
  const userHome = homedir();
  const configCommandPortsForValidation = createNodeConfigCommandPorts;
  const homeOf = () => createNodeHomePaths().home;
  const idempotency = new Map<string, { requestHash: string; status: number; body: unknown }>();
  const databaseOptions = deps.database === undefined ? {} : { database: deps.database };
  const createNodeProjectPorts = () => createProjectPorts(databaseOptions);
  const createNodeSendPorts = () => createSendPorts(databaseOptions);
  const createNodeHandoffReadPorts = () => createHandoffReadPorts(databaseOptions);
  const createNodeReviewPorts = () => createReviewPorts(databaseOptions);
  const createNodeRevisionPorts = () => createRevisionPorts(databaseOptions);
  const createNodeTerminalPorts = () => createTerminalPorts(databaseOptions);
  const createNodeRetentionPorts = () => createRetentionPorts(databaseOptions);

  const actorInputOf = (
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): CoreResult<ReadActorInput, AppError> => {
    const as = query.get("as") ?? (typeof body.as === "string" ? body.as : undefined);
    const asUser = query.get("asUser") === "true" || body.asUser === true;
    if (as === undefined && asUser !== true) {
      return {
        ok: false,
        error: appError(
          "FORBIDDEN_ACTOR",
          "an HTTP request has no working directory; name the acting context with as=<project-slug> or asUser=true",
        ),
      };
    }
    return { ok: true, value: { path: "", userHome, as, asUser } };
  };

  const routes: RouteEntryInternal[] = [];
  const add = (entry: RouteEntryInternal) => routes.push(entry);

  // ---- Projects ------------------------------------------------------------
  add({
    method: "GET",
    pattern: "/api/v1/projects",
    handler: async (request, response, context) => {
      const result = listProjects(createNodeProjectPorts());
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = addProject(createNodeProjectPorts(), {
        name: String(body.name ?? ""),
        ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
        dir: String(body.dir ?? ""),
        userHome,
        actor: actor.value,
      });
      return void respond(response, context, result, 201);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/projects/{id}",
    handler: async (_request, response, context) => {
      const result = showProject(createNodeProjectPorts(), (context.params?.id ?? "") as string);
      return void respond(response, context, result);
    },
  });
  add({
    method: "PATCH",
    pattern: "/api/v1/projects/{id}",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = renameProject(createNodeProjectPorts(), {
        slug: (context.params?.id ?? "") as string,
        name: String(body.name ?? body.displayName ?? ""),
        actor: actor.value,
      });
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/{id}/archive",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = archiveProject(createNodeProjectPorts(), {
        slug: (context.params?.id ?? "") as string,
        actor: actor.value,
      });
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/{id}/unarchive",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = unarchiveProject(createNodeProjectPorts(), {
        slug: (context.params?.id ?? "") as string,
        actor: actor.value,
      });
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/{id}/bindings",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = bindProject(createNodeProjectPorts(), {
        slug: (context.params?.id ?? "") as string,
        dir: String(body.dir ?? ""),
        userHome,
        actor: actor.value,
      });
      return void respond(response, context, result, 201);
    },
  });
  add({
    method: "DELETE",
    pattern: "/api/v1/projects/{id}/bindings/{bindingId}",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = await resolveActor(body);
      if (!actor.ok) return void respond(response, context, actor);
      const result = unbindProject(createNodeProjectPorts(), {
        slug: (context.params?.id ?? "") as string,
        dir: url.searchParams.get("dir") ?? String(body.dir ?? ""),
        userHome,
        confirm: url.searchParams.get("confirm") === "true" || body.confirm === true,
        actor: actor.value,
      });
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/projects/resolve",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = String(body.path ?? url.searchParams.get("path") ?? "");
      const as = typeof body.as === "string" ? body.as : (url.searchParams.get("as") ?? undefined);
      if (path === "" && as === undefined) {
        return void respondError(
          response,
          context,
          appError("FORBIDDEN_ACTOR", "resolve needs a path or an as=<project-slug>"),
        );
      }
      const resolved = resolveWorkspaceActor(createNodeProjectPorts(), {
        path,
        userHome,
        ...(as !== undefined ? { as } : {}),
      });
      return void respond(response, context, resolved);
    },
  });

  // ---- Handoff reads -------------------------------------------------------
  add({
    method: "GET",
    pattern: "/api/v1/handoffs",
    handler: async (request, response, context) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = actorInputOf(url.searchParams, {});
      if (!actor.ok) return void respond(response, context, actor);
      const readPorts = createNodeHandoffReadPorts();
      const query = {
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") ?? undefined } : {}),
        filters: {
          ...(url.searchParams.has("state") ? { state: url.searchParams.get("state") ?? undefined } : {}),
          ...(url.searchParams.has("sender") ? { sender: url.searchParams.get("sender") ?? undefined } : {}),
          ...(url.searchParams.has("recipient") ? { recipient: url.searchParams.get("recipient") ?? undefined } : {}),
          ...(url.searchParams.has("updatedSince")
            ? { updatedSince: url.searchParams.get("updatedSince") ?? undefined }
            : {}),
          ...(url.searchParams.has("updatedUntil")
            ? { updatedUntil: url.searchParams.get("updatedUntil") ?? undefined }
            : {}),
          includeArchived: url.searchParams.get("includeArchived") === "true",
          includeDeleted: url.searchParams.get("includeDeleted") === "true",
        },
      };
      const result =
        url.searchParams.get("box") === "outbox"
          ? listOutbox(readPorts, actor.value, query, false)
          : listInbox(readPorts, actor.value, query);
      return void respond(response, context, result);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respond(response, context, actor);
      const result = getHandoff(createNodeHandoffReadPorts(), actor.value, (context.params?.id ?? "") as string);
      return void respond(response, context, result);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}/review-note",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respond(response, context, actor);
      // Participant-gated like the detail itself; null means no current Note.
      const result = readReviewNote(createNodeHandoffReadPorts(), actor.value, (context.params?.id ?? "") as string);
      return void respond(response, context, result);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}/events",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respond(response, context, actor);
      // The bounded metadata timeline, never Artifact bytes; a tombstone keeps its
      // timeline, because the events of a deleted Handoff remain readable (LIFE-018).
      const result = readHandoffTimeline(
        createNodeHandoffReadPorts(),
        actor.value,
        (context.params?.id ?? "") as string,
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}/artifact",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respond(response, context, actor);
      const result = getHandoff(createNodeHandoffReadPorts(), actor.value, (context.params?.id ?? "") as string);
      if (!result.ok) return void respondError(response, context, result.error);
      return void respond(response, context, { ok: true, value: { artifact: result.value.currentArtifact ?? null } });
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}/artifact/content",
    handler: async (request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respondError(response, context, actor.error);
      // The daemon runs the RUN-002 drain obligation before serving bytes, so a
      // Handoff this daemon just created materializes instead of 409ing.
      createNodeVaultCommandPorts().drainAtStart();
      const { fetchHandoff } = await import("@sorage/core");
      const fetched = fetchHandoff(createNodeHandoffReadPorts(), actor.value, (context.params?.id ?? "") as string);
      if (!fetched.ok) return void respondError(response, context, fetched.error);
      const vault = deps.vaultPath();
      if (vault === null)
        return void respondError(response, context, appError("NOT_INITIALIZED", "Sorage has not been initialized."));
      const storageKey = fetched.value.artifact.storageKey;
      // The storage key is vault-relative and already carries its artifacts/ segment.
      const path = `${vault}/${storageKey}`;
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        return void respondError(
          response,
          context,
          appError("ARTIFACT_CORRUPTED", "the Artifact file is missing at its storage key"),
        );
      }
      const etag = `"${fetched.value.artifact.sha256}"`;
      for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
      response.setHeader("X-Request-Id", context.requestId);
      response.setHeader("ETag", etag);
      response.setHeader("Accept-Ranges", "bytes");
      // Section 11.2: .md and .txt serve as inline UTF-8 text for preview; every
      // other extension serves as an octet-stream attachment under its original name.
      const originalName = fetched.value.artifact.originalName;
      if (/\.(md|txt)$/i.test(originalName)) {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
      } else {
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Disposition", `attachment; filename="${headerSafeFilename(originalName)}"`);
      }
      const range = request.headers.range;
      const match = range !== undefined ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      if (match !== null && !(match[1] === "" && match[2] === "")) {
        let start: number;
        let end: number;
        if (match[1] === "") {
          // A suffix range serves the final N bytes (section 18.4, RFC 9110); a
          // suffix covering the whole file serves it all, and bytes=-0 is
          // unsatisfiable, like any range on an empty file.
          const suffix = Number(match[2]);
          start = suffix <= 0 ? Number.NaN : Math.max(0, size - suffix);
          end = size - 1;
        } else {
          start = Number(match[1]);
          end = match[2] === "" ? size - 1 : Number(match[2]);
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
          response.statusCode = 416;
          response.setHeader("Content-Range", `bytes */${size}`);
          response.end();
          return;
        }
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        response.setHeader("Content-Length", String(end - start + 1));
        createReadStream(path, { start, end }).pipe(response);
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Length", String(size));
      createReadStream(path).pipe(response);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/artifact/reveal",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const { fetchHandoff } = await import("@sorage/core");
      const fetched = fetchHandoff(createNodeHandoffReadPorts(), actor.value, (context.params?.id ?? "") as string);
      if (!fetched.ok) return void respondError(response, context, fetched.error);
      return void respond(response, context, { ok: true, value: { localPath: fetched.value.localPath } });
    },
  });

  // ---- Browser streaming upload (API-003, NFR-005) --------------------------
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/upload",
    idempotent: true,
    handler: async (request, response, context) => {
      const configPorts = createNodeConfigCommandPorts();
      const current = configPorts.store.read();
      if (!current.ok || current.value === null) {
        return void respondError(response, context, appError("NOT_INITIALIZED", "Sorage has not been initialized."));
      }
      const maxBytes = current.value.config.artifact.maxBytes;
      const upload = await consumeMultipartUpload(request, { maxBytes, spoolDir: join(homeOf(), "state", "uploads") });
      if (!upload.ok) return void respondError(response, context, upload.error);
      const file = upload.value.file;
      if (file === null)
        return void respondError(response, context, appError("CONFIG_INVALID", "the upload carried no file part"));
      const to = upload.value.fields.to ?? [];
      const title = (upload.value.fields.title ?? [file.filename])[0] ?? file.filename;
      const result = sendHandoffs(createNodeSendPorts(), {
        to,
        title,
        file: file.path,
        // The spool path is an opaque UUID, so the browser's filename is the
        // original name the Artifact must record (VLT-007).
        originalName: file.filename,
        allowExternalSource: true, // the browser upload is already the authenticated source
        allowUnregistered: false,
        ...(context.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
        path: "",
        userHome,
        asUser: true,
      });
      upload.value.cleanup();
      return void respond(response, context, result, 201);
    },
  });

  // ---- Handoff creation from a path (CLI token only, API-004) --------------
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/import-path",
    cliTokenOnly: true,
    idempotent: true,
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const to = Array.isArray(body.to) ? body.to.map(String) : typeof body.to === "string" ? [body.to] : [];
      const result = sendHandoffs(createNodeSendPorts(), {
        to,
        title: String(body.title ?? ""),
        ...(typeof body.path === "string" ? { file: body.path } : {}),
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(typeof body.supersedes === "string" ? { supersedes: body.supersedes } : {}),
        allowExternalSource: body.allowExternalSource === true,
        allowUnregistered: body.allowUnregistered === true,
        ...(typeof body.idempotencyKey === "string"
          ? { idempotencyKey: body.idempotencyKey }
          : context.idempotencyKey !== undefined
            ? { idempotencyKey: context.idempotencyKey }
            : {}),
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
      });
      return void respond(response, context, result, 201);
    },
  });

  // ---- Review, revision, terminal ------------------------------------------
  add({
    method: "PUT",
    pattern: "/api/v1/handoffs/{id}/review-note",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = setReviewNote(createNodeReviewPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        text: String(body.text ?? ""),
        ...(typeof body.targetRevision === "number" ? { targetRevision: body.targetRevision } : {}),
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      });
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
      const result = removeReviewNote(createNodeReviewPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        confirm: url.searchParams.get("confirm") === "true" || body.confirm === true,
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      });
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
      const result = withdrawReviewNote(createNodeReviewPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      });
      return void respond(response, context, result);
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/revise",
    idempotent: true,
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
          upload.value.cleanup();
          return void respondError(response, context, actor.error);
        }
        const rowVersionField = Number(fields.expectedRowVersion?.[0] ?? NaN);
        const result = reviseHandoff(createNodeRevisionPorts(), {
          ...actor.value,
          handoffId: (context.params?.id ?? "") as string,
          file: file.path,
          // The spool path is an opaque UUID, so the browser's filename is the
          // original name the replacement Artifact must record (VLT-007).
          originalName: file.filename,
          allowExternalSource: true, // the browser upload is already the authenticated source
          ...(fields.noChange?.[0] === "true" ? { noChange: true } : {}),
          ...(typeof fields.reason?.[0] === "string" ? { reason: fields.reason[0] } : {}),
          ...(context.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
          ...(Number.isFinite(rowVersionField) ? { expectedRowVersion: rowVersionField } : {}),
        });
        upload.value.cleanup();
        return void respond(response, context, result);
      }
      const body = await readJsonBody(request);
      const actor = actorInputOf(new URL(request.url ?? "/", "http://127.0.0.1").searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = reviseHandoff(createNodeRevisionPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        ...(typeof body.path === "string" ? { file: body.path, originalName: basename(body.path) } : {}),
        ...(body.noChange === true ? { noChange: true } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(typeof body.idempotencyKey === "string"
          ? { idempotencyKey: body.idempotencyKey }
          : context.idempotencyKey !== undefined
            ? { idempotencyKey: context.idempotencyKey }
            : {}),
        ...(body.allowExternalSource === true ? { allowExternalSource: true } : {}),
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      });
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
      const result = acceptHandoff(createNodeTerminalPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        expectedRevision: expectations.value.expectedRevision,
        expectedRowVersion: expectations.value.expectedRowVersion,
      });
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
      const result = declineHandoff(createNodeTerminalPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        reason: String(body.reason ?? ""),
        expectedRowVersion: expectations.value.expectedRowVersion,
      });
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
      const result = withdrawHandoff(createNodeTerminalPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      });
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
    idempotent: true,
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = actorInputOf(url.searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const result = approveDeletion(createNodeRetentionPorts(), {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        confirm: url.searchParams.get("confirm") === "true" || body.confirm === true,
        ...(typeof body.confirmPinned === "string" ? { confirmPinned: body.confirmPinned } : {}),
        ...(typeof body.idempotencyKey === "string"
          ? { idempotencyKey: body.idempotencyKey }
          : context.idempotencyKey !== undefined
            ? { idempotencyKey: context.idempotencyKey }
            : {}),
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      });
      return void respond(response, context, result);
    },
  });
  add({ method: "POST", pattern: "/api/v1/handoffs/{id}/deletion-reject", handler: retention("deletion-reject") });

  // ---- Vault and configuration validation (section 18.2) --------------------
  add({
    method: "POST",
    pattern: "/api/v1/config/validate",
    handler: async (_request, response, context) => {
      const result = validateConfigurationFile(configCommandPortsForValidation());
      return void respond(
        response,
        context,
        result.ok ? { ok: true, value: { valid: true, path: result.value.path } } : result,
      );
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/vault/status",
    handler: async (_request, response, context) => {
      const ports = createNodeVaultCommandPorts();
      const opened = ports.statusPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, vaultStatus(opened.value));
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/vault/verify",
    handler: async (_request, response, context) => {
      const ports = createNodeVaultCommandPorts();
      const opened = ports.verifyPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, vaultVerify(opened.value, { now: new Date() }));
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/vault/move",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      if (body.asUser !== true) {
        return void respondError(
          response,
          context,
          appError("USER_CONTEXT_REQUIRED", "vault move is a User-admin operation; pass asUser=true"),
        );
      }
      const ports = createNodeVaultCommandPorts({ targetPath: String(body.to ?? "") });
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.movePorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, moveVault(opened.value));
    },
  });

  // ---- Backup (section 18.7; restore is deliberately CLI-only) --------------
  add({
    method: "GET",
    pattern: "/api/v1/backup/status",
    handler: async (_request, response, context) => {
      const ports = createNodeBackupCommandPorts();
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.statusPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, backupStatus(opened.value));
    },
  });

  add({
    method: "POST",
    pattern: "/api/v1/backup/run",
    idempotent: true,
    handler: async (_request, response, context) => {
      const ports = createNodeBackupCommandPorts();
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.runPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      const result = runBackupCommand(opened.value, {
        ...(context.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
      });
      return void respond(response, context, result);
    },
  });

  add({
    method: "POST",
    pattern: "/api/v1/backup/verify",
    handler: async (_request, response, context) => {
      const ports = createNodeBackupCommandPorts();
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.verifyPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      const report = backupVerify(opened.value, { now: new Date() });
      if (!report.ok) return void respondError(response, context, report.error);
      return void respond(response, context, ok({ ...report.value, blocking: report.value.findings.length > 0 }));
    },
  });

  const backupConfigAction = (action: "enable" | "disable" | "enable-push" | "disable-push") =>
    add({
      method: "POST",
      pattern: `/api/v1/backup/${action}`,
      handler: async (request, response, context) => {
        const body = await readJsonBody(request);
        if (body.asUser !== true) {
          return void respondError(
            response,
            context,
            appError("USER_CONTEXT_REQUIRED", `backup ${action} is a User-admin operation; pass asUser=true`),
          );
        }
        const store = createNodeConfigCommandPorts().store;
        const result = configureBackup(
          {
            read: () => {
              const read = store.read();
              if (!read.ok) return read;
              if (read.value === null)
                return { ok: false as const, error: appError("NOT_INITIALIZED", "Sorage is not initialized.") };
              return { ok: true as const, value: { config: read.value.config, etag: read.value.etag } };
            },
            write: (next, expect) => {
              const written = store.write(next, { etag: expect.etag });
              if (!written.ok) return written;
              return { ok: true as const, value: { etag: written.value.etag } };
            },
          },
          {
            action,
            asUser: true,
            ...(action === "enable"
              ? {
                  dailyAt: typeof body.dailyAt === "string" ? body.dailyAt : undefined,
                  ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
                }
              : {}),
            ...(action === "enable-push"
              ? {
                  remote: typeof body.remote === "string" ? body.remote : undefined,
                  branch: typeof body.branch === "string" ? body.branch : undefined,
                }
              : {}),
          },
        );
        return void respond(response, context, result);
      },
    });
  backupConfigAction("enable");
  backupConfigAction("disable");
  backupConfigAction("enable-push");
  backupConfigAction("disable-push");

  // ---- Diagnostics ----------------------------------------------------------
  add({
    method: "GET",
    pattern: "/api/v1/diagnostics",
    handler: async (_request, response, context) => {
      const ports = createNodeDoctorPorts();
      const report = runDoctor(ports, "");
      return void respond(response, context, { ok: true, value: report });
    },
  });

  function retention(kind: "pin" | "unpin" | "archive" | "unarchive" | "deletion-request" | "deletion-reject") {
    return async (request: IncomingMessage, response: ServerResponse, context: DaemonRequestContext) => {
      const body = await readJsonBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = actorInputOf(url.searchParams, body);
      if (!actor.ok) return void respondError(response, context, actor.error);
      const ports = createNodeRetentionPorts();
      const base = {
        ...actor.value,
        handoffId: (context.params?.id ?? "") as string,
        ...(typeof body.expectedRowVersion === "number" ? { expectedRowVersion: body.expectedRowVersion } : {}),
      };
      const result =
        kind === "pin"
          ? pinHandoff(ports, base)
          : kind === "unpin"
            ? unpinHandoff(ports, base)
            : kind === "archive"
              ? archiveHandoff(ports, { ...base, asUser: true })
              : kind === "unarchive"
                ? unarchiveHandoff(ports, { ...base, asUser: true })
                : kind === "deletion-request"
                  ? requestDeletion(ports, base)
                  : rejectDeletion(ports, { ...base, asUser: true });
      return void respond(response, context, result);
    };
  }

  async function resolveActor(body: Record<string, unknown>): Promise<CoreResult<ActorRef, AppError>> {
    const ports = createNodeProjectPorts();
    if (body.asUser === true) return { ok: true, value: USER_ACTOR };
    if (typeof body.as === "string") {
      const found = ports.projects.findProjectBySlug(body.as);
      if (!found.ok) return found;
      if (found.value === null) {
        return {
          ok: false,
          error: appError("PROJECT_NOT_FOUND", `no Project matches the slug '${body.as}'`, { slug: body.as }),
        };
      }
      return { ok: true, value: projectActor(found.value.id) };
    }
    return {
      ok: false,
      error: appError(
        "FORBIDDEN_ACTOR",
        "an HTTP request has no working directory; name the acting context with as=<project-slug> or asUser=true",
      ),
    };
  }

  function contextActor(context: DaemonRequestContext): CoreResult<ReadActorInput, AppError> {
    if (context.as === undefined && context.asUser !== true) {
      return {
        ok: false,
        error: appError(
          "FORBIDDEN_ACTOR",
          "an HTTP request has no working directory; name the acting context with as=<project-slug> or asUser=true",
        ),
      };
    }
    return { ok: true, value: { path: "", userHome, as: context.as, asUser: context.asUser } };
  }

  return routes;
}

/** Rejects a missing or non-numeric expectation honestly instead of letting NaN silently fail every comparison. */
function numericExpectations<K extends string>(
  body: Record<string, unknown>,
  keys: K[],
): CoreResult<Record<K, number>, AppError> {
  const parsed = {} as Record<K, number>;
  for (const key of keys) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return {
        ok: false,
        error: appError("CONFIG_INVALID", `${key} must be supplied as a number`, { key }),
      };
    }
    parsed[key] = value;
  }
  return { ok: true, value: parsed };
}

/** Keeps an original name safe to quote inside a Content-Disposition filename. */
function headerSafeFilename(name: string): string {
  return name.replace(/[\\"\r\n]/g, "_");
}

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export { readJsonBody as readDomainJsonBody, respond, respondError, randomUUID as freshId };

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) throw appError("CONFIG_INVALID", "the request body is too large");
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

function respond(
  response: ServerResponse,
  context: { requestId: string },
  result: CoreResult<unknown, AppError>,
  successStatus = 200,
): void {
  if (!result.ok) {
    respondError(response, context, result.error);
    return;
  }
  const payload = JSON.stringify(successEnvelope(result.value, context.requestId), null, 2);
  response.statusCode = successStatus;
  for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Request-Id", context.requestId);
  response.end(`${payload}\n`);
}

function respondError(response: ServerResponse, context: { requestId: string }, error: AppError): void {
  // Imported lazily to avoid a cycle at module scope.
  const { errorEnvelope, errorSpec } = errorKit;
  const spec = errorSpec(error.code);
  const payload = JSON.stringify(errorEnvelope(error, context.requestId), null, 2);
  response.statusCode = spec.httpStatus;
  for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Request-Id", context.requestId);
  response.end(`${payload}\n`);
}

import * as errorKit from "@sorage/core";
