import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import {
  type AppError,
  type Result,
  recoverSend,
  type SendOutcome,
  type SendRecoveryInput,
  sendRequestHash,
  workspaceKey,
} from "@sorage/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_ATTEMPTS,
  type InstallationInspectionReader,
  type PreflightInspectPorts,
  withInstallationInspection,
} from "../../src/preflight";
import { createNodeSendRecoveryPorts } from "../../src/send-recovery";
import type { SorageSqlite } from "../../src/sqlite/connection";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempHome } from "../../src/testkit/temp-home";

const entry = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  // Native synchronous scenarios must let worker RPC responses run between tests.
  await setImmediate();
});
function inventory(root: string): string[] {
  const rows: string[] = [];
  const walk = (path: string) => {
    const s = lstatSync(path);
    const base = `${relative(root, path)} ${s.mode} ${s.mtimeMs} ${s.dev}:${s.ino}`;
    if (s.isSymbolicLink()) rows.push(`l ${base} ${readlinkSync(path)}`);
    else if (s.isDirectory()) {
      rows.push(`d ${base}`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else rows.push(`f ${base} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  };
  walk(root);
  return rows;
}
function fixture(kind: "body" | "file" = "body", fanout = false, unregistered = false) {
  const temp = makeTempHome("sorage-recovery-");
  cleanups.push(temp.cleanup);
  const root = realpathSync(temp.home),
    home = join(root, "installation"),
    scratch = join(root, "scratch");
  const work = join(root, "sender"),
    recipient = join(root, "recipient"),
    other = join(root, "other");
  for (const path of [work, recipient, other, scratch]) mkdirSync(path);
  const run = (args: string[], cwd = work, selectedHome = home) => {
    const result = spawnSync("bun", [entry, ...args, "--json"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, SORAGE_HOME: selectedHome },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout).data;
  };
  run(["init", "--non-interactive"]);
  for (const [slug, dir] of [
    ["sender", work],
    ["recipient", recipient],
    ["other", other],
  ]) {
    if (unregistered && slug === "sender") continue;
    run(["project", "add", "--name", slug as string, "--dir", dir as string]);
  }
  const body = "# Original\n";
  const file = join(work, "original.md");
  writeFileSync(file, body);
  const key = `legacy-key-${randomUUID()}`;
  const input: SendRecoveryInput = {
    to: fanout ? ["recipient", "other"] : ["recipient"],
    title: "Original",
    ...(kind === "body" ? { body } : { file }),
    idempotencyKey: key,
    allowExternalSource: false,
    allowUnregistered: false,
    path: work,
    userHome: root,
  };
  const outcome = run([
    "send",
    ...input.to.flatMap((slug) => ["--to", slug]),
    "--title",
    input.title,
    kind === "body" ? "--body" : "--file",
    kind === "body" ? body : file,
    "--idempotency-key",
    key,
  ]) as SendOutcome;
  const databasePath = join(home, "state", "sorage.sqlite3");
  const db = <T>(action: (database: DatabaseSync) => T) => {
    const database = new DatabaseSync(databasePath);
    try {
      return action(database);
    } finally {
      database.close();
    }
  };
  const expires = db(
    (d) =>
      (d.prepare("SELECT expires_at FROM idempotency_keys WHERE key = ?").get(key) as { expires_at: string })
        .expires_at,
  );
  let now = new Date(Date.parse(expires) - 1000);
  const installationId = run(["config", "show"]).installationId as string;
  const bound = [work, recipient, other];
  const recover = (inspection: PreflightInspectPorts = {}) => {
    const before = [inventory(home), ...bound.map(inventory)];
    const result = recoverSend(
      createNodeSendRecoveryPorts({
        env: { SORAGE_HOME: home },
        userHome: root,
        clock: { now: () => now },
        inspection: { scratchParent: scratch, ...inspection },
      }),
      input,
    );
    expect([inventory(home), ...bound.map(inventory)]).toEqual(before);
    expect(readdirSync(scratch)).toEqual([]);
    return result;
  };
  return {
    root,
    home,
    scratch,
    work,
    recipient,
    other,
    file,
    input,
    outcome,
    databasePath,
    installationId,
    db,
    run,
    recover,
    expires,
    bound,
    setNow: (date: Date) => {
      now = date;
    },
  };
}
const code = (r: Result<unknown, AppError>) => (r.ok ? "OK" : r.error.code);

function legacy(f: ReturnType<typeof fixture>, through: number) {
  const path = join(f.root, "older.sqlite3");
  const target = new DatabaseSync(path);
  try {
    migrate(target as unknown as SorageSqlite, MIGRATIONS.slice(0, through));
    target.exec(`ATTACH DATABASE '${f.databasePath.replaceAll("'", "''")}' AS source`);
    target.exec("PRAGMA defer_foreign_keys = ON; BEGIN");
    for (const { name } of target
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','migration_lock')",
      )
      .all() as Array<{ name: string }>) {
      const columns = (target.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>)
        .map((r) => r.name)
        .join(",");
      target.exec(`INSERT INTO ${name} (${columns}) SELECT ${columns} FROM source.${name}`);
    }
    target.exec("COMMIT");
  } finally {
    target.close();
  }
  renameSync(path, f.databasePath);
}

describe("native send receipt inspection", () => {
  it.each(["body", "file"] as const)(
    "replays original %s fan-out without writes, including absent markers and pending activation",
    (kind) => {
      const f = fixture(kind, true);
      const second = join(f.root, "recipient-second");
      mkdirSync(second);
      f.run(["project", "bind", "recipient", "--dir", second]);
      f.bound.push(second);
      if (kind === "body")
        for (const dir of [f.recipient, second]) {
          mkdirSync(join(dir, ".sorage"));
          writeFileSync(join(dir, ".sorage", "INBOX.md"), "retained marker\n");
        }

      const cfg = join(f.home, "config.yaml");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace("inboxMarker: false", "inboxMarker: true"));
      f.db((d) =>
        d
          .prepare(
            "INSERT INTO pending_fs_ops (id,op,from_path,to_path,artifact_id,created_at) VALUES (?,'activate','staging/missing','artifacts/missing',NULL,?)",
          )
          .run(randomUUID(), new Date().toISOString()),
      );
      expect(f.recover()).toEqual({ ok: true, value: { ...f.outcome, replayed: true } });
      expect(f.recover()).toEqual({ ok: true, value: { ...f.outcome, replayed: true } });
    },
  );
  it.each([4, 5, 6, 7, 8])("reads complete schema %s without migration", (version) => {
    const f = fixture();
    if (version !== 8) legacy(f, version);
    expect(code(f.recover())).toBe("OK");
    f.db((d) => expect(d.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: version }));
  });
  it.each([1, 2, 3])("refuses supported receipt-less schema %s", (version) => {
    const f = fixture();
    legacy(f, version);
    expect(code(f.recover())).toBe("STORAGE_SCHEMA_UNSUPPORTED");
  });
  it("replays historical output after native revision, deletion, archival and recipient unbinding", () => {
    const f = fixture();
    const id = f.outcome.handoffs[0]?.handoffId as string;
    const replacement = join(f.work, "new.md");
    writeFileSync(replacement, "# Revised\n");
    f.run(["revise", id, "--file", replacement, "--expected-row-version", "1"]);
    expect(code(f.recover())).toBe("OK");
    f.run(["withdraw", id]);
    f.run(["archive", id, "--as-user"]);
    f.run(["delete", "request", id], f.recipient);
    f.run(["delete", "approve", id, "--as-user", "--confirm"]);
    f.run(["project", "archive", "recipient"]);
    f.run(["project", "unbind", "recipient", "--dir", f.recipient]);
    expect(f.recover()).toEqual({ ok: true, value: { ...f.outcome, replayed: true } });
  });
  it("keeps exact expiry and absent receipts with retained domain rows unknown", () => {
    const f = fixture();
    f.setNow(new Date(f.expires));
    expect(code(f.recover())).toBe("HANDOFF_REPLAY_UNAVAILABLE");
    f.db((d) => d.prepare("DELETE FROM idempotency_keys WHERE key = ?").run(f.input.idempotencyKey));
    expect(code(f.recover())).toBe("HANDOFF_REPLAY_UNAVAILABLE");
    // Retained domain rows and unchanged Installation identity cannot synthesize an absent receipt.
    expect(f.run(["config", "show"]).installationId).toBe(f.installationId);
  });
  it("conflicts for changed input and a wrong sender, even when the original sender is archived", () => {
    const f = fixture();
    f.run(["project", "archive", "sender"]);
    f.input.title = "Changed";
    expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
    f.input.title = "Original";
    f.input.as = "other";
    expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("preserves senderless and Workspace-to-Project inheritance, including descendant downgrade replay", () => {
    const f = fixture("body", false, true);
    const hash = sendRequestHash({
      to: f.input.to,
      title: f.input.title,
      contentSha256: createHash("sha256")
        .update(f.input.body as string)
        .digest("hex"),
      kind: "body",
    });
    f.db((d) =>
      d.prepare("UPDATE idempotency_keys SET request_hash = ? WHERE key = ?").run(hash, f.input.idempotencyKey),
    );
    expect(code(f.recover())).toBe("OK");
    const child = join(f.work, "child");
    mkdirSync(child);
    f.run(["project", "add", "--name", "descendant", "--dir", child]);
    expect(code(f.recover())).toBe("OK");
    f.run(["project", "add", "--name", "sender", "--dir", f.work]);
    expect(code(f.recover())).toBe("OK");
    const aware = sendRequestHash({
      to: f.input.to,
      title: f.input.title,
      contentSha256: createHash("sha256")
        .update(f.input.body as string)
        .digest("hex"),
      kind: "body",
      sender: `unregistered_workspace:${workspaceKey(f.installationId, f.work)}`,
    });
    f.db((d) =>
      d.prepare("UPDATE idempotency_keys SET request_hash = ? WHERE key = ?").run(aware, f.input.idempotencyKey),
    );
    expect(code(f.recover())).toBe("OK");
  });
  it("accepts a regular source symlink and preserves source failures and external-source guards", () => {
    const f = fixture("file");
    const link = join(f.work, "link.md");
    symlinkSync(f.file, link);
    f.input.file = link;
    expect(code(f.recover())).toBe("OK");
    f.input.file = f.work;
    expect(code(f.recover())).toBe("INTERNAL_ERROR");
    f.input.file = join(f.work, "missing");
    expect(code(f.recover())).toBe("INTERNAL_ERROR");
    const outside = join(f.root, "outside.md");
    writeFileSync(outside, readFileSync(f.file));
    f.input.file = outside;
    expect(code(f.recover())).toBe("SOURCE_OUTSIDE_WORKSPACE");
    f.input.allowExternalSource = true;
    expect(code(f.recover())).toBe("OK");
  });
  it.each(["hash", "blob-hash", "json", "blob-json", "empty-json", "expiry", "blob-expiry", "handoff", "fanout"])(
    "rejects malformed retained %s without effects",
    (field) => {
      const f = fixture("body", true);
      f.db((d) => {
        if (field === "blob-hash") d.exec("UPDATE idempotency_keys SET request_hash = X'00'");
        if (field === "blob-expiry") d.exec("UPDATE idempotency_keys SET expires_at = X'00'");
        if (field === "hash") d.exec("UPDATE idempotency_keys SET request_hash = 'bad'");
        if (field === "json") d.exec("UPDATE idempotency_keys SET response_json = '{'");
        if (field === "blob-json") d.exec("UPDATE idempotency_keys SET response_json = X'7b7d'");
        if (field === "empty-json") d.exec("UPDATE idempotency_keys SET response_json = ''");
        if (field === "expiry") d.exec("UPDATE idempotency_keys SET expires_at = 'bad'");
        if (field === "handoff")
          d.prepare(
            "UPDATE handoffs SET sender_project_id = (SELECT id FROM projects WHERE slug='other') WHERE id = ?",
          ).run(f.outcome.handoffs[0]?.handoffId as string);
        if (field === "fanout")
          d.prepare("UPDATE handoffs SET dispatch_group_id = ? WHERE id = ?").run(
            randomUUID(),
            f.outcome.handoffs[1]?.handoffId as string,
          );
      });
      expect(code(f.recover())).toBe("STORAGE_INTEGRITY_ERROR");
    },
  );
  it.each(["json", "blob-json"])("validates raw %s types but does not decode an expired historical outcome", (kind) => {
    const f = fixture();
    f.setNow(new Date(f.expires));
    f.db((d) =>
      d.exec(
        kind === "json"
          ? "UPDATE idempotency_keys SET response_json = '{'"
          : "UPDATE idempotency_keys SET response_json = X'7b7d'",
      ),
    );
    expect(code(f.recover())).toBe(kind === "json" ? "HANDOFF_REPLAY_UNAVAILABLE" : "STORAGE_INTEGRITY_ERROR");
  });
  it.each([
    ["config-missing", "NOT_INITIALIZED"],
    ["config-newer", "STORAGE_SCHEMA_UNSUPPORTED"],
    ["config-invalid", "CONFIG_INVALID"],
    ["db-missing", "STORAGE_INTEGRITY_ERROR"],
    ["db-header", "STORAGE_INTEGRITY_ERROR"],
    ["db-history", "STORAGE_INTEGRITY_ERROR"],
    ["db-newer", "STORAGE_SCHEMA_UNSUPPORTED"],
    ["db-identity", "STORAGE_INTEGRITY_ERROR"],
    ["binding-identity", "STORAGE_INTEGRITY_ERROR"],
    ["marker-missing", "VAULT_INTEGRITY_ERROR"],
    ["marker-malformed", "VAULT_INTEGRITY_ERROR"],
    ["marker-identity", "VAULT_INTEGRITY_ERROR"],
    ["marker-newer", "VAULT_SCHEMA_UNSUPPORTED"],
    ["unsafe-db", "STORAGE_INSPECTION_UNAVAILABLE"],
    ["config-directory", "STORAGE_INSPECTION_UNAVAILABLE"],
    ["db-directory", "STORAGE_INSPECTION_UNAVAILABLE"],
    ["project-status", "STORAGE_INTEGRITY_ERROR"],
    ["binding-kind", "STORAGE_INTEGRITY_ERROR"],
  ])("preserves distinct %s refusal as %s", (scenario, expected) => {
    const f = fixture();
    const config = join(f.home, "config.yaml"),
      marker = join(f.home, "vault", ".sorage-vault.json");
    if (scenario === "config-missing") rmSync(config);
    if (scenario === "config-newer")
      writeFileSync(config, readFileSync(config, "utf8").replace("schemaVersion: 1", "schemaVersion: 2"));
    if (scenario === "config-invalid") writeFileSync(config, "schemaVersion: 1\nbad: [\n");
    if (scenario === "db-missing") rmSync(f.databasePath);
    if (scenario === "config-directory") {
      rmSync(config);
      mkdirSync(config);
    }
    if (scenario === "db-directory") {
      rmSync(f.databasePath);
      mkdirSync(f.databasePath);
    }

    if (scenario === "db-header") writeFileSync(f.databasePath, "garbage");
    if (scenario === "db-history") f.db((d) => d.exec("UPDATE schema_migrations SET name='invalid' WHERE version=4"));
    if (scenario === "db-newer")
      f.db((d) => d.exec("INSERT INTO schema_migrations(version,name,applied_at) VALUES(9,'future','2026-01-01')"));
    if (scenario === "db-identity")
      f.db((d) =>
        d
          .prepare("INSERT OR REPLACE INTO installation(id,installation_id,schema_version,created_at) VALUES(1,?,1,?)")
          .run(randomUUID(), new Date().toISOString()),
      );
    if (scenario === "binding-identity")
      f.db((d) => d.prepare("UPDATE project_bindings SET installation_id=?").run(randomUUID()));
    if (scenario === "marker-missing") rmSync(marker);
    if (scenario === "marker-malformed") writeFileSync(marker, "{");
    if (scenario === "marker-identity" || scenario === "marker-newer") {
      const value = JSON.parse(readFileSync(marker, "utf8"));
      if (scenario === "marker-identity") value.installationId = randomUUID();
      else value.schemaVersion = 2;
      writeFileSync(marker, JSON.stringify(value));
    }
    if (scenario === "unsafe-db") {
      const target = join(f.root, "other.sqlite3");
      renameSync(f.databasePath, target);
      symlinkSync(target, f.databasePath);
    }
    if (scenario === "project-status" || scenario === "binding-kind")
      f.db((d) =>
        d.exec(
          `PRAGMA ignore_check_constraints=ON; ${scenario === "project-status" ? "UPDATE projects SET status='unknown'" : "UPDATE project_bindings SET binding_kind='unknown'"}`,
        ),
      );
    expect(code(f.recover())).toBe(expected);
  });
  it.each(["alive", "dead", "uncertain", "EPERM", "ESRCH", "malformed"])(
    "honors file fences with %s liveness and preserves stale files",
    (state) => {
      const f = fixture();
      writeFileSync(join(f.home, "run", "vault-move.lock"), state === "malformed" ? "{" : JSON.stringify({ pid: 711 }));
      const options: PreflightInspectPorts =
        state === "EPERM" || state === "ESRCH"
          ? {
              kill: () => {
                throw Object.assign(new Error(state), { code: state });
              },
            }
          : { liveness: () => (state === "alive" ? "alive" : state === "uncertain" ? "uncertain" : "dead") };
      expect(code(f.recover(options))).toBe(
        state === "alive" || state === "EPERM"
          ? "SERVICE_PAUSED"
          : state === "uncertain"
            ? "STORAGE_INSPECTION_UNAVAILABLE"
            : "OK",
      );
    },
  );
  it.each(["alive", "dead", "uncertain"] as const)("honors database move fence %s without clearing it", (state) => {
    const f = fixture();
    f.db((d) =>
      d.exec("INSERT OR REPLACE INTO vault_state(id,move_fence_pid,move_fence_at) VALUES (1,711,'2026-01-01')"),
    );
    expect(code(f.recover({ liveness: () => state }))).toBe(
      state === "alive" ? "SERVICE_PAUSED" : state === "uncertain" ? "STORAGE_INSPECTION_UNAVAILABLE" : "OK",
    );
  });
  it("honors version-4 file-only and observed legacy migration fences", () => {
    const f = fixture();
    legacy(f, 4);
    const lock = join(f.home, "run", "migration.lock");
    writeFileSync(lock, JSON.stringify({ pid: 711 }));
    expect(code(f.recover({ liveness: () => "alive" }))).toBe("SERVICE_PAUSED");
    expect(code(f.recover({ liveness: () => "dead" }))).toBe("OK");
  });
  it("reports copy/read/SQLite failures with cleanup, without invoking the consumer again", () => {
    const f = fixture();
    expect(
      code(
        f.recover({
          copyFile: () => {
            throw new Error("copy denied");
          },
        }),
      ),
    ).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(
      code(
        f.recover({
          readFile: () => {
            throw new Error("read denied");
          },
        }),
      ),
    ).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(
      code(
        f.recover({
          openPrivateDatabase: () => {
            throw new Error("snapshot unavailable");
          },
        }),
      ),
    ).toBe("STORAGE_INSPECTION_UNAVAILABLE");
  });
  it("rejects changing capture and a concurrent committed migration without adopting its new state", () => {
    const f = fixture();
    let changes = 0;
    const result = recoverSend(
      createNodeSendRecoveryPorts({
        env: { SORAGE_HOME: f.home },
        inspection: {
          scratchParent: f.scratch,
          copyFile(from, to) {
            copyFileSync(from, to);
            if (from === f.databasePath) {
              changes++;
              f.db((d) => d.exec(`UPDATE schema_migrations SET applied_at='change-${changes}' WHERE version=1`));
            }
          },
        },
      }),
      f.input,
    );
    expect(code(result)).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(changes).toBe(1); // The changed managed shape invalidates this observation immediately.
    expect(readdirSync(f.scratch)).toEqual([]);
    // Only the deliberate competing writer changed source state. A quiescent observation remains usable.
    expect(code(f.recover())).toBe("OK");
  });
  it("samples expiry after capture and uses the committed WAL, leaving its SHM untouched", () => {
    const f = fixture();
    const held = new DatabaseSync(f.databasePath);
    try {
      held.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      held.prepare("UPDATE idempotency_keys SET expires_at=? WHERE key=?").run(f.expires, f.input.idempotencyKey);
      expect(existsSync(`${f.databasePath}-wal`)).toBe(true);
      expect(
        code(
          f.recover({
            copyFile(from, to) {
              copyFileSync(from, to);
              if (from.endsWith("-wal")) f.setNow(new Date(f.expires));
            },
          }),
        ),
      ).toBe("HANDOFF_REPLAY_UNAVAILABLE");
    } finally {
      held.close();
    }
  });
  it("does not hide a late original commit behind a miss or create a duplicate", () => {
    const f = fixture();
    f.input.idempotencyKey = randomUUID();
    let committed = false;
    const beforeCount = f.db((d) => (d.prepare("SELECT count(*) AS n FROM handoffs").get() as { n: number }).n);
    const result = recoverSend(
      createNodeSendRecoveryPorts({
        env: { SORAGE_HOME: f.home },
        inspection: { scratchParent: f.scratch },
        clock: {
          now() {
            expect(committed).toBe(false);
            committed = true;
            f.run([
              "send",
              "--to",
              "recipient",
              "--title",
              f.input.title,
              "--body",
              f.input.body as string,
              "--idempotency-key",
              f.input.idempotencyKey,
            ]);
            return new Date(Date.parse(f.expires) - 1000);
          },
        },
      }),
      f.input,
    );
    expect(code(result)).toBe("HANDOFF_REPLAY_UNAVAILABLE");
    expect(code(f.recover())).toBe("OK");
    f.db((d) => expect(d.prepare("SELECT count(*) AS n FROM handoffs").get()).toEqual({ n: beforeCount + 1 }));
  });
  it("retains uncertainty after an actual native same-Installation backup restore", () => {
    const f = fixture();
    f.run(["backup", "run", "--as-user"]);
    const target = join(f.root, "restored");
    mkdirSync(target);
    f.run(["init", "--non-interactive"], f.work, target);
    f.run(["backup", "restore", "--from", join(f.home, "vault"), "--confirm", "--as-user"], f.work, target);
    expect(f.run(["config", "show"], f.work, target).installationId).toBe(f.installationId);
    const before = inventory(target);
    const result = recoverSend(
      createNodeSendRecoveryPorts({ env: { SORAGE_HOME: target }, inspection: { scratchParent: f.scratch } }),
      f.input,
    );
    expect(code(result)).toBe("HANDOFF_REPLAY_UNAVAILABLE");
    expect(inventory(target)).toEqual(before);
  });
  it.each(["db", "config"])("distinguishes missing %s under a supported configured Vault alias", (missing) => {
    const f = fixture();
    const actual = join(f.root, "actual-vault");
    renameSync(join(f.home, "vault"), actual);
    symlinkSync(actual, join(f.home, "vault"));
    const config = join(f.home, "config.yaml");
    const text = readFileSync(config, "utf8");
    writeFileSync(config, text.replace(/path: .+/, `path: ${JSON.stringify(actual)}`));
    expect(code(f.recover())).toBe("OK");
    rmSync(missing === "db" ? f.databasePath : config);
    expect(code(f.recover())).toBe(missing === "db" ? "STORAGE_INTEGRITY_ERROR" : "NOT_INITIALIZED");
  });
  it("keeps an unrelated or non-directory Vault alias unsafe when the database is missing", () => {
    const f = fixture();
    const actual = join(f.root, "unrelated");
    mkdirSync(actual);
    renameSync(join(f.home, "vault"), join(f.root, "real-vault"));
    const config = join(f.home, "config.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(/path: .+/, `path: ${JSON.stringify(join(f.root, "real-vault"))}`),
    );
    symlinkSync(actual, join(f.home, "vault"));
    rmSync(f.databasePath);
    expect(code(f.recover())).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    rmSync(actual, { recursive: true });
    writeFileSync(actual, "not a directory");
    expect(code(f.recover())).toBe("STORAGE_INSPECTION_UNAVAILABLE");
  });
});

describe("inspection consumer and handle lifetime", () => {
  it("runs the consumer once outside retry handling, closes on throw, and exposes SELECT only", () => {
    const f = fixture();
    let escaped: InstallationInspectionReader | undefined;
    let closes = 0;
    const consumer = vi.fn((observation) => {
      expect(observation.kind).toBe("ready");
      if (observation.kind !== "ready") throw new Error("expected ready");
      escaped = observation.reader;
      expect(() => escaped?.prepare("DELETE FROM idempotency_keys")).toThrow("SELECT");
      throw new Error("consumer failure");
    });
    expect(() =>
      withInstallationInspection(
        f.home,
        {
          scratchParent: f.scratch,
          openPrivateDatabase(path) {
            const db = new DatabaseSync(path);
            return {
              exec: (sql) => db.exec(sql),
              prepare: (sql) => db.prepare(sql),
              close() {
                closes++;
                db.close();
              },
            };
          },
        },
        consumer,
      ),
    ).toThrow("consumer failure");
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(closes).toBe(1);
    expect(readdirSync(f.scratch)).toEqual([]);
    expect(() => escaped?.prepare("SELECT * FROM projects")).toThrow();
  });
  it("closes every handle when the final migrationVersion read fails before ownership transfer", () => {
    const f = fixture();
    let opens = 0,
      closes = 0;
    const consume = vi.fn((o) => o.kind);
    withInstallationInspection(
      f.home,
      {
        scratchParent: f.scratch,
        openPrivateDatabase(path) {
          const db = new DatabaseSync(path);
          opens++;
          return {
            exec: (sql) => db.exec(sql),
            prepare(sql) {
              if (sql === "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                throw new Error("injected final read failure");
              return db.prepare(sql);
            },
            close() {
              closes++;
              db.close();
            },
          };
        },
      },
      consume,
    );
    expect(opens).toBe(CAPTURE_ATTEMPTS);
    expect(closes).toBe(opens);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveReturnedWith("refused");
    expect(readdirSync(f.scratch)).toEqual([]);
  });
});
