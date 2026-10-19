import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appError, type AppError } from "@sorage/core";
import type { IncomingMessage } from "node:http";

/**
 * The transport/domain-neutral multipart engine shared by the Handoff upload
 * (TASK-047/084) and the Memo multipart ingestion of interface section 38.2:
 * one framing-aware state machine over the raw request stream. A real part
 * boundary is the delimiter prefixed by CRLF (the preamble's first delimiter
 * excepted) and followed by a valid suffix — `--` for the closing delimiter or
 * CRLF for the next part — so a payload lookalike of the boundary is preserved
 * as content, an incomplete boundary or suffix split across arbitrary chunks
 * is awaited before anything is consumed, and the exact CRLF before a real
 * boundary is stripped while a lone CR or LF stays part bytes. Text parts are
 * buffered whole under their bound — enforced on both the progressive and the
 * found-boundary paths — headers are parsed under their bound the same way,
 * header parameters accept case, whitespace, and quoted or bare charset and
 * filename values, every streamed body byte is counted exactly once as
 * payload, and every delivered raw byte — preamble, payloads, framing, and
 * epilogue — is counted before any stage gating so no early success or
 * done-stage return bypasses the whole-request or aggregate framing bounds.
 * The policy decides every domain question; no Handoff or Memo domain rule
 * lives here and no raw-body replay cache is involved (ADR-0032 plan, W1
 * pins, corrections #1-#7).
 */

export interface MultipartPartHeader {
  name: string;
  filename: string | null;
  contentType: string | null;
  charset: string | null;
}

/** A push-based streaming sink the policy owns; the engine feeds verified part bytes. */
export interface MultipartPushSink {
  write(chunk: Buffer): void;
  /** The part completed at its boundary; the sink finalizes and returns its refusal, if any. */
  finish(totalBytes: number, sha256: string): AppError | null;
  /** Releases every partial resource; called on every failed or aborted exit. */
  abort(): void;
}

export type MultipartPartTarget =
  | { kind: "text" }
  | { kind: "engine-spool" }
  | { kind: "push-sink"; sink: MultipartPushSink }
  | { kind: "reject"; error: AppError };

export interface MultipartSpooledPart {
  header: MultipartPartHeader;
  path: string;
  bytes: number;
  sha256: string;
}

export interface MultipartTextPart {
  header: MultipartPartHeader;
  /** The part's exact bytes, boundary CRLF excluded; a byte-order mark stays content. */
  raw: Buffer;
  /** The legacy non-fatal decode the original upload used for text fields. */
  value: string;
}

export interface MultipartEnginePolicy<T> {
  /** The missing-boundary refusal, each surface's own code and wording. */
  boundaryError: AppError;
  /** The malformed-framing refusal (no closing boundary, truncated stream): a 4xx-invalid classification. */
  malformedError: AppError;
  /** The preamble bound — framing bytes before the first boundary — and its overflow refusal. */
  preambleBoundBytes: number;
  preambleTooLargeError: AppError;
  /** The per-text-part bound (the whole part stays buffered) and its overflow refusal. */
  textFieldBoundBytes: number;
  textFieldTooLargeError: AppError;
  /** The per-part-header bound and its overflow refusal. */
  headerBoundBytes: number;
  headerTooLargeError: AppError;
  /**
   * The whole raw request bound: every delivered byte — preamble, part
   * payloads, framing, and epilogue — is counted before any stage gating, and
   * a crossing fails mid-stream even after the terminator was seen. Undefined
   * keeps the legacy behavior of bounding only the streamed part bytes.
   */
  totalRawBoundBytes?: number;
  totalRawTooLargeError: (sizeBytes: number) => AppError;
  /**
   * The aggregate framing bound: the whole raw request minus every part's
   * payload bytes — preamble, delimiters, part headers, the closing boundary,
   * and the epilogue — checked while streaming (once the terminator is seen
   * the framing total can only grow) and again when the stream completes.
   * Undefined disables the aggregate check (the legacy upload behavior).
   */
  framingBoundBytes?: number;
  framingTooLargeError: (framingBytes: number) => AppError;
  /** The streamed-part byte bound and its overflow refusal. */
  partMaxBytes: number;
  partTooLargeError: (sizeBytes: number) => AppError;
  /** True to resolve at the closing boundary (the legacy upload behavior); false waits for end-of-stream so the epilogue is counted. */
  resolveAtTerminator: boolean;
  /** The directory the engine's own spool files live under. */
  spoolDir: string;
  decideHeader(header: MultipartPartHeader): MultipartPartTarget;
  /** A text part closed at its boundary; the policy validates the whole value. */
  onTextEnd(part: MultipartTextPart): AppError | null;
  /** An engine-spooled part closed at its boundary; the policy records or refuses it. */
  onSpoolEnd(part: MultipartSpooledPart): AppError | null;
  /** The closing validation after the terminator (and, without resolveAtTerminator, after end-of-stream). */
  onComplete(totalRawBytes: number, payloadBytes: number): { ok: true; value: T } | { ok: false; error: AppError };
  /** The policy's cleanup hook on every failed or aborted exit; engine spools are always removed by the engine itself. */
  onAbort(): void;
}

