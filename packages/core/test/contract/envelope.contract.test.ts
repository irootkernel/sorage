import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { errorEnvelope, protocolVersion, successEnvelope } from "../../src/index";

/**
 * Contract snapshot for the versioned envelope (NFR-003, NFR-011): the committed
 * golden files pin the exact shape, and an unreviewed change fails this suite.
 */
const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

function canonical(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("envelope contract snapshot", () => {
  it("pins the success envelope shape", () => {
    const envelope = successEnvelope({ items: [], requestId: "internal" }, "2f0ac9a0-0000-4000-8000-000000000001");
    const golden = readFileSync(`${goldenDir}success.json`, "utf8");
    expect(canonical(envelope)).toBe(golden.trimEnd());
  });

  it("pins the error envelope shape including recovery", () => {
    const envelope = errorEnvelope(
      {
        code: "CURSOR_INVALID",
        message: "The cursor does not match the supplied filter set",
        details: { cursor: true },
      },
      "2f0ac9a0-0000-4000-8000-000000000002",
    );
    const golden = readFileSync(`${goldenDir}error.json`, "utf8");
    expect(canonical(envelope)).toBe(golden.trimEnd());
  });

  it("pins the protocol version", () => {
    const golden = readFileSync(`${goldenDir}version.txt`, "utf8");
    expect(String(protocolVersion())).toBe(golden.trim());
  });
});
