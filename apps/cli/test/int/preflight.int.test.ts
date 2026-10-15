import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appError } from "@sorage/core";
import { runCli } from "../../src/main";
import { runPreflightCommand } from "../../src/preflight-command";

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function ownedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sorage-preflight-cli-"));
  homes.push(home);
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

function inventory(root: string): string[] {
  if (!existsSync(root)) return ["absent"];
  const rootStat = lstatSync(root);
  const rows = [`@ ${rootStat.mode} ${rootStat.mtimeMs} ${rootStat.dev}:${rootStat.ino}`];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (stat.isSymbolicLink()) rows.push(`l ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino}`);
      else if (stat.isDirectory()) {
        rows.push(`d ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino}`);
        walk(path);
      } else {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
        rows.push(`f ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino} ${hash}`);
      }
    }
  };
  walk(root);
  return rows.sort();
}

describe("preflight command", () => {
  it("reports an absent home without creating it", () => {
    const home = join(ownedHome(), "missing");
    process.env.SORAGE_HOME = home;
    const human = capture();
    expect(runCli(["preflight"], human.ports)).toBe(0);
    expect(human.errText()).toBe("");
    expect(human.outText()).toContain("Preflight status: fresh");
    expect(human.outText()).toContain("Recovery: This status does not authorize initialization.");
    for (const id of [
      "home.state",
      "source.snapshot",
      "config.schema",
      "db.schema",
      "db.integrity",
      "vault.marker",
      "installation.identity",
      "upgrade.preparation",
    ]) {
      expect(human.outText()).toContain(id);
    }
    expect(existsSync(home)).toBe(false);

    const json = capture();
    expect(runCli(["preflight", "--json"], json.ports)).toBe(0);
    expect(json.errText()).toBe("");
    const body = JSON.parse(json.outText()) as { ok: boolean; data: { status: string; checks: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("fresh");
    expect(body.data.checks).toHaveLength(8);
  });

  it("rejects inherited --confirm as usage and leaves an absent home absent", () => {
    const home = join(ownedHome(), "missing");
    process.env.SORAGE_HOME = home;
    for (const args of [
      ["preflight", "--confirm"],
      ["--confirm", "preflight"],
    ]) {
      const run = capture();
      expect(runCli(args, run.ports)).toBe(2);
      expect(run.outText()).toBe("");
      expect(run.errText()).toContain("preflight accepts no confirmation flag");
      expect(run.errText()).toContain("Run 'sorage --help' for usage.");
      expect(run.errText()).not.toContain("{");
      expect(existsSync(home)).toBe(false);
    }
    const unknown = capture();
    expect(runCli(["preflight", "--repair"], unknown.ports)).toBe(2);
    expect(unknown.outText()).toBe("");
    expect(existsSync(home)).toBe(false);
  });

  it("resolves a relative SORAGE_HOME from the working directory", () => {
    const parent = ownedHome();
    const run = spawnSync("bun", [entry, "preflight", "--json"], {
      cwd: parent,
      encoding: "utf8",
      env: { ...process.env, SORAGE_HOME: "relative-home" },
    });
    expect(run.status).toBe(0);
    const body = JSON.parse(run.stdout) as { ok: boolean; data: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("fresh");
    expect(existsSync(join(parent, "relative-home"))).toBe(false);
  });

  it("emits a no-log invocation error when inspection throws", () => {
    const home = join(ownedHome(), "missing");
    process.env.SORAGE_HOME = home;
    const thrown = capture();
    const exitCode = runPreflightCommand({
      ports: thrown.ports,
      json: true,
      confirm: false,
      requestId: "req-preflight-throw",
      inspect() {
        throw new Error("boom");
      },
    });
    expect(exitCode).toBe(1);
    expect(thrown.outText()).toBe("");
    const envelope = JSON.parse(thrown.errText()) as {
      ok: boolean;
      error: { code: string; message: string; recovery?: { suggestedCommand: string } };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
    expect(envelope.error.message).toContain("req-preflight-throw");
    expect(envelope.error.message).not.toMatch(/sorage\.log|\/logs/);
    expect(envelope.error.recovery?.suggestedCommand).toContain("req-preflight-throw");
    expect(envelope.error.recovery?.suggestedCommand).toContain("sorage preflight");
    expect(envelope.error.recovery?.suggestedCommand).not.toMatch(/sorage\.log|\/logs/);
    expect(existsSync(home)).toBe(false);

    for (const leaked of [
      "Inspect ~/.sorage/logs for details.",
      "Inspect meta.requestId in ~/.sorage/logs/sorage.log",
    ]) {
      const leakedRun = capture();
      expect(
        runPreflightCommand({
          ports: leakedRun.ports,
          json: true,
          confirm: false,
          requestId: "req-preflight-leaked",
          inspect() {
            throw appError("INTERNAL_ERROR", leaked);
          },
        }),
      ).toBe(1);
      const leakedBody = JSON.parse(leakedRun.errText()) as {
        error: { code: string; message: string; recovery?: { suggestedCommand: string } };
      };
      expect(leakedBody.error.code).toBe("INTERNAL_ERROR");
      expect(leakedBody.error.message).toContain("req-preflight-leaked");
      expect(leakedBody.error.message).not.toContain(leaked);
      expect(leakedBody.error.message).not.toMatch(/sorage\.log|\/logs/);
      expect(leakedBody.error.recovery?.suggestedCommand).toContain("req-preflight-leaked");
      expect(leakedBody.error.recovery?.suggestedCommand).not.toMatch(/sorage\.log|\/logs/);
      const human = capture();
      expect(
        runPreflightCommand({
          ports: human.ports,
          json: false,
          confirm: false,
          requestId: "req-preflight-leaked",
          inspect() {
            throw appError("INTERNAL_ERROR", leaked);
          },
        }),
      ).toBe(1);
      expect(human.errText()).toContain("INTERNAL_ERROR:");
      expect(human.errText()).toContain("Recovery:");
      expect(human.errText()).toContain("req-preflight-leaked");
      expect(human.errText()).not.toContain(leaked);
      expect(human.errText()).not.toMatch(/sorage\.log|\/logs/);
    }
    expect(existsSync(home)).toBe(false);

    const typed = capture();
    expect(
      runPreflightCommand({
        ports: typed.ports,
        json: false,
        confirm: false,
        requestId: "req-preflight-typed",
        inspect() {
          throw appError("CONFIG_INVALID", "The selected configuration could not be read.");
        },
      }),
    ).toBe(78);
    expect(typed.errText()).toContain("CONFIG_INVALID:");
    expect(typed.errText()).toContain("Recovery:");
    expect(typed.errText()).toContain("req-preflight-typed");
    expect(typed.errText()).toContain("sorage preflight");
    expect(typed.errText()).not.toMatch(/sorage\.log|\/logs/);
  });

  it("leaves an initialized home unchanged", () => {
    const home = ownedHome();
    process.env.SORAGE_HOME = home;
    const init = capture();
    expect(runCli(["init", "--non-interactive"], init.ports)).toBe(0);
    const before = inventory(home);
    const report = capture();
    const status = runCli(["preflight", "--json"], report.ports);
    const body = JSON.parse(report.outText()) as { ok: boolean; data: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("compatible");
    expect(status).toBe(0);
    expect(inventory(home)).toEqual(before);
  });

  it("includes preflight in the generated completion scripts", () => {
    const golden = readFileSync(new URL("../contract/golden/preflight-completion.txt", import.meta.url), "utf8");
    const [zshLine, bashLine] = golden.trimEnd().split("\n");
    const zsh = capture();
    expect(runCli(["completion", "zsh"], zsh.ports)).toBe(0);
    expect(zsh.outText()).toContain(zshLine);
    expect(zsh.outText()).toContain("--json");
    const bash = capture();
    expect(runCli(["completion", "bash"], bash.ports)).toBe(0);
    expect(bash.outText()).toContain(bashLine);
  });
});
