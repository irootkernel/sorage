import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  backupRestore,
  backupVerify,
  exportSnapshot,
  initializeInstallation,
  parseConfigurationFile,
  runBackupOnce,
  vaultGitattributesContent,
} from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeBackupCommandPorts, nodeEnsureVaultGit } from "../../src/backup-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { inspectPreflight } from "../../src/preflight";
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
  const installation = parseConfigurationFile(readFileSync(join(home, "config.yaml"), "utf8"));
  if (!installation.ok) throw new Error(installation.error.message);
  mkdirSync(join(home, "work"), { recursive: true });
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'beta', 'Beta', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at)
    VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', ?, ?, 'directory', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(installation.value.config.installationId, join(home, "work"));
  const artifactBytes = "# The brief\n";
  mkdirSync(join(vault, "artifacts", HANDOFF_ID, "22222222-2222-4222-8222-222222222222"), { recursive: true });
  writeFileSync(join(vault, `artifacts/${HANDOFF_ID}/22222222-2222-4222-8222-222222222222/brief.md`), artifactBytes);
  db.prepare(
    `INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version,
      review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at)
    VALUES (?, 'Brief', 'user', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 1, 'awaiting_recipient', 0, 0,
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  ).run(HANDOFF_ID);
  db.prepare(
    `INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256,
      materialized, created_at) VALUES ('22222222-2222-4222-8222-222222222222', ?, ?, 'brief.md', 'brief.md', 'text/markdown', ?, ?, ?, '2026-01-02T00:00:00.000Z')`,
  ).run(
    HANDOFF_ID,
    `artifacts/${HANDOFF_ID}/22222222-2222-4222-8222-222222222222/brief.md`,
    artifactBytes.length,
    createHash("sha256").update(artifactBytes).digest("hex"),
    options.materialized === false ? 0 : 1,
  );
  db.prepare(
    `INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
    VALUES ('44444444-4444-4444-8444-444444444444', ?, 'HANDOFF_CREATED', 'user', NULL, 1, '{}', '2026-01-02T00:00:00.000Z')`,
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
  git(vault, "add", "--", ".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "content", "snapshots");
  git(vault, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "fixture backup");
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

describe("nodeEnsureVaultGit", () => {
  it.each(["legacy", "partial", "interleaved", "trailing-override"])(
    "backfills %s root attributes through reconfigure and Git initialization with effective byte protection",
    (scenario) => {
      const { home, vault } = initializedHome(`sorage-attributes-${scenario}-`);
      const legacy = "artifacts/** -text -diff\nsnapshots/** text eol=lf\n.sorage-vault.json text eol=lf\n";
      const custom = "# custom header\n*.custom diff\n";
      const footer = "# trailing comment\n";
      const old =
        scenario === "partial"
          ? "artifacts/** -text -diff\n"
          : scenario === "interleaved"
            ? legacy.replace("snapshots/** text eol=lf\n", "snapshots/** text eol=crlf\nsnapshots/** text eol=lf\n")
            : scenario === "trailing-override"
              ? `${legacy}content/** text diff\nsnapshots/content/** text eol=crlf\n`
              : legacy;
      const path = join(vault, ".gitattributes");
      writeFileSync(path, `${custom}${old}${footer}`);
      const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
      const reconfigured = initializeInstallation(ports, { reconfigure: true });
      expect(reconfigured.ok).toBe(true);
      const repaired = readFileSync(path);
      expect(repaired.toString()).toContain(custom);
      expect(repaired.toString().endsWith(footer)).toBe(true);
      if (scenario === "interleaved") expect(repaired.toString()).toContain("snapshots/** text eol=crlf\n");
      if (scenario === "trailing-override") expect(repaired.toString()).toContain("content/** text diff\n");
      expect(repaired.toString()).toContain(vaultGitattributesContent());
      const gitInitialized = initializeInstallation(ports, { reconfigure: true, initializeGit: true });
      expect(gitInitialized.ok).toBe(true);
      expect(readFileSync(path)).toEqual(repaired);
      exportOnce(home, home);
      commitManaged(vault);
      const verified = verifyOnce(home, home);
      expect(verified).toMatchObject({ ok: true, value: { findings: [] } });
      for (const relative of ["content/memo/body", "snapshots/content/memo/body", "artifacts/h/a/body"]) {
        expect(git(vault, "check-attr", "text", "diff", "--", relative)).toBe(
          `${relative}: text: unset\n${relative}: diff: unset\n`,
        );
        const bytes = Buffer.from("\uFEFFraw\r\nno-final-newline");
        mkdirSync(join(vault, relative, ".."), { recursive: true });
        writeFileSync(join(vault, relative), bytes);
        git(vault, "add", "--", relative);
        expect(execFileSync("git", ["-C", vault, "show", `:${relative}`])).toEqual(bytes);
      }
      expect(git(vault, "check-attr", "diff", "--", "retained.custom")).toBe("retained.custom: diff: set\n");
      expect(initializeInstallation(ports, { reconfigure: true, initializeGit: true }).ok).toBe(true);
      expect(readFileSync(path)).toEqual(repaired);
    },
  );

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
    // The simulated user's global config lives inside the temporary home, so
    // neither the fixture nor the production Git client under test touches
    // the developer's real ~/.gitconfig.
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      git(vault, "config", "--global", "init.defaultBranch", "trunk");
      const outcome = nodeEnsureVaultGit(vault, "installation", new FakeClock(), "main");
      expect(outcome.ok && outcome.value.initialized).toBe(true);
      expect(git(vault, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
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
    const artifact = `artifacts/${HANDOFF_ID}/22222222-2222-4222-8222-222222222222/brief.md`;
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
    expect(tracked).toContain(`artifacts/${HANDOFF_ID}/22222222-2222-4222-8222-222222222222/brief.md`);
    expect(tracked.some((path) => path.endsWith(".sqlite3") || path.endsWith(".log") || path === "api-token")).toBe(
      false,
    );
  });
});

describe("the managed content/ Git seam of M9", () => {
  it("prepares the content directory in-run on the first writable backup without a sentinel, staging nothing under it", () => {
    const { home, vault, userHome } = initializedHomeWithUser("sorage-content-prepare-", true);
    seedOneHandoff(home, vault);
    // Commit the era's managed content first so the run under test observes a
    // genuinely unchanged managed set apart from the missing directory.
    exportOnce(home, userHome);
    commitManaged(vault);
    // A pre-M9-shaped Vault: current policy lines but no content/ directory.
    rmSync(join(vault, "content"), { recursive: true, force: true });
    expect(existsSync(join(vault, "content"))).toBe(false);

    // Read-only surfaces first: verify, restore dry-run, and preflight each
    // leave the absent directory absent.
    const verified = verifyOnce(home, userHome);
    expect(verified.ok).toBe(true);
    const target = initializedHomeWithUser("sorage-content-dry-run-target-", false);
    const restorePorts = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: target.home },
      userHome: target.userHome,
      sourcePath: vault,
    }).restorePorts();
    expect(restorePorts.ok).toBe(true);
    if (restorePorts.ok) {
      const dryRun = backupRestore(restorePorts.value, { dryRun: true });
      expect(dryRun.ok).toBe(true);
    }
    const preflight = inspectPreflight(home);
    expect(preflight.status, JSON.stringify(preflight)).toBe("compatible");
    expect(existsSync(join(vault, "content"))).toBe(false);

    // The writable run prepares the directory in-run, stages nothing under it,
    // and still reaches the clean no-change exit for unchanged managed content.
    const report = runOnce(home, userHome);
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.outcome).toBe("no-change");
    expect(existsSync(join(vault, "content"))).toBe(true);
    expect(readdirRecursive(join(vault, "content"))).toEqual([]);
    const tracked = git(vault, "ls-files")
      .split("\n")
      .filter((line) => line !== "");
    expect(tracked.some((path) => path.startsWith("content/"))).toBe(false);
  });

  it("preserves raw snapshot-content bytes with a BOM, CRLF, and no final newline through a real Git clone", () => {
    const { vault } = initializedHomeWithUser("sorage-content-raw-", true);
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("first\r\n", "utf8"),
      Buffer.from("last-no-final", "utf8"),
    ]);
    mkdirSync(join(vault, "snapshots", "content", "memo", "o"), { recursive: true });
    writeFileSync(join(vault, "snapshots", "content", "memo", "o", "body"), raw);
    git(vault, "add", "--", "snapshots");
    git(vault, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "raw content");
    git(vault, "config", "--local", "user.email", "t@e.com");
    git(vault, "config", "--local", "user.name", "T");

    const clone = tempDir("sorage-content-raw-clone-");
    spawnSync("git", ["-c", "core.autocrlf=true", "clone", vault, clone], { encoding: "utf8" });
    expect(existsSync(join(clone, ".git"))).toBe(true);
    const cloned = readFileSync(join(clone, "snapshots", "content", "memo", "o", "body"));
    expect(Buffer.compare(cloned, raw)).toBe(0);
    expect(cloned.includes(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(cloned.includes(Buffer.from("\r\n", "utf8"))).toBe(true);
    expect(cloned.toString("utf8").endsWith("\n")).toBe(false);
  });
});

function readdirRecursive(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...readdirRecursive(path));
    else found.push(path);
  }
  return found;
}

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
