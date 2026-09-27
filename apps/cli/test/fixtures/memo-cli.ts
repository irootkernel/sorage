import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Memo, MemoReceipt, MemoPage } from "@sorage/core";

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
export function memoCliFixture(empty = false) {
  const home = mkdtempSync(join(tmpdir(), "sorage-memo-cli-"));
  const work = join(home, "work");
  const other = join(home, "other");
  mkdirSync(work);
  mkdirSync(other);
  function run(args: string[], cwd = work) {
    const result = spawnSync("bun", [entry, ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: "2f0ac9a0-0000-4000-8000-0000000000aa" },
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  const commands = [["init", "--non-interactive"]];
  if (!empty)
    commands.push(
      ["project", "add", "--name", "Memo Project", "--slug", "memo", "--dir", work],
      ["project", "add", "--name", "Other", "--slug", "other", "--dir", other],
    );
  for (const args of commands) {
    const result = run(args);
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  return {
    home,
    work,
    other,
    db,
    run,
    cleanup: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
export function cliData<T = MemoReceipt>(result: { status: number | null; stdout: string; stderr: string }): T {
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout).data as T;
}
export type MemoCliData = Memo | MemoReceipt | MemoPage;
