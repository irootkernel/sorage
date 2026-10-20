import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { isMap, parseDocument } from "yaml";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knownSchemaMaximum, preflightExitCode } from "@sorage/core";
import { CAPTURE_ATTEMPTS, inspectPreflight } from "../../src/preflight";
import { MIGRATIONS, productionMigrationPlan } from "../../src/sqlite/migrations";
import type { SorageSqlite } from "../../src/sqlite/connection";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempHome } from "../../src/testkit/temp-home";

const fsControl = vi.hoisted(() => ({
  denyConfigReads: false,
  failAttemptMkdir: false,
  configReadAttempts: 0,
  attemptMkdirs: 0,
  mkdtempCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (fsControl.denyConfigReads && String(path).endsWith("config.yaml")) {
        fsControl.configReadAttempts += 1;
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return actual.readFileSync(path, ...(rest as never[]));
    }) as typeof actual.readFileSync,
    mkdirSync: ((path: Parameters<typeof actual.mkdirSync>[0], ...rest: unknown[]) => {
      if (fsControl.failAttemptMkdir && String(path).includes("/attempt-")) {
        fsControl.attemptMkdirs += 1;
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.mkdirSync(path, ...(rest as never[]));
    }) as typeof actual.mkdirSync,
    mkdtempSync: ((prefix: Parameters<typeof actual.mkdtempSync>[0], ...rest: unknown[]) => {
      fsControl.mkdtempCalls += 1;
      return actual.mkdtempSync(prefix, ...(rest as never[]));
    }) as typeof actual.mkdtempSync,
  };
});

const INSTALLATION = "9d57384c-030e-4ff7-90ca-c615d8043db2";
const OTHER = "1f0ac9a0-0000-4000-8000-00000000000b";
const example = readFileSync(new URL("../../../../docs/specs/examples/config.example.yaml", import.meta.url), "utf8");
const homes: string[] = [];

afterEach(() => {
  fsControl.denyConfigReads = false;
  fsControl.failAttemptMkdir = false;
  fsControl.configReadAttempts = 0;
  fsControl.attemptMkdirs = 0;
  fsControl.mkdtempCalls = 0;
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = makeTempHome("sorage-preflight-").home;
  homes.push(home);
  return home;
}

function configText(id = INSTALLATION): string {
  return example.replaceAll("9d57384c-030e-4ff7-90ca-c615d8043db2", id);
}

function marker(id = INSTALLATION): string {
  return `${JSON.stringify({
    type: "sorage-vault",
    schemaVersion: 1,
    installationId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  })}\n`;
}

function writeCurrent(
  home: string,
  options: { through?: number; installationRow?: boolean; bindingId?: string } = {},
): void {
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "vault"), { recursive: true });
  mkdirSync(join(home, "logs"), { recursive: true });
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), configText());
  writeFileSync(join(home, "vault", ".sorage-vault.json"), marker());
  const databasePath = join(home, "state", "sorage.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  // The current installation is schema 9: without an explicit legacy `through`,
  // the fixture migrates through the real production plan so the guarded
  // Handoff rebuild runs on its dedicated file-backed connection exactly as in
  // production. An explicit `through` keeps building truthful legacy prefixes
  // of the ordinary catalog for the upgrade-required classifications.
  const through = options.through ?? MIGRATIONS.length;
  if (options.through === undefined) {
    const plan = productionMigrationPlan();
    migrate(db as unknown as SorageSqlite, plan.migrations, () => "2026-01-01T00:00:00.000Z", {
      databasePath,
      rebuilds: plan.rebuilds,
    });
  } else {
    migrate(db as unknown as SorageSqlite, MIGRATIONS.slice(0, through), () => "2026-01-01T00:00:00.000Z");
  }
  if (options.installationRow !== false && through >= 1) {
    db.prepare("INSERT INTO installation (id, installation_id, schema_version, created_at) VALUES (1, ?, 1, ?)").run(
      INSTALLATION,
      "2026-01-01T00:00:00.000Z",
    );
  }
  if (options.bindingId !== undefined && through >= 2) {
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES ('p1', 'demo', 'Demo', 'active', ?, ?)",
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b1', 'p1', ?, '/tmp/demo', 'directory', ?, ?)",
    ).run(options.bindingId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  }
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  db.close();
}

function inventory(root: string): string[] {
  const rootStat = lstatSync(root);
  const rows = [`@ ${rootStat.mode} ${rootStat.mtimeMs} ${rootStat.dev}:${rootStat.ino}`];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (stat.isSymbolicLink()) {
        rows.push(`l ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino} ${readlinkSync(path)}`);
      } else if (stat.isDirectory()) {
        rows.push(`d ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino}`);
        walk(path);
      } else {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
        rows.push(`f ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino} ${hash}`);
      }
    }
  };
  walk(root);
  return rows.sort();
}

function expectUntouched(home: string, before: string[]): void {
  expect(inventory(home)).toEqual(before);
}

