import { homedir } from "node:os";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ok, type AppError, type Result } from "@sorage/core";
import type { Configuration } from "@sorage/core";
import { createConfigStore } from "./config-store";
import { createNodeHomePaths, type HomePaths } from "./home";
import { acquireLock, createNodeLockProbePorts, isPidAlive, releaseLock } from "./lockfile";
import { openSorageDatabase } from "./sqlite/connection";
import { MIGRATIONS } from "./sqlite/migrations";
import { openAndMigrate } from "./sqlite/migrator";

/**
 * The daemon composition surface (RUN-006, RUN-013, SEC-015): the atomic
 * `run/daemon.json` record, the lifetime `daemon.lock` with dead-pid recovery, the
 * configuration read, and the bounded Artifact checksum query the periodic sweep
 * walks. The daemon and the CLI reach these through this module only.
 */
export interface DaemonRunRecord {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  version: string;
  installationId: string;
}

export interface DaemonLockAcquisition {
  ok: boolean;
  /** The reason a live lock could not be taken; absent when `ok` is true. */
  reason?: "live-owner";
  release?(): void;
}

export interface ArtifactSweepBatch {
  records: Array<{ storageKey: string; sha256: string; bytes: number }>;
  /** The cursor the next tick starts from, or null when the registry was fully walked. */
  nextCursor: string | null;
  /** The bytes this batch plans to read, bounded by the tick budget. */
  plannedBytes: number;
}

export interface NodeDaemonPorts {
  home: HomePaths;
  /** Reads the resolved configuration, or null before initialization. */
  readConfiguration(): Result<{ config: Configuration; installationId: string } | null, AppError>;
  readDaemonRecord(): DaemonRunRecord | null;
  writeDaemonRecord(record: DaemonRunRecord): void;
  removeDaemonRecord(): void;
  acquireDaemonLock(): DaemonLockAcquisition;
  isPidAlive(pid: number): boolean;
  /** One bounded batch of materialized Artifact records ordered by storage key. */
  nextArtifactBatch(fromKey: string | null, byteBudget: number): ArtifactSweepBatch;
  /** Recomputes the SHA-256 of one stored Artifact file; null when the file is unreadable. */
  hashArtifact(storageKey: string): string | null;
  /** The resolved Vault path of the current configuration, or null. */
  vaultPath(): string | null;
}

export interface NodeDaemonPortsOptions {
  env?: NodeJS.ProcessEnv | undefined;
}

/** The daemon-owned database handle exposed only through this composition module. */
export type NodeDaemonDatabase = ReturnType<typeof openAndMigrate>["db"];

/** Opens and migrates the one connection the daemon owns for its whole lifetime. */
export function openNodeDaemonDatabase(stateDir: string): NodeDaemonDatabase {
  return openAndMigrate(join(stateDir, "sorage.sqlite3"), MIGRATIONS).db;
}

