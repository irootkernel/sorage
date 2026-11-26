import { observedHandoffFlags } from "../fixtures/handoff-observations";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/program";

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

    expect(
      runCli(
        [
          "review",
          "set",
          handoffId,
          "--text",
          "Tighten the intro",
          "--json",
          ...observedHandoffFlags(handoffId, "both"),
        ],
        capture().ports,
      ),
    ).toBe(0);
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
    expect(
      runCli(
        ["review", "set", handoffId, "--text", "note", "--json", ...observedHandoffFlags(handoffId, "both")],
        capture().ports,
      ),
    ).toBe(0);
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
    expect(
      runCli(
        [
          "revise",
          handoffId,
          "--no-change",
          "--reason",
          "keep wording",
          "--json",
          ...observedHandoffFlags(handoffId, "row"),
        ],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workB);
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "3", "--json"],
        capture().ports,
      ),
    ).toBe(0);
    expect(runCli(["delete", "request", handoffId, "--json"], capture().ports)).toBe(0);
    expect(
      runCli(
        ["delete", "approve", handoffId, "--as-user", "--confirm", "--json", ...observedHandoffFlags(handoffId, "row")],
        capture().ports,
      ),
    ).toBe(0);

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

  it("pins the 50-event limit, created_at DESC id DESC cutoff ties, metadata-only shape, admission, and zero writes (CLI-023, TASK-171)", () => {
    const original = process.cwd();
    const { home, workA, workB, handoffId } = setup();
    try {
      // Create a second Handoff whose strictly newer events must never leak into targetId's timeline.
      const otherDoc = join(home, "other.md");
      writeFileSync(otherDoc, "# Other\n");
      const otherSend = capture();
      expect(
        runCli(
          [
            "send",
            "--as",
            "alpha",
            "--to",
            "beta",
            "--title",
            "Other Handoff",
            "--file",
            otherDoc,
            "--allow-external-source",
            "--json",
          ],
          otherSend.ports,
        ),
      ).toBe(0);
      const otherHandoffId = (JSON.parse(otherSend.outText()) as { data: { handoffs: Array<{ handoffId: string }> } })
        .data.handoffs[0]?.handoffId as string;

      // Seed 60 deterministic events on handoffId (5 older, 10 tied across the 50-event cutoff in
      // scrambled rowid order, 45 newer in non-chronological insertion order) plus 10 strictly newer
      // events on otherHandoffId.
      const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      const insert = db.prepare(
        "INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'user', NULL, 1, ?, ?)",
      );
      const pad2 = (n: number) => String(n).padStart(2, "0");
      try {
        for (const n of [3, 1, 5, 2, 4]) {
          insert.run(
            `evt-old-${pad2(n)}`,
            handoffId,
            "REVIEW_NOTE_UPDATED",
            '{"secretBody":"must-not-leak","group":"old"}',
            `2099-01-01T00:00:${pad2(n)}.000Z`,
          );
        }
        // Identical created_at tie group spanning the 50-event cutoff (indices 45..49 kept, 50..54 evicted).
        for (const n of [5, 2, 9, 1, 8, 4, 10, 3, 7, 6]) {
          insert.run(
            `evt-tie-${pad2(n)}`,
            handoffId,
            "REVIEW_NOTE_UPDATED",
            '{"secretBody":"must-not-leak","group":"tie"}',
            "2099-01-01T00:01:00.000Z",
          );
        }
        // 45 strictly newer events inserted out of chronological order (odds ascending, then evens descending).
        const newOrder: number[] = [];
        for (let n = 1; n <= 45; n += 2) newOrder.push(n);
        for (let n = 44; n >= 2; n -= 2) newOrder.push(n);
        for (const n of newOrder) {
          insert.run(
            `evt-new-${pad2(n)}`,
            handoffId,
            "REVIEW_NOTE_UPDATED",
            '{"secretBody":"must-not-leak","group":"new"}',
            `2099-01-01T00:02:${pad2(n)}.000Z`,
          );
        }
        // 10 strictly newer events on another Handoff to verify isolation.
        for (let n = 1; n <= 10; n += 1) {
          insert.run(
            `evt-other-${pad2(n)}`,
            otherHandoffId,
            "REVIEW_NOTE_UPDATED",
            '{"secretBody":"must-not-leak","group":"other"}',
            `2099-03-01T00:00:${pad2(n)}.000Z`,
          );
        }
      } finally {
        db.close();
      }

      const expectedTop50 = [
        ...Array.from({ length: 45 }, (_, index) => `evt-new-${pad2(45 - index)}`),
        "evt-tie-10",
        "evt-tie-09",
        "evt-tie-08",
        "evt-tie-07",
        "evt-tie-06",
      ];

      const snapshotState = () => {
        const checkDb = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
        try {
          const handoff = checkDb
            .prepare(
              "SELECT revision, row_version, review_state, first_fetched_at, review_engaged_at, updated_at FROM handoffs WHERE id = ?",
            )
            .get(handoffId);
          const events = checkDb.prepare("SELECT COUNT(*) AS count, MAX(rowid) AS max_rowid FROM events").get() as {
            count: number;
            max_rowid: number;
          };
          return { handoff, events };
        } finally {
          checkDb.close();
        }
      };

      const before = snapshotState();

      for (const participantDir of [workA, workB]) {
        process.chdir(participantDir);
        const timeline = capture();
        expect(runCli(["events", handoffId, "--json"], timeline.ports)).toBe(0);
        const events = (JSON.parse(timeline.outText()) as { data: Array<Record<string, unknown>> }).data;
        expect(events).toHaveLength(50);
        expect(events.map((entry) => entry.id)).toEqual(expectedTop50);
        for (const evicted of ["evt-tie-05", "evt-tie-01", "evt-old-05", "evt-other-10"]) {
          expect(events.map((entry) => entry.id)).not.toContain(evicted);
        }
        expect(events.some((entry) => entry.eventType === "HANDOFF_CREATED")).toBe(false);
        for (const entry of events) {
          expect(Object.keys(entry).sort()).toEqual([
            "actorId",
            "actorKind",
            "createdAt",
            "eventType",
            "id",
            "rowVersion",
          ]);
          expect(JSON.stringify(entry)).not.toContain("must-not-leak");
        }
      }

      const outsider = mkdtempSync(join(tmpdir(), "sorage-detail-overflow-outsider-"));
      homes.push(outsider);
      process.chdir(outsider);
      const denied = capture();
      expect(runCli(["events", handoffId, "--json"], denied.ports)).toBe(66);
      expect((JSON.parse(denied.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_NOT_FOUND");

      expect(snapshotState()).toEqual(before);
    } finally {
      process.chdir(original);
    }
  });
});
