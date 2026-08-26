import { describe, expect, it } from "vitest";
import { errorSpec, ok, type AppError, type Result } from "../../src/errors";
import type { ArtifactStore } from "../../src/artifacts";
import { resolveArtifactForRead, verifyVaultArtifacts } from "../../src/artifact-integrity";

const KEY = "artifacts/h-1/a-1/doc.md";
const SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

interface Scripted {
  present?: boolean;
  checksum?: string | Error;
}

function scriptedStore(script: Scripted): ArtifactStore {
  return {
    stage: () => {
      throw new Error("not used here");
    },
    activate: () => {
      throw new Error("not used here");
    },
    pathOf: () => ok(`/vault/${KEY}`),
    exists: () => ok(script.present ?? true),
    checksum: () => {
      if (script.checksum instanceof Error) return err(script.checksum as never);
      return ok(script.checksum ?? SHA);
    },
  };
}

describe("resolveArtifactForRead", () => {
  it("returns ARTIFACT_MATERIALIZING at exit 75 while the row is not materialized (section 20.7)", () => {
    const read = resolveArtifactForRead(
      { artifactStore: scriptedStore({}) },
      { storageKey: KEY, sha256: SHA, materialized: false },
      { verifyChecksum: false },
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe("ARTIFACT_MATERIALIZING");
    expect(errorSpec(read.error.code).exitCode).toBe(75);
  });

  it("returns the in-Vault path once the drain flipped the row materialized", () => {
    const read = resolveArtifactForRead(
      { artifactStore: scriptedStore({}) },
      { storageKey: KEY, sha256: SHA, materialized: true },
      { verifyChecksum: false },
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.path).toBe(`/vault/${KEY}`);
  });

  it("treats a missing current Artifact as ARTIFACT_CORRUPTED at exit 73 (VLT-023)", () => {
    const read = resolveArtifactForRead(
      { artifactStore: scriptedStore({ present: false }) },
      { storageKey: KEY, sha256: SHA, materialized: true },
      { verifyChecksum: true },
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(errorSpec(read.error.code).exitCode).toBe(73);
    expect(read.error.details?.["problem"]).toBe("missing");
  });

  it("returns ARTIFACT_CORRUPTED for a mismatched checksum when verification is enabled", () => {
    const read = resolveArtifactForRead(
      {
        artifactStore: scriptedStore({ checksum: "0000000000000000000000000000000000000000000000000000000000000000" }),
      },
      { storageKey: KEY, sha256: SHA, materialized: true },
      { verifyChecksum: true },
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(read.error.details?.["problem"]).toBe("mismatched");
  });

  it("skips hashing on the hot path when verification is disabled", () => {
    let hashed = false;
    const store = scriptedStore({
      get checksum() {
        hashed = true;
        return SHA;
      },
    });
    const read = resolveArtifactForRead(
      { artifactStore: store },
      { storageKey: KEY, sha256: "wrong-recorded-value", materialized: true },
      { verifyChecksum: false },
    );
    expect(read.ok).toBe(true);
    expect(hashed).toBe(false);
  });
});

describe("verifyVaultArtifacts", () => {
  it("reports missing and mismatched artifacts alike and stays silent when clean", () => {
    const store = scriptedStore({});
    const clean = verifyVaultArtifacts({ artifactStore: store }, [{ storageKey: KEY, sha256: SHA }]);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.value).toEqual([]);

    const missing = verifyVaultArtifacts({ artifactStore: scriptedStore({ present: false }) }, [
      { storageKey: KEY, sha256: SHA },
    ]);
    if (!missing.ok || missing.value.length !== 1) throw new Error("missing finding expected");
    expect(missing.value[0]?.problem).toBe("missing");

    const mismatched = verifyVaultArtifacts(
      {
        artifactStore: scriptedStore({ checksum: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }),
      },
      [{ storageKey: KEY, sha256: SHA }],
    );
    if (!mismatched.ok || mismatched.value.length !== 1) throw new Error("mismatched finding expected");
    expect(mismatched.value[0]?.problem).toBe("mismatched");
    expect(mismatched.value[0]?.message).toContain(KEY);
  });
});

function err(error: AppError): Result<never, AppError> {
  return { ok: false, error };
}
