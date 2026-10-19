import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { NewPendingFsOp } from "@sorage/core";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteIntentLog, executeIntent } from "../../src/intent-log";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { createVaultInitializer } from "../../src/vault";
import { migrate } from "../../src/sqlite/migrator";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The section-3 causal recovery regressions over the real drain: the
 * dependency-aware executor defers a legacy unlink while a pending activation
 * targets the same persisted to_path, a failed activation never releases its
 * dependent unlink, deferred work is reconsidered only after an actually
 * cleared row, and a thrown physical assessment of an already-cleared row is a
 * stale executor's late observation that reports nothing.
 */
const INSTALLATION = "1c0a0c9a-1111-4111-8111-1111111111c1";
const HANDOFF = "1c0a0c9a-2222-4222-8222-2222222222c2";
const ARTIFACT = "1c0a0c9a-3332-4333-8333-3333333333c3";
const RECORD = "1c0a0c9a-4444-4444-8444-4444444444c4";
const KEY = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;
const SHA = "3c".repeat(32);
const TIME = "2026-05-01T00:00:00.000Z";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type DrainFixture = ReturnType<typeof fixture>;

function fixture(prefix: string) {
  const vault = makeTempVault(prefix);
  cleanups.push(vault.cleanup);
  if (!createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION).ok) {
    throw new Error("fixture init must succeed");
  }
  const database = makeTempDatabase(`${prefix}db-`);
  cleanups.push(database.cleanup);
  const plan = productionMigrationPlan();
  migrate(database.db, plan.migrations, () => TIME, {
    databasePath: database.databasePath,
    rebuilds: plan.rebuilds,
  });
  const db = database.db;
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES ('1c0a0c9a-5555-4555-8555-5555555555c5', 'causal', 'Causal', NULL, 'active', ?, ?)",
  ).run(TIME, TIME);
  db.prepare(
    "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'Causal probe', 'user', '1c0a0c9a-5555-4555-8555-5555555555c5', ?, 1, 1, 'awaiting_recipient', ?, ?)",
  ).run(HANDOFF, ARTIFACT, TIME, TIME);
  db.prepare(
    "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 6, ?, 0, ?)",
  ).run(RECORD, KEY, SHA, TIME);
  db.prepare(
    "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, ?, ?)",
  ).run(ARTIFACT, HANDOFF, TIME, RECORD);
  db.exec("COMMIT");
  const ledger = createSqliteEventLedger(db);
  return {
    vaultPath: vault.vaultPath,
    databasePath: database.databasePath,
    db,
    ledger,
    log: createSqliteIntentLog({ db, installationId: INSTALLATION, events: ledger }),
  };
}

function intent(id: string, op: "activate" | "unlink", toPath: string, fromPath: string | null): NewPendingFsOp {
  return { id, op, fromPath, toPath, artifactId: ARTIFACT, createdAt: TIME };
}

function eventsOf(db: DrainFixture["db"], type: string) {
  return db
    .prepare("SELECT handoff_id, actor_kind, metadata_json FROM events WHERE event_type = ? ORDER BY created_at, id")
    .all(type) as Array<{ handoff_id: string | null; actor_kind: string; metadata_json: string }>;
}

