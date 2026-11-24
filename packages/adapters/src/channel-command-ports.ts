import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  type AcceptedChannelBody,
  type AppError,
  appError,
  type ChannelCommandPorts,
  type Clock,
  err,
  type MessageBodyRef,
  ok,
  type ResolvedMessageBody,
  type Result,
  SystemClock,
  UuidGenerator,
} from "@sorage/core";
import { composeAdapterContext, openAdapterContext } from "./adapter-context";
import { createSqliteChannelRepository } from "./channels";
import { activateCommonFile, completeCommonIntentTx } from "./common-intent";
import { createConfigStore } from "./config-store";
import { createSqliteContentStore, type SqliteContentStore } from "./content-store";
import { createSqliteEventLedger } from "./events";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts, vaultMoveLockHeld } from "./lockfile";
import { managedRoot } from "./managed-paths";
import {
  type AcceptedBodyCaptureCodes,
  captureMemoBodyFile,
  captureMemoBodyText,
  streamMemoSpool,
} from "./memo-body-file";
import { releaseMemoInputSpool, sweepMemoInputSpool } from "./memo-input-spool";
import type { SorageSqlite } from "./sqlite/connection";
import { asSchemaAdmission } from "./sqlite/migrator";
import { AppCommandError, storageContentionOf } from "./storage-contention";

/** Keeps database admission details inside the composition boundary (SHR-015 unwrap seam). */
export function channelStorageError(error: unknown): AppError {
  const admission = asSchemaAdmission(error);
  if (admission !== null) return admission;
  const contention = storageContentionOf(error, "channel");
  if (contention !== null) return contention;
  if (error instanceof AppCommandError) return error.error;
  return appError("INTERNAL_ERROR", `Channel storage could not be opened: ${String(error)}`);
}

export interface NodeChannelPortsOptions {
  env?: HomeEnvironment;
  userHome?: string;
  database?: SorageSqlite;
  clock?: Clock;
}

const CHANNEL_BODY_CAPTURE_CODES: AcceptedBodyCaptureCodes = {
  invalidInput: "CHN_INVALID_INPUT",
  tooLarge: "CHN_TOO_LARGE",
  fileReadFailed: "CHN_INVALID_INPUT",
};

/** The Channel surface's once-only accepted-input capture over the one shared capture primitive (SHR-012, P3 step 1). */
export function captureChannelBodyFile(path: string, options: { maxBytes: number; stateDir: string; spoolId: string }) {
  return captureMemoBodyFile(path, { ...options, codes: CHANNEL_BODY_CAPTURE_CODES });
}

export function captureChannelBodyText(text: string, options: { maxBytes: number; stateDir: string; spoolId: string }) {
  if (!text.isWellFormed()) {
    return err(appError("CHN_INVALID_INPUT", "Channel message body must be valid Unicode without NUL"));
  }
  return captureMemoBodyText(text, { ...options, codes: CHANNEL_BODY_CAPTURE_CODES });
}

/** Optional startup maintenance, without opening or migrating the database: the shared spool policy the Memo sweep honors. */
export function sweepChannelAcceptedInputs(options: NodeChannelPortsOptions = {}): void {
  const env: HomeEnvironment = options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME };
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  // An operational read at an advisory seam: the sweep itself is void and
  // skips on any read failure, and the command's factory read — which runs
  // immediately afterwards — refuses CONFIG_INVALID on an unreadable file, so
  // the operational mode here records the seam's kind without changing the
  // sweep's silent-skip behavior (SHR-015).
  const current = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome }).readForOperation();
  if (!current.ok || !current.value) return;
  sweepMemoInputSpool(home.stateDir, {
    graceHours: current.value.config.gc.graceHours,
    now: (options.clock ?? new SystemClock()).now(),
  });
}

export function releaseAcceptedChannelBody(accepted: AcceptedChannelBody): void {
  if (accepted.kind === "spool") releaseMemoInputSpool(accepted.spoolPath);
}

export interface NodeChannelPorts extends ChannelCommandPorts {
  close(): void;
  releaseAcceptedBody(accepted: AcceptedChannelBody): void;
  stateDir: string;
}

