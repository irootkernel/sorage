import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** The normative lockfile set under `<home>/run` (domain-and-architecture section 19). */
export type LockName = "config" | "daemon" | "backup" | "vault-move" | "migration";

/** The record every lockfile carries. */
export interface LockRecord {
  pid: number;
  startedAt: string;
  hostname: string;
}

/** UTC clock port, structural twin of the core Clock so adapters stay self-contained. */
export interface LockClock {
  now(): Date;
}

export class SystemLockClock implements LockClock {
  now(): Date {
    return new Date();
  }
}

/** The probes a staleness decision needs; every one is injectable for tests. */
export interface LockProbePorts {
  clock: LockClock;
  hostname: () => string;
  isPidAlive: (pid: number) => boolean;
}

/** `config.lock` is additionally stale after this window; the other locks may run long. */
export const CONFIG_LOCK_MAX_AGE_MS = 30_000;

export type StaleReason = "dead-pid" | "expired" | "malformed";

export interface StalenessVerdict {
  stale: boolean;
  reason?: StaleReason;
}

/**
 * The documented staleness rules: every lock is stale when its recorded pid is not
 * alive, `config.lock` additionally when it is older than 30 seconds, and a record
 * that cannot be parsed cannot prove a live owner, so it is stale as well.
 */
export function evaluateStaleness(
  lock: LockName,
  record: LockRecord | undefined,
  now: Date,
  isPidAlive: (pid: number) => boolean,
): StalenessVerdict {
  if (record === undefined || !Number.isInteger(record.pid) || record.pid <= 0) {
    return { stale: true, reason: "malformed" };
  }
  const startedAtMs = Date.parse(record.startedAt);
  if (Number.isNaN(startedAtMs)) return { stale: true, reason: "malformed" };
  if (!isPidAlive(record.pid)) return { stale: true, reason: "dead-pid" };
  if (lock === "config" && now.getTime() - startedAtMs > CONFIG_LOCK_MAX_AGE_MS) {
    return { stale: true, reason: "expired" };
  }
  return { stale: false };
}

/** Parses one lockfile body; anything that is not a complete record is rejected. */
export function parseLockRecord(text: string): LockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<LockRecord>;
  if (
    typeof candidate.pid !== "number" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.hostname !== "string"
  ) {
    return undefined;
  }
  return { pid: candidate.pid, startedAt: candidate.startedAt, hostname: candidate.hostname };
}

export interface LockConflict {
  kind: "live-lock";
  lock: LockName;
  path: string;
  record: LockRecord | undefined;
}

export type LockAcquisition =
  | { ok: true; record: LockRecord; release: () => void }
  | { ok: false; error: LockConflict };

export interface AcquireLockOptions {
  path: string;
  lock: LockName;
  ports: LockProbePorts;
  /** Defaults to the acquiring process's own pid. */
  pid?: number | undefined;
}

/** The production probe set: the wall clock, the machine hostname, and signal-zero liveness. */
export function createNodeLockProbePorts(clock: LockClock = new SystemLockClock()): LockProbePorts {
  return {
    clock,
    hostname: () => hostname(),
    isPidAlive,
  };
}

/**
 * Signal-zero liveness: success or EPERM both mean the pid exists; ESRCH means dead.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquires one exclusive lockfile with `O_EXCL`. A stale lock is broken and taken
 * over; a live lock produces a conflict rather than a wait loop.
 */
export function acquireLock(options: AcquireLockOptions): LockAcquisition {
  const { path, lock, ports } = options;
  mkdirSync(dirname(path), { recursive: true });
  const record: LockRecord = {
    pid: options.pid ?? process.pid,
    startedAt: ports.clock.now().toISOString(),
    hostname: ports.hostname(),
  };
  const first = writeExclusive(path, record);
  if (first) return { ok: true, record, release: () => releaseLock(path) };

  const existing = parseLockRecord(readBody(path));
  const verdict = evaluateStaleness(lock, existing, ports.clock.now(), ports.isPidAlive);
  if (!verdict.stale) {
    return { ok: false, error: { kind: "live-lock", lock, path, record: existing } };
  }
  breakStaleLock(path);
  if (writeExclusive(path, record)) return { ok: true, record, release: () => releaseLock(path) };
  return { ok: false, error: { kind: "live-lock", lock, path, record: parseLockRecord(readBody(path)) } };
}

/** Reads the record a lockfile carries without acquiring anything. */
export function readLock(path: string): LockRecord | undefined {
  return parseLockRecord(readBody(path));
}

/** Releases a lockfile; releasing an absent lock is not an error. */
export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone; release is idempotent.
  }
}

function writeExclusive(path: string, record: LockRecord): boolean {
  let handle: number;
  try {
    // "wx" is Node's O_EXCL: the create fails when any file already exists.
    handle = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
  try {
    writeSync(handle, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(handle);
  }
  return true;
}

/** Removes a verified-stale lock, tolerating a concurrent breaker that got there first. */
function breakStaleLock(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readBody(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
