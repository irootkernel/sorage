import { describe, expect, it } from "vitest";
import { largeContentDisclosureMessage } from "../../src/memo-commands";

/**
 * The WR2/WR3 large-content disclosure wording (SHR-011, interface 38.7): the
 * shared message names the size, the threshold, and the forever-Git retention
 * risk — describing potential retention, never claiming a backup commit or
 * push already ran — and stays single-line so the JSON-error conditional
 * append keeps one parseable envelope. The behavioral matrix (strict
 * comparison, timing, replay, no-op, throwing sink) lives in the adapter
 * integration fixture where the full port surface and real config exist.
 */

describe("large-content disclosure wording (WR2/WR3)", () => {
  it("names the size, threshold, and forever-Git retention risk without claiming a backup ran", () => {
    const message = largeContentDisclosureMessage(1_000_000, 26_214_400);
    expect(message).toContain("1000000");
    expect(message).toContain("26214400");
    expect(message).toContain("gitBackup.largeArtifactWarningBytes");
    expect(message).toContain("every committed revision");
    expect(message).not.toMatch(/backed up|pushed|backup completed|backup succeeded/);
  });

  it("stays a single line so the JSON-error conditional append keeps one document", () => {
    const message = largeContentDisclosureMessage(10, 5);
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\r");
  });
});
