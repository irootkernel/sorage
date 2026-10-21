import { describe, expect, it } from "vitest";
import {
  CHANNEL_PREVIEW_BYTES,
  channelPreviewOf,
  checkChannelBodyText,
  composeChannelRequestDigest,
  normalizeChannelTitle,
  validateChannelHandle,
  validateChannelEventMetadata,
  validateContextField,
  validateNativeProvenance,
  submitMessageReplayOnly,
  type ChannelRecoveryPorts,
  type StoredChannelSubmitReceipt,
  type AcceptedChannelBody,
} from "../../src/channels";
import { appError, err, ok } from "../../src/errors";
import { utf8ByteLength } from "../../src/content";

const BODY: AcceptedChannelBody = { kind: "text", text: "report body", sizeBytes: 11, sha256: "0".repeat(64) };

// The explicit provenance line separators, composed so this source file never
// carries a raw control scalar: LF, CR, VT, FF, NEL, LS, and PS.
const LINE_SEPARATORS = [
  "\n",
  "\r",
  "\v",
  "\f",
  String.fromCharCode(0x85),
  String.fromCharCode(0x2028),
  String.fromCharCode(0x2029),
];

describe("channel bounds and preview rules", () => {
  it("accepts null or a trimmed single-line title within the scalar and byte bounds", () => {
    expect(normalizeChannelTitle(null).ok).toBe(true);
    const trimmed = normalizeChannelTitle("  Orbit  ");
    expect(trimmed.ok && trimmed.value).toBe("Orbit");
    expect(normalizeChannelTitle("x".repeat(201)).ok).toBe(false);
    expect(normalizeChannelTitle("line\nbreak").ok).toBe(false);
    expect(normalizeChannelTitle("x".repeat(801)).ok).toBe(false);
  });

  it("keeps handle bounds identity-exact with only the empty string empty", () => {
    const handle = validateChannelHandle(" worker-1 ");
    expect(handle.ok && handle.value).toBe(" worker-1 ");
    // Whitespace and a lone byte-order mark are nonempty byte-exact handles;
    // only the empty string is empty, and control scalars stay forbidden.
    expect(validateChannelHandle("  ").ok).toBe(true);
    expect(validateChannelHandle("\uFEFF").ok).toBe(true);
    expect(validateChannelHandle("").ok).toBe(false);
    expect(validateChannelHandle("tab\there").ok).toBe(false);
    expect(validateChannelHandle(`nul${String.fromCharCode(0)}here`).ok).toBe(false);
    expect(validateChannelHandle("x".repeat(65)).ok).toBe(false);
  });

  it("records native provenance verbatim: empty entries valid, line separators refused, TAB and NUL kept", () => {
    const empty = validateNativeProvenance([""]);
    expect(empty.ok && empty.value).toEqual([""]);
    const absent = validateNativeProvenance([]);
    expect(absent.ok && absent.value).toEqual([]);
    expect(validateNativeProvenance(["tab\tnul\0kept", "\uFEFFbom-native"]).ok).toBe(true);
    for (const separator of LINE_SEPARATORS) {
      expect(validateNativeProvenance([`bad${separator}entry`]).ok).toBe(false);
    }
    expect(validateNativeProvenance([`bad${String.fromCharCode(0xd800)}surrogate`]).ok).toBe(false);
    expect(validateNativeProvenance(["a", "b", "c", "d", "e"]).ok).toBe(false);
    expect(validateNativeProvenance(["x".repeat(257)]).ok).toBe(false);
  });

  it("keeps context verbatim under the same provenance single-line rule", () => {
    expect(validateContextField("tab\tnul\0verbatim").ok).toBe(true);
    const empty = validateContextField("");
    expect(empty.ok && empty.value).toBe("");
    const absent = validateContextField(null);
    expect(absent.ok && absent.value).toBeNull();
    for (const separator of LINE_SEPARATORS) {
      expect(validateContextField(`ctx${separator}line`).ok).toBe(false);
    }
    expect(validateContextField(`bad${String.fromCharCode(0xdfff)}surrogate`).ok).toBe(false);
    expect(validateContextField("x".repeat(201)).ok).toBe(false);
    expect(validateContextField("x".repeat(801)).ok).toBe(false);
  });

  it("rejects a blank-after-trim or NUL body and bounds the accepted size", () => {
    expect(checkChannelBodyText(" \r\n\t ", 1024).ok).toBe(false);
    expect(checkChannelBodyText("report", 1024).ok).toBe(true);
    // The NUL is composed, never a raw byte in this source file.
    const nulBody = `bad${String.fromCharCode(0)}body`;
    const nul = checkChannelBodyText(nulBody, 1024);
    expect(nul.ok).toBe(false);
    expect(!nul.ok && nul.error.code).toBe("CHN_INVALID_INPUT");
    const tooLarge = checkChannelBodyText("x".repeat(11), 10);
    expect(tooLarge.ok).toBe(false);
    expect(!tooLarge.ok && tooLarge.error.code).toBe("CHN_TOO_LARGE");
  });

  it("truncates the preview at the 512-byte scalar boundary with an honest flag", () => {
    const ascii = channelPreviewOf("x".repeat(600), 600);
    expect(ascii.bodyPreview.length).toBe(CHANNEL_PREVIEW_BYTES);
    expect(ascii.bodyPreviewTruncated).toBe(true);
    // 171 three-byte scalars are 513 bytes: the rule admits 170 of them (510
    // bytes) and marks truncation against the 513-byte total.
    const multibyte = channelPreviewOf("\uc544".repeat(171), 513);
    expect(utf8ByteLength(multibyte.bodyPreview)).toBe(510);
    expect(multibyte.bodyPreviewTruncated).toBe(true);
    const exact = channelPreviewOf("short", 5);
    expect(exact.bodyPreviewTruncated).toBe(false);
  });
});

