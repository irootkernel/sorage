import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The TASK-039 gate made observable: the shipped agent policy exists, carries the
 * GEN-014 instructions verbatim enough for a session to follow, keeps its links
 * resolvable the way scripts/sot-check demands, and needs no file outside this
 * repository to work.
 */
const skillPath = fileURLToPath(new URL("../../skills/use-sorage/SKILL.md", import.meta.url));

describe("the shipped use-sorage skill", () => {
  const text = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";

  it("exists with valid frontmatter and a name", () => {
    expect(existsSync(skillPath)).toBe(true);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text.slice(0, text.indexOf("\n---\n", 4))).toContain("name: use-sorage");
  });

  it("states the GEN-014 inbox policy for session start and before every task", () => {
    expect(text).toContain("sorage inbox --json");
    expect(text).toContain("at session start");
    expect(text).toContain("before starting any task");
    expect(text).toContain("changes_requested");
  });

  it("forbids editing the managed Vault and instructs ignoring .sorage/ in Git", () => {
    expect(text).toContain("Never create, edit, rename, or delete anything inside the Vault");
    expect(text).toContain("Ignore `.sorage/` in Git");
    expect(text).toContain("handoff.inboxMarker");
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
