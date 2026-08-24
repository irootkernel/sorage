import { describe, expect, it } from "vitest";
import { CLI_NAME, main } from "../../src/main";

describe("cli entry", () => {
  it("declares the canonical executable name", () => {
    expect(CLI_NAME).toBe("sorage");
    expect(main(["version"])).toBe(0);
  });
});
