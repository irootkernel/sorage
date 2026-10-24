import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ackMessages,
  addParticipant,
  backupRestore,
  backupVerify,
  canonicalJson,
  canonicalJsonLine,
  closeChannel,
  createChannel,
  exportSnapshot,
  initializeInstallation,
  listChannelMessages,
  postMessage,
  removeParticipant,
  showChannel,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { captureChannelBodyText, createNodeChannelPorts, type NodeChannelPorts } from "../../src/channels";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";
import { unwrap } from "../fixtures/memo-installation";

/**
 * The TASK-123 rebuilt format-3 Channel snapshot round trip on real SQLite, a
 * real Vault, and the real backup ports (CHN-009, section 38.8): names,
 * participant handles with their removal state, per-Channel sequence numbers,
 * and handled state survive export → verify → restore into a fresh
 * installation; a file-backed body carries as exact raw bytes digested in the
 * manifest; an unmaterialized current body refuses the export closed; and a
 * development snapshot carrying an old Channel shard key set or an old
 * Channel event name fails closed validation with `VAULT_INTEGRITY_ERROR`
 * rather than being converted.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  delete process.env.SORAGE_HOME;
});

const CHANNEL_TIME = "2026-10-24T00:00:00.000Z";
const FILE_BODY = `file-backed ${"x".repeat(70_000)}body\r\n`;

interface Installation {
  home: string;
  vault: string;
}

function installation(prefix: string): Installation {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  process.env.SORAGE_HOME = home;
  unwrap(
    initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
      { vaultPath: join(home, "vault") },
    ),
  );
  return { home, vault: join(home, "vault") };
}

function channelPorts(value: Installation): NodeChannelPorts {
  const created = createNodeChannelPorts({
    env: { SORAGE_HOME: value.home },
    userHome: value.home,
    clock: new FakeClock(Date.parse(CHANNEL_TIME)),
  });
  cleanups.push(() => created.close());
  return created;
}

function accepted(instance: NodeChannelPorts, text: string) {
  return unwrap(
    captureChannelBodyText(text, {
      maxBytes: instance.maxBytes,
      stateDir: instance.stateDir,
      spoolId: randomUUID(),
    }),
  );
}

function step(instance: NodeChannelPorts, seconds: number): void {
  (instance.clock as FakeClock).advance(seconds * 1000);
}

function backupPorts(value: Installation, source?: Installation) {
  return createNodeBackupCommandPorts({
    env: { SORAGE_HOME: value.home },
    userHome: value.home,
    sourcePath: source?.vault,
  });
}

/** One Channel whose history exercises every rebuilt record shape. */
function seedChannel(value: Installation): void {
  const instance = channelPorts(value);
  step(instance, 1);
  unwrap(createChannel(instance, { name: "aq-run-42", title: "Round trip", main: "orchestrator" }));
  step(instance, 1);
  unwrap(addParticipant(instance, { channelRef: "aq-run-42", handle: "worker-1", role: "worker" }));
  step(instance, 1);
  unwrap(addParticipant(instance, { channelRef: "aq-run-42", handle: "judge-1", role: "judge" }));
  step(instance, 1);
  unwrap(
    postMessage(instance, {
      channelRef: "aq-run-42",
      from: "worker-1",
      kind: "report",
      ref: "pr-42",
      accepted: accepted(instance, "inline report"),
    }),
  );
  step(instance, 1);
  unwrap(
    postMessage(instance, {
      channelRef: "aq-run-42",
      from: "worker-1",
      kind: "relay_request",
      to: "judge-1",
      accepted: accepted(instance, "please relay"),
    }),
  );
  step(instance, 1);
  unwrap(
    postMessage(instance, {
      channelRef: "aq-run-42",
      from: "judge-1",
      kind: "question",
      accepted: accepted(instance, FILE_BODY),
    }),
  );
  step(instance, 1);
  unwrap(ackMessages(instance, { channelRef: "aq-run-42", seqs: [1], note: "reviewed" }));
  step(instance, 1);
  unwrap(removeParticipant(instance, { channelRef: "aq-run-42", handle: "judge-1" }));
  step(instance, 1);
  unwrap(closeChannel(instance, { channelRef: "aq-run-42" }));
}

