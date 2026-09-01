import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { FakeClock } from "@sorage/adapters/src/testkit/fakes";
import { initializeInstallation } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonServer } from "../../src/server";
import { serveDaemon } from "../../src/runtime";

/**
 * The TASK-056 daemon scheduler over a real installation (RUN-002, BKP-002,
 * BKP-015, BKP-026): the tick the daemon owns catches a run missed during a
 * sleep gap up exactly once, refuses to race a held backup.lock, does nothing
 * while the schedule is off, and drives the on-time run through the same
 * engine a manual run uses.
 */
let home: string | null = null;
afterEach(() => {
  if (home !== null) {
    delete process.env.SORAGE_HOME;
    rmSync(home, { recursive: true, force: true });
    home = null;
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

const HANDOFF_ID = "1a111111-1111-4111-8111-111111111111";

function fixture(prefix: string, options: { catchUp?: boolean } = {}): string {
  home = mkdtempSync(join(tmpdir(), prefix));
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const initPorts = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: homedir(), clock: new FakeClock() });
  if (!initializeInstallation(initPorts, { vaultPath: vault }).ok) throw new Error("init failed");
  const store = createNodeConfigCommandPorts().store;
  const config = store.read();
  if (!config.ok || config.value === null) throw new Error("config read failed");
  config.value.config.gitBackup.enabled = true;
  config.value.config.gitBackup.schedule.at = "03:00";
  config.value.config.gitBackup.schedule.timezone = "UTC";
  config.value.config.gitBackup.schedule.catchUpAfterMissedRun = options.catchUp !== false;
  if (!store.write(config.value.config, { revision: config.value.revision }).ok) throw new Error("config write failed");

  const artifactBytes = "# The brief\n";
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at)
    VALUES ('p-1', 'beta', 'Beta', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  mkdirSync(join(vault, "artifacts", HANDOFF_ID, "a-1"), { recursive: true });
  writeFileSync(join(vault, `artifacts/${HANDOFF_ID}/a-1/brief.md`), artifactBytes);
  db.prepare(
    `INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version,
      review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at)
    VALUES (?, 'Brief', 'user', 'p-1', 'a-1', 1, 1, 'awaiting_recipient', 0, 0,
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  ).run(HANDOFF_ID);
  db.prepare(
    `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256,
      materialized, created_at) VALUES ('a-1', ?, ?, 'brief.md', 'brief.md', 'text/markdown', ?, ?, 1, '2026-01-02T00:00:00.000Z')`,
  ).run(
    HANDOFF_ID,
    `artifacts/${HANDOFF_ID}/a-1/brief.md`,
    artifactBytes.length,
    createHash("sha256").update(artifactBytes).digest("hex"),
  );
  db.exec("COMMIT");
  db.close();
  return home;
}

function rowsOf(atHome: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(atHome, "state", "sorage.sqlite3"));
  try {
    return db.prepare("SELECT * FROM backup_runs ORDER BY started_at").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

async function startScheduledDaemon(times: Date[]): Promise<{
  tick: () => unknown;
  stop: () => Promise<void>;
}> {
  const port = await freePort();
  const store = createNodeConfigCommandPorts().store;
  const config = store.read();
  if (!config.ok || config.value === null) throw new Error("config read failed");
  config.value.config.server.port = port;
  if (!store.write(config.value.config, { revision: config.value.revision }).ok) throw new Error("port write failed");
  let tick: () => unknown = () => undefined;
  const running = await serveDaemon({
    serverFactory: createDaemonServer,
    scheduleSweep: () => () => {},
    scheduleBackup: (run) => {
      tick = run as () => unknown;
      return () => {};
    },
    now: () => times[times.length - 1] as Date,
  });
  return {
    tick,
    stop: () => running.drain(),
  };
}

describe("the daemon backup scheduler tick", () => {
  it("catches a run missed during a sleep gap up exactly once (BKP-015)", async () => {
    const atHome = fixture("sorage-sched-catchup-");
    const times = [new Date("2026-08-30T09:00:00.000Z"), new Date("2026-08-30T09:01:00.000Z")];
    const daemon = await startScheduledDaemon(times);
    try {
      const first = daemon.tick() as { action: string; triggeredBy?: string };
      expect(first.action).toBe("ran");
      expect(first.triggeredBy).toBe("catch-up");
      times.pop();
      const second = daemon.tick() as { action: string };
      expect(second.action).toBe("none");
      const rows = rowsOf(atHome);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ triggered_by: "catch-up", outcome: "success" });
      expect(existsSync(join(atHome, "vault", ".git"))).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 20000);

  it("runs the on-time tick as scheduled and not as catch-up", async () => {
    const atHome = fixture("sorage-sched-ontime-");
    const times = [new Date("2026-08-30T03:00:30.000Z")];
    const daemon = await startScheduledDaemon(times);
    try {
      const decision = daemon.tick() as { action: string; triggeredBy?: string };
      expect(decision.action).toBe("ran");
      expect(decision.triggeredBy).toBe("scheduled");
      expect(rowsOf(atHome)).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  }, 20000);

  it("does nothing at all while the schedule is disabled", async () => {
    const atHome = fixture("sorage-sched-disabled-");
    const store = createNodeConfigCommandPorts().store;
    const config = store.read();
    if (!config.ok || config.value === null) throw new Error("config read failed");
    config.value.config.gitBackup.enabled = false;
    expect(store.write(config.value.config, { revision: config.value.revision }).ok).toBe(true);
    const times = [new Date("2026-08-30T09:00:00.000Z")];
    const daemon = await startScheduledDaemon(times);
    try {
      const decision = daemon.tick() as { action: string; nextDueAt: string | null };
      expect(decision.action).toBe("none");
      expect(decision.nextDueAt).toBeNull();
      expect(rowsOf(atHome)).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  }, 20000);

  it("skips the missed run entirely when catch-up is disabled", async () => {
    const atHome = fixture("sorage-sched-nocatchup-", { catchUp: false });
    const times = [new Date("2026-08-30T09:00:00.000Z")];
    const daemon = await startScheduledDaemon(times);
    try {
      const decision = daemon.tick() as { action: string; nextDueAt: string | null };
      expect(decision.action).toBe("none");
      expect(decision.nextDueAt).toBe("2026-08-31T03:00:00.000Z");
      expect(rowsOf(atHome)).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  }, 20000);

  it("refuses to race a held backup.lock instead of queueing (BKP-006)", async () => {
    const atHome = fixture("sorage-sched-lock-");
    mkdirSync(join(atHome, "run"), { recursive: true });
    writeFileSync(
      join(atHome, "run", "backup.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
    );
    const times = [new Date("2026-08-30T09:00:00.000Z")];
    const daemon = await startScheduledDaemon(times);
    try {
      const decision = daemon.tick() as { action: string };
      expect(decision.action).toBe("failed");
      expect(rowsOf(atHome)).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  }, 20000);

  it("resolves a nonexistent spring-forward time to the next valid instant through the tick's status", async () => {
    // The unit suite pins the computation; this proves the status surface a CLI
    // caller reads carries the same zone-aware nextDueAt.
    const atHome = fixture("sorage-sched-dst-");
    const store = createNodeConfigCommandPorts().store;
    const config = store.read();
    if (!config.ok || config.value === null) throw new Error("config read failed");
    config.value.config.gitBackup.schedule.at = "02:30";
    config.value.config.gitBackup.schedule.timezone = "America/New_York";
    expect(store.write(config.value.config, { revision: config.value.revision }).ok).toBe(true);
    // A manual run just now covers the previous due instant, so the tick only
    // reports the zone-aware next due time instead of catching anything up.
    const db = new DatabaseSync(join(atHome, "state", "sorage.sqlite3"));
    db.prepare(
      `INSERT INTO backup_runs (id, triggered_by, started_at, finished_at, outcome, snapshot_outcome,
        commit_outcome, push_outcome) VALUES ('cover', 'manual', '2026-03-07T12:00:00.000Z', '2026-03-07T12:00:01.000Z',
        'success', 'success', 'no-change', 'disabled')`,
    ).run();
    db.close();
    const times = [new Date("2026-03-07T12:00:05.000Z")];
    const daemon = await startScheduledDaemon(times);
    try {
      const decision = daemon.tick() as { action: string; nextDueAt: string | null };
      expect(decision.action).toBe("none");
      // 02:30 does not exist on 2026-03-08 in New York; the next valid instant is 03:00 EDT.
      expect(decision.nextDueAt).toBe("2026-03-08T07:00:00.000Z");
      // Only the covering manual row exists; the tick ran nothing.
      expect(rowsOf(atHome)).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  }, 20000);
});
