import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AppError,
  backupRestore,
  backupVerify,
  type BackupVerifyReport,
  exportSnapshot,
  initializeInstallation,
  parseSendRecoveryOutcome,
  type Result,
  redactSnapshotData,
  snapshotFiles,
  snapshotFilesV2,
} from "@sorage/core";
import { createNodeBackupCommandPorts, nodeEnsureVaultGit } from "../../src/backup-command-ports";
import {
  LEGACY_BODY_V2,
  LEGACY_EVENT_BASE,
  LEGACY_HANDOFF,
  LEGACY_RECEIPT_JSON,
  LEGACY_RECEIPT_KEY,
  legacyRequestHash,
  legacyReviseInstallation,
} from "../fixtures/legacy-revise-installation";
import { createNodeInitPorts } from "../../src/init-ports";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteIntentLog } from "../../src/intent-log";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * ADR-0031's qualification slice (TASK-106, R2.4.3): the frozen schema-7
 * legacy revision — a genuine `a`-plus-eight-hex current Artifact identifier —
 * survives the real migration-8 upgrade byte-exactly, exports and verifies as
 * a normal format-3 snapshot through the direct adapter ports with its
 * operational rows untouched, dry-runs and restores into a fresh target with
 * exact domain identity and body bytes while operational rows stay excluded,
 * and its one genuine leftover intent completes under the normal drain with
 * exactly one success event from authoritative associations only.
 */

function unwrap<T>(result: Result<T, AppError>, label: string): T {
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function freshTarget(): string {
  const home = mkdtempSync(join(tmpdir(), "sorage-legacy-revise-target-"));
  unwrap(
    initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: homedir(), clock: new FakeClock() }),
      { vaultPath: join(home, "vault") },
    ),
    "target initialization",
  );
  return home;
}

