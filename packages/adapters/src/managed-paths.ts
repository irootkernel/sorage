import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** An unsafe managed path is distinct from missing content or an ordinary I/O failure. */
export class UnsafeManagedPathError extends Error {}

/** The selected user path may be an alias; all managed I/O uses its canonical directory. */
export function managedRoot(root: string, create = false): string {
  if (create) mkdirSync(root, { recursive: true });
  const canonical = realpathSync(root);
  if (!lstatSync(canonical).isDirectory()) throw new UnsafeManagedPathError("The selected root is not a directory");
  return canonical;
}

function segments(key: string): string[] {
  const parts = key.split("/");
  if (
    isAbsolute(key) ||
    key.includes("\\") ||
    key.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    throw new UnsafeManagedPathError("The managed path must be a nonempty relative key without traversal");
  return parts;
}

/**
 * Resolve from the canonical selected boundary, rejecting every managed parent link.
 * Missing parents may be created one checked level at a time. These checks do not
 * provide isolation against an adversarial process running as the same OS user.
 */
export function managedPath(root: string, key: string, createParents = false, mode = 0o755): string {
  const parts = segments(key);
  const canonical = managedRoot(root);
  const path = join(canonical, ...parts);
  const remainder = relative(canonical, path);
  if (remainder === "" || remainder === ".." || remainder.startsWith("../") || isAbsolute(remainder))
    throw new UnsafeManagedPathError("The managed path escapes its selected root");
  let directory = canonical;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    let stat = managedLstat(directory);
    if (stat === undefined && createParents) {
      try {
        mkdirSync(directory, { mode });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatSync(directory);
    }
    if (stat === undefined) return path;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new UnsafeManagedPathError("A managed parent is not a real directory");
  }
  return path;
}

/** Only ENOENT establishes absence; dangling links remain visible as links. */
export function managedLstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function managedDirectory(root: string, key: string, create = false, mode = 0o755): string | undefined {
  const path = managedPath(root, key, create, mode);
  let stat = managedLstat(path);
  if (stat === undefined && create) {
    try {
      mkdirSync(path, { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    stat = lstatSync(path);
  }
  if (stat === undefined) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new UnsafeManagedPathError("A managed directory is a link or special entry");
  return path;
}

export function managedFile(root: string, key: string): { path: string; stat: Stats | undefined } {
  const path = managedPath(root, key);
  const stat = managedLstat(path);
  if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink()))
    throw new UnsafeManagedPathError("A managed file is a link or special entry");
  return { path, stat };
}

/** Inspect the leaf and verify the opened regular-file identity before reading bytes. */
export function openManagedFile(root: string, key: string): number {
  const { path, stat } = managedFile(root, key);
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || (stat !== undefined && (opened.dev !== stat.dev || opened.ino !== stat.ino)))
      throw new UnsafeManagedPathError("The managed file changed identity while opening");
    return handle;
  } catch (error) {
    closeSync(handle);
    throw error;
  }
}

export function digestManagedFile(root: string, key: string): { sha256: string; sizeBytes: number } {
  const handle = openManagedFile(root, key);
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sizeBytes = 0;
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      sizeBytes += count;
    }
    return { sha256: digest.digest("hex"), sizeBytes };
  } finally {
    closeSync(handle);
  }
}
