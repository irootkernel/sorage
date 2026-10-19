import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorSpec } from "../../src/errors";
import type { SendOutcome, SentHandoff } from "../../src/handoff-commands";
import { parseSendRecoveryOutcome } from "../../src/send-recovery";

const outcomes = JSON.parse(readFileSync(new URL("./golden/send-recovery.json", import.meta.url), "utf8")) as [
  SendOutcome,
  SendOutcome,
];
const single = outcomes[0].handoffs[0] as SentHandoff;
if (typeof single.storageKey !== "string") throw new Error("The historical fixture must remain file-backed");
const singleStorageKey = single.storageKey;

describe("the additive send recovery contract", () => {
  it.each(outcomes)("checks the unchanged historical SendOutcome shape: %j", (outcome) => {
    expect(parseSendRecoveryOutcome(JSON.stringify(outcome))).toEqual({ ok: true, value: outcome });
  });
  it.each([
    ["HANDOFF_REPLAY_UNAVAILABLE", 409, 75],
    ["STORAGE_SCHEMA_UNSUPPORTED", 422, 78],
    ["STORAGE_INTEGRITY_ERROR", 409, 73],
    ["STORAGE_INSPECTION_UNAVAILABLE", 503, 75],
  ] as const)("publishes %s as HTTP-equivalent %s / exit %s without a new route", (code, httpStatus, exitCode) => {
    expect(errorSpec(code)).toMatchObject({ code, httpStatus, exitCode });
    expect(errorSpec(code).recovery?.suggestedCommand).not.toMatch(/new key|sorage send|sorage init|logs\//);
  });
  it.each([
    null,
    [],
    {},
    { ...outcomes[0], handoffs: [] },
    { ...outcomes[0], replayed: true },
    { ...outcomes[0], dispatchGroupId: "bad" },
    { ...outcomes[1], dispatchGroupId: null },
    { ...outcomes[0], dispatchGroupId: outcomes[1].dispatchGroupId },
  ])("refuses invalid top-level creation data: %j", (value) => {
    const result = parseSendRecoveryOutcome(JSON.stringify(value));
    expect(!result.ok && result.error.code).toBe("STORAGE_INTEGRITY_ERROR");
  });
  it.each([
    ["handoffId", "bad"],
    ["artifactId", "bad"],
    ["recipientSlug", ""],
    ["recipientSlug", "../recipient"],
    ["revision", 2],
    ["rowVersion", 2],
    ["reviewState", "accepted"],
    ["storageKey", "../outside"],
    ["storageKey", `${single.storageKey}/extra`],
    ["storageKey", `artifacts/${single.handoffId}/${single.artifactId}/..`],
    ["storageKey", singleStorageKey.replace("/original-1.md", "/bad\\name")],
    ["storageKey", singleStorageKey.replace("/original-1.md", "/bad\u0000name")],
    ["storageKey", singleStorageKey.replace("/original-1.md", "/")],
    ["storageKey", singleStorageKey.replace("000000000010", "000000000099")],
    ["storageKey", singleStorageKey.replace("000000000020", "000000000099")],
  ])("refuses malformed historical Handoff %s=%j", (field, value) => {
    const outcome = { ...outcomes[0], handoffs: [{ ...single, [field as string]: value }] };
    const result = parseSendRecoveryOutcome(JSON.stringify(outcome));
    expect(!result.ok && result.error.code).toBe("STORAGE_INTEGRITY_ERROR");
  });
  it.each(["handoffId", "artifactId", "recipientSlug"] as const)("refuses duplicate fan-out %s", (field) => {
    const outcome = structuredClone(outcomes[1]);
    outcome.handoffs[1] = {
      ...(outcome.handoffs[1] as SentHandoff),
      [field]: (outcome.handoffs[0] as SentHandoff)[field],
    };
    const result = parseSendRecoveryOutcome(JSON.stringify(outcome));
    expect(!result.ok && result.error.code).toBe("STORAGE_INTEGRITY_ERROR");
  });
});
