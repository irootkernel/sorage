import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  appError,
  err,
  ok,
  type ArtifactStore,
  type AppError,
  type Result,
  type StageRequest,
  type StagedFile,
} from "@sorage/core";
import { isManagedStorageKey } from "@sorage/core";
import { vaultMoveLockHeld } from "./lockfile";
import { openVault } from "./vault";

/** One mebibyte: the fixed copy buffer that keeps import memory bounded (NFR-005). */
const STREAM_BUFFER_BYTES = 1024 * 1024;

export interface NodeArtifactStoreOptions {
  vaultPath: string;
  installationId: string;
  /** Overridable for tests; each staged file gets a fresh exclusive name. */
  newStagingId?: (() => string) | undefined;
  /** When provided, a live vault-move.lock pauses every mutation with SERVICE_PAUSED (RUN-014). */
  runDir?: string | undefined;
}

/**
 * The filesystem ArtifactStore over one Vault (VLT-004 to VLT-007, VLT-020): every
 * mutation first passes the TASK-021 Vault guard, staging streams through a fixed
 * buffer with SHA-256 computed in the same pass and aborts mid-stream past
 * `maxBytes`, and activation resolves one storageKey to one exclusive path so no
 * placement can overwrite bytes a record already names. The intent-log durability
 * order and drain around these primitives arrive with TASK-024.
 */
