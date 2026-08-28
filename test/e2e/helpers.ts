import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The AJ-01 to AJ-10 harness of the 0.1 release gate: every journey drives the
 * compiled `dist/sorage` binary as a real process against a clean temporary
 * installation, so nothing in this layer can pass through in-process wiring, and no
 * daemon, Web server, Git backup, or ecosystem tool is ever required (GEN-010).
 */
export const BINARY = fileURLToPath(new URL("../../dist/sorage", import.meta.url));

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

const cleanups: Array<() => void> = [];
export function registerCleanup(cleanup: () => void): void {
  cleanups.push(cleanup);
}
export function runCleanups(): void {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // Journey teardown is best-effort; a failed removal must not mask a failure.
    }
  }
}

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function sorage(args: string[], options: { home?: string | undefined; cwd?: string | undefined } = {}): Run {
  if (!existsSync(BINARY)) {
    throw new Error(`the compiled binary is missing at ${BINARY}; run make build first`);
  }
  const result = spawnSync(BINARY, args, {
    encoding: "utf8",
    cwd: options.cwd ?? tmpdir(),
    env: {
      ...process.env,
      SORAGE_HOME: options.home ?? makeTempDir("sorage-e2e-home-"),
      // The release journeys exercise the product as shipped: no test hooks.
      SORAGE_TEST_REQUEST_ID: undefined,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function envelopeOf(run: Run): Record<string, unknown> {
  try {
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(
      `expected a JSON envelope on stdout, got: ${run.stdout.slice(0, 200)} / stderr: ${run.stderr.slice(0, 200)}`,
    );
  }
}

export function errorEnvelopeOf(run: Run): {
  error: { code: string; message: string; details: Record<string, unknown> };
} {
  // Error envelopes are emitted on standard error with an empty stdout (CLI-003).
  try {
    return JSON.parse(run.stderr) as { error: { code: string; message: string; details: Record<string, unknown> } };
  } catch {
    throw new Error(`expected a JSON error envelope on stderr, got: ${run.stderr.slice(0, 200)}`);
  }
}

export interface Fixture {
  home: string;
  workA: string;
  workB: string;
  document: string;
  sendTo(from: "a" | "b", to: "a" | "b", title: string): string;
}

/** Two registered Projects in one initialized installation, plus a shareable document. */
export function twoProjectFixture(prefix: string): Fixture {
  const home = makeTempDir(`${prefix}-home-`);
  const workA = makeTempDir(`${prefix}-work-a-`);
  const workB = makeTempDir(`${prefix}-work-b-`);
  const init = sorage(["init", "--non-interactive"], { home });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const addA = sorage(["project", "add", "--name", "Alpha", "--dir", workA], { home });
  if (addA.status !== 0) throw new Error(`project add alpha failed: ${addA.stderr}`);
  const addB = sorage(["project", "add", "--name", "Beta", "--dir", workB], { home });
  if (addB.status !== 0) throw new Error(`project add beta failed: ${addB.stderr}`);
  const document = join(home, "brief.md");
  writeFileSync(document, "# The brief\n\nShared content for the journey.\n");
  return {
    home,
    workA,
    workB,
    document,
    sendTo(from, to, title) {
      const run = sorage(
        [
          "send",
          `--to`,
          to === "a" ? "alpha" : "beta",
          "--title",
          title,
          "--file",
          document,
          "--allow-external-source",
          "--json",
        ],
        { home, cwd: from === "a" ? workA : workB },
      );
      if (run.status !== 0) throw new Error(`send '${title}' failed (${run.status}): ${run.stderr}`);
      const envelope = envelopeOf(run) as { data: { handoffs: Array<{ handoffId: string }> } };
      return envelope.data.handoffs[0]?.handoffId as string;
    },
  };
}

export function writeDocument(home: string, name: string, content: string): string {
  const path = join(home, name);
  writeFileSync(path, content, "utf8");
  return path;
}

/** Runs one git command inside a directory of the journey. */
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function makeGitRepo(prefix: string): { repo: string; clone: string } {
  const repo = makeTempDir(`${prefix}-repo-`);
  git(repo, ["init", "--initial-branch=main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Journey", "-c", "user.email=journey@example.invalid", "commit", "-m", "init"]);
  const clone = makeTempDir(`${prefix}-clone-`);
  git(clone, ["clone", repo, "."]);
  git(clone, [
    "-c",
    "user.name=Journey",
    "-c",
    "user.email=journey@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "second",
    "--quiet",
  ]);
  return { repo, clone };
}

export function mkdirp(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Best-effort recursive removal for journey-managed directories. */
export function rmSyncSafe(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
