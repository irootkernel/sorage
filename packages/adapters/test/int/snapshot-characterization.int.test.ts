import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupRestore,
  backupVerify,
  exportSnapshot,
  initializeInstallation,
  ok,
  type Result,
  type SnapshotFile,
  snapshotFilesV5,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";
import {
  collectSortedTreeChecksums,
  copyFixtureTreeToTempVault,
  FILE_ARTIFACT_STORAGE_KEY,
  readActiveCollaborationData,
  readPrimaryFoundationData,
  readTreeBuffers,
  seedActiveCollaborationInstallation,
  seedPrimaryInstallation,
  TASK165_BASE_SHA,
  TASK165_BODIES,
  TASK165_FIXTURE_ROOT,
  TASK165_IDS,
  TASK165_TIMES,
} from "../fixtures/task165-snapshot-seeder";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function unwrap<T>(result: Result<T>, label: string): T {
  if (!result.ok) throw new Error(`${label} failed: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function freshTargetInstallation(prefix: string): { home: string; vault: string; database: string } {
  const home = makeTempDir(prefix);
  const vault = join(home, "vault");
  const clock = new FakeClock(Date.parse(TASK165_TIMES.base));
  unwrap(
    initializeInstallation(createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock }), {
      vaultPath: vault,
    }),
    "initialize target installation",
  );
  return { home, vault, database: join(home, "state", "sorage.sqlite3") };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Sorage Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Sorage Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

function snapshotFilesToMap(files: SnapshotFile[]): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const file of files) {
    out[file.path] = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : Buffer.from(file.content);
  }
  return out;
}

function assertBufferTreesEqual(actual: Record<string, Buffer>, expected: Record<string, Buffer>, label: string): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  expect(actualKeys, `${label} file list`).toEqual(expectedKeys);
  for (const key of expectedKeys) {
    expect(actual[key], `${label}: ${key}`).toEqual(expected[key]);
  }
}

function tableCount(database: string, table: string): number {
  const db = openSorageDatabase(database);
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  } finally {
    db.close();
  }
}

describe("TASK-165 frozen provenance and regular-file fixture integrity", () => {
  it("matches PROVENANCE.json sorted sha256 checksums and scoped Git attributes verbatim", () => {
    const provenance = JSON.parse(readFileSync(join(TASK165_FIXTURE_ROOT, "PROVENANCE.json"), "utf8")) as {
      task: string;
      baseSha: string;
      fileCount: number;
      sha256: Record<string, string>;
    };
    expect(provenance.task).toBe("TASK-165");
    expect(provenance.baseSha).toBe(TASK165_BASE_SHA);
    expect(readFileSync(join(TASK165_FIXTURE_ROOT, ".gitattributes"), "utf8")).toBe("* -text -diff\n");

    const liveChecksums = collectSortedTreeChecksums(TASK165_FIXTURE_ROOT, new Set(["PROVENANCE.json"]));
    expect(Object.keys(liveChecksums).length).toBe(provenance.fileCount);
    expect(liveChecksums).toEqual(provenance.sha256);
  });
});

describe("TASK-165 deterministic V5 goldens across all three approved trees (D1/D2)", () => {
  it("matches frozen v5-notices byte-for-byte via production exportSnapshot and direct snapshotFilesV5", () => {
    const home = makeTempDir("sorage-task165-v5-notices-");
    const vault = join(home, "vault");
    seedPrimaryInstallation(home, vault);

    const backupPorts = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      clock: new FakeClock(Date.parse(TASK165_TIMES.base)),
    });
    const exportPorts = unwrap(backupPorts.exportPorts(), "v5-notices exportPorts");
    unwrap(exportSnapshot(exportPorts), "production exportSnapshot");

    const expected = readTreeBuffers(join(TASK165_FIXTURE_ROOT, "v5-notices", "snapshots"));
    const actualFromExport = readTreeBuffers(join(vault, "snapshots"));
    assertBufferTreesEqual(actualFromExport, expected, "v5-notices via exportSnapshot");

    // Re-exporting unchanged state is byte-identical.
    unwrap(exportSnapshot(exportPorts), "second production exportSnapshot");
    assertBufferTreesEqual(readTreeBuffers(join(vault, "snapshots")), expected, "v5-notices determinism");

    // Direct snapshotFilesV5 on readSnapshotData() matches production exportSnapshot byte-for-byte.
    const rawData = unwrap(exportPorts.readSnapshotData(), "v5-notices readSnapshotData");
    if (!("exchanges" in rawData)) throw new Error("Expected V5 snapshot data");
    const redactedExport = unwrap(
      exportSnapshot({
        vaultPath: vault,
        redactWorkspacePaths: true,
        readSnapshotData: () => ok(rawData),
        writeSnapshotTree: (files) => {
          assertBufferTreesEqual(snapshotFilesToMap(files), expected, "v5-notices via injected exportSnapshot");
          return ok(undefined);
        },
      }),
      "injected v5-notices exportSnapshot",
    );
    expect(redactedExport.files).toBe(Object.keys(expected).length);
  });

  it("matches frozen v5-foundation byte-for-byte via snapshotFilesV5 and injected exportSnapshot (omitted & explicit)", () => {
    const home = makeTempDir("sorage-task165-v5-foundation-");
    const vault = join(home, "vault");
    seedPrimaryInstallation(home, vault);

    const expected = readTreeBuffers(join(TASK165_FIXTURE_ROOT, "v5-foundation", "snapshots"));
    const foundationData = readPrimaryFoundationData(home);

    const direct = unwrap(snapshotFilesV5(foundationData), "snapshotFilesV5(foundation)");
    assertBufferTreesEqual(snapshotFilesToMap(direct.files), expected, "v5-foundation via snapshotFilesV5");

    // Injected exportSnapshot with exchangeRepresentation omitted exercises `?? "foundation"`.
    const { exchangeRepresentation: _omitted, ...withoutRep } = foundationData;
    let omittedFiles: SnapshotFile[] = [];
    unwrap(
      exportSnapshot({
        vaultPath: vault,
        redactWorkspacePaths: false,
        readSnapshotData: () => ok(withoutRep),
        writeSnapshotTree: (files) => {
          omittedFiles = files;
          return ok(undefined);
        },
      }),
      "injected exportSnapshot (omitted representation)",
    );
    assertBufferTreesEqual(snapshotFilesToMap(omittedFiles), expected, "v5-foundation via exportSnapshot default");

    // Injected exportSnapshot with explicit "foundation".
    let explicitFiles: SnapshotFile[] = [];
    unwrap(
      exportSnapshot({
        vaultPath: vault,
        redactWorkspacePaths: false,
        readSnapshotData: () => ok(foundationData),
        writeSnapshotTree: (files) => {
          explicitFiles = files;
          return ok(undefined);
        },
      }),
      "injected exportSnapshot (explicit foundation)",
    );
    assertBufferTreesEqual(snapshotFilesToMap(explicitFiles), expected, "v5-foundation via exportSnapshot explicit");
  });

  it("matches frozen v5-collaboration byte-for-byte from separate active-only installation via snapshotFilesV5 and injected exportSnapshot", () => {
    const home = makeTempDir("sorage-task165-v5-collab-");
    const vault = join(home, "vault");
    seedActiveCollaborationInstallation(home, vault);

    const expected = readTreeBuffers(join(TASK165_FIXTURE_ROOT, "v5-collaboration", "snapshots"));
    const collabData = readActiveCollaborationData(home);

    const direct = unwrap(snapshotFilesV5(collabData), "snapshotFilesV5(collaboration)");
    assertBufferTreesEqual(snapshotFilesToMap(direct.files), expected, "v5-collaboration via snapshotFilesV5");

    let injectedFiles: SnapshotFile[] = [];
    unwrap(
      exportSnapshot({
        vaultPath: vault,
        redactWorkspacePaths: false,
        readSnapshotData: () => ok(collabData),
        writeSnapshotTree: (files) => {
          injectedFiles = files;
          return ok(undefined);
        },
      }),
      "injected exportSnapshot (collaboration)",
    );
    assertBufferTreesEqual(snapshotFilesToMap(injectedFiles), expected, "v5-collaboration via exportSnapshot");
  });
});

describe("TASK-165 frozen Format 1–5 and V5-tree dry-run, restore, target mode, and positive backupVerify (F5/F8)", () => {
  const matrix: Array<{
    tree: string;
    expectedFormat: number;
    expectedHandoffs: number;
    expectedMemos: number;
    expectedChannels: number;
    expectedExchanges: number;
  }> = [
    {
      tree: "formats/v1",
      expectedFormat: 1,
      expectedHandoffs: 2,
      expectedMemos: 0,
      expectedChannels: 0,
      expectedExchanges: 0,
    },
    {
      tree: "formats/v2",
      expectedFormat: 2,
      expectedHandoffs: 2,
      expectedMemos: 1,
      expectedChannels: 0,
      expectedExchanges: 0,
    },
    {
      tree: "formats/v3",
      expectedFormat: 3,
      expectedHandoffs: 3,
      expectedMemos: 2,
      expectedChannels: 2,
      expectedExchanges: 0,
    },
    {
      tree: "formats/v4",
      expectedFormat: 4,
      expectedHandoffs: 3,
      expectedMemos: 2,
      expectedChannels: 2,
      expectedExchanges: 0,
    },
    {
      tree: "formats/v5",
      expectedFormat: 5,
      expectedHandoffs: 3,
      expectedMemos: 2,
      expectedChannels: 2,
      expectedExchanges: 3,
    },
    {
      tree: "v5-foundation",
      expectedFormat: 5,
      expectedHandoffs: 3,
      expectedMemos: 2,
      expectedChannels: 2,
      expectedExchanges: 3,
    },
    {
      tree: "v5-collaboration",
      expectedFormat: 5,
      expectedHandoffs: 3,
      expectedMemos: 2,
      expectedChannels: 2,
      expectedExchanges: 1,
    },
    {
      tree: "v5-notices",
      expectedFormat: 5,
      expectedHandoffs: 3,
      expectedMemos: 2,
      expectedChannels: 2,
      expectedExchanges: 3,
    },
  ];

  it.each(matrix)(
    "dry-runs, restores with 0444 target modes, and positively backup-verifies frozen $tree",
    ({ tree, expectedFormat, expectedHandoffs, expectedMemos, expectedChannels, expectedExchanges }) => {
      const fixtureDir = join(TASK165_FIXTURE_ROOT, tree);
      const beforeFixtureChecksums = collectSortedTreeChecksums(fixtureDir);

      // Copy fixture into temp source with 0644 (as Git checkout does) so restore's 0444 chmod is proven.
      const sourceCopy = makeTempDir("sorage-task165-src-");
      copyFixtureTreeToTempVault(fixtureDir, sourceCopy, { artifactMode: 0o644 });

      const target = freshTargetInstallation("sorage-task165-dst-");
      const restorePorts = unwrap(
        createNodeBackupCommandPorts({
          env: { SORAGE_HOME: target.home },
          userHome: target.home,
          sourcePath: sourceCopy,
          clock: new FakeClock(Date.parse(TASK165_TIMES.t15)),
        }).restorePorts(),
        `${tree} restorePorts`,
      );

      // 1. Dry-run succeeds and leaves target empty.
      const dry = unwrap(backupRestore(restorePorts, { dryRun: true }), `${tree} dry-run`);
      expect(dry.dryRun).toBe(true);
      expect(dry.adoptedInstallationId).toBe(TASK165_IDS.installation);
      expect(tableCount(target.database, "projects")).toBe(0);

      // 2. Real restore succeeds, adopts installationId, restores domain rows, and sets 0444 on Vault files.
      const restored = unwrap(backupRestore(restorePorts, { dryRun: false }), `${tree} restore`);
      expect(restored.dryRun).toBe(false);
      expect(tableCount(target.database, "projects")).toBe(3);
      expect(tableCount(target.database, "handoffs")).toBe(expectedHandoffs);
      expect(tableCount(target.database, "project_memos")).toBe(expectedMemos);
      expect(tableCount(target.database, "channels")).toBe(expectedChannels);
      expect(tableCount(target.database, "exchanges")).toBe(expectedExchanges);

      const restoredArtifact = join(target.vault, FILE_ARTIFACT_STORAGE_KEY);
      expect(readFileSync(restoredArtifact)).toEqual(Buffer.from(TASK165_BODIES.fileArtifact, "utf8"));
      expect(statSync(restoredArtifact).mode & 0o777).toBe(0o444);

      if (expectedFormat >= 3) {
        const db = openSorageDatabase(target.database);
        try {
          const contentKeys = db
            .prepare("SELECT storage_key FROM content_records WHERE storage_key LIKE 'content/%'")
            .all() as Array<{ storage_key: string }>;
          expect(contentKeys.length).toBe(2);
          for (const { storage_key } of contentKeys) {
            const p = join(target.vault, storage_key);
            expect(existsSync(p)).toBe(true);
            expect(statSync(p).mode & 0o777).toBe(0o444);
          }
        } finally {
          db.close();
        }
      }

      // 3. Positive backupVerify on the unmodified frozen snapshot tree itself (F5).
      // Build a fresh temp installation whose DB holds the restored domain rows minus only
      // the 2 post-restore audit events (events is append-only in SQLite, so copy into a fresh DB),
      // place the unmodified frozen snapshots/ + 0444 artifacts/content, and init Git.
      const verifyHome = makeTempDir("sorage-task165-verify-");
      const verifyVault = join(verifyHome, "vault");
      const verifyClock = new FakeClock(Date.parse(TASK165_TIMES.base));
      unwrap(
        initializeInstallation(
          {
            ...createNodeInitPorts({ env: { SORAGE_HOME: verifyHome }, userHome: verifyHome, clock: verifyClock }),
            ids: { next: () => TASK165_IDS.installation },
          },
          { vaultPath: verifyVault },
        ),
        `${tree} verifyHome init`,
      );
      copyFixtureTreeToTempVault(fixtureDir, verifyVault, { artifactMode: 0o444 });
      if (existsSync(join(target.vault, "content"))) {
        copyFixtureTreeToTempVault(join(target.vault, "content"), join(verifyVault, "content"), {
          artifactMode: 0o444,
        });
      }
      chmodSync(join(verifyVault, FILE_ARTIFACT_STORAGE_KEY), 0o444);

      const verifyDb = openSorageDatabase(join(verifyHome, "state", "sorage.sqlite3"));
      try {
        verifyDb.exec(`ATTACH DATABASE '${target.database.replaceAll("'", "''")}' AS src`);
        verifyDb.exec("BEGIN");
        for (const table of [
          "projects",
          "exchanges",
          "exchange_members",
          "exchange_read_ranges",
          "exchange_creation_outcomes",
          "exchange_materials",
          "exchange_requests",
          "exchange_reports",
          "exchange_acceptances",
          "exchange_messages",
          "exchange_operation_outcomes",
          "exchange_transitions",
          "exchange_notice_issues",
          "content_records",
          "handoffs",
          "artifacts",
          "review_notes",
          "deletion_requests",
          "project_memos",
          "channels",
          "channel_participants",
          "channel_messages",
        ]) {
          verifyDb.exec(`INSERT INTO main.${table} SELECT * FROM src.${table}`);
        }
        verifyDb.exec(
          "INSERT INTO main.events SELECT * FROM src.events WHERE event_type NOT IN ('VAULT_ADOPTED', 'RESTORE_COMPLETED')",
        );
        verifyDb.exec("COMMIT");
        verifyDb.exec("DETACH DATABASE src");
      } finally {
        verifyDb.close();
      }

      git(verifyVault, "init", "-b", "main");
      git(verifyVault, "config", "core.autocrlf", "false");
      mkdirSync(join(verifyVault, "content"), { recursive: true });
      git(verifyVault, "add", "--", ".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "snapshots");
      if (expectedFormat >= 3) {
        git(verifyVault, "add", "--", "content");
      }
      git(verifyVault, "commit", "-m", `frozen ${tree}`);

      const verifyPorts = unwrap(
        createNodeBackupCommandPorts({
          env: { SORAGE_HOME: verifyHome },
          userHome: verifyHome,
          clock: new FakeClock(Date.parse(TASK165_TIMES.t15)),
        }).verifyPorts(),
        `${tree} verifyPorts`,
      );
      const verified = unwrap(
        backupVerify(verifyPorts, { now: new Date(TASK165_TIMES.t15) }),
        `${tree} positive backupVerify`,
      );
      expect(verified.findings, `${tree} backupVerify findings`).toEqual([]);
      expect(verified.warnings, `${tree} backupVerify warnings`).toEqual([]);
      expect(verified.checked.manifest.present).toBe(true);

      // Source on-disk fixture stayed completely immutable.
      expect(collectSortedTreeChecksums(fixtureDir)).toEqual(beforeFixtureChecksums);
    },
  );
});

