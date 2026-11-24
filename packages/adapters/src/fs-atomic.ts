import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_COPY_BUFFER_BYTES = 1024 * 1024;

export type TempNameStrategy = "uuid" | "pid";
export type DirFsyncMode = "required" | "best-effort" | "none";

export interface WriteFileAtomicOptions {
  /** Temporary sibling naming strategy: `uuid` (default) or `pid`. */
  tempName?: TempNameStrategy | undefined;
  /** Open temporary file exclusively with `O_EXCL` (default `true`). */
  exclusiveTemp?: boolean | undefined;
  /** Include `O_NOFOLLOW` when opening the temporary file (default `false`). */
  noFollow?: boolean | undefined;
  /** Mode passed to `openSync` when creating the temporary file. */
  createMode?: number | undefined;
  /** Mode enforced via `fchmodSync` on the open temporary descriptor before rename. */
  finalMode?: number | undefined;
  /** Whether to `fsyncSync` the file descriptor before closing (default `true`). */
  fileFsync?: boolean | undefined;
  /** Parent directory `fsync` policy after rename (default `"required"`). */
  dirFsync?: DirFsyncMode | undefined;
}

export interface CopyFileHashedOptions {
  /** Copy directly into an exclusive destination or stage in a temporary sibling and rename. */
  mode: "exclusive-direct" | "temp-rename";
  /** Temporary sibling naming strategy for `temp-rename` (default `"uuid"`). */
  tempName?: TempNameStrategy | undefined;
  /** Include `O_NOFOLLOW` when opening the output file (default `false`). */
  noFollow?: boolean | undefined;
  /** Mode passed to `openSync` when creating the output file. */
  createMode?: number | undefined;
  /** Mode enforced via `fchmodSync` on the output descriptor before closing. */
  finalMode?: number | undefined;
  /** Whether to `fsyncSync` the output file before closing (default `true`). */
  fileFsync?: boolean | undefined;
  /** Parent directory `fsync` policy (default `"required"` for `temp-rename`, `"none"` for `exclusive-direct`). */
  dirFsync?: DirFsyncMode | undefined;
  /** Streaming chunk size in bytes (default 1 MiB). */
  bufferBytes?: number | undefined;
}

export interface PlaceExclusiveOptions {
  /** Creation mode passed to `openSync` (default `0o644`). */
  createMode?: number | undefined;
  /** Final mode applied via `fchmodSync` before `fsyncSync` (e.g. `0o444`). */
  finalMode?: number | undefined;
  /** Include `O_NOFOLLOW` when opening the target (default `true`). */
  noFollow?: boolean | undefined;
  /** Whether to `fsyncSync` the placed file before closing (default `true`). */
  fileFsync?: boolean | undefined;
  /** Parent directory `fsync` policy when `syncAncestorsTo` is omitted (default `"required"`). */
  dirFsync?: DirFsyncMode | undefined;
  /** When set, `fsync` every ancestor directory from `dirname(path)` up to and including `syncAncestorsTo`. */
  syncAncestorsTo?: string | undefined;
  /** Read back the placed file and assert exact byte length and SHA-256 before returning (default `false`). */
  verifyReadback?: boolean | undefined;
  /** Optional custom readback identity reader; defaults to guarded no-follow descriptor readback. */
  readback?: ((path: string) => { sizeBytes: number; sha256: string }) | undefined;
  /** Optional directory fsync hook; defaults to `fsyncDirectory`. */
  syncDirectory?: ((dirPath: string) => void) | undefined;
  /** Remove only the file created by this call on error; never unlinks pre-existing files on `EEXIST` (default `true`). */
  cleanupOwnedOnError?: boolean | undefined;
}

