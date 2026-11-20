import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  type AppError,
  appError,
  CONTENT_INLINE_MAX_UTF8_BYTES,
  decodeStrictUtf8,
  err,
  isMemoUuid,
  ok,
  type Result,
} from "@sorage/core";
import { fsyncDirectory } from "./intent-log";
import { vaultMoveLockHeld, vaultMovePauseRefusal } from "./lockfile";
import {
  digestManagedFile,
  managedDirectory,
  managedFile,
  managedPath,
  managedRoot,
  openManagedFile,
  UnsafeManagedPathError,
} from "./managed-paths";
import type { SorageSqlite } from "./sqlite/connection";
import { runInTransaction } from "./sqlite/transaction";

interface ExchangeWorkingStoreOptions {
  db: SorageSqlite;
  stateDir: string;
  vaultPath: string;
  runDir?: string;
}

interface ActivationRow {
  content_id: string;
  staging_key: string;
  storage_key: string;
  size_bytes: number;
  sha256: string;
}

interface ExchangeWorkingBody {
  exchangeId: string;
  /** The upstream domain surface decides whether it accepts text or binary. */
  classification: "text" | "binary";
  chunks: Iterable<Uint8Array>;
  maxBytes: number;
}

interface ExchangeWorkingIdentity {
  id: string;
  sizeBytes: number;
  sha256: string;
}

export interface PreparedExchangeBody extends ExchangeWorkingIdentity {
  exchangeId: string;
  inline: string | null;
}

function contains(root: string, path: string): boolean {
  const key = relative(root, path);
  return key === "" || (!isAbsolute(key) && key !== ".." && !key.startsWith(`..${sep}`));
}

/** Never resolve Exchange keys under the chosen Vault, including through aliases. */
function workingBoundary(options: ExchangeWorkingStoreOptions): string {
  const state = managedRoot(options.stateDir);
  const vault = managedRoot(options.vaultPath);
  const candidate = join(state, "exchange-working");
  // The operational SQLite file is itself a working-body container, so a
  // Vault containing the state root is unsafe even for a small inline body.
  if (contains(vault, state) || contains(vault, candidate) || contains(candidate, vault)) {
    throw new UnsafeManagedPathError("Exchange working storage must be outside the Vault");
  }
  return state;
}

function workingRoot(options: ExchangeWorkingStoreOptions, create: boolean): string {
  const state = workingBoundary(options);
  const root = managedDirectory(state, "exchange-working", create, 0o700);
  if (root === undefined) throw new Error("Exchange working storage is missing");
  if (create) fsyncDirectory(state);
  return root;
}

