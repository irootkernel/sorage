import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fetchHandoff, prepareHandoffFetch } from "@sorage/core";
import type { HandoffDetailReadPorts } from "@sorage/core";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createHomePaths } from "../../src/home";
import { createArtifactBodyPorts } from "../../src/artifact-body-ports";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteHandoffReadStore } from "../../src/handoff-read-store";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { migrate } from "../../src/sqlite/migrator";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { makeTempVault } from "../../src/testkit/temp-vault";

/**
 * The safe serving boundary of M3-P3 (VLT-020, section 11.3, section 6.2
 * canaries): the default-false production fetch acquires the body through the
 * guarded managed open — an owned-outside symlink at the leaf or a managed
 * parent, a dangling link, a special entry, or a missing file refuses with
 * ARTIFACT_CORRUPTED before any first fetch is recorded — while a healthy
 * regular file and a legitimately aliased selected root keep serving. The
 * store-level handle honors the bounded read contract and honest close
 * ownership. No raw pathOf unit canary substitutes for these paths: every
 * case runs the real fetch use case over the real store, database, and
 * filesystem.
 */

const INSTALLATION = "00000000-0000-4000-8000-0000000000f2";
const BODY = Buffer.from("# The served document\n", "utf8");
const SHA = createHash("sha256").update(BODY).digest("hex");
const USER_ACTOR_INPUT = { path: "/w", userHome: "/h", as: undefined, asUser: true };

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

/** A deterministic valid UUID (8-4-4-4-12) whose segments stay hexadecimal at any ordinal. */
function seededUuid(kind: string, ordinal: number): string {
  const head = Buffer.from(kind, "utf8").toString("hex").slice(0, 8).padStart(8, "0");
  const tail = ordinal.toString(16).padStart(12, "0").slice(-12);
  return `${head}-0000-4000-8000-${tail}`;
}

interface Fixture {
  db: ReturnType<typeof makeTempDatabase>["db"];
  vaultPath: string;
  stateDir: string;
  ports: HandoffDetailReadPorts;
  artifactStore: ReturnType<typeof createNodeArtifactStore>;
  count: (sql: string, ...params: string[]) => number;
  firstFetchedAt: (handoffId: string) => string | null;
  fetchEvents: (handoffId: string) => number;
  seed: (handoffId: string, options?: { sha256?: string; materialized?: boolean }) => string;
}

