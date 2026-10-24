import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { knownSchemaMaximum, listChannelMessages, recoverSend, showChannel } from "@sorage/core";

interface AppErrorLike {
  code: string;
  message: string;
  recovery?: { suggestedCommand: string };
}
import { afterEach, describe, expect, it } from "vitest";
import { createNodeChannelPorts } from "../../src/channels";
import { inspectPreflight } from "../../src/preflight";
import { openCoveredReadStorage } from "../../src/read-storage";
import { createNodeSendRecoveryPorts } from "../../src/send-recovery";
import { makeTempHome } from "../../src/testkit/temp-home";

/**
 * The TASK-119 write-protected-installation inspection contract (V3) under the
 * TASK-123 rebuilt Channel surface: a stable, readable installation whose
 * database and WAL cannot be written — with a retained send receipt and a
 * committed Channel message living only in an uncheckpointed WAL held open by
 * a live connection — still inspects coherently, because the private copies
 * are made owner-writable while the live installation is never written.
 * Preflight reports its real verdict, `send --replay-only` returns its normal
 * recovery result, the covered Channel reads (`messages`, `list`, `show`)
 * return the WAL-committed Channel message through the TASK-122 primitive
 * with nothing written, the full home inventory stays identical, an absent
 * SHM stays absent, and genuine refusals (a live fence) still refuse.
 */

