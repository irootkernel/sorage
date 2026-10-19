import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AppError,
  appError,
  type DrainReport,
  err,
  type GarbageCollectionOptions,
  type GarbageCollectionReport,
  type IntentLog,
  isManagedStorageKey,
  type NewPendingFsOp,
  ok,
  type PendingFsOp,
  type Result,
  SYSTEM_ACTOR,
} from "@sorage/core";
import { createSqliteEventLedger, type SqliteEventLedger } from "./events";
import { completeCommonIntentTx, executeCommonIntent } from "./content-store";
import { classifyContentIntentOwnership, contentIntentIntegrityError } from "@sorage/core";
import { vaultMoveLockHeld } from "./lockfile";
import type { SorageSqlite } from "./sqlite/connection";
import { openVault } from "./vault";
import { UnsafeManagedPathError, managedDirectory, managedFile, type managedLstat } from "./managed-paths";

export interface SqliteIntentLogOptions {
  db: SorageSqlite;
  installationId: string;
  /** When provided, a live vault-move.lock pauses the drain with SERVICE_PAUSED (RUN-014). */
  runDir?: string | undefined;
  /** When provided, the drain appends ARTIFACT_INTEGRITY_FAILED into the ledger (SEC-012). */
  events?: SqliteEventLedger | undefined;
  /** When provided, a deterministic clock for ledger timestamps in tests. */
  now?: (() => string) | undefined;
  /** When provided, a deterministic id source for ledger rows in tests. */
  eventIds?: (() => string) | undefined;
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
 * The SQLite intent log (ADR-0013, VLT-021, VLT-022, RUN-002): `record` commits
 * intents in one transaction, `drain` executes every outstanding intent against
 * the filesystem state it finds and clears the resolved ones in a second
 * transaction, and `clear` is the mutation path's completion commit. The
 * durability order of write, fsync file, rename, fsync parent directory, then
 * the completion commit is spread across the caller's staging (already written
 * and fsynced), the rename plus parent fsync here, and the clearing
 * transaction; no filesystem I/O happens inside a transaction.
 */
