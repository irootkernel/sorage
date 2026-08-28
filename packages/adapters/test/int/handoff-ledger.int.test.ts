import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { errorSpec } from "@sorage/core";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteHandoffRowStore } from "../../src/handoffs";
import { createSqliteIntentLog } from "../../src/intent-log";
import { createSqliteProjectRepository } from "../../src/projects";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { createVaultInitializer } from "../../src/vault";

/**
 * The TASK-028 ledger and compare-and-set evidence: every Project mutation appends
 * its lifecycle event inside the same transaction and no read appends anything,
 * the Row Version compare-and-set lets exactly one of two writers through, and the
 * drain records an integrity failure in the ledger it now owns.
 */

const ACTOR = { kind: "user" as const, id: null };
const INSTALLATION = "00000000-0000-4000-8000-000000000001";

const tempCleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of tempCleanups) cleanup();
});

function migratedDb() {
  const temp = makeTempDatabase();
  tempCleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS);
  return temp;
}

type Db = ReturnType<typeof makeTempDatabase>["db"];

function nestedDirectory(temp: ReturnType<typeof migratedDb>): string {
  const nested = join(temp.home.home, "bindings", "second");
  mkdirSync(nested, { recursive: true });
  return nested;
}

function eventTypes(db: Db): string[] {
  const rows = db.prepare("SELECT event_type FROM events ORDER BY created_at, rowid").all() as Array<{
    event_type: string;
  }>;
  return rows.map((row) => row.event_type);
}

function insertHandoff(db: Db, id: string, overrides: Record<string, unknown> = {}): void {
  const artifactId = `artifact-${id}`;
  db.exec("BEGIN");
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES ('p-1', 'p-1', 'p-1', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, 'doc.md', 'doc.md', 'text/markdown', 1, ?, NULL, 1, '2026-01-01T00:00:00.000Z')",
  ).run(artifactId, id, `artifacts/${id}/${artifactId}/doc.md`, `sha-${id}`);
  db.prepare(
    "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES (?, NULL, NULL, ?, 'user', NULL, NULL, NULL, 'p-1', ?, 1, 1, 'awaiting_recipient', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(id, `Handoff ${id}`, artifactId);
  db.exec("COMMIT");
  for (const [column, value] of Object.entries(overrides)) {
    db.prepare(`UPDATE handoffs SET ${column} = ? WHERE id = ?`).run(value as never, id);
  }
}

