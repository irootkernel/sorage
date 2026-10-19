import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeInstallation } from "@sorage/core";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The section-1 maintenance wiring regressions at both real production
 * entrypoints: drain, then the shared reference-proof cleanup in its own
 * transaction, then the freshly recomputed protection set, then the physical
 * GC, then the cache sweep. A legitimately removable record leaves through
 * the cleanup and its unguarded file follows through the recomputed GC; a
 * failed proof skips the physical GC entirely; and a live move fence pauses
 * the cleanup atomically with the GC skipped (R3.2 sections 1 and 3). The
 * late-handoff regressions prove the cleanup's own entry guard catches a
 * vault-move.lock acquired after a successful drain, before the cleanup
 * transaction opens — the window between the file lock and the later SQL
 * switch fence that no earlier check covers.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

const PROJECT = "1e0a0c9a-2222-4222-8222-2222222222e2";
const HANDOFF = "1e0a0c9a-3333-4333-8333-3333333333e3";
const ARTIFACT = "1e0a0c9a-4444-4444-8444-4444444444e4";
const RECORD = "1e0a0c9a-5555-4555-8555-5555555555e5";
const RETAINED_RECORD = "1e0a0c9a-6666-4666-8666-6666666666e6";
const NEW_HANDOFF = "1e0a0c9a-1212-4121-8121-1212121212e1";
const NEW_ARTIFACT = "1e0a0c9a-7777-4777-8777-7777777777e7";
const NEW_RECORD = "1e0a0c9a-8888-4888-8888-8888888888e8";
const ACTIVATION_INTENT = "1e0a0c9a-9999-4999-8999-9999999999e9";
const NEW_KEY = `artifacts/${NEW_HANDOFF}/${NEW_ARTIFACT}/arriving.md`;
const STAGED_NAME = "late-handoff-staged";
const NEW_BODY = "arriving bytes\n";
const FETCH_CACHE_CANARY = "6c".repeat(32);
const LIVE_BODY = "live bytes\n";
const RETAINED_BODY = "retained bytes\n";
const ORPHAN_BODY = "orphaned long ago";
const CACHE_BODY = "cached long ago";
const LIVE_KEY = `artifacts/${HANDOFF}/${ARTIFACT}/live.md`;
const RETAINED_KEY = `artifacts/${HANDOFF}/retired/retained.md`;
const AGED = new Date(Date.now() - 400 * 24 * 3_600_000);

interface MaintenanceFixture {
  home: string;
  vault: string;
  database: string;
}

function initializedHome(prefix: string): MaintenanceFixture {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  const result = initializeInstallation(ports, { vaultPath: vault });
  if (!result.ok) throw new Error(result.error.message);
  return { home, vault, database: join(home, "state", "sorage.sqlite3") };
}

