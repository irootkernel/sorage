import { describe, expect, it } from "vitest";
import { runCli, type OutputPorts } from "../../src/main";

function capture(): { ports: OutputPorts; out: string; err: string } {
  let out = "";
  let err = "";
  return {
    ports: {
      out: (t) => {
        out = out + t;
      },
      err: (t) => {
        err = err + t;
      },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe("cli shell", () => {
  it("prints only the JSON envelope on stdout for version --json", () => {
    const cap = capture();
    const code = runCli(["version", "--json"], cap.ports);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out) as { ok: boolean; data: Record<string, unknown>; meta: Record<string, string> };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.cli).toBe("sorage");
    expect(parsed.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cap.err).toBe("");
  });

  it("prints human version text on stdout without --json", () => {
    const cap = capture();
    expect(runCli(["version"], cap.ports)).toBe(0);
    expect(cap.out).toContain("sorage 0.0.0");
  });

  it("exits 0 for help", () => {
    const cap = capture();
    expect(runCli(["--help"], cap.ports)).toBe(0);
    expect(cap.out).toContain("Usage:");
  });

  it("exits 2 for an unknown command and renders the diagnostic exactly once", () => {
    const cap = capture();
    expect(runCli(["definitely-not-a-command"], cap.ports)).toBe(2);
    expect(cap.err).toContain("unknown command");
    expect(cap.out).toBe("");
    expect(cap.err.match(/unknown command/g)).toHaveLength(1);
  });

  it("exits 0 and prints help for a bare invocation", () => {
    const cap = capture();
    expect(runCli([], cap.ports)).toBe(0);
    expect(cap.out).toContain("Usage:");
  });

  it("exits 2 for a malformed or fractional option value", () => {
    for (const bad of ["not-a-number", "3.5", "10x", "9007199254740992"]) {
      const cap = capture();
      expect(runCli(["--limit", bad, "version"], cap.ports)).toBe(2);
      expect(cap.err).toContain("non-negative integer");
    }
  });

  it("carries every global option", () => {
    const cap = capture();
    expect(
      runCli(
        [
          "--as",
          "web-app",
          "--as-user",
          "--confirm",
          "--expected-row-version",
          "3",
          "--limit",
          "20",
          "--cursor",
          "abc",
          "version",
        ],
        cap.ports,
      ),
    ).toBe(0);
  });
});
