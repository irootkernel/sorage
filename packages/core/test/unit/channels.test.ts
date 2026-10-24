import { describe, expect, it } from "vitest";
import type { AppError, Result } from "../../src/errors";
import {
  type AcceptedChannelBody,
  ackMessages,
  addParticipant,
  CHANNEL_NAME_BYTES,
  type ChannelCommandPorts,
  type ChannelContentPlan,
  type ChannelEventInput,
  type ChannelReader,
  type ChannelRecord,
  type ChannelRepository,
  type ChannelTransaction,
  channelBodyRoutesFile,
  channelDomainEvent,
  channelError,
  checkChannelBodyText,
  closeChannel,
  createChannel,
  isChannelUuid,
  type MessageRecord,
  normalizeChannelTitle,
  type ParticipantRecord,
  postMessage,
  removeParticipant,
  validateChannelEventMetadata,
  validateChannelHandle,
  validateChannelName,
  validateHandleNote,
  validateMessageRef,
} from "../../src/channels";
import { utf8ByteLength } from "../../src/content";
import { appError, err, ok } from "../../src/errors";

const CHANNEL = "aaaaaaaa-0000-4000-8000-000000000001";
const _CONTENT = "aaaaaaaa-0000-4000-8000-0000000000c1";
const _CONTENT_2 = "aaaaaaaa-0000-4000-8000-0000000000c2";
const STAMP = "2026-10-24T00:00:00.000Z";

const BODY: AcceptedChannelBody = { kind: "text", text: "report body", sizeBytes: 11, sha256: "a".repeat(64) };
const OTHER_BODY: AcceptedChannelBody = { kind: "text", text: "other body", sizeBytes: 10, sha256: "b".repeat(64) };

describe("channel bounds and identity rules", () => {
  it("keeps the name rule identity-exact and refuses a UUID-shaped name", () => {
    const name = validateChannelName(" worker-1 ");
    expect(name.ok && name.value).toBe(" worker-1 ");
    expect(validateChannelName("").ok).toBe(false);
    expect(validateChannelName("x".repeat(65)).ok).toBe(false);
    expect(validateChannelName("x".repeat(257)).ok).toBe(false);
    expect(validateChannelName("tab\there").ok).toBe(false);
    expect(validateChannelName(CHANNEL).ok).toBe(false);
    expect(isChannelUuid(CHANNEL)).toBe(true);
  });

  it("keeps handle bounds identity-exact with only the empty string empty", () => {
    const handle = validateChannelHandle(" worker-1 ");
    expect(handle.ok && handle.value).toBe(" worker-1 ");
    expect(validateChannelHandle("  ").ok).toBe(true);
    expect(validateChannelHandle("\uFEFF").ok).toBe(true);
    expect(validateChannelHandle("").ok).toBe(false);
    expect(validateChannelHandle("tab\there").ok).toBe(false);
    expect(validateChannelHandle(`nul${String.fromCharCode(0)}here`).ok).toBe(false);
    expect(validateChannelHandle("x".repeat(65)).ok).toBe(false);
  });

  it("accepts null or a trimmed single-line title within the bounds", () => {
    expect(normalizeChannelTitle(null).ok).toBe(true);
    const trimmed = normalizeChannelTitle("  Orbit  ");
    expect(trimmed.ok && trimmed.value).toBe("Orbit");
    expect(normalizeChannelTitle("x".repeat(201)).ok).toBe(false);
    expect(normalizeChannelTitle("line\nbreak").ok).toBe(false);
    expect(normalizeChannelTitle("x".repeat(801)).ok).toBe(false);
  });

  it("trims a supplied reference and keeps an absent one null", () => {
    const reference = validateMessageRef("  pr-42 ");
    expect(reference.ok && reference.value).toBe("pr-42");
    expect(validateMessageRef(null).ok && (validateMessageRef(null) as { value: string | null }).value).toBeNull();
    expect(validateMessageRef("x".repeat(201)).ok).toBe(false);
    expect(validateMessageRef("x".repeat(801)).ok).toBe(false);
    expect(validateMessageRef("line\nbreak").ok).toBe(false);
  });

  it("bounds the handling note and the body text", () => {
    expect(validateHandleNote(null).ok).toBe(true);
    expect(validateHandleNote("done").ok).toBe(true);
    expect(validateHandleNote("x".repeat(8001)).ok).toBe(false);
    expect(checkChannelBodyText(" \r\n\t ", 1024).ok).toBe(false);
    expect(checkChannelBodyText("report", 1024).ok).toBe(true);
    const nulBody = `bad${String.fromCharCode(0)}body`;
    expect(checkChannelBodyText(nulBody, 1024).ok).toBe(false);
    const tooLarge = checkChannelBodyText("x".repeat(11), 10);
    expect(tooLarge.ok).toBe(false);
    expect(!tooLarge.ok && tooLarge.error.code).toBe("CHN_TOO_LARGE");
  });

  it("routes a body to the Vault only above the shared inline threshold", () => {
    expect(channelBodyRoutesFile({ ...BODY, sizeBytes: 65_536, text: "x" })).toBe(false);
    expect(channelBodyRoutesFile({ ...BODY, sizeBytes: 65_537, text: "x" })).toBe(true);
  });
});