describe("the Project event ledger", () => {
  it("appends every mutation's lifecycle event and nothing for a read", () => {
    const temp = migratedDb();
    const ledger = createSqliteEventLedger(temp.db);
    const repository = createSqliteProjectRepository(temp.db, { installationId: INSTALLATION, events: ledger });

    const registered = repository.createProjectWithBinding(
      { id: "p-1", slug: "web-app", displayName: "Web App", description: null, createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "b-1",
        projectId: "p-1",
        directory: temp.home.home,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      ACTOR,
    );
    expect(registered.ok).toBe(true);
    expect(eventTypes(temp.db)).toEqual(["PROJECT_REGISTERED", "PROJECT_BINDING_ADDED"]);

    // Reads append nothing.
    expect(repository.findProjectBySlug("web-app").ok).toBe(true);
    expect(repository.listProjects().ok).toBe(true);
    expect(repository.listBindings().ok).toBe(true);
    expect(eventTypes(temp.db)).toEqual(["PROJECT_REGISTERED", "PROJECT_BINDING_ADDED"]);

    const renamed = repository.updateProjectDisplayName("p-1", "Web App 2", "2026-01-02T00:00:00.000Z", ACTOR);
    expect(renamed.ok).toBe(true);
    const archived = repository.updateProjectStatus("p-1", "archived", "2026-01-03T00:00:00.000Z", ACTOR);
    expect(archived.ok).toBe(true);
    const reactivated = repository.updateProjectStatus("p-1", "active", "2026-01-04T00:00:00.000Z", ACTOR);
    expect(reactivated.ok).toBe(true);
    const added = repository.addBinding(
      {
        id: "b-2",
        projectId: "p-1",
        directory: nestedDirectory(temp),
        bindingKind: "directory",
        createdAt: "2026-01-05T00:00:00.000Z",
      },
      ACTOR,
    );
    expect(added.ok).toBe(true);
    temp.db.prepare("UPDATE project_bindings SET updated_at = '2026-01-06T00:00:00.000Z' WHERE id = 'b-2'").run();
    const removed = repository.removeBinding("b-2", ACTOR);
    expect(removed.ok).toBe(true);
    expect(eventTypes(temp.db)).toEqual([
      "PROJECT_REGISTERED",
      "PROJECT_BINDING_ADDED",
      "PROJECT_RENAMED",
      "PROJECT_STATUS_ARCHIVED",
      "PROJECT_STATUS_ACTIVE",
      "PROJECT_BINDING_ADDED",
      "PROJECT_BINDING_REMOVED",
    ]);

    // A duplicate registration leaves no partial event pair behind: the transaction
    // aborts the Project row together with its events.
    const duplicate = repository.createProjectWithBinding(
      { id: "p-2", slug: "web-app", displayName: "Again", description: null, createdAt: "2026-01-06T00:00:00.000Z" },
      {
        id: "b-3",
        projectId: "p-2",
        directory: temp.home.home,
        bindingKind: "directory",
        createdAt: "2026-01-06T00:00:00.000Z",
      },
      ACTOR,
    );
    expect(duplicate.ok).toBe(false);
    expect(eventTypes(temp.db)).toHaveLength(7);
  });

  it("records the actor provenance on each event", () => {
    const temp = migratedDb();
    const ledger = createSqliteEventLedger(temp.db);
    const repository = createSqliteProjectRepository(temp.db, { installationId: INSTALLATION, events: ledger });
    expect(
      repository.createProject(
        {
          id: "p-9",
          slug: "actor-probe",
          displayName: "Actor Probe",
          description: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        { kind: "registered_project", id: "p-1" },
      ).ok,
    ).toBe(true);
    const rows = ledger.list();
    expect(rows.ok && rows.value).toHaveLength(1);
    const event = rows.ok ? rows.value[0] : undefined;
    expect(event?.eventType).toBe("PROJECT_REGISTERED");
    expect(event?.actorKind).toBe("registered_project");
    expect(event?.actorId).toBe("p-1");
    expect(event?.metadata).toEqual({ projectId: "p-9", slug: "actor-probe" });
  });
});

describe("the Row Version compare-and-set", () => {
  it("fails a stale expectation with ROW_VERSION_CONFLICT at exit 75", () => {
    const temp = migratedDb();
    const store = createSqliteHandoffRowStore(temp.db);
    insertHandoff(temp.db, "h-cas", { row_version: 4 });
    const stale = store.compareAndSet("h-cas", 3, { pinned: 1, updated_at: "2026-01-02T00:00:00.000Z" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("ROW_VERSION_CONFLICT");
      expect(errorSpec(stale.error.code).exitCode).toBe(75);
    }
    const row = temp.db.prepare("SELECT row_version, pinned FROM handoffs WHERE id = 'h-cas'").get() as {
      row_version: number;
      pinned: number;
    };
    expect(row).toEqual({ row_version: 4, pinned: 0 });
  });

  it("lets exactly one of two concurrent writers through", () => {
    const temp = migratedDb();
    insertHandoff(temp.db, "h-race");
    // Two processes each hold the row at Row Version 1.
    const first = openSorageDatabase(temp.databasePath);
    const second = openSorageDatabase(temp.databasePath);
    try {
      const writerA = createSqliteHandoffRowStore(first);
      const writerB = createSqliteHandoffRowStore(second);
      const a = writerA.compareAndSet("h-race", 1, { pinned: 1, updated_at: "2026-01-02T00:00:00.000Z" });
      const b = writerB.compareAndSet("h-race", 1, { pinned: 0, updated_at: "2026-01-02T00:00:00.000Z" });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.error.code).toBe("ROW_VERSION_CONFLICT");
      const row = second.prepare("SELECT row_version, pinned FROM handoffs WHERE id = 'h-race'").get() as {
        row_version: number;
        pinned: number;
      };
      expect(row).toEqual({ row_version: 2, pinned: 1 });
    } finally {
      first.close();
      second.close();
    }
  });

  it("answers HANDOFF_NOT_FOUND for an unknown row", () => {
    const temp = migratedDb();
    const store = createSqliteHandoffRowStore(temp.db);
    const outcome = store.compareAndSet("h-ghost", 1, { pinned: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("HANDOFF_NOT_FOUND");
  });
});

describe("the drain's integrity ledger", () => {
  it("appends ARTIFACT_INTEGRITY_FAILED in the completion transaction of a failed intent", () => {
    const temp = migratedDb();
    const vault = makeTempVault("sorage-drain-ledger-");
    tempCleanups.push(vault.cleanup);
    const marker = createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION);
    if (!marker.ok) throw new Error("fixture vault marker must initialize");
    insertHandoff(temp.db, "h-drain");
    // An activate intent whose staged source and destination are both gone is the
    // both-gone integrity failure of CP-2 recovery.
    temp.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('i-1', 'activate', 'staging/vanished.bin', 'artifacts/h-drain/a/missing.bin', 'artifact-h-drain', '2026-01-01T00:00:00.000Z', 0)",
      )
      .run();
    const log = createSqliteIntentLog({
      db: temp.db,
      installationId: INSTALLATION,
      events: createSqliteEventLedger(temp.db),
      now: () => "2026-01-02T00:00:00.000Z",
      eventIds: () => "e-1",
    });
    const drained = log.drain(vault.vaultPath);
    expect(drained.ok).toBe(true);
    if (drained.ok) {
      expect(drained.value.integrityFailed).toHaveLength(1);
      expect(drained.value.integrityFailed[0]?.event).toBe("ARTIFACT_INTEGRITY_FAILED");
    }
    const events = temp.db
      .prepare("SELECT event_type, actor_kind, handoff_id, metadata_json FROM events")
      .all() as Array<{ event_type: string; actor_kind: string; handoff_id: string; metadata_json: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("ARTIFACT_INTEGRITY_FAILED");
    expect(events[0]?.actor_kind).toBe("system");
    expect(events[0]?.handoff_id).toBe("h-drain");
    expect(JSON.parse(events[0]?.metadata_json ?? "{}")).toMatchObject({
      intentId: "i-1",
      reason: "both-gone",
    });
  });
});
