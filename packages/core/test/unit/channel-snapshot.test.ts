import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SnapshotChannelShard, type SnapshotDataV3, snapshotFilesV3 } from "../../src/content-snapshot";
import { validateSnapshot } from "../../src/backup-commands";
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
import { canonicalJson, type SnapshotEvent } from "../../src/backup-snapshot";
import type { ContentSnapshotManifest } from "../../src/memo-snapshot";

const CHANNEL = "10000000-0000-4000-8000-000000000001";
const OTHER_CHANNEL = "10000000-0000-4000-8000-000000000002";
const MAIN = "20000000-0000-4000-8000-000000000001";
const WORKER = "20000000-0000-4000-8000-000000000002";
const JUDGE = "20000000-0000-4000-8000-000000000003";
const OTHER_MAIN = "20000000-0000-4000-8000-0000000000a1";
const ASSIGNMENT_OPEN = "30000000-0000-4000-8000-000000000001";
const ASSIGNMENT_CLOSED = "30000000-0000-4000-8000-000000000002";
const MESSAGE_RELAY = "40000000-0000-4000-8000-000000000001";
const MESSAGE_HANDLED = "40000000-0000-4000-8000-000000000002";
const MESSAGE_FILE = "40000000-0000-4000-8000-000000000003";
const CONTENT_ID = "50000000-0000-4000-8000-000000000003";
const CREATOR_PROJECT = "70000000-0000-4000-8000-000000000001";

const T = (seconds: number): string => `2026-10-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;

const FILE_BODY = Buffer.from("\uFEFFfile body content\r\nno final newline");
const FILE_SHA = createHash("sha256").update(FILE_BODY).digest("hex");
const CONTENT_PATH = `content/channel/${CHANNEL}/${CONTENT_ID}`;

/** A complete, healthy closed Channel with every runtime state represented once. */
function validShard(): SnapshotChannelShard {
  return structuredClone({
    id: CHANNEL,
    title: "Snapshot Plan",
    state: "closed",
    creatorKind: "registered_project",
    creatorId: CREATOR_PROJECT,
    createdAt: T(0),
    closedAt: T(12),
    closedByParticipantId: MAIN,
    closedByKind: "participant",
    participants: [
      {
        id: MAIN,
        role: "main",
        handle: "main",
        nativeProvenance: [],
        active: true,
        registeredAt: T(0),
        deactivatedAt: null,
      },
      {
        id: WORKER,
        role: "worker",
        handle: "\uFEFF worker ",
        nativeProvenance: ["", "\t", "nul\u0000"],
        active: true,
        registeredAt: T(1),
        deactivatedAt: null,
      },
      {
        id: JUDGE,
        role: "judge",
        handle: "judge",
        nativeProvenance: [],
        active: false,
        registeredAt: T(2),
        deactivatedAt: T(3),
      },
    ],
    assignments: [
      {
        id: ASSIGNMENT_OPEN,
        participantId: WORKER,
        label: "Do B2",
        state: "open",
        createdAt: T(4),
        closedAt: null,
      },
      {
        id: ASSIGNMENT_CLOSED,
        participantId: null,
        label: "Review",
        state: "closed",
        createdAt: T(5),
        closedAt: T(6),
      },
    ],
    messages: [
      {
        id: MESSAGE_RELAY,
        senderParticipantId: WORKER,
        kind: "relay_request",
        bodyContent: { inline: "relay: please proceed" },
        assignmentId: ASSIGNMENT_OPEN,
        assignmentLate: false,
        relayToParticipantId: WORKER,
        contextSession: "",
        contextNode: "node\twith\ttabs",
        contextAttempt: "attempt\u0000nul",
        handled: false,
        handledAt: null,
        handledByParticipantId: null,
        handledByKind: null,
        handleNote: null,
        createdAt: T(7),
      },
      {
        id: MESSAGE_HANDLED,
        senderParticipantId: MAIN,
        kind: "report",
        bodyContent: { inline: "done\uFEFF report body" },
        assignmentId: ASSIGNMENT_CLOSED,
        assignmentLate: true,
        relayToParticipantId: null,
        contextSession: null,
        contextNode: null,
        contextAttempt: null,
        handled: true,
        handledAt: T(9),
        handledByParticipantId: MAIN,
        handledByKind: "participant",
        handleNote: "handled\uFEFF",
        createdAt: T(8),
      },
      {
        id: MESSAGE_FILE,
        senderParticipantId: MAIN,
        kind: "question",
        bodyContent: { contentPath: CONTENT_PATH, sizeBytes: FILE_BODY.length, sha256: FILE_SHA },
        assignmentId: null,
        assignmentLate: false,
        relayToParticipantId: null,
        contextSession: null,
        contextNode: null,
        contextAttempt: null,
        handled: true,
        handledAt: T(11),
        handledByParticipantId: null,
        handledByKind: "user",
        handleNote: null,
        createdAt: T(10),
      },
    ],
  } satisfies SnapshotChannelShard);
}

function event(seq: number, overrides: Partial<SnapshotEvent> & Record<string, unknown>): SnapshotEvent {
  return {
    id: `60000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    handoffId: null,
    memoId: null,
    eventType: "",
    actorKind: "user",
    actorId: null,
    rowVersion: null,
    metadata: {},
    createdAt: T(0),
    ...overrides,
  } as SnapshotEvent;
}

