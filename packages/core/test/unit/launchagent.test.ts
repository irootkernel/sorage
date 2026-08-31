import { describe, expect, it } from "vitest";
import { type AppError, ok, type Result } from "../../src/errors";
import {
  escapePlistValue,
  installLaunchAgent,
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_PLIST_FILENAME,
  type LaunchAgentPorts,
  launchAgentPlistPath,
  launchAgentTarget,
  renderLaunchAgentPlist,
  uninstallLaunchAgent,
} from "../../src/launchagent";

function fakePorts(overrides: Partial<LaunchAgentPorts> = {}): LaunchAgentPorts & {
  written: Map<string, string>;
  bootstrapCalls: string[][];
  bootoutCalls: number;
  removed: string[];
  loaded: boolean;
} {
  const written = new Map<string, string>();
  const bootstrapCalls: string[][] = [];
  let bootoutCalls = 0;
  const removed: string[] = [];
  let loaded = false;
  const ports: LaunchAgentPorts = {
    bootstrap: (plistPath: string): Result<{ bootstrapped: boolean }, AppError> => {
      bootstrapCalls.push([plistPath]);
      loaded = true;
      return ok({ bootstrapped: true });
    },
    bootout: (): Result<{ wasLoaded: boolean }, AppError> => {
      bootoutCalls += 1;
      loaded = false;
      return ok({ wasLoaded: true });
    },
    isLoaded: () => loaded,
    writePlist: (path: string, content: string) => {
      written.set(path, content);
      return ok(null);
    },
    readPlist: (path: string) => written.get(path) ?? null,
    removePlist: (path: string) => {
      removed.push(path);
      written.delete(path);
    },
    ensureDirectory: () => {},
    ...overrides,
  };
  const live = Object.defineProperties(ports, {
    written: { value: written },
    bootstrapCalls: { value: bootstrapCalls },
    removed: { value: removed },
    bootoutCalls: { get: () => bootoutCalls },
    loaded: { get: () => loaded },
  }) as LaunchAgentPorts & {
    written: Map<string, string>;
    bootstrapCalls: string[][];
    bootoutCalls: number;
    removed: string[];
    loaded: boolean;
  };
  return live;
}

describe("the LaunchAgent plist", () => {
  it("carries the canonical label, program arguments, home environment, and RunAtLoad", () => {
    const plist = renderLaunchAgentPlist({
      program: { binaryPath: "/usr/local/bin/sorage", scriptArgs: [] },
      sorageHome: "/Users/gul/.sorage",
    });
    expect(plist).toContain("<string>xyz.rootkernel.sorage</string>");
    expect(plist).toContain("<string>/usr/local/bin/sorage</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>SORAGE_HOME</key>");
    expect(plist).toContain("<string>/Users/gul/.sorage</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(LAUNCH_AGENT_LABEL).toBe("xyz.rootkernel.sorage");
    expect(LAUNCH_AGENT_PLIST_FILENAME).toBe("xyz.rootkernel.sorage.plist");
    expect(launchAgentTarget(501)).toBe("gui/501/xyz.rootkernel.sorage");
    expect(launchAgentPlistPath("/Users/gul/Library/LaunchAgents")).toBe(
      "/Users/gul/Library/LaunchAgents/xyz.rootkernel.sorage.plist",
    );
  });

  it("XML-escapes every value, so home paths with quotes and ampersands survive", () => {
    expect(escapePlistValue(`a"b&c<d>e'f`)).toBe("a&quot;b&amp;c&lt;d&gt;e&apos;f");
    const plist = renderLaunchAgentPlist({
      program: { binaryPath: `/opt/my "sorage"/bin/sorage`, scriptArgs: [] },
      sorageHome: `/Users/gul/it's <home> & mine/.sorage`,
    });
    expect(plist).toContain("<string>/opt/my &quot;sorage&quot;/bin/sorage</string>");
    expect(plist).toContain("<string>/Users/gul/it&apos;s &lt;home&gt; &amp; mine/.sorage</string>");
  });
});

describe("installLaunchAgent", () => {
  it("writes the plist and bootstraps it into gui/$UID", () => {
    const ports = fakePorts();
    const result = installLaunchAgent(ports, {
      program: { binaryPath: "/opt/sorage", scriptArgs: [] },
      sorageHome: "/tmp/home",
      agentsDirectory: "/tmp/agents",
      uid: 501,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plistPath).toBe("/tmp/agents/xyz.rootkernel.sorage.plist");
    expect(result.value.bootstrapped).toBe(true);
    expect(ports.bootstrapCalls).toEqual([["/tmp/agents/xyz.rootkernel.sorage.plist"]]);
    expect(ports.written.get("/tmp/agents/xyz.rootkernel.sorage.plist")).toContain("xyz.rootkernel.sorage");
  });

  it("leaves an already-loaded agent alone when the plist is unchanged", () => {
    const ports = fakePorts();
    const input = {
      program: { binaryPath: "/opt/sorage", scriptArgs: [] },
      sorageHome: "/tmp/home",
      agentsDirectory: "/tmp/agents",
      uid: 501,
    };
    const rendered = renderLaunchAgentPlist(input);
    ports.written.set("/tmp/agents/xyz.rootkernel.sorage.plist", rendered);
    ports.isLoaded = () => true;
    const result = installLaunchAgent(ports, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bootstrapped).toBe(false);
    expect(ports.bootstrapCalls).toEqual([]);
    expect(ports.bootoutCalls).toBe(0);
  });

  it("refreshes a loaded agent through boot-out and bootstrap when the plist changes", () => {
    const ports = fakePorts();
    const input = {
      program: { binaryPath: "/opt/sorage", scriptArgs: [] },
      sorageHome: "/tmp/home",
      agentsDirectory: "/tmp/agents",
      uid: 501,
    };
    ports.written.set("/tmp/agents/xyz.rootkernel.sorage.plist", "<plist><!-- older -->");
    ports.isLoaded = () => true;
    const result = installLaunchAgent(ports, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bootstrapped).toBe(true);
    expect(ports.bootoutCalls).toBe(1);
    expect(ports.bootstrapCalls).toEqual([["/tmp/agents/xyz.rootkernel.sorage.plist"]]);
  });
});

describe("uninstallLaunchAgent", () => {
  it("boots out a loaded agent and removes its plist", () => {
    const ports = fakePorts({ isLoaded: () => true });
    ports.writePlist("/tmp/agents/xyz.rootkernel.sorage.plist", "<plist/>");
    const result = uninstallLaunchAgent(ports, { agentsDirectory: "/tmp/agents", uid: 501 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasLoaded).toBe(true);
    expect(result.value.plistRemoved).toBe(true);
    expect(ports.bootoutCalls).toBe(1);
    expect(ports.removed).toEqual(["/tmp/agents/xyz.rootkernel.sorage.plist"]);
  });

  it("treats an unloaded agent as already gone and still removes a stray plist", () => {
    const ports = fakePorts();
    ports.writePlist("/tmp/agents/xyz.rootkernel.sorage.plist", "<plist/>");
    const result = uninstallLaunchAgent(ports, { agentsDirectory: "/tmp/agents", uid: 501 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasLoaded).toBe(false);
    expect(result.value.plistRemoved).toBe(true);
    expect(ports.bootoutCalls).toBe(0);
  });
});