describe("closed event metadata", () => {
  it("carries the acting handle in every event and refuses any other free text", () => {
    const base = { channelId: CHANNEL, actingHandle: "main" };
    expect(validateChannelEventMetadata("CHANNEL_CREATED", { ...base, mainHandle: "main", extra: 1 }).ok).toBe(false);
    expect(validateChannelEventMetadata("CHANNEL_CREATED", { channelId: CHANNEL, actingHandle: "main" }).ok).toBe(
      false,
    );
    expect(validateChannelEventMetadata("CHANNEL_CLOSED", { ...base }).ok).toBe(true);
    expect(
      validateChannelEventMetadata("CHANNEL_PARTICIPANT_ADDED", { ...base, handle: "w1", role: "worker" }).ok,
    ).toBe(true);
    expect(
      validateChannelEventMetadata("CHANNEL_PARTICIPANT_REMOVED", { ...base, handle: "w1", role: "worker" }).ok,
    ).toBe(false);
    expect(
      validateChannelEventMetadata("CHANNEL_MESSAGE_POSTED", { ...base, seq: 1, kind: "report", toHandle: null }).ok,
    ).toBe(true);
    expect(
      validateChannelEventMetadata("CHANNEL_MESSAGE_POSTED", { ...base, seq: 1, kind: "relay_request", toHandle: "w2" })
        .ok,
    ).toBe(true);
    expect(
      validateChannelEventMetadata("CHANNEL_MESSAGE_POSTED", { ...base, seq: 1, kind: "report", toHandle: "w2" }).ok,
    ).toBe(false);
    expect(validateChannelEventMetadata("CHANNEL_MESSAGE_ACKED", { ...base, seq: 0 }).ok).toBe(false);
    expect(validateChannelEventMetadata("CHANNEL_MESSAGE_ACKED", { ...base, seq: 1.5 }).ok).toBe(false);
    expect(
      validateChannelEventMetadata("CHANNEL_CLOSED", { channelId: CHANNEL, actingHandle: "main", body: "text" }).ok,
    ).toBe(false);
  });
});

/**
 * An in-memory ChannelRepository over plain maps: the command functions' full
 * idempotency, duplicate, and event behavior runs against it, with the
 * transaction boundary recorded so tests can assert what committed.
 */
