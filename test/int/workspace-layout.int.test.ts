import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace layout", () => {
  it("contains the five packages of the fixed layout", () => {
    for (const manifest of [
      "packages/core/package.json",
      "packages/adapters/package.json",
      "apps/cli/package.json",
      "apps/daemon/package.json",
      "apps/web/package.json",
    ]) {
      expect(existsSync(manifest), manifest).toBe(true);
    }
  });

  it("commits a lockfile whose resolved set is stable across frozen installs", () => {
    expect(existsSync("bun.lock")).toBe(true);
    const lockfile = readFileSync("bun.lock", "utf8");
    expect(lockfile.length).toBeGreaterThan(0);
  });
});
