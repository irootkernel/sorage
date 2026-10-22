import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createHomePaths } from "../../src/home";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { initializeInstallation, VAULT_OPEN_RECOVERY, vaultVerify } from "@sorage/core";
import { FakeClock } from "../../src/testkit/fakes";

const isRoot = process.getuid?.() === 0;
const CONFIG_REPAIR = "sorage config validate, then repair the reported keys";
const HOME_PERMISSIONS =
  "Restore the home directory with mode 0700 and config.yaml with owner-only 0600 permissions; do not reinitialize an existing installation";
const VAULT_GITATTRIBUTES =
  "Backfill both files with sorage init --reconfigure --non-interactive; set the git configuration in the Vault repository";
const GITIGNORE_ENTRY =
  "Add the missing staging/ entry to .gitignore by hand; reconfiguration creates only a missing .gitignore";
const GITATTRIBUTES_AND_GITIGNORE =
  "Backfill .gitattributes with sorage init --reconfigure --non-interactive, and add the missing staging/ entry to .gitignore by hand; reconfiguration creates only a missing .gitignore";
const POLICY_PATH_REPAIR =
  "Repair the policy file path and its permissions; reconfiguration cannot backfill a symlink, directory, or unreadable file";
const POLICY_PATH_AND_RECONFIGURE =
  "Repair the unsafe or unreadable policy path and backfill the missing policy file or .gitattributes line with sorage init --reconfigure --non-interactive; reconfiguration cannot backfill a symlink, directory, or unreadable file";
const CONFIG_PATH_REPAIR =
  "Replace the non-regular entry, dangling symlink, or symlink loop at the configuration path with a regular config.yaml file owned by this user, or a symlink to one";