export function createNodeChannelPorts(options: NodeChannelPortsOptions = {}): NodeChannelPorts {
  const context = openAdapterContext({
    order: "db-first",
    configMode: "operation",
    env: options.env,
    userHome: options.userHome,
    clock: options.clock,
    database: options.database,
    contentionSurface: "channel",
  });
  return composeAdapterContext(context, ({ home, configStore, db, configuration, close }) => {
    const config = configuration.config;
    const clock = options.clock ?? new SystemClock();
    const ledger = createSqliteEventLedger(db);
    const contentStore = createSqliteContentStore({
      db,
      vaultPath: config.vault.path,
      installationId: config.installationId,
      runDir: home.runDir,
      ledger,
    });
    const repository = createSqliteChannelRepository(db, { contentStore });
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
    const relativeStaged = (
      stagingPath: string,
      vaultPath: string,
      sizeBytes: number,
      sha256: string,
    ): Result<{ stagedPath: string; sizeBytes: number; sha256: string }> => {
      let stagedPath: string;
      try {
        stagedPath = relative(managedRoot(vaultPath), stagingPath);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", "The bound Channel Vault root could not be resolved", {
            cause: String(error),
          }),
        );
      }
      if (stagedPath.startsWith("..") || stagedPath.length === 0) {
        return err(appError("INTERNAL_ERROR", "The staged Channel body escaped the bound Vault"));
      }
      return ok({ stagedPath, sizeBytes, sha256 });
    };
    return {
      installationId: config.installationId,
      maxBytes: config.artifact.maxBytes,
      defaultPageSize: config.ui.defaultPageSize,
      clock,
      ids: new UuidGenerator(),
      channels: repository,
      disclosures: {
        backupEnabled: config.gitBackup.enabled,
        thresholdBytes: config.gitBackup.largeArtifactWarningBytes,
        largeContent: () => {},
      },
      bodies: {
        proveAcceptedNonBlank: (accepted) => proveAcceptedNonBlank(accepted),
        resolveBody: (ref) => resolveRecordBody(contentStore, config.vault.path, ref),
      },
      staging: {
        freshBinding: () => {
          // An operational re-read: a present-but-unreadable configuration is
          // the typed CONFIG_INVALID refusal, never a swallowed absence
          // (SHR-015's W4 clarification). The staged-file post re-reads this
          // binding inside its transaction (CHN-014).
          const current = configStore.readForOperation();
          if (!current.ok) return current;
          if (!current.value) return err(appError("INTERNAL_ERROR", "Channel configuration could not be re-read"));
          return ok({ vaultPath: current.value.config.vault.path });
        },
        stageAccepted: (accepted, binding) => {
          if (accepted.kind === "spool") {
            const staged = boundStore(binding).stage({
              sourcePath: accepted.spoolPath,
              maxBytes: config.artifact.maxBytes,
              tooLargeCode: "CHN_TOO_LARGE",
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
          // the owned private spool capture and the content store's
          // managed-path-guarded streaming stage. No raw Vault write bypasses
          // those guards, and the temporary owned spool is released on every
          // exit; the accepted input itself stays immutable.
          const spoolId = randomUUID();
          const captured = captureMemoBodyText(accepted.text, {
            maxBytes: config.artifact.maxBytes,
            stateDir: home.stateDir,
            spoolId,
            codes: CHANNEL_BODY_CAPTURE_CODES,
          });
          if (!captured.ok) return captured;
          if (captured.value.kind !== "spool") {
            return err(appError("INTERNAL_ERROR", "A below-threshold Channel body never stages into the Vault"));
          }
          try {
            const staged = boundStore(binding).stage({
              sourcePath: captured.value.spoolPath,
              maxBytes: config.artifact.maxBytes,
              tooLargeCode: "CHN_TOO_LARGE",
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
          // pending, emits no fabricated event, and reports paused honestly.
          if (vaultMoveLockHeld(home.runDir)) return ok({ status: "paused" as const });
          const outcome = activateCommonFile({
            vaultPath: binding.vaultPath,
            fromPath: input.stagedPath,
            toPath: input.storageKey,
            expect: { sizeBytes: input.sizeBytes, sha256: input.sha256 },
          });
          const completion = completeCommonIntentTx(db, ledger, input.intentId, outcome);
          if (!completion.ok) return completion;
          // A committed failed assessment retains the intent and its
          // CONTENT_INTEGRITY_FAILED event with materialized left 0; the
          // post's post-commit half reports it honestly as committed but
          // unmaterialized — never a fabricated success, never a rollback
          // claim, and never a raw error or body detail (SHR-005, CHN-012).
          if (completion.value.status === "failed") {
            return err(
              appError(
                "CONTENT_MATERIALIZING",
                `The Channel message is committed; its activation could not complete: a committed failure assessment retained the intent (reason: ${String(completion.value.reason)})`,
              ),
            );
          }
          return ok({ status: "completed" as const });
        },
      },
      close,
      releaseAcceptedBody: (accepted) => releaseAcceptedChannelBody(accepted),
      stateDir: home.stateDir,
    };
  });
}

/**
 * The full accepted-spool nonblank proof (CHN-004): streams the accepted
 * bytes in bounded chunks through the shared spool reader and proves at least
 * one non-whitespace scalar exists — bounded memory, the exact accepted bytes,
 * and no second UTF-8 or bound validator, because the capture pass already
 * owns those.
 */
function proveAcceptedNonBlank(accepted: AcceptedChannelBody): Result<void, AppError> {
  if (accepted.kind === "text") return ok(undefined);
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let sawNonWhitespace = false;
  const outcome = streamMemoSpool(accepted.spoolPath, (chunk) => {
    if (!sawNonWhitespace && /\S/u.test(decoder.decode(chunk, { stream: true }))) {
      sawNonWhitespace = true;
    }
  });
  if (!outcome.ok) return outcome;
  if (!sawNonWhitespace) {
    return err(appError("CHN_INVALID_INPUT", "Channel message body must be nonempty after trimming"));
  }
  return ok(undefined);
}

/**
 * The complete-content resolution of one record's body against the current
 * Vault binding, outside every transaction: an inline record is its exact
 * text, an unmaterialized file-backed record is pending in place, and a
 * materialized file is read and digest-verified with its immutable Vault
 * path (section 38.4 line 1716).
 */
function resolveRecordBody(
  store: SqliteContentStore,
  vaultPath: string,
  ref: MessageBodyRef,
): Result<ResolvedMessageBody, AppError> {
  // Every representation resolves through the shared store's verified read:
  // an inline record's bytes are checked against their recorded size and
  // SHA-256 exactly as a file-backed body's are (SHR-005).
  const read = store.read(ref.recordId);
  if (!read.ok) {
    if (read.error.code === "CONTENT_MATERIALIZING") return ok({ state: "pending" });
    return read;
  }
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.value.bytes);
  if (read.value.kind === "inline") {
    return ok({ state: "inline", text: decoded });
  }
  const root = managedRoot(vaultPath);
  const path = ref.storageKey === null ? root : join(root, ref.storageKey);
  return ok({ state: "materialized", text: decoded, path });
}
