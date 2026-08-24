import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  appError,
  applyConfigurationToDocument,
  emptyConfigurationDocument,
  err,
  loadConfiguration,
  ok,
  parseConfigurationFile,
  serializeConfiguration,
  validateConfiguration,
  type AppError,
  type Configuration,
  type Result,
} from "@sorage/core";
import type { HomePaths } from "./home";
import { acquireLock, type LockProbePorts } from "./lockfile";

/**
 * The atomic configuration store (CFG-010 to CFG-012, CFG-015, CFG-019, SEC-016),
 * implementing the ten-step write of domain-and-architecture section 21: acquire
 * `config.lock`, compare the expected ETag or revision, validate the complete
 * proposal, write and `fsync` a temporary file in the same directory, replace the
 * single `.bak` only after validation, rename atomically with a parent `fsync`,
 * restore owner-only permissions, and release the lock. The ETag is the SHA-256 of
 * the canonical file content, never of `configRevision`, because a manual edit does
 * not bump the counter (CFG-019).
 */
export interface ConfigStoreFs {
  writeFile(path: string, data: string): void;
  readFile(path: string): string;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  mkdir(path: string): void;
  fsync(path: string): void;
  copyFile(from: string, to: string): void;
  chmod(path: string, mode: number): void;
}

const realConfigStoreFs: ConfigStoreFs = {
  writeFile: (path, data) => writeFileSync(path, data, { encoding: "utf8" }),
  readFile: (path) => readFileSync(path, "utf8"),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  // fsync(2) needs no write permission, and "r" is the only mode that opens a
  // directory, so one read-only descriptor serves both the file and the parent.
  fsync: (path) => {
    const handle = openSync(path, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  },
  copyFile: (from, to) => copyFileSync(from, to),
  chmod: (path, mode) => chmodSync(path, mode),
};

export interface ConfigStorePorts {
  home: HomePaths;
  lockPorts: LockProbePorts;
  userHome: string;
  fs?: ConfigStoreFs | undefined;
}

export interface ReadConfiguration {
  config: Configuration;
  etag: string;
  revision: number;
}

export interface WriteExpectation {
  revision?: number | undefined;
  etag?: string | undefined;
}

export interface WrittenConfiguration {
  config: Configuration;
  etag: string;
}

export interface ConfigStore {
  /** Reads and fully validates the current file; null when none exists yet. */
  read(): Result<ReadConfiguration | null, AppError>;
  /** The raw file bytes as text, or null when no file exists. */
  readText(): string | null;
  /** The SHA-256 content hash of the canonical file, or null when absent. */
  etag(): string | null;
  /** Performs one atomic Sorage-mediated write under `config.lock`. The proposal is
   * the file view, so `vault.path` keeps its literal tilde form exactly as it should
   * appear on disk; the store validates it and stamps the next monotonic revision. */
  write(next: Configuration, expect?: WriteExpectation): Result<WrittenConfiguration, AppError>;
  /** Atomically writes validated raw bytes under `config.lock` without applying a
   * document edit; used to restore a known-good file after a rejected editor pass. */
  writeRaw(text: string): Result<{ etag: string }, AppError>;
}

export function createConfigStore(ports: ConfigStorePorts): ConfigStore {
  const fs = ports.fs ?? realConfigStoreFs;
  const configFile = ports.home.configFile;
  const backupFile = `${configFile}.bak`;

  function currentText(): string | null {
    try {
      return fs.readFile(configFile);
    } catch {
      return null;
    }
  }

  function contentEtag(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  function withConfigLock<T>(body: () => Result<T, AppError>): Result<T, AppError> {
    const lock = acquireLock({ path: ports.home.lockFile("config"), lock: "config", ports: ports.lockPorts });
    if (!lock.ok) {
      return err(
        appError("SERVICE_PAUSED", "another process is writing the configuration; wait for it to finish and retry", {
          lock: "config.lock",
          holder: lock.error.record ?? undefined,
        }),
      );
    }
    try {
      return body();
    } finally {
      lock.release();
    }
  }

  /** Steps 6 to 9: temporary write, fsync, validated .bak swap, rename, permissions. */
  function swapIn(text: string, previousExists: boolean): void {
    fs.mkdir(dirname(configFile));
    const temporary = `${configFile}.tmp-${process.pid}`;
    fs.writeFile(temporary, text);
    fs.fsync(temporary);
    try {
      // The single .bak holds the previous valid file, replaced only after validation.
      if (previousExists) {
        fs.copyFile(configFile, backupFile);
        fs.chmod(backupFile, 0o600);
      }
      fs.rename(temporary, configFile);
      fs.fsync(dirname(configFile));
      fs.chmod(configFile, 0o600);
    } catch (error) {
      // A failed swap must not leave a temporary file behind for a later rename.
      try {
        fs.unlink(temporary);
      } catch {
        // The rename may already have consumed it.
      }
      throw error;
    }
  }

  return {
    read() {
      const text = currentText();
      if (text === null) return ok(null);
      const loaded = loadConfiguration(text, { userHome: ports.userHome, sorageHome: ports.home.home });
      if (!loaded.ok) return loaded;
      return ok({ config: loaded.value.config, etag: contentEtag(text), revision: loaded.value.config.configRevision });
    },

    readText() {
      return currentText();
    },

    etag() {
      const text = currentText();
      return text === null ? null : contentEtag(text);
    },

    write(next, expect) {
      return withConfigLock(() => writeUnderLock(next, expect));

      function writeUnderLock(
        proposal: Configuration,
        expectation?: WriteExpectation,
      ): Result<WrittenConfiguration, AppError> {
        const text = currentText();
        const existing =
          text === null ? null : loadConfiguration(text, { userHome: ports.userHome, sorageHome: ports.home.home });
        if (existing !== null && !existing.ok) return existing;

        const currentRevision = existing === null ? 0 : existing.ok ? existing.value.config.configRevision : 0;
        if (expectation?.revision !== undefined && expectation.revision !== currentRevision) {
          return err(conflict(`expected configRevision ${expectation.revision} but the file is at ${currentRevision}`));
        }
        if (text !== null) {
          const etag = contentEtag(text);
          if (expectation?.etag !== undefined && expectation.etag !== etag) {
            return err(conflict("the configuration changed since it was read; re-read and retry"));
          }
        }

        // Step 4: validate the complete proposed configuration before anything lands.
        const proposed: Configuration = { ...proposal, configRevision: currentRevision + 1 };
        const validated = validateConfiguration(proposed);
        if (!validated.ok) return validated;

        // Step 5: serialize through the current document so comments and key order survive.
        const document = existing !== null && existing.ok ? existing.value.document : emptyConfigurationDocument();
        applyConfigurationToDocument(document, proposed);
        const serialized = serializeConfiguration({ config: proposed, document });

        swapIn(serialized, text !== null);
        return ok({ config: proposed, etag: contentEtag(serialized) });
      }
    },

    writeRaw(text) {
      return withConfigLock(() => {
        // Raw bytes still pass full validation before they can become canonical.
        const validated = parseConfigurationFile(text);
        if (!validated.ok) return validated;
        swapIn(text, currentText() !== null);
        return ok({ etag: contentEtag(text) });
      });
    },
  };
}

function conflict(message: string): AppError {
  return appError("CONFIG_CONFLICT", message);
}
