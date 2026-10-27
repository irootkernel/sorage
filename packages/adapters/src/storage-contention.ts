import { type AppError, appError } from "@sorage/core";
import {
  MigrationConnectionError,
  MigrationFailedError,
  MigrationIntegrityError,
  SchemaAdmissionError,
} from "./sqlite/migrator";

/**
 * The SHR-015 storage-preparation contention classification (ADR-0032's
 * 2026-10-21 amendment, extended to write-protected storage by the 2026-10-22
 * amendment): one detection helper and one typed carrier shared by the
 * Channel, Handoff, and Project compositions. Detection recognizes only the
 * engine's contention and unavailability signatures — a busy lock, an
 * unopenable database, and a write-protected database the invocation cannot
 * write — so schema admission, the migrator's committed-versus-unusable
 * connection split, integrity refusals, and every other condition keep their
 * existing codes; the refusal is marked with `details.storageContention` and
 * carries the invoking family's message and recovery so no later seam
 * relabels same-code errors.
 */

/** The invoking command family whose wording the refusal carries. */
export type ContentionSurface = "channel" | "handoff" | "project" | "memo";

/** A composition-thrown error that already carries its typed public error. */
export class AppCommandError extends Error {
  constructor(public readonly error: AppError) {
    super(error.message);
    this.name = "AppCommandError";
  }
}

/** Returns the carried typed error when the throwable is the carrier. */
export function asAppCommandError(error: unknown): AppCommandError | null {
  return error instanceof AppCommandError ? error : null;
}

const LOCK_CODES = new Set(["SQLITE_BUSY", "ERR_SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_LOCKED"]);
const OPEN_CODES = new Set(["SQLITE_CANTOPEN", "ERR_SQLITE_CANTOPEN"]);
const READONLY_CODES = new Set(["SQLITE_READONLY", "ERR_SQLITE_READONLY"]);
const LOCKED_MESSAGE = /database is locked/i;
const UNOPENABLE_MESSAGE = /unable to open database file/i;
const READONLY_MESSAGE = /attempt to write a readonly database/i;

export type ContentionKind = "lock" | "open" | "readonly";

function codeOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "code" in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function messageOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

function kindOfCandidate(value: unknown): ContentionKind | null {
  const code = codeOf(value);
  if (code !== undefined) {
    if (LOCK_CODES.has(code)) return "lock";
    if (OPEN_CODES.has(code)) return "open";
    if (READONLY_CODES.has(code)) return "readonly";
  }
  const message = messageOf(value);
  if (message !== undefined) {
    if (LOCKED_MESSAGE.test(message)) return "lock";
    if (UNOPENABLE_MESSAGE.test(message)) return "open";
    if (READONLY_MESSAGE.test(message)) return "readonly";
  }
  if (typeof value === "object" && value !== null && "details" in value) {
    const details = (value as { details?: unknown }).details;
    if (typeof details === "object" && details !== null && "cause" in details) {
      const cause = (details as { cause?: unknown }).cause;
      if (typeof cause === "string") {
        if (LOCKED_MESSAGE.test(cause)) return "lock";
        if (UNOPENABLE_MESSAGE.test(cause)) return "open";
        if (READONLY_MESSAGE.test(cause)) return "readonly";
      }
    }
  }
  return null;
}

/**
 * Walks the error, its cause chain, a wrapped migration step failure's
 * preserved cause, and already-mapped `details.cause` strings, returning the
 * first contention signature found. The migrator's own refusal classes are
 * excluded by name: a restoration, integrity, or admission outcome never
 * becomes the contention refusal regardless of message text.
 */
