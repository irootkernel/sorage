import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

const homes: string[] = [];
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
    const home = initializedHome("sorage-cli-show-");
    const io = capture();
    const code = runCli(["config", "show", "--json"], io.ports);
    expect(code).toBe(0);
    const envelope = JSON.parse(io.outText()) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect((envelope.data["vault"] as Record<string, unknown>)["path"]).toBe("~/.sorage/vault");
    expect(envelope.data["installationId"]).toBe("2f0ac9a0-0000-4000-8000-00000000000b");
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
