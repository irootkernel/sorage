import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-032 sender revision through the real CLI: content revision resolving the
 * Note atomically, the same-content refusal, the proactive correction, the bounded
 * no-change resolution, and the durability of the current Artifact across the swap.
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
  const home = tempHome("sorage-revise-cli-");
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

describe("sorage revise", () => {
  it("revises content with atomic Note resolution and durable current Artifact", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup();

    process.chdir(workB);
    expect(runCli(["review", "set", handoffId, "--text", "tighten the intro", "--json"], capture().ports)).toBe(0);

    const replacement = join(home, "brief-v2.md");
    writeFileSync(replacement, "# Shared, revised\n");
    process.chdir(workA);
    const revised = capture();
    const reviseExit = runCli(
      ["revise", handoffId, "--file", replacement, "--allow-external-source", "--json"],
      revised.ports,
    );
    if (reviseExit !== 0) throw new Error(`revise failed (${reviseExit}): ${revised.errText()}`);
    expect(reviseExit).toBe(0);
    const report = JSON.parse(revised.outText()) as {
      data: { revision: number; rowVersion: number; reviewState: string };
    };
    expect(report.data.revision).toBe(2);
    expect(report.data.rowVersion).toBe(3);
    expect(report.data.reviewState).toBe("awaiting_recipient");

    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const handoff = database
        .prepare("SELECT revision, row_version, review_state, current_artifact_id FROM handoffs WHERE id = ?")
        .get(handoffId) as { revision: number; row_version: number; review_state: string; current_artifact_id: string };
      expect(handoff.revision).toBe(2);
      expect(handoff.review_state).toBe("awaiting_recipient");
      const artifacts = database.prepare("SELECT * FROM artifacts WHERE handoff_id = ?").all(handoffId) as Array<{
        id: string;
        materialized: number;
        storage_key: string;
      }>;
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.id).toBe(handoff.current_artifact_id);
      expect(artifacts[0]?.materialized).toBe(1);
      expect(existsSync(join(home, "vault", artifacts[0]?.storage_key ?? ""))).toBe(true);
      const notes = database.prepare("SELECT COUNT(*) AS c FROM review_notes WHERE handoff_id = ?").get(handoffId) as {
        c: number;
      };
      expect(notes.c).toBe(0);
      const intents = database.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get() as { c: number };
      expect(intents.c).toBe(0);
      const eventTypes = (
        database.prepare("SELECT event_type FROM events ORDER BY rowid").all() as Array<{ event_type: string }>
      ).map((row) => row.event_type);
      expect(eventTypes).toContain("HANDOFF_REVISED");
      expect(eventTypes).toContain("REVIEW_NOTE_RESOLVED");
      expect(eventTypes).toContain("ARTIFACT_ACTIVATED");
      expect(eventTypes).toContain("ARTIFACT_UNLINKED");
    } finally {
      database.close();
    }

    // The same content refuses and changes nothing.
    const same = capture();
    expect(runCli(["revise", handoffId, "--file", replacement, "--allow-external-source", "--json"], same.ports)).toBe(
      65,
    );
    const refused = JSON.parse(same.errText()) as { error: { code: string } };
    expect(refused.error.code).toBe("NO_CONTENT_CHANGE");

    // Proactive correction keeps the state and increments the Revision.
    const replacement2 = join(home, "brief-v3.md");
    writeFileSync(replacement2, "# Shared, proactively fixed\n");
    const proactive = capture();
    expect(
      runCli(["revise", handoffId, "--file", replacement2, "--allow-external-source", "--json"], proactive.ports),
    ).toBe(0);
    const proactiveReport = JSON.parse(proactive.outText()) as { data: { revision: number; reviewState: string } };
    expect(proactiveReport.data.revision).toBe(3);
    expect(proactiveReport.data.reviewState).toBe("awaiting_recipient");
    process.chdir(original);
  });

  it("bounds the no-change resolution and refuses it without a Note", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup();

    process.chdir(workA);
    const withoutNote = capture();
    const noNoteExit = runCli(
      ["revise", handoffId, "--no-change", "--reason", "nothing to change", "--json"],
      withoutNote.ports,
    );
    if (noNoteExit !== 65) throw new Error(`no-note revise: ${noNoteExit}: ${withoutNote.errText()}`);
    expect(noNoteExit).toBe(65);
    expect((JSON.parse(withoutNote.errText()) as { error: { code: string } }).error.code).toBe("NO_REVIEW_NOTE");

    process.chdir(workB);
    expect(runCli(["review", "set", handoffId, "--text", "please reconsider", "--json"], capture().ports)).toBe(0);
    process.chdir(workA);
    const first = capture();
    expect(
      runCli(["revise", handoffId, "--no-change", "--reason", "content already correct", "--json"], first.ports),
    ).toBe(0);
    const firstReport = JSON.parse(first.outText()) as { data: { reviewState: string; revision: number } };
    expect(firstReport.data.reviewState).toBe("awaiting_recipient");
    expect(firstReport.data.revision).toBe(1);

    // A second consecutive no-change resolution is impossible.
    process.chdir(workB);
    expect(runCli(["review", "set", handoffId, "--text", "still wrong", "--json"], capture().ports)).toBe(0);
    process.chdir(workA);
    const second = capture();
    expect(runCli(["revise", handoffId, "--no-change", "--reason", "again", "--json"], second.ports)).toBe(65);
    expect((JSON.parse(second.errText()) as { error: { code: string } }).error.code).toBe("NO_CHANGE_LIMIT");

    // A content revision after a no-change resolution resets the bound.
    const replacement = join(home, "brief-final.md");
    writeFileSync(replacement, "# Final content\n");
    expect(
      runCli(["revise", handoffId, "--file", replacement, "--allow-external-source", "--json"], capture().ports),
    ).toBe(0);
    process.chdir(workB);
    expect(runCli(["review", "set", handoffId, "--text", "one more look", "--json"], capture().ports)).toBe(0);
    process.chdir(workA);
    const reset = capture();
    expect(runCli(["revise", handoffId, "--no-change", "--reason", "correct after all", "--json"], reset.ports)).toBe(
      0,
    );
    process.chdir(original);
  });
});
