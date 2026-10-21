import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_WRITE_ATTEMPTS,
  type ChannelBodyPorts,
  type ChannelCommandPorts,
  type MessageListCapture,
  submitMessage,
} from "../../src/channels";
import { type AppError, appError, err, ok, type Result } from "../../src/errors";
import type { ActorRef } from "../../src/events";

/**
 * TASK-114 pins the observable signature of coherence-budget exhaustion
 * (EPIC-017 plan r2 section 3.4). The product exposes no structured
 * discriminant for exhaustion: it is the plain STORAGE_INSPECTION_UNAVAILABLE
 * whose exact message is asserted here and whose details never carry
 * `storageContention`. The compiled qualification classifies a refusal by
 * that same pinned text, so a wording change must fail this unit test instead
 * of silently reclassifying a different condition.
 */

const INSTALLATION = "11111111-2222-4333-8444-555555555555";
const CHANNEL_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SENDER_ID = "cccccccc-0000-4000-8000-000000000003";
const ACTOR: ActorRef = { kind: "user", id: null };
const BODY = "coherence exhaustion body";
const BODY_SHA256 = createHash("sha256").update(BODY, "utf8").digest("hex");

const EXHAUSTION_MESSAGE =
  "A coherent storage state could not be established while this Channel operation was being prepared; this invocation committed nothing";

interface RunScript {
  calls: number;
  outcomes: Array<Result<never> | null>;
}

function portsWith(script: RunScript): ChannelCommandPorts {
  const bodies: ChannelBodyPorts = {
    readAcceptedPreviewSeed: () => ok("preview"),
    proveAcceptedNonBlank: () => ok(undefined),
    readRecordPreviewSeed: () => ok("preview"),
    resolveBody: () => ok(BODY),
    messageContentState: () => ok({ representation: "inline", materialized: true }),
  };
  return {
    installationId: INSTALLATION,
    maxBytes: 1_048_576,
    defaultPageSize: 50,
    channels: {
      aggregate: () => ok(null),
      message: () => ok(null),
      captureChannelList: () => ok({ summaries: [], lastSortKey: null, exhausted: true }),
      captureMessageList: (): Result<MessageListCapture> => ok({ records: [], lastSortKey: null, exhausted: true }),
      run: <T>(): Result<T> => {
        script.calls += 1;
        const scripted = script.outcomes.shift();
        if (scripted !== undefined && scripted !== null) {
          return scripted as Result<T>;
        }
        return err(mismatch()) as Result<T>;
      },
      inspect: (work) => work({ aggregate: () => ok(null), message: () => ok(null) }),
    },
    bodies,
    coherence: {
      captureExternalVersion: () => ok(1),
      classifyExternalChange: () => ok("external-commit"),
      moveLockHeld: () => false,
    },
    backoff: {
      sleepMs: () => undefined,
      random: () => 0,
    },
    staging: {
      freshBinding: () => ok({ vaultPath: "/vault" }),
      stageAccepted: () => ok({ stagedPath: "staging/file", sizeBytes: BODY.length, sha256: BODY_SHA256 }),
      activateContent: () => ok({ status: "completed" }),
    },
    clock: { now: () => new Date(0) },
    ids: { next: () => "00000000-0000-4000-8000-0000000000ff" },
  };
}

function mismatch(): AppError {
  return {
    ...appError("SERVICE_PAUSED", "another connection committed"),
    details: { coherenceMismatch: true },
  };
}

function submit(ports: ChannelCommandPorts, idempotencyKey?: string) {
  return submitMessage(ports, {
    channelId: CHANNEL_ID,
    senderParticipantId: SENDER_ID,
    kind: "report",
    accepted: { kind: "text", text: BODY, sizeBytes: BODY.length, sha256: BODY_SHA256 },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    actor: ACTOR,
  });
}

describe("TASK-114 coherence-budget exhaustion signature", () => {
  it("pins the exact message and the absence of a contention detail after the bounded attempts", () => {
    const script: RunScript = { calls: 0, outcomes: [] };
    const ports = portsWith(script);
    const result = submit(ports, "t114-pinned-key");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(script.calls).toBe(CHANNEL_WRITE_ATTEMPTS);
    expect(CHANNEL_WRITE_ATTEMPTS).toBe(3);
    expect(result.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(result.error.message).toBe(EXHAUSTION_MESSAGE);
    expect(result.error.details?.storageContention).toBeUndefined();
    expect(result.error.recovery?.suggestedCommand).toBe(
      "Retry the identical request with its original mode, inputs, and key; this invocation committed nothing and settles no earlier unknown outcome",
    );
  });

  it("returns a non-coherence failure immediately without spending the retry budget", () => {
    const failure = { ...appError("CHN_CLOSED", "The Channel is closed, so submissions are frozen") };
    const script: RunScript = { calls: 0, outcomes: [err(failure)] };
    const result = submit(portsWith(script), "t114-closed-key");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(script.calls).toBe(1);
    expect(result.error.code).toBe("CHN_CLOSED");
  });
});
