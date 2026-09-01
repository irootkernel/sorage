import { afterAll, describe, expect, it } from "vitest";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteHandoffReadStore } from "../../src/handoff-read-store";
import { createSqliteRetentionStore, createSqliteRevisionStore } from "../../src/handoffs";
import { clearMoveFence, setMoveFenceAndCountPending } from "../../src/intent-log";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempDatabase } from "../../src/testkit/temp-database";

/**
 * The EPIC-005 whole-epic round-1 remediation regressions: the administrative next
 * actor derives from the pending Deletion Request and integrity state (F001), the
 * vault-move fence pauses every intent-committing decision including revision and
 * retention (F002), and the review-set core contract stores the resolved note text
 * (F003, covered by the CLI suites that read the file before calling the core).
 */

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function migratedDb() {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS);
  return temp;
}

function seedHandoff(db: ReturnType<typeof migratedDb>["db"], id: string, state: string): void {
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES ('p-1', 'p-1', 'p-1', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, 'doc.md', 'doc.md', 'text/markdown', 1, 'sha', NULL, 1, '2026-01-01T00:00:00.000Z')",
  ).run(`a-${id}`, id, `artifacts/${id}/a-${id}/doc.md`);
  db.prepare(
    "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'T', 'user', 'p-1', ?, 1, 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(id, `a-${id}`, state);
  db.exec("COMMIT");
}

describe("the whole-epic round-1 remediations", () => {
  it("expires a stored retention idempotency response at the 24-hour boundary", () => {
    const temp = migratedDb();
    temp.db
      .prepare(
        "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("key-expired", "deletion-approve:h-1", "hash", "{}", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    const retention = createSqliteRetentionStore(temp.db, createSqliteEventLedger(temp.db), {
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    const expired = retention.idempotencyLookup("key-expired", "deletion-approve:h-1");

    expect(expired.ok && expired.value).toBeNull();
    expect(temp.db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get()).toMatchObject({ c: 0 });
  });

  it("F001: a pending Deletion Request or an unmaterialized Artifact makes the User the administrative next actor", () => {
    const temp = migratedDb();
    const store = createSqliteHandoffReadStore(temp.db, createSqliteEventLedger(temp.db));
    seedHandoff(temp.db, "h-f001", "awaiting_recipient");

    const plain = store.findHandoffView("h-f001");
    expect(plain.ok && plain.value?.nextActors.administrativeNextActor).toBeNull();

    temp.db
      .prepare(
        "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at) VALUES ('dr-1', 'h-f001', 'user', NULL, NULL, 'pending', '2026-01-02T00:00:00.000Z')",
      )
      .run();
    const pending = store.findHandoffView("h-f001");
    expect(pending.ok && pending.value?.nextActors.administrativeNextActor).toBe("user");

    temp.db.prepare("UPDATE deletion_requests SET status = 'rejected' WHERE id = 'dr-1'").run();
    temp.db.prepare("UPDATE artifacts SET materialized = 0 WHERE id = 'a-h-f001'").run();
    const unmaterialized = store.findHandoffView("h-f001");
    expect(unmaterialized.ok && unmaterialized.value?.nextActors.administrativeNextActor).toBe("user");
  });

  it("F002: a live vault-move fence pauses revision and retention intent commits with SERVICE_PAUSED", () => {
    const temp = migratedDb();
    const ledger = createSqliteEventLedger(temp.db);
    seedHandoff(temp.db, "h-f002", "changes_requested");
    const revisions = createSqliteRevisionStore(temp.db, ledger);
    const retention = createSqliteRetentionStore(temp.db, ledger);

    expect(setMoveFenceAndCountPending(temp.db, process.pid, "2026-01-02T00:00:00.000Z").ok).toBe(true);

    const revised = revisions.applyContentRevision({
      handoffId: "h-f002",
      expectedRowVersion: 1,
      newArtifact: {
        id: "a-new",
        handoffId: "h-f002",
        storageKey: "artifacts/h-f002/a-new/doc.md",
        originalName: "doc.md",
        storedName: "doc.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        sha256: "sha2",
        importedFromPath: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      activateIntent: {
        id: "i-a",
        op: "activate",
        fromPath: "staging/s",
        toPath: "artifacts/h-f002/a-new/doc.md",
        artifactId: "a-new",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      unlinkIntent: null,
      events: [],
    });
    expect(!revised.ok && revised.error.code).toBe("SERVICE_PAUSED");

    const pinned = retention.applyRetentionMutation({
      handoffId: "h-f002",
      expectedRowVersion: 1,
      assignments: { pinned: 1, updated_at: "2026-01-02T00:00:00.000Z" },
      events: [],
    });
    expect(pinned.ok && pinned.value.rowVersion).toBe(2);

    const resolved = retention.applyRetentionMutation({
      handoffId: "h-f002",
      expectedRowVersion: 2,
      assignments: {
        deleted_at: "2026-01-02T00:00:00.000Z",
        current_artifact_id: null,
        updated_at: "2026-01-02T00:00:00.000Z",
      },
      events: [],
      unlinkIntent: { id: "i-u", toPath: "artifacts/h-f002/a-h-f002/doc.md", artifactId: "a-h-f002" },
    });
    expect(!resolved.ok && resolved.error.code).toBe("SERVICE_PAUSED");

    // Nothing moved: the revision and the tombstone both refused before mutating.
    const row = temp.db.prepare("SELECT review_state, deleted_at FROM handoffs WHERE id = 'h-f002'").get() as {
      review_state: string;
      deleted_at: string | null;
    };
    expect(row).toEqual({ review_state: "changes_requested", deleted_at: null });
    expect(temp.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });

    // A dead mover's stale fence is ignored and the revision goes through.
    clearMoveFence(temp.db);
    setMoveFenceAndCountPending(temp.db, 999_999_999, "2026-01-02T00:00:00.000Z");
    const through = revisions.applyContentRevision({
      handoffId: "h-f002",
      expectedRowVersion: 2,
      newArtifact: {
        id: "a-new2",
        handoffId: "h-f002",
        storageKey: "artifacts/h-f002/a-new2/doc.md",
        originalName: "doc.md",
        storedName: "doc.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        sha256: "sha3",
        importedFromPath: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      activateIntent: {
        id: "i-a2",
        op: "activate",
        fromPath: "staging/s2",
        toPath: "artifacts/h-f002/a-new2/doc.md",
        artifactId: "a-new2",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      unlinkIntent: null,
      events: [],
    });
    expect(through.ok).toBe(true);
  });
});
