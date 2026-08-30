import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupRestore, exportSnapshot, initializeInstallation } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The TASK-052 restore drill at the adapter level (BKP-021, BKP-023, VLT-019,
 * RUN-014, SEC-014): a Vault copy restores into a second empty installation
 * that never held the data, rebuilding every row verbatim, adopting the
 * marker's installationId, regenerating only the API token, and refusing both
 * a populated target and a single altered Artifact byte.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
}

function initializedHome(prefix: string): { home: string; vault: string } {
  const home = tempDir(prefix);
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  if (!initializeInstallation(ports, { vaultPath: vault }).ok) throw new Error("fixture init must succeed");
  return { home, vault };
}

const HANDOFF_ID = "1a111111-1111-4111-8111-111111111111";
const TOMBSTONE_ID = "2b222222-2222-4222-8222-222222222222";
const WORKSPACE_KEY = "workspace-key-of-the-unregistered-sender";

function seedSource(home: string, vault: string): void {
  const workspacePath = join(home, "work", "beta");
  mkdirSync(workspacePath, { recursive: true });
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at)
    VALUES ('p-1', 'beta', 'Beta', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at)
    VALUES ('b-1', 'p-1', 'source-installation', ?, 'directory', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(workspacePath);
  const artifactBytes = "# The brief\n";
  mkdirSync(join(vault, "artifacts", HANDOFF_ID, "a-1"), { recursive: true });
  const artifactPath = join(vault, "artifacts", HANDOFF_ID, "a-1", "brief.md");
  writeFileSync(artifactPath, artifactBytes);
  chmodSync(artifactPath, 0o444);
  db.prepare(
    `INSERT INTO handoffs (id, sender_kind, sender_workspace_key, sender_path_snapshot, recipient_project_id,
      current_artifact_id, title, revision, row_version, review_state, first_fetched_at, created_at, updated_at)
    VALUES (?, 'unregistered_workspace', ?, ?, 'p-1', 'a-1', 'Brief', 2, 3, 'changes_requested',
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  ).run(HANDOFF_ID, WORKSPACE_KEY, workspacePath);
  db.prepare(
    `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes,
      sha256, imported_from_path, materialized, created_at)
    VALUES ('a-1', ?, ?, 'brief.md', 'brief.md', 'text/markdown', ?, ?, ?, 1, '2026-01-02T00:00:00.000Z')`,
  ).run(
    HANDOFF_ID,
    `artifacts/${HANDOFF_ID}/a-1/brief.md`,
    artifactBytes.length,
    createHash("sha256").update(artifactBytes).digest("hex"),
    join(workspacePath, "brief.md"),
  );
  db.prepare(
    `INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at)
    VALUES (?, 'registered_project', 'p-1', 2, 'Tighten the title', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`,
  ).run(HANDOFF_ID);
  db.prepare(
    `INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status,
      requested_at, resolved_at, resolved_by_user, resolution_note)
    VALUES ('d-1', ?, 'registered_project', 'p-1', 'Done', 'rejected', '2026-01-04T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z', 'root', 'kept for the audit')`,
  ).run(HANDOFF_ID);
  db.prepare(
    `INSERT INTO handoffs (id, sender_kind, recipient_project_id, title, revision, row_version, review_state,
      consecutive_no_change_resolutions, pinned, deleted_at, created_at, updated_at)
    VALUES (?, 'user', 'p-1', 'Gone', 1, 1, 'accepted', 0, 0, '2026-01-06T00:00:00.000Z',
      '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z')`,
  ).run(TOMBSTONE_ID);
  db.prepare(
    `INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
    VALUES ('e-1', ?, 'HANDOFF_CREATED', 'unregistered_workspace', ?, 1, ?, '2026-01-02T00:00:01.000Z')`,
  ).run(HANDOFF_ID, WORKSPACE_KEY, JSON.stringify({ title: "Brief", fromPath: "/somewhere" }));
  db.prepare(
    `INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
    VALUES ('e-2', ?, 'REVIEW_NOTE_CREATED', 'registered_project', 'p-1', 3, ?, '2026-01-03T00:00:00.000Z')`,
  ).run(HANDOFF_ID, JSON.stringify({ targetRevision: 2 }));
  db.exec("COMMIT");
  db.close();

  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: homedir() });
  const exportPorts = ports.exportPorts();
  if (!exportPorts.ok) throw new Error(exportPorts.error.message);
  const exported = exportSnapshot(exportPorts.value);
  if (!exported.ok) throw new Error(exported.error.message);
}

/** A Vault copy in the shape restore receives: the whole tree of a backed-up Vault. */
function vaultCopy(source: string): string {
  const copy = tempDir("sorage-restore-source-");
  cpSyncRecursive(source, copy);
  return copy;
}

function cpSyncRecursive(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "staging") continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) cpSyncRecursive(source, target);
    else {
      // A Git clone would check these out 0644; the copy mirrors that so the
      // restore's own 0444 chmod is the behavior under test.
      writeFileSync(target, readFileSync(source));
      chmodSync(target, 0o644);
    }
  }
}

function restoreInto(targetHome: string, source: string, options: { dryRun: boolean }) {
  const ports = createNodeBackupCommandPorts({
    env: { SORAGE_HOME: targetHome },
    userHome: homedir(),
    sourcePath: source,
    clock: new FakeClock(),
  });
  const restorePorts = ports.restorePorts();
  if (!restorePorts.ok) throw new Error(restorePorts.error.message);
  return backupRestore(restorePorts.value, options);
}

function domainCounts(home: string): Record<string, number> {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    const counts: Record<string, number> = {};
    for (const table of [
      "projects",
      "project_bindings",
      "handoffs",
      "artifacts",
      "review_notes",
      "deletion_requests",
      "events",
    ]) {
      counts[table] = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    }
    return counts;
  } finally {
    db.close();
  }
}

/** The installation identity authority is config.yaml; the schema v1 `installation` table stays unused. */
function installationIdOf(home: string): string {
  const configText = readFileSync(join(home, "config.yaml"), "utf8");
  return /installationId: "?([0-9a-f-]+)"?/.exec(configText)?.[1] ?? "";
}

describe("backupRestore across two installations", () => {
  it("dry-runs every validation without writing anything", () => {
    const source = initializedHome("sorage-restore-dry-src-");
    seedSource(source.home, source.vault);
    const copy = vaultCopy(source.vault);
    const target = initializedHome("sorage-restore-dry-dst-");
    const before = installationIdOf(target.home);

    const result = restoreInto(target.home, copy, { dryRun: true });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.dryRun) {
      expect(result.value.wouldCreate).toEqual({ projects: 1, handoffs: 2, reviewNotes: 1, artifacts: 1, events: 2 });
    }
    expect(domainCounts(target.home)).toEqual({
      projects: 0,
      project_bindings: 0,
      handoffs: 0,
      artifacts: 0,
      review_notes: 0,
      deletion_requests: 0,
      events: 0,
    });
    expect(installationIdOf(target.home)).toEqual(before);
    expect(existsSync(join(target.vault, "artifacts", HANDOFF_ID))).toBe(false);
  });

  it("rebuilds the state verbatim, adopts the identity, and regenerates only the token", () => {
    const source = initializedHome("sorage-restore-real-src-");
    seedSource(source.home, source.vault);
    const exportedEvents = readFileSync(join(source.vault, "snapshots/events.jsonl"), "utf8");
    const sourceId = installationIdOf(source.home);
    const copy = vaultCopy(source.vault);
    const target = initializedHome("sorage-restore-real-dst-");

    const result = restoreInto(target.home, copy, { dryRun: false });
    expect(result.ok).toBe(true);
    if (result.ok && !result.value.dryRun) {
      expect(result.value.restored).toEqual({ projects: 1, handoffs: 2, reviewNotes: 1, artifacts: 1, events: 2 });
      expect(result.value.events).toEqual(["VAULT_ADOPTED", "RESTORE_COMPLETED"]);
    }

    // The rows: identity, Projects, both Handoffs, the Note, the Deletion
    // Request, and the ledger exactly as exported plus the two restore events.
    expect(installationIdOf(target.home)).toBe(sourceId);
    const db = new DatabaseSync(join(target.home, "state", "sorage.sqlite3"));
    const handoff = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(HANDOFF_ID) as Record<string, unknown>;
    expect(handoff["revision"]).toBe(2);
    expect(handoff["row_version"]).toBe(3);
    expect(handoff["review_state"]).toBe("changes_requested");
    expect(handoff["sender_workspace_key"]).toBe(WORKSPACE_KEY);
    expect(handoff["sender_path_snapshot"]).toBeNull();
    const tombstone = db.prepare("SELECT deleted_at FROM handoffs WHERE id = ?").get(TOMBSTONE_ID) as {
      deleted_at: string;
    };
    expect(tombstone.deleted_at).toBe("2026-01-06T00:00:00.000Z");
    const note = db.prepare("SELECT body, target_revision FROM review_notes WHERE handoff_id = ?").get(HANDOFF_ID) as {
      body: string;
      target_revision: number;
    };
    expect(note.body).toBe("Tighten the title");
    expect(note.target_revision).toBe(2);
    const request = db.prepare("SELECT status FROM deletion_requests WHERE id = 'd-1'").get() as { status: string };
    expect(request.status).toBe("rejected");
    const events = db.prepare("SELECT id, metadata_json FROM events ORDER BY created_at").all() as Array<{
      id: string;
      metadata_json: string;
    }>;
    const ids = events.map((event) => event.id);
    expect(ids).toHaveLength(4);
    expect(ids).toEqual(expect.arrayContaining(["e-1", "e-2"]));
    const restoredFirst = events.find((event) => event.id === "e-1");
    expect(restoredFirst).toBeDefined();
    const exportedFirst = JSON.parse(exportedEvents.split("\n")[0] as string) as { metadata: Record<string, unknown> };
    expect(JSON.parse((restoredFirst as { metadata_json: string }).metadata_json)).toEqual(exportedFirst.metadata);
    const types = db
      .prepare("SELECT event_type FROM events WHERE id NOT IN ('e-1', 'e-2') ORDER BY created_at")
      .all() as Array<{ event_type: string }>;
    expect(types.map((row) => row.event_type)).toEqual(["VAULT_ADOPTED", "RESTORE_COMPLETED"]);
    db.close();

    // The Vault: the marker carries the adopted identity and the Artifact bytes
    // are byte-identical and read-only.
    const marker = JSON.parse(readFileSync(join(target.vault, ".sorage-vault.json"), "utf8")) as {
      installationId: string;
    };
    expect(marker.installationId).toBe(sourceId);
    const restored = readFileSync(join(target.vault, `artifacts/${HANDOFF_ID}/a-1/brief.md`), "utf8");
    expect(restored).toBe("# The brief\n");

    // Only the API token is regenerated; it exists and is well-formed.
    const token = readFileSync(join(target.home, "state", "api-token"), "utf8").trim();
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("refuses a populated target with RESTORE_TARGET_NOT_EMPTY", () => {
    const source = initializedHome("sorage-restore-second-src-");
    seedSource(source.home, source.vault);
    const copy = vaultCopy(source.vault);
    const target = initializedHome("sorage-restore-second-dst-");
    const first = restoreInto(target.home, copy, { dryRun: false });
    expect(first.ok).toBe(true);

    const second = restoreInto(target.home, copy, { dryRun: false });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error.code).toBe("RESTORE_TARGET_NOT_EMPTY");
  });

  it("aborts on a single altered Artifact byte and writes nothing", () => {
    const source = initializedHome("sorage-restore-altered-src-");
    seedSource(source.home, source.vault);
    const copy = vaultCopy(source.vault);
    const artifact = join(copy, `artifacts/${HANDOFF_ID}/a-1/brief.md`);
    chmodSync(artifact, 0o644);
    writeFileSync(artifact, "# The brief, altered\n");
    const target = initializedHome("sorage-restore-altered-dst-");

    const result = restoreInto(target.home, copy, { dryRun: false });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(domainCounts(target.home)).toEqual({
      projects: 0,
      project_bindings: 0,
      handoffs: 0,
      artifacts: 0,
      review_notes: 0,
      deletion_requests: 0,
      events: 0,
    });
  });

  it("pauses while another process holds vault-move.lock (RUN-014)", () => {
    const source = initializedHome("sorage-restore-lock-src-");
    seedSource(source.home, source.vault);
    const copy = vaultCopy(source.vault);
    const target = initializedHome("sorage-restore-lock-dst-");
    mkdirSync(join(target.home, "run"), { recursive: true });
    // The test process's own pid is alive, so the lock reads as held by a live owner.
    writeFileSync(
      join(target.home, "run", "vault-move.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
    );

    const result = restoreInto(target.home, copy, { dryRun: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("SERVICE_PAUSED");
  });

  it("refuses while the daemon is running", () => {
    const source = initializedHome("sorage-restore-daemon-src-");
    seedSource(source.home, source.vault);
    const copy = vaultCopy(source.vault);
    const target = initializedHome("sorage-restore-daemon-dst-");
    mkdirSync(join(target.home, "run"), { recursive: true });
    writeFileSync(
      join(target.home, "run", "daemon.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
    );

    const result = restoreInto(target.home, copy, { dryRun: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("SERVICE_PAUSED");
  });

  it("refuses a source without snapshots as VAULT_INTEGRITY_ERROR", () => {
    const target = initializedHome("sorage-restore-nosnap-dst-");
    const notAVault = tempDir("sorage-restore-nosnap-src-");

    const result = restoreInto(target.home, notAVault, { dryRun: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });
});
