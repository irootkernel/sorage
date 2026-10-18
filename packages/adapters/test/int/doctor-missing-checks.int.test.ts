import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createHomePaths } from "../../src/home";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { initializeInstallation, vaultVerify } from "@sorage/core";
import { FakeClock } from "../../src/testkit/fakes";

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
