import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addAssignment,
  addParticipant,
  backupRestore,
  backupVerify,
  canonicalJson,
  canonicalJsonLine,
  closeAssignment,
  closeChannel,
  createChannel,
  deactivateParticipant,
  exportSnapshot,
  handleChannelMessage,
  projectActor,
  readChannelMessage,
  showChannel,
  submitMessage,
  type ChannelActorAssertion,
} from "@sorage/core";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { captureChannelBodyText, createNodeChannelPorts, type NodeChannelPorts } from "../../src/channels";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";
import { memoInstallation, unwrap } from "../fixtures/memo-installation";

// Real SQLite and filesystem on isolated temporary SORAGE_HOME installations;
// the Channel history is seeded through the real runtime mutations, never raw
// rows, and the export/verify/restore surface under test is the production
// backup command ports (CHN-009, SHR-010, section 38.8).

type Installation = ReturnType<typeof memoInstallation>;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const CHANNEL_TIME = "2026-10-20T00:00:00.000Z";
const CREATOR = projectActor("11111111-2222-4333-8444-555555555555");
const MAIN_HANDLE = "\uFEFF orchestrator ";
const WORKER_HANDLE = " worker ";
const WORKER_NATIVE = ["", "\t", "nul\u0000"];
const RELAY_BODY = "relay: please proceed";
const INLINE_BODY = "done\uFEFF report body";
const BEYOND_HEAD_BODY = `\uFEFF${" ".repeat(70_000)}tail content\r\nno-final-LF`;
const HANDLE_NOTE = "handled\uFEFF";

function installation(): Installation {
  const value = memoInstallation();
  cleanups.push(value.cleanup);
  return value;
}

