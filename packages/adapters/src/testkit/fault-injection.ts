/**
 * Fault-injection wrappers over the filesystem and Git operations with named crash
 * points. A crash point throws before or after the wrapped operation so tests can
 * rehearse the durability order of section 20.8 of domain-and-architecture.md.
 */
export type CrashPhase = "before" | "after";

export type FsOperation = "writeFile" | "readFile" | "rename" | "unlink" | "mkdir" | "fsync" | "copyFile";

export type GitOperation = "add" | "commit" | "push" | "pull" | "status" | "clone";

export class CrashInjectedError extends Error {
  constructor(
    public readonly adapter: "fs" | "git",
    public readonly operation: string,
    public readonly phase: CrashPhase,
  ) {
    super(`injected crash in ${adapter}.${operation} (${phase})`);
    this.name = "CrashInjectedError";
  }
}

interface ArmedPoint {
  adapter: "fs" | "git";
  operation: string;
  phase: CrashPhase;
}

/** Shared registration of named crash points for one test scenario. */
export class CrashPointRegistry {
  private readonly points = new Map<string, ArmedPoint>();

  /** Names a crash point like "CP-1"; it fires only on its own adapter, operation, and phase. */
  arm(name: string, adapter: "fs" | "git", operation: string, phase: CrashPhase): void {
    this.points.set(name, { adapter, operation, phase });
  }

  disarm(name: string): void {
    this.points.delete(name);
  }

  fire(adapter: "fs" | "git", operation: string, phase: CrashPhase): void {
    for (const point of this.points.values()) {
      if (point.adapter === adapter && point.operation === operation && point.phase === phase) {
        throw new CrashInjectedError(adapter, operation, phase);
      }
    }
  }
}

/** Filesystem adapter surface used by Sorage code under test. */
export interface FsAdapter {
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  mkdir(path: string): void;
  fsync(path: string): void;
  copyFile(from: string, to: string): void;
}

import * as nodeFs from "node:fs";
import { openSync, readFileSync, closeSync } from "node:fs";

export const realFsAdapter: FsAdapter = {
  writeFile: (path, data) => nodeFs.writeFileSync(path, data),
  readFile: (path) => new Uint8Array(readFileSync(path)),
  rename: (from, to) => nodeFs.renameSync(from, to),
  unlink: (path) => nodeFs.unlinkSync(path),
  mkdir: (path) => nodeFs.mkdirSync(path, { recursive: true }),
  fsync: (path) => {
    const fd = openSync(path, "r+");
    try {
      nodeFs.fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  copyFile: (from, to) => nodeFs.copyFileSync(from, to),
};

/** Wraps an FsAdapter so armed crash points throw before or after each operation. */
export function faultInjectingFs(registry: CrashPointRegistry, inner: FsAdapter = realFsAdapter): FsAdapter {
  return {
    writeFile: (path, data) => {
      registry.fire("fs", "writeFile", "before");
      inner.writeFile(path, data);
      registry.fire("fs", "writeFile", "after");
    },
    readFile: (path) => {
      registry.fire("fs", "readFile", "before");
      const result = inner.readFile(path);
      registry.fire("fs", "readFile", "after");
      return result;
    },
    rename: (from, to) => {
      registry.fire("fs", "rename", "before");
      inner.rename(from, to);
      registry.fire("fs", "rename", "after");
    },
    unlink: (path) => {
      registry.fire("fs", "unlink", "before");
      inner.unlink(path);
      registry.fire("fs", "unlink", "after");
    },
    mkdir: (path) => {
      registry.fire("fs", "mkdir", "before");
      inner.mkdir(path);
      registry.fire("fs", "mkdir", "after");
    },
    fsync: (path) => {
      registry.fire("fs", "fsync", "before");
      inner.fsync(path);
      registry.fire("fs", "fsync", "after");
    },
    copyFile: (from, to) => {
      registry.fire("fs", "copyFile", "before");
      inner.copyFile(from, to);
      registry.fire("fs", "copyFile", "after");
    },
  };
}

/** Minimal Git adapter surface used by backup tests until the real adapter lands. */
export interface GitAdapter {
  run(cwd: string, operation: GitOperation, args: string[]): string;
}

import { spawnSync as gitSpawnSync } from "node:child_process";

export const realGitAdapter: GitAdapter = {
  run: (cwd, _operation, args) => {
    const result = gitSpawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  },
};

/** Wraps a GitAdapter so armed crash points throw before or after each operation. */
export function faultInjectingGit(registry: CrashPointRegistry, inner: GitAdapter = realGitAdapter): GitAdapter {
  return {
    run: (cwd, operation, args) => {
      registry.fire("git", operation, "before");
      const out = inner.run(cwd, operation, args);
      registry.fire("git", operation, "after");
      return out;
    },
  };
}
