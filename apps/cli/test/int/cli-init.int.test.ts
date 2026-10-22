import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

const homes: string[] = [];
const cliEntry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
/** A FIFO needs `mkfifo`; the platform-skipped cases state that reason. */
const mkfifoAvailable = spawnSync("mkfifo", [], { encoding: "utf8" }).error === undefined;

function makeFifo(path: string): boolean {
  return spawnSync("mkfifo", [path], { encoding: "utf8" }).status === 0;
}

/** Runs the CLI entry in a child process with a parent-enforced timeout (K21). */
function runChild(
  args: string[],
  home: string,
): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const result = spawnSync("bun", [cliEntry, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, SORAGE_HOME: home },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
  };
}

const UUID_IN_OUTPUT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("sorage init", () => {
  it("creates the full installation non-interactively and exits 0", () => {
    const home = tempHome("sorage-cli-init-");
    const vault = join(home, "vault");
    const io = capture();
    const code = runCli(["init", "--vault", vault, "--non-interactive"], io.ports);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain(`Initialized Sorage at ${home}`);
    expect(io.out.join("")).toMatch(UUID_IN_OUTPUT);
    expect(existsSync(join(home, "config.yaml"))).toBe(true);
    expect(existsSync(join(vault, ".sorage-vault.json"))).toBe(true);
    expect(existsSync(join(vault, ".gitattributes"))).toBe(true);
    expect(existsSync(join(vault, ".gitignore"))).toBe(true);
    expect(existsSync(join(vault, "artifacts"))).toBe(true);
    expect(existsSync(join(vault, "staging"))).toBe(true);
    expect(existsSync(join(home, "state", "sorage.sqlite3"))).toBe(true);
  });

  it("reports an existing installation on a second run and changes nothing", () => {
    const home = tempHome("sorage-cli-init-second-");
    const first = capture();
    expect(runCli(["init", "--non-interactive"], first.ports)).toBe(0);
    const configBefore = readFileSync(join(home, "config.yaml"), "utf8");
    const markerBefore = readFileSync(join(home, "vault", ".sorage-vault.json"), "utf8");
    const second = capture();
    const code = runCli(["init", "--non-interactive"], second.ports);
    expect(code).toBe(0);
    expect(second.out.join("")).toContain("already initialized");
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(home, "vault", ".sorage-vault.json"), "utf8")).toBe(markerBefore);
  });

  it("exits 78 with CONFIG_INVALID and suggests sorage doctor against a malformed configuration", () => {
    const home = tempHome("sorage-cli-init-malformed-");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "vault: [unclosed");
    const before = readFileSync(join(home, "config.yaml"), "utf8");
    const io = capture();
    const code = runCli(["init", "--non-interactive"], io.ports);
    expect(code).toBe(78);
    const stderr = io.err.join("");
    expect(stderr).toContain("CONFIG_INVALID");
    expect(stderr).toContain("sorage doctor");
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(before);
  });

  it("exits 2 with the --non-interactive hint when stdin offers no wizard answer", () => {
    tempHome("sorage-cli-init-interactive-");
    const io = capture();
    const code = runCli(["init"], io.ports, { ask: () => null });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--non-interactive");
  });

  it("resolves a relative --vault against the working directory once", async () => {
    const home = tempHome("sorage-cli-init-relative-");
    const parent = mkdtempSync(join(tmpdir(), "sorage-cli-init-cwd-"));
    const previousCwd = process.cwd();
    process.chdir(parent);
    try {
      const io = capture();
      const code = runCli(["init", "--vault", "relative-vault", "--non-interactive"], io.ports);
      expect(code).toBe(0);
      const config = readFileSync(join(home, "config.yaml"), "utf8");
      // resolve() follows the macOS /tmp symlink, so compare against the resolved form.
      expect(config).toContain(resolve(join(parent, "relative-vault")));
      expect(existsSync(join(parent, "relative-vault", ".sorage-vault.json"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("emits the versioned success envelope under --json", () => {
    const home = tempHome("sorage-cli-init-json-");
    const io = capture();
    const code = runCli(["init", "--non-interactive", "--json"], io.ports);
    expect(code).toBe(0);
    const envelope = JSON.parse(io.out.join("")) as Record<string, unknown>;
    expect(envelope.meta).toBeDefined();
    const data = envelope.data as Record<string, unknown>;
    expect(data.outcome).toBe("created");
    expect(String(data.vaultPath)).toBe(join(home, "vault"));
  });
});

describe("the plain init hint (TASK-118)", () => {
  const REPAIR_HINT = "Nothing was changed; run 'sorage init --reconfigure --non-interactive' for explicit repair.";
  const WARNING =
    "Nothing was changed; the configured Vault cannot be opened, so reconfiguration is not suggested. Resolve the Vault-open refusal first.";

  it("keeps the repair hint while the configured Vault opens", () => {
    tempHome("sorage-cli-init-hint-ok-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const io = capture();
    expect(runCli(["init", "--non-interactive"], io.ports)).toBe(0);
    expect(io.out.join("")).toContain("already initialized");
    expect(io.out.join("")).toContain(REPAIR_HINT);
  });

  it("warns instead of suggesting reconfiguration when the Vault directory is missing", () => {
    const home = tempHome("sorage-cli-init-hint-missing-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    const io = capture();
    expect(runCli(["init", "--non-interactive"], io.ports)).toBe(0);
    const output = io.out.join("");
    expect(output).toContain("already initialized");
    expect(output).toContain(WARNING);
    expect(output).not.toContain("sorage init --reconfigure");
    expect(existsSync(join(home, "vault"))).toBe(false);
  });

  it("keeps the JSON outcome unchanged and prints no human hint", () => {
    const home = tempHome("sorage-cli-init-hint-json-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    rmSync(join(home, "vault"), { recursive: true, force: true });
    const io = capture();
    expect(runCli(["init", "--non-interactive", "--json"], io.ports)).toBe(0);
    const envelope = JSON.parse(io.out.join("")) as Record<string, unknown>;
    expect((envelope.data as Record<string, unknown>).outcome).toBe("already-initialized");
    expect(io.out.join("")).not.toContain("Nothing was changed");
  });

  it.skipIf(process.getuid?.() === 0)("warns for a mode-000 Vault directory without changing it", () => {
    const home = tempHome("sorage-cli-init-hint-mode000-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const vault = join(home, "vault");
    chmodSync(vault, 0o000);
    try {
      const io = capture();
      expect(runCli(["init", "--non-interactive"], io.ports)).toBe(0);
      const output = io.out.join("");
      expect(output).toContain(WARNING);
      expect(output).not.toContain("sorage init --reconfigure");
    } finally {
      chmodSync(vault, 0o700);
    }
  });

  it("warns after a reconfigure that preserves a foreign marker", () => {
    const home = tempHome("sorage-cli-init-hint-foreign-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const markerPath = join(home, "vault", ".sorage-vault.json");
    const foreign = `${JSON.stringify({
      type: "sorage-vault",
      schemaVersion: 1,
      installationId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    writeFileSync(markerPath, foreign);
    const io = capture();
    expect(runCli(["init", "--non-interactive", "--reconfigure"], io.ports)).toBe(0);
    const output = io.out.join("");
    // A successful reconfigure does not imply the Vault opens: the initializer
    // preserves the foreign marker and the hint branches on the actual probe.
    expect(output).toContain(WARNING);
    expect(output).not.toContain(REPAIR_HINT);
    expect(readFileSync(markerPath, "utf8")).toBe(foreign);
  });
});

describe("the configuration-access refusal before initialization (TASK-118 K1)", () => {
  const ACCESS_REPAIR =
    "Restore the home directory with mode 0700 and config.yaml with owner-only 0600 permissions; do not reinitialize an existing installation";
  const PATH_REPAIR =
    "Replace the non-regular entry, dangling symlink, or symlink loop at the configuration path with a regular config.yaml file owned by this user, or a symlink to one";

  function installationIdOf(): string {
    const show = capture();
    expect(runCli(["config", "show", "--json"], show.ports)).toBe(0);
    return (JSON.parse(show.out.join("")) as { data: { installationId: string } }).data.installationId;
  }

  it.skipIf(process.getuid?.() === 0)(
    "refuses an unreadable configuration with the access repair and writes nothing (root reads a mode-000 file, so this case is skipped as root)",
    () => {
      const home = tempHome("sorage-t118-init-unreadable-");
      expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
      const configPath = join(home, "config.yaml");
      const markerPath = join(home, "vault", ".sorage-vault.json");
      const configBefore = readFileSync(configPath, "utf8");
      const markerBefore = readFileSync(markerPath, "utf8");
      const installationBefore = installationIdOf();
      chmodSync(configPath, 0o000);
      try {
        const io = capture();
        expect(runCli(["init", "--non-interactive", "--json"], io.ports)).toBe(78);
        expect(io.out.join("")).toBe("");
        const envelope = JSON.parse(io.err.join("")) as {
          error: { code: string; message: string; recovery?: { suggestedCommand: string } };
        };
        expect(envelope.error.code).toBe("CONFIG_INVALID");
        expect(envelope.error.message).toBe(`The configuration at ${configPath} cannot be read.`);
        expect(envelope.error.recovery?.suggestedCommand).toBe(ACCESS_REPAIR);
      } finally {
        chmodSync(configPath, 0o600);
      }
      // Nothing was treated as a new installation.
      expect(readFileSync(configPath, "utf8")).toBe(configBefore);
      expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
      expect(installationIdOf()).toBe(installationBefore);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "refuses a configuration whose home cannot be traversed and preserves the installation (root traverses a mode-000 directory, so this case is skipped as root)",
    () => {
      const home = tempHome("sorage-t118-init-parent-");
      expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
      const configPath = join(home, "config.yaml");
      const markerPath = join(home, "vault", ".sorage-vault.json");
      const configBefore = readFileSync(configPath, "utf8");
      const markerBefore = readFileSync(markerPath, "utf8");
      const installationBefore = installationIdOf();
      chmodSync(home, 0o000);
      try {
        const io = capture();
        expect(runCli(["init", "--non-interactive"], io.ports)).toBe(78);
        expect(io.err.join("")).toContain("CONFIG_INVALID");
        expect(io.err.join("")).toContain(`Recovery: ${ACCESS_REPAIR}`);
      } finally {
        chmodSync(home, 0o700);
      }
      expect(readFileSync(configPath, "utf8")).toBe(configBefore);
      expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
      expect(installationIdOf()).toBe(installationBefore);
    },
  );

  it("refuses a directory at the configuration path with a path repair", () => {
    const home = tempHome("sorage-t118-init-path-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const configPath = join(home, "config.yaml");
    const valid = readFileSync(configPath, "utf8");
    rmSync(configPath, { force: true });
    mkdirSync(configPath);
    const io = capture();
    expect(runCli(["init", "--non-interactive", "--json"], io.ports)).toBe(78);
    const envelope = JSON.parse(io.err.join("")) as {
      error: { code: string; message: string; recovery?: { suggestedCommand: string } };
    };
    expect(envelope.error.code).toBe("CONFIG_INVALID");
    expect(envelope.error.message).toBe(`The configuration path ${configPath} is not a regular file.`);
    expect(envelope.error.recovery?.suggestedCommand).toBe(PATH_REPAIR);
    expect(envelope.error.recovery?.suggestedCommand).not.toContain("0600");

    // K3: following the path repair restores a plain repeat.
    rmSync(configPath, { recursive: true, force: true });
    writeFileSync(configPath, valid);
    chmodSync(configPath, 0o600);
    const repeat = capture();
    expect(runCli(["init", "--non-interactive"], repeat.ports)).toBe(0);
    expect(repeat.out.join("")).toContain("already initialized");
  });

  it("accepts a live symlink to a valid configuration and reports the existing installation (K15)", () => {
    const home = tempHome("sorage-t118-init-live-symlink-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const configPath = join(home, "config.yaml");
    const valid = readFileSync(configPath, "utf8");
    const installationBefore = installationIdOf();
    const target = join(home, "config-target.yaml");
    writeFileSync(target, valid);
    chmodSync(target, 0o600);
    rmSync(configPath, { force: true });
    symlinkSync(target, configPath);
    const io = capture();
    expect(runCli(["init", "--non-interactive", "--json"], io.ports)).toBe(0);
    const envelope = JSON.parse(io.out.join("")) as { data: { outcome: string } };
    expect(envelope.data.outcome).toBe("already-initialized");
    expect(readFileSync(target, "utf8")).toBe(valid);
    expect(installationIdOf()).toBe(installationBefore);
  });

  it.skipIf(!mkfifoAvailable)(
    "refuses a FIFO at the configuration path in a child process without blocking (K18/K21; mkfifo is unavailable on this platform, so this case is skipped)",
    () => {
      const home = tempHome("sorage-t118-init-fifo-");
      expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
      const configPath = join(home, "config.yaml");
      const markerPath = join(home, "vault", ".sorage-vault.json");
      const valid = readFileSync(configPath, "utf8");
      const markerBefore = readFileSync(markerPath, "utf8");
      rmSync(configPath, { force: true });
      expect(makeFifo(configPath)).toBe(true);
      try {
        const child = runChild(["init", "--non-interactive", "--json"], home);
        expect(child.timedOut).toBe(false);
        expect(child.status).toBe(78);
        const envelope = JSON.parse(child.stderr) as {
          error: { code: string; message: string; recovery?: { suggestedCommand: string } };
        };
        expect(envelope.error.code).toBe("CONFIG_INVALID");
        expect(envelope.error.message).toBe(`The configuration path ${configPath} is not a regular file.`);
        expect(envelope.error.recovery?.suggestedCommand).toBe(PATH_REPAIR);
        expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
      } finally {
        rmSync(configPath, { force: true });
      }
      writeFileSync(configPath, valid);
      chmodSync(configPath, 0o600);
      const repeat = runChild(["init", "--non-interactive"], home);
      expect(repeat.timedOut).toBe(false);
      expect(repeat.status).toBe(0);
      expect(repeat.stdout).toContain("already initialized");
    },
    30_000,
  );

  it("refuses a symlink loop at the configuration path with the path repair (K15)", () => {
    const home = tempHome("sorage-t118-init-loop-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const configPath = join(home, "config.yaml");
    const markerPath = join(home, "vault", ".sorage-vault.json");
    const valid = readFileSync(configPath, "utf8");
    const markerBefore = readFileSync(markerPath, "utf8");
    rmSync(configPath, { force: true });
    symlinkSync(configPath, configPath);
    const io = capture();
    expect(runCli(["init", "--non-interactive", "--json"], io.ports)).toBe(78);
    const envelope = JSON.parse(io.err.join("")) as {
      error: { code: string; message: string; recovery?: { suggestedCommand: string } };
    };
    expect(envelope.error.code).toBe("CONFIG_INVALID");
    expect(envelope.error.message).toBe(`The configuration path ${configPath} is not a regular file.`);
    expect(envelope.error.recovery?.suggestedCommand).toBe(PATH_REPAIR);
    expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);

    rmSync(configPath, { force: true });
    writeFileSync(configPath, valid);
    chmodSync(configPath, 0o600);
    const repeat = capture();
    expect(runCli(["init", "--non-interactive"], repeat.ports)).toBe(0);
    expect(repeat.out.join("")).toContain("already initialized");
  });

  it("refuses a dangling symlink at the configuration path with the path repair (K12)", () => {
    const home = tempHome("sorage-t118-init-dangling-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const configPath = join(home, "config.yaml");
    const markerPath = join(home, "vault", ".sorage-vault.json");
    const valid = readFileSync(configPath, "utf8");
    const markerBefore = readFileSync(markerPath, "utf8");
    rmSync(configPath, { force: true });
    symlinkSync(join(home, "missing-config-target"), configPath);
    const io = capture();
    expect(runCli(["init", "--non-interactive", "--json"], io.ports)).toBe(78);
    const envelope = JSON.parse(io.err.join("")) as {
      error: { code: string; message: string; recovery?: { suggestedCommand: string } };
    };
    expect(envelope.error.code).toBe("CONFIG_INVALID");
    expect(envelope.error.message).toBe(`The configuration path ${configPath} is not a regular file.`);
    expect(envelope.error.recovery?.suggestedCommand).toBe(PATH_REPAIR);
    // The dangling symlink is preserved, and no new installation was written.
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);

    rmSync(configPath, { force: true });
    writeFileSync(configPath, valid);
    chmodSync(configPath, 0o600);
    const repeat = capture();
    expect(runCli(["init", "--non-interactive"], repeat.ports)).toBe(0);
    expect(repeat.out.join("")).toContain("already initialized");
  });
});