export function createNodeDaemonPorts(options: NodeDaemonPortsOptions = {}): NodeDaemonPorts {
  const home = createNodeHomePaths(options.env ?? process.env);
  const daemonJson = join(home.runDir, "daemon.json");
  const userHome = options.env?.HOME ?? options.env?.USERPROFILE ?? homedir();
  const store = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });

  return {
    home,
    readConfiguration: () => {
      const current = store.read();
      if (!current.ok) return current;
      if (current.value === null) return ok(null);
      return ok({ config: current.value.config, installationId: current.value.config.installationId });
    },
    readDaemonRecord: () => {
      try {
        return JSON.parse(readFileSync(daemonJson, "utf8")) as DaemonRunRecord;
      } catch {
        return null;
      }
    },
    writeDaemonRecord: (record) => {
      mkdirSync(home.runDir, { recursive: true });
      atomicWrite(daemonJson, `${JSON.stringify(record, null, 2)}\n`);
    },
    removeDaemonRecord: () => {
      try {
        unlinkSync(daemonJson);
      } catch {
        // A clean stop is idempotent; the record may already be gone.
      }
    },
    acquireDaemonLock: () => {
      const acquisition = acquireLock({
        path: home.lockFile("daemon"),
        lock: "daemon",
        ports: createNodeLockProbePorts(),
      });
      if (acquisition.ok) return { ok: true, release: () => releaseLock(home.lockFile("daemon")) };
      return { ok: false, reason: "live-owner" };
    },
    isPidAlive,
    nextArtifactBatch: (fromKey, byteBudget) => {
      const databasePath = join(home.stateDir, "sorage.sqlite3");
      if (!existsSync(databasePath)) return { records: [], nextCursor: null, plannedBytes: 0 };
      const vault = vaultPathOf(store);
      if (vault === null) return { records: [], nextCursor: null, plannedBytes: 0 };

      const db = openSorageDatabase(databasePath);
      try {
        // The cursor names the first record the previous tick could not fit, so the
        // walk resumes at that record itself, never skipping past it.
        const statement =
          fromKey === null
            ? db.prepare("SELECT storage_key, sha256 FROM artifacts WHERE materialized = 1 ORDER BY storage_key")
            : db.prepare(
                "SELECT storage_key, sha256 FROM artifacts WHERE materialized = 1 AND storage_key >= ? ORDER BY storage_key",
              );
        const fetched = (fromKey === null ? statement.all() : statement.all(fromKey)) as unknown as Array<{
          storage_key: string;
          sha256: string;
        }>;
        const rows = fetched;
        const records: ArtifactSweepBatch["records"] = [];
        let planned = 0;
        for (const row of rows) {
          const size = artifactSize(vault, row.storage_key);
          if (size === null) {
            // An unreadable file is itself a mismatch the hash step reports.
            records.push({ storageKey: row.storage_key, sha256: row.sha256, bytes: 0 });
            continue;
          }
          if (planned > 0 && planned + size > byteBudget) {
            // Keep the batch within the tick budget; resume here next tick.
            return { records, nextCursor: row.storage_key, plannedBytes: planned };
          }
          records.push({ storageKey: row.storage_key, sha256: row.sha256, bytes: size });
          planned += size;
        }
        return { records, nextCursor: null, plannedBytes: planned };
      } finally {
        db.close();
      }
    },
    hashArtifact: (storageKey) => {
      const vault = vaultPathOf(store);
      if (vault === null) return null;
      try {
        // A storage key is vault-relative and already carries its artifacts/ segment,
        // the same resolution rule artifactSize applies below.
        const digest = createHash("sha256")
          .update(readFileSync(join(vault, storageKey)))
          .digest("hex");
        return digest;
      } catch {
        return null;
      }
    },
    vaultPath: () => vaultPathOf(store),
  };
}

function vaultPathOf(store: ReturnType<typeof createConfigStore>): string | null {
  const current = store.read();
  return current.ok && current.value !== null ? current.value.config.vault.path : null;
}

function artifactSize(vault: string, storageKey: string): number | null {
  // A storage key is vault-relative and already carries its artifacts/ segment.
  try {
    return statSync(join(vault, storageKey)).size;
  } catch {
    return null;
  }
}

/** The durable write every run-record change uses: temp file, fsync, rename, fsync dir. */
export function atomicWrite(path: string, contents: string): void {
  const temporary = join(dirname(path), `.${basenameOf(path)}.tmp-${process.pid}`);
  writeFileSync(temporary, contents, "utf8");
  const handle = openSync(temporary, "r+");
  fsyncSync(handle);
  closeSync(handle);
  renameSync(temporary, path);
  try {
    const dir = openSync(dirname(path), "r");
    fsyncSync(dir);
    closeSync(dir);
  } catch {
    // Directory fsync is best effort on platforms that refuse it.
  }
  rmSync(temporary, { force: true });
}

function basenameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "record";
}