function seedGraph(
  fixture: MaintenanceFixture,
  options: { retainedFile?: boolean; corruptRetainedKey?: boolean; ageFiles?: boolean } = {},
): void {
  const body = "live bytes\n";
  const retainedBody = "retained bytes\n";
  const db = openSorageDatabase(fixture.database);
  try {
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'maint', 'Maint', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(PROJECT);
    db.prepare(
      "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Maint probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
    ).run(HANDOFF, PROJECT, ARTIFACT);
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, '2026-01-02T00:00:00.000Z')",
    ).run(RECORD, LIVE_KEY, Buffer.byteLength(body), hashOf(body));
    db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'live.md', 'live.md', 'text/markdown', NULL, '2026-01-02T00:00:00.000Z', ?)",
    ).run(ARTIFACT, HANDOFF, RECORD);
    if (options.retainedFile === true) {
      // A retained record no Artifact row references — exactly the state the
      // maintenance cleanup owns — with its unguarded file aged past grace.
      db.prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, '2026-01-02T00:00:00.000Z')",
      ).run(
        RETAINED_RECORD,
        options.corruptRetainedKey === true ? "../outside/retained.md" : RETAINED_KEY,
        Buffer.byteLength(retainedBody),
        hashOf(retainedBody),
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  mkdirSync(join(fixture.vault, LIVE_KEY.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(fixture.vault, LIVE_KEY), body);
  if (options.retainedFile === true && options.corruptRetainedKey !== true) {
    mkdirSync(join(fixture.vault, RETAINED_KEY.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(fixture.vault, RETAINED_KEY), retainedBody);
    if (options.ageFiles === true) utimesSync(join(fixture.vault, RETAINED_KEY), AGED, AGED);
  }
}

function hashOf(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

/** The fixture of the late-handoff regressions: a real resolvable activation on its own current Handoff plus the maintenance cleanup's own workload. */
function seedLateHandoff(fixture: MaintenanceFixture): void {
  seedGraph(fixture, { retainedFile: true, ageFiles: true });
  const db = openSorageDatabase(fixture.database);
  try {
    db.exec("BEGIN");
    // The arriving Artifact is its own Handoff's current Artifact: a genuine
    // current graph shape, inserted through the deferred reference cycle in
    // the same transaction, while the live Handoff and its recorded file stay
    // independently protected.
    db.prepare(
      "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Late handoff probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')",
    ).run(NEW_HANDOFF, PROJECT, NEW_ARTIFACT);
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 0, '2026-01-03T00:00:00.000Z')",
    ).run(NEW_RECORD, NEW_KEY, Buffer.byteLength(NEW_BODY), hashOf(NEW_BODY));
    db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'arriving.md', 'arriving.md', 'text/markdown', NULL, '2026-01-03T00:00:00.000Z', ?)",
    ).run(NEW_ARTIFACT, NEW_HANDOFF, NEW_RECORD);
    db.prepare(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'activate', ?, ?, ?, '2026-01-03T00:00:00.000Z', 0)",
    ).run(ACTIVATION_INTENT, `staging/${STAGED_NAME}`, NEW_KEY, NEW_ARTIFACT);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  writeFileSync(join(fixture.vault, "staging", STAGED_NAME), NEW_BODY);
  // An aged unreferenced orphan under artifacts/ the GC would collect, and an
  // aged valid fetch-cache canary the cache sweep would remove: both must
  // survive a paused maintenance run untouched.
  const orphan = join(fixture.vault, "artifacts", "h-late-orphan", "old.md");
  mkdirSync(dirname(orphan), { recursive: true });
  writeFileSync(orphan, ORPHAN_BODY);
  utimesSync(orphan, AGED, AGED);
  const cacheDir = join(fixture.home, "state", "fetch-cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, FETCH_CACHE_CANARY), CACHE_BODY);
  utimesSync(join(cacheDir, FETCH_CACHE_CANARY), AGED, AGED);
}

/**
 * The honest deterministic post-drain/pre-cleanup barrier: the maintenance
 * entrypoint evaluates the cleanup's clock argument only after the drain has
 * returned, so a clock that observes — through an owned real read connection —
 * that the seeded pending activation has vanished arms a one-shot live
 * vault-move.lock exactly in the handoff window, after the drain's committed
 * resolution and before the cleanup transaction opens. The file write happens
 * between the two, never inside any UnitOfWork; the post-drain baseline is
 * captured at the same instant the lock lands.
 */
function lateLockClock(
  fixture: MaintenanceFixture,
  baseline: { captured: boolean; pending: unknown[]; records: unknown[]; artifacts: unknown[]; events: unknown[] },
): { now(): Date } {
  let armed = false;
  return {
    now(): Date {
      if (armed) return new Date();
      const probe = openSorageDatabase(fixture.database);
      let pendingEmpty = false;
      try {
        const row = probe.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops WHERE id = ?").get(ACTIVATION_INTENT) as {
          c: number;
        };
        pendingEmpty = row.c === 0;
        if (pendingEmpty) {
          baseline.pending = probe.prepare("SELECT * FROM pending_fs_ops ORDER BY id").all();
          baseline.records = probe.prepare("SELECT * FROM content_records ORDER BY id").all();
          baseline.artifacts = probe.prepare("SELECT * FROM artifacts ORDER BY id").all();
          baseline.events = probe
            .prepare(
              "SELECT id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at FROM events ORDER BY id",
            )
            .all();
        }
      } finally {
        probe.close();
      }
      if (!pendingEmpty) return new Date();
      armed = true;
      writeFileSync(
        join(fixture.home, "run", "vault-move.lock"),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
      );
      baseline.captured = true;
      return new Date();
    },
  };
}

/**
 * The shared late-handoff regression body: the paused call's exact
 * SERVICE_PAUSED with the expected lock path, proof the drain genuinely
 * completed before the lock landed, byte-identical preservation against the
 * captured post-drain baseline with the GC and cache sweep skipped, and full
 * convergence of the same production entrypoint after the lock is released.
 */
