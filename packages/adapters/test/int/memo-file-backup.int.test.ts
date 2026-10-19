import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupRestore, canonicalJson, exportSnapshot, mutateMemo, showMemo } from "@sorage/core";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeConfigCommandPorts } from "../../src/config-command-ports";
import { createNodeMemoPorts } from "../../src/memo-command-ports";
import { activateCommonFile } from "../../src/content-store";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { captureMemoBodyText } from "../../src/memo-body-file";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";
import { MEMO_ID, MEMO_TIME, memoInstallation, seedMemoInstallation, unwrap } from "../fixtures/memo-installation";

// Observe real SQLite and directory-sync operations; faults affect only the
// selected temporary target and never substitute for the restore implementation.
const fault = vi.hoisted(() => ({ target: "", mode: "", trace: [] as string[] }));
vi.mock("../../src/sqlite/migrator", async (original) => {
  const actual = await original<typeof import("../../src/sqlite/migrator")>();
  return {
    ...actual,
    openAndMigrate: (...args: Parameters<typeof actual.openAndMigrate>) => {
      const opened = actual.openAndMigrate(...args);
      const path = args[0];
      const db = opened.db;
      let committed = false;
      const wrapped = {
        exec(sql: string) {
          if (path !== fault.target) return db.exec(sql);
          const statement = sql.trim();
          if (statement === "BEGIN IMMEDIATE") {
            fault.trace.push("begin");
            if (fault.mode === "begin") throw new Error("Injected BEGIN refusal");
          }
          const result = db.exec(sql);
          if (statement === "COMMIT") {
            committed = true;
            fault.trace.push("commit");
            if (fault.mode === "uncertain") throw new Error("Injected lost COMMIT acknowledgment");
          }
          return result;
        },
        prepare(sql: string) {
          if (path === fault.target && fault.mode === "insert" && /INSERT INTO project_memos/.test(sql))
            throw new Error("Injected Memo insert refusal");
          return db.prepare(sql);
        },
        close() {
          db.close();
          if (path === fault.target && committed && fault.mode === "close") throw new Error("Injected close refusal");
        },
      };
      return { ...opened, db: wrapped };
    },
  };
});
vi.mock("../../src/intent-log", async (original) => {
  const actual = await original<typeof import("../../src/intent-log")>();
  return {
    ...actual,
    fsyncDirectory(path: string) {
      fault.trace.push(`sync:${path}`);
      if (fault.mode === "sync" && path.endsWith(MEMO_ID)) throw new Error("Injected directory sync refusal");
      return actual.fsyncDirectory(path);
    },
  };
});

