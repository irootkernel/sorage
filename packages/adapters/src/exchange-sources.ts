import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type AppError, appError, exchangeInvalid, type ExchangeLocalScope, type ProjectBinding } from "@sorage/core";
import { managedRoot, openManagedFile, UnsafeManagedPathError } from "./managed-paths";
import { createNodeResolutionBindings } from "./project-command-ports";
import { carriedAppError } from "./storage-contention";

export interface BoundExchangeSource extends ExchangeLocalScope {
  root: string;
  relativePath: string;
  bindingId: string;
  /** Internal stat identity digest captured at versioned registration/revalidation; stripped from Format 5 snapshots. */
  observedVersion?: string;
}

function fail(error: AppError): never {
  throw carriedAppError(error);
}

function unsafe(): never {
  return fail({
    ...appError("SOURCE_OUTSIDE_WORKSPACE", "The registered source is outside the supplying Project's safe workspace."),
    recovery: { suggestedCommand: "Use a regular file inside the supplying Project's bound workspace" },
  });
}

function unavailable(reason: string): never {
  return fail(appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The Exchange source is unavailable.", { reason }));
}

export function exchangeWorkspaceRoot(binding: ProjectBinding, cwd: string): string {
  if (binding.bindingKind === "directory") return managedRoot(binding.directory);
  const root = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (root.status !== 0) return unavailable("binding");
  return managedRoot(root.stdout.trim());
}

export function resolveExchangeSource(
  binding: ProjectBinding,
  cwd: string,
  path: string,
  offset: number,
  length: number | null,
): BoundExchangeSource {
  const root = exchangeWorkspaceRoot(binding, cwd);
  const relativePath = relative(root, resolve(cwd, path));
  if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return unsafe();
  }
  return { root, relativePath, bindingId: binding.id, offset, length };
}

function statIdentity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Open only the binding authorized for the original. The callback receives the checked descriptor. */
export function withExchangeSource<T>(
  scope: BoundExchangeSource,
  binding: ProjectBinding,
  inspect: (source: { fd: number; size: number; observedVersion: string }) => T,
): T {
  if (scope.bindingId !== binding.id) return unavailable("binding");
  let fd: number;
  try {
    if (realpathSync(scope.root) !== scope.root) return unsafe();
    const boundRoot =
      binding.bindingKind === "directory"
        ? realpathSync(binding.directory)
        : createNodeResolutionBindings().gitCommonDirectory(scope.root);
    if (boundRoot !== binding.directory || (binding.bindingKind === "directory" && scope.root !== boundRoot)) {
      return unsafe();
    }
    fd = openManagedFile(scope.root, scope.relativePath);
  } catch (error) {
    if (error instanceof UnsafeManagedPathError || (error as NodeJS.ErrnoException).code === "ELOOP") return unsafe();
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return unavailable("missing");
    }
    if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") {
      return unavailable("permission");
    }
    throw error;
  }
  try {
    const observation = statIdentity(fd);
    const available = fstatSync(fd).size - scope.offset;
    if (available < 0 || (scope.length !== null && scope.length > available)) return unavailable("range");
    const result = inspect({
      fd,
      size: scope.length ?? available,
      observedVersion: createHash("sha256").update(observation).digest("hex"),
    });
    if (statIdentity(fd) !== observation) return unavailable("changed");
    return result;
  } finally {
    closeSync(fd);
  }
}

export function* exchangeSourceChunks(fd: number, offset: number, length: number): Iterable<Uint8Array> {
  let position = 0;
  while (position < length) {
    const buffer = Buffer.allocUnsafe(Math.min(65_536, length - position));
    const count = readSync(fd, buffer, 0, buffer.length, offset + position);
    if (count === 0) return unavailable("changed");
    position += count;
    yield buffer.subarray(0, count);
  }
}

export function digestExchangeSource(
  chunks: Iterable<Uint8Array>,
  maxBytes: number,
): {
  sizeBytes: number;
  sha256: string;
  text: boolean;
} {
  const digest = createHash("sha256");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let sizeBytes = 0;
  let text = true;
  for (const chunk of chunks) {
    if (chunk.byteLength > maxBytes - sizeBytes) {
      return fail(appError("ARTIFACT_TOO_LARGE", "The Exchange body crossed artifact.maxBytes.", { maxBytes }));
    }
    sizeBytes += chunk.byteLength;
    digest.update(chunk);
    if (text) {
      try {
        utf8.decode(chunk, { stream: true });
      } catch {
        text = false;
      }
    }
  }
  if (text) {
    try {
      utf8.decode();
    } catch {
      text = false;
    }
  }
  return { sizeBytes, sha256: digest.digest("hex"), text };
}

export function readExchangeOriginal(
  scope: BoundExchangeSource,
  binding: ProjectBinding,
  offset: number,
  limit: number,
  expectedSha256: string | null,
  expectedSize: number | null = null,
): { bytes: Buffer; size: number; observedVersion: string } {
  return withExchangeSource(scope, binding, ({ fd, size, observedVersion }) => {
    if (expectedSha256 === null) {
      if (offset > size) return fail(exchangeInvalid("The offset is past the original reference's range."));
      const length = Math.min(limit, size - offset);
      return {
        bytes: Buffer.concat([...exchangeSourceChunks(fd, scope.offset + offset, length)], length),
        size,
        observedVersion,
      };
    }
    if (expectedSize !== null && offset > expectedSize) {
      return fail(exchangeInvalid("The offset is past the original reference's range."));
    }
    if (expectedSize !== null && size !== expectedSize) {
      return unavailable("changed");
    }
    if (offset > size) return fail(exchangeInvalid("The offset is past the original reference's range."));
    const length = Math.min(limit, size - offset);
    if (offset > 0 && scope.observedVersion !== undefined && observedVersion === scope.observedVersion) {
      return {
        bytes: Buffer.concat([...exchangeSourceChunks(fd, scope.offset + offset, length)], length),
        size,
        observedVersion,
      };
    }
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(length);
    let position = 0;
    for (const chunk of exchangeSourceChunks(fd, scope.offset, size)) {
      hash.update(chunk);
      const first = Math.max(offset, position);
      const last = Math.min(offset + length, position + chunk.byteLength);
      if (last > first) bytes.set(chunk.subarray(first - position, last - position), first - offset);
      position += chunk.byteLength;
    }
    if (hash.digest("hex") !== expectedSha256) return unavailable("changed");
    return { bytes, size, observedVersion };
  });
}
