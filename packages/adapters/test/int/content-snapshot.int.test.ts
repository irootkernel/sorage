import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupRestore,
  backupVerify,
  canonicalJson,
  canonicalJsonLine,
  exportSnapshot,
  SYSTEM_ACTOR,
} from "@sorage/core";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createSqliteEventLedger } from "../../src/events";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { MEMO_ID, MEMO_PROJECT, memoInstallation, seedMemoInstallation, unwrap } from "../fixtures/memo-installation";

type Installation = ReturnType<typeof memoInstallation>;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function installation() {
  const value = memoInstallation();
  cleanups.push(value.cleanup);
  return value;
}
function ports(value: Installation, source?: Installation) {
  return createNodeBackupCommandPorts({
    env: { SORAGE_HOME: value.home },
    userHome: value.home,
    sourcePath: source?.vault,
  });
}
function manifestPath(value: Installation) {
  return join(value.vault, "snapshots", "manifest.json");
}
function eventsPath(value: Installation) {
  return join(value.vault, "snapshots", "events.jsonl");
}
function inventory(value: Installation) {
  const db = openSorageDatabase(value.database);
  try {
    return ["projects", "project_memos", "events", "content_records", "idempotency_keys", "pending_fs_ops"].map(
      (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  } finally {
    db.close();
  }
}
function commonHistory(value: Installation) {
  const db = openSorageDatabase(value.database);
  try {
    return db
      .prepare("SELECT * FROM events WHERE event_type LIKE 'CONTENT_%' ORDER BY id")
      .all()
      .map((row) => ({ ...row, metadata_json: JSON.parse(String(row.metadata_json)) }));
  } finally {
    db.close();
  }
}
function exportedHistory() {
  const source = installation();
  seedMemoInstallation(source);
  const db = openSorageDatabase(source.database);
  try {
    const ledger = createSqliteEventLedger(db);
    for (const eventType of ["CONTENT_ACTIVATED", "CONTENT_UNLINKED", "CONTENT_INTEGRITY_FAILED"] as const) {
      unwrap(
        ledger.appendStandalone({
          id: randomUUID(),
          eventType,
          actor: SYSTEM_ACTOR,
          metadata: {
            contentId: randomUUID(),
            ownerDomain: "channel",
            ownerId: randomUUID(),
            intentId: randomUUID(),
            operation: eventType === "CONTENT_UNLINKED" ? "unlink" : "activate",
            ...(eventType === "CONTENT_INTEGRITY_FAILED" ? { attempt: 1, reason: "destination_conflict" } : {}),
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    expect(db.prepare("SELECT id FROM content_records").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'channel%'").all()).toEqual([]);
  } finally {
    db.close();
  }
  unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
  return source;
}

function refusesBeforeImport(source: Installation, code: string) {
  expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() })).toMatchObject({
    ok: false,
    error: { code },
  });
  const target = installation();
  const before = inventory(target);
  const config = readFileSync(join(target.home, "config.yaml"));
  const marker = readFileSync(join(target.vault, ".sorage-vault.json"));
  for (const dryRun of [true, false]) {
    expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun })).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(inventory(target)).toEqual(before);
    expect(readFileSync(join(target.home, "config.yaml"))).toEqual(config);
    expect(readFileSync(join(target.vault, ".sorage-vault.json"))).toEqual(marker);
  }
}

function exportedHandoff() {
  const source = installation();
  seedMemoInstallation(source);
  const id = randomUUID();
  const artifactId = randomUUID();
  const storageKey = `artifacts/${id}/${artifactId}/body.md`;
  const bytes = Buffer.from("\uFEFFArtifact\r\nno-final-newline");
  mkdirSync(join(source.vault, "artifacts", id, artifactId), { recursive: true });
  writeFileSync(join(source.vault, storageKey), bytes);
  const db = openSorageDatabase(source.database);
  try {
    db.exec("BEGIN");
    db.prepare(`INSERT INTO handoffs
      (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state,
       consecutive_no_change_resolutions, pinned, created_at, updated_at)
      VALUES (?, 'Shard identity', 'user', ?, ?, 1, 1, 'awaiting_recipient', 0, 0, ?, ?)`).run(
      id,
      MEMO_PROJECT,
      artifactId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z')",
    ).run(randomUUID(), storageKey, bytes.length, createHash("sha256").update(bytes).digest("hex"));
    db.prepare(`INSERT INTO artifacts (id,handoff_id,original_name,stored_name,mime_type,imported_from_path,created_at,content_record_id)
      VALUES (?,?,'body.md','body.md','text/markdown',NULL,'2026-01-01T00:00:00.000Z',
        (SELECT id FROM content_records WHERE storage_key = ?))`).run(artifactId, id, storageKey);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
  expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }).ok).toBe(true);
  return { source, id, path: join(source.vault, "snapshots", "handoffs", id.slice(0, 2), `${id}.json`) };
}