describe("channel request identity", () => {
  it("binds the accepted body's captured identity deterministically", () => {
    const base = {
      operation: "channel-submit",
      installationId: "11111111-2222-4333-8444-555555555555",
      channelId: "aaaaaaaa-0000-4000-8000-000000000001",
      fields: { kind: "report" as const },
    };
    const first = composeChannelRequestDigest({ ...base, body: { sha256: "a".repeat(64), sizeBytes: 3 } });
    expect(composeChannelRequestDigest({ ...base, body: { sha256: "a".repeat(64), sizeBytes: 3 } })).toBe(first);
    expect(composeChannelRequestDigest({ ...base, body: { sha256: "b".repeat(64), sizeBytes: 3 } })).not.toBe(first);
    expect(
      composeChannelRequestDigest({
        ...base,
        fields: { kind: "question" as const },
        body: { sha256: "a".repeat(64), sizeBytes: 3 },
      }),
    ).not.toBe(first);
  });
});

describe("channel event metadata closed shapes", () => {
  it("accepts the exact creation metadata and rejects any drift", () => {
    const created = {
      channelId: "aaaaaaaa-0000-4000-8000-000000000001",
      mainParticipantId: "bbbbbbbb-0000-4000-8000-000000000002",
    };
    expect(validateChannelEventMetadata("CHANNEL_CREATED", created).ok).toBe(true);
    expect(validateChannelEventMetadata("CHANNEL_CREATED", { ...created, extra: 1 }).ok).toBe(false);
    expect(validateChannelEventMetadata("CHANNEL_CREATED", { channelId: created.channelId }).ok).toBe(false);
    expect(validateChannelEventMetadata("CHANNEL_CREATED", { ...created, mainParticipantId: "not-a-uuid" }).ok).toBe(
      false,
    );
  });

  it("pins submission row version 1, handling row version 2, and worker/judge registration only", () => {
    const submission = {
      channelId: "aaaaaaaa-0000-4000-8000-000000000001",
      participantId: "bbbbbbbb-0000-4000-8000-000000000002",
      messageId: "cccccccc-0000-4000-8000-000000000003",
      kind: "relay_request" as const,
      assignmentId: null,
      assignmentLate: false,
      relayToParticipantId: "dddddddd-0000-4000-8000-000000000004",
      processingRowVersion: 1,
    };
    expect(validateChannelEventMetadata("CHANNEL_MESSAGE_SUBMITTED", submission).ok).toBe(true);
    expect(
      validateChannelEventMetadata("CHANNEL_MESSAGE_SUBMITTED", { ...submission, processingRowVersion: 2 }).ok,
    ).toBe(false);
    expect(
      validateChannelEventMetadata("CHANNEL_MESSAGE_HANDLED", {
        channelId: submission.channelId,
        actingParticipantId: null,
        messageId: submission.messageId,
        processingRowVersion: 2,
      }).ok,
    ).toBe(true);
    expect(
      validateChannelEventMetadata("CHANNEL_PARTICIPANT_REGISTERED", {
        channelId: submission.channelId,
        actingParticipantId: null,
        participantId: submission.participantId,
        role: "main",
      }).ok,
    ).toBe(false);
  });
});

