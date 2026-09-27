import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSorageDatabase } from "../../src/sqlite/connection";
import {
  changeMemo,
  createMemo,
  initializeInstallation,
  backupRestore,
  exportSnapshot,
  type Memo,
  type MemoChange,
  type Result,
} from "@sorage/core";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { createSqliteMemoRepository } from "../../src/memos";
import { FakeClock } from "../../src/testkit/fakes";

export const MEMO_PROJECT = "cd000000-0000-4000-8000-000000000001";
export const MEMO_ID = "ab000000-0000-4000-8000-000000000001";
export const MEMO_TIME = "2026-09-27T00:00:00.000Z";
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture value");
  return value;
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Real temporary installation shared by persistence and later replay-only recovery tests. */
export function memoInstallation() {
  const home = mkdtempSync(join(tmpdir(), "sorage-memo-int-"));
  const vault = join(home, "vault");
  unwrap(
    initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
      { vaultPath: vault },
    ),
  );
  return {
    home,
    vault,
    database: join(home, "state", "sorage.sqlite3"),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Seed through the real repository; no CLI/application operation is simulated. */
export function seedMemoInstallation(installation: ReturnType<typeof memoInstallation>, newlyCreated = false): Memo {
  const db = openSorageDatabase(installation.database);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, 'memo-project', 'Memo Project', 'active', ?, ?)",
  ).run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
  const repository = createSqliteMemoRepository(db);
  let transition = unwrap(
    createMemo(MEMO_ID, MEMO_PROJECT, { title: "검토 😀", body: "e\u0301\r\nMemo body" }, MEMO_TIME),
  );
  unwrap(
    repository.run((tx) => {
      const inserted = tx.insert(transition.memo);
      return inserted.ok ? tx.appendEvent(randomUUID(), required(transition.event)) : inserted;
    }),
  );
  for (const operation of newlyCreated ? [] : (["update", "done"] as const)) {
    const change: MemoChange =
      operation === "update"
        ? { operation, expectedRowVersion: transition.memo.rowVersion, body: "edited\r\n한글 😀" }
        : { operation, expectedRowVersion: transition.memo.rowVersion };
    transition = unwrap(changeMemo(transition.memo, change, "2026-09-27T01:00:00.000Z"));
    unwrap(
      repository.run((tx) => {
        const written = tx.compareAndSet(transition.memo, transition.memo.rowVersion - 1);
        return written.ok ? tx.appendEvent(randomUUID(), required(transition.event)) : written;
      }),
    );
  }
  db.prepare(
    "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, 'memo-create', 'original', ?, ?, '2099-01-01T00:00:00.000Z')",
  ).run(randomUUID(), JSON.stringify({ memo: transition.memo, changed: true }), MEMO_TIME);
  db.close();
  return transition.memo;
}

/** Same installation identity and committed create, deliberately without its operational receipt. */
export function restoredMemoInstallation() {
  const source = memoInstallation();
  const target = memoInstallation();
  try {
    const memo = seedMemoInstallation(source, true);
    const sourcePorts = createNodeBackupCommandPorts({ env: { SORAGE_HOME: source.home }, userHome: source.home });
    unwrap(exportSnapshot(unwrap(sourcePorts.exportPorts())));
    const targetPorts = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: target.home },
      userHome: target.home,
      sourcePath: source.vault,
    });
    unwrap(backupRestore(unwrap(targetPorts.restorePorts()), { dryRun: false }));
    return { ...target, memo };
  } catch (error) {
    target.cleanup();
    throw error;
  } finally {
    source.cleanup();
  }
}