const entry = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function inventory(root: string): string[] {
  const rows: string[] = [];
  const walk = (path: string) => {
    const stat = statSync(path);
    const base = `${relative(root, path)} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino}`;
    if (stat.isSymbolicLink()) rows.push(`l ${base}`);
    else if (stat.isDirectory()) {
      rows.push(`d ${base}`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else rows.push(`f ${base} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  };
  walk(root);
  return rows;
}

interface ProtectedInstallation {
  root: string;
  home: string;
  scratch: string;
  work: string;
  databasePath: string;
  installationId: string;
  sendKey: string;
  channelName: string;
  channelBody: string;
  body: string;
  sentHandoffId: string;
  postedSeq: number;
  snapshot(): string[];
  replaySend(): ReturnType<typeof recoverSend>;
  readChannelMessages(): ReturnType<typeof listChannelMessages> | { ok: false; error: AppErrorLike };
  showChannelView(): ReturnType<typeof showChannel>;
  preflight(): ReturnType<typeof inspectPreflight>;
}

/**
 * One installation whose retained send receipt and committed Channel message
 * live only in the uncheckpointed WAL: a read transaction opened before the
 * writers spawn pins the WAL mark, the database and WAL files are then made
 * read-only, and the saved modes are restored before the temporary tree is
 * removed.
 */
function protectedInstallation(shmAbsent = false, orphanFutureSchema = false): ProtectedInstallation {
  const temp = makeTempHome("sorage-write-protected-");
  cleanups.push(temp.cleanup);
  const root = realpathSync(temp.home);
  const home = join(root, "installation");
  const scratch = join(root, "scratch");
  const work = join(root, "sender");
  const recipient = join(root, "recipient");
  for (const path of [home, scratch, work, recipient]) mkdirSync(path);
  const run = (args: string[], selectedHome = home, cwd = work) => {
    const result = spawnSync("bun", [entry, ...args, "--json"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, SORAGE_HOME: selectedHome },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout).data;
  };
  run(["init", "--non-interactive"]);
  run(["project", "add", "--name", "sender", "--dir", work]);
  run(["project", "add", "--name", "recipient", "--dir", recipient]);
  const channelName = "aq-wp";
  run(["channel", "create", channelName, "--main", "orchestrator"]);
  run(["channel", "add", channelName, "worker-1", "--role", "worker"]);
  const databasePath = join(home, "state", "sorage.sqlite3");
  // A read transaction opened before the writers spawn: its snapshot pins the
  // WAL mark, so the writers' per-process close checkpoints cannot move their
  // committed frames into the main file, and the retained rows stay in the
  // uncheckpointed WAL (V3).
  const holder = new DatabaseSync(databasePath);
  holder.exec("BEGIN");
  holder.prepare("SELECT COUNT(*) AS n FROM projects").get();
  cleanups.push(() => holder.close());
  const body = "# Original\n";
  const sendKey = `send-key-${randomUUID()}`;
  const sent = run([
    "send",
    "--to",
    "recipient",
    "--title",
    "Original",
    "--body",
    body,
    "--idempotency-key",
    sendKey,
  ]) as { handoffs: Array<{ handoffId: string }> };
  const channelBody = "channel committed body";
  const posted = run([
    "channel",
    "post",
    channelName,
    "--from",
    "worker-1",
    "--kind",
    "report",
    "--body",
    channelBody,
  ]) as { message: { seq: number } };
  // Both retained rows are committed in the WAL and absent from the main file.
  const verifier = new DatabaseSync(databasePath);
  try {
    const receipts = verifier.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?").get(sendKey) as {
      n: number;
    };
    expect(receipts.n).toBe(1);
    const messages = verifier.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number };
    expect(messages.n).toBe(1);
  } finally {
    verifier.close();
  }
  const mainOnly = join(scratch, "main-only.sqlite3");
  copyFileSync(databasePath, mainOnly);
  const bare = new DatabaseSync(mainOnly, { readOnly: true });
  try {
    const mainOnlyReceipts = bare.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?").get(sendKey) as {
      n: number;
    };
    expect(mainOnlyReceipts.n).toBe(0);
    const mainOnlyMessages = bare.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number };
    expect(mainOnlyMessages.n).toBe(0);
  } finally {
    bare.close();
    rmSync(mainOnly, { force: true });
  }
  const installationId = run(["config", "show"]).installationId as string;
  if (orphanFutureSchema) {
    // A newer schema row committed only into the uncheckpointed WAL (K1): the
    // pinning read snapshot predates it, so no close checkpoint can move it
    // into the main file, and the verdict-deciding schema state lives only in
    // the WAL.
    const orphan = new DatabaseSync(databasePath);
    try {
      orphan
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(knownSchemaMaximum() + 1, "future", "2026-01-01T00:00:00.000Z");
    } finally {
      orphan.close();
    }
    const seen = new DatabaseSync(databasePath);
    try {
      expect(seen.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()).toMatchObject({
        n: knownSchemaMaximum() + 1,
      });
    } finally {
      seen.close();
    }
    const orphanMainOnly = join(scratch, "orphan-main-only.sqlite3");
    copyFileSync(databasePath, orphanMainOnly);
    const mainProbe = new DatabaseSync(orphanMainOnly, { readOnly: true });
    try {
      expect(mainProbe.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()).toMatchObject({
        n: knownSchemaMaximum(),
      });
      const mainOnlyMessages = mainProbe.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number };
      expect(mainOnlyMessages.n).toBe(0);
    } finally {
      mainProbe.close();
      rmSync(orphanMainOnly, { force: true });
    }
  }
  if (shmAbsent) {
    rmSync(join(home, "state", `${"sorage.sqlite3"}-shm`), { force: true });
  }
  const savedModes = new Map<string, number>();
  for (const path of [databasePath, `${databasePath}-wal`]) {
    const mode = statSync(path).mode & 0o777;
    savedModes.set(path, mode);
    chmodSync(path, 0o444);
  }
  cleanups.push(() => {
    for (const [path, mode] of savedModes) chmodSync(path, mode);
  });
  const clock = { now: () => new Date() };
  const coveredMessages = () => {
    const storage = openCoveredReadStorage({
      surface: "channel",
      vaultAdmission: true,
      env: { SORAGE_HOME: home },
      userHome: root,
    });
    if (!storage.ok)
      return storage as unknown as {
        ok: false;
        error: { code: string; message: string; recovery?: { suggestedCommand: string } };
      };
    const ports = createNodeChannelPorts({ database: storage.value.db, env: { SORAGE_HOME: home }, userHome: root });
    try {
      return listChannelMessages(ports, { channelRef: channelName });
    } finally {
      ports.close();
      storage.value.close();
    }
  };
  return {
    root,
    home,
    scratch,
    work,
    databasePath,
    installationId,
    sendKey,
    channelName,
    channelBody,
    body,
    sentHandoffId: sent.handoffs[0]?.handoffId ?? "",
    postedSeq: posted.message.seq,
    snapshot: () => inventory(home),
    replaySend: () =>
      recoverSend(
        createNodeSendRecoveryPorts({
          env: { SORAGE_HOME: home },
          userHome: root,
          clock,
          inspection: { scratchParent: scratch },
        }),
        {
          to: ["recipient"],
          title: "Original",
          body,
          idempotencyKey: sendKey,
          allowExternalSource: false,
          allowUnregistered: false,
          path: work,
          userHome: root,
        },
      ),
    readChannelMessages: coveredMessages,
    showChannelView: () => {
      const storage = openCoveredReadStorage({
        surface: "channel",
        vaultAdmission: true,
        env: { SORAGE_HOME: home },
        userHome: root,
      });
      if (!storage.ok) return { ok: false, error: storage.error } as const;
      const ports = createNodeChannelPorts({ database: storage.value.db, env: { SORAGE_HOME: home }, userHome: root });
      try {
        return showChannel(ports, { channelRef: channelName });
      } finally {
        ports.close();
        storage.value.close();
      }
    },
    preflight: () => inspectPreflight(home, { scratchParent: scratch, userHome: root }),
  };
}

describe("the shared private-copy inspection on a write-protected installation (TASK-119, V3)", () => {
  it("preflight reports its real verdict from the uncheckpointed WAL with the installation untouched", () => {
    const f = protectedInstallation();
    const before = f.snapshot();
    const report = f.preflight();
    expect(report.status).toBe("compatible");
    expect(f.snapshot()).toEqual(before);
  });

  it("decides preflight's verdict from the uncheckpointed WAL, not the main file (K1, V3)", () => {
    const f = protectedInstallation(false, true);
    expect(statSync(`${f.databasePath}-wal`).size).toBeGreaterThan(0);
    const mainOnlyHome = join(f.root, "main-only-home");
    cpSync(f.home, mainOnlyHome, { recursive: true });
    rmSync(join(mainOnlyHome, "state", "sorage.sqlite3-wal"), { force: true });
    rmSync(join(mainOnlyHome, "state", "sorage.sqlite3-shm"), { force: true });
    const mainOnlyReport = inspectPreflight(mainOnlyHome, { scratchParent: f.scratch, userHome: f.root });
    expect(mainOnlyReport.status).toBe("compatible");
    const before = f.snapshot();
    expect(f.preflight().status).toBe("unsupported");
    expect(f.snapshot()).toEqual(before);
  });

  it("send --replay-only returns the retained receipt from the uncheckpointed WAL with the installation untouched", () => {
    const f = protectedInstallation();
    const before = f.snapshot();
    const result = f.replaySend();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.handoffs[0]?.handoffId).toBe(f.sentHandoffId);
    expect(f.snapshot()).toEqual(before);
  });

  it("covered Channel reads return the WAL-committed message with the installation untouched", () => {
    const f = protectedInstallation();
    const before = f.snapshot();
    const page = f.readChannelMessages();
    expect(page.ok, JSON.stringify(page)).toBe(true);
    if (page.ok) {
      expect(page.value.items.map((item) => [item.seq, item.from, item.body])).toEqual([
        [f.postedSeq, "worker-1", f.channelBody],
      ]);
    }
    const view = f.showChannelView();
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.value.channel.unhandledCount).toBe(1);
    expect(f.snapshot()).toEqual(before);
  });

  it("keeps the absent SHM absent: preflight still inspects, and the covered Channel read refuses the sidecar gap (38.11)", () => {
    const f = protectedInstallation(true);
    const shm = `${f.databasePath}-shm`;
    expect(statSync(`${f.databasePath}-wal`).size).toBeGreaterThan(0);
    const before = f.snapshot();
    // The owner-writable private copy still serves preflight.
    expect(f.preflight().status).toBe("compatible");
    // A WAL longer than its header without its -shm selects no zero-write
    // path: the covered Channel read refuses with the surface's typed
    // open-contention refusal, creating no sidecar and writing nothing.
    const page = f.readChannelMessages();
    expect(page.ok).toBe(false);
    if (!page.ok) {
      expect(page.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(page.error.message).toContain("Channel storage is contended");
    }
    const replay = f.replaySend();
    expect(replay.ok).toBe(true);
    expect(f.snapshot()).toEqual(before);
    expect(statSync(shm, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("still refuses a live fence on the write-protected installation", () => {
    const f = protectedInstallation();
    const lock = join(f.home, "run", "vault-move.lock");
    const lockBody = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" });
    writeFileSync(lock, lockBody);
    const before = f.snapshot();
    expect(f.preflight().status).toBe("unverifiable");
    expect(f.snapshot()).toEqual(before);
    expect(readFileSync(lock, "utf8")).toBe(lockBody);
  });
});
