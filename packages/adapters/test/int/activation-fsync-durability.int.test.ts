import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteIntentLog, executeIntent } from "../../src/intent-log";
import { activateCommonFile, completeCommonIntentTx } from "../../src/content-store";
import { createSqliteRevisionStore } from "../../src/handoffs";
import { createVaultInitializer } from "../../src/vault";
import { migrate } from "../../src/sqlite/migrator";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { makeArtifactContentBindings, makeTempDatabase } from "../../src/testkit";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The rename→parent-fsync durability regressions (VLT-022, SHR-005): an fsync
 * failure after a successful rename is never converted into a done assessment
 * by existence or content checks, and no activation settles before a
 * successful parent fsync. The fault seam is the same test-only vi.mock of
 * node:fs the preflight suite uses: every call delegates to the real
 * filesystem, and only fsyncSync throws a bounded number of injected EIO
 * errors while armed. All corruption-free fixtures are isolated temporary
 * installations; interleavings use real second connections and real
 * executors — these are observed instruction-order interleavings, not OS
 * parallelism or power-loss simulation.
 */
const fsControl = vi.hoisted(() => ({
  fsyncFailuresRemaining: 0,
  beforeDirectoryFsync: undefined as (() => void) | undefined,
  successfulDirectoryFsyncs: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      const directory = actual.fstatSync(args[0]).isDirectory();
      if (directory) {
        const before = fsControl.beforeDirectoryFsync;
        fsControl.beforeDirectoryFsync = undefined;
        before?.();
        if (fsControl.fsyncFailuresRemaining > 0) {
          fsControl.fsyncFailuresRemaining -= 1;
          throw Object.assign(new Error("injected parent fsync EIO"), { code: "EIO" });
        }
      }
      actual.fsyncSync(...args);
      if (directory) fsControl.successfulDirectoryFsyncs += 1;
    },
  };
});

const INSTALLATION = "210a0c9a-1111-4111-8111-1111111111e1";
const HANDOFF = "210a0c9a-2222-4222-8222-2222222222e2";
const ARTIFACT = "210a0c9a-3333-4333-8333-3333333333e3";
const RECORD = "210a0c9a-4444-4444-8444-4444444444e4";
const KEY = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;
const SHA = "5e".repeat(32);
const TIME = "2026-07-01T00:00:00.000Z";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
afterEach(() => {
  fsControl.fsyncFailuresRemaining = 0;
  fsControl.beforeDirectoryFsync = undefined;
  fsControl.successfulDirectoryFsyncs = 0;
  vi.restoreAllMocks();
});

type Fixture = ReturnType<typeof fixture>;

function fixture(prefix: string) {
  const vault = makeTempVault(prefix);
  cleanups.push(vault.cleanup);
  if (!createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION).ok) {
    throw new Error("fixture init must succeed");
  }
  const database = makeTempDatabase(`${prefix}db-`);
  cleanups.push(database.cleanup);
  const plan = productionMigrationPlan();
  migrate(database.db, plan.migrations, () => TIME, {
    databasePath: database.databasePath,
    rebuilds: plan.rebuilds,
  });
  const db = database.db;
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES ('210a0c9a-5555-4555-8555-5555555555e5', 'fsync', 'Fsync', NULL, 'active', ?, ?)",
  ).run(TIME, TIME);
  db.prepare(
    "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Fsync probe', 'user', '210a0c9a-5555-4555-8555-5555555555e5', ?, 1, 1, 'awaiting_recipient', ?, ?)",
  ).run(HANDOFF, ARTIFACT, TIME, TIME);
  db.prepare(
    "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 9, ?, 0, ?)",
  ).run(RECORD, KEY, SHA, TIME);
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
  ).run(ARTIFACT, HANDOFF, TIME, RECORD);
  db.exec("COMMIT");
  const ledger = createSqliteEventLedger(db);
  const bindings = () =>
    makeArtifactContentBindings({ db, ledger, vaultPath: vault.vaultPath, installationId: INSTALLATION });
  return {
    vaultPath: vault.vaultPath,
    databasePath: database.databasePath,
    db,
    ledger,
    bindings,
    log: createSqliteIntentLog({ db, installationId: INSTALLATION, events: ledger }),
  };
}

function eventsOf(db: Fixture["db"], type: string) {
  return db.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = ?").get(type) as { c: number };
}

/** The read-only mode a successfully placed or repaired managed file carries where the filesystem supports it. */
function readOnlyMode(path: string): boolean {
  return (statSync(path).mode & 0o777) === 0o444;
}

