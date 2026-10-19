import type { Result } from "./errors";
import type { MemoEvent, MemoSnapshot } from "./memos";
import type { MemoCandidateDescriptor, MemoListFilter } from "./memo-protocol";

/**
 * The Memo repository port after shared-content adoption (SHR-004, MEM-009,
 * ADR-0032): reads and writes carry metadata plus immutable record references,
 * file-backed bodies never resolve inside a transaction, list capture runs in
 * bounded short-snapshot batches, and a write transaction optionally pins the
 * connection-local external-commit version captured before the attempt's
 * fresh Vault binding and staging.
 */

/** A retained receipt in either stored form, before any body resolution. */
export interface StoredMemoReceiptLookup {
  requestHash: string;
  memo: MemoSnapshot;
  changed: boolean;
}

/** The content plan a mutation commits atomically with its domain rows. */
export type MemoContentPlan =
  /** The mutation keeps the Memo's existing record: title-only, state, and no-op writes. */
  | { kind: "keep" }
  /** A new inline record committed from the accepted text; no file, no intent, no physical event. */
  | { kind: "inline"; contentId: string; text: string; sizeBytes: number; sha256: string }
  /** A new file-backed record and its activation intent, both committed in the same transaction. */
  | {
      kind: "file";
      contentId: string;
      /** The activation intent's UUID, committed with the plan and completed after the domain commit. */
      intentId: string;
      /** The staged file's Vault-relative path under `staging/`. */
      stagedPath: string;
      /** The managed `content/memo/<owner>/<record>` key. */
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    };

/** One mutation's committed result: the snapshot, its event, and the plan its activation owes. */
export interface MemoWriteOutcome {
  memo: MemoSnapshot;
  changed: boolean;
  event: MemoEvent | null;
  /** The plan actually committed; the unchanged plan when the write changed no content. */
  content: MemoContentPlan;
  /** The file plan's committed common activation intent; null when no activation is owed. */
  intentId: string | null;
}

export interface MemoTransaction extends MemoReader {
  /**
   * Records the plan's immutable content record — and, for a file plan, its
   * activation intent — inside the caller's open transaction; throws on SQL
   * failure so the whole Memo transaction aborts.
   */
  commitContent(plan: MemoContentPlan, ownerMemoId: string, createdAt: string): Result<void>;
  insertMemo(memo: MemoSnapshot): Result<void>;
  compareAndSetMemo(memo: MemoSnapshot, expectedRowVersion: number): Result<void>;
  appendEvent(id: string, event: MemoEvent): Result<void>;
  storeReceipt(
    key: string,
    scope: string,
    requestHash: string,
    receipt: { memo: MemoSnapshot; changed: boolean },
    createdAt: string,
    expiresAt: string,
  ): Result<void>;
}

export interface MemoReader {
  /** The metadata read: the body text only when the current record is inline (MEM-009). */
  get(id: string): Result<MemoSnapshot | null>;
  projectStatus(id: string): Result<"active" | "archived" | null>;
  /** The retained receipt lookup under the server clock; never deletes or extends expiry. */
  receipt(key: string, scope: string, now: string): Result<StoredMemoReceiptLookup | null>;
}

/** One bounded metadata batch from its own short read transaction. */
export interface MemoListCapture {
  descriptors: MemoCandidateDescriptor[];
  exhausted: boolean;
  lastSortKey: { createdAt: string; id: string } | null;
}

export interface MemoRunOptions {
  /**
   * The connection-local external-commit version captured before this
   * attempt's fresh binding and staging; a mismatch inside the transaction
   * rolls back with the internal coherence marker for classification.
   */
  expectedExternalVersion?: number;
}

export interface MemoRepository {
  get(id: string): Result<MemoSnapshot | null>;
  /** The application owns batching, file scans, and the whole-attempt version guard. */
  captureListBatch(
    filter: MemoListFilter,
    after: { createdAt: string; id: string } | undefined,
    batchSize: number,
  ): Result<MemoListCapture>;
  /** Synchronous work only; a failed Result or thrown error rolls back every write. */
  run<T>(work: (transaction: MemoTransaction) => Result<T>, options?: MemoRunOptions): Result<T>;
  /** Consistent fenced reads, with no key reservation or expiry cleanup. */
  inspect<T>(work: (reader: MemoReader) => Result<T>): Result<T>;
}
