import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@sorage/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { FakeClock } from "../../src/testkit/fakes";
import {
  copyFixtureTreeToTempVault,
  seedPrimaryInstallation,
  TASK165_FIXTURE_ROOT,
  TASK165_TIMES,
} from "../fixtures/task165-snapshot-seeder";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function unwrap<T>(result: core.Result<T>, context: string): T {
  if (!result.ok) throw new Error(`${context}: ${result.error.code} ${result.error.message}`);
  return result.value;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "TASK165",
      GIT_AUTHOR_EMAIL: "task165@example.test",
      GIT_COMMITTER_NAME: "TASK165",
      GIT_COMMITTER_EMAIL: "task165@example.test",
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TASK-165 Step 4 single-pass verify and restore call counts", () => {
  it("parses manifest once, parses each events.jsonl line once, and validates once during backupVerify", () => {
    const root = makeTempDir("sorage-task165-sp-verify-");
    const home = join(root, "home");
    const vault = join(root, "vault");
    seedPrimaryInstallation(home, vault);
    const ports = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      clock: new FakeClock(Date.parse(TASK165_TIMES.base)),
    });
    unwrap(core.exportSnapshot(unwrap(ports.exportPorts(), "exportPorts")), "exportSnapshot");
    git(vault, "init", "-b", "main");
    git(vault, "config", "core.autocrlf", "false");
    git(vault, "add", "--", ".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "content", "snapshots");
    git(vault, "commit", "-m", "initial snapshot");

    const eventLines = readFileSync(join(vault, "snapshots", "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    const eventLineSet = new Set(eventLines);

    const manifestSpy = vi.spyOn(core, "parseVersionedSnapshotManifest");
    const openExchangeSpy = vi.spyOn(core, "openExchangeSnapshot");
    const validateSnapshotSpy = vi.spyOn(core, "validateSnapshot");
    const validateExchangeSpy = vi.spyOn(core, "validateExchangeInventory");
    const jsonParseSpy = vi.spyOn(JSON, "parse");

    const verifyPorts = unwrap(ports.verifyPorts(), "verifyPorts");
    const report = unwrap(core.backupVerify(verifyPorts, { now: new Date(TASK165_TIMES.t15) }), "backupVerify");
    expect(report.findings).toEqual([]);
    expect(report.checked.manifest.present).toBe(true);
    expect(report.checked.manifest.events).toBe(eventLines.length);

    expect(manifestSpy).toHaveBeenCalledTimes(1);
    expect(openExchangeSpy).toHaveBeenCalledTimes(1);
    expect(validateSnapshotSpy).toHaveBeenCalledTimes(1);
    // Format-5 validation inside openExchangeSnapshot already validated Exchanges; validateSnapshot runs on V4 base.
    expect(validateExchangeSpy).toHaveBeenCalledTimes(0);

    const eventLineParses = jsonParseSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && eventLineSet.has(call[0]),
    );
    expect(eventLineParses).toHaveLength(eventLines.length);
  });

  it("parses manifest once, parses each events.jsonl line once, and validates once during backupRestore (Format 5 and Format 1)", () => {
    for (const format of ["formats/v5", "formats/v1"] as const) {
      for (const dryRun of [true, false] as const) {
        const srcRoot = makeTempDir(`sorage-task165-sp-src-${format.replace("/", "-")}-`);
        const sourceVault = join(srcRoot, "vault");
        copyFixtureTreeToTempVault(join(TASK165_FIXTURE_ROOT, format), sourceVault, { artifactMode: 0o644 });

        const targetRoot = makeTempDir(`sorage-task165-sp-dst-${format.replace("/", "-")}-`);
        const targetHome = join(targetRoot, "home");
        const targetVault = join(targetRoot, "vault");
        unwrap(
          core.initializeInstallation(
            createNodeInitPorts({
              env: { SORAGE_HOME: targetHome },
              userHome: targetHome,
              clock: new FakeClock(Date.parse(TASK165_TIMES.t15)),
            }),
            { vaultPath: targetVault },
          ),
          "init target",
        );

        const eventLines = readFileSync(join(sourceVault, "snapshots", "events.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line !== "");
        const eventLineSet = new Set(eventLines);

        const manifestSpy = vi.spyOn(core, "parseVersionedSnapshotManifest");
        const openExchangeSpy = vi.spyOn(core, "openExchangeSnapshot");
        const validateSnapshotSpy = vi.spyOn(core, "validateSnapshot");
        const validateExchangeSpy = vi.spyOn(core, "validateExchangeInventory");
        const jsonParseSpy = vi.spyOn(JSON, "parse");

        const restorePorts = unwrap(
          createNodeBackupCommandPorts({
            env: { SORAGE_HOME: targetHome },
            userHome: targetHome,
            sourcePath: sourceVault,
            clock: new FakeClock(Date.parse(TASK165_TIMES.t15)),
          }).restorePorts(),
          "restorePorts",
        );
        expect(restorePorts.readValidatedSourceSnapshot).toBeDefined();
        const readSnapshotSpy = vi.spyOn(restorePorts, "readSourceSnapshot");
        const readManifestSpy = vi.spyOn(restorePorts, "readSourceManifest");
        const readValidatedSpy = vi.spyOn(
          restorePorts as Required<Pick<core.BackupRestorePorts, "readValidatedSourceSnapshot">>,
          "readValidatedSourceSnapshot",
        );

        const outcome = unwrap(core.backupRestore(restorePorts, { dryRun }), `restore ${format} dryRun=${dryRun}`);
        expect(outcome.dryRun).toBe(dryRun);

        expect(readValidatedSpy).toHaveBeenCalledTimes(1);
        expect(readSnapshotSpy).toHaveBeenCalledTimes(0);
        expect(readManifestSpy).toHaveBeenCalledTimes(0);
        expect(manifestSpy).toHaveBeenCalledTimes(1);
        expect(openExchangeSpy).toHaveBeenCalledTimes(format === "formats/v5" ? 1 : 0);
        expect(validateSnapshotSpy).toHaveBeenCalledTimes(1);
        expect(validateExchangeSpy).toHaveBeenCalledTimes(0);

        const eventLineParses = jsonParseSpy.mock.calls.filter(
          (call) => typeof call[0] === "string" && eventLineSet.has(call[0]),
        );
        expect(eventLineParses).toHaveLength(eventLines.length);

        vi.restoreAllMocks();
      }
    }
  });
});
