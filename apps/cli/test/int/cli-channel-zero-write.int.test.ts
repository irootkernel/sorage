import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as channelCommandPorts from "@sorage/adapters/src/channel-command-ports";
import { appError, err } from "@sorage/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWindowConnectionsClosed,
  connectionsOpenedSince,
  openWindow,
  settleConnections,
} from "../fixtures/connection-window";
import { runCli } from "../../src/main";

/**
 * The covered Channel reads through the in-process CLI (RDR-001 to RDR-005,
 * decision r2 section 2): the reads and the wait render log-free, the Vault
 * and pause admission runs once at the wait's start exactly as the pre-Task
 * drain performed it, later polls re-admit without it so a mid-wait move does
 * not end the wait, and the sidecar-gap refusal carries the rebuilt
 * `RECOVERY.channel` text. The compiled-binary suite owns the sandbox and
 * inventory evidence; this suite owns the mechanism.
 */

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

/** Size, nanosecond mtime and bytes of every file under the home (the Vault included), captured raw. */
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

/**
 * An inventory window (c2-decision item 3): the fixture's leaked connections
 * are settled once, before the baseline; `after` asserts that no connection
 * opened inside the window is still open and then captures the raw inventory,
 * never closing anything first.
 */
function openInventoryWindow(home: string) {
  settleConnections();
  const mark = openWindow();
  const before = homeInventory(home);
  return {
    before,
    mark,
    after(label: string): Record<string, string> {
      assertWindowConnectionsClosed(mark, label);
      return homeInventory(home);
    },
  };
}

/** The paths added, changed (bytes or mtime) and removed between two inventories. */
function inventoryDelta(before: Record<string, string>, after: Record<string, string>) {
  return {
    added: Object.keys(after)
      .filter((path) => before[path] === undefined)
      .sort(),
    changed: Object.keys(after)
      .filter((path) => before[path] !== undefined && before[path] !== after[path])
      .sort(),
    removed: Object.keys(before)
      .filter((path) => after[path] === undefined)
      .sort(),
  };
}

function logWritten(home: string): boolean {
  return existsSync(join(home, "logs", "sorage.log"));
}

function errorCode(result: { err: string }): string {
  return (JSON.parse(result.err) as { error: { code: string } }).error.code;
}

/** An initialized home with one Channel, one worker, and one committed message. */
function installation(prefix: string) {
  const home = tempHome(prefix);
  const work = join(home, "work");
  mkdirSync(work);
  expect(run(["init", "--non-interactive", "--json"]).code).toBe(0);
  for (const args of [
    ["channel", "create", "aq-cov", "--json"],
    ["channel", "add", "aq-cov", "w1", "--role", "worker", "--json"],
    ["channel", "post", "aq-cov", "--from", "w1", "--kind", "report", "--body", "covered body", "--json"],
  ]) {
    const result = run(args, work);
    expect(result.code, result.err).toBe(0);
  }
  expect(logWritten(home)).toBe(false);
  return { home, work, database: join(home, "state", "sorage.sqlite3") };
}

