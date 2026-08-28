import { createHash } from "node:crypto";
import type { SorageSqlite } from "../sqlite/connection";

/**
 * Deterministic 10,000-Handoff seed for scale and pagination checks (NFR-004, HND scale).
 * Every value is derived from the row index, so two generations of the same index are
 * byte-identical, and `insertHandoffSeed` loads the same rows into the migrated domain
 * tables of TASK-027: one recipient Project per twenty-five slugs, one unregistered
 * Workspace sender per forty slugs, and one materialized Artifact per Handoff.
 */
export interface SeedHandoffRow {
  handoffId: string;
  senderSlug: string;
  recipientSlug: string;
  title: string;
  createdAt: string;
  contentSha256: string;
}

function stableUuid(index: number): string {
  const digest = createHash("sha256").update(`sorage-seed-handoff-${index}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function stableUuidFrom(label: string): string {
  const digest = createHash("sha256").update(`sorage-seed-${label}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function generateHandoffSeed(count = 10_000): SeedHandoffRow[] {
  const rows: SeedHandoffRow[] = [];
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  for (let index = 0; index < count; index++) {
    const sender = `sender-${(index % 40).toString().padStart(2, "0")}`;
    const recipient = `recipient-${(index % 25).toString().padStart(2, "0")}`;
    rows.push({
      handoffId: stableUuid(index),
      senderSlug: sender,
      recipientSlug: recipient,
      title: `Seed handoff ${index}`,
      createdAt: new Date(baseMs + index * 60_000).toISOString(),
      contentSha256: createHash("sha256").update(`seed-content-${index}`).digest("hex"),
    });
  }
  return rows;
}

const REVIEW_STATES = ["awaiting_recipient", "changes_requested", "accepted"] as const;

/**
 * Loads the deterministic seed into a database that already carries the handoff-domain
 * migration. The recipient slugs become registered Projects, the sender slugs become
 * unregistered Workspace identities with derived keys, and every Handoff owns exactly
 * one materialized Artifact, all inside one transaction so a partial load never lands.
 */
export function insertHandoffSeed(db: SorageSqlite, count = 10_000): number {
  const rows = generateHandoffSeed(count);
  db.exec("BEGIN");
  try {
    const insertProject = db.prepare(
      "INSERT OR IGNORE INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', ?, ?)",
    );
    const seenRecipients = new Set<string>();
    for (const row of rows) {
      if (seenRecipients.has(row.recipientSlug)) continue;
      seenRecipients.add(row.recipientSlug);
      insertProject.run(
        stableUuidFrom(`project-${row.recipientSlug}`),
        row.recipientSlug,
        row.recipientSlug,
        row.createdAt,
        row.createdAt,
      );
    }
    const insertHandoff = db.prepare(
      "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES (?, NULL, NULL, ?, 'unregistered_workspace', NULL, ?, ?, ?, ?, 1, 1, ?, 0, 0, ?, ?)",
    );
    const insertArtifact = db.prepare(
      "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, ?, ?, 'text/markdown', ?, ?, NULL, 1, ?)",
    );
    for (const [index, row] of rows.entries()) {
      const artifactId = stableUuidFrom(`artifact-${index}`);
      const storageKey = `artifacts/${row.handoffId}/${artifactId}/seed.md`;
      insertArtifact.run(
        artifactId,
        row.handoffId,
        storageKey,
        "seed.md",
        "seed.md",
        1,
        row.contentSha256,
        row.createdAt,
      );
      insertHandoff.run(
        row.handoffId,
        row.title,
        createHash("sha256").update(`sorage-seed-workspace-${row.senderSlug}`).digest("hex"),
        `/virtual/seed/${row.senderSlug}`,
        stableUuidFrom(`project-${row.recipientSlug}`),
        artifactId,
        REVIEW_STATES[index % REVIEW_STATES.length],
        row.createdAt,
        row.createdAt,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}
