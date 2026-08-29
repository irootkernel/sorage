import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { appError } from "@sorage/core";
import type { AppError } from "@sorage/core";
import type { IncomingMessage } from "node:http";

/**
 * The browser streaming upload of TASK-047 (API-003, NFR-005): a multipart body is
 * consumed chunk by chunk straight into a bounded spool file under `state/uploads`,
 * never buffered whole in memory, and the stream aborts the moment it crosses
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
  /** Removes the spool file; safe to call after a failure. */
  cleanup(): void;
}

const BOUNDARY_PREFIX = "--";

/** Streams one multipart/form-data body, spooling the first file part to disk. */
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
  const hasher = createHash("sha256");

  return new Promise((resolve) => {
    const fail = (error: AppError) => {
      try {
        if (spool !== null) closeSync(spooloolSafe(spool));
        if (file !== null) rmSync(file.path, { force: true });
        rmSync(spoolPath, { force: true });
      } catch {
        // Best-effort cleanup; the periodic sweep is the backstop.
      }
      request.resume();
      resolve({ ok: false, error });
    };

    function spooloolSafe(fd: number): number {
      return fd;
    }

    // A tiny state machine over the raw byte stream: the buffer never holds more
    // than the current part's framing plus one incoming chunk.
    let buffer: Buffer = Buffer.alloc(0);
    let stage: "preamble" | "headers" | "body" | "done" = "preamble";
    let currentField = "";
    let currentFilename: string | null = null;
    // The spool is a plain descriptor opened eagerly: a lazily-opened stream
    // would recreate the file after an abort's unlink.
    let spool: number | null = null;
    let written = 0;

    const openSpool = () => {
      spool = openSync(spoolPath, "w");
    };

    request.on("data", (chunk: Buffer) => {
      if (stage === "done") return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "preamble" || stage === "body") {
          const index = buffer.indexOf(delimiter);
          if (index === -1) {
            // No delimiter in sight: everything before a tail guard is file data;
            // a text part stays buffered because its value is small by contract.
            if (stage === "body" && currentFilename !== null) {
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
            } else if (stage === "body" && buffer.length > 65_536) {
              fail(appError("CONFIG_INVALID", "a text form field exceeded its bound"));
              stage = "done";
            }
            return;
          }
          if (stage === "body") {
            const emit = buffer.subarray(0, Math.max(0, index - 2)); // strip the CRLF before the boundary
            if (currentFilename === null) {
              const value = emit.toString("utf8");
              if (currentField !== "") {
                fields[currentField] = fields[currentField] ?? [];
                (fields[currentField] as string[]).push(value);
              }
              buffer = buffer.subarray(index + delimiter.length);
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
            file = {
              field: currentField,
              filename: currentFilename ?? "upload",
              path: spoolPath,
              bytes: written,
              sha256: "",
            };
          }
          buffer = buffer.subarray(index + delimiter.length);
          stage = "headers";
          continue;
        }
        if (stage === "headers") {
          const terminator = buffer.indexOf("\r\n\r\n");
          if (terminator === -1) {
            if (buffer.length > 16_384) {
              fail(appError("CONFIG_INVALID", "the multipart part headers are too large"));
              stage = "done";
            }
            return;
          }
          const headerBlock = buffer.subarray(0, terminator).toString("utf8");
          buffer = buffer.subarray(terminator + 4);
          currentField = /name="([^"]*)"/.exec(headerBlock)?.[1] ?? "";
          currentFilename = /filename="([^"]*)"/.exec(headerBlock)?.[1] ?? null;
          if (buffer.subarray(0, 2).toString("latin1") === "--") {
            // The closing boundary: the form is complete.
            stage = "done";
            finish();
            return;
          }
          if (currentFilename !== null) {
            if (file !== null) {
              fail(appError("CONFIG_INVALID", "the upload carries more than one file part"));
              stage = "done";
              return;
            }
            written = 0;
            openSpool();
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
      if (file === null) {
        rmSync(spoolPath, { force: true });
        resolve({
          ok: false,
          error: appError("CONFIG_INVALID", "the upload carried no file part"),
        });
        return;
      }
      file.sha256 = hasher.digest("hex");
      const spooled = file as unknown as { path: string };
      try {
        statSync(spooled.path);
      } catch {
        resolve({ ok: false, error: appError("INTERNAL_ERROR", "the spooled upload vanished") });
        return;
      }
      settle();
      return;
    }

    function settle() {
      resolve({
        ok: true,
        value: {
          fields,
          file: file as UploadedPart,
          cleanup: () => {
            try {
              rmSync(spoolPath, { force: true });
              rmSync(dirname(spoolPath), { recursive: true, force: true });
            } catch {
              // Best effort.
            }
          },
        },
      });
    }
  });
}
