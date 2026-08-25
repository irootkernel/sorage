import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

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
    errText(): string {
      return err.join("");
    },
  };
}

describe("sorage process logging", () => {
  it("writes one warn JSON line to <home>/logs/sorage.log for a failed command", () => {
    const home = tempHome("sorage-cli-logging-");
    const cap = capture();
    const code = runCli(["config", "show", "--json"], cap.ports);
    expect(code).toBe(78);
    const logFile = join(home, "logs", "sorage.log");
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as { level: string; event: string; code: string; requestId: string };
    expect(record.level).toBe("warn");
    expect(record.event).toBe("cli.command_failed");
    expect(record.code).toBe("NOT_INITIALIZED");
    const envelope = JSON.parse(cap.errText()) as { error: { code: string }; meta: { requestId: string } };
    expect(envelope.error.code).toBe("NOT_INITIALIZED");
    expect(record.requestId).toBe(envelope.meta.requestId);
  });

  it("keeps a successful run from touching the log directory", () => {
    const home = tempHome("sorage-cli-logging-silent-");
    const cap = capture();
    expect(runCli(["version", "--json"], cap.ports)).toBe(0);
    expect(existsSync(join(home, "logs"))).toBe(false);
  });
});