function fakeRepository() {
  const channels = new Map<string, ChannelRecord>();
  const rosters = new Map<string, Map<string, ParticipantRecord>>();
  const messages = new Map<string, MessageRecord[]>();
  const contents = new Map<string, { inlineText: string | null; storageKey: string | null; materialized: boolean }>();
  const events: Array<{ id: string; input: ChannelEventInput; createdAt: string }> = [];
  let idCounter = 0;
  const nextId = (): string => `aaaaaaaa-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;

  const insertParticipantRow = (
    channelId: string,
    handle: string,
    role: ParticipantRecord["role"],
    addedAt: string,
  ): Result<void> => {
    const roster = rosters.get(channelId) ?? new Map<string, ParticipantRecord>();
    roster.set(handle, { channelId, handle, role, addedAt, removedAt: null });
    rosters.set(channelId, roster);
    return ok(undefined);
  };

  const transaction: ChannelTransaction = {
    channelByName: (name) => ok(channels.get([...channels.values()].find((c) => c.name === name)?.id ?? "") ?? null),
    channelById: (id) => ok(channels.get(id) ?? null),
    participants: (channelId) => ok([...(rosters.get(channelId)?.values() ?? [])]),
    participant: (channelId, handle) => ok(rosters.get(channelId)?.get(handle) ?? null),
    messageBySeq: (channelId, seq) => ok(messages.get(channelId)?.find((message) => message.seq === seq) ?? null),
    pageMessages: (channelId, query, limit) =>
      ok(
        (messages.get(channelId) ?? [])
          .filter(
            (message) =>
              (query.handling === "all" || !message.handled) &&
              (query.afterSeq === null || message.seq > query.afterSeq) &&
              (query.fromHandle === null || message.senderHandle === query.fromHandle) &&
              (query.kind === null || message.kind === query.kind),
          )
          .slice(0, limit),
      ),
    counters: (channelId) => {
      const all = messages.get(channelId) ?? [];
      return ok({ total: all.length, unhandled: all.filter((message) => !message.handled).length });
    },
    findUnhandledDuplicate: (channelId, senderHandle, kind, toHandle, ref, sha) =>
      ok(
        (messages.get(channelId) ?? []).find(
          (message) =>
            !message.handled &&
            message.senderHandle === senderHandle &&
            message.kind === kind &&
            message.toHandle === toHandle &&
            message.ref === ref &&
            message.content.sha256 === sha,
        ) ?? null,
      ),
    nextSeq: (channelId) => ok((messages.get(channelId) ?? []).reduce((max, m) => Math.max(max, m.seq), 0) + 1),
    commitContent: (plan: ChannelContentPlan, _owner, createdAt) => {
      expect(createdAt).toBe(STAMP);
      contents.set(plan.contentId, {
        inlineText: plan.kind === "inline" ? plan.text : null,
        storageKey: plan.kind === "file" ? plan.storageKey : null,
        materialized: plan.kind === "inline",
      });
      return ok(undefined);
    },
    insertMessage: (row) => {
      const list = messages.get(row.channelId) ?? [];
      list.push(row);
      messages.set(row.channelId, list);
      contents.set(row.content.recordId, {
        inlineText: row.content.inlineText,
        storageKey: row.content.storageKey,
        materialized: row.content.representation === "inline",
      });
      return ok(undefined);
    },
    insertChannel: (row) => {
      channels.set(row.id, row);
      rosters.set(row.id, new Map());
      messages.set(row.id, []);
      return ok(undefined);
    },
    insertParticipant: insertParticipantRow,
    reRegisterParticipant: (channelId, handle, addedAt) => {
      const roster = rosters.get(channelId);
      const existing = roster?.get(handle);
      if (roster !== undefined && existing !== undefined) roster.set(handle, { ...existing, addedAt, removedAt: null });
      return ok(undefined);
    },
    removeParticipant: (channelId, handle, removedAt) => {
      const roster = rosters.get(channelId);
      const existing = roster?.get(handle);
      if (roster !== undefined && existing !== undefined) roster.set(handle, { ...existing, removedAt });
      return ok(undefined);
    },
    closeChannelRow: (id, closedAt) => {
      const existing = channels.get(id);
      if (existing === undefined || existing.state === "closed") return ok("unchanged" as const);
      channels.set(id, { ...existing, state: "closed", closedAt });
      return ok("changed" as const);
    },
    markHandled: (channelId, seq, handledAt, note) => {
      const list = messages.get(channelId) ?? [];
      const message = list.find((entry) => entry.seq === seq);
      if (message === undefined || message.handled) return err(appError("STORAGE_INTEGRITY_ERROR", "fake"));
      message.handled = true;
      message.handledAt = handledAt;
      message.handleNote = note;
      return ok(undefined);
    },
    appendEvent: (id, input, createdAt) => {
      const row = channelDomainEvent(id, input, createdAt);
      const checked = validateChannelEventMetadata(
        row.eventType as Parameters<typeof validateChannelEventMetadata>[0],
        row.metadata,
      );
      if (!checked.ok) return checked;
      events.push({ id, input, createdAt });
      return ok(undefined);
    },
  };

  const reader: ChannelReader = {
    channelByName: transaction.channelByName,
    channelById: transaction.channelById,
    participants: transaction.participants,
    participant: transaction.participant,
    pageMessages: transaction.pageMessages,
    counters: transaction.counters,
    listChannels: (filter) =>
      ok(
        [...channels.values()]
          .filter((channel) => filter.state === "all" || channel.state === filter.state)
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            title: channel.title,
            state: channel.state,
            main: [...(rosters.get(channel.id)?.values() ?? [])].find((p) => p.role === "main")?.handle ?? "",
            createdAt: channel.createdAt,
            closedAt: channel.closedAt,
          })),
      ),
  };

  const repository: ChannelRepository = {
    run: (work) => work(transaction),
    read: (work) => work(reader),
  };
  return { repository, channels, rosters, messages, contents, events, nextId };
}

interface Harness {
  ports: ChannelCommandPorts;
  repo: ReturnType<typeof fakeRepository>;
  activation: { status: "completed" | "paused" };
  binding: string;
  warnings: string[];
}

function harness(): Harness {
  const repo = fakeRepository();
  const activation = { status: "completed" as "completed" | "paused" };
  const binding = "/vault";
  const warnings: string[] = [];
  const ports: ChannelCommandPorts = {
    installationId: "installation",
    maxBytes: 1024 * 1024,
    defaultPageSize: 50,
    channels: repo.repository,
    bodies: {
      proveAcceptedNonBlank: () => ok(undefined),
      resolveBody: (ref) => {
        const content = repo.contents.get(ref.recordId);
        if (content === undefined) return err(appError("STORAGE_INTEGRITY_ERROR", "missing record"));
        if (content.inlineText !== null) return ok({ state: "inline" as const, text: content.inlineText });
        if (!content.materialized) return ok({ state: "pending" as const });
        return ok({ state: "materialized" as const, text: "file body", path: `/vault/${content.storageKey ?? ""}` });
      },
    },
    staging: {
      freshBinding: () => ok({ vaultPath: binding }),
      stageAccepted: (accepted) =>
        ok({ stagedPath: "staging/x", sizeBytes: accepted.sizeBytes, sha256: accepted.sha256 }),
      activateContent: () => ok({ status: activation.status }),
    },
    clock: { now: () => new Date(Date.parse(STAMP)) },
    ids: { next: repo.nextId },
    disclosures: {
      backupEnabled: false,
      thresholdBytes: 1,
      largeContent: () => {},
      completionWarning: (t) => warnings.push(t),
    },
  };
  return { ports, repo, activation, binding, warnings };
}

const unwrap = <T>(result: Result<T, AppError>): T => {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code} ${result.error.message}`);
  return result.value;
};

