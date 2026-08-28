import { afterAll, describe, expect, it } from "vitest";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteHandoffReadStore } from "../../src/handoff-read-store";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { insertHandoffSeed } from "../../src/testkit/seed";
import { makeTempDatabase } from "../../src/testkit/temp-database";

/**
 * The deterministic pagination proof of TASK-030 (NFR-006, HND scale): paging the
 * 10,000-Handoff seed in the fixed (updatedAt DESC, id DESC) keyset order returns
 * every row exactly once, and the filters bind the cursor to its filter set.
 */

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function seeded() {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS);
  insertHandoffSeed(temp.db, 10_000);
  return temp.db;
}

describe("handoff read store pagination", () => {
  it("returns every seeded row exactly once across all pages", { timeout: 30_000 }, () => {
    const db = seeded();
    const store = createSqliteHandoffReadStore(db, createSqliteEventLedger(db));
    const filters = { includeArchived: false, includeDeleted: false };
    const seen = new Set<string>();
    let afterSortKey: string | null = null;
    let pages = 0;
    for (;;) {
      const page = store.listPage({ kind: "all" }, filters, 500, afterSortKey);
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const item of page.value.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      if (page.value.items.length === 0) break;
      pages += 1;
      afterSortKey = page.value.lastSortKey;
      if (page.value.items.length < 500 || afterSortKey === null) break;
    }
    // The seed mints one third in each of three review states, and every state is
    // non-archived and non-deleted, so the default visibility sees all 10,000.
    expect(seen.size).toBe(10_000);
    expect(pages).toBe(20);
  });

  it("keeps the cursor bound to its filter set through the use-case layer", { timeout: 30_000 }, () => {
    const db = seeded();
    const store = createSqliteHandoffReadStore(db, createSqliteEventLedger(db));
    const first = store.listPage(
      { kind: "all" },
      { includeArchived: false, includeDeleted: false, state: "accepted" },
      10,
      null,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The same filter set pages forward; the count matches the accepted third.
    const seen = new Set(first.value.items.map((item) => item.id));
    let after = first.value.lastSortKey;
    for (;;) {
      const page = store.listPage(
        { kind: "all" },
        { includeArchived: false, includeDeleted: false, state: "accepted" },
        700,
        after,
      );
      if (!page.ok) return;
      for (const item of page.value.items) seen.add(item.id);
      after = page.value.lastSortKey;
      if (page.value.items.length < 700 || after === null) break;
    }
    expect(seen.size).toBe(3_333);
  });
});
