import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyFileHashed, fsyncDirectory, placeExclusive, writeFileAtomic } from "../../src/fs-atomic";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Restore permissions if a test left a read-only file behind.
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("fs-atomic primitives", () => {
  it("placeExclusive fsyncs every ancestor directory from dirname(path) up to managedRoot in bottom-up order", () => {
    const managedRoot = makeTempDir("sorage-fs-atomic-ancestors-");
    const nestedDir = join(managedRoot, "contents", "memos", "m-1");
    mkdirSync(nestedDir, { recursive: true });
    const target = join(nestedDir, "body.md");
    const syncedDirs: string[] = [];

    const result = placeExclusive(target, "hello memo\n", {
      createMode: 0o644,
      finalMode: 0o444,
      syncAncestorsTo: managedRoot,
      verifyReadback: true,
      syncDirectory: (dir) => {
        syncedDirs.push(dir);
        fsyncDirectory(dir);
      },
    });

    expect(syncedDirs).toEqual([
      nestedDir,
      join(managedRoot, "contents", "memos"),
      join(managedRoot, "contents"),
      managedRoot,
    ]);
    expect(result).toEqual({
      sizeBytes: Buffer.byteLength("hello memo\n", "utf8"),
      sha256: createHash("sha256").update("hello memo\n").digest("hex"),
    });
    expect(readFileSync(target, "utf8")).toBe("hello memo\n");
    expect(statSync(target).mode & 0o777).toBe(0o444);
    chmodSync(target, 0o644);
  });

  it("placeExclusive deletes the newly owned file when post-placement readback disagrees on digest or length", () => {
    const managedRoot = makeTempDir("sorage-fs-atomic-readback-");
    const dir = join(managedRoot, "contents");
    mkdirSync(dir, { recursive: true });

    const badDigestTarget = join(dir, "bad-digest.txt");
    expect(() =>
      placeExclusive(badDigestTarget, "expected bytes", {
        createMode: 0o644,
        finalMode: 0o444,
        syncAncestorsTo: managedRoot,
        verifyReadback: true,
        readback: () => ({
          sizeBytes: Buffer.byteLength("expected bytes", "utf8"),
          sha256: "0".repeat(64),
        }),
      }),
    ).toThrow(/readback/i);
    expect(existsSync(badDigestTarget)).toBe(false);

    const badSizeTarget = join(dir, "bad-size.txt");
    expect(() =>
      placeExclusive(badSizeTarget, "expected bytes", {
        createMode: 0o644,
        finalMode: 0o444,
        syncAncestorsTo: managedRoot,
        verifyReadback: true,
        readback: () => ({
          sizeBytes: 1,
          sha256: createHash("sha256").update("expected bytes").digest("hex"),
        }),
      }),
    ).toThrow(/readback/i);
    expect(existsSync(badSizeTarget)).toBe(false);
  });

  it("placeExclusive throws on EEXIST and never unlinks a pre-existing file", () => {
    const managedRoot = makeTempDir("sorage-fs-atomic-eexist-");
    const target = join(managedRoot, "existing.txt");
    writeFileSync(target, "original content", "utf8");

    expect(() =>
      placeExclusive(target, "replacement content", {
        createMode: 0o644,
        finalMode: 0o444,
        syncAncestorsTo: managedRoot,
        verifyReadback: true,
      }),
    ).toThrow(/EEXIST/i);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("original content");
  });

  it("writeFileAtomic and copyFileHashed preserve bytes, digests, and cleanup on failure", () => {
    const root = makeTempDir("sorage-fs-atomic-rw-");
    const fileA = join(root, "atomic.json");
    writeFileAtomic(fileA, '{"ok":true}\n', {
      createMode: 0o600,
      finalMode: 0o600,
      fileFsync: true,
      dirFsync: "required",
    });
    expect(readFileSync(fileA, "utf8")).toBe('{"ok":true}\n');
    expect(statSync(fileA).mode & 0o777).toBe(0o600);

    const expectedSha = createHash("sha256").update('{"ok":true}\n').digest("hex");
    const copiedDirect = join(root, "copied-direct.json");
    expect(copyFileHashed(fileA, copiedDirect, { mode: "exclusive-direct", fileFsync: true, dirFsync: "none" })).toBe(
      expectedSha,
    );
    expect(readFileSync(copiedDirect, "utf8")).toBe('{"ok":true}\n');

    const copiedRename = join(root, "copied-rename.json");
    expect(copyFileHashed(fileA, copiedRename, { mode: "temp-rename", fileFsync: true, dirFsync: "required" })).toBe(
      expectedSha,
    );
    expect(readFileSync(copiedRename, "utf8")).toBe('{"ok":true}\n');
  });

  it("writeFileAtomic removes its owned temp sibling when rename fails after temp creation", () => {
    const dir = makeTempDir("sorage-fs-atomic-wfa-fail-");
    const occupiedDir = join(dir, "occupied");
    mkdirSync(occupiedDir);
    writeFileSync(join(occupiedDir, "keep.txt"), "keep", "utf8");

    expect(() =>
      writeFileAtomic(occupiedDir, "replacement", {
        tempName: "uuid",
        exclusiveTemp: true,
        fileFsync: true,
        dirFsync: "required",
      }),
    ).toThrow();
    expect(readdirSync(dir)).toEqual(["occupied"]);
    expect(readFileSync(join(occupiedDir, "keep.txt"), "utf8")).toBe("keep");

    // PID-named exclusive temp files must also be unlinked on failure so a same-process retry never hits EEXIST.
    for (let attempt = 0; attempt < 2; attempt++) {
      let caught: NodeJS.ErrnoException | undefined;
      try {
        writeFileAtomic(occupiedDir, "replacement", {
          tempName: "pid",
          exclusiveTemp: true,
          fileFsync: true,
          dirFsync: "required",
        });
      } catch (error) {
        caught = error as NodeJS.ErrnoException;
      }
      expect(caught).toBeDefined();
      expect(caught?.code).not.toBe("EEXIST");
      expect(readdirSync(dir)).toEqual(["occupied"]);
    }
  });

  it("copyFileHashed (temp-rename) removes its owned temp sibling on both mid-copy and rename failures", () => {
    const dir = makeTempDir("sorage-fs-atomic-copy-fail-");
    const sourceFile = join(dir, "source.bin");
    writeFileSync(sourceFile, "streamed payload", "utf8");

    // Mid-copy failure: output temp file is opened exclusively before reading from a write-only fd fails with EBADF.
    const writeOnlyPath = join(dir, "write-only.bin");
    const writeOnlyFd = openSync(writeOnlyPath, "w");
    const midFailTarget = join(dir, "mid-fail.bin");
    try {
      expect(() =>
        copyFileHashed(writeOnlyFd, midFailTarget, {
          mode: "temp-rename",
          tempName: "uuid",
          fileFsync: true,
          dirFsync: "required",
        }),
      ).toThrow(/EBADF/i);
    } finally {
      closeSync(writeOnlyFd);
    }
    expect(existsSync(midFailTarget)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);

    // Post-copy rename failure: full stream completes and closes before rename onto a non-empty directory fails.
    const occupiedDir = join(dir, "copy-occupied");
    mkdirSync(occupiedDir);
    writeFileSync(join(occupiedDir, "keep.txt"), "keep", "utf8");
    expect(() =>
      copyFileHashed(sourceFile, occupiedDir, {
        mode: "temp-rename",
        tempName: "uuid",
        fileFsync: true,
        dirFsync: "required",
      }),
    ).toThrow();
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(readFileSync(join(occupiedDir, "keep.txt"), "utf8")).toBe("keep");
  });
});
