import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { type AppError, appError, type ContentBodyHandle, err, ok, type Result } from "@sorage/core";
import { openManagedFile, UnsafeManagedPathError } from "./managed-paths";

/** One mebibyte: the fixed buffer that keeps every streaming copy memory bounded (NFR-005). */
export const STREAM_BUFFER_BYTES = 1024 * 1024;

/** Reads the exact expected size through one guarded regular-file descriptor. */
export function readFileBounded(root: string, key: string, expectedSize: number): Result<Buffer, AppError> {
  let handle: number | undefined;
  try {
    handle = openManagedFile(root, key);
    if (fstatSync(handle).size !== expectedSize)
      return err(
        appError("CONTENT_CORRUPTED", "The content file does not match its expected byte size.", { key, expectedSize }),
      );
    const bytes = Buffer.alloc(expectedSize);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(handle, bytes, length, Math.min(STREAM_BUFFER_BYTES, bytes.length - length), null);
      if (count === 0) break;
      length += count;
    }
    if (length !== expectedSize || readSync(handle, Buffer.allocUnsafe(1), 0, 1, null) !== 0)
      return err(appError("CONTENT_CORRUPTED", "The content file changed size while being read.", { key }));
    return ok(bytes);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return err(
      appError(
        error instanceof UnsafeManagedPathError || missing ? "CONTENT_CORRUPTED" : "INTERNAL_ERROR",
        "The managed content file is missing, unsafe, or unreadable.",
        { key, cause: String(error) },
      ),
    );
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export function unreadableSource(sourcePath: string, error: unknown): AppError {
  return appError("INTERNAL_ERROR", `The source ${sourcePath} could not be read: ${messageOf(error)}.`, {
    sourcePath,
    cause: String(error),
  });
}

/**
 * The bounded prepare pre-read of section 4: at most `limit` bytes of a source
 * file, with `complete` true only when the whole body fit inside the clamp, so
 * an inline decision never rests on partial bytes and a Vault routing never
 * buffers more than the routing threshold plus one byte in memory.
 */
export function preReadSource(
  sourcePath: string,
  limit: number,
): Result<{ bytes: Buffer; complete: boolean }, AppError> {
  let source: number | undefined;
  try {
    try {
      source = openSync(sourcePath, "r");
    } catch (error) {
      return err(unreadableSource(sourcePath, error));
    }
    const bytes = Buffer.allocUnsafe(limit);
    let length = 0;
    while (length < limit) {
      const count = readSync(source, bytes, length, limit - length, null);
      if (count === 0) return ok({ bytes: bytes.subarray(0, length), complete: true });
      length += count;
    }
    return ok({ bytes, complete: false });
  } catch (error) {
    return err(unreadableSource(sourcePath, error));
  } finally {
    if (source !== undefined) {
      try {
        closeSync(source);
      } catch {
        // Best effort on the abort path.
      }
    }
  }
}

/** One bounded streamed SHA-256 over an already-opened regular-file descriptor. */
export function digestOfFd(fd: number, sizeBytes: number): Result<string, AppError> {
  try {
    const onDiskBytes = fstatSync(fd).size;
    if (onDiskBytes !== sizeBytes) {
      return err(
        appError("CONTENT_CORRUPTED", "The content file does not match its recorded byte size.", {
          sizeBytes,
          onDiskBytes,
        }),
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
    let position = 0;
    while (position < sizeBytes) {
      const count = readSync(fd, buffer, 0, Math.min(STREAM_BUFFER_BYTES, sizeBytes - position), position);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (position !== sizeBytes) {
      return err(
        appError("CONTENT_CORRUPTED", "The content file is shorter than its recorded byte size.", { sizeBytes }),
      );
    }
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, sizeBytes) !== 0) {
      return err(
        appError("CONTENT_CORRUPTED", "The content file is longer than its recorded byte size.", { sizeBytes }),
      );
    }
    return ok(hash.digest("hex"));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Digesting the opened content failed: ${messageOf(error)}.`, { cause: String(error) }),
    );
  }
}

function invalidBoundedRead(): AppError {
  return appError("INTERNAL_ERROR", "A bounded body read needs a nonnegative position and a positive maxLength.");
}

/**
 * One best-effort close of a descriptor an error path already owns: a failing
 * OS close may still have closed the descriptor, and the swallowed disposal
 * failure never masks the typed body-integrity refusal that follows it.
 */
export function disposeOpenedDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort only: the typed refusal is the answer the caller receives.
  }
}

export interface BodyHandleMeta {
  recordId: string;
  sizeBytes: number;
  sha256: string;
}

/** The inline handle: exact verified bytes already in memory, bounded by the routing threshold. */
export function inlineBodyHandle(meta: BodyHandleMeta, bytes: Buffer): ContentBodyHandle {
  return {
    recordId: meta.recordId,
    representation: "inline",
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
    storageKey: null,
    read(position: number, maxLength: number): Result<Uint8Array, AppError> {
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(maxLength) || position < 0 || maxLength <= 0) {
        return err(invalidBoundedRead());
      }
      if (position >= bytes.byteLength) return ok(new Uint8Array(0));
      const length = Math.min(maxLength, bytes.byteLength - position);
      const out = new Uint8Array(length);
      out.set(bytes.subarray(position, position + length));
      return ok(out);
    },
    close(): void {
      // The inline buffer holds no opened resource.
    },
  };
}

/**
 * The file handle: one validated managed no-follow descriptor, the actually
 * opened file's true byte extent as its size authority, bounded positional
 * reads that never buffer the whole body, and explicit disposal.
 */
export function fileBodyHandle(meta: BodyHandleMeta & { storageKey: string }, fd: number): ContentBodyHandle {
  let open: number | null = fd;
  return {
    recordId: meta.recordId,
    representation: "file",
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
    storageKey: meta.storageKey,
    read(position: number, maxLength: number): Result<Uint8Array, AppError> {
      if (open === null) return err(appError("INTERNAL_ERROR", "The body handle is already closed."));
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(maxLength) || position < 0 || maxLength <= 0) {
        return err(invalidBoundedRead());
      }
      if (position >= meta.sizeBytes) return ok(new Uint8Array(0));
      const length = Math.min(maxLength, STREAM_BUFFER_BYTES, meta.sizeBytes - position);
      const out = Buffer.allocUnsafe(length);
      let done = 0;
      try {
        while (done < length) {
          const count = readSync(open, out, done, length - done, position + done);
          if (count <= 0) break;
          done += count;
        }
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the body at ${meta.storageKey} failed: ${messageOf(error)}.`, {
            storageKey: meta.storageKey,
            cause: String(error),
          }),
        );
      }
      if (done < length) {
        return err(
          appError("CONTENT_CORRUPTED", "The content file is shorter than its opened byte extent.", {
            storageKey: meta.storageKey,
          }),
        );
      }
      return ok(out);
    },
    close(): void {
      if (open !== null) {
        const closing = open;
        open = null;
        closeSync(closing);
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