describe("format-3 filesystem and representation boundaries", () => {
  it.each([
    "compact",
    "duplicate-key",
    "bom",
    "crlf",
    "no-lf",
    "non-array",
    "null-project",
    "id",
    "bindings",
    "null-binding",
    "binding-id",
    "description",
    "status",
    "time",
    "duplicate-project",
    "duplicate-slug",
    "duplicate-slug-case",
  ])("refuses malformed Project metadata before import: %s", (defect) => {
    const source = exportedHistory();
    const path = join(source.vault, "snapshots", "projects.json");
    const projects = JSON.parse(readFileSync(path, "utf8"));
    const project = projects[0];
    project.bindings = [
      {
        id: randomUUID(),
        installationId: randomUUID(),
        bindingKind: "directory",
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ];
    if (defect === "null-project") projects[0] = null;
    if (defect === "id") project.id = "not-a-uuid";
    if (defect === "bindings") project.bindings = {};
    if (defect === "null-binding") project.bindings = [null];
    if (defect === "binding-id") project.bindings[0].installationId = "not-a-uuid";
    if (defect === "description") project.description = 1;
    if (defect === "status") project.status = "unknown";
    if (defect === "time") project.createdAt = "invalid";
    if (defect === "duplicate-project" || defect === "duplicate-slug" || defect === "duplicate-slug-case") {
      if (defect === "duplicate-slug-case") project.slug = "alpha";
      projects.push({
        ...project,
        id: defect === "duplicate-project" ? project.id : randomUUID(),
        ...(defect === "duplicate-slug-case" ? { slug: "ALPHA" } : {}),
      });
      const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
      manifest.counts.projects = 2;
      writeFileSync(manifestPath(source), canonicalJson(manifest));
    }
    const raw = canonicalJson(projects);
    const altered =
      defect === "compact"
        ? `${JSON.stringify(projects)}\n`
        : defect === "duplicate-key"
          ? raw.replace('"slug":', '"slug":"duplicate","slug":')
          : defect === "bom"
            ? `\uFEFF${raw}`
            : defect === "crlf"
              ? raw.replaceAll("\n", "\r\n")
              : defect === "no-lf"
                ? raw.trimEnd()
                : defect === "non-array"
                  ? canonicalJson({})
                  : raw;
    writeFileSync(path, altered);
    refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
  });

  it.each([false, true])("refuses NUL Project slugs before import (collision: %s)", (collision) => {
    const source = exportedHistory();
    const path = join(source.vault, "snapshots/projects.json");
    const projects = JSON.parse(readFileSync(path, "utf8"));
    projects[0].slug = "alpha\u0000x";
    if (collision) {
      projects.push({ ...projects[0], id: randomUUID(), slug: "ALPHA\u0000y", bindings: [] });
      const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
      manifest.counts.projects = 2;
      writeFileSync(manifestPath(source), canonicalJson(manifest));
    }
    writeFileSync(path, canonicalJson(projects));
    refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
  });

  it("round-trips the stored Unicode slug from an accepted native CLI registration", () => {
    const source = installation();
    const directory = join(source.home, "project");
    mkdirSync(directory);
    const entry = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));
    const added = spawnSync(
      "bun",
      [entry, "project", "add", "--name", "Turkish", "--slug", "İ", "--dir", directory, "--as-user", "--json"],
      { cwd: directory, env: { ...process.env, SORAGE_HOME: source.home }, encoding: "utf8", timeout: 10_000 },
    );
    expect(added.status, added.stderr).toBe(0);
    unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
    expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }).ok).toBe(true);
    const target = installation();
    expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: true }).ok).toBe(true);
    unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false }));
    for (const value of [source, target]) {
      const db = openSorageDatabase(value.database);
      try {
        expect(db.prepare("SELECT slug, hex(slug) AS bytes FROM projects").all()).toEqual([
          { slug: "i\u0307", bytes: "69CC87" },
        ]);
      } finally {
        db.close();
      }
    }
  });

  it("preserves slugs that SQLite ASCII NOCASE distinguishes during verify and restore", () => {
    const source = exportedHistory();
    const path = join(source.vault, "snapshots/projects.json");
    const projects = JSON.parse(readFileSync(path, "utf8"));
    projects[0].slug = "Alpha";
    projects.push(
      { ...projects[0], id: randomUUID(), slug: "Ä", bindings: [] },
      { ...projects[0], id: randomUUID(), slug: "ä", bindings: [] },
    );
    writeFileSync(path, canonicalJson(projects));
    const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
    manifest.counts.projects = 3;
    writeFileSync(manifestPath(source), canonicalJson(manifest));
    expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }).ok).toBe(true);
    const target = installation();
    expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: true }).ok).toBe(true);
    unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false }));
    const db = openSorageDatabase(target.database);
    try {
      expect(db.prepare("SELECT slug FROM projects ORDER BY slug").all()).toEqual([
        { slug: "Alpha" },
        { slug: "Ä" },
        { slug: "ä" },
      ]);
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "keeps open Project extension fields and historical Binding provenance (directory present: %s)",
    (directoryPresent) => {
      const source = exportedHistory();
      const path = join(source.vault, "snapshots", "projects.json");
      const projects = JSON.parse(readFileSync(path, "utf8"));
      const project = projects[0];
      project.extension = { retainedInput: true };
      project.bindings = [
        {
          id: randomUUID(),
          installationId: randomUUID(),
          bindingKind: "git_repository",
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          extension: "allowed",
          ...(directoryPresent ? { directory: "/unavailable-on-this-installation" } : {}),
        },
      ];
      writeFileSync(path, canonicalJson(projects));
      expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }).ok).toBe(true);
      const target = installation();
      unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: true }));
      unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false }));
      const db = openSorageDatabase(target.database);
      try {
        expect(db.prepare("SELECT * FROM project_bindings").all()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it.each(["blank", "no-lf", "crlf", "order", "spaces", "keys", "bom"])(
    "refuses noncanonical ledger bytes before import: %s",
    (defect) => {
      const source = exportedHistory();
      const raw = readFileSync(eventsPath(source), "utf8");
      const lines = raw.trimEnd().split("\n");
      const altered =
        defect === "blank"
          ? `${raw}\n`
          : defect === "no-lf"
            ? raw.trimEnd()
            : defect === "crlf"
              ? raw.replaceAll("\n", "\r\n")
              : defect === "order"
                ? `${lines.reverse().join("\n")}\n`
                : defect === "spaces"
                  ? `${lines.map((line) => ` ${line}`).join("\n")}\n`
                  : defect === "keys"
                    ? `${lines
                        .map((line) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(line)).reverse())))
                        .join("\n")}\n`
                    : `\uFEFF${raw}`;
      writeFileSync(eventsPath(source), altered);
      refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
    },
  );

  it("classifies a coherent later file-backed Memo as unsupported before import", () => {
    const source = exportedHistory();
    const root = join(source.vault, "snapshots");
    const contentPath = `content/memo/${MEMO_ID}/${randomUUID()}`;
    const bytes = Buffer.from(`\uFEFF${"x".repeat(65_532)}\r\n`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(root, "content", "memo", MEMO_ID), { recursive: true });
    writeFileSync(join(root, contentPath), bytes);
    const path = `memos/ab/${MEMO_ID}.json`;
    const memo = JSON.parse(readFileSync(join(root, path), "utf8"));
    memo.bodyContent = { contentPath, sizeBytes: bytes.length, sha256 };
    const raw = canonicalJson(memo);
    writeFileSync(join(root, path), raw);
    const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
    manifest.memoDigests[path] = createHash("sha256").update(raw).digest("hex");
    manifest.contentDigests = { [contentPath]: sha256 };
    writeFileSync(manifestPath(source), canonicalJson(manifest));
    refusesBeforeImport(source, "VAULT_SCHEMA_UNSUPPORTED");
  });

  it.each(["channels", "content", "handoffs"])("rejects unsafe %s inventory roots and descendants", (family) => {
    for (const scenario of ["root-link", "entry-link", "fifo", "unreadable", "root-file"]) {
      const source = installation();
      unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
      const root = join(source.vault, "snapshots", family);
      const outside = join(source.home, "outside");
      mkdirSync(outside);
      if (scenario === "root-link") symlinkSync(outside, root);
      else if (scenario === "root-file") writeFileSync(root, "not a directory");
      else {
        mkdirSync(root, { recursive: true });
        if (scenario === "entry-link") symlinkSync(outside, join(root, "linked"));
        if (scenario === "fifo") expect(spawnSync("mkfifo", [join(root, "pipe")]).status).toBe(0);
        if (scenario === "unreadable") chmodSync(root, 0);
      }
      try {
        refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
      } finally {
        if (scenario === "unreadable") chmodSync(root, 0o700);
      }
    }
  });

  it("rejects files outside an empty content digest inventory", () => {
    const source = installation();
    unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
    mkdirSync(join(source.vault, "snapshots", "content"));
    writeFileSync(join(source.vault, "snapshots", "content", "extra"), "extra");
    refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
  });

  it("rejects a Handoff shard in a prefix different from its UUID", () => {
    const { source, id, path } = exportedHandoff();
    const prefix = id.startsWith("ff") ? "ee" : "ff";
    const directory = join(source.vault, "snapshots", "handoffs", prefix);
    mkdirSync(directory, { recursive: true });
    renameSync(path, join(directory, `${id}.json`));
    refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
  });

  it.each([
    "compact",
    "bom",
    "crlf",
    "no-lf",
    "extra-field",
    "missing-field",
    "wrong-type",
    "invalid-uuid",
    "object-id",
    "invalid-note-author",
    "invalid-user-project",
  ])("rejects noncanonical or malformed Handoff shards: %s", (defect) => {
    const { source, path } = exportedHandoff();
    const raw = readFileSync(path, "utf8");
    const record = JSON.parse(raw);
    if (defect === "extra-field") record.extra = true;
    if (defect === "missing-field") delete record.title;
    if (defect === "wrong-type") record.pinned = 1;
    if (defect === "invalid-uuid") record.dispatchGroupId = "not-a-uuid";
    if (defect === "object-id") record.id = { toString: "not-callable" };
    if (defect === "invalid-note-author" || defect === "invalid-user-project") {
      record.reviewNote = {
        handoffId: record.id,
        authorKind: defect === "invalid-note-author" ? "unregistered_workspace" : "user",
        authorProjectId: defect === "invalid-user-project" ? MEMO_PROJECT : null,
        targetRevision: 1,
        body: "review",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }
    const altered =
      defect === "compact"
        ? `${JSON.stringify(record)}\n`
        : defect === "bom"
          ? `\uFEFF${raw}`
          : defect === "crlf"
            ? raw.replaceAll("\n", "\r\n")
            : defect === "no-lf"
              ? raw.trimEnd()
              : canonicalJson(record);
    writeFileSync(path, altered);
    refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
  });

  it.each(["dual", "missing", "size", "sha", "over-threshold", "surrogate", "unmaterialized"])(
    "refuses malformed inline Artifact %s before any partial restore",
    (defect) => {
      const fixture = exportedHandoff();
      const record = JSON.parse(readFileSync(fixture.path, "utf8"));
      const body =
        defect === "surrogate"
          ? "\uD800"
          : defect === "over-threshold"
            ? "x".repeat(65_537)
            : "\uFEFFExact\r\nno-final-newline";
      const artifact = record.artifact;
      artifact.inlineBody = body;
      artifact.storageKey = null;
      artifact.sizeBytes = Buffer.byteLength(body);
      artifact.sha256 = createHash("sha256").update(body).digest("hex");
      artifact.materialized = true;
      if (defect === "dual") artifact.storageKey = `artifacts/${record.id}/${artifact.id}/body.md`;
      if (defect === "missing") artifact.inlineBody = null;
      if (defect === "size") artifact.sizeBytes += 1;
      if (defect === "sha") artifact.sha256 = "0".repeat(64);
      if (defect === "unmaterialized") artifact.materialized = false;
      writeFileSync(fixture.path, canonicalJson(record));
      refusesBeforeImport(fixture.source, "VAULT_INTEGRITY_ERROR");
    },
  );

  it("preserves a real inline Artifact's exact bytes through native export, restore and fetch", () => {
    const source = installation();
    const target = installation();
    const body = "\uFEFF# Unicode 한글\r\nno-final-newline";
    const core = fileURLToPath(new URL("../../../core/src/index.ts", import.meta.url));
    const backup = fileURLToPath(new URL("../../src/backup-command-ports.ts", import.meta.url));
    const projects = fileURLToPath(new URL("../../src/project-command-ports.ts", import.meta.url));
    const handoffs = fileURLToPath(new URL("../../src/handoff-command-ports.ts", import.meta.url));
    const connection = fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url));
    const script = `
      import { mkdirSync, readFileSync, readdirSync } from "node:fs";
      import { join } from "node:path";
      import { createHash } from "node:crypto";
      import { isDeepStrictEqual } from "node:util";
      const { addProject, USER_ACTOR, sendHandoffs, exportSnapshot, backupRestore, fetchHandoff } = await import(${JSON.stringify(core)});
      const { createNodeBackupCommandPorts } = await import(${JSON.stringify(backup)});
      const { createNodeProjectPorts } = await import(${JSON.stringify(projects)});
      const { createNodeSendPorts, createNodeHandoffReadPorts } = await import(${JSON.stringify(handoffs)});
      const { openSorageDatabase } = await import(${JSON.stringify(connection)});
      const source = ${JSON.stringify({ home: source.home, vault: source.vault, database: source.database })};
      const target = ${JSON.stringify({ home: target.home, vault: target.vault, database: target.database })};
      const body = ${JSON.stringify(body)};
      const exact = Buffer.from(body, "utf8");
      function unwrap(result) { if (!result.ok) throw Error(JSON.stringify(result)); return result.value; }
      const env = { SORAGE_HOME: source.home };
      const dir = join(source.home, "inline-recipient"); mkdirSync(dir);
      unwrap(addProject(createNodeProjectPorts({ env, userHome: source.home }), { name: "Inline Recipient", dir, userHome: source.home, actor: USER_ACTOR }));
      const sent = unwrap(sendHandoffs(createNodeSendPorts({ env, userHome: source.home }), {
        to: ["inline-recipient"], title: "Inline bytes", body, asUser: true, path: source.home, userHome: source.home,
        idempotencyKey: "cddcba01-1111-4111-8111-111111111111"
      }));
      const item = sent.handoffs[0]; if (item.storageKey !== null) throw Error("Expected an inline producer");
      const readRow = (database) => {
        const db = openSorageDatabase(database);
        try { return db.prepare("SELECT a.id AS artifact_id, a.handoff_id, c.* FROM artifacts a JOIN content_records c ON c.id=a.content_record_id WHERE a.id=?").get(item.artifactId); }
        finally { db.close(); }
      };
      const original = readRow(source.database);
      unwrap(exportSnapshot(unwrap(createNodeBackupCommandPorts({ env, userHome: source.home }).exportPorts())));
      const shard = JSON.parse(readFileSync(join(source.vault, "snapshots/handoffs", item.handoffId.slice(0,2), item.handoffId+".json"), "utf8"));
      if (shard.artifact.inlineBody !== body || shard.artifact.storageKey !== null) throw Error("Export changed inline bytes");
      const restored = unwrap(backupRestore(unwrap(createNodeBackupCommandPorts({ env: { SORAGE_HOME: target.home }, userHome: target.home, sourcePath: source.vault }).restorePorts()), { dryRun: false }));
      for (let reopened=0; reopened<2; reopened++) {
        const row = readRow(target.database);
        if (row.id === original.id || row.id === item.artifactId || row.artifact_id !== item.artifactId || row.handoff_id !== item.handoffId || row.inline_text !== body || row.storage_key !== null || row.materialized !== 1 || Number(row.size_bytes) !== exact.length || row.sha256 !== createHash("sha256").update(exact).digest("hex")) throw Error("Native restore changed Artifact identity or bytes: "+JSON.stringify(row));
      }
      const db = openSorageDatabase(target.database);
      try {
        if (db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get().n !== 0) throw Error("Receipts must not restore");
        const sourceDb = openSorageDatabase(source.database);
        try {
          const history = (d) => d.prepare("SELECT * FROM events WHERE handoff_id=? ORDER BY created_at,id").all(item.handoffId).map(row => ({ ...row, metadata_json: JSON.parse(row.metadata_json) }));
          if (!isDeepStrictEqual(history(db), history(sourceDb))) throw Error("Restore changed original Handoff history");
        } finally { sourceDb.close(); }
      } finally { db.close(); }
      if (readdirSync(join(target.vault, "artifacts")).length !== 0) throw Error("Inline restore fabricated an Artifact file");
      const fetched = unwrap(fetchHandoff(createNodeHandoffReadPorts({ env: { SORAGE_HOME: target.home }, userHome: target.home }), { asUser:true, as:undefined, path:target.home, userHome:target.home }, item.handoffId));
      if (!readFileSync(fetched.localPath).equals(exact)) throw Error("Restored inline fetch changed bytes");
      console.log(JSON.stringify({ nativeBun:Bun.version, restored:restored.restored.handoffs, reopened:2, receipts:0 }));
    `;
    const child = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ nativeBun: "1.4.2", restored: 1, reopened: 2, receipts: 0 });
  });

  it("preserves native Review Note BOM/CRLF bytes through restore and reopened TEXT reads", () => {
    const { source, id, path } = exportedHandoff();
    const target = installation();
    const body = "\uFEFFReview\r\nno-final-newline";
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.reviewState = "changes_requested";
    record.rowVersion = 2;
    record.reviewNote = {
      handoffId: id,
      authorKind: "user",
      authorProjectId: null,
      targetRevision: 1,
      body,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    writeFileSync(path, canonicalJson(record));
    const core = fileURLToPath(new URL("../../../core/src/index.ts", import.meta.url));
    const adapter = fileURLToPath(new URL("../../src/backup-command-ports.ts", import.meta.url));
    const connection = fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url));
    const script = `
      import { createHash } from "node:crypto";
      const { backupRestore } = await import(${JSON.stringify(core)});
      const { createNodeBackupCommandPorts } = await import(${JSON.stringify(adapter)});
      const { openSorageDatabase } = await import(${JSON.stringify(connection)});
      const ports = createNodeBackupCommandPorts({env:{SORAGE_HOME:${JSON.stringify(target.home)}},userHome:${JSON.stringify(target.home)},sourcePath:${JSON.stringify(source.vault)}}).restorePorts();
      if (!ports.ok) throw Error(JSON.stringify(ports));
      const result = backupRestore(ports.value, {dryRun:false});
      if (!result.ok) throw Error(JSON.stringify(result));
      for (let reopened = 0; reopened < 2; reopened++) {
        const db = openSorageDatabase(${JSON.stringify(target.database)});
        try {
          const row = db.prepare("SELECT body,typeof(body) AS kind,hex(body) AS bytes,length(CAST(body AS BLOB)) AS size FROM review_notes WHERE handoff_id=?").get(${JSON.stringify(id)});
          const bytes = Buffer.from(${JSON.stringify(body)}, "utf8");
          if (row.kind !== "text" || row.body !== ${JSON.stringify(body)} || row.bytes !== bytes.toString("hex").toUpperCase() || row.size !== bytes.length || createHash("sha256").update(row.body).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw Error("Native restore changed Note bytes: " + JSON.stringify(row));
        } finally {db.close();}
      }
      console.log(JSON.stringify({nativeBun:Bun.version,reopened:2}));
    `;
    const child = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ nativeBun: "1.4.2", reopened: 2 });
  });

  it.each([2, 3])(
    "preserves format %s BOM/CRLF/no-final-newline Memo bytes through native Bun restore and reopen",
    (formatVersion) => {
      const source = installation();
      seedMemoInstallation(source);
      unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
      const target = installation();
      const body = "\uFEFFMemo\r\nno-final-newline";
      const path = join(source.vault, "snapshots", `memos/ab/${MEMO_ID}.json`);
      const memo = JSON.parse(readFileSync(path, "utf8"));
      if (formatVersion === 2) {
        delete memo.bodyContent;
        memo.body = body;
      } else memo.bodyContent = { inline: body };
      const raw = canonicalJson(memo);
      writeFileSync(path, raw);
      const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
      if (formatVersion === 2) {
        manifest.formatVersion = 2;
        delete manifest.counts.channels;
        delete manifest.contentDigests;
      }
      manifest.memoDigests[`memos/ab/${MEMO_ID}.json`] = createHash("sha256").update(raw).digest("hex");
      writeFileSync(manifestPath(source), canonicalJson(manifest));
      const core = fileURLToPath(new URL("../../../core/src/index.ts", import.meta.url));
      const adapter = fileURLToPath(new URL("../../src/backup-command-ports.ts", import.meta.url));
      const connection = fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url));
      const script = `
      import { createHash } from "node:crypto";
      const { backupRestore } = await import(${JSON.stringify(core)});
      const { createNodeBackupCommandPorts } = await import(${JSON.stringify(adapter)});
      const { openSorageDatabase } = await import(${JSON.stringify(connection)});
      const p = createNodeBackupCommandPorts({env:{SORAGE_HOME:${JSON.stringify(target.home)}},userHome:${JSON.stringify(target.home)},sourcePath:${JSON.stringify(source.vault)}}).restorePorts();
      if (!p.ok) throw Error(JSON.stringify(p));
      const restored = backupRestore(p.value, {dryRun:false});
      if (!restored.ok) throw Error(JSON.stringify(restored));
      for (let reopened = 0; reopened < 2; reopened++) {
        const db = openSorageDatabase(${JSON.stringify(target.database)});
        try {
          const row = db.prepare("SELECT body, typeof(body) AS kind, hex(body) AS bytes, length(CAST(body AS BLOB)) AS size FROM project_memos WHERE id=?").get(${JSON.stringify(MEMO_ID)});
          const bytes = Buffer.from(${JSON.stringify(body)}, "utf8");
          if (row.kind !== "text" || row.body !== ${JSON.stringify(body)} || row.bytes !== bytes.toString("hex").toUpperCase() || row.size !== bytes.length || createHash("sha256").update(row.body).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw Error("Native restore changed Memo bytes: " + JSON.stringify(row));
        } finally { db.close(); }
      }
      console.log(JSON.stringify({nativeBun:Bun.version, reopened:2}));
    `;
      const child = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 10_000 });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ nativeBun: "1.4.2", reopened: 2 });
    },
  );

  it.each([
    "extra",
    "missing",
    "id",
    "time",
    "actor-kind",
    "user-id",
    "project-id",
    "workspace-id",
    "row-version",
    "metadata",
    "event-type",
    "handoff-id",
  ])("validates kept Handoff event base rows before import: %s", (defect) => {
    const { source, id } = exportedHandoff();
    const event: Record<string, unknown> = {
      id: randomUUID(),
      handoffId: id,
      memoId: null,
      eventType: "HANDOFF_CREATED",
      actorKind: "user",
      actorId: null,
      rowVersion: 1,
      metadata: {},
      createdAt: "2026-09-28T00:00:00.000Z",
    };
    const before = readFileSync(eventsPath(source), "utf8");
    writeFileSync(eventsPath(source), before + canonicalJsonLine(event));
    const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
    manifest.counts.events += 1;
    writeFileSync(manifestPath(source), canonicalJson(manifest));
    expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }).ok).toBe(true);
    if (defect === "extra") event.extra = true;
    if (defect === "missing") delete event.id;
    if (defect === "id") event.id = "not-a-uuid";
    if (defect === "time") event.createdAt = "invalid";
    if (defect === "actor-kind") event.actorKind = "unknown";
    if (defect === "user-id") event.actorId = "unexpected";
    if (defect === "project-id") {
      event.actorKind = "registered_project";
      event.actorId = "not-a-uuid";
    }
    if (defect === "workspace-id") {
      event.actorKind = "unregistered_workspace";
      event.actorId = null;
    }
    if (defect === "row-version") event.rowVersion = 0;
    if (defect === "metadata") event.metadata = [];
    if (defect === "event-type") event.eventType = { toString: "not-callable" };
    if (defect === "handoff-id") event.handoffId = { toString: "not-callable" };
    writeFileSync(eventsPath(source), before + canonicalJsonLine(event));
    refusesBeforeImport(source, "VAULT_INTEGRITY_ERROR");
  });
});

