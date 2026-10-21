import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_RETRY_BASE_MS,
  CHANNEL_RETRY_MAX_DELAY_MS,
  CHANNEL_WRITE_ATTEMPTS,
  type ChannelBodyPorts,
  type ChannelCommandPorts,
  type ChannelTransaction,
  composeChannelRequestDigest,
  type MessageListCapture,
  submitMessage,
} from "../../src/channels";
import { appError, err, ok, type Result } from "../../src/errors";
import type { ActorRef } from "../../src/events";

/**
 * TASK-114 section 5.3 deterministic tests 1 to 5: the bounded external-commit
 * backoff is full jitter over the measured base, uses the injected random and
 * sleep ports, sleeps only between external-commit attempts, never delays a
 * path-change or non-coherence result, and preserves the accepted input, hash,
 * key, fence, version capture and restaging across a binding change.
 */

const INSTALLATION = "11111111-2222-4333-8444-555555555555";
const CHANNEL_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const MAIN_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const SENDER_ID = "cccccccc-0000-4000-8000-000000000003";
const ACTOR: ActorRef = { kind: "user", id: null };
const INLINE_BODY = "retry body";
const FILE_BODY = "file-backed retry body";

const EXHAUSTION_MESSAGE =
  "A coherent storage state could not be established while this Channel operation was being prepared; this invocation committed nothing";

interface AttemptScript {
  outcome: "mismatch" | "succeed" | "closed";
  classification?: "external-commit" | "vault-path-changed";
  bindingPath?: string;
}

interface StagedCall {
  binding: { vaultPath: string };
  accepted: object;
}

interface RecordedReceipt {
  key: string;
  scope: string;
  requestHash: string;
  summary: Record<string, unknown>;
}

interface FakeState {
  scripts: AttemptScript[];
  random: number[];
  attempts: number;
  sleeps: number[];
  randomCalls: number;
  versionCaptures: number;
  moveLockChecks: number;
  classifyCalls: number;
  staged: StagedCall[];
  receipts: RecordedReceipt[];
  messages: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  events: string[];
}

function mismatch(): Result<never> {
  return err({ ...appError("SERVICE_PAUSED", "another connection committed"), details: { coherenceMismatch: true } });
}

