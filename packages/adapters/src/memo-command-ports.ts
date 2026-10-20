import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  appError,
  err,
  decodeStrictUtf8,
  SystemClock,
  UuidGenerator,
  type AcceptedMemoBody,
  type AppError,
  type Clock,
  type MemoBodyRef,
  type MemoCommandPorts,
  type ProjectCommandPorts,
  type Result,
} from "@sorage/core";
import { createConfigStore } from "./config-store";
import { managedRoot } from "./managed-paths";
import {
  activateCommonFile,
  completeCommonIntentTx,
  createSqliteContentStore,
  type SqliteContentStore,
} from "./content-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts, vaultMoveLockHeld } from "./lockfile";
import { captureMemoBodyText, createAcceptedBodyCapture, streamMemoSpool } from "./memo-body-file";
import { releaseMemoInputSpool, sweepMemoInputSpool } from "./memo-input-spool";
import { createSqliteMemoRepository } from "./memos";
import { appendStructuredLog } from "./structured-log";
import { createNodeProjectPorts } from "./project-command-ports";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
import { createSqliteEventLedger } from "./events";

/** Keeps database admission details inside the composition boundary. */
export function memoStorageError(error: unknown): AppError {
  return asSchemaAdmission(error) ?? appError("INTERNAL_ERROR", "Memo storage could not be opened");
}

/**
 * The one adapter-owned accepted-body capture seam exposed to the HTTP
 * transport (W1 pin): the daemon's multipart ingestion pushes verified part
 * bytes through this factory — fatal UTF-8, NUL, current bound, size and
 * SHA-256, and the 65,536-byte inline threshold spilling into the operation's
 * owned `memo-input` spool — so the validation lives once in the adapters and
 * the apps never private-import memo-body-file, config, lock, or spool
 * modules. The standalone release mirror lets the transport free an accepted
 * body's owned spool through this same allowed composition.
 */
export { createAcceptedBodyCapture };
export type { AcceptedBodyCapture, MemoBodyCaptureOptions } from "./memo-body-file";
export function releaseAcceptedMemoBody(accepted: AcceptedMemoBody): void {
  if (accepted.kind === "spool") releaseMemoInputSpool(accepted.spoolPath);
}

export interface NodeMemoPortsOptions {
  env?: HomeEnvironment;
  userHome?: string;
  database?: SorageSqlite;
  clock?: Clock;
}

export type NodeMemoPorts = ReturnType<typeof createNodeMemoPorts>;

/** Optional startup maintenance, without opening or migrating the database. */
export function sweepMemoAcceptedInputs(options: NodeMemoPortsOptions = {}): void {
  const env: HomeEnvironment = options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME };
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const current = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome }).read();
  if (!current.ok || !current.value) return;
  sweepMemoInputSpool(home.stateDir, {
    graceHours: current.value.config.gc.graceHours,
    now: (options.clock ?? new SystemClock()).now(),
  });
}

/**
 * The production Memo composition (ADR-0032 plan): the database connection —
 * never the configuration — opens first, so every attempt can capture the
 * connection-local external-commit counter before its fresh configuration
 * binding; the preliminary configuration read that follows preserves the
 * initialized/config-readability and schema-admission behavior. Every body
 * read, scan, preview, staging pass, and activation runs against the binding
 * its own operation captured — a completed Vault move can never leave a
 * reader, a staged file, or an activation aimed at the abandoned Vault. The
 * CLI owns and closes its connection; the daemon supplies its existing shared
 * connection.
 */
