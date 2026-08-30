import { describe, expect, it } from "vitest";
import { ok } from "@sorage/core";
import { defaultConfiguration } from "@sorage/core";
import { runWebCommand, type WebRuntimePorts } from "../../src/web";

/**
 * The `sorage web` orchestration (RUN-012, SEC-019) with every side effect faked: the
 * daemon is probed, started when nothing answers, and the opened URL carries the
 * single-use fragment secret that the store just issued.
 */
const SECRET = "S".repeat(48);

function ports(overrides: Partial<WebRuntimePorts>): WebRuntimePorts {
  return {
    probeDaemon: () => false,
    spawnDaemon: () => {},
    openBrowser: () => {},
    readConfig: () => ok(defaultConfiguration("1f0ac9a0-0000-4000-8000-00000000000b")),
    issueSecret: () => ok({ secret: SECRET, expiresAt: "2026-08-30T00:05:00.000Z" }),
    ...overrides,
  };
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, ports: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

describe("runWebCommand", () => {
  it("uses the running daemon and opens the fragment URL with the issued secret", () => {
    const opened: string[] = [];
    const harness = sink();
    let spawned = 0;
    const code = runWebCommand(
      ports({
        probeDaemon: () => true,
        spawnDaemon: () => {
          spawned += 1;
        },
        openBrowser: (url) => opened.push(url),
      }),
      harness.ports,
      { openBrowser: true },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(opened).toEqual([`http://127.0.0.1:46321/#s=${SECRET}`]);
    const payload = JSON.parse(harness.out.join(""));
    expect(payload.url).toBe(`http://127.0.0.1:46321/#s=${SECRET}`);
    expect(payload.daemonStarted).toBe(false);
  });

  it("starts the daemon when nothing answers and reports it", () => {
    const opened: string[] = [];
    const harness = sink();
    let probes = 0;
    let spawned = 0;
    const code = runWebCommand(
      ports({
        probeDaemon: () => {
          probes += 1;
          return probes > 2;
        },
        spawnDaemon: () => {
          spawned += 1;
        },
        openBrowser: (url) => opened.push(url),
      }),
      harness.ports,
      { openBrowser: true },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(1);
    expect(JSON.parse(harness.out.join("")).daemonStarted).toBe(true);
  });

  it("fails with DAEMON_UNAVAILABLE when the daemon never becomes ready", () => {
    const harness = sink();
    const code = runWebCommand(ports({ probeDaemon: () => false }), harness.ports, {
      openBrowser: true,
      startTimeoutMs: 300,
    });
    expect(code).toBe(69);
    expect(harness.err.join("")).toContain("DAEMON_UNAVAILABLE");
  });

  it("does not open a browser when asked not to", () => {
    const opened: string[] = [];
    const harness = sink();
    const code = runWebCommand(
      ports({ probeDaemon: () => true, openBrowser: (url) => opened.push(url) }),
      harness.ports,
      { openBrowser: false },
    );
    expect(code).toBe(0);
    expect(opened).toEqual([]);
    expect(harness.out.join("")).toContain("#s=");
  });

  it("names the bound address so an IPv6 loopback yields a reachable URL", () => {
    const opened: string[] = [];
    const harness = sink();
    const ipv6 = defaultConfiguration("1f0ac9a0-0000-4000-8000-0000000000c");
    ipv6.server.host = "::1";
    const code = runWebCommand(
      ports({ probeDaemon: () => true, openBrowser: (url) => opened.push(url), readConfig: () => ok(ipv6) }),
      harness.ports,
      { openBrowser: true },
    );
    expect(code).toBe(0);
    // The bracketed literal is reachable in a browser; a dead 127.0.0.1 URL is not.
    expect(opened).toEqual([`http://[::1]:46321/#s=${SECRET}`]);
  });
});
