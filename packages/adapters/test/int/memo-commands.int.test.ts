import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMemo,
  mutateMemo,
  showMemo,
  listMemos,
  resolveMemoProject,
  UuidGenerator,
  type MemoCommandPorts,
  type Result,
  type MemoExecution,
  backupRestore,
  exportSnapshot,
} from "@sorage/core";
import { createNodeMemoPorts } from "../../src/memo-command-ports";
import { createSqliteMemoRepository } from "../../src/memos";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { migrate } from "../../src/sqlite/migrator";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { FakeClock } from "../../src/testkit/fakes";
import {
  MEMO_PROJECT,
  MEMO_TIME,
  memoInstallation,
  restoredMemoInstallation,
  unwrap,
} from "../fixtures/memo-installation";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const INSTALLATION = "ef000000-0000-4000-8000-000000000001";
const DAY = 86_400_000;
const request = { projectId: MEMO_PROJECT, title: "메모 😀", body: "e\u0301\r\nbody" };
function fixture() {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS);
  temp.db
    .prepare(
      "INSERT INTO projects (id,slug,display_name,status,created_at,updated_at) VALUES (?,'memo','Memo','active',?,?)",
    )
    .run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
  const clock = new FakeClock(Date.parse(MEMO_TIME));
  const ports: MemoCommandPorts = {
    installationId: INSTALLATION,
    memos: createSqliteMemoRepository(temp.db),
    clock,
    ids: new UuidGenerator(),
    defaultPageSize: 2,
  };
  return { ...temp, ports, clock };
}
function code(result: Result<unknown>): string {
  return result.ok ? "OK" : result.error.code;
}
function inventory(db: SorageSqlite) {
  return ["project_memos", "events", "idempotency_keys"].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}
const execute = (key = randomUUID()): MemoExecution => ({ mode: "execute", idempotencyKey: key });
const inspect = (key: string): MemoExecution => ({ mode: "replay-only", idempotencyKey: key });

// Child processes use the real pinned Bun SQLite engine and independent connections.
function concurrent(database: string, calls: string[]) {
  const children = calls.map((call) => {
    const script = `import {openSorageDatabase} from './packages/adapters/src/sqlite/connection.ts';
      import {createSqliteMemoRepository} from './packages/adapters/src/memos.ts';
      import {addMemo,mutateMemo,UuidGenerator} from './packages/core/src/index.ts';
      const db=openSorageDatabase(${JSON.stringify(database)});
      const ports={installationId:${JSON.stringify(INSTALLATION)},memos:createSqliteMemoRepository(db),clock:{now:()=>new Date(${JSON.stringify(MEMO_TIME)})},ids:new UuidGenerator(),defaultPageSize:2};
      console.log('ready');for await(const line of console){ console.log(JSON.stringify(${call}));break; }db.close();`;
    const child = spawn("bun", ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ready\n")) readyResolve();
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const done = new Promise<Result<unknown>>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exit) => {
        readyResolve();
        if (exit !== 0) reject(new Error(errors));
        else resolve(JSON.parse(output.trim().split("\n").at(-1) ?? "null"));
      });
    });
    return { child, ready, done };
  });
  return Promise.all(children.map((child) => child.ready)).then(() => {
    for (const { child } of children) child.stdin.end("go\n");
    return Promise.all(children.map((child) => child.done));
  });
}