function contentFailure(error: unknown, contentId?: string): AppError {
  return appError("STORAGE_INTEGRITY_ERROR", "Exchange working storage could not be used safely.", {
    contentId,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function databaseFailure(error: unknown): AppError {
  return appError("INTERNAL_ERROR", "Updating Exchange working storage failed.", { cause: String(error) });
}

/** Finish a previously committed intent outside its transactions. Repeating after a crash is safe. */
function activate(root: string, intent: ActivationRow): void {
  if (
    !isMemoUuid(intent.content_id) ||
    intent.staging_key !== `staging/${intent.content_id}` ||
    intent.storage_key !== `content/${intent.content_id}`
  ) {
    throw new UnsafeManagedPathError("An Exchange activation intent does not match its state keys");
  }
  const verify = (key: string): void => {
    const content = digestManagedFile(root, key);
    if (content.sizeBytes !== intent.size_bytes || content.sha256 !== intent.sha256) {
      throw new Error("Exchange working content does not match its recorded size and digest");
    }
  };
  const source = managedFile(root, intent.staging_key);
  const destination = managedFile(root, intent.storage_key);
  if (destination.stat === undefined) {
    try {
      if (source.stat !== undefined) verify(intent.staging_key);
      const path = managedPath(root, intent.storage_key, true, 0o700);
      // An idempotent peer may already have placed the destination. A
      // no-clobber link keeps both paths available for integrity checks.
      linkSync(source.path, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EEXIST" && code !== "ENOENT") || managedFile(root, intent.storage_key).stat === undefined) {
        throw error;
      }
    }
  }
  verify(intent.storage_key);
  fsyncDirectory(dirname(destination.path));
  fsyncDirectory(root);
  if (managedFile(root, intent.staging_key).stat !== undefined) {
    try {
      verify(intent.staging_key);
      unlinkSync(source.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Persist a prior stage unlink or removal of the whole staging directory.
  fsyncDirectory(managedDirectory(root, "staging") ?? root);
}

export function createExchangeWorkingStore(options: ExchangeWorkingStoreOptions) {
  const { db, runDir } = options;
  const tx = { failure: databaseFailure };
  const paused = () => runDir !== undefined && vaultMoveLockHeld(runDir);
  const pauseRefusal = () => vaultMovePauseRefusal(runDir === undefined ? undefined : join(runDir, "vault-move.lock"));

  function complete(intent: ActivationRow): Result<void> {
    if (paused()) return err(pauseRefusal());
    try {
      activate(workingRoot(options, false), intent);
    } catch (error) {
      const noted = runInTransaction(
        db,
        "BEGIN IMMEDIATE",
        () => {
          db.prepare("UPDATE exchange_activation_intents SET attempts = attempts + 1 WHERE content_id = ?").run(
            intent.content_id,
          );
          return ok(undefined);
        },
        tx,
      );
      return noted.ok ? err(contentFailure(error, intent.content_id)) : noted;
    }
    return runInTransaction(
      db,
      "BEGIN IMMEDIATE",
      () => {
        db.prepare("UPDATE exchange_working_content SET materialized = 1 WHERE id = ?").run(intent.content_id);
        db.prepare("DELETE FROM exchange_activation_intents WHERE content_id = ?").run(intent.content_id);
        return ok(undefined);
      },
      tx,
    );
  }

  /** Prepare bytes without creating database authority. */
  function prepare(input: ExchangeWorkingBody): Result<PreparedExchangeBody> {
    if (paused()) return err(pauseRefusal());
    if (!isMemoUuid(input.exchangeId) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      return err(appError("INTERNAL_ERROR", "Invalid Exchange working-content identity or byte bound."));
    }
    const id = randomUUID();
    const staging = `staging/${id}`;
    let root: string | undefined;
    let staged: string | undefined;
    let handle: number | undefined;
    let prepared = false;
    try {
      // Small UTF-8 content may stay inline, so buffer only the threshold.
      const prefix: Uint8Array[] = [];
      let length = 0;
      const hash = createHash("sha256");
      const writeBytes = (bytes: Uint8Array): void => {
        let written = 0;
        while (written < bytes.byteLength) {
          const count = writeSync(handle as number, bytes, written, bytes.byteLength - written);
          if (count <= 0) throw new Error("Exchange staging did not make progress");
          written += count;
        }
      };
      const startFile = (): void => {
        root = workingRoot(options, true);
        const path = managedPath(root, staging, true, 0o700);
        handle = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        staged = path;
        for (const bytes of prefix) writeBytes(bytes);
        prefix.length = 0;
      };
      // Resolve the placement before reading input or writing DB state. We
      // don't require a pre-existing state subdirectory for an inline body.
      workingBoundary(options);
      for (const chunk of input.chunks) {
        if (chunk.byteLength > input.maxBytes - length) {
          return err(
            appError("ARTIFACT_TOO_LARGE", "The Exchange body crossed artifact.maxBytes.", {
              maxBytes: input.maxBytes,
            }),
          );
        }
        length += chunk.byteLength;
        hash.update(chunk);
        if (handle === undefined && (input.classification === "binary" || length > CONTENT_INLINE_MAX_UTF8_BYTES)) {
          startFile();
        }
        if (handle !== undefined) writeBytes(chunk);
        else if (chunk.byteLength > 0) prefix.push(Uint8Array.from(chunk));
      }
      const inline =
        handle === undefined && input.classification === "text"
          ? decodeStrictUtf8(Buffer.concat(prefix, length))
          : null;
      const sha256 = hash.digest("hex");
      if (inline !== null) {
        return ok({ id, exchangeId: input.exchangeId, inline, sizeBytes: length, sha256 });
      }
      if (handle === undefined) startFile();
      if (handle === undefined || staged === undefined) throw new Error("Exchange staging did not open");
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      fsyncDirectory(dirname(staged));
      fsyncDirectory(dirname(dirname(staged)));
      if (paused()) return err(pauseRefusal());
      prepared = true;
      return ok({ id, exchangeId: input.exchangeId, inline: null, sizeBytes: length, sha256 });
    } catch (error) {
      return err(contentFailure(error, id));
    } finally {
      try {
        if (handle !== undefined) closeSync(handle);
        if (!prepared && staged !== undefined && root !== undefined) {
          const pending = managedFile(root, staging);
          if (pending.stat !== undefined) unlinkSync(pending.path);
        }
      } catch {
        // Preserve the original failure; never follow a changed stage path.
      }
    }
  }

  function intentOf(body: PreparedExchangeBody): ActivationRow {
    return {
      content_id: body.id,
      staging_key: `staging/${body.id}`,
      storage_key: `content/${body.id}`,
      size_bytes: body.sizeBytes,
      sha256: body.sha256,
    };
  }

  /** Invoke only inside the same transaction as the body owner and its operation outcome. */
  function record(body: PreparedExchangeBody): void {
    if (body.inline !== null) {
      db.prepare(
        "INSERT INTO exchange_working_content (id, exchange_id, inline_text, size_bytes, sha256, materialized) VALUES (?, ?, CAST(? AS TEXT), ?, ?, 1)",
      ).run(body.id, body.exchangeId, Buffer.from(body.inline, "utf8"), body.sizeBytes, body.sha256);
      return;
    }
    const intent = intentOf(body);
    db.prepare(
      "INSERT INTO exchange_working_content (id, exchange_id, storage_key, size_bytes, sha256, materialized) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(body.id, body.exchangeId, intent.storage_key, body.sizeBytes, body.sha256);
    db.prepare("INSERT INTO exchange_activation_intents (content_id, staging_key) VALUES (?, ?)").run(
      body.id,
      intent.staging_key,
    );
  }

  function discard(body: PreparedExchangeBody): void {
    if (body.inline !== null) return;
    try {
      const pending = managedFile(workingRoot(options, false), intentOf(body).staging_key);
      if (pending.stat !== undefined) unlinkSync(pending.path);
    } catch {
      // Cleanup is best effort and must never follow a changed stage path.
    }
  }

  /** A failed COMMIT can leave the outcome uncertain until committed state can be read. */
  function discardAfterFailedCommit(body: PreparedExchangeBody): void {
    if (body.inline !== null) return;
    try {
      // The Bun and Node SQLite adapters expose the same autocommit state under different names.
      const inTransaction =
        "inTransaction" in db ? db.inTransaction : "isTransaction" in db ? db.isTransaction : undefined;
      if (inTransaction !== false) return;
      const owner = db
        .prepare(
          `SELECT 1 FROM exchange_working_content WHERE id = ?
          UNION ALL SELECT 1 FROM exchange_activation_intents WHERE content_id = ? OR staging_key = ? LIMIT 1`,
        )
        .get(body.id, body.id, intentOf(body).staging_key);
      if (owner === null || owner === undefined) discard(body);
    } catch {
      // An inconclusive observation leaves the exact stage available for recovery.
    }
  }

  function finish(body: PreparedExchangeBody): Result<void> {
    return body.inline !== null ? ok(undefined) : complete(intentOf(body));
  }

  function recover(exchangeId?: string, skipContentId?: string): Result<{ resolved: string[]; failures: AppError[] }> {
    const resolved: string[] = [];
    const failures: AppError[] = [];
    try {
      const intents = db
        .prepare<ActivationRow>(
          `SELECT i.content_id, i.staging_key, c.storage_key, c.size_bytes, c.sha256
        FROM exchange_activation_intents i LEFT JOIN exchange_working_content c ON c.id = i.content_id
        WHERE (? IS NULL OR c.exchange_id = ?) AND (? IS NULL OR i.content_id <> ?) ORDER BY i.content_id`,
        )
        .all(exchangeId ?? null, exchangeId ?? null, skipContentId ?? null, skipContentId ?? null);
      for (const intent of intents) {
        const outcome = complete(intent);
        if (outcome.ok) resolved.push(intent.content_id);
        else failures.push(outcome.error);
      }
    } catch (error) {
      return err(databaseFailure(error));
    }
    return ok({ resolved, failures });
  }

  return {
    prepare,
    record,
    discard,
    discardAfterFailedCommit,
    finish,
    recover,

    /** Standalone foundation fixture path. Producers attach record() to their domain transaction. */
    write(input: ExchangeWorkingBody): Result<ExchangeWorkingIdentity> {
      const body = prepare(input);
      if (!body.ok) return body;
      let commitAttempted = false;
      const inserted = runInTransaction(
        db,
        "BEGIN IMMEDIATE",
        () => {
          record(body.value);
          commitAttempted = true;
          return ok(undefined);
        },
        tx,
      );
      if (!inserted.ok) {
        if (!commitAttempted) discard(body.value);
        return inserted;
      }
      const completed = finish(body.value);
      const { id, sizeBytes, sha256 } = body.value;
      return completed.ok ? ok({ id, sizeBytes, sha256 }) : completed;
    },

    /** Read a verified slice on the existing admitted read connection. */
    planRead(exchangeId: string, id: string, offset: number, limit: number): Result<() => Result<Buffer>> {
      const body = db
        .prepare(
          "SELECT inline_text, storage_key, size_bytes, sha256, materialized FROM exchange_working_content WHERE id = ? AND exchange_id = ?",
        )
        .get(id, exchangeId) as
        | {
            inline_text: string | null;
            storage_key: string | null;
            size_bytes: number;
            sha256: string;
            materialized: number;
          }
        | undefined;
      if (!body) return err(appError("CONTENT_CORRUPTED", "The registered Exchange body record is missing."));
      if (!body.materialized) {
        return err({
          ...appError("CONTENT_MATERIALIZING", "The committed Exchange body is awaiting verified activation."),
          recovery: {
            suggestedCommand: "Run an authorized Exchange write or join for this Exchange, then retry the read",
          },
        });
      }
      if (offset > body.size_bytes) return err(appError("EXCHANGE_INVALID_INPUT", "The offset is past the body end."));
      return ok(() => {
        try {
          if (body.inline_text !== null) {
            const bytes = Buffer.from(body.inline_text, "utf8");
            if (bytes.length !== body.size_bytes || createHash("sha256").update(bytes).digest("hex") !== body.sha256) {
              throw new Error("The inline body disagrees with its recorded size or digest");
            }
            return ok(bytes.subarray(offset, offset + limit));
          }
          if (body.storage_key !== `content/${id}`) throw new Error("Invalid Exchange working-content key");
          const fd = openManagedFile(workingRoot(options, false), body.storage_key);
          try {
            const hash = createHash("sha256");
            const chunk = Buffer.alloc(65_536);
            const bytes = Buffer.alloc(Math.min(limit, body.size_bytes - offset));
            let position = 0;
            for (;;) {
              const count = readSync(fd, chunk, 0, chunk.length, position);
              if (count === 0) break;
              if (count > body.size_bytes - position) throw new Error("The file exceeds its recorded size");
              hash.update(chunk.subarray(0, count));
              const start = Math.max(offset, position);
              const end = Math.min(offset + bytes.length, position + count);
              if (end > start) chunk.copy(bytes, start - offset, start - position, end - position);
              position += count;
            }
            if (position !== body.size_bytes || hash.digest("hex") !== body.sha256) {
              throw new Error("The file disagrees with its recorded size or digest");
            }
            return ok(bytes);
          } finally {
            closeSync(fd);
          }
        } catch {
          return err({
            ...appError("CONTENT_CORRUPTED", "The verified Exchange working bytes are missing or corrupt."),
            recovery: {
              suggestedCommand:
                "Ask the owning Project to share new material. Exchange working bytes are outside backup",
            },
          });
        }
      });
    },

    /** Scoped Exchange recovery. Shared backup and Vault operations can proceed without disposable bytes. */
    drain(exchangeId?: string, skipContentId?: string): Result<string[]> {
      const result = recover(exchangeId, skipContentId);
      if (!result.ok) return result;
      const first = result.value.failures[0];
      return first ? err(first) : ok(result.value.resolved);
    },
  };
}