function ports(value: Installation, source?: Installation) {
  return createNodeBackupCommandPorts({
    env: { SORAGE_HOME: value.home },
    userHome: value.home,
    sourcePath: source?.vault,
  });
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

function accepted(portsInstance: NodeChannelPorts, text: string) {
  return unwrap(
    captureChannelBodyText(text, {
      maxBytes: portsInstance.maxBytes,
      stateDir: portsInstance.stateDir,
      spoolId: randomUUID(),
    }),
  );
}

function step(instance: NodeChannelPorts, seconds: number): void {
  (instance.clock as FakeClock).advance(seconds * 1000);
}

function channelTime(seconds: number): string {
  return new Date(Date.parse(CHANNEL_TIME) + seconds * 1000).toISOString();
}

interface SeededChannel {
  channelId: string;
  mainId: string;
  workerId: string;
  judgeId: string;
  assignmentOpenId: string;
  assignmentClosedId: string;
  relayMessageId: string;
  handledMessageId: string;
  fileMessageId: string;
}

function seedSnapshotChannel(instance: NodeChannelPorts): SeededChannel {
  const asMain = (participantId: string): ChannelActorAssertion => ({ actor: CREATOR, asParticipant: participantId });
  step(instance, 1);
  const created = unwrap(
    createChannel(instance, { creator: CREATOR, mainHandle: MAIN_HANDLE, title: "Snapshot roundtrip" }),
  );
  const channelId = created.channel.id;
  const mainId = created.channel.mainParticipantId;
  step(instance, 1);
  const worker = unwrap(
    addParticipant(instance, {
      channelId,
      assertion: asMain(mainId),
      role: "worker",
      handle: WORKER_HANDLE,
      nativeProvenance: WORKER_NATIVE,
    }),
  );
  step(instance, 1);
  const judge = unwrap(
    addParticipant(instance, { channelId, assertion: asMain(mainId), role: "judge", handle: "judge" }),
  );
  step(instance, 1);
  const assignmentOpen = unwrap(
    addAssignment(instance, { channelId, assertion: asMain(mainId), participantId: worker.id, label: "Do B2" }),
  );
  step(instance, 1);
  const assignmentClosed = unwrap(addAssignment(instance, { channelId, assertion: asMain(mainId), label: "Review" }));
  step(instance, 1);
  unwrap(closeAssignment(instance, { channelId, assignmentId: assignmentClosed.id, assertion: asMain(mainId) }));
  const relayInput = accepted(instance, RELAY_BODY);
  const inlineInput = accepted(instance, INLINE_BODY);
  const fileInput = accepted(instance, BEYOND_HEAD_BODY);
  try {
    step(instance, 1);
    const relay = unwrap(
      submitMessage(instance, {
        channelId,
        senderParticipantId: worker.id,
        kind: "relay_request",
        accepted: relayInput,
        actor: CREATOR,
        assignmentId: assignmentOpen.id,
        relayToParticipantId: judge.id,
        contextSession: "",
        contextNode: "node\twith\ttabs",
        contextAttempt: "attempt\u0000nul",
      }),
    );
    step(instance, 1);
    const handled = unwrap(
      submitMessage(instance, {
        channelId,
        senderParticipantId: mainId,
        kind: "report",
        accepted: inlineInput,
        actor: CREATOR,
        assignmentId: assignmentClosed.id,
      }),
    );
    step(instance, 1);
    unwrap(
      handleChannelMessage(instance, {
        channelId,
        messageId: handled.message.id,
        assertion: asMain(mainId),
        expectedRowVersion: 1,
        note: HANDLE_NOTE,
      }),
    );
    step(instance, 1);
    const fileMessage = unwrap(
      submitMessage(instance, {
        channelId,
        senderParticipantId: mainId,
        kind: "question",
        accepted: fileInput,
        actor: CREATOR,
      }),
    );
    step(instance, 1);
    unwrap(
      handleChannelMessage(instance, {
        channelId,
        messageId: fileMessage.message.id,
        assertion: { actor: { kind: "user", id: null }, asUser: true },
        expectedRowVersion: 1,
      }),
    );
    step(instance, 1);
    unwrap(deactivateParticipant(instance, { channelId, participantId: judge.id, assertion: asMain(mainId) }));
    step(instance, 1);
    unwrap(closeChannel(instance, { channelId, assertion: asMain(mainId) }));
    return {
      channelId,
      mainId,
      workerId: worker.id,
      judgeId: judge.id,
      assignmentOpenId: assignmentOpen.id,
      assignmentClosedId: assignmentClosed.id,
      relayMessageId: relay.message.id,
      handledMessageId: handled.message.id,
      fileMessageId: fileMessage.message.id,
    };
  } finally {
    instance.releaseAcceptedBody(relayInput);
    instance.releaseAcceptedBody(inlineInput);
    instance.releaseAcceptedBody(fileInput);
  }
}

function shardPathOf(value: Installation, channelId: string): string {
  return join(value.vault, "snapshots", "channels", channelId.slice(0, 2), `${channelId}.json`);
}

function readManifest(value: Installation): {
  counts: { channels: number; events: number };
  contentDigests: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(value.vault, "snapshots", "manifest.json"), "utf8")) as {
    counts: { channels: number; events: number };
    contentDigests: Record<string, string>;
  };
}

function rowsOf(value: Installation, table: string): Array<Record<string, unknown>> {
  const db = openSorageDatabase(value.database);
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function channelEventRows(value: Installation): Array<Record<string, unknown>> {
  const db = openSorageDatabase(value.database);
  try {
    return db
      .prepare(
        "SELECT id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function contentRecordIds(value: Installation): string[] {
  return rowsOf(value, "content_records").map((row) => String(row.id));
}

function channelContentFileDigests(value: Installation): Record<string, string> {
  const root = join(value.vault, "content", "channel");
  const digests: Record<string, string> = {};
  if (!existsSync(root)) return digests;
  for (const channelId of readdirSync(root)) {
    for (const name of readdirSync(join(root, channelId))) {
      const bytes = readFileSync(join(root, channelId, name));
      digests[`content/channel/${channelId}/${name}`] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return digests;
}

function channelInventory(value: Installation) {
  return {
    channels: rowsOf(value, "channels"),
    participants: rowsOf(value, "channel_participants"),
    assignments: rowsOf(value, "channel_assignments"),
    messages: rowsOf(value, "channel_messages"),
    events: channelEventRows(value),
    contentRecords: contentRecordIds(value),
    contentFiles: channelContentFileDigests(value),
    config: readFileSync(join(value.home, "config.yaml")),
    marker: readFileSync(join(value.vault, ".sorage-vault.json")),
  };
}

function refusesBeforeImport(source: Installation, code = "VAULT_INTEGRITY_ERROR") {
  expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() })).toMatchObject({
    ok: false,
    error: { code },
  });
  const target = installation();
  const before = channelInventory(target);
  for (const dryRun of [true, false]) {
    expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun })).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(channelInventory(target)).toEqual(before);
  }
}

