import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";

function unwrap<T>(result: { ok: boolean; value?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "unwrap failed");
  return (result as { value: T }).value;
}
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMemo,
  exportSnapshot,
  listMemos,
  mutateMemo,
  moveVault,
  sha256OfText,
  showMemo,
  type MemoPage,
} from "@sorage/core";
import { createNodeMemoPorts, type NodeMemoPorts } from "../../src/memo-command-ports";
import { captureMemoBodyFile, captureMemoBodyText } from "../../src/memo-body-file";
import { memoInputDirectory, sweepMemoInputSpool } from "../../src/memo-input-spool";
import { validateMemoContentLinks } from "../../src/content-store";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";
import { memoInstallation, MEMO_PROJECT, MEMO_TIME } from "../fixtures/memo-installation";

/**
 * The M1+M2 shared-content Memo delivery against a real installation: the
 * Vault-backed write path from a captured accepted spool, immutable reference
 * receipts and their replay, superseded-record protection behind unexpired
 * receipts, the schema-10 link guards, the post-commit activation gate, the
 * two-connection coherence barriers, and the owned spool area's safety rules.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const OVER = 65_536;

function installation() {
  const fixture = memoInstallation();
  cleanups.push(fixture.cleanup);
  return fixture;
}

function portsOf(home: string, clock = new FakeClock(Date.parse(MEMO_TIME))): NodeMemoPorts {
  const ports = createNodeMemoPorts({ env: { SORAGE_HOME: home }, userHome: homedir(), clock });
  cleanups.push(() => ports.close());
  return ports;
}

function writeFile(path: string, text: string): string {
  writeFileSync(path, text, "utf8");
  return path;
}

function largeBody(prefix: string, size: number): string {
  const head = Buffer.byteLength(prefix, "utf8");
  return prefix + "a".repeat(Math.max(0, size - head));
}

function acceptedOf(ports: NodeMemoPorts, home: string, text: string) {
  const source = writeFile(join(home, "body.md"), text);
  const captured = captureMemoBodyFile(source, {
    maxBytes: ports.maxBytes,
    stateDir: ports.stateDir,
    spoolId: randomUUID(),
  });
  expect(captured.ok).toBe(true);
  return captured.ok ? captured.value : (undefined as never);
}

function seedProject(home: string): void {
  const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, 'p', 'P', 'active', ?, ?)",
  ).run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
  db.close();
}

describe("vault-backed Memo bodies", () => {
  it("stores a large body as an immutable Vault record with a reference receipt and replays it", () => {
    const { home, vault } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("large\n", OVER + 37);
    const accepted = acceptedOf(ports, home, body);
    expect(accepted.kind).toBe("spool");
    const key = randomUUID();
    const created = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "large" },
      { mode: "execute", idempotencyKey: key },
      accepted,
    );
    expect(created.ok).toBe(true);
    const receipt = created.ok ? created.value : (undefined as never);
    expect(receipt.memo.body).toBe(body);
    expect(receipt.changed).toBe(true);
    // The Vault file exists at the managed content key and holds the exact bytes.
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    const row = db
      .prepare(
        "SELECT c.storage_key AS key FROM project_memos m JOIN content_records c ON c.id = m.content_record_id WHERE m.id = ?",
      )
      .get(receipt.memo.id) as { key: string };
    db.close();
    expect(readFileSync(join(vault, row.key), "utf8")).toBe(body);
    // The stored receipt is the reference form: no full body in SQLite.
    const receiptRow = openSorageDatabase(join(home, "state", "sorage.sqlite3"))
      .prepare("SELECT response_json FROM idempotency_keys WHERE key = ?")
      .get(key) as { response_json: string };
    expect(receiptRow.response_json).toContain("bodyRef");
    expect(receiptRow.response_json).not.toContain(body.slice(0, 40));
    // Replay-only resolves the reference to the original outcome without effects.
    const replayed = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "large" },
      { mode: "replay-only", idempotencyKey: key },
      accepted,
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.replayed).toBe(true);
      expect(replayed.value.memo.body).toBe(body);
    }
    ports.releaseAcceptedBody(accepted);
  });

  it("keeps exact bytes at the threshold boundary with multibyte content", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    for (const size of [OVER - 3, OVER, OVER + 3]) {
      const prefix = `\uFEFF${String(size)}\r\ne\u0301`;
      const emojiOffset = Math.min(size - 4, OVER - 2);
      const body =
        prefix + "a".repeat(emojiOffset - Buffer.byteLength(prefix)) + "😀" + "z".repeat(size - emojiOffset - 4);
      expect(Buffer.byteLength(body)).toBe(size);
      const accepted = acceptedOf(ports, home, body);
      const created = addMemo(
        ports,
        { projectId: MEMO_PROJECT, title: `t${String(size)}` },
        { mode: "execute" },
        accepted,
      );
      expect(created.ok).toBe(true);
      if (created.ok) expect(created.value.memo.body).toBe(body);
      ports.releaseAcceptedBody(accepted);
    }
  });

  it("protects superseded records until their exact receipt expiry while preserving other live references", () => {
    const { home } = installation();
    seedProject(home);
    const clock = new FakeClock(Date.parse("2026-10-19T00:00:00.000Z"));
    const ports = portsOf(home, clock);
    const withDb = <T>(read: (db: ReturnType<typeof openSorageDatabase>) => T): T => {
      const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
      try {
        return read(db);
      } finally {
        db.close();
      }
    };
    const currentRecord = (id: string): string =>
      withDb(
        (db) =>
          (db.prepare("SELECT content_record_id AS id FROM project_memos WHERE id = ?").get(id) as { id: string }).id,
      );
    const records = (): string[] =>
      withDb((db) =>
        (db.prepare("SELECT id FROM content_records ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id),
      );
    const createFile = (title: string, size: number): string => {
      const accepted = acceptedOf(ports, home, largeBody(`${title}\n`, size));
      try {
        return unwrap(
          addMemo(
            ports,
            { projectId: MEMO_PROJECT, title },
            { mode: "execute", idempotencyKey: randomUUID() },
            accepted,
          ),
        ).memo.id;
      } finally {
        ports.releaseAcceptedBody(accepted);
      }
    };
    const firstId = createFile("original", OVER + 10);
    const firstRecord = currentRecord(firstId);
    const replacement = acceptedOf(ports, home, largeBody("current\n", OVER + 20));
    try {
      unwrap(mutateMemo(ports, "update", firstId, { expectedRowVersion: 1 }, { mode: "execute" }, replacement));
    } finally {
      ports.releaseAcceptedBody(replacement);
    }
    const currentFirstRecord = currentRecord(firstId);
    // The keeper's receipt expires two hours later. Its original record has
    // no domain reference, so its survival proves receipt-only protection.
    clock.advance(2 * 3_600_000);
    const keeperId = createFile("keeper", OVER + 12);
    const keeperRecord = currentRecord(keeperId);
    unwrap(
      mutateMemo(ports, "update", keeperId, { expectedRowVersion: 1, body: "current keeper" }, { mode: "execute" }),
    );
    const currentKeeperRecord = currentRecord(keeperId);
    const maintain = (): void => {
      unwrap(createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, clock }).drainAtStart());
    };
    const initial = [firstRecord, currentFirstRecord, keeperRecord, currentKeeperRecord].sort();
    maintain();
    expect(records()).toEqual(initial);
    clock.advance(21 * 3_600_000); // T0 + 23h: both retained receipts are live.
    maintain();
    expect(records()).toEqual(initial);
    clock.advance(3_600_000); // T0 + 24h: expires_at === now is no longer live.
    maintain();
    const surviving = [currentFirstRecord, keeperRecord, currentKeeperRecord].sort();
    expect(records()).toEqual(surviving);
    clock.advance(3_600_000); // T0 + 25h: later receipt and current rows survive.
    maintain();
    expect(records()).toEqual(surviving);
    clock.advance(3_600_000); // T0 + 26h: the keeper's own receipt expires too.
    maintain();
    expect(records()).toEqual([currentFirstRecord, currentKeeperRecord].sort());
  });

  it("lists file-backed bodies through the bounded scan with the shared preview rule", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const needle = "unique-needle-속문자열";
    const matching = largeBody(`head\n${needle}\n`, OVER + 11);
    const other = largeBody("no match here\n", OVER + 12);
    for (const [title, body] of [
      ["match", matching],
      ["other", other],
    ] as const) {
      const accepted = acceptedOf(ports, home, body);
      const created = addMemo(ports, { projectId: MEMO_PROJECT, title }, { mode: "execute" }, accepted);
      expect(created.ok).toBe(true);
      ports.releaseAcceptedBody(accepted);
    }
    const page = listMemos(ports, { projectId: MEMO_PROJECT, state: "all", query: needle, limit: 10 });
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.items).toHaveLength(1);
      expect(page.value.items[0]?.title).toBe("match");
      expect(page.value.items[0]?.bodyPreviewTruncated).toBe(true);
      expect(Buffer.byteLength(page.value.items[0]?.bodyPreview ?? "")).toBeLessThanOrEqual(512);
    }
    const missing = listMemos(ports, { projectId: MEMO_PROJECT, state: "all", query: "absent-string", limit: 10 });
    expect(missing.ok && missing.value.items).toHaveLength(0);
  });

  it("keeps historical bodies readable and replayable under a lowered current cap", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("historical\n", OVER + 9);
    const key = randomUUID();
    const accepted = acceptedOf(ports, home, body);
    const created = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "history" },
      { mode: "execute", idempotencyKey: key },
      accepted,
    );
    expect(created.ok).toBe(true);
    ports.releaseAcceptedBody(accepted);
    const stateKey = randomUUID();
    const completed = unwrap(
      mutateMemo(
        ports,
        "done",
        unwrap(created).memo.id,
        { expectedRowVersion: 1 },
        {
          mode: "execute",
          idempotencyKey: stateKey,
        },
      ),
    );
    // Lower the configured bound below the recorded size; reads stay bounded by the record.
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(configPath, config.replace(/maxBytes:\s*\d+/, "maxBytes: 1024"), "utf8");
    const lowered = portsOf(home);
    const shown = showMemo(lowered, created.ok ? created.value.memo.id : "");
    expect(shown.ok).toBe(true);
    if (shown.ok) expect(shown.value.body).toBe(body);
    // A bodyless state request recovers its original full body under the lower cap.
    const replayed = mutateMemo(
      lowered,
      "done",
      completed.memo.id,
      { expectedRowVersion: 1 },
      { mode: "replay-only", idempotencyKey: stateKey },
    );
    expect(replayed.ok && replayed.value.replayed).toBe(true);
    expect(unwrap(replayed).memo).toEqual(completed.memo);
    // A new body-bearing input over the lowered cap is refused before lookup, replay-only included.
    const over = addMemo(
      lowered,
      { projectId: MEMO_PROJECT, title: "history", body },
      { mode: "replay-only", idempotencyKey: key },
    );
    expect(over.ok === false && over.error.code).toBe("MEMO_TOO_LARGE");
  });
});

describe("preserved Memo identity and body integrity", () => {
  it.each(['{"id":null,"kind":"user"}\n', '{ "kind": "user", "id": null }'])(
    "updates preserved actor JSON without rewriting its representation: %s",
    (actorJson) => {
      const { home } = installation();
      seedProject(home);
      const ports = portsOf(home);
      const original = unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "legacy actor", body: "original" }));
      const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
      try {
        db.prepare("UPDATE project_memos SET created_by=? WHERE id=?").run(actorJson, original.memo.id);
        const changed = unwrap(
          mutateMemo(ports, "update", original.memo.id, { expectedRowVersion: 1, body: "edited" }),
        );
        expect(changed.memo.rowVersion).toBe(2);
        expect(changed.memo.createdBy).toEqual({ kind: "user", id: null });
        expect(db.prepare("SELECT created_by FROM project_memos WHERE id=?").get(original.memo.id)).toEqual({
          created_by: actorJson,
        });
      } finally {
        db.close();
      }
    },
  );

  it("refuses an inline checksum mismatch in detail, mutations and the whole list page", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const original = unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "body integrity", body: "original" }));
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    try {
      db.prepare(
        "UPDATE content_records SET inline_text='tampered' WHERE id=(SELECT content_record_id FROM project_memos WHERE id=?)",
      ).run(original.memo.id);
      for (const result of [
        showMemo(ports, original.memo.id),
        listMemos(ports, { allProjects: true }),
        listMemos(ports, { allProjects: true, query: "absent" }),
        mutateMemo(ports, "done", original.memo.id, { expectedRowVersion: 1 }),
      ]) {
        expect(result).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });
      }
      expect(db.prepare("SELECT row_version FROM project_memos WHERE id=?").get(original.memo.id)).toEqual({
        row_version: 1,
      });
    } finally {
      db.close();
    }
  });

  it("refuses a retained file receipt whose recorded digest differs from its content record", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const accepted = acceptedOf(ports, home, largeBody("identity\n", OVER + 17));
    const key = randomUUID();
    unwrap(
      addMemo(
        ports,
        { projectId: MEMO_PROJECT, title: "identity" },
        { mode: "execute", idempotencyKey: key },
        accepted,
      ),
    );
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    try {
      const row = db.prepare("SELECT response_json FROM idempotency_keys WHERE key=?").get(key) as {
        response_json: string;
      };
      const receipt = JSON.parse(row.response_json);
      receipt.memo.bodyRef.sha256 = "0".repeat(64);
      db.prepare("UPDATE idempotency_keys SET response_json=? WHERE key=?").run(JSON.stringify(receipt), key);
      const before = db.prepare("SELECT * FROM events ORDER BY id").all();
      expect(
        addMemo(
          ports,
          { projectId: MEMO_PROJECT, title: "identity" },
          { mode: "replay-only", idempotencyKey: key },
          accepted,
        ),
      ).toMatchObject({ ok: false, error: { code: "CONTENT_CORRUPTED" } });
      expect(db.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(before);
    } finally {
      db.close();
      ports.releaseAcceptedBody(accepted);
    }
  });

  it("refuses malformed stored receipt syntax as a fixed body-free integrity error in both modes", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const key = randomUUID();
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    const insert = db.prepare(
      "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (?, ?, 'hash', ?, ?, '2099-01-01T00:00:00.000Z')",
    );
    insert.run(key, `memo:${ports.installationId}:user`, "PRIVATE_MEMO_SENTINEL {{not json", MEMO_TIME);
    const before = {
      memos: db.prepare("SELECT * FROM project_memos").all(),
      events: db.prepare("SELECT * FROM events").all(),
      keys: db.prepare("SELECT key, request_hash, response_json, created_at, expires_at FROM idempotency_keys").all(),
    };
    db.close();
    for (const mode of [{ mode: "execute" }, { mode: "replay-only" }] as const) {
      const refused = addMemo(ports, { projectId: MEMO_PROJECT, title: "sentinel" }, { ...mode, idempotencyKey: key });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        expect(refused.error.message).toBe(
          `A stored Memo receipt under scope memo:${ports.installationId}:user is not valid JSON.`,
        );
        expect(refused.error.message).not.toContain("PRIVATE_MEMO_SENTINEL");
        expect(JSON.stringify(refused.error)).not.toContain("Unexpected");
      }
    }
    const after = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    try {
      expect(after.prepare("SELECT * FROM project_memos").all()).toEqual(before.memos);
      expect(after.prepare("SELECT * FROM events").all()).toEqual(before.events);
      expect(
        after.prepare("SELECT key, request_hash, response_json, created_at, expires_at FROM idempotency_keys").all(),
      ).toEqual(before.keys);
    } finally {
      after.close();
    }
  });

  it("classifies corrupted actor JSON through the export read as a fixed body-free internal error", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "actor" }, { mode: "execute" }));
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    db.prepare("UPDATE project_memos SET created_by=? WHERE id = (SELECT id FROM project_memos LIMIT 1)").run(
      "PRIVATE_ACTOR_SENTINEL {{not json",
    );
    db.close();
    const exportPorts = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: home }).exportPorts();
    expect(exportPorts.ok).toBe(true);
    if (exportPorts.ok) {
      const outcome = exportSnapshot(exportPorts.value);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        // The corrupted-actor exception surfaces through the export read's own
        // catch: generic classification, a fixed body-free message, and none
        // of the stored actor payload or parser text (project-memos.md:230).
        expect(outcome.error.code).toBe("INTERNAL_ERROR");
        expect(outcome.error.message).toBe("Reading the Memos for export failed");
        expect(outcome.error.message).not.toContain("PRIVATE_ACTOR_SENTINEL");
        expect(JSON.stringify(outcome.error)).not.toContain("Unexpected");
      }
    }
  });

  it("reuses production ports after a completed Vault move for reads, replay and a new file write", () => {
    const { home, vault } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("moved-body\n", OVER + 19);
    const accepted = acceptedOf(ports, home, body);
    const key = randomUUID();
    const first = unwrap(
      addMemo(ports, { projectId: MEMO_PROJECT, title: "move" }, { mode: "execute", idempotencyKey: key }, accepted),
    );
    const target = join(home, "moved-vault");
    const movePorts = unwrap(
      createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target }).movePorts(),
    );
    unwrap(moveVault(movePorts));
    // Only this test's synthetic old Vault is removed: stale bindings cannot pass by reading the retained source.
    rmSync(vault, { recursive: true, force: true });
    expect(unwrap(showMemo(ports, first.memo.id)).body).toBe(body);
    expect(unwrap(listMemos(ports, { allProjects: true, query: "moved-body" })).items.map((m) => m.id)).toEqual([
      first.memo.id,
    ]);
    expect(
      unwrap(
        addMemo(
          ports,
          { projectId: MEMO_PROJECT, title: "move" },
          { mode: "replay-only", idempotencyKey: key },
          accepted,
        ),
      ).memo,
    ).toEqual(first.memo);
    const second = unwrap(
      addMemo(ports, { projectId: MEMO_PROJECT, title: "new after move" }, { mode: "execute" }, accepted),
    );
    expect(unwrap(showMemo(ports, second.memo.id)).body).toBe(body);
    expect(existsSync(vault)).toBe(false);
    expect(readdirSync(join(target, "content", "memo"))).toHaveLength(2);
    ports.releaseAcceptedBody(accepted);
  });
});

describe("schema-10 link guards", () => {
  it("refuses cleanup, doctor-style census, and export on a dangling Memo record", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const accepted = acceptedOf(ports, home, largeBody("guard\n", OVER + 7));
    const created = addMemo(ports, { projectId: MEMO_PROJECT, title: "guard" }, { mode: "execute" }, accepted);
    expect(created.ok).toBe(true);
    ports.releaseAcceptedBody(accepted);
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("DELETE FROM content_records WHERE id = (SELECT content_record_id FROM project_memos LIMIT 1)").run();
    db.exec("PRAGMA foreign_keys=ON");
    const guard = validateMemoContentLinks(db);
    expect(guard.ok).toBe(false);
    expect(guard.ok === false && guard.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    db.close();
    expect(showMemo(ports, unwrap(created).memo.id)).toMatchObject({
      ok: false,
      error: { code: "STORAGE_INTEGRITY_ERROR" },
    });
    expect(listMemos(ports, { allProjects: true })).toMatchObject({
      ok: false,
      error: { code: "STORAGE_INTEGRITY_ERROR" },
    });
    const maintenance = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home }).drainAtStart();
    expect(maintenance.ok === false && maintenance.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    const exportPorts = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome: home }).exportPorts();
    expect(exportPorts.ok).toBe(true);
    if (exportPorts.ok) {
      const snapshot = exportSnapshot(exportPorts.value);
      expect(snapshot.ok).toBe(false);
      expect(snapshot.ok === false && snapshot.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    }
  });
});

describe("post-commit completed Vault move", () => {
  it("resolves the acknowledged body from the new Vault after the old source becomes unavailable", () => {
    const { home, vault } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("post-commit move\n", OVER + 29);
    const target = join(home, "moved-after-commit");
    const activate = ports.staging.activateContent;
    ports.staging.activateContent = (input, binding) => {
      const outcome = activate(input, binding);
      if (!outcome.ok) return outcome;
      const movePorts = unwrap(
        createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home, targetPath: target }).movePorts(),
      );
      unwrap(moveVault(movePorts));
      rmSync(vault, { recursive: true, force: true });
      return outcome;
    };
    const receipt = unwrap(
      addMemo(
        ports,
        { projectId: MEMO_PROJECT, title: "post-commit", body },
        { mode: "execute", idempotencyKey: randomUUID() },
      ),
    );
    expect(receipt.memo.body).toBe(body);
    expect(existsSync(vault)).toBe(false);
    expect(unwrap(showMemo(ports, receipt.memo.id)).body).toBe(body);
  });
});

describe("post-commit activation gate", () => {
  it("leaves the committed intent durably pending under a held lock and reports the honest boundary", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("paused\n", OVER + 21);
    const accepted = acceptedOf(ports, home, body);
    const lockPath = join(home, "run", "vault-move.lock");
    const activate = ports.staging.activateContent;
    ports.staging.activateContent = (input, binding) => {
      // The move begins after the domain transaction commits, before activation.
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" })}\n`,
        "utf8",
      );
      return activate(input, binding);
    };
    const key = randomUUID();
    const created = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "paused" },
      { mode: "execute", idempotencyKey: key },
      accepted,
    );
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("CONTENT_MATERIALIZING");
      const memoId = String((created.error.details as Record<string, unknown>).memoId);
      expect(memoId).toBeTruthy();
      expect(created.error.recovery?.suggestedCommand).toContain("replay-only");
    }
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    const pending = (
      db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops WHERE op = 'activate'").get() as { n: number }
    ).n;
    expect(pending).toBe(1);
    db.close();
    rmSync(lockPath, { force: true });
    const drained = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home }).drainAtStart();
    expect(drained.ok).toBe(true);
    const memoId = created.ok ? "" : String((created.error.details as Record<string, unknown>).memoId);
    const shown = showMemo(ports, memoId);
    expect(shown.ok).toBe(true);
    if (shown.ok) expect(shown.value.body).toBe(body);
    const replayed = unwrap(
      addMemo(
        ports,
        { projectId: MEMO_PROJECT, title: "paused" },
        {
          mode: "replay-only",
          idempotencyKey: key,
        },
        accepted,
      ),
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.memo).toEqual(unwrap(shown));
    ports.releaseAcceptedBody(accepted);
  });
});

describe("two-connection operation coherence", () => {
  it("commits despite an unrelated external commit through the bounded restart", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("coherence\n", OVER + 5);
    const accepted = acceptedOf(ports, home, body);
    const other = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    const stage = ports.staging.stageAccepted;
    let stageCalls = 0;
    const captureVersion = ports.coherence.captureExternalVersion;
    let versionCalls = 0;
    ports.coherence.captureExternalVersion = () => {
      versionCalls++;
      return captureVersion();
    };
    ports.staging.stageAccepted = (input, binding) => {
      stageCalls++;
      const result = stage(input, binding);
      // The mutable source is no longer authoritative after capture.
      writeFileSync(join(home, "body.md"), "changed after capture");
      other
        .prepare(
          "INSERT INTO projects (id,slug,display_name,status,created_at,updated_at) VALUES (?,'other','Other','active',?,?)",
        )
        .run("cd000000-0000-4000-8000-0000000000ff", MEMO_TIME, MEMO_TIME);
      return result;
    };
    try {
      const created = unwrap(
        addMemo(ports, { projectId: MEMO_PROJECT, title: "coherent" }, { mode: "execute" }, accepted),
      );
      expect(created.memo.body).toBe(body);
      expect(stageCalls).toBe(1);
      expect(versionCalls).toBe(2);
    } finally {
      other.close();
      ports.releaseAcceptedBody(accepted);
    }
  });

  it("restages after a completed move between staging and BEGIN, with DV preceding every fresh binding", () => {
    const { home, vault } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("restage\n", OVER + 31);
    const accepted = acceptedOf(ports, home, body);
    const target = join(home, "moved-before-begin");
    const order: string[] = [];
    const version = ports.coherence.captureExternalVersion;
    ports.coherence.captureExternalVersion = () => {
      order.push("version");
      return version();
    };
    const binding = ports.staging.freshBinding;
    ports.staging.freshBinding = () => {
      order.push("binding");
      return binding();
    };
    const stage = ports.staging.stageAccepted;
    let moved = false;
    ports.staging.stageAccepted = (input, bound) => {
      order.push("stage");
      const staged = stage(input, bound);
      if (staged.ok && !moved) {
        moved = true;
        unwrap(
          moveVault(
            unwrap(
              createNodeVaultCommandPorts({
                env: { SORAGE_HOME: home },
                userHome: home,
                targetPath: target,
              }).movePorts(),
            ),
          ),
        );
        rmSync(vault, { recursive: true, force: true });
      }
      return staged;
    };
    const run = ports.memos.run;
    ports.memos.run = (work, options) => {
      order.push("begin");
      return run(work, options);
    };
    try {
      const created = unwrap(
        addMemo(ports, { projectId: MEMO_PROJECT, title: "restage" }, { mode: "execute" }, accepted),
      );
      expect(created.memo.body).toBe(body);
      expect(order.slice(0, 8)).toEqual([
        "version",
        "binding",
        "stage",
        "begin",
        "version",
        "binding",
        "stage",
        "begin",
      ]);
      expect(existsSync(vault)).toBe(false);
      expect(readdirSync(join(target, "content", "memo"))).toHaveLength(1);
    } finally {
      ports.releaseAcceptedBody(accepted);
    }
  });

  it.each([true, false])(
    "bounds sustained unrelated commits without a false path conflict or new Memo (key=%s)",
    (keyed) => {
      const { home } = installation();
      seedProject(home);
      const ports = portsOf(home);
      const other = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
      const binding = ports.staging.freshBinding;
      let bindings = 0;
      ports.staging.freshBinding = () => {
        const result = binding();
        other.prepare("UPDATE projects SET display_name=? WHERE id=?").run(`external-${++bindings}`, MEMO_PROJECT);
        return result;
      };
      const stage = ports.staging.stageAccepted;
      let stages = 0;
      ports.staging.stageAccepted = (input, bound) => {
        stages++;
        return stage(input, bound);
      };
      try {
        const result = addMemo(
          ports,
          { projectId: MEMO_PROJECT, title: "bounded", body: largeBody("bounded\n", OVER + 11) },
          { mode: "execute", ...(keyed ? { idempotencyKey: randomUUID() } : {}) },
        );
        expect(result).toMatchObject({ ok: false, error: { code: "STORAGE_INSPECTION_UNAVAILABLE" } });
        expect(bindings).toBe(3);
        expect(stages).toBe(1);
        if (!result.ok) {
          expect(result.error.message).toContain("this invocation committed nothing");
          expect(result.error.recovery?.suggestedCommand).toContain(
            keyed ? "earlier unknown" : "no Memo was committed",
          );
        }
        for (const table of ["project_memos", "idempotency_keys", "content_records", "pending_fs_ops"]) {
          expect(other.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
      } finally {
        other.close();
      }
    },
  );

  it("reports a real path conflict after three completed moves without committing a Memo", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const stage = ports.staging.stageAccepted;
    let moves = 0;
    ports.staging.stageAccepted = (input, bound) => {
      const staged = stage(input, bound);
      if (!staged.ok) return staged;
      unwrap(
        moveVault(
          unwrap(
            createNodeVaultCommandPorts({
              env: { SORAGE_HOME: home },
              userHome: home,
              targetPath: join(home, `moving-${++moves}`),
            }).movePorts(),
          ),
        ),
      );
      return staged;
    };
    const result = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "moving", body: largeBody("moving\n", OVER + 11) },
      { mode: "execute", idempotencyKey: randomUUID() },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_CONFLICT" } });
    expect(moves).toBe(3);
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM project_memos").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type LIKE 'MEMO_%'").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("restarts a whole list page once and refuses sustained changes without a partial page", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const body = largeBody("needle\n", OVER + 11);
    const accepted = acceptedOf(ports, home, body);
    unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "search" }, { mode: "execute" }, accepted));
    ports.releaseAcceptedBody(accepted);
    const other = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    const scan = ports.bodies.scanBodyForQuery;
    let scans = 0;
    ports.bodies.scanBodyForQuery = (ref, query, bound) => {
      const result = scan(ref, query, bound);
      if (++scans === 1) other.prepare("UPDATE projects SET display_name='fresh' WHERE id=?").run(MEMO_PROJECT);
      return result;
    };
    try {
      const first = unwrap(listMemos(ports, { allProjects: true, query: "needle" }));
      expect(scans).toBe(2);
      expect(first.items[0]?.projectDisplayName).toBe("fresh");
      scans = 0;
      ports.bodies.scanBodyForQuery = (ref, query, bound) => {
        const result = scan(ref, query, bound);
        other.prepare("UPDATE projects SET display_name=? WHERE id=?").run(`changing-${++scans}`, MEMO_PROJECT);
        return result;
      };
      expect(listMemos(ports, { allProjects: true, query: "needle" })).toMatchObject({
        ok: false,
        error: { code: "STORAGE_INSPECTION_UNAVAILABLE" },
      });
      expect(scans).toBe(2);
    } finally {
      other.close();
    }
  });

  it("sees another connection's commit through the same-connection external-version counter", () => {
    const { home } = installation();
    const a = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    const before = (a.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    const b = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    b.prepare(
      "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, 'dv', 'DV', 'active', ?, ?)",
    ).run("cd000000-0000-4000-8000-0000000000ee", MEMO_TIME, MEMO_TIME);
    b.close();
    a.exec("BEGIN IMMEDIATE");
    const inside = (a.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    a.exec("ROLLBACK");
    a.close();
    expect(inside).not.toBe(before);
  });
});

describe("large-content Git-history disclosure (WR2/WR3, SHR-011)", () => {
  it("fires once after the fresh commit of a body above the threshold and before activation", () => {
    const { home } = installation();
    seedProject(home);
    // Lower the threshold so the body used here is genuinely ABOVE it: the
    // body is 70,010 bytes and the threshold is 70,000 (strict > comparison).
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      config
        .replace(/largeArtifactWarningBytes:\s*\d+/, "largeArtifactWarningBytes: 70000")
        .replace(/gitBackup:\n  enabled: false/, "gitBackup:\n  enabled: true"),
      "utf8",
    );
    const ports = portsOf(home);
    const notifications: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    const composed = ports.disclosures;
    if (composed !== undefined) {
      ports.disclosures = {
        ...composed,
        largeContent: (sizeBytes, thresholdBytes) => {
          notifications.push({ sizeBytes, thresholdBytes });
        },
      };
    }
    const body = largeBody("disclosed\n", 70_010);
    expect(Buffer.byteLength(body, "utf8")).toBe(70_010);
    const accepted = acceptedOf(ports, home, body);
    const key = randomUUID();
    unwrap(
      addMemo(
        ports,
        { projectId: MEMO_PROJECT, title: "disclosed" },
        { mode: "execute", idempotencyKey: key },
        accepted,
      ),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.thresholdBytes).toBe(70_000);
    expect(notifications[0]?.sizeBytes).toBe(70_010);
    ports.releaseAcceptedBody(accepted);
  });

  it("still fires when the post-commit activation pauses and the response reports the committed boundary", () => {
    const { home } = installation();
    seedProject(home);
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      config
        .replace(/largeArtifactWarningBytes:\s*\d+/, "largeArtifactWarningBytes: 70000")
        .replace(/gitBackup:\n  enabled: false/, "gitBackup:\n  enabled: true"),
      "utf8",
    );
    const ports = portsOf(home);
    const notifications: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    const composed = ports.disclosures;
    if (composed !== undefined) {
      ports.disclosures = {
        ...composed,
        largeContent: (sizeBytes, thresholdBytes) => {
          notifications.push({ sizeBytes, thresholdBytes });
        },
      };
    }
    // Mock the staging activation to return paused AFTER the commit — the real
    // post-commit gate seam — instead of holding the entry lock (which would
    // correctly refuse pre-commit with SERVICE_PAUSED).
    const originalActivate = ports.staging.activateContent;
    ports.staging.activateContent = (input, binding) => {
      void input;
      void binding;
      return { ok: true, value: { status: "paused" } };
    };
    const body = largeBody("paused-disclosed\n", 70_012);
    const accepted = acceptedOf(ports, home, body);
    const refused = addMemo(ports, { projectId: MEMO_PROJECT, title: "paused" }, { mode: "execute" }, accepted);
    ports.staging.activateContent = originalActivate;
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CONTENT_MATERIALIZING");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sizeBytes).toBe(70_012);
    ports.releaseAcceptedBody(accepted);
  });

  it("never fires for replay, no-op, title-only, state changes, or a throwing sink failure outcome", () => {
    const { home } = installation();
    seedProject(home);
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      config
        .replace(/largeArtifactWarningBytes:\s*\d+/, "largeArtifactWarningBytes: 70000")
        .replace(/gitBackup:\n  enabled: false/, "gitBackup:\n  enabled: true"),
      "utf8",
    );
    const ports = portsOf(home);
    const notifications: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    const composed = ports.disclosures;
    if (composed !== undefined) {
      ports.disclosures = {
        ...composed,
        largeContent: (sizeBytes, thresholdBytes) => {
          notifications.push({ sizeBytes, thresholdBytes });
          throw new Error("injected sink failure");
        },
      };
    }
    const body = largeBody("sink-fail\n", 70_008);
    const accepted = acceptedOf(ports, home, body);
    const key = randomUUID();
    const created = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "sink" },
      { mode: "execute", idempotencyKey: key },
      accepted,
    );
    expect(created.ok).toBe(true);
    expect(notifications).toHaveLength(1);
    // A second add with the same key is a replay: no new notification.
    const replayed = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "sink" },
      { mode: "execute", idempotencyKey: key },
      accepted,
    );
    expect(replayed.ok && replayed.value.replayed).toBe(true);
    expect(notifications).toHaveLength(1);
    // A title-only update of a large body: no new body plan, no notification.
    const memoId = created.ok ? created.value.memo.id : "";
    unwrap(mutateMemo(ports, "update", memoId, { expectedRowVersion: 1, title: "renamed" }, { mode: "execute" }));
    expect(notifications).toHaveLength(1);
    // A state change: no new body plan.
    unwrap(mutateMemo(ports, "done", memoId, { expectedRowVersion: 2 }, { mode: "execute" }));
    expect(notifications).toHaveLength(1);
    ports.releaseAcceptedBody(accepted);
  });

  it("never fires when backup is disabled, at exact equality, or below the threshold", () => {
    const { home } = installation();
    seedProject(home);
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    // Backup stays enabled but the threshold sits above every body used here.
    writeFileSync(
      configPath,
      config.replace(/largeArtifactWarningBytes:\s*\d+/, "largeArtifactWarningBytes: 200000000"),
      "utf8",
    );
    const ports = portsOf(home);
    const notifications: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    const composed = ports.disclosures;
    if (composed !== undefined) {
      ports.disclosures = {
        ...composed,
        largeContent: (sizeBytes, thresholdBytes) => {
          notifications.push({ sizeBytes, thresholdBytes });
        },
      };
    }
    const accepted = acceptedOf(ports, home, largeBody("below\n", OVER + 4));
    unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "below" }, { mode: "execute" }, accepted));
    expect(notifications).toHaveLength(0);
    ports.releaseAcceptedBody(accepted);
  });

  it("never fires at exact threshold equality: a body of exactly thresholdBytes is at, not above", () => {
    const { home } = installation();
    seedProject(home);
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      config
        .replace(/largeArtifactWarningBytes:\s*\d+/, "largeArtifactWarningBytes: 70000")
        .replace(/gitBackup:\n  enabled: false/, "gitBackup:\n  enabled: true"),
      "utf8",
    );
    const ports = portsOf(home);
    const notifications: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    const composed = ports.disclosures;
    if (composed !== undefined) {
      ports.disclosures = {
        ...composed,
        largeContent: (sizeBytes, thresholdBytes) => {
          notifications.push({ sizeBytes, thresholdBytes });
        },
      };
    }
    // Exactly 70,000 bytes: strict > means no notification.
    const accepted = acceptedOf(ports, home, largeBody("at\n", 70_000));
    unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "at" }, { mode: "execute" }, accepted));
    expect(notifications).toHaveLength(0);
    ports.releaseAcceptedBody(accepted);
  });

  it("never fires when Git backup is disabled even above the threshold", () => {
    const { home } = installation();
    seedProject(home);
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8");
    // Threshold low but backup disabled.
    const disabled = config
      .replace(/largeArtifactWarningBytes:\s*\d+/, "largeArtifactWarningBytes: 70000")
      .replace(/enabled:\s*true/, "enabled: false");
    writeFileSync(configPath, disabled, "utf8");
    const ports = portsOf(home);
    const notifications: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    const composed = ports.disclosures;
    if (composed !== undefined) {
      ports.disclosures = {
        ...composed,
        largeContent: (sizeBytes, thresholdBytes) => {
          notifications.push({ sizeBytes, thresholdBytes });
        },
      };
    }
    const accepted = acceptedOf(ports, home, largeBody("disabled\n", 70_006));
    unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "disabled" }, { mode: "execute" }, accepted));
    expect(notifications).toHaveLength(0);
    ports.releaseAcceptedBody(accepted);
  });
});

describe("owned accepted-input spool area", () => {
  it("never follows a symlinked owned directory and deletes nothing outside it", () => {
    const { home } = installation();
    const outside = join(home, "outside");
    const outsideFile = join(outside, `${randomUUID()}.${String(process.pid)}.spool`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideFile, "synthetic", "utf8");
    utimesSync(outsideFile, new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 48 * 3_600_000));
    symlinkSync(outside, memoInputDirectory(join(home, "state")));
    const removed = sweepMemoInputSpool(join(home, "state"), { graceHours: 24, now: new Date() });
    expect(removed).toBe(0);
    expect(readFileSync(outsideFile, "utf8")).toBe("synthetic");
  });

  it("protects a live-owner spool beyond the grace window and reaps only dead-owner orphans", () => {
    const { home } = installation();
    const directory = memoInputDirectory(join(home, "state"));
    mkdirSync(directory, { recursive: true });
    const old = new Date(Date.now() - 48 * 3_600_000);
    const live = join(directory, `${randomUUID()}.${String(process.pid)}.spool`);
    writeFileSync(live, "active owner", "utf8");
    utimesSync(live, old, old);
    const dead = join(directory, `${randomUUID()}.999999.spool`);
    writeFileSync(dead, "crash orphan", "utf8");
    utimesSync(dead, old, old);
    const unrelated = join(directory, "not-a-spool.txt");
    writeFileSync(unrelated, "unrelated", "utf8");
    utimesSync(unrelated, old, old);
    const removed = sweepMemoInputSpool(join(home, "state"), { graceHours: 24, now: new Date() });
    expect(removed).toBe(1);
    expect(readFileSync(live, "utf8")).toBe("active owner");
    expect(readFileSync(unrelated, "utf8")).toBe("unrelated");
    expect(readdirSync(directory).includes("not-a-spool.txt")).toBe(true);
    expect(readdirSync(directory).some((name) => name.endsWith(".999999.spool"))).toBe(false);
  });

  it("rejects invalid text before any spool side effect", () => {
    const { home } = installation();
    const ports = portsOf(home);
    const over = "a".repeat(OVER + 1);
    for (const bad of [`${over}\0`, `${over}\ud800`, `plain\0`, `plain\ud800`]) {
      const captured = captureMemoBodyText(bad, {
        maxBytes: ports.maxBytes,
        stateDir: ports.stateDir,
        spoolId: randomUUID(),
      });
      expect(captured.ok === false && captured.error.code).toBe("MEMO_INVALID_INPUT");
    }
    expect(existsSync(memoInputDirectory(join(home, "state")))).toBe(false);
  });

  it("refuses staging when the bound Vault's staging tree is a symlink, writing nothing outside", () => {
    const { home, vault } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const outside = join(home, "outside-staging");
    mkdirSync(outside, { recursive: true });
    rmSync(join(vault, "staging"), { recursive: true, force: true });
    symlinkSync(outside, join(vault, "staging"));
    const text = largeBody("staged\n", OVER + 13);
    const created = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "symlinked" },
      { mode: "execute" },
      { kind: "text", text, sizeBytes: Buffer.byteLength(text, "utf8"), sha256: sha256OfText(text) },
    );
    expect(created.ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("stages a large text body through the owned spool and the guarded Vault stage", () => {
    const { home, vault } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const text = largeBody("text-route\n", OVER + 15);
    const created = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "text-route" },
      { mode: "execute" },
      { kind: "text", text, sizeBytes: Buffer.byteLength(text, "utf8"), sha256: sha256OfText(text) },
    );
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.memo.body).toBe(text);
    expect(readdirSync(join(vault, "content", "memo"))).toHaveLength(1);
    expect(readdirSync(memoInputDirectory(join(home, "state")))).toEqual([]);
  });

  it("updates a Memo body-only through a captured accepted spool", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const first = unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "v1" }, { mode: "execute" }));
    const accepted = acceptedOf(ports, home, largeBody("replaced\n", OVER + 25));
    const updated = mutateMemo(
      ports,
      "update",
      first.memo.id,
      { expectedRowVersion: 1 },
      { mode: "execute" },
      accepted,
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.changed).toBe(true);
      expect(updated.value.memo.body.startsWith("replaced\n")).toBe(true);
    }
    ports.releaseAcceptedBody(accepted);
  });

  it("keeps the original file-backed reference receipt replayable after a file-to-inline replacement", () => {
    const { home } = installation();
    seedProject(home);
    const clock = new FakeClock(Date.parse(MEMO_TIME));
    const ports = portsOf(home, clock);
    const fileBody = largeBody("original-file\n", OVER + 14);
    const key = randomUUID();
    const accepted = acceptedOf(ports, home, fileBody);
    const created = unwrap(
      addMemo(
        ports,
        { projectId: MEMO_PROJECT, title: "transition" },
        { mode: "execute", idempotencyKey: key },
        accepted,
      ),
    );
    const memoId = created.memo.id;
    const replaced = mutateMemo(
      ports,
      "update",
      memoId,
      { expectedRowVersion: 1, body: "inline now" },
      { mode: "execute" },
    );
    expect(replaced.ok).toBe(true);
    // The current row reads the inline body; the retained receipt resolves the
    // ORIGINAL file-backed bytes through its immutable reference (SHR-008).
    expect(unwrap(showMemo(ports, memoId)).body).toBe("inline now");
    const replayed = addMemo(
      ports,
      { projectId: MEMO_PROJECT, title: "transition" },
      { mode: "replay-only", idempotencyKey: key },
      accepted,
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.replayed).toBe(true);
      expect(replayed.value.memo.body).toBe(fileBody);
      expect(replayed.value.memo.rowVersion).toBe(1);
    }
    ports.releaseAcceptedBody(accepted);
    // The superseded file record survives while its receipt is unexpired.
    const maintenance = createNodeVaultCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      clock,
    }).drainAtStart();
    expect(maintenance.ok).toBe(true);
    const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
    try {
      const records = (db.prepare("SELECT COUNT(*) AS n FROM content_records").get() as { n: number }).n;
      expect(records).toBe(2);
    } finally {
      db.close();
    }
  });

  it("finds a multibyte literal whose match spans a 64KiB chunk boundary", () => {
    const { home } = installation();
    seedProject(home);
    const ports = portsOf(home);
    const prefix = "a".repeat(65_530);
    const needle = "경계😀needle";
    // The needle starts at byte 65,530, so its multibyte sequence crosses the
    // 65,536 boundary between two scan chunks; the overlap carry must hold it.
    const body = `${prefix}${needle}${"b".repeat(300)}`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(OVER);
    const accepted = acceptedOf(ports, home, body);
    unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title: "split" }, { mode: "execute" }, accepted));
    ports.releaseAcceptedBody(accepted);
    const page = unwrap(listMemos(ports, { projectId: MEMO_PROJECT, state: "all", query: needle, limit: 10 }));
    expect(page.items).toHaveLength(1);
    const miss = unwrap(listMemos(ports, { projectId: MEMO_PROJECT, state: "all", query: "경계😀needlX", limit: 10 }));
    expect(miss.items).toHaveLength(0);
  });

  it("searches more than one candidate batch with filter-before-paging and no skips or duplicates", () => {
    const { home } = installation();
    seedProject(home);
    const clock = new FakeClock(Date.parse(MEMO_TIME));
    const ports = portsOf(home, clock);
    const expected: string[] = [];
    // 240 candidates overwhelm the 200-descriptor batch bound; matches live in
    // both batches, interleaved inline and file-backed.
    const total = 240;
    for (let index = 0; index < total; index++) {
      clock.advance(1000); // Deterministic order puts matches 20 and 0 beyond batch 200.
      const title = `bulk ${String(index).padStart(3, "0")}`;
      const wantsMatch = index % 20 === 0;
      const bodyText = wantsMatch ? `bulk-match-패턴 ${String(index)}\n` : `bulk-miss ${String(index)}\n`;
      let id: string;
      if (index % 3 === 0) {
        const fileBody = largeBody(bodyText, OVER + 8 + index);
        const accepted = acceptedOf(ports, home, fileBody);
        id = unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title }, { mode: "execute" }, accepted)).memo.id;
        ports.releaseAcceptedBody(accepted);
      } else {
        id = unwrap(addMemo(ports, { projectId: MEMO_PROJECT, title, body: bodyText }, { mode: "execute" })).memo.id;
      }
      if (wantsMatch) expected.unshift(id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      const page: MemoPage = unwrap(
        listMemos(ports, {
          projectId: MEMO_PROJECT,
          state: "all",
          query: "bulk-match-패턴",
          limit: 3,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    const all = unwrap(
      listMemos(ports, { projectId: MEMO_PROJECT, state: "all", query: "bulk-match-패턴", limit: 200 }),
    );
    expect(all.items.map((item) => item.id)).toEqual(expected);
    expect(all.nextCursor).toBeNull();
  });

  it("leaves no spool residue after a failed capture", () => {
    const { home } = installation();
    const ports = portsOf(home);
    const withNul = join(home, "nul.md");
    writeFileSync(withNul, Buffer.concat([Buffer.alloc(OVER * 2, 0x61), Buffer.from([0])]));
    const nul = captureMemoBodyFile(withNul, {
      maxBytes: ports.maxBytes,
      stateDir: ports.stateDir,
      spoolId: randomUUID(),
    });
    expect(nul.ok === false && nul.error.code).toBe("MEMO_INVALID_INPUT");
    const invalidPath = join(home, "invalid.md");
    writeFileSync(invalidPath, Buffer.concat([Buffer.alloc(OVER * 2, 0x61), Buffer.from([0xff, 0xfe, 0xfd])]));
    const bad = captureMemoBodyFile(invalidPath, {
      maxBytes: ports.maxBytes,
      stateDir: ports.stateDir,
      spoolId: randomUUID(),
    });
    expect(bad.ok === false && bad.error.code).toBe("MEMO_INVALID_INPUT");
    const overPath = join(home, "over.md");
    writeFileSync(overPath, Buffer.alloc(ports.maxBytes + 1, 0x61));
    const over = captureMemoBodyFile(overPath, {
      maxBytes: ports.maxBytes,
      stateDir: ports.stateDir,
      spoolId: randomUUID(),
    });
    expect(over.ok === false && over.error.code).toBe("MEMO_TOO_LARGE");
    expect(readdirSync(memoInputDirectory(join(home, "state")))).toEqual([]);
  });
});