function fakePorts(options: {
  scripts: AttemptScript[];
  random: number[];
  accepted: Parameters<typeof submitMessage>[1]["accepted"];
}): { ports: ChannelCommandPorts; state: FakeState } {
  const state: FakeState = {
    scripts: options.scripts,
    random: options.random,
    attempts: 0,
    sleeps: [],
    randomCalls: 0,
    versionCaptures: 0,
    moveLockChecks: 0,
    classifyCalls: 0,
    staged: [],
    receipts: [],
    messages: [],
    plans: [],
    events: [],
  };
  const channel = {
    id: CHANNEL_ID,
    title: "Retry channel",
    state: "open" as const,
    creatorKind: "registered_project" as const,
    creatorId: INSTALLATION,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    closedAt: null,
    closedByParticipantId: null,
    closedByKind: null,
  };
  const sender = {
    id: SENDER_ID,
    channelId: CHANNEL_ID,
    role: "worker" as const,
    handle: "worker-a",
    nativeProvenance: [],
    active: true,
    registeredAt: new Date(0).toISOString(),
    deactivatedAt: null,
  };
  const main = { ...sender, id: MAIN_ID, role: "main" as const, handle: "main" };
  const participants = [main, sender];
  let nextId = 0;
  const transaction: ChannelTransaction = {
    channel: (id) => ok(id === CHANNEL_ID ? channel : null),
    participants: () => ok(participants),
    participant: (_channelId, participantId) => ok(participants.find((item) => item.id === participantId) ?? null),
    participantByHandle: (_channelId, handle) => ok(participants.find((item) => item.handle === handle) ?? null),
    assignment: () => ok(null),
    message: () => ok(null),
    submitReceipt: () => ok(null),
    createReceipt: () => ok(null),
    commitContent: (plan) => {
      state.plans.push(plan as unknown as Record<string, unknown>);
      return ok(undefined);
    },
    insertChannel: () => ok(undefined),
    insertParticipant: () => ok(undefined),
    insertAssignment: () => ok(undefined),
    insertMessage: (row) => {
      state.messages.push(row as unknown as Record<string, unknown>);
      return ok(undefined);
    },
    closeChannel: () => ok("unchanged"),
    deactivateParticipant: () => ok("unchanged"),
    closeAssignment: () => ok("unchanged"),
    handleMessage: () => ok("changed"),
    appendEvent: (_id, event) => {
      state.events.push(event.eventType);
      return ok(undefined);
    },
    storeSubmitReceipt: (key, scope, requestHash, summary) => {
      state.receipts.push({ key, scope, requestHash, summary: summary as unknown as Record<string, unknown> });
      return ok(undefined);
    },
    storeCreateReceipt: () => ok(undefined),
  };
  const bodies: ChannelBodyPorts = {
    readAcceptedPreviewSeed: (accepted) => ok(accepted.kind === "text" ? accepted.text : "file head"),
    proveAcceptedNonBlank: () => ok(undefined),
    readRecordPreviewSeed: () => ok("preview"),
    resolveBody: () => ok(INLINE_BODY),
    messageContentState: () =>
      ok({
        representation: options.accepted.kind === "text" ? ("inline" as const) : ("file" as const),
        materialized: true,
      }),
  };
  const ports: ChannelCommandPorts = {
    installationId: INSTALLATION,
    maxBytes: 1_048_576,
    defaultPageSize: 50,
    channels: {
      aggregate: () => ok(null),
      message: () => ok(null),
      captureChannelList: () => ok({ summaries: [], lastSortKey: null, exhausted: true }),
      captureMessageList: (): Result<MessageListCapture> => ok({ records: [], lastSortKey: null, exhausted: true }),
      run: <T>(work: (value: typeof transaction) => Result<T>): Result<T> => {
        const index = state.attempts;
        state.attempts += 1;
        const script = state.scripts[index] ?? { outcome: "succeed" as const };
        if (script.outcome === "mismatch") return mismatch() as Result<T>;
        if (script.outcome === "closed") {
          return err(appError("CHN_CLOSED", "The Channel is closed, so submissions are frozen")) as Result<T>;
        }
        return work(transaction);
      },
      inspect: (work) => work({ aggregate: () => ok(null), message: () => ok(null) }),
    },
    bodies,
    coherence: {
      captureExternalVersion: () => {
        state.versionCaptures += 1;
        return ok(state.versionCaptures);
      },
      classifyExternalChange: () => {
        state.classifyCalls += 1;
        const script = state.scripts[state.attempts - 1];
        return ok(script?.classification ?? "external-commit");
      },
      moveLockHeld: () => {
        state.moveLockChecks += 1;
        return false;
      },
    },
    backoff: {
      sleepMs: (ms) => {
        state.sleeps.push(ms);
      },
      random: () => {
        state.randomCalls += 1;
        return state.random[state.randomCalls - 1] ?? 0;
      },
    },
    staging: {
      freshBinding: () => {
        const script = state.scripts[state.attempts] ?? { outcome: "succeed" as const };
        return ok({ vaultPath: script.bindingPath ?? "/vault-a" });
      },
      stageAccepted: (accepted, binding) => {
        state.staged.push({ binding, accepted });
        return ok({
          stagedPath: `staging/${binding.vaultPath}/${state.staged.length}`,
          sizeBytes: accepted.sizeBytes,
          sha256: accepted.sha256,
        });
      },
      activateContent: () => ok({ status: "completed" as const }),
    },
    clock: { now: () => new Date(0) },
    ids: {
      next: () => {
        nextId += 1;
        return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
      },
    },
  };
  return { ports, state };
}

function acceptedText(): Parameters<typeof submitMessage>[1]["accepted"] {
  return {
    kind: "text",
    text: INLINE_BODY,
    sizeBytes: Buffer.byteLength(INLINE_BODY, "utf8"),
    sha256: createHash("sha256").update(INLINE_BODY, "utf8").digest("hex"),
  };
}

function acceptedSpool(): Parameters<typeof submitMessage>[1]["accepted"] {
  return {
    kind: "spool",
    spoolPath: "/spool/retry-body",
    sizeBytes: Buffer.byteLength(FILE_BODY, "utf8"),
    sha256: createHash("sha256").update(FILE_BODY, "utf8").digest("hex"),
  };
}

function expectedDigest(accepted: Parameters<typeof submitMessage>[1]["accepted"]): string {
  return composeChannelRequestDigest({
    operation: "channel-submit",
    installationId: INSTALLATION,
    channelId: CHANNEL_ID,
    fields: {
      senderParticipantId: SENDER_ID,
      kind: "report",
      assignmentId: null,
      relayToParticipantId: null,
      contextSession: null,
      contextNode: null,
      contextAttempt: null,
    },
    body: { sha256: accepted.sha256, sizeBytes: accepted.sizeBytes },
  });
}

function submit(ports: ChannelCommandPorts, accepted: Parameters<typeof submitMessage>[1]["accepted"]) {
  return submitMessage(ports, {
    channelId: CHANNEL_ID,
    senderParticipantId: SENDER_ID,
    kind: "report",
    accepted,
    idempotencyKey: "retry-key",
    actor: ACTOR,
  });
}

