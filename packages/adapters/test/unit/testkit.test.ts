import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CrashPointRegistry,
  FakeClock,
  SequentialIdGenerator,
  faultInjectingFs,
  generateHandoffSeed,
  makeTempDatabase,
  makeTempHome,
  makeTempVault,
  probeFullFsync,
  withTempHome,
} from "../../src/testkit";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

describe("temporary home fixture", () => {
  it("creates an isolated SORAGE_HOME and removes it on cleanup", async () => {
    let observedHome = "";
    await withTempHome((home) => {
      observedHome = home;
      expect(home).not.toContain(process.env.HOME ?? "/Users");
      expect(existsSync(home)).toBe(true);
    });
    expect(existsSync(observedHome)).toBe(false);
  });

  it("restores SORAGE_HOME after the test", async () => {
    const previous = process.env.SORAGE_HOME;
    await withTempHome(() => undefined);
    expect(process.env.SORAGE_HOME).toBe(previous);
  });
});

describe("temporary vault fixture", () => {
  it("creates artifacts/ and staging/ under the vault root", () => {
    const vault = makeTempVault();
    cleanups.push(vault.cleanup);
    expect(existsSync(join(vault.vaultPath, "artifacts"))).toBe(true);
    expect(existsSync(join(vault.vaultPath, "staging"))).toBe(true);
  });
});

describe("temporary database fixture", () => {
  it("opens a WAL database with foreign keys on and closes it on cleanup", () => {
    const temp = makeTempDatabase();
    cleanups.push(temp.cleanup);
    expect(temp.db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(temp.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
  });
});

describe("fake clock and id generator", () => {
  it("advances time only when told", () => {
    const clock = new FakeClock();
    const first = clock.now().toISOString();
    clock.advance(5_000);
    expect(clock.now().getTime() - Date.parse(first)).toBe(5_000);
  });

  it("generates sequential ids", () => {
    const ids = new SequentialIdGenerator("handoff");
    expect(ids.next()).toBe("handoff-000001");
    expect(ids.next()).toBe("handoff-000002");
  });
});

describe("fault-injection adapters", () => {
  it("throws before a write and after a rename at armed crash points", () => {
    const home = makeTempHome("sorage-test-fi-");
    cleanups.push(home.cleanup);
    const registry = new CrashPointRegistry();
    const fs = faultInjectingFs(registry);
    const target = join(home.home, "data.txt");

    registry.arm("CP-1", "fs", "writeFile", "before");
    expect(() => fs.writeFile(target, "x")).toThrowError(/injected crash in fs.writeFile \(before\)/);
    expect(existsSync(target)).toBe(false);
    // The crash point is specific: it must not fire for a different operation.
    registry.arm("CP-3", "fs", "unlink", "before");
    fs.mkdir(join(home.home, "nested"));
    registry.disarm("CP-3");
    registry.disarm("CP-1");

    fs.writeFile(target, "x");
    registry.arm("CP-2", "fs", "rename", "after");
    const renamed = join(home.home, "renamed.txt");
    expect(() => fs.rename(target, renamed)).toThrowError(/injected crash in fs.rename \(after\)/);
    expect(existsSync(renamed)).toBe(true);
  });
});

describe("handoff seed generator", () => {
  it("produces a deterministic seed of the requested size", () => {
    const first = generateHandoffSeed(50);
    const second = generateHandoffSeed(50);
    expect(first).toEqual(second);
    expect(first).toHaveLength(50);
    expect(new Set(first.map((row) => row.handoffId)).size).toBe(50);
  });
});

describe("fsync durability probe", () => {
  it("asserts F_FULLFSYNC semantics on macOS", () => {
    const result = probeFullFsync();
    if (result.platform === "darwin") {
      expect(result.fullFsyncSupported).toBe(true);
    } else {
      expect(result.detail).toContain("not applicable");
    }
  });
});
