import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The structural part of the TASK-039 gate: the shipped skill exists, identifies
 * itself, and resolves its references within this repository. GEN-014 and HND-026
 * behavior is reviewed separately under the M1 skill acceptance scenarios; prose
 * matching cannot establish an agent's decisions.
 */
const skillPath = fileURLToPath(new URL("../../skills/use-sorage/SKILL.md", import.meta.url));

describe("the shipped use-sorage skill", () => {
  const text = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";

  it("exists with valid frontmatter and a name", () => {
    expect(existsSync(skillPath)).toBe(true);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text.slice(0, text.indexOf("\n---\n", 4))).toContain("name: use-sorage");
  });

  it("resolves every relative link it contains from the skill directory", () => {
    const base = dirname(skillPath);
    const links = [...text.matchAll(/\]\(([^)#\s]+)\)/g)]
      .map((match) => match[1] as string)
      .filter((link) => !link.startsWith("http"));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(existsSync(resolve(base, link)), link).toBe(true);
    }
  });
});