describe("TASK-114 bounded external-commit backoff", () => {
  it("delays exactly twice with full jitter, then succeeds with the same input, hash and key", () => {
    const accepted = acceptedText();
    const { ports, state } = fakePorts({
      scripts: [
        { outcome: "mismatch", classification: "external-commit" },
        { outcome: "mismatch", classification: "external-commit" },
        { outcome: "succeed" },
      ],
      random: [0.999, 0.999],
      accepted,
    });
    const result = submit(ports, accepted);
    expect(result.ok).toBe(true);
    expect(state.attempts).toBe(3);
    // Full jitter: floor(0.999 * 100) then floor(0.999 * min(200, 200)).
    expect(state.sleeps).toEqual([99, 199]);
    expect(state.sleeps.every((ms) => ms < 300)).toBe(true);
    expect(CHANNEL_RETRY_BASE_MS).toBe(100);
    expect(CHANNEL_RETRY_MAX_DELAY_MS).toBe(200);
    expect(state.versionCaptures).toBe(3);
    expect(state.moveLockChecks).toBe(3);
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]?.key).toBe("retry-key");
    expect(state.receipts[0]?.requestHash).toBe(expectedDigest(accepted));
    expect(state.messages).toHaveLength(1);
  });

  it("returns the existing coherence exhaustion after three attempts and exactly two sleeps", () => {
    const accepted = acceptedText();
    const { ports, state } = fakePorts({
      scripts: [
        { outcome: "mismatch", classification: "external-commit" },
        { outcome: "mismatch", classification: "external-commit" },
        { outcome: "mismatch", classification: "external-commit" },
      ],
      random: [0.5, 0.25],
      accepted,
    });
    const result = submit(ports, accepted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(state.attempts).toBe(CHANNEL_WRITE_ATTEMPTS);
    expect(state.sleeps).toEqual([50, 50]);
    expect(result.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(result.error.message).toBe(EXHAUSTION_MESSAGE);
    expect(result.error.details?.storageContention).toBeUndefined();
    expect(result.error.recovery?.suggestedCommand).toContain(
      "Retry the identical request with its original mode, inputs, and key",
    );
    expect(state.messages).toHaveLength(0);
    expect(state.receipts).toHaveLength(0);
  });

  it("returns a non-coherence failure immediately with no delay", () => {
    const accepted = acceptedText();
    const { ports, state } = fakePorts({
      scripts: [{ outcome: "closed" }],
      random: [0.5],
      accepted,
    });
    const result = submit(ports, accepted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHN_CLOSED");
    expect(state.attempts).toBe(1);
    expect(state.sleeps).toEqual([]);
    expect(state.versionCaptures).toBe(1);
    expect(state.moveLockChecks).toBe(1);
  });

  it("never delays a vault-path-changed retry and still reports CONFIG_CONFLICT on exhaustion", () => {
    const accepted = acceptedText();
    const { ports, state } = fakePorts({
      scripts: [
        { outcome: "mismatch", classification: "vault-path-changed" },
        { outcome: "mismatch", classification: "vault-path-changed" },
        { outcome: "mismatch", classification: "vault-path-changed" },
      ],
      random: [0.5, 0.5],
      accepted,
    });
    const result = submit(ports, accepted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(state.attempts).toBe(3);
    expect(state.sleeps).toEqual([]);
    expect(result.error.code).toBe("CONFIG_CONFLICT");
    expect(result.error.message).toBe(
      "The configuration or Vault binding changed while this Channel operation was being prepared",
    );
    expect(result.error.recovery?.suggestedCommand).toContain("Reload the configuration");
  });

  it("restages into the new binding after an external-commit retry without changing input, hash or key", () => {
    const accepted = acceptedSpool();
    const { ports, state } = fakePorts({
      scripts: [
        { outcome: "mismatch", classification: "external-commit", bindingPath: "/vault-a" },
        { outcome: "succeed", bindingPath: "/vault-b" },
      ],
      random: [0.5],
      accepted,
    });
    const result = submit(ports, accepted);
    expect(result.ok).toBe(true);
    expect(state.attempts).toBe(2);
    expect(state.sleeps).toEqual([50]);
    expect(state.versionCaptures).toBe(2);
    expect(state.moveLockChecks).toBe(2);
    expect(state.classifyCalls).toBe(1);
    expect(state.staged.map((call) => call.binding.vaultPath)).toEqual(["/vault-a", "/vault-b"]);
    // The same accepted object is restaged, not a new capture or a new body.
    expect(state.staged[0]?.accepted).toBe(state.staged[1]?.accepted);
    expect(state.staged[1]?.accepted).toBe(accepted);
    expect(state.plans).toHaveLength(1);
    expect(state.plans[0]?.kind).toBe("file");
    expect(String(state.plans[0]?.stagedPath)).toContain("/vault-b");
    expect(state.messages).toHaveLength(1);
    expect(state.receipts[0]?.key).toBe("retry-key");
    expect(state.receipts[0]?.requestHash).toBe(expectedDigest(accepted));
  });
});