function runLateHandoffRegression(
  fixture: MaintenanceFixture,
  baseline: { captured: boolean; pending: unknown[]; records: unknown[]; artifacts: unknown[]; events: unknown[] },
  paused: { ok: boolean; error?: { code: string; details?: unknown } },
  release: { rerun: () => { ok: boolean } },
): void {
  expect(paused.ok).toBe(false);
  if (!paused.ok) {
    expect(paused.error?.code).toBe("SERVICE_PAUSED");
    expect((paused.error?.details as { lockPath?: string } | undefined)?.lockPath).toBe(
      join(fixture.home, "run", "vault-move.lock"),
    );
  }

  // The drain genuinely completed before the lock landed: the activation
  // reached its destination with its parent fsynced and its exact bytes, its
  // record materialized, its intent cleared, its staged source gone, and
  // exactly one correct event appended — a census proxy cannot masquerade as
  // this.
  expect(readFileSync(join(fixture.vault, NEW_KEY), "utf8")).toBe(NEW_BODY);
  expect(existsSync(join(fixture.vault, "staging", STAGED_NAME))).toBe(false);
  expect(baseline.captured).toBe(true);
  expect(baseline.pending).toEqual([]);
  expect(
    (baseline.records as Array<{ id: string; materialized: number }>).find((row) => row.id === NEW_RECORD)
      ?.materialized,
  ).toBe(1);
  const activation = (
    baseline.events as Array<{ event_type: string; handoff_id: string; metadata_json: string }>
  ).filter((row) => row.event_type === "ARTIFACT_ACTIVATED");
  expect(activation).toHaveLength(1);
  expect(activation[0]?.handoff_id).toBe(NEW_HANDOFF);
  expect(JSON.parse(activation[0]?.metadata_json ?? "{}")).toEqual({
    storageKey: NEW_KEY,
    sha256: hashOf(NEW_BODY),
  });

  // Against that post-drain baseline, the paused run changed nothing: the
  // retained record, every remaining row, and the ledger stand exactly as
  // the drain left them, and neither the physical GC nor the cache sweep
  // ran — the retained file, the aged orphan, and the aged fetch-cache
  // canary all survive untouched with their exact bytes.
  const verify = openSorageDatabase(fixture.database);
  try {
    expect(verify.prepare("SELECT * FROM pending_fs_ops ORDER BY id").all()).toEqual(baseline.pending);
    expect(verify.prepare("SELECT * FROM content_records ORDER BY id").all()).toEqual(baseline.records);
    expect(verify.prepare("SELECT * FROM artifacts ORDER BY id").all()).toEqual(baseline.artifacts);
    expect(
      verify
        .prepare(
          "SELECT id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at FROM events ORDER BY id",
        )
        .all(),
    ).toEqual(baseline.events);
  } finally {
    verify.close();
  }
  expect(readFileSync(join(fixture.vault, RETAINED_KEY), "utf8")).toBe(RETAINED_BODY);
  expect(readFileSync(join(fixture.vault, "artifacts", "h-late-orphan", "old.md"), "utf8")).toBe(ORPHAN_BODY);
  expect(readFileSync(join(fixture.home, "state", "fetch-cache", FETCH_CACHE_CANARY), "utf8")).toBe(CACHE_BODY);
  expect(readFileSync(join(fixture.vault, LIVE_KEY), "utf8")).toBe(LIVE_BODY);

  // Releasing the lock lets the same production entrypoint converge: the
  // retained record leaves through the cleanup, its unguarded aged file,
  // the aged orphan, and the aged cache canary are all collected, while the
  // live recorded file and the newly activated record stay protected with
  // their exact bytes.
  rmSync(join(fixture.home, "run", "vault-move.lock"), { force: true });
  const converged = release.rerun();
  expect(converged.ok).toBe(true);
  const final = openSorageDatabase(fixture.database);
  try {
    const records = final.prepare("SELECT id FROM content_records ORDER BY id").all() as Array<{ id: string }>;
    expect(records.map((row) => row.id).sort()).toEqual([NEW_RECORD, RECORD].sort());
  } finally {
    final.close();
  }
  expect(existsSync(join(fixture.vault, RETAINED_KEY))).toBe(false);
  expect(existsSync(join(fixture.vault, "artifacts", "h-late-orphan", "old.md"))).toBe(false);
  expect(existsSync(join(fixture.home, "state", "fetch-cache", FETCH_CACHE_CANARY))).toBe(false);
  expect(readFileSync(join(fixture.vault, LIVE_KEY), "utf8")).toBe(LIVE_BODY);
  expect(readFileSync(join(fixture.vault, NEW_KEY), "utf8")).toBe(NEW_BODY);
}

