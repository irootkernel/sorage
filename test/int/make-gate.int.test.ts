import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const preparation = [
  "run check:toolchain",
  "run check:version",
  "install --frozen-lockfile",
  "run check:format",
  "run check:lint",
  "run check:typecheck",
  "run check:import-boundaries",
  "run check:dependency-boundaries",
  "run check:sot",
];
const stages = [
  ...preparation,
  "run test:unit",
  "run package",
  "run test:int",
  "run test:contract",
  "run test:e2e",
  "run test:release",
];

/** Exercise the real Makefile with a recording runner, without building or installing. */
function runGate(target: string, fail = "") {
  const directory = mkdtempSync(join(tmpdir(), "sorage-make-gate-"));
  try {
    copyFileSync(new URL("../../Makefile", import.meta.url), join(directory, "Makefile"));
    const runner = join(directory, "bun");
    const log = join(directory, "commands.log");
    writeFileSync(log, "");
    writeFileSync(
      runner,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GATE_LOG"\nif [ "$*" = "$GATE_FAIL" ]; then exit 7; fi\n',
    );
    chmodSync(runner, 0o755);
    const result = spawnSync("make", ["-j4", target, `BUN=${runner}`], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, SORAGE_HOME: join(directory, "home"), GATE_LOG: log, GATE_FAIL: fail },
    });
    return { ...result, commands: readFileSync(log, "utf8").trim().split("\n") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("the single make test gate", () => {
  it("runs preparation, every test stage, and packaging in order under parallel make", () => {
    const result = runGate("test");
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual(stages);
  });

  it.each([
    "run check:toolchain",
    "run test:unit",
    "run package",
    "run test:int",
    "run test:contract",
    "run test:e2e",
    "run test:release",
  ])("stops after %s fails", (command) => {
    const result = runGate("test", command);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.commands).toEqual(stages.slice(0, stages.indexOf(command) + 1));
  });

  it.each([
    ["test-int", ["run build:cli", "run test:int"]],
    ["test-e2e", ["run build:cli", "run test:e2e"]],
    ["test-release", ["run package", "run test:release"]],
  ])("prepares the required executable for standalone %s", (target, commands) => {
    const result = runGate(target);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual(commands);
  });

  it.each(["test-int", "test-e2e"])("does not run %s after its build fails", (target) => {
    const result = runGate(target, "run build:cli");
    expect(result.status).not.toBe(0);
    expect(result.commands).toEqual(["run build:cli"]);
  });
});
