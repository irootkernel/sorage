import { describe, expect, it } from "vitest";
import { errorSpec } from "../../src/errors";
import {
  parseVaultMarker,
  REQUIRED_GITATTRIBUTES_LINES,
  validateVaultMarkerForInstallation,
  VAULT_ADOPTION_COMMAND,
  VAULT_OPEN_RECOVERY,
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

describe("Vault-open recovery guidance (TASK-118)", () => {
  it("keeps every parser error recovery-free with its exact message", () => {
    const cases: Array<[Record<string, unknown> | string, string]> = [
      ["not json", "The Vault marker is not valid JSON."],
      ["[]", "The Vault marker is not a JSON object."],
      [{ type: "sorage-backup" }, "The marker's type is not 'sorage-vault'."],
      [{ schemaVersion: 0 }, "The Vault marker schemaVersion is not a positive integer: 0."],
      [{ installationId: "" }, "The Vault marker has no installationId."],
      [{ createdAt: "" }, "The Vault marker has no createdAt."],
    ];
    for (const [body, message] of cases) {
      const parsed = parseVaultMarker(typeof body === "string" ? body : markerBody(body));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.message).toBe(message);
      expect(parsed.error.recovery).toBeUndefined();
    }
  });

  it("keeps the foreign-marker refusal recovery-free at the parser layer (VLT-019)", () => {
    const marker = parseVaultMarker(markerBody({ installationId: "22222222-2222-4222-8222-222222222222" }));
    if (!marker.ok) throw new Error("fixture marker must parse");
    const owned = validateVaultMarkerForInstallation(marker.value, "11111111-1111-4111-8111-111111111111");
    expect(owned.ok).toBe(false);
    if (owned.ok) return;
    expect(owned.error.message).toBe(
      `The Vault marker belongs to installation 22222222-2222-4222-8222-222222222222, not this installation 11111111-1111-4111-8111-111111111111; adopt it only through the audited ${VAULT_ADOPTION_COMMAND}.`,
    );
    expect(owned.error.recovery).toBeUndefined();
  });

  it("never names a command that cannot run while the Vault cannot open", () => {
    for (const [state, recovery] of Object.entries(VAULT_OPEN_RECOVERY)) {
      expect(recovery, state).not.toContain("sorage vault verify");
      if (state === "emptyUninitialized") continue;
      expect(recovery, state).not.toContain("sorage init");
    }
  });

  it("names the reconfigure backfill only in the empty-uninitialized state (VTL-003)", () => {
    const recovery = VAULT_OPEN_RECOVERY.emptyUninitialized;
    expect(recovery).toContain("sorage init --reconfigure --non-interactive");
    expect(recovery).toContain("mounted");
    expect(recovery).toContain("genuinely new installation");
    expect(recovery.split("sorage init")).toHaveLength(2);
  });

  it("names the audited adoption route for a foreign marker (VLT-019)", () => {
    expect(VAULT_OPEN_RECOVERY.foreignMarker).toContain(VAULT_ADOPTION_COMMAND);
    expect(VAULT_OPEN_RECOVERY.foreignMarker).toContain("fresh installation");
  });

  it("keeps the unreadable-directory recovery conditional on the listing (TASK-118)", () => {
    expect(VAULT_OPEN_RECOVERY.unreadableDirectory).toContain("symlink loop");
    expect(VAULT_OPEN_RECOVERY.unreadableDirectory).toContain("when its marker is missing or unreadable");
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
