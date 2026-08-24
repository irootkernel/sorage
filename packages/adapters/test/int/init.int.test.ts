import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfiguration } from "@sorage/core";
import { createNodeInitPorts } from "../../src/init-ports";
import { initializeInstallation } from "@sorage/core";
import { withTempHome } from "../../src/testkit/temp-home";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempHome } from "../../src/testkit/temp-home";

const GITATTRIBUTES = `artifacts/** -text -diff
snapshots/** text eol=lf
.sorage-vault.json text eol=lf
`;

function portsFor(home: string) {
  return createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() });
}

describe("initializeInstallation", () => {
  it("creates the home tree, configuration, database, and the complete Vault", async () => {
    await withTempHome(async (home) => {
      const vault = `${home}/custom-vault`;
      const result = initializeInstallation(portsFor(home), { vaultPath: vault });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe("created");
      expect(result.value.vaultPath).toBe(vault);

      expect(existsSync(`${home}/state`)).toBe(true);
      expect(existsSync(`${home}/logs`)).toBe(true);
      expect(existsSync(`${home}/run`)).toBe(true);
      expect(existsSync(`${home}/config.yaml`)).toBe(true);
      expect(existsSync(`${home}/state/sorage.sqlite3`)).toBe(true);
      expect(existsSync(`${vault}/.sorage-vault.json`)).toBe(true);
      expect(existsSync(`${vault}/.gitattributes`)).toBe(true);
      expect(existsSync(`${vault}/.gitignore`)).toBe(true);
      expect(existsSync(`${vault}/artifacts`)).toBe(true);
      expect(existsSync(`${vault}/staging`)).toBe(true);
      expect(statSync(`${home}/config.yaml`).mode & 0o777).toBe(0o600);

      expect(readFileSync(`${vault}/.gitattributes`, "utf8")).toBe(GITATTRIBUTES);
      expect(readFileSync(`${vault}/.gitignore`, "utf8")).toBe("staging/\n");
      const marker = JSON.parse(readFileSync(`${vault}/.sorage-vault.json`, "utf8")) as Record<string, unknown>;
      expect(marker["type"]).toBe("sorage-vault");
      expect(marker["schemaVersion"]).toBe(1);
      expect(marker["installationId"]).toBe(result.value.installationId);
      expect(typeof marker["createdAt"]).toBe("string");

      const loaded = loadConfiguration(readFileSync(`${home}/config.yaml`, "utf8"), { userHome: home });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.config.installationId).toBe(result.value.installationId);
        expect(loaded.value.config.vault.path).toBe(vault);
        expect(loaded.value.config.configRevision).toBe(1);
      }
    }, "sorage-test-init-create-");
  });

  it("defaults the Vault to <home>/vault when no path is supplied", async () => {
    await withTempHome(async (home) => {
      const result = initializeInstallation(portsFor(home), {});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.vaultPath).toBe(`${home}/vault`);
      expect(existsSync(`${home}/vault/.sorage-vault.json`)).toBe(true);
    }, "sorage-test-init-default-");
  });

  it("is idempotent: a second run reports the installation and changes no file content", async () => {
    await withTempHome(async (home) => {
      const ports = portsFor(home);
      const first = initializeInstallation(ports, {});
      expect(first.ok).toBe(true);
      const snapshot = directorySnapshot(home);
      const second = initializeInstallation(ports, {});
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.outcome).toBe("already-initialized");
        expect(second.value.installationId).toBe(first.ok ? first.value.installationId : "");
      }
      expect(directorySnapshot(home)).toEqual(snapshot);
    }, "sorage-test-init-idempotent-");
  });

  it("stops before a malformed configuration with CONFIG_INVALID and rewrites nothing", async () => {
    await withTempHome(async (home) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(home, { recursive: true });
      writeFileSync(`${home}/config.yaml`, "vault: [unclosed");
      const before = readFileSync(`${home}/config.yaml`, "utf8");
      const result = initializeInstallation(portsFor(home), {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFIG_INVALID");
      expect(readFileSync(`${home}/config.yaml`, "utf8")).toBe(before);
      expect(readdirSync(home).sort()).toEqual(["config.yaml"]);
    }, "sorage-test-init-malformed-");
  });

  it("backfills missing Vault files under --reconfigure without touching the configuration", async () => {
    const scratch = makeTempHome("sorage-test-init-reconfigure-");
    try {
      const home = `${scratch.home}/installation`;
      const ports = portsFor(home);
      const first = initializeInstallation(ports, {});
      expect(first.ok).toBe(true);
      const { rmSync } = await import("node:fs");
      rmSync(`${home}/vault/.gitattributes`);
      const configBefore = readFileSync(`${home}/config.yaml`, "utf8");
      const second = initializeInstallation(ports, { reconfigure: true });
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.value.outcome).toBe("already-initialized");
      expect(readFileSync(`${home}/config.yaml`, "utf8")).toBe(configBefore);
      expect(readFileSync(`${home}/vault/.gitattributes`, "utf8")).toBe(GITATTRIBUTES);
    } finally {
      scratch.cleanup();
    }
  });
});

function directorySnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true }) as string[]) {
    const path = `${root}/${entry}`;
    if (statSync(path).isFile()) snapshot[entry] = readFileSync(path, "utf8");
  }
  return snapshot;
}
