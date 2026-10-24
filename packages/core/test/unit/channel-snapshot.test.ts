import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, type SnapshotEvent } from "../../src/backup-snapshot";
import {
  channelContentFilePath,
  channelIdFromSnapshotPath,
  channelSnapshotPath,
  parseChannelSnapshotShard,
  proveChannelContentBytes,
  validateSnapshotChannelContent,
  validateSnapshotChannelHistory,
  validateSnapshotChannelShard,
} from "../../src/channel-snapshot";
import type { ChannelContentFileExport, SnapshotChannelShard, SnapshotDataV3 } from "../../src/content-snapshot";
import type { ContentSnapshotManifest } from "../../src/memo-snapshot";

/**
 * The rebuilt format-3 Channel snapshot validators (section 38.8, section 38.9
 * line 1818, security section 10.1): the closed shard contract keyed by name,
 * handle and sequence number; the closed participant and message records with
 * their null rules and deterministic orders; the content-file inventory; and
 * the order-independent ledger reconciliation — exactly one posting event per
 * message, exactly one handling event per handled message, at least one
 * addition event per retained non-main participant with the count relation,
 * and no assumption that timestamp or UUID order records mutation order. An
 * old-key shard or an old Channel event name fails closed with
 * `VAULT_INTEGRITY_ERROR`, never a conversion.
 */

const CHANNEL = "10000000-0000-4000-8000-000000000001";
const CONTENT_ID = "50000000-0000-4000-8000-000000000003";
const CONTENT_PATH = `content/channel/${CHANNEL}/${CONTENT_ID}`;
const STAMP = "2026-10-24T00:00:00.000Z";
const STAMP_2 = "2026-10-24T00:00:00.001Z";
const STAMP_3 = "2026-10-24T00:00:00.002Z";
const INLINE = "inline channel body";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Shard = Mutable<SnapshotChannelShard>;

function baseShard(): Shard {
  return {
    id: CHANNEL,
    name: "aq-run-42",
    title: null,
    state: "open",
    main: "main",
    createdAt: STAMP,
    closedAt: null,
    participants: [
      { handle: "main", role: "main", addedAt: STAMP, removedAt: null },
      { handle: "w1", role: "worker", addedAt: STAMP_2, removedAt: null },
    ],
    messages: [
      {
        seq: 1,
        senderHandle: "w1",
        kind: "report",
        toHandle: null,
        ref: null,
        bodyContent: { inline: INLINE },
        handled: false,
        handledAt: null,
        handleNote: null,
        createdAt: STAMP_3,
      },
    ],
  };
}

function event(
  eventType: string,
  metadata: Record<string, unknown>,
  createdAt: string,
  id = `70000000-0000-4000-8000-${String(eventCounter++).padStart(12, "0")}`,
): SnapshotEvent {
  return { id, handoffId: null, eventType, actorKind: "user", actorId: null, rowVersion: null, metadata, createdAt };
}

let eventCounter = 1;

function coherentEvents(shard: Shard): SnapshotEvent[] {
  const events: SnapshotEvent[] = [
    event(
      "CHANNEL_CREATED",
      { channelId: shard.id, actingHandle: shard.main, mainHandle: shard.main },
      shard.createdAt,
    ),
  ];
  if (shard.state === "closed") {
    events.push(event("CHANNEL_CLOSED", { channelId: shard.id, actingHandle: shard.main }, shard.closedAt ?? STAMP_3));
  }
  for (const participant of shard.participants) {
    if (participant.role === "main") continue;
    events.push(
      event(
        "CHANNEL_PARTICIPANT_ADDED",
        { channelId: shard.id, actingHandle: shard.main, handle: participant.handle, role: participant.role },
        participant.addedAt,
      ),
    );
    if (participant.removedAt !== null) {
      events.push(
        event(
          "CHANNEL_PARTICIPANT_REMOVED",
          { channelId: shard.id, actingHandle: shard.main, handle: participant.handle },
          participant.removedAt,
        ),
      );
    }
  }
  for (const message of shard.messages) {
    events.push(
      event(
        "CHANNEL_MESSAGE_POSTED",
        {
          channelId: shard.id,
          actingHandle: message.senderHandle,
          seq: message.seq,
          kind: message.kind,
          toHandle: message.toHandle,
        },
        message.createdAt,
      ),
    );
    if (message.handled) {
      events.push(
        event(
          "CHANNEL_MESSAGE_ACKED",
          { channelId: shard.id, actingHandle: shard.main, seq: message.seq },
          message.handledAt ?? STAMP_3,
        ),
      );
    }
  }
  return events;
}

