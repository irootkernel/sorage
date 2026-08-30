import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupVerify, exportSnapshot, initializeInstallation } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts, nodeEnsureVaultGit } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The TASK-053 integration matrix (INIT-007, BKP-001, BKP-004, BKP-022):
 * Vault Git initialization is idempotent and leaves an existing unrelated
 * repository untouched, a `core.autocrlf=true` clone leaves managed bytes
 * byte-identical, and `backup verify` names every wrong configuration while
 * an unmaterialized Artifact stays a warning.
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

function initializedHome(prefix: string, options: { initializeGit?: boolean } = {}): { home: string; vault: string } {
  const home = tempDir(prefix);
  process.env.SORAGE_HOME = home;
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  const result = initializeInstallation(ports, { vaultPath: vault, initializeGit: options.initializeGit });
  if (!result.ok) throw new Error(result.error.message);
  return { home, vault };
}

const HANDOFF_ID = "1a111111-1111-4111-8111-111111111111";

function seedOneHandoff(home: string, vault: string, options: { materialized?: boolean } = {}): void {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at)
    VALUES ('p-1', 'beta', 'Beta', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at)
    VALUES ('b-1', 'p-1', 'installation', ?, 'directory', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(join(home, "work"));
  const artifactBytes = "# The brief\n";
  mkdirSync(join(vault, "artifacts", HANDOFF_ID, "a-1"), { recursive: true });
  writeFileSync(join(vault, `artifacts/${HANDOFF_ID}/a-1/brief.md`), artifactBytes);
  db.prepare(
    `INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version,
      review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at)
    VALUES (?, 'Brief', 'user', 'p-1', 'a-1', 1, 1, 'awaiting_recipient', 0, 0,
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  ).run(HANDOFF_ID);
  db.prepare(
    `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256,
      materialized, created_at) VALUES ('a-1', ?, ?, 'brief.md', 'brief.md', 'text/markdown', ?, ?, ?, '2026-01-02T00:00:00.000Z')`,
  ).run(
    HANDOFF_ID,
    `artifacts/${HANDOFF_ID}/a-1/brief.md`,
    artifactBytes.length,
    createHash("sha256").update(artifactBytes).digest("hex"),
    options.materialized === false ? 0 : 1,
  );
  db.prepare(
    `INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
    VALUES ('e-1', ?, 'HANDOFF_CREATED', 'user', NULL, 1, '{}', '2026-01-02T00:00:00.000Z')`,
  ).run(HANDOFF_ID);
  db.exec("COMMIT");
  db.close();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function exportOnce(home: string, userHome: string): void {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome });
  const exportPorts = ports.exportPorts();
  if (!exportPorts.ok) throw new Error(exportPorts.error.message);
  const exported = exportSnapshot(exportPorts.value);
  if (!exported.ok) throw new Error(exported.error.message);
}

function commitManaged(vault: string): void {
  git(vault, "add", "--", ".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "snapshots");
  git(vault, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "fixture backup");
}

function verifyOnce(home: string, userHome: string) {
  const ports = createNodeBackupCommandPorts({ env: { SORAGE_HOME: home }, userHome });
  const verifyPorts = ports.verifyPorts();
  if (!verifyPorts.ok) throw new Error(verifyPorts.error.message);
  return backupVerify(verifyPorts.value, { now: new Date() });
}

describe("nodeEnsureVaultGit", () => {
  it("initializes the repository with core.autocrlf=false and reports an existing one untouched", () => {
    const { home, vault } = initializedHome("sorage-git-init-");
    expect(existsSync(join(vault, ".git"))).toBe(false);
    const first = nodeEnsureVaultGit(vault, "installation", new FakeClock(), "main");
    expect(first.ok && first.value.initialized).toBe(true);
    expect(git(vault, "config", "--local", "--get", "core.autocrlf").trim()).toBe("false");

    const second = nodeEnsureVaultGit(vault, "installation", new FakeClock(), "main");
    expect(second.ok && second.value).toEqual({ initialized: false, existingReported: true });
    expect(home).toBeTruthy();
  });

  it("reports an unrelated existing repository rather than reinitializing it", () => {
    const { vault } = initializedHome("sorage-git-unrelated-");
    writeFileSync(join(vault, "foreign.txt"), "not sorage\n");
    git(vault, "init");
    git(vault, "add", "foreign.txt");
    git(vault, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "unrelated history");
    const before = git(vault, "rev-parse", "HEAD").trim();

    const outcome = nodeEnsureVaultGit(vault, "installation", new FakeClock(), "main");
    expect(outcome.ok && outcome.value).toEqual({ initialized: false, existingReported: true });
    expect(git(vault, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("pins the configured branch on a fresh repository whatever the user's init.defaultBranch is", () => {
    const { home, vault } = initializedHome("sorage-git-branchpin-");
    // A user whose global default branch is not "main" would otherwise wedge
    // the run engine's branch gate on the very Vault this epic initialized.
    git(vault, "config", "--global", "init.defaultBranch", "trunk");
    try {
      const outcome = nodeEnsureVaultGit(vault, "installation", new FakeClock(), "main");
      expect(outcome.ok && outcome.value.initialized).toBe(true);
      expect(git(vault, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
    } finally {
      execFileSync("git", ["config", "--global", "--unset", "init.defaultBranch"]);
      void home;
    }
  });

  it("initializes through sorage init --initialize-git", () => {
    const { home, vault } = initializedHome("sorage-git-initflag-", { initializeGit: true });
    expect(existsSync(join(vault, ".git"))).toBe(true);
    expect(existsSync(join(home, "config.yaml"))).toBe(true);
    expect(git(vault, "config", "--local", "--get", "core.autocrlf").trim()).toBe("false");
  });
});

describe("backupVerify over a real installation", () => {
  it("exits clean on a committed, exported, correctly configured Vault", () => {
    const { home, vault, userHome } = initializedHomeWithUser("sorage-verify-green-", true);
    seedOneHandoff(home, vault);
    exportOnce(home, userHome);
    commitManaged(vault);
    const report = verifyOnce(home, userHome);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.findings).toEqual([]);
      expect(report.value.warnings).toEqual([]);
    }
  });

  it("names the fix for a wrong core.autocrlf and a missing .gitattributes line", () => {
    const { home, vault, userHome } = initializedHomeWithUser("sorage-verify-autocrlf-", true);
    seedOneHandoff(home, vault);
    exportOnce(home, userHome);
    commitManaged(vault);
    git(vault, "config", "--local", "core.autocrlf", "true");
    const wrongCrlf = verifyOnce(home, userHome);
    expect(wrongCrlf.ok && wrongCrlf.value.findings.some((f) => f.includes("core.autocrlf is 'true'"))).toBe(true);

    git(vault, "config", "--local", "core.autocrlf", "false");
    writeFileSync(join(vault, ".gitattributes"), "artifacts/** -text -diff\n");
    const missingLine = verifyOnce(home, userHome);
    expect(
      missingLine.ok &&
        missingLine.value.findings.some((f) => f.includes(".gitattributes is missing the required line")),
    ).toBe(true);
  });

  it("reports a Vault without a repository and unrelated staged work", () => {
    const bare = initializedHomeWithUser("sorage-verify-nogit-", false);
    seedOneHandoff(bare.home, bare.vault);
    exportOnce(bare.home, bare.userHome);
    const report = verifyOnce(bare.home, bare.userHome);
    expect(report.ok && report.value.findings.some((f) => f.includes("no Git repository"))).toBe(true);

    const staged = initializedHomeWithUser("sorage-verify-staged-", true);
    seedOneHandoff(staged.home, staged.vault);
    exportOnce(staged.home, staged.userHome);
    commitManaged(staged.vault);
    writeFileSync(join(staged.vault, "foreign.txt"), "staged by hand\n");
    git(staged.vault, "add", "foreign.txt");
    const stagedReport = verifyOnce(staged.home, staged.userHome);
    expect(
      stagedReport.ok &&
        stagedReport.value.findings.some((f) => f.includes("staged file(s) outside the managed pathspecs")),
    ).toBe(true);
  });

  it("flags a runtime file that was committed into the Vault (BKP-004)", () => {
    const { home, vault, userHome } = initializedHomeWithUser("sorage-verify-runtime-", true);
    seedOneHandoff(home, vault);
    exportOnce(home, userHome);
    commitManaged(vault);
    writeFileSync(join(vault, "sorage.log"), "leak\n");
    git(vault, "add", "sorage.log");
    git(vault, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "leak");
    const report = verifyOnce(home, userHome);
    expect(
      report.ok && report.value.findings.some((f) => f.includes("sorage.log") && f.includes("never committed")),
    ).toBe(true);
  });

  it("keeps an unmaterialized current Artifact a warning that does not fail the run", () => {
    const { home, vault, userHome } = initializedHomeWithUser("sorage-verify-unmaterialized-", true);
    seedOneHandoff(home, vault, { materialized: false });
    exportOnce(home, userHome);
    commitManaged(vault);
    const report = verifyOnce(home, userHome);
    expect(report.ok && report.value.warnings.some((w) => w.includes("materialized = 0"))).toBe(true);
    expect(report.ok && report.value.findings).toEqual([]);
  });

  it("leaves managed bytes identical in a core.autocrlf=true clone (BKP-022)", () => {
    const { home, vault, userHome } = initializedHomeWithUser("sorage-verify-clone-", true);
    seedOneHandoff(home, vault);
    exportOnce(home, userHome);
    commitManaged(vault);
    git(vault, "config", "--local", "user.email", "t@e.com");
    git(vault, "config", "--local", "user.name", "T");

    const clone = tempDir("sorage-verify-clone-target-");
    spawnSync("git", ["-c", "core.autocrlf=true", "clone", vault, clone], { encoding: "utf8" });
    expect(existsSync(join(clone, ".git"))).toBe(true);
    const artifact = `artifacts/${HANDOFF_ID}/a-1/brief.md`;
    expect(readFileSync(join(clone, artifact), "utf8")).toBe(readFileSync(join(vault, artifact), "utf8"));
    expect(readFileSync(join(clone, ".sorage-vault.json"), "utf8")).toBe(
      readFileSync(join(vault, ".sorage-vault.json"), "utf8"),
    );
    expect(readFileSync(join(clone, "snapshots/projects.json"), "utf8")).toBe(
      readFileSync(join(vault, "snapshots/projects.json"), "utf8"),
    );
  });

  it("proves through ls-files that the runtime files never enter the committed tree", () => {
    const { home, vault, userHome } = initializedHomeWithUser("sorage-verify-lsfiles-", true);
    seedOneHandoff(home, vault);
    exportOnce(home, userHome);
    commitManaged(vault);
    const tracked = git(vault, "ls-files")
      .split("\n")
      .filter((line) => line !== "");
    expect(tracked).toContain(".sorage-vault.json");
    expect(tracked).toContain(`artifacts/${HANDOFF_ID}/a-1/brief.md`);
    expect(tracked.some((path) => path.endsWith(".sqlite3") || path.endsWith(".log") || path === "api-token")).toBe(
      false,
    );
  });
});

function initializedHomeWithUser(
  prefix: string,
  initializeGit: boolean,
): { home: string; vault: string; userHome: string } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const userHome = mkdtempSync(join(tmpdir(), `${prefix}user-`));
  homes.push(userHome);
  const vault = join(home, "vault");
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome, clock: new FakeClock() });
  const result = initializeInstallation(ports, { vaultPath: vault, initializeGit });
  if (!result.ok) throw new Error(result.error.message);
  return { home, vault, userHome };
}
