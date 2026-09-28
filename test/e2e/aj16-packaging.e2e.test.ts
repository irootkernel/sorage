import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * a literal fresh macOS user account and hosted GitHub Release download remain
 * the recorded evidence boundary. This journey drives the exact versioned
 * release candidate that `make package` produces.
 */
const BINARY_NAME = "sorage-v0.1.2-darwin-arm64";
const BINARY = fileURLToPath(new URL(`../../dist/${BINARY_NAME}`, import.meta.url));

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

const launchctlBin = tempDir("sorage-aj16-launchctl-");
const fakeLaunchctl = join(launchctlBin, "launchctl");
writeFileSync(
  fakeLaunchctl,
  '#!/bin/sh\nif [ "$1" = "bootout" ]; then echo "No such process" >&2; exit 3; fi\nexit 1\n',
  "utf8",
);
chmodSync(fakeLaunchctl, 0o755);

/** Runs the packaged binary with a clean HOME and an isolated prefix, like a new account. */
function installed(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(join(BINARY), args, {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      SORAGE_HOME: join(home, ".sorage"),
      // launchd labels are scoped to the real user domain, not HOME. Keep the
      // clean-account uninstall from addressing the developer's installed job.
      PATH: `${launchctlBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      // A clean account has no developer checkout; nothing here may depend on one.
      SORAGE_TEST_REQUEST_ID: undefined,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("AJ-16 packaging on a clean account", () => {
  // `make test-e2e` prepares the signed candidate before running every journey.
  // Missing artifacts are preparation failures, never a reason to skip AJ-16.
  const manifestPath = `${BINARY}.manifest.json`;
  const checksumPath = `${BINARY}.sha256`;
  it("installs nothing but the binary and completes the journey", () => {
    expect(existsSync(manifestPath), "run make test-e2e to prepare the packaged candidate").toBe(true);
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
      version: string;
      sha256: string;
      revision: string;
      target: string;
      binary: string;
      signature: string;
    };
    const digest = createHash("sha256").update(readFileSync(BINARY)).digest("hex");
    expect(digest).toBe(manifest.sha256);
    expect(manifest).toMatchObject({
      version: "0.1.2",
      target: "darwin-arm64",
      binary: BINARY_NAME,
      signature: "ad-hoc",
    });
    expect(readFileSync(checksumPath, "utf8")).toBe(`${digest}  ${BINARY_NAME}\n`);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dirname(BINARY), encoding: "utf8" });
    expect(revision.status).toBe(0);
    expect(manifest.revision).toBe(revision.stdout.trim());
    const sourceBinary = join(dirname(BINARY), "sorage");
    expect(createHash("sha256").update(readFileSync(sourceBinary)).digest("hex")).toBe(digest);

    const version = installed(["version", "--json"], account);
    expect(version.status).toBe(0);
    expect(version.stdout).toBe('{"name":"sorage","version":"v0.1.2"}\n');
    expect(version.stderr).toBe("");

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
    // The account root is an ancestor of the registered work-a directory.
    const send = installed(
      ["send", "--to", "alpha", "--title", "AJ-16", "--file", document, "--allow-unregistered", "--json"],
      account,
    );
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
