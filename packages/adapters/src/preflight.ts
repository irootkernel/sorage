import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Database } from "bun:sqlite";
import { parseDocument } from "yaml";
import {
  assessPreflight,
  loadConfiguration,
  parseConfigurationFile,
  type PreflightConfigFact,
  type PreflightDatabaseFact,
  type PreflightFacts,
  type PreflightIdentityFact,
  type PreflightIntegrityFact,
  type PreflightReport,
  type PreflightResidueEntry,
  type PreflightVaultFact,
} from "@sorage/core";
import { MIGRATIONS } from "./sqlite/migrations";
import type { SorageSqlite } from "./sqlite/connection";
import { migrate } from "./sqlite/migrator";

/**
 * Non-mutating installation inspection. The selected SQLite files are copied
 * and opened only as a private copy; assessPreflight owns the verdict.
 */
const LOG_FILE_NAME = /^sorage\.log(?:\.[1-9][0-9]*)?$/;
const SQLITE_HEADER = "SQLite format 3";
export const CAPTURE_ATTEMPTS = 2;
const ROOT_INSTALL_NAMES = new Set(["config.yaml", "logs", "state", "run", "vault"]);
const referenceCatalogs = new Map<number, Map<string, string>>();

export type PreflightLiveness = "alive" | "dead" | "uncertain";

export interface PreflightInspectPorts {
  /** Operating-system user home for `~/` expansion. Never the selected installation. */
  userHome?: string;
  /** Existing directory outside the selected home and Vault. The inspector creates its scratch here. */
  scratchParent?: string;
  /** Signal-zero probe. The default is `process.kill`. */
  kill?: (pid: number, signal: number) => void;
  /** Called once after the first look at an absent selected path, before the stability recheck. */
  onObserved?: () => void;
  liveness?: (pid: number) => PreflightLiveness;
  copyFile?: (from: string, to: string) => void;
  readFile?: (path: string) => Buffer;
  openPrivateDatabase?: (path: string) => PrivateDatabase;
}

interface PrivateDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}

interface CaptureFacts {
  config: PreflightConfigFact;
  database: PreflightDatabaseFact;
  integrity: PreflightIntegrityFact;
  vault: PreflightVaultFact;
  identity: PreflightIdentityFact;
  staleFence: boolean;
}

