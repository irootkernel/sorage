import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import {
  admitKnownAppliedHistory,
  type AppError,
  appError,
  type AppliedMigrationRow,
  err,
  knownSchemaMaximum,
  ok,
  type Result,
} from "@sorage/core";
import { type ContentionSurface, contentionRefusal, storageContentionOf } from "../storage-contention";
import { databaseFileExists, openSorageMemoryCopy, openSorageReadonlyWalAccess, type SorageSqlite } from "./connection";
import { readAppliedRows } from "./history-inspection";

/**
 * The one shared read primitive of the covered zero-write reads (RDR-002 to
 * RDR-004). It selects the storage path from the `-wal` length before any
 * SQLite open, so a read never creates a missing sidecar, never rewrites the
 * shared-memory file, and never depends on an engine error to choose a path:
 *
 * - `-wal` absent, or no longer than its 32-byte header: the WAL holds no
 *   frame, so the main file holds every committed transaction; the read
 *   captures it into a private read-only in-memory image with its identity
 *   (and the `-wal` length) verified before and after the copy. TASK-122
 *   measured that a clean last close leaves an empty `-wal`, over which a
 *   reader whose `-shm` is read-only runs SQLite's unreliable shared-memory
 *   mode and reports an external change at every read transaction, so the
 *   Memo list coherence of MEM-011 could never settle, and that a header-only
 *   `-wal` fails such a reader with `SQLITE_PROTOCOL`; the copy serves both
 *   as well as the sidecars-absent state of probe P1 case C.
 * - `-wal` longer than its header and `-shm` present: read-only WAL access
 *   with a read-only `-shm`, measured stable and write-free with a live writer,
 *   after a writer was killed before closing, and over an incomplete tail,
 *   sandboxed or not. After its first read the connection re-checks the
 *   `-wal` length: a last writer's close may have emptied it between the
 *   selection and that first read, and once the first read holds its lock a
 *   later close can no longer empty it, so one re-check is enough.
 * - `-wal` longer than its header and `-shm` absent: every zero-write
 *   mechanism fails and the main file alone would omit the WAL's committed
 *   rows, so the state is refused with the invoking family's typed
 *   open-contention refusal.
 * - a non-regular sidecar is refused exactly where the read relies on it: a
 *   `-wal` that is not a regular file (a symlink is the main case, `lstat`
 *   reporting the link's own length) refuses everywhere, in the selection and
 *   in the copy's re-check alike, so a short link over a `-wal` holding
 *   uncheckpointed commits can never serve a copy that omits them; a `-shm`
 *   that is not a regular file refuses only on the WAL path, where SQLite
 *   opens it — on the copy path the read neither opens nor measures the
 *   `-shm`, so its type cannot affect what the read returns and the copy
 *   serves it.
 *
 * The schema is then checked through the existing history-inspection read
 * (`readAppliedRows` plus the central known-schema admission), and an older or
 * empty database is refused with `STORAGE_MIGRATION_REQUIRED` instead of being
 * migrated. The primitive never runs the migration path, never creates a
 * database file, never reaches `inspectCapture`'s temp-directory copy, and
 * never lets a raw SQLite error escape.
 */

/** Internal seams, overridden only by failure, race, transition and exhaustion tests. */
export interface ReadAdmissionPorts {
  openReadonly?: (path: string) => SorageSqlite;
  openMemoryCopy?: (bytes: Uint8Array) => SorageSqlite;
  /** The byte read of the capture; a test's reader may change the files mid-copy. */
  readMainFile?: (path: string, size: number) => Buffer;
  /** Runs between the selection of the WAL path and its open; a test's writer may close here. */
  beforeOpen?: (path: string) => void;
}

export type CoveredReadSource = "readonly-wal" | "memory-copy";

export interface CoveredReadConnection {
  db: SorageSqlite;
  source: CoveredReadSource;
  close(): void;
}

const CAPTURE_ATTEMPTS = 3;
const SQLITE_HEADER_BYTES = 100;
const WAL_HEADER_BYTES = 32;
const WAL_FORMAT_VERSION = 2;
const LEGACY_FORMAT_VERSION = 1;
const SIDECAR_GAP_REPAIR =
  "Run any writable Sorage command, or sorage backup run once, to recreate the missing -shm beside the -wal; then retry this read identically";

