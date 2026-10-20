import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { appError, err, ok, validateMemoBody, type AcceptedMemoBody, type AppError, type Result } from "@sorage/core";
import {
  closeDescriptor,
  ensureMemoInputDirectory,
  memoInputSpoolPath,
  openMemoInputSpool,
  releaseMemoInputSpool,
} from "./memo-input-spool";

/**
 * The once-only accepted-input capture for Memo bodies (SHR-002, SHR-012, the
 * ADR-0032 reviewed plan): one streaming validation pass enforces the current
 * `artifact.maxBytes` mid-stream, decodes fatally with a byte-order mark
 * preserved and NUL rejected, computes the size and SHA-256 in the same pass,
 * and materializes the text only while it stays at or below the 65,536-byte
 * inline threshold — anything larger spills into the operation's private spool
 * and never becomes a whole-body buffer. One algorithm owns that pass: the
 * push/finish/dispose capture primitive below, which the file reader, the
 * in-memory text capture, and the HTTP multipart ingestion all drive. The
 * returned accepted input is the only body every retry hashes and stages; the
 * mutable original path is never reread.
 */

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The surface error mapping one capture pass reports: the Memo codes are the
 * defaults every existing Memo and HTTP multipart caller keeps, and the
 * Channel surface passes its own codes for the same single algorithm — no
 * second ingest path exists (SHR-012, the TASK-109 reviewed plan).
 */
export interface AcceptedBodyCaptureCodes {
  invalidInput: "MEMO_INVALID_INPUT" | "CHN_INVALID_INPUT";
  tooLarge: "MEMO_TOO_LARGE" | "CHN_TOO_LARGE";
  fileReadFailed: "MEMO_FILE_READ_FAILED" | "CHN_INVALID_INPUT";
}

const MEMO_BODY_CAPTURE_CODES: AcceptedBodyCaptureCodes = {
  invalidInput: "MEMO_INVALID_INPUT",
  tooLarge: "MEMO_TOO_LARGE",
  fileReadFailed: "MEMO_FILE_READ_FAILED",
};

export interface MemoBodyCaptureOptions {
  maxBytes: number;
  stateDir: string;
  spoolId: string;
  /** The surface's error mapping; the Memo codes are the defaults. */
  codes?: AcceptedBodyCaptureCodes;
}

/**
 * The push-based accepted-body capture the transports feed (SHR-002, SHR-012,
 * the W1 pins): one streaming state — fatal UTF-8, NUL rejection, the current
 * `artifact.maxBytes` enforced mid-stream, size and SHA-256 in the same pass,
 * the 65,536-byte inline threshold spilling into the operation's owned
 * `memo-input` spool with fsync-before-close durability and independent
 * descriptor disposal on every failed or aborted exit.
 */
export interface AcceptedBodyCapture {
  /** Feeds one verified chunk; returns the refusal instead of throwing. */
  push(chunk: Buffer): { error: AppError } | null;
  /** Finalizes at the input's end: the accepted input, or the tail's refusal. */
  finish(): Result<AcceptedMemoBody>;
  /** Releases a partial spill on every failed or aborted exit. */
  abort(): void;
}