describe("the covered Channel reads", () => {
  it("answers the three reads and an empty wait with exit 0 and no log, in both forms", () => {
    const f = installation("sorage-chcov-basic-");
    for (const [label, args, json] of [
      ["list", ["channel", "list", "--json"], true],
      ["show", ["channel", "show", "aq-cov", "--json"], true],
      ["messages", ["channel", "messages", "aq-cov", "--json"], true],
      ["list human", ["channel", "list"], false],
      ["show human", ["channel", "show", "aq-cov"], false],
      ["messages human", ["channel", "messages", "aq-cov"], false],
      ["empty wait", ["channel", "messages", "aq-cov", "--after", "1", "--wait", "--timeout", "1", "--json"], true],
    ] as Array<[string, string[], boolean]>) {
      const result = run(args, f.work);
      expect(result.code, `${label}: ${result.err}`).toBe(0);
      if (json) {
        const envelope = JSON.parse(result.out) as { ok: boolean };
        expect(envelope.ok, label).toBe(true);
      } else {
        expect(result.err, label).toBe("");
      }
    }
    expect(logWritten(f.home)).toBe(false);
  });

  it("renders action-path and parser-stage failures log-free while a Channel mutation still logs", () => {
    const f = installation("sorage-chcov-logfree-");
    // A typed action failure (unknown Channel) renders without the log.
    const unknown = run(["channel", "show", "ghost", "--json"], f.work);
    expect(unknown.code).toBe(66);
    expect(unknown.out).toBe("");
    expect(errorCode(unknown)).toBe("CHN_NOT_FOUND");
    expect(logWritten(f.home)).toBe(false);
    // A parser-stage failure of a covered read never reaches an action and
    // stays log-free; a mutation's failure still writes the log.
    const parser = run(["channel", "messages", "aq-cov", "--after", "x", "--json"], f.work);
    expect(parser.code).toBe(2);
    expect(logWritten(f.home)).toBe(false);
    const failedMutation = run(["channel", "remove", "aq-cov", "main", "--json"], f.work);
    expect(failedMutation.code, failedMutation.err).toBe(64);
    expect(logWritten(f.home)).toBe(true);
  });

  it("renders returned and thrown INTERNAL_ERROR failures log-free with the request-id recovery in both forms, each injection proven executed (items 12 and 4)", () => {
    const f = installation("sorage-chcov-internal-");
    const originalFactory = channelCommandPorts.createNodeChannelPorts;
    const assertLogFreeInternal = (result: { code: number; out: string; err: string }, label: string) => {
      expect(result.code, label).toBe(1);
      expect(result.out, label).toBe("");
      const envelope = JSON.parse(result.err) as {
        error: { code: string; message: string; recovery?: { suggestedCommand: string } };
        meta: { requestId: string };
      };
      expect(envelope.error.code, label).toBe("INTERNAL_ERROR");
      // The log-free INTERNAL_ERROR recovery names the request id and the
      // retained output, never the installation log the catalogue default
      // points at (the covered reads write no log).
      expect(envelope.error.recovery?.suggestedCommand, label).toContain(envelope.meta.requestId);
      expect(envelope.error.recovery?.suggestedCommand, label).toContain("wrote no installation log");
      expect(envelope.error.recovery?.suggestedCommand, label).not.toContain("sorage.log");
      return envelope;
    };
    const assertLogFreeInternalHuman = (result: { code: number; err: string }, label: string) => {
      expect(result.code, label).toBe(1);
      expect(result.err, label).toContain("INTERNAL_ERROR");
      expect(result.err, label).toContain("Retain request ");
      expect(result.err, label).toContain("wrote no installation log");
      expect(result.err, label).not.toContain("sorage.log");
    };

    // The returned failure: the repository's read seam returns INTERNAL_ERROR
    // with no site recovery; the composition renders it log-free.
    let returnedInjected = 0;
    const returnedSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = originalFactory(options);
      const realRead = ports.channels.read;
      ports.channels.read = (<T>(...args: Parameters<typeof realRead>) => {
        returnedInjected += 1;
        if (returnedInjected === 1) {
          return err(appError("INTERNAL_ERROR", "injected returned internal failure")) as unknown as {
            ok: true;
            value: T;
          };
        }
        return realRead(...args) as unknown as { ok: true; value: T };
      }) as typeof realRead;
      return ports;
    });
    try {
      const json = run(["channel", "list", "--json"], f.work);
      const envelope = assertLogFreeInternal(json, "returned json");
      expect(envelope.error.message).toBe("injected returned internal failure");
      expect(returnedInjected, "the returned injection executed (json)").toBeGreaterThanOrEqual(1);
      expect(logWritten(f.home)).toBe(false);
      returnedInjected = 0;
      const human = run(["channel", "list"], f.work);
      assertLogFreeInternalHuman(human, "returned human");
      expect(human.err).toContain("injected returned internal failure");
      expect(returnedInjected, "the returned injection executed (human)").toBeGreaterThanOrEqual(1);
      expect(logWritten(f.home)).toBe(false);
    } finally {
      returnedSpy.mockRestore();
    }

    // The thrown failure: the read seam throws and the catch renders the
    // typed envelope log-free.
    let thrownInjected = 0;
    const thrownSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = originalFactory(options);
      const realRead = ports.channels.read;
      ports.channels.read = (<T>(...args: Parameters<typeof realRead>) => {
        thrownInjected += 1;
        if (thrownInjected === 1) throw new Error("injected thrown composition failure");
        return realRead(...args) as unknown as { ok: true; value: T };
      }) as typeof realRead;
      return ports;
    });
    try {
      const json = run(["channel", "list", "--json"], f.work);
      const envelope = assertLogFreeInternal(json, "thrown json");
      expect(envelope.error.message).toContain("injected thrown composition failure");
      expect(thrownInjected, "the thrown injection executed (json)").toBeGreaterThanOrEqual(1);
      expect(logWritten(f.home)).toBe(false);
      thrownInjected = 0;
      const human = run(["channel", "list"], f.work);
      assertLogFreeInternalHuman(human, "thrown human");
      expect(human.err).toContain("injected thrown composition failure");
      expect(thrownInjected, "the thrown injection executed (human)").toBeGreaterThanOrEqual(1);
      expect(logWritten(f.home)).toBe(false);
    } finally {
      thrownSpy.mockRestore();
    }

    // Extra coverage: a returned typed contention refusal renders log-free at
    // its own exit.
    let contentionInjected = 0;
    const contentionSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = originalFactory(options);
      const realRead = ports.channels.read;
      ports.channels.read = (<T>(...args: Parameters<typeof realRead>) => {
        contentionInjected += 1;
        if (contentionInjected === 1) {
          return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "injected returned listing failure")) as unknown as {
            ok: true;
            value: T;
          };
        }
        return realRead(...args) as unknown as { ok: true; value: T };
      }) as typeof realRead;
      return ports;
    });
    try {
      const json = run(["channel", "list", "--json"], f.work);
      expect(json.code).toBe(75);
      expect(errorCode(json)).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(contentionInjected, "the contention injection executed").toBeGreaterThanOrEqual(1);
      expect(logWritten(f.home)).toBe(false);
    } finally {
      contentionSpy.mockRestore();
    }
  });

  it("keeps the Vault-open refusal on the covered Channel reads, identically and write-free", () => {
    const f = installation("sorage-chcov-vault-");
    rmSync(join(f.home, "vault"), { recursive: true, force: true });
    const verify = run(["vault", "verify", "--json"]);
    expect(verify.code).toBe(73);
    for (const args of [
      ["channel", "list", "--json"],
      ["channel", "show", "aq-cov", "--json"],
      ["channel", "messages", "aq-cov", "--json"],
    ]) {
      const result = run(args, f.work);
      expect(result.code, args.join(" ")).toBe(73);
      expect(result.out, args.join(" ")).toBe("");
      const envelope = JSON.parse(result.err) as { error: Record<string, unknown> };
      const verifyError = (JSON.parse(verify.err) as { error: Record<string, unknown> }).error;
      expect(envelope.error, args.join(" ")).toEqual(verifyError);
    }
  });

  it("pauses one-shot reads and the wait's start under a live lock, and serves everything under a stale one", () => {
    const f = installation("sorage-chcov-pause-");
    const settle = new DatabaseSync(f.database);
    settle.exec("PRAGMA journal_mode=WAL");
    settle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    settle.close();
    writeFileSync(`${f.database}-wal`, Buffer.alloc(0));
    const runDir = join(f.home, "run");
    const lockPath = join(runDir, "vault-move.lock");
    const writeLock = (pid: number) => {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(lockPath, `${JSON.stringify({ pid, startedAt: new Date().toISOString(), hostname: "chcov" })}\n`);
    };
    writeLock(process.pid);
    // The one-shot reads keep the drain's SERVICE_PAUSED exit (RDR-005),
    // rendered log-free, both forms; the wait's single start admission
    // refuses the same way.
    for (const [label, args, json] of [
      ["list json", ["channel", "list", "--json"], true],
      ["show json", ["channel", "show", "aq-cov", "--json"], true],
      ["list human", ["channel", "list"], false],
      ["wait start", ["channel", "messages", "aq-cov", "--after", "1", "--wait", "--timeout", "1", "--json"], true],
    ] as Array<[string, string[], boolean]>) {
      const result = run(args, f.work);
      expect(result.code, label).toBe(75);
      if (json) {
        const envelope = JSON.parse(result.err) as {
          error: { code: string; details: { lockPath: string } };
        };
        expect(envelope.error.code, label).toBe("SERVICE_PAUSED");
        expect(envelope.error.details.lockPath, label).toBe(lockPath);
      } else {
        expect(result.err, label).toContain("SERVICE_PAUSED");
      }
    }
    expect(logWritten(f.home)).toBe(false);
    // A stale lock (a dead pid) pauses no one.
    writeLock(999_999_999);
    for (const args of [
      ["channel", "list", "--json"],
      ["channel", "messages", "aq-cov", "--json"],
    ]) {
      const result = run(args, f.work);
      expect(result.code, args.join(" ")).toBe(0);
    }
    expect(existsSync(lockPath)).toBe(true);
  });

  it("runs the bound mid-wait lock arrival sequence and the timeout variant, each inside a full inventory window (readiness decision, items 10 and 5)", () => {
    const f = installation("sorage-chcov-midwait-");
    const runDir = join(f.home, "run");
    const lockPath = join(runDir, "vault-move.lock");
    const writeLock = () => {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "chcov" })}\n`,
      );
    };
    const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
    const realPorts = channelCommandPorts.createNodeChannelPorts;
    // Counters separate the start admission from polls under the lock.
    let startAdmissions = 0;
    let pollsTotal = 0;
    let pollsWhileLockHeld = 0;
    let lockHeld = false;
    let lockObservedHeld = false;
    const order: string[] = [];
    let peerPosted = false;
    const spy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = realPorts(options);
      if ((options as { database?: unknown }).database !== undefined) {
        pollsTotal += 1;
        if (pollsTotal === 1) {
          // Step 1-2: the wait starts on an empty filter; this composition is
          // the start admission (vaultAdmission path — see the count below).
          startAdmissions += 1;
          order.push("start-admission");
        } else {
          if (!lockHeld && !peerPosted) {
            // Step 3: a live lock appears after the start admission.
            lockHeld = true;
            writeLock();
            order.push("lock-created");
          } else if (lockHeld && !lockObservedHeld) {
            // Step 4: a poll completes while the lock is held and the wait is
            // still running — this composition is that poll's proof.
            pollsWhileLockHeld += 1;
            lockObservedHeld = true;
            order.push("poll-under-lock");
          } else if (lockHeld && lockObservedHeld && !peerPosted) {
            // Step 5-6: release the lock, then the peer post lands (outside
            // the wait's own process, through the real CLI).
            rmSync(lockPath, { force: true });
            lockHeld = false;
            const peer = spawnSync(
              "bun",
              [
                entry,
                "channel",
                "post",
                "aq-cov",
                "--from",
                "w1",
                "--kind",
                "question",
                "--body",
                "later body",
                "--json",
              ],
              { cwd: f.work, env: { ...process.env, SORAGE_HOME: f.home }, encoding: "utf8", timeout: 20_000 },
            );
            expect(peer.status, peer.stderr).toBe(0);
            peerPosted = true;
            order.push("lock-released", "peer-posted");
          }
        }
      }
      return ports;
    });
    const window = openInventoryWindow(f.home);
    try {
      const wait = run(
        ["channel", "messages", "aq-cov", "--after", "1", "--wait", "--timeout", "8", "--interval", "1", "--json"],
        f.work,
      );
      // Step 7: exit 0 with the full body and no meta.timedOut.
      expect(wait.code, wait.err).toBe(0);
      const envelope = JSON.parse(wait.out) as {
        data: { items: Array<{ seq: number; body: string }> };
        meta: { timedOut?: boolean };
      };
      expect(envelope.meta.timedOut).toBeUndefined();
      expect(envelope.data.items.map((item) => [item.seq, item.body])).toEqual([[2, "later body"]]);
      expect(startAdmissions).toBe(1);
      expect(pollsWhileLockHeld).toBeGreaterThanOrEqual(1);
      expect(order).toEqual(["start-admission", "lock-created", "poll-under-lock", "lock-released", "peer-posted"]);
      expect(peerPosted).toBe(true);
      // Item 5: the full home and Vault inventories, bytes and mtimes. The lock
      // was created and released inside the wait, so it is in neither capture;
      // the peer's authorized post changed the database file and its sidecars,
      // and nothing else was added, changed or removed.
      expect(existsSync(lockPath)).toBe(false);
      const delta = inventoryDelta(window.before, window.after("arrival wait"));
      const authorized = new Set([f.database, `${f.database}-wal`, `${f.database}-shm`]);
      expect(delta.removed).toEqual([]);
      expect(delta.changed).toContain(f.database);
      expect([...delta.added, ...delta.changed].filter((path) => !authorized.has(path))).toEqual([]);
      expect(logWritten(f.home)).toBe(false);
    } finally {
      spy.mockRestore();
      rmSync(lockPath, { force: true });
    }

    // The timeout variant: a live lock appears mid-wait and stays; the wait
    // times out with meta.timedOut and exit 0, and the only inventory change
    // is the test's own lock.
    const f2 = installation("sorage-chcov-midwait-timeout-");
    const runDir2 = join(f2.home, "run");
    const lockPath2 = join(runDir2, "vault-move.lock");
    const realPorts2 = channelCommandPorts.createNodeChannelPorts;
    let polls2 = 0;
    let lock2Created = false;
    let polls2UnderLock = 0;
    const spy2 = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = realPorts2(options);
      if ((options as { database?: unknown }).database !== undefined) {
        polls2 += 1;
        if (polls2 >= 2 && !lock2Created) {
          mkdirSync(runDir2, { recursive: true });
          writeFileSync(
            lockPath2,
            `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "chcov" })}\n`,
          );
          lock2Created = true;
        } else if (lock2Created) {
          polls2UnderLock += 1;
        }
      }
      return ports;
    });
    try {
      const window2 = openInventoryWindow(f2.home);
      const wait = run(
        ["channel", "messages", "aq-cov", "--after", "1", "--wait", "--timeout", "3", "--interval", "1", "--json"],
        f2.work,
      );
      expect(wait.code, wait.err).toBe(0);
      const envelope = JSON.parse(wait.out) as { data: { items: unknown[] }; meta: { timedOut?: boolean } };
      expect(envelope.meta.timedOut).toBe(true);
      expect(envelope.data.items).toEqual([]);
      expect(lock2Created).toBe(true);
      expect(polls2UnderLock).toBeGreaterThanOrEqual(1);
      // Item 5: nothing was added, changed or removed except the test's lock.
      expect(inventoryDelta(window2.before, window2.after("timeout wait"))).toEqual({
        added: [lockPath2],
        changed: [],
        removed: [],
      });
      expect(logWritten(f2.home)).toBe(false);
    } finally {
      spy2.mockRestore();
      rmSync(lockPath2, { force: true });
    }
  });

  it("settles the sidecar gap for surface channel with the rebuilt recovery and no -shm", () => {
    const f = installation("sorage-chcov-gap-");
    const writer = new DatabaseSync(f.database);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("UPDATE migration_lock SET id = 1 WHERE id = 1");
    expect(lstatSync(`${f.database}-wal`).size).toBeGreaterThan(32);
    rmSync(`${f.database}-shm`);
    try {
      const listed = run(["channel", "list", "--json"], f.work);
      expect(listed.code).toBe(75);
      expect(errorCode(listed)).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      const recovery = (JSON.parse(listed.err) as { error: { recovery: { suggestedCommand: string } } }).error.recovery
        .suggestedCommand;
      expect(recovery).toContain("recreate the missing -shm");
      expect(existsSync(`${f.database}-shm`)).toBe(false);
      expect(logWritten(f.home)).toBe(false);
    } finally {
      writer.close();
    }
  });

  it("negative control: a connection opened inside the window and left open fails the connection assertion (c2-decision item 3)", () => {
    const f = installation("sorage-chcov-control-connection-");
    const window = openInventoryWindow(f.home);
    const leaked = new DatabaseSync(f.database);
    try {
      leaked.exec("PRAGMA user_version");
      expect(connectionsOpenedSince(window.mark)).toHaveLength(1);
      expect(() => window.after("leaked connection")).toThrowError(/connections opened inside the window still open/);
    } finally {
      leaked.close();
    }
    // Once the leak is closed, the same window's connection assertion passes.
    expect(connectionsOpenedSince(window.mark)).toHaveLength(0);
    window.after("closed again");
  });

  it("negative control: a sidecar-creating writer open inside the window fails the inventory comparison (c2-decision item 3)", () => {
    const f = installation("sorage-chcov-control-sidecar-");
    const window = openInventoryWindow(f.home);
    expect(existsSync(`${f.database}-wal`), "precondition: the settled baseline holds no sidecars").toBe(false);
    const writer = new DatabaseSync(f.database);
    try {
      writer.exec("BEGIN IMMEDIATE");
      // The raw capture, as `after` would take it past the connection
      // assertion: the open writer's sidecars make the comparison fail.
      const raw = homeInventory(f.home);
      expect(raw).not.toEqual(window.before);
      expect(inventoryDelta(window.before, raw)).toEqual({
        added: [`${f.database}-shm`, `${f.database}-wal`],
        changed: [],
        removed: [],
      });
      expect(connectionsOpenedSince(window.mark)).toHaveLength(1);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