/**
 * The TASK-068 probe proofs (INIT-017, RUN-013, SEC-002, SEC-020): the two
 * checks the catalog documents and no build emitted, driven through
 * the production ports against a temporary installation.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

describe("the daemon.reachable probe", () => {
  it("reports ok when no daemon is recorded", () => {
    const home = tempHome("sorage-reachable-none-");
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("daemon.reachable");
    expect(outcome.severity).toBe("ok");
  });

  it("warns on a malformed record instead of reading it as no record", () => {
    const home = tempHome("sorage-reachable-malformed-");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(join(paths.runDir, "daemon.json"), "{ not json");
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("daemon.reachable");
    expect(outcome.severity).toBe("warning");
    expect(outcome.message).toContain("cannot be parsed");
  });

  it("treats an out-of-domain pid as a malformed record, not a live daemon", () => {
    const home = tempHome("sorage-reachable-badpid-");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(join(paths.runDir, "daemon.json"), JSON.stringify({ pid: -1, host: "127.0.0.1", port: 46321 }));
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("daemon.reachable");
    expect(outcome.severity).toBe("warning");
    expect(outcome.message).toContain("cannot be parsed");
  });

  it("warns on a stale record whose pid is dead", () => {
    const home = tempHome("sorage-reachable-stale-");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      join(paths.runDir, "daemon.json"),
      JSON.stringify({
        pid: 999999,
        host: "127.0.0.1",
        port: 46321,
        startedAt: "t",
        version: "t",
        installationId: "i",
      }),
    );
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("daemon.reachable");
    expect(outcome.severity).toBe("warning");
    expect(outcome.message).toContain("stale");
    expect(outcome.recovery?.suggestedCommand).toContain("sorage daemon start");
  });
});

describe("the content.checksums probe of M9", () => {
  it.each([
    "content/memo/0123abcd-0000-4000-8000-0000000000c9/0123abcd-0000-4000-8000-0000000000c9",
    "artifacts/0123abcd-0000-4000-8000-0000000000c9/0123abcd-0000-4000-8000-0000000000c9/body.md",
  ])("verifies and detects tampering of generic record key %s in both censuses", (key) => {
    const home = tempHome("sorage-doctor-content-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const doctor = createNodeDoctorPorts({ userHome: home });
    const vacuous = doctor.probe("content.checksums");
    expect(vacuous.severity).toBe("ok");
    expect(vacuous.message).toContain("No content records");

    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    const vault = join(home, "vault");
    mkdirSync(join(vault, key.split("/").slice(0, -1).join("/")), { recursive: true });
    const bytes = Buffer.from("doctor census bytes", "utf8");
    writeFileSync(join(vault, key), bytes);
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, ?)",
    ).run(
      "0123abcd-0000-4000-8000-0000000000c9",
      key,
      bytes.byteLength,
      createHash("sha256").update(bytes).digest("hex"),
      "2026-01-01T00:00:00.000Z",
    );
    db.close();
    const clean = doctor.probe("content.checksums");
    expect(clean.severity).toBe("ok");
    const verifyPorts = createNodeVaultCommandPorts({ env: { SORAGE_HOME: home }, userHome: home }).verifyPorts();
    if (!verifyPorts.ok) throw new Error(verifyPorts.error.message);
    const verified = vaultVerify(verifyPorts.value, { now: new Date() });
    expect(verified).toMatchObject({ ok: true, value: { findings: [], checked: { contentRecords: 1 } } });

    writeFileSync(join(vault, key), "tampered");
    const corrupted = doctor.probe("content.checksums");
    expect(corrupted.severity).toBe("blocking");
    expect(corrupted.message).toContain(key);
    expect(corrupted.recovery?.suggestedCommand).toContain("sorage vault verify");
    const corruptedVerify = vaultVerify(verifyPorts.value, { now: new Date() });
    expect(corruptedVerify.ok).toBe(true);
    if (corruptedVerify.ok) expect(corruptedVerify.value.findings.join("\n")).toContain(key);
  });
});

const RECORD_PROJECT = "0123abcd-0000-4000-8000-0000000000f1";
const RECORD_HANDOFF = "0123abcd-0000-4000-8000-0000000000f2";
const RECORD_CONTENT = "0123abcd-0000-4000-8000-0000000000f3";
const RECORD_KEY = "artifacts/h-t118/a-t118/body.md";
const RECORD_BYTES = "task 118 bytes\n";
const RECORD_SHA = createHash("sha256").update(RECORD_BYTES).digest("hex");

/** An initialized installation with one materialized Artifact and content record. */
function recordedHome(prefix: string): { home: string; vaultPath: string } {
  const home = tempHome(prefix);
  const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
  const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
  if (initialized.ok !== true) throw new Error("fixture initialization failed");
  const paths = createHomePaths({ SORAGE_HOME: home }, home);
  const db = new DatabaseSync(join(paths.stateDir, "sorage.sqlite3"));
  try {
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, 't118', 'T118', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(RECORD_PROJECT);
    db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, ?, ?, 1, '2026-01-02T00:00:00.000Z')",
    ).run(RECORD_CONTENT, RECORD_KEY, Buffer.byteLength(RECORD_BYTES), RECORD_SHA);
    db.prepare(
      "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?, 'T118', 'user', ?, 'a-t118', 1, 1, 'awaiting_recipient', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
    ).run(RECORD_HANDOFF, RECORD_PROJECT);
    db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES ('a-t118', ?, 'body.md', 'body.md', 'text/markdown', NULL, '2026-01-02T00:00:00.000Z', ?)",
    ).run(RECORD_HANDOFF, RECORD_CONTENT);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  mkdirSync(join(home, "vault", "artifacts", "h-t118", "a-t118"), { recursive: true });
  writeFileSync(join(home, "vault", RECORD_KEY), RECORD_BYTES);
  return { home, vaultPath: join(home, "vault") };
}

