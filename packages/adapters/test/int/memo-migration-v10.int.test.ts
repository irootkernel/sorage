import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitKnownAppliedHistory } from "@sorage/core";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { migrate, SchemaAdmissionError, readAppliedRows } from "../../src/sqlite/migrator";
import {
  HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION,
  MEMO_SHARED_CONTENT_REBUILD_MIGRATION,
  MIGRATIONS,
  productionMigrationPlan,
} from "../../src/sqlite/migrations";
import { KNOWN_SCHEMA_HISTORY } from "@sorage/core";

/**
 * Migration 10 fidelity (SHR-009, SHR-014): the Memo component rebuild moves
 * every inline body into a fresh immutable content record with its exact
 * stored bytes — BOM, CRLF, empty bodies, and final-newline state included —
 * computed in the synchronous segmented callback, and preserves every Memo
 * UUID, metadata column, event row, pending intent, and the exact raw
 * retained receipts, with no repacking. The private `:memory:` reference
 * catalog path executes the same segments; a forward history refuses.
 */

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function v9Database(): { database: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "sorage-v10-"));
  homes.push(home);
  const database = join(home, "sorage.sqlite3");
  const db = openSorageDatabase(database);
  migrate(db, MIGRATIONS, () => "2026-01-01T00:00:00.000Z", {
    databasePath: database,
    rebuilds: [HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION],
  });
  db.close();
  return { database, home };
}

const PROJECT = "cd000000-0000-4000-8000-000000000001";

