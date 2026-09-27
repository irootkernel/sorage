import type { Result } from "./errors";
import type { Memo, MemoEvent } from "./memos";
import type { MemoListFilter, MemoSummary } from "./memo-protocol";

export interface MemoTransaction {
  get(id: string): Result<Memo | null>;
  projectStatus(id: string): Result<"active" | "archived" | null>;
  insert(memo: Memo): Result<void>;
  compareAndSet(memo: Memo, expectedRowVersion: number): Result<void>;
  appendEvent(id: string, event: MemoEvent): Result<void>;
}

export interface MemoRepository {
  get(id: string): Result<Memo | null>;
  /** The application owns scoped cursor encoding; the repository receives its decoded tuple. */
  list(filter: MemoListFilter, after?: { createdAt: string; id: string }): Result<MemoSummary[]>;
  /** Synchronous work only; a failed Result or thrown error rolls back every write. */
  run<T>(work: (transaction: MemoTransaction) => Result<T>): Result<T>;
}
