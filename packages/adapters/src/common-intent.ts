import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, readSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AppError,
  appError,
  classifyContentIntentOwnership,
  type CommonContentFailureReason,
  commonContentFailureMetadata,
  commonContentSuccessMetadata,
  contentIntentIntegrityError,
  type ContentOwnerDomain,
  err,
  isManagedContentStorageKey,
  ok,
  type Result,
  SYSTEM_ACTOR,
} from "@sorage/core";
import { STREAM_BUFFER_BYTES } from "./content-file-io";
import type { SqliteEventLedger } from "./events";
import { fsyncDirectory } from "./fs-atomic";
import {
  isSafeVaultRelativePath,
  managedFile,
  managedPath,
  openManagedFile,
  UnsafeManagedPathError,
} from "./managed-paths";
import type { SorageSqlite } from "./sqlite/connection";
import { runInTransaction } from "./sqlite/transaction";

const READ_ONLY_MODE = 0o444;

/** The committed outcome of one common intent's filesystem assessment. */
export type CommonExecutionOutcome = { status: "done" } | { status: "failed"; reason: CommonContentFailureReason };

/** What the shared completion transaction observed. */
export type CommonCompletion =
  | { status: "completed" }
  | { status: "already-completed" }
  | { status: "failed"; reason: CommonContentFailureReason; attempt: number };

/** One common intent row as the completion transaction re-reads it. */
export interface CommonIntentRow {
  id: string;
  op: "activate" | "unlink";
  fromPath: string | null;
  toPath: string;
  ownerDomain: ContentOwnerDomain;
  ownerId: string;
  contentId: string;
  attempts: number;
}

interface PendingRow {
  id: string;
  op: string;
  from_path: string | null;
  to_path: string;
  artifact_id: string | null;
  owner_domain: string | null;
  owner_id: string | null;
  content_id: string | null;
  created_at: string;
  attempts: number;
}

/**
 * The one shared completion transaction for common intents (SHR-005, section
 * 10.1), used by both the ordinary mutation completion and the start-up drain:
 * a done assessment marks the record materialized or completes the unlink,
 * clears the intent, and appends its success event in the same transaction,
 * with an inside-transaction recheck so a competing or repeated drain that
 * finds an already-completed intent appends no duplicate success; a failed
 * assessment retains the intent, bumps its attempts, and appends exactly one
 * failure event with the closed failure metadata.
 */
export function completeCommonIntentTx(
  db: SorageSqlite,
  ledger: SqliteEventLedger,
  intentId: string,
  outcome: CommonExecutionOutcome,
  stamps: { eventIds?: (() => string) | undefined; now?: (() => string) | undefined } = {},
): Result<CommonCompletion, AppError> {
  return runInTransaction<CommonCompletion>(
    db,
    "BEGIN IMMEDIATE",
    () => {
      const row = db.prepare("SELECT * FROM pending_fs_ops WHERE id = ?").get(intentId) as
        | PendingRow
        | null
        | undefined;
      if (row === null || row === undefined) {
        // A competing drain already completed this intent: no state to change,
        // and no duplicate success event (section 10.1).
        return ok({ status: "already-completed" as const });
      }
      if (
        classifyContentIntentOwnership({
          id: row.id,
          artifactId: row.artifact_id,
          ownerDomain: row.owner_domain,
          ownerId: row.owner_id,
          contentId: row.content_id,
        }) !== "common"
      ) {
        return err(contentIntentIntegrityError(row.id));
      }
      const identity = {
        contentId: row.content_id as string,
        ownerDomain: row.owner_domain as ContentOwnerDomain,
        ownerId: row.owner_id as string,
        intentId: row.id,
        operation: row.op === "unlink" ? ("unlink" as const) : ("activate" as const),
      };
      const attempt = Number(row.attempts) + 1;
      if (outcome.status === "done") {
        if (row.op === "activate") {
          db.prepare("UPDATE content_records SET materialized = 1 WHERE id = ?").run(row.content_id);
        }
        db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(row.id);
        const eventType = row.op === "unlink" ? "CONTENT_UNLINKED" : "CONTENT_ACTIVATED";
        ledger.appendNow({
          eventType,
          actor: SYSTEM_ACTOR,
          metadata: commonContentSuccessMetadata(identity),
          id: stamps.eventIds !== undefined ? stamps.eventIds() : crypto.randomUUID(),
          createdAt: stamps.now !== undefined ? stamps.now() : new Date().toISOString(),
        });
        return ok({ status: "completed" as const });
      }
      db.prepare("UPDATE pending_fs_ops SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      ledger.appendNow({
        eventType: "CONTENT_INTEGRITY_FAILED",
        actor: SYSTEM_ACTOR,
        metadata: commonContentFailureMetadata(identity, { attempt, reason: outcome.reason }),
        id: stamps.eventIds !== undefined ? stamps.eventIds() : crypto.randomUUID(),
        createdAt: stamps.now !== undefined ? stamps.now() : new Date().toISOString(),
      });
      return ok({ status: "failed" as const, reason: outcome.reason, attempt });
    },
    {
      checkFence: false,
      failure: (error) =>
        appError("INTERNAL_ERROR", `Completing the common intent ${intentId} failed: ${messageOf(error)}.`, {
          intentId,
          cause: String(error),
        }),
    },
  );
}

/**
 * Executes one common `activate` against the filesystem state it finds (SHR-005,
 * section 10.1): neither side of a both-present destination conflict is touched,
 * a source-absent/destination-present retry completes only after the recorded
 * destination's size and hash are verified, and every failure maps onto the
 * closed common reasons without synthesizing success.
 */
