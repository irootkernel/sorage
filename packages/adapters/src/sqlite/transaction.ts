import { type AppError, appError, err, type Result } from "@sorage/core";
import { liveFencePaused } from "./move-fence";
import type { SorageSqlite } from "./connection";

/**
 * The one shared adapter transaction helper of CHN-014 and TASK-157: runs
 * `begin`, the optional read-only vault-move fence check (`checkFence` defaults
 * to `true`), the optional staged external-version coherence check of MEM-011,
 * the caller's `work`, and `COMMIT`/`ROLLBACK`. A failing `ROLLBACK` on an
 * error path is swallowed so the original error survives to `options.failure`.
 */

/** The failure classifier of one invoking domain: the seam its old `databaseResult` owned. */
export type TransactionFailure = (error: unknown) => AppError;

export interface SharedTransactionOptions {
  /** Maps a thrown engine failure onto the invoking domain's typed envelope. */
  failure: TransactionFailure;
  /**
   * Whether to check the SQLite vault-move fence before running `work`
   * (default `true`). Set `false` for unfenced completions, ledgers, reviews,
   * and plain read transactions.
   */
  checkFence?: boolean;
  /** Builds the caller's typed refusal when a live move fence pauses the transaction. */
  fenceError?: (pid: number) => AppError;
  /**
   * The Memo domain's staged external-version expectation (MEM-011): checked
   * on `BEGIN IMMEDIATE` only, and a mismatch rolls back through
   * `coherenceMarker`.
   */
  expectedExternalVersion?: number;
  /** The coherence marker returned on an external-version mismatch. */
  coherenceMarker?: () => Result<never>;
}

/** The database's current `PRAGMA data_version`, the Memo coherence check's observation. */
export function externalDataVersion(db: SorageSqlite): number {
  const row = db.prepare("PRAGMA data_version").get() as { data_version: number } | null | undefined;
  return Number(row?.data_version ?? 0);
}

function rollbackQuietly(db: SorageSqlite): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The transaction never opened or the connection already rolled back;
    // swallowing preserves the original error or typed refusal.
  }
}

export function runInTransaction<T>(
  db: SorageSqlite,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  work: () => Result<T>,
  options: SharedTransactionOptions,
): Result<T> {
  try {
    db.exec(begin);
    try {
      if (options.checkFence !== false) {
        const paused = liveFencePaused(db);
        if (paused) {
          rollbackQuietly(db);
          return err(
            options.fenceError !== undefined
              ? options.fenceError(paused.pid)
              : appError("SERVICE_PAUSED", "A Vault move or restore is in progress"),
          );
        }
      }
      if (options.expectedExternalVersion !== undefined && begin === "BEGIN IMMEDIATE") {
        if (externalDataVersion(db) !== options.expectedExternalVersion) {
          rollbackQuietly(db);
          return options.coherenceMarker === undefined
            ? err(
                appError(
                  "SERVICE_PAUSED",
                  "External database state changed during this write; the attempt rolled back",
                  { coherenceMismatch: true },
                ),
              )
            : options.coherenceMarker();
        }
      }
      const result = work();
      if (result.ok) {
        db.exec("COMMIT");
      } else {
        rollbackQuietly(db);
      }
      return result;
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  } catch (error) {
    return err(options.failure(error));
  }
}
