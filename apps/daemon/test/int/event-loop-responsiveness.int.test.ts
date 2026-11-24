import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializeInstallation } from "@sorage/core";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDaemonPorts } from "@sorage/adapters/src/daemon-command-ports";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { FakeClock } from "@sorage/adapters/testkit";
import { type BackupTickResult, type RunningDaemon, serveDaemon, type SweepTickResult } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";

/**
 * TASK-153 Metric 3 concurrency qualification (RUN-005, SEC-014, BKP-006, BKP-025):
 * proves that `GET /api/v1/health` and real Memo mutations (`POST /api/v1/memos`,
 * `PATCH /api/v1/memos/{id}`) remain responsive well below browser timeouts and
 * dramatically below the TASK-147 pre-work baseline (`2,313.22 ms` push /
 * `31.81 ms` 64 MiB sweep) while a delayed 1.5s `git push` and a 64 MiB
 * Artifact checksum sweep execute asynchronously inside `serveDaemon`.
 */

const ARTIFACT_BYTES = 64 * 1024 * 1024;
const PROJECT_ID = "11111111-1111-4111-8111-111111111153";
const HANDOFF_ID = "22222222-2222-4222-8222-222222222253";

let activeHome: string | null = null;
let activeDaemon: RunningDaemon | null = null;

afterEach(async () => {
  if (activeDaemon !== null) {
    await activeDaemon.drain();
    activeDaemon = null;
  }
  if (activeHome !== null) {
    delete process.env.SORAGE_HOME;
    rmSync(activeHome, { recursive: true, force: true });
    activeHome = null;
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function httpJson(
  port: number,
  path: string,
  init: { method?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown; elapsedMs: number }> {
  const started = performance.now();
  const payload = init.body === undefined ? null : JSON.stringify(init.body);
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    ...(init.bearer !== undefined ? { authorization: `Bearer ${init.bearer}` } : {}),
    ...(payload !== null
      ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }
      : {}),
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          body: text === "" ? null : JSON.parse(text),
          elapsedMs: performance.now() - started,
        });
      });
    });
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function setupFixture(options: { seedLargeArtifact?: boolean; hookSleepSeconds?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sorage-m11-eventloop-"));
  activeHome = home;
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const remote = join(home, "remote.git");
  const projectDir = join(home, "proj-a");
  mkdirSync(projectDir, { recursive: true });

  const init = initializeInstallation(
    createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: homedir(), clock: new FakeClock() }),
    { vaultPath: vault },
  );
  expect(init.ok).toBe(true);

  // Prepare Vault git repo + bare remote with deterministic slow pre-receive hook.
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", "-b", "main", vault]);
  execFileSync("git", ["-C", vault, "config", "--local", "core.autocrlf", "false"]);
  execFileSync("git", ["-C", vault, "remote", "add", "origin", remote]);
  const hookPath = join(remote, "hooks", "pre-receive");
  const sleepSec = options.hookSleepSeconds ?? 1.5;
  writeFileSync(hookPath, `#!/bin/sh\nsleep ${sleepSec}\nexit 0\n`);
  chmodSync(hookPath, 0o755);

  const port = await freePort();
  const store = createNodeConfigCommandPorts().store;
  const cfg = store.read();
  if (!cfg.ok || cfg.value === null) throw new Error("config read failed");
  cfg.value.config.server.port = port;
  cfg.value.config.gitBackup.enabled = true;
  cfg.value.config.gitBackup.schedule.at = "03:00";
  cfg.value.config.gitBackup.schedule.timezone = "UTC";
  cfg.value.config.gitBackup.schedule.catchUpAfterMissedRun = true;
  cfg.value.config.gitBackup.push.enabled = true;
  cfg.value.config.gitBackup.push.remote = "origin";
  cfg.value.config.gitBackup.push.branch = "main";
  expect(store.write(cfg.value.config, { revision: cfg.value.revision }).ok).toBe(true);

  // Seed Project + optional 64 MiB materialized Artifact.
  const now = "2026-08-30T00:00:00.000Z";
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'proj-a', 'Proj A', NULL, 'active', ?, ?)",
  ).run(PROJECT_ID, now, now);
  db.prepare(
    "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b-1', ?, ?, ?, 'directory', ?, ?)",
  ).run(PROJECT_ID, init.ok ? init.value.installationId : "inst", projectDir, now, now);
  if (options.seedLargeArtifact) {
    const storageKey = `artifacts/${HANDOFF_ID}/a64m/large.bin`;
    const filePath = join(vault, storageKey);
    mkdirSync(dirname(filePath), { recursive: true });
    // Deterministic 64 MiB buffer hashed once at seed time.
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const hash = createHash("sha256");
    const parts: Buffer[] = [];
    for (let i = 0; i < 64; i += 1) {
      hash.update(chunk);
      parts.push(chunk);
    }
    writeFileSync(filePath, Buffer.concat(parts));
    const digest = hash.digest("hex");
    db.prepare(
      `INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version,
        review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at)
      VALUES (?, 'Large 64MiB', 'user', ?, 'a64m', 1, 1, 'awaiting_recipient', 0, 0, ?, ?)`,
    ).run(HANDOFF_ID, PROJECT_ID, now, now);
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES ('c-64m', NULL, ?, ?, ?, 1, ?)",
    ).run(storageKey, ARTIFACT_BYTES, digest, now);
    db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES ('a64m', ?, 'large.bin', 'large.bin', 'application/octet-stream', NULL, ?, 'c-64m')",
    ).run(HANDOFF_ID, now);
  }
  db.exec("COMMIT");
  db.close();

  let sweepTick: (() => Promise<SweepTickResult>) | null = null;
  let backupTick: (() => Promise<BackupTickResult>) | null = null;
  let currentTime = new Date("2026-08-30T09:00:00.000Z");

  const daemon = await serveDaemon({
    serverFactory: createDaemonServer,
    scheduleSweep: (run) => {
      sweepTick = run as () => Promise<SweepTickResult>;
      return () => {};
    },
    scheduleBackup: (run) => {
      backupTick = run as () => Promise<BackupTickResult>;
      return () => {};
    },
    now: () => currentTime,
    armSignals: () => {},
  });
  activeDaemon = daemon;
  const apiToken = readFileSync(join(home, "state", "api-token"), "utf8").trim();

  return {
    home,
    vault,
    port,
    apiToken,
    daemon,
    runSweep: () => (sweepTick as () => Promise<SweepTickResult>)(),
    runBackup: () => (backupTick as () => Promise<BackupTickResult>)(),
    setNow: (d: Date) => {
      currentTime = d;
    },
  };
}

