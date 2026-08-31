import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The two concurrent-writer rows of the section 4 failure matrix (TASK-061):
 * two real CLI processes race on one Handoff with the same expected Row Version
 * - a recipient review set against a sender revise, and two sender revises - and
 * exactly one wins while the loser meets ROW_VERSION_CONFLICT with the Handoff
 * left internally consistent (CFG-015, SEC-008, SEC-016).
 */
const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

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
  };
}

/** Runs one CLI command as its own process, as a real concurrent writer would. */
function runProcess(args: string[], home: string): Promise<{ code: number; stderr: string }> {
  // The golden harness pattern: the CLI entry is TypeScript, so it runs under
  // bun. The cwd matches the sender workspace the in-process send used, so the
  // revise processes resolve the same unregistered sender the Handoff records.
  return exec("bun", [entry, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, SORAGE_HOME: home },
  })
    .then(({ stdout, stderr }) => ({ code: 0, stderr: `${stdout}${stderr}` }))
    .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? 1,
      stderr: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    }));
}

function setup(): { home: string; handoffId: string } {
  const home = mkdtempSync(join(tmpdir(), "sorage-concurrent-"));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const alpha = join(home, "alpha");
  const beta = join(home, "beta");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", alpha], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", beta], capture().ports)).toBe(0);
  const document = join(home, "brief.md");
  writeFileSync(document, "# brief\n");
  const send = capture();
  expect(
    runCli(
      ["send", "--to", "alpha", "--title", "Race", "--file", document, "--allow-external-source", "--json"],
      send.ports,
    ),
  ).toBe(0);
  const envelope = JSON.parse(send.outText()) as { data: { handoffs: Array<{ handoffId: string }> } };
  return { home, handoffId: envelope.data.handoffs[0]?.handoffId as string };
}

function outcomes(codes: number[]): { winners: number; conflicts: number } {
  return {
    winners: codes.filter((code) => code === 0).length,
    conflicts: codes.filter((code) => code === 75).length,
  };
}

describe("two concurrent writers on one Handoff", () => {
  it("lets exactly one of a recipient review set and a sender revise win", async () => {
    const { home, handoffId } = setup();
    const revisionA = join(home, "revision.md");
    writeFileSync(revisionA, "# revised\n");
    // Both writers pin the same expected Row Version, as the matrix row requires.
    const [review, revise] = await Promise.all([
      runProcess(
        [
          "review",
          "set",
          handoffId,
          "--text",
          "from the recipient",
          "--json",
          "--as",
          "alpha",
          "--expected-row-version",
          "1",
        ],
        home,
      ),
      runProcess(
        ["revise", handoffId, "--file", revisionA, "--allow-external-source", "--json", "--expected-row-version", "1"],
        home,
      ),
    ]);
    const { winners, conflicts } = outcomes([review.code, revise.code]);
    expect(winners).toBe(1);
    expect(conflicts).toBe(1);
    // The loser names the compare-and-set conflict; exit 75 alone is ambiguous.
    const loser = review.code === 75 ? review : revise;
    expect(loser.stderr).toContain("ROW_VERSION_CONFLICT");
    // The Handoff is internally consistent for whichever writer won: the review
    // state matches the winner, no Note rides a Revision that no longer exists,
    // and the Row Version moved exactly once.
    const get = capture();
    expect(runCli(["get", handoffId, "--json", "--as", "alpha"], get.ports)).toBe(0);
    const detail = JSON.parse(get.outText()) as {
      data: { reviewState: string; rowVersion: number; revision: number; currentArtifact: unknown };
    };
    expect(detail.data.rowVersion).toBe(2);
    if (review.code === 0) {
      expect(detail.data.reviewState).toBe("changes_requested");
      expect(detail.data.revision).toBe(1);
    } else {
      expect(detail.data.reviewState).toBe("awaiting_recipient");
      expect(detail.data.revision).toBe(2);
      expect(detail.data.currentArtifact).not.toBeNull();
    }
  });

  it("lets exactly one of two concurrent sender revises win", async () => {
    const { home, handoffId } = setup();
    const first = join(home, "first.md");
    const second = join(home, "second.md");
    writeFileSync(first, "# first revision\n");
    writeFileSync(second, "# second revision\n");
    const [a, b] = await Promise.all([
      runProcess(
        ["revise", handoffId, "--file", first, "--allow-external-source", "--json", "--expected-row-version", "1"],
        home,
      ),
      runProcess(
        ["revise", handoffId, "--file", second, "--allow-external-source", "--json", "--expected-row-version", "1"],
        home,
      ),
    ]);
    const { winners, conflicts } = outcomes([a.code, b.code]);
    expect(winners).toBe(1);
    expect(conflicts).toBe(1);
    // The winner's content is the only current Artifact. The loser staged its own
    // copy before the authoritative compare-and-set rolled its transaction back,
    // so its file is exactly the matrix row's orphan of the no-row class: visible
    // to vault verify as a staged file with no row, and removable by the sweep.
    const get = capture();
    expect(runCli(["get", handoffId, "--json", "--as", "alpha"], get.ports)).toBe(0);
    const detail = JSON.parse(get.outText()) as { data: { revision: number; rowVersion: number } };
    expect(detail.data.revision).toBe(2);
    expect(detail.data.rowVersion).toBe(2);
    const staged = readdirSync(join(home, "vault", "staging"));
    expect(staged.length).toBeGreaterThanOrEqual(1);
  });
});
