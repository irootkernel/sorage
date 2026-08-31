import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLaunchAgent, renderLaunchAgentPlist, uninstallLaunchAgent } from "@sorage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeDoctorPorts } from "../../src/doctor";
import {
  createNodeLaunchAgentPorts,
  launchAgentPlistPath,
  launchAgentsDirectory,
  launchAgentUid,
} from "../../src/launchagent-ports";

/**
 * The LaunchAgent integration seam (INIT-009, RUN-007, RUN-011): the real file layout
 * under a temporary user home and a stateful fake `launchctl` first on `PATH`, so the
 * exact bootstrap, bootout, and print invocations are asserted without touching the
 * developer's real launchd domain. The real domain is exercised by the TASK-059 e2e
 * journey against the compiled binary.
 */
const scratchDirs: string[] = [];
let binDir: string;
let stateDir: string;
let userHome: string;
let previousPath: string | undefined;

const FAKE_LAUNCHCTL = `#!/bin/sh
echo "$@" >> "$LAUNCHCTL_STATE_DIR/invocations"
command="$1"
case "$command" in
  bootstrap) touch "$LAUNCHCTL_STATE_DIR/loaded"; exit 0 ;;
  bootout)
    if [ -f "$LAUNCHCTL_STATE_DIR/loaded" ]; then
      rm "$LAUNCHCTL_STATE_DIR/loaded"
      exit 0
    fi
    echo "Boot-out failed: 36: No such process" >&2
    exit 1
    ;;
  print)
    if [ -f "$LAUNCHCTL_STATE_DIR/loaded" ]; then
      echo "domain gui/${launchAgentUid()}"
      exit 0
    fi
    echo "Print failed: 3: No such process" >&2
    exit 1
    ;;
  *) exit 1 ;;
esac
`;

function invocations(): string[] {
  const path = join(stateDir, "invocations");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "sorage-launchctl-bin-"));
  stateDir = mkdtempSync(join(tmpdir(), "sorage-launchctl-state-"));
  userHome = mkdtempSync(join(tmpdir(), "sorage-launchagent-home-"));
  scratchDirs.push(binDir, stateDir, userHome);
  writeFileSync(join(binDir, "launchctl"), FAKE_LAUNCHCTL, { mode: 0o755 });
  chmodSync(join(binDir, "launchctl"), 0o755);
  process.env.LAUNCHCTL_STATE_DIR = stateDir;
  previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
});

