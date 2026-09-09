import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * TASK-081 CLI detail reads: review show and events call the same use cases as
 * the HTTP detail surface, record nothing, and hide non-participants.
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
  const home = tempHome("sorage-detail-read-");
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

function rowOf(home: string, id: string): { row_version: number; first_fetched_at: string | null } {
  const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    return database.prepare("SELECT row_version, first_fetched_at FROM handoffs WHERE id = ?").get(id) as {
      row_version: number;
      first_fetched_at: string | null;
    };
  } finally {
    database.close();
  }
}

function eventCount(home: string): number {
  const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    return (database.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
  } finally {
    database.close();
  }
}

describe("sorage review show and events", () => {
  it("returns the current Note or JSON null, records nothing, and hides non-participants", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup();

    process.chdir(workB);
    const missing = capture();
    expect(runCli(["review", "show", handoffId, "--json"], missing.ports)).toBe(0);
    expect((JSON.parse(missing.outText()) as { data: unknown }).data).toBeNull();

    expect(runCli(["review", "set", handoffId, "--text", "Tighten the intro", "--json"], capture().ports)).toBe(0);
    const before = rowOf(home, handoffId);
    const eventsBefore = eventCount(home);

    const shown = capture();
    expect(runCli(["review", "show", handoffId, "--json"], shown.ports)).toBe(0);
    const note = JSON.parse(shown.outText()) as {
      data: { body: string; targetRevision: number; authorKind: string };
    };
    expect(note.data.body).toBe("Tighten the intro");
    expect(note.data.targetRevision).toBe(1);
    expect(note.data.authorKind).toBe("registered_project");

    process.chdir(workA);
    const sender = capture();
    expect(runCli(["review", "show", handoffId, "--json"], sender.ports)).toBe(0);
    expect((JSON.parse(sender.outText()) as { data: { body: string } }).data.body).toBe("Tighten the intro");

    const after = rowOf(home, handoffId);
    expect(after.row_version).toBe(before.row_version);
    expect(after.first_fetched_at).toBeNull();
    expect(eventCount(home)).toBe(eventsBefore);

    const outsider = mkdtempSync(join(tmpdir(), "sorage-detail-outsider-"));
    homes.push(outsider);
    process.chdir(outsider);
    const stranger = capture();
    expect(runCli(["review", "show", handoffId, "--json"], stranger.ports)).toBe(66);
    expect((JSON.parse(stranger.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_NOT_FOUND");
    process.chdir(original);
  });

  it("returns a bounded newest-first metadata timeline, including on a tombstone", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup();

    process.chdir(workB);
    expect(runCli(["review", "set", handoffId, "--text", "note", "--json"], capture().ports)).toBe(0);
    process.chdir(workA);
    const before = rowOf(home, handoffId);
    const eventsBefore = eventCount(home);

    const timeline = capture();
    expect(runCli(["events", handoffId, "--json"], timeline.ports)).toBe(0);
    const listed = JSON.parse(timeline.outText()) as {
      data: Array<{ eventType: string; actorKind: string; rowVersion: number | null }>;
    };
    expect(listed.data.length).toBeGreaterThan(0);
    expect(listed.data.length).toBeLessThanOrEqual(50);
    expect(listed.data.some((event) => event.eventType === "REVIEW_NOTE_CREATED")).toBe(true);
    for (const event of listed.data) {
      expect(event).not.toHaveProperty("artifactBytes");
      expect(event).not.toHaveProperty("body");
    }
    const createdIndex = listed.data.findIndex((event) => event.eventType === "REVIEW_NOTE_CREATED");
    const sentIndex = listed.data.findIndex((event) => event.eventType === "HANDOFF_CREATED");
    expect(createdIndex).toBeGreaterThanOrEqual(0);
    expect(sentIndex).toBeGreaterThan(createdIndex);

    const after = rowOf(home, handoffId);
    expect(after.row_version).toBe(before.row_version);
    expect(eventCount(home)).toBe(eventsBefore);

    process.chdir(workA);
    expect(runCli(["revise", handoffId, "--no-change", "--reason", "keep wording", "--json"], capture().ports)).toBe(0);
    process.chdir(workB);
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "3", "--json"],
        capture().ports,
      ),
    ).toBe(0);
    expect(runCli(["delete", "request", handoffId, "--json"], capture().ports)).toBe(0);
    expect(runCli(["delete", "approve", handoffId, "--as-user", "--confirm", "--json"], capture().ports)).toBe(0);

    const tombstoneEvents = capture();
    expect(runCli(["events", handoffId, "--json"], tombstoneEvents.ports)).toBe(0);
    const tombstone = JSON.parse(tombstoneEvents.outText()) as { data: Array<{ eventType: string }> };
    expect(tombstone.data.some((event) => event.eventType === "DELETION_APPROVED")).toBe(true);

    const tombstoneNote = capture();
    expect(runCli(["review", "show", handoffId, "--json"], tombstoneNote.ports)).toBe(0);
    expect((JSON.parse(tombstoneNote.outText()) as { data: unknown }).data).toBeNull();

    const outsider = mkdtempSync(join(tmpdir(), "sorage-detail-events-outsider-"));
    homes.push(outsider);
    process.chdir(outsider);
    const stranger = capture();
    expect(runCli(["events", handoffId, "--json"], stranger.ports)).toBe(66);
    expect((JSON.parse(stranger.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_NOT_FOUND");
    process.chdir(original);
  });
});