export function createAcceptedBodyCapture(options: MemoBodyCaptureOptions): AcceptedBodyCapture {
  const codes = options.codes ?? MEMO_BODY_CAPTURE_CODES;
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const textParts: string[] = [];
  const prefixChunks: Buffer[] = [];
  let spilled = false;
  let total = 0;
  let spool: number | undefined;
  let spoolPath: string | null = null;

  const writeAll = (chunk: Buffer): void => {
    let written = 0;
    while (written < chunk.byteLength) {
      written += writeSync(spool as number, chunk, written, chunk.byteLength - written, null);
    }
  };

  const release = (): void => {
    if (spool !== undefined) {
      try {
        closeSync(spool);
      } catch {
        // Independent disposal; the unlink below is the durable cleanup.
      }
      spool = undefined;
    }
    if (spoolPath !== null) releaseMemoInputSpool(spoolPath);
  };

  const spill = (): { error: AppError } | null => {
    spilled = true;
    textParts.length = 0;
    try {
      ensureMemoInputDirectory(options.stateDir);
      spoolPath = memoInputSpoolPath(options.stateDir, options.spoolId);
      spool = openMemoInputSpool(spoolPath);
      for (const prefix of prefixChunks) writeAll(prefix);
    } catch {
      release();
      return { error: appError("INTERNAL_ERROR", "The accepted Memo body spool could not be written") };
    }
    prefixChunks.length = 0;
    return null;
  };

  return {
    push(chunk) {
      if (chunk.includes(0)) {
        release();
        return {
          error: appError(
            codes.invalidInput,
            codes.invalidInput === "MEMO_INVALID_INPUT"
              ? "Memo body must be valid Unicode without NUL"
              : "Channel message body must be valid Unicode without NUL",
          ),
        };
      }
      let decoded: string;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        release();
        return {
          error: appError(
            codes.invalidInput,
            codes.invalidInput === "MEMO_INVALID_INPUT"
              ? "Memo body must contain valid UTF-8"
              : "Channel message body must contain valid UTF-8",
          ),
        };
      }
      total += chunk.byteLength;
      if (total > options.maxBytes) {
        release();
        return {
          error: appError(
            codes.tooLarge,
            codes.invalidInput === "MEMO_INVALID_INPUT"
              ? `The Memo body crossed the accepted bound artifact.maxBytes ${String(options.maxBytes)} bytes`
              : `The Channel body crossed the accepted bound artifact.maxBytes ${String(options.maxBytes)} bytes`,
            {
              maxBytes: options.maxBytes,
              sizeBytes: total,
            },
          ),
        };
      }
      hash.update(chunk);
      if (total > 65_536) {
        if (!spilled) {
          const refusal = spill();
          if (refusal !== null) return refusal;
        }
        try {
          writeAll(chunk);
        } catch {
          release();
          return { error: appError("INTERNAL_ERROR", "The accepted Memo body spool could not be written") };
        }
      } else {
        textParts.push(decoded);
        prefixChunks.push(Buffer.from(chunk));
      }
      return null;
    },
    finish() {
      let tail: string;
      try {
        tail = decoder.decode();
      } catch {
        release();
        return err(
          appError(
            codes.invalidInput,
            codes.invalidInput === "MEMO_INVALID_INPUT"
              ? "Memo body must contain valid UTF-8"
              : "Channel message body must contain valid UTF-8",
          ),
        );
      }
      if (!spilled) {
        return ok({
          kind: "text",
          text: textParts.join("") + tail,
          sizeBytes: total,
          sha256: hash.digest("hex"),
        });
      }
      try {
        if (tail !== "") writeAll(Buffer.from(tail, "utf8"));
        // The spool is the retries' accepted-input authority, so it carries the
        // authoritative Vault stage's durability order: fsync before close, and
        // a sync failure fails the capture honestly instead of claiming
        // durability the bytes do not have (SHR-005's discipline).
        fsyncSync(spool as number);
        closeSync(spool as number);
        spool = undefined;
      } catch {
        release();
        return err(appError("INTERNAL_ERROR", "The accepted Memo body spool could not be synced"));
      }
      return ok({ kind: "spool", spoolPath: spoolPath as string, sizeBytes: total, sha256: hash.digest("hex") });
    },
    abort() {
      release();
    },
  };
}

