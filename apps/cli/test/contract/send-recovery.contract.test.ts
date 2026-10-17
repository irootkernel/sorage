import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appError } from "@sorage/core";
import { afterAll, describe, expect, it } from "vitest";
import { renderSendRecoveryError } from "../../src/send-recovery-command";

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const golden = fileURLToPath(new URL("./golden/", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "sorage-recovery-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function pin(name: string, value: string) {
  const path = join(golden, name);
  const normalized = value.replace(/\n*$/, "\n");
  if (process.env.SORAGE_UPDATE_GOLDENS === "1") writeFileSync(path, normalized);
  else expect(normalized).toBe(readFileSync(path, "utf8"));
}
function run(args: string[]) {
  const p = spawnSync("bun", [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, SORAGE_HOME: join(root, "absent") },
  });
  expect(p.status, p.stderr).toBe(0);
  return p.stdout;
}
describe("additive CLI send recovery snapshots", () => {
  it("pins send help and both shell completion scripts", () => {
    pin("send-recovery-help.txt", run(["send", "--help"]));
    pin("send-recovery-completion-zsh.txt", run(["completion", "zsh"]));
    pin("send-recovery-completion-bash.txt", run(["completion", "bash"]));
  });
  it("pins contextual JSON and human refusals without changing operational defaults", () => {
    const results = [];
    for (const code of [
      "IDEMPOTENCY_CONFLICT",
      "INTERNAL_ERROR",
      "HANDOFF_REPLAY_UNAVAILABLE",
      "STORAGE_SCHEMA_UNSUPPORTED",
      "STORAGE_INTEGRITY_ERROR",
      "STORAGE_INSPECTION_UNAVAILABLE",
      "NOT_INITIALIZED",
      "SOURCE_OUTSIDE_WORKSPACE",
    ] as const) {
      const renders = [];
      for (const json of [true, false]) {
        let output = "";
        const exit = renderSendRecoveryError(appError(code, "an execute-only hint must not escape"), {
          json,
          requestId: "2f0ac9a0-0000-4000-8000-0000000000aa",
          ports: {
            out: () => {
              throw new Error("unexpected stdout");
            },
            err: (s) => {
              output += s;
            },
          },
        });
        renders.push({ json, exit, output });
      }
      results.push({ code, renders });
    }
    pin("send-recovery-errors.json", `${JSON.stringify(results, null, 2)}\n`);
  });
  it("actually completes send --replay-only in clean bash and zsh", () => {
    const bash = join(root, "completion.bash"),
      zsh = join(root, "completion.zsh");
    writeFileSync(bash, run(["completion", "bash"]));
    writeFileSync(zsh, run(["completion", "zsh"]));
    const b = spawnSync(
      "bash",
      [
        "-c",
        `source "$1"; COMP_WORDS=(sorage send --re); COMP_CWORD=2; _sorage; printf "%s\\n" "\${COMPREPLY[@]}"`,
        "completion",
        bash,
      ],
      { encoding: "utf8" },
    );
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout.trim()).toBe("--replay-only");
    const z = spawnSync(
      "zsh",
      [
        "-f",
        "-c",
        'source "$1"; _describe() { :; }; _arguments() { print -l -- "$@"; }; words=(sorage send --re); _sorage',
        "completion",
        zsh,
      ],
      { encoding: "utf8" },
    );
    expect(z.status, z.stderr).toBe(0);
    expect(z.stdout.split("\n")).toContain("--replay-only");
  });
});
