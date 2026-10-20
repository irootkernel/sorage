import {
  realpathSync,
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { type ContentReferences, ok, SystemClock } from "@sorage/core";
import { createSqliteContentStore, type SqliteContentStore } from "../../src/content-store";
import { createSqliteEventLedger } from "../../src/events";
import { migrate } from "../../src/sqlite/migrator";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { createVaultInitializer } from "../../src/vault";
import * as managedPaths from "../../src/managed-paths";

const INSTALLATION = "11111111-2222-4333-8444-555555555555";
const OWNER = "0123abcd-0000-4000-8000-0000000000ff";
const HANDOFF = "0123abcd-0000-4000-8000-0000000000aa";
const ARTIFACT = "0123abcd-0000-4000-8000-0000000000ab";

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
}

function fixture(): Fixture {
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
  });
  return {
    store,
    vaultPath: vault.vaultPath,
    stateDir: temp.home.home,
    db: temp.db,
    close: () => temp.db.close(),
  };
}

function stagingEntries(vaultPath: string): string[] {
  const staging = join(vaultPath, "staging");
  return existsSync(staging) ? readdirSync(staging) : [];
}

/** Writes one file-backed common record through the 106 stage/write path and returns its key. */
function writeCommonFile(f: Fixture, bytes: Buffer): { recordId: string; storageKey: string } {
  const source = join(f.stateDir, `${randomUUID()}.tmp`);
  writeFileSync(source, bytes);
  const staged = f.store.stage({ sourcePath: source, maxBytes: 4 * 1024 * 1024 });
  expect(staged.ok).toBe(true);
  if (!staged.ok) throw new Error("staging failed");
  const recordId = randomUUID();
  const written = f.store.writeFile({
    owner: { domain: "memo", ownerId: OWNER },
    contentId: recordId,
    staged: staged.value,
    createdAt: "2026-01-01T00:00:00.000Z",
    intentId: randomUUID(),
  });
  expect(written.ok).toBe(true);
  if (!written.ok) throw new Error("writeFile failed");
  return { recordId, storageKey: written.value.storageKey as string };
}

