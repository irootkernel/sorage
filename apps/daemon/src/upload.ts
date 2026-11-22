import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { appError, type AppError } from "@sorage/core";
import type { IncomingMessage } from "node:http";
import {
  streamMultipart,
  type MultipartEnginePolicy,
  type MultipartPartHeader,
  type MultipartPushSink,
} from "./multipart-engine";

/**
 * The browser streaming upload of TASK-047 and TASK-084 (API-003, API-013,
 * NFR-005), a thin Handoff policy over the shared multipart engine using
 * `push-sink`: a file part and a `body` field are mutually exclusive by
 * presence, every streamed part is spooled under `state/uploads` with the
 * mid-stream `artifact.maxBytes` abort, and the closing validation keeps the
 * original empty-after-trim body check and error wording. The engine owns all
 * framing mechanics; this wrapper owns spool persistence, cleanup, Handoff
 * domain rules, and existing error categories.
 */

export interface UploadedPart {
  field: string;
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface MultipartUploadResult {
  fields: Record<string, string[]>;
  file: UploadedPart | null;
  /** Streamed `body` field, present only when the form carried that field. */
  body: UploadedPart | null;
  /** Removes the spool file; safe to call after a failure. */
  cleanup(): void;
}

const TEXT_FIELD_BOUND_BYTES = 65_536;
const HEADER_BOUND_BYTES = 16_384;
const SCAN_BUFFER_BYTES = 64 * 1024;

/** Streams one multipart/form-data body, spooling a file part or a `body` field to disk. */
export function consumeMultipartUpload(
  request: IncomingMessage,
  options: { maxBytes: number; spoolDir: string },
): Promise<{ ok: true; value: MultipartUploadResult } | { ok: false; error: AppError }> {
  const fields: Record<string, string[]> = {};
  let file: UploadedPart | null = null;
  let body: UploadedPart | null = null;
  let bodyPresent = false;
  let activeSink: MultipartPushSink | null = null;
  let cleaned = false;

  const tryCreateSpoolSink = (
    header: MultipartPartHeader,
  ): { ok: true; sink: MultipartPushSink } | { ok: false; error: AppError } => {
    let spoolPath: string;
    let fd: number | null;
    try {
      mkdirSync(options.spoolDir, { recursive: true });
      spoolPath = join(options.spoolDir, randomUUID());
      fd = openSync(spoolPath, "w");
    } catch (error) {
      return {
        ok: false,
        error: appError("INTERNAL_ERROR", "opening the uploaded spool failed", { cause: String(error) }),
      };
    }
    let sinkError: AppError | null = null;
    let removed = false;

    const closeFd = (): void => {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort close.
        }
        fd = null;
      }
    };

    const removeSpool = (): void => {
      if (removed) return;
      removed = true;
      try {
        rmSync(spoolPath, { force: true });
      } catch {
        // Best-effort cleanup of this upload's own spool file only.
      }
    };