describe("legacy activation fsync durability (VLT-022)", () => {
  it("keeps the promise owed when the parent fsync fails after a successful rename, on first attempt and retry", () => {
    const f = fixture("sorage-fsync-legacy-owed-");
    writeFileSync(join(f.vaultPath, "staging", "staged-1"), "fsync body");
    expect(
      f.log.record([
        {
          id: "f-activate",
          op: "activate",
          fromPath: "staging/staged-1",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: TIME,
        },
      ]).ok,
    ).toBe(true);

    // First attempt: the rename lands, the parent fsync is the only failure.
    fsControl.fsyncFailuresRemaining = 2;
    const first = f.log.drain(f.vaultPath);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("INTERNAL_ERROR");
    // The file exists — the rename physically happened — yet nothing settled:
    // pending unchanged with zero attempts, the record stays unmaterialized,
    // and no success or failure event landed.
    expect(existsSync(join(f.vaultPath, KEY))).toBe(true);
    expect(existsSync(join(f.vaultPath, "staging", "staged-1"))).toBe(false);
    const owed = f.db.prepare("SELECT attempts FROM pending_fs_ops WHERE id = 'f-activate'").get() as {
      attempts: number;
    };
    expect(owed.attempts).toBe(0);
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 0,
    });
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED").c).toBe(0);
    expect(eventsOf(f.db, "ARTIFACT_INTEGRITY_FAILED").c).toBe(0);

    // Retry with the source absent and destination present: the idempotent
    // completion requires a successful parent fsync again, and the second
    // injected failure keeps the same promise owed.
    const second = f.log.drain(f.vaultPath);
    expect(second.ok).toBe(false);
    const stillOwed = f.db.prepare("SELECT attempts FROM pending_fs_ops WHERE id = 'f-activate'").get() as {
      attempts: number;
    };
    expect(stillOwed.attempts).toBe(0);
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 0,
    });
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED").c).toBe(0);

    // The repaired fsync completes exactly one activation, and the repaired
    // destination carries the same best-effort read-only mark a fresh
    // placement would have applied.
    fsControl.fsyncFailuresRemaining = 0;
    const third = f.log.drain(f.vaultPath);
    expect(third.ok).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 1,
    });
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED").c).toBe(1);
    expect(eventsOf(f.db, "ARTIFACT_INTEGRITY_FAILED").c).toBe(0);
    expect(readOnlyMode(join(f.vaultPath, KEY))).toBe(true);
  });

  it("a causal pair repairs into exactly one activation and only then its dependent unlink", () => {
    const f = fixture("sorage-fsync-legacy-causal-");
    writeFileSync(join(f.vaultPath, "staging", "staged-2"), "causal body");
    expect(
      f.log.record([
        { id: "a-unlink", op: "unlink", fromPath: null, toPath: KEY, artifactId: ARTIFACT, createdAt: TIME },
        {
          id: "z-activate",
          op: "activate",
          fromPath: "staging/staged-2",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: TIME,
        },
      ]).ok,
    ).toBe(true);

    fsControl.fsyncFailuresRemaining = 1;
    const failed = f.log.drain(f.vaultPath);
    expect(failed.ok).toBe(false);
    // The rename landed but nothing settled; the dependent unlink took no
    // attempt, no effect, and no event while its activation stayed pending.
    expect(existsSync(join(f.vaultPath, KEY))).toBe(true);
    const owed = f.log.pending();
    expect(owed.ok && owed.value.map((row) => row.id).sort()).toEqual(["a-unlink", "z-activate"]);
    expect(owed.ok && owed.value.find((row) => row.id === "a-unlink")?.attempts).toBe(0);
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED").c).toBe(0);
    expect(eventsOf(f.db, "ARTIFACT_UNLINKED").c).toBe(0);

    fsControl.fsyncFailuresRemaining = 0;
    const repaired = f.log.drain(f.vaultPath);
    expect(repaired.ok).toBe(true);
    // Exactly one activation — through the fsync-verified destination-present
    // completion — and only after that clear does the dependent unlink run.
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
    expect(existsSync(join(f.vaultPath, KEY))).toBe(false);
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED").c).toBe(1);
    expect(eventsOf(f.db, "ARTIFACT_UNLINKED").c).toBe(1);
  });

  it("suppresses a late executor fsync error after a competing executor genuinely fsynced and settled", () => {
    const f = fixture("sorage-fsync-legacy-compete-");
    writeFileSync(join(f.vaultPath, "staging", "staged-3"), "competed body");
    expect(
      f.log.record([
        {
          id: "c-activate",
          op: "activate",
          fromPath: "staging/staged-3",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: TIME,
        },
      ]).ok,
    ).toBe(true);

    // Hold the original executor after its real rename and before any parent
    // fsync. A second real connection verifies and fsyncs the destination,
    // settles the winner, then the original resumes with a late EIO.
    const successfulBefore = fsControl.successfulDirectoryFsyncs;
    let heldBeforeFsync = false;
    fsControl.beforeDirectoryFsync = () => {
      heldBeforeFsync = true;
      expect(existsSync(join(f.vaultPath, "staging", "staged-3"))).toBe(false);
      expect(readFileSync(join(f.vaultPath, KEY), "utf8")).toBe("competed body");
      expect(fsControl.successfulDirectoryFsyncs).toBe(successfulBefore);
      expect(f.db.prepare("SELECT attempts FROM pending_fs_ops WHERE id = 'c-activate'").get()).toMatchObject({
        attempts: 0,
      });
      expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
        materialized: 0,
      });
      expect(eventsOf(f.db, "ARTIFACT_ACTIVATED").c).toBe(0);
      const competitor = openSorageDatabase(f.databasePath);
      try {
        expect(executeIntent({ op: "activate", fromPath: "staging/staged-3", toPath: KEY }, f.vaultPath)).toBe("done");
        expect(fsControl.successfulDirectoryFsyncs).toBe(successfulBefore + 1);
        const ledger = createSqliteEventLedger(competitor);
        const settled = createSqliteRevisionStore(
          competitor,
          ledger,
          {},
          makeArtifactContentBindings({
            db: competitor,
            ledger,
            vaultPath: f.vaultPath,
            installationId: INSTALLATION,
          }),
        ).completeActivations([
          {
            intentId: "c-activate",
            artifactId: ARTIFACT,
            event: {
              id: "210a0c9a-6666-4666-8666-6666666666e6",
              handoffId: HANDOFF,
              eventType: "ARTIFACT_ACTIVATED",
              actor: { kind: "system", id: null },
              rowVersion: null,
              metadata: {},
              createdAt: TIME,
            },
          },
        ]);
        expect(settled).toMatchObject({ ok: true, value: { completed: 1 } });
      } finally {
        competitor.close();
      }
      throw Object.assign(new Error("late original parent fsync EIO"), { code: "EIO" });
    };
    const log = f.log;
    const drained = log.drain(f.vaultPath);
    expect(heldBeforeFsync).toBe(true);
    // The competitor's successful fsync settled the winner before this
    // executor's injected fsync error; the late error is a stale observation
    // that reports nothing — no false failure, no duplicate, drain healthy.
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED").c).toBe(1);
    expect(eventsOf(f.db, "ARTIFACT_INTEGRITY_FAILED").c).toBe(0);
    expect(readFileSync(join(f.vaultPath, KEY), "utf8")).toBe("competed body");
  });
});

