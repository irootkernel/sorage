import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("refuses to run without --non-interactive because the wizard arrives in 0.3", () => {
    tempHome("sorage-cli-init-interactive-");
    const io = capture();
    const code = runCli(["init"], io.ports);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--non-interactive");
  });

  it("emits the versioned success envelope under --json", () => {
    const home = tempHome("sorage-cli-init-json-");
    const io = capture();
    const code = runCli(["init", "--non-interactive", "--json"], io.ports);
    expect(code).toBe(0);
    const envelope = JSON.parse(io.out.join("")) as Record<string, unknown>;
    expect(envelope["meta"]).toBeDefined();
    const data = envelope["data"] as Record<string, unknown>;
    expect(data["outcome"]).toBe("created");
    expect(String(data["vaultPath"])).toBe(join(home, "vault"));
  });
});
