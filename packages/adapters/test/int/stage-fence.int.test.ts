import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeInstallation, reviseHandoff, sendHandoffs } from "@sorage/core";
import type { SendPorts } from "@sorage/core";
import { createSqliteEventLedger } from "../../src/events";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeRevisionPorts, createNodeSendPorts } from "../../src/handoff-command-ports";
import { createSqliteProjectRepository } from "../../src/projects";
import { openSorageDatabase } from "../../src/sqlite/connection";

/**
 * The late-lock stage fence of M3-P3 (RUN-014, SHR-011): the production send
 * and revision ports are constructed BEFORE a live vault-move.lock appears,
 * and their base ArtifactStore must still observe the late lock — the stage
 * that precedes the SQL transaction pauses with SERVICE_PAUSED, an ordinary
 * send creates no Handoff, Artifact, intent, event, or receipt, and an
 * ordinary revise leaves the existing Handoff exactly unchanged. Releasing
 * the lock restores normal operation. The revision comparison is against the
 * actual pre-attempt snapshot, not an all-tables-zero claim, because the
 * Handoff and its prior Artifact already exist.
 */

const RECIPIENT_ID = "22222222-2222-4222-8222-2222222222b1";
const BINDING_ID = "33333333-3333-4333-8333-3333333333b1";
const MAX_BYTES = 1024 * 1024;

const home = mkdtempSync(join(tmpdir(), "sorage-stage-fence-"));
const vaultPath = join(home, "vault");
const recipientDir = join(home, "recipient-work");
const senderSource = join(home, "source.md");
const replacement = join(home, "replacement.md");
const lockPath = join(home, "run", "vault-move.lock");
const databasePath = join(home, "state", "sorage.sqlite3");

let sendPorts: SendPorts;
let revisionPorts: ReturnType<typeof createNodeRevisionPorts>;
let assertDb: ReturnType<typeof openSorageDatabase>;
const closer: Array<() => void> = [];

function countOf(sql: string): number {
  return (assertDb.prepare(sql).get() as { count: number }).count;
}

function handoffRow(handoffId: string): Record<string, unknown> {
  return assertDb.prepare("SELECT * FROM handoffs WHERE id = ?").get(handoffId) as Record<string, unknown>;
}

function artifactDigests(): string[] {
  return (
    assertDb.prepare("SELECT storage_key FROM content_records WHERE storage_key IS NOT NULL").all() as Array<{
      storage_key: string;
    }>
  )
    .map((row) => row.storage_key)
    .sort()
    .map((key) =>
      createHash("sha256")
        .update(readFileSync(join(vaultPath, key)))
        .digest("hex"),
    );
}

function snapshot(): Record<string, unknown> {
  return {
    handoffs: countOf("SELECT COUNT(*) AS count FROM handoffs"),
    artifacts: countOf("SELECT COUNT(*) AS count FROM artifacts"),
    intents: countOf("SELECT COUNT(*) AS count FROM pending_fs_ops"),
    events: countOf("SELECT COUNT(*) AS count FROM events"),
    receipts: countOf("SELECT COUNT(*) AS count FROM idempotency_keys"),
    bytes: artifactDigests(),
  };
}