describe("the vault maintenance entrypoint (R3.2 section 1)", () => {
  it("drains, cleans the retained record, recomputes protection, and collects the freed file", () => {
    const fixture = initializedHome("sorage-maint-vault-clean-");
    seedGraph(fixture, { retainedFile: true, ageFiles: true });
    const drained = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).drainAtStart();
    expect(drained.ok).toBe(true);
    const db = openSorageDatabase(fixture.database);
    try {
      expect(db.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({ c: 1 });
      expect(db.prepare("SELECT id FROM content_records").get()).toMatchObject({ id: RECORD });
    } finally {
      db.close();
    }
    // The freed file left with its record; the live recorded file survives.
    expect(existsSync(join(fixture.vault, RETAINED_KEY))).toBe(false);
    expect(existsSync(join(fixture.vault, LIVE_KEY))).toBe(true);
  });

  it("propagates the refused cleanup proof exactly and preserves every row and file", () => {
    const fixture = initializedHome("sorage-maint-vault-proof-");
    seedGraph(fixture, { retainedFile: true, corruptRetainedKey: true, ageFiles: true });
    const orphan = join(fixture.vault, "artifacts", "h-maint-orphan", "old.md");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "orphaned long ago");
    utimesSync(orphan, AGED, AGED);
    const drained = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).drainAtStart();
    // The failed proof surfaces its exact error — never a healthy drain — and
    // the physical GC and cache sweep never ran: the aged orphan and every
    // owned file survive exactly as they were, and no record was removed.
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(join(fixture.vault, LIVE_KEY))).toBe(true);
    const db = openSorageDatabase(fixture.database);
    try {
      expect(db.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({ c: 2 });
    } finally {
      db.close();
    }
  });

  it("propagates the cleanup's SERVICE_PAUSED from a live database fence with atomic preservation", () => {
    const fixture = initializedHome("sorage-maint-vault-dbfence-");
    seedGraph(fixture, { retainedFile: true, ageFiles: true });
    const orphan = join(fixture.vault, "artifacts", "h-maint-fence", "old.md");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "orphaned long ago");
    utimesSync(orphan, AGED, AGED);
    // A live mover fence in the database only — no run lockfile, so the drain
    // itself proceeds and the cleanup's own fence check aborts atomically.
    const db = openSorageDatabase(fixture.database);
    try {
      db.prepare("INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?)").run(
        process.pid,
        "2026-01-01T00:00:00.000Z",
      );
    } finally {
      db.close();
    }
    try {
      const drained = createNodeVaultCommandPorts({
        env: { SORAGE_HOME: fixture.home },
        userHome: fixture.home,
      }).drainAtStart();
      expect(drained.ok).toBe(false);
      if (!drained.ok) expect(drained.error.code).toBe("SERVICE_PAUSED");
      expect(existsSync(orphan)).toBe(true);
      expect(existsSync(join(fixture.vault, RETAINED_KEY))).toBe(true);
      expect(existsSync(join(fixture.vault, LIVE_KEY))).toBe(true);
      const verify = openSorageDatabase(fixture.database);
      try {
        expect(verify.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({ c: 2 });
      } finally {
        verify.close();
      }
    } finally {
      const clear = openSorageDatabase(fixture.database);
      try {
        clear.prepare("UPDATE vault_state SET move_fence_pid = NULL, move_fence_at = NULL WHERE id = 1").run();
      } finally {
        clear.close();
      }
    }
  });

  it("pauses the cleanup atomically behind a live move fence and skips the GC", () => {
    const fixture = initializedHome("sorage-maint-vault-fence-");
    seedGraph(fixture, { retainedFile: true, ageFiles: true });
    const orphan = join(fixture.vault, "artifacts", "h-maint-fence", "old.md");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "orphaned long ago");
    utimesSync(orphan, AGED, AGED);
    const lock = join(fixture.home, "run", "vault-move.lock");
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
    );
    try {
      const drained = createNodeVaultCommandPorts({
        env: { SORAGE_HOME: fixture.home },
        userHome: fixture.home,
      }).drainAtStart();
      // The drain itself pauses behind the live lock: no cleanup, no GC, and
      // every promise and file survives untouched.
      expect(drained.ok).toBe(false);
      if (!drained.ok) expect(drained.error.code).toBe("SERVICE_PAUSED");
      expect(existsSync(orphan)).toBe(true);
      expect(existsSync(join(fixture.vault, RETAINED_KEY))).toBe(true);
      expect(existsSync(join(fixture.vault, LIVE_KEY))).toBe(true);
      const db = openSorageDatabase(fixture.database);
      try {
        expect(db.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({ c: 2 });
      } finally {
        db.close();
      }
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it("pauses the cleanup exactly when a live vault-move.lock lands after a successful drain, and converges after release", () => {
    const fixture = initializedHome("sorage-maint-vault-late-");
    seedLateHandoff(fixture);
    const baseline = { captured: false, pending: [], records: [], artifacts: [], events: [] };
    // The ports are constructed while no lock exists: the drain must run to
    // completion before the barrier arms.
    const ports = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
      clock: lateLockClock(fixture, baseline),
    });
    runLateHandoffRegression(fixture, baseline, ports.drainAtStart(), {
      rerun: () =>
        createNodeVaultCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home }).drainAtStart(),
    });
  });
});

