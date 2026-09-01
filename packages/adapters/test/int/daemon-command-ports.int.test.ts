import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createNodeDaemonPorts } from "../../src/daemon-command-ports";
import { withTempHome } from "../../src/testkit";
import type { HomePaths } from "../../src/home";
import { createHomePaths } from "../../src/home";
import { defaultConfiguration } from "@sorage/core";
import { createConfigStore } from "../../src/config-store";
import { createNodeLockProbePorts } from "../../src/lockfile";

/**
 * The TASK-044 daemon composition surface: the atomic `run/daemon.json` record, the
 * `daemon.lock` lifetime with dead-pid recovery, and the byte-budgeted Artifact
 * checksum batch the periodic sweep walks.
 */
const INSTALLATION = "1f0ac9a0-0000-4000-8000-0000000000dd";

async function preparedHome(vaultRel = "vault"): Promise<{ home: HomePaths; env: Record<string, string> }> {
  const temp = await withTempHome(async (home) => home, "sorage-daemon-ports-");
  const env = { SORAGE_HOME: temp };
  const home = createHomePaths({ SORAGE_HOME: temp }, "/Users/test");
  mkdirSync(join(home.runDir), { recursive: true });
  mkdirSync(join(home.stateDir), { recursive: true });
  const vault = join(temp, vaultRel);
  const store = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome: "/Users/test" });
  const written = store.write(defaultConfiguration(INSTALLATION), { revision: 0 });
  expect(written.ok).toBe(true);
  mkdirSync(vault, { recursive: true });
  return { home, env };
}

describe("the run record (RUN-013)", () => {
  it("writes daemon.json atomically and reads it back", async () => {
    const { env } = await preparedHome();
    const ports = createNodeDaemonPorts({ env });
    expect(ports.readDaemonRecord()).toBeNull();
    ports.writeDaemonRecord({
      pid: 42,
      host: "127.0.0.1",
      port: 46321,
      startedAt: "2026-08-30T00:00:00.000Z",
      version: "0.1.0",
      installationId: INSTALLATION,
    });
    expect(ports.readDaemonRecord()).toMatchObject({ pid: 42, port: 46321, installationId: INSTALLATION });
    ports.removeDaemonRecord();
    expect(ports.readDaemonRecord()).toBeNull();
    // Removal is idempotent.
    expect(() => ports.removeDaemonRecord()).not.toThrow();
  });

  it("leaves no temporary residue behind the atomic write", async () => {
    const { env, home } = await preparedHome();
    const ports = createNodeDaemonPorts({ env });
    ports.writeDaemonRecord({
      pid: 1,
      host: "127.0.0.1",
      port: 1,
      startedAt: "2026-08-30T00:00:00.000Z",
      version: "0",
      installationId: INSTALLATION,
    });
    const residue = join(home.runDir).toString();
    expect(existsSync(join(residue, ".daemon.json.tmp-1"))).toBe(false);
  });
});

describe("the daemon lock (RUN-013, SEC-015)", () => {
  it("is exclusive for live owners and recovered when the recorded pid is dead", async () => {
    const { env, home } = await preparedHome();
    const first = createNodeDaemonPorts({ env });
    const held = first.acquireDaemonLock();
    expect(held.ok).toBe(true);
    const second = createNodeDaemonPorts({ env });
    const conflicted = second.acquireDaemonLock();
    expect(conflicted.ok).toBe(false);
    held.release?.();
    expect(second.acquireDaemonLock().ok).toBe(true);

    // A lock whose recorded pid is dead is broken and taken over by the next start.
    writeFileSync(
      home.lockFile("daemon"),
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), hostname: "gone" }),
    );
    expect(createNodeDaemonPorts({ env }).acquireDaemonLock().ok).toBe(true);
    rmSync(home.lockFile("daemon"), { force: true });
  });
});

describe("the bounded checksum batch", () => {
  it("walks materialized Artifacts in order and honors the byte budget", async () => {
    const { env, home } = await preparedHome();
    const vault = join(env.SORAGE_HOME as string, "vault");
    // Seed the database with the schema through the migration path the CLI uses.
    const { openAndMigrate } = await import("../../src/sqlite/migrator");
    const { MIGRATIONS } = await import("../../src/sqlite/migrations");
    const db = openAndMigrate(join(home.stateDir, "sorage.sqlite3"), MIGRATIONS).db;

    const _store = createNodeArtifactStore({ vaultPath: vault, installationId: INSTALLATION });
    const handoff = "2f0ac9a0-0000-4000-8000-0000000000h1" as string;
    const key1 = `artifacts/${handoff}/a/one.md`;
    const key2 = `artifacts/${handoff}/a/two.md`;
    const dir = join(vault, key1.slice(0, key1.lastIndexOf("/")));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(vault, key1), "a".repeat(10));
    writeFileSync(join(vault, key2), "b".repeat(10));
    const project = "3f0ac9a0-0000-4000-8000-0000000000p1";
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)",
    ).run(project, "proj", "Proj", new Date().toISOString(), new Date().toISOString());
    // The deferrable current_artifact_id cycle: insert the handoff marked deleted
    // first is wrong; instead point it at the first artifact, which lands after it
    // inside the same transaction window thanks to the DEFERRABLE foreign key.
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?,?,?,?,?,1,1,'awaiting_recipient',?,?)",
    ).run(handoff, "Probe", "user", project, "a1", new Date().toISOString(), new Date().toISOString());
    const insert = db.prepare(
      "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, materialized, created_at) VALUES (?,?,?,?,?,?,?, ?,1,?)",
    );
    insert.run("a1", handoff, key1, "one.md", "one.md", "text/markdown", 10, "0".repeat(64), new Date().toISOString());
    insert.run("a2", handoff, key2, "two.md", "two.md", "text/markdown", 10, "0".repeat(64), new Date().toISOString());
    db.exec("COMMIT");
    db.close();

    const ports = createNodeDaemonPorts({ env });
    // A budget that fits only the first record leaves a cursor at the second.
    const first = ports.nextArtifactBatch(null, 10);
    expect(first.records).toHaveLength(1);
    expect(first.nextCursor).toBe(key2);
    const second = ports.nextArtifactBatch(first.nextCursor, 10);
    expect(second.records).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // Hashing resolves the vault-relative key itself, so the digest is the real
    // SHA-256 of the planted bytes; the doubled artifacts/ prefix would miss the
    // file and return null, which the equality below would catch.
    const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(ports.hashArtifact(key1)).toBe(digestOf("a".repeat(10)));
    expect(ports.hashArtifact(key2)).toBe(digestOf("b".repeat(10)));
    expect(ports.hashArtifact(`artifacts/${handoff}/a/missing.md`)).toBeNull();
  });
});