/** The complete ledger the runtime appends for the fixture above, in order. */
function validEvents(): SnapshotEvent[] {
  return [
    event(1, {
      eventType: "CHANNEL_CREATED",
      actorKind: "registered_project",
      actorId: CREATOR_PROJECT,
      createdAt: T(0),
      metadata: { channelId: CHANNEL, mainParticipantId: MAIN },
    }),
    event(2, {
      eventType: "CHANNEL_PARTICIPANT_REGISTERED",
      createdAt: T(1),
      metadata: { channelId: CHANNEL, actingParticipantId: MAIN, participantId: WORKER, role: "worker" },
    }),
    event(3, {
      eventType: "CHANNEL_PARTICIPANT_REGISTERED",
      createdAt: T(2),
      metadata: { channelId: CHANNEL, actingParticipantId: MAIN, participantId: JUDGE, role: "judge" },
    }),
    event(4, {
      eventType: "CHANNEL_PARTICIPANT_DEACTIVATED",
      createdAt: T(3),
      metadata: {
        channelId: CHANNEL,
        actingParticipantId: MAIN,
        participantId: JUDGE,
        fromActive: true,
        toActive: false,
      },
    }),
    event(5, {
      eventType: "CHANNEL_ASSIGNMENT_CREATED",
      createdAt: T(4),
      metadata: { channelId: CHANNEL, actingParticipantId: MAIN, assignmentId: ASSIGNMENT_OPEN, participantId: WORKER },
    }),
    event(6, {
      eventType: "CHANNEL_ASSIGNMENT_CREATED",
      createdAt: T(5),
      metadata: { channelId: CHANNEL, actingParticipantId: MAIN, assignmentId: ASSIGNMENT_CLOSED, participantId: null },
    }),
    event(7, {
      eventType: "CHANNEL_ASSIGNMENT_CLOSED",
      createdAt: T(6),
      metadata: {
        channelId: CHANNEL,
        actingParticipantId: MAIN,
        assignmentId: ASSIGNMENT_CLOSED,
        fromState: "open",
        toState: "closed",
      },
    }),
    event(8, {
      eventType: "CHANNEL_MESSAGE_SUBMITTED",
      rowVersion: 1,
      createdAt: T(7),
      metadata: {
        channelId: CHANNEL,
        participantId: WORKER,
        messageId: MESSAGE_RELAY,
        kind: "relay_request",
        assignmentId: ASSIGNMENT_OPEN,
        assignmentLate: false,
        relayToParticipantId: WORKER,
        processingRowVersion: 1,
      },
    }),
    event(9, {
      eventType: "CHANNEL_MESSAGE_SUBMITTED",
      rowVersion: 1,
      createdAt: T(8),
      metadata: {
        channelId: CHANNEL,
        participantId: MAIN,
        messageId: MESSAGE_HANDLED,
        kind: "report",
        assignmentId: ASSIGNMENT_CLOSED,
        assignmentLate: true,
        relayToParticipantId: null,
        processingRowVersion: 1,
      },
    }),
    event(10, {
      eventType: "CHANNEL_MESSAGE_SUBMITTED",
      rowVersion: 1,
      createdAt: T(10),
      metadata: {
        channelId: CHANNEL,
        participantId: MAIN,
        messageId: MESSAGE_FILE,
        kind: "question",
        assignmentId: null,
        assignmentLate: false,
        relayToParticipantId: null,
        processingRowVersion: 1,
      },
    }),
    event(11, {
      eventType: "CHANNEL_MESSAGE_HANDLED",
      rowVersion: 2,
      createdAt: T(9),
      metadata: { channelId: CHANNEL, actingParticipantId: MAIN, messageId: MESSAGE_HANDLED, processingRowVersion: 2 },
    }),
    event(12, {
      eventType: "CHANNEL_MESSAGE_HANDLED",
      rowVersion: 2,
      createdAt: T(11),
      metadata: { channelId: CHANNEL, actingParticipantId: null, messageId: MESSAGE_FILE, processingRowVersion: 2 },
    }),
    event(13, {
      eventType: "CHANNEL_CLOSED",
      createdAt: T(12),
      metadata: { channelId: CHANNEL, actingParticipantId: MAIN, fromState: "open", toState: "closed" },
    }),
  ];
}

function validChannelData(): SnapshotDataV3 {
  return {
    projects: [],
    handoffs: [],
    events: validEvents(),
    memos: [],
    memoContentFiles: [],
    channels: [validShard()],
    channelContentFiles: [{ channelId: CHANNEL, contentId: CONTENT_ID, bytes: FILE_BODY }],
  };
}

