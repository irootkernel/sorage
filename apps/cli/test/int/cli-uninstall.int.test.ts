import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
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

/** Points HOME at a temporary directory so the LaunchAgent ports stay isolated. */
function withTempUserHome<T>(body: () => T): T {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const userHome = mkdtempSync(join(tmpdir(), "sorage-uninstall-user-"));
  const binDir = join(userHome, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeLaunchctl = join(binDir, "launchctl");
  writeFileSync(
    fakeLaunchctl,
    '#!/bin/sh\nif [ "$1" = "bootout" ]; then echo "No such process" >&2; exit 3; fi\nexit 1\n',
    "utf8",
  );
  chmodSync(fakeLaunchctl, 0o755);
  process.env.HOME = userHome;
  process.env.PATH = `${binDir}:${previousPath ?? "/usr/bin:/bin"}`;
  homes.push(userHome);
  try {
    return body();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}

describe("sorage uninstall", () => {
  it("exits 77 with USER_CONTEXT_REQUIRED without --as-user", () => {
    tempHome("sorage-uninstall-asuser-");
    const io = capture();
    const code = withTempUserHome(() => runCli(["uninstall", "--confirm"], io.ports));
    expect(code).toBe(77);
    expect(io.err.join("")).toContain("USER_CONTEXT_REQUIRED");
  });

  it("exits 64 with CONFIRMATION_REQUIRED without --confirm", () => {
    tempHome("sorage-uninstall-confirm-");
    const io = capture();
    const code = withTempUserHome(() => runCli(["uninstall", "--as-user"], io.ports));
    expect(code).toBe(64);
    expect(io.err.join("")).toContain("CONFIRMATION_REQUIRED");
  });

  it("exits 78 against an uninitialized installation", () => {
    tempHome("sorage-uninstall-uninit-");
    const io = capture();
    const code = withTempUserHome(() => runCli(["uninstall", "--as-user", "--confirm"], io.ports));
    expect(code).toBe(78);
    expect(io.err.join("")).toContain("NOT_INITIALIZED");
  });

  it("removes the installation, keeps the Vault, and prints its retained path", () => {
    const home = tempHome("sorage-uninstall-happy-");
    const vault = join(home, "keep-vault");
    const init = capture();
    expect(runCli(["init", "--vault", vault, "--non-interactive"], init.ports)).toBe(0);
    // Populate every directory the command promises to remove.
    mkdirSync(join(home, "run", "nested"), { recursive: true });
    writeFileSync(join(home, "run", "nested", "daemon.json"), "{}");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", "sorage.log"), "{}\n");
    writeFileSync(join(home, "config.yaml.bak"), "# prior\n");

    const io = capture();
    const code = withTempUserHome(() => runCli(["uninstall", "--as-user", "--confirm"], io.ports));
    expect(code).toBe(0);
    const stdout = io.out.join("");
    expect(stdout).toContain(`Vault retained at ${vault}`);
    expect(existsSync(join(home, "state"))).toBe(false);
    expect(existsSync(join(home, "run"))).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
    expect(existsSync(join(home, "config.yaml.bak"))).toBe(false);
    expect(existsSync(join(vault, ".sorage-vault.json"))).toBe(true);
  });

  it("reports the same outcome under --json through the versioned envelope", () => {
    const home = tempHome("sorage-uninstall-json-");
    const vault = join(home, "keep-vault");
    const init = capture();
    expect(runCli(["init", "--vault", vault, "--non-interactive"], init.ports)).toBe(0);
    const io = capture();
    const code = withTempUserHome(() => runCli(["uninstall", "--as-user", "--confirm", "--json"], io.ports));
    expect(code).toBe(0);
    const envelope = JSON.parse(io.out.join("")) as { data: { retainedVaultPath: string } };
    expect(envelope.data.retainedVaultPath).toBe(vault);
  });
});
