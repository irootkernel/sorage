import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import type { ProjectCommandPorts, SendPorts } from "@sorage/core";
import { sendHandoffs } from "@sorage/core";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteHandoffWriteStore } from "../../src/handoffs";
import { clearMoveFence, setMoveFenceAndCountPending } from "../../src/intent-log";
import { createSqliteProjectRepository } from "../../src/projects";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { FakeClock, makeTempDatabase, makeTempVault } from "../../src/testkit";
import { createVaultInitializer } from "../../src/vault";

/**
 * The TASK-029 acceptance gate: fan-out independence through one dispatch group,
 * `--body` Markdown materialization, the supersedes link, idempotency replay before
 * every other guard, the all-or-nothing crash shape of CP-1, and the vault-move
 * fence that closes the EPIC-004 seam (RUN-002).
 */

const INSTALLATION = "00000000-0000-4000-8000-00000000000f";
const USER_HOME = "/home/tester";

interface Fixture {
  db: ReturnType<typeof makeTempDatabase>["db"];
  vaultPath: string;
  ports: SendPorts;
  cleanup: () => void;
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

function makeFixture(options: { failCreateFanout?: boolean } = {}): Fixture {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  migrate(temp.db, MIGRATIONS);
  const vault = makeTempVault("sorage-send-");
  cleanups.push(vault.cleanup);
  const marker = createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION);
  if (!marker.ok) throw new Error("fixture vault marker must initialize");
  const ledger = createSqliteEventLedger(temp.db);
  const repository = createSqliteProjectRepository(temp.db, { installationId: INSTALLATION, events: ledger });
  const write = createSqliteHandoffWriteStore(temp.db, ledger);
  const clock = new FakeClock();
  let ids = 0;
  const nextId = () => {
    ids += 1;
    return `0000000${ids.toString().padStart(5, "0")}-0000-4000-8000-0000000000${(ids % 9) + 1}`;
  };
  const projectPorts: ProjectCommandPorts = {
    installationId: INSTALLATION,
    projects: repository,
    clock,
    ids: { next: nextId },
    bindings: {
      realPath(path) {
        return { ok: true, value: path.startsWith("/") ? path : join(USER_HOME, path) };
      },
      absentRealPath(path) {
        return { ok: true, value: path };
      },
      gitCommonDirectory: () => null,
      resolveDirectory(path) {
        return { ok: true, value: { directory: path, bindingKind: "directory" } };
      },
    },
    handoffs: { openHandoffCount: () => ({ ok: true, value: 0 }) },
  };
  const sourceDir = join(vault.home.home, "sources");
  mkdirSync(sourceDir, { recursive: true });
  const ports: SendPorts = {
    projectPorts,
    handoffs:
      options.failCreateFanout === true
        ? {
            ...write,
            createFanout: () => ({
              ok: false,
              error: { code: "INTERNAL_ERROR", message: "injected failure before the intent commit" },
            }),
          }
        : write,
    artifactStore: createNodeArtifactStore({ vaultPath: vault.vaultPath, installationId: INSTALLATION }),
    ids: { next: nextId },
    clock,
    config: { vaultPath: vault.vaultPath, maxBytes: 1024 * 1024, allowUnregisteredSenders: false },
    bindingDirectories: [],
    inspectSource(path) {
      return { ok: true, value: { resolvedSourcePath: path, originalName: basename(path) } };
    },
    writeBodySource(text, storedName) {
      const sourcePath = join(sourceDir, storedName);
      writeFileSync(sourcePath, text);
      return { ok: true, value: { sourcePath, cleanup: () => rmSync(sourcePath, { force: true }) } };
    },
    digestSource(path) {
      const digest = spawnSync("shasum", ["-a", "256", path], { encoding: "utf8" });
      return { ok: true, value: (digest.stdout ?? "").split(" ")[0] ?? "" };
    },
  };
  return {
    db: temp.db,
    vaultPath: vault.vaultPath,
    ports,
    cleanup: () => {},
  };
}

