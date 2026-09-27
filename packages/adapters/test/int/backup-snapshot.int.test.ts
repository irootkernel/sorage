import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportSnapshot, initializeInstallation } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The TASK-052 export contract over a real installation (BKP-003, BKP-007,
 * BKP-008, BKP-024): two exports of unchanged data are byte-identical trees,
 * the default redaction removes exactly the machine-local paths, the tree is
 * replaced atomically with no scratch left behind, and changed data changes
 * the bytes.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function initializedHome(prefix: string): { home: string; vault: string } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  if (!initializeInstallation(ports, { vaultPath: vault }).ok) throw new Error("fixture init must succeed");
  return { home, vault };
}

function seedInstallation(home: string, vault: string, options: { workspacePath: string }): void {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  // The handoff-to-artifact cycle defers to commit, so the seed rows land in
  // one explicit transaction the way a real send transaction would write them.
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at)
    VALUES ('p-1', 'beta', 'Beta', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at)
    VALUES ('b-1', 'p-1', 'installation-a', ?, 'directory', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(options.workspacePath);
  db.prepare(
    `INSERT INTO handoffs (id, title, sender_kind, sender_path_snapshot, recipient_project_id,
      current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions,
      pinned, created_at, updated_at)
    VALUES ('1a111111-1111-4111-8111-111111111111', 'Brief', 'unregistered_workspace', ?, 'p-1', 'a-1', 1, 2, 'awaiting_recipient', 0, 0,
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  ).run(options.workspacePath);
  const artifactBytes = "# The brief\n";
  const artifactPath = join(vault, "artifacts/1a111111-1111-4111-8111-111111111111/a-1/brief.md");
  mkdirSync(join(vault, "artifacts/1a111111-1111-4111-8111-111111111111/a-1"), { recursive: true });
  writeFileSync(artifactPath, artifactBytes);
  db.prepare(
    `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes,
      sha256, imported_from_path, materialized, created_at)
    VALUES ('a-1', '1a111111-1111-4111-8111-111111111111', 'artifacts/1a111111-1111-4111-8111-111111111111/a-1/brief.md', 'brief.md', 'brief.md', 'text/markdown', ?,
      ?, ?, 1, '2026-01-02T00:00:00.000Z')`,
  ).run(
    artifactBytes.length,
    createHash("sha256").update(artifactBytes).digest("hex"),
    join(options.workspacePath, "brief.md"),
  );
  db.prepare(
    `INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
    VALUES ('e-1', '1a111111-1111-4111-8111-111111111111', 'HANDOFF_CREATED', 'unregistered_workspace', 'workspace-key', 1, ?, '2026-01-02T00:00:00.000Z')`,
  ).run(
    JSON.stringify({
      title: "Brief",
      storageKey: "artifacts/1a111111-1111-4111-8111-111111111111/a-1/brief.md",
      fromPath: "/somewhere",
    }),
  );
  db.exec("COMMIT");
  db.close();
}

function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(path, "utf8");
    }
  };
  walk(root, "");
  return files;
}

function exportOnce(home: string) {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: home });
  const exportPorts = ports.exportPorts();
  if (!exportPorts.ok) throw new Error(exportPorts.error.message);
  return exportSnapshot(exportPorts.value);
}

describe("exportSnapshot over a real installation", () => {
  it("writes byte-identical trees across two exports of unchanged data", () => {
    const { home, vault } = initializedHome("sorage-snapshot-determinism-");
    seedInstallation(home, vault, { workspacePath: join(home, "work", "beta") });

    const first = exportOnce(home);
    expect(first.ok).toBe(true);
    const firstTree = readTree(join(vault, "snapshots"));
    const second = exportOnce(home);
    expect(second.ok).toBe(true);
    expect(readTree(join(vault, "snapshots"))).toEqual(firstTree);

    const paths = Object.keys(firstTree).sort();
    expect(paths).toEqual([
      "events.jsonl",
      "handoffs/1a/1a111111-1111-4111-8111-111111111111.json",
      "manifest.json",
      "projects.json",
    ]);
    // No scratch directory the atomic replacement uses survives the export.
    expect(readdirSync(vault).filter((name) => name.startsWith(".snapshots."))).toEqual([]);
  });

  it("redacts machine-local paths by default and keeps them when the policy is off", () => {
    const { home, vault } = initializedHome("sorage-snapshot-redaction-");
    const workspacePath = join(home, "work", "beta");
    seedInstallation(home, vault, { workspacePath });

    exportOnce(home);
    const redacted = readTree(join(vault, "snapshots"));
    expect(redacted["projects.json"]).toBeDefined();
    expect(redacted["projects.json"]).not.toContain(workspacePath);
    const shard = redacted["handoffs/1a/1a111111-1111-4111-8111-111111111111.json"];
    expect(shard).toBeDefined();
    // BKP-003 enumerates the redaction surface exactly: the sender path
    // snapshot, binding directories, and event metadata path fields. The
    // senderPathSnapshot key is gone; importedFromPath is provenance the
    // enumeration keeps, so the assertion pins the key, not the substring.
    const parsedShard = JSON.parse(shard as string) as Record<string, unknown>;
    expect("senderPathSnapshot" in parsedShard).toBe(false);
    expect(redacted["events.jsonl"]).not.toContain("/somewhere");
    expect(redacted["events.jsonl"]).toContain("storageKey");
    const manifest = JSON.parse(redacted["manifest.json"] as string) as { counts: Record<string, number> };
    expect(manifest.counts).toEqual({ projects: 1, handoffs: 1, events: 1, artifacts: 1, memos: 0 });

    // Flipping the policy off exposes the same paths the redaction removed.
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(configPath, config.replace("redactWorkspacePaths: true", "redactWorkspacePaths: false"));
    exportOnce(home);
    const exposed = readTree(join(vault, "snapshots"));
    expect(exposed["projects.json"]).toContain(workspacePath);
    const exposedShard = JSON.parse(
      exposed["handoffs/1a/1a111111-1111-4111-8111-111111111111.json"] as string,
    ) as Record<string, unknown>;
    expect(exposedShard.senderPathSnapshot).toBe(workspacePath);
    expect(exposed["events.jsonl"]).toContain("/somewhere");
  });

  it("changes the bytes once the underlying rows change", () => {
    const { home, vault } = initializedHome("sorage-snapshot-change-");
    seedInstallation(home, vault, { workspacePath: join(home, "work", "beta") });
    exportOnce(home);
    const before = readTree(join(vault, "snapshots"));

    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    db.prepare(
      "UPDATE handoffs SET review_state = 'accepted', accepted_revision = 1 WHERE id = '1a111111-1111-4111-8111-111111111111'",
    ).run();
    db.close();
    exportOnce(home);
    const after = readTree(join(vault, "snapshots"));
    expect(after["handoffs/1a/1a111111-1111-4111-8111-111111111111.json"]).not.toBe(
      before["handoffs/1a/1a111111-1111-4111-8111-111111111111.json"],
    );
    expect(after["manifest.json"]).toBe(before["manifest.json"]);
  });

  it("replaces the tree atomically, dropping any shard the new export does not name", () => {
    const { home, vault } = initializedHome("sorage-snapshot-replace-");
    seedInstallation(home, vault, { workspacePath: join(home, "work", "beta") });
    exportOnce(home);
    const snapshots = join(vault, "snapshots");

    // A shard a previous export of a larger database left behind — or a file a
    // crashed export never cleaned — must not survive the next replacement,
    // because the ledger is append-only and the rows cannot be deleted to
    // shrink the database for real.
    mkdirSync(join(snapshots, "handoffs/2b"), { recursive: true });
    writeFileSync(join(snapshots, "handoffs/2b/stale.json"), "{}\n");
    writeFileSync(join(snapshots, "stray.txt"), "stray\n");
    exportOnce(home);
    expect(existsSync(join(snapshots, "handoffs/2b"))).toBe(false);
    expect(existsSync(join(snapshots, "stray.txt"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(snapshots, "manifest.json"), "utf8")) as {
      counts: Record<string, number>;
    };
    expect(manifest.counts.handoffs).toBe(1);
  });

  it("writes every file with LF endings only", () => {
    const { home, vault } = initializedHome("sorage-snapshot-lf-");
    seedInstallation(home, vault, { workspacePath: join(home, "work", "beta") });
    exportOnce(home);
    for (const [name, content] of Object.entries(readTree(join(vault, "snapshots")))) {
      expect(name, `${name} has no CR`).toBeDefined();
      expect(content.includes("\r")).toBe(false);
      expect(statSync(join(vault, "snapshots", name)).isFile()).toBe(true);
    }
  });
});
