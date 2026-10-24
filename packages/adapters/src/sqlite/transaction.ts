import { type AppError, appError, err, type Result } from "@sorage/core";
import { liveFencePaused } from "../intent-log";
import type { SorageSqlite } from "./connection";

/**
 * The one shared adapter transaction helper of CHN-014: the Memo domain's
 * fenced transaction runner, lifted from its private copy in `memos.ts` so
 * both domains run the identical sequence — `begin`, the read-only
 * vault-move fence check, the optional staged external-version coherence
 * check of MEM-011, the work, and `COMMIT`/`ROLLBACK` with a rollback and
 * rethrow on any thrown engine failure. Each domain supplies its own failure
 * classifier so the public envelopes stay byte-identical to the private
 * helpers this module replaces; the Memo domain additionally passes its
 * `expectedExternalVersion` and coherence marker, and the rebuilt Channel
 * domain passes neither (no `PRAGMA data_version` coherence loop exists).
 */

/** The failure classifier of one invoking domain: the seam its old `databaseResult` owned. */
export type TransactionFailure = (error: unknown) => AppError;

export interface SharedTransactionOptions {
  /** Maps a thrown engine failure onto the invoking domain's typed envelope. */
  failure: TransactionFailure;
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

export function runInTransaction<T>(
  db: SorageSqlite,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  work: () => Result<T>,
  options: SharedTransactionOptions,
): Result<T> {
  try {
    db.exec(begin);
    try {
      if (liveFencePaused(db)) {
        db.exec("ROLLBACK");
        return err(appError("SERVICE_PAUSED", "A Vault move or restore is in progress"));
      }
      if (options.expectedExternalVersion !== undefined && begin === "BEGIN IMMEDIATE") {
        if (externalDataVersion(db) !== options.expectedExternalVersion) {
          db.exec("ROLLBACK");
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
      db.exec(result.ok ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    return err(options.failure(error));
  }
}
