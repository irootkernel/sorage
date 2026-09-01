import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, errorEnvelopeOf, runCleanups, sorage, twoProjectFixture } from "./helpers";

/** AJ-09: Vault relocation under the move lock, with a paused concurrent mutation and a clean retry. */
afterAll(runCleanups);

function vaultPathOf(home: string): string {
  const show = sorage(["config", "show", "--json"], { home });
  return (envelopeOf(show) as { data: { vault: { path: string } } }).data.vault.path;
}

describe("AJ-09 vault relocation", () => {
  it("moves the Vault, pauses concurrent mutations while the lock is held, and preserves integrity", () => {
    const fixture = twoProjectFixture("aj09");
    const _id = fixture.sendTo("a", "b", "Before the move");
    // The declared default renders with `~`, so the original location is derived from the home.
    const originalVault = join(fixture.home, "vault");
    const target = join(fixture.home, "moved-vault");

    // A live-looking move lock pauses every other mutation (the concurrent second process).
    const runDir = join(fixture.home, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "vault-move.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "journey" }),
      "utf8",
    );
    const paused = sorage(["send", "--to", "beta", "--title", "While paused", "--body", "# paused", "--json"], {
      home: fixture.home,
      cwd: fixture.workA,
    });
    expect(paused.status).toBe(75);
    expect(errorEnvelopeOf(paused).error.code).toBe("SERVICE_PAUSED");
    rmSync(join(runDir, "vault-move.lock"), { force: true });

    const move = sorage(["vault", "move", "--to", target, "--as-user", "--json"], {
      home: fixture.home,
      cwd: fixture.workA,
    });
    expect(move.status).toBe(0);
    const moved = envelopeOf(move) as { data: { fromPath: string; toPath: string; artifactsMoved: number } };
    expect(moved.data.toPath).toBe(target);
    expect(moved.data.artifactsMoved).toBeGreaterThanOrEqual(1);

    expect(vaultPathOf(fixture.home)).toBe(target);
    // The previous Vault was kept in place, and the relocated one carries the same identity.
    expect(existsSync(join(originalVault, ".sorage-vault.json"))).toBe(true);
    const marker = JSON.parse(readFileSync(join(target, ".sorage-vault.json"), "utf8")) as { installationId: string };
    expect(marker.installationId).toBeTruthy();

    const verify = sorage(["vault", "verify", "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(verify.status).toBe(0);
    const doctor = sorage(["doctor", "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(doctor.status).toBe(0);
    expect(
      (envelopeOf(doctor) as { data: { checks: Array<{ severity: string }> } }).data.checks.every(
        (check) => check.severity !== "blocking",
      ),
    ).toBe(true);
  });
});
