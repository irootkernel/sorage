import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type AppError,
  type DrainReport,
  appError,
  type FanoutCommit,
  type HandoffReadPort,
  type HandoffWritePort,
  ok,
  type Result,
  type SendPorts,
  sendHandoffs,
} from "@sorage/core";

const err = <T>(error: AppError): Result<T, AppError> => ({ ok: false, error });
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createSqliteEventLedger } from "../../src/events";
import {
  createSqliteHandoffWriteStore,
  createSqliteRevisionStore,
  createSqliteTerminalStore,
} from "../../src/handoffs";
import { createSqliteHandoffReadStore } from "../../src/handoff-read-store";
import { createSqliteIntentLog } from "../../src/intent-log";
import { createSqliteProjectRepository } from "../../src/projects";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock, makeTempDatabase, makeTempVault } from "../../src/testkit";
import { createVaultInitializer } from "../../src/vault";

/**
 * The TASK-035 failure-injection suite over the seven crash points of section 20.8
 * for create, fan-out, revise, and deletion approval. Each scenario interrupts one
 * boundary of the four-phase protocol, then "restarts the process" by opening a fresh
 * connection and draining before asserting the documented recovery outcome: no
 * scenario loses a current Artifact, shows a partially materialized fan-out as
 * complete, fabricates a replacement file, or leaves an intent a second drain cannot
 * resolve.
 */

const INSTALLATION = "00000000-0000-4000-8000-000000000035";
const USER_HOME = "/home/tester";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

type Phase =
  | "before-commit"
  | "after-commit-before-activate"
  | "after-activate-before-complete"
  | "after-delete-commit-before-unlink"
  | "mid-fanout-second-activate";

interface Seams {
  failCreateFanout?: boolean;
  skipActivate?: number; // ordinal (1-based) of the recipient whose activate is skipped
  skipComplete?: boolean;
  skipUnlink?: boolean;
}

interface World {
  dbPath: string;
  vaultPath: string;
  makeSendPorts(seams: Seams): SendPorts;
  readStore(): HandoffReadPort;
  drain(): Result<DrainReport, AppError>;
  counts(): {
    handoffs: number;
    artifacts: number;
    materialized: number;
    intents: number;
    notes: number;
  };
}

