import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { appError, err, memoIdFromSnapshotPath, ok, type Result, type VersionedSnapshotManifest } from "@sorage/core";

/** Check every ancestor and the opened regular file before reading any bytes. */
export function readSnapshotBytes(root: string, path: string, maximumBytes?: number): Result<Buffer> {
  try {
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\")))
      throw new Error("Invalid snapshot path");
    let parent = root;
    for (const part of ["", ...parts.slice(0, -1)]) {
      parent = part === "" ? parent : join(parent, part);
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Snapshot ancestor is not a regular directory");
    }
    const file = join(root, ...parts);
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Snapshot is not a regular file");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        (maximumBytes !== undefined && opened.size > maximumBytes)
      )
        throw new Error("Snapshot file changed or exceeds its bound");
      // Cap the allocation and reads even if a concurrently modified file grows.
      let bytes: Buffer;
      if (maximumBytes === undefined) bytes = readFileSync(fd);
      else {
        const buffer = Buffer.alloc(Math.min(opened.size + 1, maximumBytes + 1));
        let length = 0;
        while (length < buffer.length) {
          const read = readSync(fd, buffer, length, buffer.length - length, null);
          if (read === 0) break;
          length += read;
        }
        bytes = buffer.subarray(0, length);
      }
      if (bytes.length !== opened.size || (maximumBytes !== undefined && bytes.length > maximumBytes))
        throw new Error("Snapshot file changed while reading");
      return ok(bytes);
    } finally {
      closeSync(fd);
    }
  } catch {
    return err(appError("VAULT_INTEGRITY_ERROR", "Snapshot path is missing, unsafe, or unreadable"));
  }
}

export function readMemoSnapshotFiles(
  sourcePath: string,
  manifest: VersionedSnapshotManifest,
): Result<Array<{ path: string; bytes: Buffer; digest: string }>> {
  const root = join(sourcePath, "snapshots");
  const paths: string[] = [];
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Unsafe snapshot root");
    const directory = join(root, "memos");
    let present = true;
    try {
      lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      present = false;
    }
    if (present) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Memo directory");
      for (const shard of readdirSync(directory)) {
        const shardPath = join(directory, shard);
        const stat = lstatSync(shardPath);
        if (!/^[0-9a-f]{2}$/.test(shard) || !stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Invalid Memo shard directory");
        for (const name of readdirSync(shardPath)) {
          const path = `memos/${shard}/${name}`;
          if (!memoIdFromSnapshotPath(path).ok) throw new Error("Invalid Memo shard path");
          paths.push(path);
        }
      }
    }
    const digests = manifest.formatVersion === 2 ? manifest.memoDigests : {};
    if (paths.length !== Object.keys(digests).length || paths.some((path) => !Object.hasOwn(digests, path)))
      throw new Error("Memo files and digest inventory disagree");
    const files = [];
    for (const path of paths.sort()) {
      const bytes = readSnapshotBytes(root, path, 512 * 1024);
      if (!bytes.ok) return bytes;
      files.push({ path, bytes: bytes.value, digest: digests[path] as string });
    }
    return ok(files);
  } catch {
    return err(appError("VAULT_INTEGRITY_ERROR", "Memo snapshot inventory is invalid or unsafe"));
  }
}
