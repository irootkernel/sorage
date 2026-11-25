import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  type ArtifactReadHandle,
  appError,
  getHandoff,
  listInbox,
  listOutbox,
  prepareHandoffFetch,
  readHandoffTimeline,
  readReviewNote,
} from "@sorage/core";
import { respond, respondError, SECURITY_HEADERS } from "../http-kit";
import type { RouteContext } from "./context";
import type { RouteEntryInternal } from "../route-kit";
import type { ServerResponse } from "node:http";

export function createHandoffReadRoutes(context: RouteContext): RouteEntryInternal[] {
  const {
    databaseOptions,
    withPorts,
    createNodeHandoffReadPorts,
    withHandoffRead,
    daemonCompletionWarning,
    actorInputOf,
    contextActor,
  } = context;
  const routes: RouteEntryInternal[] = [];
  const add = (entry: RouteEntryInternal) => routes.push(entry);

  // ---- Handoff reads -------------------------------------------------------
  add({
    method: "GET",
    pattern: "/api/v1/handoffs",
    handler: async (request, response, context) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const actor = actorInputOf(url.searchParams, {});
      if (!actor.ok) return void respond(response, context, actor);
      const query = {
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") ?? undefined } : {}),
        filters: {
          ...(url.searchParams.has("state") ? { state: url.searchParams.get("state") ?? undefined } : {}),
          ...(url.searchParams.has("sender") ? { senderSlug: url.searchParams.get("sender") ?? undefined } : {}),
          ...(url.searchParams.has("recipient")
            ? { recipientSlug: url.searchParams.get("recipient") ?? undefined }
            : {}),
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
      const result = withHandoffRead((ports) =>
        url.searchParams.get("box") === "outbox"
          ? listOutbox(ports, actor.value, query, false)
          : listInbox(ports, actor.value, query),
      );
      return void respond(response, context, result);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respond(response, context, actor);
      const result = withHandoffRead((ports) => getHandoff(ports, actor.value, context.params?.id ?? ""));
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
      const result = withHandoffRead((ports) => readReviewNote(ports, actor.value, context.params?.id ?? ""));
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
      const result = withHandoffRead((ports) => readHandoffTimeline(ports, actor.value, context.params?.id ?? ""));
      return void respond(response, context, result);
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/handoffs/{id}/artifact",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respond(response, context, actor);
      const result = withHandoffRead((ports) => getHandoff(ports, actor.value, context.params?.id ?? ""));
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
      createNodeVaultCommandPorts(databaseOptions).drainAtStart();
      const readPorts = createNodeHandoffReadPorts();
      let handle: ArtifactReadHandle | undefined;
      try {
        const prepared = prepareHandoffFetch(readPorts, actor.value, (context.params?.id ?? "") as string, {
          kind: "body",
        });
        if (!prepared.ok) return void respondError(response, context, prepared.error);
        if (prepared.value.kind !== "body") {
          prepared.value.close();
          return void respondError(
            response,
            context,
            appError("INTERNAL_ERROR", "the prepared fetch carried no opened body"),
          );
        }
        // The safely opened descriptor is the one authority for size and bytes:
        // no reconstructed vault path is statSynced or reopened after this guard
        // (VLT-020, section 11.3).
        handle = prepared.value.body;
        const size = handle.sizeBytes;
        // Both admitted content and 416 retain the representation headers.
        // Delay setting them on other paths so settlement errors remain JSON.
        const setContentHeaders = (): void => {
          const etag = `"${prepared.value.artifact.sha256}"`;
          for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
          response.setHeader("X-Request-Id", context.requestId);
          response.setHeader("ETag", etag);
          response.setHeader("Accept-Ranges", "bytes");
          // Section 11.2: .md and .txt serve as inline UTF-8 text for preview; every
          // other extension serves as an octet-stream attachment under its original name.
          const originalName = prepared.value.artifact.originalName;
          if (/\.(md|txt)$/i.test(originalName)) {
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
          } else {
            response.setHeader("Content-Type", "application/octet-stream");
            response.setHeader("Content-Disposition", `attachment; filename="${headerSafeFilename(originalName)}"`);
          }
        };
        const range = request.headers.range;
        const match = range !== undefined ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
        let start = 0;
        let end = size - 1;
        let admitted = false;
        if (match !== null && !(match[1] === "" && match[2] === "")) {
          let rangeStart: number;
          let rangeEnd: number;
          if (match[1] === "") {
            // A suffix range serves the final N bytes (section 18.4, RFC 9110); a
            // suffix covering the whole file serves it all, and bytes=-0 is
            // unsatisfiable, like any range on an empty file.
            const suffix = Number(match[2]);
            rangeStart = suffix <= 0 ? Number.NaN : Math.max(0, size - suffix);
            rangeEnd = size - 1;
          } else {
            rangeStart = Number(match[1]);
            rangeEnd = match[2] === "" ? size - 1 : Number(match[2]);
          }
          if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd) || rangeStart > rangeEnd || rangeEnd >= size) {
            // Range admission precedes settlement (HND-012): an unsatisfiable
            // range records no first fetch and closes the opened descriptor
            // before the early response.
            handle.close();
            setContentHeaders();
            response.statusCode = 416;
            response.setHeader("Content-Range", `bytes */${size}`);
            response.end();
            return;
          }
          start = rangeStart;
          end = rangeEnd;
          admitted = true;
        }
        // A response that already stopped is not an admitted fetch (HND-012):
        // it settles nothing, and the opened descriptor is simply released.
        if (response.destroyed || response.writableEnded) {
          handle.close();
          return;
        }
        // Preserve the historical first-fetch protection and fail-fast write
        // fences before streaming, independently of successful current reading.
        const settled = prepared.value.admitFirstFetch();
        if (!settled.ok) {
          handle.close();
          return void respondError(response, context, settled.error);
        }
        setContentHeaders();
        response.statusCode = admitted ? 206 : 200;
        if (admitted) response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        response.setHeader("Content-Length", String(end - start + 1));
        const streamed = await streamArtifactBody(handle, response, start, end);
        if (streamed.closeFailure !== null) {
          daemonCompletionWarning(`Artifact serving cleanup failed: ${String(streamed.closeFailure.error)}`);
        }
        if (streamed.delivered) {
          const read = prepared.value.settleFirstFetch();
          if (!read.ok)
            daemonCompletionWarning(
              `Artifact delivered; current-Revision reading settlement failed (${read.error.code}): ${read.error.message}`,
            );
        }
      } catch (error) {
        // Contain every close or streaming failure and terminate the exchange
        // visibly: while the response can still carry an error it answers with
        // one, otherwise the truncated connection is the failure.
        if (!response.headersSent && !response.writableEnded) {
          respondError(response, context, appError("INTERNAL_ERROR", `serving the Artifact failed: ${String(error)}`));
        } else if (!response.writableEnded) {
          response.destroy();
        } else {
          daemonCompletionWarning(`Artifact response completed; serving or read settlement failed: ${String(error)}`);
        }
      } finally {
        // Every exit disposes the acquired descriptor: the streaming helper
        // and the early admission paths may already have closed it — the
        // single-attempt ownership makes this idempotent — and a backstop
        // disposal failure must never reject the handler or touch a response
        // it no longer owns.
        try {
          handle?.close();
        } catch {
          // Ownership was consumed; a failed backstop close stays contained.
        }
        readPorts.close();
      }
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/handoffs/{id}/artifact/reveal",
    handler: async (_request, response, context) => {
      const actor = contextActor(context);
      if (!actor.ok) return void respondError(response, context, actor.error);
      // Reveal prepares the same authorized safe local path a fetch would, but
      // never settles a first fetch: only the CLI fetch command and an admitted
      // content response record one (HND-012, section 11.3).
      const prepared = withPorts(createNodeHandoffReadPorts(), (ports) =>
        prepareHandoffFetch(ports, actor.value, (context.params?.id ?? "") as string, { kind: "local-path" }),
      );
      if (!prepared.ok) return void respondError(response, context, prepared.error);
      if (prepared.value.kind !== "local-path") {
        prepared.value.close();
        return void respondError(
          response,
          context,
          appError("INTERNAL_ERROR", "the prepared fetch carried no local path"),
        );
      }
      return void respond(response, context, { ok: true, value: { localPath: prepared.value.localPath } });
    },
  });

  return routes;
}

