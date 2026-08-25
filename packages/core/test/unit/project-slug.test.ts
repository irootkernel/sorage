import { describe, expect, it } from "vitest";
import { deriveProjectSlug, validateProjectSlug } from "../../src/project-commands";

describe("slug derivation from a display name in any script", () => {
  it("derives the documented latin examples", () => {
    expect(deriveProjectSlug("Web App")).toBe("web-app");
    expect(deriveProjectSlug("  Dolgorae Writer  ")).toBe("dolgorae-writer");
    expect(deriveProjectSlug(" Already--Complicated !! Name ")).toBe("already-complicated-name");
  });

  it("keeps letters of non-latin scripts instead of inventing a transliteration", () => {
    expect(deriveProjectSlug("웹 앱")).toBe("웹-앱");
    expect(deriveProjectSlug("Долгорэ")).toBe("долгорэ");
    expect(deriveProjectSlug("プロジェクトX")).toBe("プロジェクトx");
  });

  it("collapses every non-alphanumeric run into one hyphen and trims the edges", () => {
    expect(deriveProjectSlug("--a/*+b--")).toBe("a-b");
    expect(deriveProjectSlug("123 456")).toBe("123-456");
  });

  it("derives an empty slug when the name carries no letters or digits", () => {
    expect(deriveProjectSlug("!!!")).toBe("");
    expect(deriveProjectSlug("   ")).toBe("");
  });

  it("accepts an explicit slug only in the derived shape", () => {
    expect(validateProjectSlug("web-app").ok).toBe(true);
    expect(validateProjectSlug("웹-앱").ok).toBe(true);
    expect(validateProjectSlug("").ok).toBe(false);
    expect(validateProjectSlug("-leading").ok).toBe(false);
    expect(validateProjectSlug("trailing-").ok).toBe(false);
    expect(validateProjectSlug("has/slash").ok).toBe(false);
    expect(validateProjectSlug("has space").ok).toBe(false);
  });
});
