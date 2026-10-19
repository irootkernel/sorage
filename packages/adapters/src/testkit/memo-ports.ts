import { mkdirSync } from "node:fs";
import {
  appError,
  decodeStrictUtf8,
  SystemClock,
  UuidGenerator,
  type AcceptedMemoBody,
  type AppError,
  type Clock,
  type MemoBodyPorts,
  type MemoBodyRef,
  type MemoCoherencePorts,
  type MemoCommandPorts,
  type MemoStagingPorts,
  type Result,
} from "@sorage/core";
import type { SorageSqlite } from "../sqlite/connection";
import {
  activateCommonFile,
  completeCommonIntentTx,
  createSqliteContentStore,
  type SqliteContentStore,
} from "../content-store";
import { createSqliteEventLedger } from "../events";
import { createSqliteMemoRepository } from "../memos";
import { streamMemoSpool } from "../memo-body-file";

/**
 * The testkit Memo composition: the full production port surface over a bare
 * migrated database and a throwaway Vault directory, with a fixed binding (no
 * configuration re-reads) so tests drive the repository, the bounded readers,
 * the write-attempt coherence loop, staging, and activation without a real
 * installation. The coherence classification mirrors the fixed-binding case:
 * a held lock is a pause and everything else is an external commit.
 */

export interface TestMemoPortsOptions {
  db: SorageSqlite;
  vaultPath: string;
  installationId: string;
  runDir: string;
  stateDir: string;
  clock?: Clock;
  defaultPageSize?: number;
  maxBytes?: number;
}

/** Verifies the opened handle carries the reference's exact recorded identity before any byte is served. */
function requireRefIdentity(
  handle: { sizeBytes: number; sha256: string; recordId: string },
  ref: MemoBodyRef,
): Result<void, AppError> {
  if (handle.recordId !== ref.recordId || handle.sizeBytes !== ref.sizeBytes || handle.sha256 !== ref.sha256) {
    return {
      ok: false,
      error: appError("CONTENT_CORRUPTED", "The content record no longer carries the reference's recorded identity", {
        recordId: ref.recordId,
      }),
    };
  }
  return { ok: true, value: undefined };
}

export function createTestMemoCommandPorts(options: TestMemoPortsOptions): MemoCommandPorts & {
  store: SqliteContentStore;
  releaseAcceptedBody(accepted: AcceptedMemoBody): void;
} {
  mkdirSync(options.vaultPath, { recursive: true });
  const store = createSqliteContentStore({
    db: options.db,
    vaultPath: options.vaultPath,
    installationId: options.installationId,
    runDir: options.runDir,
    ledger: createSqliteEventLedger(options.db),
  });
  const repository = createSqliteMemoRepository(options.db, { contentStore: store });
  const externalVersion = (): number => {
    const row = options.db.prepare("PRAGMA data_version").get() as { data_version: number } | null | undefined;
    return Number(row?.data_version ?? 0);
  };
  const bodies: MemoBodyPorts = {
    spoolSource: (spoolPath) => ({
      stream(sink) {
        return streamMemoSpool(spoolPath, sink);
      },
    }),
    scanBodyForQuery: (ref, query) => scanBody(store, ref, query),
    readBodyPreviewSeed: (ref) => previewSeed(store, ref),
    resolveBody: (ref) => resolveBody(store, ref),
  };
  const coherence: MemoCoherencePorts = {
    captureExternalVersion: () => ({ ok: true, value: externalVersion() }),
    classifyExternalChange: () => ({ ok: true, value: "external-commit" as const }),
    moveLockHeld: () => false,
  };
  const staging: MemoStagingPorts = {
    freshBinding: () => ({ ok: true, value: { vaultPath: options.vaultPath } }),
    stageAccepted: (accepted) => {
      if (accepted.kind !== "spool") {
        return { ok: false, error: appError("INTERNAL_ERROR", "The testkit staging seam accepts spool inputs only") };
      }
      const staged = store.stage({
        sourcePath: accepted.spoolPath,
        maxBytes: options.maxBytes ?? 104_857_600,
        tooLargeCode: "MEMO_TOO_LARGE",
      });
      if (!staged.ok) return staged;
      const stagedPath = staged.value.stagingPath.slice(options.vaultPath.length + 1);
      return { ok: true, value: { stagedPath, sizeBytes: staged.value.sizeBytes, sha256: staged.value.sha256 } };
    },
    activateContent: (input) => {
      const outcome = activateCommonFile({
        vaultPath: options.vaultPath,
        fromPath: input.stagedPath,
        toPath: input.storageKey,
        expect: { sizeBytes: input.sizeBytes, sha256: input.sha256 },
      });
      const completion = completeCommonIntentTx(
        options.db,
        createSqliteEventLedger(options.db),
        input.intentId,
        outcome,
      );
      if (!completion.ok) return completion;
      return { ok: true, value: { status: "completed" as const } };
    },
  };
  return {
    installationId: options.installationId,
    maxBytes: options.maxBytes ?? 104_857_600,
    memos: repository,
    bodies,
    coherence,
    staging,
    clock: options.clock ?? new SystemClock(),
    ids: new UuidGenerator(),
    defaultPageSize: options.defaultPageSize ?? 2,
    store,
    releaseAcceptedBody: () => undefined,
  };
}

function scanBody(store: SqliteContentStore, ref: MemoBodyRef, query: string): Result<boolean, AppError> {
  const opened = store.openBody(ref.recordId, { verifyFileDigest: "always" });
  if (!opened.ok) return opened;
  const handle = opened.value;
  try {
    const identity = requireRefIdentity(handle, ref);
    if (!identity.ok) return identity;
    const needle = Buffer.from(query, "utf8");
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

function previewSeed(store: SqliteContentStore, ref: MemoBodyRef): Result<string, AppError> {
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
    const text = decodeStrictUtf8(Buffer.concat(parts));
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
