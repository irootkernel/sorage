import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../packages/adapters/src/sqlite/migrations";
import { migrate } from "../../packages/adapters/src/sqlite/migrator";
import { knownSchemaMaximum } from "../../packages/core/src/known-schemas";
import {
  BINARY,
  envelopeOf,
  errorEnvelopeOf,
  makeTempDir,
  type Run,
  registerCleanup,
  runCleanups,
  sorage,
  storageProof,
} from "./helpers";

/**
 * The TASK-122 acceptance gate (AJ-30 steps 1 and 2 for the CLI read path):
 * every covered read command, `inbox --wait` included, succeeds under a real
 * `sandbox-exec` profile that denies every write, with output identical to an
 * unrestricted run and byte- and mtime-identical home and Vault inventories —
 * no exception for `-wal`, `-shm` or the log. The reads run against every
 * measured storage state: the empty `-wal` a clean close leaves, a `-wal`
 * holding a killed writer's frames, a connected idle writer after a commit, a
 * header-only `-wal`, an incomplete frame tail, and the sidecars-absent
 * quiescent file — plus the RDR-002 refusals, a concurrent `BEGIN IMMEDIATE`
 * holder, and the wait waking from a copy-served state. Every state case
 * asserts its precondition first, and an external writer's legitimate changes
 * are reported separately from the reader's zero-write claim.
 */

afterAll(runCleanups);

const SANDBOX = "/usr/bin/sandbox-exec";
const DENY_WRITE_PROFILE = "(version 1)(allow default)(deny file-write*)";
const sandboxAvailable = existsSync(SANDBOX);

function main(home: string, cwd: string, args: string[]): Run {
  return sorage(args, { home, cwd });
}

function inSandbox(home: string, cwd: string, args: string[]): Run {
  return sorage(["-p", DENY_WRITE_PROFILE, BINARY, ...args], { binary: SANDBOX, home, cwd });
}

/** A long-running waiter process with its completion promise, for waits that a peer wakes. */
function spawnWaiter(command: string, args: string[], home: string, cwd: string) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: undefined },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  // Captured before any yield: a zero-write waiter exposes no readiness signal,
  // so a later `once("close")` could miss an already-emitted event.
  const done = new Promise<Run>((resolve) => {
    child.on("close", (status) => {
      resolve({ status: status ?? null, stdout, stderr });
    });
  });
  registerCleanup(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  return { child, done };
}

/** An initialized home with two Projects, one sent Handoff and two Memos, all through real CLI writes. */
function fixture(prefix: string) {
  const home = makeTempDir(prefix);
  const work = join(home, "work");
  const other = join(home, "other");
  const vault = join(home, "vault");
  for (const dir of [work, other]) mkdirSync(dir);
  for (const args of [
    ["init", "--non-interactive", "--initialize-git"],
    ["project", "add", "--name", "Alpha", "--slug", "alpha", "--dir", work],
    ["project", "add", "--name", "Beta", "--slug", "beta", "--dir", other],
  ]) {
    const run = sorage([...args, "--json"], { home, cwd: work });
    expect(run.status, run.stderr).toBe(0);
  }
  const sent = sorage(["send", "--to", "alpha", "--title", "Hello", "--body", "the body", "--json"], {
    home,
    cwd: other,
  });
  expect(sent.status, sent.stderr).toBe(0);
  const handoffId = (envelopeOf(sent) as { data: { handoffs: Array<{ handoffId?: string }> } }).data.handoffs[0]
    ?.handoffId as string;
  const first = sorage(["memo", "add", "--title", "First", "--json"], { home, cwd: work });
  expect(first.status, first.stderr).toBe(0);
  const memoId = (envelopeOf(first) as { data: { memo: { id: string } } }).data.memo.id;
  const second = sorage(["memo", "add", "--title", "Second", "--json"], { home, cwd: work });
  for (const args of [
    ["channel", "create", "aq-cov", "--json"],
    ["channel", "add", "aq-cov", "w1", "--role", "worker", "--json"],
    ["channel", "post", "aq-cov", "--from", "w1", "--kind", "report", "--body", "covered channel body", "--json"],
  ]) {
    const run = sorage(args, { home, cwd: work });
    expect(run.status, run.stderr).toBe(0);
  }
  expect(second.status, second.stderr).toBe(0);
  return { home, work, other, vault, handoffId, memoId, database: join(home, "state", "sorage.sqlite3") };
}

/** The database state a clean close leaves: an empty `-wal` beside its `-shm`. */
function assertEmptyWalState(f: ReturnType<typeof fixture>) {
  expect(lstatSync(`${f.database}-wal`).size, "precondition: empty -wal").toBe(0);
  expect(lstatSync(`${f.database}-shm`).isFile(), "precondition: -shm present").toBe(true);
}