describe("the TASK-118 doctor recovery policy", () => {
  it("reports the V1 refusal on the Vault-dependent checks and never names a command that cannot run", () => {
    const fixture = recordedHome("sorage-t118-v1-");
    rmSync(fixture.vaultPath, { recursive: true, force: true });
    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const message = `The Vault directory does not exist at ${fixture.vaultPath}.`;
    for (const id of ["vault.marker", "vault.gitattributes", "artifacts.checksums", "content.checksums"] as const) {
      const outcome = doctor.probe(id);
      expect(outcome.severity, id).not.toBe("ok");
      expect(outcome.message, id).toBe(message);
      expect(outcome.recovery?.suggestedCommand, id).toBe(VAULT_OPEN_RECOVERY.missingDirectory);
    }
    const writable = doctor.probe("vault.writable");
    expect(writable.severity).toBe("blocking");
    // Only the recovery follows the Vault-open state; the diagnostic message stays.
    expect(writable.message).toBe("The Vault root, artifacts/, or staging/ is not writable by this user.");
    expect(writable.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.missingDirectory);
    const platform = doctor.probe("platform.tcc");
    expect(platform.severity).toBe("warning");
    expect(platform.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.missingDirectory);
    for (const id of ["vault.marker", "vault.gitattributes", "vault.writable", "platform.tcc"] as const) {
      const recovery = doctor.probe(id).recovery?.suggestedCommand ?? "";
      expect(recovery, id).not.toContain("sorage vault verify");
    }
  });

  it.skipIf(isRoot)("reports the V2 refusal on the marker and checksum checks for a mode-000 Vault", () => {
    const fixture = recordedHome("sorage-t118-v2-");
    const message = `The Vault directory at ${fixture.vaultPath} cannot be inspected.`;
    try {
      chmodSync(fixture.vaultPath, 0o000);
      const doctor = createNodeDoctorPorts({ userHome: fixture.home });
      for (const id of ["vault.marker", "vault.gitattributes", "artifacts.checksums", "content.checksums"] as const) {
        const outcome = doctor.probe(id);
        expect(outcome.severity, id).not.toBe("ok");
        expect(outcome.message, id).toBe(message);
        expect(outcome.recovery?.suggestedCommand, id).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
      }
      // Z7: vault.writable keeps its diagnostic message; only its recovery follows the Vault state.
      const writable = doctor.probe("vault.writable");
      expect(writable.severity).toBe("blocking");
      expect(writable.message).toBe("The Vault root, artifacts/, or staging/ is not writable by this user.");
      expect(writable.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
      const platform = doctor.probe("platform.tcc");
      expect(platform.severity).toBe("warning");
      expect(platform.message).toBe("The Vault is not readable without a macOS privacy prompt.");
      expect(platform.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
    } finally {
      chmodSync(fixture.vaultPath, 0o700);
    }
  });

  it("reports the V4 refusal on the marker and checksum checks for a directory at the marker path", () => {
    const fixture = recordedHome("sorage-t118-v4-");
    rmSync(join(fixture.vaultPath, ".sorage-vault.json"), { force: true });
    mkdirSync(join(fixture.vaultPath, ".sorage-vault.json"));
    const doctor = createNodeDoctorPorts({ userHome: fixture.home });
    const message = `The Vault marker at ${fixture.vaultPath}/.sorage-vault.json cannot be read.`;
    for (const id of ["vault.marker", "artifacts.checksums", "content.checksums"] as const) {
      const outcome = doctor.probe(id);
      expect(outcome.severity, id).toBe("blocking");
      expect(outcome.message, id).toBe(message);
      expect(outcome.recovery?.suggestedCommand, id).toBe(VAULT_OPEN_RECOVERY.unreadableMarker);
    }
    const writable = doctor.probe("vault.writable");
    expect(writable.severity).toBe("blocking");
    expect(writable.message).toBe("The Vault root, artifacts/, or staging/ is not writable by this user.");
    expect(writable.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.unreadableMarker);
  });

  it("reports V7, V8 and V9 marker states with their exact recoveries", () => {
    const cases: Array<[string, string, string | undefined]> = [
      [
        `${JSON.stringify({ type: "sorage-vault", schemaVersion: 1, installationId: "i", createdAt: "" })}\n`,
        "The Vault marker has no createdAt.",
        VAULT_OPEN_RECOVERY.invalidMarker,
      ],
      [
        `${JSON.stringify({ type: "sorage-vault", schemaVersion: 1, installationId: "22222222-2222-4222-8222-222222222222", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
        "The Vault marker belongs to installation 22222222-2222-4222-8222-222222222222, not this installation ",
        VAULT_OPEN_RECOVERY.foreignMarker,
      ],
      [
        `${JSON.stringify({ type: "sorage-vault", schemaVersion: 2, installationId: "i", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
        "is newer than this build's",
        undefined,
      ],
    ];
    for (const [body, message, recovery] of cases) {
      const home = tempHome("sorage-t118-marker-");
      const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
      const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
      if (initialized.ok !== true) throw new Error("fixture initialization failed");
      writeFileSync(join(home, "vault", ".sorage-vault.json"), body);
      const outcome = createNodeDoctorPorts({ userHome: home }).probe("vault.marker");
      expect(outcome.severity).toBe("blocking");
      expect(outcome.message).toContain(message);
      if (recovery === undefined) {
        // V9 keeps the catalogue default; the doctor carries it explicitly.
        expect(outcome.recovery?.suggestedCommand).toBe("Upgrade Sorage; Sorage never downgrades a Vault");
      } else {
        expect(outcome.recovery?.suggestedCommand).toBe(recovery);
      }
    }
  });

  it("backfills missing policy files with the named reconfigure and then passes", () => {
    const home = tempHome("sorage-t118-gitattributes-missing-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    rmSync(join(home, "vault", ".gitattributes"), { force: true });
    rmSync(join(home, "vault", ".gitignore"), { force: true });
    const missing = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(missing.severity).toBe("warning");
    expect(missing.recovery?.suggestedCommand).toBe(VAULT_GITATTRIBUTES);

    // K2: the named action runs in exactly this state and fixes it.
    expect(initializeInstallation(ports, { reconfigure: true }).ok).toBe(true);
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
  });

  it("reasserts a missing .gitattributes line with the named reconfigure and then passes", () => {
    const home = tempHome("sorage-t118-gitattributes-line-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "vault", ".gitattributes");
    writeFileSync(path, readFileSync(path, "utf8").replace("artifacts/** -text -diff\n", ""));
    const damaged = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(damaged.severity).toBe("warning");
    expect(damaged.message).toContain("artifacts/** -text -diff");
    expect(damaged.recovery?.suggestedCommand).toBe(VAULT_GITATTRIBUTES);

    expect(initializeInstallation(ports, { reconfigure: true }).ok).toBe(true);
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
  });

  it("names both actions when .gitattributes is missing and .gitignore lacks staging/ (K8)", () => {
    const home = tempHome("sorage-t118-gitattributes-combined-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    rmSync(join(home, "vault", ".gitattributes"), { force: true });
    writeFileSync(join(home, "vault", ".gitignore"), "node_modules/\n");
    const combined = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(combined.severity).toBe("warning");
    expect(combined.message).toContain(".gitattributes is missing from the Vault.");
    expect(combined.message).toContain("staging/");
    expect(combined.recovery?.suggestedCommand).toBe(GITATTRIBUTES_AND_GITIGNORE);
    expect(combined.recovery?.suggestedCommand).toContain("sorage init --reconfigure --non-interactive");
    expect(combined.recovery?.suggestedCommand).toContain("by hand");

    // Each named action fixes its own half; only both together make the check pass.
    expect(initializeInstallation(ports, { reconfigure: true }).ok).toBe(true);
    const afterReconfigure = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(afterReconfigure.severity).toBe("warning");
    expect(afterReconfigure.recovery?.suggestedCommand).toBe(GITIGNORE_ENTRY);
    writeFileSync(join(home, "vault", ".gitignore"), "staging/\n");
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
  });

  it("names both actions when both present files carry findings (K8)", () => {
    const home = tempHome("sorage-t118-gitattributes-both-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const attributesPath = join(home, "vault", ".gitattributes");
    writeFileSync(attributesPath, readFileSync(attributesPath, "utf8").replace("artifacts/** -text -diff\n", ""));
    writeFileSync(join(home, "vault", ".gitignore"), "node_modules/\n");
    const combined = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(combined.severity).toBe("warning");
    expect(combined.message).toContain("artifacts/** -text -diff");
    expect(combined.message).toContain("staging/");
    expect(combined.recovery?.suggestedCommand).toBe(GITATTRIBUTES_AND_GITIGNORE);

    expect(initializeInstallation(ports, { reconfigure: true }).ok).toBe(true);
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").recovery?.suggestedCommand).toBe(
      GITIGNORE_ENTRY,
    );
    writeFileSync(join(home, "vault", ".gitignore"), "staging/\n");
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
  });

  it("names a manual .gitignore edit because reconfiguration never rewrites an existing one", () => {
    const home = tempHome("sorage-t118-gitignore-entry-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "vault", ".gitignore");
    writeFileSync(path, "node_modules/\n");
    const wrong = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(wrong.severity).toBe("warning");
    expect(wrong.message).toContain("staging/");
    expect(wrong.recovery?.suggestedCommand).toBe(GITIGNORE_ENTRY);

    // The initializer creates only a missing .gitignore; the named manual edit is required.
    expect(initializeInstallation(ports, { reconfigure: true }).ok).toBe(true);
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").recovery?.suggestedCommand).toBe(
      GITIGNORE_ENTRY,
    );
    writeFileSync(path, "staging/\n");
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
  });

  it.skipIf(isRoot)(
    "repairs an unreadable policy file and then passes (root reads a mode-000 file, so this case is skipped as root)",
    () => {
      const home = tempHome("sorage-t118-gitattributes-unreadable-");
      const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
      const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
      if (initialized.ok !== true) throw new Error("fixture initialization failed");
      const path = join(home, "vault", ".gitattributes");
      try {
        chmodSync(path, 0o000);
        const unreadable = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
        expect(unreadable.severity).toBe("warning");
        expect(unreadable.recovery?.suggestedCommand).toBe(POLICY_PATH_REPAIR);
      } finally {
        chmodSync(path, 0o644);
      }
      expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
    },
  );

  it("repairs an unsafe policy path in place and then passes", () => {
    const home = tempHome("sorage-t118-gitattributes-directory-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "vault", ".gitattributes");
    rmSync(path, { force: true });
    mkdirSync(path);
    const unsafe = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(unsafe.severity).toBe("warning");
    expect(unsafe.message).toBe(".gitattributes is unreadable or unsafe at its path.");
    expect(unsafe.recovery?.suggestedCommand).toBe(POLICY_PATH_REPAIR);

    rmSync(path, { recursive: true, force: true });
    writeFileSync(
      path,
      "artifacts/** -text -diff\ncontent/** -text -diff\nsnapshots/** text eol=lf\nsnapshots/content/** -text -diff\n.sorage-vault.json text eol=lf\n",
    );
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
  });

  it("repairs a symlinked policy path in its own fixture and then passes", () => {
    const home = tempHome("sorage-t118-gitattributes-symlink-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "vault", ".gitignore");
    const outside = join(home, "outside-gitignore");
    writeFileSync(outside, "staging/\n");
    rmSync(path, { force: true });
    symlinkSync(outside, path);
    const unsafe = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(unsafe.severity).toBe("warning");
    expect(unsafe.recovery?.suggestedCommand).toBe(POLICY_PATH_REPAIR);

    rmSync(path, { force: true });
    writeFileSync(path, "staging/\n");
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
    expect(readFileSync(outside, "utf8")).toBe("staging/\n");
  });

  it("carries the configuration-repair recovery when the configuration is malformed", () => {
    const home = tempHome("sorage-t118-malformed-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    writeFileSync(join(home, "config.yaml"), "not: [valid\n");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.runDir, { recursive: true });
    // A live-looking daemon record reaches the daemon.reachable configuration branch.
    writeFileSync(
      join(paths.runDir, "daemon.json"),
      JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 46321 }),
    );
    const doctor = createNodeDoctorPorts({ userHome: home });
    for (const id of [
      "config.schema",
      "vault.marker",
      "vault.gitattributes",
      "artifacts.checksums",
      "content.checksums",
      "platform.tcc",
      "daemon.reachable",
      "daemon.port",
      "backup.schedule",
      "git.state",
    ] as const) {
      const outcome = doctor.probe(id);
      expect(outcome.severity, id).not.toBe("ok");
      expect(outcome.recovery?.suggestedCommand, id).toBe(CONFIG_REPAIR);
    }
  });

  it("repairs a malformed configuration and then passes", () => {
    const home = tempHome("sorage-t118-malformed-pass-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "config.yaml");
    const valid = readFileSync(path, "utf8");
    writeFileSync(path, "not: [valid\n");
    const malformed = createNodeDoctorPorts({ userHome: home }).probe("config.schema");
    expect(malformed.severity).toBe("blocking");
    expect(malformed.message).toContain("config.yaml is invalid");
    expect(malformed.recovery?.suggestedCommand).toBe(CONFIG_REPAIR);

    // K3: the repair the recovery names restores the check.
    writeFileSync(path, valid);
    expect(createNodeDoctorPorts({ userHome: home }).probe("config.schema").severity).toBe("ok");
  });

  it.skipIf(isRoot)(
    "treats an unreadable configuration as an access failure and then passes after repair (root reads a mode-000 file, so this case is skipped as root)",
    () => {
      const home = tempHome("sorage-t118-unreadable-");
      const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
      const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
      if (initialized.ok !== true) throw new Error("fixture initialization failed");
      const configPath = join(home, "config.yaml");
      try {
        chmodSync(configPath, 0o000);
        const doctor = createNodeDoctorPorts({ userHome: home });
        expect(doctor.initialized()).toBe(true);
        const marker = doctor.probe("vault.marker");
        expect(marker.severity).toBe("blocking");
        expect(marker.message).toBe("The Vault marker cannot be checked without a valid configuration.");
        expect(marker.recovery?.suggestedCommand).toBe(HOME_PERMISSIONS);
        expect(marker.recovery?.suggestedCommand).not.toContain("sorage init");

        // K3: following the access repair restores both checks.
        chmodSync(configPath, 0o600);
        expect(createNodeDoctorPorts({ userHome: home }).probe("vault.marker").severity).toBe("ok");
        expect(createNodeDoctorPorts({ userHome: home }).probe("config.schema").severity).toBe("ok");
      } finally {
        chmodSync(configPath, 0o600);
      }
    },
  );

  it.skipIf(isRoot)(
    "treats a denied home traversal as an access failure, never as pre-initialization (root traverses a mode-000 directory, so this case is skipped as root)",
    () => {
      const home = tempHome("sorage-t118-parent-");
      const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
      const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
      if (initialized.ok !== true) throw new Error("fixture initialization failed");
      try {
        chmodSync(home, 0o000);
        const doctor = createNodeDoctorPorts({ userHome: home });
        // K1: only a confirmed ENOENT is pre-initialization.
        expect(doctor.initialized()).toBe(true);
        const schema = doctor.probe("config.schema");
        expect(schema.severity).toBe("blocking");
        expect(schema.message).toBe("config.yaml cannot be read.");
        expect(schema.recovery?.suggestedCommand).toBe(HOME_PERMISSIONS);
      } finally {
        chmodSync(home, 0o700);
      }
      expect(createNodeDoctorPorts({ userHome: home }).probe("config.schema").severity).toBe("ok");
    },
  );

  it("aggregates an unsafe policy path with the other file's finding (K13)", () => {
    const home = tempHome("sorage-t118-gitattributes-unsafe-missing-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const attributesPath = join(home, "vault", ".gitattributes");
    rmSync(attributesPath, { force: true });
    mkdirSync(attributesPath);
    rmSync(join(home, "vault", ".gitignore"), { force: true });
    const combined = createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes");
    expect(combined.severity).toBe("warning");
    expect(combined.message).toContain(".gitattributes is unreadable or unsafe at its path.");
    expect(combined.message).toContain(".gitignore is missing from the Vault.");
    expect(combined.recovery?.suggestedCommand).toBe(POLICY_PATH_AND_RECONFIGURE);

    // Both named actions, in the order the recovery states: repair the path,
    // then let the reconfiguration create the missing .gitignore.
    rmSync(attributesPath, { recursive: true, force: true });
    writeFileSync(
      attributesPath,
      "artifacts/** -text -diff\ncontent/** -text -diff\nsnapshots/** text eol=lf\nsnapshots/content/** -text -diff\n.sorage-vault.json text eol=lf\n",
    );
    expect(initializeInstallation(ports, { reconfigure: true }).ok).toBe(true);
    expect(createNodeDoctorPorts({ userHome: home }).probe("vault.gitattributes").severity).toBe("ok");
  });

  it("accepts a live symlink to a valid configuration (K15)", () => {
    const home = tempHome("sorage-t118-config-live-symlink-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "config.yaml");
    const target = join(home, "config-target.yaml");
    const valid = readFileSync(path, "utf8");
    writeFileSync(target, valid);
    chmodSync(target, 0o600);
    rmSync(path, { force: true });
    symlinkSync(target, path);
    const doctor = createNodeDoctorPorts({ userHome: home });
    expect(doctor.initialized()).toBe(true);
    expect(doctor.probe("config.schema").severity).toBe("ok");
    expect(doctor.probe("home.permissions").severity).toBe("ok");
  });

  it("reports a symlink loop at the configuration path as a path fault (K15)", () => {
    const home = tempHome("sorage-t118-config-loop-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "config.yaml");
    const valid = readFileSync(path, "utf8");
    rmSync(path, { force: true });
    symlinkSync(path, path);
    const doctor = createNodeDoctorPorts({ userHome: home });
    expect(doctor.initialized()).toBe(true);
    const schema = doctor.probe("config.schema");
    expect(schema.severity).toBe("blocking");
    expect(schema.message).toBe("The configuration path is not a regular config.yaml file.");
    expect(schema.recovery?.suggestedCommand).toBe(CONFIG_PATH_REPAIR);
    expect(doctor.probe("home.permissions").recovery?.suggestedCommand).toBe(CONFIG_PATH_REPAIR);

    rmSync(path, { force: true });
    writeFileSync(path, valid);
    chmodSync(path, 0o600);
    expect(createNodeDoctorPorts({ userHome: home }).probe("config.schema").severity).toBe("ok");
  });

  it("repairs a dangling symlink at the configuration path instead of treating it as absent (K12)", () => {
    const home = tempHome("sorage-t118-config-dangling-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "config.yaml");
    const valid = readFileSync(path, "utf8");
    rmSync(path, { force: true });
    symlinkSync(join(home, "missing-config-target"), path);
    const doctor = createNodeDoctorPorts({ userHome: home });
    // K12: only an lstat ENOENT is absence, so the catalog runs.
    expect(doctor.initialized()).toBe(true);
    const schema = doctor.probe("config.schema");
    expect(schema.severity).toBe("blocking");
    expect(schema.message).toBe("The configuration path is not a regular config.yaml file.");
    expect(schema.recovery?.suggestedCommand).toBe(CONFIG_PATH_REPAIR);

    rmSync(path, { force: true });
    writeFileSync(path, valid);
    chmodSync(path, 0o600);
    expect(createNodeDoctorPorts({ userHome: home }).probe("config.schema").severity).toBe("ok");
  });

  it("repairs a directory at the configuration path instead of suggesting 0600", () => {
    const home = tempHome("sorage-t118-config-path-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const path = join(home, "config.yaml");
    const valid = readFileSync(path, "utf8");
    rmSync(path, { force: true });
    mkdirSync(path);
    const doctor = createNodeDoctorPorts({ userHome: home });
    expect(doctor.initialized()).toBe(true);
    const schema = doctor.probe("config.schema");
    expect(schema.severity).toBe("blocking");
    expect(schema.message).toBe("The configuration path is not a regular config.yaml file.");
    expect(schema.recovery?.suggestedCommand).toBe(CONFIG_PATH_REPAIR);
    expect(schema.recovery?.suggestedCommand).not.toContain("0600");
    // The permission check names the same repair instead of a 0600 mode.
    const permissions = doctor.probe("home.permissions");
    expect(permissions.severity).toBe("blocking");
    expect(permissions.recovery?.suggestedCommand).toBe(CONFIG_PATH_REPAIR);

    // K3: following the path repair restores the check.
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, valid);
    chmodSync(path, 0o600);
    expect(createNodeDoctorPorts({ userHome: home }).probe("config.schema").severity).toBe("ok");
  });

  it("repairs home permissions directly when the Vault is also missing, then passes", () => {
    const home = tempHome("sorage-t118-home-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    chmodSync(join(home, "config.yaml"), 0o644);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("home.permissions");
    expect(outcome.severity).toBe("blocking");
    expect(outcome.recovery?.suggestedCommand).toBe(HOME_PERMISSIONS);
    expect(outcome.recovery?.suggestedCommand).not.toContain("init --reconfigure");

    // K3: the recovery's modes are the ones that restore the check.
    chmodSync(home, 0o700);
    chmodSync(join(home, "config.yaml"), 0o600);
    expect(createNodeDoctorPorts({ userHome: home }).probe("home.permissions").severity).toBe("ok");
  });

  it.skipIf(isRoot)("reports the Vault marker ok for an execute-only directory with a valid marker", () => {
    const home = tempHome("sorage-t118-exec-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    try {
      chmodSync(join(home, "vault"), 0o300);
      const outcome = createNodeDoctorPorts({ userHome: home }).probe("vault.marker");
      expect(outcome.severity).toBe("ok");
    } finally {
      chmodSync(join(home, "vault"), 0o700);
    }
  });
});

describe("the db.migrations probe and the legacy migration lock", () => {
  it("blocks on a live-looking legacy owner because the runner does not acquire the file", async () => {
    const home = tempHome("sorage-doctor-miglock-live-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      join(paths.runDir, "migration.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "h" }),
    );
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("db.migrations");
    expect(outcome.severity).toBe("blocking");
    expect(outcome.message).toContain("does not acquire the legacy file");
  });

  it("blocks on stale evidence with removal guidance, preserving the file", async () => {
    const home = tempHome("sorage-doctor-miglock-stale-");
    const ports = createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
    const initialized = initializeInstallation(ports, { vaultPath: join(home, "vault") });
    if (initialized.ok !== true) throw new Error("fixture initialization failed");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.runDir, { recursive: true });
    const lockPath = join(paths.runDir, "migration.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "2020-01-01T00:00:00.000Z", hostname: "h" }));
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("db.migrations");
    expect(outcome.severity).toBe("blocking");
    expect(outcome.message).toContain("stale");
    expect(outcome.recovery?.suggestedCommand).toContain("migration.lock");
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("the token.permissions probe", () => {
  it("reports ok for a 0600 file holding at least 32 bytes", () => {
    const home = tempHome("sorage-token-ok-");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.stateDir, { recursive: true });
    const token = join(paths.stateDir, "api-token");
    writeFileSync(token, "t".repeat(64), { mode: 0o600 });
    chmodSync(token, 0o600);
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("token.permissions");
    expect(outcome.severity).toBe("ok");
  });

  it("warns when the file is absent", () => {
    const home = tempHome("sorage-token-absent-");
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("token.permissions");
    expect(outcome.severity).toBe("warning");
  });

  it("blocks on a loose mode", () => {
    const home = tempHome("sorage-token-loose-");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.stateDir, { recursive: true });
    const token = join(paths.stateDir, "api-token");
    writeFileSync(token, "t".repeat(64), { mode: 0o644 });
    chmodSync(token, 0o644);
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("token.permissions");
    expect(outcome.severity).toBe("blocking");
    expect(outcome.message).toContain("0600");
    expect(outcome.recovery?.suggestedCommand).toBe("sorage token rotate --as-user");
  });

  it("blocks on fewer than 32 bytes", () => {
    const home = tempHome("sorage-token-short-");
    const paths = createHomePaths({ SORAGE_HOME: home }, home);
    mkdirSync(paths.stateDir, { recursive: true });
    const token = join(paths.stateDir, "api-token");
    writeFileSync(token, "t".repeat(16), { mode: 0o600 });
    chmodSync(token, 0o600);
    const outcome = createNodeDoctorPorts({ userHome: home }).probe("token.permissions");
    expect(outcome.severity).toBe("blocking");
    expect(outcome.message).toContain("32 bytes");
  });
});
