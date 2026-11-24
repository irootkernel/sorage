import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type AppError,
  appError,
  type DrainReport,
  err,
  type GarbageCollectionOptions,
  type GarbageCollectionReport,
  ok,
  type PendingFsOp,
  type Result,
} from "@sorage/core";
import { receiptReferencedContentKeys, sqliteContentReferences } from "./content-references";
import { createSqliteContentStore } from "./content-store";
import { createSqliteEventLedger } from "./events";
import { sweepFetchCache } from "./fetch-cache";
import type { HomePaths } from "./home";
import { createSqliteIntentLog } from "./intent-log";
import { acquireLock, createNodeLockProbePorts } from "./lockfile";
import { managedDirectory, managedFile } from "./managed-paths";
import type { SorageSqlite } from "./sqlite/connection";

export interface StartupMaintenanceOptions {
  home: HomePaths;
  vaultPath: string;
  installationId: string;
  graceHours: number;
  clock: { now(): Date };
  /** Caller-specific Artifact live-key query (Vault: materialized + table check; Backup: unfiltered). */
  liveStorageKeys: (db: SorageSqlite) => Result<string[], AppError>;
  /** Optional caller-specific error classifier for drain and cleanup failures (e.g. contention surface). */
  classify?: ((error: AppError) => AppError) | undefined;
}

/**
 * The shared startup maintenance sequence (RUN-002, SHR-004, SHR-006, SHR-011):
 * drains pending intents, runs reference-proof content cleanup (returning the
 * original mapped error before GC or cache sweep when either fails, including
 * live move-fence refusals), runs physical garbage collection only when every
 * pending and live-key proof read succeeded, then sweeps the derived fetch cache.
 */
export function runStartupMaintenance(
  db: SorageSqlite,
  options: StartupMaintenanceOptions,
): Result<DrainReport, AppError> {
  const classify = options.classify ?? ((error: AppError) => error);
  const log = createSqliteIntentLog({
    db,
    installationId: options.installationId,
    runDir: options.home.runDir,
    events: createSqliteEventLedger(db),
  });
  const drained = log.drain(options.vaultPath);
  if (!drained.ok) return err(classify(drained.error));
  const cleanup = createSqliteContentStore({
    db,
    vaultPath: options.vaultPath,
    installationId: options.installationId,
    runDir: options.home.runDir,
  }).cleanup(sqliteContentReferences(db), options.clock.now());
  if (!cleanup.ok) return err(classify(cleanup.error));
  const surviving = log.pending();
  const recorded = options.liveStorageKeys(db);
  const contentKeys = recordedContentKeys(db);
  const receiptKeys = receiptReferencedContentKeys(db, options.clock.now());
  if (surviving.ok && recorded.ok && contentKeys.ok && receiptKeys.ok) {
    void collectVaultGarbage(options.vaultPath, surviving.value, {
      liveStorageKeys: recorded.value,
      liveContentKeys: contentKeys.value,
      receiptReferencedKeys: receiptKeys.value,
      graceHours: options.graceHours,
      now: options.clock.now(),
    });
  }
  sweepFetchCache(options.home.stateDir, {
    graceHours: options.graceHours,
    now: options.clock.now(),
  });
  return drained;
}

/** Acquires `vault-move.lock`, returning `SERVICE_PAUSED` when held by another live process (RUN-014). */
export function acquireVaultMoveLock(
  home: HomePaths,
  clock: { now(): Date },
): Result<{ release: () => void }, AppError> {
  const acquired = acquireLock({
    path: home.lockFile("vault-move"),
    lock: "vault-move",
    ports: createNodeLockProbePorts(clock),
  });
  if (acquired.ok) return ok({ release: acquired.release });
  return err(
    appError(
      "SERVICE_PAUSED",
      `A Vault move or restore is in progress (vault-move.lock held by pid ${String(
        acquired.error.record?.pid,
      )}); this operation paused instead of racing it.`,
      { lockPath: home.lockFile("vault-move") },
    ),
  );
}

/** The managed `content/` keys live content records name, the GC guard input. */
export function recordedContentKeys(db: SorageSqlite): Result<string[], AppError> {
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_records'")
      .get() as { name: string } | null | undefined;
    if (!table) return ok([]);
    const rows = db
      .prepare("SELECT storage_key FROM content_records WHERE storage_key IS NOT NULL")
      .all() as unknown as Array<{ storage_key: string }>;
    return ok(rows.map((row) => String(row.storage_key ?? "")));
  } catch (error) {
    return err(
      appError("INTERNAL_ERROR", `Reading the content keys failed: ${messageOf(error)}.`, { cause: String(error) }),
    );
  }
}

/**
 * The post-drain garbage pass (VLT-013, VLT-014): sweeps `staging/` by age and
 * sweeps unreferenced files under `artifacts/` and `content/` past the grace
 * window, while a path matching a live storage key, content key, retained
 * receipt key, or any pending intent is never removed, whatever its age.
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
