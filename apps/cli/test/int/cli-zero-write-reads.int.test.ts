import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { knownSchemaMaximum } from "@sorage/core";
import { MIGRATIONS } from "@sorage/adapters/src/sqlite/migrations";
import { openAndMigrate } from "@sorage/adapters/src/sqlite/migrator";
import { runCli, withCoveredRead } from "../../src/main";

/**
 * The covered zero-write reads through the in-process CLI (RDR-001, RDR-002):
 * every failure path renders without creating the log — action results, the
 * pre-initialization gate, parser-stage failures that never reach an action,
 * and throws escaping a composition — while non-covered commands keep their
 * log; no startup drain or accepted-input sweep runs; the upgrade window and
 * the other RDR-002 states answer their typed refusals; and the sidecar-gap
 * refusal is settled per surface. The compiled-binary suite owns the sandbox
 * and inventory evidence; this suite owns the mechanism.
 */

const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

function run(args: string[], cwd?: string): { code: number; out: string; err: string } {
  const previous = process.cwd();
  if (cwd !== undefined) process.chdir(cwd);
  try {
    const cap = capture();
    const code = runCli(args, cap.ports);
    return { code, out: cap.outText(), err: cap.errText() };
  } finally {
    if (cwd !== undefined) process.chdir(previous);
  }
}

function logWritten(home: string): boolean {
  return existsSync(join(home, "logs", "sorage.log"));
}

/** Size, nanosecond mtime and bytes of every file under the home (the Vault included). */
function homeInventory(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      out[path] = `${String(stat.size)}:${String(stat.mtimeNs)}:${readFileSync(path).toString("hex")}`;
    }
  };
  walk(home);
  return out;
}

function errorCode(result: { err: string }): string {
  return (JSON.parse(result.err) as { error: { code: string } }).error.code;
}

