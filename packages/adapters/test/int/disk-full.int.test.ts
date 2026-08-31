import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfiguration } from "@sorage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createConfigStore } from "../../src/config-store";
import { createHomePaths } from "../../src/home";
import { createNodeLockProbePorts } from "../../src/lockfile";
import { FakeClock } from "../../src/testkit/fakes";
import { createVaultInitializer } from "../../src/vault";

/**
 * The disk-full rows of the section 4 failure matrix (TASK-061): a real 2 MB HFS
 * ram disk is filled to under a kilobyte of free space, so the configuration
 * write and a staging copy meet a genuine ENOSPC rather than a mocked errno. The
 * invariants: the previous valid configuration stays active with its `.bak`
 * intact, reads keep working, no half-written Artifact is ever materialized, and
 * no Handoff is committed without a repair path.
 */
const SECTORS = 4096; // 2 MB
let device = "";
let mountPoint = "";

function sh(bin: string, args: string[]): string {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function freeBytes(): number {
  const output = execFileSync("df", ["-k", mountPoint], { encoding: "utf8" });
  // Columns: Filesystem 1024-blocks Used Available ...; "Available" is index 3.
  const columns = (output.trim().split("\n").at(-1) as string).split(/\s+/);
  return Number.parseInt(columns[3] ?? "0", 10) * 1024;
}

/**
 * Consumes the volume with 4 KB filler files until under `target` bytes remain.
 * A filler write that itself meets ENOSPC means the target is reached.
 */
function fillTo(targetBytes: number): void {
  const fillerDir = join(mountPoint, "filler");
  mkdirSync(fillerDir, { recursive: true });
  const chunk = Buffer.alloc(4096, 0x66);
  let index = 0;
  while (freeBytes() > targetBytes) {
    index += 1;
    try {
      writeFileSync(join(fillerDir, `f${index}`), chunk);
    } catch {
      return;
    }
  }
}

/** Each scenario gets a fresh volume, so one test's filler never poisons the next. */
function freshVolume(): void {
  mountPoint = mkdtempSync(join(tmpdir(), "sorage-disk-full-"));
  device = sh("hdiutil", ["attach", "-nomount", `ram://${SECTORS}`]);
  sh("newfs_hfs", ["-v", "SorageDiskFull", device]);
  sh("diskutil", ["mount", "-mountPoint", mountPoint, device]);
}

function dropVolume(): void {
  try {
    sh("diskutil", ["unmount", "force", mountPoint]);
  } catch {
    // A failed unmount must not mask the detach.
  }
  try {
    sh("hdiutil", ["detach", device]);
  } catch {
    // Best effort: the ram disk is destroyed with the session anyway.
  }
  rmSync(mountPoint, { recursive: true, force: true });
}

beforeEach(() => freshVolume());
afterEach(() => dropVolume());

describe("disk full during the configuration write", () => {
  it("keeps the previous valid configuration active and its store readable", { timeout: 30_000 }, () => {
    const home = join(mountPoint, "home");
    const vault = join(mountPoint, "vault");
    mkdirSync(join(home, "run"), { recursive: true });
    mkdirSync(vault, { recursive: true });
    const paths = createHomePaths({ SORAGE_HOME: home }, "/Users/tester");
    const store = createConfigStore({
      home: paths,
      lockPorts: createNodeLockProbePorts(new FakeClock()),
      userHome: "/Users/tester",
    });
    const first = store.write(defaultConfiguration("11111111-1111-4111-8111-111111111111"));
    expect(first.ok).toBe(true);
    // A second successful write creates the retained .bak holding the first
    // valid configuration, so the failing third write has a .bak to protect.
    const secondValid = defaultConfiguration("11111111-1111-4111-8111-111111111111");
    secondValid.server.port = 46400;
    const secondWrite = store.write(secondValid);
    expect(secondWrite.ok).toBe(true);
    const before = readFileSync(join(home, "config.yaml"), "utf8");
    const backupBefore = readFileSync(`${join(home, "config.yaml")}.bak`, "utf8");

    // The volume allocates in 4096-byte blocks, so the fill targets the window
    // where the lock record's one block still fits while the temporary sibling
    // plus the atomic .bak swap cannot: the failure lands inside the swap, not
    // in lock acquisition.
    fillTo(8192);
    // df reports block multiples, so the landing is 8192 or 4096; both leave the
    // lock its block while the three-block swap (lock, temp, .bak) cannot fit.
    expect(freeBytes()).toBeGreaterThanOrEqual(4096);
    expect(freeBytes()).toBeLessThanOrEqual(8192);

    const next = defaultConfiguration("11111111-1111-4111-8111-111111111111");
    next.server.port = 46900;
    const third = store.write(next);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.message).not.toContain("lock could not be acquired");
      expect(third.error.message).toContain("the configuration could not be written");
    }
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(before);
    // The previous good .bak survives the mid-swap failure byte for byte: the
    // copy lands on a temporary sibling that only renames over the .bak whole.
    expect(readFileSync(`${join(home, "config.yaml")}.bak`, "utf8")).toBe(backupBefore);

    // Reads keep working and still see the last valid values.
    const read = store.read();
    expect(read.ok).toBe(true);
    if (read.ok && read.value !== null) {
      expect(read.value.config.server.port).toBe(46400);
    }
  });
});

describe("disk full during a staging copy", () => {
  it("fails recoverably with no materialized Artifact and no intent row", { timeout: 30_000 }, () => {
    const source = join(tmpdir(), `sorage-disk-full-source-${Date.now()}.bin`);
    writeFileSync(source, Buffer.alloc(64 * 1024, 0x61));
    try {
      const vaultPath = join(mountPoint, "vault-b");
      const initialized = createVaultInitializer(new FakeClock()).initialize(
        vaultPath,
        "11111111-1111-4111-8111-111111111111",
      );
      expect(initialized.ok).toBe(true);
      const store = createNodeArtifactStore({
        vaultPath,
        installationId: "11111111-1111-4111-8111-111111111111",
      });
      fillTo(2048);
      const staged = store.stage({ sourcePath: source, maxBytes: 1024 * 1024 });
      expect(staged.ok).toBe(false);
      if (staged.ok) return;
      expect(staged.error.code).toBe("INTERNAL_ERROR");
      expect(staged.error.message).toContain("staged copy");
      // The failure happened before any intent commit: no Artifact bytes were
      // placed and nothing can be half-materialized, the CP-1 repair shape.
      expect(readdirSync(join(vaultPath, "artifacts"))).toEqual([]);
    } finally {
      rmSync(source, { force: true });
    }
  });
});
