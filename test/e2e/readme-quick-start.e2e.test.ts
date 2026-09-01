import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BINARY = fileURLToPath(new URL("../../dist/sorage", import.meta.url));
const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch.reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe("README quick start", () => {
  it("installs the built binary and completes the documented review loop in an isolated home", () => {
    expect(existsSync(BINARY)).toBe(true);

    const home = tempDir("sorage-readme-home-");
    const sorageHome = join(home, ".sorage");
    const binDir = join(home, ".local", "bin");
    const installedBinary = join(binDir, "sorage");
    const sender = join(home, "sender");
    const recipient = join(home, "recipient");
    const proposal = join(sender, "proposal.md");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sender, { recursive: true });
    mkdirSync(recipient, { recursive: true });
    writeFileSync(proposal, "# Proposal\n\nThe first draft.\n", "utf8");

    const install = spawnSync("install", ["-m", "0755", BINARY, installedBinary], { encoding: "utf8" });
    expect(install.status, install.stderr).toBe(0);

    const run = (args: string[], cwd = home, input?: string): Run => {
      const result = spawnSync("sorage", args, {
        cwd,
        encoding: "utf8",
        input,
        env: {
          ...process.env,
          HOME: home,
          SORAGE_HOME: sorageHome,
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          SORAGE_TEST_REQUEST_ID: undefined,
        },
      });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    };
    const succeeds = (result: Run): void => {
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    };

    succeeds(run(["version"]));
    succeeds(run(["init"], home, `${["", "y", "", "n", "n", "n", "n", "n", "y"].join("\n")}\n`));
    succeeds(run(["project", "add", "--name", "sender", "--slug", "sender", "--dir", sender]));
    succeeds(run(["project", "add", "--name", "recipient", "--slug", "recipient", "--dir", recipient]));

    const sent = run(["send", "--to", "recipient", "--title", "Proposal review", "--file", "./proposal.md"], sender);
    succeeds(sent);
    const handoffId = sent.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (handoffId === undefined) {
      throw new Error(`sorage send did not report a Handoff id: ${sent.stdout}`);
    }

    const inbox = run(["inbox"], recipient);
    succeeds(inbox);
    expect(inbox.stdout).toContain(handoffId);
    succeeds(run(["get", handoffId], recipient));
    succeeds(run(["fetch", handoffId], recipient));
    succeeds(run(["review", "set", handoffId, "--text", "Clarify the rollback procedure."], recipient));

    writeFileSync(proposal, "# Proposal\n\nThe revised draft includes a rollback procedure.\n", "utf8");
    succeeds(run(["revise", handoffId, "--file", "./proposal.md"], sender));

    const revised = run(["get", handoffId], recipient);
    succeeds(revised);
    const coordinates = revised.stdout.match(/revision (\d+), rowVersion (\d+)/);
    if (coordinates === null || coordinates[1] === undefined || coordinates[2] === undefined) {
      throw new Error(`sorage get did not report revision coordinates: ${revised.stdout}`);
    }
    succeeds(run(["fetch", handoffId], recipient));
    const accepted = run(
      ["accept", handoffId, "--expected-revision", coordinates[1], "--expected-row-version", coordinates[2]],
      recipient,
    );
    succeeds(accepted);
    expect(accepted.stdout).toContain(`Accepted ${handoffId}`);
  });
});
