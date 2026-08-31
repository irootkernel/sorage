import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createHomePaths } from "../../src/home";

/**
 * The TASK-068 probe proofs (INIT-017, RUN-013, SEC-002, SEC-020): the two
 * checks the twenty-id catalog documents and no build emitted, driven through
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
