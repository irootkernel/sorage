import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * AJ-16, the clean-account packaging journey (TASK-064, GEN-002): the packaged
 * and signed binary installs into an isolated prefix and an empty HOME the way
 * a freshly created macOS account would see it, runs init, a full Handoff loop,
 * doctor, and completion with no separately installed runtime, and the
 * uninstall leaves the Vault behind. The literal fresh macOS user account and
 * a real Homebrew tap install remain the recorded evidence boundary: the tap
 * repository is outside this repository's reach, so the journey drives the
 * exact binary `make package` produces through the same isolation a clean
 * account provides.
 */
const BINARY = fileURLToPath(new URL("../../dist/sorage", import.meta.url));

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Runs the packaged binary with a clean HOME and an isolated prefix, like a new account. */
function installed(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(join(BINARY), args, {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      SORAGE_HOME: join(home, ".sorage"),
      // A clean account has no developer checkout; nothing here may depend on one.
      SORAGE_TEST_REQUEST_ID: undefined,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("AJ-16 packaging on a clean account", () => {
  // `make test` builds without packaging, and the journey's subject is the
  // packaged artifact, so it runs whenever the packaging pipeline has produced
  // its manifest and reports a precise skip otherwise.
  const manifestPath = join(dirname(BINARY), "package.json");
  const packaged = existsSync(manifestPath);
  it.skipIf(!packaged)("installs nothing but the binary and completes the journey", () => {
    expect(existsSync(BINARY)).toBe(true);
    const account = tempDir("sorage-aj16-account-");
    const workA = join(account, "work-a");
    mkdirSync(workA, { recursive: true });

    // The signature the package pipeline wrote is present and valid on the
    // exact binary this journey drives; Gatekeeper assessment of an ad-hoc
    // signature depends on local policy, so the durable check is the receipt.
    const codesign = spawnSync("codesign", ["--verify", "--strict", BINARY], { encoding: "utf8" });
    expect(codesign.status, `codesign --verify failed: ${codesign.stderr}`).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      sha256: string;
      revision: string;
    };
    expect(createHash("sha256").update(readFileSync(BINARY)).digest("hex")).toBe(manifest.sha256);

    const version = installed(["version", "--json"], account);
    expect(version.status).toBe(0);
    expect(JSON.parse(version.stdout).data.version).toBeDefined();

    const init = installed(["init", "--non-interactive"], account);
    expect(init.status).toBe(0);
    expect(existsSync(join(account, ".sorage", "config.yaml"))).toBe(true);

    const doctor = installed(["doctor", "--json"], account);
    expect(doctor.status).toBe(0);

    // A full Handoff loop under the clean account.
    const addA = installed(["project", "add", "--name", "Alpha", "--dir", workA], account);
    expect(addA.status).toBe(0);
    const document = join(account, "brief.md");
    writeFileSync(document, "# AJ-16 brief\n");
    const send = installed(["send", "--to", "alpha", "--title", "AJ-16", "--file", document, "--json"], account);
    expect(send.status).toBe(0);
    const handoffId = (JSON.parse(send.stdout).data.handoffs as Array<{ handoffId: string }>)[0]?.handoffId as string;
    const inbox = installed(["inbox", "--json", "--as", "alpha"], account);
    expect(inbox.status).toBe(0);
    expect(inbox.stdout).toContain(handoffId);
    const accept = installed(
      ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "1", "--json", "--as", "alpha"],
      account,
    );
    expect(accept.status).toBe(0);

    // Completion works from the installed binary.
    const completion = installed(["completion", "zsh"], account);
    expect(completion.status).toBe(0);
    expect(completion.stdout).toContain("sorage");

    // 5-6. Uninstall keeps the Vault and prints its path.
    const uninstall = installed(["uninstall", "--as-user", "--confirm"], account);
    expect(uninstall.status).toBe(0);
    expect(uninstall.stdout).toContain("Vault retained at");
    expect(existsSync(join(account, ".sorage", "vault", ".sorage-vault.json"))).toBe(true);
    expect(existsSync(join(account, ".sorage", "config.yaml"))).toBe(false);
  });
});
