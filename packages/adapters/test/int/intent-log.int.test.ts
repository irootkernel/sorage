import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type NewPendingFsOp, type PendingFsOp } from "@sorage/core";
import { collectVaultGarbage, createSqliteIntentLog } from "../../src/intent-log";
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
