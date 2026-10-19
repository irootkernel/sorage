import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeInstallation, sendRequestHash, type SendOutcome } from "@sorage/core";
import { createNodeInitPorts } from "../../src/init-ports";
import { MIGRATIONS, productionMigrationPlan } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The frozen legacy-revise installation of ADR-0031's qualification (TASK-106,
 * R2.4.3): a real temporary installation whose database is deliberately built
 * at schema 7 through the genuine migration prefix, populated with the exact
 * post-revise production shape — a legacy short Artifact identifier generated
 * by the retired `a`-plus-eight-hex producer algorithm, the current Artifact
 * row and its file bytes fully materialized, the superseded Artifact row
 * already deleted, review and deletion associations, the retained original
 * send receipt, and the single SHA-1-named legacy pending intent a genuine
 * crash leaves behind: the superseded revision's unlink executed on disk (its
 * target already absent) whose completion transaction never landed. The state
 * is internally consistent, so the exported current Artifact is readable like
 * any native backup's; the recovery suites separately cover an activation
 * whose row is still materialized = 0 and source-gone/destination-present
 * retries. Nothing here depends on a temporary executable; the seeding is SQL
 * and files under an isolated SORAGE_HOME the caller cleans up.
 */

export const LEGACY_PROJECT = "99999999-2222-4999-8999-999999999992";
export const LEGACY_HANDOFF = "99999999-3333-4999-8999-999999999993";
/** The ten-character tail every derived event id completes with its two-character suffix. */
export const LEGACY_EVENT_BASE = "99999999-4444-4999-8999-9999999999";
export const LEGACY_RECEIPT_KEY = "99999999-5555-4999-8999-999999999995";
export const LEGACY_SEND_ARTIFACT = "99999999-6666-4999-8999-999999999996";
export const LEGACY_SEND_TIME = "2026-10-01T00:00:00.000Z";
export const LEGACY_REVISE_TIME = "2026-10-01T02:00:00.000Z";

export const LEGACY_BODY_V1 = "# The frozen legacy brief\nfirst revision bytes\r\n";
export const LEGACY_BODY_V2 = "# The frozen legacy brief, revised\nexact bytes no final newline";

/** The retired producer algorithm, reproduced verbatim for the frozen fixture. */
export function legacyReviseArtifactId(handoffId: string, nextRevision: number, now: string): string {
  return `a${createHash("sha1").update(`${handoffId}:${nextRevision}:${now}`).digest("hex").slice(0, 8)}`;
}

/** The legacy SHA-1 intent id derivation, reproduced verbatim. */
export function legacyIntentId(kind: "activate" | "unlink", storageKey: string): string {
  return createHash("sha1").update(`${kind}:${storageKey}`).digest("hex");
}

export interface LegacyReviseInstallation {
  home: string;
  vault: string;
  database: string;
  /** The installation identity the real configuration and Vault marker carry. */
  installationId: string;
  handoffId: string;
  /** The legacy short identifier of the current Artifact, `a` + eight hex. */
  currentArtifactId: string;
  currentStorageKey: string;
  /** The superseded key the pending legacy unlink names; its file is absent. */
  oldStorageKey: string;
  /** The exact retained receipt response string planted in `idempotency_keys`. */
  receiptResponseJson: string;
  /** Re-migrates the schema-7 database to the current build's full catalog. */
  upgradeToCurrent: () => void;
  /** The schema-7 rows of the operational tables, for before/after comparison. */
  operationalSnapshot: () => string;
  /** The schema-7 rows of the exported domain tables, for before/after comparison. */
  domainSnapshot: () => string;
  /** The physical Artifact projection as the frozen schema-7 rows carry it. */
  legacyArtifactSnapshot: () => string;
  /** The same physical Artifact projection through the normalized schema-9 join. */
  normalizedArtifactProjection: () => string;
  cleanup: () => void;
}

