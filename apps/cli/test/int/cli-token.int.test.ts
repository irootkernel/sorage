import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-043 CLI surface: `init` now also creates the Installation API token at
 * `state/api-token` with `0600` (INIT-003, SEC-020), and `token rotate --as-user`
 * replaces it while the ungated form stops at `USER_CONTEXT_REQUIRED` (CLI-019).
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
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

function tokenPath(home: string): string {
  return join(home, "state", "api-token");
}

describe("init creates the Installation API token (INIT-003)", () => {
  it("writes a well-formed owner-only token file next to the configuration", () => {
    const home = tempHome("sorage-cli-token-init-");
    const sink = capture();
    const vault = join(home, "vault");
    const code = runCli(["init", "--vault", vault, "--non-interactive", "--json"], sink.ports);
    expect(code).toBe(0);
    const token = readFileSync(tokenPath(home), "utf8").trim();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
    expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
    // A second init changes nothing: the token stays byte-identical.
    const again = runCli(["init", "--vault", vault, "--non-interactive", "--json"], sink.ports);
    expect(again).toBe(0);
    expect(readFileSync(tokenPath(home), "utf8").trim()).toBe(token);
  });
});

describe("sorage token rotate (SEC-020)", () => {
  it("refuses without --as-user at exit 77 with USER_CONTEXT_REQUIRED", () => {
    const home = tempHome("sorage-cli-token-gate-");
    const sink = capture();
    runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports);
    const code = runCli(["token", "rotate", "--json"], sink.ports);
    expect(code).toBe(77);
    expect(JSON.parse(sink.errText()).error.code).toBe("USER_CONTEXT_REQUIRED");
  });

  it("replaces the token with --as-user and never echoes the material", () => {
    const home = tempHome("sorage-cli-token-rotate-");
    const sink = capture();
    runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports);
    const before = readFileSync(tokenPath(home), "utf8").trim();
    const rotateSink = capture();
    const code = runCli(["token", "rotate", "--as-user", "--json"], rotateSink.ports);
    expect(code).toBe(0);
    const after = readFileSync(tokenPath(home), "utf8").trim();
    expect(after).not.toBe(before);
    expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
    const output = JSON.parse(rotateSink.outText());
    expect(output.ok).toBe(true);
    expect(JSON.stringify(output)).not.toContain(after);
    expect(JSON.stringify(output)).not.toContain(before);
  });

  it("requires an initialized installation", () => {
    const home = tempHome("sorage-cli-token-uninit-");
    const sink = capture();
    const code = runCli(["token", "rotate", "--as-user", "--json"], sink.ports);
    expect(code).toBe(78);
    expect(JSON.parse(sink.errText()).error.code).toBe("NOT_INITIALIZED");
  });
});
