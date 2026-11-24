import { describe, expect, it } from "vitest";
import { CLI_NAME } from "../../src/cli-output";
import { main } from "../../src/main";

describe("cli entry", () => {
  it("declares the canonical executable name", async () => {
    expect(CLI_NAME).toBe("sorage");
    expect(await main(["version"])).toBe(0);
  });
});
