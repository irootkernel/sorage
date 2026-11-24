import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppError,
  appError,
  type Configuration,
  KNOWN_SCHEMA_HISTORY,
  type PreflightConfigFact,
  type PreflightDatabaseFact,
  type PreflightIdentityFact,
  type PreflightIntegrityFact,
  type PreflightVaultFact,
} from "@sorage/core";
import { parseDocument } from "yaml";
import { loadConfiguration } from "./config-codec";
import { pathLook, type PreflightLiveness, type PrivateDatabase } from "./preflight-fs";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { execMigrationSegments, migrate } from "./sqlite/migrator";

const referenceCatalogs = new Map<number, Map<string, string>>();

export interface CaptureFacts {
  config: PreflightConfigFact;
  database: PreflightDatabaseFact;
  integrity: PreflightIntegrityFact;
  vault: PreflightVaultFact;
  identity: PreflightIdentityFact;
  staleFence: boolean;
  markerMismatch?: boolean;
}

export interface CachedPreflightConfig {
  text: string;
  fact: PreflightConfigFact;
  config?: Configuration;
}

export interface FenceRead {
  blocked: boolean;
  stale: boolean;
  stamp: string;
  live?: boolean;
}

export function recoveryRefusal(facts: CaptureFacts): AppError | undefined {
  if (
    facts.database.kind === "newer" ||
    facts.database.kind === "maximum-version-only" ||
    facts.database.kind === "memo-table-only"
  )
    return appError("STORAGE_SCHEMA_UNSUPPORTED", "the database schema is unsupported");
  if (facts.vault.kind === "newer") return appError("VAULT_SCHEMA_UNSUPPORTED", "the Vault schema is unsupported");
  if (facts.vault.kind !== "supported" || facts.markerMismatch)
    return appError(
      "VAULT_INTEGRITY_ERROR",
      "the Vault marker is missing, malformed or belongs to another Installation",
    );
  if (
    (facts.database.kind !== "current-ordered" && facts.database.kind !== "known-older-ordered") ||
    facts.integrity.kind !== "passed" ||
    facts.identity.kind !== "consistent"
  )
    return appError("STORAGE_INTEGRITY_ERROR", "the database, identity or required storage structures are invalid");
  return undefined;
}

export function blankCapture(config: PreflightConfigFact, staleFence: boolean): CaptureFacts {
  return {
    config,
    database: { kind: "unverified" },
    integrity: { kind: "unverified" },
    vault: { kind: "unverified" },
    identity: { kind: "unverified" },
    staleFence,
  };
}

export function classifyAndLoadConfig(
  text: string,
  userHome: string,
  sorageHome: string,
  cache?: { cachedConfig?: CachedPreflightConfig },
): CachedPreflightConfig {
  if (cache?.cachedConfig !== undefined && cache.cachedConfig.text === text) {
    return cache.cachedConfig;
  }
  const document = parseDocument(text);
  let result: CachedPreflightConfig;
  if (document.errors.length > 0) {
    result = { text, fact: { kind: "invalid" } };
  } else {
    let value: unknown;
    let validJs = true;
    try {
      value = document.toJS();
    } catch {
      validJs = false;
    }
    if (!validJs) {
      result = { text, fact: { kind: "invalid" } };
    } else if (!isMapping(value)) {
      result = { text, fact: { kind: "unsupported-format" } };
    } else if (!Object.hasOwn(value, "schemaVersion")) {
      result = { text, fact: { kind: "invalid" } };
    } else {
      const schemaVersion = value.schemaVersion;
      if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion > 1) {
        result = { text, fact: { kind: "newer" } };
      } else if (schemaVersion !== 1) {
        result = { text, fact: { kind: "invalid" } };
      } else {
        const loaded = loadConfiguration(text, { userHome, sorageHome });
        result = loaded.ok
          ? { text, fact: { kind: "supported" }, config: loaded.value.config }
          : { text, fact: { kind: "invalid" } };
      }
    }
  }
  if (cache !== undefined) cache.cachedConfig = result;
  return result;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function classifyVault(text: string): PreflightVaultFact {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: "malformed" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "malformed" };
  const marker = value as Record<string, unknown>;
  if (marker.type !== "sorage-vault") return { kind: "unsupported-format" };
  if (typeof marker.schemaVersion === "number" && Number.isInteger(marker.schemaVersion) && marker.schemaVersion > 1) {
    return { kind: "newer" };
  }
  if (
    marker.schemaVersion === 1 &&
    typeof marker.installationId === "string" &&
    marker.installationId !== "" &&
    typeof marker.createdAt === "string" &&
    marker.createdAt !== ""
  ) {
    return { kind: "supported" };
  }
  return { kind: "malformed" };
}