function acquireLiveLock(): void {
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(
    lockPath,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() })}\n`,
  );
}

function releaseLock(): void {
  rmSync(lockPath, { force: true });
}

function stagingNames(): string[] {
  const staging = join(vaultPath, "staging");
  return existsSync(staging) ? readdirSync(staging).sort() : [];
}

beforeAll(() => {
  mkdirSync(recipientDir, { recursive: true });
  writeFileSync(senderSource, "# The staged source\n");
  writeFileSync(replacement, "# The replacement source\n");
  const init = initializeInstallation(createNodeInitPorts({ env: { SORAGE_HOME: home } }), { vaultPath });
  expect(init.ok).toBe(true);
  // The production ports are constructed while no lock exists; the test then
  // acquires a live lock and proves these very instances observe it late.
  sendPorts = createNodeSendPorts({ env: { SORAGE_HOME: home } });
  const seedDb = openSorageDatabase(databasePath);
  const repository = createSqliteProjectRepository(seedDb, {
    installationId: init.ok ? init.value.installationId : "x",
    events: createSqliteEventLedger(seedDb),
  });
  const created = repository.createProjectWithBinding(
    {
      id: RECIPIENT_ID,
      slug: "beta",
      displayName: "Beta",
      description: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: BINDING_ID,
      projectId: RECIPIENT_ID,
      bindingKind: "directory",
      directory: recipientDir,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    { kind: "user", id: null },
  );
  seedDb.close();
  expect(created.ok).toBe(true);
  revisionPorts = createNodeRevisionPorts({ env: { SORAGE_HOME: home } });
  assertDb = openSorageDatabase(databasePath);
  closer.push(() => {
    // The owned database closes before the owned home is removed.
    assertDb.close();
    rmSync(home, { recursive: true, force: true });
  });
});

afterAll(() => {
  for (const close of closer.reverse()) close();
});

describe("the production stage fence observes a late vault-move.lock", () => {
  it("pauses stage, send, and revise and leaves the domain exactly unchanged", () => {
    // One healthy send before the lock gives the revise attempt a real,
    // already-settled Handoff to compare against.
    const healthy = sendHandoffs(sendPorts, {
      to: ["beta"],
      title: "Stage fence baseline",
      file: senderSource,
      allowExternalSource: true,
      allowUnregistered: false,
      path: home,
      userHome: home,
      asUser: true,
    });
    expect(healthy.ok).toBe(true);
    if (!healthy.ok) return;
    const handoffId = healthy.value.handoffs[0]?.handoffId ?? "";
    expect(handoffId).not.toBe("");
    const before = snapshot();
    const beforeRow = handoffRow(handoffId);
    const stagingBefore = stagingNames();

    acquireLiveLock();
    try {
      const staged = sendPorts.artifactStore.stage({ sourcePath: senderSource, maxBytes: MAX_BYTES });
      expect(staged.ok).toBe(false);
      if (!staged.ok) expect(staged.error.code).toBe("SERVICE_PAUSED");
      expect(stagingNames()).toEqual(stagingBefore);

      const pausedSend = sendHandoffs(sendPorts, {
        to: ["beta"],
        title: "Must not exist",
        file: senderSource,
        allowExternalSource: true,
        allowUnregistered: false,
        path: home,
        userHome: home,
        asUser: true,
      });
      expect(pausedSend.ok).toBe(false);
      if (!pausedSend.ok) expect(pausedSend.error.code).toBe("SERVICE_PAUSED");
      expect(snapshot()).toEqual(before);
      expect(handoffRow(handoffId)).toEqual(beforeRow);
      expect(stagingNames()).toEqual(stagingBefore);

      const pausedRevise = reviseHandoff(revisionPorts, {
        expectedRowVersion: 1,
        as: undefined,
        handoffId,
        file: replacement,
        originalName: "replacement.md",
        allowExternalSource: true,
        path: home,
        userHome: home,
        asUser: true,
      });
      expect(pausedRevise.ok).toBe(false);
      if (!pausedRevise.ok) expect(pausedRevise.error.code).toBe("SERVICE_PAUSED");
      expect(snapshot()).toEqual(before);
      expect(handoffRow(handoffId)).toEqual(beforeRow);
      expect(stagingNames()).toEqual(stagingBefore);
    } finally {
      releaseLock();
    }

    // The released lock restores ordinary operation end to end.
    const resumed = sendHandoffs(sendPorts, {
      to: ["beta"],
      title: "Resumed after the fence",
      file: senderSource,
      allowExternalSource: true,
      allowUnregistered: false,
      path: home,
      userHome: home,
      asUser: true,
    });
    expect(resumed.ok).toBe(true);
    const revised = reviseHandoff(revisionPorts, {
      expectedRowVersion: 1,
      as: undefined,
      handoffId,
      file: replacement,
      originalName: "replacement.md",
      allowExternalSource: true,
      path: home,
      userHome: home,
      asUser: true,
    });
    expect(revised.ok).toBe(true);
    if (revised.ok) expect(revised.value.revision).toBe(2);
  });
});
