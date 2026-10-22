import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";
import { CONFIGURATION_DEFAULTS } from "@sorage/core";

/**
 * The EPIC-002 acceptance journeys executed through the CLI: AJ-01 runs a fresh
 * non-interactive initialization and a clean doctor, AJ-02 verifies the
 * pre-initialization guidance and catalog. The journeys are re-run in full at the
 * M1 release gate; until `project list` and `completion` arrive with their epics,
 * the gated-command step uses `config show`, the gated command this epic ships.
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

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

interface DoctorEnvelope {
  ok: boolean;
  data: { checks: Array<{ id: string; severity: string; message: string; recovery?: { suggestedCommand: string } }> };
}

describe("AJ-01: fresh non-interactive initialization and doctor", () => {
  it("initializes idempotently and doctors clean", () => {
    const home = tempHome("sorage-aj01-");
    const vault = join(home, "vault");

    const init = capture();
    expect(runCli(["init", "--vault", vault, "--non-interactive"], init.ports)).toBe(0);
    expect(join(home, "config.yaml") !== "");
    expect(runCli(["--help"], capture().ports)).toBe(0);

    expect(readFileSync(join(vault, ".gitattributes"), "utf8")).toBe(
      "artifacts/** -text -diff\ncontent/** -text -diff\nsnapshots/** text eol=lf\nsnapshots/content/** -text -diff\n.sorage-vault.json text eol=lf\n",
    );
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("staging/\n");
    expect(readFileSync(join(vault, ".sorage-vault.json"), "utf8")).toContain("sorage-vault");

    const show = capture();
    expect(runCli(["config", "show", "--json"], show.ports)).toBe(0);
    const shown = JSON.parse(show.outText()) as { data: Record<string, unknown> };
    const expected = {
      ...CONFIGURATION_DEFAULTS,
      installationId: shown.data.installationId,
      vault: { ...CONFIGURATION_DEFAULTS.vault, path: vault },
    };
    expect(shown.data).toEqual(expected);
    expect(typeof shown.data.installationId).toBe("string");

    const before = readFileSync(join(home, "config.yaml"), "utf8");
    const markerBefore = readFileSync(join(vault, ".sorage-vault.json"), "utf8");
    const again = capture();
    expect(runCli(["init", "--vault", vault, "--non-interactive"], again.ports)).toBe(0);
    expect(again.outText()).toContain("already initialized");
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(before);
    expect(readFileSync(join(vault, ".sorage-vault.json"), "utf8")).toBe(markerBefore);

    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(0);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    expect(report.ok).toBe(true);
    expect(report.data.checks).toHaveLength(21);
    for (const check of report.data.checks) {
      // The LaunchAgent is the one optional piece: an installation without it is
      // healthy and reports service.installed as a warning, never blocking.
      if (check.id === "service.installed") {
        expect(check.severity).toBe("warning");
        expect(check.recovery?.suggestedCommand).toContain("launchctl bootstrap gui/$UID");
        continue;
      }
      expect(check.severity).toBe("ok");
      expect(check.recovery).toBeUndefined();
    }
  });
});

describe("AJ-02: pre-initialization guidance", () => {
  it("gates non-bootstrap commands and runs the bootstrap set", () => {
    const home = tempHome("sorage-aj02-");

    const gated = capture();
    expect(runCli(["config", "show"], gated.ports)).toBe(78);
    expect(gated.errText()).toContain("NOT_INITIALIZED");
    expect(gated.errText()).toContain(join(home, "config.yaml"));
    expect(gated.errText()).toContain("sorage init");

    const gatedJson = capture();
    expect(runCli(["config", "show", "--json"], gatedJson.ports)).toBe(78);
    expect(gatedJson.outText()).toBe("");
    const envelope = JSON.parse(gatedJson.errText()) as {
      error: { code: string; details: { expectedConfigPath: string }; recovery: { suggestedCommand: string } };
    };
    expect(envelope.error.code).toBe("NOT_INITIALIZED");
    expect(envelope.error.details.expectedConfigPath).toBe(join(home, "config.yaml"));
    expect(envelope.error.recovery.suggestedCommand).toBe("sorage init");

    expect(runCli(["--help"], capture().ports)).toBe(0);
    expect(runCli(["version"], capture().ports)).toBe(0);
    const doctor = capture();
    expect(runCli(["doctor"], doctor.ports)).toBe(1);
    expect(doctor.outText()).toContain("[blocking] config.schema");
  });

  it("emits the pre-initialization catalog with every installation-dependent check blocking", () => {
    const home = tempHome("sorage-aj02-catalog-");
    const doctor = capture();
    const code = runCli(["doctor", "--json"], doctor.ports);
    expect(code).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    expect(report.ok).toBe(true);
    expect(report.data.checks).toHaveLength(21);
    const expectedIds = [
      "home.permissions",
      "config.schema",
      "config.lock",
      "vault.marker",
      "vault.gitattributes",
      "vault.writable",
      "db.integrity",
      "db.pendingIntents",
      "db.migrations",
      "artifacts.checksums",
      "content.checksums",
      "bindings.exist",
      "bindings.nested",
      "bindings.ambiguous",
      "daemon.reachable",
      "daemon.port",
      "token.permissions",
      "service.installed",
      "backup.schedule",
      "git.state",
      "platform.tcc",
    ];
    expect(report.data.checks.map((check) => check.id)).toEqual(expectedIds);
    for (const check of report.data.checks) {
      expect(check.severity).toBe("blocking");
      if (check.id !== "config.schema") {
        expect(check.message).toBe("Sorage is not initialized");
        expect(check.message).not.toContain(join(home, "config.yaml"));
      }
      expect(check.recovery).toEqual({ suggestedCommand: "sorage init" });
    }
    const schema = report.data.checks.find((check) => check.id === "config.schema");
    expect(schema?.message).toBe(
      `Sorage is not initialized; expected configuration file: ${join(home, "config.yaml")}`,
    );
  });
});

describe("doctor severities after initialization", () => {
  it("exits 0 with a warning alone when config.lock goes stale", () => {
    const home = tempHome("sorage-doctor-warning-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(
      join(home, "run", "config.lock"),
      `${JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), hostname: "gone" })}\n`,
    );
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(0);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    const lock = report.data.checks.find((check) => check.id === "config.lock");
    expect(lock?.severity).toBe("warning");
    expect(lock?.recovery?.suggestedCommand).toContain("config.lock");
    expect(report.data.checks.every((check) => check.severity !== "blocking")).toBe(true);
  });

  it("exits non-zero with a blocking check when the configuration is broken", () => {
    const home = tempHome("sorage-doctor-blocking-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    chmodSync(join(home, "config.yaml"), 0o644);
    const doctor = capture();
    const code = runCli(["doctor", "--json"], doctor.ports);
    expect(code).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    const permissions = report.data.checks.find((check) => check.id === "home.permissions");
    expect(permissions?.severity).toBe("blocking");
    // TASK-118 Z1: direct permission repair, never reinitialization.
    expect(permissions?.recovery?.suggestedCommand).toBe(
      "Restore the home directory with mode 0700 and config.yaml with owner-only 0600 permissions; do not reinitialize an existing installation",
    );
  });

  it("warns through db.pendingIntents only for intents the drain cannot resolve", () => {
    const home = tempHome("sorage-doctor-intents-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const clean = capture();
    expect(runCli(["doctor", "--json"], clean.ports)).toBe(0);
    const cleanReport = JSON.parse(clean.outText()) as DoctorEnvelope;
    const cleanCheck = cleanReport.data.checks.find((check) => check.id === "db.pendingIntents");
    expect(cleanCheck?.severity).toBe("ok");

    // One committed intent whose bytes are gone on both ends: the durable
    // integrity-failed signal the drain leaves behind (VLT-014, RUN-002).
    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      database
        .prepare(
          "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES (?, 'activate', NULL, 'artifacts/h-1/a-9/none.md', NULL, ?, 1)",
        )
        .run("intent-1", "2026-05-01T00:00:00.000Z");
    } finally {
      database.close();
    }
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(0);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    const check = report.data.checks.find((entry) => entry.id === "db.pendingIntents");
    expect(check?.severity).toBe("warning");
    expect(check?.message).toContain("integrity-failed");
    expect(check?.recovery?.suggestedCommand).toContain("ARTIFACT_INTEGRITY_FAILED");
  });

  it("blocks through artifacts.checksums for a missing and a mismatched current Artifact (VLT-023)", () => {
    const home = tempHome("sorage-doctor-checksums-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const vault = join(home, "vault");

    const goodBytes = "good bytes";
    const goodSha = createHash("sha256").update(goodBytes).digest("hex");
    mkdirSync(join(vault, "artifacts/h-1/a-1"), { recursive: true });
    writeFileSync(join(vault, "artifacts/h-1/a-1/good.md"), goodBytes);
    mkdirSync(join(vault, "artifacts/h-1/a-2"), { recursive: true });
    writeFileSync(join(vault, "artifacts/h-1/a-2/tampered.md"), "tampered bytes");

    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      database.exec("PRAGMA foreign_keys = ON");
      // The artifacts registry arrives migrated by the TASK-027 domain migration, so
      // the probe's columns are the live table's contract: one Handoff row carries the
      // current Artifact while two further registry rows exist for the checksum probe.
      database.exec("BEGIN");
      database
        .prepare(
          "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES ('p-1', 'p-1', 'p-1', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      database
        .prepare(
          "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, created_at, updated_at) VALUES ('h-1', NULL, NULL, 'Checksum probe', 'registered_project', 'p-1', NULL, NULL, 'p-1', 'a-1', 1, 1, 'awaiting_recipient', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      // Schema 9: each registry row references its own immutable content record
      // that carries the physical columns.
      const insertRecord = database.prepare(
        "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, NULL, ?, 10, ?, 1, '2026-01-01T00:00:00.000Z')",
      );
      const insertArtifact = database.prepare(
        "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, 'h-1', 'doc.md', 'doc.md', 'text/markdown', NULL, '2026-01-01T00:00:00.000Z', ?)",
      );
      for (const [artifactId, storageKey] of [
        ["a-1", "artifacts/h-1/a-1/good.md"],
        ["a-2", "artifacts/h-1/a-2/tampered.md"],
        ["a-3", "artifacts/h-1/a-3/missing.md"],
      ] as const) {
        const recordId = `c-${artifactId}`;
        insertRecord.run(recordId, storageKey, goodSha);
        insertArtifact.run(artifactId, recordId);
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }

    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    const check = report.data.checks.find((entry) => entry.id === "artifacts.checksums");
    expect(check?.severity).toBe("blocking");
    expect(check?.message).toContain("artifacts/h-1/a-2/tampered.md");
    expect(check?.message).toContain("artifacts/h-1/a-3/missing.md");
    expect(check?.message).not.toContain("artifacts/h-1/a-1/good.md");
    expect(check?.recovery?.suggestedCommand).toContain("sorage vault verify");
  });
});

describe("the TASK-118 doctor configuration and Vault branches", () => {
  const CONFIG_REPAIR = "sorage config validate, then repair the reported keys";
  const HOME_PERMISSIONS =
    "Restore the home directory with mode 0700 and config.yaml with owner-only 0600 permissions; do not reinitialize an existing installation";

  function checkOf(report: DoctorEnvelope, id: string) {
    return report.data.checks.find((entry) => entry.id === id);
  }

  it("classifies a malformed configuration as configuration repair and restores it with config validate", () => {
    const home = tempHome("sorage-t118-cli-malformed-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const configPath = join(home, "config.yaml");
    const valid = readFileSync(configPath, "utf8");
    writeFileSync(configPath, "not: [valid\n");
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    for (const id of [
      "config.schema",
      "vault.marker",
      "vault.gitattributes",
      "vault.writable",
      "artifacts.checksums",
      "content.checksums",
      "daemon.port",
      "backup.schedule",
      "git.state",
      "platform.tcc",
    ]) {
      const check = checkOf(report, id);
      expect(check, id).toBeDefined();
      expect(check?.severity, id).not.toBe("ok");
      expect(check?.recovery?.suggestedCommand, id).toBe(CONFIG_REPAIR);
    }
    for (const check of report.data.checks) {
      const recovery = check.recovery?.suggestedCommand ?? "";
      expect(recovery, check.id).not.toContain("sorage vault verify");
      expect(recovery, check.id).not.toContain("sorage init --reconfigure");
    }

    // K3: the named command actually runs in this state and reports the problem.
    const validate = capture();
    expect(runCli(["config", "validate"], validate.ports)).toBe(78);
    expect(validate.errText()).toContain("CONFIG_INVALID");
    // Repairing the reported keys restores the check.
    writeFileSync(configPath, valid);
    expect(runCli(["config", "validate"], capture().ports)).toBe(0);
    const repaired = capture();
    expect(runCli(["doctor", "--json"], repaired.ports)).toBe(0);
    const repairedReport = JSON.parse(repaired.outText()) as DoctorEnvelope;
    expect(checkOf(repairedReport, "config.schema")?.severity).toBe("ok");
  });

  it.skipIf(process.getuid?.() === 0)(
    "classifies an unreadable configuration as an access failure instead of the pre-init report",
    () => {
      const home = tempHome("sorage-t118-cli-unreadable-");
      expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
      const configPath = join(home, "config.yaml");
      chmodSync(configPath, 0o000);
      try {
        const doctor = capture();
        expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
        const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
        expect(report.data.checks).toHaveLength(21);
        const schema = checkOf(report, "config.schema");
        expect(schema?.message).not.toContain("Sorage is not initialized");
        expect(schema?.recovery?.suggestedCommand).toBe(HOME_PERMISSIONS);
        const marker = checkOf(report, "vault.marker");
        expect(marker?.recovery?.suggestedCommand).toBe(HOME_PERMISSIONS);
      } finally {
        chmodSync(configPath, 0o600);
      }
      // K3: following the access repair restores the check.
      const repaired = capture();
      expect(runCli(["doctor", "--json"], repaired.ports)).toBe(0);
      const repairedReport = JSON.parse(repaired.outText()) as DoctorEnvelope;
      expect(checkOf(repairedReport, "config.schema")?.severity).toBe("ok");
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "classifies a denied home traversal as an access failure instead of the pre-init report",
    () => {
      const home = tempHome("sorage-t118-cli-parent-");
      expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
      chmodSync(home, 0o000);
      try {
        const doctor = capture();
        expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
        const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
        expect(report.data.checks).toHaveLength(21);
        const schema = checkOf(report, "config.schema");
        expect(schema?.message).not.toContain("Sorage is not initialized");
        expect(schema?.message).toBe("config.yaml cannot be read.");
        expect(schema?.recovery?.suggestedCommand).toBe(HOME_PERMISSIONS);
      } finally {
        chmodSync(home, 0o700);
      }
      const repaired = capture();
      expect(runCli(["doctor", "--json"], repaired.ports)).toBe(0);
      expect(checkOf(JSON.parse(repaired.outText()) as DoctorEnvelope, "config.schema")?.severity).toBe("ok");
    },
  );

  it("repairs a directory at the configuration path instead of suggesting 0600", () => {
    const home = tempHome("sorage-t118-cli-config-path-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const configPath = join(home, "config.yaml");
    const valid = readFileSync(configPath, "utf8");
    rmSync(configPath, { force: true });
    mkdirSync(configPath);
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    const schema = checkOf(report, "config.schema");
    expect(schema?.message).toBe("The configuration path is not a regular config.yaml file.");
    expect(schema?.recovery?.suggestedCommand).toBe(
      "Replace the non-regular entry, dangling symlink, or symlink loop at the configuration path with a regular config.yaml file owned by this user, or a symlink to one",
    );
    expect(schema?.recovery?.suggestedCommand).not.toContain("0600");
    // K3: the path repair restores the check.
    rmSync(configPath, { recursive: true, force: true });
    writeFileSync(configPath, valid);
    chmodSync(configPath, 0o600);
    const repaired = capture();
    expect(runCli(["doctor", "--json"], repaired.ports)).toBe(0);
    expect(checkOf(JSON.parse(repaired.outText()) as DoctorEnvelope, "config.schema")?.severity).toBe("ok");
  });

  it("keeps the database diagnostic and adds the Vault-open recovery for a missing Vault", () => {
    const home = tempHome("sorage-t118-cli-db-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const vault = join(home, "vault");
    rmSync(vault, { recursive: true, force: true });
    // A corrupt database file keeps the database diagnostic while the Vault is missing.
    writeFileSync(join(home, "state", "sorage.sqlite3"), "not a database");
    rmSync(join(home, "state", "sorage.sqlite3-wal"), { force: true });
    rmSync(join(home, "state", "sorage.sqlite3-shm"), { force: true });
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    const checksums = checkOf(report, "artifacts.checksums");
    expect(checksums?.severity).toBe("blocking");
    expect(checksums?.message).toContain("database");
    expect(checksums?.recovery?.suggestedCommand).toBe(
      "Check the configured vault.path with sorage config show and confirm the Vault directory is present and its volume is mounted; if the Vault is lost, restore a verified backup into a fresh installation. Do not initialize the configured path or replace a Vault that may only be unmounted",
    );
    const integrity = checkOf(report, "db.integrity");
    expect(integrity?.severity).toBe("blocking");
    expect(integrity?.message).toContain("database");
    expect(integrity?.recovery?.suggestedCommand).toContain("Restore from ~/.sorage/state/backups/");
    const marker = checkOf(report, "vault.marker");
    expect(marker?.message).toBe(`The Vault directory does not exist at ${vault}.`);
  });

  it("never names sorage vault verify when the Vault is missing and no records exist", () => {
    const home = tempHome("sorage-t118-cli-v1-empty-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    for (const check of report.data.checks) {
      expect(check.recovery?.suggestedCommand ?? "", check.id).not.toContain("sorage vault verify");
    }
    const attributes = checkOf(report, "vault.gitattributes");
    expect(attributes?.severity).toBe("warning");
    expect(attributes?.recovery?.suggestedCommand).toContain("Do not initialize");
  });

  it("repairs a loose home permission without suggesting reinitialization", () => {
    const home = tempHome("sorage-t118-cli-home-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    chmodSync(join(home, "config.yaml"), 0o644);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as DoctorEnvelope;
    const permissions = checkOf(report, "home.permissions");
    expect(permissions?.severity).toBe("blocking");
    expect(permissions?.recovery?.suggestedCommand).toBe(HOME_PERMISSIONS);
  });
});
