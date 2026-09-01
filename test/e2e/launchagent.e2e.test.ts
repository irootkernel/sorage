import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, runCleanups, sorage } from "./helpers";

/**
 * The TASK-059, TASK-073, and TASK-074 LaunchAgent journey against the compiled
 * binary and the real `gui/$UID` launchd domain (INIT-006, INIT-009, RUN-007,
 * RUN-011): CLI calls use an isolated launchctl double because a launchd label is
 * scoped to the user domain rather than HOME, while the login-cycle exercise uses
 * a run-unique real label. The developer's canonical installed agent is therefore
 * never booted out.
 */
const LABEL = "xyz.rootkernel.sorage";
const TEST_LABEL = `${LABEL}.e2e.${process.pid}`;
const parent = makeTempDir("sorage-launchagent-e2e-");
// Spaces and a quotation mark in the user home prove the plist escaping rule.
const userHome = `${parent}/my "home" dir`;
mkdirSync(userHome, { recursive: true });
const home = `${userHome}/.sorage`;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const plistPath = `${userHome}/Library/LaunchAgents/${LABEL}.plist`;
const fakeBin = `${parent}/fake-bin`;
const fakeState = `${parent}/fake-launchctl-loaded`;
const fakeLaunchctl = `${fakeBin}/launchctl`;
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  fakeLaunchctl,
  `#!/bin/sh
case "$1" in
  print)
    test -f "$SORAGE_E2E_LAUNCHCTL_STATE"
    ;;
  bootstrap)
    : > "$SORAGE_E2E_LAUNCHCTL_STATE"
    ;;
  bootout)
    if test -f "$SORAGE_E2E_LAUNCHCTL_STATE"; then
      rm -f "$SORAGE_E2E_LAUNCHCTL_STATE"
      exit 0
    fi
    echo "No such process" >&2
    exit 3
    ;;
  *)
    exit 64
    ;;
esac
`,
  "utf8",
);
chmodSync(fakeLaunchctl, 0o755);
const cliEnv = {
  HOME: userHome,
  PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  SORAGE_E2E_LAUNCHCTL_STATE: fakeState,
};

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

function agentLoaded(label: string): boolean {
  return launchctl(["print", `gui/${uid}/${label}`]).status === 0;
}

