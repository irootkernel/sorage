import { describe, expect, it } from "vitest";
import {
  compareHandoffObservations,
  validateCommentText,
  validateHandoffObservations,
} from "../../src/reporting-commands";

describe("Handoff reporting scalar and observation admission", () => {
  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid observation %s",
    (value) => {
      for (const field of ["expectedRevision", "targetRevision", "expectedRowVersion"] as const)
        expect(validateHandoffObservations({ [field]: value })).toMatchObject({
          ok: false,
          error: { code: "HANDOFF_INVALID_INPUT" },
        });
    },
  );
  it("separates replay scalar validation from fresh required observations", () => {
    expect(validateHandoffObservations({})).toEqual({ ok: true, value: undefined });
    expect(validateHandoffObservations({}, ["expectedRowVersion"])).toMatchObject({
      ok: false,
      error: { code: "HANDOFF_INVALID_INPUT" },
    });
    expect(
      validateHandoffObservations({ expectedRowVersion: Number.MAX_SAFE_INTEGER }, ["expectedRowVersion"]),
    ).toEqual({ ok: true, value: undefined });
  });
  it("reports a stale Revision before a stale Row Version", () => {
    expect(
      compareHandoffObservations({ revision: 2, rowVersion: 4 }, { expectedRevision: 1, expectedRowVersion: 1 }),
    ).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect(
      compareHandoffObservations({ revision: 2, rowVersion: 4 }, { targetRevision: 2, expectedRowVersion: 1 }),
    ).toMatchObject({ ok: false, error: { code: "ROW_VERSION_CONFLICT" } });
  });
  it("accepts exact historical-sized text without a content-routing cap", () => {
    expect(validateCommentText(`\uFEFF ${"가".repeat(70000)}\r\n`)).toEqual({ ok: true, value: undefined });
    for (const text of ["", " \r\n", "A\0B", "\ud800", "\udfff"])
      expect(validateCommentText(text)).toMatchObject({ ok: false, error: { code: "HANDOFF_INVALID_INPUT" } });
  });
});