/** Parse parameters without treating semicolons inside quoted values as separators. */
function headerParameters(header: string): Map<string, string> | null {
  const parameters = new Map<string, string>();
  let cursor = header.indexOf(";");
  while (cursor !== -1 && cursor < header.length) {
    cursor++;
    while (/\s/.test(header[cursor] ?? "") && cursor < header.length) cursor++;
    const start = cursor;
    while (cursor < header.length && !/[;=\s]/.test(header[cursor] as string)) cursor++;
    const name = header.slice(start, cursor).toLowerCase();
    while (cursor < header.length && /\s/.test(header[cursor] as string)) cursor++;
    let value = "";
    if (header[cursor] === "=") {
      cursor++;
      while (cursor < header.length && /\s/.test(header[cursor] as string)) cursor++;
      const quote = header[cursor];
      if (quote === '"' || quote === "'") {
        cursor++;
        let closed = false;
        while (cursor < header.length) {
          const char = header[cursor++];
          if (char === quote) {
            closed = true;
            break;
          }
          if (char === "\\") {
            if (cursor === header.length) return null;
            value += header[cursor++];
          } else value += char;
        }
        if (!closed) return null;
        while (cursor < header.length && /\s/.test(header[cursor] as string)) cursor++;
      } else {
        const valueStart = cursor;
        while (cursor < header.length && header[cursor] !== ";") cursor++;
        value = header.slice(valueStart, cursor).trim();
      }
    }
    if (cursor < header.length && header[cursor] !== ";") return null;
    if (name !== "" && !parameters.has(name)) parameters.set(name, value);
    if (cursor === header.length) break;
  }
  return parameters;
}

