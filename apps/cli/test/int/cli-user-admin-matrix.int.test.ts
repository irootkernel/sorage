import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The CLI-019 matrix of TASK-036: every M1 User-admin command refuses to run without
 * `--as-user` at exit 77 with `USER_CONTEXT_REQUIRED` in its JSON envelope, so the
 * actor gate is uniform across the whole catalog rather than per-command folklore.
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
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

describe("the User-admin gate without --as-user", () => {
  it("answers exit 77 with USER_CONTEXT_REQUIRED for every M1 User-admin command", () => {
    const home = tempHome("sorage-user-admin-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const workA = join(home, "work-a");
    const workB = join(home, "work-b");
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# Shared\n");
    const send = capture();
    expect(
      runCli(
        [
          "send",
          "--as",
          "alpha",
          "--to",
          "beta",
          "--title",
          "Matrix",
          "--file",
          document,
          "--allow-external-source",
          "--json",
        ],
        send.ports,
      ),
    ).toBe(0);
    const handoffId = (JSON.parse(send.outText()) as { data: { handoffs: Array<{ handoffId: string }> } }).data
      .handoffs[0]?.handoffId as string;

    const commands: Array<[string, string[]]> = [
      ["config set", ["config", "set", "ui.defaultPageSize", "25", "--json"]],
      ["config edit", ["config", "edit", "--json"]],
      ["review remove", ["review", "remove", handoffId, "--confirm", "--json"]],
      ["pin", ["pin", handoffId, "--json"]],
      ["unpin", ["unpin", handoffId, "--json"]],
      ["archive", ["archive", handoffId, "--json"]],
      ["unarchive", ["unarchive", handoffId, "--json"]],
      ["delete approve", ["delete", "approve", handoffId, "--confirm", "--json"]],
      ["delete reject", ["delete", "reject", handoffId, "--json"]],
      ["vault move", ["vault", "move", "--to", join(home, "moved-vault"), "--json"]],
    ];

    for (const [label, args] of commands) {
      const cap = capture();
      const exit = runCli(args, cap.ports);
      expect(exit, label).toBe(77);
      expect(cap.outText(), label).toBe("");
      const envelope = JSON.parse(cap.errText()) as { error: { code: string } };
      expect(envelope.error.code, label).toBe("USER_CONTEXT_REQUIRED");
    }
  });
});
