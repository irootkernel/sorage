import { join } from "node:path";
import { decodeStrictUtf8, type AcceptedMemoBody, type AppError, appError } from "@sorage/core";
import { createAcceptedBodyCapture, releaseAcceptedMemoBody } from "@sorage/adapters/src/memo-command-ports";
import type { IncomingMessage } from "node:http";
import {
  streamMultipart,
  type MultipartEnginePolicy,
  type MultipartPartHeader,
  type MultipartPushSink,
} from "./multipart-engine";

/**
 * The Memo multipart ingestion of interface section 38.2 over the shared
 * multipart engine: exactly one `meta` part whose bytes are the closed
 * existing operation object with the `body` field excluded, at most one `body`
 * part whose raw bytes are the complete body text, and nothing else. The
 * engine owns every framing mechanic; this policy owns the Memo rules — part
 * cardinalities, the filename-anywhere refusal, the meta/body content-type and
 * charset matrix, the meta JSON bound, fatal UTF-8, and the body's routing
 * through the adapter-owned accepted-body capture whose 65,536-byte threshold
 * keeps small bodies inline and spills larger ones into the operation's owned
 * spool. Bounds follow the contract exactly, each enforced before and during
 * collection with its contract error: the `meta` part at most 524,288 bytes,
 * the `body` part at most `artifact.maxBytes`, the aggregate multipart
 * framing and part headers at most 65,536 bytes — counted as every raw byte
 * minus part payload, covering the preamble, delimiters, headers, closing
 * boundary, and epilogue together — and the whole raw request at most
 * `artifact.maxBytes` plus 589,824 bytes, all four overflows
 * `MEMO_TOO_LARGE`/413; malformed framing, a missing boundary, unknown or
 * duplicated parts, a filename attribute, a forbidden `body` field in `meta`,
 * invalid UTF-8 or JSON, and an unsupported part content type or charset are
 * `MEMO_INVALID_INPUT`/422 (SHR-012, ADR-0032).
 */

export interface MemoMultipartRequest {
  /** The closed, validated operation object exactly as the JSON route would parse it. */
  meta: unknown;
  /** The captured accepted body: `null` when no `body` part was carried. */
  acceptedBody: AcceptedMemoBody | null;
  /** Frees the accepted body's owned spool; safe to call after a failure. */
  release(): void;
}

