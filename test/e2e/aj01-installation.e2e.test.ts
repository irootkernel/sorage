import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, runCleanups, sorage } from "./helpers";

/** AJ-01: a fresh non-interactive installation is complete, idempotent, and healthy. */
afterAll(runCleanups);

describe("AJ-01 fresh installation", () => {
  it("initializes, verifies, and re-initializes without changing anything", () => {
    const run = sorage(["init", "--non-interactive", "--json"]);
    expect(run.status).toBe(0);
    const envelope = envelopeOf(run) as { data: { home: string; installationId: string; vaultPath: string } };
    const installationHome = envelope.data.home;
    expect(envelope.data.installationId).toBeTruthy();

    for (const relative of ["config.yaml", join("state", "sorage.sqlite3")]) {
      expect(existsSync(join(installationHome, relative)), relative).toBe(true);
    }
    const vault = envelope.data.vaultPath;
    for (const relative of [".sorage-vault.json", ".gitattributes", ".gitignore", "artifacts", "staging"]) {
      expect(existsSync(join(vault, relative)), relative).toBe(true);
    }
    const gitattributes = readFileSync(join(vault, ".gitattributes"), "utf8");
    expect(gitattributes).toContain("artifacts/** -text -diff");
    expect(gitattributes).toContain("snapshots/** text eol=lf");
    expect(gitattributes).toContain(".sorage-vault.json text eol=lf");

    const show = sorage(["config", "show", "--json"], { home: installationHome });
    expect(show.status).toBe(0);
    const config = (envelopeOf(show) as { data: Record<string, unknown> }).data;
    expect(config).toHaveProperty("installationId");
    expect((config as { server: { host: string } }).server.host).toBe("127.0.0.1");

    const doctor = sorage(["doctor", "--json"], { home: installationHome });
    expect(doctor.status).toBe(0);
    const report = envelopeOf(doctor) as { data: { checks: Array<{ severity: string; id: string }> } };
    expect(report.data.checks.every((check) => check.severity !== "blocking")).toBe(true);

    const again = sorage(["init", "--non-interactive", "--json"], { home: installationHome });
    expect(again.status).toBe(0);
    const second = envelopeOf(again) as { data: { outcome: string; installationId: string } };
    expect(second.data.outcome).not.toBe("created");
    expect(second.data.installationId).toBe(envelope.data.installationId);
  });
});
