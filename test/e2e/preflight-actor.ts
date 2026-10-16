import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

function requiredArg(index: number): string {
  const value = process.argv[index];
  if (value === undefined) {
    process.stderr.write("usage: preflight-actor <home> <progress>\n");
    process.exit(2);
  }
  return value;
}

const home = requiredArg(2);
const progress = requiredArg(3);

const db = new Database(join(home, "state", "sorage.sqlite3"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA wal_autocheckpoint = 0");
let commits = 0;
let stopped = false;

function shutdown(): void {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  clearTimeout(limit);
  try {
    db.close();
  } catch {
    // The process is exiting.
  }
  process.exit(0);
}

function commit(): void {
  if (stopped) return;
  commits += 1;
  const stamp = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE installation SET created_at = ? WHERE id = 1").run(stamp);
  db.exec("COMMIT");
  appendFileSync(progress, `${Date.now()} ${commits} ${stamp}\n`);
  if (commits >= 400) shutdown();
}

const timer = setInterval(commit, 10);
const limit = setTimeout(shutdown, 15_000);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
