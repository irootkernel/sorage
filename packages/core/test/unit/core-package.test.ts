import { describe, expect, it } from "vitest";
import { CORE_PACKAGE_NAME } from "../../src/index";

describe("core package", () => {
  it("exposes its package identity", () => {
    expect(CORE_PACKAGE_NAME).toBe("@sorage/core");
  });
});
