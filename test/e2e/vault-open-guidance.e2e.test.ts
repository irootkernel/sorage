import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, errorEnvelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

/**
 * TASK-118 at the compiled surface: every `openVault` state refuses with a safe
 * action that can run in that state, the plain `init` hint branches on the
 * actual probe, and the V6 evidence separates a genuinely new installation
 * from the preservation case (F1, VLT-002, VLT-003, VLT-019, INIT-017).
 */
afterAll(runCleanups);

const MESSAGES = {
  V1: (vault: string) => `The Vault directory does not exist at ${vault}.`,
  V2: (vault: string) => `The Vault directory at ${vault} cannot be inspected.`,
  V3: (vault: string) => `The Vault path ${vault} is a file, not a directory.`,
  V4: (vault: string) => `The Vault marker at ${vault}/.sorage-vault.json cannot be read.`,
  V5: (vault: string) => `Refusing to adopt the non-empty directory ${vault} because it has no Vault marker (VLT-003).`,
  V6: (vault: string) => `The directory ${vault} is empty and has not been initialized as a Vault.`,
  V7: () => "The Vault marker is not valid JSON.",
} as const;

const RECOVERY = {
  missingDirectory:
    "Check the configured vault.path with sorage config show and confirm the Vault directory is present and its volume is mounted; if the Vault is lost, restore a verified backup into a fresh installation. Do not initialize the configured path or replace a Vault that may only be unmounted",
  unreadableDirectory:
    "Confirm the Vault directory is readable and reachable without a symlink loop, and, when its marker is missing or unreadable, that its entries can be listed and its volume is mounted; if the Vault is lost, restore a verified backup into a fresh installation. Do not initialize the configured path or replace a Vault that may only be unmounted",
  filePath:
    "Check the configured vault.path with sorage config show; it must name the Vault directory, not a file. If a stray file occupies the intended Vault path, move it aside only after confirming it is not the Vault; do not initialize over it or replace an existing Vault",
  unreadableMarker:
    "Confirm the Vault directory and its marker are readable by this user and that the Vault volume is mounted; if the marker is lost, restore a verified backup into a fresh installation. Never replace the marker by hand or initialize over the existing Vault",
  nonEmptyWithoutMarker:
    "Check the configured vault.path and confirm its volume is mounted; if this is the intended Vault and its marker was lost, restore a verified backup into a fresh installation. Never create a marker by hand, initialize over a populated directory, or replace a populated Vault",
  emptyUninitialized:
    "Check the configured vault.path and confirm its volume is mounted; if this installation has prior data, restore a verified backup into a fresh installation. Only for a genuinely new installation with no prior Vault data may sorage init --reconfigure --non-interactive backfill this empty directory",
  invalidMarker:
    "Check the configured vault.path and confirm its volume is mounted; if the marker is damaged, restore a verified backup into a fresh installation. Never rewrite the marker by hand or initialize over the existing Vault",
  foreignMarker:
    "Adopt this Vault only by restoring it into a fresh installation with sorage backup restore --from <vault-path> --as-user --confirm; never rewrite the marker in place",
  catalogue: "Upgrade Sorage; Sorage never downgrades a Vault",
} as const;

const isRoot = process.getuid?.() === 0;

function initializedHome(prefix: string): { home: string; vault: string } {
  const home = makeTempDir(`${prefix}-home-`);
  const init = sorage(["init", "--non-interactive"], { home });
  if (init.status !== 0) throw new Error(`fixture init failed: ${init.stderr}`);
  return { home, vault: join(home, "vault") };
}

function vaultTree(vault: string): string[] {
  if (!existsSync(vault)) return [];
  return statSync(vault).isDirectory() ? readdirSync(vault).sort() : ["<file>"];
}

interface Expected {
  state: string;
  exit: number;
  code: string;
  message: string;
  recovery: string;
  details: Record<string, unknown>;
}

