import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupRestore,
  backupVerify,
  type ExchangeSnapshotRecord,
  exportSnapshot,
  initializeInstallation,
  type Result,
  runBackupCommand,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { EXCHANGE_FOUNDATION_TABLES, readExchangeRecords, restoreExchangeRecords } from "../../src/exchange-records";
import { createExchangeWorkingStore } from "../../src/exchange-working-store";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { openAndMigrate } from "../../src/sqlite/migrator";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const EXCHANGE = "33333333-3333-4333-8333-333333333333";
const STAGED = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-20T00:00:00.000Z";
const DIGEST = createHash("sha256").update("body").digest("hex");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function homeFixture() {
  const home = mkdtempSync(join(tmpdir(), "sorage-exchange-foundation-"));
  homes.push(home);
  const options = { env: { SORAGE_HOME: home }, userHome: home };
  const vaultPath = join(home, "vault");
  const stateDir = join(home, "state");
  unwrap(initializeInstallation(createNodeInitPorts(options), { vaultPath }));
  return {
    ...options,
    home,
    vaultPath,
    stateDir,
    database: join(stateDir, "sorage.sqlite3"),
    ports: createNodeBackupCommandPorts(options),
    workingDir: join(stateDir, "exchange-working"),
    snapshots: join(vaultPath, "snapshots"),
  };
}

const compact: ExchangeSnapshotRecord = {
  id: EXCHANGE,
  openingProjectId: PROJECT,
  createdAt: NOW,
  goal: "Keep only compact workflow facts",
  criteria: ["Verify the backup"],
  members: [PROJECT, PEER],
  readRanges: [
    { projectId: PEER, firstSeq: 2, lastSeq: 3 },
    { projectId: PEER, firstSeq: 5, lastSeq: 6 },
  ],
  creationOutcomes: [{ projectId: PROJECT, operationId: "synthetic-create", fingerprint: DIGEST }],
};

function seed(db: SorageSqlite): void {
  for (const [id, slug] of [
    [PROJECT, "owner"],
    [PEER, "peer"],
  ]) {
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).run(id, slug, slug, NOW, NOW);
  }
  restoreExchangeRecords(db, [compact]);
}