/** Durability order helper: fsync the parent directory after a rename or unlink (VLT-022). */
export function fsyncDirectory(path: string): void {
  const handle = openSync(path, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function toBuffer(bytes: string | Uint8Array): Buffer {
  if (typeof bytes === "string") return Buffer.from(bytes, "utf8");
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function writeAll(handle: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(handle, buffer, offset, buffer.byteLength - offset);
    if (written <= 0) {
      throw new Error(`Atomic write made no progress after ${offset} of ${buffer.byteLength} bytes.`);
    }
    offset += written;
  }
}

function applyDirFsync(dirPath: string, mode: DirFsyncMode, syncDirectory: (dir: string) => void): void {
  if (mode === "none") return;
  if (mode === "required") {
    syncDirectory(dirPath);
    return;
  }
  try {
    syncDirectory(dirPath);
  } catch {
    // Best effort on platforms or filesystems that refuse directory fsync.
  }
}

function temporarySiblingPath(path: string, strategy: TempNameStrategy): string {
  const suffix = strategy === "pid" ? String(process.pid) : randomUUID();
  return join(dirname(path), `.${basename(path)}.tmp-${suffix}`);
}

function readbackIdentity(path: string, noFollow: boolean): { sizeBytes: number; sha256: string } {
  const flags = constants.O_RDONLY | (noFollow ? constants.O_NOFOLLOW : 0);
  const handle = openSync(path, flags);
  try {
    const stat = fstatSync(handle);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(DEFAULT_COPY_BUFFER_BYTES);
    let total = 0;
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      total += count;
    }
    if (total !== stat.size) {
      throw new Error(`Readback size ${total} disagreed with stat size ${stat.size}.`);
    }
    return { sizeBytes: total, sha256: hash.digest("hex") };
  } finally {
    closeSync(handle);
  }
}

/**
 * Writes `bytes` to a sibling temporary file and atomically renames it into
 * `path`, with explicit options preserving each caller's temporary naming,
 * exclusivity, permissions, file `fsync`, and directory `fsync` policy.
 */
export function writeFileAtomic(path: string, bytes: string | Uint8Array, options: WriteFileAtomicOptions = {}): void {
  const tempName = options.tempName ?? "uuid";
  const exclusiveTemp = options.exclusiveTemp ?? true;
  const noFollow = options.noFollow ?? false;
  const fileFsync = options.fileFsync ?? true;
  const dirFsync = options.dirFsync ?? "required";
  const temporary = temporarySiblingPath(path, tempName);
  const buffer = toBuffer(bytes);
  let flags = constants.O_WRONLY | constants.O_CREAT | (exclusiveTemp ? constants.O_EXCL : constants.O_TRUNC);
  if (noFollow) flags |= constants.O_NOFOLLOW;

  let handle: number | undefined;
  let created = false;
  let renamed = false;
  try {
    handle =
      options.createMode !== undefined ? openSync(temporary, flags, options.createMode) : openSync(temporary, flags);
    created = true;
    writeAll(handle, buffer);
    if (options.finalMode !== undefined) {
      fchmodSync(handle, options.finalMode);
    }
    if (fileFsync) {
      fsyncSync(handle);
    }
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
    renamed = true;
    applyDirFsync(dirname(path), dirFsync, fsyncDirectory);
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Best-effort close on error path.
      }
    }
    if (created && !renamed) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Best-effort cleanup of the temporary file created by this call.
      }
    }
  }
}

/**
 * Streams `source` (file path or already-opened descriptor) into `destination`,
 * computing SHA-256 in the same pass under either `exclusive-direct` or
 * `temp-rename` placement semantics.
 */
