import { describe, expect, it } from "vitest";
import { ADAPTERS_PACKAGE_NAME } from "../../src/index";

describe("adapters package", () => {
  it("exposes its package identity", () => {
    expect(ADAPTERS_PACKAGE_NAME).toBe("@sorage/adapters");
  });
});