function counts(db: SorageSqlite, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function sourceRestorePorts(target: ReturnType<typeof homeFixture>, source: ReturnType<typeof homeFixture>) {
  return unwrap(
    createNodeBackupCommandPorts({
      env: target.env,
      userHome: target.userHome,
      sourcePath: source.vaultPath,
    }).restorePorts(),
  );
}

function restore(target: ReturnType<typeof homeFixture>, source: ReturnType<typeof homeFixture>, dryRun: boolean) {
  return backupRestore(sourceRestorePorts(target, source), { dryRun });
}

function seedActivation(db: SorageSqlite): void {
  db.prepare(
    "INSERT INTO exchange_working_content (id, exchange_id, storage_key, size_bytes, sha256, materialized) VALUES (?, ?, ?, 4, ?, 0)",
  ).run(STAGED, EXCHANGE, `content/${STAGED}`, DIGEST);
  db.prepare("INSERT INTO exchange_activation_intents (content_id, staging_key) VALUES (?, ?)").run(
    STAGED,
    `staging/${STAGED}`,
  );
}

describe("the real SQLite Exchange storage foundation", () => {
  it("appends schema 13 to an actual schema-12 file without changing existing records", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-exchange-upgrade-"));
    homes.push(home);
    const path = join(home, "prior.sqlite3");
    const plan = productionMigrationPlan();
    const prior = openAndMigrate(
      path,
      plan.migrations.filter((step) => step.version < 13),
      { rebuilds: plan.rebuilds },
    );
    prior.db
      .prepare(
        "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, 'owner', 'Owner', 'active', ?, ?)",
      )
      .run(PROJECT, NOW, NOW);
    const projects = prior.db.prepare("SELECT * FROM projects").all();
    const ledger = prior.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    prior.db.close();
    const current = openAndMigrate(path, plan.migrations, { rebuilds: plan.rebuilds });
    try {
      expect(current.db.prepare("SELECT * FROM projects").all()).toEqual(projects);
      const migrated = current.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      expect(migrated.slice(0, 12)).toEqual(ledger);
      expect(migrated[12]).toMatchObject({ version: 13, name: "exchange-foundation" });
      expect(readExchangeRecords(current.db)).toEqual([]);
      expect(current.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      current.db.close();
    }
    const reopened = openAndMigrate(path, plan.migrations, { rebuilds: plan.rebuilds });
    try {
      expect(counts(reopened.db, "schema_migrations")).toBe(14);
    } finally {
      reopened.db.close();
    }
  });

  it("routes byte-exact text and binary under state, rejecting excess streamed bytes before commit", () => {
    const f = homeFixture();
    const db = openSorageDatabase(f.database);
    try {
      seed(db);
      const store = createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.vaultPath });
      const text = Buffer.from("\uFEFFx\r\n");
      const inline = unwrap(
        store.write({ exchangeId: EXCHANGE, classification: "text", maxBytes: 65536, chunks: [text] }),
      );
      expect(
        db
          .prepare(
            "SELECT HEX(CAST(inline_text AS BLOB)) AS bytes, storage_key FROM exchange_working_content WHERE id = ?",
          )
          .get(inline.id),
      ).toMatchObject({ bytes: text.toString("hex").toUpperCase(), storage_key: null });
      expect(existsSync(f.workingDir)).toBe(false);

      const edge = Buffer.alloc(65536, 0x61);
      const atLimit = unwrap(
        store.write({ exchangeId: EXCHANGE, classification: "text", maxBytes: edge.length, chunks: [edge] }),
      );
      expect(db.prepare("SELECT storage_key FROM exchange_working_content WHERE id = ?").get(atLimit.id)).toEqual({
        storage_key: null,
      });
      const chunks = [edge, Buffer.from("x")];
      const file = unwrap(store.write({ exchangeId: EXCHANGE, classification: "text", maxBytes: 70000, chunks }));
      expect(readFileSync(join(f.workingDir, "content", file.id))).toEqual(Buffer.concat(chunks));
      expect(file.sha256).toEqual(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
      const binary = unwrap(
        store.write({ exchangeId: EXCHANGE, classification: "binary", maxBytes: text.length, chunks: [text] }),
      );
      expect(readFileSync(join(f.workingDir, "content", binary.id))).toEqual(text);
      const invalid = Buffer.from([0xfe, 0x61]);
      const invalidText = unwrap(
        store.write({ exchangeId: EXCHANGE, classification: "text", maxBytes: 2, chunks: [invalid] }),
      );
      expect(readFileSync(join(f.workingDir, "content", invalidText.id))).toEqual(invalid);
      expect(
        store.write({ exchangeId: EXCHANGE, classification: "binary", maxBytes: edge.length, chunks }),
      ).toMatchObject({ ok: false, error: { code: "ARTIFACT_TOO_LARGE" } });
      expect(readdirSync(join(f.workingDir, "staging"))).toEqual([]);
      expect(counts(db, "exchange_working_content")).toBe(5);
      expect(counts(db, "exchange_activation_intents")).toBe(0);
      expect(existsSync(join(f.vaultPath, "content", file.id))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("fences both Vault overlaps and never follows a managed working-root symlink", () => {
    const f = homeFixture();
    const db = openSorageDatabase(f.database);
    try {
      seed(db);
      const body = {
        exchangeId: EXCHANGE,
        classification: "binary" as const,
        maxBytes: 4,
        chunks: [Buffer.from("body")],
      };
      expect(createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.home }).write(body)).toMatchObject({
        ok: false,
        error: { code: "STORAGE_INTEGRITY_ERROR" },
      });
      mkdirSync(join(f.workingDir, "nested-vault"), { recursive: true });
      expect(
        createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: join(f.workingDir, "nested-vault") }).write(
          body,
        ),
      ).toMatchObject({ ok: false, error: { code: "STORAGE_INTEGRITY_ERROR" } });
      rmSync(f.workingDir, { recursive: true });
      symlinkSync(f.vaultPath, f.workingDir);
      expect(
        createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.vaultPath }).write(body),
      ).toMatchObject({ ok: false, error: { code: "STORAGE_INTEGRITY_ERROR" } });
      expect(counts(db, "exchange_working_content")).toBe(0);
      expect(existsSync(join(f.vaultPath, "content", "body"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it.each(["before placement", "after unlinking the stage", "after removing the staging directory"])(
    "recovers interrupted activation %s",
    (phase) => {
      const f = homeFixture();
      const db = openSorageDatabase(f.database);
      try {
        seed(db);
        const store = createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.vaultPath });
        mkdirSync(join(f.workingDir, "staging"), { recursive: true });
        seedActivation(db);
        expect(store.drain()).toMatchObject({ ok: false, error: { code: "STORAGE_INTEGRITY_ERROR" } });
        expect(db.prepare("SELECT attempts FROM exchange_activation_intents").get()).toEqual({ attempts: 1 });
        const directory = phase === "before placement" ? "staging" : "content";
        mkdirSync(join(f.workingDir, directory), { recursive: true });
        writeFileSync(join(f.workingDir, directory, STAGED), "body");
        const staging = join(f.workingDir, "staging");
        if (phase === "after removing the staging directory") rmSync(staging, { recursive: true });
        expect(unwrap(store.drain())).toEqual([STAGED]);
        expect(unwrap(store.drain())).toEqual([]);
        expect(readFileSync(join(f.workingDir, "content", STAGED), "utf8")).toBe("body");
        expect(existsSync(join(staging, STAGED))).toBe(false);
        expect(existsSync(staging)).toBe(phase !== "after removing the staging directory");
        expect(db.prepare("SELECT materialized FROM exchange_working_content").get()).toEqual({ materialized: 1 });
      } finally {
        db.close();
      }
    },
  );

  it.each(["corrupt stage", "conflicting destination"])("protects files and keeps the intent with a %s", (defect) => {
    const f = homeFixture();
    const db = openSorageDatabase(f.database);
    try {
      seed(db);
      seedActivation(db);
      const store = createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.vaultPath });
      const stage = join(f.workingDir, "staging", STAGED);
      const dest = join(f.workingDir, "content", STAGED);
      mkdirSync(join(f.workingDir, "staging"), { recursive: true });
      const corruptStage = defect === "corrupt stage";
      writeFileSync(stage, corruptStage ? "fail" : "body");
      if (!corruptStage) {
        mkdirSync(join(f.workingDir, "content"));
        writeFileSync(dest, "kept");
      }
      expect(store.drain()).toMatchObject({
        ok: false,
        error: {
          code: "STORAGE_INTEGRITY_ERROR",
          details: { cause: expect.stringContaining("recorded size and digest") },
        },
      });
      expect(readFileSync(stage, "utf8")).toBe(corruptStage ? "fail" : "body");
      if (corruptStage) expect(existsSync(dest)).toBe(false);
      else expect(readFileSync(dest, "utf8")).toBe("kept");
      expect(db.prepare("SELECT materialized FROM exchange_working_content").get()).toEqual({ materialized: 0 });
      expect(db.prepare("SELECT attempts FROM exchange_activation_intents").get()).toEqual({ attempts: 1 });
      if (corruptStage) writeFileSync(stage, "body");
      else rmSync(dest);
      expect(unwrap(store.drain())).toEqual([STAGED]);
      expect(readFileSync(dest, "utf8")).toBe("body");
      expect(counts(db, "exchange_activation_intents")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses an unsafe staging parent even when the destination has verified bytes", () => {
    const f = homeFixture();
    const db = openSorageDatabase(f.database);
    try {
      seed(db);
      seedActivation(db);
      const content = join(f.workingDir, "content");
      mkdirSync(content, { recursive: true });
      writeFileSync(join(content, STAGED), "body");
      symlinkSync(content, join(f.workingDir, "staging"));
      const store = createExchangeWorkingStore({ db, stateDir: f.stateDir, vaultPath: f.vaultPath });
      expect(store.drain()).toMatchObject({ ok: false, error: { code: "STORAGE_INTEGRITY_ERROR" } });
      expect(readFileSync(join(content, STAGED), "utf8")).toBe("body");
      expect(db.prepare("SELECT materialized FROM exchange_working_content").get()).toEqual({ materialized: 0 });
      expect(counts(db, "exchange_activation_intents")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("runs and verifies shared backup while scoped recovery reports a missing stage", () => {
    const source = homeFixture();
    const db = openSorageDatabase(source.database);
    try {
      seed(db);
      seedActivation(db);
      mkdirSync(source.workingDir);
      const store = createExchangeWorkingStore({ db, stateDir: source.stateDir, vaultPath: source.vaultPath });
      expect(store.drain()).toMatchObject({ ok: false, error: { code: "STORAGE_INTEGRITY_ERROR" } });
      unwrap(source.ports.drainAtStart());
      expect(unwrap(runBackupCommand(unwrap(source.ports.runPorts()), {})).snapshot).toBe("success");
      unwrap(source.ports.drainAtStart());
      expect(backupVerify(unwrap(source.ports.verifyPorts()), { now: new Date(NOW) }).ok).toBe(true);
      expect(db.prepare("SELECT attempts FROM exchange_activation_intents").get()).toEqual({ attempts: 1 });
      expect(db.prepare("SELECT materialized FROM exchange_working_content").get()).toEqual({ materialized: 0 });
      const target = homeFixture();
      expect(restore(target, source, false).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("exports and restores compact format-5 records atomically without working bytes or public census fields", () => {
    const source = homeFixture();
    const db = openSorageDatabase(source.database);
    try {
      seed(db);
      const store = createExchangeWorkingStore({ db, stateDir: source.stateDir, vaultPath: source.vaultPath });
      for (const classification of ["text", "binary"] as const) {
        unwrap(
          store.write({
            exchangeId: EXCHANGE,
            classification,
            maxBytes: 50,
            chunks: [Buffer.from("private-disposable-marker")],
          }),
        );
      }
      expect(counts(db, "events")).toBe(0);
      expect(counts(db, "idempotency_keys")).toBe(0);
    } finally {
      db.close();
    }
    const exportPorts = unwrap(source.ports.exportPorts());
    unwrap(exportSnapshot(exportPorts));
    const inventory = readFileSync(join(source.snapshots, "exchanges.json"), "utf8");
    expect(inventory).not.toContain("private-disposable-marker");
    expect(inventory).not.toContain("storage_key");
    expect(readFileSync(join(source.snapshots, "events.jsonl"), "utf8")).toBe("");
    expect(existsSync(join(source.snapshots, "content"))).toBe(false);
    expect(existsSync(join(source.vaultPath, "exchange-working"))).toBe(false);
    unwrap(exportSnapshot(exportPorts));
    expect(readFileSync(join(source.snapshots, "exchanges.json"), "utf8")).toBe(inventory);
    const verification = unwrap(backupVerify(unwrap(source.ports.verifyPorts()), { now: new Date(NOW) }));
    expect(verification.checked.manifest).not.toHaveProperty("exchanges");
    expect(verification.findings.some((finding) => finding.includes("Exchange record(s)"))).toBe(false);
    const target = homeFixture();
    expect(restore(target, source, true).ok).toBe(true);
    const targetDb = openSorageDatabase(target.database);
    try {
      expect(readExchangeRecords(targetDb)).toEqual([]);
      expect(restore(target, source, false).ok).toBe(true);
      expect(readExchangeRecords(targetDb)).toEqual([compact]);
      for (const table of [
        "project_bindings",
        "exchange_working_content",
        "exchange_activation_intents",
        "idempotency_keys",
      ]) {
        expect(counts(targetDb, table)).toBe(0);
      }
      expect(existsSync(target.workingDir)).toBe(false);
      expect(restore(target, source, false)).toMatchObject({ ok: false, error: { code: "RESTORE_TARGET_NOT_EMPTY" } });
    } finally {
      targetDb.close();
    }
  });

  it.each([
    ["missing", "VAULT_INTEGRITY_ERROR"],
    ["malformed", "VAULT_INTEGRITY_ERROR"],
    ["incompatible with a malformed ledger", "VAULT_SCHEMA_UNSUPPORTED"],
  ] as const)("refuses the Exchange inventory before any target import when %s", (defect, code) => {
    const source = homeFixture();
    const sourceDb = openSorageDatabase(source.database);
    seed(sourceDb);
    sourceDb.close();
    unwrap(exportSnapshot(unwrap(source.ports.exportPorts())));
    const path = join(source.snapshots, "exchanges.json");
    const clean = readFileSync(path, "utf8");
    if (defect === "missing") rmSync(path);
    else if (defect === "malformed") writeFileSync(path, clean.replace('"goal":', '"leaseClaims": [], "goal":'));
    else {
      writeFileSync(
        path,
        clean.replace('"representation": "collaboration"', '"representation": "later-required-class"'),
      );
      writeFileSync(join(source.snapshots, "events.jsonl"), "not-json\n");
    }
    const refusal = { ok: false, error: { code } };
    expect(backupVerify(unwrap(source.ports.verifyPorts()), { now: new Date(NOW) })).toMatchObject(refusal);
    const target = homeFixture();
    const beforeConfig = readFileSync(join(target.home, "config.yaml"));
    const beforeMarker = readFileSync(join(target.vaultPath, ".sorage-vault.json"));
    const db = openSorageDatabase(target.database);
    try {
      for (const dryRun of [true, false]) {
        expect(restore(target, source, dryRun)).toMatchObject(refusal);
        expect(readFileSync(join(target.home, "config.yaml"))).toEqual(beforeConfig);
        expect(readFileSync(join(target.vaultPath, ".sorage-vault.json"))).toEqual(beforeMarker);
        for (const table of ["projects", "events", ...EXCHANGE_FOUNDATION_TABLES]) {
          expect(counts(db, table)).toBe(0);
        }
      }
    } finally {
      db.close();
    }
  });

  it("reports a mismatch between the valid snapshot and the live Exchange census", () => {
    const source = homeFixture();
    const db = openSorageDatabase(source.database);
    try {
      seed(db);
      unwrap(exportSnapshot(unwrap(source.ports.exportPorts())));
      restoreExchangeRecords(db, [{ ...compact, id: STAGED, creationOutcomes: [] }]);
      const result = unwrap(backupVerify(unwrap(source.ports.verifyPorts()), { now: new Date(NOW) }));
      expect(result.findings).toContain("The manifest counts 1 Exchange record(s) against the database's 2.");
      expect(result.checked.manifest).not.toHaveProperty("exchanges");
    } finally {
      db.close();
    }
  });

  it("rechecks target emptiness inside the actual restore transaction", () => {
    const source = homeFixture();
    const sourceDb = openSorageDatabase(source.database);
    seed(sourceDb);
    sourceDb.close();
    unwrap(exportSnapshot(unwrap(source.ports.exportPorts())));
    const target = homeFixture();
    const ports = sourceRestorePorts(target, source);
    const db = openSorageDatabase(target.database);
    try {
      expect(
        backupRestore(
          {
            ...ports,
            rebuildDatabase(data, marker) {
              seed(db);
              return ports.rebuildDatabase(data, marker);
            },
          },
          { dryRun: false },
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "RESTORE_TARGET_NOT_EMPTY", message: "The restore target is no longer empty." },
      });
      expect(readExchangeRecords(db)).toEqual([compact]);
      expect(counts(db, "events")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rolls back Exchange records when a later real SQL write aborts, then restores on retry", () => {
    const source = homeFixture();
    const sourceDb = openSorageDatabase(source.database);
    seed(sourceDb);
    sourceDb.close();
    unwrap(exportSnapshot(unwrap(source.ports.exportPorts())));
    const target = homeFixture();
    const db = openSorageDatabase(target.database);
    try {
      db.exec(`
        CREATE TRIGGER fail_after_exchanges BEFORE INSERT ON events
        WHEN NEW.event_type = 'RESTORE_COMPLETED' AND EXISTS (SELECT 1 FROM exchange_creation_outcomes)
        BEGIN
          SELECT RAISE(ABORT, 'injected failure after Exchange import');
        END;
      `);
      expect(restore(target, source, false)).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: expect.stringContaining("injected failure after Exchange import") },
      });
      for (const table of ["projects", "events", ...EXCHANGE_FOUNDATION_TABLES]) {
        expect(counts(db, table)).toBe(0);
      }
      db.exec("DROP TRIGGER fail_after_exchanges");
      expect(restore(target, source, false).ok).toBe(true);
      expect(readExchangeRecords(db)).toEqual([compact]);
    } finally {
      db.close();
    }
  });
});
