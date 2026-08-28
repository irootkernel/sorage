import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-034 retention and deletion surface through the real CLI, walking AJ-10:
 * the request from a Project, the non-terminal and unauthorized approvals, the
 * rejection, the corrupted-Artifact refusal, the pinned confirmation, the tombstone
 * with its intent-log cleanup, and the surviving reads.
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

function setup(): { home: string; workA: string; workB: string } {
  const home = tempHome("sorage-retention-cli-");
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
  return { home, workA, workB };
}

function handoffIdOf(output: string): string {
  return (JSON.parse(output) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
    ?.handoffId as string;
}

function sendOne(home: string): string {
  const document = join(home, "brief.md");
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
  if (exit !== 0) throw new Error(`send failed: ${send.errText()}`);
  return handoffIdOf(send.outText());
}

function eventsOf(home: string, type: string): string[] {
  const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    return (
      database.prepare("SELECT event_type FROM events WHERE event_type = ?").all(type) as Array<{ event_type: string }>
    ).map((row) => row.event_type);
  } finally {
    database.close();
  }
}

describe("the AJ-10 deletion journey and the retention rules", () => {
  it("requests, refuses, rejects, and finally approves a deletion into a tombstone", () => {
    const original = process.cwd();
    const { home, workA, workB } = setup();
    const handoffId = sendOne(home);

    // Step 1: a Project requests deletion while awaiting_recipient.
    process.chdir(workA);
    expect(runCli(["delete", "request", handoffId, "--json"], capture().ports)).toBe(0);

    // Step 2: approving a non-terminal Handoff refuses.
    process.chdir(workB);
    const nonTerminal = capture();
    expect(runCli(["delete", "approve", handoffId, "--as-user", "--confirm", "--json"], nonTerminal.ports)).toBe(65);
    expect((JSON.parse(nonTerminal.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_NOT_TERMINAL");

    // Step 3: rejection retains the Handoff with the decision recorded.
    const rejected = capture();
    expect(runCli(["delete", "reject", handoffId, "--as-user", "--json"], rejected.ports)).toBe(0);
    expect(eventsOf(home, "DELETION_REJECTED")).toHaveLength(1);

    // Step 4: accept, request again, and refuse a non-User approval.
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "3", "--json"],
        capture().ports,
      ),
    ).toBe(0);
    expect(runCli(["delete", "request", handoffId, "--json"], capture().ports)).toBe(0);
    const unauthorized = capture();
    expect(runCli(["delete", "approve", handoffId, "--confirm", "--json"], unauthorized.ports)).toBe(77);

    // Step 5: a corrupted Artifact refuses without claiming deletion.
    const vaultArtifact = join(home, "vault", "artifacts");
    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    let storageKey = "";
    try {
      storageKey = (
        database.prepare("SELECT storage_key FROM artifacts WHERE handoff_id = ?").get(handoffId) as {
          storage_key: string;
        }
      ).storage_key;
    } finally {
      database.close();
    }
    const artifactPath = join(home, "vault", storageKey);
    chmodSync(artifactPath, 0o644);
    writeFileSync(artifactPath, "tampered bytes");
    const corrupted = capture();
    expect(runCli(["delete", "approve", handoffId, "--as-user", "--confirm", "--json"], corrupted.ports)).toBe(73);
    expect((JSON.parse(corrupted.errText()) as { error: { code: string } }).error.code).toBe("ARTIFACT_CORRUPTED");
    // Step 5 continues: restore the bytes before the journey proceeds.
    writeFileSync(artifactPath, "# Shared\n");

    // Step 6: pin, then approve without the distinct confirmation.
    expect(runCli(["pin", handoffId, "--as-user", "--json"], capture().ports)).toBe(0);
    const pinned = capture();
    expect(runCli(["delete", "approve", handoffId, "--as-user", "--confirm", "--json"], pinned.ports)).toBe(64);
    expect((JSON.parse(pinned.errText()) as { error: { code: string } }).error.code).toBe("PINNED_DELETE_CONFIRMATION");

    // Step 7: approve with the distinct confirmation; every rendering names the Git caveat.
    const approved = capture();
    expect(
      runCli(
        ["delete", "approve", handoffId, "--as-user", "--confirm", "--confirm-pinned", handoffId, "--json"],
        approved.ports,
      ),
    ).toBe(0);
    const approval = JSON.parse(approved.outText()) as { data: { deleted: boolean; warning: string } };
    expect(approval.data.deleted).toBe(true);
    expect(approval.data.warning).toContain("prior Git commits may retain earlier content");

    // Step 8: the tombstone answers content operations with HANDOFF_DELETED.
    const fetched = capture();
    expect(runCli(["fetch", handoffId, "--json"], fetched.ports)).toBe(65);
    expect((JSON.parse(fetched.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_DELETED");
    const revised = capture();
    expect(
      runCli(
        ["revise", handoffId, "--file", join(home, "brief.md"), "--allow-external-source", "--json"],
        revised.ports,
      ),
    ).toBe(65);
    const again = capture();
    expect(runCli(["delete", "request", handoffId, "--json"], again.ports)).toBe(65);

    // Reads and retention survive on the tombstone.
    expect(runCli(["get", handoffId, "--json"], capture().ports)).toBe(0);
    const listed = capture();
    expect(runCli(["inbox", "--include-deleted", "--json"], listed.ports)).toBe(0);
    expect(listed.outText()).toContain(handoffId);
    const withoutFlag = capture();
    expect(runCli(["inbox", "--json"], withoutFlag.ports)).toBe(0);
    expect(withoutFlag.outText()).not.toContain(handoffId);
    expect(runCli(["pin", handoffId, "--as-user", "--json"], capture().ports)).toBe(0);
    expect(runCli(["archive", handoffId, "--as-user", "--json"], capture().ports)).toBe(0);

    // Step 9: the tombstone holds no current Artifact row, no Note, no pending intent.
    const after = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const row = after.prepare("SELECT deleted_at, current_artifact_id FROM handoffs WHERE id = ?").get(handoffId) as {
        deleted_at: string | null;
        current_artifact_id: string | null;
      };
      expect(row.deleted_at).not.toBeNull();
      expect(row.current_artifact_id).toBeNull();
      expect(after.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE handoff_id = ?").get(handoffId)).toMatchObject({
        c: 0,
      });
      expect(after.prepare("SELECT COUNT(*) AS c FROM review_notes WHERE handoff_id = ?").get(handoffId)).toMatchObject(
        { c: 0 },
      );
      expect(after.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
      expect(eventsOf(home, "DELETION_APPROVED")).toHaveLength(1);
      expect(eventsOf(home, "ARTIFACT_UNLINKED")).toHaveLength(1);
    } finally {
      after.close();
    }
    process.chdir(original);
  });

  it("replays a deletion approval under an idempotency key and refuses a different request (section 17.3)", () => {
    const original = process.cwd();
    const { home, workB } = setup();
    const first = sendOne(home);
    const second = sendOne(home);

    process.chdir(workB);
    expect(
      runCli(["accept", first, "--expected-revision", "1", "--expected-row-version", "1", "--json"], capture().ports),
    ).toBe(0);
    expect(runCli(["delete", "request", first, "--json"], capture().ports)).toBe(0);
    const approved = capture();
    expect(
      runCli(
        ["delete", "approve", first, "--as-user", "--confirm", "--idempotency-key", "k-approve-1", "--json"],
        approved.ports,
      ),
    ).toBe(0);
    expect(eventsOf(home, "DELETION_APPROVED")).toHaveLength(1);

    // The identical retry replays the recorded approval instead of meeting HANDOFF_DELETED
    // on the tombstone the first call created, because replay is evaluated first.
    const replayed = capture();
    expect(
      runCli(
        ["delete", "approve", first, "--as-user", "--confirm", "--idempotency-key", "k-approve-1", "--json"],
        replayed.ports,
      ),
    ).toBe(0);
    const report = JSON.parse(replayed.outText()) as {
      data: { handoffId: string; deleted: boolean; warning: string; replayed: boolean };
    };
    expect(report.data.handoffId).toBe(first);
    expect(report.data.deleted).toBe(true);
    expect(report.data.warning).toContain("prior Git commits may retain earlier content");
    expect(report.data.replayed).toBe(true);
    expect(eventsOf(home, "DELETION_APPROVED")).toHaveLength(1);

    // The same key naming a different Handoff is a different request.
    expect(
      runCli(["accept", second, "--expected-revision", "1", "--expected-row-version", "1", "--json"], capture().ports),
    ).toBe(0);
    expect(runCli(["delete", "request", second, "--json"], capture().ports)).toBe(0);
    const conflict = capture();
    expect(
      runCli(
        ["delete", "approve", second, "--as-user", "--confirm", "--idempotency-key", "k-approve-1", "--json"],
        conflict.ports,
      ),
    ).toBe(75);
    expect((JSON.parse(conflict.errText()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
    process.chdir(original);
  });

  it("enforces the archive and unarchive rules and the duplicate request", () => {
    const original = process.cwd();
    const { home, workA, workB } = setup();
    const handoffId = sendOne(home);

    process.chdir(workA);
    const earlyArchive = capture();
    expect(runCli(["archive", handoffId, "--as-user", "--json"], earlyArchive.ports)).toBe(65);
    expect((JSON.parse(earlyArchive.errText()) as { error: { code: string } }).error.code).toBe(
      "HANDOFF_ARCHIVE_INVALID",
    );

    const notArchived = capture();
    expect(runCli(["unarchive", handoffId, "--as-user", "--json"], notArchived.ports)).toBe(65);
    expect((JSON.parse(notArchived.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_NOT_ARCHIVED");

    expect(runCli(["delete", "request", handoffId, "--json"], capture().ports)).toBe(0);
    const duplicate = capture();
    expect(runCli(["delete", "request", handoffId, "--json"], duplicate.ports)).toBe(75);
    expect((JSON.parse(duplicate.errText()) as { error: { code: string } }).error.code).toBe(
      "DELETION_ALREADY_REQUESTED",
    );

    process.chdir(workB);
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "2", "--json"],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workA);
    expect(runCli(["delete", "reject", handoffId, "--as-user", "--json"], capture().ports)).toBe(0);
    expect(runCli(["archive", handoffId, "--as-user", "--json"], capture().ports)).toBe(0);
    process.chdir(workB);
    const archivedListing = capture();
    expect(runCli(["inbox", "--include-archived", "--json"], archivedListing.ports)).toBe(0);
    expect(archivedListing.outText()).toContain(handoffId);
    const defaultListing = capture();
    expect(runCli(["inbox", "--json"], defaultListing.ports)).toBe(0);
    expect(defaultListing.outText()).not.toContain(handoffId);
    process.chdir(original);
  });

  it("drains pending intents at start before approving a deletion, and the human message names the Git caveat", () => {
    const original = process.cwd();
    const { home, workA, workB } = setup();
    const handoffId = sendOne(home);

    process.chdir(workB);
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "1", "--json"],
        capture().ports,
      ),
    ).toBe(0);
    process.chdir(workA);
    expect(runCli(["delete", "request", handoffId, "--json"], capture().ports)).toBe(0);

    // A stale intent from an earlier crashed process waits in the log (CP-6 shape).
    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      database
        .prepare(
          "INSERT INTO pending_fs_ops (id, op, from_path, to_path, artifact_id, created_at, attempts) VALUES ('i-stale', 'unlink', NULL, 'artifacts/gone/none', NULL, '2026-01-01T00:00:00.000Z', 0)",
        )
        .run();
    } finally {
      database.close();
    }

    const approved = capture();
    expect(runCli(["delete", "approve", handoffId, "--as-user", "--confirm"], approved.ports)).toBe(0);
    expect(approved.outText()).toContain("prior Git commits may retain earlier content");

    // The approval drained the stale intent at start (RUN-002): nothing is left pending.
    const after = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      expect(after.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
    } finally {
      after.close();
    }
    process.chdir(original);
  });
});
