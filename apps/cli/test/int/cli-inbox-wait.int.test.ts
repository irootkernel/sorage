import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The `inbox --wait` CLI surface of TASK-036 (CLI-020): the timeout answers exit 0
 * with the empty list and `meta.timedOut: true`, a Handoff created during the wait
 * returns before the timeout through a real second process, and `--wait` refuses to
 * combine with `--cursor` because a wait lists only new items.
 */
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
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

function fixture(): { home: string; workA: string; workB: string } {
  const home = tempHome("sorage-inbox-wait-");
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  const workA = join(home, "work-a");
  const workB = join(home, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
  return { home, workA, workB };
}

interface WaitEnvelope {
  ok: boolean;
  data: { handoffs: Array<{ id: string }>; nextCursor: string | null };
  meta: { requestId: string; timedOut?: boolean };
}

describe("sorage inbox --wait", () => {
  it("times out at exit 0 with an empty list and meta.timedOut true", () => {
    fixture();
    const wait = capture();
    const exit = runCli(["inbox", "--as", "beta", "--wait", "--timeout", "1", "--interval", "1", "--json"], wait.ports);
    expect(exit).toBe(0);
    expect(wait.errText()).toBe("");
    const envelope = JSON.parse(wait.outText()) as WaitEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.handoffs).toEqual([]);
    expect(envelope.data.nextCursor).toBeNull();
    expect(envelope.meta.timedOut).toBe(true);
  });

  it("returns a Handoff created during the wait before the timeout", async () => {
    const { home, workA } = fixture();
    const child: ChildProcess = spawn(
      "bun",
      [entry, "inbox", "--as", "beta", "--wait", "--timeout", "30", "--interval", "1", "--json"],
      {
        env: { ...process.env, SORAGE_HOME: home },
        cwd: workA,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Let the wait take its first poll, then create the Handoff from a second process.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      runCli(
        ["send", "--as", "alpha", "--to", "beta", "--title", "During the wait", "--body", "# Late\n"],
        capture().ports,
      ),
    ).toBe(0);
    const started = Date.now();
    const exit = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    const envelope = JSON.parse(stdout) as WaitEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.timedOut).toBeUndefined();
    expect(envelope.data.handoffs).toHaveLength(1);
    // The wait answered on the poll after the send, far inside its 30s budget.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses an --interval below one second as a usage error at exit 2", () => {
    fixture();
    const wait = capture();
    const exit = runCli(["inbox", "--as", "beta", "--wait", "--interval", "0", "--json"], wait.ports);
    expect(exit).toBe(2);
    expect(wait.errText()).toContain("whole-second intervals");
  });

  it("refuses --wait together with --cursor as a usage error at exit 2", () => {
    fixture();
    const wait = capture();
    const exit = runCli(["inbox", "--as", "beta", "--wait", "--cursor", "opaque", "--json"], wait.ports);
    expect(exit).toBe(2);
    expect(wait.errText()).toContain("inbox --wait cannot combine with --cursor");
  });
});
