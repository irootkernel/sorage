import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";
import { errorSpec, knownSchemaMaximum } from "@sorage/core";

/**
 * The SHR-009 forward-refusal boundary at the CLI surface: a database whose
 * applied maximum migration exceeds this build's known maximum fails closed
 * with `STORAGE_SCHEMA_UNSUPPORTED` before operational work, while the offline
 * `version` and `help` commands never open the database at all.
 */
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

function initialize(home: string): number {
  const vault = join(home, "vault");
  const init = capture();
  const code = runCli(["init", "--vault", vault, "--non-interactive"], init.ports);
  expect(code).toBe(0);
  return code;
}

function poisonWithFutureVersion(home: string): void {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', ?)").run(
      knownSchemaMaximum() + 1,
      "2026-01-01T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

describe("STORAGE_SCHEMA_UNSUPPORTED at the CLI boundary", () => {
  it("refuses operational database work with exit 78 while offline version and help still run", () => {
    const home = tempHome("sorage-schema-refusal-");
    initialize(home);
    poisonWithFutureVersion(home);

    const refused = capture();
    const code = runCli(["memo", "list", "--json"], refused.ports);
    expect(code).toBe(78);
    const envelope = JSON.parse(refused.errText()) as { ok: boolean; error?: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");

    const vaultStatus = capture();
    const vaultCode = runCli(["vault", "status", "--json"], vaultStatus.ports);
    expect(vaultCode).toBe(78);
    const vaultEnvelope = JSON.parse(vaultStatus.errText()) as { ok: boolean; error?: { code: string } };
    expect(vaultEnvelope.error?.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");

    const database = readFileSync(join(home, "state/sorage.sqlite3"));
    const config = readFileSync(join(home, "config.yaml"));
    const marker = readFileSync(join(home, "vault/.sorage-vault.json"));
    const token = join(home, "state/api-token");
    rmSync(token);
    const noOp = capture();
    expect(runCli(["init", "--non-interactive", "--json"], noOp.ports)).toBe(0);
    expect(existsSync(token)).toBe(false);
    for (const args of [
      ["doctor", "--json"],
      ["inbox", "--json"],
      ["project", "list", "--json"],
      ["daemon", "start", "--json"],
      ["init", "--reconfigure", "--vault", join(home, "vault"), "--non-interactive", "--json"],
    ]) {
      const sink = capture();
      expect(runCli(args, sink.ports), args.join(" ")).toBe(78);
      expect(JSON.parse(sink.errText()).error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
      expect(readFileSync(join(home, "state/sorage.sqlite3"))).toEqual(database);
      expect(readFileSync(join(home, "config.yaml"))).toEqual(config);
      expect(readFileSync(join(home, "vault/.sorage-vault.json"))).toEqual(marker);
      expect(existsSync(join(home, "run/daemon.json"))).toBe(false);
      expect(existsSync(join(home, "run/daemon.lock"))).toBe(false);
      expect(existsSync(token)).toBe(false);
    }

    const retainedToken = "a".repeat(64);
    writeFileSync(token, retainedToken, { mode: 0o600 });
    const retained = capture();
    expect(runCli(["init", "--reconfigure", "--non-interactive", "--json"], retained.ports)).toBe(78);
    expect(readFileSync(token, "utf8")).toBe(retainedToken);
    const version = capture();
    expect(runCli(["version"], version.ports)).toBe(0);
    expect(version.outText()).toContain("sorage");

    const help = capture();
    expect(runCli(["help"], help.ports)).toBe(0);
    expect(help.outText()).toContain("Usage");
  });

  it("refuses a future database in a partial installation before creating a token or configuration", () => {
    const home = tempHome("sorage-schema-partial-");
    initialize(home);
    poisonWithFutureVersion(home);
    const token = join(home, "state/api-token");
    rmSync(token);
    rmSync(join(home, "config.yaml"));
    const marker = readFileSync(join(home, "vault/.sorage-vault.json"));
    const sink = capture();
    expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports)).toBe(78);
    expect(JSON.parse(sink.errText()).error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
    expect(existsSync(token)).toBe(false);
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
    expect(readFileSync(join(home, "vault/.sorage-vault.json"))).toEqual(marker);
  });

  it("preserves typed integrity refusal for malformed history on read and daemon startup", () => {
    const home = tempHome("sorage-schema-integrity-");
    initialize(home);
    const db = new DatabaseSync(join(home, "state/sorage.sqlite3"));
    db.exec("UPDATE schema_migrations SET name = 'invalid' WHERE version = 1");
    db.close();
    const before = readFileSync(join(home, "state/sorage.sqlite3"));
    for (const args of [
      ["inbox", "--json"],
      ["project", "list", "--json"],
      ["daemon", "start", "--json"],
    ]) {
      const sink = capture();
      expect(runCli(args, sink.ports)).toBe(errorSpec("STORAGE_INTEGRITY_ERROR").exitCode);
      expect(JSON.parse(sink.errText()).error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(readFileSync(join(home, "state/sorage.sqlite3"))).toEqual(before);
      expect(existsSync(join(home, "run/daemon.lock"))).toBe(false);
    }
    const diagnostics = capture();
    expect(runCli(["doctor", "--json"], diagnostics.ports)).toBe(1);
    const report = JSON.parse(diagnostics.outText()) as {
      data: { checks: Array<{ id: string; severity: string; message: string }> };
    };
    expect(report.data.checks.find((check) => check.id === "db.migrations")).toMatchObject({
      severity: "blocking",
      message: expect.stringContaining("invalid"),
    });
  });
});