export function createNodeMemoPorts(options: NodeMemoPortsOptions = {}): MemoCommandPorts & {
  projectPorts: ProjectCommandPorts;
  close(): void;
  releaseAcceptedBody(accepted: AcceptedMemoBody): void;
  /** The resolved home state tree carrying the private accepted-input spool area. */
  stateDir: string;
  /** The configured `gc.graceHours` window the spool backstop sweep honors. */
  graceHours: number;
} {
  const env: HomeEnvironment = options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME };
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const plan = productionMigrationPlan();
  const db =
    options.database ??
    openAndMigrate(resolve(home.stateDir, "sorage.sqlite3"), plan.migrations, {
      rebuilds: plan.rebuilds,
    }).db;
  try {
    const configStore = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
    const read = configStore.read();
    if (!read.ok || !read.value) throw new Error("Memo configuration could not be read");
    const config = read.value.config;
    const clock = options.clock ?? new SystemClock();
    const ledger = createSqliteEventLedger(db);
    const contentStore = createSqliteContentStore({
      db,
      vaultPath: config.vault.path,
      installationId: config.installationId,
      runDir: home.runDir,
      ledger,
    });
    const repository = createSqliteMemoRepository(db, { contentStore });
    const externalVersion = (): number => {
      const row = db.prepare("PRAGMA data_version").get() as { data_version: number } | null | undefined;
      return Number(row?.data_version ?? 0);
    };
    /** One content store aimed at the binding the current operation captured, not the composition-time path. */
    const boundStore = (binding: { vaultPath: string }): SqliteContentStore =>
      binding.vaultPath === config.vault.path
        ? contentStore
        : createSqliteContentStore({
            db,
            vaultPath: binding.vaultPath,
            installationId: config.installationId,
            runDir: home.runDir,
            ledger,
          });
    return {
      installationId: config.installationId,
      maxBytes: config.artifact.maxBytes,
      defaultPageSize: config.ui.defaultPageSize,
      clock,
      ids: new UuidGenerator(),
      memos: repository,
      disclosures: {
        backupEnabled: config.gitBackup.enabled,
        thresholdBytes: config.gitBackup.largeArtifactWarningBytes,
        largeContent: (sizeBytes: number, thresholdBytes: number) => {
          // The CLI attaches its own stderr sink after composition; the
          // composition-level default records the structured diagnostic so an
          // unwired caller still leaves evidence (a log write is never user
          // delivery, per the plain-HTTP disclosure documentation).
          appendStructuredLog(
            { level: "warn", event: "LARGE_CONTENT_DISCLOSED", domain: "memo", sizeBytes, thresholdBytes },
            home,
            config.logging,
          );
        },
      },
      bodies: {
        spoolSource: (spoolPath) => ({
          stream(sink) {
            return streamMemoSpool(spoolPath, sink);
          },
        }),
        scanBodyForQuery: (ref, query, binding) => scanBodyForQuery(boundStore(binding), ref, query),
        readBodyPreviewSeed: (ref, binding) => readBodyPreviewSeed(boundStore(binding), ref),
        resolveBody: (ref, binding) => resolveBody(boundStore(binding), ref),
      },
      coherence: {
        captureExternalVersion: () => ({ ok: true, value: externalVersion() }),
        classifyExternalChange: (expectedVaultPath) => {
          if (vaultMoveLockHeld(home.runDir)) {
            return { ok: true, value: "vault-move-held" as const };
          }
          const current = configStore.read();
          if (!current.ok) return current;
          if (!current.value) return err(appError("INTERNAL_ERROR", "Memo configuration could not be re-read"));
          return {
            ok: true as const,
            value:
              current.value.config.vault.path === expectedVaultPath
                ? ("external-commit" as const)
                : ("vault-path-changed" as const),
          };
        },
        moveLockHeld: () => vaultMoveLockHeld(home.runDir),
      },
      staging: {
        freshBinding: () => {
          const current = configStore.read();
          if (!current.ok) return current;
          if (!current.value)
            return { ok: false, error: appError("INTERNAL_ERROR", "Memo configuration could not be re-read") };
          return { ok: true, value: { vaultPath: current.value.config.vault.path } };
        },
        stageAccepted: (accepted, binding) => {
          if (accepted.kind === "spool") {
            const staged = boundStore(binding).stage({
              sourcePath: accepted.spoolPath,
              maxBytes: config.artifact.maxBytes,
              tooLargeCode: "MEMO_TOO_LARGE",
            });
            if (!staged.ok) return staged;
            return relativeStaged(
              staged.value.stagingPath,
              binding.vaultPath,
              staged.value.sizeBytes,
              staged.value.sha256,
            );
          }
          // A large in-memory text (the JSON transport's bounded string) reaches
          // the Vault through the same two guarded primitives a file body uses:
          // the owned private spool capture — bounded chunks, scalar and NUL
          // validation before any encode — and the content store's
          // managed-path-guarded streaming stage. No raw Vault write bypasses
          // those guards, and the temporary owned spool is released on every
          // exit; the accepted input itself stays immutable (ADR-0032 plan).
          const spoolId = randomUUID();
          const captured = captureMemoBodyText(accepted.text, {
            maxBytes: config.artifact.maxBytes,
            stateDir: home.stateDir,
            spoolId,
          });
          if (!captured.ok) return captured;
          if (captured.value.kind !== "spool") {
            return {
              ok: false,
              error: appError(
                "INTERNAL_ERROR",
                "A Vault-routed Memo text must spill to its owned spool before staging",
              ),
            };
          }
          try {
            const staged = boundStore(binding).stage({
              sourcePath: captured.value.spoolPath,
              maxBytes: config.artifact.maxBytes,
              tooLargeCode: "MEMO_TOO_LARGE",
            });
            if (!staged.ok) return staged;
            return relativeStaged(
              staged.value.stagingPath,
              binding.vaultPath,
              staged.value.sizeBytes,
              staged.value.sha256,
            );
          } finally {
            releaseMemoInputSpool(captured.value.spoolPath);
          }
        },
        activateContent: (input, binding) => {
          // The post-commit gate: a held lock leaves the committed intent durably
          // pending, emits no fabricated event, and reports MATERIALIZING honestly.
          if (vaultMoveLockHeld(home.runDir)) return { ok: true, value: { status: "paused" as const } };
          const outcome = activateCommonFile({
            vaultPath: binding.vaultPath,
            fromPath: input.stagedPath,
            toPath: input.storageKey,
            expect: { sizeBytes: input.sizeBytes, sha256: input.sha256 },
          });
          const completion = completeCommonIntentTx(db, ledger, input.intentId, outcome);
          if (!completion.ok) return completion;
          return { ok: true, value: { status: "completed" as const } };
        },
      },
      projectPorts: createNodeProjectPorts({ env, userHome, database: db }),
      close: () => {
        if (!options.database) db.close();
      },
      releaseAcceptedBody: (accepted) => {
        if (accepted.kind === "spool") releaseMemoInputSpool(accepted.spoolPath);
      },
      stateDir: home.stateDir,
      graceHours: config.gc.graceHours,
    };
  } catch (error) {
    if (!options.database) db.close();
    throw error;
  }
}

