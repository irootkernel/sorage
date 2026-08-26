import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Golden-output harness every later command reuses: the CLI runs as a real process
 * with a deterministic request id, and stdout must match the committed golden file
 * exactly while stderr stays empty for successful commands.
 */
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

function runCli(args: string[], sorageHome?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [entry, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SORAGE_TEST_REQUEST_ID: "2f0ac9a0-0000-4000-8000-0000000000aa",
      ...(sorageHome !== undefined ? { SORAGE_HOME: sorageHome } : {}),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("cli golden snapshots", () => {
  it("pins `sorage version --json`", () => {
    const run = runCli(["version", "--json"]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const golden = readFileSync(`${goldenDir}version.json`, "utf8");
    expect(run.stdout).toBe(golden);
  });

  it("pins `sorage help`", () => {
    const run = runCli(["--help"]);
    expect(run.status).toBe(0);
    const golden = readFileSync(`${goldenDir}help.txt`, "utf8");
    expect(run.stdout).toBe(golden);
  });

  it("pins the pre-initialization NOT_INITIALIZED JSON envelope", () => {
    const run = runCli(["config", "show", "--json"], "/tmp/sorage-golden-home");
    expect(run.status).toBe(78);
    expect(run.stdout).toBe("");
    const golden = readFileSync(`${goldenDir}not-initialized.json`, "utf8");
    expect(run.stderr).toBe(golden);
  });

  it("exits 2 on a malformed invocation and pins the exact stderr", () => {
    const run = runCli(["definitely-not-a-command"]);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    const golden = readFileSync(`${goldenDir}malformed-stderr.txt`, "utf8");
    expect(run.stderr).toBe(golden);
  });

  it("pins the vault status NOT_INITIALIZED envelope before initialization", () => {
    const run = runCli(["vault", "status", "--json"], "/tmp/sorage-golden-home");
    expect(run.status).toBe(78);
    expect(run.stdout).toBe("");
    const golden = readFileSync(`${goldenDir}vault-status-not-initialized.json`, "utf8");
    expect(run.stderr).toBe(golden);
  });

  it("pins vault move without --as-user refusing with USER_CONTEXT_REQUIRED", () => {
    const init = runCli(["init", "--non-interactive"], "/tmp/sorage-golden-home2");
    expect(init.status).toBe(0);
    const run = runCli(["vault", "move", "--to", "/tmp/sorage-golden-moved"], "/tmp/sorage-golden-home2");
    expect(run.status).toBe(77);
    expect(run.stdout).toBe("");
    const golden = readFileSync(`${goldenDir}vault-move-requires-user-context.txt`, "utf8");
    expect(run.stderr).toBe(golden);
  });
});
