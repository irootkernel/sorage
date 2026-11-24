import { createHash, randomUUID } from "node:crypto";
import { SystemClock } from "@sorage/core";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteRetentionStore } from "../../src/handoffs";
import { clearMoveFence, setMoveFenceAndCountPending } from "../../src/sqlite/move-fence";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeArtifactContentBindings, makeTempDatabase } from "../../src/testkit";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { createVaultInitializer } from "../../src/vault";

const INSTALLATION = "11111111-4444-4444-8444-444444444441";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function setupFixture() {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  const plan = productionMigrationPlan();
  migrate(temp.db, plan.migrations, () => "2026-01-01T00:00:00.000Z", {
    databasePath: temp.databasePath,
    rebuilds: plan.rebuilds,
  });
  const vault = makeTempVault("sorage-retention-fence-vault-");
  cleanups.push(vault.cleanup);
  const init = createVaultInitializer(new SystemClock()).initialize(vault.vaultPath, INSTALLATION);
  if (!init.ok) throw new Error(`fixture vault init failed: ${init.error.message}`);

  temp.db
    .prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES ('p-1', 'p-1', 'p-1', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .run();

  const ledger = createSqliteEventLedger(temp.db);
  const content = makeArtifactContentBindings({
    db: temp.db,
    ledger,
    vaultPath: vault.vaultPath,
    installationId: INSTALLATION,
  });
  const retention = createSqliteRetentionStore(temp.db, ledger, {}, content);
  return { db: temp.db, retention };
}

function seedHandoff(
  db: ReturnType<typeof setupFixture>["db"],
  handoffId: string,
  options: { inline: boolean },
): { artifactId: string; contentRecordId: string; storageKey: string | null } {
  const artifactId = `a-${handoffId}`;
  const contentRecordId = randomUUID();
  const storageKey = options.inline ? null : `artifacts/${handoffId}/${artifactId}/doc.md`;
  const inlineText = options.inline ? "inline body" : null;
  const body = options.inline ? "inline body" : "file body";
  const sha = createHash("sha256").update(body).digest("hex");

  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, ?, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z')",
  ).run(contentRecordId, inlineText, storageKey, Buffer.byteLength(body, "utf8"), sha);
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, '2026-01-01T00:00:00.000Z', ?)",
  ).run(artifactId, handoffId, contentRecordId);
  db.prepare(
    "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'T', 'user', 'p-1', ?, 1, 1, 'accepted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(handoffId, artifactId);
  db.exec("COMMIT");

  return { artifactId, contentRecordId, storageKey };
}

describe("applyRetentionMutation under a live vault-move fence", () => {
  it("refuses inline deletion-approve (removeContent: true, no unlinkIntent) with SERVICE_PAUSED and zero mutations", () => {
    const { db, retention } = setupFixture();
    const { contentRecordId } = seedHandoff(db, "h-inline", { inline: true });
    expect(setMoveFenceAndCountPending(db, process.pid, "2026-01-02T00:00:00.000Z").ok).toBe(true);

    const outcome = retention.applyRetentionMutation({
      handoffId: "h-inline",
      expectedRowVersion: 1,
      change: {
        kind: "deletion-approve",
        removeContent: true,
      },
      at: "2026-01-02T00:00:00.000Z",
      events: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("SERVICE_PAUSED");
    }

    const handoff = db.prepare("SELECT row_version, deleted_at FROM handoffs WHERE id = 'h-inline'").get() as {
      row_version: number;
      deleted_at: string | null;
    };
    expect(handoff).toEqual({ row_version: 1, deleted_at: null });
    expect(db.prepare("SELECT COUNT(*) AS c FROM content_records WHERE id = ?").get(contentRecordId)).toMatchObject({
      c: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
  });

  it("refuses file-backed deletion-approve (removeContent: true with unlinkIntent) with SERVICE_PAUSED and zero mutations", () => {
    const { db, retention } = setupFixture();
    const { artifactId, contentRecordId, storageKey } = seedHandoff(db, "h-file", { inline: false });
    if (storageKey === null) throw new Error("expected file-backed storageKey");
    expect(setMoveFenceAndCountPending(db, process.pid, "2026-01-02T00:00:00.000Z").ok).toBe(true);

    const outcome = retention.applyRetentionMutation({
      handoffId: "h-file",
      expectedRowVersion: 1,
      change: {
        kind: "deletion-approve",
        removeContent: true,
        unlinkIntent: {
          id: "intent-unlink-file",
          toPath: storageKey,
          artifactId,
        },
      },
      at: "2026-01-02T00:00:00.000Z",
      events: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("SERVICE_PAUSED");
    }

    const handoff = db.prepare("SELECT row_version, deleted_at FROM handoffs WHERE id = 'h-file'").get() as {
      row_version: number;
      deleted_at: string | null;
    };
    expect(handoff).toEqual({ row_version: 1, deleted_at: null });
    expect(db.prepare("SELECT COUNT(*) AS c FROM content_records WHERE id = ?").get(contentRecordId)).toMatchObject({
      c: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
  });

  it("allows all metadata-only retention mutations while a live move fence is held", () => {
    const { db, retention } = setupFixture();
    seedHandoff(db, "h-meta", { inline: true });
    expect(setMoveFenceAndCountPending(db, process.pid, "2026-01-02T00:00:00.000Z").ok).toBe(true);

    const steps = [
      { kind: "pin" as const },
      { kind: "unpin" as const },
      { kind: "archive" as const },
      { kind: "unarchive" as const },
      {
        kind: "deletion-request" as const,
        requestId: "dr-meta-1",
        requestedByKind: "registered_project",
        requestedById: "p-1",
        reason: "no longer needed",
      },
      { kind: "deletion-reject" as const, resolutionNote: null },
    ];

    let version = 1;
    for (const change of steps) {
      const outcome = retention.applyRetentionMutation({
        handoffId: "h-meta",
        expectedRowVersion: version,
        change,
        at: "2026-01-02T00:00:00.000Z",
        events: [],
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        version = outcome.value.rowVersion;
      }
    }

    expect(version).toBe(1 + steps.length);
    const req = db.prepare("SELECT status FROM deletion_requests WHERE id = 'dr-meta-1'").get() as { status: string };
    expect(req.status).toBe("rejected");
    clearMoveFence(db);
  });
});