function manifestFor(
  data: SnapshotDataV3,
  contentDigests: Record<string, string> = { [CONTENT_PATH]: FILE_SHA },
): ContentSnapshotManifest {
  return {
    formatVersion: 3,
    counts: {
      projects: data.projects.length,
      handoffs: data.handoffs.length,
      events: data.events.length,
      artifacts: 0,
      memos: 0,
      channels: data.channels?.length ?? 0,
    },
    memoDigests: {},
    contentDigests,
  };
}

describe("Channel snapshot path helpers", () => {
  it("derives canonical shard and content paths from canonical UUIDs only", () => {
    expect(channelSnapshotPath(CHANNEL)).toEqual({ ok: true, value: `channels/10/${CHANNEL}.json` });
    expect(channelContentFilePath(CHANNEL, CONTENT_ID)).toEqual({ ok: true, value: CONTENT_PATH });
    expect(channelSnapshotPath("not-a-uuid").ok).toBe(false);
    expect(channelContentFilePath(CHANNEL, "x").ok).toBe(false);
  });

  it("recovers the id from a canonical path and refuses every other shape", () => {
    expect(channelIdFromSnapshotPath(`channels/10/${CHANNEL}.json`)).toEqual({ ok: true, value: CHANNEL });
    for (const path of [
      `channels/ab/${CHANNEL}.json`,
      `channels/10/${CHANNEL}`,
      `memos/10/${CHANNEL}.json`,
      `channels/10/../../${CHANNEL}.json`,
    ]) {
      expect(channelIdFromSnapshotPath(path).ok).toBe(false);
    }
  });
});

describe("parseChannelSnapshotShard", () => {
  it("parses its own canonical bytes with every verbatim field preserved", () => {
    const shard = validShard();
    const parsed = parseChannelSnapshotShard(`channels/10/${CHANNEL}.json`, Buffer.from(canonicalJson(shard)));
    expect(parsed).toEqual({ ok: true, value: shard });
  });

  it("refuses null, arrays, unknown shapes, unknown keys, duplicate keys, and noncanonical bytes before any cast", () => {
    const path = `channels/10/${CHANNEL}.json`;
    for (const bytes of [
      Buffer.from("null"),
      Buffer.from("[]"),
      Buffer.from('"text"'),
      Buffer.from(canonicalJson({ ...validShard(), extra: 1 })),
      Buffer.from(`{"id":"${CHANNEL}","id":"${CHANNEL}"}`),
      Buffer.from(JSON.stringify(validShard(), null, 2)),
    ]) {
      const parsed = parseChannelSnapshotShard(path, bytes);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("VAULT_INTEGRITY_ERROR");
    }
  });

  it("refuses a record whose id disagrees with its path", () => {
    const shard = validShard();
    const parsed = parseChannelSnapshotShard(`channels/10/${OTHER_CHANNEL}.json`, Buffer.from(canonicalJson(shard)));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });
});