export function consumeMemoMultipart(
  request: IncomingMessage,
  options: { maxBytes: number; stateDir: string; spoolId: string },
): Promise<{ ok: true; value: MemoMultipartRequest } | { ok: false; error: AppError }> {
  const invalid = (message: string): AppError => appError("MEMO_INVALID_INPUT", message);
  const tooLarge = (message: string, sizeBytes: number): AppError =>
    appError("MEMO_TOO_LARGE", message, { maxBytes: options.maxBytes, sizeBytes });
  let meta: unknown = null;
  let metaSeen = false;
  let bodySeen = false;
  let capture: ReturnType<typeof createAcceptedBodyCapture> | null = null;
  let captureRefusal: AppError | null = null;
  let acceptedBody: AcceptedMemoBody | null = null;
  let released = false;

  const metaType = (header: MultipartPartHeader): AppError | null => {
    if (header.contentType === null) return null;
    if (header.contentType !== "application/json")
      return invalid("The meta part must carry application/json or no content type.");
    if (header.charset !== null && header.charset !== "utf-8") return invalid("The meta part must be UTF-8.");
    return null;
  };

  const bodyType = (header: MultipartPartHeader): AppError | null => {
    if (header.contentType === null) return null;
    if (header.contentType !== "text/plain") return invalid("The body part must carry text/plain or no content type.");
    if (header.charset !== null && header.charset !== "utf-8") return invalid("The body part must be UTF-8.");
    return null;
  };

  const policy: MultipartEnginePolicy<MemoMultipartRequest> = {
    boundaryError: invalid("A Memo multipart request must be multipart/form-data with a boundary."),
    malformedError: invalid("The Memo multipart request ended without its closing boundary."),
    preambleBoundBytes: 65_536,
    preambleTooLargeError: tooLarge("The Memo multipart framing exceeded 65,536 bytes.", 65_536),
    // The meta part may be 524,288 bytes; it is buffered whole.
    textFieldBoundBytes: 524_288,
    textFieldTooLargeError: tooLarge("The meta part exceeds 524,288 bytes.", 524_289),
    headerBoundBytes: 65_536,
    headerTooLargeError: tooLarge("The Memo multipart part headers exceeded 65,536 bytes.", 65_537),
    totalRawBoundBytes: options.maxBytes + 589_824,
    totalRawTooLargeError: (sizeBytes: number) =>
      tooLarge(`The raw Memo request exceeded artifact.maxBytes plus 589,824 bytes.`, sizeBytes),
    framingBoundBytes: 65_536,
    framingTooLargeError: (framingBytes: number) =>
      tooLarge("The Memo multipart framing and part headers exceeded 65,536 bytes.", framingBytes),
    partMaxBytes: options.maxBytes,
    partTooLargeError: (sizeBytes: number) =>
      tooLarge(`The Memo body part exceeded artifact.maxBytes ${String(options.maxBytes)} bytes.`, sizeBytes),
    resolveAtTerminator: false,
    spoolDir: join(options.stateDir, "uploads"),
    decideHeader(header) {
      // A filename attribute on any part — even an empty one — makes it a
      // file part, and the Memo surface carries no file part.
      if (header.filename !== null) {
        return { kind: "reject", error: invalid("A Memo multipart request carries no file parts.") };
      }
      if (header.name === "meta") {
        if (metaSeen) {
          return { kind: "reject", error: invalid("A Memo multipart request carries exactly one meta part.") };
        }
        const refusal = metaType(header);
        if (refusal !== null) return { kind: "reject", error: refusal };
        metaSeen = true;
        return { kind: "text" };
      }
      if (header.name === "body") {
        if (bodySeen) {
          return { kind: "reject", error: invalid("A Memo multipart request carries at most one body part.") };
        }
        const refusal = bodyType(header);
        if (refusal !== null) return { kind: "reject", error: refusal };
        bodySeen = true;
        capture = createAcceptedBodyCapture({
          maxBytes: options.maxBytes,
          stateDir: options.stateDir,
          spoolId: options.spoolId,
        });
        captureRefusal = null;
        return { kind: "push-sink", sink: captureSink };
      }
      return { kind: "reject", error: invalid("A Memo multipart request carries only meta and body parts.") };
    },
    onTextEnd(part) {
      // The meta bytes decode fatally — a BOM stays content, invalid bytes
      // never become U+FFFD — and the closed JSON object excludes body.
      const text = decodeStrictUtf8(part.raw);
      if (text === null) return invalid("The meta part must be valid UTF-8.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return invalid("The meta part must be valid JSON.");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return invalid("The meta part must be a JSON object.");
      }
      if (Object.hasOwn(parsed as Record<string, unknown>, "body")) {
        return invalid("The meta part excludes the body field; the body part carries the body.");
      }
      meta = parsed;
      return null;
    },
    onSpoolEnd() {
      return null;
    },
    onComplete() {
      if (captureRefusal !== null) {
        return { ok: false, error: captureRefusal };
      }
      if (!metaSeen) {
        return { ok: false, error: invalid("A Memo multipart request carries exactly one meta part.") };
      }
      return {
        ok: true,
        value: {
          meta,
          acceptedBody,
          release: () => {
            if (released) return;
            released = true;
            if (acceptedBody !== null) releaseAcceptedMemoBody(acceptedBody);
          },
        },
      };
    },
    onAbort() {
      if (capture !== null) capture.abort();
    },
  };

  const captureSink: MultipartPushSink = {
    write(chunk) {
      if (capture === null || captureRefusal !== null) return;
      const refusal = capture.push(chunk);
      if (refusal !== null) captureRefusal = refusal.error;
    },
    finish(_totalBytes: number, _sha256: string) {
      if (capture === null || captureRefusal !== null) return captureRefusal;
      const finished = capture.finish();
      if (!finished.ok) {
        captureRefusal = finished.error;
        return finished.error;
      }
      acceptedBody = finished.value;
      return null;
    },
    abort() {
      if (capture !== null) capture.abort();
    },
  };

  return streamMultipart(request, policy);
}