describe("the pre-backup maintenance entrypoint (R3.2 section 1)", () => {
  it("cleans the retained record and collects the freed file after the drain", () => {
    const fixture = initializedHome("sorage-maint-backup-clean-");
    seedGraph(fixture, { retainedFile: true, ageFiles: true });
    const drained = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).drainAtStart();
    expect(drained.ok).toBe(true);
    const db = openSorageDatabase(fixture.database);
    try {
      expect(db.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({ c: 1 });
    } finally {
      db.close();
    }
    expect(existsSync(join(fixture.vault, RETAINED_KEY))).toBe(false);
    expect(existsSync(join(fixture.vault, LIVE_KEY))).toBe(true);
  });

  it("propagates the refused cleanup proof exactly and preserves every row and file", () => {
    const fixture = initializedHome("sorage-maint-backup-proof-");
    seedGraph(fixture, { retainedFile: true, corruptRetainedKey: true, ageFiles: true });
    const orphan = join(fixture.vault, "artifacts", "h-maint-orphan", "old.md");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "orphaned long ago");
    utimesSync(orphan, AGED, AGED);
    const drained = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
    }).drainAtStart();
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(join(fixture.vault, LIVE_KEY))).toBe(true);
    const db = openSorageDatabase(fixture.database);
    try {
      expect(db.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({ c: 2 });
    } finally {
      db.close();
    }
  });

  it("pauses the cleanup exactly when a live vault-move.lock lands after a successful drain, and converges after release", () => {
    const fixture = initializedHome("sorage-maint-backup-late-");
    seedLateHandoff(fixture);
    const baseline = { captured: false, pending: [], records: [], artifacts: [], events: [] };
    // The ports are constructed while no lock exists: the pre-backup drain
    // must run to completion before the barrier arms.
    const ports = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: fixture.home },
      userHome: fixture.home,
      clock: lateLockClock(fixture, baseline),
    });
    runLateHandoffRegression(fixture, baseline, ports.drainAtStart(), {
      rerun: () =>
        createNodeBackupCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: fixture.home }).drainAtStart(),
    });
  });

  it("propagates the cleanup's SERVICE_PAUSED from a live database fence with atomic preservation", () => {
    const fixture = initializedHome("sorage-maint-backup-dbfence-");
    seedGraph(fixture, { retainedFile: true, ageFiles: true });
    const orphan = join(fixture.vault, "artifacts", "h-maint-fence", "old.md");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "orphaned long ago");
    utimesSync(orphan, AGED, AGED);
    const db = openSorageDatabase(fixture.database);
    try {
      db.prepare("INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?)").run(
        process.pid,
        "2026-01-01T00:00:00.000Z",
      );
    } finally {
      db.close();
    }
    try {
      const drained = createNodeBackupCommandPorts({
        env: { SORAGE_HOME: fixture.home },
        userHome: fixture.home,
      }).drainAtStart();
      expect(drained.ok).toBe(false);
      if (!drained.ok) expect(drained.error.code).toBe("SERVICE_PAUSED");
      expect(existsSync(orphan)).toBe(true);
      expect(existsSync(join(fixture.vault, RETAINED_KEY))).toBe(true);
      expect(existsSync(join(fixture.vault, LIVE_KEY))).toBe(true);
      const verify = openSorageDatabase(fixture.database);
      try {
        expect(verify.prepare("SELECT COUNT(*) AS c FROM content_records").get()).toMatchObject({ c: 2 });
      } finally {
        verify.close();
      }
    } finally {
      const clear = openSorageDatabase(fixture.database);
      try {
        clear.prepare("UPDATE vault_state SET move_fence_pid = NULL, move_fence_at = NULL WHERE id = 1").run();
      } finally {
        clear.close();
      }
    }
  });
});