function expectRefusal(home: string, expected: Expected): void {
  for (const command of [
    ["vault", "verify"],
    ["send", "--to", "no-such-project", "--title", "T118", "--body", "body"],
    ["memo", "list", "--all-projects"],
    ["channel", "list"],
    ["backup", "status"],
  ]) {
    const json = sorage([...command, "--json"], { home });
    expect(json.status, `${expected.state} ${command.join(" ")}`).toBe(expected.exit);
    expect(json.stdout, `${expected.state} ${command.join(" ")}`).toBe("");
    const envelope = errorEnvelopeOf(json) as unknown as {
      error: {
        code: string;
        message: string;
        details: Record<string, unknown>;
        recovery?: { suggestedCommand: string };
      };
    };
    expect(envelope.error.code, `${expected.state} ${command.join(" ")}`).toBe(expected.code);
    expect(envelope.error.message, `${expected.state} ${command.join(" ")}`).toBe(expected.message);
    expect(envelope.error.details, `${expected.state} ${command.join(" ")}`).toEqual(expected.details);
    expect(envelope.error.recovery?.suggestedCommand, `${expected.state}`).toBe(expected.recovery);
    expect((json.stderr.match(/"ok": false/g) ?? []).length, "one envelope").toBe(1);

    const human = sorage(command, { home });
    expect(human.status, `${expected.state} human`).toBe(expected.exit);
    expect(human.stdout, `${expected.state} human`).toBe("");
    expect(human.stderr).toBe(`${expected.code}: ${expected.message}\nRecovery: ${expected.recovery}\n`);
  }
}

