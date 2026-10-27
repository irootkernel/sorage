import { createHash } from "node:crypto";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { makeArtifactContentBindings } from "../../src/testkit/artifact-content";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acceptHandoff, approveDeletion, reviseHandoff } from "@sorage/core";
import type { AppError, Result } from "@sorage/core";
import { createArtifactBodyPorts } from "../../src/artifact-body-ports";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteHandoffReadStore } from "../../src/handoff-read-store";
import { createSqliteRetentionStore, createSqliteRevisionStore, createSqliteTerminalStore } from "../../src/handoffs";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempDatabase, makeTempVault } from "../../src/testkit";

/**
 * The mandatory missing-authority gates of the M4 content boundary
 * (SHR-004, SHR-014, VLT-023): a living Handoff whose current Artifact row or
 * whose authoritative content record row was deleted refuses revise, the
 * no-change resolution, accept, and deletion approval with the honest
 * corruption answer — after the earlier replay, state, role, Note, and
 * expected-Row-Version priorities — leaving the domain, Row Version, events,
 * receipts, and body bytes exactly unchanged. Both SQL break modes run as
 * real controls: a missing artifacts row and a missing content_records row.
 */

const INSTALLATION = "00000000-0000-4000-8000-0000000000a1";
const USER = { path: "/w", userHome: "/h", as: undefined, asUser: true };

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

type Break = "artifact-row" | "record-row" | "none";

interface Fixture {
  breakCurrent: (mode: Break) => void;
  snapshot: () => unknown;
  replacement: string;
  count: (sql: string) => number;
  revisions: ReturnType<typeof createSqliteRevisionStore>;
  retention: ReturnType<typeof createSqliteRetentionStore>;
  terminals: ReturnType<typeof createSqliteTerminalStore>;
  verifyArtifactBody: (artifactId: string, policy: { verifyFileDigest: "always" }) => Result<void, AppError>;
  readBase: {
    handoffs: ReturnType<typeof createSqliteHandoffReadStore>;
    config: { vaultPath: string; maxBytes: number; verifyChecksumOnFetch: boolean };
    artifact: ReturnType<typeof createArtifactBodyPorts>;
    ids: { next(): string };
    clock: { now(): Date };
  };
  seed: (options: { reviewState: string; withNote: boolean; pendingDeletion: boolean; fileBacked?: boolean }) => string;
  tamperFileBody: (handoffId: string, bytes: Buffer) => void;
  tamperInline: (handoffId: string, variant: "text" | "sha") => void;
}