describe("validateSnapshotChannelShard wire semantics", () => {
  it("accepts the healthy fixture with closed, inactive, late, unhandled-relay, and handled-note states", () => {
    expect(validateSnapshotChannelShard(validShard()).ok).toBe(true);
  });

  it("refuses an open channel carrying closing provenance and a closed channel missing it", () => {
    const openWithClose = validShard();
    openWithClose.state = "open";
    expect(validateSnapshotChannelShard(openWithClose).ok).toBe(false);
    const closedWithoutProvenance = validShard();
    closedWithoutProvenance.closedByKind = null;
    expect(validateSnapshotChannelShard(closedWithoutProvenance).ok).toBe(false);
  });

  it("keeps handles verbatim: empty is invalid, space and BOM only are valid, TAB and NUL are invalid", () => {
    for (const handle of ["", "\t", "\u0000"]) {
      const shard = validShard();
      (shard.participants[1] as { handle: string }).handle = handle;
      expect(validateSnapshotChannelShard(shard).ok).toBe(false);
    }
    for (const handle of [" ", "\uFEFF", " \uFEFFworker "]) {
      const shard = validShard();
      (shard.participants[1] as { handle: string }).handle = handle;
      expect(validateSnapshotChannelShard(shard).ok).toBe(true);
    }
  });

  it("keeps native provenance and context verbatim, refusing only line separators and shape violations", () => {
    const withNative = validShard();
    (withNative.participants[1] as { nativeProvenance: string[] }).nativeProvenance = ["", "\t", "\u0000", "ok"];
    expect(validateSnapshotChannelShard(withNative).ok).toBe(true);
    const tooMany = validShard();
    (tooMany.participants[1] as { nativeProvenance: string[] }).nativeProvenance = ["a", "b", "c", "d", "e"];
    expect(validateSnapshotChannelShard(tooMany).ok).toBe(false);
    const newlineNative = validShard();
    (newlineNative.participants[1] as { nativeProvenance: string[] }).nativeProvenance = ["bad\nline"];
    expect(validateSnapshotChannelShard(newlineNative).ok).toBe(false);
    const shard = validShard();
    const relay = shard.messages[0] as { contextSession: string };
    relay.contextSession = " \uFEFF";
    (shard.messages[0] as { contextNode: string | null }).contextNode = null;
    expect(validateSnapshotChannelShard(shard).ok).toBe(true);
  });

  it("refuses rosters without exactly one main, duplicate identities or handles, and inactive mains", () => {
    const twoMains = validShard();
    (twoMains.participants[1] as { role: string }).role = "main";
    twoMains.participants[1]!.nativeProvenance = [];
    twoMains.participants[1]!.registeredAt = twoMains.createdAt;
    expect(validateSnapshotChannelShard(twoMains).ok).toBe(false);
    const noMain = validShard();
    (noMain.participants[0] as { role: string }).role = "worker";
    expect(validateSnapshotChannelShard(noMain).ok).toBe(false);
    const duplicateHandle = validShard();
    (duplicateHandle.participants[2] as { handle: string }).handle = "main";
    expect(validateSnapshotChannelShard(duplicateHandle).ok).toBe(false);
    const inactiveMain = validShard();
    (inactiveMain.participants[0] as { active: boolean }).active = false;
    (inactiveMain.participants[0] as { deactivatedAt: string | null }).deactivatedAt = T(5);
    expect(validateSnapshotChannelShard(inactiveMain).ok).toBe(false);
    const mainWithNative = validShard();
    (mainWithNative.participants[0] as { nativeProvenance: string[] }).nativeProvenance = [""];
    expect(validateSnapshotChannelShard(mainWithNative).ok).toBe(false);
    const mainRegisteredLate = validShard();
    (mainRegisteredLate.participants[0] as { registeredAt: string }).registeredAt = T(4);
    expect(validateSnapshotChannelShard(mainRegisteredLate).ok).toBe(false);
  });

  it("refuses cross-roster senders, relay targets, and assignments, and late flags without assignments", () => {
    const foreignSender = validShard();
    (foreignSender.messages[0] as { senderParticipantId: string }).senderParticipantId = OTHER_MAIN;
    expect(validateSnapshotChannelShard(foreignSender).ok).toBe(false);
    const foreignRelay = validShard();
    (foreignRelay.messages[0] as { relayToParticipantId: string }).relayToParticipantId = OTHER_MAIN;
    expect(validateSnapshotChannelShard(foreignRelay).ok).toBe(false);
    const foreignAssignment = validShard();
    (foreignAssignment.messages[0] as { assignmentId: string | null }).assignmentId =
      "30000000-0000-4000-8000-0000000000ff";
    expect(validateSnapshotChannelShard(foreignAssignment).ok).toBe(false);
    const lateWithoutAssignment = validShard();
    (lateWithoutAssignment.messages[0] as { assignmentLate: boolean }).assignmentLate = true;
    (lateWithoutAssignment.messages[0] as { assignmentId: string | null }).assignmentId = null;
    expect(validateSnapshotChannelShard(lateWithoutAssignment).ok).toBe(false);
    const relayWithoutTarget = validShard();
    (relayWithoutTarget.messages[0] as { relayToParticipantId: string | null }).relayToParticipantId = null;
    expect(validateSnapshotChannelShard(relayWithoutTarget).ok).toBe(false);
    const targetOnReport = validShard();
    (targetOnReport.messages[1] as { relayToParticipantId: string | null }).relayToParticipantId = WORKER;
    expect(validateSnapshotChannelShard(targetOnReport).ok).toBe(false);
  });

  it("refuses handled and unhandled field-shape violations", () => {
    const unhandledWithNote = validShard();
    (unhandledWithNote.messages[0] as { handleNote: string | null }).handleNote = "note";
    expect(validateSnapshotChannelShard(unhandledWithNote).ok).toBe(false);
    const handledWithoutTime = validShard();
    (handledWithoutTime.messages[1] as { handledAt: string | null }).handledAt = null;
    expect(validateSnapshotChannelShard(handledWithoutTime).ok).toBe(false);
    const userWithParticipant = validShard();
    (userWithParticipant.messages[2] as { handledByParticipantId: string | null }).handledByParticipantId = MAIN;
    expect(validateSnapshotChannelShard(userWithParticipant).ok).toBe(false);
  });

  it("enforces the closed inline body rules and the fixed inline threshold", () => {
    for (const body of ["", " ", "\uFEFF", "\u0000", "\uD800ok", `${"x".repeat(65537)}`]) {
      const shard = validShard();
      (shard.messages[0] as { bodyContent: { inline: string } }).bodyContent = { inline: body };
      expect(validateSnapshotChannelShard(shard).ok).toBe(false);
    }
    const threshold = validShard();
    (threshold.messages[0] as { bodyContent: { inline: string } }).bodyContent = { inline: "x".repeat(65536) };
    expect(validateSnapshotChannelShard(threshold).ok).toBe(true);
  });

  it("refuses file-backed bodies outside their own Channel identity path", () => {
    const foreign = validShard();
    foreign.messages[2]!.bodyContent = {
      contentPath: `content/channel/${OTHER_CHANNEL}/${CONTENT_ID}`,
      sizeBytes: FILE_BODY.length,
      sha256: FILE_SHA,
    };
    expect(validateSnapshotChannelShard(foreign).ok).toBe(false);
  });

  it("refuses unnormalized titles and labels instead of re-normalizing retained values", () => {
    const untrimmedTitle = validShard();
    untrimmedTitle.title = " Snapshot Plan ";
    expect(validateSnapshotChannelShard(untrimmedTitle).ok).toBe(false);
    const untrimmedLabel = validShard();
    (untrimmedLabel.assignments[0] as { label: string }).label = " Do B2 ";
    expect(validateSnapshotChannelShard(untrimmedLabel).ok).toBe(false);
  });

  it("refuses rosters outside their deterministic order", () => {
    const swapped = validShard();
    swapped.participants = [swapped.participants[1]!, swapped.participants[0]!, swapped.participants[2]!];
    expect(validateSnapshotChannelShard(swapped).ok).toBe(false);
    const messagesSwapped = validShard();
    messagesSwapped.messages = [
      messagesSwapped.messages[1]!,
      messagesSwapped.messages[0]!,
      messagesSwapped.messages[2]!,
    ];
    expect(validateSnapshotChannelShard(messagesSwapped).ok).toBe(false);
  });

  it("validates creator ActorRef coherence without any Project lookup", () => {
    const workspaceCreator = validShard();
    workspaceCreator.creatorKind = "unregistered_workspace";
    workspaceCreator.creatorId = "workspace-key";
    expect(validateSnapshotChannelShard(workspaceCreator).ok).toBe(true);
    const userCreator = validShard();
    userCreator.creatorKind = "user";
    userCreator.creatorId = null;
    expect(validateSnapshotChannelShard(userCreator).ok).toBe(true);
    const userWithId = validShard();
    userWithId.creatorKind = "user";
    userWithId.creatorId = CREATOR_PROJECT;
    expect(validateSnapshotChannelShard(userWithId).ok).toBe(false);
  });
});