describe("the rebuilt Channel snapshot round trip", () => {
  it("preserves names, handles, sequence numbers, and handled state through export, verify, and restore", () => {
    const source = installation("sorage-channelsnap-source-");
    seedChannel(source);
    unwrap(exportSnapshot(unwrap(backupPorts(source).exportPorts())));
    expect(backupVerify(unwrap(backupPorts(source).verifyPorts()), { now: new Date() })).toMatchObject({ ok: true });

    const seededId = unwrap(showChannel(channelPorts(source), { channelRef: "aq-run-42" })).channel.id;
    const shardPath = join(source.vault, "snapshots", "channels", seededId.slice(0, 2), `${seededId}.json`);
    expect(existsSync(shardPath)).toBe(true);
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as {
      id: string;
      name: string;
      title: string | null;
      state: string;
      main: string;
      closedAt: string | null;
      participants: Array<{ handle: string; role: string; addedAt: string; removedAt: string | null }>;
      messages: Array<{
        seq: number;
        senderHandle: string;
        kind: string;
        toHandle: string | null;
        ref: string | null;
        handled: boolean;
        handledAt: string | null;
        handleNote: string | null;
        bodyContent: Record<string, unknown>;
      }>;
    };
    expect(shard.name).toBe("aq-run-42");
    expect(shard.title).toBe("Round trip");
    expect(shard.state).toBe("closed");
    expect(shard.main).toBe("orchestrator");
    expect(shard.participants.find((participant) => participant.handle === "worker-1")?.removedAt).toBeNull();
    expect(shard.participants.find((participant) => participant.handle === "judge-1")?.removedAt).not.toBeNull();
    expect(shard.messages.map((message) => [message.seq, message.kind, message.toHandle, message.handled])).toEqual([
      [1, "report", null, true],
      [2, "relay_request", "judge-1", false],
      [3, "question", null, false],
    ]);
    expect(shard.messages[0]?.ref).toBe("pr-42");
    expect(shard.messages[0]?.handleNote).toBe("reviewed");
    expect(shard.messages[0]?.bodyContent).toEqual({ inline: "inline report" });
    expect(shard.messages[2]?.bodyContent).toMatchObject({ sizeBytes: Buffer.byteLength(FILE_BODY, "utf8") });

    const target = installation("sorage-channelsnap-target-");
    const restored = backupRestore(unwrap(backupPorts(target, source).restorePorts()), { dryRun: false });
    expect(restored.ok, JSON.stringify(restored)).toBe(true);

    const view = unwrap(showChannel(channelPorts(target), { channelRef: "aq-run-42" })).channel;
    expect(view.title).toBe("Round trip");
    expect(view.state).toBe("closed");
    expect(view.main).toBe("orchestrator");
    expect(view.messageCount).toBe(3);
    expect(view.unhandledCount).toBe(2);
    const handles = view.participants.map((participant) => [participant.handle, participant.removedAt === null]);
    expect(handles).toContainEqual(["orchestrator", true]);
    expect(handles).toContainEqual(["worker-1", true]);
    expect(handles).toContainEqual(["judge-1", false]);
    const messages = unwrap(listChannelMessages(channelPorts(target), { channelRef: "aq-run-42", all: true })).items;
    expect(messages.map((message) => [message.seq, message.kind, message.from, message.to, message.handled])).toEqual([
      [1, "report", "worker-1", null, true],
      [2, "relay_request", "worker-1", "judge-1", false],
      [3, "question", "judge-1", null, false],
    ]);
    expect(messages[0]?.handleNote).toBe("reviewed");
    expect(messages[2]?.body).toBe(FILE_BODY);
    expect(messages[2]?.bodyPath).not.toBeNull();
    // Acks keep working on the restored home and the sequence stays dense.
    const acked = unwrap(ackMessages(channelPorts(target), { channelRef: "aq-run-42", seqs: [2] }));
    expect(acked.handled).toEqual([2]);
    expect(acked.alreadyHandled).toEqual([]);
  });

  it("refuses the export when a current file-backed body is unmaterialized", () => {
    const source = installation("sorage-channelsnap-pending-");
    const instance = channelPorts(source);
    unwrap(createChannel(instance, { name: "pending" }));
    unwrap(addParticipant(instance, { channelRef: "pending", handle: "w1", role: "worker" }));
    unwrap(
      postMessage(instance, {
        channelRef: "pending",
        from: "w1",
        kind: "report",
        accepted: accepted(instance, FILE_BODY),
      }),
    );
    // Leave the committed body unmaterialized with no pending intent, exactly
    // the state an interrupted activation can leave behind.
    const db = openSorageDatabase(join(source.home, "state", "sorage.sqlite3"));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE content_records SET materialized = 0 WHERE inline_text IS NULL").run();
      db.prepare("DELETE FROM pending_fs_ops").run();
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const exported = exportSnapshot(unwrap(backupPorts(source).exportPorts()));
    expect(exported.ok).toBe(false);
    if (!exported.ok) {
      expect(exported.error.code).toBe("CONTENT_MATERIALIZING");
      expect(exported.error.message).toContain("waiting for its committed activation");
    }
  });

  it("refuses a development snapshot carrying an old Channel shard key set with VAULT_INTEGRITY_ERROR", () => {
    const source = installation("sorage-channelsnap-oldshard-");
    const instance = channelPorts(source);
    unwrap(createChannel(instance, { name: "legacy" }));
    unwrap(exportSnapshot(unwrap(backupPorts(source).exportPorts())));
    const seededId = unwrap(showChannel(channelPorts(source), { channelRef: "legacy" })).channel.id;
    const shardPath = join(source.vault, "snapshots", "channels", seededId.slice(0, 2), `${seededId}.json`);
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
    // The TASK-109 shard shape: creator provenance, participant UUIDs, and an
    // assignment roster, with the rebuilt keys absent.
    const legacy: Record<string, unknown> = {
      id: shard.id,
      title: shard.title,
      state: shard.state,
      creatorKind: "user",
      creatorId: null,
      createdAt: shard.createdAt,
      closedAt: shard.closedAt,
      closedByParticipantId: null,
      closedByKind: null,
      participants: (shard.participants as Array<Record<string, unknown>>).map((participant) => ({
        id: randomUUID(),
        role: participant.role,
        handle: participant.handle,
        nativeProvenance: [],
        active: participant.removedAt === null,
        registeredAt: participant.addedAt,
        deactivatedAt: participant.removedAt,
      })),
      assignments: [],
      messages: (shard.messages as Array<Record<string, unknown>>).map((message) => ({
        id: randomUUID(),
        senderParticipantId: randomUUID(),
        kind: message.kind,
        bodyContent: message.bodyContent,
        assignmentId: null,
        assignmentLate: false,
        relayToParticipantId: null,
        contextSession: null,
        contextNode: null,
        contextAttempt: null,
        handled: message.handled,
        handledAt: message.handledAt,
        handledByParticipantId: null,
        handledByKind: null,
        handleNote: message.handleNote,
        createdAt: message.createdAt,
      })),
    };
    writeFileSync(shardPath, `${canonicalJson(legacy)}\n`);

    const verify = backupVerify(unwrap(backupPorts(source).verifyPorts()), { now: new Date() });
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });

  it("refuses a development snapshot carrying an old Channel event name with VAULT_INTEGRITY_ERROR", () => {
    const source = installation("sorage-channelsnap-oldevent-");
    const instance = channelPorts(source);
    unwrap(createChannel(instance, { name: "legacy" }));
    unwrap(addParticipant(instance, { channelRef: "legacy", handle: "w1", role: "worker" }));
    unwrap(exportSnapshot(unwrap(backupPorts(source).exportPorts())));
    const eventsPath = join(source.vault, "snapshots", "events.jsonl");
    const lines = readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const renamed = lines.map((line) => {
      const parsed = JSON.parse(line) as { eventType: string; metadata?: Record<string, unknown> };
      return parsed.eventType === "CHANNEL_PARTICIPANT_ADDED"
        ? canonicalJsonLine({
            ...parsed,
            eventType: "CHANNEL_PARTICIPANT_REGISTERED",
            metadata: { ...(parsed.metadata ?? {}), participantId: randomUUID() },
          })
        : line;
    });
    writeFileSync(eventsPath, `${renamed.join("\n")}\n`);

    const verify = backupVerify(unwrap(backupPorts(source).verifyPorts()), { now: new Date() });
    expect(verify.ok).toBe(false);
    if (!verify.ok) {
      // The closed validation refuses the snapshot before import: the old
      // event name is either the allowlist's unknown type or the
      // reconciliation's missing-addition finding, never a conversion.
      expect(verify.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(verify.error.message).toMatch(/does not define|no addition event/);
    }
  });

  it("round-trips a roster mixing BMP private-use and supplementary-plane handles in code-point order (decision item 6)", () => {
    const source = installation("sorage-channelsnap-codepoint-");
    const instance = channelPorts(source);
    const e000 = "\uE000worker";
    const u10000 = "\u{10000}worker";
    unwrap(createChannel(instance, { name: "mixed" }));
    unwrap(addParticipant(instance, { channelRef: "mixed", handle: u10000, role: "worker" }));
    unwrap(addParticipant(instance, { channelRef: "mixed", handle: e000, role: "worker" }));
    unwrap(
      postMessage(instance, {
        channelRef: "mixed",
        from: e000,
        kind: "report",
        accepted: accepted(instance, "bpm body"),
      }),
    );
    unwrap(
      postMessage(instance, {
        channelRef: "mixed",
        from: u10000,
        kind: "report",
        accepted: accepted(instance, "supplementary body"),
      }),
    );
    unwrap(exportSnapshot(unwrap(backupPorts(source).exportPorts())));
    expect(backupVerify(unwrap(backupPorts(source).verifyPorts()), { now: new Date() })).toMatchObject({ ok: true });
    const channelId = unwrap(showChannel(channelPorts(source), { channelRef: "mixed" })).channel.id;
    const shardPath = join(source.vault, "snapshots", "channels", channelId.slice(0, 2), `${channelId}.json`);
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as {
      participants: Array<{ handle: string }>;
    };
    // Code-point order: U+E000 sorts before U+10000; UTF-16 units would not.
    expect(shard.participants.map((participant) => participant.handle)).toEqual(["main", e000, u10000]);
    const target = installation("sorage-channelsnap-codepoint-target-");
    const restored = backupRestore(unwrap(backupPorts(target, source).restorePorts()), { dryRun: false });
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    const view = unwrap(showChannel(channelPorts(target), { channelRef: "mixed" })).channel;
    expect(view.participants.map((participant) => participant.handle)).toEqual(["main", e000, u10000]);
    expect(view.messageCount).toBe(2);
  });

  it("refuses a duplicate Channel name across shards with VAULT_INTEGRITY_ERROR at verify and restore (decision item 17)", () => {
    const source = installation("sorage-channelsnap-dupname-");
    const instance = channelPorts(source);
    unwrap(createChannel(instance, { name: "aq-dup" }));
    unwrap(exportSnapshot(unwrap(backupPorts(source).exportPorts())));
    const channelId = unwrap(showChannel(channelPorts(source), { channelRef: "aq-dup" })).channel.id;
    // Clone the shard under a fresh id but the SAME name; the manifest count
    // and content inventory stay coherent so only the name rule refuses.
    const shardPath = join(source.vault, "snapshots", "channels", channelId.slice(0, 2), `${channelId}.json`);
    const cloneId = "10000000-0000-4000-8000-000000000009";
    // Clone the canonical bytes with only the id substituted, so the clone is
    // itself canonical; the id also appears nowhere else in the shard.
    const shardBytes = readFileSync(shardPath, "utf8");
    const cloneBytes = [...shardBytes.split(channelId)].join(cloneId);
    const cloneDir = join(source.vault, "snapshots", "channels", cloneId.slice(0, 2));
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(join(cloneDir, `${cloneId}.json`), cloneBytes);
    const manifestPath = join(source.vault, "snapshots", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { counts: { channels: number } };
    manifest.counts.channels = 2;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const verify = backupVerify(unwrap(backupPorts(source).verifyPorts()), { now: new Date() });
    expect(verify.ok).toBe(false);
    if (!verify.ok) {
      expect(verify.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(verify.error.message).toContain("repeats a Channel name");
    }
    const target = installation("sorage-channelsnap-dupname-target-");
    const restored = backupRestore(unwrap(backupPorts(target, source).restorePorts()), { dryRun: false });
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(restored.error.message).toContain("repeats a Channel name");
    }
  });

  it("carries the file-backed body's digest in the manifest's content inventory", () => {
    const source = installation("sorage-channelsnap-digest-");
    const instance = channelPorts(source);
    unwrap(createChannel(instance, { name: "digest" }));
    unwrap(addParticipant(instance, { channelRef: "digest", handle: "w1", role: "worker" }));
    unwrap(
      postMessage(instance, {
        channelRef: "digest",
        from: "w1",
        kind: "report",
        accepted: accepted(instance, FILE_BODY),
      }),
    );
    unwrap(exportSnapshot(unwrap(backupPorts(source).exportPorts())));
    const manifest = JSON.parse(readFileSync(join(source.vault, "snapshots", "manifest.json"), "utf8")) as {
      counts: { channels: number };
      contentDigests: Record<string, string>;
    };
    expect(manifest.counts.channels).toBe(1);
    const keys = Object.keys(manifest.contentDigests);
    expect(keys).toHaveLength(1);
    const key = keys[0] as string;
    expect(key.startsWith("content/channel/")).toBe(true);
    const carried = readFileSync(join(source.vault, "snapshots", key));
    expect(carried.equals(Buffer.from(FILE_BODY, "utf8"))).toBe(true);
    expect(manifest.contentDigests[key]).toBe(createHash("sha256").update(carried).digest("hex"));
  });
});