export function openCoveredReadConnection(
  path: string,
  surface: ContentionSurface | undefined,
  ports: ReadAdmissionPorts = {},
): Result<CoveredReadConnection, AppError> {
  try {
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
      if (!databaseFileExists(path)) return err(missingDatabase(path));
      const wal = walState(path);
      const walRefusal = walStateRefusal(wal, path, surface);
      if (walRefusal !== null) return err(walRefusal);
      let db: SorageSqlite;
      let source: CoveredReadSource;
      if (holdsNoFrames(wal)) {
        const bytes = captureQuiescentMainFile(path, ports);
        if (bytes === null) continue;
        if (bytes.byteLength === 0) return err(migrationRequired(0));
        const image = openImage(bytes, surface, ports);
        if (!image.ok) return image;
        db = image.value;
        source = "memory-copy";
      } else {
        // SQLite opens the `-shm` on this path, so its type matters here; on
        // the copy path the read neither opens nor measures it.
        const shm = sidecarStat(`${path}-shm`);
        if (shm === "irregular") return err(irregularSidecar("Shared-memory sidecar", `${path}-shm`));
        if (shm === "absent") return err(sidecarGap(surface));
        if (typeof shm === "object" && "kind" in shm) return err(storageFailure(shm.error, surface));
        ports.beforeOpen?.(path);
        let opened: SorageSqlite;
        try {
          opened = ports.openReadonly !== undefined ? ports.openReadonly(path) : openSorageReadonlyWalAccess(path);
        } catch (error) {
          // The open threw, so no connection is owned here: a non-selectable
          // `-wal` refuses, a CANTOPEN over a now-frameless `-wal` re-selects
          // (a writer checkpointed and closed between the selection and the
          // open), and anything else renders the open's own failure.
          const reopened = walState(path);
          const refusal = walStateRefusal(reopened, path, surface);
          if (refusal !== null) return err(refusal);
          if (cannotOpen(error) && holdsNoFrames(reopened)) continue;
          return err(storageFailure(error, surface));
        }
        db = opened;
        source = "readonly-wal";
      }
      let rows: AppliedMigrationRow[];
      try {
        rows = readAppliedRows(db);
      } catch (error) {
        closeQuietly(db);
        const reopened = walState(path);
        const refusal = walStateRefusal(reopened, path, surface);
        if (refusal !== null) return err(refusal);
        if (source === "readonly-wal" && cannotOpen(error) && holdsNoFrames(reopened)) continue;
        return err(storageFailure(error, surface));
      }
      if (source === "readonly-wal") {
        const reopened = walState(path);
        // Every branch below is done with the connection, and the re-check can
        // no longer throw past a close: an owned connection is closed before
        // any refusal or retry interpretation leaves this block.
        if (!walHoldsFrames(reopened)) {
          closeQuietly(db);
          const refusal = walStateRefusal(reopened, path, surface);
          if (refusal !== null) return err(refusal);
          // The last writer's close emptied the WAL before this connection's
          // first read took its lock; the copy owns that state.
          continue;
        }
      }
      const refusal = schemaRefusal(rows);
      if (refusal !== null) {
        closeQuietly(db);
        return err(refusal);
      }
      return ok({ db, source, close: () => db.close() });
    }
    return err(captureExhausted(surface));
  } catch (error) {
    if (error instanceof TypedRefusal) return err(error.refusal);
    return err(storageFailure(error, surface));
  }
}

/** An internal typed refusal raised across a seam that only propagates throwables. */
class TypedRefusal extends Error {
  constructor(public readonly refusal: AppError) {
    super(refusal.message);
    this.name = "TypedRefusal";
  }
}

/**
 * A sidecar that exists but is not a regular file is refused exactly where the
 * read relies on it (a symlink is the main case, because `lstat` reports the
 * link's own length): the `-wal`'s length selects the path and SQLite reads
 * the `-wal` on the WAL path, so a non-regular `-wal` refuses everywhere — a
 * short link over a `-wal` holding uncheckpointed commits would otherwise
 * silently serve a copy that omits them; SQLite opens the `-shm` only on the
 * WAL path, so a non-regular `-shm` refuses only there; on the copy path the
 * read neither opens nor measures the `-shm`, so its type cannot affect what
 * the read returns and the copy serves it. The refusals carry the same
 * regular-file condition the history inspection raises
 * (`history-inspection.ts` requires a regular file), as typed integrity
 * refusals.
 */
function irregularSidecar(label: string, path: string): AppError {
  const refusal = appError("STORAGE_INTEGRITY_ERROR", `${label} is not a regular file: ${path}.`, {
    sidecarPath: path,
  });
  refusal.recovery = {
    suggestedCommand: "Diagnose the storage and obtain a bounded recovery decision; do not initialize over it",
  };
  return refusal;
}