export function activateCommonFile(input: {
  vaultPath: string;
  fromPath: string;
  toPath: string;
  expect: { sizeBytes: number; sha256: string };
}): CommonExecutionOutcome {
  if (!isSafeVaultRelativePath(input.fromPath) || !isManagedContentStorageKey(input.toPath))
    return { status: "failed", reason: "unsafe_path" };
  try {
    const source = managedFile(input.vaultPath, input.fromPath);
    const destination = managedFile(input.vaultPath, input.toPath);
    if (source.stat !== undefined && destination.stat !== undefined) {
      const refreshedSource = managedFile(input.vaultPath, input.fromPath);
      if (refreshedSource.stat !== undefined) return { status: "failed", reason: "destination_conflict" };
      return durableVerifiedDestination(input.vaultPath, input.toPath, input.expect);
    }
    if (source.stat !== undefined) {
      const target = managedPath(input.vaultPath, input.toPath, true);
      try {
        renameSync(source.path, target);
      } catch (error) {
        if (
          managedFile(input.vaultPath, input.fromPath).stat === undefined &&
          managedFile(input.vaultPath, input.toPath).stat !== undefined
        ) {
          return durableVerifiedDestination(input.vaultPath, input.toPath, input.expect);
        }
        throw error;
      }
      fsyncDirectory(dirname(target));
      try {
        chmodSync(target, READ_ONLY_MODE);
      } catch {
        // Read-only is best effort where the filesystem supports it (VLT-008);
        // the content census reports the condition.
      }
      return { status: "done" };
    }
    if (destination.stat !== undefined) {
      return durableVerifiedDestination(input.vaultPath, input.toPath, input.expect);
    }
    return { status: "failed", reason: "missing_content" };
  } catch (error) {
    return { status: "failed", reason: error instanceof UnsafeManagedPathError ? "unsafe_path" : "io_error" };
  }
}

function durableVerifiedDestination(
  vaultPath: string,
  toPath: string,
  expect: { sizeBytes: number; sha256: string },
): CommonExecutionOutcome {
  const verified = verifyDestination(vaultPath, toPath, expect);
  if (verified.status !== "done") return verified;
  const target = managedPath(vaultPath, toPath);
  fsyncDirectory(dirname(target));
  try {
    chmodSync(target, READ_ONLY_MODE);
  } catch {
    // Read-only is best effort where the filesystem supports it (VLT-008);
    // the content census reports the condition.
  }
  return verified;
}

/** Missing targets converge; unsafe entries retain the intent and are never followed. */
export function unlinkCommonFile(input: { vaultPath: string; toPath: string }): CommonExecutionOutcome {
  if (!isManagedContentStorageKey(input.toPath)) return { status: "failed", reason: "unsafe_path" };
  try {
    const target = managedFile(input.vaultPath, input.toPath);
    if (target.stat === undefined) return { status: "done" };
    try {
      unlinkSync(target.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsyncDirectory(dirname(target.path));
    return { status: "done" };
  } catch (error) {
    return { status: "failed", reason: error instanceof UnsafeManagedPathError ? "unsafe_path" : "io_error" };
  }
}

/**
 * The drain's executor for one common intent: the activate arm reads its
 * record's recorded size and digest for the destination verification, and a
 * record that has already vanished is `missing_content`, never a synthesized
 * success. Never runs inside a transaction.
 */
export function executeCommonIntent(
  db: SorageSqlite,
  intent: { op: "activate" | "unlink"; fromPath: string | null; toPath: string; contentId: string | null },
  vaultPath: string,
): CommonExecutionOutcome {
  if (intent.op === "unlink") {
    return unlinkCommonFile({ vaultPath, toPath: intent.toPath });
  }
  if (intent.contentId === null) {
    return { status: "failed", reason: "missing_content" };
  }
  const row = db.prepare("SELECT size_bytes, sha256 FROM content_records WHERE id = ?").get(intent.contentId) as
    | { size_bytes: number; sha256: string }
    | null
    | undefined;
  if (row === null || row === undefined) {
    return { status: "failed", reason: "missing_content" };
  }
  return activateCommonFile({
    vaultPath,
    fromPath: intent.fromPath ?? "",
    toPath: intent.toPath,
    expect: { sizeBytes: Number(row.size_bytes), sha256: row.sha256 },
  });
}

function verifyDestination(
  root: string,
  key: string,
  expect: { sizeBytes: number; sha256: string },
): CommonExecutionOutcome {
  let handle: number | undefined;
  try {
    handle = openManagedFile(root, key);
    if (fstatSync(handle).size !== expect.sizeBytes) return { status: "failed", reason: "size_mismatch" };
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
    let total = 0;
    for (;;) {
      const count = readSync(handle, buffer, 0, Math.min(buffer.length, expect.sizeBytes - total + 1), null);
      if (count === 0) break;
      total += count;
      if (total > expect.sizeBytes) return { status: "failed", reason: "size_mismatch" };
      digest.update(buffer.subarray(0, count));
    }
    if (total !== expect.sizeBytes) return { status: "failed", reason: "size_mismatch" };
    if (digest.digest("hex").toLowerCase() !== expect.sha256.toLowerCase())
      return { status: "failed", reason: "checksum_mismatch" };
    return { status: "done" };
  } catch (error) {
    return { status: "failed", reason: error instanceof UnsafeManagedPathError ? "unsafe_path" : "io_error" };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
