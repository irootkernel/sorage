import { describe, expect, it } from "vitest";
import { admitAppliedHistory, KNOWN_SCHEMA_HISTORY } from "../../src/known-schemas";

const HISTORY = KNOWN_SCHEMA_HISTORY;

function rows(versions: number[]) {
  return versions.map((version) => ({
    version,
    name: (HISTORY.find((entry) => entry.version === version) ?? { name: `future-${String(version)}` }).name,
  }));
}

describe("admitAppliedHistory maximum and integrity ordering", () => {
  it("classifies future-plus-duplicate as unsupported, not deferred integrity", () => {
    const futureVersion = Math.max(...HISTORY.map((entry) => entry.version)) + 1;
    const mixed = [...rows([...HISTORY.map((entry) => entry.version), 3]), { version: futureVersion, name: "future" }];
    const verdict = admitAppliedHistory(mixed, HISTORY);
    expect(verdict.kind).toBe("unsupported");
    if (verdict.kind === "unsupported") {
      expect(verdict.error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
      expect(verdict.error.message).toContain(String(futureVersion));
    }
  });

  it("classifies supported-range duplicates as integrity after the maximum scan", () => {
    const duplicated = rows([1, 2, 3, 3, 4, 5, 6, 7, 8]);
    const verdict = admitAppliedHistory(duplicated, HISTORY);
    expect(verdict.kind).toBe("integrity");
    if (verdict.kind === "integrity") {
      expect(verdict.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(verdict.error.message).toContain("3");
    }
  });

  it("keeps a clean supported history admitted", () => {
    expect(admitAppliedHistory(rows([1, 2, 3, 4, 5, 6, 7, 8]), HISTORY).kind).toBe("ok");
  });

  it("keeps a clean older prefix admitted", () => {
    expect(admitAppliedHistory(rows([1, 2, 3, 4]), HISTORY).kind).toBe("ok");
  });

  it("keeps forward-only refusal unchanged", () => {
    const forward = [...rows([1, 2, 3, 4, 5, 6, 7, 8]), { version: 13, name: "far-future" }];
    const verdict = admitAppliedHistory(forward, HISTORY);
    expect(verdict.kind).toBe("unsupported");
  });

  it("keeps hole and name-mismatch integrity classifications unchanged", () => {
    const hole = rows([1, 2, 4, 5, 6, 7, 8]);
    expect(admitAppliedHistory(hole, HISTORY).kind).toBe("integrity");
    const mismatched = rows([1, 2, 3, 4, 5, 6, 7, 8]).map((row, index) =>
      index === 3 ? { ...row, name: "wrong-name" } : row,
    );
    expect(admitAppliedHistory(mismatched, HISTORY).kind).toBe("integrity");
  });
});
