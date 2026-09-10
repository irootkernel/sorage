import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appError } from "@sorage/core";
import type { AppError } from "@sorage/core";
import type { IncomingMessage } from "node:http";

/**
 * The browser streaming upload of TASK-047 and TASK-084 (API-003, API-013, NFR-005):
 * a multipart body is consumed chunk by chunk straight into a bounded spool file
 * under `state/uploads`, never buffered whole in memory. A file part and a `body`
 * field are mutually exclusive by presence. The stream aborts the moment it crosses
 * `artifact.maxBytes`, leaving no spool file behind.
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

const BOUNDARY_PREFIX = "--";
const TEXT_FIELD_BOUND_BYTES = 65_536;
const HEADER_BOUND_BYTES = 16_384;
const SCAN_BUFFER_BYTES = 64 * 1024;

/** Streams one multipart/form-data body, spooling a file part or a `body` field to disk. */
export function consumeMultipartUpload(
  request: IncomingMessage,
  options: { maxBytes: number; spoolDir: string },
): Promise<{ ok: true; value: MultipartUploadResult } | { ok: false; error: AppError }> {
  const contentType = String(request.headers["content-type"] ?? "");
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (boundary === undefined || boundary === "") {
    return Promise.resolve({
      ok: false,
      error: appError("CONFIG_INVALID", "the upload must be multipart/form-data with a boundary"),
    });
  }
  const delimiter = Buffer.from(`${BOUNDARY_PREFIX}${boundary}`);
  mkdirSync(options.spoolDir, { recursive: true });
  const spoolPath = `${options.spoolDir}/${randomUUID()}`;
  const fields: Record<string, string[]> = {};
  let file: UploadedPart | null = null;
  let body: UploadedPart | null = null;
  let bodyPresent = false;
  const hasher = createHash("sha256");

  return new Promise((resolve) => {
    const fail = (error: AppError) => {
      try {
        if (spool !== null) closeSync(spool);
        if (file !== null) rmSync(file.path, { force: true });
        if (body !== null) rmSync(body.path, { force: true });
        rmSync(spoolPath, { force: true });
      } catch {
        // Best-effort cleanup; the periodic sweep is the backstop.
      }
      request.resume();
      resolve({ ok: false, error });
    };

    // A tiny state machine over the raw byte stream: the buffer never holds more
    // than the current part's framing plus one incoming chunk.
    let buffer: Buffer = Buffer.alloc(0);
    let stage: "preamble" | "headers" | "body" | "done" = "preamble";
    let currentField = "";
    let currentFilename: string | null = null;
    let streamingKind: "file" | "body" | "field" = "field";
    // The spool is a plain descriptor opened eagerly: a lazily-opened stream
    // would recreate the file after an abort's unlink.
    let spool: number | null = null;
    let written = 0;

    const openSpool = () => {
      spool = openSync(spoolPath, "w");
    };

    const isStreaming = () => streamingKind === "file" || streamingKind === "body";

    request.on("data", (chunk: Buffer) => {
      if (stage === "done") return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "preamble" || stage === "body") {
          const index = buffer.indexOf(delimiter);
          if (index === -1) {
            // No delimiter in sight: everything before a tail guard is file or
            // body data; a text part stays buffered because its value is small.
            if (stage === "preamble" && buffer.length > TEXT_FIELD_BOUND_BYTES) {
              fail(appError("CONFIG_INVALID", "the multipart preamble exceeded its bound"));
              stage = "done";
              return;
            }
            if (stage === "body" && isStreaming()) {
              const keep = delimiter.length + 3;
              const emit = buffer.length > keep ? buffer.subarray(0, buffer.length - keep) : Buffer.alloc(0);
              if (emit.length > 0) {
                written += emit.length;
                if (written > options.maxBytes) {
                  fail(
                    appError(
                      "ARTIFACT_TOO_LARGE",
                      `the upload crossed artifact.maxBytes (${options.maxBytes} bytes) and was aborted mid-stream`,
                    ),
                  );
                  stage = "done";
                  return;
                }
                hasher.update(emit);
                if (spool !== null) writeSync(spool, emit);
                buffer = buffer.subarray(emit.length);
              }
            } else if (stage === "body" && buffer.length > TEXT_FIELD_BOUND_BYTES) {
              fail(appError("CONFIG_INVALID", "a text form field exceeded its bound"));
              stage = "done";
            }
            return;
          }
          if (stage === "body") {
            const emit = buffer.subarray(0, Math.max(0, index - 2)); // strip the CRLF before the boundary
            if (streamingKind === "field") {
              const value = emit.toString("utf8");
              if (currentField !== "") {
                fields[currentField] = fields[currentField] ?? [];
                (fields[currentField] as string[]).push(value);
              }
              buffer = buffer.subarray(index + delimiter.length);
              if (buffer.subarray(0, 2).toString("latin1") === "--") {
                stage = "done";
                finish();
                return;
              }
              stage = "headers";
              continue;
            }
            written += emit.length;
            if (written > options.maxBytes) {
              fail(
                appError(
                  "ARTIFACT_TOO_LARGE",
                  `the upload crossed artifact.maxBytes (${options.maxBytes} bytes) and was aborted mid-stream`,
                ),
              );
              stage = "done";
              return;
            }
            hasher.update(emit);
            if (spool !== null) {
              writeSync(spool, emit);
              closeSync(spool);
              spool = null;
            }
            const part: UploadedPart = {
              field: currentField,
              filename: currentFilename ?? (streamingKind === "body" ? "body.md" : "upload"),
              path: spoolPath,
              bytes: written,
              sha256: "",
            };
            if (streamingKind === "body") body = part;
            else file = part;
          }
          buffer = buffer.subarray(index + delimiter.length);
          // `--boundary--` is the terminator. Detect it here, not after headers,
          // so a body or file whose bytes start with `--` (YAML frontmatter) is kept.
          if (buffer.subarray(0, 2).toString("latin1") === "--") {
            stage = "done";
            finish();
            return;
          }
          stage = "headers";
          continue;
        }
        if (stage === "headers") {
          const terminator = buffer.indexOf("\r\n\r\n");
          if (terminator === -1) {
            if (buffer.length > HEADER_BOUND_BYTES) {
              fail(appError("CONFIG_INVALID", "the multipart part headers are too large"));
              stage = "done";
            }
            return;
          }
          const headerBlock = buffer.subarray(0, terminator).toString("utf8");
          buffer = buffer.subarray(terminator + 4);
          currentField = /name="([^"]*)"/.exec(headerBlock)?.[1] ?? "";
          currentFilename = /filename="([^"]*)"/.exec(headerBlock)?.[1] ?? null;
          if (currentField === "body") {
            if (bodyPresent || body !== null) {
              fail(appError("CONFIG_INVALID", "the upload carries more than one body field"));
              stage = "done";
              return;
            }
            if (file !== null) {
              fail(appError("CONFIG_INVALID", "the upload carries both a file part and a body field"));
              stage = "done";
              return;
            }
            bodyPresent = true;
            streamingKind = "body";
            written = 0;
            openSpool();
          } else if (currentFilename !== null) {
            if (file !== null) {
              fail(appError("CONFIG_INVALID", "the upload carries more than one file part"));
              stage = "done";
              return;
            }
            if (bodyPresent || body !== null) {
              fail(appError("CONFIG_INVALID", "the upload carries both a file part and a body field"));
              stage = "done";
              return;
            }
            streamingKind = "file";
            written = 0;
            openSpool();
          } else {
            streamingKind = "field";
          }
          stage = "body";
          continue;
        }
        return;
      }
    });

    request.on("end", () => {
      if (stage === "done") return;
      if (stage === "body") {
        fail(appError("CONFIG_INVALID", "the multipart body ended without a closing boundary"));
        return;
      }
      finish();
    });

    request.on("error", () => {
      if (stage !== "done") {
        fail(appError("INTERNAL_ERROR", "the upload stream failed"));
      }
    });

    function finish() {
      stage = "done";
      if (file !== null && bodyPresent) {
        fail(appError("CONFIG_INVALID", "the upload carries both a file part and a body field"));
        return;
      }
      if (bodyPresent) {
        if (body === null) {
          fail(appError("CONFIG_INVALID", "the body field is empty after trimming"));
          return;
        }
        const emptiness = utf8EmptyAfterTrim(body.path);
        if (!emptiness.ok) {
          fail(emptiness.error);
          return;
        }
        if (emptiness.empty) {
          fail(appError("CONFIG_INVALID", "the body field is empty after trimming"));
          return;
        }
        body.sha256 = hasher.digest("hex");
        try {
          statSync(body.path);
        } catch {
          resolve({ ok: false, error: appError("INTERNAL_ERROR", "the spooled upload vanished") });
          return;
        }
        settle();
        return;
      }
      if (file === null) {
        rmSync(spoolPath, { force: true });
        resolve({
          ok: false,
          error: appError("CONFIG_INVALID", "the upload carried no file part"),
        });
        return;
      }
      file.sha256 = hasher.digest("hex");
      try {
        statSync(file.path);
      } catch {
        resolve({ ok: false, error: appError("INTERNAL_ERROR", "the spooled upload vanished") });
        return;
      }
      settle();
    }

    function settle() {
      resolve({
        ok: true,
        value: {
          fields,
          file,
          body,
          cleanup: () => {
            // Only this upload's own spool file: the shared state/uploads directory
            // holds the spools of every concurrent upload and must survive (TASK-047).
            try {
              rmSync(spoolPath, { force: true });
            } catch {
              // Best effort.
            }
          },
        },
      });
    }
  });
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