describe("proveChannelContentBytes", () => {
  it("accepts exact bodies and finds non-whitespace beyond any bounded head", () => {
    expect(proveChannelContentBytes(FILE_BODY).ok).toBe(true);
    const beyondHead = Buffer.from(`${" ".repeat(70000)}found it`);
    expect(proveChannelContentBytes(beyondHead).ok).toBe(true);
    const bomOnly = Buffer.from([0xef, 0xbb, 0xbf, 0x62, 0x6f, 0x64, 0x79]);
    expect(proveChannelContentBytes(bomOnly).ok).toBe(true);
  });

  it("refuses invalid UTF-8, NUL, and all-whitespace bodies with typed errors", () => {
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from([0x41, 0x00, 0x42]),
      Buffer.from("   \t\r\n"),
      Buffer.from([0xef, 0xbb, 0xbf]),
    ]) {
      const proof = proveChannelContentBytes(bytes);
      expect(proof.ok).toBe(false);
      if (!proof.ok) expect(proof.error.code).toBe("VAULT_INTEGRITY_ERROR");
    }
  });
});

describe("validateSnapshotChannelContent", () => {
  it("accepts the healthy fixture through the composed format-3 validator", () => {
    const data = validChannelData();
    expect(validateSnapshotChannelContent(data, manifestFor(data)).ok).toBe(true);
    expect(validateSnapshot(data, manifestFor(data)).ok).toBe(true);
  });

  it("refuses manifest Channel counts that disagree with the shard family in both directions", () => {
    const data = validChannelData();
    const positiveCountNoShards = manifestFor({ ...data, channels: [] });
    expect(validateSnapshotChannelContent({ ...data, channels: [] }, positiveCountNoShards).ok).toBe(false);
    const zeroCountWithShards = { ...manifestFor(data), counts: { ...manifestFor(data).counts, channels: 0 } };
    expect(validateSnapshotChannelContent(data, zeroCountWithShards).ok).toBe(false);
    expect(validateSnapshot({ ...data, channels: [] }, positiveCountNoShards)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR" },
    });
  });

  it("refuses per-table identities duplicated across Channel shards", () => {
    const base = validChannelData();
    for (const duplicate of [
      { id: WORKER, role: "worker" as const },
      { id: JUDGE, role: "judge" as const },
    ]) {
      const data = { ...base, channels: [...(base.channels ?? [])] };
      const foreign = structuredClone(base.channels?.[0] as SnapshotChannelShard);
      foreign.id = OTHER_CHANNEL;
      foreign.state = "open";
      foreign.closedAt = null;
      foreign.closedByParticipantId = null;
      foreign.closedByKind = null;
      foreign.title = null;
      foreign.createdAt = T(20);
      foreign.participants = [
        {
          id: OTHER_MAIN,
          role: "main",
          handle: "other-main",
          nativeProvenance: [],
          active: true,
          registeredAt: T(20),
          deactivatedAt: null,
        },
        {
          ...duplicate,
          handle: `h-${duplicate.id}`,
          nativeProvenance: [],
          active: true,
          registeredAt: T(21),
          deactivatedAt: null,
        },
      ];
      foreign.assignments = [];
      foreign.messages = [];
      (data.channels as SnapshotChannelShard[]).push(foreign);
      const manifest = manifestFor(data);
      manifest.counts.channels = 2;
      const refused = validateSnapshotChannelContent(data, manifest);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("VAULT_INTEGRITY_ERROR");
    }
    const duplicateAssignment = { ...base, channels: [...(base.channels ?? [])] };
    const foreignAssignment = structuredClone(base.channels?.[0] as SnapshotChannelShard);
    foreignAssignment.id = OTHER_CHANNEL;
    foreignAssignment.state = "open";
    foreignAssignment.closedAt = null;
    foreignAssignment.closedByParticipantId = null;
    foreignAssignment.closedByKind = null;
    foreignAssignment.createdAt = T(20);
    foreignAssignment.participants = [
      {
        id: OTHER_MAIN,
        role: "main",
        handle: "other-main",
        nativeProvenance: [],
        active: true,
        registeredAt: T(20),
        deactivatedAt: null,
      },
    ];
    foreignAssignment.assignments = [
      {
        id: ASSIGNMENT_OPEN,
        participantId: null,
        label: "Foreign",
        state: "open",
        createdAt: T(21),
        closedAt: null,
      },
    ];
    foreignAssignment.messages = [];
    (duplicateAssignment.channels as SnapshotChannelShard[]).push(foreignAssignment);
    const assignmentManifest = manifestFor(duplicateAssignment);
    assignmentManifest.counts.channels = 2;
    expect(validateSnapshotChannelContent(duplicateAssignment, assignmentManifest).ok).toBe(false);

    const duplicateMessage = { ...base, channels: [...(base.channels ?? [])] };
    const foreignMessage = structuredClone(foreignAssignment);
    foreignMessage.assignments = [];
    foreignMessage.messages = [
      {
        id: MESSAGE_RELAY,
        senderParticipantId: OTHER_MAIN,
        kind: "report",
        bodyContent: { inline: "foreign message" },
        assignmentId: null,
        assignmentLate: false,
        relayToParticipantId: null,
        contextSession: null,
        contextNode: null,
        contextAttempt: null,
        handled: false,
        handledAt: null,
        handledByParticipantId: null,
        handledByKind: null,
        handleNote: null,
        createdAt: T(22),
      },
    ];
    (duplicateMessage.channels as SnapshotChannelShard[]).push(foreignMessage);
    const messageManifest = manifestFor(duplicateMessage);
    messageManifest.counts.channels = 2;
    expect(validateSnapshotChannelContent(duplicateMessage, messageManifest).ok).toBe(false);
  });

  it("refuses orphan, missing, digest-mismatched, and semantically invalid carried content with valid digests", () => {
    const data = validChannelData();
    const orphan = {
      ...data,
      channelContentFiles: [
        ...(data.channelContentFiles ?? []),
        { channelId: CHANNEL, contentId: "50000000-0000-4000-8000-0000000000ff", bytes: FILE_BODY },
      ],
    };
    expect(validateSnapshotChannelContent(orphan, manifestFor(orphan, { [CONTENT_PATH]: FILE_SHA })).ok).toBe(false);
    const missing = { ...data, channelContentFiles: [] };
    expect(validateSnapshotChannelContent(missing, manifestFor(missing, {})).ok).toBe(false);
    const tamperedMap = manifestFor(data, { [CONTENT_PATH]: "0".repeat(64) });
    expect(validateSnapshotChannelContent(data, tamperedMap).ok).toBe(false);
    for (const bytes of [Buffer.from([0xff]), Buffer.from("ok\0ok"), Buffer.from(" \t\r\n ")]) {
      const sha = createHash("sha256").update(bytes).digest("hex");
      const invalid = {
        ...data,
        channels: [{ ...(data.channels?.[0] as SnapshotChannelShard) }],
        channelContentFiles: [{ channelId: CHANNEL, contentId: CONTENT_ID, bytes }],
      };
      invalid.channels[0]!.messages[2]!.bodyContent = {
        contentPath: CONTENT_PATH,
        sizeBytes: bytes.length,
        sha256: sha,
      };
      const refused = validateSnapshotChannelContent(invalid, manifestFor(invalid, { [CONTENT_PATH]: sha }));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("VAULT_INTEGRITY_ERROR");
    }
  });

  it("refuses two messages naming one content record and map keys no record names", () => {
    const data = validChannelData();
    const twin = structuredClone(data.channels?.[0] as SnapshotChannelShard);
    (twin.messages[0] as { bodyContent: unknown }).bodyContent = {
      contentPath: CONTENT_PATH,
      sizeBytes: FILE_BODY.length,
      sha256: FILE_SHA,
    };
    const shared = { ...data, channels: [twin] };
    expect(validateSnapshotChannelContent(shared, manifestFor(shared)).ok).toBe(false);
    const extraMapKey = manifestFor(data, {
      [CONTENT_PATH]: FILE_SHA,
      "content/channel/10000000-0000-4000-8000-000000000001/50000000-0000-4000-8000-0000000000ff": FILE_SHA,
    });
    expect(validateSnapshotChannelContent(data, extraMapKey).ok).toBe(false);
  });
});

