import { realpathSync, statSync } from "node:fs";
import { appError, err, ok, type AppError, type Result } from "@sorage/core";

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