describe("installation preflight inspection", () => {
  it("copies a committed WAL into the private snapshot and leaves the source untouched", () => {
    const home = tempHome();
    writeCurrent(home, { bindingId: INSTALLATION });
    const held = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    held.exec("CREATE TABLE wal_probe (id INTEGER)");
    held.exec("INSERT INTO wal_probe (id) VALUES (1)");
    const wal = join(home, "state", "sorage.sqlite3-wal");
    expect(lstatSync(wal).size).toBeGreaterThan(0);
    const before = inventory(home);
    const copied: string[] = [];
    const report = inspectPreflight(home, {
      copyFile(from, to) {
        copied.push(from);
        copyFileSync(from, to);
      },
    });
    expect(report.status).toBe("compatible");
    expect(report.contractVersion).toBe(1);
    expect(copied.some((path) => path.endsWith("sorage.sqlite3-wal"))).toBe(true);
    expectUntouched(home, before);
    held.close();
  });

  it("classifies absent, empty, and permitted residue as fresh, and partial or unexplained inventory as recovery", () => {
    const absent = join(tempHome(), "missing");
    expect(inspectPreflight(absent).status).toBe("fresh");
    expect(existsSync(absent)).toBe(false);

    const empty = tempHome();
    expect(inspectPreflight(empty).status).toBe("fresh");

    const residue = tempHome();
    mkdirSync(join(residue, "logs"));
    writeFileSync(join(residue, "logs", "sorage.log"), "native failure\n");
    writeFileSync(join(residue, "logs", "sorage.log.1"), "rotated\n");
    const residueBefore = inventory(residue);
    const residueReport = inspectPreflight(residue);
    expect(residueReport.status).toBe("fresh");
    expect(residueReport.checks[0]?.severity).toBe("warning");
    expectUntouched(residue, residueBefore);

    const partial = tempHome();
    mkdirSync(join(partial, "state"), { recursive: true });
    writeFileSync(join(partial, "state", "sorage.sqlite3"), "placeholder");
    expect(inspectPreflight(partial).status).toBe("recovery_required");

    const unexplained = tempHome();
    writeFileSync(join(unexplained, "sorage.log"), "root lookalike\n");
    expect(inspectPreflight(unexplained).status).toBe("recovery_required");
  });

  it("accepts a current empty installation and a populated one", () => {
    const empty = tempHome();
    writeCurrent(empty, { installationRow: false });
    expect(inspectPreflight(empty).status).toBe("compatible");

    const populated = tempHome();
    writeCurrent(populated, { bindingId: INSTALLATION });
    const before = inventory(populated);
    expect(inspectPreflight(populated).status).toBe("compatible");
    expectUntouched(populated, before);
  });

  it("reports a valid pre-Memo prefix as upgrade_required and does not treat weak history as compatible", () => {
    const older = tempHome();
    writeCurrent(older, { through: 6 });
    const olderReport = inspectPreflight(older);
    expect(olderReport.status).toBe("upgrade_required");
    expect(olderReport.checks.find((check) => check.id === "upgrade.preparation")?.message).toContain(
      "separately from preparation",
    );

    const hole = tempHome();
    writeCurrent(hole);
    const holeDb = new DatabaseSync(join(hole, "state", "sorage.sqlite3"));
    holeDb.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    holeDb.close();
    expect(inspectPreflight(hole).status).toBe("recovery_required");

    const wrongName = tempHome();
    writeCurrent(wrongName);
    const wrongDb = new DatabaseSync(join(wrongName, "state", "sorage.sqlite3"));
    wrongDb.prepare("UPDATE schema_migrations SET name = 'wrong' WHERE version = 1").run();
    wrongDb.close();
    expect(inspectPreflight(wrongName).status).toBe("recovery_required");

    const structure = tempHome();
    writeCurrent(structure);
    const structureDb = new DatabaseSync(join(structure, "state", "sorage.sqlite3"));
    structureDb.exec("DROP TABLE handoffs");
    structureDb.close();
    expect(inspectPreflight(structure).status).toBe("recovery_required");

    const corrupt = tempHome();
    writeCurrent(corrupt);
    writeFileSync(
      join(corrupt, "state", "sorage.sqlite3"),
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(16)]),
    );
    expect(inspectPreflight(corrupt).checks.find((check) => check.id === "db.schema")?.message).toContain("corrupt");

    const newer = tempHome();
    writeCurrent(newer);
    const newerDb = new DatabaseSync(join(newer, "state", "sorage.sqlite3"));
    newerDb
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', ?)")
      .run(knownSchemaMaximum() + 1, "2026-01-01T00:00:00.000Z");
    newerDb.close();
    const newerReport = inspectPreflight(newer);
    expect(newerReport.status).toBe("unsupported");
    expect(newerReport.checks.find((check) => check.id === "db.schema")?.message).toContain("newer");

    const format = tempHome();
    writeCurrent(format);
    writeFileSync(join(format, "state", "sorage.sqlite3"), "OTHER-FORMAT\n");
    const formatReport = inspectPreflight(format);
    expect(formatReport.status).toBe("unsupported");
    expect(formatReport.checks.find((check) => check.id === "db.schema")?.message).not.toContain("newer");

    const maximum = tempHome();
    writeCurrent(maximum);
    const maximumDb = new DatabaseSync(join(maximum, "state", "sorage.sqlite3"));
    maximumDb.exec("DROP TABLE schema_migrations");
    maximumDb.exec("PRAGMA user_version = 7");
    maximumDb.close();
    expect(inspectPreflight(maximum).status).not.toBe("compatible");
    expect(inspectPreflight(maximum).status).not.toBe("upgrade_required");

    const memo = tempHome();
    writeCurrent(memo);
    const memoDb = new DatabaseSync(join(memo, "state", "sorage.sqlite3"));
    memoDb.exec("DROP TABLE schema_migrations");
    memoDb.close();
    expect(inspectPreflight(memo).status).not.toBe("compatible");
    expect(inspectPreflight(memo).status).not.toBe("upgrade_required");
  });

  it("reports an installation identity or binding mismatch", () => {
    const home = tempHome();
    writeCurrent(home, { bindingId: OTHER });
    const report = inspectPreflight(home);
    expect(report.status).toBe("recovery_required");
    expect(report.checks.find((check) => check.id === "installation.identity")?.message).toContain("does not agree");
  });

  it("fails closed for permission denial, linked managed files, escaping links, and a broken root", () => {
    const denied = tempHome();
    writeCurrent(denied);
    const beforeDenied = inventory(denied);
    chmodSync(join(denied, "config.yaml"), 0o000);
    try {
      expect(inspectPreflight(denied).status).toBe("unverifiable");
      chmodSync(join(denied, "config.yaml"), 0o644);
      expectUntouched(denied, beforeDenied);
    } finally {
      chmodSync(join(denied, "config.yaml"), 0o644);
    }

    const linked = tempHome();
    writeCurrent(linked);
    const realConfig = join(linked, "config.yaml");
    const moved = join(linked, "config-real.yaml");
    copyFileSync(realConfig, moved);
    rmSync(realConfig);
    symlinkSync(moved, realConfig);
    expect(inspectPreflight(linked).status).toBe("unverifiable");

    const escaping = tempHome();
    writeCurrent(escaping);
    symlinkSync("/etc/passwd", join(escaping, "state", "leak"));
    expect(inspectPreflight(escaping).status).toBe("unverifiable");

    const real = tempHome();
    writeCurrent(real, { bindingId: INSTALLATION });
    const alias = join(tmpdir(), `sorage-preflight-alias-${process.pid}`);
    symlinkSync(real, alias);
    homes.push(alias);
    expect(inspectPreflight(alias).status).toBe("compatible");

    const brokenParent = tempHome();
    const broken = join(brokenParent, "missing-target");
    symlinkSync(join(brokenParent, "no-such-dir"), broken);
    const brokenReport = inspectPreflight(broken);
    expect(brokenReport.status).toBe("unverifiable");
    expect(brokenReport.checks[0]?.message).toContain("not fresh");
  });

  it("honors live, stale, uncertain, and changing file fences without removing them", () => {
    const live = tempHome();
    writeCurrent(live);
    const liveLock = join(live, "run", "vault-move.lock");
    writeFileSync(
      liveLock,
      JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" }),
    );
    const liveBefore = inventory(live);
    expect(inspectPreflight(live).status).toBe("unverifiable");
    expectUntouched(live, liveBefore);

    const stale = tempHome();
    writeCurrent(stale);
    const staleLock = join(stale, "run", "vault-move.lock");
    const staleBody = JSON.stringify({
      pid: 999_999_999,
      startedAt: "2026-01-01T00:00:00.000Z",
      hostname: "test",
    });
    writeFileSync(staleLock, staleBody);
    const staleReport = inspectPreflight(stale);
    expect(staleReport.status).toBe("compatible");
    expect(staleReport.checks.find((check) => check.id === "source.snapshot")?.message).toContain("left untouched");
    expect(readFileSync(staleLock, "utf8")).toBe(staleBody);

    const uncertain = tempHome();
    writeCurrent(uncertain);
    writeFileSync(
      join(uncertain, "run", "vault-move.lock"),
      JSON.stringify({ pid: 50, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" }),
    );
    expect(inspectPreflight(uncertain, { liveness: () => "uncertain" }).status).toBe("unverifiable");

    const changing = tempHome();
    writeCurrent(changing);
    const changingLock = join(changing, "run", "vault-move.lock");
    writeFileSync(
      changingLock,
      JSON.stringify({ pid: 999_999_999, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" }),
    );
    expect(
      inspectPreflight(changing, {
        copyFile(from, to) {
          copyFileSync(from, to);
          writeFileSync(changingLock, '{"pid":999999999,"startedAt":"2026-01-02T00:00:00.000Z","hostname":"test"}');
        },
      }).status,
    ).toBe("unverifiable");
  });

  it("treats a database move fence as live or stale only when the schema has the table, and ignores migration_lock", () => {
    const live = tempHome();
    writeCurrent(live);
    const liveDb = new DatabaseSync(join(live, "state", "sorage.sqlite3"));
    liveDb
      .prepare("INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?)")
      .run(process.pid, "2026-01-01T00:00:00.000Z");
    liveDb.close();
    const liveBefore = inventory(live);
    expect(inspectPreflight(live).status).toBe("unverifiable");
    expectUntouched(live, liveBefore);

    const stale = tempHome();
    writeCurrent(stale);
    const staleDb = new DatabaseSync(join(stale, "state", "sorage.sqlite3"));
    staleDb
      .prepare("INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?)")
      .run(999_999_999, "2026-01-01T00:00:00.000Z");
    staleDb.close();
    const staleReport = inspectPreflight(stale);
    expect(staleReport.checks.find((check) => check.id === "source.snapshot")?.message).toContain("left untouched");
    const reread = new DatabaseSync(join(stale, "state", "sorage.sqlite3"));
    expect(
      (reread.prepare("SELECT move_fence_pid FROM vault_state WHERE id = 1").get() as { move_fence_pid: number })
        .move_fence_pid,
    ).toBe(999_999_999);
    reread.close();

    const legacy = tempHome();
    writeCurrent(legacy);
    writeFileSync(
      join(legacy, "run", "migration.lock"),
      JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" }),
    );
    expect(inspectPreflight(legacy).status).toBe("unverifiable");

    const legacyStale = tempHome();
    writeCurrent(legacyStale);
    writeFileSync(
      join(legacyStale, "run", "migration.lock"),
      JSON.stringify({ pid: 999_999_999, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" }),
    );
    expect(inspectPreflight(legacyStale).status).toBe("compatible");

    const rowOnly = tempHome();
    writeCurrent(rowOnly);
    const rowDb = new DatabaseSync(join(rowOnly, "state", "sorage.sqlite3"));
    rowDb.exec("INSERT OR IGNORE INTO migration_lock (id) VALUES (1)");
    rowDb.close();
    expect(inspectPreflight(rowOnly).status).toBe("compatible");
  });

  it("fails closed when a writer changes the source, without charging that write to the inspector", () => {
    const home = tempHome();
    writeCurrent(home);
    const configBefore = readFileSync(join(home, "config.yaml"));
    const report = inspectPreflight(home, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (from.endsWith(`${sep}sorage.sqlite3`)) {
          writeFileSync(from, Buffer.concat([readFileSync(from), Buffer.from("writer")]));
        }
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(readFileSync(join(home, "config.yaml"))).toEqual(configBefore);
  });

  it("removes its scratch directory after copy, read, parse, and SQLite failures", () => {
    const parent = mkdtempSync(join(tmpdir(), "sorage-preflight-scratch-"));
    homes.push(parent);
    const home = tempHome();
    writeCurrent(home);

    inspectPreflight(home, {
      scratchParent: parent,
      copyFile() {
        throw new Error("copy failed");
      },
    });
    expect(readdirSync(parent)).toEqual([]);

    let reads = 0;
    inspectPreflight(home, {
      scratchParent: parent,
      readFile(path) {
        reads += 1;
        if (reads > 1) throw new Error("read failed");
        return readFileSync(path);
      },
    });
    expect(reads).toBeGreaterThan(1);
    expect(readdirSync(parent)).toEqual([]);

    writeFileSync(join(home, "vault", ".sorage-vault.json"), "{");
    inspectPreflight(home, { scratchParent: parent });
    expect(readdirSync(parent)).toEqual([]);

    writeFileSync(join(home, "vault", ".sorage-vault.json"), marker());
    const beforeSqlite = inventory(home);
    let opened = 0;
    const sqliteReport = inspectPreflight(home, {
      scratchParent: parent,
      openPrivateDatabase() {
        opened += 1;
        throw new Error("sqlite failed");
      },
    });
    expect(sqliteReport.status).toBe("unverifiable");
    expect(preflightExitCode(sqliteReport.status)).toBe(75);
    expect(sqliteReport.checks.find((check) => check.id === "source.snapshot")?.message).toBe(
      "A coherent snapshot was not available.",
    );
    expect(opened).toBe(CAPTURE_ATTEMPTS);
    expectUntouched(home, beforeSqlite);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("returns unverifiable before any scratch allocation when the native configuration read stays denied", () => {
    const owner = tempHome();
    const vaultRoot = join(owner, "external-vault");
    const scratchInside = join(vaultRoot, "scratch-parent");
    mkdirSync(scratchInside, { recursive: true });
    writeFileSync(join(vaultRoot, ".sorage-vault.json"), marker());
    const home = tempHome();
    writeCurrent(home);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vaultRoot)}`));
    const homeBefore = inventory(home);
    const vaultBefore = inventory(vaultRoot);
    const scratchBefore = inventory(scratchInside);
    const scratchMtime = lstatSync(scratchInside).mtimeMs;
    const scratchIno = lstatSync(scratchInside).ino;
    fsControl.denyConfigReads = true;
    expect(() => readFileSync(configPath, "utf8")).toThrow(/EACCES/);
    fsControl.configReadAttempts = 0;
    fsControl.mkdtempCalls = 0;
    const report = inspectPreflight(home, { scratchParent: scratchInside });
    expect(fsControl.configReadAttempts).toBe(1);
    expect(() => readFileSync(configPath, "utf8")).toThrow(/EACCES/);
    expect(fsControl.mkdtempCalls).toBe(0);
    fsControl.denyConfigReads = false;
    expect(report.status).toBe("unverifiable");
    expect(preflightExitCode(report.status)).toBe(75);
    expect(report.checks.find((check) => check.id === "source.snapshot")?.message).toBe(
      "A coherent snapshot was not available.",
    );
    expect(readFileSync(configPath, "utf8")).toContain(vaultRoot);
    expectUntouched(home, homeBefore);
    expect(inventory(vaultRoot)).toEqual(vaultBefore);
    expect(inventory(scratchInside)).toEqual(scratchBefore);
    expect(lstatSync(scratchInside).mtimeMs).toBe(scratchMtime);
    expect(lstatSync(scratchInside).ino).toBe(scratchIno);
  });

  it("returns unverifiable when a private attempt directory cannot be created", () => {
    const parent = mkdtempSync(join(tmpdir(), "sorage-preflight-attempt-"));
    homes.push(parent);
    const home = tempHome();
    writeCurrent(home);
    const before = inventory(home);
    fsControl.failAttemptMkdir = true;
    fsControl.attemptMkdirs = 0;
    const report = inspectPreflight(home, { scratchParent: parent });
    fsControl.failAttemptMkdir = false;
    expect(report.status).toBe("unverifiable");
    expect(preflightExitCode(report.status)).toBe(75);
    expect(report.checks.find((check) => check.id === "source.snapshot")?.message).toBe(
      "A coherent snapshot was not available.",
    );
    expect(fsControl.attemptMkdirs).toBe(CAPTURE_ATTEMPTS);
    expectUntouched(home, before);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("keeps conclusive private SQLite corruption and fails closed on environmental private SQLite errors", () => {
    const parent = mkdtempSync(join(tmpdir(), "sorage-preflight-sqlite-"));
    homes.push(parent);
    const bunSqlite = (code: "SQLITE_CANTOPEN" | "SQLITE_CORRUPT" | "SQLITE_NOTADB", errno: number): Error =>
      Object.assign(new Error(code), { code, errno });

    const cantOpen = tempHome();
    writeCurrent(cantOpen);
    const cantOpenBefore = inventory(cantOpen);
    let cantOpenAttempts = 0;
    const cantOpenReport = inspectPreflight(cantOpen, {
      scratchParent: parent,
      openPrivateDatabase() {
        cantOpenAttempts += 1;
        throw bunSqlite("SQLITE_CANTOPEN", 14);
      },
    });
    expect(cantOpenReport.status).toBe("unverifiable");
    expect(preflightExitCode(cantOpenReport.status)).toBe(75);
    expect(cantOpenReport.checks.find((check) => check.id === "source.snapshot")?.message).toBe(
      "A coherent snapshot was not available.",
    );
    expect(cantOpenReport.checks.find((check) => check.id === "db.schema")?.message).not.toContain("corrupt");
    expect(cantOpenAttempts).toBe(CAPTURE_ATTEMPTS);
    expectUntouched(cantOpen, cantOpenBefore);
    expect(readdirSync(parent)).toEqual([]);

    const postOpen = tempHome();
    writeCurrent(postOpen);
    const postOpenBefore = inventory(postOpen);
    let postOpenAttempts = 0;
    const postOpenReport = inspectPreflight(postOpen, {
      scratchParent: parent,
      openPrivateDatabase(path) {
        postOpenAttempts += 1;
        const db = new DatabaseSync(path);
        return {
          exec(sql: string) {
            if (sql.includes("wal_checkpoint")) throw new Error("checkpoint unavailable");
            db.exec(sql);
          },
          prepare(sql: string) {
            return db.prepare(sql);
          },
          close() {
            db.close();
          },
        } as never;
      },
    });
    expect(postOpenReport.status).toBe("unverifiable");
    expect(preflightExitCode(postOpenReport.status)).toBe(75);
    expect(postOpenReport.checks.find((check) => check.id === "source.snapshot")?.message).toBe(
      "A coherent snapshot was not available.",
    );
    expect(postOpenAttempts).toBe(CAPTURE_ATTEMPTS);
    expectUntouched(postOpen, postOpenBefore);
    expect(readdirSync(parent)).toEqual([]);

    for (const failure of [bunSqlite("SQLITE_CORRUPT", 11), bunSqlite("SQLITE_NOTADB", 26)] as const) {
      const home = tempHome();
      writeCurrent(home);
      const before = inventory(home);
      let attempts = 0;
      const report = inspectPreflight(home, {
        scratchParent: parent,
        openPrivateDatabase() {
          attempts += 1;
          throw failure;
        },
      });
      expect(report.status).toBe("recovery_required");
      expect(preflightExitCode(report.status)).toBe(78);
      expect(report.checks.find((check) => check.id === "source.snapshot")?.message).toBe(
        "The observed source snapshot is coherent.",
      );
      expect(report.checks.find((check) => check.id === "db.schema")?.message).toContain("corrupt");
      expect(attempts).toBe(1);
      expectUntouched(home, before);
      expect(readdirSync(parent)).toEqual([]);
    }
  });

  it("selects scratch outside an external Vault path that contains a newline", () => {
    const owner = tempHome();
    const vaultRoot = join(owner, "vault\nactual");
    const scratchInside = join(vaultRoot, "scratch-parent");
    mkdirSync(scratchInside, { recursive: true });
    writeFileSync(join(vaultRoot, ".sorage-vault.json"), marker());
    const home = tempHome();
    writeCurrent(home);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    writeFileSync(
      join(home, "config.yaml"),
      configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vaultRoot)}`),
    );
    const homeBefore = inventory(home);
    const vaultBefore = inventory(vaultRoot);
    const scratchBefore = inventory(scratchInside);
    const vaultMtime = lstatSync(vaultRoot).mtimeMs;
    const scratchMtime = lstatSync(scratchInside).mtimeMs;
    const report = inspectPreflight(home, { scratchParent: scratchInside });
    expect(report.status).toBe("compatible");
    expect(preflightExitCode(report.status)).toBe(0);
    expectUntouched(home, homeBefore);
    expect(inventory(vaultRoot)).toEqual(vaultBefore);
    expect(inventory(scratchInside)).toEqual(scratchBefore);
    expect(lstatSync(vaultRoot).mtimeMs).toBe(vaultMtime);
    expect(lstatSync(scratchInside).mtimeMs).toBe(scratchMtime);
  });

  it("classifies schemaVersion from the parsed top-level YAML field", () => {
    const flow = tempHome();
    writeCurrent(flow);
    const flowDoc = parseDocument(configText());
    if (isMap(flowDoc.contents)) flowDoc.contents.flow = true;
    writeFileSync(join(flow, "config.yaml"), flowDoc.toString());
    expect(inspectPreflight(flow).status).toBe("compatible");

    const quoted = tempHome();
    writeCurrent(quoted);
    writeFileSync(join(quoted, "config.yaml"), configText().replace(/^schemaVersion:/m, '"schemaVersion":'));
    expect(inspectPreflight(quoted).status).toBe("compatible");

    const json = tempHome();
    writeCurrent(json);
    writeFileSync(join(json, "config.yaml"), `${JSON.stringify(parseDocument(configText()).toJS())}\n`);
    expect(inspectPreflight(json).status).toBe("compatible");

    const nested = tempHome();
    writeCurrent(nested);
    writeFileSync(
      join(nested, "config.yaml"),
      configText()
        .replace(/^schemaVersion: 1\n/m, "")
        .replace(/^server:\n {2}host:/m, "server:\n  schemaVersion: 2\n  host:"),
    );
    const nestedReport = inspectPreflight(nested);
    expect(nestedReport.status).toBe("recovery_required");
    expect(nestedReport.checks.find((check) => check.id === "config.schema")?.message).toContain("invalid");
    expect(nestedReport.checks.find((check) => check.id === "config.schema")?.message).not.toContain("newer");

    const wrongType = tempHome();
    writeCurrent(wrongType);
    writeFileSync(join(wrongType, "config.yaml"), configText().replace("schemaVersion: 1", 'schemaVersion: "1"'));
    const wrongTypeReport = inspectPreflight(wrongType);
    expect(wrongTypeReport.status).toBe("recovery_required");
    expect(wrongTypeReport.checks.find((check) => check.id === "config.schema")?.message).not.toContain(
      "not supported",
    );

    const missing = tempHome();
    writeCurrent(missing);
    writeFileSync(join(missing, "config.yaml"), configText().replace(/^schemaVersion: 1\n/m, ""));
    const missingReport = inspectPreflight(missing);
    expect(missingReport.status).toBe("recovery_required");
    expect(missingReport.checks.find((check) => check.id === "config.schema")?.message).toContain("invalid");
    expect(missingReport.checks.find((check) => check.id === "config.schema")?.message).not.toContain("not supported");
  });

  it("resolves ~/ under the user home and ~/.sorage/ under the selected home", () => {
    const user = tempHome();
    const selected = tempHome();
    writeCurrent(selected);
    mkdirSync(join(user, "Vault"), { recursive: true });
    writeFileSync(join(user, "Vault", ".sorage-vault.json"), marker());
    rmSync(join(selected, "vault"), { recursive: true, force: true });
    writeFileSync(join(selected, "config.yaml"), configText().replace('path: "~/.sorage/vault"', 'path: "~/Vault"'));
    expect(inspectPreflight(selected, { userHome: user }).status).toBe("compatible");

    const selectedDefault = tempHome();
    const otherUser = tempHome();
    writeCurrent(selectedDefault);
    expect(inspectPreflight(selectedDefault, { userHome: otherUser }).status).toBe("compatible");
  });

  it("does not create scratch inside a selected root that contains the temp directory", () => {
    const owner = tempHome();
    const vaultRoot = join(owner, "external-vault");
    const scratchInside = join(vaultRoot, "scratch-parent");
    mkdirSync(scratchInside, { recursive: true });
    writeFileSync(join(vaultRoot, ".sorage-vault.json"), marker());
    const home = tempHome();
    writeCurrent(home);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    writeFileSync(
      join(home, "config.yaml"),
      configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vaultRoot)}`),
    );
    const vaultBefore = inventory(vaultRoot);
    const mtime = lstatSync(vaultRoot).mtimeMs;
    const homeBefore = inventory(home);
    expect(inspectPreflight(home, { scratchParent: scratchInside }).status).toBe("compatible");
    expect(inventory(vaultRoot)).toEqual(vaultBefore);
    expect(lstatSync(vaultRoot).mtimeMs).toBe(mtime);
    expectUntouched(home, homeBefore);
  });

  it("rejects a current prefix that lost a non-representative index and trigger", () => {
    for (const sql of [
      "DROP INDEX idx_pending_fs_ops_created_at",
      "DROP TRIGGER events_memo_association",
      "DROP TRIGGER events_channel_association",
    ]) {
      const home = tempHome();
      writeCurrent(home);
      const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      db.exec(sql);
      db.close();
      const before = inventory(home);
      expect(inspectPreflight(home).status).toBe("recovery_required");
      expectUntouched(home, before);
    }
  });

  it("fails integrity on corruption and on a foreign-key violation without opening the original for those checks", () => {
    const corrupt = tempHome();
    writeCurrent(corrupt);
    const corruptPath = join(corrupt, "state", "sorage.sqlite3");
    const opened: string[] = [];
    const sizing = new DatabaseSync(corruptPath);
    sizing.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const pageSize = (sizing.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    sizing.close();
    rmSync(`${corruptPath}-wal`, { force: true });
    rmSync(`${corruptPath}-shm`, { force: true });
    const bytes = readFileSync(corruptPath);
    const offset = pageSize * 2 + 20;
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    writeFileSync(corruptPath, bytes);
    const corruptBefore = inventory(corrupt);
    const corruptReport = inspectPreflight(corrupt, {
      openPrivateDatabase(path) {
        opened.push(path);
        expect(path).not.toBe(corruptPath);
        return new DatabaseSync(path) as never;
      },
    });
    expect(corruptReport.status).toBe("recovery_required");
    expect(corruptReport.checks.find((check) => check.id === "db.integrity")?.message).toContain(
      "Integrity checks failed",
    );
    expect(opened.length).toBeGreaterThan(0);
    expectUntouched(corrupt, corruptBefore);

    const foreign = tempHome();
    writeCurrent(foreign);
    const foreignPath = join(foreign, "state", "sorage.sqlite3");
    const foreignDb = new DatabaseSync(foreignPath);
    foreignDb.exec("PRAGMA foreign_keys = OFF");
    foreignDb
      .prepare(
        "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b-missing', 'missing-project', ?, '/tmp/missing', 'directory', ?, ?)",
      )
      .run(INSTALLATION, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    foreignDb.close();
    const foreignBefore = inventory(foreign);
    const foreignReport = inspectPreflight(foreign);
    expect(foreignReport.status).toBe("recovery_required");
    expect(foreignReport.checks.find((check) => check.id === "db.integrity")?.message).toContain(
      "Integrity checks failed",
    );
    expectUntouched(foreign, foreignBefore);
  });

  it("checks configuration, the installation row, every binding, and the Vault marker separately", () => {
    const markerHome = tempHome();
    writeCurrent(markerHome, { bindingId: INSTALLATION });
    writeFileSync(join(markerHome, "vault", ".sorage-vault.json"), marker(OTHER));
    const markerBefore = inventory(markerHome);
    expect(inspectPreflight(markerHome).status).toBe("recovery_required");
    expectUntouched(markerHome, markerBefore);

    const rowHome = tempHome();
    writeCurrent(rowHome);
    const rowDb = new DatabaseSync(join(rowHome, "state", "sorage.sqlite3"));
    rowDb.prepare("UPDATE installation SET installation_id = ? WHERE id = 1").run(OTHER);
    rowDb.close();
    expect(inspectPreflight(rowHome).checks.find((check) => check.id === "installation.identity")?.message).toContain(
      "does not agree",
    );

    const bindings = tempHome();
    writeCurrent(bindings, { bindingId: INSTALLATION });
    const bindingDb = new DatabaseSync(join(bindings, "state", "sorage.sqlite3"));
    bindingDb
      .prepare(
        "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b2', 'p1', ?, '/tmp/other', 'directory', ?, ?)",
      )
      .run(OTHER, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    bindingDb.close();
    expect(inspectPreflight(bindings).status).toBe("recovery_required");

    const absentRow = tempHome();
    writeCurrent(absentRow, { installationRow: false });
    const absentBefore = inventory(absentRow);
    expect(inspectPreflight(absentRow).status).toBe("compatible");
    expectUntouched(absentRow, absentBefore);
    const reread = new DatabaseSync(join(absentRow, "state", "sorage.sqlite3"));
    expect((reread.prepare("SELECT COUNT(*) AS n FROM installation").get() as { n: number }).n).toBe(0);
    reread.close();
  });

  it("never opens the original database, skips SHM, and stops after the capture limit", () => {
    const home = tempHome();
    writeCurrent(home, { bindingId: INSTALLATION });
    const source = join(home, "state", "sorage.sqlite3");
    const held = new DatabaseSync(source);
    held.exec("PRAGMA wal_autocheckpoint = 0");
    held.exec("UPDATE installation SET schema_version = schema_version");
    rmSync(`${source}-shm`, { force: true });
    const opened: string[] = [];
    const copied: string[] = [];
    const before = inventory(home);
    const report = inspectPreflight(home, {
      openPrivateDatabase(path) {
        opened.push(path);
        return new DatabaseSync(path) as never;
      },
      copyFile(from, to) {
        copied.push(from);
        copyFileSync(from, to);
      },
    });
    expect(report.status).toBe("compatible");
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((path) => path !== source && !path.endsWith(`${sep}state${sep}sorage.sqlite3`))).toBe(true);
    expect(copied.some((path) => path.endsWith(`${sep}sorage.sqlite3-wal`))).toBe(true);
    expect(copied.some((path) => path.endsWith("-shm"))).toBe(false);
    expect(existsSync(`${source}-shm`)).toBe(false);
    expectUntouched(home, before);
    held.close();

    const staleShm = tempHome();
    writeCurrent(staleShm);
    const shm = join(staleShm, "state", "sorage.sqlite3-shm");
    writeFileSync(shm, "stale-shm");
    const shmBefore = readFileSync(shm);
    expect(inspectPreflight(staleShm).status).toBe("compatible");
    expect(readFileSync(shm)).toEqual(shmBefore);

    const changing = tempHome();
    writeCurrent(changing);
    let dbCopies = 0;
    const changingReport = inspectPreflight(changing, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (from.endsWith(`${sep}sorage.sqlite3`)) {
          dbCopies += 1;
          writeFileSync(from, Buffer.concat([readFileSync(from), Buffer.from("x")]));
        }
      },
    });
    expect(changingReport.status).toBe("unverifiable");
    expect(dbCopies).toBeLessThanOrEqual(CAPTURE_ATTEMPTS);
    expect(dbCopies).toBe(CAPTURE_ATTEMPTS);
  });

  it("reports unreadable, non-directory, and broken homes as unverifiable with unverified downstream checks", () => {
    const unreadable = tempHome();
    chmodSync(unreadable, 0o000);
    try {
      const report = inspectPreflight(unreadable);
      expect(report.status).toBe("unverifiable");
      expect(
        report.checks.slice(1).every((check) => check.message !== "This check does not apply to the selected home."),
      ).toBe(true);
    } finally {
      chmodSync(unreadable, 0o755);
    }

    const fileHome = tempHome();
    const filePath = join(fileHome, "not-a-directory");
    writeFileSync(filePath, "file");
    const fileReport = inspectPreflight(filePath);
    expect(fileReport.status).toBe("unverifiable");
    expect(fileReport.checks[0]?.message).toContain("not a directory");
    expect(fileReport.checks.slice(1).every((check) => !check.message.includes("does not apply"))).toBe(true);

    const parent = tempHome();
    const broken = join(parent, "broken");
    symlinkSync(join(parent, "missing"), broken);
    const brokenReport = inspectPreflight(broken);
    expect(brokenReport.status).toBe("unverifiable");
    expect(brokenReport.checks.slice(1).every((check) => !check.message.includes("does not apply"))).toBe(true);
  });

  it("does not treat an unsearchable existing home, a non-directory path, or a link loop as absent", () => {
    const owner = tempHome();
    const parent = join(owner, "locked");
    const selected = join(parent, "selected");
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(selected, "sentinel"), "kept");
    chmodSync(parent, 0o000);
    try {
      const report = inspectPreflight(selected);
      expect(report.status).toBe("unverifiable");
      expect(report.checks.find((check) => check.id === "home.state")?.message).not.toContain("absent");
      expect(report.checks.slice(1).every((check) => !check.message.includes("does not apply"))).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
    expect(readFileSync(join(selected, "sentinel"), "utf8")).toBe("kept");
    expect(existsSync(selected)).toBe(true);

    const file = join(owner, "not-a-directory");
    writeFileSync(file, "file");
    expect(inspectPreflight(join(file, "selected")).status).toBe("unverifiable");
    expect(readFileSync(file, "utf8")).toBe("file");

    const loop = join(owner, "loop");
    symlinkSync(loop, loop);
    expect(inspectPreflight(loop).status).toBe("unverifiable");
  });

  it("treats EPERM as alive, ESRCH as a stale warning, and any other liveness error as unverifiable", () => {
    function killError(code: string): (pid: number, signal: number) => void {
      return () => {
        const error = new Error(code) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      };
    }
    const alive = tempHome();
    writeCurrent(alive);
    const aliveLock = join(alive, "run", "vault-move.lock");
    const aliveBody = JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" });
    writeFileSync(aliveLock, aliveBody);
    const aliveBefore = inventory(alive);
    expect(inspectPreflight(alive, { kill: killError("EPERM") }).status).toBe("unverifiable");
    expect(readFileSync(aliveLock, "utf8")).toBe(aliveBody);
    expectUntouched(alive, aliveBefore);

    const dead = tempHome();
    writeCurrent(dead);
    const deadLock = join(dead, "run", "vault-move.lock");
    const deadBody = JSON.stringify({ pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" });
    writeFileSync(deadLock, deadBody);
    const deadReport = inspectPreflight(dead, { kill: killError("ESRCH") });
    expect(deadReport.status).toBe("compatible");
    expect(deadReport.checks.find((check) => check.id === "source.snapshot")?.message).toContain("left untouched");
    expect(readFileSync(deadLock, "utf8")).toBe(deadBody);

    const unknown = tempHome();
    writeCurrent(unknown);
    const unknownLock = join(unknown, "run", "vault-move.lock");
    writeFileSync(unknownLock, deadBody);
    const unknownBefore = inventory(unknown);
    expect(inspectPreflight(unknown, { kill: killError("EIO") }).status).toBe("unverifiable");
    expectUntouched(unknown, unknownBefore);
  });

  it("does not require the move-fence column on a prefix shorter than version 5", () => {
    const home = tempHome();
    writeCurrent(home, { through: 4 });
    const before = inventory(home);
    const report = inspectPreflight(home);
    expect(report.status).toBe("upgrade_required");
    expect(report.checks.find((check) => check.id === "upgrade.preparation")?.message).toContain(
      "separately from preparation",
    );
    expectUntouched(home, before);
  });

  it("classifies a top-level newer configuration and the Vault format distinctions", () => {
    const newerConfig = tempHome();
    writeCurrent(newerConfig);
    writeFileSync(join(newerConfig, "config.yaml"), configText().replace("schemaVersion: 1", "schemaVersion: 2"));
    const newerConfigReport = inspectPreflight(newerConfig);
    expect(newerConfigReport.status).toBe("unsupported");
    expect(newerConfigReport.checks.find((check) => check.id === "config.schema")?.message).toContain("newer");

    const foreign = tempHome();
    writeCurrent(foreign);
    writeFileSync(join(foreign, "config.yaml"), '["not-a-config"]\n');
    const foreignReport = inspectPreflight(foreign);
    expect(foreignReport.checks.find((check) => check.id === "config.schema")?.message).toContain("not supported");

    const newerVault = tempHome();
    writeCurrent(newerVault);
    writeFileSync(
      join(newerVault, "vault", ".sorage-vault.json"),
      `${JSON.stringify({ type: "sorage-vault", schemaVersion: 2, installationId: INSTALLATION, createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    expect(inspectPreflight(newerVault).checks.find((check) => check.id === "vault.marker")?.message).toContain(
      "newer",
    );

    const malformedVault = tempHome();
    writeCurrent(malformedVault);
    writeFileSync(join(malformedVault, "vault", ".sorage-vault.json"), "{");
    expect(inspectPreflight(malformedVault).checks.find((check) => check.id === "vault.marker")?.message).toContain(
      "malformed",
    );

    const foreignVault = tempHome();
    writeCurrent(foreignVault);
    writeFileSync(join(foreignVault, "vault", ".sorage-vault.json"), `${JSON.stringify({ type: "other-vault" })}\n`);
    expect(inspectPreflight(foreignVault).checks.find((check) => check.id === "vault.marker")?.message).toContain(
      "not supported",
    );
  });

  it("keeps a home and sentinel that appear during observation of an absent path", () => {
    const parent = tempHome();
    const selected = join(parent, "late-home");
    const report = inspectPreflight(selected, {
      onObserved() {
        mkdirSync(selected);
        writeFileSync(join(selected, "sentinel"), "kept");
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(readFileSync(join(selected, "sentinel"), "utf8")).toBe("kept");
    expect(existsSync(selected)).toBe(true);
  });

  it("treats malformed YAML and an unresolved alias as invalid configuration", () => {
    const malformed = tempHome();
    writeCurrent(malformed);
    writeFileSync(join(malformed, "config.yaml"), 'schemaVersion: 1\ninstallationId: "unterminated\n');
    const malformedReport = inspectPreflight(malformed);
    expect(malformedReport.status).toBe("recovery_required");
    expect(malformedReport.checks.find((check) => check.id === "config.schema")?.message).toContain("invalid");
    expect(malformedReport.checks.find((check) => check.id === "config.schema")?.message).not.toContain(
      "not supported",
    );

    const alias = tempHome();
    writeCurrent(alias);
    writeFileSync(join(alias, "config.yaml"), "schemaVersion: *missing\n");
    const aliasReport = inspectPreflight(alias);
    expect(aliasReport.status).toBe("recovery_required");
    expect(aliasReport.checks.find((check) => check.id === "config.schema")?.message).toContain("invalid");
    expect(aliasReport.checks.find((check) => check.id === "config.schema")?.message).not.toContain("not supported");
  });

  it("does not create a private directory for a blocked configuration whose Vault contains the temp parent", () => {
    const owner = tempHome();
    const vaultRoot = join(owner, "external-vault");
    const scratchInside = join(vaultRoot, "scratch-parent");
    mkdirSync(scratchInside, { recursive: true });
    writeFileSync(join(vaultRoot, ".sorage-vault.json"), marker());
    const cases = [
      {
        body: configText()
          .replace("schemaVersion: 1", "schemaVersion: 2")
          .replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vaultRoot)}`),
        status: "unsupported" as const,
        message: "newer",
      },
      {
        body: configText()
          .replace(/^installationId:.*\n/m, "")
          .replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vaultRoot)}`),
        status: "recovery_required" as const,
        message: "invalid",
      },
    ];
    for (const item of cases) {
      const home = tempHome();
      writeCurrent(home);
      rmSync(join(home, "vault"), { recursive: true, force: true });
      writeFileSync(join(home, "config.yaml"), item.body);
      const vaultBefore = inventory(vaultRoot);
      const mtime = lstatSync(vaultRoot).mtimeMs;
      const homeBefore = inventory(home);
      const report = inspectPreflight(home, { scratchParent: scratchInside });
      expect(report.status).toBe(item.status);
      expect(report.checks.find((check) => check.id === "config.schema")?.message).toContain(item.message);
      expect(inventory(vaultRoot)).toEqual(vaultBefore);
      expect(lstatSync(vaultRoot).mtimeMs).toBe(mtime);
      expectUntouched(home, homeBefore);
    }
  });

  it("fails closed when a home or Vault directory alias changes target during the copy", () => {
    const parent = tempHome();
    const targetA = join(parent, "target-a");
    const targetB = join(parent, "target-b");
    writeCurrent(targetA);
    writeCurrent(targetB);
    const alias = join(parent, "alias");
    symlinkSync(targetA, alias);
    const beforeA = inventory(targetA);
    const beforeB = inventory(targetB);
    let flipped = false;
    const homeReport = inspectPreflight(alias, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (!flipped && from.endsWith(`${sep}sorage.sqlite3`)) {
          flipped = true;
          rmSync(alias);
          symlinkSync(targetB, alias);
        }
      },
    });
    expect(homeReport.status).toBe("unverifiable");
    expect(inventory(targetA)).toEqual(beforeA);
    expect(inventory(targetB)).toEqual(beforeB);

    const selected = tempHome();
    writeCurrent(selected);
    const vaultA = join(parent, "vault-a");
    const vaultB = join(parent, "vault-b");
    mkdirSync(vaultA);
    mkdirSync(vaultB);
    writeFileSync(join(vaultA, ".sorage-vault.json"), marker());
    writeFileSync(join(vaultB, ".sorage-vault.json"), marker());
    const vaultLink = join(parent, "vault-link");
    symlinkSync(vaultA, vaultLink);
    rmSync(join(selected, "vault"), { recursive: true, force: true });
    writeFileSync(
      join(selected, "config.yaml"),
      configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vaultLink)}`),
    );
    const vaultBeforeA = inventory(vaultA);
    const vaultBeforeB = inventory(vaultB);
    let vaultFlipped = false;
    const vaultReport = inspectPreflight(selected, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (!vaultFlipped && from.endsWith(`${sep}sorage.sqlite3`)) {
          vaultFlipped = true;
          rmSync(vaultLink);
          symlinkSync(vaultB, vaultLink);
        }
      },
    });
    expect(vaultReport.status).toBe("unverifiable");
    expect(inventory(vaultA)).toEqual(vaultBeforeA);
    expect(inventory(vaultB)).toEqual(vaultBeforeB);
  });

  it("fails closed when a selected home alias changes after the initial observation", () => {
    const parent = tempHome();
    const targetA = join(parent, "target-a");
    const targetB = join(parent, "target-b");
    const scratch = join(parent, "scratch");
    writeCurrent(targetA);
    writeCurrent(targetB);
    writeFileSync(join(targetB, "config.yaml"), configText().replace("schemaVersion: 1", "schemaVersion: 2"));
    mkdirSync(scratch);
    const alias = join(parent, "alias");
    symlinkSync(targetA, alias);
    const beforeA = inventory(targetA);
    const beforeB = inventory(targetB);
    const report = inspectPreflight(alias, {
      get scratchParent() {
        rmSync(alias);
        symlinkSync(targetB, alias);
        return scratch;
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(inventory(targetA)).toEqual(beforeA);
    expect(inventory(targetB)).toEqual(beforeB);
    expect(inspectPreflight(targetB, { scratchParent: scratch }).status).toBe("unsupported");
  });

  it("fails closed when the configured Vault changes before private scratch is created", () => {
    const home = tempHome();
    writeCurrent(home);
    const owner = tempHome();
    const vault = join(owner, "external-vault");
    mkdirSync(vault);
    writeFileSync(join(vault, ".sorage-vault.json"), marker());
    const vaultBefore = inventory(vault);
    const mtime = lstatSync(vault).mtimeMs;
    const report = inspectPreflight(home, {
      get scratchParent() {
        writeFileSync(
          join(home, "config.yaml"),
          configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vault)}`),
        );
        return vault;
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(inventory(vault)).toEqual(vaultBefore);
    expect(lstatSync(vault).mtimeMs).toBe(mtime);
  });

  it("fails closed when the Vault marker is replaced by the same bytes and a new inode", () => {
    const home = tempHome();
    writeCurrent(home);
    const markerPath = join(home, "vault", ".sorage-vault.json");
    const database = join(home, "state", "sorage.sqlite3");
    const databaseInode = lstatSync(database).ino;
    const markerInode = lstatSync(markerPath).ino;
    const markerBefore = readFileSync(markerPath);
    let replaced = false;
    const report = inspectPreflight(home, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (!replaced && from.endsWith(`${sep}sorage.sqlite3`)) {
          replaced = true;
          const temp = join(home, "marker-replacement");
          writeFileSync(temp, markerBefore);
          renameSync(temp, markerPath);
        }
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(lstatSync(database).ino).toBe(databaseInode);
    expect(readFileSync(markerPath)).toEqual(markerBefore);
    expect(lstatSync(markerPath).ino).not.toBe(markerInode);
    expect(existsSync(join(home, "marker-replacement"))).toBe(false);
  });

  it("fails closed when the Vault marker is replaced by a link during the copy", () => {
    const home = tempHome();
    writeCurrent(home);
    const markerPath = join(home, "vault", ".sorage-vault.json");
    const outsideHome = tempHome();
    const outside = join(outsideHome, "linked-marker");
    const markerBytes = readFileSync(markerPath);
    writeFileSync(outside, markerBytes);
    const outsideBefore = inventory(outsideHome);
    let linked = false;
    const report = inspectPreflight(home, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (!linked && from.endsWith(`${sep}sorage.sqlite3`)) {
          linked = true;
          rmSync(markerPath);
          symlinkSync(outside, markerPath);
        }
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside)).toEqual(markerBytes);
    expect(inventory(outsideHome)).toEqual(outsideBefore);
  });

  it("fails closed when a managed directory is replaced by a link to another installation", () => {
    const parent = tempHome();
    const selected = join(parent, "selected");
    const other = join(parent, "other");
    writeCurrent(selected);
    writeCurrent(other);
    const otherBefore = inventory(other);
    const configBefore = readFileSync(join(selected, "config.yaml"));
    let flipped = false;
    const report = inspectPreflight(selected, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (!flipped && from.endsWith(`${sep}sorage.sqlite3`)) {
          flipped = true;
          renameSync(join(selected, "state"), join(parent, "held-state"));
          symlinkSync(join(other, "state"), join(selected, "state"));
        }
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(lstatSync(join(selected, "state")).isSymbolicLink()).toBe(true);
    expect(inventory(other)).toEqual(otherBefore);
    expect(readFileSync(join(selected, "config.yaml"))).toEqual(configBefore);
  });

  it("reads configuration and the Vault marker from the private snapshot before SQLite inspection", () => {
    const home = tempHome();
    writeCurrent(home);
    const scratch = join(tempHome(), "scratch");
    mkdirSync(scratch);
    const configBytes = readFileSync(join(home, "config.yaml"));
    const markerBytes = readFileSync(join(home, "vault", ".sorage-vault.json"));
    const before = inventory(home);
    let sawPrivate = false;
    const report = inspectPreflight(home, {
      scratchParent: scratch,
      openPrivateDatabase(path) {
        expect(readFileSync(join(dirname(path), "config.yaml"))).toEqual(configBytes);
        expect(readFileSync(join(dirname(path), ".sorage-vault.json"))).toEqual(markerBytes);
        sawPrivate = true;
        return new DatabaseSync(path) as never;
      },
    });
    expect(sawPrivate).toBe(true);
    expect(report.status).toBe("compatible");
    expectUntouched(home, before);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("reports a stably absent Vault marker or directory as recovery and keeps the source", () => {
    const missingMarker = tempHome();
    writeCurrent(missingMarker);
    rmSync(join(missingMarker, "vault", ".sorage-vault.json"));
    const markerBefore = inventory(missingMarker);
    const markerReport = inspectPreflight(missingMarker);
    expect(markerReport.status).toBe("recovery_required");
    expect(markerReport.checks.find((check) => check.id === "vault.marker")?.message).toContain(
      "missing from a recognizable installation",
    );
    expect(markerReport.checks.find((check) => check.id === "source.snapshot")?.message).not.toContain(
      "could not be verified",
    );
    expect(markerReport.checks.find((check) => check.id === "db.schema")?.message).not.toContain(
      "could not be verified",
    );
    expect(markerReport.checks.find((check) => check.id === "installation.identity")?.message).toContain(
      "could not be verified",
    );
    expectUntouched(missingMarker, markerBefore);

    const missingDirectory = tempHome();
    writeCurrent(missingDirectory);
    rmSync(join(missingDirectory, "vault"), { recursive: true, force: true });
    const directoryBefore = inventory(missingDirectory);
    const directoryReport = inspectPreflight(missingDirectory);
    expect(directoryReport.status).toBe("recovery_required");
    expect(directoryReport.checks.find((check) => check.id === "vault.marker")?.message).toContain(
      "missing from a recognizable installation",
    );
    expectUntouched(missingDirectory, directoryBefore);

    const fenced = tempHome();
    writeCurrent(fenced);
    rmSync(join(fenced, "vault", ".sorage-vault.json"));
    const lock = join(fenced, "run", "vault-move.lock");
    const lockBody = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" });
    writeFileSync(lock, lockBody);
    const fencedBefore = inventory(fenced);
    expect(inspectPreflight(fenced).status).toBe("unverifiable");
    expect(readFileSync(lock, "utf8")).toBe(lockBody);
    expectUntouched(fenced, fencedBefore);

    const newer = tempHome();
    writeCurrent(newer);
    rmSync(join(newer, "vault", ".sorage-vault.json"));
    const newerDb = new DatabaseSync(join(newer, "state", "sorage.sqlite3"));
    newerDb
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', ?)")
      .run(knownSchemaMaximum() + 1, "2026-01-01T00:00:00.000Z");
    newerDb.close();
    const newerReport = inspectPreflight(newer);
    expect(newerReport.status).toBe("unsupported");
    expect(newerReport.checks.find((check) => check.id === "db.schema")?.message).toContain("newer");
    expect(newerReport.checks.find((check) => check.id === "vault.marker")?.message).toContain(
      "missing from a recognizable installation",
    );
  });

  it("fails closed when a managed directory inventory changes during capture", () => {
    const home = tempHome();
    writeCurrent(home);
    const configBefore = readFileSync(join(home, "config.yaml"));
    let added = false;
    const report = inspectPreflight(home, {
      copyFile(from, to) {
        copyFileSync(from, to);
        if (!added && from.endsWith(`${sep}sorage.sqlite3`)) {
          added = true;
          writeFileSync(join(home, "logs", "added-during-capture"), "actor");
        }
      },
    });
    expect(report.status).toBe("unverifiable");
    expect(readFileSync(join(home, "logs", "added-during-capture"), "utf8")).toBe("actor");
    expect(readFileSync(join(home, "config.yaml"))).toEqual(configBefore);
  });

  it("does not treat a populated Vault, a directory config, a logs file, or a root link as fresh residue", () => {
    const populated = tempHome();
    mkdirSync(join(populated, "logs"));
    mkdirSync(join(populated, "vault"));
    writeFileSync(join(populated, "vault", "payload"), "kept");
    const populatedBefore = inventory(populated);
    expect(inspectPreflight(populated).status).toBe("recovery_required");
    expectUntouched(populated, populatedBefore);

    const directoryConfig = tempHome();
    mkdirSync(join(directoryConfig, "logs"));
    mkdirSync(join(directoryConfig, "config.yaml"));
    expect(inspectPreflight(directoryConfig).status).toBe("recovery_required");

    const fileLogs = tempHome();
    writeFileSync(join(fileLogs, "logs"), "not-a-directory");
    expect(inspectPreflight(fileLogs).status).toBe("recovery_required");

    const fileVault = tempHome();
    mkdirSync(join(fileVault, "state"));
    writeFileSync(join(fileVault, "vault"), "not-a-directory");
    const fileVaultBefore = inventory(fileVault);
    expect(inspectPreflight(fileVault).status).toBe("recovery_required");
    expectUntouched(fileVault, fileVaultBefore);

    const linked = tempHome();
    mkdirSync(join(linked, "logs"));
    symlinkSync(join(linked, "logs"), join(linked, "alias"));
    expect(inspectPreflight(linked).status).toBe("unverifiable");
  });

  it("does not pass identity without a supported marker and a known ordered database", () => {
    const malformed = tempHome();
    writeCurrent(malformed);
    writeFileSync(join(malformed, "vault", ".sorage-vault.json"), "{");
    const malformedReport = inspectPreflight(malformed);
    expect(malformedReport.status).toBe("recovery_required");
    expect(malformedReport.checks.find((check) => check.id === "installation.identity")?.message).toContain(
      "could not be verified",
    );

    const absent = tempHome();
    writeCurrent(absent);
    rmSync(join(absent, "vault", ".sorage-vault.json"));
    const mismatched = new DatabaseSync(join(absent, "state", "sorage.sqlite3"));
    mismatched.prepare("UPDATE installation SET installation_id = ? WHERE id = 1").run(OTHER);
    mismatched.close();
    const absentReport = inspectPreflight(absent);
    expect(absentReport.status).toBe("recovery_required");
    expect(absentReport.checks.find((check) => check.id === "installation.identity")?.message).toContain(
      "does not agree",
    );

    const foreign = tempHome();
    writeCurrent(foreign);
    writeFileSync(join(foreign, "state", "sorage.sqlite3"), "OTHER-FORMAT\n");
    const foreignIdentity = inspectPreflight(foreign).checks.find((check) => check.id === "installation.identity");
    expect(foreignIdentity?.severity).not.toBe("ok");
    expect(foreignIdentity?.message).not.toContain("was not invented");

    const newerMarker = tempHome();
    writeCurrent(newerMarker);
    writeFileSync(
      join(newerMarker, "vault", ".sorage-vault.json"),
      `${JSON.stringify({ type: "sorage-vault", schemaVersion: 2, installationId: INSTALLATION, createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    const newerReport = inspectPreflight(newerMarker);
    expect(newerReport.status).toBe("unsupported");
    expect(newerReport.checks.find((check) => check.id === "installation.identity")?.severity).not.toBe("ok");
  });

  it("does not create scratch inside a dot-prefixed descendant of a selected root", () => {
    const home = tempHome();
    writeCurrent(home);
    const inside = join(home, "..inspection");
    mkdirSync(inside);
    const before = inventory(home);
    const mode = lstatSync(home).mode;
    const mtime = lstatSync(home).mtimeMs;
    const identity = `${lstatSync(home).dev}:${lstatSync(home).ino}`;
    expect(inspectPreflight(home, { scratchParent: inside }).status).toBe("compatible");
    expectUntouched(home, before);
    expect(lstatSync(home).mode).toBe(mode);
    expect(lstatSync(home).mtimeMs).toBe(mtime);
    expect(`${lstatSync(home).dev}:${lstatSync(home).ino}`).toBe(identity);
    expect(readdirSync(inside)).toEqual([]);

    const owner = tempHome();
    const vault = join(owner, "external-vault");
    const vaultInside = join(vault, "..inspection");
    mkdirSync(vaultInside, { recursive: true });
    writeFileSync(join(vault, ".sorage-vault.json"), marker());
    const selected = tempHome();
    writeCurrent(selected);
    rmSync(join(selected, "vault"), { recursive: true, force: true });
    writeFileSync(
      join(selected, "config.yaml"),
      configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(vault)}`),
    );
    const vaultBefore = inventory(vault);
    const vaultMtime = lstatSync(vault).mtimeMs;
    expect(inspectPreflight(selected, { scratchParent: vaultInside }).status).toBe("compatible");
    expect(inventory(vault)).toEqual(vaultBefore);
    expect(lstatSync(vault).mtimeMs).toBe(vaultMtime);
    expect(readdirSync(vaultInside)).toEqual([]);

    const inherited = process.env.TMPDIR;
    const dotHome = tempHome();
    writeCurrent(dotHome);
    const dot = join(dotHome, "..inspection");
    mkdirSync(dot);
    const dotBefore = inventory(dotHome);
    const child = spawnSync(
      "bun",
      [
        "-e",
        `import { inspectPreflight } from ${JSON.stringify(new URL("../../src/preflight.ts", import.meta.url).pathname)};
         const report = inspectPreflight(${JSON.stringify(dotHome)});
         console.log(report.status);`,
      ],
      { env: { ...process.env, TMPDIR: dot }, encoding: "utf8" },
    );
    expect(process.env.TMPDIR).toBe(inherited);
    expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
    expect(child.stdout.trim()).toBe("compatible");
    expect(inventory(dotHome)).toEqual(dotBefore);
    expect(readdirSync(dot)).toEqual([]);

    const vaultOwner = tempHome();
    const externalVault = join(vaultOwner, "external-vault");
    const vaultDot = join(externalVault, "..inspection");
    mkdirSync(vaultDot, { recursive: true });
    writeFileSync(join(externalVault, ".sorage-vault.json"), marker());
    const vaultHome = tempHome();
    writeCurrent(vaultHome);
    rmSync(join(vaultHome, "vault"), { recursive: true, force: true });
    writeFileSync(
      join(vaultHome, "config.yaml"),
      configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(externalVault)}`),
    );
    const homeBefore = inventory(vaultHome);
    const homeMode = lstatSync(vaultHome).mode;
    const homeMtime = lstatSync(vaultHome).mtimeMs;
    const homeIdentity = `${lstatSync(vaultHome).dev}:${lstatSync(vaultHome).ino}`;
    const externalBefore = inventory(externalVault);
    const externalMode = lstatSync(externalVault).mode;
    const externalMtime = lstatSync(externalVault).mtimeMs;
    const externalIdentity = `${lstatSync(externalVault).dev}:${lstatSync(externalVault).ino}`;
    const vaultChild = spawnSync(
      "bun",
      [
        "-e",
        `import { inspectPreflight } from ${JSON.stringify(new URL("../../src/preflight.ts", import.meta.url).pathname)};
         const report = inspectPreflight(${JSON.stringify(vaultHome)});
         console.log(report.status);`,
      ],
      { env: { ...process.env, TMPDIR: vaultDot }, encoding: "utf8" },
    );
    expect(process.env.TMPDIR).toBe(inherited);
    expect(vaultChild.status, `${vaultChild.stderr}\n${vaultChild.stdout}`).toBe(0);
    expect(vaultChild.stdout.trim()).toBe("compatible");
    expect(inventory(vaultHome)).toEqual(homeBefore);
    expect(lstatSync(vaultHome).mode).toBe(homeMode);
    expect(lstatSync(vaultHome).mtimeMs).toBe(homeMtime);
    expect(`${lstatSync(vaultHome).dev}:${lstatSync(vaultHome).ino}`).toBe(homeIdentity);
    expect(inventory(externalVault)).toEqual(externalBefore);
    expect(lstatSync(externalVault).mode).toBe(externalMode);
    expect(lstatSync(externalVault).mtimeMs).toBe(externalMtime);
    expect(`${lstatSync(externalVault).dev}:${lstatSync(externalVault).ino}`).toBe(externalIdentity);
    expect(readdirSync(vaultDot)).toEqual([]);
  });

  it("accepts a stable in-home vault symlink to an external Vault", () => {
    const home = tempHome();
    writeCurrent(home);
    const externalHome = tempHome();
    const external = join(externalHome, "external-vault");
    mkdirSync(external);
    const markerBytes = readFileSync(join(home, "vault", ".sorage-vault.json"));
    writeFileSync(join(external, ".sorage-vault.json"), markerBytes);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    symlinkSync(external, join(home, "vault"));
    const before = inventory(home);
    const externalBefore = inventory(external);
    const report = inspectPreflight(home);
    expect(report.status).toBe("compatible");
    expect(inventory(home)).toEqual(before);
    expect(inventory(external)).toEqual(externalBefore);

    const broken = tempHome();
    writeCurrent(broken);
    rmSync(join(broken, "vault"), { recursive: true, force: true });
    symlinkSync(join(broken, "missing-vault"), join(broken, "vault"));
    expect(inspectPreflight(broken).status).toBe("unverifiable");

    const selected = tempHome();
    writeCurrent(selected);
    const configured = join(tempHome(), "configured-vault");
    const unrelated = join(tempHome(), "unrelated-vault");
    mkdirSync(configured);
    mkdirSync(unrelated);
    writeFileSync(join(configured, ".sorage-vault.json"), marker());
    writeFileSync(join(unrelated, ".sorage-vault.json"), marker());
    rmSync(join(selected, "vault"), { recursive: true, force: true });
    symlinkSync(unrelated, join(selected, "vault"));
    writeFileSync(
      join(selected, "config.yaml"),
      configText().replace('path: "~/.sorage/vault"', `path: ${JSON.stringify(configured)}`),
    );
    const selectedBefore = inventory(selected);
    const configuredBefore = inventory(configured);
    const unrelatedBefore = inventory(unrelated);
    expect(inspectPreflight(selected).status).toBe("unverifiable");
    expect(inventory(selected)).toEqual(selectedBefore);
    expect(inventory(configured)).toEqual(configuredBefore);
    expect(inventory(unrelated)).toEqual(unrelatedBefore);

    const newer = tempHome();
    writeCurrent(newer);
    rmSync(join(newer, "vault"), { recursive: true, force: true });
    symlinkSync(unrelated, join(newer, "vault"));
    writeFileSync(join(newer, "config.yaml"), configText().replace("schemaVersion: 1", "schemaVersion: 2"));
    expect(inspectPreflight(newer).status).toBe("unsupported");
  });
});
