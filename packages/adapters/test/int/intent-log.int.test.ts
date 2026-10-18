import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, type NewPendingFsOp, type PendingFsOp } from "@sorage/core";
import { collectVaultGarbage, createSqliteIntentLog, executeIntent } from "../../src/intent-log";
import { createSqliteEventLedger } from "../../src/events";
import {
  createSqliteHandoffWriteStore,
  createSqliteRevisionStore,
  createSqliteRetentionStore,
} from "../../src/handoffs";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { createVaultInitializer } from "../../src/vault";
import { migrate } from "../../src/sqlite/migrator";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { makeTempHome } from "../../src/testkit/temp-home";
import { makeTempVault } from "../../src/testkit/temp-vault";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";
const OLD = new Date("2026-01-01T00:00:00.000Z");
const RECENT = new Date("2026-06-01T00:00:00.000Z");

function intentFixture(prefix: string) {
  const vault = makeTempVault(prefix);
  if (!createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION).ok) {
    throw new Error("fixture init must succeed");
  }
  const database = makeTempDatabase(`${prefix}db-`);
  migrate(database.db, MIGRATIONS);
  const log = createSqliteIntentLog({ db: database.db, installationId: INSTALLATION });
  return {
    vaultPath: vault.vaultPath,
    db: database.db,
    databasePath: database.databasePath,
    log,
    cleanup: () => {
      database.cleanup();
      vault.cleanup();
    },
  };
}

function activate(
  id: string,
  fromPath: string,
  toPath: string,
  createdAt = "2026-05-01T00:00:00.000Z",
): NewPendingFsOp {
  return { id, op: "activate", fromPath, toPath, artifactId: null, createdAt };
}

function unlinkIntent(id: string, toPath: string, createdAt = "2026-05-01T00:00:00.000Z"): NewPendingFsOp {
  return { id, op: "unlink", fromPath: null, toPath, artifactId: null, createdAt };
}