function makeFixture(options: { verifyChecksumOnFetch?: boolean } = {}): Fixture {
  const temp = makeTempDatabase();
  cleanups.push(temp.cleanup);
  const plan = productionMigrationPlan();
  migrate(temp.db, plan.migrations, () => "2026-01-01T00:00:00.000Z", {
    databasePath: temp.databasePath,
    rebuilds: plan.rebuilds,
  });
  const vault = makeTempVault("sorage-serving-");
  cleanups.push(vault.cleanup);
  const home = createHomePaths({ SORAGE_HOME: vault.home.home }, vault.home.home);
  temp.db
    .prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 'recipient', 'Recipient', NULL, 'active', ?, ?)",
    )
    .run("00000000-0000-4000-8000-0000000000b9", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const ledger = createSqliteEventLedger(temp.db);
  const store = createNodeArtifactStore({ vaultPath: vault.vaultPath, installationId: INSTALLATION });
  const ports = {
    projectPorts: null as never,
    handoffs: createSqliteHandoffReadStore(temp.db, ledger, { runDir: home.runDir }),
    config: { vaultPath: vault.vaultPath, verifyChecksumOnFetch: options.verifyChecksumOnFetch === true },
    artifact: createArtifactBodyPorts({
      db: temp.db,
      vaultPath: vault.vaultPath,
      installationId: INSTALLATION,
      stateDir: home.stateDir,
    }),
    ids: {
      next: () =>
        `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12)
          .toString()
          .padStart(12, "0")}`,
    },
    clock: { now: () => new Date("2026-01-02T00:00:00.000Z") },
  } as unknown as HandoffDetailReadPorts;
  let ordinal = 0;
  const seed = (handoffId: string, seedOptions: { sha256?: string; materialized?: boolean } = {}): string => {
    ordinal += 1;
    const artifactId = seededUuid("aa", ordinal);
    const recordId = seededUuid("cc", ordinal);
    const storageKey = `artifacts/${handoffId}/${artifactId}/doc.md`;
    temp.db.exec("BEGIN");
    try {
      temp.db
        .prepare(
          "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES (?, NULL, NULL, 'Serving', 'user', NULL, NULL, NULL, '00000000-0000-4000-8000-0000000000b9', ?, 1, 1, 'awaiting_recipient', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        )
        .run(handoffId, artifactId);
      temp.db
        .prepare(
          "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
        )
        .run(
          recordId,
          storageKey,
          BODY.byteLength,
          seedOptions.sha256 ?? SHA,
          seedOptions.materialized === false ? 0 : 1,
        );
      temp.db
        .prepare(
          "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, 'doc.md', 'doc.md', 'text/markdown', NULL, '2026-01-01T00:00:00.000Z', ?)",
        )
        .run(artifactId, handoffId, recordId);
      temp.db.exec("COMMIT");
    } catch (error) {
      temp.db.exec("ROLLBACK");
      throw error;
    }
    return storageKey;
  };
  const count = (sql: string, ...params: string[]): number =>
    (temp.db.prepare(sql).get(...params) as { count: number }).count;
  return {
    db: temp.db,
    vaultPath: vault.vaultPath,
    ports,
    stateDir: home.stateDir,
    artifactStore: store,
    count,
    firstFetchedAt: (handoffId) =>
      (
        temp.db.prepare("SELECT first_fetched_at FROM handoffs WHERE id = ?").get(handoffId) as {
          first_fetched_at: string | null;
        }
      ).first_fetched_at,
    fetchEvents: (handoffId) =>
      count(
        "SELECT COUNT(*) AS count FROM events WHERE handoff_id = ? AND event_type = 'ARTIFACT_FETCHED_FIRST_TIME'",
        handoffId,
      ),
    seed,
  };
}

function placeHealthyArtifact(fixture: Fixture, handoffId: string): string {
  const key = fixture.seed(handoffId);
  const leaf = join(fixture.vaultPath, key);
  mkdirSync(dirname(leaf), { recursive: true });
  writeFileSync(leaf, BODY);
  chmodSync(leaf, 0o444);
  return leaf;
}

const outsideFile = (name: string): string => {
  const outside = mkdtempSync(join(tmpdir(), "sorage-serving-outside-"));
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
  const target = join(outside, name);
  writeFileSync(target, "owned bytes outside the Vault");
  return target;
};

describe("the default-false production fetch over the guarded serving boundary", () => {
  it("serves a healthy regular file and records the eligible first fetch exactly once", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111f1";
    placeHealthyArtifact(fixture, handoffId);
    const fetched = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, handoffId);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(readFileSync(fetched.value.localPath, "utf8")).toBe(BODY.toString("utf8"));
    expect(fixture.firstFetchedAt(handoffId)).not.toBeNull();
    expect(fixture.fetchEvents(handoffId)).toBe(1);
    const again = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, handoffId);
    expect(again.ok).toBe(true);
    expect(fixture.fetchEvents(handoffId)).toBe(1);
  });

  it("refuses a missing file before any first fetch is recorded", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111f2";
    fixture.seed(handoffId);
    const fetched = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, handoffId);
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(fixture.firstFetchedAt(handoffId)).toBeNull();
    expect(fixture.fetchEvents(handoffId)).toBe(0);
  });

  it("refuses an owned-outside symlinked leaf without settling or serving outside bytes", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111f3";
    const leaf = placeHealthyArtifact(fixture, handoffId);
    const outside = outsideFile("secret.md");
    rmSync(leaf);
    symlinkSync(outside, leaf);
    const fetched = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, handoffId);
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(fixture.firstFetchedAt(handoffId)).toBeNull();
    expect(fixture.fetchEvents(handoffId)).toBe(0);
  });

  it("refuses a symlinked managed parent", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111f4";
    const leaf = placeHealthyArtifact(fixture, handoffId);
    const parent = dirname(leaf);
    const outsideDir = mkdtempSync(join(tmpdir(), "sorage-serving-parent-"));
    cleanups.push(() => rmSync(outsideDir, { recursive: true, force: true }));
    mkdirSync(join(outsideDir, handoffId), { recursive: true });
    writeFileSync(join(outsideDir, handoffId, "doc.md"), "outside parent bytes");
    rmSync(parent, { recursive: true, force: true });
    symlinkSync(join(outsideDir, handoffId), parent);
    const fetched = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, handoffId);
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(fixture.fetchEvents(handoffId)).toBe(0);
  });

  it("refuses a dangling leaf symlink and a special or directory leaf within bounded time", () => {
    const fixture = makeFixture();
    const dangling = "11111111-1111-4111-8111-1111111111f5";
    const danglingLeaf = placeHealthyArtifact(fixture, dangling);
    rmSync(danglingLeaf);
    symlinkSync(join(fixture.vaultPath, "artifacts", dangling, "nowhere.md"), danglingLeaf);
    const fetchedDangling = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, dangling);
    expect(fetchedDangling.ok).toBe(false);
    if (fetchedDangling.ok) return;
    expect(fetchedDangling.error.code).toBe("ARTIFACT_CORRUPTED");

    const special = "11111111-1111-4111-8111-1111111111f6";
    const specialLeaf = placeHealthyArtifact(fixture, special);
    rmSync(specialLeaf);
    const fifo = spawnSync("mkfifo", [specialLeaf]);
    expect(fifo.status).toBe(0);
    const fetchedSpecial = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, special);
    expect(fetchedSpecial.ok).toBe(false);
    if (fetchedSpecial.ok) return;
    expect(fetchedSpecial.error.code).toBe("ARTIFACT_CORRUPTED");

    const directory = "11111111-1111-4111-8111-1111111111f7";
    const directoryLeaf = placeHealthyArtifact(fixture, directory);
    rmSync(directoryLeaf);
    mkdirSync(directoryLeaf);
    const fetchedDirectory = fetchHandoff(fixture.ports, USER_ACTOR_INPUT, directory);
    expect(fetchedDirectory.ok).toBe(false);
    if (fetchedDirectory.ok) return;
    expect(fetchedDirectory.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(fixture.fetchEvents(special)).toBe(0);
  });

  it("keeps the selected root alias a legitimate serving configuration", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111f8";
    placeHealthyArtifact(fixture, handoffId);
    const realRoot = fixture.vaultPath;
    const aliasParent = mkdtempSync(join(tmpdir(), "sorage-serving-alias-"));
    cleanups.push(() => rmSync(aliasParent, { recursive: true, force: true }));
    const alias = join(aliasParent, "vault-alias");
    symlinkSync(realRoot, alias);
    const aliasedPorts: HandoffDetailReadPorts = {
      ...fixture.ports,
      config: { vaultPath: alias, verifyChecksumOnFetch: false },
      artifact: createArtifactBodyPorts({
        db: fixture.db,
        vaultPath: alias,
        installationId: INSTALLATION,
        stateDir: fixture.stateDir,
      }),
    };
    const fetched = fetchHandoff(aliasedPorts, USER_ACTOR_INPUT, handoffId);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(readFileSync(fetched.value.localPath, "utf8")).toBe(BODY.toString("utf8"));
  });

  it("keeps the existing if-configured checksum policy: default false serves, true verifies", () => {
    const permissive = makeFixture();
    const tampered = "11111111-1111-4111-8111-1111111111f9";
    const leaf = placeHealthyArtifact(permissive, tampered);
    chmodSync(leaf, 0o644);
    writeFileSync(leaf, "tampered bytes");
    chmodSync(leaf, 0o444);
    const served = fetchHandoff(permissive.ports, USER_ACTOR_INPUT, tampered);
    expect(served.ok).toBe(true);

    const strict = makeFixture({ verifyChecksumOnFetch: true });
    const mismatched = "11111111-1111-4111-8111-1111111111fa";
    const strictLeaf = placeHealthyArtifact(strict, mismatched);
    chmodSync(strictLeaf, 0o644);
    writeFileSync(strictLeaf, "tampered bytes");
    chmodSync(strictLeaf, 0o444);
    const refused = fetchHandoff(strict.ports, USER_ACTOR_INPUT, mismatched);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(strict.fetchEvents(mismatched)).toBe(0);
  });
});

