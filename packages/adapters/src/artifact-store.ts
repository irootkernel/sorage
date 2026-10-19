import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
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
  type ArtifactReadHandle,
  type ArtifactStore,
  type AppError,
  type Result,
  type StageRequest,
  type StagedFile,
} from "@sorage/core";
import { isManagedStorageKey } from "@sorage/core";
import { vaultMoveLockHeld } from "./lockfile";
import { fsyncDirectory } from "./intent-log";
import { UnsafeManagedPathError, managedDirectory, managedFile, openManagedFile } from "./managed-paths";
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
      let stagingPath: string;
      let reportedStagingPath: string;
      try {
        // The staging root resolves through the canonical managed path: a
        // symlinked or special staging directory is refused rather than
        // created through or written past, so a staged file can never land
        // outside the Vault through a linked root (section 6.2 canaries). The
        // bytes open on the canonical root, while the caller-visible path is
        // expressed under the configured selected root, so a valid directory
        // alias keeps a coherent logical/physical mapping: the caller's own
        // prefix stripping still yields `staging/<id>` (managed-root aliases).
        const stagingRoot = managedDirectory(vaultPath, "staging", true, 0o755);
        if (stagingRoot === undefined) {
          return err(appError("INTERNAL_ERROR", "Preparing the managed staging directory failed."));
        }
        const stagingId = newStagingId();
        stagingPath = join(stagingRoot, stagingId);
        reportedStagingPath = join(vaultPath, "staging", stagingId);
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) {
          return err(
            appError("INTERNAL_ERROR", "The managed staging directory is a link or special entry.", {
              cause: String(error),
            }),
          );
        }
        return err(
          appError("INTERNAL_ERROR", `Preparing the managed staging directory failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
      let source: number | undefined;
      let staged: number | undefined;
      try {
        if (pausedNow()) return err(pauseError());
        try {
          source = openSync(request.sourcePath, "r");
        } catch (error) {
          return err(unreadableSource(request.sourcePath, error));
        }
        try {
          staged = openSync(stagingPath, "wx");
        } catch (error) {
          return err(stagingWriteFailed(stagingPath, error));
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
        let total = 0;
        for (;;) {
          let read: number;
          try {
            read = readSync(source, buffer, 0, buffer.length, null);
          } catch (error) {
            return err(unreadableSource(request.sourcePath, error));
          }
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
          try {
            // A partial write must never pass the same-pass hash as complete
            // bytes, so the write loops until every read byte landed.
            let written = 0;
            while (written < read) {
              const count = writeSync(staged, buffer, written, read - written);
              if (count <= 0) throw new Error(`The staged write made no progress after ${written} of ${read} bytes.`);
              written += count;
            }
          } catch (error) {
            return err(stagingWriteFailed(stagingPath, error));
          }
          total += read;
        }
        try {
          fsyncSync(staged);
        } catch (error) {
          return err(stagingWriteFailed(stagingPath, error));
        }
        closeSync(source);
        closeSync(staged);
        source = undefined;
        staged = undefined;
        return ok({ stagingPath: reportedStagingPath, sizeBytes: total, sha256: hash.digest("hex") });
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Staging ${request.sourcePath} failed unexpectedly: ${messageOf(error)}.`, {
            sourcePath: request.sourcePath,
            stagingPath: reportedStagingPath,
            cause: String(error),
          }),
        );
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
        // The managed parent check keeps a symlinked or special directory in
        // the managed chain from being created through or renamed into
        // (section 6.2 canaries).
        const parentKey = request.storageKey.slice(0, request.storageKey.lastIndexOf("/"));
        try {
          managedDirectory(vaultPath, parentKey, true);
        } catch (managedError) {
          if (managedError instanceof UnsafeManagedPathError) {
            return err(
              appError("INTERNAL_ERROR", `The managed path ${request.storageKey} is unsafe.`, {
                storageKey: request.storageKey,
              }),
            );
          }
          throw managedError;
        }
        renameSync(request.stagingPath, destination);
        // The parent must be durable before any caller commits materialized = 1 (VLT-022).
        fsyncDirectory(dirname(destination));
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
      // Serving-path resolution adopts the managed guard (VLT-020, section 6.2
      // canaries): a symlinked or special managed parent or leaf is refused
      // instead of resolved, an absent leaf is a visible missing-Artifact
      // failure, and the selected root stays a legitimate alias through its
      // canonical resolution. The returned notation keeps the selected root so
      // the caller-visible localPath contract is unchanged; safe open
      // ownership belongs to openReadable.
      try {
        const { stat } = managedFile(vaultPath, storageKey);
        if (stat === undefined) {
          return err(
            appError("ARTIFACT_CORRUPTED", `The Artifact at ${storageKey} is missing from its storage key.`, {
              storageKey,
            }),
          );
        }
        return ok(join(vaultPath, storageKey));
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) {
          return err(
            appError("ARTIFACT_CORRUPTED", `The managed path ${storageKey} is unsafe for serving.`, { storageKey }),
          );
        }
        return err(
          appError("ARTIFACT_CORRUPTED", `Inspecting the managed path ${storageKey} failed: ${messageOf(error)}.`, {
            storageKey,
            cause: String(error),
          }),
        );
      }
    },

    openReadable(storageKey: string): Result<ArtifactReadHandle, AppError> {
      if (!isManagedStorageKey(storageKey)) {
        return err(
          appError("INTERNAL_ERROR", `The storage key is not a managed artifacts/ key: ${storageKey}.`, {
            storageKey,
          }),
        );
      }
      let handle: number;
      try {
        // The managed open refuses a symlinked or special leaf with O_NOFOLLOW,
        // never blocks on a special entry (O_NONBLOCK), and verifies the opened
        // regular-file identity before any byte is read (section 6.2 canaries).
        handle = openManagedFile(vaultPath, storageKey);
      } catch (error) {
        return err(servingUnavailable(storageKey, error));
      }
      let closed = false;
      const close = (): void => {
        if (closed) return;
        // Ownership is consumed before the single close attempt: a failed OS
        // close may still have closed the descriptor, and the descriptor
        // number may be reused, so a retry can never close a second time.
        // The original close failure propagates, so a local-path preparation
        // refuses instead of settling on a failed close (VLT-020, section
        // 11.3).
        closed = true;
        closeSync(handle);
      };
      const disposeQuietly = (): void => {
        try {
          close();
        } catch {
          // Cleanup must not mask the typed corruption error it follows.
        }
      };
      let sizeBytes: number;
      try {
        sizeBytes = fstatSync(handle).size;
      } catch (error) {
        // A disposal failure here must never replace the typed serving error.
        disposeQuietly();
        return err(servingUnavailable(storageKey, error));
      }
      return ok({
        sizeBytes,
        read(position: number, maxLength: number): Result<Uint8Array, AppError> {
          if (closed) {
            return err(
              appError("ARTIFACT_CORRUPTED", `The Artifact at ${storageKey} was closed before this read.`, {
                storageKey,
              }),
            );
          }
          if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(maxLength) || maxLength <= 0) {
            return err(
              appError(
                "INTERNAL_ERROR",
                `The bounded read of ${storageKey} needs a nonnegative position and a positive length.`,
                { storageKey, position, maxLength },
              ),
            );
          }
          if (position >= sizeBytes) return ok(new Uint8Array(0));
          const length = Math.min(maxLength, STREAM_BUFFER_BYTES, sizeBytes - position);
          const buffer = Buffer.allocUnsafe(length);
          let total = 0;
          while (total < length) {
            let count: number;
            try {
              count = readSync(handle, buffer, total, length - total, position + total);
            } catch (error) {
              // An actual read error disposes the acquired descriptor while
              // the typed corruption error stays the answer.
              disposeQuietly();
              return err(servingReadFailed(storageKey, error));
            }
            if (count === 0) {
              // Zero bytes before the recorded end of the body must terminate
              // visibly instead of looping or silently claiming completion,
              // and the descriptor is disposed rather than retained.
              disposeQuietly();
              return err(servingReadFailed(storageKey, new Error("the descriptor ended before the recorded size")));
            }
            total += count;
          }
          return ok(new Uint8Array(buffer.buffer, buffer.byteOffset, total));
        },
        close,
      });
    },

    exists(storageKey: string): Result<boolean, AppError> {
      const path = resolveManagedPath(storageKey);
      if (!path.ok) return err(path.error);
      try {
        // The managed leaf check keeps a symlink or special entry from being
        // reported as ordinary stored content (section 6.2 canaries).
        return ok(managedFile(vaultPath, storageKey).stat !== undefined);
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) {
          return err(appError("INTERNAL_ERROR", `The managed path ${storageKey} is unsafe.`, { storageKey }));
        }
        return err(
          appError("INTERNAL_ERROR", `Inspecting ${storageKey} failed: ${messageOf(error)}.`, {
            storageKey,
            cause: String(error),
          }),
        );
      }
    },

    remove(storageKey: string): Result<void, AppError> {
      // Every mutation funnels through the move lock and the marker guard, the
      // same boundary activate and stage enforce (RUN-014, VLT-019).
      const opened = guard();
      if (!opened.ok) return err(opened.error);
      if (!isManagedStorageKey(storageKey)) {
        return err(
          appError("INTERNAL_ERROR", `The storage key is not a managed artifacts/ key: ${storageKey}.`, {
            storageKey,
          }),
        );
      }
      // Serving and removal adopt the managed-path guards: a symlink or
      // special entry at a managed parent or leaf is refused rather than
      // followed, and only the managed-path classification turns into the
      // managed-key error — genuine I/O keeps its ordinary failure report
      // (VLT-020, section 6.2 canaries).
      try {
        const { path } = managedFile(vaultPath, storageKey);
        if (existsSync(path)) {
          unlinkSync(path);
          fsyncDirectory(dirname(path));
        }
        return ok(undefined);
      } catch (error) {
        if (error instanceof UnsafeManagedPathError) {
          return err(
            appError("INTERNAL_ERROR", `The managed path ${storageKey} is unsafe and was not removed.`, {
              storageKey,
            }),
          );
        }
        return err(appError("INTERNAL_ERROR", `Removing ${storageKey} failed: ${String(error)}.`, { storageKey }));
      }
    },
    checksum(storageKey: string): Result<string, AppError> {
      const path = resolveManagedPath(storageKey);
      if (!path.ok) return err(path.error);
      try {
        const hash = createHash("sha256");
        let handle: number | undefined;
        try {
          // The managed open refuses symlinked or special leaves with
          // O_NOFOLLOW and verifies the opened identity before any byte is
          // read (section 6.2 canaries).
          handle = openManagedFile(vaultPath, storageKey);
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
        if (error instanceof UnsafeManagedPathError) {
          return err(
            appError("INTERNAL_ERROR", `The managed path ${storageKey} is unsafe and was not read.`, {
              storageKey,
            }),
          );
        }
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

function unreadableSource(sourcePath: string, error: unknown): AppError {
  return appError("INTERNAL_ERROR", `The source ${sourcePath} could not be read: ${messageOf(error)}.`, {
    sourcePath,
    cause: String(error),
  });
}

/**
 * An unsafe, missing, or unreadable serving acquisition is one visible
 * corruption failure of the Handoff read boundary (VLT-020, section 11.3);
 * the store's maintenance methods keep their own error families.
 */
function servingUnavailable(storageKey: string, error: unknown): AppError {
  return appError(
    "ARTIFACT_CORRUPTED",
    `The Artifact at ${storageKey} is missing, unsafe, or unreadable at its storage key.`,
    { storageKey, cause: String(error) },
  );
}

/** A read that fails or ends early must terminate visibly, never spin or claim the promised bytes. */
function servingReadFailed(storageKey: string, error: unknown): AppError {
  return appError("ARTIFACT_CORRUPTED", `Reading the Artifact at ${storageKey} failed mid-stream.`, {
    storageKey,
    cause: String(error),
  });
}

/**
 * A failure writing the staged copy is never a statement about the source: a
 * full disk or an unwritable staging directory must point recovery at the
 * Vault, not at the sender's file (the closed catalogue has no dedicated code,
 * so it surfaces as INTERNAL_ERROR with an explicit message).
 */
function stagingWriteFailed(stagingPath: string, error: unknown): AppError {
  return appError("INTERNAL_ERROR", `Writing the staged copy ${stagingPath} failed: ${messageOf(error)}.`, {
    stagingPath,
    cause: String(error),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