function agentPid(label: string): number | null {
  const result = launchctl(["print", `gui/${uid}/${label}`]);
  if (result.status !== 0) return null;
  const pid = result.stdout.match(/^\s*pid = (\d+)$/m)?.[1];
  return pid === undefined ? null : Number(pid);
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

/** The defensive cleanup only targets this run's unique label. */
function forceBootOut(): void {
  if (process.platform === "darwin" && agentLoaded(TEST_LABEL)) {
    launchctl(["bootout", `gui/${uid}/${TEST_LABEL}`]);
  }
}

afterAll(() => {
  forceBootOut();
  runCleanups();
});

describe("the LaunchAgent journey", () => {
  it("adds the agent through explicit reconfiguration and survives a login cycle", { timeout: 60_000 }, async () => {
    const port = await freePort();
    const canonicalPidBefore = agentPid(LABEL);
    // A leftover run-unique label from an interrupted run would make bootstrap fail loudly.
    forceBootOut();

    const init = sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--port", String(port)], {
      home,
      env: cliEnv,
    });
    expect(init.status).toBe(0);
    expect(existsSync(plistPath)).toBe(false);
    const configBefore = readFileSync(`${home}/config.yaml`, "utf8");
    const markerBefore = readFileSync(`${home}/vault/.sorage-vault.json`, "utf8");

    const project = sorage(["project", "add", "--name", "Preserved", "--slug", "preserved", "--dir", userHome], {
      home,
      env: cliEnv,
    });
    expect(project.status).toBe(0);

    const reconfigured = sorage(["init", "--reconfigure", "--non-interactive", "--install-service", "--json"], {
      home,
      env: cliEnv,
    });
    expect(reconfigured.status).toBe(0);
    const reconfiguredJson = JSON.parse(reconfigured.stdout) as {
      data: { outcome: string; installationId: string; service?: { label?: string; plistPath?: string } };
    };
    expect(reconfiguredJson.data.outcome).toBe("already-initialized");
    expect(reconfiguredJson.data.service).toEqual({ label: LABEL, plistPath });
    expect(readFileSync(`${home}/config.yaml`, "utf8")).toBe(configBefore);
    expect(readFileSync(`${home}/vault/.sorage-vault.json`, "utf8")).toBe(markerBefore);
    expect(sorage(["project", "show", "preserved", "--json"], { home, env: cliEnv }).status).toBe(0);

    const repeated = sorage(["init", "--reconfigure", "--non-interactive", "--install-service", "--json"], {
      home,
      env: cliEnv,
    });
    expect(repeated.status).toBe(0);
    expect((JSON.parse(repeated.stdout) as { data: { service?: { label?: string } } }).data.service?.label).toBe(LABEL);

    expect(existsSync(plistPath)).toBe(true);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>xyz.rootkernel.sorage</string>");
    expect(plist).toContain("&quot;home&quot;");
    expect(plist).not.toContain('"home"');
    expect(plist).toContain("daemon");
    expect(plist).toContain("serve");

    const isolatedPlist = plist.replace(`<string>${LABEL}</string>`, `<string>${TEST_LABEL}</string>`);
    expect(isolatedPlist).not.toBe(plist);
    writeFileSync(plistPath, isolatedPlist, "utf8");
    expect(launchctl(["bootstrap", `gui/${uid}`, plistPath]).status).toBe(0);
    expect(agentLoaded(TEST_LABEL)).toBe(true);
    const installationId = (
      readFileSync(`${home}/config.yaml`, "utf8").match(/installationId: "?([^"\n]+)"?/)?.[1] ?? ""
    ).trim();
    expect(installationId).not.toBe("");
    expect(await daemonReachable(port, installationId, 20_000)).toBe(true);
    const cliVersion = JSON.parse(sorage(["version", "--json"], { home, env: cliEnv }).stdout) as {
      version: string;
    };
    const health = (await fetch(`http://127.0.0.1:${port}/api/v1/health`).then((response) => response.json())) as {
      data: { version: string };
    };
    const daemonVersion = (await fetch(`http://127.0.0.1:${port}/api/v1/version`).then((response) =>
      response.json(),
    )) as { data: { version: string } };
    expect(`v${health.data.version}`).toBe(cliVersion.version);
    expect(`v${daemonVersion.data.version}`).toBe(cliVersion.version);

    // Boot out stands in for logging out; the daemon drains and stops.
    expect(launchctl(["bootout", `gui/${uid}/${TEST_LABEL}`]).status).toBe(0);
    expect(await daemonGone(port, 15_000)).toBe(true);

    // A re-bootstrap stands in for the next login: the daemon starts again.
    expect(launchctl(["bootstrap", `gui/${uid}`, plistPath]).status).toBe(0);
    expect(await daemonReachable(port, installationId, 20_000)).toBe(true);
    expect(agentPid(LABEL)).toBe(canonicalPidBefore);
    expect(launchctl(["bootout", `gui/${uid}/${TEST_LABEL}`]).status).toBe(0);
    expect(await daemonGone(port, 15_000)).toBe(true);
  });

  it("uninstall removes the agent and the installation and keeps the Vault", async () => {
    const uninstall = sorage(["uninstall", "--as-user", "--confirm"], { home, env: cliEnv });
    expect(uninstall.status).toBe(0);
    expect(uninstall.stdout).toContain(`Vault retained at ${home}/vault`);
    expect(existsSync(plistPath)).toBe(false);
    expect(agentLoaded(TEST_LABEL)).toBe(false);
    expect(existsSync(`${home}/config.yaml`)).toBe(false);
    expect(existsSync(`${home}/state`)).toBe(false);
    expect(existsSync(`${home}/run`)).toBe(false);
    expect(existsSync(`${home}/logs`)).toBe(false);
    expect(existsSync(`${home}/vault/.sorage-vault.json`)).toBe(true);
  });

  it("refuses uninstall without --as-user even on a fresh installation", async () => {
    const port = await freePort();
    expect(
      sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--port", String(port), "--install-service"], {
        home,
        env: cliEnv,
      }).status,
    ).toBe(0);
    const refused = sorage(["uninstall", "--confirm"], { home, env: cliEnv });
    expect(refused.status).toBe(77);
    const done = sorage(["uninstall", "--as-user", "--confirm"], { home, env: cliEnv });
    expect(done.status).toBe(0);
  });
});