export function createSqliteIntentLog(options: SqliteIntentLogOptions): IntentLog {
  const { db, installationId } = options;

  function toPending(row: PendingRow): PendingFsOp {
    return {
      id: row.id,
      op: row.op === "unlink" ? "unlink" : "activate",
      fromPath: row.from_path,
      toPath: row.to_path,
      artifactId: row.artifact_id,
      ownerDomain: row.owner_domain as PendingFsOp["ownerDomain"],
      ownerId: row.owner_id,
      contentId: row.content_id,
      createdAt: row.created_at,
      attempts: row.attempts,
    };
  }

  function listPending(): Result<PendingFsOp[], AppError> {
    const rows = db.prepare<PendingRow>("SELECT * FROM pending_fs_ops ORDER BY created_at, id").all();
    for (const row of rows) {
      if (
        classifyContentIntentOwnership({
          id: row.id,
          artifactId: row.artifact_id,
          ownerDomain: row.owner_domain,
          ownerId: row.owner_id,
          contentId: row.content_id,
        }) === "invalid"
      ) {
        return err(contentIntentIntegrityError(row.id));
      }
    }
    return ok(rows.map(toPending));
  }

  return {
    record(intents: NewPendingFsOp[]): Result<{ recorded: number }, AppError> {
      for (const intent of intents) {
        if (classifyContentIntentOwnership(intent) === "invalid") {
          return err(
            appError(
              "INTERNAL_ERROR",
              `Filesystem intent ${intent.id} must carry either legacy ownership or a complete common-content owner triple.`,
            ),
          );
        }
      }
      // A committed intent is a promise about the current Vault, so it may not
      // be committed around a relocation that would relocate the promise's
      // filesystem underneath it (RUN-014).
      if (options.runDir !== undefined && vaultMoveLockHeld(options.runDir)) {
        return err(
          appError(
            "SERVICE_PAUSED",
            "A Vault move or restore is in progress; the intent commit paused instead of racing it.",
            { lockPath: join(options.runDir, "vault-move.lock") },
          ),
        );
      }
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          // The vault-move fence is read inside the transaction so the mover's
          // fence-and-count and this commit serialize on the database write lock:
          // whichever wins, the other sees it, and a promise can never land between
          // the mover's re-count and the configuration switch. A fence whose pid is
          // dead is stale and ignored, exactly like a stale lockfile.
          const paused = liveFencePaused(db);
          if (paused) {
            db.exec("ROLLBACK");
            return err(
              appError(
                "SERVICE_PAUSED",
                "A Vault move or restore is in progress; the intent commit paused instead of racing it.",
                {
                  moveFencePid: paused.pid,
                },
              ),
            );
          }
          const insert = db.prepare(
            "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
          );
          for (const intent of intents) {
            insert.run(
              intent.id,
              intent.op,
              intent.fromPath,
              intent.toPath,
              intent.artifactId,
              intent.ownerDomain ?? null,
              intent.ownerId ?? null,
              intent.contentId ?? null,
              intent.createdAt,
            );
          }
          db.exec("COMMIT");
          return ok({ recorded: intents.length });
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction never opened or the connection already rolled back.
          }
          throw transactionError;
        }
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Recording filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    pending(): Result<PendingFsOp[], AppError> {
      try {
        return listPending();
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading pending filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    drain(vaultPath: string): Result<DrainReport, AppError> {
      const paused = (): boolean => options.runDir !== undefined && vaultMoveLockHeld(options.runDir);
      const pauseError = (): AppError =>
        appError(
          "SERVICE_PAUSED",
          "A Vault move or restore is in progress; the intent drain paused instead of racing it.",
          { lockPath: options.runDir === undefined ? undefined : join(options.runDir, "vault-move.lock") },
        );
      // The lock is re-checked before every intent, not only at entry, so a move
      // that starts mid-drain cannot switch the Vault underneath in-flight
      // renames (RUN-014).
      if (paused()) return err(pauseError());
      const opened = openVault(vaultPath, installationId);
      if (!opened.ok) return err(opened.error);
      const report: DrainReport = { resolved: [], integrityFailed: [], commonFailures: [] };

      /**
       * The completion commit: one short transaction per intent that rechecks
       * the row, bumps attempts, and deletes it only when the effect is
       * complete. A done assessment appends ARTIFACT_ACTIVATED or
       * ARTIFACT_UNLINKED inside this same transaction when its own DELETE
       * actually cleared the row, so a competing drain cannot double-append;
       * an integrity failure appends ARTIFACT_INTEGRITY_FAILED the same way,
       * so the ledger and the surviving intent row agree (SEC-012,
       * security section 10: the completion transaction that removes the
       * intent records what actually happened on disk). The classification
       * separates a real clear — this invocation's own DELETE winner, or a
       * competitor's clear observed at the live recheck — from a retained
       * failure assessment whose row survives: only a real clear is progress
       * that may release deferred work, never an attempt increment or an
       * appended event.
       */
      const settle = (
        intent: PendingFsOp,
        outcome: "done" | "both-gone" | "destination-conflict" | "unsafe-path",
      ): Result<"own-clear" | "observed-clear" | "retained", AppError> => {
        db.exec("BEGIN IMMEDIATE");
        try {
          // Recheck before any attempt, state, or event: a competing drain may
          // have completed this intent while this process waited, and a stale
          // row must change no state and append no false failure — the
          // competitor's clear is still real progress for deferred work.
          const live = db.prepare("SELECT id FROM pending_fs_ops WHERE id = ?").get(intent.id) as
            | { id: string }
            | null
            | undefined;
          if (live === null || live === undefined) {
            db.exec("COMMIT");
            return ok("observed-clear");
          }
          db.prepare("UPDATE pending_fs_ops SET attempts = attempts + 1 WHERE id = ?").run(intent.id);
          if (outcome === "done") {
            const cleared = db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(intent.id) as {
              changes: number;
            };
            if (cleared.changes === 1) {
              // The authoritative record state belongs to the winning
              // completion transaction exactly as the event does: a stale
              // executor that lost the row mutates nothing (SHR-004). The
              // physical target is pinned to the persisted intent's exact
              // stored key on both arms — the current-Artifact join and the
              // retained-record fallback — so a mismatched record is never
              // flipped (section 3).
              if (intent.op === "activate" && intent.artifactId !== null) {
                db.prepare(
                  "UPDATE content_records SET materialized = 1 WHERE storage_key = ? AND inline_text IS NULL AND (id = (SELECT content_record_id FROM artifacts WHERE id = ?) OR materialized = 0)",
                ).run(intent.toPath, intent.artifactId);
              }
              if (options.events !== undefined) {
                // Associations and hashes come only from an authoritative
                // Artifact row read inside this transaction; when the row is
                // gone the association stays null and the unavailable sha256 is
                // omitted rather than invented, and never derived from a
                // pathname. storageKey itself is the persisted intent's own.
                const artifact =
                  intent.artifactId === null
                    ? null
                    : ((db
                        .prepare(
                          "SELECT a.handoff_id, cr.sha256 FROM artifacts a JOIN content_records cr ON cr.id = a.content_record_id WHERE a.id = ?",
                        )
                        .get(intent.artifactId) as { handoff_id: string; sha256: string } | null | undefined) ?? null);
                const metadata: Record<string, unknown> = { storageKey: intent.toPath };
                if (intent.op === "activate" && artifact !== null) {
                  metadata.sha256 = artifact.sha256;
                }
                options.events.appendNow({
                  eventType: intent.op === "unlink" ? "ARTIFACT_UNLINKED" : "ARTIFACT_ACTIVATED",
                  actor: SYSTEM_ACTOR,
                  metadata,
                  handoffId: artifact === null ? null : artifact.handoff_id,
                  id: options.eventIds !== undefined ? options.eventIds() : crypto.randomUUID(),
                  createdAt: options.now !== undefined ? options.now() : new Date().toISOString(),
                });
              }
            }
          } else if (options.events !== undefined) {
            const handoffId =
              intent.artifactId === null
                ? null
                : ((
                    db.prepare("SELECT handoff_id FROM artifacts WHERE id = ?").get(intent.artifactId) as
                      | { handoff_id: string }
                      | null
                      | undefined
                  )?.handoff_id ?? null);
            options.events.appendNow({
              eventType: "ARTIFACT_INTEGRITY_FAILED",
              actor: SYSTEM_ACTOR,
              metadata: {
                intentId: intent.id,
                op: intent.op,
                toPath: intent.toPath,
                artifactId: intent.artifactId,
                reason: outcome,
              },
              handoffId,
              id: options.eventIds !== undefined ? options.eventIds() : crypto.randomUUID(),
              createdAt: options.now !== undefined ? options.now() : new Date().toISOString(),
            });
          }
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction was never opened or was already rolled back.
          }
          return err(
            appError("INTERNAL_ERROR", `Completing intent ${intent.id} failed: ${messageOf(error)}.`, {
              intentId: intent.id,
              cause: String(error),
            }),
          );
        }
        if (outcome === "done") {
          report.resolved.push(intent.id);
          return ok("own-clear");
        }
        report.integrityFailed.push({
          id: intent.id,
          op: intent.op,
          toPath: intent.toPath,
          artifactId: intent.artifactId,
          event: "ARTIFACT_INTEGRITY_FAILED",
          reason: outcome,
        });
        // The failure assessment settled without clearing the row: the intent
        // stays durable and is never progress for deferred work.
        return ok("retained");
      };

      /**
       * One real attempt through the shared execution boundary. The common
       * Memo/Channel arm keeps its own executor and contract; the legacy arm
       * runs the dependency-aware executor whose deferral performs no
       * filesystem effect, clear, attempt increment, event, or failure report.
       * Thrown physical I/O settles against the live row: when a competitor
       * already cleared it, this stale executor appends no false failure and
       * rethrows nothing (section 3).
       */
      const attempt = (
        intent: PendingFsOp,
      ): Result<"own-clear" | "observed-clear" | "retained" | "deferred", AppError> => {
        if (intent.ownerDomain !== null && intent.ownerId !== null && intent.contentId !== null) {
          // The common content-intent arm of the M9 drain (SHR-005, section
          // 10.1): execution follows the common semantics — a both-present
          // destination conflict retains both files, a source-absent retry
          // completes only after size and hash verification — and completion
          // runs through the same shared transaction the ordinary mutation
          // path uses, so a competing drain appends no duplicate success. A
          // completion is a real clear (own or already-observed competitor);
          // a retained common failure is not progress.
          const outcome = executeCommonIntent(db, intent, vaultPath);
          const ledger = options.events ?? createSqliteEventLedger(db);
          const completion = completeCommonIntentTx(db, ledger, intent.id, outcome, {
            eventIds: options.eventIds,
            now: options.now,
          });
          if (!completion.ok) return err(completion.error);
          if (completion.value.status === "failed") {
            report.commonFailures.push({
              intentId: intent.id,
              contentId: intent.contentId as string,
              ownerDomain: intent.ownerDomain as "memo" | "channel",
              ownerId: intent.ownerId as string,
              reason: completion.value.reason,
            });
            return ok("retained");
          }
          report.resolved.push(intent.id);
          return ok(completion.value.status === "already-completed" ? "observed-clear" : "own-clear");
        }
        let outcome: "done" | "both-gone" | "destination-conflict" | "unsafe-path";
        try {
          const executed = executeLegacyIntent(db, intent, vaultPath);
          if (!executed.ok) return err(executed.error);
          if (executed.value === "deferred") return ok("deferred");
          outcome = executed.value;
        } catch (ioError) {
          // A thrown physical assessment is not a failure until the exact row
          // is still live: a competitor that already completed this intent
          // means the throw is a stale executor's late observation, recorded as
          // nothing at all — and that competitor's clear is real progress.
          const live = db.prepare("SELECT id FROM pending_fs_ops WHERE id = ?").get(intent.id) as
            | { id: string }
            | null
            | undefined;
          if (live === null || live === undefined) return ok("observed-clear");
          throw ioError;
        }
        const settled = settle(intent, outcome);
        if (!settled.ok) return settled;
        return ok(settled.value);
      };

      try {
        // The finite initial set: each intent receives exactly one real
        // physical attempt in this invocation, whatever unrelated intents do,
        // so unrelated successes never retry a failed activation (section 3).
        const pending = listPending();
        if (!pending.ok) return pending;
        const deferred: PendingFsOp[] = [];
        let progressed = false;
        for (const intent of pending.value) {
          if (paused()) return err(pauseError());
          const attempted = attempt(intent);
          if (!attempted.ok) return attempted;
          if (attempted.value === "deferred") deferred.push(intent);
          // Only an actually cleared row is progress: an own winner's DELETE or
          // a competitor's clear observed at a live recheck. A retained failure
          // assessment, an attempt increment, or an appended event never
          // releases deferred work and never fakes an empty queue.
          if (attempted.value === "own-clear" || attempted.value === "observed-clear") progressed = true;
        }
        // Deferred work is reconsidered exactly once more, and only after this
        // invocation's own actual progress: an activation resolved above can
        // release its dependent unlink now, while a still-blocked or failed
        // intent is never handed a second physical attempt here.
        if (progressed && deferred.length > 0) {
          const requeued = listPending();
          if (!requeued.ok) return requeued;
          const stillPending = new Map(requeued.value.map((row) => [row.id, row]));
          for (const intent of deferred) {
            const current = stillPending.get(intent.id);
            if (current === undefined) continue;
            if (paused()) return err(pauseError());
            const attempted = attempt(current);
            if (!attempted.ok) return attempted;
            // A second deferral stays durable for the next drain; there is no
            // further reconsideration within this invocation.
          }
        }
        return ok(report);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Draining pending filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },

    clear(intentIds: string[]): Result<{ cleared: number }, AppError> {
      if (intentIds.length === 0) return ok({ cleared: 0 });
      try {
        db.exec("BEGIN IMMEDIATE");
        const remove = db.prepare("DELETE FROM pending_fs_ops WHERE id = ?");
        for (const id of intentIds) {
          remove.run(id);
        }
        db.exec("COMMIT");
        return ok({ cleared: intentIds.length });
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // As above: nothing to roll back.
        }
        return err(
          appError("INTERNAL_ERROR", `Clearing filesystem intents failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}

/** One intent's filesystem effect, evaluated from current state; never runs inside a transaction. */
interface FenceRow {
  move_fence_pid: number | null;
  move_fence_at: string | null;
}

/** True when a process with this pid is alive; a dead fence pid is stale. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live fence that must pause intent commits, or null when absent or stale. */
export function liveFencePaused(db: SorageSqlite): { pid: number } | null {
  const row = db.prepare("SELECT move_fence_pid, move_fence_at FROM vault_state WHERE id = 1").get() as
    | FenceRow
    | null
    | undefined;
  const pid = row?.move_fence_pid ?? null;
  if (pid === null) return null;
  return pidIsAlive(pid) ? { pid } : null;
}

/**
 * The mover's fence-and-count (TASK-029, the EPIC-004 accepted seam): one write
 * transaction sets the fence row and counts the outstanding intents, so an intent
 * commit either lands before it and is counted, or waits on the write lock and then
 * sees the fence and pauses. Returns the count the switch decision needs.
 */
export function setMoveFenceAndCountPending(db: SorageSqlite, pid: number, at: string): Result<number, AppError> {
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET move_fence_pid = excluded.move_fence_pid, move_fence_at = excluded.move_fence_at",
      ).run(pid, at);
      const row = db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as { count: number };
      db.exec("COMMIT");
      return ok(row.count);
    } catch (transactionError) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing left to roll back.
      }
      throw transactionError;
    }
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Fencing the Vault switch failed: ${messageOf(error)}.`, { cause: String(error) }),
    );
  }
}

/** Clears the fence after the switch completes or the move abandons the switch. */
export function clearMoveFence(db: SorageSqlite): Result<void, AppError> {
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE vault_state SET move_fence_pid = NULL, move_fence_at = NULL WHERE id = 1").run();
      db.exec("COMMIT");
      return ok(undefined);
    } catch (transactionError) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing left to roll back.
      }
      throw transactionError;
    }
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Clearing the Vault switch fence failed: ${messageOf(error)}.`, {
        cause: String(error),
      }),
    );
  }
}

/**
 * The eligibility primitive of section 3: a legacy unlink may take no physical
 * effect, clear, attempt, event, or failure report while any pending
 * activation targets the exact same persisted `to_path` — the recorded
 * activation is the dependency, and a timestamp/id ordering alone cannot
 * prevent the retired-file counterexample. SQL only; no filesystem I/O.
 */
export function pendingActivationTargets(db: SorageSqlite, toPath: string): boolean {
  const row = db
    .prepare("SELECT 1 AS pending FROM pending_fs_ops WHERE op = 'activate' AND to_path = ? LIMIT 1")
    .get(toPath) as { pending: number } | null | undefined;
  return row !== null && row !== undefined;
}

/** The internal execution outcomes of the shared legacy intent executor. */
export type LegacyIntentOutcome = "done" | "both-gone" | "destination-conflict" | "unsafe-path" | "deferred";

/**
 * The one shared dependency-aware legacy execution boundary of section 3
 * (SHR-004): eligibility runs against the exact persisted activation target
 * BEFORE any legacy unlink filesystem effect, then the managed physical
 * activate/unlink logic runs — never inside a SQL transaction. The startup
 * drain AND the ordinary production send/revise/delete physical wrappers call
 * this same function, so ordinary mutation cannot bypass the dependency check
 * with a direct remove. The optional precondition carries the ArtifactStore's
 * own marker/live-fence mutation guard for ordinary callers; the drain keeps
 * its per-intent lock re-checks and passes none.
 */
export function executeLegacyIntent(
  db: SorageSqlite,
  intent: Pick<PendingFsOp, "op" | "fromPath" | "toPath">,
  vaultPath: string,
  precondition?: () => Result<unknown, AppError>,
): Result<LegacyIntentOutcome, AppError> {
  if (precondition !== undefined) {
    const guarded = precondition();
    if (!guarded.ok) return err(guarded.error);
  }
  if (intent.op === "unlink" && pendingActivationTargets(db, intent.toPath)) {
    return ok("deferred");
  }
  return ok(executeIntent(intent, vaultPath));
}

export function executeIntent(
  intent: Pick<PendingFsOp, "op" | "fromPath" | "toPath">,
  vaultPath: string,
): "done" | "both-gone" | "destination-conflict" | "unsafe-path" {
  if (!isSafeVaultRelative(intent.toPath) || (intent.fromPath !== null && !isSafeVaultRelative(intent.fromPath))) {
    // A hostile path never touches the filesystem; it stays recorded as failed.
    return "unsafe-path";
  }
  // The legacy managed-key contract the ArtifactStore always enforced: a
  // legacy activation places exactly an artifacts/ managed key from a staging/
  // source, and a legacy unlink removes exactly an artifacts/ managed key. A
  // corrupted relative intent naming the Vault marker or the snapshot tree is
  // unsafe and never touches the filesystem.
  if (!isManagedStorageKey(intent.toPath)) {
    return "unsafe-path";
  }
  if (intent.op === "activate" && intent.fromPath !== null && !intent.fromPath.startsWith("staging/")) {
    return "unsafe-path";
  }
  if (intent.op === "activate") {
    let sourceStat: ReturnType<typeof managedLstat>;
    let destinationStat: ReturnType<typeof managedLstat>;
    try {
      // Managed resolution rejects symlinked or special parents and leaves
      // before anything is touched: a link in the managed chain is unsafe, not
      // content to rename over or follow.
      const source = intent.fromPath === null ? null : managedFile(vaultPath, intent.fromPath);
      const destination = managedFile(vaultPath, intent.toPath);
      sourceStat = source === null ? undefined : source.stat;
      destinationStat = destination.stat;
    } catch (error) {
      // Only the managed-path classification is an unsafe path; a genuine I/O
      // failure keeps its original error semantics for the thrown-I/O
      // liveness gate.
      if (error instanceof UnsafeManagedPathError) return "unsafe-path";
      throw error;
    }
    const destinationPath = join(vaultPath, intent.toPath);
    const parentKey = intent.toPath.slice(0, intent.toPath.lastIndexOf("/"));
    if (sourceStat?.isFile()) {
      if (destinationStat !== undefined) {
        // Both ends present: overwriting the destination would violate the
        // no-overwrite invariant the store enforces, so the row stays recorded
        // as a failure instead of silently replacing bytes a record may name.
        return "destination-conflict";
      }
      try {
        managedDirectory(vaultPath, parentKey, true);
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) return "unsafe-path";
        throw error;
      }
      try {
        renameSync(join(vaultPath, intent.fromPath as string), destinationPath);
      } catch (error) {
        // Only a rename error reaches this re-evaluation: a concurrent drain
        // may have renamed the source first (CP-7), and the managed validated
        // destination then carries the competitor's effect. The re-evaluation
        // itself keeps the managed classification: unsafe entries stay
        // unsafe-path and genuine I/O keeps its original semantics.
        let sourceGone: boolean;
        let destinationPresent: boolean;
        try {
          sourceGone = managedFile(vaultPath, intent.fromPath as string).stat === undefined;
          destinationPresent = managedFile(vaultPath, intent.toPath).stat !== undefined;
        } catch (recheckError) {
          if (recheckError instanceof UnsafeManagedPathError) return "unsafe-path";
          throw recheckError;
        }
        if (!sourceGone || !destinationPresent) throw error;
      }
      // Whether this executor's own rename or the competitor's just-raced one
      // placed the file, the parent directory entry must fsync successfully
      // before this activation may settle: an fsync failure is never
      // converted into done by existence (VLT-022).
      fsyncDirectory(dirname(destinationPath));
      // Managed Artifact files are read-only after import where the
      // filesystem supports it (VLT-008); the placement stands even when the
      // mark cannot be applied.
      try {
        chmodSync(destinationPath, 0o444);
      } catch {
        // Read-only is best effort on exotic filesystems; vault verify reports it.
      }
      return "done";
    }
    if (destinationStat?.isFile()) {
      // The idempotent source-absent/destination-present completion still
      // requires a successful parent fsync before done: verified existence of
      // the bytes never proves the directory entry is durable. The repair arm
      // of an earlier fsync failure reaches done here, so the same best-effort
      // read-only mark the fresh placement applies follows the required fsync.
      fsyncDirectory(dirname(destinationPath));
      try {
        chmodSync(destinationPath, 0o444);
      } catch {
        // Read-only is best effort on exotic filesystems; vault verify reports it.
      }
      return "done";
    }
    return "both-gone";
  }
  let targetStat: ReturnType<typeof managedLstat>;
  try {
    targetStat = managedFile(vaultPath, intent.toPath).stat;
  } catch (error) {
    // A symlink or special entry at the managed leaf is never followed or
    // unlinked, and only the managed-path classification maps to unsafe-path;
    // genuine I/O keeps its original semantics.
    if (error instanceof UnsafeManagedPathError) return "unsafe-path";
    throw error;
  }
  if (targetStat !== undefined) {
    const targetPath = join(vaultPath, intent.toPath);
    try {
      unlinkSync(targetPath);
    } catch (error) {
      // A concurrent drain may have unlinked first; a vanished target is done.
      if (!existsSync(targetPath)) return "done";
      throw error;
    }
    fsyncDirectory(dirname(targetPath));
  }
  return "done";
}

/**
 * The post-drain garbage pass (VLT-013, VLT-014): sweeps `staging/` by age and
 * sweeps unreferenced files under `artifacts/` past the grace window, while a
 * path matching a live storageKey or any pending intent is never removed,
 * whatever its age. Runs only after this process's drain has finished.
 */
export function collectVaultGarbage(
  vaultPath: string,
  pendingIntents: PendingFsOp[],
  options: GarbageCollectionOptions,
): Result<GarbageCollectionReport, AppError> {
  const cutoffMs = options.now.getTime() - options.graceHours * 3_600_000;
  const guarded = new Set<string>();
  for (const key of options.liveStorageKeys) guarded.add(join(vaultPath, key));
  for (const key of options.liveContentKeys ?? []) guarded.add(join(vaultPath, key));
  for (const key of options.receiptReferencedKeys ?? []) guarded.add(join(vaultPath, key));
  for (const intent of pendingIntents) {
    guarded.add(join(vaultPath, intent.toPath));
    if (intent.fromPath !== null) guarded.add(join(vaultPath, intent.fromPath));
  }
  const report: GarbageCollectionReport = { sweptStaging: [], sweptUnreferenced: [], sweptContent: [] };
  try {
    // Each managed root is independently checked, including the legacy roots
    // visited by this same collector. An unsafe root is never traversed.
    for (const root of ["staging", "artifacts", "content"] as const) {
      if (
        root === "artifacts" &&
        options.liveStorageKeys.length === 0 &&
        options.sweepArtifactsWithoutRegistry !== true
      )
        continue;
      if (
        root === "content" &&
        (options.liveContentKeys ?? []).length === 0 &&
        options.sweepContentWithoutRegistry !== true
      )
        continue;
      let directory: string | undefined;
      try {
        directory = managedDirectory(vaultPath, root);
      } catch {
        continue;
      }
      if (directory === undefined) continue;
      const visit = (key: string): void => {
        const current = managedDirectory(vaultPath, key);
        if (current === undefined) return;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const child = `${key}/${entry.name}`;
          if (entry.isDirectory() && root !== "staging") {
            visit(child);
            continue;
          }
          if (!entry.isFile()) continue;
          const file = managedFile(vaultPath, child);
          if (file.stat === undefined || guarded.has(join(vaultPath, child)) || guarded.has(file.path)) continue;
          if (file.stat.mtimeMs >= cutoffMs) continue;
          // Recheck the parent and regular leaf at the actual deletion boundary.
          unlinkSync(managedFile(vaultPath, child).path);
          if (root === "staging") report.sweptStaging.push(file.path);
          else if (root === "artifacts") report.sweptUnreferenced.push(file.path);
          else report.sweptContent.push(file.path);
        }
      };
      visit(root);
    }
    return ok(report);
  } catch (error) {
    return err(appError("INTERNAL_ERROR", `Garbage collection failed: ${messageOf(error)}.`, { cause: String(error) }));
  }
}

function isSafeVaultRelative(path: string): boolean {
  return isSafeVaultRelativePath(path);
}

/** True when a path is a safe non-empty Vault-relative path with no traversal segments. */
export function isSafeVaultRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