function healthyExport(): { source: Installation; seed: SeededChannel } {
  const source = installation();
  const instance = channelPorts(source);
  const seed = seedSnapshotChannel(instance);
  unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
  return { source, seed };
}

/** Rewrites shard, content file, and manifest so one file body carries `bytes` with a self-consistent recorded identity. */
function rewriteFileBody(source: Installation, seed: SeededChannel, bytes: Buffer) {
  const manifestPath = join(source.vault, "snapshots", "manifest.json");
  const manifest = readManifest(source);
  const contentKey = Object.keys(manifest.contentDigests)[0] as string;
  const shardPath = shardPathOf(source, seed.channelId);
  const shard = JSON.parse(readFileSync(shardPath, "utf8")) as {
    messages: Array<{ id: string; bodyContent: Record<string, unknown> }>;
  };
  const message = shard.messages.find((row) => row.id === seed.fileMessageId);
  if (message === undefined) throw new Error("file-backed fixture message missing");
  const sha = createHash("sha256").update(bytes).digest("hex");
  message.bodyContent = { contentPath: contentKey, sizeBytes: bytes.length, sha256: sha };
  writeFileSync(shardPath, canonicalJson(shard));
  writeFileSync(join(source.vault, "snapshots", contentKey), bytes);
  manifest.contentDigests[contentKey] = sha;
  writeFileSync(manifestPath, canonicalJson(manifest));
}