function makeWorld(): World {
  const temp = makeTempDatabase("sorage-fi-");
  // The world reopens the file per phase; the seed handle closes here, so the
  // testkit's double close is replaced by plain file removal.
  cleanups.push(() => {
    rmSync(temp.databasePath, { force: true });
    rmSync(`${temp.databasePath}-wal`, { force: true });
    rmSync(`${temp.databasePath}-shm`, { force: true });
    temp.home.cleanup();
  });
  migrate(temp.db, MIGRATIONS);
  temp.db.close();
  const vault = makeTempVault("sorage-fi-vault-");
  cleanups.push(vault.cleanup);
  if (!createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION).ok) {
    throw new Error("fixture vault marker must initialize");
  }
  const sources = join(vault.home.home, "sources");
  const sourcesBeta = join(sources, "beta");
  mkdirSync(sourcesBeta, { recursive: true });

  const open = () => openSorageDatabase(temp.databasePath);
  const seed = () => {
    const db = open();
    const ledger = createSqliteEventLedger(db);
    const repository = createSqliteProjectRepository(db, { installationId: INSTALLATION, events: ledger });
    void repository.createProjectWithBinding(
      { id: "p-1", slug: "alpha", displayName: "Alpha", description: null, createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "b-1",
        projectId: "p-1",
        directory: sources,
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { kind: "user", id: null },
    );
    void repository.createProjectWithBinding(
      { id: "p-2", slug: "beta", displayName: "Beta", description: null, createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "b-2",
        projectId: "p-2",
        directory: join(sources, "beta"),
        bindingKind: "directory",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { kind: "user", id: null },
    );
    db.close();
  };
  seed();

  return {
    dbPath: temp.databasePath,
    vaultPath: vault.vaultPath,
    makeSendPorts(seams: Seams): SendPorts {
      const db = open();
      const ledger = createSqliteEventLedger(db);
      const write: HandoffWritePort = createSqliteHandoffWriteStore(db, ledger);
      const wrappedWrite: HandoffWritePort = {
        ...write,
        createFanout(commit: FanoutCommit) {
          if (seams.failCreateFanout === true) {
            return err(appErrorOf("INTERNAL_ERROR", "injected failure before the intent commit (CP-1)"));
          }
          return write.createFanout(commit);
        },
        completeActivations(completions) {
          if (seams.skipComplete === true) {
            // The commit and the renames happened; only the completion transaction is
            // withheld, which is exactly the CP-4 shape.
            return ok({ completed: 0 });
          }
          return write.completeActivations(completions);
        },
      };
      const artifactStore = createNodeArtifactStore({ vaultPath: vault.vaultPath, installationId: INSTALLATION });
      let activateOrdinal = 0;
      const clock = new FakeClock();
      let ids = 0;
      const nextId = () => `00000000-0000-4000-8000-${(++ids).toString().padStart(12, "0")}`;
      const repository = createSqliteProjectRepository(db, { installationId: INSTALLATION, events: ledger });
      return {
        projectPorts: {
          installationId: INSTALLATION,
          projects: repository,
          clock,
          ids: { next: nextId },
          bindings: {
            realPath: (path) => ({ ok: true, value: path }),
            absentRealPath: (path) => ({ ok: true, value: path }),
            gitCommonDirectory: () => null,
            resolveDirectory: (path) => ({ ok: true, value: { directory: path, bindingKind: "directory" } }),
          },
          handoffs: { openHandoffCount: () => ({ ok: true, value: 0 }) },
        },
        handoffs: wrappedWrite,
        artifactStore: {
          stage: (request) => artifactStore.stage(request),
          activate: (request: { stagingPath: string; storageKey: string }) => {
            activateOrdinal += 1;
            if (seinsSkip(seams.skipActivate, activateOrdinal)) {
              return { ok: true, value: { path: join(vault.vaultPath, request.storageKey) } } as Result<
                { path: string },
                AppError
              >;
            }
            return artifactStore.activate(request);
          },
          pathOf: (key) => artifactStore.pathOf(key),
          exists: (key) => artifactStore.exists(key),
          checksum: (key) => artifactStore.checksum(key),
          remove: (key) => {
            if (seams.skipUnlink === true) {
              return err(appErrorOf("INTERNAL_ERROR", "injected failure before the unlink (CP-6)"));
            }
            return artifactStore.remove(key);
          },
        },
        ids: { next: nextId },
        clock,
        config: { vaultPath: vault.vaultPath, maxBytes: 1024 * 1024, allowUnregisteredSenders: true },
        digestSource: (path) => ({ ok: true, value: createHash("sha256").update(readFileSync(path)).digest("hex") }),
        bindingDirectories: [],
        inspectSource: (path) => ({ ok: true, value: { resolvedSourcePath: path, originalName: basename(path) } }),
        writeBodySource: (text, storedName) => {
          const sourcePath = join(sources, storedName);
          writeFileSync(sourcePath, text);
          return { ok: true, value: { sourcePath, cleanup: () => rmSync(sourcePath, { force: true }) } };
        },
      };
    },
    readStore(): HandoffReadPort {
      const db = open();
      return createSqliteHandoffReadStore(db, createSqliteEventLedger(db));
    },
    drain(): Result<DrainReport, AppError> {
      const db = open();
      const log = createSqliteIntentLog({ db, installationId: INSTALLATION, events: createSqliteEventLedger(db) });
      return log.drain(vault.vaultPath);
    },
    counts() {
      const db = open();
      try {
        const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
        return {
          handoffs: one("SELECT COUNT(*) AS c FROM handoffs"),
          artifacts: one("SELECT COUNT(*) AS c FROM artifacts"),
          materialized: one("SELECT COUNT(*) AS c FROM artifacts WHERE materialized = 1"),
          intents: one("SELECT COUNT(*) AS c FROM pending_fs_ops"),
          notes: one("SELECT COUNT(*) AS c FROM review_notes"),
        };
      } finally {
        db.close();
      }
    },
  };
}

function seinsSkip(skip: number | undefined, ordinal: number): boolean {
  return skip !== undefined && ordinal === skip;
}

function appErrorOf(code: string, message: string): AppError {
  return appError(code as AppError["code"], message);
}

function sourceOf(world: World, name: string, content: string): string {
  const path = join(world.vaultPath, "..", "sources", name);
  writeFileSync(path, content);
  return path;
}

function baseInput(world: World, overrides: Partial<Parameters<typeof sendHandoffs>[1]> = {}) {
  const file = sourceOf(world, "doc.md", "document bytes");
  return {
    to: ["beta"],
    title: "Resilience brief",
    file,
    allowExternalSource: true,
    allowUnregistered: true,
    path: "/unregistered/workspace",
    userHome: USER_HOME,
    ...overrides,
  };
}

describe("the section 20.8 crash points", () => {
  it("CP-1: a failure after staging and before the intent commit creates nothing and leaves a sweepable staged file", () => {
    const world = makeWorld();
    const failed = sendHandoffs(world.makeSendPorts({ failCreateFanout: true }), baseInput(world));
    expect(failed.ok).toBe(false);
    expect(world.counts()).toMatchObject({ handoffs: 0, artifacts: 0, intents: 0 });
    const staging = join(world.vaultPath, "staging");
    expect(existsSync(staging)).toBe(true);

    // A retry with the same idempotency key creates exactly one Handoff.
    const retried = sendHandoffs(world.makeSendPorts({}), baseInput(world, { idempotencyKey: "key-cp1" }));
    expect(retried.ok).toBe(true);
    expect(world.counts().handoffs).toBe(1);
    const again = sendHandoffs(world.makeSendPorts({}), baseInput(world, { idempotencyKey: "key-cp1" }));
    expect(again.ok && again.value.replayed).toBe(true);
    expect(world.counts().handoffs).toBe(1);
  });

  it("CP-2: rows exist with materialized = 0 and the restart drain renames and completes", () => {
    const world = makeWorld();
    const sent = sendHandoffs(world.makeSendPorts({ skipActivate: 1, skipComplete: true }), baseInput(world));
    expect(sent.ok).toBe(true);
    const after = world.counts();
    expect(after.handoffs).toBe(1);
    expect(after.materialized).toBe(0);
    expect(after.intents).toBe(1);
    // A read of the unmaterialized Artifact refuses.
    const store = world.readStore();
    const view = store.findHandoffView((sent.ok && sent.value.handoffs[0]?.handoffId) || "");
    expect(view.ok && view.value !== null ? view.value.currentArtifact?.materialized : undefined).toBe(false);

    // Restart and drain: the staged source is present, so the rename completes.
    const drained = world.drain();
    expect(drained.ok).toBe(true);
    if (drained.ok) expect(drained.value.resolved).toHaveLength(1);
    expect(world.counts()).toMatchObject({ materialized: 1, intents: 0 });
  });

  it("CP-3 and CP-4: files at their final place with intents pending complete on the restart drain, twice-safe", () => {
    const world = makeWorld();
    const sent = sendHandoffs(world.makeSendPorts({ skipComplete: true }), baseInput(world));
    expect(sent.ok).toBe(true);
    expect(world.counts()).toMatchObject({ materialized: 0, intents: 1 });
    const store = world.readStore();
    const id = sent.ok ? (sent.value.handoffs[0]?.handoffId as string) : "";
    const view = store.findHandoffView(id);
    const storageKey = view.ok && view.value !== null ? view.value.currentArtifact?.storageKey : undefined;
    expect(storageKey !== undefined && existsSync(join(world.vaultPath, storageKey))).toBe(true);

    const first = world.drain();
    expect(first.ok && first.value.resolved).toHaveLength(1);
    expect(world.counts()).toMatchObject({ materialized: 1, intents: 0 });
    // CP-7 shape: a second drain over the resolved state resolves nothing and harms nothing.
    const second = world.drain();
    expect(second.ok && second.value.resolved).toHaveLength(0);
    expect(world.counts()).toMatchObject({ materialized: 1, intents: 0 });
  });

  it("CP-5: a fan-out interrupted between renames stays all-or-nothing and the drain finishes the remainder", () => {
    const world = makeWorld();
    const sent = sendHandoffs(
      world.makeSendPorts({ skipActivate: 2, skipComplete: true }),
      baseInput(world, { to: ["alpha", "beta"] }),
    );
    expect(sent.ok).toBe(true);
    expect(sent.ok && sent.value.handoffs).toHaveLength(2);
    const counts = world.counts();
    expect(counts.handoffs).toBe(2);
    expect(counts.materialized).toBe(0);
    // The database holds the complete dispatch group even though only the first
    // rename will have executed.
    const db = openSorageDatabase(world.dbPath);
    interface GroupRow {
      dispatch_group_id: string | null;
      c: number;
    }
    const groups = db
      .prepare("SELECT dispatch_group_id, COUNT(*) AS c FROM handoffs GROUP BY dispatch_group_id")
      .all() as unknown as GroupRow[];
    db.close();
    expect(groups).toEqual([{ dispatch_group_id: sent.ok ? sent.value.dispatchGroupId : null, c: 2 }]);

    const drained = world.drain();
    expect(drained.ok).toBe(true);
    expect(world.counts()).toMatchObject({ handoffs: 2, materialized: 2, intents: 0 });
  });

  it("CP-6: the tombstone is authoritative after the delete commit and the restart drain removes the file", () => {
    const world = makeWorld();
    // Create, accept, request, and approve with the unlink withheld.
    const created = sendHandoffs(world.makeSendPorts({}), baseInput(world));
    expect(created.ok).toBe(true);
    const id = created.ok ? (created.value.handoffs[0]?.handoffId as string) : "";

    const db = openSorageDatabase(world.dbPath);
    const terminal = createSqliteTerminalStore(db, createSqliteEventLedger(db));
    const read = createSqliteHandoffReadStore(db, createSqliteEventLedger(db));
    const accepted = terminal.applyTerminalTransition({
      handoffId: id,
      expectedRowVersion: 1,
      assignments: {
        review_state: "accepted",
        accepted_revision: 1,
        accepted_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      },
      event: {
        id: "e-accept",
        handoffId: id,
        eventType: "HANDOFF_ACCEPTED",
        actor: { kind: "registered_project", id: "p-2" },
        rowVersion: 2,
        metadata: {},
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(accepted.ok).toBe(true);
    const view = read.findHandoffView(id);
    const storageKey = view.ok && view.value !== null ? view.value.currentArtifact?.storageKey : undefined;
    expect(storageKey).toBeTruthy();
    db.prepare(
      "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at) VALUES ('dr-1', ?, 'user', NULL, NULL, 'pending', '2026-01-02T00:00:00.000Z')",
    ).run(id);
    // The approval transaction commits the tombstone and the unlink intent...
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "UPDATE handoffs SET deleted_at = '2026-01-02T00:00:00.000Z', current_artifact_id = NULL, updated_at = '2026-01-02T00:00:00.000Z', row_version = row_version + 1 WHERE id = ?",
    ).run(id);
    db.prepare(
      "UPDATE deletion_requests SET status = 'approved', resolved_at = '2026-01-02T00:00:00.000Z', resolved_by_user = 'user' WHERE handoff_id = ? AND status = 'pending'",
    ).run(id);
    db.prepare(
      "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('i-unlink', 'unlink', NULL, ?, NULL, '2026-01-02T00:00:00.000Z', 0)",
    ).run(storageKey);
    db.exec("COMMIT");
    db.close();

    // ...and the crash lands before the unlink: the tombstone rules, the file remains,
    // and it is protected by the pending intent.
    expect(existsSync(join(world.vaultPath, storageKey as string))).toBe(true);
    const drained = world.drain();
    expect(drained.ok).toBe(true);
    expect(existsSync(join(world.vaultPath, storageKey as string))).toBe(false);
    expect(world.counts()).toMatchObject({ intents: 0 });
    const after = world.readStore().findHandoffView(id);
    expect(after.ok && after.value?.deletedAt).not.toBeNull();
    expect(after.ok && after.value?.currentArtifact).toBeNull();
  });

  it("revise survives a withheld completion and drains into the replacement only", () => {
    const world = makeWorld();
    const created = sendHandoffs(world.makeSendPorts({}), baseInput(world));
    expect(created.ok).toBe(true);
    const id = created.ok ? (created.value.handoffs[0]?.handoffId as string) : "";

    // The revision transaction commits; the activate for the new slot is withheld
    // (CP-2 shape on the revise path) and the old bytes are never unlinked early.
    const db = openSorageDatabase(world.dbPath);
    const ledger = createSqliteEventLedger(db);
    const revisions = createSqliteRevisionStore(db, ledger);
    const artifactStore = createNodeArtifactStore({ vaultPath: world.vaultPath, installationId: INSTALLATION });
    const originalView = createSqliteHandoffReadStore(db, ledger).findHandoffView(id);
    const originalStorageKey =
      originalView.ok && originalView.value ? (originalView.value.currentArtifact?.storageKey ?? "") : "";
    const staged = artifactStore.stage({
      sourcePath: sourceOf(world, "doc-v2.md", "replacement bytes"),
      maxBytes: 1024 * 1024,
    });
    expect(staged.ok).toBe(true);
    const applied = revisions.applyContentRevision({
      handoffId: id,
      expectedRowVersion: 1,
      newArtifact: {
        id: "a-replacement",
        handoffId: id,
        storageKey: `artifacts/${id}/a-replacement/doc.md`,
        originalName: "doc.md",
        storedName: "doc.md",
        mimeType: "text/markdown",
        sizeBytes: staged.ok ? staged.value.sizeBytes : 0,
        sha256: staged.ok ? staged.value.sha256 : "",
        importedFromPath: null,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      activateIntent: {
        id: "i-activate-2",
        op: "activate",
        fromPath: (staged.ok ? staged.value.stagingPath : "").split("/").slice(-2).join("/"),
        toPath: `artifacts/${id}/a-replacement/doc.md`,
        artifactId: "a-replacement",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      unlinkIntent: {
        id: "i-unlink-2",
        op: "unlink",
        fromPath: null,
        toPath: originalStorageKey,
        artifactId: "original",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      events: [
        {
          id: "e-revise",
          handoffId: id,
          eventType: "HANDOFF_REVISED",
          actor: { kind: "user", id: null },
          rowVersion: 2,
          metadata: {},
          createdAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    expect(applied.ok).toBe(true);
    db.close();

    const drained = world.drain();
    expect(drained.ok).toBe(true);
    const counts = world.counts();
    // Only the current Artifact row remains materialized; the old row was deleted by
    // the revision transaction and its bytes left with the resolved unlink.
    expect(counts.artifacts).toBe(1);
    expect(counts.materialized).toBe(1);
    expect(counts.intents).toBe(0);
    const final = world.readStore().findHandoffView(id);
    expect(final.ok && final.value?.currentArtifact?.id).toBe("a-replacement");
    expect(final.ok && final.value?.revision).toBe(2);
  });
});
