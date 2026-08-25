import { describe, expect, it } from "vitest";
import { errorSpec } from "../../src/errors";
import {
  parseVaultMarker,
  REQUIRED_GITATTRIBUTES_LINES,
  validateVaultMarkerForInstallation,
  VAULT_ADOPTION_COMMAND,
  verifyVaultPolicyFiles,
  vaultGitattributesContent,
  vaultGitignoreContent,
} from "../../src/vault";

function markerBody(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "sorage-vault",
    schemaVersion: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  })}\n`;
}

describe("parseVaultMarker", () => {
  it("accepts the marker this build writes", () => {
    const parsed = parseVaultMarker(markerBody());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      type: "sorage-vault",
      schemaVersion: 1,
      installationId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("rejects a body that is not JSON, not an object, or not a Sorage marker", () => {
    for (const body of ["not json", "[]", "{}", markerBody({ type: "sorage-backup" })]) {
      const parsed = parseVaultMarker(body);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(errorSpec(parsed.error.code).exitCode).toBe(73);
    }
  });

  it("rejects an impossible schemaVersion as an integrity error", () => {
    for (const schemaVersion of [0, -1, 1.5, "1", null]) {
      const parsed = parseVaultMarker(markerBody({ schemaVersion }));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe("VAULT_INTEGRITY_ERROR");
    }
  });

  it("classifies a schemaVersion newer than the build as VAULT_SCHEMA_UNSUPPORTED at exit 78", () => {
    const parsed = parseVaultMarker(markerBody({ schemaVersion: 2 }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VAULT_SCHEMA_UNSUPPORTED");
    expect(errorSpec(parsed.error.code).exitCode).toBe(78);
    expect(parsed.error.message).toContain("never downgrades");
  });

  it("rejects a marker without an installationId or createdAt", () => {
    for (const overrides of [{ installationId: "" }, { createdAt: "" }, { installationId: 5 }]) {
      const parsed = parseVaultMarker(markerBody(overrides));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe("VAULT_INTEGRITY_ERROR");
    }
  });
});

describe("validateVaultMarkerForInstallation", () => {
  it("accepts a marker of this installation", () => {
    const marker = parseVaultMarker(markerBody());
    if (!marker.ok) throw new Error("fixture marker must parse");
    const owned = validateVaultMarkerForInstallation(marker.value, "11111111-1111-4111-8111-111111111111");
    expect(owned.ok).toBe(true);
  });

  it("blocks a foreign marker and names the audited restore path (VLT-019)", () => {
    const marker = parseVaultMarker(markerBody({ installationId: "22222222-2222-4222-8222-222222222222" }));
    if (!marker.ok) throw new Error("fixture marker must parse");
    const owned = validateVaultMarkerForInstallation(marker.value, "11111111-1111-4111-8111-111111111111");
    expect(owned.ok).toBe(false);
    if (owned.ok) return;
    expect(owned.error.code).toBe("VAULT_INTEGRITY_ERROR");
    expect(errorSpec(owned.error.code).exitCode).toBe(73);
    expect(owned.error.message).toContain(VAULT_ADOPTION_COMMAND);
  });
});

describe("verifyVaultPolicyFiles", () => {
  it("reports no problem for the exact bytes initialization writes", () => {
    expect(verifyVaultPolicyFiles(vaultGitattributesContent(), vaultGitignoreContent())).toEqual([]);
  });

  it("accepts additional lines while requiring the contract lines", () => {
    const attributes = `${vaultGitattributesContent()}vendor/** -text -diff\n`;
    expect(verifyVaultPolicyFiles(attributes, vaultGitignoreContent())).toEqual([]);
  });

  it("reports a missing .gitattributes line and a missing staging/ entry (VLT-024)", () => {
    const withoutDiffRule = `${REQUIRED_GITATTRIBUTES_LINES.slice(1).join("\n")}\n`;
    const problems = verifyVaultPolicyFiles(withoutDiffRule, "node_modules/\n");
    expect(problems).toContain(".gitattributes is missing the required line 'artifacts/** -text -diff'.");
    expect(problems).toContain(".gitignore is missing the required entry 'staging/'.");
  });

  it("reports missing policy files", () => {
    expect(verifyVaultPolicyFiles(null, null)).toEqual([
      ".gitattributes is missing from the Vault.",
      ".gitignore is missing from the Vault.",
    ]);
  });
});
