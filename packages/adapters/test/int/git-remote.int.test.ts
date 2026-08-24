import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeGitRemote } from "../../src/testkit";

const fixtures: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of fixtures) cleanup();
});

describe("bare git remote fixture", () => {
  it("gives a bare remote and a second clone that share history", () => {
    const fixture = makeGitRemote();
    fixtures.push(fixture.cleanup);
    expect(existsSync(join(fixture.remotePath, "HEAD"))).toBe(true);
    expect(readFileSync(join(fixture.seedPath, "README.md"), "utf8")).toContain("seed");
    expect(readFileSync(join(fixture.clonePath, "README.md"), "utf8")).toContain("seed");
  });
});