describe("validateSnapshotChannelHistory", () => {
  it("accepts the complete healthy ledger of the fixture", () => {
    expect(validateSnapshotChannelHistory(validEvents(), [validShard()]).ok).toBe(true);
  });

  it("refuses a ledger-only Channel event whose shard is not retained", () => {
    const events = validEvents().map((row) =>
      row.eventType === "CHANNEL_CREATED"
        ? { ...row, metadata: { channelId: OTHER_CHANNEL, mainParticipantId: MAIN } }
        : row,
    );
    const refused = validateSnapshotChannelHistory(events, [validShard()]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });

  it("refuses duplicate creation, creation actor mismatch, and creation main mismatch", () => {
    const duplicate = [...validEvents(), validEvents()[0]!];
    expect(validateSnapshotChannelHistory(duplicate, [validShard()]).ok).toBe(false);
    const actorMismatch = validEvents().map((row) =>
      row.eventType === "CHANNEL_CREATED" ? { ...row, actorKind: "user", actorId: null } : row,
    );
    expect(validateSnapshotChannelHistory(actorMismatch, [validShard()]).ok).toBe(false);
    const mainMismatch = validEvents().map((row) =>
      row.eventType === "CHANNEL_CREATED"
        ? { ...row, metadata: { channelId: CHANNEL, mainParticipantId: WORKER } }
        : row,
    );
    expect(validateSnapshotChannelHistory(mainMismatch, [validShard()]).ok).toBe(false);
  });

  it("refuses a separate registration event for the initial main and role mismatches", () => {
    const initialMainRegistered = [
      ...validEvents(),
      event(14, {
        eventType: "CHANNEL_PARTICIPANT_REGISTERED",
        createdAt: T(0),
        metadata: { channelId: CHANNEL, actingParticipantId: MAIN, participantId: MAIN, role: "worker" },
      }),
    ];
    expect(validateSnapshotChannelHistory(initialMainRegistered, [validShard()]).ok).toBe(false);
    const roleMismatch = validEvents().map((row) =>
      row.metadata instanceof Object && (row.metadata as { role?: string }).role === "worker"
        ? { ...row, metadata: { ...(row.metadata as object), role: "judge" } }
        : row,
    );
    expect(validateSnapshotChannelHistory(roleMismatch, [validShard()]).ok).toBe(false);
  });

  it("refuses missing and extra closure events and closing provenance disagreement", () => {
    const noClosure = validEvents().filter((row) => row.eventType !== "CHANNEL_CLOSED");
    expect(validateSnapshotChannelHistory(noClosure, [validShard()]).ok).toBe(false);
    const wrongTime = validEvents().map((row) =>
      row.eventType === "CHANNEL_CLOSED" ? { ...row, createdAt: T(11) } : row,
    );
    expect(validateSnapshotChannelHistory(wrongTime, [validShard()]).ok).toBe(false);
    const wrongAuthority = validEvents().map((row) =>
      row.eventType === "CHANNEL_CLOSED"
        ? { ...row, metadata: { ...(row.metadata as object), actingParticipantId: null } }
        : row,
    );
    expect(validateSnapshotChannelHistory(wrongAuthority, [validShard()]).ok).toBe(false);
    const openShard = validShard();
    openShard.state = "open";
    openShard.closedAt = null;
    openShard.closedByParticipantId = null;
    openShard.closedByKind = null;
    const openEvents = validEvents().filter((row) => row.eventType !== "CHANNEL_CLOSED");
    expect(validateSnapshotChannelHistory(openEvents, [openShard]).ok).toBe(true);
  });

  it("refuses wrong row versions, duplicate submissions, and handling/record disagreement", () => {
    const wrongSubmissionVersion = validEvents().map((row) =>
      row.eventType === "CHANNEL_MESSAGE_SUBMITTED" ? { ...row, rowVersion: 2 } : row,
    );
    expect(validateSnapshotChannelHistory(wrongSubmissionVersion, [validShard()]).ok).toBe(false);
    const duplicateSubmission = [...validEvents(), validEvents()[7]!];
    expect(validateSnapshotChannelHistory(duplicateSubmission, [validShard()]).ok).toBe(false);
    const handledOnUnhandled = validEvents().map((row) =>
      row.eventType === "CHANNEL_MESSAGE_HANDLED"
        ? { ...row, metadata: { ...(row.metadata as object), messageId: MESSAGE_RELAY } }
        : row,
    );
    expect(validateSnapshotChannelHistory(handledOnUnhandled, [validShard()]).ok).toBe(false);
    const submissionDisagreement = validEvents().map((row) =>
      row.eventType === "CHANNEL_MESSAGE_SUBMITTED" &&
      (row.metadata as { messageId: string }).messageId === MESSAGE_RELAY
        ? { ...row, metadata: { ...(row.metadata as object), assignmentLate: true } }
        : row,
    );
    expect(validateSnapshotChannelHistory(submissionDisagreement, [validShard()]).ok).toBe(false);
    const missingSubmission = validEvents().filter(
      (row) =>
        !(
          row.eventType === "CHANNEL_MESSAGE_SUBMITTED" &&
          (row.metadata as { messageId: string }).messageId === MESSAGE_RELAY
        ),
    );
    expect(validateSnapshotChannelHistory(missingSubmission, [validShard()]).ok).toBe(false);
  });

  it("refuses legacy associations, system actors, and non-main acting participants on Channel events", () => {
    const handoffAssociated = validEvents().map((row) =>
      row.eventType === "CHANNEL_CREATED" ? { ...row, handoffId: "0123abcd-0000-4000-8000-0000000000ee" } : row,
    );
    expect(validateSnapshotChannelHistory(handoffAssociated, [validShard()]).ok).toBe(false);
    const memoAssociated = validEvents().map((row) =>
      row.eventType === "CHANNEL_CREATED" ? { ...row, memoId: "0123abcd-0000-4000-8000-0000000000ee" } : row,
    );
    expect(validateSnapshotChannelHistory(memoAssociated, [validShard()]).ok).toBe(false);
    const systemActor = validEvents().map((row) =>
      row.eventType === "CHANNEL_CREATED" ? { ...row, actorKind: "system" } : row,
    );
    expect(validateSnapshotChannelHistory(systemActor, [validShard()]).ok).toBe(false);
    const nonMainActing = validEvents().map((row) =>
      row.eventType === "CHANNEL_CLOSED"
        ? { ...row, metadata: { ...(row.metadata as object), actingParticipantId: WORKER } }
        : row,
    );
    expect(validateSnapshotChannelHistory(nonMainActing, [validShard()]).ok).toBe(false);
  });

  it("refuses assignment metadata that disagrees with the retained binding", () => {
    const bindingMismatch = validEvents().map((row) =>
      row.eventType === "CHANNEL_ASSIGNMENT_CREATED" &&
      (row.metadata as { assignmentId: string }).assignmentId === ASSIGNMENT_OPEN
        ? { ...row, metadata: { ...(row.metadata as object), participantId: null } }
        : row,
    );
    expect(validateSnapshotChannelHistory(bindingMismatch, [validShard()]).ok).toBe(false);
    const deactivationOfActive = validEvents().map((row) =>
      row.eventType === "CHANNEL_PARTICIPANT_DEACTIVATED"
        ? { ...row, metadata: { ...(row.metadata as object), participantId: WORKER } }
        : row,
    );
    expect(validateSnapshotChannelHistory(deactivationOfActive, [validShard()]).ok).toBe(false);
  });
});

describe("snapshotFilesV3 Channel export", () => {
  it("writes canonical shard and content paths with counts and digests, then imports cleanly", () => {
    const data = validChannelData();
    const built = snapshotFilesV3(data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.files.some((file) => file.path === `channels/10/${CHANNEL}.json`)).toBe(true);
    expect(built.value.files.some((file) => file.path === CONTENT_PATH)).toBe(true);
    expect(built.value.files.some((file) => file.path.startsWith("snapshots/"))).toBe(false);
    expect(built.value.manifest.counts.channels).toBe(1);
    expect(built.value.manifest.contentDigests).toEqual({ [CONTENT_PATH]: FILE_SHA });
    expect(validateSnapshot(data, built.value.manifest).ok).toBe(true);
  });

  it("refuses invalid shards, orphan content, and duplicate content references before writing", () => {
    const invalidTitle = validChannelData();
    (invalidTitle.channels?.[0] as { title: string }).title = " untrimmed ";
    expect(snapshotFilesV3(invalidTitle).ok).toBe(false);
    const orphan = validChannelData();
    orphan.channelContentFiles = [
      ...(orphan.channelContentFiles ?? []),
      { channelId: CHANNEL, contentId: "50000000-0000-4000-8000-0000000000ff", bytes: Buffer.from("orphan") },
    ];
    expect(snapshotFilesV3(orphan).ok).toBe(false);
    const missing = validChannelData();
    missing.channelContentFiles = [];
    expect(snapshotFilesV3(missing).ok).toBe(false);
    const blank = validChannelData();
    const blankBytes = Buffer.from(" ");
    const blankSha = createHash("sha256").update(blankBytes).digest("hex");
    blank.channelContentFiles = [{ channelId: CHANNEL, contentId: CONTENT_ID, bytes: blankBytes }];
    ((blank.channels?.[0] as SnapshotChannelShard).messages[2] as { bodyContent: unknown }).bodyContent = {
      contentPath: CONTENT_PATH,
      sizeBytes: blankBytes.length,
      sha256: blankSha,
    };
    const blankBuilt = snapshotFilesV3(blank);
    expect(blankBuilt.ok).toBe(false);
    if (!blankBuilt.ok) expect(blankBuilt.error.code).toBe("VAULT_INTEGRITY_ERROR");
    expect(blankSha).not.toBe(FILE_SHA);
  });
});