/** The older-or-empty refusal of RDR-002; the catalogue carries its recovery. */
export function migrationRequired(appliedMaximum: number): AppError {
  const knownMaximum = knownSchemaMaximum();
  return appError(
    "STORAGE_MIGRATION_REQUIRED",
    `The database schema is at migration ${String(appliedMaximum)} while this build's known maximum is ${String(knownMaximum)}; this covered read never migrates.`,
    { appliedMaximum, knownMaximum },
  );
}

function schemaRefusal(rows: readonly AppliedMigrationRow[]): AppError | null {
  const admission = admitKnownAppliedHistory(rows);
  if (admission.kind !== "ok") return admission.error;
  const appliedMaximum = rows.reduce((maximum, row) => Math.max(maximum, row.version), 0);
  if (appliedMaximum < knownSchemaMaximum()) return migrationRequired(appliedMaximum);
  return null;
}

/** Preflight's finding for a missing operational database, with RDR-002's restore direction. */
function missingDatabase(path: string): AppError {
  const refusal = appError("STORAGE_INTEGRITY_ERROR", "The database is missing from a recognizable installation.", {
    databasePath: path,
  });
  refusal.recovery = {
    suggestedCommand:
      "Restore a verified backup into a fresh installation with sorage backup restore; do not initialize over this home",
  };
  return refusal;
}

function sidecarGap(surface: ContentionSurface | undefined): AppError {
  const cause =
    "the WAL sidecar is longer than its header without its -shm companion, which a zero-write read neither creates nor can read around";
  const refusal =
    surface === undefined
      ? appError("INTERNAL_ERROR", `Memo storage could not be opened: ${cause}.`, { cause })
      : contentionRefusal(surface, "open", cause);
  refusal.recovery = { suggestedCommand: SIDECAR_GAP_REPAIR };
  return refusal;
}

function captureExhausted(surface: ContentionSurface | undefined): AppError {
  const cause = "the database kept changing while a coherent read was being established";
  if (surface === undefined) {
    return appError(
      "INTERNAL_ERROR",
      `Memo storage could not be read coherently: ${cause}; retry when storage is quieter.`,
      {
        cause,
      },
    );
  }
  return contentionRefusal(surface, "lock", cause);
}

/**
 * Normalizes every engine or filesystem failure into a typed envelope: a
 * non-database image is an integrity refusal, contention keeps the invoking
 * family's stamped refusal, and anything else is a typed internal error. The
 * Memo composition has no contention surface, so its residual failures keep
 * the existing unclassified `INTERNAL_ERROR`.
 */
function storageFailure(error: unknown, surface: ContentionSurface | undefined): AppError {
  if (isNotADatabase(error)) {
    const refusal = appError("STORAGE_INTEGRITY_ERROR", "The database file is not a valid SQLite database.", {
      cause: String(error),
    });
    refusal.recovery = {
      suggestedCommand: "Diagnose the storage and obtain a bounded recovery decision; do not initialize over it",
    };
    return refusal;
  }
  if (surface !== undefined) {
    const contention = storageContentionOf(error, surface);
    if (contention !== null) return contention;
  }
  return appError(
    "INTERNAL_ERROR",
    `${surface === undefined ? "Memo storage" : "Storage"} could not be read: ${messageOf(error)}.`,
    { cause: String(error) },
  );
}

/**
 * Captures the complete main file of a database whose WAL holds no frames, or
 * returns null when the state changed under the capture — the main file's
 * identity stamp or size, a truncation, or a `-wal` that gained frames — in
 * which case the caller re-selects the path. The identity discipline is the
 * history inspector's: `O_RDONLY | O_NOFOLLOW`, the stamp compared through
 * the open descriptor and the path before and after the bytes are read.
 */
function captureQuiescentMainFile(path: string, ports: ReadAdmissionPorts): Buffer | null {
  let expected: BigIntStats;
  try {
    expected = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!expected.isFile()) throw new Error(`The database path is not a regular file: ${path}`);
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(expected)) return null;
    const size = Number(expected.size);
    const bytes = ports.readMainFile !== undefined ? ports.readMainFile(path, size) : readThrough(fd, size);
    if (bytes === null || bytes.byteLength !== size) return null;
    if (
      stamp(fstatSync(fd, { bigint: true })) !== stamp(expected) ||
      stamp(lstatSync(path, { bigint: true })) !== stamp(expected) ||
      !captureWalHoldsNoFrames(path)
    ) {
      return null;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Reads exactly `size` bytes through the open descriptor; a short read is a truncation under the capture. */
function readThrough(fd: number, size: number): Buffer | null {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, null);
    if (read === 0) return null;
    offset += read;
  }
  return bytes;
}