describe("daemon event-loop responsiveness under slow git push and 64 MiB sweep (TASK-153 Metric 3)", () => {
  it("keeps GET /api/v1/health and Memo mutations responsive during a 1.5s POST /api/v1/backup/run push", async () => {
    const f = await setupFixture({ hookSleepSeconds: 1.5 });

    let backupCompleted = false;
    const backupPromise = httpJson(f.port, "/api/v1/backup/run", { method: "POST", bearer: f.apiToken }).then((res) => {
      backupCompleted = true;
      return res;
    });

    // Wait briefly for backup to enter git push, then hammer health + run real Memo create & update concurrently.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const healthLatencies: number[] = [];
    const probeLoop = (async () => {
      while (!backupCompleted) {
        const res = await httpJson(f.port, "/api/v1/health");
        expect(res.status).toBe(200);
        healthLatencies.push(res.elapsedMs);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();

    const memoCreate = await httpJson(f.port, "/api/v1/memos", {
      method: "POST",
      bearer: f.apiToken,
      body: { projectId: PROJECT_ID, title: "During slow push", body: "Created concurrently while pushing" },
    });
    expect(memoCreate.status).toBe(200);
    const createdData = (memoCreate.body as { ok: boolean; data: { memo: { id: string; rowVersion: number } } }).data;
    expect(backupCompleted).toBe(false);

    const memoPatch = await httpJson(f.port, `/api/v1/memos/${createdData.memo.id}`, {
      method: "PATCH",
      bearer: f.apiToken,
      body: {
        projectId: PROJECT_ID,
        title: "Updated during slow push",
        body: "Patched concurrently while pushing",
        expectedRowVersion: createdData.memo.rowVersion,
      },
    });
    expect(memoPatch.status).toBe(200);
    expect(backupCompleted).toBe(false);

    const backup = await backupPromise;
    await probeLoop;

    expect(backup.status).toBe(200);
    expect((backup.body as { ok: boolean; data: { push: string } }).data.push).toBe("pushed");
    expect(backup.elapsedMs).toBeGreaterThanOrEqual(1_400);

    expect(healthLatencies.length).toBeGreaterThanOrEqual(8);
    const maxHealthMs = Math.max(...healthLatencies);
    // TASK-147 pre-work baseline: 2,313.22 ms max during 1.5s git push.
    expect(maxHealthMs).toBeLessThan(250);
    expect(memoCreate.elapsedMs).toBeLessThan(500);
    expect(memoPatch.elapsedMs).toBeLessThan(500);
  }, 30_000);

  it("keeps health and Memo mutations responsive during async runBackupTick and prevents overlapping ticks", async () => {
    const f = await setupFixture({ hookSleepSeconds: 1.5 });

    let tickDone = false;
    const firstTick = f.runBackup().then((res) => {
      tickDone = true;
      return res;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    // A second overlapping tick while the first is in flight returns immediately without queueing or racing.
    const overlap = await f.runBackup();
    expect(overlap.action).toBe("none");
    expect(tickDone).toBe(false);

    const health = await httpJson(f.port, "/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.elapsedMs).toBeLessThan(250);
    expect(tickDone).toBe(false);

    const memo = await httpJson(f.port, "/api/v1/memos", {
      method: "POST",
      bearer: f.apiToken,
      body: { projectId: PROJECT_ID, title: "During scheduled push", body: "Responsive under tick" },
    });
    expect(memo.status).toBe(200);
    expect(memo.elapsedMs).toBeLessThan(500);
    expect(tickDone).toBe(false);

    const finished = await firstTick;
    expect(finished.action).toBe("ran");
  }, 30_000);

  it("keeps GET /api/v1/health and Memo mutations responsive during a 64 MiB streaming sweep", async () => {
    const f = await setupFixture({ seedLargeArtifact: true, hookSleepSeconds: 0 });

    let sweepDone = false;
    const sweepPromise = f.runSweep().then((res) => {
      sweepDone = true;
      return res;
    });

    const healthLatencies: number[] = [];
    const probeLoop = (async () => {
      while (!sweepDone) {
        const res = await httpJson(f.port, "/api/v1/health");
        expect(res.status).toBe(200);
        healthLatencies.push(res.elapsedMs);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    const memoCreate = await httpJson(f.port, "/api/v1/memos", {
      method: "POST",
      bearer: f.apiToken,
      body: { projectId: PROJECT_ID, title: "During 64MiB sweep", body: "No lock contention" },
    });
    expect(memoCreate.status).toBe(200);
    const memoData = (memoCreate.body as { ok: boolean; data: { memo: { id: string; rowVersion: number } } }).data;

    const memoPatch = await httpJson(f.port, `/api/v1/memos/${memoData.memo.id}`, {
      method: "PATCH",
      bearer: f.apiToken,
      body: {
        projectId: PROJECT_ID,
        title: "Updated during 64MiB sweep",
        body: "Still responsive",
        expectedRowVersion: memoData.memo.rowVersion,
      },
    });
    expect(memoPatch.status).toBe(200);

    const sweep = await sweepPromise;
    await probeLoop;

    expect(sweep.checked).toBe(1);
    expect(sweep.mismatches).toEqual([]);
    expect(sweep.bytes).toBe(ARTIFACT_BYTES);
    expect(sweep.failure).toBeUndefined();
    // TASK-147 pre-work baseline: 31.81 ms max during synchronous 64 MiB readFileSync sweep.
    expect(healthLatencies.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...healthLatencies)).toBeLessThan(30);
    expect(memoCreate.elapsedMs).toBeLessThan(250);
    expect(memoPatch.elapsedMs).toBeLessThan(250);
  }, 30_000);

  it("aborts an active 64 MiB sweep cleanly on drain without false ARTIFACT_CORRUPTED logs or lock leaks", async () => {
    const f = await setupFixture({ seedLargeArtifact: true, hookSleepSeconds: 0 });
    const sweepPromise = f.runSweep();
    // Immediately initiate drain while the 64 MiB streaming sweep is running.
    await f.daemon.drain();
    activeDaemon = null;

    const sweep = await sweepPromise;
    expect(sweep.mismatches).toEqual([]);
    expect(sweep.failure).toBeUndefined();

    // No false ARTIFACT_CORRUPTED warning was emitted during the drain abort.
    const logPath = join(f.home, "logs", "sorage.log");
    if (existsSync(logPath)) {
      expect(readFileSync(logPath, "utf8")).not.toContain("daemon.artifact_corrupted");
    }
    // daemon.lock and daemon.json were cleanly released after background ticks settled.
    expect(existsSync(join(f.home, "run", "daemon.json"))).toBe(false);
    const lock = createNodeDaemonPorts({ env: { SORAGE_HOME: f.home } }).acquireDaemonLock();
    expect(lock.ok).toBe(true);
    lock.release?.();
  }, 30_000);
});