function manifestFor(shards: Shard[], carried: ChannelContentFileExport[]): ContentSnapshotManifest {
  const contentDigests: Record<string, string> = {};
  for (const file of carried) {
    const path = channelContentFilePath(file.channelId, file.contentId);
    if (!path.ok) throw new Error("carried file identity is not canonical");
    contentDigests[path.value] = createHash("sha256").update(file.bytes).digest("hex");
  }
  return {
    formatVersion: 3,
    counts: { projects: 0, handoffs: 0, events: 0, artifacts: 0, memos: 0, channels: shards.length },
    memoDigests: {},
    contentDigests,
  } as unknown as ContentSnapshotManifest;
}

function snapshotData(shards: Shard[], carried: ChannelContentFileExport[]): SnapshotDataV3 {
  return { channels: shards, channelContentFiles: carried } as unknown as SnapshotDataV3;
}

describe("the canonical Channel snapshot paths", () => {
  it("derives and recovers shard and content paths", () => {
    expect(channelSnapshotPath(CHANNEL)).toEqual({ ok: true, value: `channels/10/${CHANNEL}.json` });
    expect(channelContentFilePath(CHANNEL, CONTENT_ID)).toEqual({ ok: true, value: CONTENT_PATH });
    expect(channelSnapshotPath("not-a-uuid").ok).toBe(false);
    expect(channelContentFilePath(CHANNEL, "x").ok).toBe(false);
    expect(channelIdFromSnapshotPath(`channels/10/${CHANNEL}.json`)).toEqual({ ok: true, value: CHANNEL });
    expect(channelIdFromSnapshotPath(`channels/ff/${CHANNEL}.json`).ok).toBe(false);
  });
});