function openImage(
  bytes: Buffer,
  surface: ContentionSurface | undefined,
  ports: ReadAdmissionPorts,
): Result<SorageSqlite, AppError> {
  // SQLite's memdb VFS cannot open a WAL-mode image: header bytes 18/19 are
  // the only WAL indicator, and this buffer is the read's private copy, so the
  // pair is normalized to the legacy value without touching any page content.
  if (bytes.byteLength >= SQLITE_HEADER_BYTES) {
    if (bytes[18] === WAL_FORMAT_VERSION) bytes[18] = LEGACY_FORMAT_VERSION;
    if (bytes[19] === WAL_FORMAT_VERSION) bytes[19] = LEGACY_FORMAT_VERSION;
  }
  try {
    return ok((ports.openMemoryCopy ?? openSorageMemoryCopy)(bytes));
  } catch (error) {
    return err(storageFailure(error, surface));
  }
}

function stamp(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** The selection meaning of the `-wal`'s observed state; never throws, so an owned open connection can always be closed before interpretation. */
type WalSelection =
  | { kind: "absent" }
  | { kind: "irregular" }
  | { kind: "regular"; longerThanHeader: boolean }
  | { kind: "stat-failed"; error: unknown };

/** The `-wal`'s state for path selection; an existing non-regular file is never trusted by length. */
function walState(path: string): WalSelection {
  const stat = sidecarStat(`${path}-wal`);
  if (stat === "absent") return { kind: "absent" };
  if (stat === "irregular") return { kind: "irregular" };
  if (typeof stat === "object" && "kind" in stat) return { kind: "stat-failed", error: stat.error };
  return { kind: "regular", longerThanHeader: stat.size > WAL_HEADER_BYTES };
}

/** True when the observed `-wal` state means the WAL holds no frame (the copy owns the database). */
function holdsNoFrames(wal: WalSelection): boolean {
  return wal.kind === "absent" || (wal.kind === "regular" && !wal.longerThanHeader);
}

/** True when the observed `-wal` state means the WAL may hold frames and selects the WAL path. */
function walHoldsFrames(wal: WalSelection): boolean {
  return wal.kind === "regular" && wal.longerThanHeader;
}

/** The refusal for a `-wal` state that selects no path — an irregular file or a failed stat — or null when the state is selectable. */
function walStateRefusal(wal: WalSelection, path: string, surface: ContentionSurface | undefined): AppError | null {
  if (wal.kind === "irregular") return irregularSidecar("WAL sidecar", `${path}-wal`);
  if (wal.kind === "stat-failed") return storageFailure(wal.error, surface);
  return null;
}

/**
 * The copy's own re-check: true when the `-wal` still holds no frame, so the
 * capture stays valid. An irregular `-wal` throws the typed integrity refusal
 * and an unstatable one the raw stat error, and both propagate to the outer
 * catch — the irregular one as its typed refusal, the stat failure as a typed
 * envelope — instead of being treated as a race. No connection is open on the
 * copy path, so throwing across the capture seam is safe here.
 */
function captureWalHoldsNoFrames(path: string): boolean {
  const wal = walState(path);
  if (wal.kind === "irregular") throw new TypedRefusal(irregularSidecar("WAL sidecar", `${path}-wal`));
  if (wal.kind === "stat-failed") throw wal.error;
  return holdsNoFrames(wal);
}

/** The observed state of a sidecar path; `lstat` sees symlinks as non-regular, never following them. */
function sidecarStat(
  path: string,
): "absent" | "irregular" | { size: number } | { kind: "stat-failed"; error: unknown } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return { kind: "stat-failed", error };
  }
  if (!stat.isFile()) return "irregular";
  return { size: stat.size };
}

function closeQuietly(db: SorageSqlite): void {
  try {
    db.close();
  } catch {
    // The refusal already carries the outcome; a failed close adds nothing.
  }
}

function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cannotOpen(error: unknown): boolean {
  const code = codeOf(error);
  if (code === "SQLITE_CANTOPEN" || code === "ERR_SQLITE_CANTOPEN") return true;
  return /unable to open database file/i.test(messageOf(error));
}

function isNotADatabase(error: unknown): boolean {
  const code = codeOf(error);
  if (
    code === "SQLITE_NOTADB" ||
    code === "ERR_SQLITE_NOTADB" ||
    code === "SQLITE_CORRUPT" ||
    code === "ERR_SQLITE_CORRUPT"
  )
    return true;
  return /file is not a database|database disk image is malformed/i.test(messageOf(error));
}
