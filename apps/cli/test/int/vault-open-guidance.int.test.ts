import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VAULT_ADOPTION_COMMAND, VAULT_OPEN_RECOVERY } from "@sorage/core";
import { runCli } from "../../src/main";

/**
 * The TASK-118 contract at the CLI surface: every `openVault` refusal state
 * renders its own safe action, the plain `init` hint branches on the actual
 * Vault-open probe, and the V6 reconfiguration evidence is separated from the
 * preservation case (F1, VLT-002, VLT-003, VLT-019, INIT-017).
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

const isRoot = process.getuid?.() === 0;

function tempVault(prefix: string): { home: string; vault: string } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const io = capture();
  expect(runCli(["init", "--non-interactive"], io.ports)).toBe(0);
  return { home, vault: join(home, "vault") };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

interface ErrorEnvelope {
  ok: boolean;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    recovery?: { suggestedCommand: string };
  };
  meta: { requestId: string };
}

function refusal(args: string[]): { exit: number; envelope: ErrorEnvelope; stderr: string } {
  const io = capture();
  const exit = runCli([...args, "--json"], io.ports);
  expect(io.outText(), "a JSON refusal writes nothing to stdout").toBe("");
  expect((io.errText().match(/"ok": false/g) ?? []).length, "exactly one envelope").toBe(1);
  const envelope = JSON.parse(io.errText()) as ErrorEnvelope;
  expect(envelope.ok).toBe(false);
  expect(envelope.meta.requestId).not.toBe("");
  return { exit, envelope, stderr: io.errText() };
}

function humanRefusal(args: string[]): { exit: number; stderr: string } {
  const io = capture();
  const exit = runCli(args, io.ports);
  return { exit, stderr: io.errText() };
}

describe("the CLI Vault-open matrix (TASK-118)", () => {
  it("V1: missing directory names the mount check and refuses at 73", () => {
    const { home, vault } = tempVault("sorage-t118-cli-v1-");
    rmSync(vault, { recursive: true, force: true });
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.code).toBe("VAULT_INTEGRITY_ERROR");
    expect(envelope.error.message).toBe(`The Vault directory does not exist at ${vault}.`);
    expect(envelope.error.details).toEqual({ vaultPath: vault });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.missingDirectory);
    expect(envelope.error.recovery?.suggestedCommand).toContain("Do not initialize");
    expect(envelope.error.recovery?.suggestedCommand).not.toContain("sorage init");

    const human = humanRefusal(["vault", "verify"]);
    expect(human.exit).toBe(73);
    expect(human.stderr).toBe(
      `VAULT_INTEGRITY_ERROR: ${envelope.error.message}\nRecovery: ${VAULT_OPEN_RECOVERY.missingDirectory}\n`,
    );

    // The states that still work must keep working.
    const show = capture();
    expect(runCli(["config", "show", "--json"], show.ports)).toBe(0);
    const shown = JSON.parse(show.outText()) as { data: { installationId: string; vault: { path: string } } };
    expect(typeof shown.data.installationId).toBe("string");
    expect(shown.data.vault.path).not.toBe("");
    const projects = capture();
    expect(runCli(["project", "list", "--json"], projects.ports)).toBe(0);

    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as {
      data: { checks: Array<{ id: string; recovery?: { suggestedCommand: string } }> };
    };
    const marker = report.data.checks.find((check) => check.id === "vault.marker");
    expect(marker?.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.missingDirectory);
    for (const check of report.data.checks) {
      expect(check.recovery?.suggestedCommand ?? "", check.id).not.toContain("sorage vault verify");
    }

    const init = capture();
    expect(runCli(["init", "--non-interactive"], init.ports)).toBe(0);
    expect(init.outText()).toContain("already initialized");
    expect(init.outText()).not.toContain("sorage init --reconfigure");
    expect(existsSync(home)).toBe(true);
  });

  it("V2: a symlink loop is an uninspectable directory at 73", () => {
    const { vault } = tempVault("sorage-t118-cli-v2-");
    rmSync(vault, { recursive: true, force: true });
    symlinkSync(vault, vault);
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.code).toBe("VAULT_INTEGRITY_ERROR");
    expect(envelope.error.message).toBe(`The Vault directory at ${vault} cannot be inspected.`);
    expect(envelope.error.details).toEqual({ vaultPath: vault });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
    expect(envelope.error.recovery?.suggestedCommand).toContain("Do not initialize");
  });

  it.skipIf(isRoot)("V2: an execute-only directory without a marker maps the listing failure to 73", () => {
    const { vault } = tempVault("sorage-t118-cli-v2-listing-");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    chmodSync(vault, 0o300);
    try {
      const { exit, envelope } = refusal(["vault", "verify"]);
      expect(exit).toBe(73);
      expect(envelope.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(envelope.error.message).toBe(`The Vault directory at ${vault} cannot be inspected.`);
      expect(envelope.error.details).toEqual({ vaultPath: vault });
      expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.unreadableDirectory);
    } finally {
      chmodSync(vault, 0o700);
    }
  });

  it("V3: a file at the Vault path refuses at 73 without touching it", () => {
    const { vault } = tempVault("sorage-t118-cli-v3-");
    rmSync(vault, { recursive: true, force: true });
    writeFileSync(vault, "not a vault\n");
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.message).toBe(`The Vault path ${vault} is a file, not a directory.`);
    expect(envelope.error.details).toEqual({ vaultPath: vault });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.filePath);
    expect(readFileSync(vault, "utf8")).toBe("not a vault\n");
  });

  it("V4: a directory at the marker path reports the unreadable marker with its entry count", () => {
    const { vault } = tempVault("sorage-t118-cli-v4-");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    mkdirSync(join(vault, ".sorage-vault.json"));
    const entryCount = readdirSync(vault).length;
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.message).toBe(`The Vault marker at ${vault}/.sorage-vault.json cannot be read.`);
    expect(envelope.error.details).toEqual({ vaultPath: vault, entryCount });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.unreadableMarker);
  });

  it("V5: a populated directory without a marker refuses adoption at 73", () => {
    const { vault } = tempVault("sorage-t118-cli-v5-");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    const entryCount = readdirSync(vault).length;
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.message).toBe(
      `Refusing to adopt the non-empty directory ${vault} because it has no Vault marker (VLT-003).`,
    );
    expect(envelope.error.details).toEqual({ vaultPath: vault, entryCount });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.nonEmptyWithoutMarker);
    expect(envelope.error.recovery?.suggestedCommand).not.toContain("sorage init");
  });

  it("V6: an empty directory names reconfiguration as the only state that may", () => {
    const { vault } = tempVault("sorage-t118-cli-v6-");
    for (const entry of readdirSync(vault)) rmSync(join(vault, entry), { recursive: true, force: true });
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.message).toBe(`The directory ${vault} is empty and has not been initialized as a Vault.`);
    expect(envelope.error.details).toEqual({ vaultPath: vault });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.emptyUninitialized);
    expect(envelope.error.recovery?.suggestedCommand).toContain("sorage init --reconfigure --non-interactive");
  });

  it("V7: an invalid marker reports its exact core message and the invalid-marker recovery", () => {
    const { vault } = tempVault("sorage-t118-cli-v7-");
    writeFileSync(join(vault, ".sorage-vault.json"), "not json");
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.message).toBe("The Vault marker is not valid JSON.");
    expect(envelope.error.details).toEqual({ vaultPath: vault });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.invalidMarker);
  });

  it("V8: a foreign marker names only the audited adoption route", () => {
    const { vault } = tempVault("sorage-t118-cli-v8-");
    writeFileSync(
      join(vault, ".sorage-vault.json"),
      `${JSON.stringify({
        type: "sorage-vault",
        schemaVersion: 1,
        installationId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(73);
    expect(envelope.error.message).toContain(`adopt it only through the audited ${VAULT_ADOPTION_COMMAND}`);
    expect(envelope.error.details).toEqual({ vaultPath: vault });
    expect(envelope.error.recovery?.suggestedCommand).toBe(VAULT_OPEN_RECOVERY.foreignMarker);
    expect(envelope.error.recovery?.suggestedCommand).not.toContain("config edit");
  });

  it("V9: a newer marker keeps VAULT_SCHEMA_UNSUPPORTED at 78 and the catalogue recovery", () => {
    const { vault } = tempVault("sorage-t118-cli-v9-");
    writeFileSync(
      join(vault, ".sorage-vault.json"),
      `${JSON.stringify({
        type: "sorage-vault",
        schemaVersion: 2,
        installationId: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const { exit, envelope } = refusal(["vault", "verify"]);
    expect(exit).toBe(78);
    expect(envelope.error.code).toBe("VAULT_SCHEMA_UNSUPPORTED");
    expect(envelope.error.message).toContain("is newer than this build's");
    expect(envelope.error.details).toEqual({ vaultPath: vault });
    expect(envelope.error.recovery?.suggestedCommand).toBe("Upgrade Sorage; Sorage never downgrades a Vault");
  });

  it("renders the same refusal on the Handoff, Memo, Channel and backup surfaces", () => {
    const cases: Array<{ name: string; setup: (vault: string) => void; message: string }> = [
      { name: "V1", setup: (vault) => rmSync(vault, { recursive: true, force: true }), message: "" },
      {
        name: "V3",
        setup: (vault) => {
          rmSync(vault, { recursive: true, force: true });
          writeFileSync(vault, "not a vault\n");
        },
        message: "",
      },
      {
        name: "V4",
        setup: (vault) => {
          rmSync(join(vault, ".sorage-vault.json"), { force: true });
          mkdirSync(join(vault, ".sorage-vault.json"));
        },
        message: "",
      },
      {
        name: "V6",
        setup: (vault) => {
          for (const entry of readdirSync(vault)) rmSync(join(vault, entry), { recursive: true, force: true });
        },
        message: "",
      },
      {
        name: "V7",
        setup: (vault) => writeFileSync(join(vault, ".sorage-vault.json"), "not json"),
        message: "The Vault marker is not valid JSON.",
      },
      {
        name: "V8",
        setup: (vault) =>
          writeFileSync(
            join(vault, ".sorage-vault.json"),
            `${JSON.stringify({
              type: "sorage-vault",
              schemaVersion: 1,
              installationId: "22222222-2222-4222-8222-222222222222",
              createdAt: "2026-01-01T00:00:00.000Z",
            })}\n`,
          ),
        message: "",
      },
    ];
    for (const testCase of cases) {
      const { vault } = tempVault(`sorage-t118-cli-surface-${testCase.name.toLowerCase()}-`);
      testCase.setup(vault);
      const first = refusal(["vault", "verify"]);
      expect(first.envelope.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(first.exit).toBe(73);
      for (const args of [
        ["send", "--to", "no-such-project", "--title", "T118", "--body", "body"],
        ["memo", "list"],
        ["channel", "list"],
        ["backup", "status"],
      ]) {
        const other = refusal(args);
        expect(other.exit, `${testCase.name} ${args.join(" ")}`).toBe(73);
        expect(other.envelope.error.code, `${testCase.name} ${args.join(" ")}`).toBe("VAULT_INTEGRITY_ERROR");
        expect(other.envelope.error.message, `${testCase.name} ${args.join(" ")}`).toBe(first.envelope.error.message);
        expect(other.envelope.error.details, `${testCase.name} ${args.join(" ")}`).toEqual(
          first.envelope.error.details,
        );
        expect(other.envelope.error.recovery, `${testCase.name} ${args.join(" ")}`).toEqual(
          first.envelope.error.recovery,
        );
      }
      if (testCase.message !== "") {
        expect(first.envelope.error.message).toBe(testCase.message);
      }
    }
  });
});

describe("the V6 reconfiguration evidence and its negatives (TASK-118)", () => {
  it("backfills a genuinely new empty configured Vault directory", () => {
    const { home, vault } = tempVault("sorage-t118-cli-v6-new-");
    const configBefore = readFileSync(join(home, "config.yaml"), "utf8");
    for (const entry of readdirSync(vault)) rmSync(join(vault, entry), { recursive: true, force: true });
    expect(readdirSync(vault)).toEqual([]);

    const io = capture();
    expect(runCli(["init", "--non-interactive", "--reconfigure", "--json"], io.ports)).toBe(0);
    const envelope = JSON.parse(io.outText()) as { data: { outcome: string } };
    expect(envelope.data.outcome).toBe("already-initialized");
    for (const entry of [".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "staging", "content"]) {
      expect(existsSync(join(vault, entry)), entry).toBe(true);
    }
    expect(runCli(["vault", "status", "--json"], capture().ports)).toBe(0);
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(configBefore);

    const markerBefore = readFileSync(join(vault, ".sorage-vault.json"), "utf8");
    const layoutBefore = readdirSync(vault).sort();
    expect(runCli(["init", "--non-interactive", "--reconfigure", "--json"], capture().ports)).toBe(0);
    expect(readFileSync(join(vault, ".sorage-vault.json"), "utf8")).toBe(markerBefore);
    expect(readdirSync(vault).sort()).toEqual(layoutBefore);
  });

  it("preserves recorded Projects and Memos across a reconfiguration", () => {
    const { home, vault } = tempVault("sorage-t118-cli-v6-preserve-");
    const work = mkdtempSync(join(tmpdir(), "sorage-t118-project-"));
    homes.push(work);
    expect(runCli(["project", "add", "--name", "Preserved", "--dir", work, "--json"], capture().ports)).toBe(0);
    expect(
      runCli(
        ["memo", "add", "--project", "preserved", "--title", "Kept", "--body", "kept body", "--json"],
        capture().ports,
      ),
    ).toBe(0);
    const projectData = capture();
    expect(runCli(["project", "list", "--json"], projectData.ports)).toBe(0);
    const memoData = capture();
    expect(runCli(["memo", "list", "--all-projects", "--json"], memoData.ports)).toBe(0);
    const configBefore = readFileSync(join(home, "config.yaml"), "utf8");

    for (const entry of readdirSync(vault)) rmSync(join(vault, entry), { recursive: true, force: true });
    expect(runCli(["init", "--non-interactive", "--reconfigure", "--json"], capture().ports)).toBe(0);

    const projectsAfter = capture();
    expect(runCli(["project", "list", "--json"], projectsAfter.ports)).toBe(0);
    expect((JSON.parse(projectsAfter.outText()) as { data: unknown }).data).toEqual(
      (JSON.parse(projectData.outText()) as { data: unknown }).data,
    );
    const memosAfter = capture();
    expect(runCli(["memo", "list", "--all-projects", "--json"], memosAfter.ports)).toBe(0);
    expect((JSON.parse(memosAfter.outText()) as { data: unknown }).data).toEqual(
      (JSON.parse(memoData.outText()) as { data: unknown }).data,
    );
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(configBefore);
  });

  it("records the V1 hazard: reconfiguration creates a Vault at a missing configured path", () => {
    const { vault } = tempVault("sorage-t118-cli-v1-negative-");
    rmSync(vault, { recursive: true, force: true });
    expect(runCli(["init", "--non-interactive", "--reconfigure", "--json"], capture().ports)).toBe(0);
    expect(existsSync(join(vault, ".sorage-vault.json"))).toBe(true);
    expect(runCli(["vault", "status", "--json"], capture().ports)).toBe(0);
  });

  it("records the V5 hazard: reconfiguration writes a marker into a populated directory", () => {
    const { vault } = tempVault("sorage-t118-cli-v5-negative-");
    writeFileSync(join(vault, "important.txt"), "untouched");
    rmSync(join(vault, ".sorage-vault.json"), { force: true });
    expect(runCli(["init", "--non-interactive", "--reconfigure", "--json"], capture().ports)).toBe(0);
    expect(existsSync(join(vault, ".sorage-vault.json"))).toBe(true);
    expect(readFileSync(join(vault, "important.txt"), "utf8")).toBe("untouched");
    expect(runCli(["vault", "status", "--json"], capture().ports)).toBe(0);
  });
});