describe("format-3 historical physical-content snapshots", () => {
  it("round-trips all common event families without retaining owners, content rows, files or receipts", () => {
    const source = exportedHistory();
    const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
    expect(manifest.counts.channels).toBe(0);
    expect(manifest.contentDigests).toEqual({});
    expect(existsSync(join(source.vault, "snapshots", "content"))).toBe(false);
    const verified = unwrap(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }));
    expect(verified.findings).toEqual([
      "The Vault has no Git repository; re-run sorage init --initialize-git to initialize one.",
    ]);
    const target = installation();
    const before = inventory(target);
    unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: true }));
    expect(inventory(target)).toEqual(before);
    unwrap(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun: false }));
    expect(commonHistory(target)).toEqual(commonHistory(source));
    const db = openSorageDatabase(target.database);
    try {
      expect(db.prepare("SELECT id FROM content_records").all()).toEqual([]);
      expect(db.prepare("SELECT key FROM idempotency_keys").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'channel%'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each([
    ["actorKind", "user"],
    ["actorId", "unexpected"],
    ["rowVersion", 1],
    ["handoffId", "unexpected"],
    ["memoId", "unexpected"],
    ["id", "not-a-uuid"],
    ["createdAt", "not-a-timestamp"],
    ["extra", "unknown-field"],
  ])("refuses a common event with invalid %s before verify or restore can adopt anything", (field, value) => {
    const source = exportedHistory();
    const events = readFileSync(eventsPath(source), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const common = events.find((event) => event.eventType === "CONTENT_ACTIVATED");
    if (!common) throw new Error("missing common fixture event");
    common[String(field)] = value;
    writeFileSync(eventsPath(source), events.map(canonicalJsonLine).join(""));
    const verified = backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() });
    expect(verified).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
    const target = installation();
    const before = inventory(target);
    const config = readFileSync(join(target.home, "config.yaml"));
    for (const dryRun of [true, false]) {
      expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun })).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR" },
      });
      expect(inventory(target)).toEqual(before);
      expect(readFileSync(join(target.home, "config.yaml"))).toEqual(config);
    }
  });

  it("refuses a recognized ledger-only Channel domain event as unsupported before import", () => {
    const source = exportedHistory();
    writeFileSync(
      eventsPath(source),
      readFileSync(eventsPath(source), "utf8") +
        canonicalJsonLine({
          id: randomUUID(),
          handoffId: null,
          memoId: null,
          eventType: "CHANNEL_CREATED",
          actorKind: "user",
          actorId: null,
          rowVersion: null,
          metadata: { channelId: randomUUID(), mainParticipantId: randomUUID() },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
    );
    const manifest = JSON.parse(readFileSync(manifestPath(source), "utf8"));
    manifest.counts.events += 1;
    writeFileSync(manifestPath(source), canonicalJson(manifest));
    const target = installation();
    const before = inventory(target);
    const config = readFileSync(join(target.home, "config.yaml"));
    expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() })).toMatchObject({
      ok: false,
      error: { code: "VAULT_SCHEMA_UNSUPPORTED" },
    });
    for (const dryRun of [true, false]) {
      expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun })).toMatchObject({
        ok: false,
        error: { code: "VAULT_SCHEMA_UNSUPPORTED" },
      });
      expect(inventory(target)).toEqual(before);
      expect(readFileSync(join(target.home, "config.yaml"))).toEqual(config);
    }
  });

  it.each([
    [1, "CONTENT_ACTIVATED"],
    [2, "CONTENT_ACTIVATED"],
    [1, "CHANNEL_CREATED"],
    [2, "CHANNEL_CREATED"],
    [1, "UNRECOGNIZED_EVENT"],
    [2, "UNRECOGNIZED_EVENT"],
    [3, "UNRECOGNIZED_EVENT"],
  ] as const)("keeps format %s's frozen event family closed against %s", (formatVersion, eventType) => {
    const source = installation();
    unwrap(exportSnapshot(unwrap(ports(source).exportPorts())));
    const event = {
      id: randomUUID(),
      handoffId: null,
      ...(formatVersion === 1 ? {} : { memoId: null }),
      eventType,
      actorKind: "system",
      actorId: null,
      rowVersion: null,
      metadata: {
        contentId: randomUUID(),
        ownerDomain: "channel",
        ownerId: randomUUID(),
        intentId: randomUUID(),
        operation: "activate",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(eventsPath(source), canonicalJsonLine(event));
    writeFileSync(
      manifestPath(source),
      canonicalJson({
        formatVersion,
        counts: {
          projects: 0,
          handoffs: 0,
          artifacts: 0,
          events: 1,
          ...(formatVersion === 1 ? {} : { memos: 0 }),
          ...(formatVersion === 3 ? { channels: 0 } : {}),
        },
        ...(formatVersion === 1 ? {} : { memoDigests: {} }),
        ...(formatVersion === 3 ? { contentDigests: {} } : {}),
      }),
    );
    const target = installation();
    const before = inventory(target);
    expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() })).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR" },
    });
    for (const dryRun of [true, false]) {
      expect(backupRestore(unwrap(ports(target, source).restorePorts()), { dryRun })).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR" },
      });
      expect(inventory(target)).toEqual(before);
    }
  });
});
