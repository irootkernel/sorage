import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The TASK-118 contract golden: every `openVault` refusal state renders its own
 * safe action at the CLI surface, the newer-marker refusal keeps its catalogue
 * recovery, and doctor's Vault-open checks report the same state. Existing
 * goldens (`error-renderings.json`, `backup-restore-invalid-vault.txt`,
 * `tour/06-doctor.json`) must stay byte-identical; this is the only new golden.
 */
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));
const updateGoldens = process.env.SORAGE_UPDATE_GOLDENS === "1";
const REQUEST_ID = "2f0ac9a0-0000-4000-8000-0000000000aa";

const parent = mkdtempSync(join(tmpdir(), "sorage-vault-open-guidance-"));
afterAll(() => {
  if (!updateGoldens) rmSync(parent, { recursive: true, force: true });
});

function run(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [entry, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SORAGE_TEST_REQUEST_ID: REQUEST_ID,
      SORAGE_HOME: home,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function normalize(text: string, home: string): string {
  const variants = new Set([home, realpathSync(home)]);
  let normalized = text;
  for (const variant of variants) normalized = normalized.split(variant).join("<home>");
  return normalized.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
}

interface StateFixture {
  name: string;
  setup: (vault: string) => void;
}

const fixtures: StateFixture[] = [
  {
    name: "V1",
    setup: (vault) => rmSync(vault, { recursive: true, force: true }),
  },
  {
    name: "V2",
    setup: (vault) => {
      rmSync(vault, { recursive: true, force: true });
      symlinkSync(vault, vault);
    },
  },
  {
    name: "V3",
    setup: (vault) => {
      rmSync(vault, { recursive: true, force: true });
      writeFileSync(vault, "not a vault\n");
    },
  },
  {
    name: "V4",
    setup: (vault) => {
      rmSync(join(vault, ".sorage-vault.json"), { force: true });
      mkdirSync(join(vault, ".sorage-vault.json"));
    },
  },
  {
    name: "V5",
    setup: (vault) => rmSync(join(vault, ".sorage-vault.json"), { force: true }),
  },
  {
    name: "V6",
    setup: (vault) => {
      for (const entryName of readdirSync(vault)) rmSync(join(vault, entryName), { recursive: true, force: true });
    },
  },
  {
    name: "V7",
    setup: (vault) => writeFileSync(join(vault, ".sorage-vault.json"), "not json"),
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
  },
  {
    name: "V9",
    setup: (vault) =>
      writeFileSync(
        join(vault, ".sorage-vault.json"),
        `${JSON.stringify({
          type: "sorage-vault",
          schemaVersion: 2,
          installationId: "11111111-1111-4111-8111-111111111111",
          createdAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      ),
  },
];

interface DoctorCheck {
  id: string;
  severity: string;
  message: string;
  recovery?: { suggestedCommand: string };
}

interface GoldenEntry {
  state: string;
  exit: number;
  json: unknown;
  human: string;
  doctor: DoctorCheck[];
}

function captureState(fixture: StateFixture): GoldenEntry {
  const home = join(parent, fixture.name.toLowerCase());
  mkdirSync(home, { recursive: true });
  const initialized = run(["init", "--non-interactive"], home);
  if (initialized.status !== 0) throw new Error(`fixture init failed for ${fixture.name}`);
  const vault = join(home, "vault");
  fixture.setup(vault);

  const jsonRun = run(["vault", "verify", "--json"], home);
  if (jsonRun.stdout !== "") throw new Error(`${fixture.name} wrote a JSON refusal to stdout`);
  const json = JSON.parse(normalize(jsonRun.stderr, home)) as unknown;
  const humanRun = run(["vault", "verify"], home);
  const human = normalize(humanRun.stderr, home);

  const doctorRun = run(["doctor", "--json"], home);
  const report = JSON.parse(normalize(doctorRun.stdout, home)) as { data: { checks: DoctorCheck[] } };
  // The changed recoveries of the doctor surface, including the configuration
  // branches that must stay out of the Vault-open path.
  const doctor = report.data.checks.filter((check) =>
    ["config.schema", "vault.marker", "vault.gitattributes", "vault.writable", "platform.tcc"].includes(check.id),
  );

  return {
    state: fixture.name,
    exit: jsonRun.status ?? 0,
    json,
    human,
    doctor,
  };
}

describe("the Vault-open guidance contract", () => {
  it("pins every state's refusal and doctor rendering", () => {
    const entries = fixtures.map(captureState);
    for (const entryValue of entries) {
      const envelope = entryValue.json as {
        error: {
          code: string;
          message: string;
          details: Record<string, unknown>;
          recovery?: { suggestedCommand: string };
        };
      };
      const recovery = envelope.error.recovery?.suggestedCommand ?? "";
      expect(recovery, entryValue.state).not.toContain("sorage vault verify");
      expect((entryValue.human.match(/^Recovery: /gm) ?? []).length, entryValue.state).toBe(1);
      const initMentions = (entryValue.json as { error: { recovery?: { suggestedCommand: string } } }).error.recovery
        ?.suggestedCommand;
      if (entryValue.state === "V6") {
        expect(initMentions).toContain("sorage init --reconfigure --non-interactive");
      } else {
        expect(recovery, entryValue.state).not.toContain("sorage init");
      }
    }
    const v9 = entries.find((value) => value.state === "V9");
    expect(v9?.exit).toBe(78);
    expect((v9?.json as { error: { code: string } }).error.code).toBe("VAULT_SCHEMA_UNSUPPORTED");
    expect((v9?.json as { error: { recovery?: { suggestedCommand: string } } }).error.recovery?.suggestedCommand).toBe(
      "Upgrade Sorage; Sorage never downgrades a Vault",
    );

    const serialized = `${JSON.stringify(entries, null, 2)}\n`;
    const goldenPath = `${goldenDir}vault-open-guidance.json`;
    if (updateGoldens) {
      mkdirSync(goldenDir, { recursive: true });
      writeFileSync(goldenPath, serialized);
      return;
    }
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  }, 180_000);
});