describe("the causal legacy drain (section 3)", () => {
  it("defers the unlink-first counterexample and resolves activation before unlink in one invocation", () => {
    const f = fixture("sorage-causal-order-");
    // The counterexample shape: the key's old bytes are already physically
    // gone, an old staged activation still promises the same key, and the
    // dependent unlink sorts first at an equal timestamp with a lower id.
    writeFileSync(join(f.vaultPath, "staging", "staged-1"), "replacement");
    expect(
      f.log.record([intent("a-unlink", "unlink", KEY, null), intent("z-activate", "activate", KEY, "staging/staged-1")])
        .ok,
    ).toBe(true);

    const drained = f.log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    // Activation completed first, then the revisited unlink removed the
    // recreated file: the retired key ends absent with both intents cleared.
    expect(drained.value.resolved.sort()).toEqual(["a-unlink", "z-activate"]);
    expect(existsSync(join(f.vaultPath, KEY))).toBe(false);
    const pending = f.log.pending();
    expect(pending.ok && pending.value).toEqual([]);
    const activated = eventsOf(f.db, "ARTIFACT_ACTIVATED");
    const unlinked = eventsOf(f.db, "ARTIFACT_UNLINKED");
    expect(activated).toHaveLength(1);
    expect(unlinked).toHaveLength(1);
    expect(activated[0]?.handoff_id).toBe(HANDOFF);
    expect(JSON.parse(activated[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY, sha256: SHA });
    expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
    expect(eventsOf(f.db, "ARTIFACT_INTEGRITY_FAILED")).toHaveLength(0);
    // The winner's completion transaction pinned the exact stored key.
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 1,
    });
  });

  it("keeps a failed activation and its dependent unlink durable with zero unlink effect", () => {
    const f = fixture("sorage-causal-failed-");
    // True both-gone: the staged source is gone AND the destination key is
    // absent, so the activation is a retained failure that stays pending and
    // must never release the dependent unlink targeting the same key.
    expect(
      f.log.record([intent("a-unlink", "unlink", KEY, null), intent("z-activate", "activate", KEY, "staging/gone")]).ok,
    ).toBe(true);

    const drained = f.log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.resolved).toEqual([]);
    expect(drained.value.integrityFailed.map((entry) => entry.id)).toEqual(["z-activate"]);
    // No false empty queue: both promises remain and no unlink effect, event,
    // or attempt landed — the unlink defers while its activation is pending.
    const pending = f.log.pending();
    expect(pending.ok && pending.value.map((row) => row.id).sort()).toEqual(["a-unlink", "z-activate"]);
    expect(pending.ok && pending.value.find((row) => row.id === "a-unlink")?.attempts).toBe(0);
    expect(existsSync(join(f.vaultPath, KEY))).toBe(false);
    expect(eventsOf(f.db, "ARTIFACT_UNLINKED")).toHaveLength(0);
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED")).toHaveLength(0);
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 0,
    });
  });

  it("repairs the staged source and a later drain performs activation then unlink, leaving the key absent", () => {
    const f = fixture("sorage-causal-repair-");
    expect(
      f.log.record([intent("a-unlink", "unlink", KEY, null), intent("z-activate", "activate", KEY, "staging/staged-2")])
        .ok,
    ).toBe(true);
    const first = f.log.drain(f.vaultPath);
    expect(first.ok).toBe(true);
    expect(first.ok && first.value.resolved).toEqual([]);

    // The repair: the owned staged source arrives, and the same equal-order
    // pair now completes activation followed by unlink in one invocation.
    writeFileSync(join(f.vaultPath, "staging", "staged-2"), "repaired bytes");
    const second = f.log.drain(f.vaultPath);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.resolved.sort()).toEqual(["a-unlink", "z-activate"]);
    expect(existsSync(join(f.vaultPath, KEY))).toBe(false);
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED")).toHaveLength(1);
    expect(eventsOf(f.db, "ARTIFACT_UNLINKED")).toHaveLength(1);
  });

  it("treats a thrown physical assessment of an already-cleared row as a stale observation, not a failure", () => {
    const f = fixture("sorage-causal-stale-throw-");
    writeFileSync(join(f.vaultPath, "staging", "staged-3"), "competed bytes");
    expect(f.log.record([intent("s-activate", "activate", KEY, "staging/staged-3")]).ok).toBe(true);
    const stagingDir = join(f.vaultPath, "staging");

    // A competitor really clears the row while this drain's initial snapshot
    // is being read, and the staging directory is made read-only so this stale
    // executor's own rename throws genuine I/O (EACCES) afterwards.
    let interleaved = false;
    const staleRead = new Proxy(f.db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (sql !== "SELECT * FROM pending_fs_ops ORDER BY created_at, id") return statement;
          return new Proxy(statement, {
            get(selected, key) {
              if (key !== "all") {
                const value = Reflect.get(selected, key);
                return typeof value === "function" ? value.bind(selected) : value;
              }
              return (...args: Parameters<typeof selected.all>) => {
                const rows = selected.all(...args);
                if (!interleaved) {
                  interleaved = true;
                  const settled = target.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run("s-activate") as {
                    changes: number;
                  };
                  expect(settled.changes).toBe(1);
                  chmodSync(stagingDir, 0o555);
                }
                return rows;
              };
            },
          });
        };
      },
    });
    try {
      const log = createSqliteIntentLog({ db: staleRead, installationId: INSTALLATION, events: f.ledger });
      const drained = log.drain(f.vaultPath);
      // The stale executor's late throw reports nothing: no false failure, no
      // duplicate event, and the drain stays healthy.
      expect(drained.ok).toBe(true);
      expect(eventsOf(f.db, "ARTIFACT_ACTIVATED")).toHaveLength(0);
      expect(eventsOf(f.db, "ARTIFACT_INTEGRITY_FAILED")).toHaveLength(0);
      // The injected genuine I/O throw demonstrably happened: the rename never
      // moved the staged source and the destination was never created.
      expect(readFileSync(join(f.vaultPath, "staging", "staged-3"), "utf8")).toBe("competed bytes");
      expect(existsSync(join(f.vaultPath, KEY))).toBe(false);
    } finally {
      chmodSync(stagingDir, 0o755);
    }
  });

  it("records nothing when a fully-real competitor already executed and settled the intent", () => {
    const f = fixture("sorage-causal-stale-done-");
    writeFileSync(join(f.vaultPath, "staging", "staged-8"), "competed done bytes");
    expect(f.log.record([intent("d-activate", "activate", KEY, "staging/staged-8")]).ok).toBe(true);

    let interleaved = false;
    const staleRead = new Proxy(f.db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (sql !== "SELECT * FROM pending_fs_ops ORDER BY created_at, id") return statement;
          return new Proxy(statement, {
            get(selected, key) {
              if (key !== "all") {
                const value = Reflect.get(selected, key);
                return typeof value === "function" ? value.bind(selected) : value;
              }
              return (...args: Parameters<typeof selected.all>) => {
                const rows = selected.all(...args);
                if (!interleaved) {
                  interleaved = true;
                  // The competitor performs the real physical activation and
                  // settles through the ordinary winner transaction.
                  expect(
                    executeIntent({ op: "activate", fromPath: "staging/staged-8", toPath: KEY }, f.vaultPath),
                  ).toBe("done");
                  const settled = target.prepare("DELETE FROM pending_fs_ops WHERE id = ?").run("d-activate") as {
                    changes: number;
                  };
                  expect(settled.changes).toBe(1);
                }
                return rows;
              };
            },
          });
        };
      },
    });
    const log = createSqliteIntentLog({ db: staleRead, installationId: INSTALLATION, events: f.ledger });
    const drained = log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    // A late both-present observation by the stale executor appends no
    // duplicate success and no false failure; the file the competitor placed
    // stands exactly as it left it.
    expect(eventsOf(f.db, "ARTIFACT_ACTIVATED")).toHaveLength(0);
    expect(eventsOf(f.db, "ARTIFACT_INTEGRITY_FAILED")).toHaveLength(0);
    expect(readFileSync(join(f.vaultPath, KEY), "utf8")).toBe("competed done bytes");
  });

  it("keeps the original error semantics when a thrown physical assessment belongs to a live row", () => {
    const f = fixture("sorage-causal-live-throw-");
    writeFileSync(join(f.vaultPath, "staging", "staged-6"), "blocked bytes");
    expect(f.log.record([intent("l-activate", "activate", KEY, "staging/staged-6")]).ok).toBe(true);
    const artifactParent = join(f.vaultPath, "artifacts", HANDOFF);
    mkdirSync(artifactParent, { recursive: true });
    chmodSync(artifactParent, 0o555);
    try {
      const drained = f.log.drain(f.vaultPath);
      expect(drained.ok).toBe(false);
      if (!drained.ok) expect(drained.error.code).toBe("INTERNAL_ERROR");
      const pending = f.log.pending();
      expect(pending.ok && pending.value).toHaveLength(1);
    } finally {
      chmodSync(artifactParent, 0o755);
    }
  });

  it("never flips a record whose stored key differs from the persisted intent target", () => {
    const f = fixture("sorage-causal-key-mismatch-");
    writeFileSync(join(f.vaultPath, "staging", "staged-4"), "mismatch bytes");
    // The intent's persisted to_path names a different key than the record's
    // stored key: the pinned update must not flip the record.
    expect(
      f.log.record([intent("m-activate", "activate", `artifacts/${HANDOFF}/${ARTIFACT}/other.md`, "staging/staged-4")])
        .ok,
    ).toBe(true);
    const drained = f.log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 0,
    });
  });

  it("resolves a retained record by its exact stored key after the Artifact row is gone", () => {
    const f = fixture("sorage-causal-retained-");
    writeFileSync(join(f.vaultPath, "staging", "staged-5"), "retained bytes");
    // FKOFF delete of the Artifact row leaves the record retained: the
    // fallback arm flips it only because the stored key equals the persisted
    // intent target, and the event keeps a null association with no digest.
    f.db.exec("PRAGMA foreign_keys = OFF");
    f.db.prepare("DELETE FROM artifacts WHERE id = ?").run(ARTIFACT);
    f.db.exec("PRAGMA foreign_keys = ON");
    expect(f.log.record([intent("r-activate", "activate", KEY, "staging/staged-5")]).ok).toBe(true);
    const drained = f.log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    expect(f.db.prepare("SELECT materialized FROM content_records WHERE id = ?").get(RECORD)).toMatchObject({
      materialized: 1,
    });
    const activated = eventsOf(f.db, "ARTIFACT_ACTIVATED");
    expect(activated).toHaveLength(1);
    expect(activated[0]?.handoff_id).toBeNull();
    expect(JSON.parse(activated[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
  });

  it("leaves the vault marker and snapshot tree untouched by corrupted relative intents", () => {
    const f = fixture("sorage-causal-hostile-");
    mkdirSync(join(f.vaultPath, "snapshots"));
    writeFileSync(join(f.vaultPath, "snapshots", "kept.json"), "snapshot canary");
    writeFileSync(join(f.vaultPath, "staging", "staged-7"), "hostile bytes");
    expect(
      f.log.record([
        intent("h-unlink", "unlink", ".sorage-vault.json", null),
        intent("h-activate", "activate", "snapshots/manifest.json", "outside/staged-7"),
      ]).ok,
    ).toBe(true);
    const drained = f.log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.integrityFailed.map((entry) => entry.id).sort()).toEqual(["h-activate", "h-unlink"]);
    expect(existsSync(join(f.vaultPath, ".sorage-vault.json"))).toBe(true);
    expect(existsSync(join(f.vaultPath, "snapshots"))).toBe(true);
    expect(readFileSync(join(f.vaultPath, "snapshots", "kept.json"), "utf8")).toBe("snapshot canary");
  });

  it("refuses to follow a symlinked managed parent or leaf from the executor", () => {
    const f = fixture("sorage-causal-symlink-");
    const outside = join(f.vaultPath, "..", "causal-outside-target");
    writeFileSync(outside, "outside bytes");
    symlinkSync(outside, join(f.vaultPath, "artifacts", "h-linked"));
    try {
      expect(f.log.record([intent("y-unlink", "unlink", "h-linked/target.md", null)]).ok).toBe(true);
      const drained = f.log.drain(f.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.integrityFailed.map((entry) => entry.reason)).toEqual(["unsafe-path"]);
      expect(readFileSync(outside, "utf8")).toBe("outside bytes");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("settles exactly once when two real native processes drain the same causal pair concurrently", async () => {
    const f = fixture("sorage-causal-native-race-");
    writeFileSync(join(f.vaultPath, "staging", "staged-race"), "raced bytes");
    expect(
      f.log.record([
        intent("a-unlink", "unlink", KEY, null),
        intent("z-activate", "activate", KEY, "staging/staged-race"),
      ]).ok,
    ).toBe(true);
    const firstRead = join(f.vaultPath, "..", "race-read-1");
    const secondRead = join(f.vaultPath, "..", "race-read-2");
    const release = join(f.vaultPath, "..", "race-release");
    const childBarrierMs = 10_000;

    // Each child proves it HOLDS the real stale initial drain row set: a
    // structural wrapper delegates every statement to the real SQLite handle
    // but intercepts only the FIRST exact drain pending-read statement
    // (`SELECT * FROM pending_fs_ops ORDER BY created_at, id`), reads the
    // actual rows through the real statement, asserts the two expected intent
    // IDs, writes its owned marker, and waits at the bounded barrier BEFORE
    // returning those same real rows to the actual drain. After release, both
    // drains genuinely execute their held overlapping initial row sets; the
    // wrapper only ever reorders observation, never fabricates rows, touches
    // the filesystem, or hooks production code. Later pending re-reads (the
    // deferred requeue) pass through untouched because only the first
    // occurrence is intercepted.
    const script = (marker: string) => `
      const { writeFileSync, existsSync } = await import("node:fs");
      const { createSqliteIntentLog } = await import(${JSON.stringify(fileURLToPath(new URL("../../src/intent-log.ts", import.meta.url)))});
      const { createSqliteEventLedger } = await import(${JSON.stringify(fileURLToPath(new URL("../../src/events.ts", import.meta.url)))});
      const { openSorageDatabase } = await import(${JSON.stringify(fileURLToPath(new URL("../../src/sqlite/connection.ts", import.meta.url)))});
      const real = openSorageDatabase(${JSON.stringify(f.databasePath)});
      let interceptedInitialRead = false;
      const wrapper = {
        prepare: (sql, ...rest) => {
          const statement = real.prepare(sql, ...rest);
          if (sql !== ${JSON.stringify("SELECT * FROM pending_fs_ops ORDER BY created_at, id")} || interceptedInitialRead) {
            return statement;
          }
          interceptedInitialRead = true;
          return new Proxy(statement, {
            get(selected, key, receiver) {
              if (key !== "all") {
                const value = Reflect.get(selected, key, selected);
                return typeof value === "function" ? value.bind(selected) : value;
              }
              return (...args) => {
                const rows = selected.all(...args);
                const ids = rows.map((row) => row.id).sort();
                if (ids.length !== 2 || ids[0] !== "a-unlink" || ids[1] !== "z-activate") {
                  throw new Error("unexpected initial drain row set: " + JSON.stringify(ids));
                }
                writeFileSync(${JSON.stringify(marker)}, "read:" + ids.join(","));
                const deadline = Date.now() + ${String(childBarrierMs)};
                while (!existsSync(${JSON.stringify(release)})) {
                  if (Date.now() > deadline) throw new Error("race barrier timed out");
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
                return rows;
              };
            },
          });
        },
        exec: (sql, ...rest) => real.exec(sql, ...rest),
        close: () => real.close(),
      };
      try {
        const log = createSqliteIntentLog({
          db: wrapper,
          installationId: ${JSON.stringify(INSTALLATION)},
          events: createSqliteEventLedger(wrapper),
        });
        const drained = log.drain(${JSON.stringify(f.vaultPath)});
        console.log(drained.ok ? "ok" : drained.error.code);
      } finally {
        real.close();
      }
    `;
    const children = [spawn("bun", ["-e", script(firstRead)]), spawn("bun", ["-e", script(secondRead)])];
    // Attach output and close handlers before releasing either process: even
    // an immediate exit is observed, and a stalled drain is killed and awaited.
    const childResults = children.map(
      (child) =>
        new Promise<{ code: number | null; output: string }>((resolve) => {
          let output = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.once("error", (error) => {
            output += String(error);
          });
          child.once("close", (code) => resolve({ code, output }));
        }),
    );
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const waitAndDrain = async (): Promise<void> => {
      const deadline = Date.now() + childBarrierMs;
      // File creation is observable before the other process finishes its
      // write. Wait for both complete proofs, not only their directory entries.
      const hasReadProof = (path: string) =>
        existsSync(path) && readFileSync(path, "utf8") === "read:a-unlink,z-activate";
      while (!(hasReadProof(firstRead) && hasReadProof(secondRead)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      // Both children held the real overlapping initial drain row sets at the
      // barrier — verified by their markers naming the actual intent ids —
      // before either drain executed; release and await both real drains.
      await waitAndDrain();
      expect(readFileSync(firstRead, "utf8"), "first child must hold the initial drain row set").toBe(
        "read:a-unlink,z-activate",
      );
      expect(readFileSync(secondRead, "utf8"), "second child must hold the initial drain row set").toBe(
        "read:a-unlink,z-activate",
      );
      writeFileSync(release, "release");
      drainTimer = setTimeout(() => {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }, 10_000);
      const settled = await Promise.all(childResults);
      clearTimeout(drainTimer);
      for (const result of settled) {
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain("ok");
      }
      const verify = openSorageDatabase(f.databasePath);
      try {
        // Exactly one winner per physical intent, no duplicate or false
        // failure events, no CONTENT events, nothing pending, key absent.
        expect(verify.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
        const activated = verify
          .prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_ACTIVATED'")
          .get() as { c: number };
        const unlinked = verify
          .prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_UNLINKED'")
          .get() as { c: number };
        const integrity = verify
          .prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'ARTIFACT_INTEGRITY_FAILED'")
          .get() as { c: number };
        const content = verify.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type LIKE 'CONTENT_%'").get() as {
          c: number;
        };
        expect(activated.c).toBe(1);
        expect(unlinked.c).toBe(1);
        expect(integrity.c).toBe(0);
        expect(content.c).toBe(0);
        expect(existsSync(join(f.vaultPath, KEY))).toBe(false);
      } finally {
        verify.close();
      }
    } finally {
      // Bounded cleanup on every exit: release the barrier, then kill and
      // await any child that has not already exited — never infer close.
      clearTimeout(drainTimer);
      writeFileSync(release, "release");
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
      await Promise.all(childResults);
      rmSync(firstRead, { force: true });
      rmSync(secondRead, { force: true });
      rmSync(release, { force: true });
    }
  });

  it("never retries a failed activation on an unrelated success and keeps its dependent unlink attempt-free", () => {
    const f = fixture("sorage-causal-unrelated-");
    // Two independent keys: one activation genuinely fails (both-gone) while
    // an unrelated activation succeeds in the same invocation; the dependent
    // unlink of the failed key must not gain an attempt or an effect.
    writeFileSync(join(f.vaultPath, "staging", "staged-good"), "good bytes");
    const otherKey = `artifacts/${HANDOFF}/${ARTIFACT}/other.md`;
    expect(
      f.log.record([
        intent("a-unlink", "unlink", KEY, null),
        intent("m-failed", "activate", KEY, "staging/never-staged"),
        intent("z-good", "activate", otherKey, "staging/staged-good"),
      ]).ok,
    ).toBe(true);
    const drained = f.log.drain(f.vaultPath);
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    // The unrelated success settled; the failed activation was attempted
    // exactly once and stays durable; the dependent unlink never attempted.
    expect(drained.value.resolved).toEqual(["z-good"]);
    expect(drained.value.integrityFailed.map((entry) => entry.id)).toEqual(["m-failed"]);
    const pending = f.log.pending();
    expect(pending.ok && pending.value.map((row) => row.id).sort()).toEqual(["a-unlink", "m-failed"]);
    expect(pending.ok && pending.value.find((row) => row.id === "m-failed")?.attempts).toBe(1);
    expect(pending.ok && pending.value.find((row) => row.id === "a-unlink")?.attempts).toBe(0);
    expect(eventsOf(f.db, "ARTIFACT_UNLINKED")).toHaveLength(0);
    expect(existsSync(join(f.vaultPath, KEY))).toBe(false);
    expect(existsSync(join(f.vaultPath, otherKey))).toBe(true);
  });
});
