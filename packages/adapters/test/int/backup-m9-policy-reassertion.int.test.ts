import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupVerify, initializeInstallation, runBackupOnce } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { inspectPreflight } from "../../src/preflight";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The TASK-109 M9 policy reassertion regression (VLT-024, SHR-011, P3-H2):
 * a legacy Vault with an EXISTING Git repository whose `.gitattributes`
 * predates M9 gains the two new managed content lines through the backup
 * run's writable setup — the guarded idempotent initializer — preserving
 * non-managed lines (including conflicting raw-path rules and Unicode/CRLF
 * comments) and order, making `git check-attr` show `-text -diff` unset for
 * both managed content paths, keeping the existing Git config bytes and
 * history prefix intact, and keeping read-only verify/preflight non-mutating.
 * A symlinked attributes path returns a typed INTERNAL_ERROR with no Git
 * staging after the failure.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/**
 * Creates a legacy Vault with an EXISTING Git repository, then degrades
 * `.gitattributes` to the pre-M9 three-line form with true conflicting
 * raw-path rules and Unicode/CRLF non-managed comments.
 */
function initializedLegacyGitHome(prefix: string): {
  home: string;
  vault: string;
  userHome: string;
  headBefore: string;
  configBefore: string;
} {
  const home = tempDir(prefix);
  process.env.SORAGE_HOME = home;
  const userHome = tempDir(`${prefix}-user-`);
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome, clock: new FakeClock() });
  const result = initializeInstallation(ports, { vaultPath: vault, initializeGit: true });
  if (!result.ok) throw new Error(result.error.message);
  // Create a pre-existing commit on the existing repository with test-local
  // identity, ensuring core.autocrlf=false is set.
  git(vault, "config", "core.autocrlf", "false");
  git(vault, "config", "user.email", "t@e.com");
  git(vault, "config", "user.name", "T");
  git(vault, "add", "--", ".sorage-vault.json", ".gitattributes", ".gitignore");
  git(vault, "commit", "-m", "pre-backup legacy commit");
  const headBefore = git(vault, "rev-parse", "HEAD").trim();
  const configBefore = readFileSync(join(vault, ".git", "config"), "utf8");
  // Degrade to pre-M9 three-line form with true conflicting raw-path rules
  // (broad `* text` plus explicit `content/** text diff` and
  // `snapshots/content/** text diff`) that would override the M9 managed
  // rules if not reasserted, plus Unicode/CRLF non-managed comments.
  writeFileSync(
    join(vault, ".gitattributes"),
    "*.bin binary\r\n" +
      "# Sorage managed attributes \u00e9\u3042\uD83D\uDE00\r\n" +
      "artifacts/** -text -diff\r\n" +
      "snapshots/** text eol=lf\r\n" +
      ".sorage-vault.json text eol=lf\r\n" +
      "# User custom: broad text\r\n" +
      "* text\r\n" +
      "content/** text diff\r\n" +
      "snapshots/content/** text diff\r\n",
    "utf8",
  );
  return { home, vault, userHome, headBefore, configBefore };
}

function runOnce(home: string, userHome: string) {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome });
  const runPorts = ports.runPorts("manual");
  if (!runPorts.ok) throw new Error(runPorts.error.message);
  return runBackupOnce(runPorts.value);
}

function verifyOnce(home: string, userHome: string) {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome });
  const verifyPorts = ports.verifyPorts();
  if (!verifyPorts.ok) throw new Error(verifyPorts.error.message);
  return backupVerify(verifyPorts.value, { now: new Date() });
}