function contentionKindOf(error: unknown): ContentionKind | null {
  const seen: unknown[] = [];
  const visit = (value: unknown, depth: number): ContentionKind | null => {
    if (depth > 4 || typeof value !== "object" || value === null) return null;
    if (seen.includes(value)) return null;
    seen.push(value);
    if (
      value instanceof SchemaAdmissionError ||
      value instanceof MigrationConnectionError ||
      value instanceof MigrationIntegrityError
    ) {
      return null;
    }
    if (value instanceof MigrationFailedError) {
      // The step failure preserved its cause; only that cause decides.
      return visit(value.causeOfFailure, depth + 1);
    }
    const kind = kindOfCandidate(value);
    if (kind !== null) return kind;
    if (value instanceof Error && value.cause !== undefined) {
      const nested = visit(value.cause, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  return visit(error, 0);
}

const CONDITION: Record<ContentionKind, string> = {
  open: "opening the Sorage database did not succeed",
  lock: "locking the Sorage database did not succeed within the busy timeout",
  readonly: "the Sorage database cannot be written by this invocation",
};

function refusalMessage(surface: ContentionSurface, kind: ContentionKind): string {
  const head = surface === "channel" ? "Channel command" : "command";
  const state = kind === "readonly" ? "is write-protected" : "is contended";
  const family = { channel: "Channel", handoff: "Handoff", project: "Project", memo: "Memo" }[surface];
  return `${family} storage ${state}: ${CONDITION[kind]}, so this ${head} committed none of the changes it was asked to make.`;
}

/**
 * Recoveries are per state, never per action: contention quiets down and an
 * identical retry converges, while write protection is repaired first — the
 * restore-access recovery never suggests a quieter-storage retry, a fresh
 * idempotency key, a mode switch, or an authority flag. Both replay-only
 * inspections preserve their original mode and material; send inspection
 * writes no installation data but needs writable private temporary scratch.
 */
const RECOVERY: Record<ContentionSurface, Record<ContentionKind, string>> = {
  channel: {
    lock: "Retry the same channel command when storage is quieter; it committed none of the changes it was asked to make.",
    open: "Retry the same channel command when storage is quieter; it committed none of the changes it was asked to make.",
    readonly:
      "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical channel command; it committed none of the changes it was asked to make.",
  },
  handoff: {
    lock: "Retry the same command with its original mode, input, and idempotency key when storage is quieter; after an unknown send outcome inspect with sorage send --replay-only first.",
    open: "Retry the same command with its original mode, input, and idempotency key when storage is quieter; after an unknown send outcome inspect with sorage send --replay-only first.",
    readonly:
      "In a permitted writable execution context, retry the identical command with the original mode, inputs, and idempotency key. For an unknown send outcome, inspect the original material with sorage send --replay-only first: it writes no Sorage home or Vault data but needs writable private temporary scratch. If that scratch is denied and an already permitted MCP server is available, use handoff_send with replayOnly: true and the same Installation and sender context; never execute again or replace the key automatically.",
  },
  project: {
    lock: "Retry the same command when storage is quieter; it committed none of the changes it was asked to make.",
    open: "Retry the same command when storage is quieter; it committed none of the changes it was asked to make.",
    readonly:
      "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical command; it committed none of the changes it was asked to make.",
  },
  memo: {
    lock: "Retry the identical Memo command when storage is available, preserving the current mode, original inputs, observed version, Project/Installation and key when present. An earlier unknown outcome still requires replay-only; never switch to execution or replace the key.",
    open: "Retry the identical Memo command when storage is available, preserving the current mode, original inputs, observed version, Project/Installation and key when present. An earlier unknown outcome still requires replay-only; never switch to execution or replace the key.",
    readonly:
      "Use a permitted writable execution context or the matching Memo tool on an already permitted MCP server, preserving the current mode, original inputs, observed version, Project/Installation and key when present. An earlier unknown outcome still requires replay-only; this refusal does not authorize execution, a replacement key or permission changes.",
  },
};

/**
 * Maps a storage-preparation failure onto the marked, surface-stamped
 * `STORAGE_INSPECTION_UNAVAILABLE` refusal, or null when the signature is not
 * contention or unavailability. Callers pass the invoking family's surface so
 * the message and recovery follow the invoking command, never the storing
 * adapter (SHR-015, ADR-0032's 2026-10-21 amendment).
 */
export function storageContentionOf(error: unknown, surface: ContentionSurface): AppError | null {
  const kind = contentionKindOf(error);
  if (kind === null) return null;
  return contentionRefusal(surface, kind, String(error));
}

/**
 * The same stamped refusal built directly from a storage state the caller
 * detected itself, before or without an engine error to classify (SHR-015):
 * the covered read path uses it for its sidecar-gap and capture-exhaustion
 * states, which no thrown signature represents.
 */
export function contentionRefusal(surface: ContentionSurface, kind: ContentionKind, cause: string): AppError {
  const refusal = appError(
    "STORAGE_INSPECTION_UNAVAILABLE",
    refusalMessage(surface, kind),
    surface === "memo" ? { storageContention: true } : { storageContention: true, cause },
  );
  refusal.recovery = { suggestedCommand: RECOVERY[surface][kind] };
  return refusal;
}

/** The typed carrier for configuration conditions; surface-independent by design (W7). */
export function carriedAppError(error: AppError): AppCommandError {
  return new AppCommandError(error);
}