function relativeStaged(
  stagingPath: string,
  vaultPath: string,
  sizeBytes: number,
  sha256: string,
): Result<{ stagedPath: string; sizeBytes: number; sha256: string }, AppError> {
  let stagedPath: string;
  try {
    stagedPath = relative(managedRoot(vaultPath), stagingPath);
  } catch (error) {
    return err(appError("INTERNAL_ERROR", "The bound Memo Vault root could not be resolved", { cause: String(error) }));
  }
  if (stagedPath.startsWith("..") || stagedPath.length === 0) {
    return { ok: false, error: appError("INTERNAL_ERROR", "The staged Memo body escaped the bound Vault") };
  }
  return { ok: true, value: { stagedPath, sizeBytes, sha256 } };
}

/** Verifies the opened handle carries the reference's exact recorded identity before any byte is served (SHR-008). */
function requireRefIdentity(
  handle: { sizeBytes: number; sha256: string; recordId: string },
  ref: MemoBodyRef,
): Result<void, AppError> {
  if (handle.recordId !== ref.recordId || handle.sizeBytes !== ref.sizeBytes || handle.sha256 !== ref.sha256) {
    return {
      ok: false,
      error: appError("CONTENT_CORRUPTED", "The content record no longer carries the reference's recorded identity", {
        recordId: ref.recordId,
        referencedSizeBytes: ref.sizeBytes,
        referencedSha256: ref.sha256,
        actualSizeBytes: handle.sizeBytes,
        actualSha256: handle.sha256,
      }),
    };
  }
  return { ok: true, value: undefined };
}

