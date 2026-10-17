import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SorageSqlite } from "../../packages/adapters/src/sqlite/connection";
import { MIGRATIONS } from "../../packages/adapters/src/sqlite/migrations";
import { migrate } from "../../packages/adapters/src/sqlite/migrator";
import { type SendOutcome, sendRequestHash, workspaceKey } from "../../packages/core/src/index";
import { BINARY, envelopeOf, makeTempDir, runCleanups, sorage, storageProof, twoProjectFixture } from "./helpers";

afterEach(runCleanups);
function data<T = SendOutcome>(run: ReturnType<typeof sorage>): T {
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).toBe("");
  return envelopeOf(run).data as T;
}
function failure(run: ReturnType<typeof sorage>, code: string, exit: number) {
  expect(run.status, run.stderr).toBe(exit);
  expect(run.stdout).toBe("");
  const body = JSON.parse(run.stderr) as {
    error: { code: string; message: string; recovery: { suggestedCommand: string } };
    meta: { requestId: string };
  };
  expect(body.error.code).toBe(code);
  for (const text of [body.error.message, body.error.recovery.suggestedCommand]) {
    expect(text).toContain("original");
    expect(text).toContain("Installation");
    expect(text).toContain("sender context");
    expect(text).not.toMatch(/new key|sorage (init|config|send)|sorage\.log|--as-user|--confirm/);
  }
  expect(body.error.message).toContain("outcome remains unknown");
  expect(body.error.message).toContain(body.meta.requestId);
  return body;
}
function fixture(kind: "body" | "file" = "body", fanout = false, execute = true) {
  const f = twoProjectFixture("sorage-send-recovery-");
  const key = `legacy:${randomUUID()}`;
  const body = "# Original\n";
  const args = [
    "send",
    "--to",
    "beta",
    ...(fanout ? ["--to", "alpha"] : []),
    "--title",
    "Original",
    ...(kind === "file" ? ["--file", f.document, "--allow-external-source"] : ["--body", body]),
    "--idempotency-key",
    key,
  ];
  const run = (argv: string[], home = f.home, cwd = f.workA) => sorage(argv, { home, cwd });
  const outcome = execute ? data(run([...args, "--json"])) : null;
  const path = join(f.home, "state", "sorage.sqlite3");
  const db = <T>(action: (db: DatabaseSync) => T) => {
    const held = new DatabaseSync(path);
    try {
      return action(held);
    } finally {
      held.close();
    }
  };
  const bindings = [f.workA, f.workB];
  const proof = () => [storageProof(f.home), ...bindings.map(storageProof)];
  const recover = (extra: string[] = [], json = true) => {
    const before = proof();
    const result = run([...args, "--replay-only", ...extra, ...(json ? ["--json"] : [])]);
    expect(proof()).toEqual(before);
    return result;
  };
  return { ...f, key, body, args, outcome, path, run, db, proof, recover, bindings };
}
function historical(f: ReturnType<typeof fixture>, version: number) {
  const path = join(makeTempDir("sorage-old-recovery-"), "older.sqlite3");
  const db = new DatabaseSync(path);
  try {
    migrate(db as unknown as SorageSqlite, MIGRATIONS.slice(0, version));
    db.exec(`ATTACH DATABASE '${f.path.replaceAll("'", "''")}' AS source; PRAGMA defer_foreign_keys=ON; BEGIN`);
    for (const { name } of db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','migration_lock')",
      )
      .all() as { name: string }[]) {
      const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[])
        .map((r) => r.name)
        .join(",");
      db.exec(`INSERT INTO ${name}(${columns}) SELECT ${columns} FROM source.${name}`);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  renameSync(path, f.path);
}

