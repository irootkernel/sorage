import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { appError, changeMemo, createMemo, err, parseMemoListFilter } from "@sorage/core";
import { createSqliteMemoRepository } from "../../src/memos";
import { createSqliteEventLedger } from "../../src/events";
import { MIGRATIONS, PROJECT_MEMOS_MIGRATION } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { MEMO_ID, MEMO_PROJECT, MEMO_TIME, unwrap, required } from "../fixtures/memo-installation";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(legacy = false) {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  migrate(temp.db, legacy ? MIGRATIONS.slice(0, -1) : MIGRATIONS);
  temp.db
    .prepare(
      "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?, 'memo', 'Memo', 'active', ?, ?)",
    )
    .run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
  return temp;
}
function created() {
  return unwrap(createMemo(MEMO_ID, MEMO_PROJECT, { title: "literal %_", body: "😀".repeat(200) }, MEMO_TIME));
}
function seed(db: ReturnType<typeof fixture>["db"]) {
  const repository = createSqliteMemoRepository(db);
  const value = created();
  unwrap(
    repository.run((tx) => {
      const result = tx.insert(value.memo);
      return result.ok ? tx.appendEvent(randomUUID(), required(value.event)) : result;
    }),
  );
  return { repository, memo: value.memo };
}

describe("Memo migration and transactional repository", () => {
  it("upgrades version 6 without changing existing domain rows, receipts or old migration definitions", () => {
    const { db } = fixture(true);
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO project_bindings VALUES ('binding', ?, 'installation', '/fixture/project', 'directory', ?, ?)",
    ).run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
    db.prepare(
      "INSERT INTO handoffs (id,title,sender_kind,recipient_project_id,current_artifact_id,revision,row_version,review_state,created_at,updated_at) VALUES ('handoff','Legacy','user',?,'artifact',1,1,'awaiting_recipient',?,?)",
    ).run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
    db.prepare(
      "INSERT INTO artifacts VALUES ('artifact','handoff','artifacts/handoff/artifact/body.md','body.md','body.md','text/markdown',0,?,NULL,1,?)",
    ).run("0".repeat(64), MEMO_TIME);
    db.prepare("INSERT INTO review_notes VALUES ('handoff','user',NULL,1,'Legacy note',?,?)").run(MEMO_TIME, MEMO_TIME);
    db.prepare(
      "INSERT INTO events (id,handoff_id,event_type,actor_kind,actor_id,row_version,metadata_json,created_at) VALUES ('event','handoff','HANDOFF_CREATED','user',NULL,1,'{}',?)",
    ).run(MEMO_TIME);
    db.prepare(
      "INSERT INTO idempotency_keys VALUES ('key','handoff','hash','response',?,'2099-01-01T00:00:00.000Z')",
    ).run(MEMO_TIME);
    db.exec("COMMIT");
    const tables = ["projects", "project_bindings", "handoffs", "artifacts", "review_notes", "idempotency_keys"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const migrations = db.prepare("SELECT * FROM schema_migrations").all();
    expect(migrate(db, MIGRATIONS).appliedVersions).toEqual([7]);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version < 7").all()).toEqual(migrations);
    expect(db.prepare("SELECT memo_id FROM events").get()).toMatchObject({ memo_id: null });
    expect(migrate(db, MIGRATIONS).alreadyUpToDate).toBe(true);
    expect(() => db.exec("UPDATE events SET memo_id=NULL")).toThrow();
    expect(() => db.exec("DELETE FROM events")).toThrow();
  });
  it("rolls back the actual Memo migration when a later statement in its step fails", () => {
    const { db } = fixture(true);
    expect(() =>
      migrate(db, [
        ...MIGRATIONS.slice(0, -1),
        { ...PROJECT_MEMOS_MIGRATION, sql: `${PROJECT_MEMOS_MIGRATION.sql}\nINSERT INTO missing_table VALUES (1);` },
      ]),
    ).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='project_memos'").get()).toBeUndefined();
    expect(
      db
        .prepare("PRAGMA table_info(events)")
        .all()
        .some((row) => row.name === "memo_id"),
    ).toBe(false);
    expect(migrate(db, MIGRATIONS).appliedVersions).toEqual([7]);
  });
  it("commits Memo and metadata together, fences stale CAS, and keeps summaries bounded with literal search", () => {
    const { db } = fixture();
    const { repository, memo } = seed(db);
    const closed = unwrap(changeMemo(memo, { operation: "done", expectedRowVersion: 1 }, MEMO_TIME));
    unwrap(
      repository.run((tx) => {
        const result = tx.compareAndSet(closed.memo, 1);
        return result.ok ? tx.appendEvent(randomUUID(), required(closed.event)) : result;
      }),
    );
    expect(unwrap(repository.get(memo.id))).toEqual(closed.memo);
    expect(repository.run((tx) => tx.compareAndSet(closed.memo, 1))).toMatchObject({
      ok: false,
      error: { code: "ROW_VERSION_CONFLICT" },
    });
    const filter = unwrap(parseMemoListFilter({ allProjects: true, state: "all", query: "%_", limit: 1 }, 50));
    const listed = unwrap(repository.list(filter));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ state: "done", bodyPreview: "😀".repeat(128), bodyPreviewTruncated: true });
    expect(listed[0]).not.toHaveProperty("body");
    expect(unwrap(repository.list({ ...filter, query: "%missing" }))).toEqual([]);
    expect(unwrap(createSqliteEventLedger(db).list({ handoffId: memo.id }))).toEqual([]);
  });
  it("pages by creation time and ID without losing unread Memos edited or closed between pages", () => {
    const { db } = fixture();
    const repository = createSqliteMemoRepository(db);
    const memos = [1, 2, 3].map((suffix) => {
      const transition = unwrap(
        createMemo(
          `ab000000-0000-4000-8000-00000000000${suffix}`,
          MEMO_PROJECT,
          { title: `Memo ${suffix}`, body: "Original" },
          suffix === 1 ? MEMO_TIME : "2026-09-27T01:00:00.000Z",
        ),
      );
      unwrap(
        repository.run((tx) => {
          const result = tx.insert(transition.memo);
          return result.ok ? tx.appendEvent(randomUUID(), required(transition.event)) : result;
        }),
      );
      return transition.memo;
    });
    const filter = unwrap(parseMemoListFilter({ projectId: MEMO_PROJECT, state: "all", limit: 1 }, 50));
    const first = unwrap(repository.list(filter));
    expect(first.map((memo) => memo.id)).toEqual([required(memos[2]).id, required(memos[1]).id]);
    const edited = unwrap(
      changeMemo(
        required(memos[1]),
        { operation: "update", expectedRowVersion: 1, body: "Edited between pages" },
        "2026-09-28T00:00:00.000Z",
      ),
    );
    unwrap(
      repository.run((tx) => {
        const result = tx.compareAndSet(edited.memo, 1);
        return result.ok ? tx.appendEvent(randomUUID(), required(edited.event)) : result;
      }),
    );
    const second = unwrap(
      repository.list(filter, { createdAt: required(first[0]).createdAt, id: required(first[0]).id }),
    );
    expect(second.map((memo) => memo.id)).toEqual([required(memos[1]).id, required(memos[0]).id]);
    expect(required(second[0]).bodyPreview).toBe("Edited between pages");
    const closed = unwrap(
      changeMemo(required(memos[0]), { operation: "done", expectedRowVersion: 1 }, "2026-09-29T00:00:00.000Z"),
    );
    unwrap(
      repository.run((tx) => {
        const result = tx.compareAndSet(closed.memo, 1);
        return result.ok ? tx.appendEvent(randomUUID(), required(closed.event)) : result;
      }),
    );
    const third = unwrap(
      repository.list(filter, { createdAt: required(second[0]).createdAt, id: required(second[0]).id }),
    );
    expect(third.map((memo) => memo.id)).toEqual([required(memos[0]).id]);
    expect(required(third[0]).state).toBe("done");
    expect(
      unwrap(repository.list(filter, { createdAt: required(third[0]).createdAt, id: required(third[0]).id })),
    ).toEqual([]);
    expect(unwrap(repository.list({ ...filter, limit: 10 })).map((memo) => memo.id)).toEqual(
      [...memos].reverse().map((memo) => memo.id),
    );
  });
  it("rolls back failed events, callback errors and blocked writes without a partial Memo", () => {
    const { db } = fixture();
    const repository = createSqliteMemoRepository(db);
    const value = created();
    db.exec("CREATE TRIGGER fail_memo_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(
      repository.run((tx) => {
        const inserted = tx.insert(value.memo);
        return inserted.ok ? tx.appendEvent(randomUUID(), required(value.event)) : inserted;
      }).ok,
    ).toBe(false);
    expect(unwrap(repository.get(MEMO_ID))).toBeNull();
    db.exec("DROP TRIGGER fail_memo_event");
    expect(
      repository.run((tx) => {
        unwrap(tx.insert(value.memo));
        return err(appError("MEMO_INVALID_INPUT", "injected"));
      }).ok,
    ).toBe(false);
    expect(unwrap(repository.get(MEMO_ID))).toBeNull();
    expect(
      repository.run((tx) => {
        unwrap(tx.insert(value.memo));
        throw new Error("injected");
      }).ok,
    ).toBe(false);
    expect(unwrap(repository.get(MEMO_ID))).toBeNull();
    db.prepare("INSERT INTO vault_state VALUES (1, ?, ?)").run(process.pid, MEMO_TIME);
    expect(repository.run((tx) => tx.insert(value.memo))).toMatchObject({
      ok: false,
      error: { code: "SERVICE_PAUSED" },
    });
    db.exec("DELETE FROM vault_state");
    db.exec("PRAGMA query_only=ON");
    expect(repository.run((tx) => tx.insert(value.memo)).ok).toBe(false);
    db.exec("PRAGMA query_only=OFF");
    db.exec("ALTER TABLE project_memos RENAME TO inaccessible_memos");
    expect(repository.get(MEMO_ID)).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });
  it("rejects orphan rows and invalid event associations at the database boundary", () => {
    const { db } = fixture();
    const { repository } = seed(db);
    const other = created();
    expect(repository.run((tx) => tx.insert({ ...other.memo, id: randomUUID(), projectId: randomUUID() })).ok).toBe(
      false,
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (id,event_type,actor_kind,metadata_json,created_at) VALUES (?, 'MEMO_CREATED','user','{}',?)",
        )
        .run(randomUUID(), MEMO_TIME),
    ).toThrow();
  });
  it("preserves an acknowledged repository write across an independent process restart", () => {
    const { databasePath } = fixture();
    const imports = `const {openAndMigrate}=await import('./packages/adapters/src/sqlite/migrator.ts');const {MIGRATIONS}=await import('./packages/adapters/src/sqlite/migrations.ts');const {createSqliteMemoRepository}=await import('./packages/adapters/src/memos.ts');const {createMemo}=await import('./packages/core/src/memos.ts');const {db}=openAndMigrate(${JSON.stringify(databasePath)},MIGRATIONS);const repo=createSqliteMemoRepository(db);`;
    const write = spawnSync(
      "bun",
      [
        "-e",
        `${imports}const value=createMemo('${MEMO_ID}','${MEMO_PROJECT}',{title:'persist',body:'body'},'${MEMO_TIME}');if(!value.ok)process.exit(1);const saved=repo.run(tx=>{const r=tx.insert(value.value.memo);return r.ok?tx.appendEvent(crypto.randomUUID(),value.value.event):r});if(!saved.ok)process.exit(2);db.close();console.log('ack');`,
      ],
      { encoding: "utf8" },
    );
    expect(write.status, write.stderr).toBe(0);
    expect(write.stdout.trim()).toBe("ack");
    const read = spawnSync("bun", ["-e", `${imports}console.log(JSON.stringify(repo.get('${MEMO_ID}')));db.close();`], {
      encoding: "utf8",
    });
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ ok: true, value: { id: MEMO_ID, body: "body", rowVersion: 1 } });
  });
  it("serializes genuinely concurrent startup migration processes", async () => {
    const { databasePath } = fixture(true);
    const script = `const {openAndMigrate}=await import('./packages/adapters/src/sqlite/migrator.ts');const {MIGRATIONS}=await import('./packages/adapters/src/sqlite/migrations.ts');const {db,outcome}=openAndMigrate(${JSON.stringify(databasePath)},MIGRATIONS);console.log(JSON.stringify(outcome));db.close();`;
    const run = () =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn("bun", ["-e", script]);
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      });
    const results = await Promise.all([run(), run()]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.flatMap((result) => JSON.parse(result.output).appliedVersions)).toEqual([7]);
  });
});
