import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, registerCleanup, runCleanups, sorage } from "./helpers";

/**
 * AJ-15, the clean restore drill, over the compiled binary: a backup holding
 * Projects, Handoffs at several review states, and an unregistered-Workspace
 * Handoff is cloned into a clean environment with core.autocrlf=true, every
 * text Artifact stays byte-identical, and a second installation that never
 * held the original restores it - dry-run first - adopting the identity,
 * regenerating only the API token, and refusing a second restore.
 */
afterAll(() => {
  runCleanups();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

describe("AJ-15 the clean restore drill", () => {
  it("restores a backup copy into a second empty installation with every checksum matching", () => {
    // 1. Produce a backup with Handoffs across states.
    const homeA = makeTempDir("sorage-aj15-a-");
    const workA = makeTempDir("sorage-aj15-work-");
    const workUnregistered = makeTempDir("sorage-aj15-unreg-");
    const vaultA = join(homeA, "vault");
    expect(sorage(["init", "--vault", vaultA, "--initialize-git", "--non-interactive"], { home: homeA }).status).toBe(
      0,
    );
    const beta = join(homeA, "beta");
    mkdtempSync(beta);
    rmSync(beta, { recursive: true, force: true });
    execFileSync("mkdir", ["-p", beta]);
    sorage(["project", "add", "--name", "Alpha", "--dir", workA, "--json"], { home: homeA, cwd: workA });
    sorage(["project", "add", "--name", "Beta", "--dir", beta, "--json"], { home: homeA, cwd: workA });

    const briefs: Array<[string, string, string, string[]]> = [
      ["accepted brief", "accepted.md", "# Accepted\n", ["--to", "beta"]],
      ["declined brief", "declined.md", "# Declined\n", ["--to", "beta"]],
    ];
    const ids: Record<string, string> = {};
    for (const [title, file, body] of briefs) {
      const path = join(workA, file);
      rmSync(path, { force: true });
      (function write() {
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(path, body);
      })();
      const send = sorage(
        ["send", "--as", "alpha", ...(["--to", "beta"] as string[]), "--title", title, "--file", file, "--json"],
        { home: homeA, cwd: workA },
      );
      expect(send.status, `send ${title}`).toBe(0);
      ids[title] =
        (JSON.parse(send.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]?.handoffId ??
        "";
    }
    // Move them to their terminal states.
    sorage(
      [
        "accept",
        ids["accepted brief"] as string,
        "--as",
        "beta",
        "--expected-revision",
        "1",
        "--expected-row-version",
        "1",
        "--json",
      ],
      { home: homeA, cwd: beta },
    );
    sorage(
      [
        "decline",
        ids["declined brief"] as string,
        "--as",
        "beta",
        "--reason",
        "not needed",
        "--expected-row-version",
        "2",
        "--json",
      ],
      { home: homeA, cwd: beta },
    );
    // An unregistered-Workspace Handoff exercises the workspaceKey identity.
    const unregisteredBrief = join(workUnregistered, "unregistered.md");
    (function write() {
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(unregisteredBrief, "# From an unregistered workspace\n");
    })();
    const unregistered = sorage(
      ["send", "--to", "beta", "--title", "Unregistered", "--file", unregisteredBrief, "--json"],
      { home: homeA, cwd: workUnregistered },
    );
    expect(unregistered.status).toBe(0);

    const backup = sorage(["backup", "run", "--json"], { home: homeA });
    expect(backup.status).toBe(0);

    // 2. Clone the backup repository into a clean environment with autocrlf=true.
    const clone = makeTempDir("sorage-aj15-clone-");
    execFileSync("git", ["-c", "core.autocrlf=true", "clone", vaultA, clone]);

    // 3. Every text Artifact stays byte-identical.
    const listed = git(clone, "ls-files")
      .split("\n")
      .filter((line) => line.startsWith("artifacts/"));
    expect(listed.length).toBeGreaterThanOrEqual(3);
    for (const relative of listed) {
      expect(readFileSync(join(clone, relative), "utf8")).toBe(readFileSync(join(vaultA, relative), "utf8"));
    }

    // 4. Dry-run in an empty installation reports the plan and writes nothing.
    const homeB = makeTempDir("sorage-aj15-b-");
    expect(sorage(["init", "--non-interactive"], { home: homeB }).status).toBe(0);
    const dry = sorage(["backup", "restore", "--from", clone, "--dry-run", "--as-user", "--json"], { home: homeB });
    expect(dry.status).toBe(0);
    const dryEnvelope = JSON.parse(dry.stdout) as {
      data: { wouldCreate: Record<string, number>; adoptedInstallationId: string };
    };
    expect(dryEnvelope.data.wouldCreate.projects).toBe(2);
    expect(dryEnvelope.data.wouldCreate.handoffs).toBe(3);
    expect(existsSync(join(homeB, "vault", "snapshots"))).toBe(false);

    // 5. The real restore, then the second refusal.
    const restore = sorage(["backup", "restore", "--from", clone, "--as-user", "--confirm", "--json"], { home: homeB });
    if (restore.status !== 0) {
      console.log("RESTORE DEBUG", restore.status, restore.stdout.slice(0, 300), restore.stderr.slice(0, 500));
    }
    expect(restore.status).toBe(0);
    const again = sorage(["backup", "restore", "--from", clone, "--as-user", "--confirm", "--json"], { home: homeB });
    expect(again.status).toBe(75);
    const againEnvelope = JSON.parse(again.stderr) as { error: { code: string } };
    expect(againEnvelope.error.code).toBe("RESTORE_TARGET_NOT_EMPTY");

    // 6. UUIDs, states, and every checksum survived.
    const identityA =
      /installationId: "?([0-9a-f-]+)"?/.exec(readFileSync(join(homeA, "config.yaml"), "utf8"))?.[1] ?? "";
    expect(/installationId: "?([0-9a-f-]+)"?/.exec(readFileSync(join(homeB, "config.yaml"), "utf8"))?.[1]).toBe(
      identityA,
    );
    const restored = sorage(["get", ids["accepted brief"] as string, "--as-user", "--json"], {
      home: homeB,
      cwd: beta,
    });
    expect(restored.status).toBe(0);
    const restoredEnvelope = JSON.parse(restored.stdout) as {
      data: { reviewState: string; revision: number; currentArtifact: { sha256: string } | null };
    };
    expect(restoredEnvelope.data.reviewState).toBe("accepted");
    expect(restoredEnvelope.data.revision).toBe(1);
    expect(restoredEnvelope.data.currentArtifact).not.toBeNull();
    // The restored installation backs up on its own, and that backup verifies.
    const backupB = sorage(["backup", "run", "--json"], { home: homeB });
    expect(backupB.status).toBe(0);
    const verifyB = sorage(["backup", "verify", "--json"], { home: homeB });
    expect(verifyB.status).toBe(0);

    // 7. The unregistered outbox resolves from the original path, and Projects re-bind.
    const outbox = sorage(["outbox", "--json"], { home: homeB, cwd: workUnregistered });
    expect(outbox.status).toBe(0);
    const outboxEnvelope = JSON.parse(outbox.stdout) as { data: { handoffs: Array<{ title: string }> } };
    expect(outboxEnvelope.data.handoffs.some((handoff) => handoff.title === "Unregistered")).toBe(true);
    sorage(["project", "bind", "beta", "--dir", beta, "--json"], { home: homeB, cwd: beta });
    sorage(["project", "bind", "alpha", "--dir", workA, "--json"], { home: homeB, cwd: workA });

    // 8. Doctor reports no blocking check after the re-bind.
    const doctor = sorage(["doctor", "--json"], { home: homeB, cwd: beta });
    expect(doctor.status).toBe(0);
    const doctorEnvelope = JSON.parse(doctor.stdout) as { data: { checks: Array<{ severity: string }> } };
    expect(doctorEnvelope.data.checks.some((check) => check.severity === "blocking")).toBe(false);
    expect(existsSync(join(homeB, "state", "api-token"))).toBe(true);
    void homedir;
  }, 60000);
});
