import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorSpec, type AppError } from "@sorage/core";
import { createVaultInitializer, openVault } from "../../src/vault";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempHome } from "../../src/testkit/temp-home";
import { makeTempVault } from "../../src/testkit/temp-vault";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";

function initializedVault(): { vaultPath: string; cleanup: () => void } {
  const fixture = makeTempVault("sorage-open-");
  const initializer = createVaultInitializer(new FakeClock());
  const created = initializer.initialize(fixture.vaultPath, INSTALLATION);
  if (!created.ok) throw new Error("fixture initialization must succeed");
  return { vaultPath: fixture.vaultPath, cleanup: fixture.cleanup };
}

function exitCodeOf(error: AppError): number {
  return errorSpec(error.code).exitCode;
}

describe("openVault", () => {
  it("opens the Vault this build initializes and reports no layout problem", () => {
    const { vaultPath, cleanup } = initializedVault();
    try {
      const opened = openVault(vaultPath, INSTALLATION);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.marker.installationId).toBe(INSTALLATION);
      expect(opened.value.marker.schemaVersion).toBe(1);
      expect(opened.value.layoutProblems).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("refuses a non-empty directory without a marker, adopting nothing (VLT-003)", () => {
    const home = makeTempHome("sorage-foreign-");
    try {
      const vaultPath = join(home.home, "foreign-vault");
      mkdirSync(vaultPath);
      writeFileSync(join(vaultPath, "important.txt"), "untouched");
      const opened = openVault(vaultPath, INSTALLATION);
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(opened.error)).toBe(73);
      expect(readFileSync(join(vaultPath, "important.txt"), "utf8")).toBe("untouched");
      expect(readdirSync(vaultPath)).toEqual(["important.txt"]);
    } finally {
      home.cleanup();
    }
  });

  it("refuses an empty directory without a marker instead of initializing it", () => {
    const home = makeTempHome("sorage-empty-");
    try {
      const emptyDir = join(home.home, "empty-vault");
      mkdirSync(emptyDir);
      const opened = openVault(emptyDir, INSTALLATION);
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(opened.error)).toBe(73);
      expect(readdirSync(emptyDir)).toEqual([]);
    } finally {
      home.cleanup();
    }
  });

  it("fails with exit 73 when the Vault directory does not exist", () => {
    const home = makeTempHome("sorage-absent-");
    try {
      const opened = openVault(join(home.home, "absent-vault"), INSTALLATION);
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(opened.error)).toBe(73);
    } finally {
      home.cleanup();
    }
  });

  it("blocks a marker of another installation and names the audited restore path", () => {
    const fixture = makeTempVault("sorage-mismatch-");
    try {
      writeFileSync(
        join(fixture.vaultPath, ".sorage-vault.json"),
        `${JSON.stringify({
          type: "sorage-vault",
          schemaVersion: 1,
          installationId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      const opened = openVault(fixture.vaultPath, INSTALLATION);
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(opened.error)).toBe(73);
      expect(opened.error.message).toContain("sorage backup restore --from <vault-path> --as-user --confirm");
    } finally {
      fixture.cleanup();
    }
  });

  it("fails with VAULT_SCHEMA_UNSUPPORTED at exit 78 for a newer marker schemaVersion", () => {
    const fixture = makeTempVault("sorage-newer-");
    try {
      writeFileSync(
        join(fixture.vaultPath, ".sorage-vault.json"),
        `${JSON.stringify({
          type: "sorage-vault",
          schemaVersion: 2,
          installationId: INSTALLATION,
          createdAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      const opened = openVault(fixture.vaultPath, INSTALLATION);
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("VAULT_SCHEMA_UNSUPPORTED");
      expect(exitCodeOf(opened.error)).toBe(78);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports a missing .gitattributes line and a missing staging/ entry without blocking", () => {
    const { vaultPath, cleanup } = initializedVault();
    try {
      writeFileSync(join(vaultPath, ".gitattributes"), "snapshots/** text eol=lf\n.sorage-vault.json text eol=lf\n");
      writeFileSync(join(vaultPath, ".gitignore"), "node_modules/\n");
      const opened = openVault(vaultPath, INSTALLATION);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.layoutProblems).toContain(
        ".gitattributes is missing the required line 'artifacts/** -text -diff'.",
      );
      expect(opened.value.layoutProblems).toContain(".gitignore is missing the required entry 'staging/'.");
    } finally {
      cleanup();
    }
  });
});
