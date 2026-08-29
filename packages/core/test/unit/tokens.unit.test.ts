import { describe, expect, it } from "vitest";
import { isWellFormedToken, MINIMUM_TOKEN_BYTES, rotateApiToken, tokensEqual } from "../../src/tokens";
import { appError } from "../../src/errors";

describe("token well-formedness (SEC-020)", () => {
  it("accepts base64url strings decoding to at least 32 bytes", () => {
    expect(isWellFormedToken("A".repeat(43))).toBe(true);
    expect(isWellFormedToken("A".repeat(64))).toBe(true);
  });

  it("rejects shorter material, wrong alphabets, and padding", () => {
    expect(isWellFormedToken("A".repeat(42))).toBe(false);
    expect(isWellFormedToken("A".repeat(43) + "+")).toBe(false);
    expect(isWellFormedToken("A".repeat(43) + "=")).toBe(false);
    expect(isWellFormedToken("")).toBe(false);
  });

  it("documents the minimum as 32 bytes", () => {
    expect(MINIMUM_TOKEN_BYTES).toBe(32);
  });
});

describe("constant-time equality (SEC-020)", () => {
  it("compares equal and unequal material correctly", () => {
    expect(tokensEqual("A".repeat(43), "A".repeat(43))).toBe(true);
    expect(tokensEqual("A".repeat(43), "B".repeat(43))).toBe(false);
    expect(tokensEqual("A".repeat(43), "A".repeat(42))).toBe(false);
    expect(tokensEqual("", "")).toBe(true);
  });
});

describe("the token rotate use case (SEC-020)", () => {
  it("requires the User context", () => {
    const result = rotateApiToken({ token: stubStore() }, { asUser: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("USER_CONTEXT_REQUIRED");
  });

  it("rotates through the store with the User context", () => {
    let rotated = 0;
    const result = rotateApiToken(
      {
        token: {
          path: "/tmp/api-token",
          read: () => null,
          ensure: () => ({ ok: true as const, value: { created: true } }),
          rotate: () => {
            rotated += 1;
            return { ok: true as const, value: { rotated: true as const } };
          },
        },
      },
      { asUser: true },
    );
    expect(result.ok).toBe(true);
    expect(rotated).toBe(1);
  });
});

function stubStore() {
  return {
    path: "/tmp/api-token",
    read: () => null,
    ensure: () => ({ ok: true as const, value: { created: true } }),
    rotate: () => ({ ok: false as const, error: appError("INTERNAL_ERROR", "unreachable") }),
  };
}