export function legacyReviseInstallation(): LegacyReviseInstallation {
  const home = mkdtempSync(join(tmpdir(), "sorage-legacy-revise-"));
  const vault = join(home, "vault");
  const seeded = initializeInstallation(
    createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
    { vaultPath: vault },
  );
  if (!seeded.ok) throw new Error(seeded.error.message);
  const database = join(home, "state", "sorage.sqlite3");
  // The current initializer migrates to the build's maximum; the frozen legacy
  // state needs schema 7, so the database files are rebuilt through the genuine
  // migration prefix while the real configuration, marker, and Vault layout stay.
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${database}${suffix}`, { force: true });
  }
  const db = openSorageDatabase(database);
  const installationId = (
    JSON.parse(readFileSync(join(vault, ".sorage-vault.json"), "utf8")) as { installationId: string }
  ).installationId;
  try {
    migrate(db, MIGRATIONS.slice(0, 7), () => LEGACY_SEND_TIME);
    // A genuine initialized database carries the installation singleton the
    // initializer wrote, with the exact identity the configuration and marker
    // retained across the rebuild.
    db.prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 1, ?)").run(
      installationId,
      LEGACY_SEND_TIME,
    );
    seedLegacyRevise(db, vault);
  } finally {
    db.close();
  }
  const currentArtifactId = legacyReviseArtifactId(LEGACY_HANDOFF, 2, LEGACY_REVISE_TIME);
  const currentStorageKey = `artifacts/${LEGACY_HANDOFF}/${currentArtifactId}/brief.md`;
  const oldStorageKey = `artifacts/${LEGACY_HANDOFF}/${LEGACY_SEND_ARTIFACT}/brief.md`;
  return {
    home,
    vault,
    database,
    installationId,
    handoffId: LEGACY_HANDOFF,
    currentArtifactId,
    currentStorageKey,
    oldStorageKey,
    receiptResponseJson: LEGACY_RECEIPT_JSON,
    upgradeToCurrent() {
      const upgraded = openSorageDatabase(database);
      try {
        // The current build's full catalog is the real production plan: the
        // ordinary 1..8 prefix plus the guarded schema-9 Handoff rebuild on its
        // dedicated file-backed connection, exactly as a current opener
        // upgrades this installation.
        const plan = productionMigrationPlan();
        migrate(upgraded, plan.migrations, () => "2026-10-18T00:00:00.000Z", {
          databasePath: database,
          rebuilds: plan.rebuilds,
        });
      } finally {
        upgraded.close();
      }
    },
    operationalSnapshot() {
      return (
        rowsOf(
          database,
          "SELECT id, op, from_path, to_path, artifact_id, created_at, attempts FROM pending_fs_ops ORDER BY id",
        ) +
        rowsOf(
          database,
          "SELECT key, scope, request_hash, response_json, created_at, expires_at FROM idempotency_keys ORDER BY key",
        )
      );
    },
    domainSnapshot() {
      // The non-Artifact domain tables compare verbatim across the upgrade;
      // the Artifacts compare through their physical projection separately,
      // because the normalization moves the physical columns onto the
      // immutable content records. The events projection names all nine
      // columns explicitly so the rebuilt table's different physical column
      // order (memo_id moved from ALTER-appended last to DDL-declared third)
      // cannot masquerade as a data change; every metadata_json value stays
      // the exact stored string.
      return (
        rowsOf(database, "SELECT * FROM installation") +
        rowsOf(database, "SELECT * FROM handoffs ORDER BY id") +
        rowsOf(
          database,
          "SELECT id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at FROM events ORDER BY id",
        ) +
        rowsOf(database, "SELECT * FROM deletion_requests ORDER BY id")
      );
    },
    /** The physical Artifact projection as the frozen schema-7 rows carry it. */
    legacyArtifactSnapshot() {
      return rowsOf(
        database,
        "SELECT id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at FROM artifacts ORDER BY id",
      );
    },
    /** The same physical Artifact projection through the normalized schema-9 join. */
    normalizedArtifactProjection() {
      return rowsOf(
        database,
        "SELECT a.id, a.handoff_id, c.storage_key, a.original_name, a.stored_name, a.mime_type, c.size_bytes, c.sha256, a.imported_from_path, c.materialized, a.created_at FROM artifacts a JOIN content_records c ON c.id = a.content_record_id ORDER BY a.id",
      );
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** The retained original send outcome, exactly the shape the send completion stored. */
export const LEGACY_RECEIPT_JSON = JSON.stringify({
  handoffs: [
    {
      handoffId: LEGACY_HANDOFF,
      recipientSlug: "legacy-recipient",
      artifactId: LEGACY_SEND_ARTIFACT,
      storageKey: `artifacts/${LEGACY_HANDOFF}/${LEGACY_SEND_ARTIFACT}/brief.md`,
      revision: 1,
      rowVersion: 1,
      reviewState: "awaiting_recipient",
    },
  ],
  dispatchGroupId: null,
  replayed: false,
} satisfies SendOutcome);

/** The actual request identity of the original send, derived by the real rule. */
export function legacyRequestHash(): string {
  return sendRequestHash({
    to: ["legacy-recipient"],
    title: "Frozen legacy brief",
    contentSha256: createHash("sha256").update(Buffer.from(LEGACY_BODY_V1, "utf8")).digest("hex"),
    kind: "file",
  });
}

function rowsOf(database: string, sql: string): string {
  const db = openSorageDatabase(database);
  try {
    return JSON.stringify(db.prepare(sql).all());
  } finally {
    db.close();
  }
}

function seedLegacyRevise(db: ReturnType<typeof openSorageDatabase>, vault: string): void {
  const currentArtifactId = legacyReviseArtifactId(LEGACY_HANDOFF, 2, LEGACY_REVISE_TIME);
  const currentKey = `artifacts/${LEGACY_HANDOFF}/${currentArtifactId}/brief.md`;
  const oldKey = `artifacts/${LEGACY_HANDOFF}/${LEGACY_SEND_ARTIFACT}/brief.md`;
  const v2 = Buffer.from(LEGACY_BODY_V2, "utf8");
  const v2Sha = createHash("sha256").update(v2).digest("hex");
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'legacy-recipient', 'Legacy Recipient', NULL, 'active', ?, ?)",
    ).run(LEGACY_PROJECT, LEGACY_SEND_TIME, LEGACY_SEND_TIME);
    db.prepare(
      `INSERT INTO handoffs (id, title, sender_kind, sender_workspace_key, sender_path_snapshot, recipient_project_id,
        current_artifact_id, revision, row_version, review_state, first_fetched_at, review_engaged_at,
        consecutive_no_change_resolutions, pinned, created_at, updated_at)
      VALUES (?, 'Frozen legacy brief', 'unregistered_workspace', 'legacy-workspace-key', '/legacy/work', ?,
        ?, 2, 5, 'awaiting_recipient', ?, ?, 0, 0, ?, ?)`,
    ).run(
      LEGACY_HANDOFF,
      LEGACY_PROJECT,
      currentArtifactId,
      "2026-10-01T00:30:00.000Z",
      "2026-10-01T01:00:00.000Z",
      LEGACY_SEND_TIME,
      LEGACY_REVISE_TIME,
    );
    // The current Artifact row, fully materialized: the revise's activation
    // completed, exactly as a healthy post-revise database carries it. The
    // superseded Artifact row is already deleted, as the production revise
    // transaction deletes it; only its bytes' unlink promise remains open.
    db.prepare(
      `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256,
        imported_from_path, materialized, created_at) VALUES (?, ?, ?, 'brief.md', 'brief.md', 'text/markdown', ?, ?, NULL, 1, ?)`,
    ).run(currentArtifactId, LEGACY_HANDOFF, currentKey, v2.byteLength, v2Sha, LEGACY_REVISE_TIME);
    db.prepare(
      `INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status,
        requested_at, resolved_at, resolved_by_user, resolution_note)
      VALUES (?, ?, 'user', NULL, 'Frozen legacy request', 'rejected', ?, ?, 'root', 'kept for the audit')`,
    ).run(`${LEGACY_EVENT_BASE}d1`, LEGACY_HANDOFF, "2026-10-01T00:10:00.000Z", "2026-10-01T00:20:00.000Z");
    const event = (
      suffix: string,
      type: string,
      rowVersion: number,
      metadata: Record<string, unknown>,
      at: string,
      actorKind: "unregistered_workspace" | "registered_project" | "user",
      actorId: string | null,
    ) =>
      db
        .prepare(
          "INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `${LEGACY_EVENT_BASE}${suffix}`,
          LEGACY_HANDOFF,
          type,
          actorKind,
          actorId,
          rowVersion,
          JSON.stringify(metadata),
          at,
        );
    // The request and rejection precede the Note and revision, so each mutation
    // increments Row Version and the final unlink is the only unfinished work.
    event(
      "e1",
      "HANDOFF_CREATED",
      1,
      { title: "Frozen legacy brief" },
      "2026-10-01T00:00:01.000Z",
      "unregistered_workspace",
      "legacy-workspace-key",
    );
    event(
      "e2",
      "DELETION_REQUESTED",
      2,
      { requestId: `${LEGACY_EVENT_BASE}d1` },
      "2026-10-01T00:10:00.000Z",
      "user",
      null,
    );
    event(
      "e3",
      "DELETION_REJECTED",
      3,
      { requestId: `${LEGACY_EVENT_BASE}d1` },
      "2026-10-01T00:20:00.000Z",
      "user",
      null,
    );
    event(
      "e4",
      "REVIEW_NOTE_CREATED",
      4,
      { targetRevision: 1 },
      "2026-10-01T01:00:00.000Z",
      "registered_project",
      LEGACY_PROJECT,
    );
    event(
      "e5",
      "HANDOFF_REVISED",
      5,
      { revision: 2, storageKey: currentKey, resolvedNote: true },
      LEGACY_REVISE_TIME,
      "unregistered_workspace",
      "legacy-workspace-key",
    );
    event(
      "e6",
      "REVIEW_NOTE_RESOLVED",
      5,
      { revision: 2 },
      LEGACY_REVISE_TIME,
      "unregistered_workspace",
      "legacy-workspace-key",
    );
    // The retained original send outcome, verbatim.
    db.prepare(
      "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, 'send', ?, ?, ?, '2099-01-01T00:00:00.000Z')",
    ).run(LEGACY_RECEIPT_KEY, legacyRequestHash(), LEGACY_RECEIPT_JSON, LEGACY_SEND_TIME);
    // The one genuine leftover: the superseded revision's unlink executed on
    // disk — its target is already absent — before its completion transaction
    // landed, so the drain must clear it and append its success event without
    // an authoritative Artifact row to associate.
    db.prepare(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'unlink', NULL, ?, ?, ?, 0)",
    ).run(legacyIntentId("unlink", oldKey), oldKey, LEGACY_SEND_ARTIFACT, LEGACY_REVISE_TIME);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // The Vault bytes: the current key present and read-only, staging empty, and
  // the superseded file gone — the crash-after-unlink state the intent records.
  mkdirSync(join(vault, "artifacts", LEGACY_HANDOFF, currentArtifactId), { recursive: true });
  writeFileSync(join(vault, currentKey), v2);
  chmodSync(join(vault, currentKey), 0o444);
}