describe("AJ-25 compiled send recovery", () => {
  it.each(["body", "file"] as const)(
    "replays original %s fan-out across independent processes without any managed writes",
    (kind) => {
      const f = fixture(kind, true);
      const second = makeTempDir("sorage-recipient-second-");
      data(f.run(["project", "bind", "beta", "--dir", second, "--json"]));
      f.bindings.push(second);
      const config = join(f.home, "config.yaml");
      writeFileSync(config, readFileSync(config, "utf8").replace("inboxMarker: false", "inboxMarker: true"));
      if (kind === "body")
        for (const dir of [f.workB, second]) {
          mkdirSync(join(dir, ".sorage"));
          writeFileSync(join(dir, ".sorage", "INBOX.md"), "retained marker\n");
        }
      f.db((d) =>
        d
          .prepare(
            "INSERT INTO pending_fs_ops(id,op,from_path,to_path,artifact_id,created_at) VALUES(?,'activate','staging/missing','artifacts/missing',NULL,?)",
          )
          .run(randomUUID(), new Date().toISOString()),
      );
      const first = f.recover();
      expect(data(first)).toEqual({ ...f.outcome, replayed: true });
      const secondRun = f.recover();
      expect(data(secondRun)).toEqual({ ...f.outcome, replayed: true });
      expect(envelopeOf(first).meta).not.toEqual(envelopeOf(secondRun).meta);
      const human = f.recover([], false);
      expect(human.status).toBe(0);
      expect(human.stdout).toContain("Historical send receipt");
      expect(human.stdout).toContain("does not report current delivery or Artifact activation");
    },
  );
  it("returns historical creation data after native revision, deletion and sender/recipient archival", () => {
    const f = fixture();
    const id = f.outcome?.handoffs[0]?.handoffId as string;
    const replacement = join(f.workA, "new.md");
    writeFileSync(replacement, "# New\n");
    data(f.run(["revise", id, "--file", replacement, "--expected-row-version", "1", "--json"]));
    expect(data(f.recover())).toEqual({ ...f.outcome, replayed: true });
    data(f.run(["withdraw", id, "--json"]));
    data(f.run(["archive", id, "--as-user", "--json"]));
    data(f.run(["delete", "request", id, "--json"], f.home, f.workB));
    data(f.run(["delete", "approve", id, "--as-user", "--confirm", "--json"]));
    data(f.run(["project", "archive", "alpha", "--json"]));
    data(f.run(["project", "archive", "beta", "--json"]));
    data(f.run(["project", "unbind", "beta", "--dir", f.workB, "--json"]));
    expect(data(f.recover())).toEqual({ ...f.outcome, replayed: true });
  });
  it.each([4, 5, 6, 7])("reads complete historical schema %s without migration, drain or locks", (version) => {
    const f = fixture();
    if (version !== 7) historical(f, version);
    expect(data(f.recover())).toEqual({ ...f.outcome, replayed: true });
    f.db((d) => expect(d.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: version }));
    if (version === 4) {
      writeFileSync(join(f.home, "run", "vault-move.lock"), JSON.stringify({ pid: process.pid }));
      failure(f.recover(), "SERVICE_PAUSED", 75);
    }
  });
  it.each([1, 2, 3])("refuses receipt-less schema %s without migration", (version) => {
    const f = fixture();
    historical(f, version);
    failure(f.recover(), "STORAGE_SCHEMA_UNSUPPORTED", 78);
  });
  it("keeps conflicting original input and another sender from using a retained receipt", () => {
    const f = fixture();
    data(f.run(["project", "archive", "alpha", "--json"]));
    for (const changed of [
      ["--title", "Changed"],
      ["--body", "Changed bytes"],
      ["--to", "alpha"],
      ["--supersedes", randomUUID()],
      ["--as-user"],
    ])
      failure(f.recover(changed), "IDEMPOTENCY_CONFLICT", 75);
    failure(f.recover(["--as", "beta"]), "IDEMPOTENCY_CONFLICT", 75);
    failure(f.recover(["--as", "unknown"]), "PROJECT_NOT_FOUND", 66);
  });
  it("retains senderless and Workspace-to-Project legacy ownership", () => {
    const f = fixture("body", false, false);
    data(f.run(["project", "unbind", "alpha", "--dir", f.workA, "--json"]));
    const original = data(f.run([...f.args, "--json"]));
    const installation = data<{ installationId: string }>(f.run(["config", "show", "--json"])).installationId;
    f.db((d) =>
      expect(d.prepare("SELECT sender_path_snapshot,sender_workspace_key FROM handoffs").get()).toEqual({
        sender_path_snapshot: realpathSync(f.workA),
        sender_workspace_key: workspaceKey(installation, realpathSync(f.workA)),
      }),
    );
    const business = {
      to: ["beta"],
      title: "Original",
      contentSha256: createHash("sha256").update(f.body).digest("hex"),
      kind: "body" as const,
    };
    f.db((d) =>
      d.prepare("UPDATE idempotency_keys SET request_hash=? WHERE key=?").run(sendRequestHash(business), f.key),
    );
    expect(data(f.recover())).toEqual({ ...original, replayed: true });
    const descendant = join(f.workA, "child");
    mkdirSync(descendant);
    data(f.run(["project", "add", "--name", "Child", "--dir", descendant, "--json"]));
    expect(data(f.recover())).toEqual({ ...original, replayed: true });
    data(f.run(["project", "bind", "alpha", "--dir", f.workA, "--json"]));
    f.db((d) =>
      d.prepare("UPDATE idempotency_keys SET request_hash=? WHERE key=?").run(
        sendRequestHash({
          ...business,
          sender: `unregistered_workspace:${workspaceKey(installation, realpathSync(f.workA))}`,
        }),
        f.key,
      ),
    );
    expect(data(f.recover())).toEqual({ ...original, replayed: true });
  });
  it("does not execute on missing or expired receipts and does not clean up expiration", () => {
    const f = fixture();
    f.db((d) => d.exec("UPDATE idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z'"));
    failure(f.recover(), "HANDOFF_REPLAY_UNAVAILABLE", 75);
    f.db((d) => d.exec("DELETE FROM idempotency_keys"));
    failure(f.recover(), "HANDOFF_REPLAY_UNAVAILABLE", 75);
    f.db((d) => expect(d.prepare("SELECT count(*) AS n FROM handoffs").get()).toEqual({ n: 1 }));
  });
  it("retains original identity and uncertainty after an actual native same-Installation backup restore", () => {
    const f = fixture();
    data(f.run(["backup", "run", "--as-user", "--json"]));
    const target = makeTempDir("sorage-recovery-restored-");
    data(f.run(["init", "--non-interactive", "--json"], target));
    data(f.run(["backup", "restore", "--from", join(f.home, "vault"), "--confirm", "--as-user", "--json"], target));
    expect(data<{ installationId: string }>(f.run(["config", "show", "--json"], target)).installationId).toBe(
      data<{ installationId: string }>(f.run(["config", "show", "--json"])).installationId,
    );
    const before = [storageProof(target), ...f.bindings.map(storageProof)];
    failure(f.run([...f.args, "--replay-only", "--json"], target), "HANDOFF_REPLAY_UNAVAILABLE", 75);
    expect([storageProof(target), ...f.bindings.map(storageProof)]).toEqual(before);
  });
  it("reads an authoritative expiry update committed only in WAL, with original SHM preserved", () => {
    const f = fixture();
    const past = "2000-01-01T00:00:00.000Z";
    f.db((d) => d.prepare("UPDATE idempotency_keys SET expires_at=? WHERE key=?").run(past, f.key));
    const held = new DatabaseSync(f.path);
    try {
      held.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      held
        .prepare("UPDATE idempotency_keys SET expires_at=? WHERE key=?")
        .run(new Date(Date.now() + 3600000).toISOString(), f.key);
      const mainOnly = join(makeTempDir("sorage-main-only-"), "main.sqlite3");
      copyFileSync(f.path, mainOnly);
      const main = new DatabaseSync(mainOnly);
      try {
        expect(
          (main.prepare("SELECT expires_at FROM idempotency_keys WHERE key=?").get(f.key) as { expires_at: string })
            .expires_at,
        ).toBe(past);
      } finally {
        main.close();
      }
      // Parent writes precede the no-write baseline; omitting the committed WAL would yield an expired miss.
      expect(data(f.recover())).toEqual({ ...f.outcome, replayed: true });
    } finally {
      held.close();
    }
  });
  it("reports a miss while the response-lost original waits on a real writer fence, then replays its one commit", async () => {
    const f = fixture("body", false, false);
    const db = new DatabaseSync(f.path);
    db.exec("BEGIN IMMEDIATE");
    const child = spawn(BINARY, [...f.args, "--json"], {
      cwd: f.workA,
      env: { ...process.env, SORAGE_HOME: f.home, SORAGE_TEST_REQUEST_ID: undefined },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    try {
      await once(child, "spawn");
      // The blocked original may touch WAL/SHM; only its deliberate later domain/log writes are attributed to it.
      failure(f.run([...f.args, "--replay-only", "--json"]), "HANDOFF_REPLAY_UNAVAILABLE", 75);
      expect(db.prepare("SELECT count(*) AS n FROM handoffs").get()).toEqual({ n: 0 });
      db.exec("COMMIT");
      expect(await ended, stderr).toBe(0);
      const recorded = data(f.recover());
      expect(recorded.replayed).toBe(true);
      expect(recorded.handoffs).toHaveLength(1);
      f.db((d) => expect(d.prepare("SELECT count(*) AS n FROM handoffs").get()).toEqual({ n: 1 }));
    } finally {
      try {
        db.exec("ROLLBACK");
      } catch {}
      db.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await ended;
      }
    }
  });
  it.each([
    ["config-missing", "NOT_INITIALIZED", 78],
    ["config-newer", "STORAGE_SCHEMA_UNSUPPORTED", 78],
    ["config-invalid", "CONFIG_INVALID", 78],
    ["db-missing", "STORAGE_INTEGRITY_ERROR", 73],
    ["db-corrupt", "STORAGE_INTEGRITY_ERROR", 73],
    ["db-history", "STORAGE_INTEGRITY_ERROR", 73],
    ["db-newer", "STORAGE_SCHEMA_UNSUPPORTED", 78],
    ["db-identity", "STORAGE_INTEGRITY_ERROR", 73],
    ["marker-missing", "VAULT_INTEGRITY_ERROR", 73],
    ["marker-invalid", "VAULT_INTEGRITY_ERROR", 73],
    ["marker-identity", "VAULT_INTEGRITY_ERROR", 73],
    ["marker-newer", "VAULT_SCHEMA_UNSUPPORTED", 78],
    ["receipt-malformed", "STORAGE_INTEGRITY_ERROR", 73],
    ["linked-db", "STORAGE_INSPECTION_UNAVAILABLE", 75],
    ["live-file", "SERVICE_PAUSED", 75],
    ["live-db", "SERVICE_PAUSED", 75],
    ["legacy-migration-file", "SERVICE_PAUSED", 75],
  ] as const)("renders contextual %s refusal as %s/%s with no managed writes", (scenario, code, exit) => {
    const f = fixture();
    const config = join(f.home, "config.yaml"),
      marker = join(f.home, "vault", ".sorage-vault.json");
    if (scenario === "config-missing") rmSync(config);
    if (scenario === "config-newer")
      writeFileSync(config, readFileSync(config, "utf8").replace("schemaVersion: 1", "schemaVersion: 2"));
    if (scenario === "config-invalid") writeFileSync(config, "schemaVersion: 1\nbad: [\n");
    if (scenario === "db-missing") rmSync(f.path);
    if (scenario === "db-corrupt") writeFileSync(f.path, "garbage database");
    if (scenario === "db-history") f.db((d) => d.exec("UPDATE schema_migrations SET name='invalid' WHERE version=4"));
    if (scenario === "db-newer")
      f.db((d) => d.exec("INSERT INTO schema_migrations(version,name,applied_at) VALUES(8,'future','2026-01-01')"));
    if (scenario === "db-identity")
      f.db((d) =>
        d
          .prepare("INSERT OR REPLACE INTO installation(id,installation_id,schema_version,created_at) VALUES(1,?,1,?)")
          .run(randomUUID(), new Date().toISOString()),
      );
    if (scenario === "marker-missing") rmSync(marker);
    if (scenario === "marker-invalid") writeFileSync(marker, "{");
    if (scenario === "marker-identity" || scenario === "marker-newer") {
      const value = JSON.parse(readFileSync(marker, "utf8"));
      if (scenario === "marker-identity") value.installationId = randomUUID();
      else value.schemaVersion = 2;
      writeFileSync(marker, JSON.stringify(value));
    }
    if (scenario === "receipt-malformed") f.db((d) => d.exec("UPDATE idempotency_keys SET response_json='{'"));
    if (scenario === "linked-db") {
      const target = join(makeTempDir("sorage-linked-db-"), "db");
      renameSync(f.path, target);
      symlinkSync(target, f.path);
    }
    if (scenario === "live-file" || scenario === "legacy-migration-file")
      writeFileSync(
        join(f.home, "run", scenario === "live-file" ? "vault-move.lock" : "migration.lock"),
        JSON.stringify({ pid: process.pid }),
      );
    if (scenario === "live-db")
      f.db((d) =>
        d
          .prepare("INSERT OR REPLACE INTO vault_state(id,move_fence_pid,move_fence_at) VALUES(1,?,?)")
          .run(process.pid, new Date().toISOString()),
      );
    failure(f.recover(), code, exit);
    const human = f.recover([], false);
    expect(human.status).toBe(exit);
    expect(human.stderr).toContain("outcome remains unknown");
    expect(human.stderr).toContain("Recovery:");
    expect(human.stderr).not.toMatch(/new key|sorage (init|config|send)|sorage\.log/);
  });
  it("ignores a stale fence without clearing it", () => {
    const f = fixture();
    writeFileSync(join(f.home, "run", "vault-move.lock"), "{");
    expect(data(f.recover())).toEqual({ ...f.outcome, replayed: true });
  });
  it("preserves source errors, realpath regular-file acceptance and changed bytes", () => {
    const f = fixture("file");
    const before = f.proof();
    failure(
      f.run([...f.args.filter((arg) => arg !== "--allow-external-source"), "--replay-only", "--json"]),
      "SOURCE_OUTSIDE_WORKSPACE",
      77,
    );
    expect(f.proof()).toEqual(before);
    failure(f.recover(["--file", join(f.workA, "missing")]), "INTERNAL_ERROR", 1);
    failure(f.recover(["--file", f.workA]), "INTERNAL_ERROR", 1);
    const link = join(f.workA, "source-link.md");
    symlinkSync(f.document, link);
    expect(data(f.recover(["--file", link]))).toEqual({ ...f.outcome, replayed: true });
    writeFileSync(f.document, "changed original source");
    failure(f.recover(), "IDEMPOTENCY_CONFLICT", 75);
  });
  it("keeps an unreadable original source failure at INTERNAL_ERROR/1 without an installation log", () => {
    const f = fixture("file");
    const denied = join(makeTempDir("sorage-denied-source-"), "source.md");
    writeFileSync(denied, readFileSync(f.document));
    chmodSync(denied, 0);
    try {
      failure(f.recover(["--file", denied]), "INTERNAL_ERROR", 1);
    } finally {
      chmodSync(denied, 0o600);
    }
  });

  it("does not initialize an absent home and requires the original nonempty key and source", () => {
    const parent = makeTempDir("sorage-recovery-absent-");
    const home = join(parent, "absent");
    const before = storageProof(parent);
    const base = ["send", "--to", "beta", "--title", "Original", "--body", "exact", "--replay-only"];
    for (const extra of [[], ["--idempotency-key", ""], ["--idempotency-key", "   "]]) {
      const run = sorage([...base, ...extra, "--json"], { home });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("original nonempty --idempotency-key");
    }
    const noSource = sorage(
      ["send", "--to", "beta", "--title", "Original", "--idempotency-key", "original", "--replay-only"],
      { home },
    );
    expect(noSource.status).toBe(2);
    failure(sorage([...base, "--idempotency-key", "original", "--json"], { home }), "NOT_INITIALIZED", 78);
    expect(storageProof(parent)).toEqual(before);
  });
});
