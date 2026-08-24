import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PINNED_BUN = "1.3.14";

describe("toolchain pin", () => {
  it("records the pinned Bun version in .bun-version and package.json engines", () => {
    const versionFile = readFileSync(".bun-version", "utf8").trim();
    expect(versionFile).toBe(PINNED_BUN);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines: { bun: string } };
    expect(pkg.engines.bun).toBe(PINNED_BUN);
  });

  it("provides every Makefile target the verification gate depends on", () => {
    const makefile = readFileSync("Makefile", "utf8");
    for (const target of [
      "test-prepare",
      "test-unit",
      "test-int",
      "test-contract",
      "test-e2e",
      "test",
      "build",
      "package",
    ]) {
      expect(makefile).toContain(`${target}:`);
    }
  });

  it("pins the version the toolchain check enforces at prepare time", () => {
    const check = readFileSync("scripts/check-toolchain.ts", "utf8");
    expect(check).toContain(`"${PINNED_BUN}"`);
  });
});