describe("createSqliteIntentLog record and pending", () => {
  it("records intents in one transaction and lists them in createdAt order", () => {
    const fixture = intentFixture("sorage-record-");
    try {
      const recorded = fixture.log.record([
        activate("i-2", "staging/b", "artifacts/h/a2", "2026-05-02T00:00:00.000Z"),
        activate("i-1", "staging/a", "artifacts/h/a1", "2026-05-01T00:00:00.000Z"),
      ]);
      expect(recorded.ok).toBe(true);
      const pending = fixture.log.pending();
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value.map((intent) => intent.id)).toEqual(["i-1", "i-2"]);
      expect(pending.value[0]?.attempts).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("createSqliteIntentLog drain", () => {
  it("activates a staged file through rename plus parent fsync and clears the intent", () => {
    const fixture = intentFixture("sorage-drain-activate-");
    try {
      writeFileSync(join(fixture.vaultPath, "staging", "staged-1"), "artifact bytes");
      const recorded = fixture.log.record([activate("i-1", "staging/staged-1", "artifacts/h-1/a-1/doc.md")]);
      expect(recorded.ok).toBe(true);
      const drained = fixture.log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.resolved).toEqual(["i-1"]);
      expect(drained.value.integrityFailed).toEqual([]);
      expect(readFileSync(join(fixture.vaultPath, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("artifact bytes");
      expect(readdirSync(join(fixture.vaultPath, "staging"))).toEqual([]);
      const pending = fixture.log.pending();
      if (pending.ok) expect(pending.value).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("replays idempotently: a second drain produces the same result and changes nothing", () => {
    const fixture = intentFixture("sorage-drain-twice-");
    try {
      writeFileSync(join(fixture.vaultPath, "staging", "staged-1"), "stable bytes");
      fixture.log.record([activate("i-1", "staging/staged-1", "artifacts/h-1/a-1/doc.md")]);
      const first = fixture.log.drain(fixture.vaultPath);
      const second = fixture.log.drain(fixture.vaultPath);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value.resolved).toEqual([]);
      expect(second.value.integrityFailed).toEqual([]);
      expect(readFileSync(join(fixture.vaultPath, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("stable bytes");
    } finally {
      fixture.cleanup();
    }
  });

  it("completes an activate whose source is gone and whose destination is present without touching the filesystem", () => {
    const fixture = intentFixture("sorage-drain-done-");
    try {
      const destination = join(fixture.vaultPath, "artifacts/h-1/a-1/doc.md");
      mkdirSync(join(fixture.vaultPath, "artifacts/h-1/a-1"), { recursive: true });
      writeFileSync(destination, "already placed");
      const before = statSync(destination);
      fixture.log.record([activate("i-1", "staging/vanished", "artifacts/h-1/a-1/doc.md")]);
      const drained = fixture.log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.resolved).toEqual(["i-1"]);
      const after = statSync(destination);
      expect(readFileSync(destination, "utf8")).toBe("already placed");
      expect(after.mtimeMs).toBe(before.mtimeMs);
      const pending = fixture.log.pending();
      if (pending.ok) expect(pending.value).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("marks an activate with both ends gone integrity-failed without fabricating a file (VLT-014)", () => {
    const fixture = intentFixture("sorage-drain-failed-");
    try {
      fixture.log.record([activate("i-1", "staging/vanished", "artifacts/h-1/a-9/none.md")]);
      const drained = fixture.log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.resolved).toEqual([]);
      expect(drained.value.integrityFailed).toHaveLength(1);
      const failure = drained.value.integrityFailed[0];
      if (!failure) throw new Error("failure expected");
      expect(failure.id).toBe("i-1");
      expect(failure.event).toBe("ARTIFACT_INTEGRITY_FAILED");
      expect(failure.reason).toBe("both-gone");
      expect(failure.toPath).toBe("artifacts/h-1/a-9/none.md");
      expect(existsSync(join(fixture.vaultPath, "artifacts/h-1/a-9/none.md"))).toBe(false);
      // The row stays recorded as the durable integrity-failed signal, and a
      // replayed drain produces the same result: still unresolved, nothing done.
      const pending = fixture.log.pending();
      if (!pending.ok) return;
      expect(pending.value).toHaveLength(1);
      expect(pending.value[0]?.attempts).toBe(1);
      const again = fixture.log.drain(fixture.vaultPath);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.integrityFailed).toHaveLength(1);
      expect(existsSync(join(fixture.vaultPath, "artifacts/h-1/a-9/none.md"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses to overwrite when both ends of an activate are present (epic audit F003)", () => {
    const fixture = intentFixture("sorage-drain-both-");
    try {
      const source = join(fixture.vaultPath, "staging", "still-there");
      const destination = join(fixture.vaultPath, "artifacts/h-1/a-1/doc.md");
      writeFileSync(source, "staged replacement");
      mkdirSync(join(fixture.vaultPath, "artifacts/h-1/a-1"), { recursive: true });
      writeFileSync(destination, "existing bytes");
      fixture.log.record([activate("i-1", "staging/still-there", "artifacts/h-1/a-1/doc.md")]);
      const drained = fixture.log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.resolved).toEqual([]);
      expect(drained.value.integrityFailed).toHaveLength(1);
      expect(drained.value.integrityFailed[0]?.reason).toBe("destination-conflict");
      // Nothing was overwritten and nothing was fabricated.
      expect(readFileSync(destination, "utf8")).toBe("existing bytes");
      expect(readFileSync(source, "utf8")).toBe("staged replacement");
    } finally {
      fixture.cleanup();
    }
  });

  it("unlinks a present target and completes immediately for an already-gone one", () => {
    const fixture = intentFixture("sorage-drain-unlink-");
    try {
      const target = join(fixture.vaultPath, "artifacts/h-1/a-1/old.md");
      mkdirSync(join(fixture.vaultPath, "artifacts/h-1/a-1"), { recursive: true });
      writeFileSync(target, "superseded bytes");
      fixture.log.record([
        unlinkIntent("i-1", "artifacts/h-1/a-1/old.md"),
        unlinkIntent("i-2", "artifacts/h-1/a-1/gone.md"),
      ]);
      const drained = fixture.log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.resolved).toEqual(["i-1", "i-2"]);
      expect(existsSync(target)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses an unsafe path without touching the filesystem", () => {
    const fixture = intentFixture("sorage-drain-unsafe-");
    try {
      const outside = join(fixture.vaultPath, "..", "outside.txt");
      fixture.log.record([activate("i-1", "staging/ok", "../../../etc/passwd", "2026-05-01T00:00:00.000Z")]);
      const drained = fixture.log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.resolved).toEqual([]);
      expect(drained.value.integrityFailed[0]?.reason).toBe("unsafe-path");
      expect(existsSync(outside)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("blocks the drain on a foreign Vault marker (VLT-019)", () => {
    const fixture = intentFixture("sorage-drain-guard-");
    try {
      writeFileSync(
        join(fixture.vaultPath, ".sorage-vault.json"),
        `${JSON.stringify({
          type: "sorage-vault",
          schemaVersion: 1,
          installationId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      const drained = fixture.log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(false);
      if (drained.ok) return;
      expect(drained.error.code).toBe("VAULT_INTEGRITY_ERROR");
    } finally {
      fixture.cleanup();
    }
  });

  it("clears executed intents as the mutation-path completion commit", () => {
    const fixture = intentFixture("sorage-clear-");
    try {
      fixture.log.record([activate("i-1", "staging/x", "artifacts/h/a"), unlinkIntent("i-2", "artifacts/h/b")]);
      const cleared = fixture.log.clear(["i-1", "i-2"]);
      expect(cleared.ok).toBe(true);
      const pending = fixture.log.pending();
      if (pending.ok) expect(pending.value).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("collectVaultGarbage", () => {
  it("sweeps by age after the drain and never removes a storageKey or pending-intent path (VLT-013)", () => {
    const fixture = intentFixture("sorage-gc-");
    try {
      const vault = fixture.vaultPath;
      const stagedOld = join(vault, "staging", "staged-old");
      const stagedYoung = join(vault, "staging", "staged-young");
      writeFileSync(stagedOld, "old staged");
      writeFileSync(stagedYoung, "young staged");
      const live = join(vault, "artifacts/h-1/a-1/live.md");
      const pendingTarget = join(vault, "artifacts/h-1/a-2/pending.md");
      const orphan = join(vault, "artifacts/h-1/a-3/orphan.md");
      const youngOrphan = join(vault, "artifacts/h-1/a-4/young.md");
      for (const path of [live, pendingTarget, orphan, youngOrphan]) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "bytes");
      }
      for (const path of [stagedOld, live, pendingTarget, orphan]) {
        utimesSync(path, OLD, OLD);
      }
      for (const path of [stagedYoung, youngOrphan]) {
        utimesSync(path, RECENT, RECENT);
      }
      const pendingIntents: PendingFsOp[] = [
        {
          id: "i-1",
          op: "unlink",
          fromPath: null,
          toPath: "artifacts/h-1/a-2/pending.md",
          artifactId: null,
          ownerDomain: null,
          ownerId: null,
          contentId: null,
          createdAt: "2026-05-01T00:00:00.000Z",
          attempts: 0,
        },
      ];
      const collected = collectVaultGarbage(vault, pendingIntents, {
        liveStorageKeys: ["artifacts/h-1/a-1/live.md"],
        graceHours: 24,
        now: new Date("2026-06-02T00:00:00.000Z"),
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.sweptStaging).toEqual([stagedOld]);
      expect(collected.value.sweptUnreferenced).toEqual([orphan]);
      expect(existsSync(stagedYoung)).toBe(true);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(pendingTarget)).toBe(true);
      expect(existsSync(youngOrphan)).toBe(true);
      expect(existsSync(join(vault, ".sorage-vault.json"))).toBe(true);
      expect(existsSync(join(vault, ".gitattributes"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("record fencing and conservative garbage collection (epic audit round 2)", () => {
  it("pauses an intent commit while vault-move.lock is live (RUN-014)", () => {
    const home = makeTempHome("sorage-record-paused-");
    try {
      const database = makeTempDatabase("sorage-record-paused-db-");
      migrate(database.db, MIGRATIONS);
      mkdirSync(join(home.home, "run"), { recursive: true });
      writeFileSync(
        join(home.home, "run", "vault-move.lock"),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "here" })}\n`,
      );
      const log = createSqliteIntentLog({
        db: database.db,
        installationId: INSTALLATION,
        runDir: join(home.home, "run"),
      });
      const recorded = log.record([activate("i-1", "staging/a", "artifacts/h/a")]);
      expect(recorded.ok).toBe(false);
      if (recorded.ok) return;
      expect(recorded.error.code).toBe("SERVICE_PAUSED");
      const pending = log.pending();
      if (pending.ok) expect(pending.value).toEqual([]);
      database.cleanup();
    } finally {
      home.cleanup();
    }
  });

  it("never sweeps artifacts/ while no registry can prove a file unreferenced (F004 guard)", () => {
    const fixture = intentFixture("sorage-gc-noregistry-");
    try {
      const orphan = join(fixture.vaultPath, "artifacts/h-1/a-1/orphan.md");
      mkdirSync(join(fixture.vaultPath, "artifacts/h-1/a-1"), { recursive: true });
      writeFileSync(orphan, "old bytes");
      utimesSync(orphan, OLD, OLD);
      const staged = join(fixture.vaultPath, "staging", "old-staged");
      writeFileSync(staged, "old staged");
      utimesSync(staged, OLD, OLD);
      const collected = collectVaultGarbage(fixture.vaultPath, [], {
        liveStorageKeys: [],
        graceHours: 24,
        now: new Date("2026-06-02T00:00:00.000Z"),
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.sweptStaging).toEqual([staged]);
      expect(collected.value.sweptUnreferenced).toEqual([]);
      expect(existsSync(orphan)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("staging sweep guard (epic audit round 3)", () => {
  it("never sweeps a staged source a pending intent still names, whatever its age", () => {
    const fixture = intentFixture("sorage-gc-guarded-");
    try {
      const guardedStaged = join(fixture.vaultPath, "staging", "conflicted");
      const oldStaged = join(fixture.vaultPath, "staging", "abandoned");
      writeFileSync(guardedStaged, "awaiting conflict resolution");
      writeFileSync(oldStaged, "nobody names this");
      utimesSync(guardedStaged, OLD, OLD);
      utimesSync(oldStaged, OLD, OLD);
      const pending: PendingFsOp = {
        id: "i-1",
        op: "activate",
        fromPath: "staging/conflicted",
        toPath: "artifacts/h-1/a-1/doc.md",
        artifactId: "a-1",
        ownerDomain: null,
        ownerId: null,
        contentId: null,
        createdAt: "2026-05-01T00:00:00.000Z",
        attempts: 1,
      };
      const collected = collectVaultGarbage(fixture.vaultPath, [pending], {
        liveStorageKeys: ["artifacts/h-1/a-1/doc.md"],
        graceHours: 24,
        now: new Date("2026-06-02T00:00:00.000Z"),
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.sweptStaging).toEqual([oldStaged]);
      expect(existsSync(guardedStaged)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("legacy completion events in the drain (SEC-012)", () => {
  const HANDOFF = "0a111111-1111-4111-8111-1111111111aa";
  const ARTIFACT = "0a111111-2222-4111-8111-1111111111ab";
  const PROJECT = "0a111111-5555-4111-8111-1111111111ae";
  const KEY = "artifacts/h-1/a-1/doc.md";
  const SHA = "1b".repeat(32);

  function completionFixture(prefix: string) {
    const fixture = intentFixture(prefix);
    const ledger = createSqliteEventLedger(fixture.db);
    // One live Artifact row: the authoritative association and digest source.
    // Insert the deferred Handoff/Artifact reference cycle in one transaction.
    fixture.db.exec("BEGIN");
    fixture.db
      .prepare(
        "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'drain-probe', 'Drain Probe', NULL, 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
      )
      .run(PROJECT);
    fixture.db
      .prepare(
        `INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version,
          review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at)
        VALUES (?, 'Drain event probe', 'user', ?, ?, 1, 1, 'awaiting_recipient', 0, 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      )
      .run(HANDOFF, PROJECT, ARTIFACT);
    fixture.db
      .prepare(
        `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256,
          imported_from_path, materialized, created_at) VALUES (?, ?, ?, 'doc.md', 'doc.md', 'text/markdown', 6, ?, NULL, 0, '2026-05-01T00:00:00.000Z')`,
      )
      .run(ARTIFACT, HANDOFF, KEY, SHA);
    fixture.db.exec("COMMIT");
    mkdirSync(join(fixture.vaultPath, "staging"), { recursive: true });
    writeFileSync(join(fixture.vaultPath, "staging", "staged-doc"), "doc by");
    return { ...fixture, ledger };
  }

  function artifactEvents(db: ReturnType<typeof intentFixture>["db"], type: string) {
    return db
      .prepare("SELECT handoff_id, actor_kind, metadata_json FROM events WHERE event_type = ? ORDER BY id")
      .all(type) as Array<{ handoff_id: string | null; actor_kind: string; metadata_json: string }>;
  }

  it("records an activation without inventing an association or hash when its Artifact row is gone", () => {
    const fixture = intentFixture("sorage-drain-missing-row-");
    try {
      mkdirSync(join(fixture.vaultPath, "artifacts", "h-1", "a-1"), { recursive: true });
      writeFileSync(join(fixture.vaultPath, KEY), "doc by");
      expect(
        fixture.log.record([
          {
            id: "missing-row",
            op: "activate",
            fromPath: "staging/gone",
            toPath: KEY,
            artifactId: ARTIFACT,
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        ]).ok,
      ).toBe(true);
      const log = createSqliteIntentLog({
        db: fixture.db,
        installationId: INSTALLATION,
        events: createSqliteEventLedger(fixture.db),
      });
      expect(log.drain(fixture.vaultPath).ok).toBe(true);
      const events = artifactEvents(fixture.db, "ARTIFACT_ACTIVATED");
      expect(events).toHaveLength(1);
      expect(events[0]?.handoff_id).toBeNull();
      expect(JSON.parse(events[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["revision", "retention"] as const)(
    "keeps %s unlink completion idempotent in both completion orders",
    (kind) => {
      for (const drainFirst of [false, true]) {
        const fixture = intentFixture(`sorage-unlink-${kind}-`);
        try {
          const ledger = createSqliteEventLedger(fixture.db);
          const input = {
            intentId: "unlink-race",
            event: {
              id: "0a111111-3333-4111-8111-1111111111ac",
              eventType: "ARTIFACT_UNLINKED" as const,
              actor: SYSTEM_ACTOR,
              metadata: { storageKey: KEY },
              createdAt: "2026-05-01T00:00:00.000Z",
            },
          };
          expect(
            fixture.log.record([
              {
                id: input.intentId,
                op: "unlink",
                fromPath: null,
                toPath: KEY,
                artifactId: ARTIFACT,
                createdAt: input.event.createdAt,
              },
            ]).ok,
          ).toBe(true);
          const log = createSqliteIntentLog({ db: fixture.db, installationId: INSTALLATION, events: ledger });
          const complete = () =>
            kind === "revision"
              ? createSqliteRevisionStore(fixture.db, ledger).completeUnlinks([input])
              : createSqliteRetentionStore(fixture.db, ledger).completeUnlink(input);
          if (drainFirst) expect(log.drain(fixture.vaultPath).ok).toBe(true);
          const outcome = complete();
          expect(outcome).toMatchObject({ ok: true, value: { completed: drainFirst ? 0 : 1 } });
          expect(log.drain(fixture.vaultPath).ok).toBe(true);
          expect(complete()).toMatchObject({ ok: true, value: { completed: 0 } });
          expect(artifactEvents(fixture.db, "ARTIFACT_UNLINKED")).toHaveLength(1);
        } finally {
          fixture.cleanup();
        }
      }
    },
  );

  it("appends exactly one ARTIFACT_ACTIVATED from authoritative rows when the drain's own DELETE clears the intent", () => {
    const fixture = completionFixture("sorage-drain-activated-");
    try {
      const recorded = fixture.log.record([
        {
          id: "ci-1",
          op: "activate",
          fromPath: "staging/staged-doc",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      expect(recorded.ok).toBe(true);
      const log = createSqliteIntentLog({
        db: fixture.db,
        installationId: INSTALLATION,
        events: fixture.ledger,
      });
      const drained = log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      if (drained.ok) expect(drained.value.resolved).toEqual(["ci-1"]);
      const activated = artifactEvents(fixture.db, "ARTIFACT_ACTIVATED");
      expect(activated).toHaveLength(1);
      expect(activated[0]?.handoff_id).toBe(HANDOFF);
      expect(activated[0]?.actor_kind).toBe("system");
      expect(JSON.parse(activated[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY, sha256: SHA });
      expect(fixture.db.prepare("SELECT materialized FROM artifacts WHERE id = ?").get(ARTIFACT)).toMatchObject({
        materialized: 1,
      });
      // No pathname-derived association ever appears in the metadata.
      expect(JSON.stringify(activated[0]?.metadata_json)).not.toContain(HANDOFF);
    } finally {
      fixture.cleanup();
    }
  });

  it("appends ARTIFACT_UNLINKED with a null association when no authoritative row remains", () => {
    const fixture = completionFixture("sorage-drain-unlinked-");
    try {
      mkdirSync(join(fixture.vaultPath, "artifacts", "h-1", "a-1"), { recursive: true });
      writeFileSync(join(fixture.vaultPath, KEY), "doc by");
      const recorded = fixture.log.record([
        {
          id: "ci-2",
          op: "unlink",
          fromPath: null,
          toPath: KEY,
          artifactId: "gone-artifact",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      expect(recorded.ok).toBe(true);
      const log = createSqliteIntentLog({
        db: fixture.db,
        installationId: INSTALLATION,
        events: fixture.ledger,
      });
      const drained = log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(true);
      const unlinked = artifactEvents(fixture.db, "ARTIFACT_UNLINKED");
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0]?.handoff_id).toBeNull();
      expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toEqual({ storageKey: KEY });
    } finally {
      fixture.cleanup();
    }
  });

  it("appends nothing when a repeated drain finds the intent already cleared", () => {
    const fixture = completionFixture("sorage-drain-repeat-");
    try {
      const log = createSqliteIntentLog({
        db: fixture.db,
        installationId: INSTALLATION,
        events: fixture.ledger,
      });
      fixture.log.record([
        {
          id: "ci-3",
          op: "activate",
          fromPath: "staging/staged-doc",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      expect(log.drain(fixture.vaultPath).ok).toBe(true);
      expect(log.drain(fixture.vaultPath).ok).toBe(true);
      expect(artifactEvents(fixture.db, "ARTIFACT_ACTIVATED")).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps exactly-once across competing ordinary and drain completions in both orders", () => {
    // Order one: the drain wins; the stale ordinary completion appends nothing
    // and counts no winner.
    const drainFirst = completionFixture("sorage-compete-drain-");
    try {
      const log = createSqliteIntentLog({
        db: drainFirst.db,
        installationId: INSTALLATION,
        events: drainFirst.ledger,
      });
      drainFirst.log.record([
        {
          id: "ci-4",
          op: "activate",
          fromPath: "staging/staged-doc",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      expect(log.drain(drainFirst.vaultPath).ok).toBe(true);
      const store = createSqliteHandoffWriteStore(drainFirst.db, drainFirst.ledger);
      const stale = store.completeActivations([
        {
          intentId: "ci-4",
          artifactId: ARTIFACT,
          event: {
            id: "0a111111-3333-4111-8111-1111111111ac",
            handoffId: HANDOFF,
            eventType: "ARTIFACT_ACTIVATED",
            actor: SYSTEM_ACTOR,
            createdAt: "2026-05-02T00:00:00.000Z",
            metadata: { storageKey: KEY },
          },
        },
      ]);
      expect(stale.ok && stale.value.completed).toBe(0);
      expect(artifactEvents(drainFirst.db, "ARTIFACT_ACTIVATED")).toHaveLength(1);
    } finally {
      drainFirst.cleanup();
    }

    // Order two: capture the drain's pending read, then let a second SQLite
    // connection perform and complete the ordinary operation before it resumes.
    const ordinaryFirst = completionFixture("sorage-compete-ordinary-");
    const competing = openSorageDatabase(ordinaryFirst.databasePath);
    try {
      ordinaryFirst.log.record([
        {
          id: "ci-5",
          op: "activate",
          fromPath: "staging/staged-doc",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      const store = createSqliteHandoffWriteStore(competing, createSqliteEventLedger(competing));
      let interleaved = false;
      const win = () => {
        const pending = ordinaryFirst.log.pending();
        if (!pending.ok || pending.value[0] === undefined) throw new Error("The ordinary intent must remain pending");
        expect(executeIntent(pending.value[0], ordinaryFirst.vaultPath)).toBe("done");
        const won = store.completeActivations([
          {
            intentId: "ci-5",
            artifactId: ARTIFACT,
            event: {
              id: "0a111111-4444-4111-8111-1111111111ad",
              handoffId: HANDOFF,
              eventType: "ARTIFACT_ACTIVATED",
              actor: SYSTEM_ACTOR,
              createdAt: "2026-05-02T00:00:00.000Z",
              metadata: { storageKey: KEY },
            },
          },
        ]);
        expect(won.ok && won.value.completed).toBe(1);
      };
      const staleRead = new Proxy(ordinaryFirst.db, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (sql !== "SELECT * FROM pending_fs_ops ORDER BY created_at, id") return statement;
              return new Proxy(statement, {
                get(selected, key) {
                  if (key === "all")
                    return (...args: Parameters<typeof selected.all>) => {
                      const rows = selected.all(...args);
                      if (!interleaved) {
                        interleaved = true;
                        win();
                      }
                      return rows;
                    };
                  const value = Reflect.get(selected, key);
                  return typeof value === "function" ? value.bind(selected) : value;
                },
              });
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const log = createSqliteIntentLog({
        db: staleRead,
        installationId: INSTALLATION,
        events: ordinaryFirst.ledger,
      });
      expect(log.drain(ordinaryFirst.vaultPath)).toMatchObject({ ok: true, value: { resolved: [] } });
      expect(interleaved).toBe(true);
      expect(artifactEvents(ordinaryFirst.db, "ARTIFACT_ACTIVATED")).toHaveLength(1);
      expect(readFileSync(join(ordinaryFirst.vaultPath, KEY), "utf8")).toBe("doc by");
    } finally {
      competing.close();
      ordinaryFirst.cleanup();
    }
  });

  it("rolls the whole completion transaction back when the ledger append fails", () => {
    const fixture = completionFixture("sorage-drain-rollback-");
    try {
      fixture.log.record([
        {
          id: "ci-6",
          op: "activate",
          fromPath: "staging/staged-doc",
          toPath: KEY,
          artifactId: ARTIFACT,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      const throwingLedger = createSqliteEventLedger(fixture.db);
      (throwingLedger as unknown as { appendNow: () => void }).appendNow = () => {
        throw new Error("injected append failure");
      };
      const log = createSqliteIntentLog({
        db: fixture.db,
        installationId: INSTALLATION,
        events: throwingLedger,
      });
      const drained = log.drain(fixture.vaultPath);
      expect(drained.ok).toBe(false);
      if (!drained.ok) expect(drained.error.code).toBe("INTERNAL_ERROR");
      // The rollback leaves the intent row, its attempts, the materialized
      // flag, and the event ledger exactly as they were.
      const pending = fixture.db.prepare("SELECT attempts FROM pending_fs_ops WHERE id = ?").get("ci-6") as
        | { attempts: number }
        | undefined;
      expect(pending?.attempts).toBe(0);
      expect(fixture.db.prepare("SELECT materialized FROM artifacts WHERE id = ?").get(ARTIFACT)).toMatchObject({
        materialized: 0,
      });
      expect(artifactEvents(fixture.db, "ARTIFACT_ACTIVATED")).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });
});