/** The largest chunk one bounded serving read copies (NFR-005 bounded buffers). */
const ARTIFACT_SERVING_CHUNK_BYTES = 1024 * 1024;

/**
 * Streams one safely opened Artifact body to the response (section 18.4): the
 * loop reads bounded chunks from the SAME opened descriptor the route
 * validated, applies backpressure by waiting for drain, stops on client
 * close, error, or abort, and closes the descriptor exactly once on end,
 * failure, or cancellation. A read that returns no bytes before the admitted
 * end, or a response that stops early, terminates visibly — the truncated
 * connection is the failure — instead of spinning or silently claiming the
 * promised Content-Length. No whole body is buffered and no pathname is
 * reopened after the guard. A descriptor close failure is returned separately
 * after the response terminates, preserving the independently observed delivery
 * result. Delivery requires the response's finish event, not merely queued
 * writes or an end call; premature close/error does not establish delivery.
 */
export async function streamArtifactBody(
  handle: ArtifactReadHandle,
  response: ServerResponse,
  start: number,
  end: number,
): Promise<{ delivered: boolean; closeFailure: { error: unknown } | null }> {
  let position = start;
  let complete = false;
  const closeHandle = (): void => {
    handle.close();
  };
  // A response that fails or closes mid-stream must not crash the daemon on a
  // late write error; the loop notices the stopped response and terminates.
  let responseFailed = false;
  response.on("error", () => {
    responseFailed = true;
  });
  const waitDrain = (): Promise<"drain" | "stopped"> => {
    // A response that already stopped may never emit another close or drain,
    // so the wait answers immediately instead of retaining the handle on a
    // pending promise.
    if (response.destroyed || response.writableEnded) return Promise.resolve("stopped");
    return new Promise((resolve) => {
      const onDrain = (): void => {
        cleanup();
        resolve("drain");
      };
      const onClose = (): void => {
        cleanup();
        resolve("stopped");
      };
      const onError = (): void => {
        cleanup();
        resolve("stopped");
      };
      const cleanup = (): void => {
        response.removeListener("drain", onDrain);
        response.removeListener("close", onClose);
        response.removeListener("error", onError);
      };
      response.once("drain", onDrain);
      response.once("close", onClose);
      response.once("error", onError);
    });
  };
  let closeFailure: unknown;
  let closeFailureRecorded = false;
  let delivered = false;
  try {
    while (position <= end) {
      if (response.destroyed || response.writableEnded) break;
      const read = handle.read(position, Math.min(ARTIFACT_SERVING_CHUNK_BYTES, end - position + 1));
      if (!read.ok) break;
      // Zero bytes before the admitted end must terminate visibly, never loop.
      if (read.value.byteLength === 0) break;
      position += read.value.byteLength;
      const writable = response.write(read.value);
      if (!writable && position <= end) {
        if ((await waitDrain()) === "stopped") break;
      }
    }
    complete = position > end;
  } catch {
    // A synchronous write failure on a stopped response terminates the stream;
    // the finally block closes the descriptor and destroys the response.
  } finally {
    try {
      closeHandle();
    } catch (error) {
      closeFailure = error;
      closeFailureRecorded = true;
    }
    if (complete && !response.destroyed && !response.writableEnded && !responseFailed) {
      delivered = await new Promise<boolean>((resolve) => {
        const cleanup = () => {
          response.removeListener("finish", onFinish);
          response.removeListener("close", onClose);
          response.removeListener("error", onError);
        };
        const finish = (success: boolean) => {
          cleanup();
          resolve(success);
        };
        const onFinish = () => finish(!responseFailed);
        const onClose = () => finish(false);
        const onError = () => finish(false);
        response.once("finish", onFinish);
        response.once("close", onClose);
        response.once("error", onError);
        try {
          response.end();
        } catch {
          response.destroy();
          finish(false);
        }
      });
    } else if (!response.writableEnded) {
      // The admitted bytes were not fully served; destroy the response so the
      // client sees the truncation instead of a silent short body.
      response.destroy();
    }
  }
  // Cleanup cannot erase a proven finish or manufacture one after failure.
  // The caller reports the diagnostic without rewriting a completed response.
  return { delivered, closeFailure: closeFailureRecorded ? { error: closeFailure } : null };
}

/** Rejects a missing or non-numeric expectation honestly instead of letting NaN silently fail every comparison. */

/** Keeps an original name safe to quote inside a Content-Disposition filename. */
function headerSafeFilename(name: string): string {
  return name.replace(/[\\"\r\n]/g, "_");
}