/** The bounded literal scan over one immutable record's verified bytes (SHR-007). */
function scanBodyForQuery(store: SqliteContentStore, ref: MemoBodyRef, query: string): Result<boolean, AppError> {
  const opened = store.openBody(ref.recordId, { verifyFileDigest: "always" });
  if (!opened.ok) return opened;
  const handle = opened.value;
  try {
    const identity = requireRefIdentity(handle, ref);
    if (!identity.ok) return identity;
    const needle = Buffer.from(query, "utf8");
    if (needle.byteLength === 0) return { ok: true, value: true };
    const overlap = needle.byteLength - 1;
    let position = 0;
    let carry: Uint8Array = new Uint8Array(0);
    for (;;) {
      const chunk = handle.read(position, 64 * 1024);
      if (!chunk.ok) return chunk;
      if (chunk.value.byteLength === 0) return { ok: true, value: false };
      const window = Buffer.concat([carry, chunk.value]);
      if (window.indexOf(needle) !== -1) return { ok: true, value: true };
      carry = window.subarray(Math.max(0, window.length - overlap));
      position += chunk.value.byteLength;
    }
  } finally {
    handle.close();
  }
}

/** Reads the bounded head bytes for the shared preview rule (SHR-012, MEM-011). */
function readBodyPreviewSeed(store: SqliteContentStore, ref: MemoBodyRef): Result<string, AppError> {
  const opened = store.openBody(ref.recordId, { verifyFileDigest: "always" });
  if (!opened.ok) return opened;
  const handle = opened.value;
  try {
    const identity = requireRefIdentity(handle, ref);
    if (!identity.ok) return identity;
    const chunk = handle.read(0, 2048);
    if (!chunk.ok) return chunk;
    const bytes = chunk.value;
    const complete = decodeStrictUtf8(bytes);
    if (complete !== null) return { ok: true, value: complete };
    // Only a bounded head of a longer body may end inside one scalar. A
    // complete body, including an empty body, must decode exactly as stored.
    if (handle.sizeBytes > bytes.byteLength) {
      for (let trim = 1; trim < 4; trim++) {
        const text = decodeStrictUtf8(bytes.subarray(0, bytes.byteLength - trim));
        if (text !== null) return { ok: true, value: text };
      }
    }
    return {
      ok: false,
      error: appError("CONTENT_CORRUPTED", "The Memo body head is not valid UTF-8", { recordId: ref.recordId }),
    };
  } finally {
    handle.close();
  }
}

/** Resolves one record's complete exact text outside any transaction (SHR-005, SHR-008). */
function resolveBody(store: SqliteContentStore, ref: MemoBodyRef): Result<string, AppError> {
  const opened = store.openBody(ref.recordId, { verifyFileDigest: "always" });
  if (!opened.ok) return opened;
  const handle = opened.value;
  try {
    const identity = requireRefIdentity(handle, ref);
    if (!identity.ok) return identity;
    const parts: Uint8Array[] = [];
    let position = 0;
    for (;;) {
      const chunk = handle.read(position, 64 * 1024);
      if (!chunk.ok) return chunk;
      if (chunk.value.byteLength === 0) break;
      parts.push(chunk.value);
      position += chunk.value.byteLength;
    }
    const bytes = Buffer.concat(parts);
    const text = decodeStrictUtf8(bytes);
    if (text === null) {
      return {
        ok: false,
        error: appError("CONTENT_CORRUPTED", "The Memo body bytes do not decode as UTF-8", { recordId: ref.recordId }),
      };
    }
    return { ok: true, value: text };
  } finally {
    handle.close();
  }
}