/** Captures the selected regular file as the operation's accepted input through the one capture primitive. */
export function captureMemoBodyFile(path: string, options: MemoBodyCaptureOptions): Result<AcceptedMemoBody> {
  const capture = createAcceptedBodyCapture(options);
  const codes = options.codes ?? MEMO_BODY_CAPTURE_CODES;
  const memoWording = codes.invalidInput === "MEMO_INVALID_INPUT";
  let source: number | undefined;
  try {
    const resolved = realpathSync(path);
    const before = statSync(resolved);
    if (!before.isFile()) {
      return err(
        appError(
          codes.invalidInput,
          memoWording
            ? "Memo body file must be a readable regular file"
            : "Channel body file must be a readable regular file",
        ),
      );
    }
    if (before.size > options.maxBytes) {
      return err(
        appError(
          codes.tooLarge,
          memoWording
            ? `The Memo body crossed the accepted bound artifact.maxBytes ${String(options.maxBytes)} bytes`
            : `The Channel body crossed the accepted bound artifact.maxBytes ${String(options.maxBytes)} bytes`,
          {
            maxBytes: options.maxBytes,
            sizeBytes: before.size,
          },
        ),
      );
    }
    source = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = fstatSync(source);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      return err(
        appError(
          codes.invalidInput,
          memoWording ? "Memo body file changed while opening" : "Channel body file changed while opening",
        ),
      );
    if (opened.size > options.maxBytes) {
      return err(
        appError(
          codes.tooLarge,
          memoWording
            ? `The Memo body crossed the accepted bound artifact.maxBytes ${String(options.maxBytes)} bytes`
            : `The Channel body crossed the accepted bound artifact.maxBytes ${String(options.maxBytes)} bytes`,
          {
            maxBytes: options.maxBytes,
            sizeBytes: opened.size,
          },
        ),
      );
    }
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = readSync(source, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      const refusal = capture.push(buffer.subarray(0, read));
      if (refusal !== null) return err(refusal.error);
    }
    return capture.finish();
  } catch {
    // Every thrown exit — source read, spool write, fsync, or close — releases
    // the partial spool so no orphan survives a failed capture.
    capture.abort();
    return err(
      appError(
        codes.fileReadFailed,
        memoWording
          ? "The selected Memo body file could not be read"
          : "The selected Channel body file could not be read",
      ),
    );
  } finally {
    closeDescriptor(source);
  }
}

/** Captures an already-in-memory body string, spilling it only when it exceeds the inline threshold. */
export function captureMemoBodyText(text: string, options: MemoBodyCaptureOptions): Result<AcceptedMemoBody> {
  const codes = options.codes ?? MEMO_BODY_CAPTURE_CODES;
  // Scalar and NUL validation precedes every encode or spool side effect: a
  // lone surrogate would silently encode as U+FFFD replacement bytes and a NUL
  // is forbidden content, so neither may reach an accepted input (SHR-003).
  // The Memo surface keeps its validating prelude; a Channel surface skips it
  // because the same single capture pass rejects NUL and invalid UTF-8 with
  // the Channel codes and the Channel blank rule runs later on the accepted
  // text, so no second ingest algorithm exists.
  if (codes.invalidInput === "MEMO_INVALID_INPUT") {
    const validated = validateMemoBody(text, options.maxBytes);
    if (!validated.ok) return validated;
  }
  const capture = createAcceptedBodyCapture(options);
  try {
    // Encode bounded UTF-16 slices; four bytes per code unit is a conservative
    // UTF-8 bound. Keep surrogate pairs together across slice boundaries.
    const sliceMax = Math.floor(READ_CHUNK_BYTES / 4);
    let index = 0;
    while (index < text.length) {
      let end = Math.min(index + sliceMax, text.length);
      if (end < text.length) {
        const lastUnit = text.charCodeAt(end - 1);
        if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
          const nextUnit = text.charCodeAt(end);
          if (nextUnit >= 0xdc00 && nextUnit <= 0xdfff) end -= 1;
        }
      }
      const chunk = Buffer.from(text.slice(index, end), "utf8");
      const refusal = capture.push(chunk);
      if (refusal !== null) return err(refusal.error);
      index = end;
    }
    return capture.finish();
  } catch {
    // Encoder and unexpected capture failures must release any partial spool.
    capture.abort();
    return err(appError("INTERNAL_ERROR", "The accepted Memo body could not be captured"));
  }
}

/** Reads one spool's bytes in bounded chunks for the request-hash composer and the Vault staging pass. */
export function streamMemoSpool(spoolPath: string, sink: (chunk: Uint8Array) => void): Result<void> {
  let handle: number | undefined;
  try {
    handle = openSync(spoolPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(handle);
    if (!stat.isFile()) return err(appError("INTERNAL_ERROR", "The accepted Memo body spool is not a regular file"));
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      sink(buffer.subarray(0, read));
    }
    return ok(undefined);
  } catch {
    return err(appError("INTERNAL_ERROR", "The accepted Memo body spool could not be read"));
  } finally {
    closeDescriptor(handle);
  }
}