function seedProject(fixture: Fixture, id: string, slug: string): void {
  fixture.db
    .prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .run(id, slug, slug);
  fixture.db
    .prepare(
      "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .run(`b-${id}`, id, INSTALLATION, `/workspaces/${slug}`);
}

function seedTerminalHandoff(fixture: Fixture, id: string, state: string, deleted: string | null): void {
  fixture.db.exec("BEGIN");
  fixture.db
    .prepare(
      "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, imported_from_path, materialized, created_at) VALUES (?, ?, ?, 'doc.md', 'doc.md', 'text/markdown', 1, 'sha', NULL, 1, '2026-01-01T00:00:00.000Z')",
    )
    .run(`a-${id}`, id, `artifacts/${id}/a-${id}/doc.md`);
  fixture.db
    .prepare(
      "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at, deleted_at) VALUES (?, 'Old', 'user', 'p-1', ?, 1, 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)",
    )
    .run(id, `a-${id}`, state, deleted);
  fixture.db.exec("COMMIT");
}

function handoffRows(fixture: Fixture): Array<Record<string, unknown>> {
  return fixture.db.prepare("SELECT * FROM handoffs ORDER BY id").all() as Array<Record<string, unknown>>;
}

function baseInput(fixture: Fixture, overrides: Partial<Parameters<typeof sendHandoffs>[1]> = {}) {
  const sourcePath = join(fixture.vaultPath, "..", "sources", "doc.md");
  writeFileSync(sourcePath, "document bytes");
  return {
    to: ["alpha"],
    title: "Design brief",
    file: sourcePath,
    // The fixture's sources directory intentionally sits outside the fake sender
    // workspace, so the send exercises the explicit override the way a user would.
    allowExternalSource: true,
    allowUnregistered: true,
    path: "/unregistered/workspace",
    userHome: USER_HOME,
    ...overrides,
  };
}

describe("sorage send", () => {
  it("fans one source out to independent Handoffs sharing one dispatch group", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    seedProject(fixture, "p-2", "beta");
    const source = join(fixture.vaultPath, "..", "sources", "brief.md");
    writeFileSync(source, "shared document bytes");

    const sent = sendHandoffs(fixture.ports, baseInput(fixture, { to: ["alpha", "beta"], file: source }));
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.handoffs).toHaveLength(2);
    expect(sent.value.dispatchGroupId).not.toBeNull();
    const rows = handoffRows(fixture);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.dispatch_group_id))).toEqual(new Set([sent.value.dispatchGroupId]));
    // Independent Artifact copies: distinct storage keys, identical content digest.
    const keys = new Set(rows.map((row) => row.current_artifact_id));
    expect(keys.size).toBe(2);
    const artifacts = fixture.db.prepare("SELECT * FROM artifacts").all() as Array<Record<string, unknown>>;
    expect(new Set(artifacts.map((row) => row.storage_key)).size).toBe(2);
    expect(new Set(artifacts.map((row) => row.sha256)).size).toBe(1);
    for (const artifact of artifacts) {
      expect(artifact.materialized).toBe(1);
      expect(existsSync(join(fixture.vaultPath, artifact.storage_key as string))).toBe(true);
    }
    expect(fixture.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
    const events = fixture.db.prepare("SELECT event_type FROM events ORDER BY rowid").all() as Array<{
      event_type: string;
    }>;
    expect(events.map((row) => row.event_type)).toEqual([
      "HANDOFF_CREATED",
      "HANDOFF_CREATED",
      "ARTIFACT_ACTIVATED",
      "ARTIFACT_ACTIVATED",
    ]);
  });

  it("sends to one recipient without a dispatch group", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    const sent = sendHandoffs(fixture.ports, baseInput(fixture));
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.dispatchGroupId).toBeNull();
    expect(handoffRows(fixture)[0]?.dispatch_group_id).toBeNull();
  });

  it("materializes a --body send as one Markdown Artifact named title-slug-1.md", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    const sent = sendHandoffs(fixture.ports, baseInput(fixture, { file: undefined, body: "# Notes for you" }));
    expect(sent.ok).toBe(true);
    const artifact = fixture.db.prepare("SELECT * FROM artifacts").get() as Record<string, unknown>;
    expect(artifact.stored_name).toBe("design-brief-1.md");
    expect(artifact.original_name).toBe("design-brief-1.md");
    expect(artifact.mime_type).toBe("text/markdown");
    expect(artifact.imported_from_path).toBeNull();
    expect(existsSync(join(fixture.vaultPath, artifact.storage_key as string))).toBe(true);
  });

  it("validates the supersedes link: terminal and tombstone targets qualify, others refuse", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    seedTerminalHandoff(fixture, "h-old-accepted", "accepted", null);
    seedTerminalHandoff(fixture, "h-old-tombstone", "accepted", "2026-01-02T00:00:00.000Z");
    seedTerminalHandoff(fixture, "h-old-live", "awaiting_recipient", null);

    const terminal = sendHandoffs(fixture.ports, baseInput(fixture, { supersedes: "h-old-accepted" }));
    expect(terminal.ok).toBe(true);
    const tombstone = sendHandoffs(fixture.ports, baseInput(fixture, { supersedes: "h-old-tombstone" }));
    expect(tombstone.ok).toBe(true);

    const missing = sendHandoffs(fixture.ports, baseInput(fixture, { supersedes: "h-ghost" }));
    expect(!missing.ok && missing.error.code).toBe("HANDOFF_NOT_FOUND");
    const live = sendHandoffs(fixture.ports, baseInput(fixture, { supersedes: "h-old-live" }));
    expect(!live.ok && live.error.code).toBe("HANDOFF_NOT_TERMINAL");
    // Three seeded rows plus the two qualifying sends; the refusals added nothing.
    expect(handoffRows(fixture)).toHaveLength(5);
  });

  it("accepts a supersedes target whose recipient differs from the new send's", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    seedProject(fixture, "p-2", "beta");
    seedTerminalHandoff(fixture, "h-old-alpha", "accepted", null);

    const sent = sendHandoffs(fixture.ports, baseInput(fixture, { to: ["beta"], supersedes: "h-old-alpha" }));
    expect(sent.ok).toBe(true);
    const newer = handoffRows(fixture).find((row) => row.id !== "h-old-alpha") as {
      recipient_project_id: string;
      supersedes_handoff_id: string;
    };
    expect(newer.recipient_project_id).toBe("p-2");
    expect(newer.supersedes_handoff_id).toBe("h-old-alpha");
  });

  it("creates nothing for an ineligible recipient", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    const refused = sendHandoffs(fixture.ports, baseInput(fixture, { to: ["ghost"] }));
    expect(!refused.ok && refused.error.code).toBe("UNREGISTERED_RECIPIENT");
    expect(handoffRows(fixture)).toHaveLength(0);
    expect(fixture.db.prepare("SELECT COUNT(*) AS c FROM artifacts").get()).toMatchObject({ c: 0 });
  });

  it("replays an identical idempotent send and refuses a different request under the key", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    const source = join(fixture.vaultPath, "..", "sources", "doc.md");
    writeFileSync(source, "document bytes");
    const input = baseInput(fixture, { idempotencyKey: "key-1", file: source });

    const first = sendHandoffs(fixture.ports, input);
    expect(first.ok).toBe(true);
    const second = sendHandoffs(fixture.ports, input);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.replayed).toBe(true);
      expect(second.value.handoffs).toEqual(first.ok ? first.value.handoffs : []);
    }
    expect(handoffRows(fixture)).toHaveLength(1);

    writeFileSync(source, "different document bytes");
    const conflict = sendHandoffs(fixture.ports, input);
    expect(!conflict.ok && conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(handoffRows(fixture)).toHaveLength(1);
  });

  it("leaves zero Handoffs and only a sweepable staged file when the intent commit fails (CP-1)", () => {
    const fixture = makeFixture({ failCreateFanout: true });
    seedProject(fixture, "p-1", "alpha");
    const failed = sendHandoffs(fixture.ports, baseInput(fixture));
    expect(!failed.ok).toBe(true);
    expect(handoffRows(fixture)).toHaveLength(0);
    expect(fixture.db.prepare("SELECT COUNT(*) AS c FROM artifacts").get()).toMatchObject({ c: 0 });
    const staged = fixture.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get();
    expect(staged).toMatchObject({ c: 0 });
    // The staged copy survives under staging/ for the age-bounded sweep.
    const stagingDir = join(fixture.vaultPath, "staging");
    const leftover = stagingEntries(stagingDir);
    expect(leftover.length).toBe(1);
  });

  it("pauses creation behind a live vault-move fence and ignores a dead one (RUN-002)", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    const count = setMoveFenceAndCountPending(fixture.db, process.pid, "2026-01-02T00:00:00.000Z");
    expect(count.ok && count.value).toBe(0);
    const paused = sendHandoffs(fixture.ports, baseInput(fixture));
    expect(!paused.ok && paused.error.code).toBe("SERVICE_PAUSED");
    expect(handoffRows(fixture)).toHaveLength(0);

    // A fence from a dead mover is stale and ignored.
    clearMoveFence(fixture.db);
    setMoveFenceAndCountPending(fixture.db, 999_999_999, "2026-01-02T00:00:00.000Z");
    const through = sendHandoffs(fixture.ports, baseInput(fixture));
    expect(through.ok).toBe(true);
    expect(handoffRows(fixture)).toHaveLength(1);
  });

  it("completes the AJ-06 scale variant: one fan-out to one hundred recipients is all-or-nothing", () => {
    const fixture = makeFixture();
    const recipients: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const slug = `team-${index.toString().padStart(3, "0")}`;
      seedProject(fixture, `p-${index.toString().padStart(3, "0")}`, slug);
      recipients.push(slug);
    }
    const sent = sendHandoffs(fixture.ports, baseInput(fixture, { to: recipients }));
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.handoffs).toHaveLength(100);
    expect(sent.value.dispatchGroupId).not.toBeNull();

    const rows = handoffRows(fixture);
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((row) => row.dispatch_group_id)).size).toBe(1);
    expect(new Set(rows.map((row) => row.supersedes_handoff_id)).size).toBe(1);
    const artifacts = fixture.db.prepare("SELECT * FROM artifacts").all() as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(100);
    expect(new Set(artifacts.map((row) => row.storage_key)).size).toBe(100);
    for (const artifact of artifacts) {
      expect(artifact.materialized).toBe(1);
      expect(existsSync(join(fixture.vaultPath, artifact.storage_key as string))).toBe(true);
    }
    expect(fixture.db.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
  });

  it("cites one supersedes target from every Handoff of a fan-out (section 13.9)", () => {
    const fixture = makeFixture();
    seedProject(fixture, "p-1", "alpha");
    seedProject(fixture, "p-2", "beta");
    seedTerminalHandoff(fixture, "h-old-accepted", "accepted", null);

    const sent = sendHandoffs(
      fixture.ports,
      baseInput(fixture, { to: ["alpha", "beta"], supersedes: "h-old-accepted" }),
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.handoffs).toHaveLength(2);
    const newer = handoffRows(fixture).filter((row) => row.id !== "h-old-accepted");
    expect(newer).toHaveLength(2);
    for (const row of newer) {
      expect(row.supersedes_handoff_id).toBe("h-old-accepted");
    }
  });
});

function stagingEntries(stagingDir: string): string[] {
  try {
    return readdirSync(stagingDir);
  } catch {
    return [];
  }
}