describe("common activation fsync durability (SHR-005)", () => {
  const OWNER = "210a0c9a-7777-4777-8777-7777777777e7";
  const COMMON_RECORD = "210a0c9a-8888-4888-8888-8888888888e8";
  const COMMON_KEY = `content/memo/${OWNER}/${COMMON_RECORD}`;
  const COMMON_BODY = "common body";

  function commonFixture(prefix: string): Fixture {
    const f = fixture(prefix);
    const sha = createHash("sha256").update(Buffer.from(COMMON_BODY, "utf8")).digest("hex");
    f.db.exec("BEGIN");
    f.db
      .prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 0, ?)",
      )
      .run(COMMON_RECORD, COMMON_KEY, Buffer.byteLength(COMMON_BODY), sha, TIME);
    f.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES ('210a0c9a-9999-4999-8999-9999999999e9', 'activate', 'staging/common-staged', ?, NULL, 'memo', ?, ?, ?, 0)",
      )
      .run(COMMON_KEY, OWNER, COMMON_RECORD, TIME);
    f.db.exec("COMMIT");
    writeFileSync(join(f.vaultPath, "staging", "common-staged"), COMMON_BODY);
    return f;
  }

  it("maps a live-row parent fsync failure to the atomic io_error assessment and repairs into exactly one activation", () => {
    const f = commonFixture("sorage-fsync-common-");
    fsControl.fsyncFailuresRemaining = 2;
    const first = f.log.drain(f.vaultPath);
    // The common failure assessment is atomic and reported, never an error:
    // the intent stays with its attempt accounted, the record stays
    // unmaterialized, and no CONTENT_ACTIVATED landed despite the rename.
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (first.ok) expect(first.value.commonFailures).toHaveLength(1);
    expect(existsSync(join(f.vaultPath, COMMON_KEY))).toBe(true);
    const owed = f.db
      .prepare("SELECT attempts FROM pending_fs_ops WHERE id = '210a0c9a-9999-4999-8999-9999999999e9'")
      .get() as {
      attempts: number;
    };
    expect(owed.attempts).toBe(1);
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(COMMON_RECORD)).toMatchObject({
      materialized: 0,
    });
    expect(eventsOf(f.db, "CONTENT_ACTIVATED").c).toBe(0);
    expect(eventsOf(f.db, "CONTENT_INTEGRITY_FAILED").c).toBe(1);

    const failedRetry = f.log.drain(f.vaultPath);
    expect(failedRetry).toMatchObject({ ok: true, value: { commonFailures: [{ reason: "io_error" }] } });
    expect(
      f.db.prepare("SELECT attempts FROM pending_fs_ops WHERE id = '210a0c9a-9999-4999-8999-9999999999e9'").get(),
    ).toMatchObject({ attempts: 2 });
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(COMMON_RECORD)).toMatchObject({
      materialized: 0,
    });
    expect(eventsOf(f.db, "CONTENT_ACTIVATED").c).toBe(0);
    const failures = f.db
      .prepare("SELECT metadata_json FROM events WHERE event_type = 'CONTENT_INTEGRITY_FAILED' ORDER BY rowid")
      .all() as Array<{ metadata_json: string }>;
    expect(
      failures.map((row) => {
        const data = JSON.parse(row.metadata_json);
        return [data.reason, data.attempt];
      }),
    ).toEqual([
      ["io_error", 1],
      ["io_error", 2],
    ]);

    // The repaired retry verifies the recorded bytes AND fsyncs the parent
    // before done: exactly one activation settles, and the repaired file
    // carries the same best-effort read-only mark.
    fsControl.fsyncFailuresRemaining = 0;
    const second = f.log.drain(f.vaultPath);
    expect(second.ok).toBe(true);
    expect(
      f.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops WHERE id = '210a0c9a-9999-4999-8999-9999999999e9'").get(),
    ).toMatchObject({
      c: 0,
    });
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(COMMON_RECORD)).toMatchObject({
      materialized: 1,
    });
    expect(eventsOf(f.db, "CONTENT_ACTIVATED").c).toBe(1);
    expect(readOnlyMode(join(f.vaultPath, COMMON_KEY))).toBe(true);
  });

  it("suppresses a late executor fsync error after a competing common winner genuinely fsynced and settled", () => {
    const f = commonFixture("sorage-fsync-common-compete-");
    const successfulBefore = fsControl.successfulDirectoryFsyncs;
    let heldBeforeFsync = false;
    fsControl.beforeDirectoryFsync = () => {
      heldBeforeFsync = true;
      expect(existsSync(join(f.vaultPath, "staging", "common-staged"))).toBe(false);
      expect(readFileSync(join(f.vaultPath, COMMON_KEY), "utf8")).toBe(COMMON_BODY);
      expect(fsControl.successfulDirectoryFsyncs).toBe(successfulBefore);
      expect(
        f.db.prepare("SELECT attempts FROM pending_fs_ops WHERE id = '210a0c9a-9999-4999-8999-9999999999e9'").get(),
      ).toMatchObject({ attempts: 0 });
      expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(COMMON_RECORD)).toMatchObject({
        materialized: 0,
      });
      expect(eventsOf(f.db, "CONTENT_ACTIVATED").c).toBe(0);
      const competitor = openSorageDatabase(f.databasePath);
      try {
        const row = competitor
          .prepare("SELECT size_bytes, sha256 FROM content_records WHERE id = ?")
          .get(COMMON_RECORD) as { size_bytes: number; sha256: string };
        const outcome = activateCommonFile({
          vaultPath: f.vaultPath,
          fromPath: "staging/common-staged",
          toPath: COMMON_KEY,
          expect: { sizeBytes: row.size_bytes, sha256: row.sha256 },
        });
        expect(outcome.status).toBe("done");
        expect(fsControl.successfulDirectoryFsyncs).toBe(successfulBefore + 1);
        const settled = completeCommonIntentTx(
          competitor,
          createSqliteEventLedger(competitor),
          "210a0c9a-9999-4999-8999-9999999999e9",
          outcome,
        );
        expect(settled).toMatchObject({ ok: true, value: { status: "completed" } });
      } finally {
        competitor.close();
      }
      throw Object.assign(new Error("late original common parent fsync EIO"), { code: "EIO" });
    };
    const log = f.log;
    const drained = log.drain(f.vaultPath);
    expect(heldBeforeFsync).toBe(true);
    // The competing winner's successful fsync settled first; this executor's
    // late io_error meets the existing liveness gate and reports nothing — no
    // duplicate success, no false failure.
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect(
      f.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops WHERE id = '210a0c9a-9999-4999-8999-9999999999e9'").get(),
    ).toMatchObject({
      c: 0,
    });
    expect(eventsOf(f.db, "CONTENT_ACTIVATED").c).toBe(1);
    expect(eventsOf(f.db, "CONTENT_INTEGRITY_FAILED").c).toBe(0);
    expect(readOnlyMode(join(f.vaultPath, COMMON_KEY))).toBe(true);
  });
});
