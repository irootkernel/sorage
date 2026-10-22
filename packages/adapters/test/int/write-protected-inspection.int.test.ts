import { DatabaseSync } from "node:sqlite";
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
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { knownSchemaMaximum, recoverSend, submitMessageReplayOnly } from "@sorage/core";
import { inspectPreflight } from "../../src/preflight";
import { createNodeSendRecoveryPorts } from "../../src/send-recovery";
import { createNodeChannelRecoveryPorts } from "../../src/channels";
import { makeTempHome } from "../../src/testkit/temp-home";

/**
 * The TASK-119 write-protected-installation inspection contract (V3): a
 * stable, readable installation whose database and WAL cannot be written —
 * with the retained receipts living only in an uncheckpointed WAL held open
 * by a live connection — still inspects coherently, because the private
 * copies are made owner-writable while the live installation is never
 * written. Preflight reports its real verdict, both replay-only modes return
 * their normal recovery results, the full home inventory (main bytes, WAL
 * bytes, SHM presence and bytes, modes, mtimes, every other file including
 * the Vault) stays identical, an absent SHM stays absent, and genuine
 * refusals (a live fence) still refuse.
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
  channelKey: string;
  channelBody: string;
  body: string;
  sentHandoffId: string;
  submittedMessageId: string;
  channelId: string;
  mainParticipantId: string;
  snapshot(): string[];
  replaySend(): ReturnType<typeof recoverSend>;
  replayChannel(): ReturnType<typeof submitMessageReplayOnly>;
  preflight(): ReturnType<typeof inspectPreflight>;
}

/**
 * One installation whose retained send and Channel receipts are committed
 * only into the uncheckpointed WAL: a live connection holds the WAL open
 * across the spawning CLI writers, the database and WAL files are then made
 * read-only, and the saved modes are restored before the temporary tree is
 * removed. The holder connection keeps its writable SHM, exactly like a
 * concurrent reader on a write-protected installation.
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
  const created = run(["channel", "create", "--main-handle", "orchestrator", "--as-user"]) as {
    channel: { id: string; mainParticipantId: string };
  };
  const databasePath = join(home, "state", "sorage.sqlite3");
  // A read transaction opened before the keyed writers spawn: its snapshot
  // pins the WAL mark, so the writers' per-process close checkpoints cannot
  // move their committed frames into the main file, and both receipts stay in
  // the uncheckpointed WAL (V3).
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
  const channelBody = "channel receipt body";
  const channelKey = `channel-key-${randomUUID()}`;
  const submitted = run([
    "channel",
    "submit",
    created.channel.id,
    "--as-participant",
    created.channel.mainParticipantId,
    "--kind",
    "report",
    "--body",
    channelBody,
    "--idempotency-key",
    channelKey,
  ]) as { message: { id: string } };
  // Both receipts are committed in the WAL and absent from the main file; the
  // verifier is a fresh connection because the pinning holder's snapshot
  // predates the writes it must not observe.
  const verifier = new DatabaseSync(databasePath);
  try {
    const receipts = verifier
      .prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key IN (?, ?)")
      .get(sendKey, channelKey) as { n: number };
    expect(receipts.n).toBe(2);
  } finally {
    verifier.close();
  }
  const mainOnly = join(scratch, "main-only.sqlite3");
  copyFileSync(databasePath, mainOnly);
  const bare = new DatabaseSync(mainOnly, { readOnly: true });
  try {
    const mainOnlyReceipts = bare
      .prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key IN (?, ?)")
      .get(sendKey, channelKey) as { n: number };
    expect(mainOnlyReceipts.n).toBe(0);
  } finally {
    bare.close();
    rmSync(mainOnly, { force: true });
  }
  const installationId = run(["config", "show"]).installationId as string;
  if (orphanFutureSchema) {
    // A newer schema row committed only into the uncheckpointed WAL (K1): the
    // pinning read snapshot predates it, so no close checkpoint can move it
    // into the main file, and the verdict-deciding schema state lives only in
    // the WAL. Inserted after `config show`, whose operational open would
    // refuse the newer history.
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
      const mainOnlyReceipts = mainProbe
        .prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key IN (?, ?)")
        .get(sendKey, channelKey) as { n: number };
      expect(mainOnlyReceipts.n).toBe(0);
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
  return {
    root,
    home,
    scratch,
    work,
    databasePath,
    installationId,
    sendKey,
    channelKey,
    channelBody,
    body,
    sentHandoffId: sent.handoffs[0]?.handoffId ?? "",
    submittedMessageId: submitted.message.id,
    channelId: created.channel.id,
    mainParticipantId: created.channel.mainParticipantId,
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
    replayChannel: () =>
      submitMessageReplayOnly(
        createNodeChannelRecoveryPorts({
          env: { SORAGE_HOME: home },
          userHome: root,
          inspection: { scratchParent: scratch },
        }),
        {
          installationId,
          maxBytes: 1024 * 1024 * 100,
          channelId: created.channel.id,
          senderParticipantId: created.channel.mainParticipantId,
          kind: "report",
          accepted: {
            kind: "text",
            text: channelBody,
            sizeBytes: Buffer.byteLength(channelBody, "utf8"),
            sha256: createHash("sha256").update(channelBody, "utf8").digest("hex"),
          },
          idempotencyKey: channelKey,
        },
      ),
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
    // The verdict-deciding schema state — a newer migration row — is committed
    // only into the WAL, so a main-only observation of the same installation
    // answers a different verdict than the WAL-inclusive live inspection.
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

  it("channel submit --replay-only returns the retained message from the uncheckpointed WAL with the installation untouched", () => {
    const f = protectedInstallation();
    const before = f.snapshot();
    const result = f.replayChannel();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.message.id).toBe(f.submittedMessageId);
    expect(f.snapshot()).toEqual(before);
  });

  it("inspects normally when the SHM file is absent, and the absent SHM stays absent", () => {
    const f = protectedInstallation(true);
    const shm = `${f.databasePath}-shm`;
    expect(statSync(`${f.databasePath}-wal`).size).toBeGreaterThan(0);
    const before = f.snapshot();
    expect(f.preflight().status).toBe("compatible");
    const replay = f.replayChannel();
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.message.id).toBe(f.submittedMessageId);
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
    const replay = f.replayChannel();
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("SERVICE_PAUSED");
    expect(f.snapshot()).toEqual(before);
    expect(readFileSync(lock, "utf8")).toBe(lockBody);
  });
});