export function classifyDatabase(db: PrivateDatabase): PreflightDatabaseFact {
  const tables = tableNames(db);
  if (!tables.has("schema_migrations")) {
    if (tables.has("project_memos")) return { kind: "memo-table-only" };
    const userVersion = pragmaNumber(db, "user_version");
    if (userVersion > 0) return { kind: "maximum-version-only" };
    return { kind: "invalid-structure" };
  }
  const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
    name: string;
  }>;
  // The central ordered known-schema inventory owns the per-build maximum
  // (SHR-009, interface section 38.7); an applied history above it classifies
  // as `newer`, which preflight reports as `unsupported` without mutating.
  if (rows.some((row) => row.version > KNOWN_SCHEMA_HISTORY.length)) return { kind: "newer" };
  for (let index = 0; index < rows.length; index += 1) {
    const expected = KNOWN_SCHEMA_HISTORY[index];
    const row = rows[index];
    if (expected === undefined || row === undefined || row.version !== expected.version || row.name !== expected.name) {
      return { kind: "invalid-structure" };
    }
  }
  if (rows.length >= 5 && !hasMoveFenceColumn(db)) return { kind: "invalid-structure" };
  if (!catalogCovers(db, rows.length)) return { kind: "invalid-structure" };
  if (rows.length === KNOWN_SCHEMA_HISTORY.length) return { kind: "current-ordered" };
  if (rows.length === 0) return { kind: "invalid-structure" };
  return { kind: "known-older-ordered", preMemo: !rows.some((row) => row.name === "project-memos-v1") };
}

export function readIntegrity(db: PrivateDatabase): PreflightIntegrityFact {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
  if (row?.integrity_check !== "ok") return { kind: "failed" };
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  return violations.length === 0 ? { kind: "passed" } : { kind: "failed" };
}

function catalogCovers(db: PrivateDatabase, prefix: number): boolean {
  const expected = referenceCatalog(prefix);
  const actual = readCatalog(db);
  for (const [key, sql] of expected) {
    if (actual.get(key) !== sql) return false;
  }
  return true;
}

function referenceCatalog(prefix: number): Map<string, string> {
  const cached = referenceCatalogs.get(prefix);
  if (cached !== undefined) return cached;
  const plan = productionMigrationPlan();
  // Version selection over the combined ordered steps, never a positional
  // slice: a prefix selects every production step at or below its version, so
  // the reference catalog is exactly the schema that prefix's history
  // establishes — ordinary and rebuild-marked alike, in version order
  // (SHR-009, interface section 38.7).
  const combined = [...plan.migrations, ...plan.rebuilds].sort((a, b) => a.version - b.version);
  const selected = combined.filter((migration) => migration.version <= prefix);
  const rebuildSet = new Set(plan.rebuilds);
  const firstRebuild = selected.findIndex((migration) => rebuildSet.has(migration));
  const ordinary = firstRebuild < 0 ? selected : selected.slice(0, firstRebuild);
  const remaining = firstRebuild < 0 ? [] : selected.slice(firstRebuild);
  const db = new Database(":memory:") as unknown as PrivateDatabase;
  try {
    migrate(db as unknown as SorageSqlite, ordinary, () => "2026-01-01T00:00:00.000Z");
    if (remaining.length > 0) {
      // Remaining steps keep their version order; rebuilds run on this SAME private
      // `:memory:` connection with the migration's own foreign-key ceremony —
      // verified ON, disabled and verified OFF outside the transaction, one
      // `BEGIN IMMEDIATE`, committed DDL, enforcement restored and verified —
      // because routing them through the guarded runner's dedicated connection
      // would apply the rebuild to a different database and leave this one
      // without the version-9 DDL (SHR-009, interface section 38.7).
      for (const step of remaining) {
        if (!rebuildSet.has(step)) {
          db.exec("BEGIN IMMEDIATE");
          try {
            execMigrationSegments(db as unknown as SorageSqlite, step);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          continue;
        }
        db.exec("PRAGMA foreign_keys = ON");
        if (pragmaNumber(db, "foreign_keys") !== 1) {
          throw new Error("the private reference-catalog connection could not enable foreign-key enforcement");
        }
        db.exec("PRAGMA foreign_keys = OFF");
        if (pragmaNumber(db, "foreign_keys") !== 0) {
          throw new Error("the private reference-catalog connection could not disable foreign-key enforcement");
        }
        let rebuildError: unknown;
        try {
          db.exec("BEGIN IMMEDIATE");
          execMigrationSegments(db as unknown as SorageSqlite, step);
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction may already be gone; the DDL failure is the error.
          }
          rebuildError = error;
        }
        let restorationError: unknown;
        try {
          db.exec("PRAGMA foreign_keys = ON");
          if (pragmaNumber(db, "foreign_keys") !== 1) {
            throw new Error("the private reference-catalog connection could not restore foreign-key enforcement");
          }
        } catch (error) {
          restorationError = error;
        }
        if (rebuildError !== undefined && restorationError !== undefined) {
          throw new AggregateError(
            [rebuildError, restorationError],
            "the private reference-catalog rebuild failed and foreign-key restoration could not be verified",
          );
        }
        if (rebuildError !== undefined) throw rebuildError;
        if (restorationError !== undefined) throw restorationError;
      }
    }
    const catalog = readCatalog(db);
    referenceCatalogs.set(prefix, catalog);
    return catalog;
  } finally {
    db.close();
  }
}