describe("backup writable setup reasserts M9 .gitattributes on a legacy Vault with existing Git", () => {
  it("repairs pre-M9 attributes with conflicting rules, verify passes, effective check-attr is unset", () => {
    const { home, vault, userHome } = initializedLegacyGitHome("sorage-p3h-legacy-");
    // Read-only verify reports the missing lines before any correction.
    const before = verifyOnce(home, userHome);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.value.findings.some((f) => f.includes(".gitattributes is missing the required line"))).toBe(true);
    }
    // The pre-fix attrs have conflicting rules for content paths.
    const attrsBefore = readFileSync(join(vault, ".gitattributes"), "utf8");
    expect(attrsBefore).toContain("content/** text diff");
    expect(attrsBefore).toContain("snapshots/content/** text diff");
    // Effective Git check-attr before fix: text and diff ARE set (conflicting).
    const textBefore = git(vault, "check-attr", "text", "content/test/x.bin").trim();
    const diffBefore = git(vault, "check-attr", "diff", "snapshots/content/test/x.bin").trim();
    expect(textBefore).toContain("text: set");
    expect(diffBefore).toContain("diff: set");
    // Run the backup: the writable setup calls the initializer which re-asserts.
    const run = runOnce(home, userHome);
    expect(run.ok, run.ok ? "" : run.error.message).toBe(true);
    // The .gitattributes now carries all five managed lines plus preserved
    // non-managed content, with managed block after non-managed rules.
    const attrs = readFileSync(join(vault, ".gitattributes"), "utf8");
    const preserved = [
      "*.bin binary\r\n",
      "# Sorage managed attributes \u00e9\u3042\uD83D\uDE00\r\n",
      "# User custom: broad text\r\n",
      "* text\r\n",
      "content/** text diff\r\n",
      "snapshots/content/** text diff\r\n",
    ];
    for (const line of preserved) expect(attrs).toContain(line);
    const positions = preserved.map((line) => attrs.indexOf(line));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(attrs).toContain("*.bin binary");
    expect(attrs).toContain("artifacts/** -text -diff");
    expect(attrs).toContain("snapshots/** text eol=lf");
    expect(attrs).toContain(".sorage-vault.json text eol=lf");
    expect(attrs).toContain("# User custom: broad text");
    expect(attrs).toContain("content/** -text -diff");
    expect(attrs).toContain("snapshots/content/** -text -diff");
    // Non-managed Unicode comment preserved byte-exact.
    expect(attrs).toContain("# Sorage managed attributes \u00e9\u3042\uD83D\uDE00");
    // Managed block is after the conflicting custom rules.
    const customIdx = attrs.indexOf("content/** text diff");
    const managedIdx = attrs.indexOf("content/** -text -diff");
    expect(customIdx).toBeLessThan(managedIdx);
    // The content/ directory exists.
    expect(statSync(join(vault, "content")).isDirectory()).toBe(true);
    // Effective Git check-attr after fix: text and diff are UNSET for both
    // managed content paths — the later managed rules win.
    const textAfter = git(vault, "check-attr", "text", "content/test/x.bin").trim();
    const diffAfter = git(vault, "check-attr", "diff", "snapshots/content/test/x.bin").trim();
    expect(textAfter).toContain("text: unset");
    expect(diffAfter).toContain("diff: unset");
    expect(git(vault, "check-attr", "diff", "content/test/x.bin")).toContain("diff: unset");
    expect(git(vault, "check-attr", "text", "snapshots/content/test/x.bin")).toContain("text: unset");
    // Verify now passes without the missing-lines finding.
    const after = verifyOnce(home, userHome);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.findings).toEqual([]);
    }
  });

  it("is idempotent: a second run leaves the attrs byte-identical", () => {
    const { home, vault, userHome } = initializedLegacyGitHome("sorage-p3h-idem-");
    expect(runOnce(home, userHome).ok).toBe(true);
    const firstAttrs = readFileSync(join(vault, ".gitattributes"), "utf8");
    expect(runOnce(home, userHome).ok).toBe(true);
    const secondAttrs = readFileSync(join(vault, ".gitattributes"), "utf8");
    expect(secondAttrs).toBe(firstAttrs);
  });

  it("preserves the existing Git repository's full config bytes and history prefix", () => {
    const { home, vault, userHome, headBefore, configBefore } = initializedLegacyGitHome("sorage-p3h-git-");
    const run = runOnce(home, userHome);
    expect(run.ok).toBe(true);
    // Full .git/config bytes are unchanged.
    const configAfter = readFileSync(join(vault, ".git", "config"), "utf8");
    expect(configAfter).toBe(configBefore);
    // The pre-existing commit is still in history (ancestor of HEAD).
    const headAfter = git(vault, "rev-parse", "HEAD").trim();
    expect(headAfter).not.toBe(headBefore);
    expect(git(vault, "merge-base", "--is-ancestor", headBefore, headAfter)).toBe("");
    // The log contains the pre-existing commit.
    const log = git(vault, "log", "--oneline");
    expect(log).toContain("pre-backup legacy commit");
  });

  it("returns INTERNAL_ERROR for a symlinked .gitattributes with no Git staging after the failure", () => {
    const { home, vault, userHome, headBefore } = initializedLegacyGitHome("sorage-p3h-symlink-");
    // Replace .gitattributes with a symlink to an outside file.
    rmSync(join(vault, ".gitattributes"));
    const outsideTarget = join(userHome, "outside-attrs.txt");
    writeFileSync(outsideTarget, "outside data\r\n\u00e9\u3042\n");
    symlinkSync(outsideTarget, join(vault, ".gitattributes"));
    const beforeOutside = readFileSync(outsideTarget, "utf8");
    // The backup run's writable setup must fail through the initializer's
    // typed INTERNAL_ERROR; no Git staging or commit follows.
    const run = runOnce(home, userHome);
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe("INTERNAL_ERROR");
    }
    // The outside target is byte-identical.
    expect(readFileSync(outsideTarget, "utf8")).toBe(beforeOutside);
    // Git HEAD is unchanged — no commit was made after the failure.
    const headAfter = git(vault, "rev-parse", "HEAD").trim();
    expect(headAfter).toBe(headBefore);
  });

  it("keeps read-only verify and preflight non-mutating on a legacy Vault with existing Git", () => {
    const { home, vault, userHome } = initializedLegacyGitHome("sorage-p3h-ro-");
    const attrsBefore = readFileSync(join(vault, ".gitattributes"), "utf8");
    const headBefore = git(vault, "rev-parse", "HEAD").trim();
    // Verify reports the missing lines but does not write.
    const verified = verifyOnce(home, userHome);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value.findings.some((f) => f.includes(".gitattributes is missing the required line"))).toBe(true);
    }
    expect(readFileSync(join(vault, ".gitattributes"), "utf8")).toBe(attrsBefore);
    expect(git(vault, "rev-parse", "HEAD").trim()).toBe(headBefore);
    // Preflight follows its existing behavior and does not write attrs.
    const preflightHome = tempDir("sorage-p3h-preflight-");
    const preflightUser = tempDir("sorage-p3h-preflight-user-");
    const preflightVault = join(preflightHome, "vault");
    const preflightPorts = createNodeInitPorts({
      env: { SORAGE_HOME: preflightHome },
      userHome: preflightUser,
      clock: new FakeClock(),
    });
    const preflightInit = initializeInstallation(preflightPorts, { vaultPath: preflightVault });
    if (!preflightInit.ok) throw new Error(preflightInit.error.message);
    writeFileSync(join(preflightVault, ".gitattributes"), "artifacts/** -text -diff\nsnapshots/** text eol=lf\n");
    const preflightAttrsBefore = readFileSync(join(preflightVault, ".gitattributes"), "utf8");
    process.env.SORAGE_HOME = preflightHome;
    inspectPreflight(preflightHome);
    expect(readFileSync(join(preflightVault, ".gitattributes"), "utf8")).toBe(preflightAttrsBefore);
  });

  it("calls prepareWritableContent directly on a no-Git fixture: outside canary and existing policy files unchanged", () => {
    const home = tempDir("sorage-p3h-scope-");
    process.env.SORAGE_HOME = home;
    const userHome = tempDir("sorage-p3h-scope-user-");
    const vault = join(home, "vault");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome, clock: new FakeClock() });
    const result = initializeInstallation(ports, { vaultPath: vault });
    if (!result.ok) throw new Error(result.error.message);
    // Record pre-call state: the initializer already wrote the full M9 policy,
    // so this call should be a no-op — no file changes at all.
    const attrsBefore = readFileSync(join(vault, ".gitattributes"), "utf8");
    const gitignoreBefore = readFileSync(join(vault, ".gitignore"), "utf8");
    const markerBefore = readFileSync(join(vault, ".sorage-vault.json"), "utf8");
    const attrsStatBefore = statSync(join(vault, ".gitattributes"));
    // Place an outside canary.
    const canary = join(userHome, "canary.txt");
    writeFileSync(canary, "canary data");
    // Call prepareWritableContent directly through the backup run ports.
    const backupPorts = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome });
    const runPorts = backupPorts.runPorts("manual");
    if (!runPorts.ok) throw new Error(runPorts.error.message);
    const prepared = runPorts.value.prepareWritableContent();
    expect(prepared.ok, prepared.ok ? "" : prepared.error.message).toBe(true);
    // All policy files are byte-identical; the already-correct attrs' mtime
    // is unchanged (no rewrite).
    expect(readFileSync(join(vault, ".gitattributes"), "utf8")).toBe(attrsBefore);
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe(gitignoreBefore);
    expect(readFileSync(join(vault, ".sorage-vault.json"), "utf8")).toBe(markerBefore);
    const attrsStatAfter = statSync(join(vault, ".gitattributes"));
    expect(attrsStatAfter.mtimeMs).toBe(attrsStatBefore.mtimeMs);
    // The outside canary is byte-identical; no .git was created (no Git
    // repository was expected or initialized by this call).
    expect(readFileSync(canary, "utf8")).toBe("canary data");
    expect(existsSync(join(vault, ".git"))).toBe(false);
  });
});
