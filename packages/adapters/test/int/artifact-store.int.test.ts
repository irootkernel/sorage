import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStorageKey, errorSpec, type AppError } from "@sorage/core";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createVaultInitializer } from "../../src/vault";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempHome } from "../../src/testkit/temp-home";
import { makeTempVault } from "../../src/testkit/temp-vault";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";

function initializedStore(
  prefix: string,
  stagingIds?: string[],
): { store: ReturnType<typeof createNodeArtifactStore>; vaultPath: string; cleanup: () => void } {
  const fixture = makeTempVault(prefix);
  const initializer = createVaultInitializer(new FakeClock());
  if (!initializer.initialize(fixture.vaultPath, INSTALLATION).ok) throw new Error("fixture init must succeed");
  const queue = stagingIds;
  const store =
    queue === undefined
      ? createNodeArtifactStore({ vaultPath: fixture.vaultPath, installationId: INSTALLATION })
      : createNodeArtifactStore({
          vaultPath: fixture.vaultPath,
          installationId: INSTALLATION,
          newStagingId: () => queue.shift() as string,
        });
  return { store, vaultPath: fixture.vaultPath, cleanup: fixture.cleanup };
}

function exitCodeOf(error: AppError): number {
  return errorSpec(error.code).exitCode;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("createNodeArtifactStore stage", () => {
  it("streams a regular file into staging with size and same-pass SHA-256, leaving the source untouched", () => {
    const home = makeTempHome("sorage-stage-");
    try {
      const source = join(home.home, "source.md");
      writeFileSync(source, "# Report\n\nbody bytes\n");
      const { store, vaultPath, cleanup } = initializedStore("sorage-stage-v-");
      try {
        const staged = store.stage({ sourcePath: source, maxBytes: 1024 });
        expect(staged.ok).toBe(true);
        if (!staged.ok) return;
        expect(staged.value.sizeBytes).toBe(statSize(source));
        expect(staged.value.sha256).toBe(sha256Of(source));
        expect(staged.value.stagingPath.startsWith(join(vaultPath, "staging"))).toBe(true);
        expect(existsSync(staged.value.stagingPath)).toBe(true);
        expect(readFileSync(staged.value.stagingPath, "utf8")).toBe("# Report\n\nbody bytes\n");
        // VLT-004, VLT-005: copy only; the source stays present and unchanged.
        expect(existsSync(source)).toBe(true);
        expect(readFileSync(source, "utf8")).toBe("# Report\n\nbody bytes\n");
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("aborts mid-stream past artifact.maxBytes with ARTIFACT_TOO_LARGE at exit 65 and leaves staging empty", () => {
    const home = makeTempHome("sorage-toolarge-");
    try {
      const source = join(home.home, "big.bin");
      writeFileSync(source, Buffer.alloc(4096, 7));
      const { store, vaultPath, cleanup } = initializedStore("sorage-toolarge-v-");
      try {
        const staged = store.stage({ sourcePath: source, maxBytes: 100 });
        expect(staged.ok).toBe(false);
        if (staged.ok) return;
        expect(staged.error.code).toBe("ARTIFACT_TOO_LARGE");
        expect(exitCodeOf(staged.error)).toBe(65);
        expect(readdirSync(join(vaultPath, "staging"))).toEqual([]);
        expect(existsSync(source)).toBe(true);
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("accepts a file exactly at the limit", () => {
    const home = makeTempHome("sorage-atlimit-");
    try {
      const source = join(home.home, "exact.bin");
      writeFileSync(source, Buffer.alloc(100, 1));
      const { store, cleanup } = initializedStore("sorage-atlimit-v-");
      try {
        const staged = store.stage({ sourcePath: source, maxBytes: 100 });
        expect(staged.ok).toBe(true);
        if (staged.ok) expect(staged.value.sizeBytes).toBe(100);
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("keeps peak memory bounded while importing a file far larger than the buffer (NFR-005)", () => {
    const home = makeTempHome("sorage-mem-");
    try {
      const source = join(home.home, "large.bin");
      // 32 MiB against a 1 MiB buffer; an RSS growth under half the file size
      // proves the copy never buffers the body.
      writeFileSync(source, Buffer.alloc(32 * 1024 * 1024, 3));
      const { store, cleanup } = initializedStore("sorage-mem-v-");
      try {
        const before = process.memoryUsage.rss();
        const staged = store.stage({ sourcePath: source, maxBytes: 100 * 1024 * 1024 });
        const after = process.memoryUsage.rss();
        expect(staged.ok).toBe(true);
        if (staged.ok) expect(staged.value.sizeBytes).toBe(32 * 1024 * 1024);
        expect(after - before).toBeLessThan(16 * 1024 * 1024);
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("refuses a directory source without staging anything", () => {
    const home = makeTempHome("sorage-dir-");
    try {
      const directory = join(home.home, "adir");
      mkdirSync(directory);
      const { store, vaultPath, cleanup } = initializedStore("sorage-dir-v-");
      try {
        const staged = store.stage({ sourcePath: directory, maxBytes: 1024 });
        expect(staged.ok).toBe(false);
        if (staged.ok) return;
        expect(staged.error.message).toContain("not a regular file");
        expect(readdirSync(join(vaultPath, "staging"))).toEqual([]);
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("blocks every mutation when the marker belongs to another installation (VLT-019)", () => {
    const fixture = makeTempVault("sorage-guard-");
    try {
      const initializer = createVaultInitializer(new FakeClock());
      if (!initializer.initialize(fixture.vaultPath, "22222222-2222-4222-8222-222222222222").ok) {
        throw new Error("fixture init must succeed");
      }
      const home = makeTempHome("sorage-guard-src-");
      try {
        const source = join(home.home, "s.md");
        writeFileSync(source, "x");
        const store = createNodeArtifactStore({
          vaultPath: fixture.vaultPath,
          installationId: INSTALLATION,
        });
        const staged = store.stage({ sourcePath: source, maxBytes: 10 });
        expect(staged.ok).toBe(false);
        if (staged.ok) return;
        expect(staged.error.code).toBe("VAULT_INTEGRITY_ERROR");
        expect(staged.error.message).toContain("sorage backup restore --from <vault-path> --as-user --confirm");
        expect(readdirSync(join(fixture.vaultPath, "staging"))).toEqual([]);
        expect(readdirSync(join(fixture.vaultPath, "artifacts"))).toEqual([]);
      } finally {
        home.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe("createNodeArtifactStore activate", () => {
  it("places two Artifacts of one Handoff on two distinct paths (VLT-020)", () => {
    const home = makeTempHome("sorage-two-");
    try {
      const first = join(home.home, "one.md");
      const second = join(home.home, "two.md");
      writeFileSync(first, "first");
      writeFileSync(second, "second");
      const { store, vaultPath, cleanup } = initializedStore("sorage-two-v-", ["st-1", "st-2"]);
      try {
        const key1 = buildStorageKey({ handoffId: "h-1", artifactId: "a-1", storedName: "doc.md" });
        const key2 = buildStorageKey({ handoffId: "h-1", artifactId: "a-2", storedName: "doc.md" });
        if (!key1.ok || !key2.ok) throw new Error("keys must build");
        const staged1 = store.stage({ sourcePath: first, maxBytes: 100 });
        const staged2 = store.stage({ sourcePath: second, maxBytes: 100 });
        if (!staged1.ok || !staged2.ok) throw new Error("staging must succeed");
        const placed1 = store.activate({ stagingPath: staged1.value.stagingPath, storageKey: key1.value });
        const placed2 = store.activate({ stagingPath: staged2.value.stagingPath, storageKey: key2.value });
        expect(placed1.ok).toBe(true);
        expect(placed2.ok).toBe(true);
        expect(readFileSync(join(vaultPath, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("first");
        expect(readFileSync(join(vaultPath, "artifacts/h-1/a-2/doc.md"), "utf8")).toBe("second");
        expect(readdirSync(join(vaultPath, "staging"))).toEqual([]);
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("never overwrites an existing storageKey, whatever the incoming name or kind", () => {
    const home = makeTempHome("sorage-nooverwrite-");
    try {
      const first = join(home.home, "one.md");
      const second = join(home.home, "same-name.md");
      writeFileSync(first, "original bytes");
      writeFileSync(second, "replacement bytes");
      const { store, vaultPath, cleanup } = initializedStore("sorage-nooverwrite-v-", ["st-1", "st-2"]);
      try {
        const key = buildStorageKey({ handoffId: "h-1", artifactId: "a-1", storedName: "doc.md" });
        if (!key.ok) throw new Error("key must build");
        const staged1 = store.stage({ sourcePath: first, maxBytes: 100 });
        if (!staged1.ok) throw new Error("staging must succeed");
        expect(store.activate({ stagingPath: staged1.value.stagingPath, storageKey: key.value }).ok).toBe(true);
        const staged2 = store.stage({ sourcePath: second, maxBytes: 100 });
        if (!staged2.ok) throw new Error("staging must succeed");
        const again = store.activate({ stagingPath: staged2.value.stagingPath, storageKey: key.value });
        expect(again.ok).toBe(false);
        if (again.ok) return;
        expect(again.error.code).toBe("VAULT_INTEGRITY_ERROR");
        expect(readFileSync(join(vaultPath, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("original bytes");
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("refuses a staging path or key outside the managed contract", () => {
    const { store, cleanup } = initializedStore("sorage-badkey-v-");
    try {
      const placed = store.activate({ stagingPath: "/tmp/x", storageKey: "staging/evil" });
      expect(placed.ok).toBe(false);
      const resolved = store.pathOf("../escape");
      expect(resolved.ok).toBe(false);
    } finally {
      cleanup();
    }
  });
});

function statSize(path: string): number {
  return readFileSync(path).length;
}