describe("the ArtifactStore serving handle and hardened pathOf", () => {
  it("keeps non-managed key syntax on the existing INTERNAL_ERROR family", () => {
    const fixture = makeFixture();
    const store = fixture.artifactStore;
    for (const key of ["../escape", "/absolute", "content/memo/x/y", "artifacts/h/a", "artifacts/h/a/.."]) {
      const resolved = store.pathOf(key);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.error.code).toBe("INTERNAL_ERROR");
      const opened = store.openReadable(key);
      expect(opened.ok).toBe(false);
      if (opened.ok) continue;
      expect(opened.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("honors the bounded read contract and honest close ownership", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111fb";
    const key = placeHealthyArtifact(fixture, handoffId).slice(fixture.vaultPath.length + 1);
    const opened = fixture.artifactStore.openReadable(key);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const handle = opened.value;
    expect(handle.sizeBytes).toBe(BODY.byteLength);
    const whole = handle.read(0, 1024 * 1024);
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(Buffer.from(whole.value).equals(BODY)).toBe(true);
    const beyond = handle.read(BODY.byteLength, 1024);
    expect(beyond.ok).toBe(true);
    if (!beyond.ok) return;
    expect(beyond.value.byteLength).toBe(0);
    handle.close();
    handle.close();
    const afterClose = handle.read(0, 1024);
    expect(afterClose.ok).toBe(false);
    if (afterClose.ok) return;
    expect(afterClose.error.code).toBe("ARTIFACT_CORRUPTED");
  });

  it("disposes the descriptor on an early end and keeps the typed corruption error", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111fe";
    const key = placeHealthyArtifact(fixture, handoffId).slice(fixture.vaultPath.length + 1);
    const opened = fixture.artifactStore.openReadable(key);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const handle = opened.value;
    // Shrink the file after the handle recorded its fstat size: the bounded
    // reader reaches the real end before the recorded size and must fail with
    // the typed corruption error and dispose the descriptor.
    const leaf = join(fixture.vaultPath, key);
    chmodSync(leaf, 0o644);
    writeFileSync(leaf, "tiny");
    chmodSync(leaf, 0o444);
    const truncated = handle.read(0, 1024 * 1024);
    expect(truncated.ok).toBe(false);
    if (truncated.ok) return;
    expect(truncated.error.code).toBe("ARTIFACT_CORRUPTED");
    const afterDispose = handle.read(0, 1024 * 1024);
    expect(afterDispose.ok).toBe(false);
    if (afterDispose.ok) return;
    expect(afterDispose.error.code).toBe("ARTIFACT_CORRUPTED");
    // The disposed descriptor cannot be read again: the error is the closed
    // ownership verdict, never a stale byte.
    expect(afterDispose.error.message).toContain("closed");
  });

  it("refuses an unmaterialized record with ARTIFACT_MATERIALIZING before acquisition", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111fc";
    fixture.seed(handoffId, { materialized: false });
    const prepared = prepareHandoffFetch(fixture.ports, USER_ACTOR_INPUT, handoffId, { kind: "body" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("ARTIFACT_MATERIALIZING");
    expect(fixture.fetchEvents(handoffId)).toBe(0);
  });

  it("serves the prepared body variant from the same opened descriptor", () => {
    const fixture = makeFixture();
    const handoffId = "11111111-1111-4111-8111-1111111111fd";
    placeHealthyArtifact(fixture, handoffId);
    const prepared = prepareHandoffFetch(fixture.ports, USER_ACTOR_INPUT, handoffId, { kind: "body" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    if (prepared.value.kind !== "body") {
      prepared.value.close();
      throw new Error("the prepared fetch did not carry a body handle");
    }
    const chunks: Buffer[] = [];
    let position = 0;
    for (;;) {
      const read = prepared.value.body.read(position, 1024 * 1024);
      expect(read.ok).toBe(true);
      if (!read.ok) break;
      if (read.value.byteLength === 0) break;
      chunks.push(Buffer.from(read.value));
      position += read.value.byteLength;
    }
    prepared.value.body.close();
    expect(Buffer.concat(chunks).equals(BODY)).toBe(true);
    expect(fixture.fetchEvents(handoffId)).toBe(0);
  });
});