describe("shared Memo application", () => {
  it("replays direct text, decoded JSON and file-derived bodies as the same request", () => {
    const { ports, db, home, clock } = fixture();
    const body = "한글 😀 e\u0301\r\nsecond line\n";
    const firstPath = join(home.home, "first.md");
    const otherPath = join(home.home, "different-name.md");
    writeFileSync(firstPath, body, "utf8");
    writeFileSync(otherPath, body, "utf8");
    const policy = execute();
    const original = unwrap(addMemo(ports, { ...request, body }, policy));
    const before = inventory(db);
    clock.advance(1000);
    for (const input of [
      { projectId: MEMO_PROJECT, title: request.title, body: readFileSync(firstPath, "utf8") },
      { title: " " + request.title + " ", body: readFileSync(otherPath, "utf8"), projectId: MEMO_PROJECT },
      JSON.parse(JSON.stringify({ body, title: request.title, projectId: MEMO_PROJECT }).replace("한", "\\uD55C")),
    ]) {
      expect(unwrap(addMemo(ports, input, inspect(policy.idempotencyKey as string)))).toEqual({
        ...original,
        replayed: true,
      });
      expect(unwrap(addMemo(ports, input, policy))).toEqual({ ...original, replayed: true });
      expect(inventory(db)).toEqual(before); // Includes the original receipt's unchanged expiry.
    }
    const updatePolicy = execute();
    const updated = unwrap(
      mutateMemo(
        ports,
        "update",
        original.memo.id,
        { expectedRowVersion: 1, body: readFileSync(firstPath, "utf8") },
        updatePolicy,
      ),
    );
    expect(updated.changed).toBe(false);
    const afterNoop = inventory(db);
    expect(
      unwrap(
        mutateMemo(
          ports,
          "update",
          original.memo.id,
          { body, expectedRowVersion: 1 },
          inspect(updatePolicy.idempotencyKey as string),
        ),
      ),
    ).toEqual({ ...updated, replayed: true });
    expect(inventory(db)).toEqual(afterNoop);
  });
  it.each(["update", "done", "dismiss", "reopen"] as const)(
    "replays %s with its original expectation after later changes",
    (operation) => {
      const { ports, db } = fixture();
      let memo = unwrap(addMemo(ports, request)).memo;
      if (operation === "reopen") memo = unwrap(mutateMemo(ports, "done", memo.id, { expectedRowVersion: 1 })).memo;
      const input = { expectedRowVersion: memo.rowVersion, ...(operation === "update" ? { body: "new body" } : {}) };
      const policy = execute();
      const original = unwrap(mutateMemo(ports, operation, memo.id, input, policy));
      const later = operation === "done" || operation === "dismiss" ? "reopen" : "done";
      unwrap(mutateMemo(ports, later, memo.id, { expectedRowVersion: original.memo.rowVersion }));
      const before = inventory(db);
      expect(unwrap(mutateMemo(ports, operation, memo.id, input, inspect(policy.idempotencyKey as string)))).toEqual({
        ...original,
        replayed: true,
      });
      expect(code(mutateMemo(ports, operation, memo.id, input, inspect(randomUUID())))).toBe("MEMO_REPLAY_UNAVAILABLE");
      expect(inventory(db)).toEqual(before);
    },
  );

  it("leaves Handoff state, counters, timeline, artifacts and its receipt namespace unchanged", () => {
    const { ports, db } = fixture();
    db.exec("BEGIN");
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
    const key = randomUUID();
    db.prepare("INSERT INTO idempotency_keys VALUES (?,'handoff','hash','response',?,'2099-01-01T00:00:00.000Z')").run(
      key,
      MEMO_TIME,
    );
    db.exec("COMMIT");
    const snapshot = () => [
      ...["handoffs", "artifacts", "review_notes", "projects", "project_bindings", "pending_fs_ops"].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      ),
      db.prepare("SELECT * FROM events WHERE handoff_id IS NOT NULL").all(),
      db.prepare("SELECT * FROM idempotency_keys WHERE scope='handoff'").all(),
    ];
    const before = snapshot();
    const memo = unwrap(addMemo(ports, request, execute(key))).memo;
    unwrap(mutateMemo(ports, "update", memo.id, { expectedRowVersion: 1, body: "work is plain text" }));
    unwrap(mutateMemo(ports, "done", memo.id, { expectedRowVersion: 2 }));
    unwrap(listMemos(ports, { allProjects: true, state: "all" }));
    unwrap(showMemo(ports, memo.id));
    expect(snapshot()).toEqual(before);
  });

  it("performs all operations with User provenance, required versions and event-free no-ops", () => {
    const { ports, db, clock } = fixture();
    const first = unwrap(addMemo(ports, request));
    const id = first.memo.id;
    expect(first.memo.createdBy).toEqual({ kind: "user", id: null });
    clock.advance(1000);
    expect(unwrap(mutateMemo(ports, "update", id, { expectedRowVersion: 1, title: " 메모 😀 " })).changed).toBe(false);
    expect(unwrap(showMemo(ports, id))).toEqual(first.memo);
    expect(code(mutateMemo(ports, "done", id, {}))).toBe("MEMO_INVALID_INPUT");
    const updated = unwrap(mutateMemo(ports, "update", id, { expectedRowVersion: 1, body: "changed" }));
    expect(updated.memo.rowVersion).toBe(2);
    expect(code(mutateMemo(ports, "done", id, { expectedRowVersion: 1 }))).toBe("ROW_VERSION_CONFLICT");
    expect(unwrap(mutateMemo(ports, "done", id, { expectedRowVersion: 2 })).memo.state).toBe("done");
    expect(unwrap(mutateMemo(ports, "done", id, { expectedRowVersion: 3 })).changed).toBe(false);
    expect(code(mutateMemo(ports, "update", id, { expectedRowVersion: 3, body: "no" }))).toBe("MEMO_NOT_OPEN");
    expect(code(mutateMemo(ports, "dismiss", id, { expectedRowVersion: 3 }))).toBe("MEMO_NOT_OPEN");
    unwrap(mutateMemo(ports, "reopen", id, { expectedRowVersion: 3 }));
    expect(unwrap(mutateMemo(ports, "dismiss", id, { expectedRowVersion: 4 })).memo.state).toBe("dismissed");
    expect(
      db
        .prepare("SELECT event_type FROM events ORDER BY rowid")
        .all()
        .map((row) => row.event_type),
    ).toEqual(["MEMO_CREATED", "MEMO_UPDATED", "MEMO_MARKED_DONE", "MEMO_REOPENED", "MEMO_DISMISSED"]);
    expect(code(showMemo(ports, id, randomUUID()))).toBe("MEMO_NOT_FOUND");
    expect(code(mutateMemo(ports, "reopen", id, { expectedRowVersion: 5, projectId: randomUUID() }))).toBe(
      "MEMO_NOT_FOUND",
    );
    expect(code(showMemo(ports, randomUUID()))).toBe("MEMO_NOT_FOUND");
  });

  it("keeps normalized historical receipts across edits, archive and process-independent connections", () => {
    const { ports, db, databasePath } = fixture();
    const policy = execute();
    const original = unwrap(addMemo(ports, { title: "  메모 😀  ", projectId: MEMO_PROJECT }, policy));
    const expires = db.prepare("SELECT expires_at FROM idempotency_keys").get();
    unwrap(mutateMemo(ports, "update", original.memo.id, { expectedRowVersion: 1, body: "later" }));
    db.prepare("UPDATE projects SET status='archived'").run();
    const second = openSorageDatabase(databasePath);
    try {
      const replayed = unwrap(
        addMemo(
          { ...ports, memos: createSqliteMemoRepository(second) },
          { body: "", projectId: MEMO_PROJECT, title: "메모 😀" },
          inspect(policy.idempotencyKey as string),
        ),
      );
      expect(replayed).toEqual({ ...original, replayed: true });
    } finally {
      second.close();
    }
    expect(db.prepare("SELECT expires_at FROM idempotency_keys").get()).toEqual(expires);
    expect(code(addMemo(ports, { ...request, body: "\n" }, policy))).toBe("IDEMPOTENCY_CONFLICT");
    expect(code(addMemo(ports, { ...request, title: "bad\n" }, policy))).toBe("MEMO_INVALID_INPUT");
    expect(code(addMemo(ports, request))).toBe("PROJECT_ARCHIVED");
    unwrap(mutateMemo(ports, "update", original.memo.id, { expectedRowVersion: 2, body: "cleanup" }));
    expect(unwrap(mutateMemo(ports, "reopen", original.memo.id, { expectedRowVersion: 3 })).changed).toBe(false);
    unwrap(mutateMemo(ports, "done", original.memo.id, { expectedRowVersion: 3 }));
    expect(code(mutateMemo(ports, "reopen", original.memo.id, { expectedRowVersion: 4 }))).toBe("PROJECT_ARCHIVED");
    expect(unwrap(listMemos(ports, { projectId: MEMO_PROJECT, state: "all" })).items).toHaveLength(1);
  });

  it("binds update presence, exact body bytes and optional Project assertion into receipt identity", () => {
    const { ports, db } = fixture();
    const memo = unwrap(addMemo(ports, request)).memo;
    const policy = execute();
    const original = unwrap(mutateMemo(ports, "update", memo.id, { expectedRowVersion: 1, title: " title " }, policy));
    expect(
      unwrap(
        mutateMemo(
          ports,
          "update",
          memo.id,
          { title: "title", expectedRowVersion: 1 },
          inspect(policy.idempotencyKey as string),
        ),
      ),
    ).toEqual({ ...original, replayed: true });
    for (const fields of [{ body: "" }, { projectId: MEMO_PROJECT }])
      expect(
        code(mutateMemo(ports, "update", memo.id, { expectedRowVersion: 1, title: "title", ...fields }, policy)),
      ).toBe("IDEMPOTENCY_CONFLICT");
    const bodyPolicy = execute();
    unwrap(mutateMemo(ports, "update", memo.id, { expectedRowVersion: 2, body: "e\u0301\r\n" }, bodyPolicy));
    for (const body of ["e\u0301\n", "é\r\n"])
      expect(code(mutateMemo(ports, "update", memo.id, { expectedRowVersion: 2, body }, bodyPolicy))).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
    const noop = execute();
    expect(unwrap(mutateMemo(ports, "reopen", memo.id, { expectedRowVersion: 3 }, noop)).changed).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()?.n).toBe(3);
  });

  it.each([-1, 0, 1])("filters receipt expiry at boundary %+d without modifying even expired records", (offset) => {
    const { ports, clock, db } = fixture();
    const policy = execute();
    const original = unwrap(addMemo(ports, request, policy));
    const before = inventory(db);
    clock.advance(DAY + offset);
    const result = addMemo(ports, request, inspect(policy.idempotencyKey as string));
    expect(code(result)).toBe(offset < 0 ? "OK" : "MEMO_REPLAY_UNAVAILABLE");
    if (result.ok) expect(result.value).toEqual({ ...original, replayed: true });
    expect(inventory(db)).toEqual(before);
  });

  it("samples lookup time after dispatch, never reserves misses and permits a late original", () => {
    const { ports, clock, db } = fixture();
    const policy = execute();
    const before = inventory(db);
    expect(code(addMemo(ports, request, inspect(policy.idempotencyKey as string)))).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(inventory(db)).toEqual(before);
    const original = unwrap(addMemo(ports, request, policy));
    clock.advance(DAY - 1);
    const inspectRepository = ports.memos.inspect;
    const delayed = {
      ...ports,
      memos: {
        ...ports.memos,
        inspect: ((work) => {
          clock.advance(1);
          return inspectRepository(work);
        }) as typeof inspectRepository,
      },
    };
    expect(code(addMemo(delayed, request, inspect(policy.idempotencyKey as string)))).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(unwrap(showMemo(ports, original.memo.id)).rowVersion).toBe(1);
    expect(code(addMemo(ports, request, { mode: "replay-only" }))).toBe("MEMO_INVALID_INPUT");
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()?.n).toBe(1);
    // A separately intended execute can reuse an expired key; recovery never does this.
    expect(unwrap(addMemo(ports, request, policy)).memo.id).not.toBe(original.memo.id);
  });

  it.each(["project_memos", "events", "idempotency_keys"])(
    "rolls back a failure writing %s without partial state",
    (table) => {
      const { ports, db } = fixture();
      const before = inventory(db);
      db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
      expect(code(addMemo(ports, request, execute()))).toBe("INTERNAL_ERROR");
      expect(inventory(db)).toEqual(before);
      db.exec("DROP TRIGGER injected_failure");
      expect(unwrap(addMemo(ports, request, execute())).memo.rowVersion).toBe(1);
    },
  );

  it("keeps read-only recovery safe on query-only storage and propagates fences and lookup failures", () => {
    const { ports, db } = fixture();
    const policy = execute();
    const original = unwrap(addMemo(ports, request, policy));
    db.exec("PRAGMA query_only=ON");
    expect(unwrap(addMemo(ports, request, inspect(policy.idempotencyKey as string))).memo).toEqual(original.memo);
    expect(code(addMemo(ports, request, inspect(randomUUID())))).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(code(addMemo(ports, request, execute()))).toBe("INTERNAL_ERROR");
    db.exec("PRAGMA query_only=OFF");
    db.prepare(
      "INSERT INTO vault_state(id,move_fence_pid,move_fence_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET move_fence_pid=excluded.move_fence_pid",
    ).run(process.pid, MEMO_TIME);
    expect(code(addMemo(ports, request, inspect(policy.idempotencyKey as string)))).toBe("SERVICE_PAUSED");
    expect(code(addMemo(ports, request, execute()))).toBe("SERVICE_PAUSED");
    db.prepare("UPDATE vault_state SET move_fence_pid=NULL").run();
    db.exec("DROP TABLE idempotency_keys");
    expect(code(addMemo(ports, request, inspect(policy.idempotencyKey as string)))).toBe("INTERNAL_ERROR");
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_memos").get()?.n).toBe(1);
  });

  it("binds list cursors to installation, Project, filters and limit with stable creation order", () => {
    const { ports, clock } = fixture();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      clock.advance(1000);
      ids.push(unwrap(addMemo(ports, { ...request, title: `literal %_ ${i}`, body: "😀".repeat(200) })).memo.id);
    }
    const first = unwrap(listMemos(ports, { projectId: MEMO_PROJECT, query: "%_", limit: 2 }));
    expect(first.items.map((m) => m.id)).toEqual(ids.slice(2).reverse());
    expect(
      first.items.every(
        (m) => Buffer.byteLength(m.bodyPreview) <= 512 && m.bodyPreview.isWellFormed() && m.bodyPreviewTruncated,
      ),
    ).toBe(true);
    unwrap(mutateMemo(ports, "update", ids[1] as string, { expectedRowVersion: 1, body: "edited" }));
    const next = unwrap(listMemos(ports, { projectId: MEMO_PROJECT, query: "%_", limit: 2, cursor: first.nextCursor }));
    expect(next.items.map((m) => m.id)).toEqual(ids.slice(0, 2).reverse());
    expect(next.nextCursor).toBeNull();
    for (const override of [{ query: "literal" }, { limit: 1 }, { state: "all" }, { projectId: randomUUID() }])
      expect(
        code(
          listMemos(ports, { projectId: MEMO_PROJECT, query: "%_", limit: 2, cursor: first.nextCursor, ...override }),
        ),
      ).toBe("CURSOR_INVALID");
    expect(
      code(
        listMemos(
          { ...ports, installationId: randomUUID() },
          { projectId: MEMO_PROJECT, query: "%_", limit: 2, cursor: first.nextCursor },
        ),
      ),
    ).toBe("CURSOR_INVALID");
    expect(code(listMemos(ports, { allProjects: true, query: "%_", limit: 2, cursor: first.nextCursor }))).toBe(
      "CURSOR_INVALID",
    );
    expect(code(listMemos(ports, {}))).toBe("MEMO_INVALID_INPUT");
    expect(unwrap(listMemos(ports, { allProjects: true, query: "LITERAL" })).items).toEqual([]);
    expect(code(listMemos(ports, { projectId: randomUUID() }))).toBe("PROJECT_NOT_FOUND");
  });

  it("resolves unbound Projects explicitly without filesystem inference or all-Project fallback", () => {
    const installation = memoInstallation();
    cleanups.push(installation.cleanup);
    const db = openSorageDatabase(installation.database);
    cleanups.push(() => db.close());
    db.prepare(
      "INSERT INTO projects(id,slug,display_name,status,created_at,updated_at) VALUES(?,'unbound','Unbound','active',?,?)",
    ).run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
    const ports = createNodeMemoPorts({
      env: { SORAGE_HOME: installation.home },
      userHome: installation.home,
      database: db,
    });
    expect(unwrap(resolveMemoProject(ports.projectPorts, "unbound"))).toBe(MEMO_PROJECT);
    expect(unwrap(resolveMemoProject(ports.projectPorts, MEMO_PROJECT))).toBe(MEMO_PROJECT);
    const uuidSlug = randomUUID();
    db.prepare("UPDATE projects SET slug=? WHERE id=?").run(uuidSlug, MEMO_PROJECT);
    expect(unwrap(resolveMemoProject(ports.projectPorts, uuidSlug))).toBe(MEMO_PROJECT);
    expect(
      code(resolveMemoProject(ports.projectPorts, undefined, { path: installation.home, userHome: installation.home })),
    ).toBe("PROJECT_NOT_FOUND");
    expect(unwrap(addMemo(ports, request)).memo.projectId).toBe(MEMO_PROJECT);
    db.prepare("UPDATE projects SET display_name='Renamed'").run();
    expect(unwrap(listMemos(ports, { projectId: MEMO_PROJECT })).items[0]?.projectDisplayName).toBe("Renamed");
    ports.close();
    expect(db.prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
  });

  it("uses the real format-2 restore fixture without recreating lost receipts", () => {
    const installation = restoredMemoInstallation();
    cleanups.push(installation.cleanup);
    const ports = createNodeMemoPorts({ env: { SORAGE_HOME: installation.home }, userHome: installation.home });
    cleanups.push(ports.close);
    const db = openSorageDatabase(installation.database);
    cleanups.push(() => db.close());
    const before = inventory(db);
    expect(
      code(
        addMemo(
          ports,
          { projectId: MEMO_PROJECT, title: installation.memo.title, body: installation.memo.body },
          inspect(randomUUID()),
        ),
      ),
    ).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(inventory(db)).toEqual(before);
  });

  it.each([false, true])(
    "recovers a lost application response after same-Installation restore (snapshot includes create: %s)",
    (includesCreate) => {
      const source = memoInstallation(),
        target = memoInstallation();
      cleanups.push(source.cleanup, target.cleanup);
      const ports = createNodeMemoPorts({ env: { SORAGE_HOME: source.home }, userHome: source.home });
      cleanups.push(ports.close);
      const db = openSorageDatabase(source.database);
      cleanups.push(() => db.close());
      db.prepare(
        "INSERT INTO projects(id,slug,display_name,status,created_at,updated_at) VALUES(?,'memo','Memo','active',?,?)",
      ).run(MEMO_PROJECT, MEMO_TIME, MEMO_TIME);
      const sourceBackup = createNodeBackupCommandPorts({ env: { SORAGE_HOME: source.home }, userHome: source.home });
      if (!includesCreate) unwrap(exportSnapshot(unwrap(sourceBackup.exportPorts())));
      const policy = execute();
      unwrap(addMemo(ports, request, policy)); // Response is deliberately discarded.
      if (includesCreate) unwrap(exportSnapshot(unwrap(sourceBackup.exportPorts())));
      const backup = createNodeBackupCommandPorts({
        env: { SORAGE_HOME: target.home },
        userHome: target.home,
        sourcePath: source.vault,
      });
      unwrap(backupRestore(unwrap(backup.restorePorts()), { dryRun: false }));
      const restored = createNodeMemoPorts({ env: { SORAGE_HOME: target.home }, userHome: target.home });
      cleanups.push(restored.close);
      expect(restored.installationId).toBe(ports.installationId);
      const restoredDb = openSorageDatabase(target.database);
      cleanups.push(() => restoredDb.close());
      const before = inventory(restoredDb);
      expect(code(addMemo(restored, request, inspect(policy.idempotencyKey as string)))).toBe(
        "MEMO_REPLAY_UNAVAILABLE",
      );
      expect(inventory(restoredDb)).toEqual(before);
      expect(unwrap(listMemos(restored, { allProjects: true })).items).toHaveLength(includesCreate ? 1 : 0);
    },
  );

  it.each([false, true])("serializes duplicate keys with separate processes (changed request: %s)", (changed) => {
    const { databasePath, db } = fixture();
    const policy = execute();
    return concurrent(databasePath, [
      `addMemo(ports,${JSON.stringify(request)},${JSON.stringify(policy)})`,
      `addMemo(ports,${JSON.stringify({ ...request, title: changed ? "other" : request.title })},${JSON.stringify(policy)})`,
    ]).then((results) => {
      expect(results.map(code).sort()).toEqual(changed ? ["IDEMPOTENCY_CONFLICT", "OK"] : ["OK", "OK"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM project_memos").get()?.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()?.n).toBe(1);
      if (!changed)
        expect(results.filter((result) => result.ok && (result.value as { replayed: boolean }).replayed)).toHaveLength(
          1,
        );
    });
  });

  it.each(["update", "done"])("serializes update versus %s using stale expectations", async (operation) => {
    const { databasePath, ports, db } = fixture();
    const memo = unwrap(addMemo(ports, request)).memo;
    const results = await concurrent(databasePath, [
      `mutateMemo(ports,'update','${memo.id}',{expectedRowVersion:1,body:'A'})`,
      `mutateMemo(ports,'${operation}','${memo.id}',${JSON.stringify({ expectedRowVersion: 1, ...(operation === "update" ? { body: "B" } : {}) })})`,
    ]);
    expect(results.map(code).sort()).toEqual(["OK", "ROW_VERSION_CONFLICT"]);
    expect(unwrap(showMemo(ports, memo.id)).rowVersion).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(2);
  });

  it.each(["add", "reopen"])("serializes Project archive versus %s in the write transaction", async (operation) => {
    const { databasePath, ports } = fixture();
    const memo = unwrap(addMemo(ports, request)).memo;
    unwrap(mutateMemo(ports, "done", memo.id, { expectedRowVersion: 1 }));
    const call =
      operation === "add"
        ? `addMemo(ports,${JSON.stringify(request)})`
        : `mutateMemo(ports,'reopen','${memo.id}',{expectedRowVersion:2})`;
    const results = await concurrent(databasePath, [
      call,
      `(()=>{db.exec('BEGIN IMMEDIATE');db.prepare("UPDATE projects SET status='archived'").run();db.exec('COMMIT');return {ok:true,value:null};})()`,
    ]);
    expect(["OK", "PROJECT_ARCHIVED"]).toContain(code(results[0] as Result<unknown>));
    expect(code(results[1] as Result<unknown>)).toBe("OK");
    expect(code(addMemo(ports, request))).toBe("PROJECT_ARCHIVED");
  });
});
