import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { git, makeTempDir, sorage } from "./helpers";
import {
  configText,
  INSTALLATION_ID,
  markerText,
  OTHER_ID,
  populateDomain,
  writeInstallation,
} from "./preflight-fixtures";

function storageProof(root: string): string[] {
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ["absent"];
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    return [`l . ${rootStat.mode} ${rootStat.mtimeMs} ${rootStat.dev}:${rootStat.ino} ${readlinkSync(root)}`];
  }
  if (!rootStat.isDirectory()) {
    const hash = createHash("sha256").update(readFileSync(root)).digest("hex");
    return [`f . ${rootStat.mode} ${rootStat.mtimeMs} ${rootStat.dev}:${rootStat.ino} ${hash}`];
  }
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

describe("compiled preflight", () => {
  it("reports an absent home and rejects confirmation without creating the home", () => {
    const parent = makeTempDir("sorage-preflight-e2e-");
    const home = join(parent, "absent");
    const report = sorage(["preflight", "--json"], { home });
    expect(report.status).toBe(0);
    expect(report.stderr).toBe("");
    const body = JSON.parse(report.stdout) as { ok: boolean; data: { status: string; checks: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("fresh");
    expect(body.data.checks).toHaveLength(8);
    expect(existsSync(home)).toBe(false);

    const human = sorage(["preflight"], { home });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("Preflight status: fresh");
    expect(human.stdout).toContain("Recovery: This status does not authorize initialization.");

    for (const args of [
      ["preflight", "--confirm"],
      ["--confirm", "preflight"],
      ["preflight", "--help"],
    ]) {
      const run = sorage(args, { home });
      expect(existsSync(home)).toBe(false);
      if (args.at(-1) === "--help") expect(run.status).toBe(0);
      else {
        expect(run.status).toBe(2);
        expect(run.stdout).toBe("");
      }
    }
  });

  it("leaves an initialized installation unchanged and reports compatible", () => {
    const home = makeTempDir("sorage-preflight-e2e-init-");
    expect(sorage(["init", "--non-interactive"], { home }).status).toBe(0);
    const before = storageProof(home);
    const report = sorage(["preflight", "--json"], { home });
    const body = JSON.parse(report.stdout) as { ok: boolean; data: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("compatible");
    expect(report.status).toBe(0);
    expect(storageProof(home)).toEqual(before);
  });

  it("reports a partial installation and a non-directory home without changing them", () => {
    const partial = makeTempDir("sorage-preflight-e2e-partial-");
    expect(sorage(["init", "--non-interactive"], { home: partial }).status).toBe(0);
    rmSync(join(partial, "vault", ".sorage-vault.json"));
    const partialBefore = storageProof(partial);
    const partialRun = sorage(["preflight", "--json"], { home: partial });
    const partialBody = JSON.parse(partialRun.stdout) as { ok: boolean; data: { status: string } };
    expect(partialBody.ok).toBe(true);
    expect(partialBody.data.status).toBe("recovery_required");
    expect(partialRun.status).toBe(78);
    expect(storageProof(partial)).toEqual(partialBefore);

    const parent = makeTempDir("sorage-preflight-e2e-file-");
    const fileHome = join(parent, "not-a-directory");
    writeFileSync(fileHome, "file");
    const fileBefore = storageProof(fileHome);
    const fileRun = sorage(["preflight", "--json"], { home: fileHome });
    const fileBody = JSON.parse(fileRun.stdout) as { ok: boolean; data: { status: string } };
    expect(fileBody.ok).toBe(true);
    expect(fileBody.data.status).toBe("unverifiable");
    expect(fileRun.status).toBe(75);
    expect(storageProof(fileHome)).toEqual(fileBefore);
  });

  it("reports an empty home as fresh without initializing it", () => {
    const home = makeTempDir("sorage-preflight-e2e-empty-");
    const before = storageProof(home);
    const seen = inspect(home);
    expect(seen.status).toBe(0);
    expect(seen.body.data.status).toBe("fresh");
    expectHuman(home, "fresh", 0);
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
    expect(existsSync(join(home, "state", "sorage.sqlite3"))).toBe(false);
    expect(existsSync(join(home, "vault", ".sorage-vault.json"))).toBe(false);
    expect(storageProof(home)).toEqual(before);
  });

  it("keeps a real pre-init failure log as fresh residue", () => {
    const home = join(makeTempDir("sorage-preflight-e2e-residue-"), "failed");
    const failed = sorage(["config", "show"], { home });
    expect(failed.status).not.toBe(0);
    expect(relativeNames(home)).toEqual(["logs", "logs/sorage.log"]);
    const before = storageProof(home);
    const report = sorage(["preflight", "--json"], { home });
    const body = JSON.parse(report.stdout) as {
      ok: boolean;
      data: { status: string; checks: Array<{ id: string; severity: string; message: string }> };
    };
    expect(report.status).toBe(0);
    expect(report.stderr).toBe("");
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("fresh");
    const homeState = body.data.checks.find((check) => check.id === "home.state");
    expect(homeState?.severity).toBe("warning");
    expect(homeState?.message).toContain("permitted pre-initialization residue");
    expect(storageProof(home)).toEqual(before);

    const dirs = makeTempDir("sorage-preflight-e2e-residue-dirs-");
    mkdirSync(join(dirs, "logs"));
    mkdirSync(join(dirs, "state"));
    mkdirSync(join(dirs, "run"));
    writeFileSync(join(dirs, "logs", "sorage.log"), "permitted\n");
    expect(readdirSync(join(dirs, "state"))).toEqual([]);
    expect(readdirSync(join(dirs, "run"))).toEqual([]);
    expect(relativeNames(dirs)).toEqual(["logs", "logs/sorage.log", "run", "state"]);
    const dirsBefore = storageProof(dirs);
    const dirsSeen = inspect(dirs);
    expect(dirsSeen.status).toBe(0);
    expect(dirsSeen.body.data.status).toBe("fresh");
    const dirsState = dirsSeen.body.data.checks.find((check) => check.id === "home.state");
    expect(dirsState?.severity).toBe("warning");
    expect(dirsState?.message).toContain("permitted pre-initialization residue");
    for (const absent of [
      join(dirs, "config.yaml"),
      join(dirs, "state", "sorage.sqlite3"),
      join(dirs, "state", "sorage.sqlite3-wal"),
      join(dirs, "state", "sorage.sqlite3-shm"),
      join(dirs, "state", "sorage.sqlite3-journal"),
      join(dirs, "vault"),
      join(dirs, "vault", ".sorage-vault.json"),
      join(dirs, "run", "migration.lock"),
      join(dirs, "run", "vault-move.lock"),
      join(dirs, "logs", "sorage.log.1"),
    ]) {
      expect(existsSync(absent)).toBe(false);
    }
    expect(readdirSync(join(dirs, "state"))).toEqual([]);
    expect(readdirSync(join(dirs, "run"))).toEqual([]);
    expect(relativeNames(dirs)).toEqual(["logs", "logs/sorage.log", "run", "state"]);
    expect(storageProof(dirs)).toEqual(dirsBefore);
  });

  it("reports a pre-Memo prefix as upgrade_required and separates backup guidance from the drill", () => {
    const home = makeTempDir("sorage-preflight-e2e-pre-memo-");
    writeInstallation(home, 6);
    const before = storageProof(home);
    const report = sorage(["preflight", "--json"], { home });
    const body = JSON.parse(report.stdout) as {
      ok: boolean;
      data: { status: string; checks: Array<{ id: string; message: string }> };
    };
    expect(report.status).toBe(78);
    expect(report.stderr).toBe("");
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("upgrade_required");
    const schema = body.data.checks.find((check) => check.id === "db.schema")?.message ?? "";
    const preparation = body.data.checks.find((check) => check.id === "upgrade.preparation")?.message ?? "";
    expect(schema).toContain("needs migration");
    expect(schema).not.toContain("old binary");
    expect(preparation).toContain("separately from preparation");
    expect(preparation).toContain("old binary");
    expect(preparation).toContain("separate restore drill");
    expect(preparation).toContain("does not confirm that an external drill already happened");
    expect(preparation).not.toBe(schema);
    expect(storageProof(home)).toEqual(before);
  });

  it("reports readable newer config, database, and Vault schemas as unsupported", () => {
    const newerConfig = makeTempDir("sorage-preflight-e2e-newer-config-");
    writeInstallation(newerConfig);
    writeFileSync(join(newerConfig, "config.yaml"), configText().replace("schemaVersion: 1", "schemaVersion: 2"));
    expectUnsupported(newerConfig, "config.schema", true);

    const newerDatabase = makeTempDir("sorage-preflight-e2e-newer-db-");
    writeInstallation(newerDatabase);
    const db = new Database(join(newerDatabase, "state", "sorage.sqlite3"));
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (8, 'future', ?)").run(
      "2026-01-01T00:00:00.000Z",
    );
    db.close();
    expectUnsupported(newerDatabase, "db.schema");

    const newerVault = makeTempDir("sorage-preflight-e2e-newer-vault-");
    writeInstallation(newerVault);
    const marker = JSON.parse(markerText()) as { schemaVersion: number };
    marker.schemaVersion = 2;
    writeFileSync(join(newerVault, "vault", ".sorage-vault.json"), `${JSON.stringify(marker)}\n`);
    expectUnsupported(newerVault, "vault.marker");
  });

  it("preserves populated domain data, receipts, and both bindings without a project actor", () => {
    const parent = makeTempDir("sorage-preflight-e2e-populated-");
    const home = join(parent, "home");
    const directory = join(parent, "directory-project");
    const gitDirectory = join(parent, "git-project");
    mkdirSync(home);
    mkdirSync(directory);
    initGitProject(gitDirectory);
    writeInstallation(home);
    populateDomain(home, directory, gitDirectory);
    expectGitInventory(gitDirectory);
    const body = expectInspection(home, [home, directory, gitDirectory], dormant(home), "compatible", 0);
    expect(body.data.checks.find((check) => check.id === "db.schema")?.message).toContain("no migration is required");
    const preserved = readDatabaseCopy(home, (db) => ({
      versions: (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n,
      slug: (db.prepare("SELECT slug FROM projects WHERE id = 'p1'").get() as { slug: string }).slug,
      bindings: (
        db.prepare("SELECT binding_kind FROM project_bindings ORDER BY id").all() as Array<{ binding_kind: string }>
      ).map((row) => row.binding_kind),
      receipt: (db.prepare("SELECT key FROM idempotency_keys").get() as { key: string }).key,
      backup: (db.prepare("SELECT id FROM backup_runs").get() as { id: string }).id,
    }));
    expect(preserved).toEqual({
      versions: 7,
      slug: "demo",
      bindings: ["directory", "git_repository"],
      receipt: "receipt-1",
      backup: "run-1",
    });
  });

  it("reports invalid migration history and invalid schema structure as recovery_required", () => {
    const history = makeTempDir("sorage-preflight-e2e-history-");
    writeInstallation(history);
    const historyDb = new Database(join(history, "state", "sorage.sqlite3"));
    historyDb.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    historyDb.close();
    const historyBody = expectInspection(history, [history], dormant(history), "recovery_required", 78);
    expect(historyBody.data.checks.find((check) => check.id === "db.schema")?.message).toContain("not valid");

    const structure = makeTempDir("sorage-preflight-e2e-structure-");
    writeInstallation(structure);
    const structureDb = new Database(join(structure, "state", "sorage.sqlite3"));
    structureDb.exec("DROP INDEX idx_pending_fs_ops_created_at");
    structureDb.close();
    const structureBody = expectInspection(structure, [structure], dormant(structure), "recovery_required", 78);
    expect(structureBody.data.checks.find((check) => check.id === "db.schema")?.message).toContain("not valid");
  });

  it("reports an installation identity or binding mismatch as recovery_required", () => {
    const identity = makeTempDir("sorage-preflight-e2e-identity-");
    writeInstallation(identity);
    const identityDb = new Database(join(identity, "state", "sorage.sqlite3"));
    identityDb.prepare("UPDATE installation SET installation_id = ? WHERE id = 1").run(OTHER_ID);
    identityDb.close();
    const identityBody = expectInspection(identity, [identity], dormant(identity), "recovery_required", 78);
    expect(identityBody.data.checks.find((check) => check.id === "installation.identity")?.message).toContain(
      "does not agree",
    );

    const binding = makeTempDir("sorage-preflight-e2e-binding-");
    writeInstallation(binding);
    const bindingDb = new Database(join(binding, "state", "sorage.sqlite3"));
    bindingDb
      .prepare(
        "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES ('p1', 'demo', 'Demo', 'active', ?, ?)",
      )
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    bindingDb
      .prepare(
        "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b2', 'p1', ?, '/tmp/other', 'directory', ?, ?)",
      )
      .run(OTHER_ID, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    bindingDb.close();
    const bindingBody = expectInspection(binding, [binding], dormant(binding), "recovery_required", 78);
    expect(bindingBody.data.checks.find((check) => check.id === "installation.identity")?.message).toContain(
      "does not agree",
    );
  });

  it("reports committed WAL state that the main database file alone does not contain", () => {
    const parent = makeTempDir("sorage-preflight-e2e-wal-");
    const home = join(parent, "home");
    mkdirSync(home);
    writeInstallation(home);
    const source = join(home, "state", "sorage.sqlite3");
    const held = new Database(source);
    try {
      held.exec("PRAGMA wal_autocheckpoint = 0");
      held.prepare("UPDATE installation SET installation_id = ? WHERE id = 1").run(OTHER_ID);
      const live = held.prepare("SELECT installation_id FROM installation WHERE id = 1").get() as {
        installation_id: string;
      };
      expect(live.installation_id).toBe(OTHER_ID);
      const copy = join(parent, "main-only.sqlite3");
      copyFileSync(source, copy);
      const mainOnly = new Database(copy);
      const mainId = (
        mainOnly.prepare("SELECT installation_id FROM installation WHERE id = 1").get() as { installation_id: string }
      ).installation_id;
      mainOnly.close();
      expect(mainId).toBe(INSTALLATION_ID);
      expect(lstatSync(`${source}-wal`).size).toBeGreaterThan(0);
      const body = expectInspection(
        home,
        [home],
        [join(home, "state", "sorage.sqlite3-journal")],
        "recovery_required",
        78,
      );
      expect(body.data.checks.find((check) => check.id === "installation.identity")?.message).toContain(
        "does not agree",
      );
      expect(existsSync(`${source}-wal`)).toBe(true);
      expect(existsSync(`${source}-shm`)).toBe(true);
    } finally {
      held.close();
    }
  });

  it("leaves a missing SHM absent and a stale SHM unchanged on the source", () => {
    const missingHome = makeTempDir("sorage-preflight-e2e-shm-missing-");
    writeInstallation(missingHome);
    const missingSource = join(missingHome, "state", "sorage.sqlite3");
    const held = new Database(missingSource);
    try {
      held.exec("PRAGMA wal_autocheckpoint = 0");
      held.exec("UPDATE installation SET schema_version = schema_version");
      rmSync(`${missingSource}-shm`, { force: true });
      expect(existsSync(`${missingSource}-shm`)).toBe(false);
      expectInspection(
        missingHome,
        [missingHome],
        [`${missingSource}-shm`, `${missingSource}-journal`],
        "compatible",
        0,
      );
    } finally {
      held.close();
    }

    const staleHome = makeTempDir("sorage-preflight-e2e-shm-stale-");
    writeInstallation(staleHome);
    const staleShm = join(staleHome, "state", "sorage.sqlite3-shm");
    writeFileSync(staleShm, "stale-shm");
    const staleBytes = readFileSync(staleShm);
    expectInspection(staleHome, [staleHome], dormant(staleHome), "compatible", 0);
    expect(readFileSync(staleShm)).toEqual(staleBytes);
  });

  it("allows a stable home alias and a configured external Vault alias", () => {
    const parent = makeTempDir("sorage-preflight-e2e-alias-");
    const home = join(parent, "home");
    const external = join(parent, "external-vault");
    const alias = join(parent, "alias");
    mkdirSync(home);
    writeInstallation(home);
    renameSync(join(home, "vault"), external);
    symlinkSync(external, join(home, "vault"));
    symlinkSync(home, alias);
    const body = expectInspection(alias, [home, external, alias], dormant(home), "compatible", 0);
    expect(body.data.checks.find((check) => check.id === "vault.marker")?.message).toContain("supported");
  });

  it("fails closed for linked managed files, escaping links, and a broken root", () => {
    const linked = makeTempDir("sorage-preflight-e2e-linked-");
    writeInstallation(linked);
    const config = join(linked, "config.yaml");
    const movedConfig = join(linked, "config-real.yaml");
    copyFileSync(config, movedConfig);
    rmSync(config);
    symlinkSync(movedConfig, config);
    const database = join(linked, "state", "sorage.sqlite3");
    const movedDatabase = join(linked, "state", "sorage-real.sqlite3");
    copyFileSync(database, movedDatabase);
    rmSync(database);
    symlinkSync(movedDatabase, database);
    expectInspection(linked, [linked], dormant(linked), "unverifiable", 75);

    const escaping = makeTempDir("sorage-preflight-e2e-escaping-");
    const outside = makeTempDir("sorage-preflight-e2e-outside-");
    writeInstallation(escaping);
    const leak = join(outside, "secret");
    writeFileSync(leak, "secret");
    symlinkSync(leak, join(escaping, "state", "leak"));
    const runOutside = join(outside, "run-target");
    mkdirSync(runOutside);
    rmSync(join(escaping, "run"), { recursive: true });
    symlinkSync(runOutside, join(escaping, "run"));
    expectInspection(escaping, [escaping, outside], [], "unverifiable", 75);

    const parent = makeTempDir("sorage-preflight-e2e-broken-");
    const broken = join(parent, "broken");
    symlinkSync(join(parent, "missing-target"), broken);
    const evidence = storageProof(broken);
    expect(evidence).not.toEqual(["absent"]);
    expect(evidence[0]).toMatch(/^l \. \d+ [\d.]+ \d+:\d+ /);
    expect(evidence[0]).toContain("missing-target");
    const brokenBody = expectInspection(broken, [broken], [], "unverifiable", 75, true);
    expect(brokenBody.data.checks.find((check) => check.id === "home.state")?.message).toContain("not fresh");
  });

  it("does not claim a hash for a file or home it cannot read", () => {
    const deniedFile = makeTempDir("sorage-preflight-e2e-denied-file-");
    writeInstallation(deniedFile);
    const config = join(deniedFile, "config.yaml");
    const configFd = openSync(config, "r");
    const configHash = hashFd(configFd);
    const configMode = lstatSync(config).mode;
    const fileBefore = storageProof(deniedFile);
    chmodSync(config, 0);
    try {
      const seen = inspect(deniedFile);
      expect(seen.status).toBe(75);
      expect(seen.body.data.status).toBe("unverifiable");
      expect(seen.body.data.checks.find((check) => check.id === "config.schema")?.message).toBe(
        "This check could not be verified.",
      );
      expect(JSON.stringify(seen.body)).not.toContain(configHash);
      expect(hashFd(configFd)).toBe(configHash);
    } finally {
      chmodSync(config, configMode);
      closeSync(configFd);
    }
    expect(storageProof(deniedFile)).toEqual(fileBefore);

    const deniedHome = makeTempDir("sorage-preflight-e2e-denied-home-");
    writeInstallation(deniedHome);
    const sentinel = join(deniedHome, "config.yaml");
    const homeFd = openSync(sentinel, "r");
    const homeHash = hashFd(homeFd);
    const homeMode = lstatSync(deniedHome).mode;
    const homeBefore = storageProof(deniedHome);
    chmodSync(deniedHome, 0);
    try {
      const seen = inspect(deniedHome);
      expect(seen.status).toBe(75);
      expect(seen.body.data.status).toBe("unverifiable");
      expect(seen.body.data.checks.find((check) => check.id === "home.state")?.message).toContain(
        "cannot be read, so it is not fresh",
      );
      expect(JSON.stringify(seen.body)).not.toContain(homeHash);
      expect(hashFd(homeFd)).toBe(homeHash);
    } finally {
      chmodSync(deniedHome, homeMode);
      closeSync(homeFd);
    }
    expect(storageProof(deniedHome)).toEqual(homeBefore);
  });

  it("keeps live, dead, and malformed fences, and does not treat migration_lock as a live owner", () => {
    const live = makeTempDir("sorage-preflight-e2e-fence-live-");
    writeInstallation(live);
    const liveLock = join(live, "run", "vault-move.lock");
    const liveBody = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" });
    writeFileSync(liveLock, liveBody);
    expectInspection(live, [live], dormant(live), "unverifiable", 75);
    expect(readFileSync(liveLock, "utf8")).toBe(liveBody);

    const dead = makeTempDir("sorage-preflight-e2e-fence-dead-");
    writeInstallation(dead);
    const deadLock = join(dead, "run", "vault-move.lock");
    const deadBody = JSON.stringify({ pid: 999_999_999, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" });
    writeFileSync(deadLock, deadBody);
    const deadReport = expectInspection(dead, [dead], dormant(dead), "compatible", 0);
    expect(deadReport.data.checks.find((check) => check.id === "source.snapshot")?.message).toContain("left untouched");
    expect(readFileSync(deadLock, "utf8")).toBe(deadBody);

    const malformed = makeTempDir("sorage-preflight-e2e-fence-malformed-");
    writeInstallation(malformed);
    const malformedLock = join(malformed, "run", "vault-move.lock");
    writeFileSync(malformedLock, "not-json");
    const malformedReport = expectInspection(malformed, [malformed], dormant(malformed), "compatible", 0);
    expect(malformedReport.data.checks.find((check) => check.id === "source.snapshot")?.message).toContain(
      "left untouched",
    );
    expect(readFileSync(malformedLock, "utf8")).toBe("not-json");

    const liveDb = makeTempDir("sorage-preflight-e2e-db-fence-live-");
    writeInstallation(liveDb);
    const liveFence = new Database(join(liveDb, "state", "sorage.sqlite3"));
    liveFence
      .prepare("INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?)")
      .run(process.pid, "2026-01-01T00:00:00.000Z");
    liveFence.exec("PRAGMA wal_checkpoint(PASSIVE)");
    liveFence.close();
    expectInspection(liveDb, [liveDb], dormant(liveDb), "unverifiable", 75);
    expect(
      readDatabaseCopy(
        liveDb,
        (db) =>
          (db.prepare("SELECT move_fence_pid FROM vault_state WHERE id = 1").get() as { move_fence_pid: number })
            .move_fence_pid,
      ),
    ).toBe(process.pid);

    const staleDb = makeTempDir("sorage-preflight-e2e-db-fence-stale-");
    writeInstallation(staleDb);
    const staleFence = new Database(join(staleDb, "state", "sorage.sqlite3"));
    staleFence
      .prepare("INSERT INTO vault_state (id, move_fence_pid, move_fence_at) VALUES (1, ?, ?)")
      .run(999_999_999, "2026-01-01T00:00:00.000Z");
    staleFence.exec("PRAGMA wal_checkpoint(PASSIVE)");
    staleFence.close();
    const staleReport = expectInspection(staleDb, [staleDb], dormant(staleDb), "compatible", 0);
    expect(staleReport.data.checks.find((check) => check.id === "source.snapshot")?.message).toContain(
      "left untouched",
    );
    expect(
      readDatabaseCopy(
        staleDb,
        (db) =>
          (db.prepare("SELECT move_fence_pid FROM vault_state WHERE id = 1").get() as { move_fence_pid: number })
            .move_fence_pid,
      ),
    ).toBe(999_999_999);

    const rowOnly = makeTempDir("sorage-preflight-e2e-migration-lock-");
    writeInstallation(rowOnly);
    expect(existsSync(join(rowOnly, "run", "migration.lock"))).toBe(false);
    const rowReport = expectInspection(rowOnly, [rowOnly], dormant(rowOnly), "compatible", 0);
    expect(rowReport.data.checks.find((check) => check.id === "source.snapshot")?.message).toContain("coherent");
    expect(
      readDatabaseCopy(rowOnly, (db) => (db.prepare("SELECT id FROM migration_lock").get() as { id: number }).id),
    ).toBe(1);
  });

  it("preserves populated pre-Memo data and separates backup guidance from the restore drill", () => {
    const parent = makeTempDir("sorage-preflight-e2e-pre-memo-data-");
    const home = join(parent, "home");
    const directory = join(parent, "directory-project");
    const gitDirectory = join(parent, "git-project");
    mkdirSync(home);
    mkdirSync(directory);
    initGitProject(gitDirectory);
    writeInstallation(home, 6);
    populateDomain(home, directory, gitDirectory);
    expectGitInventory(gitDirectory);
    const body = expectInspection(home, [home, directory, gitDirectory], dormant(home), "upgrade_required", 78, true);
    const schema = body.data.checks.find((check) => check.id === "db.schema")?.message ?? "";
    const preparation = body.data.checks.find((check) => check.id === "upgrade.preparation")?.message ?? "";
    expect(schema).toContain("needs migration");
    expect(schema).not.toContain("old binary");
    expect(preparation).toContain("old binary");
    expect(preparation).toContain("separate restore drill");
    expect(preparation).toContain("does not confirm that an external drill already happened");
    expect(preparation).not.toBe(schema);
    const preserved = readDatabaseCopy(home, (db) => ({
      names: (db.prepare("SELECT name FROM schema_migrations ORDER BY version").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
      memo: db.prepare("SELECT name FROM sqlite_master WHERE name = 'project_memos'").get(),
      slug: (db.prepare("SELECT slug FROM projects WHERE id = 'p1'").get() as { slug: string }).slug,
      bindings: (
        db.prepare("SELECT binding_kind FROM project_bindings ORDER BY id").all() as Array<{ binding_kind: string }>
      ).map((row) => row.binding_kind),
      receipt: (db.prepare("SELECT key FROM idempotency_keys").get() as { key: string }).key,
      backup: (db.prepare("SELECT id FROM backup_runs").get() as { id: string }).id,
    }));
    expect(preserved.names).toEqual([
      "operational-baseline-v1",
      "project-registry-v1",
      "intent-log-v1",
      "handoff-domain-v1",
      "vault-move-fence-v1",
      "backup-runs-v1",
    ]);
    expect(preserved.memo).toBeUndefined();
    expect(preserved.slug).toBe("demo");
    expect(preserved.bindings).toEqual(["directory", "git_repository"]);
    expect(preserved.receipt).toBe("receipt-1");
    expect(preserved.backup).toBe("run-1");
  });

  it("accepts a current installation when the optional installation row is absent", () => {
    const home = makeTempDir("sorage-preflight-e2e-no-row-");
    writeInstallation(home);
    const db = new Database(join(home, "state", "sorage.sqlite3"));
    db.exec("DELETE FROM installation");
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    db.close();
    expectInspection(home, [home], dormant(home), "compatible", 0, true);
    expect(
      readDatabaseCopy(
        home,
        (database) => (database.prepare("SELECT COUNT(*) AS n FROM installation").get() as { n: number }).n,
      ),
    ).toBe(0);
  });

  it("reports corrupt database bytes and a foreign-key failure as recovery_required", () => {
    const corrupt = makeTempDir("sorage-preflight-e2e-corrupt-");
    writeInstallation(corrupt);
    const corruptPath = join(corrupt, "state", "sorage.sqlite3");
    const sizing = new Database(corruptPath);
    sizing.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const pageSize = (sizing.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    sizing.close();
    rmSync(`${corruptPath}-wal`, { force: true });
    rmSync(`${corruptPath}-shm`, { force: true });
    const bytes = readFileSync(corruptPath);
    const offset = pageSize * 2 + 20;
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    writeFileSync(corruptPath, bytes);
    const corruptBody = expectInspection(
      corrupt,
      [corrupt],
      [`${corruptPath}-wal`, `${corruptPath}-shm`, `${corruptPath}-journal`],
      "recovery_required",
      78,
      true,
    );
    expect(corruptBody.data.status).not.toBe("fresh");
    expect(corruptBody.data.checks.find((check) => check.id === "db.integrity")?.message).toContain(
      "Integrity checks failed",
    );

    const foreign = makeTempDir("sorage-preflight-e2e-fk-");
    writeInstallation(foreign);
    const foreignDb = new Database(join(foreign, "state", "sorage.sqlite3"));
    foreignDb.exec("PRAGMA foreign_keys = OFF");
    foreignDb
      .prepare(
        "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b-missing', 'missing-project', ?, '/tmp/missing', 'directory', ?, ?)",
      )
      .run(INSTALLATION_ID, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    foreignDb.exec("PRAGMA wal_checkpoint(PASSIVE)");
    foreignDb.close();
    const foreignBody = expectInspection(foreign, [foreign], dormant(foreign), "recovery_required", 78);
    expect(foreignBody.data.status).not.toBe("fresh");
    expect(foreignBody.data.checks.find((check) => check.id === "db.integrity")?.message).toContain(
      "Integrity checks failed",
    );
  });

  it("does not call missing config, a missing database, or unknown residue fresh", () => {
    const missingConfig = makeTempDir("sorage-preflight-e2e-missing-config-");
    writeInstallation(missingConfig);
    rmSync(join(missingConfig, "config.yaml"));
    const configBody = expectInspection(
      missingConfig,
      [missingConfig],
      dormant(missingConfig),
      "recovery_required",
      78,
    );
    expect(configBody.data.status).not.toBe("fresh");
    expect(configBody.data.checks.find((check) => check.id === "home.state")?.message).toContain("partial");

    const missingDb = makeTempDir("sorage-preflight-e2e-missing-db-");
    writeInstallation(missingDb);
    const database = join(missingDb, "state", "sorage.sqlite3");
    rmSync(database);
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });
    const databaseBody = expectInspection(
      missingDb,
      [missingDb],
      [`${database}`, `${database}-wal`, `${database}-shm`, `${database}-journal`],
      "recovery_required",
      78,
    );
    expect(databaseBody.data.status).not.toBe("fresh");
    expect(databaseBody.data.checks.find((check) => check.id === "home.state")?.message).toContain("partial");

    const unknown = makeTempDir("sorage-preflight-e2e-unknown-");
    writeFileSync(join(unknown, "notes.txt"), "notes\n");
    const unknownBody = expectInspection(unknown, [unknown], [], "recovery_required", 78);
    expect(unknownBody.data.status).not.toBe("fresh");
    expect(unknownBody.data.checks.find((check) => check.id === "home.state")?.message).toContain(
      "not a known installation",
    );
  });

  it("reports a coherent snapshot while a writer holds the database open", () => {
    const home = makeTempDir("sorage-preflight-e2e-writer-");
    writeInstallation(home);
    const held = new Database(join(home, "state", "sorage.sqlite3"));
    try {
      held.exec("BEGIN IMMEDIATE");
      const body = expectInspection(home, [home], dormant(home), "compatible", 0);
      expect(body.data.status).toBe("compatible");
      held.exec("COMMIT");
    } finally {
      held.close();
    }
  });

  it("separates commits made by an owned actor during inspection from the quiescent inventory", async () => {
    const parent = makeTempDir("sorage-preflight-e2e-actor-");
    const home = join(parent, "home");
    const progress = join(parent, "actor-progress.log");
    mkdirSync(home);
    writeInstallation(home);
    const configBefore = storageProof(join(home, "config.yaml"));
    const vaultBefore = storageProof(join(home, "vault"));
    const logsBefore = storageProof(join(home, "logs"));
    const actor = spawn("bun", [fileURLToPath(new URL("./preflight-actor.ts", import.meta.url)), home, progress], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    actor.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    try {
      await waitForProgress(progress);
      const beforeCount = readFileSync(progress, "utf8").trim().split("\n").length;
      const started = Date.now();
      const report = sorage(["preflight", "--json"], { home });
      const finished = Date.now();
      expect(report.stderr).toBe("");
      const body = JSON.parse(report.stdout) as CompiledReport;
      expectContract(body);
      if (body.data.status === "compatible") expect(report.status).toBe(0);
      else if (body.data.status === "unverifiable") expect(report.status).toBe(75);
      else throw new Error(`actor inspection returned ${body.data.status} exit ${report.status}: ${stderr}`);
      const lines = readFileSync(progress, "utf8").trim().split("\n");
      const during = lines
        .map((line) => Number(line.split(" ")[0]))
        .filter((stamp) => stamp >= started && stamp <= finished);
      expect(lines.length).toBeGreaterThan(beforeCount);
      expect(during.length).toBeGreaterThan(0);
      expect(storageProof(join(home, "config.yaml"))).toEqual(configBefore);
      expect(storageProof(join(home, "vault"))).toEqual(vaultBefore);
      expect(storageProof(join(home, "logs"))).toEqual(logsBefore);
    } finally {
      await stopActor(actor);
    }
    expect(actor.exitCode !== null || actor.signalCode !== null).toBe(true);
    const quiescent = storageProof(home);
    for (const path of dormant(home)) expect(existsSync(path)).toBe(false);
    const stable = inspect(home);
    expect(stable.status).toBe(0);
    expect(stable.body.data.status).toBe("compatible");
    expect(storageProof(home)).toEqual(quiescent);
    for (const path of dormant(home)) expect(existsSync(path)).toBe(false);
  });

  it("removes private scratch from a child TMPDIR and leaves the parent TMPDIR unchanged", () => {
    const parentTmp = process.env.TMPDIR;
    const parent = makeTempDir("sorage-preflight-e2e-scratch-parent-");
    const home = join(parent, "home");
    const owned = join(parent, "owned-tmp");
    mkdirSync(home);
    mkdirSync(owned);
    writeInstallation(home);
    const beforeHome = storageProof(home);
    const beforeVault = storageProof(join(home, "vault"));
    const beforeOwned = lstatSync(owned).mtimeMs;
    const report = sorage(["preflight", "--json"], { home, env: { TMPDIR: owned } });
    expect(process.env.TMPDIR).toBe(parentTmp);
    expect(report.status).toBe(0);
    expect(report.stderr).toBe("");
    const body = JSON.parse(report.stdout) as CompiledReport;
    expectContract(body);
    expect(body.data.status).toBe("compatible");
    expect(readdirSync(owned).filter((name) => name.startsWith("sorage-preflight-"))).toEqual([]);
    expect(lstatSync(owned).mtimeMs).not.toBe(beforeOwned);
    expect(storageProof(home)).toEqual(beforeHome);
    expect(storageProof(join(home, "vault"))).toEqual(beforeVault);
  });
});

const CHECK_IDS = [
  "home.state",
  "source.snapshot",
  "config.schema",
  "db.schema",
  "db.integrity",
  "vault.marker",
  "installation.identity",
  "upgrade.preparation",
] as const;

interface CompiledReport {
  ok: boolean;
  data: {
    contractVersion: number;
    status: string;
    checks: Array<{ id: string; severity: string; message: string }>;
  };
}

function expectContract(body: CompiledReport): void {
  expect(body.ok).toBe(true);
  expect(body.data.contractVersion).toBe(1);
  expect(body.data.checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
}

function inspect(home: string): { status: number | null; body: CompiledReport } {
  const report = sorage(["preflight", "--json"], { home });
  expect(report.stderr).toBe("");
  const body = JSON.parse(report.stdout) as CompiledReport;
  expectContract(body);
  return { status: report.status, body };
}

function expectHuman(home: string, status: string, exitCode: number): void {
  const human = sorage(["preflight"], { home });
  expect(human.status).toBe(exitCode);
  expect(human.stderr).toBe("");
  expect(human.stdout).toContain(`Preflight status: ${status}`);
  for (const id of CHECK_IDS) expect(human.stdout).toContain(id);
}

function expectInspection(
  home: string,
  roots: string[],
  absent: string[],
  status: string,
  exitCode: number,
  human = false,
): CompiledReport {
  const before = roots.map((root) => storageProof(root));
  for (const path of absent) expect(existsSync(path)).toBe(false);
  const seen = inspect(home);
  expect(seen.status).toBe(exitCode);
  expect(seen.body.data.status).toBe(status);
  if (human) expectHuman(home, status, exitCode);
  expect(roots.map((root) => storageProof(root))).toEqual(before);
  for (const path of absent) expect(existsSync(path)).toBe(false);
  return seen.body;
}

function initGitProject(directory: string): void {
  mkdirSync(directory);
  git(directory, ["init", "--initial-branch=main"]);
  writeFileSync(join(directory, "README.md"), "# project\n");
  git(directory, ["add", "."]);
  git(directory, ["-c", "user.name=Journey", "-c", "user.email=journey@example.invalid", "commit", "-m", "init"]);
}

function expectGitInventory(directory: string): void {
  const proof = storageProof(directory);
  expect(proof.some((row) => row.startsWith("d .git "))).toBe(true);
  expect(proof.some((row) => row.startsWith("f .git/HEAD "))).toBe(true);
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function waitForProgress(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path).length > 0) return;
    const pause = delay(20);
    await pause.promise;
  }
  throw new Error("actor produced no commits");
}

function watchStop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const done = (): void => {
      child.off("exit", done);
      child.off("close", done);
      resolve();
    };
    child.on("exit", done);
    child.on("close", done);
    if (child.exitCode !== null || child.signalCode !== null) done();
  });
}

function signalActor(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // A missed signal still has to be proven by the exit or close event.
  }
}

async function stopActor(child: ChildProcess): Promise<void> {
  const watched = watchStop(child);
  signalActor(child, "SIGTERM");
  const bounded = delay(2_000);
  const stopped = await Promise.race([watched.then(() => true), bounded.promise.then(() => false)]);
  bounded.cancel();
  if (!stopped) {
    signalActor(child, "SIGKILL");
    await watchStop(child);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error("owned actor did not exit");
}

function dormant(home: string): string[] {
  return [join(home, "state", "sorage.sqlite3-journal"), join(home, "run", "migration.lock")];
}

function hashFd(fd: number): string {
  const size = fstatSync(fd).size;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, buffer, offset, size - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return createHash("sha256").update(buffer.subarray(0, offset)).digest("hex");
}

function readDatabaseCopy<T>(home: string, read: (db: Database) => T): T {
  const scratch = makeTempDir("sorage-preflight-e2e-read-");
  const source = join(home, "state", "sorage.sqlite3");
  const copy = join(scratch, "sorage.sqlite3");
  copyFileSync(source, copy);
  const wal = `${source}-wal`;
  if (existsSync(wal)) copyFileSync(wal, `${copy}-wal`);
  const db = new Database(copy);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function relativeNames(root: string): string[] {
  const names: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      names.push(relative(root, path));
      if (lstatSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return names.sort();
}

function expectUnsupported(home: string, checkId: string, human = false): void {
  const before = storageProof(home);
  const seen = inspect(home);
  expect(seen.status).toBe(78);
  expect(seen.body.data.status).toBe("unsupported");
  expect(seen.body.data.checks.find((check) => check.id === checkId)?.message).toContain("newer");
  if (human) expectHuman(home, "unsupported", 78);
  expect(storageProof(home)).toEqual(before);
}