describe("Channel snapshot export, verify, and restore on real SQLite and filesystem", () => {
  it("round-trips the complete history with exact verbatim bytes, fresh private ids, and no receipts", () => {
    const { source, seed } = healthyExport();
    const shardPath = shardPathOf(source, seed.channelId);
    expect(existsSync(shardPath)).toBe(true);
    const manifest = readManifest(source);
    expect(manifest.counts.channels).toBe(1);
    const digestKeys = Object.keys(manifest.contentDigests);
    expect(digestKeys).toHaveLength(1);
    const contentKey = digestKeys[0] as string;
    expect(contentKey.startsWith(`content/channel/${seed.channelId}/`)).toBe(true);
    const carried = readFileSync(join(source.vault, "snapshots", contentKey));
    expect(carried).toEqual(Buffer.from(BEYOND_HEAD_BODY, "utf8"));
    expect(createHash("sha256").update(carried).digest("hex")).toBe(manifest.contentDigests[contentKey]);

    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as {
      id: string;
      state: string;
      title: string;
      participants: Array<{ id: string; role: string; handle: string; nativeProvenance: string[]; active: boolean }>;
      assignments: Array<{ id: string; state: string }>;
      messages: Array<Record<string, unknown>>;
    };
    expect(shard.id).toBe(seed.channelId);
    expect(shard.state).toBe("closed");
    expect(shard.title).toBe("Snapshot roundtrip");
    const wireMain = shard.participants.find((participant) => participant.role === "main");
    expect(wireMain?.handle).toBe(MAIN_HANDLE);
    const wireWorker = shard.participants.find((participant) => participant.role === "worker");
    expect(wireWorker?.handle).toBe(WORKER_HANDLE);
    expect(wireWorker?.nativeProvenance).toEqual(WORKER_NATIVE);
    const relayRow = shard.messages.find((message) => message.id === seed.relayMessageId);
    expect(relayRow).toMatchObject({
      kind: "relay_request",
      assignmentId: seed.assignmentOpenId,
      assignmentLate: false,
      relayToParticipantId: seed.judgeId,
      contextSession: "",
      contextNode: "node\twith\ttabs",
      contextAttempt: "attempt\u0000nul",
      handled: false,
      handledAt: null,
      handledByKind: null,
      handleNote: null,
    });
    const handledRow = shard.messages.find((message) => message.id === seed.handledMessageId);
    expect(handledRow).toMatchObject({
      assignmentId: seed.assignmentClosedId,
      assignmentLate: true,
      handled: true,
      handledByKind: "participant",
      handleNote: HANDLE_NOTE,
    });
    const fileRow = shard.messages.find((message) => message.id === seed.fileMessageId);
    expect(fileRow).toMatchObject({
      handled: true,
      handledByKind: "user",
      handledByParticipantId: null,
    });
    expect((fileRow?.bodyContent as { contentPath: string }).contentPath).toBe(contentKey);

    expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() })).toMatchObject({ ok: true });

    const target = installation();
    const outcome = unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false }));
    expect(outcome.dryRun).toBe(false);

    const participants = rowsOf(target, "channel_participants");
    expect(participants.map((row) => String(row.id)).sort()).toEqual([seed.mainId, seed.workerId, seed.judgeId].sort());
    const mainRow = participants.find((row) => String(row.id) === seed.mainId);
    expect(mainRow?.handle).toBe(MAIN_HANDLE);
    const workerRow = participants.find((row) => String(row.id) === seed.workerId);
    expect(workerRow?.handle).toBe(WORKER_HANDLE);
    expect(JSON.parse(String(workerRow?.native_provenance_json))).toEqual(WORKER_NATIVE);
    const judgeRow = participants.find((row) => String(row.id) === seed.judgeId);
    expect(judgeRow?.active).toBe(0);
    expect(judgeRow?.deactivated_at).toBe(channelTime(12));

    const messages = rowsOf(target, "channel_messages");
    const relayDb = messages.find((row) => String(row.id) === seed.relayMessageId);
    expect(relayDb).toMatchObject({
      sender_handle: WORKER_HANDLE,
      assignment_late: 0,
      context_session: "",
      context_node: "node\twith\ttabs",
      context_attempt: "attempt\u0000nul",
      handled: 0,
      processing_row_version: 1,
    });
    const handledDb = messages.find((row) => String(row.id) === seed.handledMessageId);
    expect(handledDb).toMatchObject({
      assignment_late: 1,
      handled: 1,
      handled_by_kind: "participant",
      handle_note: HANDLE_NOTE,
      processing_row_version: 2,
    });
    const fileDb = messages.find((row) => String(row.id) === seed.fileMessageId);
    expect(fileDb).toMatchObject({
      handled: 1,
      handled_by_kind: "user",
      handled_by_participant_id: null,
      processing_row_version: 2,
    });

    const sourceRecords = new Set(contentRecordIds(source));
    const targetRecords = contentRecordIds(target);
    expect(targetRecords).toHaveLength(sourceRecords.size);
    expect(targetRecords.some((id) => sourceRecords.has(id))).toBe(false);
    const targetFiles = channelContentFileDigests(target);
    expect(Object.keys(targetFiles)).toHaveLength(1);
    expect(Object.values(targetFiles)[0]).toBe(manifest.contentDigests[contentKey]);

    const ledger = (value: Installation) =>
      channelEventRows(value).map(({ metadata_json, ...event }) => ({
        ...event,
        metadata: JSON.parse(String(metadata_json)),
      }));
    expect(ledger(target)).toEqual(ledger(source));
    expect(rowsOf(target, "idempotency_keys")).toEqual([]);

    const targetChannelPorts = channelPorts(target);
    const fileDetail = unwrap(readChannelMessage(targetChannelPorts, seed.channelId, seed.fileMessageId));
    expect(fileDetail.body).toBe(BEYOND_HEAD_BODY);
    expect(fileDetail.handled).toBe(true);
    expect(fileDetail.handledByKind).toBe("user");
    const inlineDetail = unwrap(readChannelMessage(targetChannelPorts, seed.channelId, seed.handledMessageId));
    expect(inlineDetail.body).toBe(INLINE_BODY);
    expect(inlineDetail.handleNote).toBe(HANDLE_NOTE);
    const relayDetail = unwrap(readChannelMessage(targetChannelPorts, seed.channelId, seed.relayMessageId));
    expect(relayDetail.body).toBe(RELAY_BODY);
    expect(relayDetail.handled).toBe(false);
    const shown = unwrap(showChannel(targetChannelPorts, seed.channelId));
    expect(shown.state).toBe("closed");
    expect(shown.participants.map((participant) => participant.handle)).toEqual([MAIN_HANDLE, WORKER_HANDLE, "judge"]);
    expect(shown.assignments.map((assignment) => assignment.state)).toEqual(["open", "closed"]);
  });

  it("dry-run plans the restore without mutating the target", () => {
    const { source } = healthyExport();
    const target = installation();
    const before = channelInventory(target);
    const plan = unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: true }));
    if (plan.dryRun !== true) throw new Error("expected a dry-run plan");
    expect(plan.wouldCreate.events).toBe(readManifest(source).counts.events);
    expect(channelInventory(target)).toEqual(before);
    expect(existsSync(join(target.vault, "content", "channel"))).toBe(false);
  });

  it.each([
    [
      "a null shard",
      (source: Installation, seed: SeededChannel) => writeFileSync(shardPathOf(source, seed.channelId), "null"),
    ],
    [
      "an array shard",
      (source: Installation, seed: SeededChannel) => writeFileSync(shardPathOf(source, seed.channelId), "[]"),
    ],
    [
      "an unknown shard key",
      (source: Installation, seed: SeededChannel) => {
        const shardPath = shardPathOf(source, seed.channelId);
        const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
        writeFileSync(shardPath, canonicalJson({ ...shard, extra: 1 }));
      },
    ],
    [
      "noncanonical shard bytes",
      (source: Installation, seed: SeededChannel) => {
        const shardPath = shardPathOf(source, seed.channelId);
        const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
        writeFileSync(shardPath, JSON.stringify(shard));
      },
    ],
  ])("refuses %s as a typed integrity failure before adoption", (_name, corrupt) => {
    const { source, seed } = healthyExport();
    corrupt(source, seed);
    refusesBeforeImport(source);
  });

  it("refuses a ledger-only Channel event appended without its shard", () => {
    const { source } = healthyExport();
    const manifestPath = join(source.vault, "snapshots", "manifest.json");
    const eventsPath = join(source.vault, "snapshots", "events.jsonl");
    writeFileSync(
      eventsPath,
      `${readFileSync(eventsPath, "utf8")}${canonicalJsonLine({
        id: randomUUID(),
        handoffId: null,
        memoId: null,
        eventType: "CHANNEL_CREATED",
        actorKind: "user",
        actorId: null,
        rowVersion: null,
        metadata: { channelId: randomUUID(), mainParticipantId: randomUUID() },
        createdAt: "2026-10-20T00:00:30.000Z",
      })}`,
    );
    const manifest = readManifest(source);
    manifest.counts.events += 1;
    writeFileSync(manifestPath, canonicalJson(manifest));
    refusesBeforeImport(source);
  });

  it("refuses a manifest Channel count above an emptied shard family", () => {
    const { source, seed } = healthyExport();
    rmSync(join(source.vault, "snapshots", "channels"), { recursive: true, force: true });
    expect(readManifest(source).counts.channels).toBe(1);
    expect(shardPathOf(source, seed.channelId)).toBeDefined();
    refusesBeforeImport(source);
  });

  it.each([
    [
      "a removed content file",
      (source: Installation) => {
        const contentKey = Object.keys(readManifest(source).contentDigests)[0] as string;
        rmSync(join(source.vault, "snapshots", contentKey));
      },
    ],
    [
      "a tampered content byte",
      (source: Installation) => {
        const contentKey = Object.keys(readManifest(source).contentDigests)[0] as string;
        const path = join(source.vault, "snapshots", contentKey);
        writeFileSync(path, Buffer.concat([readFileSync(path).subarray(0, 5), Buffer.from("X")]));
      },
    ],
    [
      "a symlinked content file",
      (source: Installation) => {
        const contentKey = Object.keys(readManifest(source).contentDigests)[0] as string;
        const path = join(source.vault, "snapshots", contentKey);
        const outside = join(source.home, "outside-body.txt");
        writeFileSync(outside, readFileSync(path));
        rmSync(path);
        symlinkSync(outside, path);
      },
    ],
  ])("refuses %s before adoption", (_name, corrupt) => {
    const { source } = healthyExport();
    corrupt(source);
    refusesBeforeImport(source);
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xff, 0x41])],
    ["a NUL byte", Buffer.from("ok\0ok")],
    ["an all-whitespace body", Buffer.from(" \t\r\n ")],
  ])("refuses a self-consistent identity over %s with a valid recorded size and digest", (_name, bytes) => {
    const { source, seed } = healthyExport();
    rewriteFileBody(source, seed, bytes);
    refusesBeforeImport(source);
  });

  it("refuses restore onto a Channel-only target that the pre-Channel census already sees through its events", () => {
    const { source } = healthyExport();
    const target = installation();
    const instance = channelPorts(target);
    seedSnapshotChannel(instance);
    const before = channelInventory(target);
    expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false })).toMatchObject({
      ok: false,
      error: { code: "RESTORE_TARGET_NOT_EMPTY" },
    });
    expect(channelInventory(target)).toEqual(before);
  });

  it("refuses restore onto a deliberately partial Channel-only target whose ledger rows were removed by owned test SQL", () => {
    const { source } = healthyExport();
    const target = installation();
    const instance = channelPorts(target);
    const created = unwrap(
      createChannel(instance, { creator: { kind: "user", id: null }, mainHandle: "solo-main", title: null }),
    );
    const messageInput = accepted(instance, "committed message body");
    try {
      unwrap(
        submitMessage(instance, {
          channelId: created.channel.id,
          senderParticipantId: created.channel.mainParticipantId,
          kind: "report",
          accepted: messageInput,
          actor: { kind: "user", id: null },
        }),
      );
    } finally {
      instance.releaseAcceptedBody(messageInput);
    }
    // The deliberate corruption boundary of the P2A amendment: drop the
    // append-only guard, remove the ledger rows on this isolated fixture,
    // re-arm the guard, and checkpoint so the preservation baseline is stable.
    const db = openSorageDatabase(target.database);
    try {
      db.exec("DROP TRIGGER events_append_only_delete");
      db.exec("DELETE FROM events");
      db.exec(
        "CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END",
      );
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    for (const table of [
      "projects",
      "handoffs",
      "artifacts",
      "review_notes",
      "deletion_requests",
      "events",
      "project_memos",
    ]) {
      expect(rowsOf(target, table)).toEqual([]);
    }
    expect(rowsOf(target, "channels")).toHaveLength(1);
    expect(rowsOf(target, "channel_participants")).toHaveLength(1);
    expect(rowsOf(target, "channel_messages")).toHaveLength(1);
    expect(contentRecordIds(target)).toHaveLength(1);
    const before = channelInventory(target);
    expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false })).toMatchObject({
      ok: false,
      error: { code: "RESTORE_TARGET_NOT_EMPTY" },
    });
    expect(channelInventory(target)).toEqual(before);
  });
});
