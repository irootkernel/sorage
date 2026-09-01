import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorSpec, resolveArtifactForRead, verifyVaultArtifacts, type AppError } from "@sorage/core";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createSqliteIntentLog } from "../../src/intent-log";
import { createVaultInitializer } from "../../src/vault";
import { migrate } from "../../src/sqlite/migrator";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { makeTempVault } from "../../src/testkit/temp-vault";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";
const KEY = "artifacts/h-1/a-1/doc.md";

function fixture(prefix: string) {
  const vault = makeTempVault(prefix);
  if (!createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION).ok) {
    throw new Error("fixture init must succeed");
  }
  const database = makeTempDatabase(`${prefix}db-`);
  migrate(database.db, MIGRATIONS);
  return {
    vaultPath: vault.vaultPath,
    store: createNodeArtifactStore({ vaultPath: vault.vaultPath, installationId: INSTALLATION }),
    intentLog: createSqliteIntentLog({ db: database.db, installationId: INSTALLATION }),
    cleanup: () => {
      database.cleanup();
      vault.cleanup();
    },
  };
}

function sha256Of(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function exitCodeOf(error: AppError): number {
  return errorSpec(error.code).exitCode;
}

describe("materialization read path (section 20.7, VLT-021)", () => {
  it("returns ARTIFACT_MATERIALIZING at exit 75 and succeeds after the drain completes the intent", () => {
    const fx = fixture("sorage-read-");
    try {
      const source = join(fx.vaultPath, "staging", "staged-1");
      writeFileSync(source, "document bytes");
      const sha = sha256Of("document bytes");
      const recorded = fx.intentLog.record([
        {
          id: "i-1",
          op: "activate",
          fromPath: "staging/staged-1",
          toPath: KEY,
          artifactId: "a-1",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      expect(recorded.ok).toBe(true);

      // Before the drain the row still says materialized = 0.
      const early = resolveArtifactForRead(
        { artifactStore: fx.store },
        { storageKey: KEY, sha256: sha, materialized: false },
        { verifyChecksum: true },
      );
      expect(early.ok).toBe(false);
      if (early.ok) return;
      expect(early.error.code).toBe("ARTIFACT_MATERIALIZING");
      expect(exitCodeOf(early.error)).toBe(75);

      const drained = fx.intentLog.drain(fx.vaultPath);
      expect(drained.ok).toBe(true);
      // The completion flips the row materialized; the same read now succeeds.
      const read = resolveArtifactForRead(
        { artifactStore: fx.store },
        { storageKey: KEY, sha256: sha, materialized: true },
        { verifyChecksum: true },
      );
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.path).toBe(join(fx.vaultPath, KEY));
      expect(readFileSync(read.value.path, "utf8")).toBe("document bytes");
    } finally {
      fx.cleanup();
    }
  });

  it("returns ARTIFACT_CORRUPTED at exit 73 for a mismatched file when verification is enabled (VLT-023)", () => {
    const fx = fixture("sorage-mismatch-");
    try {
      const home = join(fx.vaultPath, "..");
      const source = writeFile(join(home, "src.md"), "original bytes");
      const staged = fx.store.stage({ sourcePath: source, maxBytes: 100 });
      if (!staged.ok) throw new Error("staging must succeed");
      const placed = fx.store.activate({ stagingPath: staged.value.stagingPath, storageKey: KEY });
      if (!placed.ok) throw new Error("activation must succeed");
      // Tamper the managed bytes; the read with verification on must refuse.
      chmodSync(placed.value.path, 0o644);
      writeFileSync(placed.value.path, "tampered bytes");
      const read = resolveArtifactForRead(
        { artifactStore: fx.store },
        { storageKey: KEY, sha256: sha256Of("original bytes"), materialized: true },
        { verifyChecksum: true },
      );
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.code).toBe("ARTIFACT_CORRUPTED");
      expect(exitCodeOf(read.error)).toBe(73);
      expect(read.error.details?.problem).toBe("mismatched");
    } finally {
      fx.cleanup();
    }
  });
});

function writeFile(path: string, content: string): string {
  writeFileSync(path, content);
  return path;
}

describe("exhaustive verification (VLT-023, SEC-014)", () => {
  it("names every missing and mismatched current Artifact", () => {
    const fx = fixture("sorage-verify-");
    try {
      const good = join(fx.vaultPath, "artifacts/h-1/a-1/good.md");
      const tampered = join(fx.vaultPath, "artifacts/h-1/a-2/tampered.md");
      mkdirSync(join(fx.vaultPath, "artifacts/h-1/a-1"), { recursive: true });
      mkdirSync(join(fx.vaultPath, "artifacts/h-1/a-2"), { recursive: true });
      writeFileSync(good, "good bytes");
      writeFileSync(tampered, "tampered bytes");
      const findings = verifyVaultArtifacts({ artifactStore: fx.store }, [
        { storageKey: "artifacts/h-1/a-1/good.md", sha256: sha256Of("good bytes") },
        { storageKey: "artifacts/h-1/a-2/tampered.md", sha256: sha256Of("recorded bytes that no longer match") },
        { storageKey: "artifacts/h-1/a-3/missing.md", sha256: sha256Of("anything") },
      ]);
      expect(findings.ok).toBe(true);
      if (!findings.ok) return;
      expect(findings.value.map((finding) => finding.problem)).toEqual(["mismatched", "missing"]);
      expect(findings.value[0]?.message).toContain("artifacts/h-1/a-2/tampered.md");
      expect(findings.value[1]?.message).toContain("artifacts/h-1/a-3/missing.md");
    } finally {
      fx.cleanup();
    }
  });

  it("performs no checksum sweep at start-up: the drain never hashes Artifact bytes", () => {
    const fx = fixture("sorage-nosweep-");
    try {
      const file = join(fx.vaultPath, "artifacts/h-1/a-1/doc.md");
      mkdirSync(join(fx.vaultPath, "artifacts/h-1/a-1"), { recursive: true });
      writeFileSync(file, "original bytes");
      chmodSync(file, 0o644);
      writeFileSync(file, "silently corrupted bytes");
      // No pending intents: the drain has nothing to do, and it must not notice
      // the corruption either, because start-up never sweeps checksums.
      const drained = fx.intentLog.drain(fx.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.resolved).toEqual([]);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("silently corrupted bytes");
    } finally {
      fx.cleanup();
    }
  });
});
