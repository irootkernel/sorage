import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveVault, vaultVerify } from "@sorage/core";
import {
  activateCommonFile,
  createSqliteContentStore,
  materializeFetchCacheFile,
  sweepFetchCache,
  unlinkCommonFile,
} from "../../src/content-store";
import { collectVaultGarbage, createSqliteIntentLog } from "../../src/intent-log";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { managedPath, UnsafeManagedPathError } from "../../src/managed-paths";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { createVaultInitializer } from "../../src/vault";
import { SystemClock } from "@sorage/core";
import { memoInstallation, unwrap } from "../fixtures/memo-installation";

const OWNER = "0123abcd-0000-4000-8000-000000000001";
const BODY = Buffer.from("\uFEFFowned canary\r\nno-final-lf");
const HASH = createHash("sha256").update(BODY).digest("hex");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const value = memoInstallation();
  const db = openSorageDatabase(value.database);
  cleanups.push(() => {
    db.close();
    value.cleanup();
  });
  const installationId = JSON.parse(readFileSync(join(value.vault, ".sorage-vault.json"), "utf8"))
    .installationId as string;
  const store = createSqliteContentStore({ db, vaultPath: value.vault, installationId });
  return { ...value, db, store, installationId };
}
function record(f: ReturnType<typeof fixture>, id: string, key: string) {
  f.db.exec("BEGIN");
  f.store.insertContentRecord({
    id,
    storageKey: key,
    inlineText: null,
    sizeBytes: BODY.length,
    sha256: HASH,
    materialized: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  f.db.exec("COMMIT");
}
function linkedParent(f: ReturnType<typeof fixture>, parent: string, key: string) {
  const outside = join(f.home, "outside");
  const path = join(f.vault, parent);
  const canary = join(outside, relative(path, join(f.vault, key)));
  mkdirSync(dirname(canary), { recursive: true });
  writeFileSync(canary, BODY);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { recursive: true, force: true });
  symlinkSync(outside, path, "dir");
  return canary;
}
function activation(f: ReturnType<typeof fixture>, key: string) {
  writeFileSync(join(f.vault, "staging", "source"), BODY);
  return activateCommonFile({
    vaultPath: f.vault,
    fromPath: "staging/source",
    toPath: key,
    expect: { sizeBytes: BODY.length, sha256: HASH },
  });
}

describe("the managed content filesystem boundary", () => {
  it.each(["content", "content/memo", `content/memo/${OWNER}`])(
    "refuses linked parent %s at activate, read and unlink",
    (parent) => {
      const f = fixture();
      const id = randomUUID();
      const key = `content/memo/${OWNER}/${id}`;
      const canary = linkedParent(f, parent, key);
      record(f, id, key);
      expect(activation(f, key)).toEqual({ status: "failed", reason: "unsafe_path" });
      expect(f.store.read(id)).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });
      expect(unlinkCommonFile({ vaultPath: f.vault, toPath: key })).toEqual({
        status: "failed",
        reason: "unsafe_path",
      });
      expect(readFileSync(canary)).toEqual(BODY);
      expect(readFileSync(join(f.vault, "staging/source"))).toEqual(BODY);
    },
  );

  it.each(["symlink", "dangling", "directory", "fifo"])(
    "refuses an unsafe %s leaf without treating it as absence",
    (kind) => {
      const f = fixture();
      const id = randomUUID();
      const key = `content/memo/${OWNER}/${id}`;
      const path = join(f.vault, key);
      const outside = join(f.home, "outside");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(outside, BODY);
      if (kind === "directory") mkdirSync(path);
      else if (kind === "fifo") execFileSync("mkfifo", [path]);
      else symlinkSync(kind === "dangling" ? `${outside}-missing` : outside, path);
      record(f, id, key);
      expect(activation(f, key)).toEqual({ status: "failed", reason: "unsafe_path" });
      expect(f.store.read(id)).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });
      expect(unlinkCommonFile({ vaultPath: f.vault, toPath: key })).toEqual({
        status: "failed",
        reason: "unsafe_path",
      });
      expect(readFileSync(outside)).toEqual(BODY);
    },
  );

  it("does not follow the staging root during streaming, byte staging or recovery", () => {
    const f = fixture();
    const outside = join(f.home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "source"), BODY);
    rmSync(join(f.vault, "staging"), { recursive: true });
    symlinkSync(outside, join(f.vault, "staging"), "dir");
    const source = join(f.home, "incoming");
    writeFileSync(source, BODY);
    expect(f.store.stage({ sourcePath: source, maxBytes: 1024 }).ok).toBe(false);
    expect(
      f.store.write({
        body: { kind: "binary", bytes: BODY },
        owner: { domain: "memo", ownerId: OWNER },
        maxBytes: 1024,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(false);
    const key = `content/memo/${OWNER}/${randomUUID()}`;
    expect(
      activateCommonFile({
        vaultPath: f.vault,
        fromPath: "staging/source",
        toPath: key,
        expect: { sizeBytes: BODY.length, sha256: HASH },
      }),
    ).toEqual({ status: "failed", reason: "unsafe_path" });
    expect(readFileSync(join(outside, "source"))).toEqual(BODY);
  });

  it("records ordinary and repeated drain failures atomically without activation success", () => {
    const f = fixture();
    const id = randomUUID();
    const key = `content/memo/${OWNER}/${id}`;
    const source = join(f.home, "incoming");
    writeFileSync(source, BODY);
    const staged = unwrap(f.store.stage({ sourcePath: source, maxBytes: 1024 }));
    const canary = linkedParent(f, `content/memo/${OWNER}`, key);
    expect(
      f.store.writeFile({
        contentId: id,
        owner: { domain: "memo", ownerId: OWNER },
        staged,
        intentId: randomUUID(),
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { activated: "failed-assessment", failureReason: "unsafe_path" },
    });
    const log = createSqliteIntentLog({ db: f.db, installationId: f.installationId });
    expect(log.drain(f.vault).ok).toBe(true);
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(id)).toMatchObject({
      materialized: 0,
    });
    expect(f.db.prepare("SELECT attempts FROM pending_fs_ops").get()).toMatchObject({ attempts: 2 });
    const events = f.db.prepare("SELECT event_type FROM events").all();
    expect(events).toEqual([{ event_type: "CONTENT_INTEGRITY_FAILED" }, { event_type: "CONTENT_INTEGRITY_FAILED" }]);
    expect(readFileSync(canary)).toEqual(BODY);
    expect(readFileSync(staged.stagingPath)).toEqual(BODY);
  });

  it.each(["content", "artifacts"])("guards %s records in both operational censuses", (root) => {
    const f = fixture();
    const id = randomUUID();
    const key =
      root === "content" ? `content/memo/${OWNER}/${id}` : `artifacts/${randomUUID()}/${randomUUID()}/body.bin`;
    const canary = linkedParent(f, root, key);
    record(f, id, key);
    expect(f.store.read(id)).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });
    const doctor = createNodeDoctorPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
    expect(doctor.probe("content.checksums").severity).toBe("blocking");
    const ports = unwrap(createNodeVaultCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).verifyPorts());
    const verified = unwrap(vaultVerify(ports, { now: new Date() }));
    expect(verified.findings.join(" ")).toContain(key);
    expect(readFileSync(canary)).toEqual(BODY);
  });

  it.each(["staging", "artifacts", "content"])("skips unsafe GC root %s and preserves its outside canary", (root) => {
    const f = fixture();
    const key = `${root}/canary`;
    const canary = linkedParent(f, root, key);
    utimesSync(canary, new Date(0), new Date(0));
    const result = unwrap(
      collectVaultGarbage(f.vault, [], {
        now: new Date(),
        graceHours: 1,
        liveStorageKeys: [],
        liveContentKeys: [],
        sweepArtifactsWithoutRegistry: true,
        sweepContentWithoutRegistry: true,
      }),
    );
    expect(result).toEqual({ sweptStaging: [], sweptUnreferenced: [], sweptContent: [] });
    expect(readFileSync(canary)).toEqual(BODY);
  });

  it("sweeps a regular aged content file while skipping a neighboring linked subtree", () => {
    const f = fixture();
    const outside = join(f.home, "outside");
    mkdirSync(outside);
    const canary = join(outside, "canary");
    writeFileSync(canary, BODY);
    utimesSync(canary, new Date(0), new Date(0));
    symlinkSync(outside, join(f.vault, "content", "linked"), "dir");
    const orphan = join(f.vault, "content", "orphan");
    writeFileSync(orphan, BODY);
    utimesSync(orphan, new Date(0), new Date(0));
    const result = unwrap(
      collectVaultGarbage(f.vault, [], {
        now: new Date(),
        graceHours: 1,
        liveStorageKeys: [],
        liveContentKeys: [],
        sweepContentWithoutRegistry: true,
      }),
    );
    expect(result.sweptContent).toEqual([join(realpathSync(f.vault), "content/orphan")]);
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(canary)).toEqual(BODY);
  });

  it.each(["state", "cache", "leaf", "dangling"])(
    "refuses a linked cache %s boundary in materialize and sweep",
    (kind) => {
      const f = fixture();
      const state = join(f.home, "cache-state");
      mkdirSync(state);
      const outside = join(f.home, "outside-cache");
      mkdirSync(outside);
      const canary = join(outside, HASH);
      writeFileSync(canary, BODY);
      utimesSync(canary, new Date(0), new Date(0));
      if (kind === "state") {
        rmSync(state, { recursive: true });
        symlinkSync(outside, state, "dir");
      } else if (kind === "cache") symlinkSync(outside, join(state, "fetch-cache"), "dir");
      else {
        mkdirSync(join(state, "fetch-cache"));
        symlinkSync(kind === "dangling" ? `${canary}-missing` : canary, join(state, "fetch-cache", HASH));
      }
      expect(materializeFetchCacheFile(state, HASH, BODY).ok).toBe(false);
      expect(sweepFetchCache(state, { graceHours: 1, now: new Date() })).toEqual([]);
      expect(readFileSync(canary)).toEqual(BODY);
    },
  );

  it.each(["../outside", "content/../outside", "/outside", "content//leaf", "content\\leaf", "content/\0leaf"])(
    "rejects malformed managed key %s",
    (key) => {
      const f = fixture();
      expect(() => managedPath(f.vault, key)).toThrow(UnsafeManagedPathError);
    },
  );

  it("keeps a selected Vault alias usable through canonical managed I/O", () => {
    const f = fixture();
    const alias = join(f.home, "vault-alias");
    symlinkSync(f.vault, alias, "dir");
    const store = createSqliteContentStore({ db: f.db, vaultPath: alias, installationId: f.installationId });
    const written = unwrap(
      store.write({
        body: { kind: "binary", bytes: BODY },
        owner: { domain: "memo", ownerId: OWNER },
        maxBytes: 1024,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(unwrap(store.read(written.recordId)).bytes).toEqual(BODY);
  });

  it.each(["source-root", "source-leaf", "target-root", "target-parent", "target-leaf"])(
    "refuses unsafe move %s without changing the active Vault",
    (kind) => {
      const f = fixture();
      const target = join(f.home, "move-target");
      const key = `content/memo/${OWNER}/${randomUUID()}`;
      const before = readFileSync(join(f.home, "config.yaml"));
      let canary: string;
      if (kind === "source-root") canary = linkedParent(f, "content", key);
      else if (kind === "source-leaf") {
        canary = join(f.home, "outside");
        writeFileSync(canary, BODY);
        mkdirSync(dirname(join(f.vault, key)), { recursive: true });
        symlinkSync(canary, join(f.vault, key));
      } else {
        mkdirSync(target);
        const outside = join(f.home, "outside");
        mkdirSync(outside);
        canary = join(outside, "canary");
        writeFileSync(canary, BODY);
        writeFileSync(
          join(target, ".sorage-move-scratch.json"),
          JSON.stringify({
            type: "sorage-vault-move-scratch",
            installationId: f.installationId,
            sourceVaultPath: realpathSync(f.vault),
          }),
        );
        const linked =
          kind === "target-root"
            ? join(target, "content")
            : kind === "target-parent"
              ? join(target, "content/memo")
              : join(target, key);
        mkdirSync(dirname(linked), { recursive: true });
        symlinkSync(kind === "target-leaf" ? canary : outside, linked);
      }
      const ports = unwrap(
        createNodeVaultCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, targetPath: target }).movePorts(),
      );
      expect(moveVault(ports).ok).toBe(false);
      expect(readFileSync(join(f.home, "config.yaml"))).toEqual(before);
      expect(readFileSync(canary)).toEqual(BODY);
    },
  );

  it("refuses an unsafe content directory in initialization and writable backup preparation", () => {
    const f = fixture();
    const canary = linkedParent(f, "content", "content/canary");
    expect(createVaultInitializer(new SystemClock()).initialize(f.vault, f.installationId).ok).toBe(false);
    const run = unwrap(createNodeBackupCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).runPorts());
    expect(run.prepareWritableContent().ok).toBe(false);
    expect(readFileSync(canary)).toEqual(BODY);
    expect(existsSync(join(f.home, "outside", ".sentinel"))).toBe(false);
  });
});
