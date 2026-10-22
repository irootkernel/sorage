import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Runs the CLI entry in a child process with a parent-enforced timeout (K21):
 * a regression that blocks on the FIFO is killed by the parent instead of
 * hanging this worker, and the case then fails on `timedOut`.
 */
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
  delete process.env.EDITOR;
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
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

/** An annotated configuration with comments that a set must preserve. */
const ANNOTATED = `# installation configuration
schemaVersion: 1
configRevision: 1
installationId: "2f0ac9a0-0000-4000-8000-00000000000b"

# the Vault stays at its default
vault:
  path: "~/.sorage/vault"
  importMode: "copy"

server:
  host: "127.0.0.1"
  port: 46321
  autoStart: false
  openBrowserOnStart: false

handoff:
  allowUnregisteredSenders: true
  requireRegisteredRecipient: true
  inboxMarker: false

artifact:
  maxBytes: 104857600
  externalSourcePolicy: "workspace_or_explicit"
  verifyChecksumOnFetch: false

gitBackup:
  enabled: false
  schedule:
    type: "daily"
    at: "03:00"
    timezone: "UTC"
    catchUpAfterMissedRun: true
  commit:
    messageTemplate: "sorage backup: {timestamp}"
  push:
    enabled: false
    remote: "origin"
    branch: "main"
  largeArtifactWarningBytes: 26214400
  snapshot:
    redactWorkspacePaths: true

ui:
  defaultPageSize: 50
  showArchivedByDefault: false
  timezone: null

logging:
  level: "warn"
  includeFullPaths: false
  rotation:
    maxBytes: 10485760
    maxFiles: 5

gc:
  graceHours: 24
`;

function initializedHome(prefix: string): string {
  const home = tempHome(prefix);
  writeFileSync(join(home, "config.yaml"), ANNOTATED);
  return home;
}

