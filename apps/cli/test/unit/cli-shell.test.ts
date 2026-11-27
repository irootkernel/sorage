import { DAEMON_VERSION } from "@sorage/daemon";
import { SORAGE_VERSION } from "@sorage/core";
import { describe, expect, it } from "vitest";
import { CLI_VERSION, type OutputPorts } from "../../src/cli-output";
import { runCli } from "../../src/program";

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
  it("reports the same product version as the daemon", () => {
    expect(SORAGE_VERSION).toBe("0.1.6");
    expect(CLI_VERSION).toBe(SORAGE_VERSION);
    expect(DAEMON_VERSION).toBe(SORAGE_VERSION);
  });

  it("prints the compact ecosystem version object on stdout for version --json", () => {
    const cap = capture();
    const code = runCli(["version", "--json"], cap.ports);
    expect(code).toBe(0);
    expect(cap.out).toBe('{"name":"sorage","version":"v0.1.6"}\n');
    expect(cap.err).toBe("");
  });

  it("prints human version text on stdout without --json", () => {
    const cap = capture();
    expect(runCli(["version"], cap.ports)).toBe(0);
    expect(cap.out).toBe("sorage v0.1.6\n");
  });

  it("exits 0 for help", () => {
    const cap = capture();
    expect(runCli(["--help"], cap.ports)).toBe(0);
    expect(cap.out).toContain("Usage:");
  });

  it("exits 0 for the literal help subcommand", () => {
    const cap = capture();
    expect(runCli(["help"], cap.ports)).toBe(0);
    expect(cap.out).toContain("Usage:");
    expect(cap.err).toBe("");
  });

  it("exits 2 for an unknown command and renders the diagnostic exactly once", () => {
    const cap = capture();
    expect(runCli(["definitely-not-a-command"], cap.ports)).toBe(2);
    expect(cap.err).toContain("unknown command");
    expect(cap.out).toBe("");
    expect(cap.err.match(/unknown command/g)).toHaveLength(1);
  });

  it("registers review show and events as catalog commands", () => {
    const reviewHelp = capture();
    expect(runCli(["review", "--help"], reviewHelp.ports)).toBe(0);
    expect(reviewHelp.out).toContain("show");
    const eventsHelp = capture();
    expect(runCli(["events", "--help"], eventsHelp.ports)).toBe(0);
    expect(eventsHelp.out).toContain("bounded recent metadata timeline");
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

  it("signals global-flag mcp synchronously via onMcpRequested without starting inside Commander", () => {
    const cap = capture();
    let requested = 0;
    const code = runCli(["--json", "mcp"], cap.ports, undefined, false, {
      onMcpRequested: () => {
        requested += 1;
      },
    });
    expect(code).toBe(-1);
    expect(requested).toBe(1);
    expect(cap.out).toBe("");
    expect(cap.err).toBe("");
  });

  it("handles mcp --help and mcp extra synchronously without triggering onMcpRequested", () => {
    let requested = 0;
    const onMcpRequested = () => {
      requested += 1;
    };
    const helped = capture();
    expect(runCli(["mcp", "--help"], helped.ports, undefined, false, { onMcpRequested })).toBe(0);
    expect(helped.out).toContain("STDIO MCP adapter");
    expect(requested).toBe(0);

    const extra = capture();
    expect(runCli(["mcp", "extra"], extra.ports, undefined, false, { onMcpRequested })).toBe(2);
    expect(extra.err).toContain("arguments");
    expect(requested).toBe(0);
  });
});
