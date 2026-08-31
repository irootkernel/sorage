import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, runCleanups, sorage } from "./helpers";

/**
 * The TASK-059 LaunchAgent journey against the compiled binary in the real
 * `gui/$UID` launchd domain (INIT-009, RUN-007, RUN-011): the plist is installed
 * under a temporary HOME whose path contains spaces and a quotation mark, the
 * daemon becomes reachable through the bootstrapped agent, a boot-out and
 * re-bootstrap stand in for a login cycle, and `sorage uninstall` removes the
 * agent and the installation while keeping the Vault.
 */
const LABEL = "xyz.rootkernel.sorage";
const parent = makeTempDir("sorage-launchagent-e2e-");
// Spaces and a quotation mark in the user home prove the plist escaping rule.
const userHome = `${parent}/my "home" dir`;
mkdirSync(userHome, { recursive: true });
const home = `${userHome}/.sorage`;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const plistPath = `${userHome}/Library/LaunchAgents/${LABEL}.plist`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function launchctl(args: string[]) {
  return spawnSync("launchctl", args, { encoding: "utf8", timeout: 15_000 });
}

function agentLoaded(): boolean {
  return launchctl(["print", `gui/${uid}/${LABEL}`]).status === 0;
}

async function daemonReachable(port: number, installationId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.status === 200) {
        const body = (await response.json()) as { data?: { installationId?: string } };
        if (body.data?.installationId === installationId) return true;
      }
    } catch {
      // Not answering yet; launchd may still be starting the job.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function daemonGone(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** The defensive cleanup: never leave the label loaded in the developer's domain. */
function forceBootOut(): void {
  if (process.platform === "darwin" && agentLoaded()) {
    launchctl(["bootout", `gui/${uid}/${LABEL}`]);
  }
}

afterAll(() => {
  forceBootOut();
  runCleanups();
});

describe("the LaunchAgent journey", () => {
  it(
    "installs the agent through init, starts the daemon, and survives a login cycle",
    { timeout: 60_000 },
    async () => {
      const port = await freePort();
      // A leftover label from an interrupted run would make bootstrap fail loudly.
      forceBootOut();

      const init = sorage(
        ["init", "--vault", `${home}/vault`, "--non-interactive", "--port", String(port), "--install-service"],
        { home, env: { HOME: userHome } },
      );
      expect(init.status).toBe(0);
      expect(init.stdout).toContain("Installed the xyz.rootkernel.sorage LaunchAgent");

      expect(existsSync(plistPath)).toBe(true);
      const plist = readFileSync(plistPath, "utf8");
      expect(plist).toContain("<string>xyz.rootkernel.sorage</string>");
      expect(plist).toContain("&quot;home&quot;");
      expect(plist).not.toContain('"home"');
      expect(plist).toContain("daemon");
      expect(plist).toContain("serve");

      expect(agentLoaded()).toBe(true);
      const installationId = (
        readFileSync(`${home}/config.yaml`, "utf8").match(/installationId: "?([^"\n]+)"?/)?.[1] ?? ""
      ).trim();
      expect(installationId).not.toBe("");
      expect(await daemonReachable(port, installationId, 20_000)).toBe(true);

      // Boot out stands in for logging out; the daemon drains and stops.
      expect(launchctl(["bootout", `gui/${uid}/${LABEL}`]).status).toBe(0);
      expect(await daemonGone(port, 15_000)).toBe(true);

      // A re-bootstrap stands in for the next login: the daemon starts again.
      expect(launchctl(["bootstrap", `gui/${uid}`, plistPath]).status).toBe(0);
      expect(await daemonReachable(port, installationId, 20_000)).toBe(true);
    },
  );

  it("uninstall removes the agent and the installation and keeps the Vault", async () => {
    const uninstall = sorage(["uninstall", "--as-user", "--confirm"], { home, env: { HOME: userHome } });
    expect(uninstall.status).toBe(0);
    expect(uninstall.stdout).toContain(`Vault retained at ${home}/vault`);
    expect(existsSync(plistPath)).toBe(false);
    expect(agentLoaded()).toBe(false);
    expect(existsSync(`${home}/config.yaml`)).toBe(false);
    expect(existsSync(`${home}/state`)).toBe(false);
    expect(existsSync(`${home}/run`)).toBe(false);
    expect(existsSync(`${home}/logs`)).toBe(false);
    expect(existsSync(`${home}/vault/.sorage-vault.json`)).toBe(true);
  });

  it("refuses uninstall without --as-user even on a fresh installation", async () => {
    const port = await freePort();
    expect(
      sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--port", String(port)], {
        home,
        env: { HOME: userHome },
      }).status,
    ).toBe(0);
    const refused = sorage(["uninstall", "--confirm"], { home, env: { HOME: userHome } });
    expect(refused.status).toBe(77);
    const done = sorage(["uninstall", "--as-user", "--confirm"], { home, env: { HOME: userHome } });
    expect(done.status).toBe(0);
  });
});
