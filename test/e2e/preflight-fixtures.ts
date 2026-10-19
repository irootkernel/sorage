import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import type { SorageSqlite } from "../../packages/adapters/src/sqlite/connection";
import { migrate } from "../../packages/adapters/src/sqlite/migrator";
import { productionMigrationPlan } from "../../packages/adapters/src/sqlite/migrations";
import { knownSchemaMaximum } from "../../packages/core/src/known-schemas";

/** Example installation id from docs/specs/examples/config.example.yaml. */
export const INSTALLATION_ID = "9d57384c-030e-4ff7-90ca-c615d8043db2";
export const OTHER_ID = "1f0ac9a0-0000-4000-8000-00000000000b";

const STAMP = "2026-01-01T00:00:00.000Z";
const CONFIG_EXAMPLE = fileURLToPath(new URL("../../docs/specs/examples/config.example.yaml", import.meta.url));

export function configText(): string {
  return readFileSync(CONFIG_EXAMPLE, "utf8");
}

export function markerText(): string {
  return `${JSON.stringify({
    type: "sorage-vault",
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    createdAt: STAMP,
  })}\n`;
}

/** Setup actor only. `through` selects a prefix of the production schema inventory. */
export function writeInstallation(home: string, through = knownSchemaMaximum()): void {
  mkdirSync(join(home, "logs"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "run"), { recursive: true });
  mkdirSync(join(home, "vault"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), configText());
  writeFileSync(join(home, "vault", ".sorage-vault.json"), markerText());
  const databasePath = join(home, "state", "sorage.sqlite3");
  const db = new Database(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  const plan = productionMigrationPlan();
  migrate(
    db as unknown as SorageSqlite,
    plan.migrations.filter((migration) => migration.version <= through),
    () => STAMP,
    { databasePath, rebuilds: plan.rebuilds.filter((migration) => migration.version <= through) },
  );
  if (through >= 1) {
    db.prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 1, ?)").run(
      INSTALLATION_ID,
      STAMP,
    );
  }
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  db.close();
}

/** Setup actor only. Domain rows, both binding kinds, and receipt rows. No project process. */
export function populateDomain(home: string, directory: string, gitDirectory: string): void {
  const db = new Database(join(home, "state", "sorage.sqlite3"));
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES ('p1', 'demo', 'Demo', 'active', ?, ?)",
  ).run(STAMP, STAMP);
  const bind =
    "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES (?, 'p1', ?, ?, ?, ?, ?)";
  db.prepare(bind).run("b-dir", INSTALLATION_ID, directory, "directory", STAMP, STAMP);
  db.prepare(bind).run("b-git", INSTALLATION_ID, gitDirectory, "git_repository", STAMP, STAMP);
  db.prepare(
    "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES ('receipt-1', 'send', 'hash', '{}', ?, ?)",
  ).run(STAMP, STAMP);
  db.prepare(
    "INSERT INTO backup_runs (id, triggered_by, started_at, finished_at, outcome, snapshot_outcome, commit_outcome, push_outcome, commit_sha) VALUES ('run-1', 'manual', ?, ?, 'success', 'success', 'committed', 'skipped', 'abc123')",
  ).run(STAMP, STAMP);
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  db.close();
}
