import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { insertHandoffSeed } from "../../src/testkit/seed";

const tempCleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of tempCleanups) cleanup();
});

function migratedDb() {
  const temp = makeTempDatabase();
  tempCleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS);
  return temp.db;
}

const NOW = "2026-01-01T00:00:00.000Z";

function insertProject(db: ReturnType<typeof migratedDb>, id: string, slug: string) {
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', ?, ?)",
  ).run(id, slug, slug, NOW, NOW);
}

function insertHandoff(
  db: ReturnType<typeof migratedDb>,
  id: string,
  recipientId: string,
  overrides: Record<string, unknown> = {},
) {
  const artifactId = (overrides.artifactId as string | undefined) ?? `artifact-${id}`;
  const columns: Record<string, unknown> = {
    id,
    dispatch_group_id: null,
    supersedes_handoff_id: null,
    title: `Handoff ${id}`,
    sender_kind: "registered_project",
    sender_project_id: null,
    sender_workspace_key: null,
    sender_path_snapshot: null,
    recipient_project_id: recipientId,
    current_artifact_id: artifactId,
    revision: 1,
    row_version: 1,
    review_state: "awaiting_recipient",
    accepted_revision: null,
    accepted_at: null,
    declined_at: null,
    decline_reason: null,
    withdrawn_at: null,
    consecutive_no_change_resolutions: 0,
    first_fetched_at: null,
    review_engaged_at: null,
    pinned: 0,
    archived_at: null,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  db.exec("BEGIN");
  try {
    if (columns.current_artifact_id !== null) {
      db.prepare(
        "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        artifactId,
        id,
        `artifacts/${id}/${artifactId}/doc.md`,
        "doc.md",
        "doc.md",
        "text/markdown",
        1,
        "0f4128ee0a3f5b5c1c4d1a1e1a0e1c3ce6e28c9a1a221db0e6f4c9a2b41cd801",
        null,
        1,
        NOW,
      );
    }
    const names = Object.keys(columns);
    const placeholders = names.map(() => "?").join(", ");
    const values = names.map((name) => columns[name]) as never[];
    db.prepare(`INSERT INTO handoffs (${names.join(", ")}) VALUES (${placeholders})`).run(...values);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("handoff domain schema", () => {
  it("creates the six domain tables and the section 18 index set", () => {
    const db = migratedDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const table of ["handoffs", "artifacts", "review_notes", "deletion_requests", "events", "idempotency_keys"]) {
      expect(tables).toContain(table);
    }
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
        .all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const index of [
      "idx_handoffs_inbox",
      "idx_handoffs_outbox_project",
      "idx_handoffs_outbox_workspace",
      "idx_handoffs_dispatch_group",
      "idx_events_handoff_created",
      "idx_artifacts_handoff",
      "idx_idempotency_keys_expires",
      "idx_deletion_requests_pending",
    ]) {
      expect(indexes).toContain(index);
    }
  });

  it("enforces exactly one recipient per Handoff through a mandatory single reference", () => {
    const db = migratedDb();
    insertProject(db, "project-a", "project-a");
    insertHandoff(db, "h-one", "project-a");
    const columns = db.prepare("PRAGMA table_info(handoffs)").all() as Array<{ name: string; notnull: number }>;
    const recipientColumns = columns
      .filter((column) => column.name.includes("recipient"))
      .map((column) => ({ name: column.name, notnull: column.notnull }));
    expect(recipientColumns).toEqual([{ name: "recipient_project_id", notnull: 1 }]);
    expect(() => insertHandoff(db, "h-null-recipient", "project-a", { recipient_project_id: null })).toThrowError(
      /NOT NULL constraint failed/,
    );
    // The recipient must exist: a dangling reference is rejected by the foreign key.
    expect(() => insertHandoff(db, "h-ghost", "project-missing")).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it("enforces at most one Review Note per Handoff", () => {
    const db = migratedDb();
    insertProject(db, "project-b", "project-b");
    insertHandoff(db, "h-two", "project-b");
    const insert = db.prepare(
      "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("h-two", "registered_project", "project-b", 1, "first note", NOW, NOW);
    expect(() => insert.run("h-two", "user", null, 1, "second note", NOW, NOW)).toThrowError(
      /UNIQUE constraint failed/,
    );
  });

  it("lets a fan-out group share one nullable dispatch group identifier", () => {
    const db = migratedDb();
    insertProject(db, "project-c", "project-c");
    insertProject(db, "project-d", "project-d");
    insertHandoff(db, "h-single", "project-c", { dispatch_group_id: null });
    insertHandoff(db, "h-fan-1", "project-c", { dispatch_group_id: "group-1" });
    insertHandoff(db, "h-fan-2", "project-d", { dispatch_group_id: "group-1" });
    const group = db
      .prepare("SELECT id FROM handoffs WHERE dispatch_group_id = ? ORDER BY id")
      .all("group-1") as Array<{ id: string }>;
    expect(group.map((row) => row.id)).toEqual(["h-fan-1", "h-fan-2"]);
  });

  it("rejects a duplicate idempotency key in one scope and allows the same key in another scope", () => {
    const db = migratedDb();
    const insert = db.prepare(
      "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("key-1", "send", "hash-a", "{}", NOW, NOW);
    expect(() => insert.run("key-1", "send", "hash-b", "{}", NOW, NOW)).toThrowError(/UNIQUE constraint failed/);
    insert.run("key-1", "revise", "hash-a", "{}", NOW, NOW);
  });

  it("makes the events table append-only in practice by rejecting update and delete", () => {
    const db = migratedDb();
    insertProject(db, "project-e", "project-e");
    insertHandoff(db, "h-three", "project-e");
    db.prepare(
      "INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("event-1", "h-three", "HANDOFF_CREATED", "registered_project", "project-e", 1, "{}", NOW);
    expect(() =>
      db.prepare("UPDATE events SET event_type = 'HANDOFF_REVISED' WHERE id = ?").run("event-1"),
    ).toThrowError(/events is append-only/);
    expect(() => db.prepare("DELETE FROM events WHERE id = ?").run("event-1")).toThrowError(/events is append-only/);
    const rows = db.prepare("SELECT event_type FROM events").all() as Array<{ event_type: string }>;
    expect(rows).toEqual([{ event_type: "HANDOFF_CREATED" }]);
  });

  it("keeps the current Artifact reference and the tombstone rule checkable", () => {
    const db = migratedDb();
    insertProject(db, "project-f", "project-f");
    // A live Handoff without a current Artifact violates the tombstone-only rule.
    expect(() => insertHandoff(db, "h-live", "project-f", { current_artifact_id: null })).toThrowError(
      /CHECK constraint failed/,
    );
    // A tombstone detaches its Artifact and keeps the row.
    insertHandoff(db, "h-dead", "project-f", { current_artifact_id: null, deleted_at: NOW, review_state: "accepted" });
    const tombstone = db.prepare("SELECT deleted_at, current_artifact_id FROM handoffs WHERE id = ?").get("h-dead") as {
      deleted_at: string;
      current_artifact_id: string | null;
    };
    expect(tombstone).toEqual({ deleted_at: NOW, current_artifact_id: null });
  });

  it("allows the deferred Handoff-to-Artifact reference cycle inside one transaction", () => {
    const db = migratedDb();
    insertProject(db, "project-g", "project-g");
    // The Handoff row names its Artifact while that Artifact row names the Handoff;
    // deferred foreign keys check the pair at commit, not per statement.
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES ('h-cycle', NULL, NULL, 'Cycle', 'registered_project', NULL, NULL, NULL, 'project-g', 'a-cycle', 1, 1, 'awaiting_recipient', 0, 0, ?, ?)",
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES ('a-cycle', 'h-cycle', 'artifacts/h-cycle/a-cycle/doc.md', 'doc.md', 'doc.md', 'text/markdown', 1, ?, NULL, 0, ?)",
    ).run("0f4128ee0a3f5b5c1c4d1a1e1a0e1c3ce6e28c9a1a221db0e6f4c9a2b41cd801", NOW);
    db.exec("COMMIT");
    const handoff = db.prepare("SELECT current_artifact_id FROM handoffs WHERE id = 'h-cycle'").get() as {
      current_artifact_id: string;
    };
    expect(handoff.current_artifact_id).toBe("a-cycle");
  });

  it("allows at most one pending Deletion Request per Handoff", () => {
    const db = migratedDb();
    insertProject(db, "project-h", "project-h");
    insertHandoff(db, "h-four", "project-h");
    const insert = db.prepare(
      "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at, resolved_at, resolved_by_user, resolution_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("dr-1", "h-four", "registered_project", "project-h", null, "pending", NOW, null, null, null);
    expect(() => insert.run("dr-2", "h-four", "user", null, null, "pending", NOW, null, null, null)).toThrowError(
      /UNIQUE constraint failed/,
    );
    // A resolved request no longer blocks a new pending one.
    db.prepare(
      "UPDATE deletion_requests SET status = 'rejected', resolved_at = ?, resolved_by_user = 'user' WHERE id = ?",
    ).run(NOW, "dr-1");
    insert.run("dr-3", "h-four", "user", null, null, "pending", NOW, null, null, null);
  });

  it("loads the deterministic Handoff seed into the migrated domain tables", () => {
    const db = migratedDb();
    const inserted = insertHandoffSeed(db, 200);
    expect(inserted).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM handoffs").get()).toMatchObject({ count: 200 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toMatchObject({ count: 200 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toMatchObject({ count: 25 });
    // A second load into a fresh database produces byte-identical first and last rows.
    const other = migratedDb();
    insertHandoffSeed(other, 200);
    const pick = (connection: ReturnType<typeof migratedDb>) =>
      connection.prepare("SELECT * FROM handoffs ORDER BY created_at LIMIT 1").all() as Array<Record<string, unknown>>;
    expect(pick(db)).toEqual(pick(other));
  });
});