function seedV9Memos(database: string): Array<{ id: string; body: string }> {
  const bodies = [
    { id: "ab000000-0000-4000-8000-000000000001", body: "\uFEFFBOM+CRLF\r\nbody" },
    { id: "ab000000-0000-4000-8000-000000000002", body: "한글 😀 e\u0301 final newline\n" },
    { id: "ab000000-0000-4000-8000-000000000003", body: "" },
    { id: "ab000000-0000-4000-8000-000000000004", body: "no final newline" },
  ];
  const db = openSorageDatabase(database);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, 'p', 'P', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(PROJECT);
  for (const [index, entry] of bodies.entries()) {
    const state = index === 3 ? "done" : "open";
    db.prepare(
      `INSERT INTO project_memos (id, project_id, title, body, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by)
       VALUES (?, ?, ?, CAST(? AS TEXT), ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      PROJECT,
      `title-${String(index)}`,
      Buffer.from(entry.body, "utf8"),
      state,
      index === 3 ? 2 : 1,
      "2026-01-02T00:00:00.000Z",
      // A closed row satisfies the v7 CHECK: closed_at equals updated_at.
      index === 3 ? "2026-01-03T00:00:00.000Z" : "2026-01-02T00:00:00.000Z",
      JSON.stringify({ kind: "user", id: null }),
      JSON.stringify({ kind: "user", id: null }),
      state === "open" ? null : "2026-01-03T00:00:00.000Z",
      state === "open" ? null : JSON.stringify({ kind: "user", id: null }),
    );
    db.prepare(
      "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, NULL, ?, 'MEMO_CREATED', 'user', NULL, 1, ?, '2026-01-02T00:00:00.000Z')",
    ).run(
      randomUUID(),
      entry.id,
      JSON.stringify({ projectId: PROJECT, memoId: entry.id, rowVersion: 1, toState: "open" }),
    );
  }
  const firstBody = bodies[0];
  if (firstBody === undefined) throw new Error("fixture requires at least one Memo body");
  const legacyReceipt = JSON.stringify({
    memo: {
      id: firstBody.id,
      projectId: PROJECT,
      title: "title-0",
      body: firstBody.body,
      state: "open",
      rowVersion: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      createdBy: { kind: "user", id: null },
      updatedBy: { kind: "user", id: null },
      closedAt: null,
      closedBy: null,
    },
    changed: true,
    replayed: false,
  });
  db.prepare(
    "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, 'memo:ef000000-0000-4000-8000-000000000001:user', 'hash', ?, '2026-01-02T00:00:00.000Z', '2099-01-01T00:00:00.000Z')",
  ).run("ab000000-0000-4000-8000-0000000000aa", legacyReceipt);
  db.close();
  return bodies;
}

function upgradeToV10(database: string): void {
  const db = openSorageDatabase(database);
  try {
    const plan = productionMigrationPlan();
    migrate(db, plan.migrations, () => "2026-01-04T00:00:00.000Z", { databasePath: database, rebuilds: plan.rebuilds });
  } finally {
    db.close();
  }
}

describe("migration 10: memo-shared-content-v1", () => {
  it("moves inline bodies into exact immutable records and preserves every identity", () => {
    const { database } = v9Database();
    const bodies = seedV9Memos(database);
    upgradeToV10(database);
    const db = openSorageDatabase(database);
    const applied = readAppliedRows(db);
    expect(applied.map((row) => row.version)).toContain(10);
    for (const entry of bodies) {
      const row = db
        .prepare(
          `SELECT m.title AS title, m.state AS state, m.row_version AS rv, m.created_at AS ca, m.updated_at AS ua,
           c.id AS record, c.inline_text AS text, c.storage_key AS key, c.size_bytes AS size, c.sha256 AS sha, c.materialized AS mat
           FROM project_memos m JOIN content_records c ON c.id = m.content_record_id WHERE m.id = ?`,
        )
        .get(entry.id) as {
        title: string;
        state: string;
        rv: number;
        ca: string;
        ua: string;
        record: string;
        text: string;
        key: string | null;
        size: number;
        sha: string;
        mat: number;
      };
      expect(row.key).toBeNull();
      expect(row.mat).toBe(1);
      expect(row.size).toBe(Buffer.byteLength(entry.body, "utf8"));
      expect(row.sha).toBe(createHash("sha256").update(Buffer.from(entry.body, "utf8")).digest("hex"));
      // The stored TEXT keeps the exact accepted bytes including the BOM.
      const stored = db
        .prepare("SELECT CAST(inline_text AS BLOB) AS bytes FROM content_records WHERE id = ?")
        .get(row.record) as { bytes: Uint8Array };
      expect(Buffer.from(stored.bytes).toString("utf8")).toBe(entry.body);
      expect(Buffer.from(stored.bytes).equals(Buffer.from(entry.body, "utf8"))).toBe(true);
    }
    // Events, the memo event index, the append-only triggers, and receipts survive verbatim.
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE memo_id IS NOT NULL").get() as { n: number }).n).toBe(
      bodies.length,
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_memo_version'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'events_memo_association'").get(),
    ).toBeTruthy();
    const receipt = db
      .prepare("SELECT response_json FROM idempotency_keys WHERE key = ?")
      .get("ab000000-0000-4000-8000-0000000000aa") as { response_json: string } | undefined;
    const firstSeeded = bodies[0];
    expect(receipt !== undefined && firstSeeded !== undefined).toBe(true);
    expect(JSON.parse((receipt as { response_json: string }).response_json).memo.body).toBe(
      (firstSeeded as { id: string; body: string }).body,
    );
    db.close();
  });

  it("rolls back the whole batch and history when the backfill fails after its writes", () => {
    const { database } = v9Database();
    seedV9Memos(database);
    const before = openSorageDatabase(database);
    const beforeMemos = (
      before.prepare("SELECT id, title, body, state, row_version FROM project_memos ORDER BY id").all() as Array<
        Record<string, unknown>
      >
    ).map((row) => ({ ...row, body: Buffer.from(row.body as Uint8Array).toString("utf8") }));
    const beforeEvents = before.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    const beforeReceipts = before
      .prepare("SELECT key, response_json FROM idempotency_keys ORDER BY key")
      .all() as Array<{ key: string; response_json: string }>;
    const beforeHistory = readAppliedRows(before).map((row) => row.version);
    before.close();
    // The failing step performs the real backfill's writes first, so the
    // rollback must remove the newly written content records and memo rows.
    const originalBackfill = MEMO_SHARED_CONTENT_REBUILD_MIGRATION.backfill;
    const failing = {
      ...MEMO_SHARED_CONTENT_REBUILD_MIGRATION,
      backfill: (connection: Parameters<NonNullable<typeof originalBackfill>>[0]) => {
        (originalBackfill as (connection: Parameters<NonNullable<typeof originalBackfill>>[0]) => void)(connection);
        throw new Error("injected post-write backfill failure");
      },
    };
    const db = openSorageDatabase(database);
    let thrown: unknown = null;
    try {
      migrate(db, MIGRATIONS, () => "2026-01-04T00:00:00.000Z", { databasePath: database, rebuilds: [failing] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    // A MigrationFailedError (not a connection error) proves the dedicated
    // connection's foreign-key restoration was verified on every exit.
    expect((thrown as Error).name).not.toBe("MigrationConnectionError");
    db.close();
    const after = openSorageDatabase(database);
    const afterMemos = (
      after.prepare("SELECT id, title, body, state, row_version FROM project_memos ORDER BY id").all() as Array<
        Record<string, unknown>
      >
    ).map((row) => ({ ...row, body: Buffer.from(row.body as Uint8Array).toString("utf8") }));
    expect(afterMemos).toEqual(beforeMemos);
    expect((after.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(beforeEvents.n);
    expect(after.prepare("SELECT key, response_json FROM idempotency_keys ORDER BY key").all()).toEqual(beforeReceipts);
    // The backfill's newly written records and the rebuild's replacement tables are gone.
    expect((after.prepare("SELECT COUNT(*) AS n FROM content_records").get() as { n: number }).n).toBe(0);
    expect(
      after
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('project_memos_new', 'events_new', 'migration_v10_assertions')",
        )
        .all(),
    ).toEqual([]);
    // The v9-era trigger and memo indexes survive untouched.
    expect(
      after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'events_memo_association'").get(),
    ).toBeTruthy();
    expect(
      after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_memo_version'").get(),
    ).toBeTruthy();
    expect(readAppliedRows(after).map((row) => row.version)).toEqual(beforeHistory);
    expect((after.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    after.close();
    // The database remains migratable: the same plan converges afterwards.
    upgradeToV10(database);
    const converged = openSorageDatabase(database);
    expect(readAppliedRows(converged).map((row) => row.version)).toContain(10);
    converged.close();
  });

  it("refuses a forward applied history before any operational work", () => {
    const { database } = v9Database();
    upgradeToV10(database);
    const db = openSorageDatabase(database);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (11, 'future-v1', '2026-01-05T00:00:00.000Z')",
    ).run();
    const verdict = admitKnownAppliedHistory(readAppliedRows(db));
    expect(verdict.kind).toBe("unsupported");
    db.close();
    const reopened = openSorageDatabase(database);
    expect(() => {
      const plan = productionMigrationPlan();
      migrate(reopened, plan.migrations, () => "2026-01-05T00:00:00.000Z", {
        databasePath: database,
        rebuilds: plan.rebuilds,
      });
    }).toThrow(SchemaAdmissionError);
    reopened.close();
  });

  it("matches the central known-schema inventory", () => {
    const plan = productionMigrationPlan();
    const catalog = [
      ...plan.migrations.map((migration) => ({ version: migration.version, name: migration.name })),
      ...plan.rebuilds.map((migration) => ({ version: migration.version, name: migration.name })),
    ].sort((a, b) => a.version - b.version);
    expect(catalog).toEqual([...KNOWN_SCHEMA_HISTORY]);
  });
});
