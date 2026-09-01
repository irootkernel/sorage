import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scratchDirectories: string[] = [];
const checker = join(import.meta.dirname, "../../scripts/check-version.ts");

function manifest(root: string, relativePath: string, value: Record<string, unknown>): void {
  const directory = join(root, relativePath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(value)}\n`);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sorage-version-check-"));
  scratchDirectories.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"sorage","version":"0.3.0"}\n');
  manifest(root, "packages/core", { name: "@sorage/core", version: "0.3.0" });
  manifest(root, "apps/cli", {
    name: "@sorage/cli",
    version: "0.3.0",
    dependencies: { "@sorage/core": "0.3.0" },
  });
  return root;
}

function check(root: string) {
  return spawnSync("bun", ["run", checker, root], { encoding: "utf8" });
}

afterEach(() => {
  while (scratchDirectories.length > 0) {
    const directory = scratchDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("product version consistency check", () => {
  it("accepts matching workspace and internal dependency versions", () => {
    const result = check(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("match Sorage 0.3.0");
  });

  it("rejects workspace and internal dependency version drift", () => {
    const root = fixture();
    manifest(root, "apps/cli", {
      name: "@sorage/cli",
      version: "0.2.0",
      dependencies: { "@sorage/core": "0.2.0" },
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("version consistency check failed");
    expect(result.stderr).toContain('version "0.2.0" does not match "0.3.0"');
    expect(result.stderr).toContain("dependencies.@sorage/core");
  });
});
