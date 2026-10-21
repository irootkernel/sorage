import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChannelAssignmentRecord,
  type ChannelBodyPorts,
  type ChannelCommandPorts,
  type ChannelListCapture,
  type ChannelMessageRecord,
  type ChannelParticipantRecord,
  type ChannelRecoveryPorts,
  type ChannelRepository,
  type ChannelTransaction,
  channelError,
  handleChannelMessage,
  listChannelMessages,
  type MessageListCapture,
  type MessageKind,
  type StoredChannelSubmitReceipt,
  submitMessage,
  submitMessageReplayOnly,
  waitForChannelMessages,
} from "../../src/channels";
import { appError, err, ok, type Result } from "../../src/errors";
import type { ActorRef } from "../../src/events";

/**
 * The TASK-113 result semantics at the use-case level (CHN-007, CHN-012,
 * CLI-020): wait continuation across retryable listing and existence failures,
 * the three deadline outcomes, the database-observed `contentActivating` rule
 * with its contained warnings, the committed `handle` result with its
 * unavailable-preview indicator, and the state-accurate refusal texts. Time is
 * driven by an injected clock and sleep so cadence and deadlines are asserted,
 * never wall time.
 */

const INSTALLATION = "11111111-2222-4333-8444-555555555555";
const CHANNEL_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const MAIN_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const WORKER_ID = "cccccccc-0000-4000-8000-000000000003";
const ASSIGNMENT_ID = "dddddddd-0000-4000-8000-000000000004";
const USER: ActorRef = { kind: "user", id: null };
const PROJECT: ActorRef = { kind: "registered_project", id: INSTALLATION };

let nowMs = 0;
afterEach(() => {
  vi.restoreAllMocks();
});

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function messageRecord(
  id: string,
  createdAt: string,
  options: { handled?: boolean; participant?: string; assignment?: string | null } = {},
): ChannelMessageRecord {
  return {
    id,
    channelId: CHANNEL_ID,
    senderParticipantId: options.participant ?? WORKER_ID,
    senderHandle: "worker-a",
    kind: "report",
    body: {
      recordId: uuid(9_000),
      representation: "inline",
      sizeBytes: 5,
      sha256: "a".repeat(64),
      inlineText: "hello",
    },
    assignmentId: options.assignment ?? null,
    assignmentLate: false,
    relayToParticipantId: null,
    contextSession: null,
    contextNode: null,
    contextAttempt: null,
    handled: options.handled ?? false,
    handledAt: (options.handled ?? false) ? createdAt : null,
    handledByParticipantId: (options.handled ?? false) ? MAIN_ID : null,
    handledByKind: (options.handled ?? false) ? "participant" : null,
    handleNote: null,
    processingRowVersion: (options.handled ?? false) ? 2 : 1,
    createdAt,
  };
}

function listCapture(records: ChannelMessageRecord[]): MessageListCapture {
  return { records, lastSortKey: null, exhausted: true };
}

function channelListEmpty(): ChannelListCapture {
  return { summaries: [], lastSortKey: null, exhausted: true };
}

interface FakeState {
  messages: Map<string, ChannelMessageRecord>;
  contents: Map<string, { representation: "inline" | "file"; materialized: boolean }>;
  receipts: Map<string, StoredChannelSubmitReceipt>;
  events: string[];
  warnings: string[];
  probeCalls: number;
  probeFault: string | null;
  activation: "completed" | "paused" | "failed";
  listScript: Array<Result<MessageListCapture>>;
  inspectScript: Array<Result<{ aggregate: true } | null>>;
}

interface FakePorts {
  ports: ChannelCommandPorts;
  state: FakeState;
  recover(): ChannelRecoveryPorts;
}

