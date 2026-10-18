import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appError, err, ok, parseMemoReceipt, SystemClock, type ContentReferences } from "@sorage/core";
import {
  materializeFetchCacheFile,
  sweepFetchCache,
  createSqliteContentStore,
  sqliteContentReferences,
  receiptReferencedContentKeys,
  type SqliteContentStore,
} from "../../src/content-store";
import { collectVaultGarbage, createSqliteIntentLog } from "../../src/intent-log";
import { createSqliteEventLedger } from "../../src/events";
import { migrate } from "../../src/sqlite/migrator";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { createVaultInitializer } from "../../src/vault";

const INSTALLATION = "11111111-2222-4333-8444-555555555555";
const OWNER = "0123abcd-0000-4000-8000-0000000000ff";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

interface Fixture {
  store: SqliteContentStore;
  vaultPath: string;
  stateDir: string;
  close: () => void;
  db: ReturnType<typeof makeTempDatabase>["db"];
  databasePath: string;
}

function fixture(options: { largeWarningBytes?: number } = {}): Fixture {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS, () => "2026-01-01T00:00:00.000Z");
  const vault = makeTempVault();
  cleanups.push(vault.cleanup);
  createVaultInitializer(new SystemClock()).initialize(vault.vaultPath, INSTALLATION);
  const ledger = createSqliteEventLedger(temp.db);
  const store = createSqliteContentStore({
    db: temp.db,
    vaultPath: vault.vaultPath,
    installationId: INSTALLATION,
    ledger,
    ...(options.largeWarningBytes === undefined ? {} : { largeWarningBytes: options.largeWarningBytes }),
  });
  return {
    store,
    vaultPath: vault.vaultPath,
    stateDir: temp.home.home,
    db: temp.db,
    databasePath: temp.databasePath,
    close: () => temp.db.close(),
  };
}

const CONTENT_EVENTS =
  "SELECT event_type, metadata_json FROM events WHERE event_type LIKE 'CONTENT_%' ORDER BY created_at, id";