afterEach(() => {
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  delete process.env.LAUNCHCTL_STATE_DIR;
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function ports() {
  return createNodeLaunchAgentPorts();
}

const PROGRAM = { binaryPath: "/opt/sorage test/bin/sorage", scriptArgs: [] };

describe("the LaunchAgent node ports", () => {
  it("writes the plist under ~/Library/LaunchAgents and bootstraps it into gui/$UID", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    const result = installLaunchAgent(ports(), {
      program: PROGRAM,
      sorageHome: `${userHome}/.sorage`,
      agentsDirectory,
      uid: launchAgentUid(),
    });
    expect(result.ok).toBe(true);
    const plistPath = launchAgentPlistPath(agentsDirectory);
    expect(existsSync(plistPath)).toBe(true);
    expect(invocations()).toEqual([
      `print gui/${launchAgentUid()}/xyz.rootkernel.sorage`,
      `bootstrap gui/${launchAgentUid()} ${plistPath}`,
    ]);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("/opt/sorage test/bin/sorage");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>serve</string>");
  });

  it("XML-escapes a home path containing spaces, quotes, and ampersands", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    const spicyHome = `${userHome}/it's <a> "home" & mine`;
    const result = installLaunchAgent(ports(), {
      program: PROGRAM,
      sorageHome: spicyHome,
      agentsDirectory,
      uid: launchAgentUid(),
    });
    expect(result.ok).toBe(true);
    const plist = readFileSync(launchAgentPlistPath(agentsDirectory), "utf8");
    expect(plist).toContain("it&apos;s &lt;a&gt; &quot;home&quot; &amp; mine");
    expect(plist).not.toContain('"home"');
  });

  it("refreshes an already-loaded agent whose plist changes through boot-out and bootstrap", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    // A stale plist from an earlier binary plus a loaded agent: the install must
    // replace the running program, not leave the daemon stranded on the old one.
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(launchAgentPlistPath(agentsDirectory), "<plist><!-- stale --></plist>");
    writeFileSync(join(stateDir, "loaded"), "");
    const result = installLaunchAgent(ports(), {
      program: PROGRAM,
      sorageHome: `${userHome}/.sorage`,
      agentsDirectory,
      uid: launchAgentUid(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bootstrapped).toBe(true);
    expect(invocations()).toEqual([
      `print gui/${launchAgentUid()}/xyz.rootkernel.sorage`,
      `bootout gui/${launchAgentUid()}/xyz.rootkernel.sorage`,
      `bootstrap gui/${launchAgentUid()} ${launchAgentPlistPath(agentsDirectory)}`,
    ]);
  });

  it("leaves an already-loaded agent untouched when the plist it would write is identical", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(
      launchAgentPlistPath(agentsDirectory),
      renderLaunchAgentPlist({ program: PROGRAM, sorageHome: `${userHome}/.sorage` }),
    );
    writeFileSync(join(stateDir, "loaded"), "");
    const result = installLaunchAgent(ports(), {
      program: PROGRAM,
      sorageHome: `${userHome}/.sorage`,
      agentsDirectory,
      uid: launchAgentUid(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bootstrapped).toBe(false);
    expect(invocations()).toEqual([`print gui/${launchAgentUid()}/xyz.rootkernel.sorage`]);
    expect(existsSync(join(stateDir, "loaded"))).toBe(true);
  });

  it("boots out a loaded agent and removes its plist", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    installLaunchAgent(ports(), {
      program: PROGRAM,
      sorageHome: `${userHome}/.sorage`,
      agentsDirectory,
      uid: launchAgentUid(),
    });
    const result = uninstallLaunchAgent(ports(), { agentsDirectory, uid: launchAgentUid() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasLoaded).toBe(true);
    expect(result.value.plistRemoved).toBe(true);
    expect(invocations().at(-1)).toBe(`bootout gui/${launchAgentUid()}/xyz.rootkernel.sorage`);
    expect(existsSync(join(stateDir, "loaded"))).toBe(false);
    expect(existsSync(launchAgentPlistPath(agentsDirectory))).toBe(false);
  });
});

describe("the doctor service.installed probe", () => {
  it("warns with the bootstrap recovery when no plist exists", () => {
    const outcome = createNodeDoctorPorts({ userHome }).probe("service.installed");
    expect(outcome.severity).toBe("warning");
    expect(outcome.message).toContain("not installed");
    expect(outcome.recovery?.suggestedCommand).toContain("launchctl bootstrap gui/$UID");
  });

  it("warns when the plist points at a different binary", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(
      launchAgentPlistPath(agentsDirectory),
      renderLaunchAgentPlist({ program: { binaryPath: "/opt/other/sorage", scriptArgs: [] }, sorageHome: "/x" }),
    );
    const outcome = createNodeDoctorPorts({ userHome }).probe("service.installed");
    expect(outcome.severity).toBe("warning");
    expect(outcome.message).toContain("different sorage binary");
  });

  it("warns when the plist exists but the agent is not bootstrapped", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(
      launchAgentPlistPath(agentsDirectory),
      renderLaunchAgentPlist({ program: { binaryPath: process.execPath, scriptArgs: [] }, sorageHome: "/x" }),
    );
    const outcome = createNodeDoctorPorts({ userHome }).probe("service.installed");
    expect(outcome.severity).toBe("warning");
    expect(outcome.message).toContain("not bootstrapped");
  });

  it("reports ok when the agent is bootstrapped and points at this binary", () => {
    const agentsDirectory = launchAgentsDirectory(userHome);
    writeFileSync(join(stateDir, "loaded"), "");
    const install = installLaunchAgent(ports(), {
      program: { binaryPath: process.execPath, scriptArgs: [] },
      sorageHome: "/x",
      agentsDirectory,
      uid: launchAgentUid(),
    });
    expect(install.ok).toBe(true);
    const outcome = createNodeDoctorPorts({ userHome }).probe("service.installed");
    expect(outcome.severity).toBe("ok");
  });
});