export function copyFileHashed(source: string | number, destination: string, options: CopyFileHashedOptions): string {
  const ownsSource = typeof source === "string";
  const input = ownsSource ? openSync(source, "r") : source;
  const fileFsync = options.fileFsync ?? true;
  const dirFsync = options.dirFsync ?? (options.mode === "temp-rename" ? "required" : "none");
  const bufferBytes = options.bufferBytes ?? DEFAULT_COPY_BUFFER_BYTES;
  const noFollow = options.noFollow ?? false;
  const outputPath =
    options.mode === "temp-rename" ? temporarySiblingPath(destination, options.tempName ?? "uuid") : destination;
  let flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  if (noFollow) flags |= constants.O_NOFOLLOW;

  let output: number | undefined;
  let created = false;
  let committed = false;
  try {
    output =
      options.createMode !== undefined ? openSync(outputPath, flags, options.createMode) : openSync(outputPath, flags);
    created = true;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(bufferBytes);
    for (;;) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) {
        const count = writeSync(output, buffer, written, read - written);
        if (count <= 0) {
          throw new Error(`The copy made no progress after ${written} of ${read} bytes.`);
        }
        written += count;
      }
    }
    if (options.finalMode !== undefined) {
      fchmodSync(output, options.finalMode);
    }
    if (fileFsync) {
      fsyncSync(output);
    }
    closeSync(output);
    output = undefined;
    if (options.mode === "temp-rename") {
      renameSync(outputPath, destination);
    }
    committed = true;
    applyDirFsync(dirname(destination), dirFsync, fsyncDirectory);
    return hash.digest("hex");
  } finally {
    if (ownsSource) {
      try {
        closeSync(input);
      } catch {
        // Best effort on cleanup.
      }
    }
    if (output !== undefined) {
      try {
        closeSync(output);
      } catch {
        // Best effort on the error path.
      }
    }
    if (options.mode === "temp-rename" && created && !committed) {
      try {
        rmSync(outputPath, { force: true });
      } catch {
        // Best effort after a failed copy; the exclusive name cannot alias user data.
      }
    }
  }
}

/**
 * Places a new file exclusively at `path` (`O_EXCL` and optional `O_NOFOLLOW`),
 * with optional mode tightening (`fchmodSync`), file `fsync`, ancestor-directory
 * `fsync` up to `syncAncestorsTo`, post-placement size and SHA-256 readback
 * verification, and error-path cleanup of only the file created by this call
 * (never unlinking a pre-existing file on `EEXIST`).
 */
export function placeExclusive(
  path: string,
  bytes: string | Uint8Array,
  options: PlaceExclusiveOptions = {},
): { sizeBytes: number; sha256: string } {
  const createMode = options.createMode ?? 0o644;
  const noFollow = options.noFollow ?? true;
  const fileFsync = options.fileFsync ?? true;
  const dirFsync = options.dirFsync ?? "required";
  const syncDirectory = options.syncDirectory ?? fsyncDirectory;
  const cleanupOwnedOnError = options.cleanupOwnedOnError ?? true;
  const buffer = toBuffer(bytes);
  const expectedDigest = createHash("sha256").update(buffer).digest("hex");
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (noFollow ? constants.O_NOFOLLOW : 0);

  let owned = false;
  try {
    const handle = openSync(path, flags, createMode);
    owned = true;
    try {
      writeAll(handle, buffer);
      if (options.finalMode !== undefined) {
        fchmodSync(handle, options.finalMode);
      }
      if (fileFsync) {
        fsyncSync(handle);
      }
    } finally {
      closeSync(handle);
    }

    if (options.syncAncestorsTo !== undefined) {
      const root = options.syncAncestorsTo;
      for (let directory = dirname(path); ; directory = dirname(directory)) {
        syncDirectory(directory);
        if (directory === root) break;
        const parent = dirname(directory);
        if (parent === directory) {
          throw new Error(`Target ${path} is not contained under ancestor fsync root ${root}.`);
        }
      }
    } else {
      applyDirFsync(dirname(path), dirFsync, syncDirectory);
    }

    if (options.verifyReadback) {
      const identity = options.readback ? options.readback(path) : readbackIdentity(path, noFollow);
      if (identity.sizeBytes !== buffer.byteLength || identity.sha256 !== expectedDigest) {
        throw new Error("The placed file failed post-placement readback verification.");
      }
      return identity;
    }

    return { sizeBytes: buffer.byteLength, sha256: expectedDigest };
  } catch (error) {
    if (cleanupOwnedOnError && owned) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Owned survivor remains unreachable if cleanup itself fails.
      }
    }
    throw error;
  }
}
