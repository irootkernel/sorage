import { type AppError, err, ok, type Result } from "../shared/errors";
import { type SnapshotFile, snapshotCounts } from "./snapshot/backup-snapshot";
import type { SnapshotDataV3 } from "./snapshot/content-snapshot";
import { type SnapshotDataV5, snapshotFilesV5 } from "./snapshot/exchange-snapshot";
import {
  redactSnapshotDataV4,
  type SnapshotDataV4,
  snapshotFilesV4,
  upgradeSnapshotHandoff,
} from "./snapshot/handoff-reporting-snapshot";

/**
 * The TASK-052 export use case (BKP-003, BKP-007, BKP-008): `exportSnapshot` is
 * the deterministic export the backup-run tasks commit.
 */

export interface BackupExportPorts {
  vaultPath: string;
  /** The `gitBackup.snapshot.redactWorkspacePaths` policy, default `true` (BKP-003). */
  redactWorkspacePaths: boolean;
  /** Reads every snapshot row inside one consistent SQLite read transaction (BKP-007). */
  readSnapshotData(): Result<SnapshotDataV3 | SnapshotDataV4 | SnapshotDataV5, AppError>;
  /** Writes the snapshot tree through temporary files and an atomic replacement (BKP-008). */
  writeSnapshotTree(files: SnapshotFile[]): Result<void, AppError>;
}

export interface BackupExportReport {
  files: number;
  counts: { projects: number; handoffs: number; events: number; artifacts: number };
  redactedWorkspacePaths: boolean;
}

export function exportSnapshot(ports: BackupExportPorts): Result<BackupExportReport, AppError> {
  const read = ports.readSnapshotData();
  if (!read.ok) return err(read.error);
  const current: SnapshotDataV4 = {
    ...read.value,
    handoffs: read.value.handoffs.map((handoff) => ("comment" in handoff ? handoff : upgradeSnapshotHandoff(handoff))),
  };
  const data = ports.redactWorkspacePaths ? redactSnapshotDataV4(current) : current;
  const built =
    "exchanges" in read.value
      ? snapshotFilesV5({
          ...data,
          exchanges: read.value.exchanges,
          exchangeRepresentation: read.value.exchangeRepresentation ?? "foundation",
        })
      : snapshotFilesV4(data);
  if (!built.ok) return built;
  const written = ports.writeSnapshotTree(built.value.files);
  if (!written.ok) return err(written.error);
  return ok({
    files: built.value.files.length,
    counts: snapshotCounts(data),
    redactedWorkspacePaths: ports.redactWorkspacePaths,
  });
}