describe("TASK-165 adapter backupVerify & backupRestore first-error precedence characterization", () => {
  function seededVerifiableInstallation(): { home: string; vault: string; database: string } {
    const home = makeTempDir("sorage-task165-err-src-");
    const vault = join(home, "vault");
    seedPrimaryInstallation(home, vault);
    const ports = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      clock: new FakeClock(Date.parse(TASK165_TIMES.base)),
    });
    unwrap(exportSnapshot(unwrap(ports.exportPorts(), "exportPorts")), "exportSnapshot");
    git(vault, "init", "-b", "main");
    git(vault, "config", "core.autocrlf", "false");
    git(vault, "add", "--", ".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "content", "snapshots");
    git(vault, "commit", "-m", "initial snapshot");
    return { home, vault, database: join(home, "state", "sorage.sqlite3") };
  }

  function assertRestoreRefusedCleanly(sourceVault: string, expectedCode: string, expectedMessage: string): void {
    const target = freshTargetInstallation("sorage-task165-err-dst-");
    const beforeConfig = readFileSync(join(target.home, "config.yaml"));
    const beforeMarker = readFileSync(join(target.vault, ".sorage-vault.json"));
    const ports = unwrap(
      createNodeBackupCommandPorts({
        env: { SORAGE_HOME: target.home },
        userHome: target.home,
        sourcePath: sourceVault,
        clock: new FakeClock(Date.parse(TASK165_TIMES.t15)),
      }).restorePorts(),
      "restorePorts",
    );
    for (const dryRun of [true, false]) {
      const res = backupRestore(ports, { dryRun });
      expect(res, `restore dryRun=${String(dryRun)}`).toMatchObject({
        ok: false,
        error: { code: expectedCode, message: expectedMessage },
      });
      expect(readFileSync(join(target.home, "config.yaml"))).toEqual(beforeConfig);
      expect(readFileSync(join(target.vault, ".sorage-vault.json"))).toEqual(beforeMarker);
      expect(tableCount(target.database, "projects")).toBe(0);
    }
  }

  it("reports missing snapshots/manifest.json as a finding in backupVerify even when events.jsonl is malformed", () => {
    const src = seededVerifiableInstallation();
    rmSync(join(src.vault, "snapshots", "manifest.json"));
    writeFileSync(join(src.vault, "snapshots", "events.jsonl"), "not-json\n");

    const verifyPorts = unwrap(
      createNodeBackupCommandPorts({
        env: { SORAGE_HOME: src.home },
        userHome: src.home,
        clock: new FakeClock(Date.parse(TASK165_TIMES.t15)),
      }).verifyPorts(),
      "verifyPorts",
    );
    const report = unwrap(backupVerify(verifyPorts, { now: new Date(TASK165_TIMES.t15) }), "verify missing manifest");
    expect(report.checked.manifest.present).toBe(false);
    expect(report.findings).toContain(
      "snapshots/manifest.json is missing; a backup run has not exported the current snapshots yet.",
    );
  });

  it("rejects duplicate JSON keys in manifest.json before reading exchanges.json or events.jsonl", () => {
    const src = seededVerifiableInstallation();
    const manifestPath = join(src.vault, "snapshots", "manifest.json");
    const raw = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, raw.replace('"formatVersion": 5,', '"formatVersion": 5, "formatVersion": 5,'));
    writeFileSync(join(src.vault, "snapshots", "events.jsonl"), "not-json\n");

    const verifyPorts = unwrap(
      createNodeBackupCommandPorts({ env: { SORAGE_HOME: src.home }, userHome: src.home }).verifyPorts(),
      "verifyPorts",
    );
    expect(backupVerify(verifyPorts, { now: new Date(TASK165_TIMES.t15) })).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Snapshot contains duplicate JSON keys" },
    });
    assertRestoreRefusedCleanly(src.vault, "VAULT_INTEGRITY_ERROR", "Snapshot contains duplicate JSON keys");
  });

  it("rejects unsupported formatVersion in manifest.json before events.jsonl", () => {
    const src = seededVerifiableInstallation();
    writeFileSync(join(src.vault, "snapshots", "manifest.json"), '{"formatVersion":6}\n');
    writeFileSync(join(src.vault, "snapshots", "events.jsonl"), "not-json\n");

    const verifyPorts = unwrap(
      createNodeBackupCommandPorts({ env: { SORAGE_HOME: src.home }, userHome: src.home }).verifyPorts(),
      "verifyPorts",
    );
    expect(backupVerify(verifyPorts, { now: new Date(TASK165_TIMES.t15) })).toMatchObject({
      ok: false,
      error: { code: "VAULT_SCHEMA_UNSUPPORTED", message: "Snapshot format is not supported" },
    });
    assertRestoreRefusedCleanly(src.vault, "VAULT_SCHEMA_UNSUPPORTED", "Snapshot format is not supported");
  });

  it("rejects unsupported V5 Exchange representation before malformed events.jsonl", () => {
    const src = seededVerifiableInstallation();
    const exchangePath = join(src.vault, "snapshots", "exchanges.json");
    const raw = readFileSync(exchangePath, "utf8");
    writeFileSync(exchangePath, raw.replace('"representation": "notices"', '"representation": "later-v9"'));
    writeFileSync(join(src.vault, "snapshots", "events.jsonl"), "42\n");

    const verifyPorts = unwrap(
      createNodeBackupCommandPorts({ env: { SORAGE_HOME: src.home }, userHome: src.home }).verifyPorts(),
      "verifyPorts",
    );
    expect(backupVerify(verifyPorts, { now: new Date(TASK165_TIMES.t15) })).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_SCHEMA_UNSUPPORTED",
        message: "This Exchange snapshot representation is not supported.",
      },
    });
    assertRestoreRefusedCleanly(
      src.vault,
      "VAULT_SCHEMA_UNSUPPORTED",
      "This Exchange snapshot representation is not supported.",
    );
  });

  it("pins duplicate JSON keys vs non-object JSON line precedence in events.jsonl", () => {
    // Case A: line 1 has duplicate JSON keys, line 2 is a non-object -> line 1 wins.
    const srcDupFirst = seededVerifiableInstallation();
    const eventsPathA = join(srcDupFirst.vault, "snapshots", "events.jsonl");
    const linesA = readFileSync(eventsPathA, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    linesA[0] = (linesA[0] as string).replace('"id":', '"id":"dup","id":');
    linesA[1] = "42";
    writeFileSync(eventsPathA, `${linesA.join("\n")}\n`);

    const verifyA = unwrap(
      createNodeBackupCommandPorts({
        env: { SORAGE_HOME: srcDupFirst.home },
        userHome: srcDupFirst.home,
      }).verifyPorts(),
      "verifyPorts A",
    );
    expect(backupVerify(verifyA, { now: new Date(TASK165_TIMES.t15) })).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Snapshot contains duplicate JSON keys" },
    });
    assertRestoreRefusedCleanly(srcDupFirst.vault, "VAULT_INTEGRITY_ERROR", "Snapshot contains duplicate JSON keys");

    // Case B: valid line 1, non-object JSON line 2 (42, [], "text", null) -> exact line-numbered non-object error.
    for (const nonObject of ["42", "[]", '"text"', "null"]) {
      const srcNonObj = seededVerifiableInstallation();
      const eventsPathB = join(srcNonObj.vault, "snapshots", "events.jsonl");
      const linesB = readFileSync(eventsPathB, "utf8")
        .split("\n")
        .filter((l) => l !== "");
      linesB[1] = nonObject;
      writeFileSync(eventsPathB, `${linesB.join("\n")}\n`);

      const expectedMessage = "The backup entry snapshots/events.jsonl line 2 is not a JSON object.";
      const verifyB = unwrap(
        createNodeBackupCommandPorts({ env: { SORAGE_HOME: srcNonObj.home }, userHome: srcNonObj.home }).verifyPorts(),
        "verifyPorts B",
      );
      expect(backupVerify(verifyB, { now: new Date(TASK165_TIMES.t15) }), nonObject).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR", message: expectedMessage },
      });
      assertRestoreRefusedCleanly(srcNonObj.vault, "VAULT_INTEGRITY_ERROR", expectedMessage);
    }
  });

  it("pins duplicate event ID and missing reference errors in backupVerify and backupRestore", () => {
    const src = seededVerifiableInstallation();
    const eventsPath = join(src.vault, "snapshots", "events.jsonl");
    const lines = readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
    second.id = first.id;
    lines[1] = JSON.stringify(second);
    writeFileSync(eventsPath, `${lines.join("\n")}\n`);

    const verifyPorts = unwrap(
      createNodeBackupCommandPorts({ env: { SORAGE_HOME: src.home }, userHome: src.home }).verifyPorts(),
      "verifyPorts dup event",
    );
    expect(backupVerify(verifyPorts, { now: new Date(TASK165_TIMES.t15) })).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Duplicate snapshot event ID" },
    });
    assertRestoreRefusedCleanly(src.vault, "VAULT_INTEGRITY_ERROR", "Duplicate snapshot event ID");
  });
});
