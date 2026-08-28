import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-031 Review Note lifecycle through the real CLI: recipient creation and
 * update against the target Revision, the sender refusal, the exactly-one Note
 * invariant, recipient withdrawal, and the audited User removal with its
 * USER_CONTEXT_REQUIRED guard.
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

function setup(): { home: string; workA: string; workB: string; handoffId: string } {
  const home = tempHome("sorage-review-cli-");
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  const workA = join(home, "work-a");
  const workB = join(home, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
  const document = join(home, "brief.md");
  writeFileSync(document, "# Shared\n");
  const send = capture();
  const exit = runCli(
    [
      "send",
      "--as",
      "alpha",
      "--to",
      "beta",
      "--title",
      "Brief",
      "--file",
      document,
      "--allow-external-source",
      "--json",
    ],
    send.ports,
  );
  if (exit !== 0) throw new Error(`fixture send failed: ${send.errText()}`);
  const handoffId = (JSON.parse(send.outText()) as { data: { handoffs: Array<{ handoffId: string }> } }).data
    .handoffs[0]?.handoffId as string;
  return { home, workA, workB, handoffId };
}

function eventsOf(home: string, type: string): number {
  const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    const rows = database.prepare("SELECT 1 FROM events WHERE event_type = ?").all(type) as unknown[];
    return rows.length;
  } finally {
    database.close();
  }
}

describe("sorage review", () => {
  it("answers an unregistered workspace sender with FORBIDDEN_ACTOR, not a missing Handoff (REV-004)", () => {
    const original = process.cwd();
    const home = tempHome("sorage-review-workspace-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const workB = join(home, "work-b");
    mkdirSync(workB, { recursive: true });
    expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# Shared\n");
    const unbound = mkdtempSync(join(tmpdir(), "sorage-review-unbound-"));
    homes.push(unbound);
    process.chdir(unbound);
    const send = capture();
    const sendExit = runCli(
      [
        "send",
        "--to",
        "beta",
        "--title",
        "Brief",
        "--file",
        document,
        "--allow-external-source",
        "--allow-unregistered",
        "--json",
      ],
      send.ports,
    );
    if (sendExit !== 0) throw new Error(`workspace send failed: ${send.errText()}`);
    const handoffId = (JSON.parse(send.outText()) as { data: { handoffs: Array<{ handoffId: string }> } }).data
      .handoffs[0]?.handoffId as string;

    // The workspace sender participates, so the permission matrix owes it FORBIDDEN_ACTOR
    // instead of hiding the Handoff behind HANDOFF_NOT_FOUND (the dba85b1 round-2 fix).
    const refused = capture();
    expect(runCli(["review", "set", handoffId, "--text", "no", "--json"], refused.ports)).toBe(77);
    expect((JSON.parse(refused.errText()) as { error: { code: string } }).error.code).toBe("FORBIDDEN_ACTOR");
    process.chdir(original);
  });

  it("sets, updates, withdraws, and removes the one Review Note", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup();

    process.chdir(workA);
    const sender = capture();
    expect(runCli(["review", "set", handoffId, "--text", "please adjust", "--json"], sender.ports)).toBe(77);

    process.chdir(workB);
    const set = capture();
    expect(runCli(["review", "set", handoffId, "--text", "please adjust", "--json"], set.ports)).toBe(0);
    const report = JSON.parse(set.outText()) as { data: { handoff: { reviewState: string; rowVersion: number } } };
    expect(report.data.handoff.reviewState).toBe("changes_requested");
    expect(report.data.handoff.rowVersion).toBe(2);

    const stale = capture();
    expect(
      runCli(["review", "set", handoffId, "--text", "again", "--target-revision", "5", "--json"], stale.ports),
    ).toBe(75);

    const update = capture();
    expect(runCli(["review", "set", handoffId, "--text", "updated note", "--json"], update.ports)).toBe(0);
    expect(eventsOf(home, "REVIEW_NOTE_CREATED")).toBe(1);
    expect(eventsOf(home, "REVIEW_NOTE_UPDATED")).toBe(1);

    const withdrawn = capture();
    expect(runCli(["review", "withdraw", handoffId, "--json"], withdrawn.ports)).toBe(0);
    const withdrawnReport = JSON.parse(withdrawn.outText()) as {
      data: { handoff: { reviewState: string; revision: number } };
    };
    expect(withdrawnReport.data.handoff.reviewState).toBe("awaiting_recipient");
    expect(withdrawnReport.data.handoff.revision).toBe(1);
    expect(eventsOf(home, "REVIEW_NOTE_WITHDRAWN")).toBe(1);

    expect(runCli(["review", "set", handoffId, "--text", "second round", "--json"], capture().ports)).toBe(0);
    const unauthorized = capture();
    expect(runCli(["review", "remove", handoffId, "--confirm", "--json"], unauthorized.ports)).toBe(77);
    const removed = capture();
    const removeExit = runCli(["review", "remove", handoffId, "--as-user", "--confirm", "--json"], removed.ports);
    if (removeExit !== 0) throw new Error(`remove failed (${removeExit}): ${removed.errText()}`);
    expect(removeExit).toBe(0);
    const removedReport = JSON.parse(removed.outText()) as { data: { handoff: { reviewState: string } } };
    expect(removedReport.data.handoff.reviewState).toBe("awaiting_recipient");
    expect(eventsOf(home, "REVIEW_NOTE_REMOVED")).toBe(1);

    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const notes = database.prepare("SELECT COUNT(*) AS c FROM review_notes").get() as { c: number };
      expect(notes.c).toBe(0);
      const engaged = database.prepare("SELECT review_engaged_at FROM handoffs WHERE id = ?").get(handoffId) as {
        review_engaged_at: string | null;
      };
      expect(engaged.review_engaged_at).not.toBeNull();
    } finally {
      database.close();
    }
    process.chdir(original);
  });
});
