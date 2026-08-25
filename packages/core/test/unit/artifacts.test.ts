import { describe, expect, it } from "vitest";
import { buildStorageKey, isManagedStorageKey } from "../../src/artifacts";

describe("buildStorageKey", () => {
  it("builds artifacts/<handoff-id>/<artifact-id>/<stored-name> (VLT-020)", () => {
    const key = buildStorageKey({
      handoffId: "h-1",
      artifactId: "a-1",
      storedName: "report.md",
    });
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    expect(key.value).toBe("artifacts/h-1/a-1/report.md");
  });

  it("rejects traversal, separators, and control bytes in any segment", () => {
    for (const parts of [
      { handoffId: "..", artifactId: "a", storedName: "n" },
      { handoffId: "h", artifactId: "a/b", storedName: "n" },
      { handoffId: "h", artifactId: "a", storedName: ".." },
      { handoffId: "h", artifactId: "a", storedName: "n\0x" },
      { handoffId: "h", artifactId: "a", storedName: "" },
      { handoffId: "h", artifactId: ".", storedName: "n" },
      { handoffId: "h", artifactId: "a", storedName: "sub\\dir" },
    ]) {
      const key = buildStorageKey(parts);
      expect(key.ok, JSON.stringify(parts)).toBe(false);
    }
  });

  it("gives two Artifacts of one Handoff distinct slots", () => {
    const first = buildStorageKey({ handoffId: "h-1", artifactId: "a-1", storedName: "doc.md" });
    const second = buildStorageKey({ handoffId: "h-1", artifactId: "a-2", storedName: "doc.md" });
    if (!first.ok || !second.ok) throw new Error("valid parts must build");
    expect(first.value).not.toBe(second.value);
  });

  it("recognizes managed keys and rejects everything else", () => {
    expect(isManagedStorageKey("artifacts/h/a/doc.md")).toBe(true);
    expect(isManagedStorageKey("staging/uuid")).toBe(false);
    expect(isManagedStorageKey("artifacts/h/../a/doc.md")).toBe(false);
    expect(isManagedStorageKey("artifacts/h/a")).toBe(false);
    expect(isManagedStorageKey("/etc/passwd")).toBe(false);
  });
});