type Installation = ReturnType<typeof memoInstallation>;
const cleanups: Array<() => void> = [];
afterEach(() => {
  fault.mode = "";
  fault.target = "";
  fault.trace = [];
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function installation() {
  const f = memoInstallation();
  cleanups.push(f.cleanup);
  return f;
}
function backup(f: Installation, source?: Installation) {
  return createNodeBackupCommandPorts({
    env: { SORAGE_HOME: f.home },
    userHome: f.home,
    ...(source ? { sourcePath: source.vault } : {}),
  });
}
function lowerCap(f: Installation) {
  const store = createNodeConfigCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).store;
  const snapshot = unwrap(store.read());
  if (snapshot === null) throw new Error("Missing temporary configuration");
  unwrap(
    store.write(
      { ...snapshot.config, artifact: { ...snapshot.config.artifact, maxBytes: 1 } },
      { etag: snapshot.etag },
    ),
  );
}
function bodyFiles(f: Installation): string[] {
  const root = join(f.vault, "content", "memo", MEMO_ID);
  try {
    return readdirSync(root).map((name) => join(root, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function rows(f: Installation, table: string) {
  const db = openSorageDatabase(f.database);
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}
function fileHistory() {
  const f = installation();
  seedMemoInstallation(f, true);
  const ports = createNodeMemoPorts({
    env: { SORAGE_HOME: f.home },
    userHome: f.home,
    clock: new FakeClock(Date.parse(MEMO_TIME) + 1000),
  });
  const body = "\uFEFF" + "x".repeat(65532) + "😀\r\nlone\rfinal";
  const accepted = unwrap(
    captureMemoBodyText(body, { maxBytes: ports.maxBytes, stateDir: ports.stateDir, spoolId: randomUUID() }),
  );
  const key = randomUUID();
  try {
    unwrap(
      mutateMemo(
        ports,
        "update",
        MEMO_ID,
        { expectedRowVersion: 1 },
        { mode: "execute", idempotencyKey: randomUUID() },
        accepted,
      ),
    );
    const receipt = unwrap(
      mutateMemo(
        ports,
        "update",
        MEMO_ID,
        { title: "Backed history", expectedRowVersion: 2 },
        { mode: "execute", idempotencyKey: key },
      ),
    );
    return { ...f, body, memo: receipt.memo, key };
  } finally {
    ports.releaseAcceptedBody(accepted);
    ports.close();
  }
}

describe("file-backed Memo backup and restore", () => {
  it.each([false, true])(
    "refuses a committed pending body before file reads (rename completed: %s), then exports after drain",
    (renamed) => {
      const f = installation();
      seedMemoInstallation(f, true);
      const ports = createNodeMemoPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
      const body = "\uFEFF" + "Pending 😀\r\n".repeat(7000) + "\rfinal";
      const accepted = unwrap(
        captureMemoBodyText(body, { maxBytes: ports.maxBytes, stateDir: ports.stateDir, spoolId: randomUUID() }),
      );
      ports.staging.activateContent = (input, binding) => {
        if (renamed)
          expect(
            activateCommonFile({
              vaultPath: binding.vaultPath,
              fromPath: input.stagedPath,
              toPath: input.storageKey,
              expect: { sizeBytes: input.sizeBytes, sha256: input.sha256 },
            }),
          ).toEqual({ status: "done" });
        return { ok: true, value: { status: "paused" } };
      };
      try {
        expect(
          mutateMemo(
            ports,
            "update",
            MEMO_ID,
            { expectedRowVersion: 1 },
            { mode: "execute", idempotencyKey: randomUUID() },
            accepted,
          ),
        ).toMatchObject({ ok: false, error: { code: "CONTENT_MATERIALIZING" } });
        const tables = ["project_memos", "content_records", "pending_fs_ops", "events", "idempotency_keys"];
        const before = tables.map((table) => rows(f, table));
        expect(
          rows(f, "content_records").some((record) => (record as { materialized: number }).materialized === 0),
        ).toBe(true);
        expect(bodyFiles(f).length).toBe(renamed ? 1 : 0);
        expect(exportSnapshot(unwrap(backup(f).exportPorts()))).toMatchObject({
          ok: false,
          error: { code: "CONTENT_MATERIALIZING" },
        });
        expect(tables.map((table) => rows(f, table))).toEqual(before);
        expect(existsSync(join(f.vault, "snapshots", "manifest.json"))).toBe(false);
        unwrap(createNodeVaultCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).drainAtStart());
        unwrap(exportSnapshot(unwrap(backup(f).exportPorts())));
        const manifest = JSON.parse(readFileSync(join(f.vault, "snapshots", "manifest.json"), "utf8"));
        const paths = Object.keys(manifest.contentDigests);
        expect(paths).toHaveLength(1);
        expect(readFileSync(join(f.vault, "snapshots", paths[0]!))).toEqual(Buffer.from(body));
      } finally {
        ports.releaseAcceptedBody(accepted);
        ports.close();
      }
    },
  );

  it("exports selected raw content and restores fresh private records independently of the current ingestion cap", () => {
    const source = fileHistory();
    lowerCap(source);
    const exported = unwrap(exportSnapshot(unwrap(backup(source).exportPorts())));
    expect(exported).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(source.vault, "snapshots", "manifest.json"), "utf8"));
    const keys = Object.keys(manifest.contentDigests);
    expect(keys).toHaveLength(1);
    const key = keys[0]!;
    const bytes = readFileSync(join(source.vault, "snapshots", key));
    expect(bytes).toEqual(Buffer.from(source.body));
    expect(manifest.contentDigests[key]).toBe(createHash("sha256").update(bytes).digest("hex"));
    const target = installation();
    lowerCap(target);
    const restore = unwrap(backup(target, source).restorePorts());
    const before = rows(target, "project_memos");
    unwrap(backupRestore(restore, { dryRun: true }));
    expect(rows(target, "project_memos")).toEqual(before);
    expect(bodyFiles(target)).toEqual([]);
    unwrap(backupRestore(restore, { dryRun: false }));
    const ports = createNodeMemoPorts({ env: { SORAGE_HOME: target.home }, userHome: target.home });
    try {
      expect(unwrap(showMemo(ports, MEMO_ID))).toEqual(source.memo);
      const original = { title: "Backed history", expectedRowVersion: 2 };
      expect(
        mutateMemo(ports, "update", MEMO_ID, original, { mode: "replay-only", idempotencyKey: source.key }),
      ).toMatchObject({ ok: false, error: { code: "MEMO_REPLAY_UNAVAILABLE" } });
    } finally {
      ports.close();
    }
    const records = rows(target, "content_records");
    expect(records).toHaveLength(1);
    expect(records[0]!.id).not.toBe(key.split("/")[3]);
    expect(bodyFiles(target).map((path) => readFileSync(path))).toEqual([bytes]);
    expect(rows(target, "idempotency_keys")).toEqual([]);
    const memoEvents = (f: Installation) =>
      rows(f, "events")
        .filter((row) => row.memo_id !== null)
        .map((row): Record<string, unknown> => ({ ...row, metadata_json: JSON.parse(String(row.metadata_json)) }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    expect(memoEvents(target)).toEqual(memoEvents(source));
  });

  it.each(["shard-digest", "size", "nul", "utf8", "missing", "extra"])(
    "refuses %s before target adoption, including dry-run",
    (defect) => {
      const source = fileHistory();
      unwrap(exportSnapshot(unwrap(backup(source).exportPorts())));
      const root = join(source.vault, "snapshots");
      const manifestPath = join(root, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const shardPath = `memos/${MEMO_ID.slice(0, 2)}/${MEMO_ID}.json`;
      const shard = JSON.parse(readFileSync(join(root, shardPath), "utf8"));
      const path = shard.bodyContent.contentPath;
      if (defect === "shard-digest") shard.bodyContent.sha256 = "0".repeat(64);
      if (defect === "size") shard.bodyContent.sizeBytes += 1;
      if (defect === "nul" || defect === "utf8") {
        const bytes = Buffer.from(source.body);
        bytes[65536] = defect === "nul" ? 0 : 0xff;
        writeFileSync(join(root, path), bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        shard.bodyContent.sha256 = digest;
        manifest.contentDigests[path] = digest;
      }
      if (defect === "missing") delete manifest.contentDigests[path];
      if (defect === "extra") {
        const extra = `content/memo/${MEMO_ID}/${randomUUID()}`;
        writeFileSync(join(root, extra), "unowned");
        manifest.contentDigests[extra] = createHash("sha256").update("unowned").digest("hex");
      }
      const raw = canonicalJson(shard);
      writeFileSync(join(root, shardPath), raw);
      manifest.memoDigests[shardPath] = createHash("sha256").update(raw).digest("hex");
      writeFileSync(manifestPath, canonicalJson(manifest));
      const target = installation();
      const config = readFileSync(join(target.home, "config.yaml"));
      const marker = readFileSync(join(target.vault, ".sorage-vault.json"));
      for (const dryRun of [true, false]) {
        expect(backupRestore(unwrap(backup(target, source).restorePorts()), { dryRun })).toMatchObject({
          ok: false,
          error: { code: "VAULT_INTEGRITY_ERROR" },
        });
        expect(readFileSync(join(target.home, "config.yaml"))).toEqual(config);
        expect(readFileSync(join(target.vault, ".sorage-vault.json"))).toEqual(marker);
        expect(rows(target, "project_memos")).toEqual([]);
        expect(bodyFiles(target)).toEqual([]);
      }
    },
  );

  it.each(["begin", "insert", "sync", "close", "uncertain"])(
    "keeps files consistent with the real SQL outcome on %s failure",
    (mode) => {
      const source = fileHistory();
      const data = unwrap(unwrap(backup(source).exportPorts()).readSnapshotData());
      const target = installation();
      const targetPorts = unwrap(backup(target, source).restorePorts());
      const marker = JSON.parse(readFileSync(join(source.vault, ".sorage-vault.json"), "utf8"));
      fault.target = target.database;
      fault.mode = mode;
      fault.trace = [];
      const result = targetPorts.rebuildDatabase(data, marker);
      expect(result.ok).toBe(false);
      const trace = [...fault.trace];
      fault.mode = "";
      const committed = mode === "close" || mode === "uncertain";
      expect(rows(target, "project_memos")).toHaveLength(committed ? 1 : 0);
      expect(bodyFiles(target)).toHaveLength(committed ? 1 : 0);
      if (committed) {
        expect(readFileSync(bodyFiles(target)[0]!)).toEqual(Buffer.from(source.body));
        if (!result.ok) expect(result.error.message).toContain(mode === "close" ? "committed" : "uncertain");
      }
      if (mode !== "sync") {
        const begin = trace.indexOf("begin");
        expect(begin).toBeGreaterThan(0);
        expect(trace.slice(0, begin)).toContain(`sync:${join(target.vault, "content", "memo", MEMO_ID)}`);
        expect(trace.slice(0, begin)).toContain(`sync:${target.vault}`);
        expect(trace.slice(begin).some((entry) => entry.startsWith("sync:"))).toBe(false);
      }
    },
  );
});
