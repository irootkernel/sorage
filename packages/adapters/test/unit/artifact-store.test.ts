import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createNodeArtifactStore } from "../../src/artifact-store";
import * as intentLog from "../../src/intent-log";
import { FakeClock, makeTempVault } from "../../src/testkit";
import { createVaultInitializer } from "../../src/vault";

/**
 * The VLT-022 durability order of the in-process fast path: activate() must fsync the
 * parent directory of the destination after the rename, because send, revise, and the
 * deletion approval commit materialized = 1 right after activate() returns and no
 * intent survives to repair an undurable rename.
 */

const INSTALLATION = "00000000-0000-4000-8000-0000000000aa";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

describe("the ArtifactStore fast path", () => {
  it("fsyncs the parent directory of the destination during activate (VLT-022)", () => {
    const vault = makeTempVault("sorage-artifact-fsync-");
    cleanups.push(vault.cleanup);
    const marker = createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION);
    if (!marker.ok) throw new Error("fixture vault marker must initialize");
    const store = createNodeArtifactStore({ vaultPath: vault.vaultPath, installationId: INSTALLATION });

    const stagingDirectory = mkdtempSync(join(tmpdir(), "sorage-artifact-staged-"));
    cleanups.push(() => rmSync(stagingDirectory, { recursive: true, force: true }));
    const staged = join(stagingDirectory, "note.md");
    writeFileSync(staged, "# Note\n");

    const fsync = vi.spyOn(intentLog, "fsyncDirectory");
    try {
      const activated = store.activate({ stagingPath: staged, storageKey: "artifacts/h-1/a-1/note.md" });
      expect(activated.ok).toBe(true);
      expect(fsync).toHaveBeenCalledTimes(1);
      expect(fsync).toHaveBeenCalledWith(dirname(join(vault.vaultPath, "artifacts/h-1/a-1/note.md")));
    } finally {
      fsync.mockRestore();
    }
  });
});