describe("prepareArtifactBody: one routing implementation for the Handoff seam", () => {
  it("routes a small decodable text file inline without creating any staging file", () => {
    const f = fixture();
    const source = join(f.stateDir, "opaque-spool-uuid");
    const text = "\uFEFFbrief\r\n한국어 body";
    writeFileSync(source, Buffer.from(text, "utf8"));
    const prepared = f.store.prepareArtifactBody({
      body: { kind: "file", physicalPath: source, logicalOriginalName: "brief.md", sourceKind: "authenticated-spool" },
      classification: "mime-first",
      identities: { handoffId: HANDOFF, artifactId: ARTIFACT },
      bounds: { maxBytes: 1024 * 1024 },
      provenance: { importedFromPath: null },
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.value).toEqual({
        kind: "inline",
        text,
        sizeBytes: Buffer.byteLength(text, "utf8"),
        sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
        mimeType: "text/markdown",
        storageKey: null,
        logicalName: "brief.md",
        importedFromPath: null,
      });
    }
    expect(stagingEntries(f.vaultPath)).toEqual([]);
  });

  it("routes an undecodable text-classified file to a staged Vault body, never rejecting the import", () => {
    const f = fixture();
    const source = join(f.stateDir, "opaque-spool-uuid");
    const bytes = Buffer.from([0x74, 0x65, 0x78, 0x74, 0xff]);
    writeFileSync(source, bytes);
    const prepared = f.store.prepareArtifactBody({
      body: { kind: "file", physicalPath: source, logicalOriginalName: "notes.txt", sourceKind: "workspace-path" },
      classification: "mime-first",
      identities: { handoffId: HANDOFF, artifactId: ARTIFACT },
      bounds: { maxBytes: 1024 * 1024 },
      provenance: { importedFromPath: "/workspace/notes.txt" },
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok && prepared.value.kind === "file") {
      expect(prepared.value.storageKey).toBe(`artifacts/${HANDOFF}/${ARTIFACT}/notes.txt`);
      expect(prepared.value.sizeBytes).toBe(bytes.byteLength);
      expect(readFileSync(prepared.value.stagingPath)).toEqual(bytes);
      expect(prepared.value.importedFromPath).toBe("/workspace/notes.txt");
    } else {
      expect(prepared.ok && prepared.value.kind).toBe("file");
    }
  });

  it("keeps a binary-classified body Vault-backed at every size even when its bytes are valid UTF-8", () => {
    const f = fixture();
    const source = join(f.stateDir, "opaque-spool-uuid");
    writeFileSync(source, Buffer.from("plain ascii", "utf8"));
    const prepared = f.store.prepareArtifactBody({
      body: { kind: "file", physicalPath: source, logicalOriginalName: "logo.png", sourceKind: "authenticated-spool" },
      classification: "mime-first",
      identities: { handoffId: HANDOFF, artifactId: ARTIFACT },
      bounds: { maxBytes: 1024 * 1024 },
      provenance: { importedFromPath: null },
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.value.kind).toBe("file");
  });

  it("stages an oversized text body with its exact UTF-8 bytes", () => {
    const f = fixture();
    const text = `${"한".repeat(30000)}padding`;
    const prepared = f.store.prepareArtifactBody({
      body: { kind: "text", text, logicalName: "title-slug-1.md" },
      classification: "mime-first",
      identities: { handoffId: HANDOFF, artifactId: ARTIFACT },
      bounds: { maxBytes: 1024 * 1024 },
      provenance: { importedFromPath: null },
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok && prepared.value.kind === "file") {
      expect(readFileSync(prepared.value.stagingPath)).toEqual(Buffer.from(text, "utf8"));
    } else {
      expect(prepared.ok && prepared.value.kind).toBe("file");
    }
  });

  it("enforces the shared accepted bound before staging and leaves no staged file behind", () => {
    const f = fixture();
    const source = join(f.stateDir, "opaque-spool-uuid");
    writeFileSync(source, Buffer.from("x".repeat(64), "utf8"));
    const prepared = f.store.prepareArtifactBody({
      body: { kind: "file", physicalPath: source, logicalOriginalName: "big.md", sourceKind: "workspace-path" },
      classification: "mime-first",
      identities: { handoffId: HANDOFF, artifactId: ARTIFACT },
      bounds: { maxBytes: 10 },
      provenance: { importedFromPath: null },
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe("ARTIFACT_TOO_LARGE");
    expect(stagingEntries(f.vaultPath)).toEqual([]);
  });

  it("refuses a short text with an unpaired surrogate before any encoding, staging, or record", () => {
    const f = fixture();
    const prepared = f.store.prepareArtifactBody({
      body: { kind: "text", text: "bad \ud800 surrogate", logicalName: "title-slug-1.md" },
      classification: "mime-first",
      identities: { handoffId: HANDOFF, artifactId: ARTIFACT },
      bounds: { maxBytes: 1024 * 1024 },
      provenance: { importedFromPath: null },
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe("INTERNAL_ERROR");
    expect(stagingEntries(f.vaultPath)).toEqual([]);
    expect((f.db.prepare("SELECT COUNT(*) AS count FROM content_records").get() as { count: number }).count).toBe(0);
  });

  it("refuses a threshold-overlong text with an unpaired surrogate with zero staged files", () => {
    const f = fixture();
    const prepared = f.store.prepareArtifactBody({
      body: { kind: "text", text: `${"한".repeat(30000)}bad \ud800 surrogate`, logicalName: "title-slug-1.md" },
      classification: "mime-first",
      identities: { handoffId: HANDOFF, artifactId: ARTIFACT },
      bounds: { maxBytes: 1024 * 1024 },
      provenance: { importedFromPath: null },
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe("INTERNAL_ERROR");
    expect(stagingEntries(f.vaultPath)).toEqual([]);
    expect((f.db.prepare("SELECT COUNT(*) AS count FROM content_records").get() as { count: number }).count).toBe(0);
  });
});

describe("openBody: one uniform bounded handle for both representations", () => {
  it("serves exact bounded reads of an inline record with end-of-body and argument semantics", () => {
    const f = fixture();
    const text = "\uFEFFfirst\r\nsecond";
    const inline = f.store.writeInline({ contentId: randomUUID(), text, createdAt: "2026-01-01T00:00:00.000Z" });
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    const handle = f.store.openBody(inline.value.recordId, { verifyFileDigest: "never" });
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;
    expect(handle.value.representation).toBe("inline");
    expect(handle.value.storageKey).toBeNull();
    const first = handle.value.read(0, 1024);
    expect(first.ok && Buffer.from(first.value).toString("utf8")).toBe(text);
    const suffix = handle.value.read(10, 1024);
    expect(suffix.ok && Buffer.from(suffix.value).toString("utf8")).toBe("second");
    const atEnd = handle.value.read(Buffer.byteLength(text, "utf8"), 10);
    expect(atEnd.ok && atEnd.value.byteLength).toBe(0);
    const pastEnd = handle.value.read(Buffer.byteLength(text, "utf8") + 5, 10);
    expect(pastEnd.ok && pastEnd.value.byteLength).toBe(0);
    const invalid = handle.value.read(-1, 4);
    expect(invalid.ok).toBe(false);
    handle.value.close();
    handle.value.close();
  });

  it("serves file-backed bytes without hashing under the hot policy and detects tampering under mandatory gates", () => {
    const f = fixture();
    const bytes = Buffer.from("# report\r\n한국어 body", "utf8");
    const { recordId, storageKey } = writeCommonFile(f, bytes);

    const hot = f.store.openBody(recordId, { verifyFileDigest: "if-configured", verifyChecksumOnFetch: false });
    expect(hot.ok).toBe(true);
    if (hot.ok) {
      const whole = hot.value.read(0, 1024);
      expect(whole.ok && Buffer.from(whole.value)).toEqual(bytes);
      hot.value.close();
    }

    const target = join(f.vaultPath, storageKey);
    chmodSync(target, 0o644);
    writeFileSync(target, Buffer.from("tampered but decodable", "utf8"));
    const stillOpen = f.store.openBody(recordId, { verifyFileDigest: "if-configured", verifyChecksumOnFetch: false });
    expect(stillOpen.ok).toBe(true);
    if (stillOpen.ok) stillOpen.value.close();

    const gate = f.store.openBody(recordId, { verifyFileDigest: "always" });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error.code).toBe("CONTENT_CORRUPTED");
  });

  it.each(["growth", "shrink", "digest", "fstat", "fstat-close"] as const)(
    "closes the actual managed descriptor once on a %s refusal",
    (fault) => {
      const f = fixture();
      const bytes = Buffer.from("original file bytes");
      const { recordId, storageKey } = writeCommonFile(f, bytes);
      const leaf = join(f.vaultPath, storageKey);
      chmodSync(leaf, 0o600);
      if (fault === "growth") appendFileSync(leaf, "appended");
      if (fault === "shrink") writeFileSync(leaf, "short");
      if (fault === "digest") writeFileSync(leaf, Buffer.alloc(bytes.length, 0x78));

      const realOpen = managedPaths.openManagedFile;
      const realStat = fs.fstatSync;
      const realClose = fs.closeSync;
      let opened: number | undefined;
      let closes = 0;
      const opener = vi.spyOn(managedPaths, "openManagedFile").mockImplementation((root, key) => {
        const fd = realOpen(root, key);
        opened = fd;
        return fd;
      });
      const stat = vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
        if (fd === opened && fault.startsWith("fstat")) {
          throw Object.assign(new Error("owned extent fstat failed"), { code: "EIO" });
        }
        return realStat(fd, options as never);
      }) as typeof fs.fstatSync);
      const closer = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        if (fd === opened) closes += 1;
        realClose(fd);
        if (fd === opened && fault === "fstat-close") throw new Error("disposal failed after consuming the fd");
      });
      // Keep the builtin's named ESM bindings aligned with these scoped
      // observations; every actual open/read/close still reaches the OS.
      syncBuiltinESMExports();
      try {
        const refused = f.store.openBody(recordId, { verifyFileDigest: "always" });
        expect(refused).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });
        if (!refused.ok && fault.startsWith("fstat")) {
          expect(refused.error.details).toMatchObject({ cause: "Error: owned extent fstat failed" });
        }
        expect(opened).toBeTypeOf("number");
        expect(closes).toBe(1);
        expect(() => realStat(opened as number)).toThrow(/EBADF/);
      } finally {
        closer.mockRestore();
        stat.mockRestore();
        opener.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  it("rejects appended bytes at a mandatory gate so extra content cannot escape verification", () => {
    const f = fixture();
    const bytes = Buffer.from("# report", "utf8");
    const { recordId, storageKey } = writeCommonFile(f, bytes);
    const target = join(f.vaultPath, storageKey);
    chmodSync(target, 0o644);
    appendFileSync(target, Buffer.from("appended", "utf8"));
    const gate = f.store.openBody(recordId, { verifyFileDigest: "always" });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error.code).toBe("CONTENT_CORRUPTED");
  });

  it("reports an unmaterialized file record as not ready without opening anything", () => {
    const f = fixture();
    const recordId = randomUUID();
    f.db.exec("BEGIN IMMEDIATE");
    f.store.insertContentRecord({
      id: recordId,
      inlineText: null,
      storageKey: `content/memo/${OWNER}/${recordId}`,
      sizeBytes: 6,
      sha256: "a".repeat(64),
      materialized: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    f.db.exec("COMMIT");
    const handle = f.store.openBody(recordId, { verifyFileDigest: "never" });
    expect(handle.ok).toBe(false);
    if (!handle.ok) expect(handle.error.code).toBe("CONTENT_MATERIALIZING");
  });

  it("clamps one file read to the streaming buffer and refuses reads after close", () => {
    const f = fixture();
    const body = Buffer.alloc(1024 * 1024 + 2048);
    for (let index = 0; index < body.byteLength; index += 97) body[index] = 0x61 + (index % 26);
    const { recordId } = writeCommonFile(f, body);
    const handle = f.store.openBody(recordId, { verifyFileDigest: "never" });
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;
    const huge = handle.value.read(0, 512 * 1024 * 1024);
    expect(huge.ok && huge.value.byteLength).toBe(1024 * 1024);
    let drained = 0;
    let position = 0;
    for (;;) {
      const chunk = handle.value.read(position, 256 * 1024);
      if (!chunk.ok) break;
      if (chunk.value.byteLength === 0) break;
      expect(Buffer.compare(Buffer.from(chunk.value), body.subarray(position, position + chunk.value.byteLength))).toBe(
        0,
      );
      position += chunk.value.byteLength;
      drained += 1;
    }
    expect(position).toBe(body.byteLength);
    expect(drained).toBeGreaterThan(1);
    handle.value.close();
    const afterClose = handle.value.read(0, 16);
    expect(afterClose.ok).toBe(false);
  });
});

describe("materializeLocalPath: one local-path surface for both representations", () => {
  it("materializes an inline record into the checksum-addressed fetch cache and reuses it", () => {
    const f = fixture();
    const text = "cached\r\n한국어";
    const inline = f.store.writeInline({ contentId: randomUUID(), text, createdAt: "2026-01-01T00:00:00.000Z" });
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    const first = f.store.materializeLocalPath(inline.value.recordId, { stateDir: f.stateDir });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = f.store.materializeLocalPath(inline.value.recordId, { stateDir: f.stateDir });
    expect(second.ok && second.value).toBe(first.value);
    expect(readFileSync(first.value)).toEqual(Buffer.from(text, "utf8"));
    expect(statSync(first.value).mode & 0o222).toBe(0);
  });

  it("resolves a file-backed record to its managed in-Vault path without a cache file", () => {
    const f = fixture();
    const bytes = Buffer.from("vault-backed body", "utf8");
    const { recordId, storageKey } = writeCommonFile(f, bytes);
    const path = f.store.materializeLocalPath(recordId, { stateDir: f.stateDir });
    expect(path.ok && path.value).toBe(join(realpathSync(f.vaultPath), storageKey));
    expect(existsSync(join(f.stateDir, "fetch-cache"))).toBe(false);
  });

  it("refuses an unreadable file without returning its path as a successful materialization", () => {
    const f = fixture();
    const { recordId, storageKey } = writeCommonFile(f, Buffer.from("unreadable body", "utf8"));
    const file = join(f.vaultPath, storageKey);
    chmodSync(file, 0o000);
    try {
      expect(() => readFileSync(file)).toThrow();
      const path = f.store.materializeLocalPath(recordId, { stateDir: f.stateDir });
      expect(path.ok).toBe(false);
      if (!path.ok) expect(path.error.code).toBe("CONTENT_CORRUPTED");
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("reports a visible missing-content failure when a materialized record's file is gone", () => {
    const f = fixture();
    const bytes = Buffer.from("vanishing body", "utf8");
    const { recordId, storageKey } = writeCommonFile(f, bytes);
    unlinkSync(join(f.vaultPath, storageKey));
    const path = f.store.materializeLocalPath(recordId, { stateDir: f.stateDir });
    expect(path.ok).toBe(false);
    if (!path.ok) expect(path.error.code).toBe("CONTENT_CORRUPTED");
  });
});

describe("removeContentRecordInTx: the shared reference-proof removal primitive", () => {
  const references = (domainIds: string[]): ContentReferences => ({
    domainReferencedRecordIds: () =>
      domainIds.length === 0 ? { ok: true, value: [] } : { ok: true, value: domainIds },
    receiptReferencedRecordIds: () => ({ ok: true, value: [] }),
  });

  it("removes an unreferenced inline record inside the caller's transaction without any intent", () => {
    const f = fixture();
    const recordId = randomUUID();
    const inline = f.store.writeInline({
      contentId: recordId,
      text: "removable",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    f.db.exec("BEGIN IMMEDIATE");
    const plan = f.store.removeContentRecordInTx(recordId, {
      references: references([]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    f.db.exec("COMMIT");
    expect(plan).toEqual({ ok: true, value: { action: "remove-inline" } });
    expect(f.store.readRecord(recordId)).toEqual({ ok: true, value: null });
    expect((f.db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as { count: number }).count).toBe(0);
  });

  it("retains a domain-referenced record and leaves its row in place", () => {
    const f = fixture();
    const recordId = randomUUID();
    const inline = f.store.writeInline({ contentId: recordId, text: "live", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    f.db.exec("BEGIN IMMEDIATE");
    const plan = f.store.removeContentRecordInTx(recordId, {
      references: references([recordId]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    f.db.exec("COMMIT");
    expect(plan).toEqual({ ok: true, value: { action: "retain", reason: "domain-reference" } });
    expect(f.store.readRecord(recordId)).toMatchObject({ ok: true, value: { id: recordId } });
  });

  it("removes an artifact-keyed record with the physical unlink owed elsewhere, never a common intent", () => {
    const f = fixture();
    const recordId = randomUUID();
    f.db.exec("BEGIN IMMEDIATE");
    f.store.insertContentRecord({
      id: recordId,
      inlineText: null,
      storageKey: `artifacts/${HANDOFF}/a1b2c3d4e/report.md`,
      sizeBytes: 6,
      sha256: "b".repeat(64),
      materialized: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const plan = f.store.removeContentRecordInTx(recordId, {
      references: references([]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    f.db.exec("COMMIT");
    expect(plan).toEqual({ ok: true, value: { action: "remove-record", physicalUnlink: "owed-elsewhere" } });
    expect(f.store.readRecord(recordId)).toEqual({ ok: true, value: null });
    expect((f.db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as { count: number }).count).toBe(0);
  });

  it("retains a record while a pending activation intent names it", () => {
    const f = fixture();
    const recordId = randomUUID();
    f.db.exec("BEGIN IMMEDIATE");
    f.db
      .prepare(
        "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, owner_domain, owner_id, content_id, created_at, attempts) VALUES (?, 'activate', 'staging/x', ?, NULL, 'memo', ?, ?, ?, 0)",
      )
      .run(randomUUID(), `content/memo/${OWNER}/${recordId}`, OWNER, recordId, "2026-01-01T00:00:00.000Z");
    f.store.insertContentRecord({
      id: recordId,
      inlineText: null,
      storageKey: `content/memo/${OWNER}/${recordId}`,
      sizeBytes: 6,
      sha256: "c".repeat(64),
      materialized: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    f.db.exec("COMMIT");
    f.db.exec("BEGIN IMMEDIATE");
    const plan = f.store.removeContentRecordInTx(recordId, {
      references: references([]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    f.db.exec("COMMIT");
    expect(plan).toEqual({ ok: true, value: { action: "retain", reason: "pending-common-activation" } });
    expect(f.store.readRecord(recordId)).toMatchObject({ ok: true, value: { id: recordId } });
  });
});

describe("malformed stored keys fail closed through both removal paths", () => {
  const references = (domainIds: string[]): ContentReferences => ({
    domainReferencedRecordIds: () =>
      domainIds.length === 0 ? { ok: true, value: [] } : { ok: true, value: domainIds },
    receiptReferencedRecordIds: () => ({ ok: true, value: [] }),
  });
  // The standalone cleanup iterates ORDER BY id, so this inline id sorts before
  // the malformed row and its deletion proves the rollback reaches earlier work.
  const INLINE_ID = "00000000-0000-4000-8000-0000000000aa";
  const MALFORMED_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const MISMATCH_ID = "0123abcd-0000-4000-8000-0000000000e1";
  const MISMATCH_KEY = `content/memo/${OWNER}/0123abcd-0000-4000-8000-0000000000e2`;

  function insertFileRecordDirect(f: ReturnType<typeof fixture>, recordId: string, storageKey: string): void {
    f.db.exec("BEGIN IMMEDIATE");
    f.db
      .prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 6, ?, 1, '2026-01-01T00:00:00.000Z')",
      )
      .run(recordId, storageKey, "a".repeat(64));
    f.db.exec("COMMIT");
  }

  it("rolls the whole standalone cleanup batch back, including earlier removable deletions", () => {
    const f = fixture();
    const inline = f.store.writeInline({
      contentId: INLINE_ID,
      text: "removable earlier in the batch",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(inline.ok).toBe(true);
    insertFileRecordDirect(f, MALFORMED_ID, "../outside/x.md");

    const result = f.store.cleanup(references([]), new Date("2026-06-01T00:00:00.000Z"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(f.store.readRecord(INLINE_ID)).toMatchObject({ ok: true, value: { id: INLINE_ID } });
    expect(f.store.readRecord(MALFORMED_ID)).toMatchObject({ ok: true, value: { id: MALFORMED_ID } });
    expect((f.db.prepare("SELECT COUNT(*) AS count FROM pending_fs_ops").get() as { count: number }).count).toBe(0);

    // A repaired owned fixture cleanup succeeds afterwards.
    f.db.exec("BEGIN IMMEDIATE");
    f.db.prepare("DELETE FROM content_records WHERE id = ?").run(MALFORMED_ID);
    f.db.exec("COMMIT");
    const repaired = f.store.cleanup(references([]), new Date("2026-06-01T00:00:00.000Z"));
    expect(repaired).toEqual(ok({ removedInlineIds: [INLINE_ID], scheduledUnlinkIds: [], removedFileOnlyIds: [] }));
  });

  it("refuses and preserves each malformed key shape through the standalone cleanup", () => {
    for (const storageKey of ["/outside/x.md", "../outside/x.md", "content//leaf"]) {
      const f = fixture();
      insertFileRecordDirect(f, MALFORMED_ID, storageKey);
      const result = f.store.cleanup(references([]), new Date("2026-06-01T00:00:00.000Z"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(f.store.readRecord(MALFORMED_ID)).toMatchObject({ ok: true, value: { id: MALFORMED_ID } });
    }
  });

  it("propagates the in-tx refusal so a caller aborts its enclosing transaction's earlier changes", () => {
    const f = fixture();
    const inline = f.store.writeInline({
      contentId: INLINE_ID,
      text: "earlier change inside the caller's transaction",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(inline.ok).toBe(true);
    insertFileRecordDirect(f, MALFORMED_ID, "../outside/x.md");

    f.db.exec("BEGIN IMMEDIATE");
    const first = f.store.removeContentRecordInTx(INLINE_ID, {
      references: references([]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(first).toEqual({ ok: true, value: { action: "remove-inline" } });
    const second = f.store.removeContentRecordInTx(MALFORMED_ID, {
      references: references([]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    // The caller honors the propagated failure and rolls back its whole
    // transaction, so the helper's earlier deletion is undone with it.
    f.db.exec("ROLLBACK");
    expect(f.store.readRecord(INLINE_ID)).toMatchObject({ ok: true, value: { id: INLINE_ID } });
    expect(f.store.readRecord(MALFORMED_ID)).toMatchObject({ ok: true, value: { id: MALFORMED_ID } });
  });

  it("refuses a content-keyed record whose stored identity mismatches through the in-tx helper", () => {
    const f = fixture();
    insertFileRecordDirect(f, MISMATCH_ID, MISMATCH_KEY);
    f.db.exec("BEGIN IMMEDIATE");
    const refused = f.store.removeContentRecordInTx(MISMATCH_ID, {
      references: references([]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    f.db.exec("ROLLBACK");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INTERNAL_ERROR");
    expect(f.store.readRecord(MISMATCH_ID)).toMatchObject({ ok: true, value: { id: MISMATCH_ID } });
  });

  it("refuses the same identity mismatch through the standalone cleanup", () => {
    const f = fixture();
    insertFileRecordDirect(f, MISMATCH_ID, MISMATCH_KEY);
    const result = f.store.cleanup(references([]), new Date("2026-06-01T00:00:00.000Z"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(f.store.readRecord(MISMATCH_ID)).toMatchObject({ ok: true, value: { id: MISMATCH_ID } });
  });
});