describe("the shared content store application boundary", () => {
  it("preserves exact inline SQLite TEXT bytes through the native Bun engine and composition primitive", () => {
    const f = fixture();
    const connection = fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url));
    const module = fileURLToPath(new URL("../../src/content-store.ts", import.meta.url));
    const bodies = ["\uFEFFinline\r\n", "한글 😀 e\u0301\r\nno-final-newline", "", "a\0b"];
    const script = `
      import { createHash, randomUUID } from "node:crypto";
      const { openSorageDatabase } = await import(${JSON.stringify(connection)});
      const { createSqliteContentStore } = await import(${JSON.stringify(module)});
      const db = openSorageDatabase(${JSON.stringify(f.databasePath)});
      const store = createSqliteContentStore({ db, vaultPath: ${JSON.stringify(f.vaultPath)}, installationId: ${JSON.stringify(INSTALLATION)} });
      const bodies = ${JSON.stringify(bodies)};
      try {
        for (const primitive of [false, true]) for (const text of bodies) {
          const bytes = Buffer.from(text, "utf8");
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          let id;
          if (primitive) {
            id = randomUUID();
            db.exec("BEGIN IMMEDIATE");
            store.insertContentRecord({ id, inlineText: text, storageKey: null, sizeBytes: bytes.length, sha256, materialized: true, createdAt: "2026-01-01T00:00:00.000Z" });
            db.exec("COMMIT");
          } else {
            const written = store.write({ body: { kind: "text", text }, owner: { domain: "memo", ownerId: ${JSON.stringify(OWNER)} }, maxBytes: 1024, createdAt: "2026-01-01T00:00:00.000Z" });
            if (!written.ok) throw Error(JSON.stringify(written));
            id = written.value.recordId;
          }
          const raw = db.prepare("SELECT typeof(inline_text) AS kind, hex(inline_text) AS bytes, length(CAST(inline_text AS BLOB)) AS size FROM content_records WHERE id = ?").get(id);
          if (raw.kind !== "text" || raw.bytes !== bytes.toString("hex").toUpperCase() || raw.size !== bytes.length) throw Error("SQLite changed exact inline TEXT bytes: " + JSON.stringify(raw));
          const read = store.read(id);
          if (!read.ok || Buffer.compare(Buffer.from(read.value.bytes), bytes) !== 0 || read.value.sizeBytes !== bytes.length || read.value.sha256 !== sha256) throw Error("Native read did not preserve the accepted body: " + JSON.stringify(read));
          const reopened = openSorageDatabase(${JSON.stringify(f.databasePath)});
          try {
            const reread = createSqliteContentStore({ db: reopened, vaultPath: ${JSON.stringify(f.vaultPath)}, installationId: ${JSON.stringify(INSTALLATION)} }).read(id);
            if (!reread.ok || Buffer.compare(Buffer.from(reread.value.bytes), bytes) !== 0 || reread.value.sizeBytes !== bytes.length || reread.value.sha256 !== sha256) throw Error("Reopened native read changed the accepted body");
          } finally { reopened.close(); }
        }
        const rolledBackId = randomUUID();
        db.exec("BEGIN IMMEDIATE");
        store.insertContentRecord({ id: rolledBackId, inlineText: "", storageKey: null, sizeBytes: 0, sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"), materialized: true, createdAt: "2026-01-01T00:00:00.000Z" });
        db.exec("ROLLBACK");
        if (store.readRecord(rolledBackId).value !== null) throw Error("The inline composition rollback did not remove its row");
        const file = store.write({ body: { kind: "binary", bytes: Buffer.from([1,2,3]) }, owner: { domain: "memo", ownerId: ${JSON.stringify(OWNER)} }, maxBytes: 1024, createdAt: "2026-01-01T00:00:00.000Z" });
        if (!file.ok || db.prepare("SELECT inline_text FROM content_records WHERE id = ?").get(file.value.recordId).inline_text !== null) throw Error("File-backed inline null was changed");
        console.log(JSON.stringify({ nativeBun: Bun.version, verified: bodies.length * 2 }));
      } finally { db.close(); }
    `;
    const child = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ nativeBun: "1.4.2", verified: 8 });
  });

  it("routes small text inline and larger text into the Vault without caller choice", () => {
    const f = fixture();
    const small = f.store.write({
      body: { kind: "text", text: "small body" },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(small.ok).toBe(true);
    if (!small.ok) return;
    expect(small.value.representation).toBe("inline");
    expect(small.value.storageKey).toBeNull();
    const read = f.store.read(small.value.recordId);
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.value.bytes).toString("utf8")).toBe("small body");

    const large = f.store.write({
      body: { kind: "text", text: "x".repeat(65_537) },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(large.ok).toBe(true);
    if (!large.ok) return;
    expect(large.value.representation).toBe("file");
    expect(large.value.storageKey).toMatch(/^content\/memo\//);
    expect(large.value.activated).toBe("completed");
    const largeRead = f.store.read(large.value.recordId);
    expect(largeRead.ok).toBe(true);
    if (largeRead.ok) expect(largeRead.value.bytes.byteLength).toBe(65_537);
    // Inline content appends no physical event; the file-backed activation
    // appends exactly one CONTENT_ACTIVATED row.
    const events = f.db.prepare(CONTENT_EVENTS).all() as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toEqual(["CONTENT_ACTIVATED"]);
  });

  it("keeps binary content Vault-backed at every size, even bytes that decode as UTF-8", () => {
    const f = fixture();
    const decoded = f.store.write({
      body: { kind: "binary", bytes: Buffer.from("plain text bytes classified binary", "utf8") },
      owner: { domain: "channel", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.representation).toBe("file");
  });

  it("enforces the shared bound before the accepting transaction", () => {
    const f = fixture();
    const refused = f.store.write({
      body: { kind: "text", text: "y".repeat(11) },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("ARTIFACT_TOO_LARGE");
    const custom = f.store.write({
      body: { kind: "text", text: "y".repeat(11) },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      tooLargeCode: "MEMO_TOO_LARGE",
    });
    expect(custom.ok).toBe(false);
    if (!custom.ok) expect(custom.error.code).toBe("MEMO_TOO_LARGE");
  });

  it("keeps an allowed empty text inline without a file or physical event", () => {
    const f = fixture();
    const written = f.store.write({
      body: { kind: "text", text: "" },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value.representation).toBe("inline");
    const read = f.store.read(written.value.recordId);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.bytes.byteLength).toBe(0);
    expect(f.db.prepare(CONTENT_EVENTS).all()).toEqual([]);
    expect(f.db.prepare("SELECT id FROM pending_fs_ops").all()).toEqual([]);
  });

  it("rejects an oversized source at the configured bound without retaining a staged copy", () => {
    const f = fixture();
    const text = "x".repeat(2 * 1024 * 1024);
    const source = writeTempSource(f, text);
    const before = statSync(source);
    const staged = f.store.stage({ sourcePath: source, maxBytes: 1024 * 1024 + 1 });
    expect(staged.ok).toBe(false);
    if (!staged.ok) expect(staged.error.code).toBe("ARTIFACT_TOO_LARGE");
    expect(readFileSync(source, "utf8")).toBe(text);
    expect(statSync(source).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(join(f.vaultPath, "staging"))).toEqual([]);
    expect(f.db.prepare("SELECT id FROM content_records").all()).toEqual([]);
    expect(f.db.prepare("SELECT id FROM pending_fs_ops").all()).toEqual([]);
  });

  it("flags the large-content Git-growth disclosure seam", () => {
    const f = fixture({ largeWarningBytes: 8 });
    const flagged = f.store.write({
      body: { kind: "text", text: "z".repeat(65_537) },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(flagged.ok).toBe(true);
    if (flagged.ok) expect(flagged.value.largeContentWarning).toBe(true);
    const quiet = f.store.write({
      body: { kind: "text", text: "tiny" },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(quiet.ok).toBe(true);
    if (quiet.ok) expect(quiet.value.largeContentWarning).toBe(false);
  });
});

describe("destination conflicts and verification", () => {
  it("retains both files and the intent on a both-present destination conflict", () => {
    const f = fixture();
    const staged = f.store.stage({
      sourcePath: writeTempSource(f, "conflict bytes"),
      maxBytes: 1024,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const key = `content/memo/${OWNER}/0123abcd-0000-4000-8000-0000000000c1`;
    // A hostile pre-existing destination: the activation must not overwrite it.
    mkdirSync(join(f.vaultPath, "content", "memo", OWNER), { recursive: true });
    writeFileSync(join(f.vaultPath, key), "existing bytes", { flag: "wx" });
    const written = f.store.writeFile({
      owner: { domain: "memo", ownerId: OWNER },
      contentId: "0123abcd-0000-4000-8000-0000000000c1",
      staged: staged.value,
      createdAt: "2026-01-01T00:00:00.000Z",
      intentId: "0123abcd-0000-4000-8000-0000000000e1",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value.activated).toBe("failed-assessment");
    expect(written.value.failureReason).toBe("destination_conflict");
    expect(readFileSync(join(f.vaultPath, key), "utf8")).toBe("existing bytes");
    expect(existsSync(staged.value.stagingPath)).toBe(true);
    const row = f.db
      .prepare("SELECT attempts FROM pending_fs_ops WHERE id = ?")
      .get("0123abcd-0000-4000-8000-0000000000e1") as { attempts: number } | undefined;
    expect(row?.attempts).toBe(1);
    const failure = f.db
      .prepare("SELECT metadata_json FROM events WHERE event_type = 'CONTENT_INTEGRITY_FAILED'")
      .get() as { metadata_json: string } | undefined;
    const metadata = JSON.parse(failure?.metadata_json ?? "{}") as Record<string, unknown>;
    expect(metadata.reason).toBe("destination_conflict");
    expect(metadata.attempt).toBe(1);
  });

  it("completes a source-gone destination-present retry only after size and hash verification", () => {
    const f = fixture();
    const bytes = Buffer.from("verified bytes", "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const key = `content/memo/${OWNER}/0123abcd-0000-4000-8000-0000000000c2`;
    mkdirSync(join(f.vaultPath, "content", "memo", OWNER), { recursive: true });
    writeFileSync(join(f.vaultPath, key), bytes);
    f.db
      .prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, ?)",
      )
      .run("0123abcd-0000-4000-8000-0000000000c2", key, bytes.byteLength, sha, "2026-01-01T00:00:00.000Z");
    f.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, 'activate', 'staging/gone', ?, NULL, 'memo', ?, ?, ?, 0)",
      )
      .run(
        "0123abcd-0000-4000-8000-0000000000e2",
        key,
        OWNER,
        "0123abcd-0000-4000-8000-0000000000c2",
        "2026-01-01T00:00:00.000Z",
      );
    const log = createSqliteIntentLog({
      db: f.db,
      installationId: INSTALLATION,
      events: createSqliteEventLedger(f.db),
    });
    const drained = log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    if (drained.ok) expect(drained.value.resolved).toContain("0123abcd-0000-4000-8000-0000000000e2");
    // A tampered destination fails closed instead of completing.
    writeFileSync(join(f.vaultPath, key), Buffer.alloc(bytes.length, 0x78));
    f.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, 'activate', 'staging/gone2', ?, NULL, 'memo', ?, ?, ?, 0)",
      )
      .run(
        "0123abcd-0000-4000-8000-0000000000e3",
        key,
        OWNER,
        "0123abcd-0000-4000-8000-0000000000c2",
        "2026-01-01T00:00:00.000Z",
      );
    const second = log.drain(f.vaultPath);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.resolved).not.toContain("0123abcd-0000-4000-8000-0000000000e3");
      expect(second.value.commonFailures.map((failure) => failure.reason)).toContain("checksum_mismatch");
    }
  });

  it("preserves an unresolved activation through cleanup and converges after explicit repair", () => {
    const f = fixture();
    const bytes = "accepted bytes";
    const staged = f.store.stage({ sourcePath: writeTempSource(f, bytes), maxBytes: 1024 });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const contentId = "0123abcd-0000-4000-8000-0000000000c4";
    const key = `content/memo/${OWNER}/${contentId}`;
    mkdirSync(join(f.vaultPath, "content", "memo", OWNER), { recursive: true });
    writeFileSync(join(f.vaultPath, key), "conflicting bytes");
    const written = f.store.writeFile({
      owner: { domain: "memo", ownerId: OWNER },
      contentId,
      intentId: "0123abcd-0000-4000-8000-0000000000e4",
      staged: staged.value,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value.activated).toBe("failed-assessment");
    const references = sqliteContentReferences(f.db);
    const log = createSqliteIntentLog({
      db: f.db,
      installationId: INSTALLATION,
      events: createSqliteEventLedger(f.db),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(f.store.cleanup(references, new Date())).toEqual(ok({ removedInlineIds: [], scheduledUnlinkIds: [] }));
      expect(f.store.readRecord(contentId)).not.toEqual(ok(null));
      expect(readFileSync(staged.value.stagingPath, "utf8")).toBe(bytes);
      expect(readFileSync(join(f.vaultPath, key), "utf8")).toBe("conflicting bytes");
      const drained = log.drain(f.vaultPath);
      expect(drained.ok).toBe(true);
      if (drained.ok)
        expect(drained.value.commonFailures.map((failure) => failure.reason)).toEqual(["destination_conflict"]);
      expect(f.db.prepare("SELECT op FROM pending_fs_ops WHERE content_id = ?").all(contentId)).toEqual([
        { op: "activate" },
      ]);
    }
    // Simulate an operator repairing the fixture's conflicting destination.
    rmSync(join(f.vaultPath, key));
    expect(log.drain(f.vaultPath).ok).toBe(true);
    expect(existsSync(staged.value.stagingPath)).toBe(false);
    expect(readFileSync(join(f.vaultPath, key), "utf8")).toBe(bytes);
    expect(f.store.cleanup(references, new Date())).toEqual(
      ok({ removedInlineIds: [], scheduledUnlinkIds: [contentId] }),
    );
    expect(log.drain(f.vaultPath).ok).toBe(true);
    expect(log.drain(f.vaultPath).ok).toBe(true);
    expect(existsSync(join(f.vaultPath, key))).toBe(false);
    expect(f.store.readRecord(contentId)).toEqual(ok(null));
    expect(f.db.prepare("SELECT id FROM pending_fs_ops WHERE content_id = ?").all(contentId)).toEqual([]);
    const events = f.db
      .prepare("SELECT event_type FROM events WHERE event_type IN ('CONTENT_ACTIVATED', 'CONTENT_UNLINKED')")
      .all();
    expect(events).toEqual([{ event_type: "CONTENT_ACTIVATED" }, { event_type: "CONTENT_UNLINKED" }]);
  });
});

describe("common intent ownership admission", () => {
  const contentId = "0123abcd-0000-4000-8000-0000000000c6";
  it("throws on invalid composition ownership so the caller can roll its record back", () => {
    const f = fixture();
    f.db.exec("BEGIN IMMEDIATE");
    try {
      f.store.insertContentRecord({
        id: contentId,
        inlineText: "",
        storageKey: null,
        sizeBytes: 0,
        sha256: createHash("sha256").update("").digest("hex"),
        materialized: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(() =>
        f.store.insertCommonIntent({
          id: randomUUID(),
          op: "unlink",
          fromPath: null,
          toPath: `content/memo/${OWNER}/${contentId}`,
          owner: { domain: "memo", ownerId: "" },
          contentId,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrow("complete UUID ownership");
    } finally {
      f.db.exec("ROLLBACK");
    }
    expect(f.db.prepare("SELECT id FROM content_records").all()).toEqual([]);
    expect(f.db.prepare("SELECT id FROM pending_fs_ops").all()).toEqual([]);
  });

  it.each([
    ["memo", null, null],
    [null, OWNER, null],
    [null, null, contentId],
    ["memo", OWNER, null],
    ["memo", null, contentId],
    [null, OWNER, contentId],
    ["memo", "not-a-uuid", contentId],
    ["memo", OWNER, "not-a-uuid"],
  ] as const)("rejects malformed ownership %s/%s/%s before committing any batch member", (ownerDomain, ownerId, id) => {
    const f = fixture();
    const log = createSqliteIntentLog({ db: f.db, installationId: INSTALLATION });
    const legacy = {
      id: "legacy",
      op: "activate" as const,
      fromPath: "staging/legacy",
      toPath: "artifacts/legacy",
      artifactId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const invalid = { ...legacy, id: randomUUID(), ownerDomain, ownerId, contentId: id };
    expect(log.record([legacy, invalid])).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(f.db.prepare("SELECT id FROM pending_fs_ops").all()).toEqual([]);
  });

  it("preserves a raw partial row and tampered destination without legacy fallback or false completion", () => {
    const f = fixture();
    const key = `content/memo/${OWNER}/${contentId}`;
    const intentId = randomUUID();
    const createdAt = "2026-01-01T00:00:00.000Z";
    mkdirSync(join(f.vaultPath, "content", "memo", OWNER), { recursive: true });
    writeFileSync(join(f.vaultPath, key), "bad");
    f.db.exec("BEGIN IMMEDIATE");
    f.store.insertContentRecord({
      id: contentId,
      inlineText: null,
      storageKey: key,
      sizeBytes: 4,
      sha256: createHash("sha256").update("good").digest("hex"),
      materialized: false,
      createdAt,
    });
    f.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, 'activate', 'staging/gone', ?, NULL, 'memo', NULL, ?, ?, 0)",
      )
      .run(intentId, key, contentId, createdAt);
    f.db.exec("COMMIT");
    const before = f.db.prepare("SELECT * FROM pending_fs_ops").all();
    const log = createSqliteIntentLog({ db: f.db, installationId: INSTALLATION });
    for (const result of [
      log.pending(),
      log.drain(f.vaultPath),
      f.store.completeCommonIntent(intentId, { status: "done" }),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "STORAGE_INTEGRITY_ERROR", recovery: { suggestedCommand: expect.stringContaining("Preserve") } },
      });
    }
    expect(f.db.prepare("SELECT * FROM pending_fs_ops").all()).toEqual(before);
    expect(f.db.prepare("SELECT materialized FROM content_records").all()).toEqual([{ materialized: 0 }]);
    expect(f.db.prepare(CONTENT_EVENTS).all()).toEqual([]);
    expect(readFileSync(join(f.vaultPath, key), "utf8")).toBe("bad");
  });
});

describe("the shared completion helper on both paths", () => {
  it("rolls back failed success-event insertion and recovers the physical activation on startup", () => {
    const f = fixture();
    f.db.exec(
      "CREATE TRIGGER reject_content_success BEFORE INSERT ON events WHEN NEW.event_type = 'CONTENT_ACTIVATED' BEGIN SELECT RAISE(ABORT, 'injected event insertion failure'); END",
    );
    const written = f.store.write({
      body: { kind: "binary", bytes: Buffer.from("durably activated") },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(written.ok).toBe(false);
    expect(f.db.prepare("SELECT materialized FROM content_records").all()).toEqual([{ materialized: 0 }]);
    expect(f.db.prepare("SELECT op, attempts FROM pending_fs_ops").all()).toEqual([{ op: "activate", attempts: 0 }]);
    expect(f.db.prepare(CONTENT_EVENTS).all()).toEqual([]);
    const row = f.db.prepare("SELECT storage_key FROM content_records").get() as { storage_key: string };
    expect(readFileSync(join(f.vaultPath, row.storage_key), "utf8")).toBe("durably activated");
    f.db.exec("DROP TRIGGER reject_content_success");
    const log = createSqliteIntentLog({ db: f.db, installationId: INSTALLATION });
    expect(log.drain(f.vaultPath).ok).toBe(true);
    expect(log.drain(f.vaultPath).ok).toBe(true);
    expect(f.db.prepare("SELECT materialized FROM content_records").all()).toEqual([{ materialized: 1 }]);
    expect(f.db.prepare("SELECT id FROM pending_fs_ops").all()).toEqual([]);
    expect(f.db.prepare(CONTENT_EVENTS).all()).toMatchObject([{ event_type: "CONTENT_ACTIVATED" }]);
  });

  it("rolls back failure-attempt state when the failure event cannot be appended", () => {
    const f = fixture();
    const staged = f.store.stage({ sourcePath: writeTempSource(f, "accepted bytes"), maxBytes: 1024 });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const contentId = "0123abcd-0000-4000-8000-0000000000c5";
    const key = `content/memo/${OWNER}/${contentId}`;
    mkdirSync(join(f.vaultPath, "content", "memo", OWNER), { recursive: true });
    writeFileSync(join(f.vaultPath, key), "conflicting bytes");
    f.db.exec(
      "CREATE TRIGGER reject_content_failure BEFORE INSERT ON events WHEN NEW.event_type = 'CONTENT_INTEGRITY_FAILED' BEGIN SELECT RAISE(ABORT, 'injected event insertion failure'); END",
    );
    expect(
      f.store.writeFile({
        owner: { domain: "memo", ownerId: OWNER },
        contentId,
        intentId: randomUUID(),
        staged: staged.value,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(false);
    expect(f.db.prepare("SELECT op, attempts FROM pending_fs_ops").all()).toEqual([{ op: "activate", attempts: 0 }]);
    expect(f.db.prepare(CONTENT_EVENTS).all()).toEqual([]);
    expect(readFileSync(staged.value.stagingPath, "utf8")).toBe("accepted bytes");
    expect(readFileSync(join(f.vaultPath, key), "utf8")).toBe("conflicting bytes");
    f.db.exec("DROP TRIGGER reject_content_failure");
    const log = createSqliteIntentLog({ db: f.db, installationId: INSTALLATION });
    for (const attempt of [1, 2]) {
      expect(log.drain(f.vaultPath).ok).toBe(true);
      expect(f.db.prepare("SELECT attempts FROM pending_fs_ops").all()).toEqual([{ attempts: attempt }]);
      const events = f.db.prepare(CONTENT_EVENTS).all() as Array<{ metadata_json: string }>;
      expect(events.map((event) => JSON.parse(event.metadata_json).attempt).sort((a, b) => a - b)).toEqual(
        [1, 2].slice(0, attempt),
      );
    }
  });

  it("emits no duplicate success when a competing drain already completed the intent", () => {
    const f = fixture();
    const written = f.store.write({
      body: { kind: "text", text: "d".repeat(70_000) },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(written.ok).toBe(true);
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'CONTENT_ACTIVATED'").get() as {
      n: number;
    };
    expect(before.n).toBe(1);
    // A repeated completion on the already-cleared intent observes nothing to do.
    const completion = f.store.completeCommonIntent("0123abcd-0000-4000-8000-0000000000not-there", { status: "done" });
    expect(completion.ok).toBe(true);
    if (completion.ok) expect(completion.value.status).toBe("already-completed");
    const after = f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'CONTENT_ACTIVATED'").get() as {
      n: number;
    };
    expect(after.n).toBe(1);
  });
});

describe("reads never synthesize success", () => {
  it("rejects inline bytes whose recorded digest or size has changed", () => {
    const f = fixture();
    const text = "\uFEFFinline\r\n";
    const written = f.store.write({
      body: { kind: "text", text },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const original = f.store.read(written.value.recordId);
    expect(original.ok).toBe(true);
    if (original.ok) expect(Buffer.from(original.value.bytes)).toEqual(Buffer.from(text));

    f.db.prepare("UPDATE content_records SET sha256 = ? WHERE id = ?").run("0".repeat(64), written.value.recordId);
    const wrongHash = f.store.read(written.value.recordId);
    expect(wrongHash.ok).toBe(false);
    if (!wrongHash.ok) expect(wrongHash.error.code).toBe("CONTENT_CORRUPTED");

    f.db
      .prepare("UPDATE content_records SET sha256 = ?, size_bytes = ? WHERE id = ?")
      .run(written.value.sha256, written.value.sizeBytes + 1, written.value.recordId);
    const wrongSize = f.store.read(written.value.recordId);
    expect(wrongSize.ok).toBe(false);
    if (!wrongSize.ok) expect(wrongSize.error.code).toBe("CONTENT_CORRUPTED");
  });

  it("rejects a file size mismatch even when the recorded digest still matches", () => {
    const f = fixture();
    const written = f.store.write({
      body: { kind: "binary", bytes: new Uint8Array([1, 2, 3]) },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    f.db.prepare("UPDATE content_records SET size_bytes = 2 WHERE id = ?").run(written.value.recordId);
    const read = f.store.read(written.value.recordId);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("CONTENT_CORRUPTED");
  });

  it("reads an existing artifacts/ body through the generic record without repacking it", () => {
    const f = fixture();
    const artifactId = "0123abcd-0000-4000-8000-0000000000a3";
    const contentId = "0123abcd-0000-4000-8000-0000000000c3";
    const key = `artifacts/${OWNER}/${artifactId}/body.txt`;
    const bytes = Buffer.from("\uFEFFlegacy\r\n");
    mkdirSync(join(f.vaultPath, "artifacts", OWNER, artifactId), { recursive: true });
    writeFileSync(join(f.vaultPath, key), bytes);
    f.db.exec("BEGIN IMMEDIATE");
    f.store.insertContentRecord({
      id: contentId,
      inlineText: null,
      storageKey: key,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      materialized: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    f.db.exec("COMMIT");
    const read = f.store.read(contentId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.kind).toBe("file");
      expect(Buffer.from(read.value.bytes)).toEqual(bytes);
    }
  });

  it("reports CONTENT_MATERIALIZING for unmaterialized file-backed records and CONTENT_CORRUPTED for tampered bytes", () => {
    const f = fixture();
    const key = `content/memo/${OWNER}/0123abcd-0000-4000-8000-0000000000c3`;
    f.db
      .prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 3, ?, 0, ?)",
      )
      .run("0123abcd-0000-4000-8000-0000000000c3", key, "f".repeat(64), "2026-01-01T00:00:00.000Z");
    const materializing = f.store.read("0123abcd-0000-4000-8000-0000000000c3");
    expect(materializing.ok).toBe(false);
    if (!materializing.ok) expect(materializing.error.code).toBe("CONTENT_MATERIALIZING");
    mkdirSync(join(f.vaultPath, "content", "memo", OWNER), { recursive: true });
    writeFileSync(join(f.vaultPath, key), "abc");
    f.db
      .prepare("UPDATE content_records SET materialized = 1 WHERE id = ?")
      .run("0123abcd-0000-4000-8000-0000000000c3");
    const corrupted = f.store.read("0123abcd-0000-4000-8000-0000000000c3");
    expect(corrupted.ok).toBe(false);
    if (!corrupted.ok) expect(corrupted.error.code).toBe("CONTENT_CORRUPTED");
    rmSync(join(f.vaultPath, key));
    const missing = f.store.read("0123abcd-0000-4000-8000-0000000000c3");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("CONTENT_CORRUPTED");
  });
});

describe("reference-aware cleanup", () => {
  function seedRecords(f: Fixture) {
    const inline = f.store.write({
      body: { kind: "text", text: "inline body" },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const fileBacked = f.store.write({
      body: { kind: "binary", bytes: Buffer.from("file body bytes") },
      owner: { domain: "memo", ownerId: OWNER },
      maxBytes: 1024 * 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(inline.ok && fileBacked.ok).toBe(true);
    return { inlineId: inline.ok ? inline.value.recordId : "", fileId: fileBacked.ok ? fileBacked.value.recordId : "" };
  }

  it("protects record references read from unexpired receipts and releases them at expiry", () => {
    const f = fixture();
    const { inlineId, fileId } = seedRecords(f);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const expires = new Date("2026-06-02T00:00:00.000Z");
    // Only this injected test provider understands this synthetic receipt shape;
    // it does not define the production format owned by the adoption Tasks.
    for (const id of [inlineId, fileId]) {
      f.db
        .prepare(
          "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          "test:retained-content",
          "a".repeat(64),
          JSON.stringify({ testContentRecordId: id }),
          now.toISOString(),
          expires.toISOString(),
        );
    }
    const references: ContentReferences = {
      domainReferencedRecordIds: () => ok([]),
      receiptReferencedRecordIds: (at) => {
        const rows = f.db
          .prepare("SELECT response_json FROM idempotency_keys WHERE scope = ? AND expires_at > ?")
          .all("test:retained-content", at.toISOString()) as Array<{ response_json: string }>;
        return ok(
          rows.map((row) => (JSON.parse(row.response_json) as { testContentRecordId: string }).testContentRecordId),
        );
      },
    };
    const protectedResult = f.store.cleanup(references, now);
    expect(protectedResult).toEqual(ok({ removedInlineIds: [], scheduledUnlinkIds: [] }));
    const keys = receiptReferencedContentKeys(f.db, now, references);
    expect(keys.ok).toBe(true);
    if (!keys.ok) return;
    expect(keys.value).toHaveLength(1);
    const fileKey = keys.value[0] as string;
    const orphanKey = `content/memo/${OWNER}/0123abcd-0000-4000-8000-00000000dead`;
    writeFileSync(join(f.vaultPath, orphanKey), "unowned bytes");
    const old = new Date(now.getTime() - 48 * 3_600_000);
    for (const key of [fileKey, orphanKey]) utimesSync(join(f.vaultPath, key), old, old);
    const swept = collectVaultGarbage(f.vaultPath, [], {
      liveStorageKeys: [],
      liveContentKeys: [],
      receiptReferencedKeys: keys.value,
      sweepContentWithoutRegistry: true,
      graceHours: 1,
      now,
    });
    expect(swept.ok).toBe(true);
    if (swept.ok) expect(swept.value.sweptContent).toEqual([join(f.vaultPath, orphanKey)]);
    expect(existsSync(join(f.vaultPath, fileKey))).toBe(true);

    const released = f.store.cleanup(references, expires);
    expect(released).toEqual(ok({ removedInlineIds: [inlineId], scheduledUnlinkIds: [fileId] }));
    const drained = createSqliteIntentLog({ db: f.db, installationId: INSTALLATION }).drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    expect(existsSync(join(f.vaultPath, fileKey))).toBe(false);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 2 });
  });

  it("does not turn a legacy inline receipt's literal path text into a reference", () => {
    const f = fixture();
    const { fileId } = seedRecords(f);
    const record = f.store.readRecord(fileId);
    expect(record.ok && record.value !== null).toBe(true);
    if (!record.ok || record.value === null) return;
    const receipt = {
      memo: {
        id: "0123abcd-0000-4000-8000-0000000000d1",
        projectId: OWNER,
        title: "Literal path text",
        body: record.value.storageKey,
        state: "open",
        rowVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdBy: { kind: "user", id: null },
        updatedBy: { kind: "user", id: null },
        closedAt: null,
        closedBy: null,
      },
      changed: true,
      replayed: false,
    };
    expect(parseMemoReceipt(receipt).ok).toBe(true);
    const raw = JSON.stringify(receipt);
    f.db
      .prepare(
        "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        receipt.memo.id,
        `memo:${INSTALLATION}:user`,
        "a".repeat(64),
        raw,
        "2026-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
      );
    const cleaned = f.store.cleanup(sqliteContentReferences(f.db), new Date("2026-06-01T00:00:00.000Z"));
    expect(cleaned.ok).toBe(true);
    if (cleaned.ok) expect(cleaned.value.scheduledUnlinkIds).toEqual([fileId]);
    expect(f.store.readRecord(fileId)).toEqual(ok(null));
    expect(f.db.prepare("SELECT response_json FROM idempotency_keys WHERE key = ?").get(receipt.memo.id)).toEqual({
      response_json: raw,
    });
  });

  it("preserves records when a reference provider cannot establish the reference set", () => {
    const f = fixture();
    const { inlineId, fileId } = seedRecords(f);
    const failed = f.store.cleanup(
      {
        domainReferencedRecordIds: () => ok([]),
        receiptReferencedRecordIds: () => err(appError("STORAGE_INTEGRITY_ERROR", "Reference lookup failed")),
      },
      new Date(),
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    for (const id of [inlineId, fileId]) {
      const record = f.store.readRecord(id);
      expect(record.ok && record.value !== null).toBe(true);
    }
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get()).toEqual({ n: 0 });
  });

  it("removes unreferenced records and protects domain and receipt references by record id", () => {
    const f = fixture();
    const { inlineId, fileId } = seedRecords(f);
    const fileRecord = f.store.readRecord(fileId);
    expect(fileRecord.ok && fileRecord.value !== null).toBe(true);
    const fileKey = fileRecord.ok && fileRecord.value ? fileRecord.value.storageKey : null;
    expect(fileKey).toMatch(/^content\//);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const cleaned = f.store.cleanup(
      {
        domainReferencedRecordIds: () => ({ ok: true, value: [inlineId] }),
        receiptReferencedRecordIds: (at) =>
          at.getTime() === now.getTime() ? { ok: true, value: [fileId] } : { ok: true, value: [] },
      },
      now,
    );
    expect(cleaned.ok).toBe(true);
    if (cleaned.ok) {
      expect(cleaned.value.removedInlineIds).toEqual([]);
      expect(cleaned.value.scheduledUnlinkIds).toEqual([]);
    }
    // Release both references: the inline row disappears outright, the
    // file-backed row schedules its unlink intent with the owner triple.
    const released = f.store.cleanup(
      {
        domainReferencedRecordIds: () => ({ ok: true, value: [] }),
        receiptReferencedRecordIds: () => ({ ok: true, value: [] }),
      },
      now,
    );
    expect(released.ok).toBe(true);
    if (released.ok) {
      expect(released.value.removedInlineIds).toEqual([inlineId]);
      expect(released.value.scheduledUnlinkIds).toEqual([fileId]);
    }
    const intent = f.db
      .prepare("SELECT owner_domain, owner_id, content_id, op FROM pending_fs_ops WHERE content_id = ?")
      .get(fileId) as { owner_domain: string; owner_id: string; content_id: string; op: string };
    expect(intent).toMatchObject({ owner_domain: "memo", owner_id: OWNER, content_id: fileId, op: "unlink" });
    expect(f.store.readRecord(fileId).ok).toBe(true);
    const afterRelease = f.store.readRecord(fileId);
    expect(afterRelease.ok && afterRelease.value === null).toBe(true);
    // The drain executes the scheduled unlink and appends CONTENT_UNLINKED.
    const log = createSqliteIntentLog({
      db: f.db,
      installationId: INSTALLATION,
      events: createSqliteEventLedger(f.db),
    });
    const drained = log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    const unlinked = f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'CONTENT_UNLINKED'").get() as {
      n: number;
    };
    expect(unlinked.n).toBe(1);
  });

  it("an embedded inline receipt protects nothing: unreferenced inline records are removable", () => {
    const f = fixture();
    const { inlineId } = seedRecords(f);
    const references = sqliteContentReferences(f.db);
    const cleaned = f.store.cleanup(references, new Date("2026-06-01T00:00:00.000Z"));
    expect(cleaned.ok).toBe(true);
    if (cleaned.ok) expect(cleaned.value.removedInlineIds).toEqual([inlineId]);
  });

  it("a retained receipt that references a Vault-backed key protects the file from the GC sweep", () => {
    const temp = makeTempVault();
    cleanups.push(temp.cleanup);
    const source = join(temp.home.home, "source.bin");
    writeFileSync(source, Buffer.from("sweepable"));
    const old = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(source, old, old);
    const guardKey = "content/memo/owner/referenced";
    const looseKey = "content/memo/owner/unreferenced";
    for (const key of [guardKey, looseKey]) {
      mkdirSync(join(temp.vaultPath, key.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(temp.vaultPath, key), "bytes");
      utimesSync(join(temp.vaultPath, key), old, old);
    }
    const swept = collectVaultGarbage(temp.vaultPath, [], {
      liveStorageKeys: [],
      liveContentKeys: [guardKey],
      receiptReferencedKeys: [],
      graceHours: 1,
      now: new Date(),
    });
    expect(swept.ok).toBe(true);
    if (swept.ok) {
      expect(swept.value.sweptContent.map((path) => path.endsWith("unreferenced"))).toEqual([true]);
      expect(existsSync(join(temp.vaultPath, guardKey))).toBe(true);
    }
  });
});

describe("the derived fetch cache", () => {
  it("materializes a read-only fsynced file, reuses it, and replaces a corrupted entry", () => {
    const temp = makeTempVault();
    cleanups.push(temp.cleanup);
    const stateDir = join(temp.home.home, "state");
    const bytes = Buffer.from("cached bytes", "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const first = materializeFetchCacheFile(stateDir, sha, bytes);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(statSync(first.value.path).mode & 0o777).toBe(0o444);
    const again = materializeFetchCacheFile(stateDir, sha, bytes);
    expect(again.ok && again.value.path === first.value.path).toBe(true);
    // An external replacement can corrupt a read-only cache entry.
    rmSync(first.value.path);
    writeFileSync(first.value.path, "corrupted", { flag: "wx", mode: 0o444 });
    const replaced = materializeFetchCacheFile(stateDir, sha, bytes);
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(readFileSync(replaced.value.path, "utf8")).toBe("cached bytes");
  });

  it("sweeps aged entries through the grace window and leaves young ones", () => {
    const temp = makeTempVault();
    cleanups.push(temp.cleanup);
    const stateDir = join(temp.home.home, "state");
    const oldBytes = Buffer.from("old");
    const youngBytes = Buffer.from("young");
    materializeFetchCacheFile(stateDir, createHash("sha256").update(oldBytes).digest("hex"), oldBytes);
    materializeFetchCacheFile(stateDir, createHash("sha256").update(youngBytes).digest("hex"), youngBytes);
    const cacheDir = join(stateDir, "fetch-cache");
    const oldPath = join(cacheDir, createHash("sha256").update(oldBytes).digest("hex"));
    utimesSync(oldPath, new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 48 * 3_600_000));
    const swept = sweepFetchCache(stateDir, { graceHours: 24, now: new Date() });
    expect(swept).toEqual([oldPath]);
    expect(existsSync(join(cacheDir, createHash("sha256").update(youngBytes).digest("hex")))).toBe(true);
  });
});

function writeTempSource(f: Fixture, content: string): string {
  const path = join(f.stateDir, `source-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(path, content);
  return path;
}

describe("legacy Artifact intents keep their family verbatim", () => {
  it("still appends ARTIFACT_INTEGRITY_FAILED with the legacy metadata for a legacy row", () => {
    const f = fixture();
    f.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, 'activate', NULL, 'artifacts/gone/x', NULL, NULL, NULL, NULL, ?, 0)",
      )
      .run("0123abcd-0000-4000-8000-0000000000l1", "2026-01-01T00:00:00.000Z");
    const log = createSqliteIntentLog({
      db: f.db,
      installationId: INSTALLATION,
      events: createSqliteEventLedger(f.db),
    });
    const drained = log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    if (drained.ok) {
      expect(drained.value.integrityFailed.length).toBe(1);
      expect(drained.value.integrityFailed[0]?.event).toBe("ARTIFACT_INTEGRITY_FAILED");
      expect(drained.value.integrityFailed[0]?.reason).toBe("both-gone");
    }
    const row = f.db
      .prepare("SELECT metadata_json FROM events WHERE event_type = 'ARTIFACT_INTEGRITY_FAILED'")
      .get() as { metadata_json: string };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      intentId: "0123abcd-0000-4000-8000-0000000000l1",
      op: "activate",
      reason: "both-gone",
    });
    expect(Object.hasOwn(metadata, "ownerDomain")).toBe(false);
  });
});
