import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createHomePaths, createNodeHomePaths } from "../../src/home";
import { acquireLock, createNodeLockProbePorts, readLock, type LockProbePorts } from "../../src/lockfile";
import { FakeClock, makeTempHome, withTempHome } from "../../src/testkit";

const systemPorts = createNodeLockProbePorts();

function fakePorts(clock: FakeClock): LockProbePorts {
  return {
    clock,
    hostname: () => "test.local",
    isPidAlive: (pid: number) => pid === process.pid,
  };
}

/** Spawns a short-lived child whose pid is live from spawn's return. */
async function spawnChild(): Promise<{ pid: number; exited: Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("could not spawn a child process");
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return { pid: child.pid, exited };
}

async function deadPid(): Promise<number> {
  const child = await spawnChild();
  process.kill(child.pid, "SIGKILL");
  await child.exited;
  return child.pid;
}

describe("the home path service", () => {
  it("resolves every canonical path under a temporary SORAGE_HOME and never the real home", async () => {
    await withTempHome(async (home) => {
      const paths = createNodeHomePaths();
      expect(paths.home).toBe(home);
      for (const location of [
        paths.configFile,
        paths.stateDir,
        paths.logsDir,
        paths.runDir,
        paths.lockFile("config"),
      ]) {
        expect(location.startsWith(home)).toBe(true);
      }
      const realHome = join(homedir(), ".sorage");
      for (const location of [paths.home, paths.configFile, paths.stateDir, paths.logsDir, paths.runDir]) {
        expect(location).not.toBe(realHome);
        expect(location.startsWith(`${realHome}/`)).toBe(false);
      }
    }, "sorage-test-homepaths-");
  });

  it("falls back to <userHome>/.sorage when SORAGE_HOME is unset", () => {
    const scratch = makeTempHome("sorage-test-fallback-");
    try {
      const paths = createHomePaths({}, scratch.home);
      expect(paths.home).toBe(join(scratch.home, ".sorage"));
      expect(paths.configFile).toBe(join(scratch.home, ".sorage", "config.yaml"));
    } finally {
      scratch.cleanup();
    }
  });
});

describe("the O_EXCL lockfile primitive", () => {
  it("refuses a second acquisition of a live lock", async () => {
    await withTempHome(async (home) => {
      const path = createNodeHomePaths().lockFile("config");
      const first = acquireLock({ path, lock: "config", ports: systemPorts });
      expect(first.ok).toBe(true);
      const second = acquireLock({ path, lock: "config", ports: systemPorts });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.kind).toBe("live-lock");
        expect(second.error.record?.pid).toBe(process.pid);
      }
      if (first.ok) first.release();
      expect(existsSync(path)).toBe(false);
    }, "sorage-test-lock-live-");
  });

  it("writes {pid, startedAt, hostname} and reads it back", async () => {
    await withTempHome(async () => {
      const path = createNodeHomePaths().lockFile("migration");
      const acquired = acquireLock({ path, lock: "migration", ports: systemPorts });
      expect(acquired.ok).toBe(true);
      const record = readLock(path);
      expect(record?.pid).toBe(process.pid);
      expect(typeof record?.startedAt).toBe("string");
      expect(Number.isNaN(Date.parse(record?.startedAt ?? ""))).toBe(false);
      expect(typeof record?.hostname).toBe("string");
      expect(record?.hostname).not.toBe("");
      if (acquired.ok) acquired.release();
    }, "sorage-test-lock-record-");
  });

  it("breaks a lock whose recorded pid is dead", async () => {
    const pid = await deadPid();
    await withTempHome(async () => {
      const paths = createNodeHomePaths();
      const path = paths.lockFile("daemon");
      mkdirSync(paths.runDir, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ pid, startedAt: new Date().toISOString(), hostname: "gone.local" })}\n`);
      const acquired = acquireLock({ path, lock: "daemon", ports: systemPorts });
      expect(acquired.ok).toBe(true);
      if (acquired.ok) {
        expect(readLock(path)?.pid).toBe(process.pid);
        acquired.release();
      }
    }, "sorage-test-lock-dead-");
  });

  it("breaks a config.lock older than 30 seconds while a live daemon.lock is not broken", async () => {
    await withTempHome(async () => {
      const paths = createNodeHomePaths();
      const clock = new FakeClock();
      const ports = fakePorts(clock);

      const daemonPath = paths.lockFile("daemon");
      const daemonFirst = acquireLock({ path: daemonPath, lock: "daemon", ports });
      expect(daemonFirst.ok).toBe(true);
      clock.advance(31_001);
      const daemonSecond = acquireLock({ path: daemonPath, lock: "daemon", ports });
      expect(daemonSecond.ok).toBe(false);
      if (!daemonSecond.ok) expect(daemonSecond.error.kind).toBe("live-lock");

      const configPath = paths.lockFile("config");
      const configFirst = acquireLock({ path: configPath, lock: "config", ports });
      expect(configFirst.ok).toBe(true);
      clock.advance(31_001);
      const configSecond = acquireLock({ path: configPath, lock: "config", ports });
      expect(configSecond.ok).toBe(true);
      if (configSecond.ok) {
        expect(readLock(configPath)?.startedAt).toBe(ports.clock.now().toISOString());
        configSecond.release();
      }
      if (daemonFirst.ok) daemonFirst.release();
    }, "sorage-test-lock-stale-");
  });

  it("breaks a malformed lockfile because it cannot prove a live owner", async () => {
    await withTempHome(async () => {
      const paths = createNodeHomePaths();
      const path = paths.lockFile("backup");
      mkdirSync(paths.runDir, { recursive: true });
      writeFileSync(path, "not a lock record\n");
      const acquired = acquireLock({ path, lock: "backup", ports: systemPorts });
      expect(acquired.ok).toBe(true);
      if (acquired.ok) acquired.release();
    }, "sorage-test-lock-malformed-");
  });

  it("creates the run directory when it does not exist", async () => {
    await withTempHome(async (home) => {
      const paths = createNodeHomePaths();
      expect(existsSync(paths.runDir)).toBe(false);
      const acquired = acquireLock({ path: paths.lockFile("vault-move"), lock: "vault-move", ports: systemPorts });
      expect(acquired.ok).toBe(true);
      expect(existsSync(join(home, "run", "vault-move.lock"))).toBe(true);
      if (acquired.ok) acquired.release();
    }, "sorage-test-lock-mkdir-");
  });

  it("leaves the lockfile body as one JSON line ending in a newline", async () => {
    await withTempHome(async () => {
      const path = createNodeHomePaths().lockFile("config");
      const acquired = acquireLock({ path, lock: "config", ports: systemPorts });
      expect(acquired.ok).toBe(true);
      const body = readFileSync(path, "utf8");
      expect(body.endsWith("\n")).toBe(true);
      expect(body.trim().split("\n")).toHaveLength(1);
      expect(() => JSON.parse(body)).not.toThrow();
      if (acquired.ok) acquired.release();
    }, "sorage-test-lock-shape-");
  });
});