describe("the frozen legacy revision through migration 8", () => {
  it.each([1, 2] as const)("restores legacy Artifact IDs through the frozen format-%i reader", (version) => {
    const source = legacyReviseInstallation();
    const targetHome = freshTarget();
    try {
      source.upgradeToCurrent();
      const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: source.home }, userHome: source.home });
      const exporting = unwrap(ports.exportPorts(), "legacy export ports");
      const data = redactSnapshotData(unwrap(exporting.readSnapshotData(), "legacy source rows"));
      const files =
        version === 1
          ? snapshotFiles({ ...data, events: data.events.map(({ memoId: _memoId, ...event }) => event) })
          : unwrap(snapshotFilesV2(data), "format-2 serialization").files;
      unwrap(exporting.writeSnapshotTree(files), "legacy snapshot write");
      const manifestPath = join(source.vault, "snapshots", "manifest.json");
      const before = readFileSync(manifestPath);
      expect(JSON.parse(before.toString()).formatVersion).toBe(version);
      const restoring = unwrap(
        createNodeBackupCommandPorts({
          env: { SORAGE_HOME: targetHome },
          userHome: targetHome,
          sourcePath: source.vault,
        }).restorePorts(),
        "legacy restore ports",
      );
      unwrap(backupRestore(restoring, { dryRun: true }), "legacy dry-run");
      unwrap(backupRestore(restoring, { dryRun: false }), "legacy restore");
      const db = openSorageDatabase(join(targetHome, "state", "sorage.sqlite3"));
      try {
        expect(db.prepare("SELECT current_artifact_id FROM handoffs WHERE id = ?").get(LEGACY_HANDOFF)).toEqual({
          current_artifact_id: source.currentArtifactId,
        });
        expect(db.prepare("SELECT id, storage_key FROM artifacts").get()).toEqual({
          id: source.currentArtifactId,
          storage_key: source.currentStorageKey,
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
      expect(readFileSync(join(targetHome, "vault", source.currentStorageKey))).toEqual(Buffer.from(LEGACY_BODY_V2));
      expect(readFileSync(manifestPath)).toEqual(before);
    } finally {
      source.cleanup();
      rmSync(targetHome, { recursive: true, force: true });
    }
  });

  it("preserves domain rows, the receipt string, pending legacy columns, and file bytes across the upgrade", () => {
    const fixture = legacyReviseInstallation();
    try {
      const domainBefore = fixture.domainSnapshot();
      const operationalBefore = fixture.operationalSnapshot();
      const bytesBefore = readFileSync(join(fixture.vault, fixture.currentStorageKey));
      const modeBefore = statSync(join(fixture.vault, fixture.currentStorageKey)).mode & 0o777;

      fixture.upgradeToCurrent();

      expect(fixture.domainSnapshot()).toBe(domainBefore);
      // The legacy columns are unchanged and the new owner columns are null.
      const db = openSorageDatabase(fixture.database);
      try {
        const pending = db
          .prepare(
            "SELECT id, op, from_path, to_path, artifact_id, created_at, attempts, owner_domain, owner_id, content_id FROM pending_fs_ops",
          )
          .all() as Array<Record<string, unknown>>;
        expect(pending).toHaveLength(1);
        expect(pending[0]?.owner_domain).toBeNull();
        expect(pending[0]?.owner_id).toBeNull();
        expect(pending[0]?.content_id).toBeNull();
      } finally {
        db.close();
      }
      expect(fixture.operationalSnapshot()).toBe(operationalBefore);
      expect(readFileSync(join(fixture.vault, fixture.currentStorageKey))).toEqual(bytesBefore);
      expect(statSync(join(fixture.vault, fixture.currentStorageKey)).mode & 0o777).toBe(modeBefore);
      expect(existsSync(join(fixture.vault, fixture.oldStorageKey))).toBe(false);
      // The initialized installation singleton is retained across the upgrade
      // with the exact identity the configuration and marker carry.
      const singleton = openSorageDatabase(fixture.database);
      try {
        expect(singleton.prepare("SELECT * FROM installation WHERE id = 1").get()).toMatchObject({
          installation_id: fixture.installationId,
          schema_version: 1,
          created_at: "2026-10-01T00:00:00.000Z",
        });
      } finally {
        singleton.close();
      }
      // The retained receipt is a genuine original send outcome: the read-only
      // recovery codec parses it, and the stored request hash is the real
      // derivation for the original file content, title, and recipient.
      const receiptDb = openSorageDatabase(fixture.database);
      try {
        const receipt = receiptDb
          .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?")
          .get(LEGACY_RECEIPT_KEY) as { request_hash: string; response_json: string };
        expect(receipt.request_hash).toBe(legacyRequestHash());
        const parsed = unwrap(parseSendRecoveryOutcome(receipt.response_json), "legacy receipt parse");
        expect(parsed.handoffs).toHaveLength(1);
        expect(parsed.handoffs[0]).toMatchObject({
          handoffId: LEGACY_HANDOFF,
          recipientSlug: "legacy-recipient",
          reviewState: "awaiting_recipient",
        });
      } finally {
        receiptDb.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("exports and verifies as format 3 through the direct ports while the source's operational rows stay untouched", () => {
    const fixture = legacyReviseInstallation();
    try {
      fixture.upgradeToCurrent();
      const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: fixture.home }, userHome: homedir() });
      const operationalBefore = fixture.operationalSnapshot();

      const exportPorts = unwrap(ports.exportPorts(), "export ports");
      unwrap(exportSnapshot(exportPorts), "export");

      // The exported snapshot carries the legacy identity unchanged.
      const shard = JSON.parse(
        readFileSync(
          join(fixture.vault, "snapshots", `handoffs/${LEGACY_HANDOFF.slice(0, 2)}/${LEGACY_HANDOFF}.json`),
          "utf8",
        ),
      ) as { currentArtifactId: string; artifact: { id: string; storageKey: string; inlineBody: null } };
      expect(shard.currentArtifactId).toBe(fixture.currentArtifactId);
      expect(shard.artifact.id).toBe(fixture.currentArtifactId);
      expect(shard.artifact.storageKey).toBe(fixture.currentStorageKey);
      expect(shard.artifact.inlineBody).toBeNull();
      const manifest = JSON.parse(readFileSync(join(fixture.vault, "snapshots", "manifest.json"), "utf8")) as {
        formatVersion: number;
        counts: { artifacts: number; channels: number; memos: number };
        contentDigests: Record<string, string>;
      };
      expect(manifest.formatVersion).toBe(3);
      expect(manifest.counts.artifacts).toBe(1);
      expect(manifest.counts.channels).toBe(0);
      expect(manifest.contentDigests).toEqual({});

      // A clean verify over a committed repository.
      unwrap(
        nodeEnsureVaultGit(fixture.vault, fixture.installationId, new FakeClock(), "main"),
        "vault git initialization",
      );
      git(
        fixture.vault,
        "add",
        "--",
        ".sorage-vault.json",
        ".gitattributes",
        ".gitignore",
        "artifacts",
        "content",
        "snapshots",
      );
      git(fixture.vault, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "legacy fixture backup");
      const verified: BackupVerifyReport = unwrap(
        backupVerify(unwrap(ports.verifyPorts(), "verify ports"), { now: new Date() }),
        "backup verify",
      );
      expect(verified.findings).toEqual([]);

      // Export and verify are read-only over the operational rows.
      expect(fixture.operationalSnapshot()).toBe(operationalBefore);
    } finally {
      fixture.cleanup();
    }
  });

  it("dry-runs and restores exact domain identity, pointer, key, body bytes, and associations while excluding operational rows", () => {
    const source = legacyReviseInstallation();
    const targetHome = freshTarget();
    try {
      source.upgradeToCurrent();
      const sourcePorts = createNodeBackupCommandPorts({
        env: { SORAGE_HOME: source.home },
        userHome: homedir(),
      });
      unwrap(exportSnapshot(unwrap(sourcePorts.exportPorts(), "source export ports")), "source export");

      const targetPorts = createNodeBackupCommandPorts({
        env: { SORAGE_HOME: targetHome },
        userHome: homedir(),
        sourcePath: source.vault,
      });
      const restorePorts = unwrap(targetPorts.restorePorts(), "restore ports");
      const plan = unwrap(backupRestore(restorePorts, { dryRun: true }), "restore dry-run");
      expect(plan).toMatchObject({ dryRun: true, wouldCreate: { artifacts: 1, handoffs: 1 } });
      const outcome = unwrap(backupRestore(restorePorts, { dryRun: false }), "restore");
      expect(outcome.dryRun).toBe(false);

      const db = openSorageDatabase(join(targetHome, "state", "sorage.sqlite3"));
      try {
        const handoff = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(LEGACY_HANDOFF) as Record<
          string,
          unknown
        >;
        expect(handoff.current_artifact_id).toBe(source.currentArtifactId);
        expect(handoff.revision).toBe(2);
        expect(handoff.row_version).toBe(5);
        expect(handoff.review_state).toBe("awaiting_recipient");
        expect(handoff.review_engaged_at).toBe("2026-10-01T01:00:00.000Z");
        const artifact = db.prepare("SELECT * FROM artifacts").get() as Record<string, unknown>;
        expect(artifact.id).toBe(source.currentArtifactId);
        expect(artifact.storage_key).toBe(source.currentStorageKey);
        expect(artifact.sha256).toBe(createHash("sha256").update(Buffer.from(LEGACY_BODY_V2, "utf8")).digest("hex"));
        expect(artifact.materialized).toBe(1);
        const deletion = db.prepare("SELECT * FROM deletion_requests").get() as Record<string, unknown>;
        expect(deletion.handoff_id).toBe(LEGACY_HANDOFF);
        expect(deletion.status).toBe("rejected");
        const events = db
          .prepare("SELECT id FROM events WHERE handoff_id = ? ORDER BY id")
          .all(LEGACY_HANDOFF) as Array<{ id: string }>;
        expect(events.map((event) => event.id)).toEqual([
          `${LEGACY_EVENT_BASE}e1`,
          `${LEGACY_EVENT_BASE}e2`,
          `${LEGACY_EVENT_BASE}e3`,
          `${LEGACY_EVENT_BASE}e4`,
          `${LEGACY_EVENT_BASE}e5`,
          `${LEGACY_EVENT_BASE}e6`,
        ]);
        // Operational rows are excluded from restore by contract.
        expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toMatchObject({ n: 0 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get()).toMatchObject({ n: 0 });
      } finally {
        db.close();
      }
      expect(readFileSync(join(targetHome, "vault", source.currentStorageKey)).toString("utf8")).toBe(LEGACY_BODY_V2);
    } finally {
      source.cleanup();
      rmSync(targetHome, { recursive: true, force: true });
    }
  });

  it("completes the genuine leftover unlink under the normal drain with exactly one authoritative success event", () => {
    const fixture = legacyReviseInstallation();
    try {
      fixture.upgradeToCurrent();
      const db = openSorageDatabase(fixture.database);
      try {
        const log = createSqliteIntentLog({
          db,
          installationId: fixture.installationId,
          events: createSqliteEventLedger(db),
        });
        const drained = unwrap(log.drain(fixture.vault), "drain");
        expect(drained.resolved).toHaveLength(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get()).toMatchObject({ n: 0 });
        const unlinked = db
          .prepare("SELECT handoff_id, actor_kind, metadata_json FROM events WHERE event_type = 'ARTIFACT_UNLINKED'")
          .all() as Array<{ handoff_id: string | null; actor_kind: string; metadata_json: string }>;
        expect(unlinked).toHaveLength(1);
        // The superseded Artifact row is gone, so the association is null and
        // the metadata carries only the persisted intent's own storageKey.
        expect(unlinked[0]?.handoff_id).toBeNull();
        expect(unlinked[0]?.actor_kind).toBe("system");
        expect(JSON.parse(unlinked[0]?.metadata_json ?? "{}")).toEqual({ storageKey: fixture.oldStorageKey });
        expect(
          db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'ARTIFACT_ACTIVATED'").get(),
        ).toMatchObject({ n: 0 });
        // A repeated drain is a no-op: no duplicate success event.
        unwrap(log.drain(fixture.vault), "repeated drain");
        expect(
          (db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'ARTIFACT_UNLINKED'").get() as { n: number })
            .n,
        ).toBe(1);
        // The retained receipt string is untouched by recovery.
        const receipt = db
          .prepare("SELECT response_json FROM idempotency_keys WHERE key = ?")
          .get(LEGACY_RECEIPT_KEY) as { response_json: string };
        expect(receipt.response_json).toBe(LEGACY_RECEIPT_JSON);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