describe("the rebuilt command behavior", () => {
  it("creates idempotently and refuses a closed name or a different main handle", () => {
    const { ports, repo } = harness();
    const first = unwrap<{ channel: { id: string; main: string; participantCount: number }; existing: boolean }>(
      createChannel(ports, { name: "aq-run-42", main: "orchestrator" }),
    );
    expect(first.existing).toBe(false);
    expect(first.channel.main).toBe("orchestrator");
    expect(first.channel.participantCount).toBe(1);
    const repeat = unwrap(createChannel(ports, { name: "aq-run-42", main: "orchestrator" }));
    expect(repeat.existing).toBe(true);
    expect(repeat.channel.id).toBe(first.channel.id);
    const differentMain = createChannel(ports, { name: "aq-run-42", main: "other" });
    expect(differentMain.ok).toBe(false);
    expect(!differentMain.ok && differentMain.error.code).toBe("CHN_INVALID_INPUT");
    unwrap(closeChannel(ports, { channelRef: "aq-run-42" }));
    const closed = createChannel(ports, { name: "aq-run-42", main: "orchestrator" });
    expect(!closed.ok && closed.error.code).toBe("CHN_CLOSED");
    expect(repo.events.map((entry) => entry.input.type)).toEqual(["CHANNEL_CREATED", "CHANNEL_CLOSED"]);
  });

  it("adds, removes and re-adds idempotently with the role kept", () => {
    const { ports, repo } = harness();
    unwrap(createChannel(ports, { name: "c" }));
    const added = unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    expect(added.participant.removedAt).toBeNull();
    const repeat = unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    expect(repeat.participant.addedAt).toBe(added.participant.addedAt);
    const differentRole = addParticipant(ports, { channelRef: "c", handle: "w1", role: "judge" });
    expect(!differentRole.ok && differentRole.error.code).toBe("CHN_INVALID_INPUT");
    const removed = unwrap(removeParticipant(ports, { channelRef: "c", handle: "w1" }));
    expect(removed.participant.removedAt).toBe(STAMP);
    const removeRepeat = unwrap(removeParticipant(ports, { channelRef: "c", handle: "w1" }));
    expect(removeRepeat.participant.removedAt).toBe(STAMP);
    const reAdded = unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    expect(reAdded.participant.removedAt).toBeNull();
    expect(reAdded.participant.addedAt).toBe(STAMP);
    const removeMain = removeParticipant(ports, { channelRef: "c", handle: "main" });
    expect(!removeMain.ok && removeMain.error.code).toBe("CHN_INVALID_INPUT");
    const removeGhost = removeParticipant(ports, { channelRef: "c", handle: "ghost" });
    expect(!removeGhost.ok && removeGhost.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    expect(repo.events.map((entry) => entry.input.type)).toEqual([
      "CHANNEL_CREATED",
      "CHANNEL_PARTICIPANT_ADDED",
      "CHANNEL_PARTICIPANT_REMOVED",
      "CHANNEL_PARTICIPANT_ADDED",
    ]);
    const reAddedDifferentRole = addParticipant(ports, { channelRef: "c", handle: "w1", role: "judge" });
    expect(!reAddedDifferentRole.ok && reAddedDifferentRole.error.code).toBe("CHN_INVALID_INPUT");
  });

  it("proves the duplicate-by-content rule over the three identity shapes", () => {
    const { ports, repo } = harness();
    const channelId = unwrap(createChannel(ports, { name: "c" })).channel.id;
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w2", role: "judge" }));

    // Shape one: a plain report with NULL --to and NULL --ref.
    const first = unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: BODY }));
    expect(first.duplicate).toBe(false);
    expect(first.message.seq).toBe(1);
    const retry = unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: BODY }));
    expect(retry.duplicate).toBe(true);
    expect(retry.message.seq).toBe(1);

    // Shape two: a non-NULL --ref distinguishes identities.
    const withRef = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-42", accepted: BODY }),
    );
    expect(withRef.duplicate).toBe(false);
    const withRefRetry = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-42", accepted: BODY }),
    );
    expect(withRefRetry.duplicate).toBe(true);
    expect(withRefRetry.message.seq).toBe(withRef.message.seq);
    const refMiss = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-43", accepted: BODY }),
    );
    expect(refMiss.duplicate).toBe(false);

    // Shape three: a relay_request with --to; and the sender is part of the identity.
    const relay = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "relay_request", to: "w2", accepted: BODY }),
    );
    expect(relay.duplicate).toBe(false);
    const relayRetry = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "relay_request", to: "w2", accepted: BODY }),
    );
    expect(relayRetry.duplicate).toBe(true);
    const otherBody = unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: OTHER_BODY }));
    expect(otherBody.duplicate).toBe(false);
    const sameBodyOtherSender = unwrap(
      postMessage(ports, { channelRef: "c", from: "w2", kind: "report", accepted: BODY }),
    );
    expect(sameBodyOtherSender.duplicate).toBe(false);

    // An identical post after the original was handled creates a new message.
    unwrap(ackMessages(ports, { channelRef: "c", seqs: [1] }));
    const afterAck = unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: BODY }));
    expect(afterAck.duplicate).toBe(false);
    expect(afterAck.message.seq).toBeGreaterThan(1);

    // A retry after close still reports the duplicate (the check runs first);
    // only a genuinely fresh post meets the closed refusal.
    const beforeClose = repo.messages.get(channelId)?.length ?? 0;
    unwrap(closeChannel(ports, { channelRef: "c" }));
    const closedRetry = unwrap(
      postMessage(ports, { channelRef: "c", from: "w1", kind: "report", ref: "pr-42", accepted: BODY }),
    );
    expect(closedRetry.duplicate).toBe(true);
    const closedDuplicate = unwrap(postMessage(ports, { channelRef: "c", from: "w2", kind: "report", accepted: BODY }));
    expect(closedDuplicate.duplicate).toBe(true);
    const freshBody: AcceptedChannelBody = {
      kind: "text",
      text: "fresh identity",
      sizeBytes: 13,
      sha256: "e".repeat(64),
    };
    const freshAfterClose = postMessage(ports, { channelRef: "c", from: "w1", kind: "report", accepted: freshBody });
    expect(!freshAfterClose.ok && freshAfterClose.error.code).toBe("CHN_CLOSED");
    expect(repo.messages.get(channelId)?.length ?? 0).toBe(beforeClose);

    // Exactly one posting event per created message, none for duplicates.
    const posted = repo.events.filter((entry) => entry.input.type === "CHANNEL_MESSAGE_POSTED");
    expect(posted.length).toBe(repo.messages.get(channelId)?.length);
  });

  it("keeps posting upstream-only and validates the relay target", () => {
    const { ports } = harness();
    unwrap(createChannel(ports, { name: "c" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    const mainPost = postMessage(ports, { channelRef: "c", from: "main", kind: "report", accepted: BODY });
    expect(!mainPost.ok && mainPost.error.code).toBe("CHN_INVALID_INPUT");
    expect(!mainPost.ok && mainPost.error.message).toContain("upstream");
    const relayWithoutTo = postMessage(ports, { channelRef: "c", from: "w1", kind: "relay_request", accepted: BODY });
    expect(!relayWithoutTo.ok && relayWithoutTo.error.code).toBe("CHN_INVALID_INPUT");
    const toWithReport = postMessage(ports, {
      channelRef: "c",
      from: "w1",
      kind: "report",
      to: "main",
      accepted: BODY,
    });
    expect(!toWithReport.ok && toWithReport.error.code).toBe("CHN_INVALID_INPUT");
    const ghostTarget = postMessage(ports, {
      channelRef: "c",
      from: "w1",
      kind: "relay_request",
      to: "ghost",
      accepted: BODY,
    });
    expect(!ghostTarget.ok && ghostTarget.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const removedSenderHarness = harness();
    unwrap(createChannel(removedSenderHarness.ports, { name: "c" }));
    unwrap(addParticipant(removedSenderHarness.ports, { channelRef: "c", handle: "w1", role: "worker" }));
    unwrap(removeParticipant(removedSenderHarness.ports, { channelRef: "c", handle: "w1" }));
    const removed = postMessage(removedSenderHarness.ports, {
      channelRef: "c",
      from: "w1",
      kind: "report",
      accepted: BODY,
    });
    expect(!removed.ok && removed.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
  });

  it("acks all-or-nothing with alreadyHandled and immutable decisions", () => {
    const { ports, repo } = harness();
    unwrap(createChannel(ports, { name: "c" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    for (let index = 0; index < 3; index += 1) {
      unwrap(
        postMessage(ports, {
          channelRef: "c",
          from: "w1",
          kind: "report",
          accepted: { ...BODY, text: `body ${index}`, sha256: `${String(index)}`.repeat(64) },
        }),
      );
    }
    const missing = ackMessages(ports, { channelRef: "c", seqs: [1, 99] });
    expect(!missing.ok && missing.error.code).toBe("CHN_MESSAGE_NOT_FOUND");
    expect(!missing.ok && missing.error.message).toContain("99");
    const partial = unwrap(ackMessages(ports, { channelRef: "c", seqs: [1, 2], note: "reviewed" }));
    expect(partial.handled).toEqual([1, 2]);
    expect(partial.alreadyHandled).toEqual([]);
    expect(partial.note).toBe("reviewed");
    const repeat = unwrap(ackMessages(ports, { channelRef: "c", seqs: [2, 3] }));
    expect(repeat.handled).toEqual([3]);
    expect(repeat.alreadyHandled).toEqual([2]);
    const acked = repo.events.filter((entry) => entry.input.type === "CHANNEL_MESSAGE_ACKED");
    expect(acked.length).toBe(3);
    unwrap(closeChannel(ports, { channelRef: "c" }));
    const afterClose = unwrap(ackMessages(ports, { channelRef: "c", seqs: [3] }));
    expect(afterClose.alreadyHandled).toEqual([3]);
  });

  it("carries the acting handle in every emitted event", () => {
    const { ports, repo } = harness();
    unwrap(createChannel(ports, { name: "c", main: "boss" }));
    unwrap(addParticipant(ports, { channelRef: "c", handle: "w1", role: "worker" }));
    unwrap(postMessage(ports, { channelRef: "c", from: "w1", kind: "relay_request", to: "boss", accepted: BODY }));
    unwrap(ackMessages(ports, { channelRef: "c", seqs: [1] }));
    unwrap(removeParticipant(ports, { channelRef: "c", handle: "w1" }));
    unwrap(closeChannel(ports, { channelRef: "c" }));
    const byType = new Map(repo.events.map((entry) => [entry.input.type, entry.input]));
    expect((byType.get("CHANNEL_CREATED") as { actingHandle: string }).actingHandle).toBe("boss");
    expect((byType.get("CHANNEL_PARTICIPANT_ADDED") as { actingHandle: string; handle: string }).actingHandle).toBe(
      "boss",
    );
    expect((byType.get("CHANNEL_PARTICIPANT_ADDED") as { actingHandle: string; handle: string }).handle).toBe("w1");
    const posted = byType.get("CHANNEL_MESSAGE_POSTED") as { actingHandle: string; toHandle: string };
    expect(posted.actingHandle).toBe("w1");
    expect(posted.toHandle).toBe("boss");
    expect((byType.get("CHANNEL_MESSAGE_ACKED") as { actingHandle: string }).actingHandle).toBe("boss");
    expect((byType.get("CHANNEL_PARTICIPANT_REMOVED") as { actingHandle: string; handle: string }).handle).toBe("w1");
    expect((byType.get("CHANNEL_CLOSED") as { actingHandle: string }).actingHandle).toBe("boss");
  });

  it("rolls back with CONFIG_CONFLICT when the Vault binding changed after staging", () => {
    const harnessInstance = harness();
    const fileBody: AcceptedChannelBody = {
      kind: "text",
      text: "x".repeat(65_537),
      sizeBytes: 65_537,
      sha256: "c".repeat(64),
    };
    unwrap(createChannel(harnessInstance.ports, { name: "c" }));
    unwrap(addParticipant(harnessInstance.ports, { channelRef: "c", handle: "w1", role: "worker" }));
    const conflictChannelId = unwrap(createChannel(harnessInstance.ports, { name: "c" })).channel.id;
    unwrap(addParticipant(harnessInstance.ports, { channelRef: "c", handle: "w1", role: "worker" }));
    const before = harnessInstance.repo.messages.get(conflictChannelId)?.length ?? 0;
    // The staged binding differs from the in-transaction re-read.
    const original = harnessInstance.ports.staging.freshBinding;
    let calls = 0;
    harnessInstance.ports.staging.freshBinding = () => {
      calls += 1;
      return calls === 1 ? original() : ok({ vaultPath: "/moved-vault" });
    };
    const conflict = postMessage(harnessInstance.ports, {
      channelRef: "c",
      from: "w1",
      kind: "report",
      accepted: fileBody,
    });
    expect(!conflict.ok && conflict.error.code).toBe("CONFIG_CONFLICT");
    expect(harnessInstance.repo.messages.get(conflictChannelId)?.length ?? 0).toBe(before);
  });

  it("keeps a committed post with a paused activation reportable as pending (CHN-012)", () => {
    const harnessInstance = harness();
    harnessInstance.activation.status = "paused";
    const fileBody: AcceptedChannelBody = {
      kind: "text",
      text: "x".repeat(65_537),
      sizeBytes: 65_537,
      sha256: "d".repeat(64),
    };
    const pausedChannelId = unwrap(createChannel(harnessInstance.ports, { name: "c" })).channel.id;
    unwrap(addParticipant(harnessInstance.ports, { channelRef: "c", handle: "w1", role: "worker" }));
    const posted = unwrap(
      postMessage(harnessInstance.ports, { channelRef: "c", from: "w1", kind: "report", accepted: fileBody }),
    );
    expect(posted.duplicate).toBe(false);
    expect(posted.message.body).toBeNull();
    expect(posted.message.bodyPath).toBeNull();
    expect(posted.message.bodyPending).toBe(true);
    expect(harnessInstance.repo.messages.get(pausedChannelId)?.length).toBe(1);
  });

  it("refines the shared typed errors for the Channel surface", () => {
    const materializing = channelError(appError("CONTENT_MATERIALIZING", "x"));
    expect(materializing.recovery?.suggestedCommand).toContain("needs no resubmission");
    const integrity = channelError(appError("STORAGE_INTEGRITY_ERROR", "x"));
    expect(integrity.recovery?.suggestedCommand).toContain("sorage doctor");
    const schema = channelError(appError("STORAGE_SCHEMA_UNSUPPORTED", "x"));
    expect(schema.recovery?.suggestedCommand).toContain("never downgrade");
    expect(channelError(appError("CHN_NOT_FOUND", "x")).code).toBe("CHN_NOT_FOUND");
  });

  it("keeps the name bound within its byte budget", () => {
    expect(utf8ByteLength("\uc544".repeat(86))).toBeGreaterThan(CHANNEL_NAME_BYTES);
    expect(validateChannelName("\uc544".repeat(86)).ok).toBe(false);
  });
});
