import { join } from "node:path";
import {
  type AppError,
  appError,
  classifyContentIntentOwnership,
  contentIntentIntegrityError,
  type DrainReport,
  err,
  type IntentLog,
  type NewPendingFsOp,
  ok,
  type PendingFsOp,
  type Result,
  SYSTEM_ACTOR,
} from "@sorage/core";
import { completeCommonIntentTx, executeCommonIntent } from "./common-intent";
import { createSqliteEventLedger, type SqliteEventLedger } from "./events";
import { executeLegacyIntent } from "./legacy-intent";
import { vaultMoveLockHeld, vaultMovePauseRefusal } from "./lockfile";
import type { SorageSqlite } from "./sqlite/connection";
import { runInTransaction } from "./sqlite/transaction";
import { openVault } from "./vault";

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
 * intents in one fenced transaction, `drain` executes every outstanding intent
 * against the filesystem state it finds and settles resolved rows in short
 * unfenced completion transactions, and `clear` clears executed intents.
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
      if (options.runDir !== undefined && vaultMoveLockHeld(options.runDir)) {
        return err(
          appError(
            "SERVICE_PAUSED",
            "A Vault move or restore is in progress; the intent commit paused instead of racing it.",
            { lockPath: join(options.runDir, "vault-move.lock") },
          ),
        );
      }
      return runInTransaction(
        db,
        "BEGIN IMMEDIATE",
        () => {
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
          return ok({ recorded: intents.length });
        },
        {
          checkFence: true,
          fenceError: (pid) =>
            appError(
              "SERVICE_PAUSED",
              "A Vault move or restore is in progress; the intent commit paused instead of racing it.",
              { moveFencePid: pid },
            ),
          failure: (error) =>
            appError("INTERNAL_ERROR", `Recording filesystem intents failed: ${messageOf(error)}.`, {
              cause: String(error),
            }),
        },
      );
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
        vaultMovePauseRefusal(options.runDir === undefined ? undefined : join(options.runDir, "vault-move.lock"));
      if (paused()) return err(pauseError());
      const opened = openVault(vaultPath, installationId);
      if (!opened.ok) return err(opened.error);
      const report: DrainReport = { resolved: [], integrityFailed: [], commonFailures: [] };

      const settle = (
        intent: PendingFsOp,
        outcome: "done" | "both-gone" | "destination-conflict" | "unsafe-path",
      ): Result<"own-clear" | "observed-clear" | "retained", AppError> => {
        const tx = runInTransaction(
          db,
          "BEGIN IMMEDIATE",
          () => {
            const live = db.prepare("SELECT id FROM pending_fs_ops WHERE id = ?").get(intent.id) as
              | { id: string }
              | null
              | undefined;
            if (live === null || live === undefined) {
              return ok("observed-clear" as const);
            }
            db.prepare("UPDATE pending_fs_ops SET attempts = attempts + 1 WHERE id = ?").run(intent.id);
            if (outcome === "done") {
              const cleared = db.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run(intent.id) as {
                changes: number;
              };
              if (cleared.changes === 1) {
                if (intent.op === "activate" && intent.artifactId !== null) {
                  db.prepare(
                    "UPDATE content_records SET materialized = 1 WHERE storage_key = ? AND inline_text IS NULL AND (id = (SELECT content_record_id FROM artifacts WHERE id = ?) OR materialized = 0)",
                  ).run(intent.toPath, intent.artifactId);
                }
                if (options.events !== undefined) {
                  const artifact =
                    intent.artifactId === null
                      ? null
                      : ((db
                          .prepare(
                            "SELECT a.handoff_id, cr.sha256 FROM artifacts a JOIN content_records cr ON cr.id = a.content_record_id WHERE a.id = ?",
                          )
                          .get(intent.artifactId) as { handoff_id: string; sha256: string } | null | undefined) ??
                        null);
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
              return ok("own-clear" as const);
            }
            if (options.events !== undefined) {
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
            return ok("retained" as const);
          },
          {
            checkFence: false,
            failure: (error) =>
              appError("INTERNAL_ERROR", `Completing intent ${intent.id} failed: ${messageOf(error)}.`, {
                intentId: intent.id,
                cause: String(error),
              }),
          },
        );
        if (!tx.ok) return tx;
        if (tx.value === "own-clear") {
          report.resolved.push(intent.id);
        } else if (tx.value === "retained") {
          report.integrityFailed.push({
            id: intent.id,
            op: intent.op,
            toPath: intent.toPath,
            artifactId: intent.artifactId,
            event: "ARTIFACT_INTEGRITY_FAILED",
            reason: outcome as "both-gone" | "destination-conflict" | "unsafe-path",
          });
        }
        return tx;
      };

      const attempt = (
        intent: PendingFsOp,
      ): Result<"own-clear" | "observed-clear" | "retained" | "deferred", AppError> => {
        if (intent.ownerDomain !== null && intent.ownerId !== null && intent.contentId !== null) {
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
          const live = db.prepare("SELECT id FROM pending_fs_ops WHERE id = ?").get(intent.id) as
            | { id: string }
            | null
            | undefined;
          if (live === null || live === undefined) return ok("observed-clear");
          throw ioError;
        }
        return settle(intent, outcome);
      };

      try {
        const pending = listPending();
        if (!pending.ok) return pending;
        const deferred: PendingFsOp[] = [];
        let progressed = false;
        for (const intent of pending.value) {
          if (paused()) return err(pauseError());
          const attempted = attempt(intent);
          if (!attempted.ok) return attempted;
          if (attempted.value === "deferred") deferred.push(intent);
          if (attempted.value === "own-clear" || attempted.value === "observed-clear") progressed = true;
        }
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
      return runInTransaction(
        db,
        "BEGIN IMMEDIATE",
        () => {
          const remove = db.prepare("DELETE FROM pending_fs_ops WHERE id = ?");
          for (const id of intentIds) {
            remove.run(id);
          }
          return ok({ cleared: intentIds.length });
        },
        {
          checkFence: false,
          failure: (error) =>
            appError("INTERNAL_ERROR", `Clearing filesystem intents failed: ${messageOf(error)}.`, {
              cause: String(error),
            }),
        },
      );
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