describe("the rebuilt closed shard contract", () => {
  it("accepts a coherent rebuilt shard and refuses an old-key shard", () => {
    expect(validateSnapshotChannelShard(baseShard()).ok).toBe(true);
    const oldKeys = baseShard() as unknown as Record<string, unknown>;
    oldKeys.creatorKind = "user";
    oldKeys.creatorId = null;
    oldKeys.assignments = [];
    delete oldKeys.name;
    delete oldKeys.main;
    expect(validateSnapshotChannelShard(oldKeys).ok).toBe(false);
  });

  it("pins the lifecycle, roster, and message null rules", () => {
    const openWithClosure = baseShard();
    openWithClosure.closedAt = STAMP_3;
    expect(validateSnapshotChannelShard(openWithClosure).ok).toBe(false);
    const closedWithoutClosure = baseShard();
    closedWithoutClosure.state = "closed";
    expect(validateSnapshotChannelShard(closedWithoutClosure).ok).toBe(false);
    const closed = baseShard();
    closed.state = "closed";
    closed.closedAt = STAMP_3;
    expect(validateSnapshotChannelShard(closed).ok).toBe(true);

    const noMain = baseShard();
    noMain.participants = [noMain.participants[1] as Shard["participants"][number]];
    expect(validateSnapshotChannelShard(noMain).ok).toBe(false);
    const mainDisagreement = baseShard();
    mainDisagreement.main = "other";
    expect(validateSnapshotChannelShard(mainDisagreement).ok).toBe(false);
    const mainNotAtCreation = baseShard();
    (mainNotAtCreation.participants[0] as { addedAt: string }).addedAt = STAMP_3;
    expect(validateSnapshotChannelShard(mainNotAtCreation).ok).toBe(false);

    const removed = baseShard();
    (removed.participants[1] as { removedAt: string | null }).removedAt = STAMP_3;
    expect(validateSnapshotChannelShard(removed).ok).toBe(true);
    const mainRemoved = baseShard();
    (mainRemoved.participants[0] as { removedAt: string | null }).removedAt = STAMP_3;
    expect(validateSnapshotChannelShard(mainRemoved).ok).toBe(false);

    const unsortedRoster = baseShard();
    unsortedRoster.participants = [
      unsortedRoster.participants[1] as Shard["participants"][number],
      unsortedRoster.participants[0] as Shard["participants"][number],
    ];
    expect(validateSnapshotChannelShard(unsortedRoster).ok).toBe(false);

    const relayWithoutTarget = baseShard();
    (relayWithoutTarget.messages[0] as { kind: string }).kind = "relay_request";
    expect(validateSnapshotChannelShard(relayWithoutTarget).ok).toBe(false);
    const targetOutsideRoster = baseShard();
    (targetOutsideRoster.messages[0] as { kind: string; toHandle: string | null }).kind = "relay_request";
    (targetOutsideRoster.messages[0] as { toHandle: string | null }).toHandle = "ghost";
    expect(validateSnapshotChannelShard(targetOutsideRoster).ok).toBe(false);
    const handledWithoutTime = baseShard();
    (handledWithoutTime.messages[0] as { handled: boolean }).handled = true;
    expect(validateSnapshotChannelShard(handledWithoutTime).ok).toBe(false);
    const handled = baseShard();
    (handled.messages[0] as { handled: boolean; handledAt: string | null }).handled = true;
    (handled.messages[0] as { handledAt: string | null }).handledAt = STAMP_3;
    expect(validateSnapshotChannelShard(handled).ok).toBe(true);
    const unsortedMessages = baseShard();
    unsortedMessages.messages.push({ ...(unsortedMessages.messages[0] as Shard["messages"][number]), seq: 1 });
    expect(validateSnapshotChannelShard(unsortedMessages).ok).toBe(false);
    const mainSender = baseShard();
    (mainSender.messages[0] as { senderHandle: string }).senderHandle = "main";
    expect(validateSnapshotChannelShard(mainSender).ok).toBe(false);
  });

  it("keeps the inline threshold and the Channel-owned content path", () => {
    const overThreshold = baseShard();
    (overThreshold.messages[0] as { bodyContent: { inline: string } }).bodyContent = { inline: "x".repeat(65_537) };
    expect(validateSnapshotChannelShard(overThreshold).ok).toBe(false);
    const foreignPath = baseShard();
    (
      foreignPath.messages[0] as { bodyContent: { contentPath: string; sizeBytes: number; sha256: string } }
    ).bodyContent = {
      contentPath: `content/channel/10000000-0000-4000-8000-000000000009/${CONTENT_ID}`,
      sizeBytes: 3,
      sha256: "a".repeat(64),
    };
    expect(validateSnapshotChannelShard(foreignPath).ok).toBe(false);
  });

  it("parses canonical bytes and refuses noncanonical ones", () => {
    const shard = baseShard();
    const path = channelSnapshotPath(CHANNEL);
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    const bytes = new TextEncoder().encode(canonicalJson(shard));
    const parsed = parseChannelSnapshotShard(path.value, bytes);
    expect(parsed.ok).toBe(true);
    const reordered = new TextEncoder().encode(JSON.stringify(shard, null, 2));
    expect(parseChannelSnapshotShard(path.value, reordered).ok).toBe(false);
    const otherChannel = channelSnapshotPath("10000000-0000-4000-8000-000000000002");
    expect(otherChannel.ok).toBe(true);
    if (otherChannel.ok) expect(parseChannelSnapshotShard(otherChannel.value, bytes).ok).toBe(false);
  });
});

