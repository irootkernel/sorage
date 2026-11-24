import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { type AppError, appError, type Configuration, type PreflightFacts } from "@sorage/core";

export const LOG_FILE_NAME = /^sorage\.log(?:\.[1-9][0-9]*)?$/;
export const SQLITE_HEADER = "SQLite format 3\0";
export const CAPTURE_ATTEMPTS = 2;
export const ROOT_INSTALL_NAMES = new Set(["config.yaml", "logs", "state", "run", "vault"]);

export type PreflightLiveness = "alive" | "dead" | "uncertain";

export interface PrivateDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}

export interface PreflightInspectPorts {
  /** Operating-system user home for `~/` expansion. Never the selected installation. */
  userHome?: string;
  /** Existing directory outside the selected home and Vault. The inspector creates its scratch here. */
  scratchParent?: string;
  /** Signal-zero probe. The default is `process.kill`. */
  kill?: (pid: number, signal: number) => void;
  /** Called once after the first look at an absent selected path, before the stability recheck. */
  onObserved?: () => void;
  liveness?: (pid: number) => PreflightLiveness;
  copyFile?: (from: string, to: string) => void;
  readFile?: (path: string) => Buffer;
  openPrivateDatabase?: (path: string) => PrivateDatabase;
}

/** Adapter-internal read capabilities, valid only during the consumer callback. */
export interface InstallationInspectionReader {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

export type InstallationInspection =
  | {
      kind: "ready";
      facts: PreflightFacts;
      config: Configuration;
      migrationVersion: number;
      reader: InstallationInspectionReader;
    }
  | { kind: "refused"; facts: PreflightFacts; error: AppError };

export type AcquiredInspection = InstallationInspection & { dispose?: () => void };

export const unavailable = () =>
  appError("STORAGE_INSPECTION_UNAVAILABLE", "a safe coherent installation inspection is unavailable");

export const refuse = (
  facts: PreflightFacts,
  error: AppError = unavailable(),
): Extract<AcquiredInspection, { kind: "refused" }> => ({
  kind: "refused",
  facts,
  error,
});

export function databaseFormat(path: string): "sqlite" | "corrupt" | "unsupported-format" {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return "unsupported-format";
    const buffer = Buffer.alloc(100);
    let total = 0;
    while (total < 100) {
      const count = readSync(fd, buffer, total, 100 - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total < SQLITE_HEADER.length) return "unsupported-format";
    if (buffer.subarray(0, SQLITE_HEADER.length).toString("utf8") !== SQLITE_HEADER) return "unsupported-format";
    if (total < 100) return "corrupt";
    return "sqlite";
  } finally {
    closeSync(fd);
  }
}

export function probePid(pid: number, kill: (pid: number, signal: number) => void): PreflightLiveness {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    const coded = error as NodeJS.ErrnoException;
    if (coded.code === "EPERM" || coded.errno === osConstants.errno.EPERM) return "alive";
    if (coded.code === "ESRCH" || coded.errno === osConstants.errno.ESRCH) return "dead";
    return "uncertain";
  }
}

export function directoryRecord(path: string, root: string): string | undefined {
  const look = pathLook(path);
  if (look.kind === "missing") return "missing";
  if (look.kind !== "stat" || look.stat.isSymbolicLink() || !look.stat.isDirectory()) return undefined;
  const target = pathTarget(path);
  if (target.kind !== "path" || !contained(root, target.path)) return undefined;
  let names: string[];
  try {
    names = readdirSync(target.path).sort();
  } catch {
    return undefined;
  }
  return `${target.path} ${look.stat.dev}:${look.stat.ino} ${look.stat.mode} ${look.stat.mtimeMs} ${names.join("\0")}`;
}

