import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The CLI rows of the section 15 security matrix (TASK-060): row 15 proves shell
 * metacharacters ride as data through titles, filenames, and the configured backup
 * commit message without ever spawning a shell, and row 20 proves a full journey
 * leaves no token, Review Note body, or Artifact bytes in the log file or the JSON
 * output (SEC-004, SEC-005, SEC-010).
 */
const homes: string[] = [];
const markers: string[] = [];
afterEach(() => {
  while (markers.length > 0) {
    const marker = markers.pop();
    if (marker !== undefined) rmSync(marker, { force: true });
  }
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

function twoProjects(home: string): { alpha: string; beta: string } {
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  const alpha = join(home, "work-alpha");
  const beta = join(home, "work-beta");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", alpha], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", beta], capture().ports)).toBe(0);
  return { alpha, beta };
}

describe("matrix row 15: shell metacharacters are data, never a command", () => {
  it("carries a hostile title and filename through send without executing them", () => {
    const home = tempHome("sorage-sec-metachar-");
    twoProjects(home);
    const marker = join(home, "pwned-by-title");
    markers.push(marker);
    const hostileTitle = `Review; rm -rf "${join(home, "nothing")}" && $(touch ${marker}) \`id\``;
    // The filename stays slash-free (a slash would make it a path), while the
    // title carries the full hostile payload including the marker path.
    const document = join(home, "notes; $(id) `whoami` && echo.md");
    writeFileSync(document, "# hostile name\n");
    const send = capture();
    const exit = runCli(
      ["send", "--to", "alpha", "--title", hostileTitle, "--file", document, "--allow-external-source", "--json"],
      send.ports,
    );
    expect(exit).toBe(0);
    // No shell ever ran: the command substitutions stayed data.
    expect(existsSync(marker)).toBe(false);
    const envelope = JSON.parse(send.outText()) as { data: { handoffs: Array<{ handoffId: string }> } };
    const handoffId = envelope.data.handoffs[0]?.handoffId;
    expect(handoffId).toBeDefined();
    const get = capture();
    expect(runCli(["get", handoffId as string, "--json"], get.ports)).toBe(0);
    expect(get.outText()).toContain("Review; rm -rf");
    // The filename rode through as data too: the recorded original name is the
    // hostile basename verbatim, never renamed or sanitized into something safe.
    const detail = JSON.parse(get.outText()) as { data: { currentArtifact: { originalName: string } } };
    expect(detail.data.currentArtifact.originalName).toBe("notes; $(id) `whoami` && echo.md");
  });

  it("renders the configured commit message template literally into the backup commit", () => {
    const home = tempHome("sorage-sec-metachar-commit-");
    expect(runCli(["init", "--non-interactive", "--initialize-git", "--enable-daily-backup"], capture().ports)).toBe(0);
    const marker = join(home, "pwned-by-commit");
    markers.push(marker);
    const hostile = `backup; $(touch ${marker}) && echo owned`;
    expect(runCli(["config", "set", "gitBackup.commit.messageTemplate", hostile, "--as-user"], capture().ports)).toBe(
      0,
    );
    const run = capture();
    expect(runCli(["backup", "run", "--as-user"], run.ports)).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // The commit itself carries the hostile template literally: read it back with
    // an argument-array git invocation, never a shell string.
    const vault = join(home, "vault");
    const message = execFileSync("git", ["-C", vault, "log", "-1", "--pretty=%B"], { encoding: "utf8" });
    expect(message).toContain(hostile);
  });
});

describe("matrix row 20: a full journey leaves no secret material in logs or JSON", () => {
  it("keeps the token, the Review Note body, and Artifact bytes out of every output", () => {
    const home = tempHome("sorage-sec-journey-");
    twoProjects(home);

    const noteBody = "SECRET-REVIEW-NOTE-BODY-9f1e";
    const artifactBytes = "SECRET-ARTIFACT-BYTES-77c3";
    const document = join(home, "brief.md");
    writeFileSync(document, `# Brief\n\n${artifactBytes}\n`);
    const send = capture();
    expect(
      runCli(
        ["send", "--to", "alpha", "--title", "Journey", "--file", document, "--allow-external-source", "--json"],
        send.ports,
      ),
    ).toBe(0);
    const envelope = JSON.parse(send.outText()) as { data: { handoffs: Array<{ handoffId: string }> } };
    const handoffId = envelope.data.handoffs[0]?.handoffId as string;

    const inbox = capture();
    expect(runCli(["inbox", "--json", "--as", "alpha"], inbox.ports)).toBe(0);
    const review = capture();
    expect(runCli(["review", "set", handoffId, "--text", noteBody, "--json", "--as", "alpha"], review.ports)).toBe(0);
    const fetch = capture();
    expect(runCli(["fetch", handoffId, "--json", "--as", "alpha"], fetch.ports)).toBe(0);
    // The sender resolves the Note with a revision, which is the loop AJ-04 accepts.
    const revised = join(home, "brief-v2.md");
    writeFileSync(revised, `# Brief v2\n\n${artifactBytes}\n`);
    const revise = capture();
    expect(runCli(["revise", handoffId, "--file", revised, "--allow-external-source", "--json"], revise.ports)).toBe(0);
    const accept = capture();
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "2", "--expected-row-version", "3", "--json", "--as", "alpha"],
        accept.ports,
      ),
    ).toBe(0);

    const token = readFileSync(join(home, "state", "api-token"), "utf8").trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
    const everyOutput = [send, inbox, review, fetch, revise, accept]
      .map((c) => `${c.outText()}${c.errText()}`)
      .join("");
    // The CLI logger is lazy and warn-only by design, so a purely successful
    // journey writes no log at all; one authorized failure produces a real log
    // whose content is then part of the assertion, never a vacuous scan.
    const outsider = capture();
    expect(runCli(["get", handoffId, "--json", "--as", "beta"], outsider.ports)).toBe(66);
    const logFile = join(home, "logs", "sorage.log");
    expect(existsSync(logFile)).toBe(true);
    const logContent = readFileSync(logFile, "utf8");
    expect(logContent.length).toBeGreaterThan(0);
    // Command envelopes may return the note to the actor who set it (WEB-004
    // renders it), so the note body is asserted against the log file only; the
    // token and Artifact bytes must never appear on any surface.
    expect(everyOutput).not.toContain(token);
    expect(everyOutput).not.toContain(artifactBytes);
    expect(logContent).not.toContain(token);
    expect(logContent).not.toContain(noteBody);
    expect(logContent).not.toContain(artifactBytes);
  });
});