function makeFixture(): Fixture {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  const plan = productionMigrationPlan();
  migrate(temp.db, plan.migrations, () => "2026-01-01T00:00:00.000Z", {
    databasePath: temp.databasePath,
    rebuilds: plan.rebuilds,
  });
  const vault = makeTempVault("sorage-missing-authority-");
  cleanups.push(vault.cleanup);
  const stateDir = mkdtempSync(join(tmpdir(), "sorage-missing-state-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  temp.db
    .prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'recipient', 'Recipient', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .run("00000000-0000-4000-8000-0000000000b9");
  const replacement = join(stateDir, "replacement.md");
  writeFileSync(replacement, "# Replacement\n");
  const ledger = createSqliteEventLedger(temp.db);
  const content = makeArtifactContentBindings({
    db: temp.db,
    ledger,
    vaultPath: vault.vaultPath,
    installationId: INSTALLATION,
  });
  const readStore = createSqliteHandoffReadStore(temp.db, ledger, { runDir: null });
  const bodyPorts = createArtifactBodyPorts({
    db: temp.db,
    vaultPath: vault.vaultPath,
    installationId: INSTALLATION,
    stateDir,
  });
  const revisions = createSqliteRevisionStore(
    temp.db,
    ledger,
    { now: () => new Date("2026-01-02T00:00:00.000Z") },
    content,
  );
  const retention = createSqliteRetentionStore(
    temp.db,
    ledger,
    { now: () => new Date("2026-01-02T00:00:00.000Z") },
    content,
  );
  const terminals = createSqliteTerminalStore(temp.db, ledger);
  const portsBase = {
    projectPorts: null as never,
    handoffs: readStore,
    config: { vaultPath: vault.vaultPath, maxBytes: 1024 * 1024, verifyChecksumOnFetch: false },
    artifact: bodyPorts,
    ids: {
      next: () =>
        `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12)
          .toString()
          .padStart(12, "0")}`,
    },
    clock: { now: () => new Date("2026-01-02T00:00:00.000Z") },
  };
  let ordinal = 0;
  const FILE_BODY = Buffer.from([0xf0, 0x0d, 0xaa, 0x55, 0x99]);
  const seededKeys = new Map<string, string>();
  const seed = (options: {
    reviewState: string;
    withNote: boolean;
    pendingDeletion: boolean;
    fileBacked?: boolean;
  }): string => {
    ordinal += 1;
    const handoffId = `44444444-4444-4444-8444-${ordinal.toString().padStart(12, "0")}`;
    const artifactId = `55555555-5555-4555-8555-${ordinal.toString().padStart(12, "0")}`;
    const recordId = `66666666-6666-4666-8666-${ordinal.toString().padStart(12, "0")}`;
    const fileBacked = options.fileBacked === true;
    const storageKey = `artifacts/${handoffId}/${artifactId}/gate.bin`;
    const body = fileBacked ? FILE_BODY : Buffer.from("# Gate body\n", "utf8");
    const digest = createHash("sha256").update(body).digest("hex");
    temp.db.exec("BEGIN IMMEDIATE");
    temp.db
      .prepare(
        "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES (?, NULL, NULL, 'Gates', 'user', NULL, NULL, NULL, '00000000-0000-4000-8000-0000000000b9', ?, 1, 1, ?, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      )
      .run(handoffId, artifactId, options.reviewState);
    if (fileBacked) {
      temp.db
        .prepare(
          "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(recordId, storageKey, body.byteLength, digest);
      seededKeys.set(handoffId, storageKey);
    } else {
      temp.db
        .prepare(
          "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, ?, NULL, ?, ?, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(recordId, "# Gate body\n", Buffer.byteLength("# Gate body\n"), digest);
    }
    temp.db
      .prepare(
        "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, ?, ?, ?, NULL, '2026-01-01T00:00:00.000Z', ?)",
      )
      .run(
        artifactId,
        handoffId,
        fileBacked ? "gate.bin" : "gate.md",
        fileBacked ? "gate.bin" : "gate.md",
        fileBacked ? "application/octet-stream" : "text/markdown",
        recordId,
      );
    if (options.withNote) {
      temp.db
        .prepare(
          "INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at) VALUES (?, 'user', NULL, 1, 'note', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        )
        .run(handoffId);
    }
    if (options.pendingDeletion) {
      temp.db
        .prepare(
          "INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at) VALUES (?, ?, 'user', NULL, NULL, 'pending', '2026-01-01T00:00:00.000Z')",
        )
        .run(`77777777-7777-4777-8777-${ordinal.toString().padStart(12, "0")}`, handoffId);
    }
    temp.db.exec("COMMIT");
    if (fileBacked) {
      const leaf = join(vault.vaultPath, storageKey);
      mkdirSync(join(vault.vaultPath, storageKey.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(leaf, FILE_BODY);
      chmodSync(leaf, 0o444);
    }
    return handoffId;
  };
  const recordIdOf = (handoffId: string): string =>
    (
      temp.db
        .prepare(
          "SELECT c.id AS id FROM handoffs h JOIN artifacts a ON a.id = h.current_artifact_id JOIN content_records c ON c.id = a.content_record_id WHERE h.id = ?",
        )
        .get(handoffId) as { id: string }
    ).id;
  return {
    tamperFileBody(handoffId: string, bytes: Buffer): void {
      const key = seededKeys.get(handoffId);
      if (key === undefined) throw new Error(`no file-backed seed for ${handoffId}`);
      const leaf = join(vault.vaultPath, key);
      chmodSync(leaf, 0o644);
      writeFileSync(leaf, bytes);
      chmodSync(leaf, 0o444);
    },
    tamperInline(handoffId: string, variant: "text" | "sha"): void {
      const recordId = recordIdOf(handoffId);
      if (variant === "text") {
        temp.db.prepare("UPDATE content_records SET inline_text = ? WHERE id = ?").run("# Tampered body\n", recordId);
      } else {
        temp.db.prepare("UPDATE content_records SET sha256 = ? WHERE id = ?").run("ab".repeat(32), recordId);
      }
    },
    breakCurrent(mode: Break): void {
      if (mode === "none") return;
      // Only the separate fault injector disables FK enforcement. The
      // operational connection retains its production constraints throughout.
      const fault = openSorageDatabase(temp.databasePath);
      try {
        fault.exec("PRAGMA foreign_keys = OFF");
        fault.exec(mode === "artifact-row" ? "DELETE FROM artifacts" : "DELETE FROM content_records");
      } finally {
        fault.exec("PRAGMA foreign_keys = ON");
        expect(fault.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
        fault.close();
      }
      expect(temp.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    },
    replacement,
    snapshot() {
      return Object.fromEntries(
        [
          "handoffs",
          "artifacts",
          "content_records",
          "review_notes",
          "deletion_requests",
          "events",
          "idempotency_keys",
          "pending_fs_ops",
        ].map((table) => [table, temp.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      );
    },
    count(sql: string): number {
      return (temp.db.prepare(sql).get() as { count: number }).count;
    },
    revisions,
    retention,
    terminals,
    verifyArtifactBody: bodyPorts.verifyArtifactBody,
    readBase: portsBase,
    seed,
  };
}

function revisionPortsOf(fixture: Fixture): Parameters<typeof reviseHandoff>[0] {
  return {
    ...fixture.readBase,
    projectPorts: null as never,
    revisions: fixture.revisions,
    artifactStore: {
      activate: () => {
        throw new Error("no activation may run past a missing-authority gate");
      },
      remove: () => {
        throw new Error("no unlink may run past a missing-authority gate");
      },
    } as never,
    content: {
      prepareArtifactBody: () => {
        throw new Error("no body preparation may run past a missing-authority gate");
      },
    } as never,
    bindingDirectories: [],
    digestSource: () => ({ ok: true, value: "f".repeat(64) }) as Result<string, AppError>,
  } as unknown as Parameters<typeof reviseHandoff>[0];
}

describe("the mandatory missing-authority gates across mutations", () => {
  for (const mode of ["artifact-row", "record-row"] as const) {
    it(`refuses revise, no-change, accept, and deletion approval when the ${mode} is gone`, () => {
      const fixture = makeFixture();
      const replacement = fixture.replacement;

      // Seed every subject Handoff first, then break the authoritative link
      // once: every gate below runs against the same broken installation.
      const reviseId = fixture.seed({ reviewState: "awaiting_recipient", withNote: true, pendingDeletion: false });
      const noChangeId = fixture.seed({ reviewState: "changes_requested", withNote: true, pendingDeletion: false });
      const acceptId = fixture.seed({ reviewState: "awaiting_recipient", withNote: false, pendingDeletion: false });
      const deleteId = fixture.seed({ reviewState: "accepted", withNote: false, pendingDeletion: true });
      const before = {
        handoffs: fixture.count("SELECT COUNT(*) AS count FROM handoffs"),
        artifacts: fixture.count("SELECT COUNT(*) AS count FROM artifacts"),
        events: fixture.count("SELECT COUNT(*) AS count FROM events"),
        receipts: fixture.count("SELECT COUNT(*) AS count FROM idempotency_keys"),
        notes: fixture.count("SELECT COUNT(*) AS count FROM review_notes"),
      };
      fixture.breakCurrent(mode);
      const brokenBaseline = fixture.snapshot();

      // revise --file: replay and state guards pass, then the gate refuses.
      const revised = reviseHandoff(revisionPortsOf(fixture), {
        handoffId: reviseId,
        expectedRowVersion: 1,
        file: replacement,
        originalName: "replacement.md",
        allowExternalSource: true,
        ...USER,
      });
      expect(revised.ok).toBe(false);
      if (!revised.ok) expect(revised.error.code).toBe("ARTIFACT_CORRUPTED");

      // revise --no-change: the Note exists so the evaluator passes; the gate
      // refuses before the resolution transaction.
      const noChange = reviseHandoff(revisionPortsOf(fixture), {
        handoffId: noChangeId,
        expectedRowVersion: 1,
        noChange: true,
        reason: "unchanged",
        ...USER,
      });
      expect(noChange.ok).toBe(false);
      if (!noChange.ok) expect(noChange.error.code).toBe("ARTIFACT_CORRUPTED");
      expect(fixture.count(`SELECT COUNT(*) AS count FROM handoffs WHERE id = '${noChangeId}' AND revision = 1`)).toBe(
        1,
      );

      // accept: the evaluator's materializing answer remaps onto the observed
      // expectations first, then the corruption refusal (LIFE-002 order).
      const accepted = acceptHandoff(
        {
          ...fixture.readBase,
          projectPorts: null as never,
          terminals: fixture.terminals,
        } as never,
        { handoffId: acceptId, expectedRevision: 1, expectedRowVersion: 1, ...USER },
      );
      expect(accepted.ok).toBe(false);
      if (!accepted.ok) expect(accepted.error.code).toBe("ARTIFACT_CORRUPTED");
      expect(
        fixture.count(
          `SELECT COUNT(*) AS count FROM handoffs WHERE id = '${acceptId}' AND review_state = 'awaiting_recipient'`,
        ),
      ).toBe(1);

      // deletion approval: terminal state and a pending request pass the
      // evaluator; the gate refuses before any tombstone.
      const approved = approveDeletion(
        {
          ...fixture.readBase,
          projectPorts: null as never,
          retention: fixture.retention,
          artifact: {
            ...fixture.readBase.artifact,
            remove: () => {
              throw new Error("no unlink may run past a missing-authority gate");
            },
          },
        } as never,
        { handoffId: deleteId, confirm: true, expectedRowVersion: 1, ...USER },
      );
      expect(approved.ok).toBe(false);
      if (!approved.ok) expect(approved.error.code).toBe("ARTIFACT_CORRUPTED");
      expect(
        fixture.count(`SELECT COUNT(*) AS count FROM handoffs WHERE id = '${deleteId}' AND deleted_at IS NULL`),
      ).toBe(1);

      // No mutation of any kind survived the four refusals: state, Row
      // Version, events, receipts, and the broken link itself are unchanged.
      expect(fixture.count("SELECT COUNT(*) AS count FROM handoffs")).toBe(before.handoffs);
      expect(fixture.count("SELECT COUNT(*) AS count FROM artifacts")).toBe(
        mode === "artifact-row" ? 0 : before.artifacts,
      );
      expect(fixture.count("SELECT COUNT(*) AS count FROM events")).toBe(before.events);
      expect(fixture.count("SELECT COUNT(*) AS count FROM idempotency_keys")).toBe(before.receipts);
      expect(fixture.count("SELECT COUNT(*) AS count FROM review_notes")).toBe(before.notes);
      expect(fixture.count("SELECT COUNT(*) AS count FROM pending_fs_ops")).toBe(0);
      expect(fixture.snapshot()).toEqual(brokenBaseline);
    });
  }

  it("answers a stale observed Row Version before the corruption refusal", () => {
    const fixture = makeFixture();
    const id = fixture.seed({ reviewState: "awaiting_recipient", withNote: true, pendingDeletion: false });
    fixture.breakCurrent("record-row");
    const revised = reviseHandoff(revisionPortsOf(fixture), {
      handoffId: id,
      file: join(tmpdir(), "unused.md"),
      originalName: "unused.md",
      allowExternalSource: true,
      expectedRowVersion: 99,
      ...USER,
    });
    expect(revised.ok).toBe(false);
    if (revised.ok) return;
    expect(revised.error.code).toBe("ROW_VERSION_CONFLICT");
  });
});

describe("the mandatory body-corruption gates across mutations (SHR-003, VLT-023)", () => {
  // SQL-seeded gate controls over the real stores and the real bounded
  // verifier; the actual-producer proof is the compiled parameterized
  // corrupt-current case, which this suite complements rather than replaces.
  for (const mode of ["file-bytes", "inline-text", "inline-sha"] as const) {
    it(`refuses revise, no-change, accept, and deletion approval on a ${mode} corruption`, () => {
      const fixture = makeFixture();
      const fileBacked = mode === "file-bytes";
      const seedOptions = { fileBacked };
      const reviseId = fixture.seed({
        reviewState: "changes_requested",
        withNote: true,
        pendingDeletion: false,
        ...seedOptions,
      });
      const noChangeId = fixture.seed({
        reviewState: "changes_requested",
        withNote: true,
        pendingDeletion: false,
        ...seedOptions,
      });
      const acceptId = fixture.seed({
        reviewState: "awaiting_recipient",
        withNote: false,
        pendingDeletion: false,
        ...seedOptions,
      });
      const deleteId = fixture.seed({
        reviewState: "accepted",
        withNote: false,
        pendingDeletion: true,
        ...seedOptions,
      });

      // Corrupt every current body, then take the full-state baseline: only
      // the refused operations' zero-effect is judged below.
      const targets = [reviseId, noChangeId, acceptId, deleteId];
      for (const id of targets) {
        if (mode === "file-bytes") {
          fixture.tamperFileBody(id, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
        } else {
          fixture.tamperInline(id, mode === "inline-text" ? "text" : "sha");
        }
      }
      const baseline = fixture.snapshot();

      const revised = reviseHandoff(revisionPortsOf(fixture), {
        handoffId: reviseId,
        expectedRowVersion: 1,
        file: fixture.replacement,
        originalName: "replacement.md",
        allowExternalSource: true,
        ...USER,
      });
      expect(revised.ok).toBe(false);
      if (!revised.ok) expect(revised.error.code).toBe("ARTIFACT_CORRUPTED");

      const noChange = reviseHandoff(revisionPortsOf(fixture), {
        handoffId: noChangeId,
        expectedRowVersion: 1,
        noChange: true,
        reason: "corruption probe",
        ...USER,
      });
      expect(noChange.ok).toBe(false);
      if (!noChange.ok) expect(noChange.error.code).toBe("ARTIFACT_CORRUPTED");

      const accepted = acceptHandoff(
        {
          ...fixture.readBase,
          projectPorts: null as never,
          terminals: fixture.terminals,
        } as never,
        { handoffId: acceptId, expectedRevision: 1, expectedRowVersion: 1, ...USER },
      );
      expect(accepted.ok).toBe(false);
      if (!accepted.ok) expect(accepted.error.code).toBe("ARTIFACT_CORRUPTED");

      const approved = approveDeletion(
        {
          ...fixture.readBase,
          projectPorts: null as never,
          retention: fixture.retention,
          artifact: {
            ...fixture.readBase.artifact,
            remove: () => {
              throw new Error("no unlink may run past a corruption gate");
            },
          },
        } as never,
        { handoffId: deleteId, confirm: true, expectedRowVersion: 1, ...USER },
      );
      expect(approved.ok).toBe(false);
      if (!approved.ok) expect(approved.error.code).toBe("ARTIFACT_CORRUPTED");

      // Every table is byte-identical to the corrupted baseline.
      expect(fixture.snapshot()).toEqual(baseline);
      expect(fixture.count("SELECT COUNT(*) AS count FROM pending_fs_ops")).toBe(0);
    });
  }
});