export function fileShape(path: string, root: string, required: boolean): string | undefined {
  const look = pathLook(path);
  if (look.kind === "missing") return required ? undefined : "missing";
  if (look.kind !== "stat" || look.stat.isSymbolicLink() || !look.stat.isFile()) return undefined;
  const target = pathTarget(path);
  if (target.kind !== "path" || !contained(root, target.path)) return undefined;
  return `${target.path} ${look.stat.dev}:${look.stat.ino} ${look.stat.mode}`;
}

const PREFLIGHT_HASH_CHUNK_BYTES = 64 * 1024;

export function streamSha256RegularFile(
  path: string,
  expectedStat?: { dev: number | bigint; ino: number | bigint },
): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) {
      throw new Error("Preflight hashing requires a regular file");
    }
    if (
      expectedStat !== undefined &&
      (opened.dev !== BigInt(expectedStat.dev) || opened.ino !== BigInt(expectedStat.ino))
    ) {
      throw new Error("Preflight file changed identity while opening");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(PREFLIGHT_HASH_CHUNK_BYTES);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function markerFile(path: string, vaultRoot: string): string | undefined {
  const shape = fileShape(path, vaultRoot, true);
  if (shape === undefined) return undefined;
  try {
    const hash = streamSha256RegularFile(path);
    const look = pathLook(path);
    if (look.kind !== "stat") return undefined;
    return `${shape} ${look.stat.mtimeMs} ${hash}`;
  } catch {
    return undefined;
  }
}

export function canonicalIdentity(path: string): string | undefined {
  const stat = tryStat(path);
  return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
}

export function rootBinding(path: string): string | undefined {
  const resolved = tryRealpath(path);
  if (resolved === undefined) return undefined;
  const identity = canonicalIdentity(resolved);
  return identity === undefined ? undefined : `${resolved}\n${identity}`;
}

const CONCLUSIVE_PRIVATE_CORRUPTION = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);

export function conclusivePrivateCorruption(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CONCLUSIVE_PRIVATE_CORRUPTION.has(code);
}

/** Identity is the final `dev:ino` line. The canonical path itself may contain newlines. */
export function bindingPath(binding: string): string | undefined {
  const splitAt = binding.lastIndexOf("\n");
  if (splitAt <= 0) return undefined;
  return binding.slice(0, splitAt);
}

export function contained(parent: string, candidate: string): boolean {
  const root = tryRealpath(parent) ?? parent;
  const target = tryRealpath(candidate) ?? candidate;
  const from = relative(root, target);
  return from === "" || (!from.startsWith(`..${sep}`) && from !== ".." && !isAbsolute(from));
}

export function stableDirectory(path: string): boolean {
  const stat = tryStat(path);
  return stat?.isDirectory() === true;
}

export function scratchParent(roots: string[], preferred?: string): string | undefined {
  const candidates: string[] = [];
  if (preferred !== undefined) candidates.push(preferred);
  let current = tmpdir();
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(current);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  candidates.push("/tmp");
  for (const candidate of candidates) {
    const parent = outsideRoots(candidate, roots);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

function outsideRoots(candidate: string, roots: string[]): string | undefined {
  const resolved = tryRealpath(candidate) ?? candidate;
  if (tryStat(resolved)?.isDirectory() !== true) return undefined;
  if (roots.some((root) => resolved === root || contained(root, resolved))) return undefined;
  try {
    accessSync(resolved, fsConstants.W_OK);
  } catch {
    return undefined;
  }
  return resolved;
}

export interface StatLook {
  kind: "stat";
  stat: NonNullable<ReturnType<typeof lstatSync>>;
}

export type PathLook = StatLook | { kind: "missing" } | { kind: "failed" };

export function pathLook(path: string): PathLook {
  try {
    const stat = lstatSync(path);
    return stat === undefined ? { kind: "failed" } : { kind: "stat", stat };
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "failed" };
  }
}

export function pathTarget(path: string): { kind: "path"; path: string } | { kind: "missing" } | { kind: "failed" } {
  try {
    return { kind: "path", path: realpathSync(path) };
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "failed" };
  }
}

export function errnoCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
}

export function tryStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

export function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