/** Normalizes the per-process requestId the envelopes legitimately differ by. */
function normalize(text: string): string {
  try {
    const parsed = JSON.parse(text) as { meta?: { requestId?: string } };
    if (parsed !== null && typeof parsed === "object" && parsed.meta !== undefined && "requestId" in parsed.meta) {
      parsed.meta.requestId = "<requestId>";
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Human output carries no request id.
  }
  return text;
}

function expectIdenticalOutput(sandboxRun: Run, plainRun: Run, label: string) {
  expect(sandboxRun.status, `${label} status: ${sandboxRun.stderr}`).toBe(plainRun.status);
  expect(normalize(sandboxRun.stdout), `${label} stdout`).toBe(normalize(plainRun.stdout));
  expect(normalize(sandboxRun.stderr), `${label} stderr`).toBe(normalize(plainRun.stderr));
}

/** The relative paths whose inventory rows differ between two snapshots. */
function deltaPaths(before: string[], after: string[]): string[] {
  return after
    .filter((row) => !before.includes(row))
    .map((row) => row.split(" ")[1] ?? row)
    .sort();
}

/** The one set of home entries a peer's authorized post changes: the database file and its sidecars. */
const DATABASE_ROWS = new Set(["state/sorage.sqlite3", "state/sorage.sqlite3-wal", "state/sorage.sqlite3-shm"]);

/** Splits a home inventory into the database rows and every other entry. */
function partitionDatabaseRows(rows: string[]): { database: string[]; others: string[] } {
  const database: string[] = [];
  const others: string[] = [];
  for (const row of rows) {
    const rel = row.split(" ")[1];
    (rel !== undefined && DATABASE_ROWS.has(rel) ? database : others).push(row);
  }
  return { database, others };
}

const coveredCommands = (f: ReturnType<typeof fixture>): Array<[string, string[]]> => [
  ["inbox", ["inbox", "--json"]],
  ["outbox", ["outbox", "--json"]],
  ["get", ["get", f.handoffId, "--json"]],
  ["events", ["events", f.handoffId, "--json"]],
  ["review show", ["review", "show", f.handoffId, "--json"]],
  ["comment show", ["comment", "show", f.handoffId, "--json"]],
  ["memo list", ["memo", "list", "--json"]],
  ["memo show", ["memo", "show", f.memoId, "--json"]],
  ["project list", ["project", "list", "--json"]],
  ["project show", ["project", "show", "alpha", "--json"]],
  ["channel messages", ["channel", "messages", "aq-cov", "--json"]],
  ["channel list", ["channel", "list", "--json"]],
  ["channel show", ["channel", "show", "aq-cov", "--json"]],
  ["channel messages human", ["channel", "messages", "aq-cov"]],
  ["channel list human", ["channel", "list"]],
  ["channel show human", ["channel", "show", "aq-cov"]],
  ["channel wait", ["channel", "messages", "aq-cov", "--wait", "--timeout", "1", "--json"]],
  ["channel wait human", ["channel", "messages", "aq-cov", "--wait", "--timeout", "1"]],
  ["inbox wait", ["inbox", "--wait", "--timeout", "1", "--json"]],
  ["inbox human", ["inbox"]],
  ["outbox human", ["outbox"]],
  ["get human", ["get", f.handoffId]],
  ["events human", ["events", f.handoffId]],
  ["review show human", ["review", "show", f.handoffId]],
  ["comment show human", ["comment", "show", f.handoffId]],
  ["memo list human", ["memo", "list"]],
  ["memo show human", ["memo", "show", f.memoId]],
  ["project list human", ["project", "list"]],
  ["project show human", ["project", "show", "alpha"]],
  ["inbox wait human", ["inbox", "--wait", "--timeout", "1"]],
];

/** A spawned writer process that commits one benign write (no Sorage data changes) with persistent sidecars. */
async function frameWritingWriter(database: string) {
  // The READY marker lives outside the installation: a synchronization marker
  // inside an inventoried tree once raced an inventory snapshot by its own
  // timestamp.
  const sync = makeTempDir("sorage-zero-write-sync-");
  const marker = join(sync, "ready");
  const script = `import {constants, Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs';
    const db = new Database(${JSON.stringify(database)});
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
    db.exec('BEGIN'); db.exec('UPDATE migration_lock SET id = 1 WHERE id = 1'); db.exec('COMMIT');
    writeFileSync(${JSON.stringify(marker)}, 'READY');
    setInterval(() => db.exec('SELECT 1'), 1000);`;
  const child = spawn("bun", ["-e", script], { stdio: "ignore" });
  registerCleanup(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  const closed = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("close", (_code, signal) => resolve(signal)),
  );
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await delay(10);
  expect(existsSync(marker), "the writer must commit before READY").toBe(true);
  return {
    child,
    async kill() {
      expect(child.kill("SIGKILL")).toBe(true);
      expect(await closed).toBe("SIGKILL");
    },
  };
}

/** One event-loop turn between synchronous child-process stretches, so a long test never starves the worker RPC transport. */
async function yieldLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("the covered reads under a write-denying sandbox (TASK-122)", () => {
  it.skipIf(!sandboxAvailable)("sandbox control: the denial is live and a write command refuses inside it", () => {
    const f = fixture("sorage-zero-write-control-");
    const version = inSandbox(f.home, f.work, ["version", "--json"]);
    expect(version.status, version.stderr).toBe(0);
    const send = inSandbox(f.home, f.other, ["send", "--to", "alpha", "--title", "Nope", "--body", "x", "--json"]);
    expect(send.status).toBe(75);
    expect(send.stdout).toBe("");
    const refusal = errorEnvelopeOf(send);
    expect(refusal.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    // The observed wording under deny-all-write is the write-protected form:
    // the writable open succeeds against the readable main file and its own
    // first write (the WAL conversion or the migration's BEGIN) fails
    // SQLITE_READONLY, so the message says storage "is write-protected".
    // Pinned after observation.
    expect(refusal.error.message).toContain("is write-protected");
  });

  it.skipIf(!sandboxAvailable)(
    "reads the empty -wal a clean close leaves: identical outputs and identical inventories, sandboxed and unrestricted",
    async () => {
      const f = fixture("sorage-zero-write-emptywal-");
      assertEmptyWalState(f);
      for (const [name, args] of coveredCommands(f)) {
        const plain = main(f.home, f.work, args);
        expect(plain.status, `${name}: ${plain.stderr}`).toBe(0);
        const beforeHome = storageProof(f.home);
        const beforeVault = storageProof(f.vault);
        const boxed = inSandbox(f.home, f.work, args);
        expectIdenticalOutput(boxed, plain, `${name} sandboxed`);
        expect(storageProof(f.home), `${name} home inventory`).toEqual(beforeHome);
        expect(storageProof(f.vault), `${name} vault inventory`).toEqual(beforeVault);
        await yieldLoop();
      }
      // The unrestricted phase, with no concurrent writer, changes nothing either.
      for (const [name, args] of coveredCommands(f)) {
        const beforeHome = storageProof(f.home);
        const beforeVault = storageProof(f.vault);
        expect(main(f.home, f.work, args).status, name).toBe(0);
        expect(storageProof(f.home), `${name} unrestricted home inventory`).toEqual(beforeHome);
        expect(storageProof(f.vault), `${name} unrestricted vault inventory`).toEqual(beforeVault);
        await yieldLoop();
      }
      expect(existsSync(join(f.home, "logs", "sorage.log"))).toBe(false);
    },
  );

  it.skipIf(!sandboxAvailable)("times out a sandboxed inbox --wait without writing anything", () => {
    const f = fixture("sorage-zero-write-wait-timeout-");
    assertEmptyWalState(f);
    const beforeHome = storageProof(f.home);
    const beforeVault = storageProof(f.vault);
    const wait = inSandbox(f.home, f.work, ["inbox", "--wait", "--timeout", "1", "--json"]);
    expect(wait.status, wait.stderr).toBe(0);
    const body = envelopeOf(wait) as { meta: { timedOut?: boolean } };
    expect(body.meta.timedOut).toBe(true);
    expect(storageProof(f.home)).toEqual(beforeHome);
    expect(storageProof(f.vault)).toEqual(beforeVault);
  });

  /** Starts a sandboxed `inbox --wait`, sends from the peer after a generous seed allowance, and asserts the wake. */
  async function wakeOnPeerSend(f: ReturnType<typeof fixture>, prepare?: (target: ReturnType<typeof fixture>) => void) {
    const waitProc = spawn(
      SANDBOX,
      ["-p", DENY_WRITE_PROFILE, BINARY, "inbox", "--wait", "--timeout", "20", "--json"],
      { cwd: f.work, env: { ...process.env, SORAGE_HOME: f.home, SORAGE_TEST_REQUEST_ID: undefined } },
    );
    // The completion promise is captured immediately after the spawn, before
    // any yield: a reader that writes nothing exposes no readiness signal, so
    // a later `once("close")` could otherwise wait for an already-emitted
    // event if the waiter finished during a yield.
    const exited = new Promise<number | null>((resolve) => waitProc.once("close", resolve));
    registerCleanup(() => {
      if (waitProc.exitCode === null && !waitProc.killed) waitProc.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    waitProc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    waitProc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // A fixed seed allowance is unavoidable — a zero-write reader exposes no
    // readiness signal — so it is generous: three seconds covers the fixture's
    // last writer closing and the waiter's first copy-served seed under load,
    // while staying far inside the 20-second wait timeout.
    await delay(3_000);
    expect(existsSync(join(f.home, "logs", "sorage.log")), "the waiting reader wrote no log").toBe(false);
    // The writer's own legitimate changes are separated from the reader's
    // zero-write claim by a twin fixture in the same starting shape: the
    // delta's path set must be the send's alone, and the log stays absent.
    const control = fixture("sorage-zero-write-wake-control-");
    prepare?.(control);
    const beforeHome = storageProof(f.home);
    const controlBefore = storageProof(control.home);
    for (const target of [f, control]) {
      const sent = sorage(["send", "--to", "alpha", "--title", "Wake", "--body", "wake body", "--json"], {
        home: target.home,
        cwd: target.other,
      });
      expect(sent.status, sent.stderr).toBe(0);
      await yieldLoop();
    }
    const readerDelta = deltaPaths(beforeHome, storageProof(f.home)).filter((path) => !path.startsWith("logs"));
    const writerDelta = deltaPaths(controlBefore, storageProof(control.home)).filter(
      (path) => !path.startsWith("logs"),
    );
    expect(readerDelta).toEqual(writerDelta);
    const exit = await exited;
    expect(exit, stderr).toBe(0);
    const body = JSON.parse(stdout) as {
      ok: boolean;
      data: { handoffs: Array<{ title: string }> };
      meta: { timedOut?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.meta.timedOut).toBeUndefined();
    expect(body.data.handoffs.map((handoff) => handoff.title)).toEqual(["Wake"]);
    expect(existsSync(join(f.home, "logs", "sorage.log")), "the waiting reader wrote no log").toBe(false);
  }

  it.skipIf(!sandboxAvailable)("wakes a wait that started on the empty-wal copy when a peer sends later", async () => {
    const f = fixture("sorage-zero-write-wait-wake-");
    assertEmptyWalState(f);
    await wakeOnPeerSend(f);
  });

  it.skipIf(!sandboxAvailable)(
    "wakes a wait that started on the sidecars-absent copy when a peer sends later",
    async () => {
      const f = fixture("sorage-zero-write-wait-wake-absent-");
      const makeSidecarsAbsent = (target: ReturnType<typeof fixture>) => {
        const writer = new DatabaseSync(target.database);
        writer.exec("PRAGMA journal_mode=WAL");
        writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        writer.close();
        rmSync(`${target.database}-wal`, { force: true });
        rmSync(`${target.database}-shm`, { force: true });
        expect(existsSync(`${target.database}-wal`), "precondition: sidecars absent").toBe(false);
      };
      makeSidecarsAbsent(f);
      await wakeOnPeerSend(f, makeSidecarsAbsent);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "times out and wakes sandboxed Channel waits in both forms with unsandboxed-identical output, and lists a materialized and a pending file-backed body, writing nothing",
    async () => {
      const f = fixture("sorage-zero-write-channelwait-");
      assertEmptyWalState(f);
      // The empty timeout: JSON and human, identical to unrestricted runs,
      // inventories unchanged.
      for (const args of [
        ["channel", "messages", "aq-cov", "--after", "99", "--wait", "--timeout", "1", "--json"],
        ["channel", "messages", "aq-cov", "--after", "99", "--wait", "--timeout", "1"],
      ]) {
        const plain = main(f.home, f.work, args);
        expect(plain.status, `${args.join(" ")}: ${plain.stderr}`).toBe(0);
        const beforeHome = storageProof(f.home);
        const beforeVault = storageProof(f.vault);
        const boxed = inSandbox(f.home, f.work, args);
        expectIdenticalOutput(boxed, plain, `${args.join(" ")} sandboxed`);
        expect(storageProof(f.home), `${args.join(" ")} home`).toEqual(beforeHome);
        expect(storageProof(f.vault), `${args.join(" ")} vault`).toEqual(beforeVault);
      }

      // The wakes, JSON then human. A sandboxed waiter and an unsandboxed
      // waiter run side by side on the same Channel and filter; after a lead-in
      // of two poll intervals, and only once both are observed still running,
      // an unrestricted peer process posts once. Both wake on that same
      // message, so their outputs are compared for equality; the inventories
      // are compared in full except the database file and its sidecars, which
      // the peer's authorized post changes, and the Vault is compared in full.
      let lastSeq = 1;
      for (const [form, formArgs] of [
        ["json", ["--json"]],
        ["human", []],
      ] as Array<[string, string[]]>) {
        const waitArgs = [
          "channel",
          "messages",
          "aq-cov",
          "--after",
          String(lastSeq),
          "--wait",
          "--timeout",
          "20",
          "--interval",
          "1",
          ...formArgs,
        ];
        const beforeHome = storageProof(f.home);
        const beforeVault = storageProof(f.vault);
        const boxed = spawnWaiter(SANDBOX, ["-p", DENY_WRITE_PROFILE, BINARY, ...waitArgs], f.home, f.work);
        const plain = spawnWaiter(BINARY, waitArgs, f.home, f.work);
        // Item 7: a lead-in of two poll intervals, then the proof that neither
        // waiter returned early. The residual limitation is recorded in the
        // report: a zero-write waiter prints nothing until it returns, so no
        // observable empty-poll signal exists without a product change.
        await delay(2_000);
        expect(boxed.child.exitCode, `${form}: the sandboxed waiter is still waiting`).toBeNull();
        expect(plain.child.exitCode, `${form}: the unsandboxed waiter is still waiting`).toBeNull();
        const body = `sandbox wake ${form}`;
        const peer = sorage(
          ["channel", "post", "aq-cov", "--from", "w1", "--kind", "question", "--body", body, "--json"],
          { home: f.home, cwd: f.work },
        );
        expect(peer.status, peer.stderr).toBe(0);
        lastSeq = (envelopeOf(peer) as { data: { message: { seq: number } } }).data.message.seq;
        const [boxedResult, plainResult] = await Promise.all([boxed.done, plain.done]);
        expect(plainResult.status, plainResult.stderr).toBe(0);
        expectIdenticalOutput(boxedResult, plainResult, `${form} wake`);
        if (form === "json") {
          const parsed = JSON.parse(boxedResult.stdout) as {
            data: { items: Array<{ seq: number; body: string }> };
            meta: { timedOut?: boolean };
          };
          expect(parsed.meta.timedOut).toBeUndefined();
          expect(parsed.data.items.map((item) => [item.seq, item.body])).toEqual([[lastSeq, body]]);
        } else {
          expect(boxedResult.stdout).toContain(body);
          expect(boxedResult.stdout).not.toContain("No matching unhandled message");
        }
        const before = partitionDatabaseRows(beforeHome);
        const after = partitionDatabaseRows(storageProof(f.home));
        expect(after.others, `${form} wake: every entry but the database rows`).toEqual(before.others);
        expect(after.database, `${form} wake: the peer's authorized write landed`).not.toEqual(before.database);
        expect(storageProof(f.vault), `${form} wake: the Vault in full`).toEqual(beforeVault);
        expect(existsSync(join(f.home, "logs", "sorage.log"))).toBe(false);
        await yieldLoop();
      }

      // A materialized file-backed body, its source outside the home, listed
      // inside the sandbox with bodyPath and the full body, wrapped in full
      // inventories.
      const large = join(makeTempDir("sorage-zero-write-channel-source-"), "channel-large.txt");
      writeFileSync(large, `${"z".repeat(70_000)}\n`);
      const backed = main(f.home, f.work, [
        "channel",
        "post",
        "aq-cov",
        "--from",
        "w1",
        "--kind",
        "report",
        "--body-file",
        large,
        "--json",
      ]);
      expect(backed.status, backed.stderr).toBe(0);
      const backedSeq = (envelopeOf(backed) as { data: { message: { seq: number } } }).data.message.seq;
      const materializedBeforeHome = storageProof(f.home);
      const materializedBeforeVault = storageProof(f.vault);
      const materializedListing = inSandbox(f.home, f.work, ["channel", "messages", "aq-cov", "--json"]);
      expect(materializedListing.status, materializedListing.stderr).toBe(0);
      type Listed = { seq: number; body: string | null; bodyPath: string | null; bodyPending: boolean };
      const materialized = (JSON.parse(materializedListing.stdout) as { data: { items: Listed[] } }).data.items.find(
        (item) => item.seq === backedSeq,
      );
      expect(materialized?.bodyPending).toBe(false);
      expect(materialized?.bodyPath).not.toBeNull();
      expect(materialized?.body?.length).toBe(70_001);
      expect(storageProof(f.home), "materialized read: home").toEqual(materializedBeforeHome);
      expect(storageProof(f.vault), "materialized read: vault").toEqual(materializedBeforeVault);

      // A pending body: the same file-backed message left unmaterialized with
      // no pending intent, the state an interrupted activation leaves behind.
      // The sandboxed listing reports it in place — exit 0, body null,
      // bodyPath null, bodyPending true — and writes nothing.
      const plant = new DatabaseSync(f.database);
      try {
        plant.exec("BEGIN IMMEDIATE");
        const planted = plant.prepare("UPDATE content_records SET materialized = 0 WHERE inline_text IS NULL").run();
        plant.prepare("DELETE FROM pending_fs_ops").run();
        plant.exec("COMMIT");
        expect(Number(planted.changes), "the pending plant executed on the file-backed record").toBeGreaterThanOrEqual(
          1,
        );
      } finally {
        plant.close();
      }
      const pendingBeforeHome = storageProof(f.home);
      const pendingBeforeVault = storageProof(f.vault);
      const pendingListing = inSandbox(f.home, f.work, ["channel", "messages", "aq-cov", "--json"]);
      expect(pendingListing.status, pendingListing.stderr).toBe(0);
      const pending = (JSON.parse(pendingListing.stdout) as { data: { items: Listed[] } }).data.items.find(
        (item) => item.seq === backedSeq,
      );
      expect(pending).toEqual(
        expect.objectContaining({ seq: backedSeq, body: null, bodyPath: null, bodyPending: true }),
      );
      expect(storageProof(f.home), "pending read: home").toEqual(pendingBeforeHome);
      expect(storageProof(f.vault), "pending read: vault").toEqual(pendingBeforeVault);
      expect(existsSync(join(f.home, "logs", "sorage.log"))).toBe(false);
      await yieldLoop();
    },
  );

  it.skipIf(!sandboxAvailable)("reads while another process holds BEGIN IMMEDIATE", () => {
    const f = fixture("sorage-zero-write-lock-");
    assertEmptyWalState(f);
    const holder = new DatabaseSync(f.database);
    registerCleanup(() => holder.close());
    holder.exec("PRAGMA journal_mode=WAL");
    holder.exec("BEGIN IMMEDIATE");
    const plain = main(f.home, f.work, ["inbox", "--json"]);
    expect(plain.status, plain.stderr).toBe(0);
    const beforeHome = storageProof(f.home);
    const boxed = inSandbox(f.home, f.work, ["inbox", "--json"]);
    expectIdenticalOutput(boxed, plain, "inbox under BEGIN IMMEDIATE");
    const memo = inSandbox(f.home, f.work, ["memo", "list", "--json"]);
    expect(memo.status, memo.stderr).toBe(0);
    const channelListed = inSandbox(f.home, f.work, ["channel", "list", "--json"]);
    expect(channelListed.status, channelListed.stderr).toBe(0);
    const channelMessages = inSandbox(f.home, f.work, ["channel", "messages", "aq-cov", "--json"]);
    expect(channelMessages.status, channelMessages.stderr).toBe(0);
    expect(storageProof(f.home)).toEqual(beforeHome);
  });

  it.skipIf(!sandboxAvailable)(
    "reads the frames a killed writer left, sandboxed and unrestricted, writing nothing",
    async () => {
      const f = fixture("sorage-zero-write-killed-");
      const writer = await frameWritingWriter(f.database);
      await writer.kill();
      expect(lstatSync(`${f.database}-wal`).size, "precondition: frames remain").toBeGreaterThan(32);
      expect(lstatSync(`${f.database}-shm`).isFile(), "precondition: -shm present").toBe(true);
      for (const args of [
        ["memo", "list", "--json"],
        ["inbox", "--json"],
        ["channel", "messages", "aq-cov", "--json"],
      ]) {
        const beforeHome = storageProof(f.home);
        const beforeVault = storageProof(f.vault);
        const plain = main(f.home, f.work, args);
        expect(plain.status, `${args.join(" ")}: ${plain.stderr}`).toBe(0);
        expect(storageProof(f.home), `${args.join(" ")} unrestricted home`).toEqual(beforeHome);
        expect(storageProof(f.vault), `${args.join(" ")} unrestricted vault`).toEqual(beforeVault);
        const boxed = inSandbox(f.home, f.work, args);
        expectIdenticalOutput(boxed, plain, `${args.join(" ")} sandboxed`);
        expect(storageProof(f.home), `${args.join(" ")} sandboxed home`).toEqual(beforeHome);
        expect(storageProof(f.vault), `${args.join(" ")} sandboxed vault`).toEqual(beforeVault);
      }
    },
  );

  it.skipIf(!sandboxAvailable)(
    "reads beside a connected idle writer after its commit, sandboxed and unrestricted",
    async () => {
      const f = fixture("sorage-zero-write-idle-");
      const writer = await frameWritingWriter(f.database);
      registerCleanup(() => writer.child.kill("SIGKILL"));
      expect(lstatSync(`${f.database}-wal`).size, "precondition: frames remain").toBeGreaterThan(32);
      expect(lstatSync(`${f.database}-shm`).isFile(), "precondition: -shm present").toBe(true);
      for (const args of [
        ["memo", "list", "--json"],
        ["inbox", "--json"],
        ["channel", "messages", "aq-cov", "--json"],
      ]) {
        const beforeHome = storageProof(f.home);
        const beforeVault = storageProof(f.vault);
        const plain = main(f.home, f.work, args);
        expect(plain.status, `${args.join(" ")}: ${plain.stderr}`).toBe(0);
        const boxed = inSandbox(f.home, f.work, args);
        expectIdenticalOutput(boxed, plain, `${args.join(" ")} sandboxed`);
        expect(storageProof(f.home), `${args.join(" ")} home`).toEqual(beforeHome);
        expect(storageProof(f.vault), `${args.join(" ")} vault`).toEqual(beforeVault);
      }
      // End the idle writer; the killed-writer and empty-wal cases above and
      // below already pin both storage states this leaves.
      await writer.kill();
      const after = inSandbox(f.home, f.work, ["memo", "list", "--json"]);
      expect(after.status, after.stderr).toBe(0);
      const afterChannel = inSandbox(f.home, f.work, ["channel", "messages", "aq-cov", "--json"]);
      expect(afterChannel.status, afterChannel.stderr).toBe(0);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "serves a killed writer's header-only -wal from the copy, promptly and write-free",
    async () => {
      const f = fixture("sorage-zero-write-headeronly-");
      const writer = await frameWritingWriter(f.database);
      await writer.kill();
      truncateSync(`${f.database}-wal`, 32);
      expect(lstatSync(`${f.database}-wal`).size, "precondition: header-only -wal").toBe(32);
      const plain = main(f.home, f.work, ["memo", "list", "--json"]);
      expect(plain.status, plain.stderr).toBe(0);
      expect((envelopeOf(plain) as { data: { items: unknown[] } }).data.items).toHaveLength(2);
      const beforeHome = storageProof(f.home);
      const started = Date.now();
      const boxed = inSandbox(f.home, f.work, ["memo", "list", "--json"]);
      expect(boxed.status, boxed.stderr).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      expectIdenticalOutput(boxed, plain, "memo list over a header-only -wal");
      expect(storageProof(f.home)).toEqual(beforeHome);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "reads a killed writer's incomplete frame tail through read-only WAL access",
    async () => {
      const f = fixture("sorage-zero-write-tail-");
      const writer = await frameWritingWriter(f.database);
      await writer.kill();
      truncateSync(`${f.database}-wal`, 2_000);
      expect(lstatSync(`${f.database}-wal`).size, "precondition: incomplete tail").toBe(2_000);
      const plain = main(f.home, f.work, ["memo", "list", "--json"]);
      expect(plain.status, plain.stderr).toBe(0);
      expect((envelopeOf(plain) as { data: { items: unknown[] } }).data.items).toHaveLength(2);
      const beforeHome = storageProof(f.home);
      for (const args of [
        ["memo", "list", "--json"],
        ["inbox", "--json"],
      ]) {
        const boxed = inSandbox(f.home, f.work, args);
        expect(boxed.status, boxed.stderr).toBe(0);
      }
      expect(storageProof(f.home)).toEqual(beforeHome);
    },
  );

  it.skipIf(!sandboxAvailable)("reads the quiescent sidecars-absent file through the copy in both modes", () => {
    const f = fixture("sorage-zero-write-absent-");
    const writer = new DatabaseSync(f.database);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.close();
    rmSync(`${f.database}-wal`, { force: true });
    rmSync(`${f.database}-shm`, { force: true });
    expect(existsSync(`${f.database}-wal`), "precondition: sidecars absent").toBe(false);
    for (const [name, args] of [
      ["memo list", ["memo", "list", "--json"]],
      ["inbox", ["inbox", "--json"]],
    ] as Array<[string, string[]]>) {
      const plain = main(f.home, f.work, args);
      expect(plain.status, `${name}: ${plain.stderr}`).toBe(0);
      const beforeHome = storageProof(f.home);
      const boxed = inSandbox(f.home, f.work, args);
      expectIdenticalOutput(boxed, plain, `${name} sandboxed`);
      expect(storageProof(f.home), `${name} inventory`).toEqual(beforeHome);
      expect(readdirSync(join(f.home, "state")).sort()).toEqual(["api-token", "sorage.sqlite3"]);
    }
    // A later write works again and leaves persistent sidecars.
    const wrote = sorage(["memo", "add", "--title", "Third", "--json"], { home: f.home, cwd: f.work });
    expect(wrote.status, wrote.stderr).toBe(0);
    expect(existsSync(`${f.database}-wal`)).toBe(true);
    expect(existsSync(`${f.database}-shm`)).toBe(true);
  });

  it.skipIf(!sandboxAvailable)(
    "refuses the RDR-002 states inside the sandbox and migrates through the named command",
    async () => {
      const f = fixture("sorage-zero-write-refusals-");
      await yieldLoop();
      for (const name of readdirSync(join(f.home, "state"))) {
        if (name.startsWith("sorage.sqlite3")) rmSync(join(f.home, "state", name));
      }
      // The real installation keeps its configuration and Vault; only the
      // database is rebuilt as a truthful schema-7 prefix.
      const older = new DatabaseSync(f.database);
      older.exec("PRAGMA journal_mode = WAL");
      migrate(older as never, MIGRATIONS.slice(0, 7));
      older.close();
      const before = storageProof(f.home);
      const refused = inSandbox(f.home, f.work, ["inbox", "--json"]);
      expect(refused.status).toBe(78);
      expect(refused.stdout).toBe("");
      const refusal = errorEnvelopeOf(refused) as { error: { code: string; recovery?: { suggestedCommand: string } } };
      expect(refusal.error.code).toBe("STORAGE_MIGRATION_REQUIRED");
      expect(refusal.error.recovery?.suggestedCommand).toContain("sorage backup run");
      expect(storageProof(f.home)).toEqual(before);
      expect(existsSync(join(f.home, "logs", "sorage.log"))).toBe(false);
      await yieldLoop();
      const backup = sorage(["backup", "run", "--json"], { home: f.home, cwd: f.work });
      expect(backup.status, backup.stderr).toBe(0);
      await yieldLoop();
      const preflight = sorage(["preflight", "--json"], { home: f.home });
      expect(preflight.status, preflight.stderr).toBe(0);
      expect((envelopeOf(preflight) as { data: { status: string } }).data.status).toBe("compatible");
      const migrated = inSandbox(f.home, f.work, ["memo", "list", "--all-projects", "--json"]);
      expect(migrated.status, migrated.stderr).toBe(0);
      await yieldLoop();

      // A valid installation whose database is an empty version-0 file.
      const emptyHome = fixture("sorage-zero-write-emptydb-");
      await yieldLoop();
      for (const name of readdirSync(join(emptyHome.home, "state"))) {
        if (name.startsWith("sorage.sqlite3")) rmSync(join(emptyHome.home, "state", name));
      }
      writeFileSync(emptyHome.database, Buffer.alloc(0));
      const empty = inSandbox(emptyHome.home, emptyHome.work, ["inbox", "--json"]);
      expect(empty.status).toBe(78);
      expect(errorEnvelopeOf(empty).error.code).toBe("STORAGE_MIGRATION_REQUIRED");

      const missingHome = fixture("sorage-zero-write-missing-");
      await yieldLoop();
      rmSync(missingHome.database);
      const missing = inSandbox(missingHome.home, missingHome.work, ["inbox", "--json"]);
      expect(missing.status).toBe(73);
      expect(errorEnvelopeOf(missing).error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(existsSync(missingHome.database), "the read never creates the file").toBe(false);

      const newerHome = fixture("sorage-zero-write-newer-");
      await yieldLoop();
      const db = new DatabaseSync(newerHome.database);
      db.exec(`INSERT INTO schema_migrations VALUES(${knownSchemaMaximum() + 1}, 'future', '2026-01-01')`);
      db.close();
      const newer = inSandbox(newerHome.home, newerHome.work, ["project", "list", "--json"]);
      expect(newer.status).toBe(78);
      expect(errorEnvelopeOf(newer).error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");

      const absentHome = makeTempDir("sorage-zero-write-absent-home-");
      const absent = inSandbox(absentHome, absentHome, ["project", "list", "--json"]);
      expect(absent.status).toBe(78);
      expect(errorEnvelopeOf(absent).error.code).toBe("NOT_INITIALIZED");
      expect(existsSync(join(absentHome, "logs"))).toBe(false);
    },
  );
});