/** An initialized home with one bound Project, one sent Handoff and two Memos. */
function installation(prefix: string) {
  const home = tempHome(prefix);
  const work = join(home, "work");
  mkdirSync(work);
  expect(run(["init", "--non-interactive", "--initialize-git", "--json"]).code).toBe(0);
  expect(run(["project", "add", "--name", "Alpha", "--slug", "alpha", "--dir", work, "--json"]).code).toBe(0);
  const sent = run(["send", "--to", "alpha", "--title", "Hello", "--body", "body text", "--json"], work);
  expect(sent.code, sent.err).toBe(0);
  const handoffId = (JSON.parse(sent.out) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
    ?.handoffId as string;
  const first = run(["memo", "add", "--title", "First", "--json"], work);
  expect(first.code, first.err).toBe(0);
  const memoId = (JSON.parse(first.out) as { data: { memo: { id: string } } }).data.memo.id;
  expect(run(["memo", "add", "--title", "Second", "--json"], work).code).toBe(0);
  // `init` lays out an empty `logs/` directory; the log file is what a covered read must never create.
  expect(logWritten(home)).toBe(false);
  return { home, work, handoffId, memoId, database: join(home, "state", "sorage.sqlite3") };
}

const coveredReads = (f: ReturnType<typeof installation>): Array<[string, string[]]> => [
  ["inbox", ["inbox", "--json"]],
  ["outbox", ["outbox", "--json"]],
  ["get", ["get", f.handoffId, "--json"]],
  ["events", ["events", f.handoffId, "--json"]],
  ["review show", ["review", "show", f.handoffId, "--json"]],
  ["memo list", ["memo", "list", "--json"]],
  ["memo show", ["memo", "show", f.memoId, "--json"]],
  ["project list", ["project", "list", "--json"]],
  ["project show", ["project", "show", "alpha", "--json"]],
];

describe("covered reads succeed through the shared read primitive", () => {
  it("answers every covered read on a migrated installation with exit 0 and no log", () => {
    const f = installation("sorage-zero-write-ok-");
    for (const [name, args] of coveredReads(f)) {
      const result = run(args, f.work);
      expect(result.code, `${name}: ${result.err}`).toBe(0);
      expect((JSON.parse(result.out) as { ok: boolean }).ok, name).toBe(true);
    }
    const page = run(["memo", "list", "--json"], f.work);
    expect((JSON.parse(page.out) as { data: { items: unknown[] } }).data.items).toHaveLength(2);
    expect(logWritten(f.home)).toBe(false);
  });
});

describe("covered-read failures render without the log (RDR-001)", () => {
  it("keeps action-path failures and the pre-initialization gate log-free while a non-covered command still logs", () => {
    const f = installation("sorage-zero-write-nolog-");
    const unknown = "00000000-0000-4000-8000-000000000000";
    const get = run(["get", unknown, "--json"], f.work);
    expect(get.code).toBe(66);
    expect(errorCode(get)).toBe("HANDOFF_NOT_FOUND");
    const project = run(["project", "show", "nope", "--json"], f.work);
    expect(project.code).toBe(66);
    expect(errorCode(project)).toBe("PROJECT_NOT_FOUND");
    const memo = run(["memo", "show", unknown, "--json"], f.work);
    expect(memo.code).toBe(66);
    expect(errorCode(memo)).toBe("MEMO_NOT_FOUND");
    expect(logWritten(f.home)).toBe(false);

    const empty = tempHome("sorage-zero-write-empty-");
    for (const args of [
      ["project", "list", "--json"],
      ["inbox", "--json"],
      ["memo", "list", "--json"],
    ]) {
      const gate = run(args);
      expect(gate.code, args.join(" ")).toBe(78);
      expect(errorCode(gate)).toBe("NOT_INITIALIZED");
    }
    expect(existsSync(join(empty, "logs"))).toBe(false);
    // The non-covered path keeps its documented log write.
    expect(run(["config", "show", "--json"]).code).toBe(78);
    expect(existsSync(join(empty, "logs", "sorage.log"))).toBe(true);
  });

  it("keeps a parser-stage Memo numeric failure log-free with its code, output and exit unchanged", () => {
    const f = installation("sorage-zero-write-parser-");
    const result = run(["memo", "list", "--limit", "nope", "--json"], f.work);
    expect(result.code).toBe(64);
    expect(result.out).toBe("");
    const envelope = JSON.parse(result.err) as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("MEMO_INVALID_INPUT");
    expect(envelope.error.message).toBe("Memo numeric values must be safe non-negative integers");
    expect(logWritten(f.home)).toBe(false);
  });

  it("renders a throw escaping a covered read's composition as a typed envelope without the log", () => {
    const f = installation("sorage-zero-write-throw-");
    const cap = capture();
    let exit = -1;
    withCoveredRead(
      cap.ports,
      true,
      (code) => {
        exit = code;
      },
      "handoff",
      () => {
        throw new Error("composition exploded");
      },
    );
    expect(exit).toBe(1);
    const envelope = JSON.parse(cap.errText()) as {
      error: { code: string; message: string; recovery?: { suggestedCommand: string } };
      meta: { requestId: string };
    };
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
    expect(envelope.error.message).toContain("composition exploded");
    // The log-free INTERNAL_ERROR recovery names the request id and the
    // retained output, never the installation log the catalogue default points
    // at (the covered reads write no log).
    expect(envelope.error.recovery?.suggestedCommand).toContain(envelope.meta.requestId);
    expect(envelope.error.recovery?.suggestedCommand).toContain("wrote no installation log");
    expect(envelope.error.recovery?.suggestedCommand).not.toContain("sorage.log");
    expect(logWritten(f.home)).toBe(false);
    const humanCap = capture();
    let humanExit = -1;
    withCoveredRead(
      humanCap.ports,
      false,
      (code) => {
        humanExit = code;
      },
      "handoff",
      () => {
        throw new Error("composition exploded");
      },
    );
    expect(humanExit).toBe(1);
    expect(humanCap.errText()).toContain("Retain request ");
    expect(humanCap.errText()).toContain("wrote no installation log");
    expect(humanCap.errText()).not.toContain("sorage.log");
    expect(logWritten(f.home)).toBe(false);
  });

  it("renders a returned INTERNAL_ERROR from a covered read action with the log-free recovery, in both forms", () => {
    const f = installation("sorage-zero-write-returned-");
    const assertLogFreeRecovery = (result: { code: number; out: string; err: string }, label: string) => {
      expect(result.code, label).toBe(1);
      expect(result.out, label).toBe("");
      const envelope = JSON.parse(result.err) as {
        error: { code: string; recovery?: { suggestedCommand: string } };
        meta: { requestId: string };
      };
      expect(envelope.error.code, label).toBe("INTERNAL_ERROR");
      expect(envelope.error.recovery?.suggestedCommand, label).toContain(envelope.meta.requestId);
      expect(envelope.error.recovery?.suggestedCommand, label).toContain("wrote no installation log");
      expect(envelope.error.recovery?.suggestedCommand, label).not.toContain("sorage.log");
    };
    // A Handoff read whose action returns INTERNAL_ERROR: the events timeline's
    // store maps a failed query to INTERNAL_ERROR with no site recovery.
    const dropEvents = new DatabaseSync(f.database);
    dropEvents.exec("PRAGMA foreign_keys = OFF");
    dropEvents.exec("DROP TABLE events");
    dropEvents.close();
    assertLogFreeRecovery(run(["events", f.handoffId, "--json"], f.work), "events json");
    const eventsHuman = run(["events", f.handoffId], f.work);
    expect(eventsHuman.code).toBe(1);
    expect(eventsHuman.err).toContain("wrote no installation log");
    expect(eventsHuman.err).not.toContain("sorage.log");
    expect(logWritten(f.home)).toBe(false);

    // A Project read whose action returns INTERNAL_ERROR: the repository maps a
    // failed query to INTERNAL_ERROR with no site recovery.
    const second = installation("sorage-zero-write-returned-project-");
    const dropProjects = new DatabaseSync(second.database);
    dropProjects.exec("PRAGMA foreign_keys = OFF");
    dropProjects.exec("DROP TABLE projects");
    dropProjects.close();
    assertLogFreeRecovery(run(["project", "list", "--json"], second.work), "project list json");
    const projectHuman = run(["project", "list"], second.work);
    expect(projectHuman.code).toBe(1);
    expect(projectHuman.err).toContain("wrote no installation log");
    expect(projectHuman.err).not.toContain("sorage.log");
    expect(logWritten(second.home)).toBe(false);
  });

  it("keeps the Vault-open refusal on the covered Memo reads, identically and write-free, for inline and file-backed Memos", () => {
    const f = installation("sorage-zero-write-vault-");
    const vault = join(f.home, "vault");
    // A file-backed Memo beside the inline ones: both must behave alike.
    const large = join(f.home, "large.txt");
    writeFileSync(large, "z".repeat(70_000));
    const backed = run(["memo", "add", "--title", "Backed", "--body-file", large, "--json"], f.work);
    expect(backed.code, backed.err).toBe(0);
    const backedId = (JSON.parse(backed.out) as { data: { memo: { id: string } } }).data.memo.id;
    // The intact Vault serves the normal page and both kinds' `show`, writing nothing.
    const intactBefore = homeInventory(f.home);
    const intactPage = run(["memo", "list", "--json"], f.work);
    expect(intactPage.code, intactPage.err).toBe(0);
    expect((JSON.parse(intactPage.out) as { data: { items: unknown[] } }).data.items).toHaveLength(3);
    const intactShow = run(["memo", "show", f.memoId, "--json"], f.work);
    expect(intactShow.code, intactShow.err).toBe(0);
    const intactBackedShow = run(["memo", "show", backedId, "--json"], f.work);
    expect(intactBackedShow.code, intactBackedShow.err).toBe(0);
    expect((JSON.parse(intactBackedShow.out) as { data: { body: string } }).data.body.length).toBe(70_000);
    expect(homeInventory(f.home)).toEqual(intactBefore);

    // The broken-Vault state (the TASK-118 V1 shape) refuses the covered Memo
    // reads with the same envelope `vault verify` reports, writing nothing —
    // the pre-Task drain's admission, kept read-only.
    rmSync(vault, { recursive: true, force: true });
    const verify = run(["vault", "verify", "--json"]);
    expect(verify.code).toBe(73);
    const before = homeInventory(f.home);
    for (const args of [
      ["memo", "list", "--json"],
      ["memo", "show", f.memoId, "--json"],
      ["memo", "show", backedId, "--json"],
    ]) {
      const result = run(args, f.work);
      expect(result.code, args.join(" ")).toBe(73);
      expect(result.out, args.join(" ")).toBe("");
      // The complete error object — code, message, details and recovery —
      // equals what `vault verify` reports on the same state.
      const envelope = JSON.parse(result.err) as { error: Record<string, unknown> };
      const verifyError = (JSON.parse(verify.err) as { error: Record<string, unknown> }).error;
      expect(envelope.error, args.join(" ")).toEqual(verifyError);
    }
    expect(homeInventory(f.home)).toEqual(before);
    expect(logWritten(f.home)).toBe(false);
    expect(existsSync(vault)).toBe(false);
  });

  it("pauses the covered Memo reads under a live vault-move.lock and serves them under a stale one", () => {
    const f = installation("sorage-zero-write-pause-");
    // Land the quiescent copy state explicitly, so the fence runs on the copy
    // path and the inventory window is exact under both engines (the bridged
    // engine's URI open over a frames-holding `-wal` writes `-shm`, which is
    // the node:sqlite divergence, not product behavior; the native engine
    // measured files-identical there).
    const settle = new DatabaseSync(f.database);
    settle.exec("PRAGMA journal_mode=WAL");
    settle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    settle.close();
    writeFileSync(`${f.database}-wal`, Buffer.alloc(0));
    const runDir = join(f.home, "run");
    const lockPath = join(runDir, "vault-move.lock");
    const writeLock = (pid: number) => {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid, startedAt: new Date().toISOString(), hostname: "pause-test" })}\n`,
      );
    };
    // A live lock carries the test process's own pid: the covered Memo reads
    // keep the drain's SERVICE_PAUSED exit (RDR-005), rendered log-free and
    // writing nothing. Handoff and Project reads never ran the drain and keep
    // serving.
    writeLock(process.pid);
    const before = homeInventory(f.home);
    for (const [label, args, json] of [
      ["memo list json", ["memo", "list", "--json"], true],
      ["memo show json", ["memo", "show", f.memoId, "--json"], true],
      ["memo list human", ["memo", "list"], false],
      ["memo show human", ["memo", "show", f.memoId], false],
    ] as Array<[string, string[], boolean]>) {
      const result = run(args, f.work);
      expect(result.code, label).toBe(75);
      const message = "A Vault move or restore is in progress; the intent drain paused instead of racing it.";
      if (json) {
        expect(result.out, label).toBe("");
        const envelope = JSON.parse(result.err) as {
          error: {
            code: string;
            message: string;
            details: { lockPath: string };
            recovery?: { suggestedCommand: string };
          };
        };
        expect(envelope.error.code, label).toBe("SERVICE_PAUSED");
        expect(envelope.error.message, label).toBe(message);
        expect(envelope.error.details.lockPath, label).toBe(lockPath);
        expect(envelope.error.recovery?.suggestedCommand, label).toBe("Wait for that operation to finish, then retry");
      } else {
        expect(result.err, label).toBe(
          `SERVICE_PAUSED: ${message}\nRecovery: Wait for that operation to finish, then retry\n`,
        );
      }
    }
    expect(homeInventory(f.home)).toEqual(before);
    expect(logWritten(f.home)).toBe(false);
    const inboxUnderLock = run(["inbox", "--json"], f.work);
    expect(inboxUnderLock.code, "the Handoff read never ran the drain").toBe(0);

    // A stale lock (a dead pid) pauses no one: both Memo reads serve their
    // normal output in both forms, the stale lock stays in place, and nothing
    // is written.
    writeLock(999_999_999);
    const staleBefore = homeInventory(f.home);
    for (const [label, args, json] of [
      ["memo list json", ["memo", "list", "--json"], true],
      ["memo show json", ["memo", "show", f.memoId, "--json"], true],
      ["memo list human", ["memo", "list"], false],
      ["memo show human", ["memo", "show", f.memoId], false],
    ] as Array<[string, string[], boolean]>) {
      const result = run(args, f.work);
      expect(result.code, label).toBe(0);
      if (json) {
        const envelope = JSON.parse(result.out) as { ok: boolean };
        expect(envelope.ok, label).toBe(true);
      } else {
        expect(result.err, label).toBe("");
      }
    }
    expect(homeInventory(f.home)).toEqual(staleBefore);
    expect(existsSync(lockPath), "the stale lock itself stays in place").toBe(true);
    expect(logWritten(f.home)).toBe(false);
  });
});

describe("covered reads run no startup drain and no spool sweep", () => {
  it("leaves a pending intent and a stale accepted-input spool alone, which the next mutation then settles", () => {
    const f = installation("sorage-zero-write-drain-");
    const db = new DatabaseSync(f.database);
    db.exec(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('11111111-1111-4111-8111-111111111111', 'unlink', NULL, 'artifacts/never/existed.md', NULL, '2026-01-01T00:00:00.000Z', 0)",
    );
    db.close();
    const spoolDir = join(f.home, "state", "memo-input");
    mkdirSync(spoolDir, { recursive: true });
    const stale = join(spoolDir, "22222222-2222-4222-8222-222222222222.999999.spool");
    writeFileSync(stale, "stale accepted input");
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(stale, old, old);
    const pending = () => {
      const probe = new DatabaseSync(f.database, { readOnly: true });
      try {
        return probe.prepare("SELECT count(*) AS n, coalesce(max(attempts), 0) AS a FROM pending_fs_ops").get() as {
          n: number;
          a: number;
        };
      } finally {
        probe.close();
      }
    };
    for (const [name, args] of coveredReads(f)) {
      expect(run(args, f.work).code, name).toBe(0);
      expect(pending().n, `${name} drained the intent`).toBe(1);
      expect(pending().a, `${name} ran the drain`).toBe(0);
      expect(existsSync(stale), `${name} swept the spool`).toBe(true);
    }
    expect(run(["memo", "add", "--title", "Third", "--json"], f.work).code).toBe(0);
    // The mutation's startup drain ran: the synthetic intent (whose target never
    // existed) was attempted, where every covered read had left it untouched.
    expect(pending().a).toBeGreaterThan(0);
    expect(existsSync(stale)).toBe(false);
  });
});

describe("the RDR-002 storage states at the CLI", () => {
  it("refuses the upgrade window with STORAGE_MIGRATION_REQUIRED until backup run migrates", () => {
    const f = installation("sorage-zero-write-upgrade-");
    for (const name of readdirSync(join(f.home, "state"))) {
      if (name.startsWith("sorage.sqlite3")) rmSync(join(f.home, "state", name));
    }
    openAndMigrate(f.database, MIGRATIONS.slice(0, 7)).db.close();
    for (const [name, args] of coveredReads(f)) {
      if (name === "memo show" || name === "get" || name === "events" || name === "review show") continue;
      const result = run(args, f.work);
      expect(result.code, name).toBe(78);
      const envelope = JSON.parse(result.err) as {
        error: {
          code: string;
          details: { appliedMaximum: number; knownMaximum: number };
          recovery: { suggestedCommand: string };
        };
      };
      expect(envelope.error.code, name).toBe("STORAGE_MIGRATION_REQUIRED");
      expect(envelope.error.details.appliedMaximum).toBe(7);
      expect(envelope.error.details.knownMaximum).toBe(knownSchemaMaximum());
      expect(envelope.error.recovery.suggestedCommand).toContain("sorage backup run");
    }
    expect(logWritten(f.home)).toBe(false);
    const backup = run(["backup", "run", "--json"], f.work);
    expect(backup.code, backup.err).toBe(0);
    // The rebuilt schema-7 database carries no Project rows, so the reads that
    // need no working-directory actor prove the migrated storage opens again.
    expect(run(["project", "list", "--json"], f.work).code).toBe(0);
    expect(run(["memo", "list", "--all-projects", "--json"], f.work).code).toBe(0);
    const preflight = run(["preflight", "--json"]);
    expect(preflight.code).toBe(0);
    expect((JSON.parse(preflight.out) as { data: { status: string } }).data.status).toBe("compatible");
  });

  it("refuses a missing database with STORAGE_INTEGRITY_ERROR and creates no file", () => {
    const f = installation("sorage-zero-write-missing-");
    for (const name of readdirSync(join(f.home, "state"))) {
      if (name.startsWith("sorage.sqlite3")) rmSync(join(f.home, "state", name));
    }
    const result = run(["inbox", "--json"], f.work);
    expect(result.code).toBe(73);
    const envelope = JSON.parse(result.err) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(envelope.error.message).toBe("The database is missing from a recognizable installation.");
    expect(existsSync(f.database)).toBe(false);
    expect(logWritten(f.home)).toBe(false);
  });

  it("refuses a newer schema with STORAGE_SCHEMA_UNSUPPORTED", () => {
    const f = installation("sorage-zero-write-newer-");
    const db = new DatabaseSync(f.database);
    db.exec(`INSERT INTO schema_migrations VALUES(${knownSchemaMaximum() + 1}, 'future', '2026-01-01')`);
    db.close();
    const result = run(["project", "list", "--json"], f.work);
    expect(result.code).toBe(78);
    expect(errorCode(result)).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(logWritten(f.home)).toBe(false);
  });

  it("settles the sidecar gap per surface without creating the -shm or the log", () => {
    const f = installation("sorage-zero-write-gap-");
    // A live writer's committed benign write leaves a `-wal` longer than its
    // header; removing the `-shm` beside it is the externally produced gap.
    const writer = new DatabaseSync(f.database);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("UPDATE migration_lock SET id = 1 WHERE id = 1");
    expect(lstatSync(`${f.database}-wal`).size).toBeGreaterThan(32);
    rmSync(`${f.database}-shm`);
    try {
      const inbox = run(["inbox", "--json"], f.work);
      expect(inbox.code).toBe(75);
      expect(errorCode(inbox)).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      const project = run(["project", "list", "--json"], f.work);
      expect(project.code).toBe(75);
      expect(errorCode(project)).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      const memo = run(["memo", "list", "--json"], f.work);
      expect(memo.code).toBe(1);
      expect(errorCode(memo)).toBe("INTERNAL_ERROR");
      for (const result of [inbox, project, memo]) {
        expect(
          (JSON.parse(result.err) as { error: { recovery: { suggestedCommand: string } } }).error.recovery
            .suggestedCommand,
        ).toContain("sorage backup run");
      }
      expect(existsSync(`${f.database}-shm`)).toBe(false);
      expect(logWritten(f.home)).toBe(false);
    } finally {
      writer.close();
    }
  });
});