describe("the compiled Vault-open matrix (TASK-118)", () => {
  it("V1 reports the missing directory and leaves the state untouched", () => {
    const { home, vault } = initializedHome("t118-e2e-v1");
    rmSync(vault, { recursive: true, force: true });
    expectRefusal(home, {
      state: "V1",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: MESSAGES.V1(vault),
      recovery: RECOVERY.missingDirectory,
      details: { vaultPath: vault },
    });
    expect(existsSync(vault)).toBe(false);
  });

  it("V2 reports an unstattable directory at 73", () => {
    const { home, vault } = initializedHome("t118-e2e-v2");
    rmSync(vault, { recursive: true, force: true });
    symlinkSync(vault, vault);
    expectRefusal(home, {
      state: "V2",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: MESSAGES.V2(vault),
      recovery: RECOVERY.unreadableDirectory,
      details: { vaultPath: vault },
    });
  });

  it.skipIf(isRoot)("V2 maps an execute-only listing failure to 73 without an entry count", () => {
    const { home, vault } = initializedHome("t118-e2e-v2-listing");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    chmodSync(vault, 0o300);
    try {
      expectRefusal(home, {
        state: "V2",
        exit: 73,
        code: "VAULT_INTEGRITY_ERROR",
        message: MESSAGES.V2(vault),
        recovery: RECOVERY.unreadableDirectory,
        details: { vaultPath: vault },
      });
    } finally {
      chmodSync(vault, 0o700);
    }
  });

  it("V3 refuses a file at the Vault path", () => {
    const { home, vault } = initializedHome("t118-e2e-v3");
    rmSync(vault, { recursive: true, force: true });
    writeFileSync(vault, "not a vault\n");
    const tree = vaultTree(vault);
    expectRefusal(home, {
      state: "V3",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: MESSAGES.V3(vault),
      recovery: RECOVERY.filePath,
      details: { vaultPath: vault },
    });
    expect(vaultTree(vault)).toEqual(tree);
  });

  it("V4 reports the unreadable marker with its entry count", () => {
    const { home, vault } = initializedHome("t118-e2e-v4");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    mkdirSync(join(vault, ".sorage-vault.json"));
    const tree = vaultTree(vault);
    expectRefusal(home, {
      state: "V4",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: MESSAGES.V4(vault),
      recovery: RECOVERY.unreadableMarker,
      details: { vaultPath: vault, entryCount: readdirSync(vault).length },
    });
    expect(vaultTree(vault)).toEqual(tree);
  });

  it("V5 refuses adoption of a populated directory", () => {
    const { home, vault } = initializedHome("t118-e2e-v5");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    const tree = vaultTree(vault);
    expectRefusal(home, {
      state: "V5",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: MESSAGES.V5(vault),
      recovery: RECOVERY.nonEmptyWithoutMarker,
      details: { vaultPath: vault, entryCount: tree.length },
    });
    expect(vaultTree(vault)).toEqual(tree);
    expect(RECOVERY.nonEmptyWithoutMarker).not.toContain("sorage init");
  });

  it("V6 names reconfiguration as the only state that may", () => {
    const { home, vault } = initializedHome("t118-e2e-v6");
    for (const entry of readdirSync(vault)) rmSync(join(vault, entry), { recursive: true, force: true });
    expectRefusal(home, {
      state: "V6",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: MESSAGES.V6(vault),
      recovery: RECOVERY.emptyUninitialized,
      details: { vaultPath: vault },
    });
    expect(readdirSync(vault)).toEqual([]);
    expect(RECOVERY.emptyUninitialized).toContain("sorage init --reconfigure --non-interactive");
  });

  it("V7 reports the invalid marker body", () => {
    const { home, vault } = initializedHome("t118-e2e-v7");
    writeFileSync(join(vault, ".sorage-vault.json"), "not json");
    expectRefusal(home, {
      state: "V7",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: MESSAGES.V7(),
      recovery: RECOVERY.invalidMarker,
      details: { vaultPath: vault },
    });
  });

  it("V8 names only the audited adoption route", () => {
    const { home, vault } = initializedHome("t118-e2e-v8");
    const own = (envelopeOf(sorage(["config", "show", "--json"], { home })) as { data: { installationId: string } })
      .data.installationId;
    writeFileSync(
      join(vault, ".sorage-vault.json"),
      `${JSON.stringify({
        type: "sorage-vault",
        schemaVersion: 1,
        installationId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    expectRefusal(home, {
      state: "V8",
      exit: 73,
      code: "VAULT_INTEGRITY_ERROR",
      message: `The Vault marker belongs to installation 22222222-2222-4222-8222-222222222222, not this installation ${own}; adopt it only through the audited sorage backup restore --from <vault-path> --as-user --confirm.`,
      recovery: RECOVERY.foreignMarker,
      details: { vaultPath: vault },
    });
  });

  it("V9 keeps VAULT_SCHEMA_UNSUPPORTED at 78 in JSON, human and shared surfaces", () => {
    const { home, vault } = initializedHome("t118-e2e-v9");
    writeFileSync(
      join(vault, ".sorage-vault.json"),
      `${JSON.stringify({
        type: "sorage-vault",
        schemaVersion: 2,
        installationId: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const message = "The Vault marker schemaVersion 2 is newer than this build's 1; Sorage never downgrades a Vault.";
    for (const command of [
      ["vault", "verify"],
      ["memo", "list", "--all-projects"],
      ["backup", "status"],
    ]) {
      const json = sorage([...command, "--json"], { home });
      expect(json.status, command.join(" ")).toBe(78);
      expect(json.stdout, command.join(" ")).toBe("");
      const envelope = errorEnvelopeOf(json) as unknown as {
        error: { code: string; message: string; recovery?: { suggestedCommand: string } };
      };
      expect(envelope.error.code, command.join(" ")).toBe("VAULT_SCHEMA_UNSUPPORTED");
      expect(envelope.error.message, command.join(" ")).toBe(message);
      expect(envelope.error.recovery?.suggestedCommand, command.join(" ")).toBe(RECOVERY.catalogue);

      const human = sorage(command, { home });
      expect(human.status, command.join(" ")).toBe(78);
      expect(human.stdout, command.join(" ")).toBe("");
      expect(human.stderr).toBe(`VAULT_SCHEMA_UNSUPPORTED: ${message}\nRecovery: ${RECOVERY.catalogue}\n`);
    }
    // A Project command never opens the Vault, so it still succeeds.
    const projects = sorage(["project", "list", "--json"], { home });
    expect(projects.status).toBe(0);
    expect(projects.stdout).not.toBe("");
  });

  it("V1 still runs the commands that do not open the Vault", () => {
    const { home, vault } = initializedHome("t118-e2e-v1-surfaces");
    rmSync(vault, { recursive: true, force: true });
    expect(sorage(["config", "show", "--json"], { home }).status).toBe(0);
    expect(sorage(["project", "list", "--json"], { home }).status).toBe(0);
    const doctor = sorage(["doctor", "--json"], { home });
    expect(doctor.status).toBe(1);
    const report = envelopeOf(doctor) as {
      data: { checks: Array<{ id: string; recovery?: { suggestedCommand: string } }> };
    };
    const marker = report.data.checks.find((check) => check.id === "vault.marker");
    expect(marker?.recovery?.suggestedCommand).toBe(RECOVERY.missingDirectory);
    for (const check of report.data.checks) {
      expect(check.recovery?.suggestedCommand ?? "", check.id).not.toContain("sorage vault verify");
    }
    const init = sorage(["init", "--non-interactive"], { home });
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("already initialized");
    expect(init.stdout).not.toContain("sorage init --reconfigure");
    expect(existsSync(vault)).toBe(false);
  });

  it("reports the V1 refusal from doctor's checksum checks when records exist", () => {
    const { home, vault } = initializedHome("t118-e2e-v1-doctor");
    const work = makeTempDir("t118-e2e-project-");
    expect(sorage(["project", "add", "--name", "Alpha", "--dir", work], { home }).status).toBe(0);
    const document = join(work, "brief.md");
    writeFileSync(document, "# Brief\n");
    const sent = sorage(
      ["send", "--to", "alpha", "--title", "T118", "--file", document, "--allow-external-source", "--json"],
      { home, cwd: work },
    );
    expect(sent.status, sent.stderr).toBe(0);
    rmSync(vault, { recursive: true, force: true });
    const doctor = sorage(["doctor", "--json"], { home });
    expect(doctor.status).toBe(1);
    const report = envelopeOf(doctor) as {
      data: { checks: Array<{ id: string; message: string; recovery?: { suggestedCommand: string } }> };
    };
    for (const id of ["vault.marker", "artifacts.checksums", "content.checksums"]) {
      const check = report.data.checks.find((entry) => entry.id === id);
      expect(check?.message, id).toBe(MESSAGES.V1(vault));
      expect(check?.recovery?.suggestedCommand, id).toBe(RECOVERY.missingDirectory);
    }
  });
});

describe("the V6 reconfiguration evidence at the compiled surface (TASK-118)", () => {
  it("backfills a genuinely new empty configured Vault directory", () => {
    const { home, vault } = initializedHome("t118-e2e-v6-new");
    const configBefore = readFileSync(join(home, "config.yaml"), "utf8");
    for (const entry of readdirSync(vault)) rmSync(join(vault, entry), { recursive: true, force: true });
    expect(readdirSync(vault)).toEqual([]);
    const reconfigure = sorage(["init", "--non-interactive", "--reconfigure", "--json"], { home });
    expect(reconfigure.status, reconfigure.stderr).toBe(0);
    expect((envelopeOf(reconfigure) as { data: { outcome: string } }).data.outcome).toBe("already-initialized");
    for (const entry of [".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "staging", "content"]) {
      expect(existsSync(join(vault, entry)), entry).toBe(true);
    }
    expect(sorage(["vault", "status", "--json"], { home }).status).toBe(0);
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(configBefore);
    const marker = readFileSync(join(vault, ".sorage-vault.json"), "utf8");
    const layout = readdirSync(vault).sort();
    expect(sorage(["init", "--non-interactive", "--reconfigure", "--json"], { home }).status).toBe(0);
    expect(readFileSync(join(vault, ".sorage-vault.json"), "utf8")).toBe(marker);
    expect(readdirSync(vault).sort()).toEqual(layout);
  });

  it("preserves recorded Projects and Memos across a reconfiguration", () => {
    const { home, vault } = initializedHome("t118-e2e-v6-preserve");
    const work = makeTempDir("t118-e2e-preserve-project-");
    expect(sorage(["project", "add", "--name", "Preserved", "--dir", work], { home }).status).toBe(0);
    expect(
      sorage(["memo", "add", "--project", "preserved", "--title", "Kept", "--body", "kept body", "--json"], { home })
        .status,
    ).toBe(0);
    const projectsBefore = sorage(["project", "list", "--json"], { home });
    const memosBefore = sorage(["memo", "list", "--all-projects", "--json"], { home });
    const configBefore = readFileSync(join(home, "config.yaml"), "utf8");
    for (const entry of readdirSync(vault)) rmSync(join(vault, entry), { recursive: true, force: true });
    expect(sorage(["init", "--non-interactive", "--reconfigure", "--json"], { home }).status).toBe(0);
    expect((JSON.parse(sorage(["project", "list", "--json"], { home }).stdout) as { data: unknown }).data).toEqual(
      (JSON.parse(projectsBefore.stdout) as { data: unknown }).data,
    );
    expect(
      (JSON.parse(sorage(["memo", "list", "--all-projects", "--json"], { home }).stdout) as { data: unknown }).data,
    ).toEqual((JSON.parse(memosBefore.stdout) as { data: unknown }).data);
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(configBefore);
  });

  it("records the V1 hazard: reconfiguration creates a Vault at a missing configured path", () => {
    const { home, vault } = initializedHome("t118-e2e-v1-negative");
    rmSync(vault, { recursive: true, force: true });
    expect(sorage(["init", "--non-interactive", "--reconfigure", "--json"], { home }).status).toBe(0);
    expect(existsSync(join(vault, ".sorage-vault.json"))).toBe(true);
    expect(sorage(["vault", "status", "--json"], { home }).status).toBe(0);
  });

  it("records the V5 hazard: reconfiguration writes a marker into a populated directory", () => {
    const { home, vault } = initializedHome("t118-e2e-v5-negative");
    writeFileSync(join(vault, "important.txt"), "untouched");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    expect(sorage(["init", "--non-interactive", "--reconfigure", "--json"], { home }).status).toBe(0);
    expect(existsSync(join(vault, ".sorage-vault.json"))).toBe(true);
    expect(readFileSync(join(vault, "important.txt"), "utf8")).toBe("untouched");
  });
});

describe("the compiled init configuration-access refusal (TASK-118 K10)", () => {
  const ACCESS_REPAIR =
    "Restore the home directory with mode 0700 and config.yaml with owner-only 0600 permissions; do not reinitialize an existing installation";

  it.skipIf(isRoot)(
    "refuses an unreadable configuration with the access repair and preserves the installation (root reads a mode-000 file, so this case is skipped as root)",
    () => {
      const { home, vault } = initializedHome("t118-e2e-init-unreadable");
      const configPath = join(home, "config.yaml");
      const markerPath = join(vault, ".sorage-vault.json");
      const configBefore = readFileSync(configPath, "utf8");
      const markerBefore = readFileSync(markerPath, "utf8");
      const shown = envelopeOf(sorage(["config", "show", "--json"], { home })) as {
        data: { installationId: string };
      };
      chmodSync(configPath, 0o000);
      try {
        const json = sorage(["init", "--non-interactive", "--json"], { home });
        expect(json.status).toBe(78);
        expect(json.stdout).toBe("");
        const envelope = errorEnvelopeOf(json) as unknown as {
          error: { code: string; message: string; recovery?: { suggestedCommand: string } };
        };
        expect(envelope.error.code).toBe("CONFIG_INVALID");
        expect(envelope.error.message).toBe(`The configuration at ${configPath} cannot be read.`);
        expect(envelope.error.recovery?.suggestedCommand).toBe(ACCESS_REPAIR);

        const human = sorage(["init", "--non-interactive"], { home });
        expect(human.status).toBe(78);
        expect(human.stdout).toBe("");
        expect(human.stderr).toContain("CONFIG_INVALID:");
        expect(human.stderr).toContain(`Recovery: ${ACCESS_REPAIR}`);
      } finally {
        chmodSync(configPath, 0o600);
      }
      // Nothing was treated as a new installation.
      expect(readFileSync(configPath, "utf8")).toBe(configBefore);
      expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
      const after = envelopeOf(sorage(["config", "show", "--json"], { home })) as {
        data: { installationId: string };
      };
      expect(after.data.installationId).toBe(shown.data.installationId);
    },
  );
});