    const sink: MultipartPushSink = {
      write(chunk: Buffer) {
        if (sinkError !== null || fd === null || chunk.length === 0) return;
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const writtenBytes = writeSync(fd, chunk, offset, chunk.length - offset);
            if (writtenBytes <= 0) throw new Error("short write to upload spool");
            offset += writtenBytes;
          }
        } catch (error) {
          closeFd();
          removeSpool();
          sinkError = appError("INTERNAL_ERROR", "writing the uploaded spool failed", { cause: String(error) });
        }
      },
      finish(totalBytes: number, sha256: string) {
        closeFd();
        if (activeSink === sink) activeSink = null;
        if (sinkError !== null) {
          removeSpool();
          return sinkError;
        }
        const uploaded: UploadedPart = {
          field: header.name,
          filename: header.filename ?? (header.name === "body" ? "body.md" : "upload"),
          path: spoolPath,
          bytes: totalBytes,
          sha256,
        };
        if (header.name === "body") body = uploaded;
        else file = uploaded;
        return null;
      },
      abort() {
        closeFd();
        removeSpool();
        if (activeSink === sink) activeSink = null;
      },
    };
    activeSink = sink;
    return { ok: true, sink };
  };

  const policy: MultipartEnginePolicy<MultipartUploadResult> = {
    boundaryError: appError("CONFIG_INVALID", "the upload must be multipart/form-data with a boundary"),
    malformedError: appError("CONFIG_INVALID", "the multipart body ended without a closing boundary"),
    preambleBoundBytes: TEXT_FIELD_BOUND_BYTES,
    preambleTooLargeError: appError("CONFIG_INVALID", "the multipart preamble exceeded its bound"),
    textFieldBoundBytes: TEXT_FIELD_BOUND_BYTES,
    textFieldTooLargeError: appError("CONFIG_INVALID", "a text form field exceeded its bound"),
    headerBoundBytes: HEADER_BOUND_BYTES,
    headerTooLargeError: appError("CONFIG_INVALID", "the multipart part headers are too large"),
    totalRawTooLargeError: () =>
      appError("ARTIFACT_TOO_LARGE", `the upload crossed artifact.maxBytes and was aborted mid-stream`),
    framingTooLargeError: (framingBytes: number) =>
      appError("CONFIG_INVALID", "the multipart framing exceeded its bound", { framingBytes }),
    partMaxBytes: options.maxBytes,
    partTooLargeError: (_sizeBytes: number) =>
      appError(
        "ARTIFACT_TOO_LARGE",
        `the upload crossed artifact.maxBytes (${String(options.maxBytes)} bytes) and was aborted mid-stream`,
      ),
    resolveAtTerminator: true,
    decideHeader(header: MultipartPartHeader) {
      if (header.name === "body") {
        if (bodyPresent || body !== null) {
          return { kind: "reject", error: appError("CONFIG_INVALID", "the upload carries more than one body field") };
        }
        if (file !== null) {
          return {
            kind: "reject",
            error: appError("CONFIG_INVALID", "the upload carries both a file part and a body field"),
          };
        }
        const created = tryCreateSpoolSink(header);
        if (!created.ok) return { kind: "reject", error: created.error };
        bodyPresent = true;
        return { kind: "push-sink", sink: created.sink };
      }
      if (header.filename !== null) {
        if (file !== null) {
          return { kind: "reject", error: appError("CONFIG_INVALID", "the upload carries more than one file part") };
        }
        if (bodyPresent || body !== null) {
          return {
            kind: "reject",
            error: appError("CONFIG_INVALID", "the upload carries both a file part and a body field"),
          };
        }
        const created = tryCreateSpoolSink(header);
        if (!created.ok) return { kind: "reject", error: created.error };
        return { kind: "push-sink", sink: created.sink };
      }
      return { kind: "text" };
    },
    onTextEnd(part) {
      if (part.header.name !== "") {
        fields[part.header.name] = fields[part.header.name] ?? [];
        (fields[part.header.name] as string[]).push(part.value);
      }
      return null;
    },
    onComplete(totalRawBytes: number, payloadBytes: number) {
      void totalRawBytes;
      void payloadBytes;
      if (file !== null && bodyPresent) {
        return { ok: false, error: appError("CONFIG_INVALID", "the upload carries both a file part and a body field") };
      }
      if (bodyPresent) {
        if (body === null) {
          return { ok: false, error: appError("CONFIG_INVALID", "the body field is empty after trimming") };
        }
        const emptiness = utf8EmptyAfterTrim((body as UploadedPart).path);
        if (!emptiness.ok) {
          return { ok: false, error: emptiness.error };
        }
        if (emptiness.empty) {
          return { ok: false, error: appError("CONFIG_INVALID", "the body field is empty after trimming") };
        }
        if (!spoolSurvives((body as UploadedPart).path)) {
          return { ok: false, error: appError("INTERNAL_ERROR", "the spooled upload vanished") };
        }
        return { ok: true, value: result() };
      }
      if (file === null) {
        return { ok: false, error: appError("CONFIG_INVALID", "the upload carried no file part") };
      }
      if (!spoolSurvives((file as UploadedPart).path)) {
        return { ok: false, error: appError("INTERNAL_ERROR", "the spooled upload vanished") };
      }
      return { ok: true, value: result() };
    },
    onAbort() {
      cleanup();
    },
  };

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    // Close and unlink any in-progress sink as well as finished spool files:
    // only this upload's own spool file is removed so sibling uploads in
    // state/uploads survive (TASK-047).
    if (activeSink !== null) {
      activeSink.abort();
      activeSink = null;
    }
    try {
      if (file !== null) rmSync(file.path, { force: true });
      if (body !== null) rmSync(body.path, { force: true });
    } catch {
      // Best effort.
    }
  }

  function spoolSurvives(path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  function result(): MultipartUploadResult {
    return {
      fields,
      file,
      body,
      cleanup,
    };
  }

  return streamMultipart(request, policy);
}

/** True when the UTF-8 file is empty after JavaScript `trim()`, scanned with a bounded buffer. */
export function utf8EmptyAfterTrim(path: string): { ok: true; empty: boolean } | { ok: false; error: AppError } {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(SCAN_BUFFER_BYTES);
      for (;;) {
        const read_ = readSync(handle, buffer, 0, SCAN_BUFFER_BYTES, null);
        if (read_ === 0) break;
        const text = decoder.decode(buffer.subarray(0, read_), { stream: true });
        for (const character of text) {
          if (character.trim() !== "") return { ok: true, empty: false };
        }
      }
      const flushed = decoder.decode();
      for (const character of flushed) {
        if (character.trim() !== "") return { ok: true, empty: false };
      }
      return { ok: true, empty: true };
    } finally {
      closeSync(handle);
    }
  } catch {
    return { ok: false, error: appError("CONFIG_INVALID", "the body field is not valid UTF-8 text") };
  }
}
