import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { type AppError, appError, err, ok, type Result } from "@sorage/core";

export interface SourceInspection {
  kind: "file";
  /** The realpath-resolved source; every later check runs against it (SEC-006). */
  resolvedPath: string;
}

/**
 * Inspects one candidate Artifact source (VLT-006, VLT-015, SEC-006, SEC-007):
 * the path is realpath-resolved so a symlink chain cannot smuggle a target past
 * validation, a symlink loop surfaces as an unresolvable path, and anything that
 * is not a regular file — a directory, a named pipe, a socket, or a device — is
 * rejected before any byte is read. The closed error catalogue of section 15
 * assigns no symbolic code to this rejection, so it surfaces as INTERNAL_ERROR
 * with an explicit message; that gap is recorded as a known catalogue seam.
 */
export function inspectSourceFile(sourcePath: string): Result<SourceInspection, AppError> {
  let resolved: string;
  try {
    resolved = realpathSync(sourcePath);
  } catch (error) {
    return err(rejected(sourcePath, "unresolvable path or symlink loop", error));
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch (error) {
    return err(rejected(sourcePath, "missing or unreadable path", error));
  }
  if (stats.isFile()) return ok({ kind: "file", resolvedPath: resolved });
  const kind = stats.isDirectory()
    ? "directory"
    : stats.isFIFO()
      ? "named pipe"
      : stats.isSocket()
        ? "socket"
        : stats.isCharacterDevice()
          ? "character device"
          : stats.isBlockDevice()
            ? "block device"
            : "special file";
  return err(rejected(sourcePath, kind));
}

function rejected(sourcePath: string, kind: string, cause?: unknown): AppError {
  return appError(
    "INTERNAL_ERROR",
    `The source ${sourcePath} is a ${kind} and cannot be imported as an Artifact (VLT-015, SEC-007).`,
    { sourcePath, kind },
    ...(cause === undefined ? [] : [cause]),
  );
}

const DIGEST_BUFFER_BYTES = 1024 * 1024;

/** Digests a file with a bounded read, shared by send, revise and non-executing recovery. */
export function digestFile(path: string): Result<string, AppError> {
  const inspected = inspectSourceFile(path);
  if (!inspected.ok) return err(inspected.error);
  try {
    const digest = createHash("sha256");
    const handle = openSync(inspected.value.resolvedPath, "r");
    try {
      const buffer = Buffer.alloc(DIGEST_BUFFER_BYTES);
      for (;;) {
        const read_ = readSync(handle, buffer, 0, DIGEST_BUFFER_BYTES, null);
        if (read_ === 0) break;
        digest.update(buffer.subarray(0, read_));
      }
    } finally {
      closeSync(handle);
    }
    return ok(digest.digest("hex"));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Digesting the source ${path} failed: ${String(error)}.`, { cause: String(error) }),
    );
  }
}
