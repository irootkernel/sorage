import type { AppError, Result } from "./errors";

/**
 * The intent-log port (ADR-0013, VLT-021, VLT-022, RUN-002): create, fan-out,
 * revise, and deletion approval commit their filesystem intents in the same
 * transaction as the domain change, execute the intents afterwards, and clear
 * them in a second transaction; every process drains outstanding intents
 * idempotently at start. One row is a promise the database has already made, so
 * recovery is deterministic: source gone and destination present means done,
 * both gone means integrity failure, and nothing is ever fabricated. The
 * SQLite implementation and the filesystem drain live in adapters.
 */
export interface PendingFsOp {
  id: string;
  op: "activate" | "unlink";
  /** Vault-relative source path: the staged file of an `activate`; null for `unlink`. */
  fromPath: string | null;
  /** Vault-relative destination: the storageKey path of an `activate`, the removal target of an `unlink`. */
  toPath: string;
  artifactId: string | null;
  /**
   * The common content-intent owner triple of M9 (section 10.1): present exactly
   * together for Memo/Channel-owned file content, all null for legacy Artifact
   * intents whose fields and fallback semantics stay verbatim.
   */
  ownerDomain: "memo" | "channel" | null;
  ownerId: string | null;
  contentId: string | null;
  createdAt: string;
  attempts: number;
}

/**
 * An intent before its first drain evaluation; `attempts` starts at zero. The
 * owner triple is optional so legacy Artifact intent records keep their shape.
 */
export type NewPendingFsOp = Omit<PendingFsOp, "attempts" | "ownerDomain" | "ownerId" | "contentId"> &
  Partial<Pick<PendingFsOp, "ownerDomain" | "ownerId" | "contentId">>;

/** One common intent the drain assessed as failed: recorded durably, never fabricated over. */
export interface CommonIntentFailure {
  intentId: string;
  contentId: string;
  ownerDomain: "memo" | "channel";
  ownerId: string;
  reason:
    | "missing_content"
    | "checksum_mismatch"
    | "size_mismatch"
    | "unsafe_path"
    | "io_error"
    | "destination_conflict";
}

/** An intent the drain cannot resolve: recorded durably, never fabricated over. */
export interface IntentIntegrityFailure {
  id: string;
  op: PendingFsOp["op"];
  toPath: string;
  artifactId: string | null;
  /** The audit event of section 20.6; the event ledger append lands with TASK-028. */
  event: "ARTIFACT_INTEGRITY_FAILED";
  /** Why the drain could not resolve it: bytes gone on both ends, a destination that already holds bytes, or a hostile recorded path. */
  reason: "both-gone" | "destination-conflict" | "unsafe-path";
}

export interface DrainReport {
  /** Intent ids the drain resolved and cleared. */
  resolved: string[];
  /** Legacy Artifact intents that remain recorded because their bytes are gone on both ends. */
  integrityFailed: IntentIntegrityFailure[];
  /** Common content intents that remain recorded with a committed failure assessment. */
  commonFailures: CommonIntentFailure[];
}

export interface IntentLog {
  /** Records committed intents in one transaction (VLT-021). */
  record(intents: NewPendingFsOp[]): Result<{ recorded: number }, AppError>;
  /** Lists outstanding intents in `created_at` order, the drain order. */
  pending(): Result<PendingFsOp[], AppError>;
  /**
   * The idempotent process-start drain (RUN-002): executes each intent against
   * the filesystem state it finds, then clears the resolved ones in a second
   * transaction. Replaying a drain produces the same result, and an
   * `activate` with both ends gone is reported as an integrity failure while
   * its row stays recorded as the durable signal.
   */
  drain(vaultPath: string): Result<DrainReport, AppError>;
  /** Clears executed intents outside the drain: the mutation's completion commit. */
  clear(intentIds: string[]): Result<{ cleared: number }, AppError>;
}

export interface GarbageCollectionOptions {
  /** Storage keys current Artifact rows name; their files are never candidates. */
  liveStorageKeys: string[];
  /**
   * Managed `content/` keys live content records name; their files are never
   * candidates, and a nonempty registry authorizes the content/ sweep (SHR-011).
   */
  liveContentKeys?: string[];
  /**
   * Managed keys unexpired retained responses reference; the sweep never removes
   * bytes a receipt may still resolve (SHR-008, SHR-011).
   */
  receiptReferencedKeys?: string[];
  /** The configured `gc.graceHours`; younger files are never candidates. */
  graceHours: number;
  now: Date;
  /**
   * When true, an empty registry still allows the artifacts/ sweep. Defaults to
   * false: with no registry, no file can be proven unreferenced (a lost state
   * database must not turn the first command into a mass deletion), so only
   * staging/ is swept.
   */
  sweepArtifactsWithoutRegistry?: boolean;
  /**
   * The same authorization for the managed `content/` subtree: without live
   * content keys no content file can be proven unreferenced, so none is swept.
   */
  sweepContentWithoutRegistry?: boolean;
}

export interface GarbageCollectionReport {
  /** Staged paths swept by age. */
  sweptStaging: string[];
  /** Files under artifacts/ that no row names, swept past the grace window. */
  sweptUnreferenced: string[];
  /** Files under content/ that no live record or unexpired receipt names, swept past the grace window. */
  sweptContent: string[];
}

/**
 * The post-drain garbage pass (VLT-013, VLT-014): staging is swept by age, an
 * unreferenced file under artifacts/ is a candidate only past the grace window,
 * and a path matching a live storageKey or a pending intent is never removed,
 * whatever its age. The implementation lives in adapters and must run only
 * after this process's drain has finished.
 */
export interface VaultGarbageCollector {
  collect(vaultPath: string, options: GarbageCollectionOptions): Result<GarbageCollectionReport, AppError>;
}
