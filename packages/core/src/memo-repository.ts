import type { Result } from "./errors";
import type { Memo, MemoEvent } from "./memos";
import type { MemoListFilter, MemoSummary, MemoReceipt } from "./memo-protocol";

export interface MemoReader {
  get(id: string): Result<Memo | null>;
  projectStatus(id: string): Result<"active" | "archived" | null>;
  receipt(key: string, scope: string, now: string): Result<{ requestHash: string; receipt: MemoReceipt } | null>;
}

export interface MemoTransaction extends MemoReader {
  insert(memo: Memo): Result<void>;
  compareAndSet(memo: Memo, expectedRowVersion: number): Result<void>;
  appendEvent(id: string, event: MemoEvent): Result<void>;
  storeReceipt(
    key: string,
    scope: string,
    requestHash: string,
    receipt: MemoReceipt,
    createdAt: string,
    expiresAt: string,
  ): Result<void>;
}

export interface MemoRepository {
  get(id: string): Result<Memo | null>;
  /** The application owns scoped cursor encoding; the repository receives its decoded tuple. */
  list(filter: MemoListFilter, after?: { createdAt: string; id: string }): Result<MemoSummary[]>;
  /** Synchronous work only; a failed Result or thrown error rolls back every write. */
  run<T>(work: (transaction: MemoTransaction) => Result<T>): Result<T>;
  /** Consistent fenced reads, with no key reservation or expiry cleanup. */
  inspect<T>(work: (reader: MemoReader) => Result<T>): Result<T>;
}
