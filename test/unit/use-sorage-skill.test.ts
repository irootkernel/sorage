import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/** Packaging/resource checks only. Actual GEN/HND decisions require the separate frozen AJ-26 observer. */
const source = fileURLToPath(new URL("../../skills/use-sorage", import.meta.url));
const checkout = resolve(source, "../..");
const root = mkdtempSync(join(tmpdir(), "sorage-standalone-skill-"));
const copy = join(root, "use-sorage");
cpSync(source, copy, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const skillPath = join(copy, "SKILL.md");
const text = readFileSync(skillPath, "utf8");
const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string);

describe("the standalone shipped use-sorage resources", () => {
  it("copies only the shipped directory outside the checkout with valid frontmatter", () => {
    expect(readdirSync(root)).toEqual(["use-sorage"]);
    expect(relative(checkout, copy).startsWith("..")).toBe(true);
    expect(readFileSync(skillPath)).toEqual(readFileSync(join(source, "SKILL.md")));
    expect(text.startsWith("---\n")).toBe(true);
    expect(text.slice(0, text.indexOf("\n---\n", 4))).toContain("name: use-sorage");
  });

  it("resolves every local Markdown resource entirely inside the standalone copy", () => {
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        expect(entry.isSymbolicLink(), path).toBe(false);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".md")) {
          for (const match of readFileSync(path, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
            const target = match[1] as string;
            if (/^https:\/\//.test(target) || target.startsWith("#")) continue;
            expect(isAbsolute(target), target).toBe(false);
            const resolved = resolve(dirname(path), decodeURIComponent(target.split("#")[0] as string));
            expect(relative(copy, resolved).startsWith(".."), target).toBe(false);
            expect(existsSync(resolved), target).toBe(true);
          }
        }
      }
    };
    visit(copy);
  });

  it("checks optional public reference source owners separately from standalone resources", () => {
    const publicLinks = links.filter((link) => link.startsWith("https://"));
    expect(publicLinks.length).toBeGreaterThan(0);
    for (const link of publicLinks) {
      const url = new URL(link);
      expect(url.host).toBe("github.com");
      const prefix = "/irootkernel/sorage/blob/main/";
      expect(url.pathname.startsWith(prefix)).toBe(true);
      expect(existsSync(resolve(checkout, url.pathname.slice(prefix.length))), link).toBe(true);
    }
  });
});