export function inspectPreflight(homePath: string, ports: PreflightInspectPorts = {}): PreflightReport {
  const userHome = ports.userHome ?? homedir();
  const located = locateHome(homePath);
  if (located.kind === "absent") {
    ports.onObserved?.();
    const again = pathLook(homePath);
    if (again.kind === "stat") return unstableHome();
    if (again.kind === "missing") return assessPreflight(closedFacts("absent"));
    return assessPreflight(closedFacts("unreadable"));
  }
  if (located.kind !== "directory") return assessPreflight(closedFacts(located.kind));
  const listing = listHome(located.canonical);
  if (listing.kind === "unsafe") return uncertain(listing.home);
  if (listing.kind !== "installed") return assessPreflight(shallowFacts(listing));
  listing.requested = homePath;
  listing.linkMoved = false;
  const homeBinding = rootBinding(homePath);
  if (homeBinding === undefined || homeBinding !== rootBinding(listing.canonical)) return uncertain("installed");
  listing.homeBinding = homeBinding;
  const configPath = join(listing.canonical, "config.yaml");
  try {
    listing.observedConfig = readFileSync(configPath, "utf8");
  } catch {
    // An unreadable configuration has no snapshot. A later successful read is a changed observation.
  }
  if (listing.observedConfig !== undefined) {
    const earlyConfig = classifyConfig(listing.observedConfig, userHome, listing.canonical);
    if (earlyConfig.kind !== "supported") {
      if (!observationHolds(listing, userHome)) return uncertain("installed");
      return assessPreflight({
        home: { kind: "installed" },
        snapshot: { kind: "unverified" },
        config: earlyConfig,
        database: { kind: "unverified" },
        integrity: { kind: "unverified" },
        vault: { kind: "unverified" },
        identity: { kind: "unverified" },
      });
    }
    const loaded = loadConfiguration(listing.observedConfig, { userHome, sorageHome: listing.canonical });
    if (!loaded.ok) return uncertain("installed");
    listing.vaultPath = loaded.value.config.vault.path;
    const vaultLook = pathLook(listing.vaultPath);
    if (vaultLook.kind === "failed") return uncertain("installed");
    if (vaultLook.kind === "missing") {
      listing.observedVault = "absent";
    } else if (vaultLook.stat.isSymbolicLink()) {
      const target = pathTarget(listing.vaultPath);
      if (target.kind !== "path") return uncertain("installed");
      const vaultBinding = rootBinding(listing.vaultPath);
      if (vaultBinding === undefined) return uncertain("installed");
      listing.observedVault = vaultBinding;
    } else if (!vaultLook.stat.isDirectory()) {
      return uncertain("installed");
    } else {
      const vaultBinding = rootBinding(listing.vaultPath);
      if (vaultBinding === undefined) return uncertain("installed");
      listing.observedVault = vaultBinding;
    }
    if (!configuredVaultAlias(listing)) return uncertain("installed");
  }
  const roots = [listing.canonical];
  const observedVaultPath = listing.observedVault?.includes("\n") ? listing.observedVault.split("\n")[0] : undefined;
  if (observedVaultPath !== undefined && observedVaultPath !== "") roots.push(observedVaultPath);
  const preferred = ports.scratchParent;
  if (!observationHolds(listing, userHome)) return uncertain("installed");
  const parent = scratchParent(roots, preferred);
  if (parent === undefined || !observationHolds(listing, userHome)) return uncertain("installed");
  let scratch: string;
  try {
    scratch = mkdtempSync(join(parent, "sorage-preflight-"));
  } catch {
    return uncertain("installed");
  }
  try {
    const captured = capture(listing, ports, scratch, userHome);
    if (!captured.ok) return uncertain("installed");
    return assessPreflight({
      home: { kind: "installed" },
      snapshot: { kind: "coherent", staleFence: captured.facts.staleFence },
      config: captured.facts.config,
      database: captured.facts.database,
      integrity: captured.facts.integrity,
      vault: captured.facts.vault,
      identity: captured.facts.identity,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function capture(
  listing: InstalledHome,
  ports: PreflightInspectPorts,
  scratch: string,
  userHome: string,
): { ok: true; facts: CaptureFacts } | { ok: false } {
  listing.liveness = ports.liveness ?? ((pid) => probePid(pid, ports.kill ?? process.kill.bind(process)));
  const copyFile = ports.copyFile ?? copyFileSync;
  const readFile = ports.readFile ?? ((path: string) => readFileSync(path));
  const openPrivate = ports.openPrivateDatabase ?? openPrivateCopy;
  const initialShape = managedShape(listing);
  if (initialShape === undefined) return { ok: false };
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    if (rootBinding(listing.requested) !== listing.homeBinding) return { ok: false };
    if (managedShape(listing) !== initialShape) return { ok: false };
    const before = fingerprint(listing);
    if (before === undefined) continue;
    const copyRoot = join(scratch, `attempt-${attempt}`);
    mkdirSync(copyRoot);
    try {
      const staged = stageCopies(listing, copyRoot, copyFile, readFile, userHome);
      if (listing.linkMoved) return { ok: false };
      if (staged === undefined) continue;
      if (rootBinding(listing.requested) !== listing.homeBinding) return { ok: false };
      if (managedShape(listing) !== initialShape) return { ok: false };
      const after = fingerprint(listing);
      if (after === undefined || after !== before) continue;
      const observed = observeCopy(staged, openPrivate, listing.liveness);
      if (observed === undefined) continue;
      return { ok: true, facts: observed };
    } catch {
      // The next attempt, or the final unverifiable verdict, owns this failure.
    }
  }
  return { ok: false };
}

interface StagedCopy {
  configPath: string;
  config: PreflightConfigFact;
  markerPath?: string;
  vaultAbsent: boolean;
  databasePath: string;
  staleFence: boolean;
  blocked: boolean;
}

function stageCopies(
  listing: InstalledHome,
  copyRoot: string,
  copyFile: (from: string, to: string) => void,
  readFile: (path: string) => Buffer,
  userHome: string,
): StagedCopy | undefined {
  const fences = readFences(listing);
  if (fences.blocked)
    return {
      configPath: "",
      config: { kind: "unverified" },
      vaultAbsent: false,
      databasePath: "",
      staleFence: false,
      blocked: true,
    };
  const configPath = join(listing.canonical, "config.yaml");
  const configText = readFile(configPath).toString("utf8");
  if (listing.observedConfig !== undefined && configText !== listing.observedConfig) {
    listing.linkMoved = true;
    return undefined;
  }
  const config = classifyConfig(configText, userHome, listing.canonical);
  if (config.kind !== "supported") {
    return {
      configPath: "",
      config,
      vaultAbsent: false,
      databasePath: "",
      staleFence: fences.stale,
      blocked: false,
    };
  }
  const loaded = loadConfiguration(configText, { userHome, sorageHome: listing.canonical });
  if (!loaded.ok)
    return {
      configPath: "",
      config: { kind: "invalid" },
      vaultAbsent: false,
      databasePath: "",
      staleFence: fences.stale,
      blocked: false,
    };
  const vaultDir = loaded.value.config.vault.path;
  const vaultRootBefore = rootBinding(vaultDir);
  if (listing.observedVault === "absent") {
    if (pathLook(vaultDir).kind !== "missing") {
      listing.linkMoved = true;
      return undefined;
    }
  } else if (listing.observedVault !== undefined && vaultRootBefore !== listing.observedVault) {
    listing.linkMoved = true;
    return undefined;
  }
  const privateConfig = join(copyRoot, "config.yaml");
  copyFile(configPath, privateConfig);
  const databasePath = join(copyRoot, "sorage.sqlite3");
  copyFile(listing.databasePath, databasePath);
  const wal = `${listing.databasePath}-wal`;
  const walLook = pathLook(wal);
  if (walLook.kind === "failed") return undefined;
  if (walLook.kind === "stat" && walLook.stat.isFile() && !walLook.stat.isSymbolicLink()) {
    copyFile(wal, `${databasePath}-wal`);
  }
  let markerPath: string | undefined;
  let vaultAbsent = listing.observedVault === "absent";
  if (!vaultAbsent) {
    const vaultCanonical = vaultRootBefore?.split("\n")[0];
    if (vaultCanonical === undefined || (!contained(listing.canonical, vaultDir) && !stableDirectory(vaultDir))) {
      return undefined;
    }
    const sourceMarker = join(vaultDir, ".sorage-vault.json");
    const markerLook = pathLook(sourceMarker);
    if (markerLook.kind === "failed") return undefined;
    if (markerLook.kind === "missing") {
      vaultAbsent = true;
    } else {
      const markerBefore = markerFile(sourceMarker, vaultCanonical);
      if (markerBefore === undefined) return undefined;
      const markerBytes = readFile(sourceMarker);
      markerPath = join(copyRoot, ".sorage-vault.json");
      copyFile(sourceMarker, markerPath);
      const markerAfter = markerFile(sourceMarker, vaultCanonical);
      if (markerAfter === undefined || markerAfter !== markerBefore || !readFile(sourceMarker).equals(markerBytes)) {
        listing.linkMoved = true;
        return undefined;
      }
    }
  }
  const fencesAfter = readFences(listing);
  if (fencesAfter.blocked || fencesAfter.stamp !== fences.stamp) return undefined;
  if (listing.observedVault === "absent") {
    if (pathLook(vaultDir).kind !== "missing") {
      listing.linkMoved = true;
      return undefined;
    }
  } else if (listing.observedVault !== undefined) {
    const vaultRootAfter = rootBinding(vaultDir);
    if (vaultRootBefore === undefined || vaultRootAfter === undefined || vaultRootAfter !== listing.observedVault) {
      listing.linkMoved = true;
      return undefined;
    }
  }
  return {
    configPath: privateConfig,
    config,
    ...(markerPath === undefined ? {} : { markerPath }),
    vaultAbsent,
    databasePath,
    staleFence: fences.stale || fencesAfter.stale,
    blocked: false,
  };
}

function observeCopy(
  staged: StagedCopy,
  openPrivate: (path: string) => PrivateDatabase,
  liveness: (pid: number) => PreflightLiveness,
): CaptureFacts | undefined {
  if (staged.blocked) return undefined;
  if (staged.config.kind !== "supported") {
    return {
      config: staged.config,
      database: { kind: "unverified" },
      integrity: { kind: "unverified" },
      vault: { kind: "unverified" },
      identity: { kind: "unverified" },
      staleFence: staged.staleFence,
    };
  }
  let configText: string;
  try {
    configText = readFileSync(staged.configPath, "utf8");
  } catch {
    return undefined;
  }
  const config = parseConfigurationFile(configText);
  if (!config.ok) return blankCapture({ kind: "invalid" }, staged.staleFence);
  let vaultText = "";
  let vault: PreflightVaultFact;
  if (staged.vaultAbsent) {
    vault = { kind: "absent" };
  } else if (staged.markerPath === undefined) {
    return undefined;
  } else {
    try {
      vaultText = readFileSync(staged.markerPath, "utf8");
    } catch {
      return undefined;
    }
    vault = classifyVault(vaultText);
  }
  const format = databaseFormat(staged.databasePath);
  if (format !== "sqlite") {
    return {
      config: { kind: "supported" },
      database: { kind: format },
      integrity: { kind: "unverified" },
      vault,
      identity: classifyIdentity(
        config.value.config.installationId,
        markerInstallationId(vaultText, vault),
        vault,
        format,
        undefined,
      ),
      staleFence: staged.staleFence,
    };
  }
  let db: PrivateDatabase | undefined;
  try {
    db = openPrivate(staged.databasePath);
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const integrity = readIntegrity(db);
    const database = classifyDatabase(db);
    const identity = classifyIdentity(
      config.value.config.installationId,
      markerInstallationId(vaultText, vault),
      vault,
      database.kind,
      db,
    );
    const moveFence =
      (database.kind === "current-ordered" || database.kind === "known-older-ordered") && hasMoveFenceColumn(db)
        ? databaseMoveFence(db, liveness)
        : "clear";
    if (moveFence === "blocked") return undefined;
    return {
      config: { kind: "supported" },
      database,
      integrity,
      vault,
      identity,
      staleFence: staged.staleFence || moveFence === "stale",
    };
  } catch {
    return {
      config: { kind: "supported" },
      database: { kind: "corrupt" },
      integrity: { kind: "unverified" },
      vault,
      identity: { kind: "unverified" },
      staleFence: staged.staleFence,
    };
  } finally {
    db?.close();
  }
}

function blankCapture(config: PreflightConfigFact, staleFence: boolean): CaptureFacts {
  return {
    config,
    database: { kind: "unverified" },
    integrity: { kind: "unverified" },
    vault: { kind: "unverified" },
    identity: { kind: "unverified" },
    staleFence,
  };
}

function classifyConfig(text: string, userHome: string, sorageHome: string): PreflightConfigFact {
  const document = parseDocument(text);
  if (document.errors.length > 0) return { kind: "invalid" };
  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    return { kind: "invalid" };
  }
  if (!isMapping(value)) return { kind: "unsupported-format" };
  if (!Object.hasOwn(value, "schemaVersion")) return { kind: "invalid" };
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion > 1)
    return { kind: "newer" };
  if (schemaVersion !== 1) return { kind: "invalid" };
  const loaded = loadConfiguration(text, { userHome, sorageHome });
  return loaded.ok ? { kind: "supported" } : { kind: "invalid" };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function classifyVault(text: string): PreflightVaultFact {
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

function classifyDatabase(db: PrivateDatabase): PreflightDatabaseFact {
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
  if (rows.some((row) => row.version > MIGRATIONS.length)) return { kind: "newer" };
  for (let index = 0; index < rows.length; index += 1) {
    const expected = MIGRATIONS[index];
    const row = rows[index];
    if (expected === undefined || row === undefined || row.version !== expected.version || row.name !== expected.name) {
      return { kind: "invalid-structure" };
    }
  }
  if (rows.length >= 5 && !hasMoveFenceColumn(db)) return { kind: "invalid-structure" };
  if (!catalogCovers(db, rows.length)) return { kind: "invalid-structure" };
  if (rows.length === MIGRATIONS.length) return { kind: "current-ordered" };
  if (rows.length === 0) return { kind: "invalid-structure" };
  return { kind: "known-older-ordered", preMemo: !rows.some((row) => row.name === "project-memos-v1") };
}

function readIntegrity(db: PrivateDatabase): PreflightIntegrityFact {
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
  const db = new Database(":memory:") as unknown as PrivateDatabase;
  try {
    migrate(db as unknown as SorageSqlite, MIGRATIONS.slice(0, prefix), () => "2026-01-01T00:00:00.000Z");
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

function markerInstallationId(text: string, vault: PreflightVaultFact): string | undefined {
  if (vault.kind !== "supported") return undefined;
  const parsed = JSON.parse(text) as { installationId?: string };
  return parsed.installationId;
}

function classifyIdentity(
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

function databaseMoveFence(
  db: PrivateDatabase,
  liveness: (pid: number) => PreflightLiveness,
): "clear" | "stale" | "blocked" {
  if (!hasMoveFenceColumn(db)) return "clear";
  const row = db.prepare("SELECT move_fence_pid FROM vault_state WHERE id = 1").get() as
    | { move_fence_pid?: number | null }
    | undefined;
  const pid = row?.move_fence_pid;
  if (pid === undefined || pid === null) return "clear";
  const verdict = liveness(pid);
  if (verdict === "alive" || verdict === "uncertain") return "blocked";
  return "stale";
}

function hasMoveFenceColumn(db: PrivateDatabase): boolean {
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

interface FenceRead {
  blocked: boolean;
  stale: boolean;
  stamp: string;
}

function readFences(listing: InstalledHome): FenceRead {
  const paths = [join(listing.canonical, "run", "vault-move.lock")];
  const migration = join(listing.canonical, "run", "migration.lock");
  const migrationLook = pathLook(migration);
  if (migrationLook.kind === "failed") return { blocked: true, stale: false, stamp: "unsafe" };
  if (migrationLook.kind === "stat" && migrationLook.stat.isFile() && !migrationLook.stat.isSymbolicLink()) {
    paths.push(migration);
  }
  let blocked = false;
  let stale = false;
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
    if (verdict === "blocked") blocked = true;
    if (verdict === "stale") stale = true;
  }
  return { blocked, stale, stamp: stamps.join("\n") };
}

function judgeLock(text: string, liveness: (pid: number) => PreflightLiveness): "clear" | "stale" | "blocked" {
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
  if (verdict === "alive" || verdict === "uncertain") return "blocked";
  return "stale";
}

function databaseFormat(path: string): "sqlite" | "corrupt" | "unsupported-format" {
  const bytes = readFileSync(path);
  const header = bytes.subarray(0, SQLITE_HEADER.length).toString("utf8");
  if (header !== SQLITE_HEADER) return "unsupported-format";
  if (bytes.length < 100) return "corrupt";
  return "sqlite";
}

function openPrivateCopy(path: string): PrivateDatabase {
  return new Database(path) as unknown as PrivateDatabase;
}

function probePid(pid: number, kill: (pid: number, signal: number) => void): PreflightLiveness {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    const coded = error as NodeJS.ErrnoException;
    if (coded.code === "EPERM" || coded.errno === osConstants.errno.EPERM) return "alive";
    if (coded.code === "ESRCH" || coded.errno === osConstants.errno.ESRCH) return "dead";
    return "uncertain";
  }
}

function unstableHome(): PreflightReport {
  return assessPreflight({
    home: { kind: "unreadable" },
    snapshot: { kind: "unavailable" },
    config: { kind: "unverified" },
    database: { kind: "unverified" },
    integrity: { kind: "unverified" },
    vault: { kind: "unverified" },
    identity: { kind: "unverified" },
  });
}

type HomeLocation =
  | { kind: "absent" | "unreadable" | "broken-link" | "non-directory" }
  | { kind: "directory"; canonical: string };

function locateHome(homePath: string): HomeLocation {
  const look = pathLook(homePath);
  if (look.kind === "missing") return { kind: "absent" };
  if (look.kind === "failed") return { kind: "unreadable" };
  const stat = look.stat;
  if (stat.isSymbolicLink()) {
    const canonical = pathTarget(homePath);
    if (canonical.kind === "missing") return { kind: "broken-link" };
    if (canonical.kind === "failed") return { kind: "unreadable" };
    const target = pathLook(canonical.path);
    if (target.kind !== "stat") return { kind: "unreadable" };
    if (!target.stat.isDirectory()) return { kind: "non-directory" };
    return { kind: "directory", canonical: canonical.path };
  }
  if (!stat.isDirectory()) return { kind: "non-directory" };
  try {
    readdirSync(homePath);
  } catch {
    return { kind: "unreadable" };
  }
  const canonical = pathTarget(homePath);
  if (canonical.kind !== "path") return { kind: "unreadable" };
  return { kind: "directory", canonical: canonical.path };
}

type HomeListing =
  | { kind: "empty" | "partial" | "unexplained" }
  | { kind: "residue"; entries: PreflightResidueEntry[] }
  | { kind: "unsafe"; home: "installed" }
  | InstalledHome;

interface InstalledHome {
  kind: "installed";
  /** The path the caller selected, which may be a directory alias. */
  requested: string;
  canonical: string;
  /** Canonical path and directory identity captured with the initial home observation. */
  homeBinding: string;
  /** Configuration bytes captured before scratch selection. Absent when that read failed. */
  observedConfig?: string;
  /** Canonical Vault path and directory identity, or `absent` when that directory is affirmatively missing. */
  observedVault?: string;
  /** Expanded Vault path from the observed configuration. */
  vaultPath?: string;
  databasePath: string;
  liveness: (pid: number) => PreflightLiveness;
  linkMoved: boolean;
}

function listHome(canonical: string): HomeListing {
  let names: string[];
  try {
    names = readdirSync(canonical);
  } catch {
    return { kind: "unsafe", home: "installed" };
  }
  if (names.length === 0) return { kind: "empty" };
  const entries: PreflightResidueEntry[] = [];
  let extra = false;
  let vaultAlias = false;
  for (const name of names) {
    const path = join(canonical, name);
    const entry = pathLook(path);
    if (entry.kind !== "stat") return { kind: "unsafe", home: "installed" };
    const stat = entry.stat;
    if (stat.isSymbolicLink()) {
      const target = pathTarget(path);
      if (target.kind !== "path") return { kind: "unsafe", home: "installed" };
      if (name === "vault") vaultAlias = true;
      else return { kind: "unsafe", home: "installed" };
    } else {
      if (!ROOT_INSTALL_NAMES.has(name)) extra = true;
      if ((name === "logs" || name === "state" || name === "run") && !stat.isDirectory()) extra = true;
      if (name === "config.yaml" && !stat.isFile()) extra = true;
      if (name === "vault") extra = true;
    }
    if (name === "state" && stat.isDirectory() && !stat.isSymbolicLink()) {
      const database = pathLook(join(canonical, "state", "sorage.sqlite3"));
      if (database.kind === "failed") return { kind: "unsafe", home: "installed" };
    }
    if ((name === "logs" || name === "state" || name === "run") && stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push({ kind: "directory", name });
      let children: string[] = [];
      try {
        children = readdirSync(path);
      } catch {
        return { kind: "unsafe", home: "installed" };
      }
      for (const child of children) {
        const childPath = join(path, child);
        const childLook = pathLook(childPath);
        if (childLook.kind !== "stat") return { kind: "unsafe", home: "installed" };
        const childStat = childLook.stat;
        if (childStat.isSymbolicLink()) {
          const target = pathTarget(childPath);
          if (target.kind !== "path" || !contained(canonical, target.path)) {
            return { kind: "unsafe", home: "installed" };
          }
        }
        if (name === "logs" && childStat.isFile() && !childStat.isSymbolicLink()) {
          entries.push({ kind: "logs-file", name: child });
        } else {
          entries.push({ kind: "unqualified", scope: name, name: child });
        }
      }
    }
  }
  const databasePath = join(canonical, "state", "sorage.sqlite3");
  const configPath = join(canonical, "config.yaml");
  const configLook = pathLook(configPath);
  const databaseLook = pathLook(databasePath);
  if (configLook.kind === "failed" || databaseLook.kind === "failed") return { kind: "unsafe", home: "installed" };
  const configStat = configLook.kind === "stat" ? configLook.stat : undefined;
  const databaseStat = databaseLook.kind === "stat" ? databaseLook.stat : undefined;
  if (configStat?.isSymbolicLink() || databaseStat?.isSymbolicLink()) return { kind: "unsafe", home: "installed" };
  const hasConfig = configStat?.isFile() === true;
  const hasDatabase = databaseStat?.isFile() === true;
  if (vaultAlias && (!hasConfig || !hasDatabase)) return { kind: "unsafe", home: "installed" };
  if (!hasConfig && !hasDatabase && !extra && permitted(entries)) return { kind: "residue", entries };
  if (!hasConfig && !hasDatabase) return { kind: "unexplained" };
  if (!hasConfig || !hasDatabase) return { kind: "partial" };
  return {
    kind: "installed",
    requested: canonical,
    canonical,
    homeBinding: "",
    databasePath,
    liveness: (pid) => probePid(pid, process.kill.bind(process)),
    linkMoved: false,
  };
}

function permitted(entries: PreflightResidueEntry[]): boolean {
  const seen = { logs: 0, state: 0, run: 0 };
  let logFiles = 0;
  for (const entry of entries) {
    if (entry.kind === "unqualified") return false;
    if (entry.kind === "logs-file") {
      if (!LOG_FILE_NAME.test(entry.name)) return false;
      logFiles += 1;
      continue;
    }
    seen[entry.name] += 1;
  }
  const present = seen.logs + seen.state + seen.run;
  if (present === 0 || seen.logs > 1 || seen.state > 1 || seen.run > 1) return false;
  return logFiles === 0 || seen.logs === 1;
}

function shallowFacts(listing: Exclude<HomeListing, InstalledHome | { kind: "unsafe" }>): PreflightFacts {
  const dormant = {
    snapshot: { kind: "not-applicable" } as const,
    config: { kind: "not-applicable" } as const,
    database: { kind: "not-applicable" } as const,
    integrity: { kind: "not-applicable" } as const,
    vault: { kind: "not-applicable" } as const,
    identity: { kind: "not-applicable" } as const,
  };
  if (listing.kind === "residue") return { home: { kind: "residue", entries: listing.entries }, ...dormant };
  return { home: { kind: listing.kind }, ...dormant };
}

function closedFacts(kind: "absent" | "unreadable" | "broken-link" | "non-directory"): PreflightFacts {
  const downstream = kind === "absent" ? "not-applicable" : "unverified";
  return {
    home: { kind },
    snapshot: { kind: kind === "absent" ? "not-applicable" : "unavailable" },
    config: { kind: downstream },
    database: { kind: downstream },
    integrity: { kind: downstream },
    vault: { kind: downstream },
    identity: { kind: downstream },
  };
}

function uncertain(home: "installed"): PreflightReport {
  return assessPreflight({
    home: { kind: home },
    snapshot: { kind: "unavailable" },
    config: { kind: "unverified" },
    database: { kind: "unverified" },
    integrity: { kind: "unverified" },
    vault: { kind: "unverified" },
    identity: { kind: "unverified" },
  });
}

function managedShape(listing: InstalledHome): string | undefined {
  const home = listing.canonical;
  const rows: string[] = [];
  const homeRecord = directoryRecord(home, home);
  if (homeRecord === undefined || homeRecord === "missing") return undefined;
  rows.push(`home ${homeRecord}`);
  for (const name of ["logs", "state", "run"]) {
    const record = directoryRecord(join(home, name), home);
    if (record === undefined) return undefined;
    rows.push(`${name} ${record}`);
  }
  const files: Array<[string, string, boolean]> = [
    ["config", join(home, "config.yaml"), true],
    ["database", listing.databasePath, true],
    ["wal", `${listing.databasePath}-wal`, false],
    ["shm", `${listing.databasePath}-shm`, false],
    ["vault-move", join(home, "run", "vault-move.lock"), false],
    ["migration", join(home, "run", "migration.lock"), false],
  ];
  for (const [label, path, required] of files) {
    const record = fileShape(path, home, required);
    if (record === undefined) return undefined;
    rows.push(`${label} ${record}`);
  }
  const alias = configuredVaultAlias(listing);
  if (alias === undefined) return undefined;
  rows.push(`vault-alias ${alias}`);
  if (listing.observedVault === "absent") {
    if (listing.vaultPath === undefined || pathLook(listing.vaultPath).kind !== "missing") return undefined;
    rows.push("vault absent");
  } else if (listing.observedVault !== undefined) {
    const vaultPath = listing.observedVault.split("\n")[0];
    if (vaultPath === undefined || vaultPath === "" || rootBinding(vaultPath) !== listing.observedVault) {
      return undefined;
    }
    const vault = directoryRecord(vaultPath, vaultPath);
    if (vault === undefined || vault === "missing") return undefined;
    rows.push(`vault ${vault}`);
    const markerPath = join(listing.vaultPath ?? vaultPath, ".sorage-vault.json");
    const markerLook = pathLook(markerPath);
    if (markerLook.kind === "failed") return undefined;
    if (markerLook.kind === "missing") rows.push("marker absent");
    else {
      const marker = markerFile(markerPath, vaultPath);
      if (marker === undefined) return undefined;
      rows.push(`marker ${marker}`);
    }
  }
  return rows.join("\n");
}

function configuredVaultAlias(listing: InstalledHome): string | undefined {
  const homeVault = join(listing.canonical, "vault");
  const look = pathLook(homeVault);
  if (look.kind === "missing") return "missing";
  if (look.kind !== "stat") return undefined;
  if (!look.stat.isSymbolicLink()) return "direct";
  const binding = rootBinding(homeVault);
  if (binding === undefined) return undefined;
  const target = binding.split("\n")[0] ?? "";
  if (contained(listing.canonical, target)) return `inside ${binding}`;
  if (binding !== listing.observedVault) return undefined;
  return `alias ${binding}`;
}

function directoryRecord(path: string, root: string): string | undefined {
  const look = pathLook(path);
  if (look.kind === "missing") return "missing";
  if (look.kind !== "stat" || look.stat.isSymbolicLink() || !look.stat.isDirectory()) return undefined;
  const target = pathTarget(path);
  if (target.kind !== "path" || !contained(root, target.path)) return undefined;
  let names: string[];
  try {
    names = readdirSync(target.path).sort();
  } catch {
    return undefined;
  }
  return `${target.path} ${look.stat.dev}:${look.stat.ino} ${look.stat.mode} ${look.stat.mtimeMs} ${names.join("\0")}`;
}

function fileShape(path: string, root: string, required: boolean): string | undefined {
  const look = pathLook(path);
  if (look.kind === "missing") return required ? undefined : "missing";
  if (look.kind !== "stat" || look.stat.isSymbolicLink() || !look.stat.isFile()) return undefined;
  const target = pathTarget(path);
  if (target.kind !== "path" || !contained(root, target.path)) return undefined;
  return `${target.path} ${look.stat.dev}:${look.stat.ino} ${look.stat.mode}`;
}

function markerFile(path: string, vaultRoot: string): string | undefined {
  const shape = fileShape(path, vaultRoot, true);
  if (shape === undefined) return undefined;
  try {
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const look = pathLook(path);
    if (look.kind !== "stat") return undefined;
    return `${shape} ${look.stat.mtimeMs} ${hash}`;
  } catch {
    return undefined;
  }
}

function fingerprint(listing: InstalledHome): string | undefined {
  const files = [
    join(listing.canonical, "config.yaml"),
    listing.databasePath,
    `${listing.databasePath}-wal`,
    `${listing.databasePath}-shm`,
    join(listing.canonical, "run", "vault-move.lock"),
    join(listing.canonical, "run", "migration.lock"),
  ];
  if (listing.vaultPath !== undefined) files.push(join(listing.vaultPath, ".sorage-vault.json"));
  const rows: string[] = [];
  for (const path of files) {
    const look = pathLook(path);
    if (look.kind === "failed") return undefined;
    if (look.kind === "missing") {
      rows.push(`${path}:missing`);
      continue;
    }
    const stat = look.stat;
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    let hash: string;
    try {
      hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return undefined;
    }
    rows.push(`${path}:${stat.ino}:${stat.mode}:${stat.mtimeMs}:${hash}`);
  }
  return rows.join("\n");
}

function canonicalIdentity(path: string): string | undefined {
  const stat = tryStat(path);
  return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
}

function rootBinding(path: string): string | undefined {
  const resolved = tryRealpath(path);
  if (resolved === undefined) return undefined;
  const identity = canonicalIdentity(resolved);
  return identity === undefined ? undefined : `${resolved}\n${identity}`;
}

function observationHolds(listing: InstalledHome, userHome: string): boolean {
  if (rootBinding(listing.requested) !== listing.homeBinding) return false;
  let text: string | undefined;
  try {
    text = readFileSync(join(listing.canonical, "config.yaml"), "utf8");
  } catch {
    text = undefined;
  }
  if (text !== listing.observedConfig) return false;
  if (listing.observedVault === undefined) return true;
  if (text === undefined || listing.vaultPath === undefined) return false;
  const loaded = loadConfiguration(text, { userHome, sorageHome: listing.canonical });
  if (!loaded.ok || loaded.value.config.vault.path !== listing.vaultPath) return false;
  if (listing.observedVault === "absent") return pathLook(listing.vaultPath).kind === "missing";
  return rootBinding(listing.vaultPath) === listing.observedVault;
}

function contained(parent: string, candidate: string): boolean {
  const root = tryRealpath(parent) ?? parent;
  const target = tryRealpath(candidate) ?? candidate;
  const from = relative(root, target);
  return from === "" || (!from.startsWith(`..${sep}`) && from !== ".." && !isAbsolute(from));
}

function stableDirectory(path: string): boolean {
  const stat = tryStat(path);
  return stat?.isDirectory() === true;
}

function scratchParent(roots: string[], preferred?: string): string | undefined {
  const candidates: string[] = [];
  if (preferred !== undefined) candidates.push(preferred);
  let current = tmpdir();
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(current);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  candidates.push("/tmp");
  for (const candidate of candidates) {
    const parent = outsideRoots(candidate, roots);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

function outsideRoots(candidate: string, roots: string[]): string | undefined {
  const resolved = tryRealpath(candidate) ?? candidate;
  if (tryStat(resolved)?.isDirectory() !== true) return undefined;
  if (roots.some((root) => resolved === root || contained(root, resolved))) return undefined;
  try {
    accessSync(resolved, fsConstants.W_OK);
  } catch {
    return undefined;
  }
  return resolved;
}

interface StatLook {
  kind: "stat";
  stat: NonNullable<ReturnType<typeof lstatSync>>;
}

type PathLook = StatLook | { kind: "missing" } | { kind: "failed" };

function pathLook(path: string): PathLook {
  try {
    const stat = lstatSync(path);
    return stat === undefined ? { kind: "failed" } : { kind: "stat", stat };
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "failed" };
  }
}

function pathTarget(path: string): { kind: "path"; path: string } | { kind: "missing" } | { kind: "failed" } {
  try {
    return { kind: "path", path: realpathSync(path) };
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "failed" };
  }
}

function errnoCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
}

function tryStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