export function streamMultipart<T>(
  request: IncomingMessage,
  policy: MultipartEnginePolicy<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: AppError }> {
  const contentType = String(request.headers["content-type"] ?? "");
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (boundary === undefined || boundary === "") {
    return Promise.resolve({ ok: false, error: policy.boundaryError });
  }
  const delimiter = Buffer.from(`--${boundary}`);
  mkdirSync(policy.spoolDir, { recursive: true });
  const spoolPath = `${policy.spoolDir}/${randomUUID()}`;

  return new Promise((resolve) => {
    let settled = false;
    let totalRawBytes = 0;
    let payloadBytes = 0;
    let buffer: Buffer = Buffer.alloc(0);
    let stage: "preamble" | "headers" | "body" | "done" = "preamble";
    let currentHeader: MultipartPartHeader = { name: "", filename: null, contentType: null, charset: null };
    let target: MultipartPartTarget = { kind: "text" };
    let spool: number | null = null;
    let hasher: ReturnType<typeof createHash> | null = null;
    let written = 0;
    let terminatorSeen = false;

    const settleWith = (outcome: { ok: true; value: T } | { ok: false; error: AppError }): void => {
      if (settled) return;
      settled = true;
      stage = "done";
      resolve(outcome);
    };

    /** Runs the policy's closing validation; a refusal cleans up exactly like a stream failure. */
    const complete = (): void => {
      if (settled) return;
      if (policy.framingBoundBytes !== undefined && totalRawBytes - payloadBytes > policy.framingBoundBytes) {
        fail(policy.framingTooLargeError(totalRawBytes - payloadBytes));
        return;
      }
      const outcome = policy.onComplete(totalRawBytes, payloadBytes);
      if (!outcome.ok) {
        policy.onAbort();
        releaseSpool();
        rmSync(spoolPath, { force: true });
        request.resume();
      }
      settleWith(outcome);
    };

    const fail = (error: AppError): void => {
      if (settled) return;
      policy.onAbort();
      releaseSpool();
      rmSync(spoolPath, { force: true });
      settleWith({ ok: false, error });
      request.resume();
    };

    const releaseSpool = (): void => {
      if (spool !== null) {
        try {
          closeSync(spool);
        } catch {
          // Best-effort; the file removal below is the durable cleanup.
        }
        spool = null;
      }
    };

    const atTerminator = (): void => {
      structuralFramingBytes += buffer.length;
      buffer = Buffer.alloc(0);
      if (!checkStreamBounds()) return;
      terminatorSeen = true;
      stage = "done";
      if (policy.resolveAtTerminator) {
        complete();
      }
    };

    /** Structural framing bytes consumed so far: preamble, delimiters, headers, closing suffix. */
    let structuralFramingBytes = 0;

    /** Mid-stream bounds shared by every counted byte; structural framing is enforced as it accumulates. */
    const checkStreamBounds = (): boolean => {
      if (policy.totalRawBoundBytes !== undefined && totalRawBytes > policy.totalRawBoundBytes) {
        fail(policy.totalRawTooLargeError(totalRawBytes));
        return false;
      }
      if (policy.framingBoundBytes !== undefined && structuralFramingBytes > policy.framingBoundBytes) {
        fail(policy.framingTooLargeError(structuralFramingBytes));
        return false;
      }
      return true;
    };

    /**
     * Finds the next real delimiter occurrence in the buffer starting at
     * `from`: in the body stage the match must be preceded by CRLF (the
     * preamble's first delimiter is exempt) and, at any stage, followed by a
     * valid two-byte suffix — `--` for the closing delimiter or CRLF for the
     * next part. An occurrence whose suffix bytes have not fully arrived is a
     * pending match the caller must wait for; an occurrence with an invalid
     * prefix or suffix is a payload lookalike the scan skips past.
     */
    const findDelimiter = (
      from: number,
    ): { status: "none" } | { status: "pending" } | { status: "match"; index: number; closing: boolean } => {
      for (
        let search = buffer.indexOf(delimiter, from);
        search !== -1;
        search = buffer.indexOf(delimiter, search + 1)
      ) {
        if (stage === "body") {
          if (search < 2 || buffer[search - 2] !== 0x0d || buffer[search - 1] !== 0x0a) continue;
        }
        const suffixStart = search + delimiter.length;
        if (buffer.length < suffixStart + 2) return { status: "pending" };
        const first = buffer[suffixStart];
        const second = buffer[suffixStart + 1];
        if (first === 0x2d && second === 0x2d) return { status: "match", index: search, closing: true };
        if (first === 0x0d && second === 0x0a) return { status: "match", index: search, closing: false };
        // Neither a closing nor a part suffix: a payload lookalike, never a boundary.
      }
      return { status: "none" };
    };

    request.on("data", (chunk: Buffer) => {
      // Drop every chunk immediately once settled: after a refusal the resumed
      // stream and after the Handoff terminator-resolution the epilogue must
      // never allocate or grow the parser buffer.
      if (settled) return;
      totalRawBytes += chunk.byteLength;
      if (!checkStreamBounds()) return;
      // After the terminator (Memo: awaiting end-of-stream), the epilogue is
      // pure framing: count it structurally without touching the parser buffer.
      if (terminatorSeen) {
        structuralFramingBytes += chunk.byteLength;
        if (policy.framingBoundBytes !== undefined && structuralFramingBytes > policy.framingBoundBytes) {
          fail(policy.framingTooLargeError(structuralFramingBytes));
          return;
        }
        if (policy.totalRawBoundBytes !== undefined && totalRawBytes > policy.totalRawBoundBytes) {
          fail(policy.totalRawTooLargeError(totalRawBytes));
        }
        return;
      }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (stage === "done" && terminatorSeen) return;
      for (;;) {
        if (stage === "preamble" || stage === "body") {
          const found = findDelimiter(0);
          if (found.status !== "match") {
            // No complete boundary in sight: a text part stays buffered whole
            // and a streaming part emits past a tail guard sized for a full
            // CRLF + delimiter + two-byte suffix, so a boundary split across
            // chunks is never falsely consumed or lost.
            const keep = delimiter.length + 4;
            if (stage === "preamble") {
              if (
                policy.framingBoundBytes !== undefined &&
                structuralFramingBytes + buffer.length > policy.framingBoundBytes
              ) {
                fail(policy.framingTooLargeError(structuralFramingBytes + buffer.length));
                return;
              }
              if (buffer.length - keep > policy.preambleBoundBytes) {
                fail(policy.preambleTooLargeError);
                return;
              }
              return;
            }
            if (target.kind === "text") {
              // Only the delimiter lookahead (CRLF + delimiter + two-byte
              // suffix) may exceed the text bound without refusal: the whole
              // buffered value minus that derived allowance is the text part's
              // own bytes so far, and a boundary-split trailing framing never
              // triggers a false overflow on a part at exactly its bound.
              const lookahead = delimiter.length + 4;
              const textBytes = Math.max(0, buffer.length - lookahead);
              if (textBytes > policy.textFieldBoundBytes) {
                fail(policy.textFieldTooLargeError);
                return;
              }
              return;
            }
            const emit = buffer.length > keep ? buffer.subarray(0, buffer.length - keep) : Buffer.alloc(0);
            if (emit.length > 0) {
              written += emit.length;
              payloadBytes += emit.length;
              if (written > policy.partMaxBytes) {
                fail(policy.partTooLargeError(written));
                return;
              }
              if (hasher !== null) hasher.update(emit);
              if (target.kind === "engine-spool" && spool !== null) writeSync(spool, emit);
              else if (target.kind === "push-sink") target.sink.write(emit);
              buffer = buffer.subarray(emit.length);
            }
            return;
          }
          const index = found.index;
          if (stage === "preamble" && index > policy.preambleBoundBytes) {
            fail(policy.preambleTooLargeError);
            return;
          }
          // The exact CRLF a real boundary requires is stripped; a lone CR or
          // LF inside the part never reaches this path.
          const bodyEnd = stage === "body" ? index - 2 : 0;
          const raw = Buffer.from(buffer.subarray(0, bodyEnd));
          payloadBytes += raw.length;
          if (stage === "body") {
            if (target.kind === "text") {
              // The found-boundary path enforces the text bound too: a single
              // large chunk whose boundary arrives with it is bounded here
              // before the policy ever sees the value (correction #4).
              if (raw.length > policy.textFieldBoundBytes) {
                fail(policy.textFieldTooLargeError);
                return;
              }
              const refusal = policy.onTextEnd({ header: currentHeader, raw, value: raw.toString("utf8") });
              if (refusal !== null) {
                fail(refusal);
                return;
              }
            } else {
              written += raw.length;
              if (written > policy.partMaxBytes) {
                fail(policy.partTooLargeError(written));
                return;
              }
              if (hasher !== null) hasher.update(raw);
              if (target.kind === "engine-spool" && spool !== null) {
                writeSync(spool, raw);
                closeSync(spool);
                spool = null;
              } else if (target.kind === "push-sink") {
                target.sink.write(raw);
              }
              const digest = hasher !== null ? hasher.digest("hex") : "";
              const refusal =
                target.kind === "engine-spool"
                  ? policy.onSpoolEnd({ header: currentHeader, path: spoolPath, bytes: written, sha256: digest })
                  : target.kind === "push-sink"
                    ? target.sink.finish(written, digest)
                    : null;
              if (refusal !== null) {
                fail(refusal);
                return;
              }
              written = 0;
              hasher = null;
            }
          } else {
            // The preamble's own bytes are structural framing, counted as consumed.
            structuralFramingBytes += index + delimiter.length + 2;
          }
          buffer = buffer.subarray(index + delimiter.length + 2);
          if (stage === "body") {
            structuralFramingBytes += delimiter.length + 4;
          }
          if (found.closing) {
            atTerminator();
            return;
          }
          stage = "headers";
          continue;
        }
        if (stage === "headers") {
          const terminator = buffer.indexOf("\r\n\r\n");
          if (terminator === -1) {
            if (buffer.length > policy.headerBoundBytes) {
              fail(policy.headerTooLargeError);
              return;
            }
            // Buffered partial header bytes are known framing: enforce the
            // aggregate bound immediately instead of waiting for \r\n\r\n.
            if (
              policy.framingBoundBytes !== undefined &&
              structuralFramingBytes + buffer.length > policy.framingBoundBytes
            ) {
              fail(policy.framingTooLargeError(structuralFramingBytes + buffer.length));
              return;
            }
            return;
          }
          // The found path enforces the header bound too (correction #5).
          if (terminator > policy.headerBoundBytes) {
            fail(policy.headerTooLargeError);
            return;
          }
          const headerBlock = buffer.subarray(0, terminator).toString("utf8");
          buffer = buffer.subarray(terminator + 4);
          // Headers are structural framing: the block plus its CRLFCRLF
          // terminator count as consumed framing immediately.
          structuralFramingBytes += terminator + 4;
          if (policy.framingBoundBytes !== undefined && structuralFramingBytes > policy.framingBoundBytes) {
            fail(policy.framingTooLargeError(structuralFramingBytes));
            return;
          }
          // Anchor parameter parsing to the actual header lines: a header line
          // starts at the block's beginning or after a CRLF. A
          // `Content-Disposition` inside an `X-Note:` value or after
          // `X-Content-Disposition:` never feeds the part's own parameters.
          const disposition = /(?:^|\r\n)content-disposition\s*:\s*([^\r\n]*)/i.exec(headerBlock)?.[1] ?? "";
          const contentTypeLine = /(?:^|\r\n)content-type\s*:\s*([^\r\n]*)/i.exec(headerBlock)?.[1] ?? "";
          const dispositionParameters = headerParameters(disposition);
          const typeParameters = headerParameters(contentTypeLine);
          if (dispositionParameters === null || typeParameters === null) {
            fail(policy.malformedError);
            return;
          }
          const type = contentTypeLine.split(";", 1)[0]?.trim().toLowerCase();
          currentHeader = {
            name: dispositionParameters.get("name") ?? "",
            filename: dispositionParameters.has("filename")
              ? (dispositionParameters.get("filename") as string)
              : (dispositionParameters.get("filename*") ?? null),
            contentType: type === undefined || type === "" ? null : type,
            charset: typeParameters.get("charset")?.toLowerCase() ?? null,
          };
          target = policy.decideHeader(currentHeader);
          if (target.kind === "reject") {
            fail(target.error);
            return;
          }
          if (target.kind === "engine-spool") {
            spool = openSync(spoolPath, "w");
          }
          // A fresh hasher per streamed part: exactly one streamed part exists
          // per policy in both surfaces, and a per-part hash never leaks state.
          if (target.kind === "engine-spool" || target.kind === "push-sink") {
            hasher = createHash("sha256");
          }
          written = 0;
          stage = "body";
          continue;
        }
        return;
      }
    });

    request.on("end", () => {
      if (settled) return;
      if (!terminatorSeen) {
        fail(policy.malformedError);
        return;
      }
      complete();
    });

    request.on("error", () => {
      if (!settled) {
        fail(appError("INTERNAL_ERROR", "the multipart request stream failed"));
      }
    });

    request.on("close", () => {
      if (!settled) {
        fail(policy.malformedError);
      }
    });
  });
}
