import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The uniform optional `--expected-row-version` of TASK-036 (CLI-020, HND-014): every
 * Handoff-mutating command beyond accept and decline refuses a stale expectation with
 * exit 75 `ROW_VERSION_CONFLICT` while the same command without the flag still
 * succeeds, so the option is enforced exactly when it is supplied.
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
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

function run(args: string[]): { exit: number; err: string } {
  const cap = capture();
  const exit = runCli(args, cap.ports);
  return { exit, err: cap.errText() };
}

function rowVersionOf(id: string): number {
  const cap = capture();
  const exit = runCli(["get", id, "--as", "beta", "--json"], cap.ports);
  expect(exit).toBe(0);
  return (JSON.parse(cap.outText()) as { data: { rowVersion: number } }).data.rowVersion;
}

interface Fixture {
  home: string;
  document: string;
  send(title: string): string;
}

function fixture(): Fixture {
  const home = tempHome("sorage-row-version-");
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  const workA = join(home, "work-a");
  const workB = join(home, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
  const document = join(home, "brief.md");
  writeFileSync(document, "# Shared\n");
  const replacement = join(home, "replacement.md");
  writeFileSync(replacement, "# Shared, revised\n");
  return {
    home,
    document,
    send(title: string): string {
      const cap = capture();
      const exit = runCli(
        [
          "send",
          "--as",
          "alpha",
          "--to",
          "beta",
          "--title",
          title,
          "--file",
          document,
          "--allow-external-source",
          "--json",
        ],
        cap.ports,
      );
      expect(exit).toBe(0);
      return (JSON.parse(cap.outText()) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
        ?.handoffId as string;
    },
  };
}

function stale(id: string): string {
  return String(rowVersionOf(id) + 1);
}

function expectConflict(label: string, args: string[]): void {
  const result = run(args);
  expect(result.exit, label).toBe(75);
  expect(result.err, label).toContain("ROW_VERSION_CONFLICT");
}

describe("the uniform optional --expected-row-version", () => {
  it("refuses a stale expectation on every Handoff-mutating command", () => {
    const fx = fixture();
    const replacement = join(fx.home, "replacement.md");

    // review set: awaiting_recipient, stale row version.
    const h1 = fx.send("Review set case");
    expectConflict("review set", [
      "review",
      "set",
      h1,
      "--as",
      "beta",
      "--text",
      "Needs work",
      "--expected-row-version",
      stale(h1),
    ]);
    expect(run(["review", "set", h1, "--as", "beta", "--text", "Needs work"]).exit).toBe(0);

    // review withdraw: changes_requested now.
    expectConflict("review withdraw", ["review", "withdraw", h1, "--as", "beta", "--expected-row-version", stale(h1)]);
    expect(run(["review", "withdraw", h1, "--as", "beta"]).exit).toBe(0);

    // review remove: put a Note back, then remove administratively with a stale value.
    expect(run(["review", "set", h1, "--as", "beta", "--text", "Again"]).exit).toBe(0);
    expectConflict("review remove", [
      "review",
      "remove",
      h1,
      "--as-user",
      "--confirm",
      "--expected-row-version",
      stale(h1),
    ]);
    expect(run(["review", "remove", h1, "--as-user", "--confirm"]).exit).toBe(0);

    // revise --file and revise --no-change: a Note exists on the next Handoff.
    const h2 = fx.send("Revise cases");
    expect(run(["review", "set", h2, "--as", "beta", "--text", "Change the title"]).exit).toBe(0);
    expectConflict("revise --file", [
      "revise",
      h2,
      "--as",
      "alpha",
      "--file",
      replacement,
      "--allow-external-source",
      "--expected-row-version",
      stale(h2),
    ]);
    expect(run(["revise", h2, "--as", "alpha", "--file", replacement, "--allow-external-source"]).exit).toBe(0);
    expect(run(["review", "set", h2, "--as", "beta", "--text", "Still wrong"]).exit).toBe(0);
    expectConflict("revise --no-change", [
      "revise",
      h2,
      "--as",
      "alpha",
      "--no-change",
      "--reason",
      "Addressed elsewhere",
      "--expected-row-version",
      stale(h2),
    ]);
    expect(run(["revise", h2, "--as", "alpha", "--no-change", "--reason", "Addressed elsewhere"]).exit).toBe(0);

    // withdraw: a fresh, unengaged Handoff.
    const h3 = fx.send("Withdraw case");
    expectConflict("withdraw", ["withdraw", h3, "--as", "alpha", "--expected-row-version", stale(h3)]);
    expect(run(["withdraw", h3, "--as", "alpha"]).exit).toBe(0);

    // pin and unpin.
    const h4 = fx.send("Pin cases");
    expectConflict("pin", ["pin", h4, "--as-user", "--expected-row-version", stale(h4)]);
    expect(run(["pin", h4, "--as-user"]).exit).toBe(0);
    expectConflict("unpin", ["unpin", h4, "--as-user", "--expected-row-version", stale(h4)]);
    expect(run(["unpin", h4, "--as-user"]).exit).toBe(0);

    // archive and unarchive: terminal only.
    const h5 = fx.send("Archive cases");
    expect(run(["accept", h5, "--as", "beta", "--expected-revision", "1", "--expected-row-version", "1"]).exit).toBe(0);
    expectConflict("archive", ["archive", h5, "--as-user", "--expected-row-version", stale(h5)]);
    expect(run(["archive", h5, "--as-user"]).exit).toBe(0);
    expectConflict("unarchive", ["unarchive", h5, "--as-user", "--expected-row-version", stale(h5)]);
    expect(run(["unarchive", h5, "--as-user"]).exit).toBe(0);

    // delete request on an open Handoff.
    const h6 = fx.send("Deletion cases");
    expectConflict("delete request", ["delete", "request", h6, "--as", "beta", "--expected-row-version", stale(h6)]);
    expect(run(["delete", "request", h6, "--as", "beta"]).exit).toBe(0);

    // delete approve and delete reject on terminal Handoffs with pending requests.
    const h7 = fx.send("Approve case");
    expect(run(["accept", h7, "--as", "beta", "--expected-revision", "1", "--expected-row-version", "1"]).exit).toBe(0);
    expect(run(["delete", "request", h7, "--as", "beta"]).exit).toBe(0);
    expectConflict("delete approve", [
      "delete",
      "approve",
      h7,
      "--as-user",
      "--confirm",
      "--expected-row-version",
      stale(h7),
    ]);
    expect(run(["delete", "approve", h7, "--as-user", "--confirm"]).exit).toBe(0);

    const h8 = fx.send("Reject case");
    expect(run(["accept", h8, "--as", "beta", "--expected-revision", "1", "--expected-row-version", "1"]).exit).toBe(0);
    expect(run(["delete", "request", h8, "--as", "beta"]).exit).toBe(0);
    expectConflict("delete reject", ["delete", "reject", h8, "--as-user", "--expected-row-version", stale(h8)]);
    expect(run(["delete", "reject", h8, "--as-user"]).exit).toBe(0);
  });

  it("still accepts a matching expectation on every mutating command", () => {
    const fx = fixture();
    const h1 = fx.send("Matching case");
    expect(
      run(["review", "set", h1, "--as", "beta", "--text", "Fine", "--expected-row-version", String(rowVersionOf(h1))])
        .exit,
    ).toBe(0);
    expect(run(["withdraw", "--help"]).exit).toBe(0);
  });
});