function fakePorts(): FakePorts {
  nowMs = 0;
  const participants: ChannelParticipantRecord[] = [
    {
      id: MAIN_ID,
      channelId: CHANNEL_ID,
      role: "main",
      handle: "orchestrator",
      nativeProvenance: [],
      active: true,
      registeredAt: new Date(0).toISOString(),
      deactivatedAt: null,
    },
    {
      id: WORKER_ID,
      channelId: CHANNEL_ID,
      role: "worker",
      handle: "worker-a",
      nativeProvenance: [],
      active: true,
      registeredAt: new Date(0).toISOString(),
      deactivatedAt: null,
    },
  ];
  const assignments: ChannelAssignmentRecord[] = [
    {
      id: ASSIGNMENT_ID,
      channelId: CHANNEL_ID,
      participantId: WORKER_ID,
      label: "main-directed",
      state: "open",
      createdAt: new Date(0).toISOString(),
      closedAt: null,
    },
  ];
  const state: FakeState = {
    messages: new Map(),
    contents: new Map(),
    receipts: new Map(),
    events: [],
    warnings: [],
    probeCalls: 0,
    probeFault: null,
    activation: "completed",
    listScript: [],
    inspectScript: [],
  };
  let ids = 100;
  let externalVersion = 0;

  const channel = {
    id: CHANNEL_ID,
    title: "Epic run",
    state: "open" as const,
    creatorKind: "registered_project" as const,
    creatorId: INSTALLATION,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    closedAt: null,
    closedByParticipantId: null,
    closedByKind: null,
  };
  const aggregate = () => ({
    channel,
    participants,
    assignments,
    mainParticipantId: MAIN_ID,
    messageCount: state.messages.size,
    unhandledCount: [...state.messages.values()].filter((message) => !message.handled).length,
  });

  const transaction: ChannelTransaction = {
    channel: (id) => ok(id === CHANNEL_ID ? channel : null),
    participants: () => ok(participants),
    participant: (channelId, participantId) =>
      ok(channelId === CHANNEL_ID ? (participants.find((item) => item.id === participantId) ?? null) : null),
    participantByHandle: (channelId, handle) =>
      ok(channelId === CHANNEL_ID ? (participants.find((item) => item.handle === handle) ?? null) : null),
    assignment: (channelId, assignmentId) =>
      ok(channelId === CHANNEL_ID ? (assignments.find((item) => item.id === assignmentId) ?? null) : null),
    message: (channelId, messageId) => ok(channelId === CHANNEL_ID ? (state.messages.get(messageId) ?? null) : null),
    submitReceipt: (key) => ok(state.receipts.get(key) ?? null),
    createReceipt: () => ok(null),
    commitContent: (plan) => {
      state.contents.set(plan.contentId, {
        representation: plan.kind === "inline" ? "inline" : "file",
        materialized: plan.kind === "inline",
      });
      return ok(undefined);
    },
    insertChannel: () => ok(undefined),
    insertParticipant: () => ok(undefined),
    insertAssignment: () => ok(undefined),
    insertMessage: (row) => {
      state.messages.set(row.id, row);
      return ok(undefined);
    },
    closeChannel: () => ok("unchanged"),
    deactivateParticipant: () => ok("unchanged"),
    closeAssignment: () => ok("unchanged"),
    handleMessage: (channelId, messageId, decision) => {
      const current = state.messages.get(messageId);
      if (channelId !== CHANNEL_ID || current === undefined || current.handled) {
        return err(appError("ROW_VERSION_CONFLICT", "A handling decision has already committed for this message"));
      }
      state.messages.set(messageId, {
        ...current,
        handled: true,
        handledAt: decision.handledAt,
        handledByParticipantId: decision.handledByParticipantId,
        handledByKind: decision.handledByKind,
        handleNote: decision.handleNote,
        processingRowVersion: 2,
      });
      return ok("changed" as const);
    },
    appendEvent: (_id, event) => {
      state.events.push(event.eventType);
      return ok(undefined);
    },
    storeSubmitReceipt: (key, _scope, requestHash, summary) => {
      state.receipts.set(key, { requestHash, message: summary });
      return ok(undefined);
    },
    storeCreateReceipt: () => ok(undefined),
  };

  const repository: ChannelRepository = {
    aggregate: (channelId) => {
      const scripted = state.inspectScript.shift();
      if (scripted !== undefined) {
        if (!scripted.ok) return scripted;
        if (scripted.value === null) return ok(null);
      }
      return ok(channelId === CHANNEL_ID ? aggregate() : null);
    },
    message: (channelId, messageId) => ok(channelId === CHANNEL_ID ? (state.messages.get(messageId) ?? null) : null),
    captureChannelList: () => ok(channelListEmpty()),
    captureMessageList: (channelId, filter, _after, batchSize) => {
      const scripted = state.listScript.shift();
      if (scripted !== undefined) return scripted;
      if (channelId !== CHANNEL_ID) return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
      const filtered = [...state.messages.values()]
        .filter(
          (message) =>
            (filter.handling === "all" || (filter.handling === "handled" ? message.handled : !message.handled)) &&
            (filter.participantId === null || message.senderParticipantId === filter.participantId) &&
            (filter.assignmentId === null || message.assignmentId === filter.assignmentId) &&
            (filter.kind === null || message.kind === filter.kind),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return ok({ records: filtered.slice(0, batchSize), lastSortKey: null, exhausted: true });
    },
    run: (work, options) => {
      if (options?.expectedExternalVersion !== undefined && options.expectedExternalVersion !== externalVersion) {
        return err({ ...appError("SERVICE_PAUSED", "external change"), details: { coherenceMismatch: true } });
      }
      const result = work(transaction);
      if (result.ok) externalVersion += 1;
      return result;
    },
    inspect: (work) =>
      work({
        aggregate: (channelId) => repository.aggregate(channelId),
        message: (channelId, messageId) => repository.message(channelId, messageId),
      }),
  };

  const bodies: ChannelBodyPorts = {
    readAcceptedPreviewSeed: (accepted) => ok(accepted.kind === "text" ? accepted.text : "spool head"),
    proveAcceptedNonBlank: () => ok(undefined),
    readRecordPreviewSeed: () => ok("preview"),
    resolveBody: () => ok("hello"),
    messageContentState: (channelId, messageId) => {
      state.probeCalls += 1;
      if (state.probeFault !== null) return err(appError("STORAGE_INTEGRITY_ERROR", state.probeFault));
      const message = state.messages.get(messageId);
      if (channelId !== CHANNEL_ID || message === undefined) {
        return err(
          appError("STORAGE_INTEGRITY_ERROR", "The committed Channel message or its content record is missing."),
        );
      }
      const content = state.contents.get(message.body.recordId);
      if (content === undefined) {
        return err(
          appError("STORAGE_INTEGRITY_ERROR", "The committed Channel message or its content record is missing."),
        );
      }
      return ok(content);
    },
  };

  const ports: ChannelCommandPorts = {
    installationId: INSTALLATION,
    maxBytes: 1024 * 1024,
    defaultPageSize: 50,
    channels: repository,
    bodies,
    coherence: {
      captureExternalVersion: () => ok(externalVersion),
      classifyExternalChange: () => ok("external-commit"),
      moveLockHeld: () => false,
    },
    staging: {
      freshBinding: () => ok({ vaultPath: "/vault" }),
      stageAccepted: (accepted) =>
        ok({ stagedPath: "staging/file", sizeBytes: accepted.sizeBytes, sha256: accepted.sha256 }),
      activateContent: (input) => {
        if (state.activation === "paused") return ok({ status: "paused" });
        if (state.activation === "failed") {
          return err(appError("CONTENT_MATERIALIZING", "injected activation failure"));
        }
        const current = state.contents.get(input.contentId);
        if (current !== undefined) state.contents.set(input.contentId, { ...current, materialized: true });
        return ok({ status: "completed" });
      },
    },
    clock: { now: () => new Date(nowMs) },
    ids: {
      next: () => {
        ids += 1;
        return uuid(ids);
      },
    },
    disclosures: {
      backupEnabled: false,
      thresholdBytes: 1_000_000,
      largeContent: () => undefined,
      completionWarning: (text) => state.warnings.push(text),
    },
  };

  return {
    ports,
    state,
    recover: () => ({
      clock: { now: () => new Date(nowMs) },
      inspect: (consume) =>
        consume({
          installationId: INSTALLATION,
          migrationVersion: 11,
          receipts: { submitReceipt: (key) => ok(state.receipts.get(key) ?? null) },
          contentState: (channelId, messageId) => bodies.messageContentState(channelId, messageId),
        }),
      bodies: { proveAcceptedNonBlank: () => ok(undefined), readAcceptedPreviewSeed: () => ok("spool head") },
    }),
  };
}

const INLINE = { kind: "text" as const, text: "hello", sizeBytes: 5, sha256: "b".repeat(64) };
const FILE_BODY = { kind: "spool" as const, spoolPath: "/spool/body", sizeBytes: 70_000, sha256: "c".repeat(64) };

function inlineSubmit(ports: ChannelCommandPorts, key?: string) {
  return submitMessage(ports, {
    channelId: CHANNEL_ID,
    senderParticipantId: WORKER_ID,
    kind: "report",
    accepted: INLINE,
    actor: PROJECT,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
}

function fileSubmit(ports: ChannelCommandPorts, key?: string) {
  return submitMessage(ports, {
    channelId: CHANNEL_ID,
    senderParticipantId: WORKER_ID,
    kind: "report",
    accepted: FILE_BODY,
    actor: PROJECT,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
}

describe("waitForChannelMessages continuation", () => {
  function runWait(
    ports: ChannelCommandPorts,
    options: { intervalSeconds?: number; timeoutSeconds: number },
    filter: { participantId?: string | null; assignmentId?: string | null } = {},
  ) {
    const time = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const sleeps: number[] = [];
    try {
      const result = waitForChannelMessages(ports, CHANNEL_ID, filter, {
        intervalSeconds: options.intervalSeconds ?? 1,
        timeoutSeconds: options.timeoutSeconds,
        sleepMs: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      });
      return { result, sleeps };
    } finally {
      time.mockRestore();
    }
  }

  it("survives two retryable listing failures and returns the later arrival without a retry count", () => {
    const fake = fakePorts();
    const arrival = messageRecord(uuid(2_001), new Date(0).toISOString());
    fake.state.listScript = [
      err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy")),
      err(appError("CONTENT_MATERIALIZING", "still activating")),
      ok(listCapture([arrival])),
    ];
    const { result, sleeps } = runWait(fake.ports, { timeoutSeconds: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.messages.map((message) => message.id)).toEqual([arrival.id]);
      expect(Object.keys(result.value).sort()).toEqual(["messages", "nextCursor", "timedOut"]);
    }
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it("clears an earlier failure after a successful empty poll and then times out ordinarily", () => {
    const fake = fakePorts();
    fake.state.listScript = [err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy")), ok(listCapture([]))];
    const { result, sleeps } = runWait(fake.ports, { timeoutSeconds: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.messages).toEqual([]);
      expect(result.value.nextCursor).toBeNull();
    }
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  it("reports a retryable failure that persists at the deadline as its typed error, never as timedOut", () => {
    const fake = fakePorts();
    fake.state.listScript = [];
    const busy = (): Result<MessageListCapture> => err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy"));
    fake.ports.channels.captureMessageList = () => busy();
    const { result, sleeps } = runWait(fake.ports, { timeoutSeconds: 2 });
    expect(!result.ok && result.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it("returns a non-retryable listing failure immediately", () => {
    const fake = fakePorts();
    fake.ports.channels.captureMessageList = () => err(appError("ARTIFACT_CORRUPTED", "corrupt"));
    const { result, sleeps } = runWait(fake.ports, { timeoutSeconds: 30 });
    expect(!result.ok && result.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(sleeps).toEqual([]);
  });

  it("keeps the ordinary empty timeout at exit 0 with timedOut", () => {
    const fake = fakePorts();
    const { result, sleeps } = runWait(fake.ports, { timeoutSeconds: 0 });
    expect(result.ok && result.value.timedOut).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it("retries a transient existence-stage failure and continues to the arrival", () => {
    const fake = fakePorts();
    fake.state.inspectScript = [err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy")), ok({ aggregate: true })];
    const arrival = messageRecord(uuid(2_002), new Date(0).toISOString());
    fake.state.listScript = [ok(listCapture([])), ok(listCapture([arrival]))];
    const { result } = runWait(fake.ports, { timeoutSeconds: 10 }, { participantId: WORKER_ID });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.messages.map((message) => message.id)).toEqual([arrival.id]);
    }
  });

  it("reports a retryable existence-stage failure that persists at the deadline", () => {
    const fake = fakePorts();
    fake.state.inspectScript = Array.from({ length: 20 }, () =>
      err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy")),
    );
    const { result } = runWait(fake.ports, { timeoutSeconds: 2 }, { assignmentId: ASSIGNMENT_ID });
    expect(!result.ok && result.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
  });

  it("validates the listing input before any read or sleep, exactly as the ordinary listing does", () => {
    const fake = fakePorts();
    let reads = 0;
    const capture = fake.ports.channels.captureMessageList;
    fake.ports.channels.captureMessageList = (...args) => {
      reads += 1;
      return capture(...args);
    };
    const inspect = fake.ports.channels.inspect;
    fake.ports.channels.inspect = (work) => {
      reads += 1;
      return inspect(work);
    };
    let sleeps = 0;
    const wait = (channelId: string, filter: { kind?: MessageKind | null; participantId?: string | null }) => {
      const time = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      try {
        return waitForChannelMessages(fake.ports, channelId, filter, {
          intervalSeconds: 1,
          timeoutSeconds: 30,
          sleepMs: () => {
            sleeps += 1;
            nowMs += 1_000;
          },
        });
      } finally {
        time.mockRestore();
      }
    };
    const listKind = listChannelMessages(fake.ports, CHANNEL_ID, { kind: "bogus" });
    expect(!listKind.ok && listKind.error.code).toBe("CHN_INVALID_INPUT");
    const waitKind = wait(CHANNEL_ID, { kind: "bogus" as MessageKind });
    expect(!waitKind.ok && waitKind.error.code).toBe("CHN_INVALID_INPUT");
    if (!waitKind.ok && !listKind.ok) expect(waitKind.error.message).toBe(listKind.error.message);
    const waitChannel = wait("not-a-uuid", {});
    expect(!waitChannel.ok && waitChannel.error.code).toBe("CHN_NOT_FOUND");
    const listParticipant = listChannelMessages(fake.ports, CHANNEL_ID, { participantId: "not-a-uuid" });
    expect(!listParticipant.ok && listParticipant.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const waitParticipant = wait(CHANNEL_ID, { participantId: "not-a-uuid" });
    expect(!waitParticipant.ok && waitParticipant.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    if (!waitParticipant.ok && !listParticipant.ok) {
      expect(waitParticipant.error.message).toBe(listParticipant.error.message);
    }
    expect(sleeps).toBe(0);
    expect(reads).toBe(0);
  });

  it("fails an unknown participant or assignment filter immediately with and without --wait", () => {
    const fake = fakePorts();
    const unknown = "eeeeeeee-0000-4000-8000-000000000005";
    const nonWait = listChannelMessages(fake.ports, CHANNEL_ID, { participantId: unknown });
    expect(!nonWait.ok && nonWait.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const nonWaitAssignment = listChannelMessages(fake.ports, CHANNEL_ID, { assignmentId: unknown });
    expect(!nonWaitAssignment.ok && nonWaitAssignment.error.code).toBe("CHN_ASSIGNMENT_NOT_FOUND");
    const waits = [
      runWait(fake.ports, { timeoutSeconds: 30 }, { participantId: unknown }),
      runWait(fake.ports, { timeoutSeconds: 30 }, { assignmentId: unknown }),
    ];
    const [participantWait, assignmentWait] = waits;
    expect(participantWait !== undefined && !participantWait.result.ok).toBe(true);
    if (participantWait !== undefined && !participantWait.result.ok) {
      expect(participantWait.result.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    }
    expect(assignmentWait !== undefined && !assignmentWait.result.ok).toBe(true);
    if (assignmentWait !== undefined && !assignmentWait.result.ok) {
      expect(assignmentWait.result.error.code).toBe("CHN_ASSIGNMENT_NOT_FOUND");
    }
    expect(participantWait?.sleeps).toEqual([]);
    expect(assignmentWait?.sleeps).toEqual([]);
  });
});

describe("committed submit result and contentActivating", () => {
  it("reports false for fresh inline content without probing", () => {
    const fake = fakePorts();
    const state = fake.state;
    const result = inlineSubmit(fake.ports);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.replayed).toBe(false);
      expect(result.value.contentActivating).toBe(false);
      expect(result.value.message.bodyBytes).toBe(INLINE.sizeBytes);
    }
    expect(state.probeCalls).toBe(0);
    expect(state.warnings).toEqual([]);
  });

  it("never probes fresh inline content even when a probe fault is armed", () => {
    const fake = fakePorts();
    fake.state.probeFault = "probe must not run for inline content";
    const result = inlineSubmit(fake.ports);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contentActivating).toBe(false);
    expect(fake.state.probeCalls).toBe(0);
    expect(fake.state.warnings).toEqual([]);
  });

  it("reports false for an ordinary inline replay without probing", () => {
    const fake = fakePorts();
    const first = inlineSubmit(fake.ports, "inline-key");
    expect(first.ok).toBe(true);
    fake.state.probeFault = "probe must not run for inline content";
    const replay = inlineSubmit(fake.ports, "inline-key");
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.contentActivating).toBe(false);
    }
    expect(fake.state.probeCalls).toBe(0);
    expect(fake.state.warnings).toEqual([]);
  });

  it("returns the committed message and an observed-pending flag when activation pauses", () => {
    const fake = fakePorts();
    fake.state.activation = "paused";
    const result = fileSubmit(fake.ports);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.replayed).toBe(false);
      expect(result.value.contentActivating).toBe(true);
      expect(result.value.message.id).toBe(uuid(101));
      expect(fake.state.events).toContain("CHANNEL_MESSAGE_SUBMITTED");
    }
    expect(fake.state.warnings).toEqual([
      "the Channel message committed but its content activation paused behind a held Vault-move lock; the pending intent remains for the next process start",
    ]);
  });

  it("returns the committed message with the failure warning when activation fails", () => {
    const fake = fakePorts();
    fake.state.activation = "failed";
    const result = fileSubmit(fake.ports);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contentActivating).toBe(true);
    expect(fake.state.warnings).toEqual([
      "the Channel message committed but its content activation failed (injected activation failure); the pending intent remains for the next process start",
    ]);
  });

  it("reports false after a completed activation observed as materialized", () => {
    const fake = fakePorts();
    const result = fileSubmit(fake.ports);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contentActivating).toBe(false);
    expect(fake.state.probeCalls).toBe(1);
    expect(fake.state.warnings).toEqual([]);
  });

  it("returns true with the unconfirmed-state warning when the file-backed probe cannot observe the state", () => {
    const fake = fakePorts();
    fake.state.activation = "completed";
    fake.state.probeFault = "injected probe failure";
    const fresh = fileSubmit(fake.ports);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.value.contentActivating).toBe(true);
      expect(fresh.value.message.id).toBe(uuid(101));
    }
    expect(fake.state.warnings[0]).toBe(
      `the content-state probe for message ${uuid(101)} failed (injected probe failure); activation is not confirmed and contentActivating is reported as true`,
    );
  });

  it("returns the recorded outcome with true and the warning on an unobservable ordinary replay", () => {
    const fake = fakePorts();
    const first = fileSubmit(fake.ports, "file-key");
    expect(first.ok).toBe(true);
    fake.state.probeFault = "injected probe failure";
    fake.state.warnings.length = 0;
    const replay = fileSubmit(fake.ports, "file-key");
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.contentActivating).toBe(true);
      expect(replay.value.message.id).toBe(uuid(101));
    }
    expect(fake.state.warnings).toEqual([
      `the content-state probe for message ${uuid(101)} failed (injected probe failure); activation is not confirmed and contentActivating is reported as true`,
    ]);
  });

  it("keeps every result unchanged when the warning sink throws", () => {
    const fake = fakePorts();
    fake.state.probeFault = "injected probe failure";
    fake.ports.disclosures = {
      backupEnabled: false,
      thresholdBytes: 1_000_000,
      largeContent: () => undefined,
      completionWarning: () => {
        throw new Error("injected sink failure");
      },
    };
    const result = fileSubmit(fake.ports);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contentActivating).toBe(true);
  });

  it("reports the recorded outcome with true and the warning on an unobservable replay-only", () => {
    const fake = fakePorts();
    const first = fileSubmit(fake.ports, "file-key");
    expect(first.ok).toBe(true);
    fake.state.probeFault = "injected probe failure";
    const warnings: string[] = [];
    const result = submitMessageReplayOnly(
      { ...fake.recover(), warnings: (text) => warnings.push(text) },
      {
        installationId: INSTALLATION,
        maxBytes: fake.ports.maxBytes,
        channelId: CHANNEL_ID,
        senderParticipantId: WORKER_ID,
        kind: "report",
        accepted: FILE_BODY,
        idempotencyKey: "file-key",
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contentActivating).toBe(true);
      expect(result.value.message.id).toBe(uuid(101));
    }
    expect(warnings).toEqual([
      `the content-state probe for message ${uuid(101)} failed (injected probe failure); activation is not confirmed and contentActivating is reported as true`,
    ]);
  });
});

describe("committed handle result", () => {
  function handledOnce(fake: FakePorts) {
    const submitted = inlineSubmit(fake.ports);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("submit failed");
    return submitted.value.message.id;
  }

  it("returns the committed decision with the unavailable-preview indicator when the post-commit binding fails", () => {
    const fake = fakePorts();
    const messageId = handledOnce(fake);
    const binding = fake.ports.staging.freshBinding;
    let calls = 0;
    fake.ports.staging.freshBinding = () => {
      calls += 1;
      if (calls > 1) return err(appError("CONFIG_INVALID", "injected post-commit binding failure"));
      return binding();
    };
    const handled = handleChannelMessage(fake.ports, {
      channelId: CHANNEL_ID,
      messageId,
      assertion: { actor: USER, asUser: true },
      expectedRowVersion: 1,
    });
    expect(handled.ok).toBe(true);
    if (handled.ok) {
      expect(handled.value.bodyPreviewUnavailable).toBe(true);
      expect(handled.value.message.bodyPreview).toBe("");
      expect(handled.value.message.bodyPreviewTruncated).toBe(false);
      expect(handled.value.message.handled).toBe(true);
      expect(handled.value.message.handledByKind).toBe("user");
    }
  });

  it("returns the committed decision with the unavailable-preview indicator when the preview read fails", () => {
    const fake = fakePorts();
    const messageId = handledOnce(fake);
    fake.ports.bodies.readRecordPreviewSeed = () => err(appError("INTERNAL_ERROR", "injected preview failure"));
    const handled = handleChannelMessage(fake.ports, {
      channelId: CHANNEL_ID,
      messageId,
      assertion: { actor: USER, asUser: true },
      expectedRowVersion: 1,
    });
    expect(handled.ok).toBe(true);
    if (handled.ok) {
      expect(handled.value.bodyPreviewUnavailable).toBe(true);
      expect(handled.value.message.bodyPreview).toBe("");
    }
    expect(fake.state.messages.get(messageId)?.handled).toBe(true);
  });
});

describe("state-specific Channel refusals", () => {
  it("states the lost-response case for a handled message at the pre-handle version", () => {
    const fake = fakePorts();
    const submitted = inlineSubmit(fake.ports);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const first = handleChannelMessage(fake.ports, {
      channelId: CHANNEL_ID,
      messageId: submitted.value.message.id,
      assertion: { actor: USER, asUser: true },
      expectedRowVersion: 1,
    });
    expect(first.ok).toBe(true);
    const stale = handleChannelMessage(fake.ports, {
      channelId: CHANNEL_ID,
      messageId: submitted.value.message.id,
      assertion: { actor: USER, asUser: true },
      expectedRowVersion: 1,
    });
    expect(!stale.ok).toBe(true);
    if (!stale.ok) {
      expect(stale.error.code).toBe("ROW_VERSION_CONFLICT");
      expect(stale.error.message).toBe(
        "A handling decision has already committed for this message, possibly an earlier attempt of this same caller whose response was lost; the first handling decision is immutable",
      );
      expect(Object.keys(stale.error.details ?? {}).sort()).toEqual([
        "handledAt",
        "handledByKind",
        "handledByParticipantId",
      ]);
      expect(stale.error.recovery?.suggestedCommand).toBe(
        "The first decision is immutable and there is nothing to retry; read the recorded decision with sorage channel read <channelId> <messageId>",
      );
    }
  });

  it("names the immutable first decision for a re-handle at the current version", () => {
    const fake = fakePorts();
    const submitted = inlineSubmit(fake.ports);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(
      handleChannelMessage(fake.ports, {
        channelId: CHANNEL_ID,
        messageId: submitted.value.message.id,
        assertion: { actor: USER, asUser: true },
        expectedRowVersion: 1,
      }).ok,
    ).toBe(true);
    const current = handleChannelMessage(fake.ports, {
      channelId: CHANNEL_ID,
      messageId: submitted.value.message.id,
      assertion: { actor: USER, asUser: true },
      expectedRowVersion: 2,
    });
    expect(!current.ok).toBe(true);
    if (!current.ok) {
      expect(current.error.code).toBe("CHN_INVALID_INPUT");
      expect(current.error.message).toContain("the first handling decision is immutable");
      expect(Object.keys(current.error.details ?? {}).sort()).toEqual([
        "handledAt",
        "handledByKind",
        "handledByParticipantId",
      ]);
      expect(current.error.recovery?.suggestedCommand).toBe(
        "The first decision is immutable and there is nothing to retry; read the recorded decision with sorage channel read <channelId> <messageId>",
      );
    }
  });

  it("states the unhandled processing version for a wrong expected version", () => {
    const fake = fakePorts();
    const submitted = inlineSubmit(fake.ports);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const wrong = handleChannelMessage(fake.ports, {
      channelId: CHANNEL_ID,
      messageId: submitted.value.message.id,
      assertion: { actor: USER, asUser: true },
      expectedRowVersion: 2,
    });
    expect(!wrong.ok).toBe(true);
    if (!wrong.ok) {
      expect(wrong.error.code).toBe("ROW_VERSION_CONFLICT");
      expect(wrong.error.message).toBe(
        "The message is unhandled and its processing row version is 1; the supplied expected row version does not match",
      );
      expect(Object.keys(wrong.error.details ?? {})).toEqual([]);
      expect(wrong.error.recovery?.suggestedCommand).toBe(
        "List the message with sorage channel messages <channelId> and re-run handle with the observed processing row version",
      );
    }
  });

  it("keeps the no-fresh-key rule on the ordinary submit key conflict", () => {
    const fake = fakePorts();
    expect(inlineSubmit(fake.ports, "same-key").ok).toBe(true);
    const conflict = submitMessage(fake.ports, {
      channelId: CHANNEL_ID,
      senderParticipantId: WORKER_ID,
      kind: "report",
      accepted: { ...INLINE, text: "changed", sizeBytes: 7, sha256: "d".repeat(64) },
      actor: PROJECT,
      idempotencyKey: "same-key",
    });
    expect(!conflict.ok).toBe(true);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(conflict.error.message).toBe("The retained Channel submission key carries a different request");
      expect(Object.keys(conflict.error.details ?? {})).toEqual([]);
      expect(conflict.error.recovery?.suggestedCommand).toBe(
        "The key is retained for a different request. Replaying the identical original request returns its original outcome; a new key is legitimate only for a genuinely new intent such as a new main-directed attempt, never as recovery for an unknown outcome",
      );
    }
  });
});

describe("the Channel error surface hook", () => {
  it("replaces a read-side materializing message and fills integrity recovery", () => {
    const materializing = channelError(appError("CONTENT_MATERIALIZING", "site text", { record: "content/xx" }));
    expect(materializing.message).toBe(
      "The message itself is committed and needs no resubmission; its file-backed content has not activated yet",
    );
    expect(materializing.details).toEqual({ record: "content/xx" });
    expect(materializing.recovery?.suggestedCommand).toBe(
      "Retry the read or wait after activation; the next process start retries the pending activation, and the message needs no resubmission",
    );
    const withRecovery = { ...appError("STORAGE_INTEGRITY_ERROR", "kept"), recovery: { suggestedCommand: "kept" } };
    expect(channelError(withRecovery)).toBe(withRecovery);
    const integrity = channelError(appError("STORAGE_INTEGRITY_ERROR", "site damage"));
    expect(integrity.message).toBe("site damage");
    expect(integrity.recovery?.suggestedCommand).toBe(
      "Diagnose the installation with sorage doctor and sorage vault verify before further Channel work; any committed outcome already reported stands",
    );
  });
});
