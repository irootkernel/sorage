import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorSpec, type AppError, VAULT_ADOPTION_COMMAND, VAULT_OPEN_RECOVERY } from "@sorage/core";
import { createVaultInitializer, openVault } from "../../src/vault";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempHome } from "../../src/testkit/temp-home";
import { makeTempVault } from "../../src/testkit/temp-vault";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";
const isRoot = process.getuid?.() === 0;

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

function refusalOf(result: ReturnType<typeof openVault>): AppError {
  if (result.ok) throw new Error("fixture must be refused");
  return result.error;
}

function recoveryOf(error: AppError): string | undefined {
  return error.recovery?.suggestedCommand;
}

function markerBodyOf(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "sorage-vault",
    schemaVersion: 1,
    installationId: INSTALLATION,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  })}\n`;
}

/** A bare Vault-shaped directory, with no artifacts/ or staging/ entries. */
function bareVault(prefix: string): { vaultPath: string; cleanup: () => void } {
  const home = makeTempHome(prefix);
  const vaultPath = join(home.home, "vault");
  mkdirSync(vaultPath);
  return { vaultPath, cleanup: home.cleanup };
}

/** A read-only tree snapshot: entry names, directories, symlink targets and file bodies. */ function snapshot(
  root: string,
): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries[relative] = "<dir>";
        walk(path, relative);
      } else if (entry.isSymbolicLink()) {
        entries[relative] = `<symlink:${readlinkSync(path)}>`;
      } else {
        entries[relative] = readFileSync(path, "utf8");
      }
    }
  };
  walk(root, "");
  return entries;
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

  it("reports missing .gitattributes lines and order violations plus a missing staging/ entry without blocking", () => {
    const { vaultPath, cleanup } = initializedVault();
    try {
      // Every required line except the artifacts rule, with the M9 raw-content
      // exception out of order relative to the general snapshots rule.
      writeFileSync(
        join(vaultPath, ".gitattributes"),
        "content/** -text -diff\nsnapshots/content/** -text -diff\nsnapshots/** text eol=lf\n.sorage-vault.json text eol=lf\n",
      );
      writeFileSync(join(vaultPath, ".gitignore"), "node_modules/\n");
      const opened = openVault(vaultPath, INSTALLATION);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.layoutProblems).toContain(
        ".gitattributes is missing the required line 'artifacts/** -text -diff'.",
      );
      expect(opened.value.layoutProblems).toContain(
        ".gitattributes carries the required line 'snapshots/content/** -text -diff' out of its stated order.",
      );
      expect(opened.value.layoutProblems).toContain(".gitignore is missing the required entry 'staging/'.");
    } finally {
      cleanup();
    }
  });
});

describe("openVault state-specific refusals (TASK-118)", () => {
  it("V1 reports the missing directory with the mount-aware recovery and creates nothing", () => {
    const home = makeTempHome("sorage-v1-");
    try {
      const vaultPath = join(home.home, "missing-vault");
      const before = snapshot(home.home);
      const error = refusalOf(openVault(vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(`The Vault directory does not exist at ${vaultPath}.`);
      expect(error.details).toEqual({ vaultPath });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.missingDirectory);
      expect(recoveryOf(error)).not.toContain("sorage init");
      expect(existsSync(vaultPath)).toBe(false);
      expect(snapshot(home.home)).toEqual(before);
    } finally {
      home.cleanup();
    }
  });

  it("V2 reports an unstattable directory as uninspectable at exit 73", () => {
    const home = makeTempHome("sorage-v2-loop-");
    try {
      const loop = join(home.home, "loop");
      symlinkSync(loop, loop);
      const error = refusalOf(openVault(loop, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(`The Vault directory at ${loop} cannot be inspected.`);
      expect(error.details).toEqual({ vaultPath: loop });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
      expect(recoveryOf(error)).toContain("symlink loop");
    } finally {
      home.cleanup();
    }
  });

  it.skipIf(isRoot)("V2 reports a mode-000 Vault directory as uninspectable without throwing", () => {
    const fixture = makeTempVault("sorage-v2-mode000-");
    try {
      chmodSync(fixture.vaultPath, 0o000);
      const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(`The Vault directory at ${fixture.vaultPath} cannot be inspected.`);
      expect(error.details).toEqual({ vaultPath: fixture.vaultPath });
      expect(error.details?.entryCount).toBeUndefined();
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
    } finally {
      chmodSync(fixture.vaultPath, 0o700);
      fixture.cleanup();
    }
  });

  it.skipIf(isRoot)("V2 reports an untraversable parent directory as uninspectable", () => {
    const home = makeTempHome("sorage-v2-parent-");
    const parent = join(home.home, "parent");
    try {
      const vaultPath = join(parent, "vault");
      mkdirSync(vaultPath, { recursive: true });
      chmodSync(parent, 0o000);
      const error = refusalOf(openVault(vaultPath, INSTALLATION));
      expect(error.message).toBe(`The Vault directory at ${vaultPath} cannot be inspected.`);
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.details).toEqual({ vaultPath });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
    } finally {
      chmodSync(parent, 0o700);
      home.cleanup();
    }
  });

  it.skipIf(isRoot)("V2 reports an execute-only directory without a marker as uninspectable", () => {
    const fixture = makeTempVault("sorage-v2-exec-");
    try {
      chmodSync(fixture.vaultPath, 0o300);
      const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
      expect(error.message).toBe(`The Vault directory at ${fixture.vaultPath} cannot be inspected.`);
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.details).toEqual({ vaultPath: fixture.vaultPath });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
    } finally {
      chmodSync(fixture.vaultPath, 0o700);
      fixture.cleanup();
    }
  });

  it.skipIf(isRoot)("opens an execute-only directory whose valid marker is readable (no listing needed)", () => {
    const fixture = makeTempVault("sorage-exec-marker-");
    try {
      const markerPath = join(fixture.vaultPath, ".sorage-vault.json");
      writeFileSync(markerPath, markerBodyOf());
      chmodSync(markerPath, 0o644);
      chmodSync(fixture.vaultPath, 0o300);
      const opened = openVault(fixture.vaultPath, INSTALLATION);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.marker.installationId).toBe(INSTALLATION);
    } finally {
      chmodSync(fixture.vaultPath, 0o700);
      fixture.cleanup();
    }
  });

  it("V3 refuses a file path without touching it", () => {
    const home = makeTempHome("sorage-v3-");
    try {
      const vaultPath = join(home.home, "vault-file");
      writeFileSync(vaultPath, "not a vault\n");
      const error = refusalOf(openVault(vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(`The Vault path ${vaultPath} is a file, not a directory.`);
      expect(error.details).toEqual({ vaultPath });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.filePath);
      expect(readFileSync(vaultPath, "utf8")).toBe("not a vault\n");
    } finally {
      home.cleanup();
    }
  });

  it("V4 reports an unreadable marker and preserves the entry count", () => {
    const fixture = bareVault("sorage-v4-");
    try {
      mkdirSync(join(fixture.vaultPath, ".sorage-vault.json"));
      writeFileSync(join(fixture.vaultPath, "entry.txt"), "kept");
      const before = snapshot(fixture.vaultPath);
      const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(`The Vault marker at ${fixture.vaultPath}/.sorage-vault.json cannot be read.`);
      expect(error.details).toEqual({ vaultPath: fixture.vaultPath, entryCount: 2 });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.unreadableMarker);
      expect(snapshot(fixture.vaultPath)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("V5 refuses a non-empty directory without a marker and reports the entry count", () => {
    const fixture = bareVault("sorage-v5-");
    try {
      writeFileSync(join(fixture.vaultPath, "important.txt"), "untouched");
      const before = snapshot(fixture.vaultPath);
      const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(
        `Refusing to adopt the non-empty directory ${fixture.vaultPath} because it has no Vault marker (VLT-003).`,
      );
      expect(error.details).toEqual({ vaultPath: fixture.vaultPath, entryCount: 1 });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.nonEmptyWithoutMarker);
      expect(recoveryOf(error)).not.toContain("sorage init");
      expect(snapshot(fixture.vaultPath)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("V6 refuses an empty directory without a marker and names reconfiguration only here", () => {
    const fixture = bareVault("sorage-v6-");
    try {
      const before = snapshot(fixture.vaultPath);
      const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(
        `The directory ${fixture.vaultPath} is empty and has not been initialized as a Vault.`,
      );
      expect(error.details).toEqual({ vaultPath: fixture.vaultPath });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.emptyUninitialized);
      expect(recoveryOf(error)).toContain("sorage init --reconfigure --non-interactive");
      expect(snapshot(fixture.vaultPath)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("V7 reports each invalid marker body with its exact message and recovery", () => {
    const cases: Array<[string, string]> = [
      ["not json", "The Vault marker is not valid JSON."],
      ["[]", "The Vault marker is not a JSON object."],
      [markerBodyOf({ type: "sorage-backup" }), "The marker's type is not 'sorage-vault'."],
      [markerBodyOf({ schemaVersion: 0 }), "The Vault marker schemaVersion is not a positive integer: 0."],
      [markerBodyOf({ installationId: "" }), "The Vault marker has no installationId."],
      [markerBodyOf({ createdAt: "" }), "The Vault marker has no createdAt."],
    ];
    for (const [body, message] of cases) {
      const fixture = bareVault("sorage-v7-");
      try {
        writeFileSync(join(fixture.vaultPath, ".sorage-vault.json"), body);
        const before = snapshot(fixture.vaultPath);
        const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
        expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
        expect(exitCodeOf(error)).toBe(73);
        expect(error.message).toBe(message);
        expect(error.details).toEqual({ vaultPath: fixture.vaultPath });
        expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.invalidMarker);
        expect(snapshot(fixture.vaultPath)).toEqual(before);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("V8 blocks a foreign marker and names the audited restore route only", () => {
    const fixture = bareVault("sorage-v8-");
    try {
      writeFileSync(
        join(fixture.vaultPath, ".sorage-vault.json"),
        markerBodyOf({ installationId: "22222222-2222-4222-8222-222222222222" }),
      );
      const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(exitCodeOf(error)).toBe(73);
      expect(error.message).toBe(
        `The Vault marker belongs to installation 22222222-2222-4222-8222-222222222222, not this installation ${INSTALLATION}; adopt it only through the audited ${VAULT_ADOPTION_COMMAND}.`,
      );
      expect(error.details).toEqual({ vaultPath: fixture.vaultPath });
      expect(recoveryOf(error)).toBe(VAULT_OPEN_RECOVERY.foreignMarker);
      expect(recoveryOf(error)).toContain("fresh installation");
      expect(recoveryOf(error)).not.toContain("config edit");
    } finally {
      fixture.cleanup();
    }
  });

  it("V9 keeps the newer-marker refusal and the catalogue recovery unchanged", () => {
    const fixture = bareVault("sorage-v9-");
    try {
      writeFileSync(join(fixture.vaultPath, ".sorage-vault.json"), markerBodyOf({ schemaVersion: 2 }));
      const error = refusalOf(openVault(fixture.vaultPath, INSTALLATION));
      expect(error.code).toBe("VAULT_SCHEMA_UNSUPPORTED");
      expect(exitCodeOf(error)).toBe(78);
      expect(error.details).toEqual({ vaultPath: fixture.vaultPath });
      // The site adds no recovery, so the catalogue default renders (VAULT_SCHEMA_UNSUPPORTED).
      expect(error.recovery).toBeUndefined();
      expect(errorSpec("VAULT_SCHEMA_UNSUPPORTED").recovery?.suggestedCommand).toBe(
        "Upgrade Sorage; Sorage never downgrades a Vault",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps every state recovery free of sorage vault verify", () => {
    for (const [state, recovery] of Object.entries(VAULT_OPEN_RECOVERY)) {
      expect(recovery, state).not.toContain("sorage vault verify");
    }
  });
});
