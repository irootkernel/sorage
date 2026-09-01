import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The `sorage send` CLI surface of TASK-029 through the real wiring: an initialized
 * temporary installation, two registered Projects, and a fan-out whose JSON envelope
 * prints every generated Handoff UUID with one dispatch group (CLI-007, CLI-008).
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

interface SendEnvelope {
  ok: boolean;
  data: {
    handoffs: Array<{
      handoffId: string;
      recipientSlug: string;
      storageKey: string;
      revision: number;
      rowVersion: number;
    }>;
    dispatchGroupId: string | null;
    replayed: boolean;
  };
}

describe("sorage send", () => {
  it("hands one document to two recipients through one dispatch group", () => {
    const home = tempHome("sorage-send-cli-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const workA = join(home, "work-a");
    const workB = join(home, "work-b");
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# The brief\n\nShared content.\n");

    const send = capture();
    const exit = runCli(
      [
        "send",
        "--to",
        "alpha",
        "--to",
        "beta",
        "--title",
        "Design brief",
        "--file",
        document,
        "--allow-external-source",
        "--json",
      ],
      send.ports,
    );
    if (exit !== 0) throw new Error(`send failed (${exit}): ${send.errText()}`);
    expect(exit).toBe(0);
    const envelope = JSON.parse(send.outText()) as SendEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.handoffs).toHaveLength(2);
    expect(envelope.data.dispatchGroupId).not.toBeNull();
    expect(new Set(envelope.data.handoffs.map((handoff) => handoff.recipientSlug))).toEqual(new Set(["alpha", "beta"]));
    for (const handoff of envelope.data.handoffs) {
      expect(handoff.revision).toBe(1);
      expect(handoff.rowVersion).toBe(1);
      expect(handoff.storageKey).toContain(handoff.handoffId);
    }
    expect(send.errText()).toBe("");
  });

  it("refuses --file and --body together as a usage error at exit 2", () => {
    const _home = tempHome("sorage-send-usage-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const send = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "T", "--file", "/tmp/x", "--body", "text"], send.ports)).toBe(2);
    expect(send.errText()).toContain("exactly one of --file or --body");
  });
});