describe("the pre-initialization gate", () => {
  it("returns NOT_INITIALIZED with the expected path and init suggestion for config show --json", () => {
    const home = tempHome("sorage-cli-gate-");
    const io = capture();
    const code = runCli(["config", "show", "--json"], io.ports);
    expect(code).toBe(78);
    const envelope = JSON.parse(io.errText()) as {
      ok: boolean;
      error: {
        code: string;
        message: string;
        details: { expectedConfigPath: string };
        recovery: { suggestedCommand: string };
      };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("NOT_INITIALIZED");
    expect(envelope.error.message).toBe("Sorage has not been initialized.");
    expect(envelope.error.details.expectedConfigPath).toBe(join(home, "config.yaml"));
    expect(envelope.error.recovery.suggestedCommand).toBe("sorage init");
    expect(io.outText()).toBe("");
  });

  it("renders the documented human form on stderr", () => {
    const home = tempHome("sorage-cli-gate-human-");
    const io = capture();
    const code = runCli(["config", "validate"], io.ports);
    expect(code).toBe(78);
    expect(io.errText()).toBe(
      `ERROR [NOT_INITIALIZED]\n\nSorage has not been initialized.\n\nExpected configuration:\n  ${join(home, "config.yaml")}\n\nRun:\n  sorage init\n`,
    );
  });

  it("keeps init, version, and help runnable before initialization", () => {
    tempHome("sorage-cli-gate-exempt-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const version = capture();
    expect(runCli(["version", "--json"], version.ports)).toBe(0);
    expect(version.errText()).toBe("");
    expect(runCli(["--help"], capture().ports)).toBe(0);
  });
});

describe("sorage config", () => {
  it("shows the file view with the literal tilde vault path", () => {
    const _home = initializedHome("sorage-cli-show-");
    const io = capture();
    const code = runCli(["config", "show", "--json"], io.ports);
    expect(code).toBe(0);
    const envelope = JSON.parse(io.outText()) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect((envelope.data.vault as Record<string, unknown>).path).toBe("~/.sorage/vault");
    expect(envelope.data.installationId).toBe("2f0ac9a0-0000-4000-8000-00000000000b");
    const human = capture();
    expect(runCli(["config", "show"], human.ports)).toBe(0);
    expect(human.outText()).toContain("# installation configuration");
  });

  it("validates a good file and reports a broken one with CONFIG_INVALID", () => {
    initializedHome("sorage-cli-validate-");
    const good = capture();
    expect(runCli(["config", "validate"], good.ports)).toBe(0);
    expect(good.outText()).toContain("Configuration is valid");
    const home = tempHome("sorage-cli-validate-bad-");
    writeFileSync(join(home, "config.yaml"), "vault: [unclosed");
    const bad = capture();
    expect(runCli(["config", "validate"], bad.ports)).toBe(78);
    expect(bad.errText()).toContain("CONFIG_INVALID");
  });

  it("sets a leaf with --as-user, exits 0, and preserves comments and the tilde path", () => {
    const home = initializedHome("sorage-cli-set-");
    const io = capture();
    const code = runCli(["config", "set", "server.port", "46322", "--as-user"], io.ports);
    expect(code).toBe(0);
    expect(io.outText()).toContain("Set server.port = 46322");
    const text = readFileSync(join(home, "config.yaml"), "utf8");
    expect(text).toContain("# installation configuration");
    expect(text).toContain("# the Vault stays at its default");
    expect(text).toContain('path: "~/.sorage/vault"');
    expect(text).toContain("port: 46322");
    expect(text).toContain("configRevision: 2");
  });

  it("fails with USER_CONTEXT_REQUIRED and exit 77 without --as-user", () => {
    initializedHome("sorage-cli-set-nouser-");
    const io = capture();
    const code = runCli(["config", "set", "server.port", "46322"], io.ports);
    expect(code).toBe(77);
    expect(io.errText()).toContain("USER_CONTEXT_REQUIRED");
  });

  it("refuses vault.path and names sorage vault move", () => {
    initializedHome("sorage-cli-set-vault-");
    const io = capture();
    const code = runCli(["config", "set", "vault.path", "/elsewhere", "--as-user"], io.ports);
    expect(code).toBe(78);
    expect(io.errText()).toContain("vault.path");
    expect(io.errText()).toContain("sorage vault move");
  });

  it("honors --expected-revision with CONFIG_CONFLICT on a stale counter", () => {
    initializedHome("sorage-cli-set-revision-");
    const io = capture();
    const code = runCli(["config", "set", "server.port", "46323", "--as-user", "--expected-revision", "99"], io.ports);
    expect(code).toBe(75);
    expect(io.errText()).toContain("CONFIG_CONFLICT");
  });

  it("rejects an unknown key, a bad integer, and a non-loopback host value", () => {
    initializedHome("sorage-cli-set-bad-");
    expect(runCli(["config", "set", "not.a.key", "1", "--as-user"], capture().ports)).toBe(78);
    expect(runCli(["config", "set", "server.port", "not-a-number", "--as-user"], capture().ports)).toBe(78);
    expect(runCli(["config", "set", "server.host", "localhost", "--as-user"], capture().ports)).toBe(78);
  });

  it("adopts a valid editor pass and restores the previous file on an invalid one", { timeout: 20_000 }, () => {
    const home = initializedHome("sorage-cli-edit-");
    const editor = join(home, "editor.sh");
    writeFileSync(editor, '#!/bin/sh\nsed -i "" "s/port: 46321/port: 46324/" "$1"\n');
    chmodSync(editor, 0o755);
    process.env.EDITOR = editor;
    const io = capture();
    const code = runCli(["config", "edit", "--as-user"], io.ports);
    expect(code).toBe(0);
    expect(io.outText()).toContain("Configuration updated");
    const text = readFileSync(join(home, "config.yaml"), "utf8");
    expect(text).toContain("port: 46324");
    expect(text).toContain("# installation configuration");
    expect(text).toContain("configRevision: 2");

    const breaker = join(home, "breaker.sh");
    writeFileSync(breaker, '#!/bin/sh\nprintf "vault: [unclosed\\n" > "$1"\n');
    chmodSync(breaker, 0o755);
    process.env.EDITOR = breaker;
    const failed = capture();
    expect(runCli(["config", "edit", "--as-user"], failed.ports)).toBe(78);
    expect(failed.errText()).toContain("CONFIG_INVALID");
    const restored = readFileSync(join(home, "config.yaml"), "utf8");
    expect(restored).toContain("port: 46324");
    expect(restored).toContain("# installation configuration");
    expect(existsSync(join(home, "config.yaml.bak"))).toBe(true);
  });

  it("surfaces a filesystem failure as INTERNAL_ERROR with exit 1, not a usage error", () => {
    const home = initializedHome("sorage-cli-set-ro-");
    chmodSync(join(home), 0o500);
    try {
      const io = capture();
      const code = runCli(["config", "set", "server.port", "46325", "--as-user"], io.ports);
      expect(code).toBe(1);
      expect(io.errText()).toContain("INTERNAL_ERROR");
      expect(io.errText()).not.toContain("Run 'sorage --help'");
      const jsonIo = capture();
      const jsonCode = runCli(["config", "set", "server.port", "46325", "--as-user", "--json"], jsonIo.ports);
      expect(jsonCode).toBe(1);
      const envelope = JSON.parse(jsonIo.errText()) as { error: { code: string } };
      expect(envelope.error.code).toBe("INTERNAL_ERROR");
    } finally {
      chmodSync(join(home), 0o700);
    }
  });

  it("requires --as-user for config edit", () => {
    initializedHome("sorage-cli-edit-nouser-");
    const io = capture();
    expect(runCli(["config", "edit"], io.ports)).toBe(77);
    expect(io.errText()).toContain("USER_CONTEXT_REQUIRED");
  });
});

describe("the operational configuration-access refusal (TASK-118 F3/K9)", () => {
  const ACCESS_REPAIR =
    "Restore the home directory with mode 0700 and config.yaml with owner-only 0600 permissions; do not reinitialize an existing installation";
  const PATH_REPAIR =
    "Replace the non-regular entry, dangling symlink, or symlink loop at the configuration path with a regular config.yaml file owned by this user, or a symlink to one";

  function install(prefix: string): { home: string; configPath: string; markerPath: string } {
    const home = tempHome(prefix);
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    return {
      home,
      configPath: join(home, "config.yaml"),
      markerPath: join(home, "vault", ".sorage-vault.json"),
    };
  }

  function expectRefusals(recovery: string): void {
    for (const args of [
      ["channel", "list"],
      ["send", "--to", "no-such-project", "--title", "T118", "--body", "body"],
      ["inbox"],
      ["project", "list"],
    ]) {
      const io = capture();
      expect(runCli([...args, "--json"], io.ports), args.join(" ")).toBe(78);
      expect(io.outText(), args.join(" ")).toBe("");
      const envelope = JSON.parse(io.errText()) as {
        error: { code: string; message: string; recovery?: { suggestedCommand: string } };
      };
      expect(envelope.error.code, args.join(" ")).toBe("CONFIG_INVALID");
      expect(envelope.error.message, args.join(" ")).toContain("cannot be read");
      expect(envelope.error.recovery?.suggestedCommand, args.join(" ")).toBe(recovery);
    }
  }

  it.skipIf(process.getuid?.() === 0)(
    "carries the access repair on Channel, Handoff and Project commands for an unreadable configuration (root reads a mode-000 file, so this case is skipped as root)",
    () => {
      const fixture = install("sorage-t118-f3-unreadable-");
      const configBefore = readFileSync(fixture.configPath, "utf8");
      const markerBefore = readFileSync(fixture.markerPath, "utf8");
      chmodSync(fixture.configPath, 0o000);
      try {
        expectRefusals(ACCESS_REPAIR);
      } finally {
        chmodSync(fixture.configPath, 0o600);
      }
      expect(readFileSync(fixture.configPath, "utf8")).toBe(configBefore);
      expect(readFileSync(fixture.markerPath, "utf8")).toBe(markerBefore);
    },
  );

  it("carries the path repair on Channel, Handoff and Project commands for a directory at the configuration path", () => {
    const fixture = install("sorage-t118-f3-directory-");
    const valid = readFileSync(fixture.configPath, "utf8");
    const markerBefore = readFileSync(fixture.markerPath, "utf8");
    rmSync(fixture.configPath, { force: true });
    mkdirSync(fixture.configPath);
    expectRefusals(PATH_REPAIR);
    expect(readFileSync(fixture.markerPath, "utf8")).toBe(markerBefore);
    // The path repair restores the installation.
    rmSync(fixture.configPath, { recursive: true, force: true });
    writeFileSync(fixture.configPath, valid);
    chmodSync(fixture.configPath, 0o600);
    expect(runCli(["project", "list", "--json"], capture().ports)).toBe(0);
  });

  it("follows a live symlink to a valid configuration on Channel, Handoff and Project commands (K15)", () => {
    const fixture = install("sorage-t118-f3-live-symlink-");
    const valid = readFileSync(fixture.configPath, "utf8");
    const target = join(fixture.home, "config-target.yaml");
    writeFileSync(target, valid);
    chmodSync(target, 0o600);
    rmSync(fixture.configPath, { force: true });
    symlinkSync(target, fixture.configPath);

    for (const args of [
      ["channel", "list"],
      ["inbox", "--as-user"],
      ["project", "list"],
    ]) {
      const io = capture();
      expect(runCli([...args, "--json"], io.ports), args.join(" ")).toBe(0);
      expect(io.errText(), args.join(" ")).toBe("");
    }
    // A Handoff mutation passes the configuration gate and fails only on its own domain.
    const send = capture();
    expect(
      runCli(["send", "--to", "no-such-project", "--title", "T118", "--body", "body", "--json"], send.ports),
    ).not.toBe(78);
    expect(send.errText()).not.toContain("cannot be read");
  });

  it.skipIf(!mkfifoAvailable)(
    "refuses a FIFO at the configuration path in child processes without blocking (K18/K21; mkfifo is unavailable on this platform, so this case is skipped)",
    () => {
      const fixture = install("sorage-t118-f3-fifo-");
      const valid = readFileSync(fixture.configPath, "utf8");
      const markerBefore = readFileSync(fixture.markerPath, "utf8");
      rmSync(fixture.configPath, { force: true });
      expect(makeFifo(fixture.configPath)).toBe(true);
      try {
        for (const args of [
          ["channel", "list", "--json"],
          ["send", "--to", "no-such-project", "--title", "T118", "--body", "body", "--json"],
          ["inbox", "--json"],
          ["project", "list", "--json"],
        ]) {
          const child = runChild(args, fixture.home);
          expect(child.timedOut, args.join(" ")).toBe(false);
          expect(child.status, args.join(" ")).toBe(78);
          const envelope = JSON.parse(child.stderr) as {
            error: { code: string; recovery?: { suggestedCommand: string } };
          };
          expect(envelope.error.code, args.join(" ")).toBe("CONFIG_INVALID");
          expect(envelope.error.recovery?.suggestedCommand, args.join(" ")).toBe(PATH_REPAIR);
        }
        // Doctor runs in its own child too; it reports the blocking path fault.
        const doctor = runChild(["doctor", "--json"], fixture.home);
        expect(doctor.timedOut).toBe(false);
        expect(doctor.status).toBe(1);
        const report = JSON.parse(doctor.stdout) as {
          data: {
            checks: Array<{ id: string; severity: string; message: string; recovery?: { suggestedCommand: string } }>;
          };
        };
        const schema = report.data.checks.find((check) => check.id === "config.schema");
        expect(schema?.severity).toBe("blocking");
        expect(schema?.message).toBe("The configuration path is not a regular config.yaml file.");
        expect(schema?.recovery?.suggestedCommand).toBe(PATH_REPAIR);
        expect(readFileSync(fixture.markerPath, "utf8")).toBe(markerBefore);
      } finally {
        rmSync(fixture.configPath, { force: true });
      }
      writeFileSync(fixture.configPath, valid);
      chmodSync(fixture.configPath, 0o600);
      const repaired = runChild(["project", "list", "--json"], fixture.home);
      expect(repaired.timedOut).toBe(false);
      expect(repaired.status).toBe(0);
    },
    30_000,
  );

  it("carries the path repair on Channel, Handoff and Project commands for a symlink loop (K15)", () => {
    const fixture = install("sorage-t118-f3-loop-");
    const valid = readFileSync(fixture.configPath, "utf8");
    const markerBefore = readFileSync(fixture.markerPath, "utf8");
    rmSync(fixture.configPath, { force: true });
    symlinkSync(fixture.configPath, fixture.configPath);
    expectRefusals(PATH_REPAIR);
    expect(readFileSync(fixture.markerPath, "utf8")).toBe(markerBefore);
    rmSync(fixture.configPath, { force: true });
    writeFileSync(fixture.configPath, valid);
    chmodSync(fixture.configPath, 0o600);
    expect(runCli(["project", "list", "--json"], capture().ports)).toBe(0);
  });

  it("carries the path repair on Channel, Handoff and Project commands for a dangling symlink (K12)", () => {
    const fixture = install("sorage-t118-f3-dangling-");
    const valid = readFileSync(fixture.configPath, "utf8");
    const markerBefore = readFileSync(fixture.markerPath, "utf8");
    rmSync(fixture.configPath, { force: true });
    symlinkSync(join(fixture.home, "missing-config-target"), fixture.configPath);
    expectRefusals(PATH_REPAIR);
    expect(readFileSync(fixture.markerPath, "utf8")).toBe(markerBefore);
    // Only an lstat ENOENT is absence; the path repair restores the installation.
    rmSync(fixture.configPath, { force: true });
    writeFileSync(fixture.configPath, valid);
    chmodSync(fixture.configPath, 0o600);
    expect(runCli(["project", "list", "--json"], capture().ports)).toBe(0);
  });
});