describe("channel submit replay-only", () => {
  const input = {
    installationId: "11111111-2222-4333-8444-555555555555",
    maxBytes: 1024,
    channelId: "aaaaaaaa-0000-4000-8000-000000000001",
    senderParticipantId: "bbbbbbbb-0000-4000-8000-000000000002",
    kind: "report" as const,
    accepted: BODY,
    idempotencyKey: "key-1",
  };

  function recovery(observation: {
    installationId: string;
    migrationVersion: number;
    receipt?: StoredChannelSubmitReceipt | null;
  }): ChannelRecoveryPorts {
    return {
      clock: { now: () => new Date("2026-10-20T00:00:00.000Z") },
      bodies: {
        proveAcceptedNonBlank: () => ok(undefined),
        readAcceptedPreviewSeed: () => ok(""),
      },
      inspect: (consume) =>
        consume({
          installationId: observation.installationId,
          migrationVersion: observation.migrationVersion,
          receipts: {
            submitReceipt: () => ok(observation.receipt ?? null),
          },
          contentState: () => ok({ representation: "file", materialized: true }),
        }),
    };
  }

  const digest = composeChannelRequestDigest({
    operation: "channel-submit",
    installationId: input.installationId,
    channelId: input.channelId,
    fields: {
      senderParticipantId: input.senderParticipantId,
      kind: input.kind,
      assignmentId: null,
      relayToParticipantId: null,
      contextSession: null,
      contextNode: null,
      contextAttempt: null,
    },
    body: { sha256: BODY.sha256, sizeBytes: BODY.sizeBytes },
  });

  it("refuses a database below the channel floor with STORAGE_SCHEMA_UNSUPPORTED", () => {
    const outcome = submitMessageReplayOnly(
      recovery({ installationId: input.installationId, migrationVersion: 10 }),
      input,
    );
    expect(!outcome.ok && outcome.error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
  });

  it("replays the retained original outcome before any live-state eligibility", () => {
    const receipt: StoredChannelSubmitReceipt = {
      requestHash: digest,
      message: validOriginalSummary(),
    };
    const outcome = submitMessageReplayOnly(
      recovery({ installationId: input.installationId, migrationVersion: 11, receipt }),
      input,
    );
    expect(outcome.ok && outcome.value.message.handled).toBe(false);
  });

  function validOriginalSummary(): StoredChannelSubmitReceipt["message"] {
    return {
      id: "cccccccc-0000-4000-8000-000000000003",
      channelId: input.channelId,
      kind: "report",
      senderParticipantId: input.senderParticipantId,
      senderHandle: "worker",
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
      processingRowVersion: 1,
      createdAt: "2026-10-20T00:00:00.000Z",
      bodyBytes: 11,
      bodyPreview: "report body",
      bodyPreviewTruncated: false,
    };
  }

  it("reports an unknown outcome for a missing receipt, a conflict for a changed request, and an integrity refusal for a malformed one", () => {
    const missing = submitMessageReplayOnly(
      recovery({ installationId: input.installationId, migrationVersion: 11 }),
      input,
    );
    expect(!missing.ok && missing.error.code).toBe("CHN_REPLAY_UNAVAILABLE");
    // A fully valid retained receipt under a different request hash conflicts;
    // the malformed receipt is a separate integrity refusal.
    const validReceipt: StoredChannelSubmitReceipt = {
      requestHash: "f".repeat(64),
      message: validOriginalSummary(),
    };
    const conflict = submitMessageReplayOnly(
      recovery({ installationId: input.installationId, migrationVersion: 11, receipt: validReceipt }),
      input,
    );
    expect(!conflict.ok && conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const malformed: StoredChannelSubmitReceipt = {
      requestHash: digest,
      message: {} as StoredChannelSubmitReceipt["message"],
    };
    const refused = submitMessageReplayOnly(
      recovery({ installationId: input.installationId, migrationVersion: 11, receipt: malformed }),
      input,
    );
    expect(!refused.ok && refused.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    const otherInstallation = submitMessageReplayOnly(
      recovery({ installationId: "99999999-9999-4999-8999-999999999999", migrationVersion: 11, receipt: validReceipt }),
      input,
    );
    expect(!otherInstallation.ok && otherInstallation.error.code).toBe("CHN_REPLAY_UNAVAILABLE");
  });

  it("rejects a blank accepted body before any inspection", () => {
    const blank = submitMessageReplayOnly(recovery({ installationId: input.installationId, migrationVersion: 11 }), {
      ...input,
      accepted: { kind: "text", text: "  ", sizeBytes: 2, sha256: "0".repeat(64) },
    });
    expect(!blank.ok && blank.error.code).toBe("CHN_INVALID_INPUT");
  });

  it("samples the lookup Clock inside the captured inspection so capture time cannot revive an expired receipt", () => {
    // The inspect callback models a capture that advanced the Clock by one
    // second before the receipt read runs.
    const baseMs = Date.parse("2026-10-20T00:00:00.000Z");
    let currentMs = baseMs;
    const clock = { now: () => new Date(currentMs) };
    const recoveryWithDelay: ChannelRecoveryPorts = {
      clock,
      bodies: {
        proveAcceptedNonBlank: () => ok(undefined),
        readAcceptedPreviewSeed: () => ok(BODY.text),
      },
      inspect: (consume) => {
        currentMs = baseMs + 1000;
        return consume({
          installationId: input.installationId,
          migrationVersion: 11,
          receipts: {
            // Expiry is judged against the post-capture sample: a receipt
            // expiring exactly at the sampled now is expired, and one expiring
            // strictly later is eligible.
            submitReceipt: (_key, _scope, now) => {
              const sampled = Date.parse(now);
              expect(sampled).toBe(baseMs + 1000);
              return ok({
                requestHash: digest,
                message: validOriginalSummary(),
              });
            },
          },
          contentState: () => ok({ representation: "file", materialized: true }),
        });
      },
    };
    const outcome = submitMessageReplayOnly(recoveryWithDelay, input);
    expect(outcome.ok).toBe(true);
    // Equality expiry: a receipt whose expiresAt equals the in-inspection now
    // must read as expired (CHN_REPLAY_UNAVAILABLE), never revived.
    const equalityExpired: ChannelRecoveryPorts = {
      clock,
      bodies: {
        proveAcceptedNonBlank: () => ok(undefined),
        readAcceptedPreviewSeed: () => ok(BODY.text),
      },
      inspect: (consume) => {
        currentMs = baseMs + 1000;
        return consume({
          installationId: input.installationId,
          migrationVersion: 11,
          receipts: {
            submitReceipt: (_key, _scope, now) => {
              // The strict eligibility rule the adapter's SQL applies:
              // expires_at > now, equality expired.
              const expiresAtMs = baseMs + 1000;
              return ok(
                Date.parse("2026-10-20T00:00:01.000Z") === expiresAtMs && expiresAtMs > Date.parse(now)
                  ? { requestHash: digest, message: validOriginalSummary() }
                  : null,
              );
            },
          },
          contentState: () => ok({ representation: "file", materialized: true }),
        });
      },
    };
    const refused = submitMessageReplayOnly(equalityExpired, input);
    expect(!refused.ok && refused.error.code).toBe("CHN_REPLAY_UNAVAILABLE");
  });

  it("rejects malformed assignment inputs without inspecting while preserving recovery for valid changed UUIDs", () => {
    let inspections = 0;
    const original = recovery({ installationId: input.installationId, migrationVersion: 11 });
    const ports: ChannelRecoveryPorts = {
      ...original,
      inspect: (consume) => {
        inspections += 1;
        return original.inspect(consume);
      },
    };
    for (const assignmentId of ["", "not-a-uuid", 0, false, {}, []]) {
      const refused = submitMessageReplayOnly(ports, { ...input, assignmentId });
      expect(!refused.ok && refused.error.code).toBe("CHN_ASSIGNMENT_NOT_FOUND");
    }
    expect(inspections).toBe(0);
    const changedInput = { ...input, assignmentId: "dddddddd-0000-4000-8000-000000000004" };
    const unavailable = submitMessageReplayOnly(ports, changedInput);
    expect(!unavailable.ok && unavailable.error.code).toBe("CHN_REPLAY_UNAVAILABLE");
    expect(inspections).toBe(1);
    const conflict = submitMessageReplayOnly(
      recovery({
        installationId: input.installationId,
        migrationVersion: 11,
        receipt: { requestHash: digest, message: validOriginalSummary() },
      }),
      changedInput,
    );
    expect(!conflict.ok && conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("keeps relay-target parity with the normal submit path before any inspection", () => {
    const missingTarget = submitMessageReplayOnly(
      recovery({ installationId: input.installationId, migrationVersion: 11 }),
      { ...input, kind: "relay_request" as const, relayToParticipantId: undefined },
    );
    expect(!missingTarget.ok && missingTarget.error.code).toBe("CHN_INVALID_INPUT");
    const forbiddenTarget = submitMessageReplayOnly(
      recovery({ installationId: input.installationId, migrationVersion: 11 }),
      { ...input, relayToParticipantId: "dddddddd-0000-4000-8000-000000000004" },
    );
    expect(!forbiddenTarget.ok && forbiddenTarget.error.code).toBe("CHN_INVALID_INPUT");
  });

  it("returns an inline recorded outcome with false and never probes", () => {
    let probes = 0;
    const base = recovery({
      installationId: input.installationId,
      migrationVersion: 11,
      receipt: { requestHash: digest, message: validOriginalSummary() },
    });
    const ports: ChannelRecoveryPorts = {
      ...base,
      inspect: (consume) =>
        base.inspect((observation) =>
          consume({
            ...observation,
            contentState: () => {
              probes += 1;
              return err(appError("STORAGE_INTEGRITY_ERROR", "probe must not run for inline content"));
            },
          }),
        ),
    };
    const outcome = submitMessageReplayOnly(ports, input);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.contentActivating).toBe(false);
      expect(outcome.value.message).toEqual(validOriginalSummary());
    }
    expect(probes).toBe(0);
  });

  it("derives a file-backed recorded outcome read-only and discloses an unobservable state", () => {
    const spool: AcceptedChannelBody = {
      kind: "spool",
      spoolPath: "/spool/original",
      sizeBytes: 70_000,
      sha256: "e".repeat(64),
    };
    const fields = {
      senderParticipantId: input.senderParticipantId,
      kind: "report" as const,
      assignmentId: null,
      relayToParticipantId: null,
      contextSession: null,
      contextNode: null,
      contextAttempt: null,
    };
    const spoolDigest = composeChannelRequestDigest({
      operation: "channel-submit",
      installationId: input.installationId,
      channelId: input.channelId,
      fields,
      body: { sha256: spool.sha256, sizeBytes: spool.sizeBytes },
    });
    const recorded = { ...validOriginalSummary(), bodyBytes: 70_000, bodyPreview: "", bodyPreviewTruncated: true };
    const withState = (
      state: { representation: "inline" | "file"; materialized: boolean } | null,
      warnings: string[],
    ): ChannelRecoveryPorts => {
      const base = recovery({
        installationId: input.installationId,
        migrationVersion: 11,
        receipt: { requestHash: spoolDigest, message: recorded },
      });
      return {
        ...base,
        warnings: (text) => warnings.push(text),
        inspect: (consume) =>
          base.inspect((observation) =>
            consume({
              ...observation,
              contentState: () =>
                state === null
                  ? err(
                      appError(
                        "STORAGE_INTEGRITY_ERROR",
                        "The committed Channel message or its content record is missing.",
                      ),
                    )
                  : ok(state),
            }),
          ),
      };
    };
    const observed = [
      withState({ representation: "file", materialized: true }, []),
      withState({ representation: "file", materialized: false }, []),
    ];
    const materialized = submitMessageReplayOnly(observed[0] as ChannelRecoveryPorts, { ...input, accepted: spool });
    expect(materialized.ok && materialized.value.contentActivating).toBe(false);
    const unmaterialized = submitMessageReplayOnly(observed[1] as ChannelRecoveryPorts, { ...input, accepted: spool });
    expect(unmaterialized.ok && unmaterialized.value.contentActivating).toBe(true);
    const warnings: string[] = [];
    const unobservable = submitMessageReplayOnly(withState(null, warnings), { ...input, accepted: spool });
    expect(unobservable.ok).toBe(true);
    if (unobservable.ok) {
      expect(unobservable.value.contentActivating).toBe(true);
      expect(unobservable.value.message).toEqual(recorded);
    }
    expect(warnings).toEqual([
      `the content-state probe for message ${recorded.id} failed (The committed Channel message or its content record is missing.); activation is not confirmed and contentActivating is reported as true`,
    ]);
  });

  it("keeps receipt-validation results without probing the content state", () => {
    let probes = 0;
    const withCountingProbe = (ports: ChannelRecoveryPorts): ChannelRecoveryPorts => ({
      ...ports,
      inspect: (consume) =>
        ports.inspect((observation) =>
          consume({
            ...observation,
            contentState: () => {
              probes += 1;
              return ok({ representation: "file", materialized: false });
            },
          }),
        ),
    });
    const conflict = submitMessageReplayOnly(
      withCountingProbe(
        recovery({
          installationId: input.installationId,
          migrationVersion: 11,
          receipt: { requestHash: "f".repeat(64), message: validOriginalSummary() },
        }),
      ),
      input,
    );
    expect(!conflict.ok && conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const missing = submitMessageReplayOnly(
      withCountingProbe(recovery({ installationId: input.installationId, migrationVersion: 11 })),
      input,
    );
    expect(!missing.ok && missing.error.code).toBe("CHN_REPLAY_UNAVAILABLE");
    const malformed = submitMessageReplayOnly(
      withCountingProbe(
        recovery({
          installationId: input.installationId,
          migrationVersion: 11,
          receipt: { requestHash: digest, message: {} as StoredChannelSubmitReceipt["message"] },
        }),
      ),
      input,
    );
    expect(!malformed.ok && malformed.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(probes).toBe(0);
  });
});
