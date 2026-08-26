import { mkdirSync, readFileSync, rmSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-026 surface: the three vault commands through the real CLI wiring,
 * with the drain-at-start obligation, the --as-user gate of CLI-019, the
 * SERVICE_PAUSED fast-fail of RUN-014, and the relocation journey AJ-09 as far
 * as the Handoff surface of EPIC-005 exists.
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

interface StatusEnvelope {
  data: {
    path: string;
    marker: { schemaVersion: number; installationId: string };
    counts: { artifacts: number; stagedFiles: number; pendingIntents: number };
    sizes: { artifactsBytes: number; stagingBytes: number };
  };
}

function seedArtifact(vault: string, relative: string, content: string): void {
  const path = join(vault, "artifacts", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("sorage vault status", () => {
  it("reports path, marker, counts, and sizes after draining at start", () => {
    const home = tempHome("sorage-vault-status-");
    const vault = join(home, "vault");
    expect(runCli(["init", "--vault", vault, "--non-interactive"], capture().ports)).toBe(0);
    seedArtifact(vault, "h-1/a-1/doc.md", "document");
    seedArtifact(vault, "h-2/a-1/doc.md", "other document");

    const status = capture();
    expect(runCli(["vault", "status", "--json"], status.ports)).toBe(0);
    const report = JSON.parse(status.outText()) as StatusEnvelope;
    expect(report.data.path).toBe(vault);
    expect(report.data.marker.schemaVersion).toBe(1);
    expect(report.data.counts.artifacts).toBe(2);
    expect(report.data.sizes.artifactsBytes).toBe("document".length + "other document".length);
    expect(report.data.counts.pendingIntents).toBe(0);
  });

  it("fails fast with SERVICE_PAUSED at exit 75 while vault-move.lock is live (RUN-014)", () => {
    const home = tempHome("sorage-vault-paused-");
    const vault = join(home, "vault");
    expect(runCli(["init", "--vault", vault, "--non-interactive"], capture().ports)).toBe(0);
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(
      join(home, "run", "vault-move.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "here" })}\n`,
    );
    const paused = capture();
    expect(runCli(["vault", "status", "--json"], paused.ports)).toBe(75);
    expect(paused.errText()).toContain("SERVICE_PAUSED");
    expect(paused.errText()).toContain("Wait for that operation to finish");
  });
});

describe("sorage vault verify", () => {
  it("exits 0 on a consistent Vault and names every finding otherwise", () => {
    const home = tempHome("sorage-vault-verify-");
    const vault = join(home, "vault");
    expect(runCli(["init", "--vault", vault, "--non-interactive"], capture().ports)).toBe(0);
    seedArtifact(vault, "h-1/a-1/doc.md", "document");

    const clean = capture();
    expect(runCli(["vault", "verify", "--json"], clean.ports)).toBe(0);
    expect(clean.errText()).toBe("");

    // A staged file left past the grace window is a finding.
    const leftover = join(vault, "staging", "leftover");
    writeFileSync(leftover, "sweep me");
    utimesSync(leftover, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    const finding = capture();
    expect(runCli(["vault", "verify", "--json"], finding.ports)).toBe(1);
    expect(finding.outText()).toContain("leftover");
  });
});

describe("sorage vault move", () => {
  it("requires --as-user with USER_CONTEXT_REQUIRED at exit 77 (CLI-019)", () => {
    const home = tempHome("sorage-vault-asuser-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const refused = capture();
    expect(runCli(["vault", "move", "--to", join(home, "moved-vault")], refused.ports)).toBe(77);
    expect(refused.errText()).toContain("USER_CONTEXT_REQUIRED");
  });

  it("relocates the Vault, updates vault.path, emits VAULT_MOVED, and keeps the original (AJ-09)", () => {
    const home = tempHome("sorage-vault-move-");
    const vault = join(home, "vault");
    const target = join(home, "moved-vault");
    expect(runCli(["init", "--vault", vault, "--non-interactive"], capture().ports)).toBe(0);
    seedArtifact(vault, "h-1/a-1/doc.md", "document one");
    seedArtifact(vault, "h-2/a-1/doc.md", "document two");

    const moved = capture();
    expect(runCli(["vault", "move", "--to", target, "--as-user", "--json"], moved.ports)).toBe(0);
    const payload = JSON.parse(moved.outText()) as {
      data: { event: string; fromPath: string; toPath: string; artifactsMoved: number };
    };
    expect(payload.data.event).toBe("VAULT_MOVED");
    expect(payload.data.fromPath).toBe(vault);
    expect(payload.data.toPath).toBe(target);
    expect(payload.data.artifactsMoved).toBe(2);

    // The configuration points at the new Vault and every byte survived.
    const show = capture();
    expect(runCli(["config", "show", "--json"], show.ports)).toBe(0);
    expect(show.outText()).toContain(JSON.stringify(target).slice(1, -1));
    expect(readFileSync(join(target, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("document one");
    expect(readFileSync(join(target, "artifacts/h-2/a-1/doc.md"), "utf8")).toBe("document two");
    expect(readFileSync(join(target, ".sorage-vault.json"), "utf8")).toContain("sorage-vault");
    // The original Vault is retained and still complete.
    expect(readFileSync(join(vault, "artifacts/h-1/a-1/doc.md"), "utf8")).toBe("document one");

    const status = capture();
    expect(runCli(["vault", "status", "--json"], status.ports)).toBe(0);
    const report = JSON.parse(status.outText()) as StatusEnvelope;
    expect(report.data.path).toBe(target);
    expect(report.data.counts.artifacts).toBe(2);

    const verify = capture();
    expect(runCli(["vault", "verify", "--json"], verify.ports)).toBe(0);
  });
});
