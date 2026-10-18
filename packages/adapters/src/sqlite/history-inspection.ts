import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { AppliedMigrationRow } from "@sorage/core";
import {
  databaseFileExists,
  openSorageInspectionCopy,
  openSorageReadonlyAdmission,
  type SorageSqlite,
} from "./connection";

/** Internal inspection dependencies, overridden only by failure/concurrency tests. */
export interface HistoryInspectionPorts {
  copyFile?: (source: string, target: string) => void;
  openReadonly?: (path: string) => SorageSqlite;
  openCopy?: (path: string) => SorageSqlite;
  removeScratch?: (path: string) => void;
}

export function readAppliedRows(db: SorageSqlite): AppliedMigrationRow[] {
  const catalog = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
  let table: unknown;
  try {
    table = catalog.get();
  } finally {
    catalog.finalize?.();
  }
  if (!table) return [];
  const history = db.prepare<AppliedMigrationRow>("SELECT version, name FROM schema_migrations ORDER BY version");
  try {
    return history.all();
  } finally {
    history.finalize?.();
  }
}

/** Reads existing history without opening the selected database writable (SHR-009). */
export function inspectAppliedHistory(path: string, ports: HistoryInspectionPorts = {}): AppliedMigrationRow[] | null {
  if (!databaseFileExists(path)) return null;
  let reader: SorageSqlite | undefined;
  try {
    reader = (ports.openReadonly ?? openSorageReadonlyAdmission)(path);
    try {
      return readAppliedRows(reader);
    } catch (error) {
      if (!cannotOpen(error)) throw error;
    }
  } catch (error) {
    if (!cannotOpen(error)) throw error;
  } finally {
    // A failed close escapes: it must never authorize capture or operational use.
    reader?.close();
  }
  return inspectCapture(path, ports);
}

function cannotOpen(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_CANTOPEN";
}

class CaptureChanged extends Error {}

interface FileObservation {
  identity: string;
  sha256: string;
}
function stamp(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Bounded reads also detect replacement, growth, and truncation during hashing. */
function observe(path: string, optional = false): FileObservation | null {
  let expected: BigIntStats;
  try {
    expected = lstatSync(path, { bigint: true });
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!expected.isFile()) throw new Error(`History inspection requires a regular file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(expected))
      throw new CaptureChanged("History source changed before reading");
    const buffer = Buffer.alloc(64 * 1024);
    const hash = createHash("sha256");
    let remaining = expected.size;
    while (remaining > 0n) {
      const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
      const read = readSync(fd, buffer, 0, length, null);
      if (read === 0) throw new CaptureChanged("History source truncated during reading");
      hash.update(buffer.subarray(0, read));
      remaining -= BigInt(read);
    }
    if (
      stamp(fstatSync(fd, { bigint: true })) !== stamp(expected) ||
      stamp(lstatSync(path, { bigint: true })) !== stamp(expected)
    ) {
      throw new CaptureChanged("History source changed during reading");
    }
    return { identity: stamp(expected), sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}
function binding(path: string): string {
  const parent = realpathSync(dirname(path));
  const stat = lstatSync(parent, { bigint: true });
  if (!stat.isDirectory()) throw new Error("History parent is not a directory");
  return `${parent}:${stat.dev}:${stat.ino}`;
}
function observation(path: string) {
  return { binding: binding(path), main: observe(path), wal: observe(`${path}-wal`, true) };
}
function outsideInstallation(path: string): string {
  const parent = realpathSync(dirname(path));
  const installation = basename(parent) === "state" ? dirname(parent) : parent;
  let candidate = realpathSync(tmpdir());
  for (;;) {
    const child = relative(installation, candidate);
    if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
      accessSync(candidate, constants.W_OK);
      return candidate;
    }
    const next = dirname(candidate);
    if (next === candidate) throw new Error("No private temporary directory outside the installation is available");
    candidate = next;
  }
}

/** Cold WAL may require sidecar creation, which occurs only in our private copy. */
function inspectCapture(path: string, ports: HistoryInspectionPorts): AppliedMigrationRow[] {
  const copy = ports.copyFile ?? copyFileSync;
  const remove = ports.removeScratch ?? ((scratch: string) => rmSync(scratch, { recursive: true, force: true }));
  let failure: unknown = new Error("Could not capture stable database history");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scratch = mkdtempSync(join(outsideInstallation(path), "sorage-history-"));
    let copying = true;
    try {
      const before = observation(path);
      const privatePath = join(scratch, "sorage.sqlite3");
      copy(path, privatePath);
      chmodSync(privatePath, 0o600);
      if (before.wal !== null) {
        copy(`${path}-wal`, `${privatePath}-wal`);
        chmodSync(`${privatePath}-wal`, 0o600);
      }
      const after = observation(path);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        failure = new Error("Database history changed during capture");
        continue;
      }
      if (
        observe(privatePath)?.sha256 !== before.main?.sha256 ||
        observe(`${privatePath}-wal`, true)?.sha256 !== before.wal?.sha256
      ) {
        failure = new Error("Captured database history does not match its source");
        continue;
      }
      copying = false;
      const db = (ports.openCopy ?? openSorageInspectionCopy)(privatePath);
      try {
        return readAppliedRows(db);
      } finally {
        db.close();
      }
    } catch (error) {
      // SQLite can remove/reset WAL during a checkpoint; recapture that change.
      // Other I/O, SQL, and close failures remain actual failures.
      if (copying && (error instanceof CaptureChanged || (error as NodeJS.ErrnoException).code === "ENOENT")) {
        failure = error;
        continue;
      }
      throw error;
    } finally {
      remove(scratch);
    }
  }
  throw failure;
}
