import { type AppError, err, ok, type Result } from "../shared/errors";
import type { BackupRunRow } from "./backup-run";

/**
 * `sorage backup status` (TASK-055, BKP-016, section 31): the run history
 * projected onto what an operator needs — the last attempt, the last success,
 * the last commit, the last push, and the last failure with its symbolic
 * code, next to the schedule snapshot and the repository size on disk. The
 * computed `nextDueAt` stays null until the scheduler of TASK-056 fills it,
 * because computing it is the scheduler's DST-aware job.
 */
export interface BackupStatusPorts {
  vaultPath: string;
  history(): Result<BackupRunRow[], AppError>;
  schedule: { enabled: boolean; at: string; timezone: string; catchUpAfterMissedRun: boolean };
  /** The computed next due time in the schedule zone, or null while disabled (section 31). */
  nextDueAt(): string | null;
  /** The most recent run's start, whatever triggered it, for coverage decisions. */
  lastRunAt(): Result<string | null, AppError>;
  /** Total bytes under the Vault's `.git`, or null when no repository exists. */
  repositoryBytes(): Result<number | null, AppError>;
}

export interface BackupStatusReport {
  lastAttempt: BackupRunRow | null;
  lastSuccess: BackupRunRow | null;
  lastCommit: BackupRunRow | null;
  lastPush: BackupRunRow | null;
  lastFailure: BackupRunRow | null;
  nextDueAt: string | null;
  schedule: { enabled: boolean; at: string; timezone: string; catchUpAfterMissedRun: boolean };
  repositorySizeBytes: number | null;
}

export function backupStatus(ports: BackupStatusPorts): Result<BackupStatusReport, AppError> {
  const history = ports.history();
  if (!history.ok) return err(history.error);
  const rows = [...history.value].sort((a, b) => compareTimestamps(a.startedAt, b.startedAt));
  const lastAttempt = rows.length > 0 ? (rows[rows.length - 1] as BackupRunRow) : null;
  const lastSuccess = findLast(rows, (row) => row.outcome !== "failure");
  const lastCommit = findLast(rows, (row) => row.commitSha !== null);
  const lastPush = findLast(rows, (row) => row.pushOutcome === "pushed");
  const lastFailure = findLast(rows, (row) => row.outcome === "failure");
  const bytes = ports.repositoryBytes();
  if (!bytes.ok) return err(bytes.error);
  return ok({
    lastAttempt,
    lastSuccess,
    lastCommit,
    lastPush,
    lastFailure,
    nextDueAt: ports.nextDueAt(),
    schedule: ports.schedule,
    repositorySizeBytes: bytes.value,
  });
}

function findLast(rows: BackupRunRow[], predicate: (row: BackupRunRow) => boolean): BackupRunRow | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] as BackupRunRow;
    if (predicate(row)) return row;
  }
  return null;
}

function compareTimestamps(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
