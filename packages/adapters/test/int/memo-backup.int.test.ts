import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSorageDatabase } from "../../src/sqlite/connection";
import {
  backupRestore,
  backupVerify,
  canonicalJson,
  canonicalJsonLine,
  changeMemo,
  exportSnapshot,
  snapshotFiles,
  type SnapshotData,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createSqliteMemoRepository } from "../../src/memos";
import {
  memoInstallation,
  restoredMemoInstallation,
  seedMemoInstallation,
  MEMO_ID,
  MEMO_PROJECT,
  unwrap,
  required,
} from "../fixtures/memo-installation";

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
function ports(value: Installation, sourcePath?: string) {
  return createNodeBackupCommandPorts({ env: { SORAGE_HOME: value.home }, userHome: value.home, sourcePath });
}
function exportOnce(value: Installation) {
  return exportSnapshot(unwrap(ports(value).exportPorts()));
}
function restore(target: Installation, source: Installation, dryRun = false) {
  return backupRestore(unwrap(ports(target, source.vault).restorePorts()), { dryRun });
}
const memoPath = `memos/ab/${MEMO_ID}.json`;
function snapshot(value: Installation, name: string) {
  return join(value.vault, "snapshots", name);
}
function manifest(value: Installation) {
  return JSON.parse(readFileSync(snapshot(value, "manifest.json"), "utf8"));
}
function writeManifest(value: Installation, data: unknown) {
  writeFileSync(snapshot(value, "manifest.json"), canonicalJson(data));
}
function replaceMemo(value: Installation, bytes: string | Buffer, updateDigest = true) {
  writeFileSync(snapshot(value, memoPath), bytes);
  if (updateDigest) {
    const data = manifest(value);
    data.memoDigests[memoPath] = createHash("sha256").update(bytes).digest("hex");
    writeManifest(value, data);
  }
}
function changeEvent(value: Installation, work: (events: Array<Record<string, unknown>>) => void) {
  const events = readFileSync(snapshot(value, "events.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  events.sort((a, b) => a.rowVersion - b.rowVersion);
  work(events);
  writeFileSync(snapshot(value, "events.jsonl"), events.map(canonicalJsonLine).join(""));
}
function rows(value: Installation) {
  const db = new DatabaseSync(value.database);
  try {
    return Object.fromEntries(
      ["projects", "project_memos", "events", "idempotency_keys", "handoffs", "artifacts"].map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table} ORDER BY ${table === "events" ? "id" : "rowid"}`)
          .all()
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                ["metadata_json", "created_by", "updated_by", "closed_by"].includes(key) && typeof value === "string"
                  ? JSON.parse(value)
                  : value,
              ]),
            ),
          ),
      ]),
    );
  } finally {
    db.close();
  }
}

describe("Memo format-2 export and recovery", () => {
  it("publishes deterministic canonical bytes with independently computed digests and restores all lifecycle fields", () => {
    const source = installation();
    const memo = seedMemoInstallation(source);
    unwrap(exportOnce(source));
    const bytes = readFileSync(snapshot(source, memoPath));
    const before = ["projects.json", "events.jsonl", "manifest.json", memoPath].map((path) =>
      readFileSync(snapshot(source, path)),
    );
    expect(JSON.parse(bytes.toString())).toEqual(memo);
    expect(bytes.toString()).toBe(canonicalJson(memo));
    expect(manifest(source)).toEqual({
      formatVersion: 2,
      counts: { projects: 1, handoffs: 0, artifacts: 0, events: 3, memos: 1 },
      memoDigests: { [memoPath]: createHash("sha256").update(bytes).digest("hex") },
    });
    unwrap(exportOnce(source));
    expect(
      ["projects.json", "events.jsonl", "manifest.json", memoPath].map((path) => readFileSync(snapshot(source, path))),
    ).toEqual(before);
    const verified = unwrap(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }));
    expect(verified.findings).toEqual([
      "The Vault has no Git repository; re-run sorage init --initialize-git to initialize one.",
    ]);
    const target = installation();
    const beforeDryRun = rows(target);
    unwrap(restore(target, source, true));
    expect(rows(target)).toEqual(beforeDryRun);
    const outcome = unwrap(restore(target, source));
    expect(outcome.adoptedInstallationId).toBe(
      JSON.parse(readFileSync(join(source.vault, ".sorage-vault.json"), "utf8")).installationId,
    );
    const db = openSorageDatabase(target.database);
    expect(unwrap(createSqliteMemoRepository(db).get(MEMO_ID))).toEqual(memo);
    db.close();
    expect(rows(target).project_memos).toEqual(rows(source).project_memos);
    expect(rows(target).events?.filter((row) => row.memo_id !== null)).toEqual(rows(source).events);
    expect(rows(target).idempotency_keys).toEqual([]);
    expect(rows(target).handoffs).toEqual([]);
    expect(rows(target).artifacts).toEqual([]);
    expect(rows(source).idempotency_keys).toHaveLength(1);
  });

  it("provides a restored committed-create fixture with no receipt and no reconstructed receipt", () => {
    const target = restoredMemoInstallation();
    cleanups.push(target.cleanup);
    const db = openSorageDatabase(target.database);
    expect(unwrap(createSqliteMemoRepository(db).get(MEMO_ID))).toEqual(target.memo);
    expect(target.memo.rowVersion).toBe(1);
    expect(db.prepare("SELECT * FROM idempotency_keys").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM events WHERE memo_id IS NOT NULL").all()).toHaveLength(1);
    const repository = createSqliteMemoRepository(db);
    const changed = unwrap(
      changeMemo(
        target.memo,
        { operation: "update", expectedRowVersion: 1, body: "After restore" },
        "2026-09-28T00:00:00.000Z",
      ),
    );
    unwrap(
      repository.run((tx) => {
        const result = tx.compareAndSet(changed.memo, 1);
        return result.ok ? tx.appendEvent(randomUUID(), required(changed.event)) : result;
      }),
    );
    expect(unwrap(repository.get(MEMO_ID))).toEqual(changed.memo);
    db.close();
  });

  it("always exports an empty format-2 inventory and restores it without Memo shards", () => {
    const source = installation();
    unwrap(exportOnce(source));
    expect(manifest(source)).toEqual({
      formatVersion: 2,
      counts: { projects: 0, handoffs: 0, artifacts: 0, events: 0, memos: 0 },
      memoDigests: {},
    });
    const target = installation();
    unwrap(restore(target, source, true));
    unwrap(restore(target, source));
    expect(rows(target).project_memos).toEqual([]);
  });

  it("imports a legacy format-1 backup into a separate home without upgrading its on-disk field set", () => {
    const source = installation();
    const data: SnapshotData = {
      projects: [
        {
          id: MEMO_PROJECT,
          slug: "legacy",
          displayName: "Legacy",
          description: null,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          bindings: [],
        },
      ],
      handoffs: [],
      events: [],
    };
    const legacy = snapshotFiles(data);
    unwrap(unwrap(ports(source).exportPorts()).writeSnapshotTree(legacy));
    const bytes = readFileSync(snapshot(source, "manifest.json"));
    expect(manifest(source)).toEqual({
      formatVersion: 1,
      counts: { projects: 1, handoffs: 0, events: 0, artifacts: 0 },
    });
    const target = installation();
    unwrap(restore(target, source, true));
    unwrap(restore(target, source));
    expect(rows(target).projects?.[0]?.id).toBe(MEMO_PROJECT);
    expect(rows(target).project_memos).toEqual([]);
    expect(rows(target).idempotency_keys).toEqual([]);
    expect(readFileSync(snapshot(source, "manifest.json"))).toEqual(bytes);
  });

  it("preserves the published backup on partial staging failure and replaces scratch on retry", () => {
    const source = installation();
    seedMemoInstallation(source);
    unwrap(exportOnce(source));
    const before = readFileSync(snapshot(source, memoPath));
    const writer = unwrap(ports(source).exportPorts());
    expect(
      writer.writeSnapshotTree([
        { path: "collision", content: "file" },
        { path: "collision/child", content: "cannot publish" },
      ]).ok,
    ).toBe(false);
    expect(readFileSync(snapshot(source, memoPath))).toEqual(before);
    unwrap(exportOnce(source));
    expect(readdirSync(source.vault).filter((name) => name.startsWith(".snapshots."))).toEqual([]);
    const db = new DatabaseSync(source.database);
    db.exec("ALTER TABLE project_memos RENAME TO unavailable_memos");
    db.close();
    expect(exportOnce(source).ok).toBe(false);
    expect(readFileSync(snapshot(source, memoPath))).toEqual(before);
  });

  it("rolls back an interrupted database import and retries with stable identity and no target receipt", () => {
    const source = installation();
    seedMemoInstallation(source);
    unwrap(exportOnce(source));
    const target = installation();
    const db = new DatabaseSync(target.database);
    db.exec(
      "INSERT INTO idempotency_keys VALUES ('target-key','fixture','hash','{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'); CREATE TRIGGER interrupt_memo_import BEFORE INSERT ON events WHEN NEW.memo_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    const before = rows(target);
    expect(restore(target, source).ok).toBe(false);
    expect(rows(target)).toEqual(before);
    db.exec("DROP TRIGGER interrupt_memo_import");
    db.close();
    unwrap(restore(target, source));
    expect(rows(target).idempotency_keys).toEqual([]);
    expect(rows(target).project_memos).toEqual(rows(source).project_memos);
  });
});

const corruptions: Array<[string, (source: Installation) => void]> = [
  ["missing LF with stale digest", (s) => replaceMemo(s, readFileSync(snapshot(s, memoPath)).subarray(0, -1), false)],
  ["missing LF with recomputed digest", (s) => replaceMemo(s, readFileSync(snapshot(s, memoPath)).subarray(0, -1))],
  ["BOM", (s) => replaceMemo(s, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(snapshot(s, memoPath))]))],
  ["noncanonical whitespace", (s) => replaceMemo(s, ` ${readFileSync(snapshot(s, memoPath), "utf8")}`)],
  ["malformed UTF-8", (s) => replaceMemo(s, Buffer.from([0xff, 0x0a]))],
  [
    "duplicate decoded Memo key",
    (s) => replaceMemo(s, readFileSync(snapshot(s, memoPath), "utf8").replace("{", '{"\\u0069d":"duplicate",')),
  ],
  [
    "duplicate manifest key",
    (s) =>
      writeFileSync(
        snapshot(s, "manifest.json"),
        readFileSync(snapshot(s, "manifest.json"), "utf8").replace("{", '{"formatVersion":2,'),
      ),
  ],
  ["missing Memo", (s) => rmSync(snapshot(s, memoPath))],
  [
    "extra Memo",
    (s) =>
      writeFileSync(
        snapshot(s, `memos/ab/ab000000-0000-4000-8000-000000000002.json`),
        readFileSync(snapshot(s, memoPath)),
      ),
  ],
  [
    "missing digest",
    (s) => {
      const m = manifest(s);
      delete m.memoDigests[memoPath];
      writeManifest(s, m);
    },
  ],
  [
    "extra digest",
    (s) => {
      const m = manifest(s);
      m.memoDigests["memos/ab/ab000000-0000-4000-8000-000000000002.json"] = "0".repeat(64);
      writeManifest(s, m);
    },
  ],
  [
    "wrong count",
    (s) => {
      const m = manifest(s);
      m.counts.memos = 2;
      writeManifest(s, m);
    },
  ],
  [
    "wrong shard",
    (s) => {
      mkdirSync(snapshot(s, "memos/aa"));
      renameSync(snapshot(s, memoPath), snapshot(s, `memos/aa/${MEMO_ID}.json`));
    },
  ],
  [
    "record ID mismatch",
    (s) => {
      const memo = JSON.parse(readFileSync(snapshot(s, memoPath), "utf8"));
      memo.id = "ab000000-0000-4000-8000-000000000002";
      replaceMemo(s, canonicalJson(memo));
    },
  ],
  ...["/memos/ab/", "../memos/ab/", "snapshots/memos/ab/", "memos\\ab\\"].map(
    (prefix): [string, (s: Installation) => void] => [
      `path alias ${prefix}`,
      (s) => {
        const m = manifest(s);
        m.memoDigests[`${prefix}${MEMO_ID}.json`] = m.memoDigests[memoPath];
        delete m.memoDigests[memoPath];
        writeManifest(s, m);
      },
    ],
  ),
  [
    "symlink file",
    (s) => {
      const file = snapshot(s, memoPath);
      const outside = join(s.home, "outside.json");
      renameSync(file, outside);
      symlinkSync(outside, file);
    },
  ],
  [
    "symlink shard directory",
    (s) => {
      const shard = snapshot(s, "memos/ab");
      const outside = join(s.home, "outside");
      renameSync(shard, outside);
      symlinkSync(outside, shard);
    },
  ],
  [
    "FIFO special file",
    (s) => {
      const file = snapshot(s, memoPath);
      rmSync(file);
      expect(spawnSync("mkfifo", [file]).status).toBe(0);
    },
  ],
  ["oversized file", (s) => replaceMemo(s, Buffer.alloc(512 * 1024 + 1, 32))],
  [
    "orphan Project",
    (s) => {
      const memo = JSON.parse(readFileSync(snapshot(s, memoPath), "utf8"));
      memo.projectId = "cd000000-0000-4000-8000-000000000002";
      replaceMemo(s, canonicalJson(memo));
    },
  ],
  [
    "orphan event",
    (s) =>
      changeEvent(s, (events) => {
        required(events[0]).memoId = "ab000000-0000-4000-8000-000000000002";
      }),
  ],
  [
    "wrong actor",
    (s) =>
      changeEvent(s, (events) => {
        required(events[0]).actorKind = "registered_project";
      }),
  ],
  [
    "Handoff association",
    (s) =>
      changeEvent(s, (events) => {
        required(events[0]).handoffId = MEMO_ID;
      }),
  ],
  [
    "duplicate event ID",
    (s) =>
      changeEvent(s, (events) => {
        required(events[1]).id = required(events[0]).id;
      }),
  ],
  [
    "duplicate event version",
    (s) =>
      changeEvent(s, (events) => {
        required(events[1]).rowVersion = 1;
      }),
  ],
  [
    "latest event timestamp",
    (s) =>
      changeEvent(s, (events) => {
        required(events[2]).createdAt = "2026-09-27T02:00:00.000Z";
      }),
  ],
  [
    "missing event",
    (s) => {
      changeEvent(s, (events) => {
        events.splice(1, 1);
      });
      const m = manifest(s);
      m.counts.events--;
      writeManifest(s, m);
    },
  ],
  [
    "format 1 containing Memo files",
    (s) => {
      const m = manifest(s);
      m.formatVersion = 1;
      delete m.counts.memos;
      delete m.memoDigests;
      writeManifest(s, m);
    },
  ],
  [
    "future format",
    (s) => {
      const m = manifest(s);
      m.formatVersion = 3;
      writeManifest(s, m);
    },
  ],
];
describe("shared Memo validation before verify, dry-run and restore", () => {
  it.each(corruptions)("rejects %s without importing or adopting identity", (_name, corrupt) => {
    const source = installation();
    seedMemoInstallation(source);
    unwrap(exportOnce(source));
    corrupt(source);
    const target = installation();
    const before = rows(target);
    const config = readFileSync(join(target.home, "config.yaml"));
    expect(backupVerify(unwrap(ports(source).verifyPorts()), { now: new Date() }).ok).toBe(false);
    expect(restore(target, source, true).ok).toBe(false);
    expect(restore(target, source).ok).toBe(false);
    expect(rows(target)).toEqual(before);
    expect(readFileSync(join(target.home, "config.yaml"))).toEqual(config);
  });
});
