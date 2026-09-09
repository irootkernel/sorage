import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { errorSpec } from "@sorage/core";
import { renderAppError, runCli } from "../../src/main";

/**
 * The TASK-040 surface: `sorage completion <shell>` emits a script that loads in a
 * clean shell (CLI-015), every command's `--help` exits 0, the `--as-user` help
 * carries the User-admin honesty clause (SEC-021), and the recovery hint of the four
 * common failures names the next valid command (CLI-016).
 */
const _entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

const commandPaths = [
  ["version"],
  ["init"],
  ["config"],
  ["config", "show"],
  ["config", "validate"],
  ["config", "set"],
  ["config", "edit"],
  ["doctor"],
  ["project"],
  ["project", "add"],
  ["project", "list"],
  ["project", "show"],
  ["project", "rename"],
  ["project", "bind"],
  ["project", "unbind"],
  ["project", "archive"],
  ["project", "unarchive"],
  ["project", "resolve"],
  ["send"],
  ["inbox"],
  ["outbox"],
  ["get"],
  ["fetch"],
  ["events"],
  ["review"],
  ["review", "show"],
  ["review", "set"],
  ["review", "withdraw"],
  ["review", "remove"],
  ["revise"],
  ["accept"],
  ["decline"],
  ["withdraw"],
  ["pin"],
  ["unpin"],
  ["archive"],
  ["unarchive"],
  ["delete"],
  ["delete", "request"],
  ["delete", "approve"],
  ["delete", "reject"],
  ["vault"],
  ["vault", "status"],
  ["vault", "verify"],
  ["vault", "move"],
  ["completion"],
];

const errorSpecExit = (code: string): number => errorSpec(code as never).exitCode;

describe("shell completion", () => {
  it("prints a zsh script that loads in a clean shell and refuses an unknown shell", () => {
    const zsh = capture();
    expect(runCli(["completion", "zsh"], zsh.ports)).toBe(0);
    expect(zsh.errText()).toBe("");
    const script = zsh.outText();
    expect(script).toContain("#compdef sorage");
    expect(script).toContain("_sorage()");
    const path = join(mkdtempSync(join(tmpdir(), "sorage-comp-")), "sorage.zsh");
    homes.push(join(path, ".."));
    writeFileSync(path, script, "utf8");
    expect(
      execFileSync("zsh", ["-f", "-c", `source ${path}; (( $+functions[_sorage] )) && echo LOADS`], {
        encoding: "utf8",
      }),
    ).toContain("LOADS");
    const unknown = capture();
    expect(runCli(["completion", "fish"], unknown.ports)).toBe(2);
    expect(unknown.errText()).toContain("completion supports zsh and bash");
  });

  it("prints a bash script that loads in a clean shell", () => {
    const bash = capture();
    expect(runCli(["completion", "bash"], bash.ports)).toBe(0);
    const path = join(mkdtempSync(join(tmpdir(), "sorage-comp-")), "sorage.bash");
    homes.push(join(path, ".."));
    writeFileSync(path, bash.outText(), "utf8");
    expect(execFileSync("bash", ["-c", `source ${path}; type -t _sorage`], { encoding: "utf8" })).toContain("function");
  });
});

describe("contextual help", () => {
  it("exits 0 for --help on the root and every command in the catalog", () => {
    const root = capture();
    expect(runCli(["--help"], root.ports)).toBe(0);
    for (const path of commandPaths) {
      const cap = capture();
      const exit = runCli([...path, "--help"], cap.ports);
      expect(exit, path.join(" ")).toBe(0);
      expect(cap.outText(), path.join(" ")).toContain("Usage:");
    }
  });

  it("carries the User-admin honesty clause in the --as-user help", () => {
    const root = capture();
    expect(runCli(["--help"], root.ports)).toBe(0);
    // Commander wraps option help to the terminal width, so the clause is matched
    // against whitespace-normalized text rather than one raw line.
    const help = root.outText().replace(/\s+/g, " ");
    expect(help).toContain("User-admin rows express workflow intent");
    expect(help).toContain("any process able to run the CLI as this operating-system user can assert User context");
  });

  it("names the next valid command after the four common failures", () => {
    const recoveries: Record<string, string> = {
      NOT_INITIALIZED: "sorage init",
      PROJECT_UNBOUND: "sorage project bind",
      REVIEW_NOTE_PRESENT: "sorage revise <handoff-id> --file <path>",
      HANDOFF_TERMINAL: "sorage send --supersedes <handoff-id>",
    };
    for (const [code, expected] of Object.entries(recoveries)) {
      const cap = capture();
      const probe = { code, message: "probe" } as Parameters<typeof renderAppError>[0];
      expect(renderAppError(probe, cap.ports, false)).toBe(errorSpecExit(code));
      expect(cap.errText(), code).toContain("Recovery: ");
      expect(cap.errText(), code).toContain(expected);
    }
  });
});