describe("the whole-bytes content proof", () => {
  it("accepts exact nonblank bytes and refuses NUL, blank, and invalid UTF-8", () => {
    expect(proveChannelContentBytes(new TextEncoder().encode("report body")).ok).toBe(true);
    expect(proveChannelContentBytes(new TextEncoder().encode("  \r\n\t ")).ok).toBe(false);
    expect(proveChannelContentBytes(new Uint8Array([0x62, 0x6f, 0x64, 0x79, 0x00])).ok).toBe(false);
    expect(proveChannelContentBytes(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
  });
});

describe("the rebuilt ledger reconciliation", () => {
  it("accepts a coherent rebuilt ledger", () => {
    const shard = baseShard();
    expect(validateSnapshotChannelHistory(coherentEvents(shard), [shard]).ok).toBe(true);
    const closed = baseShard();
    closed.state = "closed";
    closed.closedAt = STAMP_3;
    const events = coherentEvents(closed);
    expect(validateSnapshotChannelHistory(events, [closed]).ok).toBe(true);
    const handled = baseShard();
    (handled.messages[0] as { handled: boolean; handledAt: string | null }).handled = true;
    (handled.messages[0] as { handledAt: string | null }).handledAt = STAMP_3;
    expect(validateSnapshotChannelHistory(coherentEvents(handled), [handled]).ok).toBe(true);
  });

  it("keeps the reconciliation order-independent: a shared-timestamp add/remove/re-add round trips", () => {
    const shard = baseShard();
    const worker = shard.participants[1] as { handle: string; role: string; addedAt: string; removedAt: string | null };
    // Three transactions at one millisecond, with event UUID order chosen so
    // the (createdAt, id) sort disagrees with the execution order.
    const addedFirst = event(
      "CHANNEL_PARTICIPANT_ADDED",
      { channelId: shard.id, actingHandle: "main", handle: worker.handle, role: "worker" },
      STAMP_2,
      "90000000-0000-4000-8000-000000000003",
    );
    const removedThen = event(
      "CHANNEL_PARTICIPANT_REMOVED",
      { channelId: shard.id, actingHandle: "main", handle: worker.handle },
      STAMP_2,
      "90000000-0000-4000-8000-000000000001",
    );
    const reAddedLast = event(
      "CHANNEL_PARTICIPANT_ADDED",
      { channelId: shard.id, actingHandle: "main", handle: worker.handle, role: "worker" },
      STAMP_2,
      "90000000-0000-4000-8000-000000000002",
    );
    const events = coherentEvents(shard).filter(
      (entry) =>
        entry.eventType !== "CHANNEL_PARTICIPANT_ADDED" ||
        (entry.metadata as { handle: string }).handle !== worker.handle,
    );
    // The retained state: registered again (removedAt null, addedAt refreshed).
    worker.removedAt = null;
    worker.addedAt = STAMP_2;
    events.push(addedFirst, removedThen, reAddedLast);
    const sorted = [...events].sort((left, right) =>
      left.createdAt === right.createdAt ? (left.id < right.id ? -1 : 1) : left.createdAt < right.createdAt ? -1 : 1,
    );
    expect(validateSnapshotChannelHistory(sorted, [shard]).ok).toBe(true);
    // The retained state may instead end removed: the count relation holds.
    worker.removedAt = STAMP_2;
    const removedEvents = events.filter((entry) => entry !== reAddedLast);
    expect(validateSnapshotChannelHistory(removedEvents, [shard]).ok).toBe(true);
  });

  it("rejects every missing-or-duplicated event the audit trail requires", () => {
    const shard = baseShard();
    const missingPosted = coherentEvents(shard).filter((entry) => entry.eventType !== "CHANNEL_MESSAGE_POSTED");
    expect(validateSnapshotChannelHistory(missingPosted, [shard]).ok).toBe(false);
    const duplicatePosted = [
      ...coherentEvents(shard),
      coherentEvents(shard).find((entry) => entry.eventType === "CHANNEL_MESSAGE_POSTED") as SnapshotEvent,
    ];
    expect(validateSnapshotChannelHistory(duplicatePosted, [shard]).ok).toBe(false);

    const handled = baseShard();
    (handled.messages[0] as { handled: boolean; handledAt: string | null }).handled = true;
    (handled.messages[0] as { handledAt: string | null }).handledAt = STAMP_3;
    const missingAcked = coherentEvents(handled).filter((entry) => entry.eventType !== "CHANNEL_MESSAGE_ACKED");
    expect(validateSnapshotChannelHistory(missingAcked, [handled]).ok).toBe(false);
    const duplicateAcked = [
      ...coherentEvents(handled),
      coherentEvents(handled).find((entry) => entry.eventType === "CHANNEL_MESSAGE_ACKED") as SnapshotEvent,
    ];
    expect(validateSnapshotChannelHistory(duplicateAcked, [handled]).ok).toBe(false);

    const missingAdded = coherentEvents(shard).filter(
      (entry) =>
        entry.eventType !== "CHANNEL_PARTICIPANT_ADDED" || (entry.metadata as { handle?: string }).handle === undefined,
    );
    // The creation event has no handle key, so this only drops the worker's additions.
    const strictlyMissingAdded = missingAdded.filter((entry) => !(entry.eventType === "CHANNEL_CREATED"));
    expect(validateSnapshotChannelHistory(strictlyMissingAdded, [shard]).ok).toBe(false);

    const missingCreated = coherentEvents(shard).filter((entry) => entry.eventType !== "CHANNEL_CREATED");
    expect(validateSnapshotChannelHistory(missingCreated, [shard]).ok).toBe(false);
    const duplicateCreated = [
      ...coherentEvents(shard),
      event("CHANNEL_CREATED", { channelId: shard.id, actingHandle: "main", mainHandle: "main" }, STAMP_3),
    ];
    expect(validateSnapshotChannelHistory(duplicateCreated, [shard]).ok).toBe(false);
    const closedWithoutEvent = baseShard();
    closedWithoutEvent.state = "closed";
    closedWithoutEvent.closedAt = STAMP_3;
    expect(
      validateSnapshotChannelHistory(
        coherentEvents(closedWithoutEvent).filter((e) => e.eventType !== "CHANNEL_CLOSED"),
        [closedWithoutEvent],
      ).ok,
    ).toBe(false);
  });

  it("enforces the User actor, the associations, and the acting-handle rules", () => {
    const shard = baseShard();
    const projectActor = coherentEvents(shard).map((entry) =>
      entry.eventType === "CHANNEL_CREATED" ? { ...entry, actorKind: "registered_project", actorId: CHANNEL } : entry,
    );
    expect(validateSnapshotChannelHistory(projectActor, [shard]).ok).toBe(false);
    const withHandoff = coherentEvents(shard).map((entry) =>
      entry.eventType === "CHANNEL_CREATED" ? { ...entry, handoffId: CHANNEL } : entry,
    );
    expect(validateSnapshotChannelHistory(withHandoff, [shard]).ok).toBe(false);
    const withRowVersion = coherentEvents(shard).map((entry) =>
      entry.eventType === "CHANNEL_MESSAGE_POSTED" ? { ...entry, rowVersion: 1 } : entry,
    );
    expect(validateSnapshotChannelHistory(withRowVersion, [shard]).ok).toBe(false);
    const postedByMain = coherentEvents(shard).map((entry) =>
      entry.eventType === "CHANNEL_MESSAGE_POSTED"
        ? { ...entry, metadata: { ...(entry.metadata as Record<string, unknown>), actingHandle: "main" } }
        : entry,
    );
    expect(validateSnapshotChannelHistory(postedByMain, [shard]).ok).toBe(false);
    const ackedShard = { ...shard } as Shard;
    ackedShard.messages[0] = {
      ...(ackedShard.messages[0] as Shard["messages"][number]),
      handled: true,
      handledAt: STAMP_3,
    };
    const ackedByWorker = coherentEvents(ackedShard).map((entry) =>
      entry.eventType === "CHANNEL_MESSAGE_ACKED"
        ? { ...entry, metadata: { ...(entry.metadata as Record<string, unknown>), actingHandle: "w1" } }
        : entry,
    );
    expect(validateSnapshotChannelHistory(ackedByWorker, [ackedShard]).ok).toBe(false);
    // A registered worker as the acting handle of a User-performed
    // registration operation is corrupt even though the worker exists
    // (security section 10.1; decision item 7).
    for (const type of ["CHANNEL_PARTICIPANT_ADDED", "CHANNEL_PARTICIPANT_REMOVED"] as const) {
      // The removed variant needs a retained removal for its REMOVED event to
      // exist at all; the worker stays registered in the base roster.
      const workerRemoved = { ...shard } as Shard;
      const worker = workerRemoved.participants.find((participant) => participant.handle === "w1");
      if (worker !== undefined) worker.removedAt = STAMP_3;
      const subject = type === "CHANNEL_PARTICIPANT_ADDED" ? shard : workerRemoved;
      const byWorker = coherentEvents(subject).map((entry) =>
        entry.eventType === type
          ? { ...entry, metadata: { ...(entry.metadata as Record<string, unknown>), actingHandle: "w1" } }
          : entry,
      );
      expect(validateSnapshotChannelHistory(byWorker, [subject]).ok, type).toBe(false);
    }
    const foreignChannel = coherentEvents(shard).map((entry) =>
      entry.eventType === "CHANNEL_CREATED"
        ? {
            ...entry,
            metadata: {
              ...(entry.metadata as Record<string, unknown>),
              channelId: "10000000-0000-4000-8000-000000000009",
            },
          }
        : entry,
    );
    expect(validateSnapshotChannelHistory(foreignChannel, [shard]).ok).toBe(false);
  });

  it("ignores non-Channel events entirely", () => {
    const shard = baseShard();
    const events = [
      ...coherentEvents(shard),
      event("MEMO_CREATED", { projectId: CHANNEL, memoId: CHANNEL, rowVersion: 1, toState: "open" }, STAMP_3),
    ];
    expect(validateSnapshotChannelHistory(events, [shard]).ok).toBe(true);
  });
});

describe("the Channel content inventory", () => {
  const bytes = new TextEncoder().encode("file channel body");
  const carried: ChannelContentFileExport[] = [{ channelId: CHANNEL, contentId: CONTENT_ID, bytes }];

  function fileShard(): Shard {
    const shard = baseShard();
    (shard.messages[0] as { bodyContent: unknown }).bodyContent = {
      contentPath: CONTENT_PATH,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return shard;
  }

  it("refuses a snapshot that repeats a Channel name across shards before import (CHN-002, decision item 17)", () => {
    const first = baseShard();
    const second = baseShard();
    second.id = "10000000-0000-4000-8000-000000000009";
    second.name = first.name;
    const carried: ChannelContentFileExport[] = [];
    const manifest = manifestFor([first, second], carried);
    // The ids stay distinct, so only the name rule refuses the family.
    const refused = validateSnapshotChannelContent(snapshotData([first, second], carried), manifest);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("repeats a Channel name");
    // The distinct-name variant with the same shape passes.
    second.name = "aq-run-43";
    const accepted = validateSnapshotChannelContent(snapshotData([first, second], carried), manifest);
    expect(accepted.ok).toBe(true);
  });

  it("accepts an agreeing inventory and refuses every disagreement", () => {
    const shard = fileShard();
    expect(validateSnapshotChannelContent(snapshotData([shard], carried), manifestFor([shard], carried)).ok).toBe(true);
    const wrongCount = manifestFor([shard], carried);
    wrongCount.counts.channels = 2;
    expect(validateSnapshotChannelContent(snapshotData([shard], carried), wrongCount).ok).toBe(false);
    const missingFile = snapshotData([shard], []);
    expect(validateSnapshotChannelContent(missingFile, manifestFor([shard], [])).ok).toBe(false);
    const alteredBytes = new TextEncoder().encode("altered channel body");
    const altered: ChannelContentFileExport[] = [{ channelId: CHANNEL, contentId: CONTENT_ID, bytes: alteredBytes }];
    expect(validateSnapshotChannelContent(snapshotData([shard], altered), manifestFor([shard], altered)).ok).toBe(
      false,
    );
    const unreferenced: ChannelContentFileExport[] = [
      ...carried,
      { channelId: CHANNEL, contentId: "50000000-0000-4000-8000-000000000004", bytes },
    ];
    expect(
      validateSnapshotChannelContent(snapshotData([shard], unreferenced), manifestFor([shard], unreferenced)).ok,
    ).toBe(false);
    const unmaterializable = baseShard();
    (unmaterializable.messages[0] as { bodyContent: unknown }).bodyContent = {
      contentPath: CONTENT_PATH,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(
      validateSnapshotChannelContent(
        snapshotData([unmaterializable], carried),
        manifestFor([unmaterializable], carried),
      ).ok,
    ).toBe(true);
  });
});