function readCatalog(db: PrivateDatabase): Map<string, string> {
  const rows = db
    .prepare("SELECT type, name, IFNULL(sql, '') AS sql FROM sqlite_master ORDER BY type, name")
    .all() as Array<{
    type: string;
    name: string;
    sql: string;
  }>;
  const catalog = new Map<string, string>();
  for (const row of rows) {
    if (row.name.startsWith("sqlite_") && !row.name.startsWith("sqlite_autoindex_")) continue;
    catalog.set(`${row.type}:${row.name}`, row.sql.replace(/\s+/g, " ").trim());
  }
  return catalog;
}

export function markerInstallationId(text: string, vault: PreflightVaultFact): string | undefined {
  if (vault.kind !== "supported") return undefined;
  const parsed = JSON.parse(text) as { installationId?: string };
  return parsed.installationId;
}

export function classifyIdentity(
  installationId: string,
  markerId: string | undefined,
  vault: PreflightVaultFact,
  databaseKind: PreflightDatabaseFact["kind"],
  db: PrivateDatabase | undefined,
): PreflightIdentityFact {
  const ids = new Set<string>([installationId]);
  if (vault.kind === "supported" && markerId !== undefined) ids.add(markerId);
  const ordered = databaseKind === "current-ordered" || databaseKind === "known-older-ordered";
  let row: "present" | "absent-optional" = "absent-optional";
  if (ordered && db !== undefined && tableNames(db).has("installation")) {
    const installation = db.prepare("SELECT installation_id FROM installation WHERE id = 1").get() as
      | { installation_id?: string }
      | undefined;
    if (installation?.installation_id !== undefined) {
      row = "present";
      ids.add(installation.installation_id);
    }
  }
  if (ordered && db !== undefined && tableNames(db).has("project_bindings")) {
    const bindings = db.prepare("SELECT installation_id FROM project_bindings").all() as Array<{
      installation_id: string;
    }>;
    for (const binding of bindings) ids.add(binding.installation_id);
  }
  if (ids.size > 1) return { kind: "inconsistent" };
  if (vault.kind === "supported" && ordered) return { kind: "consistent", row };
  return { kind: "unverified" };
}

export function databaseMoveFence(
  db: PrivateDatabase,
  liveness: (pid: number) => PreflightLiveness,
): "clear" | "stale" | "alive" | "uncertain" {
  if (!hasMoveFenceColumn(db)) return "clear";
  const row = db.prepare("SELECT move_fence_pid FROM vault_state WHERE id = 1").get() as
    | { move_fence_pid?: number | null }
    | undefined;
  const pid = row?.move_fence_pid;
  if (pid === undefined || pid === null) return "clear";
  const verdict = liveness(pid);
  if (verdict === "alive" || verdict === "uncertain") return verdict;
  return "stale";
}

export function hasMoveFenceColumn(db: PrivateDatabase): boolean {
  const columns = db.prepare("PRAGMA table_info(vault_state)").all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "move_fence_pid");
}

function tableNames(db: PrivateDatabase): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function pragmaNumber(db: PrivateDatabase, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  return typeof value === "number" ? value : 0;
}

export function readFences(listing: { canonical: string; liveness: (pid: number) => PreflightLiveness }): FenceRead {
  const paths = [join(listing.canonical, "run", "vault-move.lock")];
  const migration = join(listing.canonical, "run", "migration.lock");
  const migrationLook = pathLook(migration);
  if (migrationLook.kind === "failed") return { blocked: true, stale: false, stamp: "unsafe" };
  if (migrationLook.kind === "stat" && migrationLook.stat.isFile() && !migrationLook.stat.isSymbolicLink()) {
    paths.push(migration);
  }
  let blocked = false;
  let stale = false;
  let live = false;
  const stamps: string[] = [];
  for (const path of paths) {
    const look = pathLook(path);
    if (look.kind === "failed") return { blocked: true, stale: false, stamp: "unsafe" };
    if (look.kind === "missing") continue;
    const stat = look.stat;
    if (!stat.isFile() || stat.isSymbolicLink()) return { blocked: true, stale: false, stamp: "unsafe" };
    const text = readFileSync(path, "utf8");
    stamps.push(`${path}:${text}`);
    const verdict = judgeLock(text, listing.liveness);
    if (verdict === "alive" || verdict === "uncertain") blocked = true;
    if (verdict === "alive") live = true;
    if (verdict === "stale") stale = true;
  }
  return { blocked, stale, live, stamp: stamps.join("\n") };
}

function judgeLock(
  text: string,
  liveness: (pid: number) => PreflightLiveness,
): "clear" | "stale" | "alive" | "uncertain" {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return "stale";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "stale";
  const pid = (value as { pid?: unknown }).pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "stale";
  const verdict = liveness(pid);
  if (verdict === "alive" || verdict === "uncertain") return verdict;
  return "stale";
}