export function createNodeArtifactStore(options: NodeArtifactStoreOptions): ArtifactStore {
  const { vaultPath, installationId } = options;
  const newStagingId = options.newStagingId ?? (() => randomUUID());

  /** Every mutation funnels through the move lock and the marker guard (RUN-014, VLT-019). */
  function guard(): Result<unknown, AppError> {
    if (pausedNow()) {
      return err(
        appError(
          "SERVICE_PAUSED",
          "A Vault move or restore is in progress; this mutation paused instead of racing it.",
          { lockPath: options.runDir === undefined ? undefined : join(options.runDir, "vault-move.lock") },
        ),
      );
    }
    return openVault(vaultPath, installationId);
  }

  /** The lock is re-checked immediately before each mutation, not only at entry, so a move that starts mid-flight cannot switch the Vault underneath a write or rename. */
  function pausedNow(): boolean {
    return options.runDir !== undefined && vaultMoveLockHeld(options.runDir);
  }

  function pauseError(): AppError {
    return appError(
      "SERVICE_PAUSED",
      "A Vault move or restore is in progress; this mutation paused instead of racing it.",
      { lockPath: options.runDir === undefined ? undefined : join(options.runDir, "vault-move.lock") },
    );
  }

  return {
    stage(request: StageRequest): Result<StagedFile, AppError> {
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      let sourceStat: ReturnType<typeof statSync>;
      try {
        sourceStat = statSync(request.sourcePath);
      } catch (error) {
        return err(unreadableSource(request.sourcePath, error));
      }
      if (!sourceStat.isFile()) {
        // The full special-file policy of section 10 step 2 lands with TASK-023;
        // staging never reads a non-regular source in the meantime.
        return err(
          appError(
            "INTERNAL_ERROR",
            `The source is not a regular file and cannot be imported: ${request.sourcePath}.`,
            {
              sourcePath: request.sourcePath,
            },
          ),
        );
      }
      const stagingPath = join(vaultPath, "staging", newStagingId());
      let source: number | undefined;
      let staged: number | undefined;
      try {
        if (pausedNow()) return err(pauseError());
        source = openSync(request.sourcePath, "r");
        staged = openSync(stagingPath, "wx");
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
        let total = 0;
        for (;;) {
          const read = readSync(source, buffer, 0, buffer.length, null);
          if (read === 0) break;
          if (total + read > request.maxBytes) {
            closeSync(source);
            closeSync(staged);
            source = undefined;
            staged = undefined;
            try {
              unlinkSync(stagingPath);
            } catch {
              // The staging sweep after the grace window removes any survivor.
            }
            return err(
              appError(
                "ARTIFACT_TOO_LARGE",
                `The source ${request.sourcePath} crossed artifact.maxBytes ${request.maxBytes} mid-stream.`,
                { sourcePath: request.sourcePath, maxBytes: request.maxBytes, readSoFar: total + read },
              ),
            );
          }
          hash.update(buffer.subarray(0, read));
          writeSync(staged, buffer, 0, read);
          total += read;
        }
        fsyncSync(staged);
        closeSync(source);
        closeSync(staged);
        source = undefined;
        staged = undefined;
        return ok({ stagingPath, sizeBytes: total, sha256: hash.digest("hex") });
      } catch (error) {
        return err(unreadableSource(request.sourcePath, error, stagingPath));
      } finally {
        if (source !== undefined) {
          try {
            closeSync(source);
          } catch {
            // Best effort: the descriptor closes with the process on abort paths.
          }
        }
        if (staged !== undefined) {
          try {
            closeSync(staged);
          } catch {
            // Best effort, as above.
          }
        }
      }
    },

    activate(request: { stagingPath: string; storageKey: string }): Result<{ path: string }, AppError> {
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      if (!isManagedStorageKey(request.storageKey)) {
        return err(
          appError("INTERNAL_ERROR", `The storage key is not a managed artifacts/ key: ${request.storageKey}.`, {
            storageKey: request.storageKey,
          }),
        );
      }
      const destination = join(vaultPath, request.storageKey);
      if (existsSync(destination)) {
        return err(
          appError(
            "VAULT_INTEGRITY_ERROR",
            `Refusing to overwrite the existing path ${request.storageKey}; every Artifact needs its own artifact-id slot.`,
            { storageKey: request.storageKey },
          ),
        );
      }
      try {
        if (pausedNow()) return err(pauseError());
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(request.stagingPath, destination);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Placing ${request.storageKey} failed: ${messageOf(error)}.`, {
            storageKey: request.storageKey,
            cause: String(error),
          }),
        );
      }
      // Managed Artifact files are read-only after import where the filesystem
      // supports it (VLT-008); the placement stands even when the mark cannot.
      try {
        chmodSync(destination, 0o444);
      } catch {
        // Read-only is best effort on exotic filesystems; vault verify reports it.
      }
      return ok({ path: destination });
    },

    pathOf(storageKey: string): Result<string, AppError> {
      if (!isManagedStorageKey(storageKey)) {
        return err(
          appError("INTERNAL_ERROR", `The storage key is not a managed artifacts/ key: ${storageKey}.`, {
            storageKey,
          }),
        );
      }
      return ok(join(vaultPath, storageKey));
    },

    exists(storageKey: string): Result<boolean, AppError> {
      const path = resolveManagedPath(storageKey);
      if (!path.ok) return err(path.error);
      return ok(existsSync(path.value));
    },

    checksum(storageKey: string): Result<string, AppError> {
      const path = resolveManagedPath(storageKey);
      if (!path.ok) return err(path.error);
      try {
        const hash = createHash("sha256");
        let handle: number | undefined;
        try {
          handle = openSync(path.value, "r");
          const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
          for (;;) {
            const read = readSync(handle, buffer, 0, buffer.length, null);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
          }
        } finally {
          if (handle !== undefined) closeSync(handle);
        }
        return ok(hash.digest("hex"));
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading ${storageKey} for verification failed: ${messageOf(error)}.`, {
            storageKey,
            cause: String(error),
          }),
        );
      }
    },
  };

  function resolveManagedPath(storageKey: string): Result<string, AppError> {
    if (!isManagedStorageKey(storageKey)) {
      return err(
        appError("INTERNAL_ERROR", `The storage key is not a managed artifacts/ key: ${storageKey}.`, {
          storageKey,
        }),
      );
    }
    return ok(join(vaultPath, storageKey));
  }
}

function unreadableSource(sourcePath: string, error: unknown, stagingPath?: string): AppError {
  return appError("INTERNAL_ERROR", `The source ${sourcePath} could not be read: ${messageOf(error)}.`, {
    sourcePath,
    ...(stagingPath === undefined ? {} : { stagingPath }),
    cause: String(error),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
