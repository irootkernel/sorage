import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimePath, toolchainRoot } from "../../../../scripts/toolchain-runtime";
import { WEB_APP_JS } from "../../src/web-assets.generated";

describe("embedded Web assets", () => {
  it("parses the shipped JavaScript", () => {
    expect(() => new Function(WEB_APP_JS)).not.toThrow();
  });

  it("generates identical tracked bytes from either cwd and checks freshness without rewriting", () => {
    const scratch = mkdtempSync("/tmp/sorage-web-assets-");
    try {
      const generated = join(toolchainRoot, "apps/daemon/src/web-assets.generated.ts");
      const output = join(scratch, "assets.ts");
      // A caller-relative destination in a directory that exists only under scratch.
      const relativeOutput = join(basename(scratch), "repeated.ts");
      const repeated = join(scratch, relativeOutput);
      mkdirSync(join(scratch, basename(scratch)));
      const build = (cwd: string, ...args: string[]) =>
        spawnSync(runtimePath("bun"), ["--no-install", join(toolchainRoot, "scripts/build-web-assets.ts"), ...args], {
          cwd,
          encoding: "utf8",
        });
      const expected = readFileSync(generated);
      const missing = build(scratch, "--out", relativeOutput, "--check");
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("bun run build:web");
      expect(existsSync(repeated)).toBe(false);
      for (const [cwd, path] of [
        [toolchainRoot, output],
        [scratch, relativeOutput],
      ] as const) {
        const result = build(cwd, "--out", path);
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(resolve(cwd, path)).equals(expected)).toBe(true);
        expect(build(cwd, "--out", path, "--check").status).toBe(0);
      }
      expect(build(scratch, "--check").status).toBe(0);
      writeFileSync(repeated, "drift\n");
      const stale = build(scratch, "--out", relativeOutput, "--check");
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("bun run build:web");
      expect(readFileSync(repeated, "utf8")).toBe("drift\n");
      expect(readFileSync(generated).equals(expected)).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
