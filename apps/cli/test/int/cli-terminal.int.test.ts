import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-033 terminal transitions through the real CLI, closing with the complete
 * AJ-04 loop run end to end from the two working directories: send, inbox, get and
 * fetch, review set, revise, and accept, with the guard matrix around the three
 * terminal commands.
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

function fixture(): { home: string; workA: string; workB: string } {
  const home = tempHome("sorage-terminal-cli-");
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

function handoffIdOf(sendOutput: string): string {
  return (JSON.parse(sendOutput) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
    ?.handoffId as string;
}

describe("the AJ-04 loop and the terminal guards", () => {
  it("runs send, inbox, get, fetch, review set, revise, and accept from two directories", () => {
    const original = process.cwd();
    const { home, workA, workB } = fixture();
    const document = join(home, "brief.md");

    // Step 1: send from A.
    process.chdir(workA);
    const send = capture();
    expect(
      runCli(
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
      ),
    ).toBe(0);
    const handoffId = handoffIdOf(send.outText());

    // Step 3: inbox from B.
    process.chdir(workB);
    const inbox = capture();
    expect(runCli(["inbox", "--json"], inbox.ports)).toBe(0);
    expect(inbox.outText()).toContain(handoffId);

    // Step 4: get records nothing.
    expect(runCli(["get", handoffId, "--json"], capture().ports)).toBe(0);

    // Step 5: the recipient fetch records the first fetch; Row Version stays 1.
    expect(runCli(["fetch", handoffId, "--json"], capture().ports)).toBe(0);

    // Step 6: review set moves to changes_requested at rowVersion 2.
    expect(runCli(["review", "set", handoffId, "--text", "tighten", "--json"], capture().ports)).toBe(0);

    // Step 7: revise from A; the uniform --expected-row-version enforcement lands with TASK-036.
    const replacement = join(home, "brief-v2.md");
    writeFileSync(replacement, "# Shared, revised\n");
    process.chdir(workA);
    const revise = capture();
    const reviseExit = runCli(
      ["revise", handoffId, "--file", replacement, "--allow-external-source", "--json"],
      revise.ports,
    );
    if (reviseExit !== 0) throw new Error(`loop revise failed (${reviseExit}): ${revise.errText()}`);
    expect(reviseExit).toBe(0);

    // Step 8: a non-participant read discloses nothing.
    const outsider = mkdtempSync(join(tmpdir(), "sorage-loop-outsider-"));
    homes.push(outsider);
    process.chdir(outsider);
    const stranger = capture();
    expect(runCli(["get", handoffId, "--json"], stranger.ports)).toBe(66);

    // Step 9: accept from B at revision 2 and rowVersion 3.
    process.chdir(workB);
    const accept = capture();
    const acceptExit = runCli(
      ["accept", handoffId, "--expected-revision", "2", "--expected-row-version", "3", "--json"],
      accept.ports,
    );
    if (acceptExit !== 0) throw new Error(`loop accept failed (${acceptExit}): ${accept.errText()}`);
    expect(acceptExit).toBe(0);
    const accepted = JSON.parse(accept.outText()) as { data: { reviewState: string; acceptedRevision: number } };
    expect(accepted.data.reviewState).toBe("accepted");
    expect(accepted.data.acceptedRevision).toBe(2);
    // LIFE-004: the acceptance timestamp is recorded with the Revision (acceptedAt).
    const acceptedRow = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const row = acceptedRow.prepare("SELECT accepted_at FROM handoffs WHERE id = ?").get(handoffId) as {
        accepted_at: string | null;
      };
      expect(row.accepted_at).not.toBeNull();
    } finally {
      acceptedRow.close();
    }

    // Step 10: terminal content operations refuse with HANDOFF_TERMINAL, from the sender side.
    process.chdir(workA);
    const reviseRefused = capture();
    expect(
      runCli(["revise", handoffId, "--file", replacement, "--allow-external-source", "--json"], reviseRefused.ports),
    ).toBe(65);
    expect((JSON.parse(reviseRefused.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_TERMINAL");
    const noteRefused = capture();
    expect(runCli(["review", "set", handoffId, "--text", "late", "--json"], noteRefused.ports)).toBe(65);
    process.chdir(original);
  });

  it("runs the AJ-06 fan-out loop: divergent reviews on siblings stay independent", () => {
    const original = process.cwd();
    const home = tempHome("sorage-terminal-cli-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const workA = join(home, "work-a");
    const workB = join(home, "work-b");
    const workC = join(home, "work-c");
    const workD = join(home, "work-d");
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    mkdirSync(workC, { recursive: true });
    mkdirSync(workD, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Gamma", "--dir", workC], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Delta", "--dir", workD], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# Shared\n");

    // Step 1: one fan-out to three recipients — three UUIDs, one Dispatch Group.
    process.chdir(workA);
    const send = capture();
    const sendExit = runCli(
      [
        "send",
        "--as",
        "alpha",
        "--to",
        "beta",
        "--to",
        "gamma",
        "--to",
        "delta",
        "--title",
        "Brief",
        "--file",
        document,
        "--allow-external-source",
        "--json",
      ],
      send.ports,
    );
    if (sendExit !== 0) throw new Error(`fan-out send failed: ${send.errText()}`);
    const sent = JSON.parse(send.outText()) as {
      data: { handoffs: Array<{ handoffId: string }>; dispatchGroupId: string | null };
    };
    expect(sent.data.handoffs).toHaveLength(3);
    expect(sent.data.dispatchGroupId).not.toBeNull();
    const [forBeta, forGamma, forDelta] = sent.data.handoffs.map((handoff) => handoff.handoffId) as [
      string,
      string,
      string,
    ];

    // Steps 2-3: B and C request different changes while D accepts at Revision 1.
    process.chdir(workB);
    expect(runCli(["review", "set", forBeta, "--text", "tighten the intro", "--json"], capture().ports)).toBe(0);
    process.chdir(workC);
    expect(runCli(["review", "set", forGamma, "--text", "add a section", "--json"], capture().ports)).toBe(0);
    process.chdir(workD);
    expect(
      runCli(
        ["accept", forDelta, "--expected-revision", "1", "--expected-row-version", "1", "--json"],
        capture().ports,
      ),
    ).toBe(0);

    // Independence: B's own inbox holds B's review request and neither sibling's.
    process.chdir(workB);
    const betaInbox = capture();
    expect(runCli(["inbox", "--state", "changes_requested", "--json"], betaInbox.ports)).toBe(0);
    expect(betaInbox.outText()).toContain(forBeta);
    expect(betaInbox.outText()).not.toContain(forGamma);
    expect(betaInbox.outText()).not.toContain(forDelta);

    // Step 4: the sender revises B and C independently, then B accepts and C declines.
    const betaReplacement = join(home, "brief-beta.md");
    writeFileSync(betaReplacement, "# Shared, revised for Beta\n");
    const gammaReplacement = join(home, "brief-gamma.md");
    writeFileSync(gammaReplacement, "# Shared, revised for Gamma\n");
    process.chdir(workA);
    expect(
      runCli(["revise", forBeta, "--file", betaReplacement, "--allow-external-source", "--json"], capture().ports),
    ).toBe(0);
    const gammaRevised = capture();
    expect(
      runCli(["revise", forGamma, "--file", gammaReplacement, "--allow-external-source", "--json"], gammaRevised.ports),
    ).toBe(0);
    const gammaReport = JSON.parse(gammaRevised.outText()) as { data: { revision: number; reviewState: string } };
    expect(gammaReport.data.revision).toBe(2);
    expect(gammaReport.data.reviewState).toBe("awaiting_recipient");

    process.chdir(workB);
    expect(
      runCli(["accept", forBeta, "--expected-revision", "2", "--expected-row-version", "3", "--json"], capture().ports),
    ).toBe(0);
    process.chdir(workC);
    expect(
      runCli(["decline", forGamma, "--reason", "not needed", "--expected-row-version", "3", "--json"], capture().ports),
    ).toBe(0);

    // Expected: no operation on one Handoff changed another — D stayed accepted at
    // Revision 1 from before the reviews, B accepted at Revision 2, C declined.
    process.chdir(workA);
    const deltaTerminal = capture();
    expect(
      runCli(["revise", forDelta, "--file", document, "--allow-external-source", "--json"], deltaTerminal.ports),
    ).toBe(65);
    expect((JSON.parse(deltaTerminal.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_TERMINAL");
    process.chdir(workB);
    const betaInboxFinal = capture();
    expect(runCli(["inbox", "--json"], betaInboxFinal.ports)).toBe(0);
    expect(betaInboxFinal.outText()).toContain(forBeta);
    process.chdir(original);
  });

  it("guards accept with the Note, materialization, and stale expectations", () => {
    const original = process.cwd();
    const { home, workA, workB } = fixture();
    const document = join(home, "brief.md");
    process.chdir(workA);
    const send = capture();
    expect(
      runCli(
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
      ),
    ).toBe(0);
    const handoffId = handoffIdOf(send.outText());

    process.chdir(workB);
    const withNote = capture();
    expect(runCli(["review", "set", handoffId, "--text", "blocked", "--json"], withNote.ports)).toBe(0);
    const noteBlocked = capture();
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "2", "--json"],
        noteBlocked.ports,
      ),
    ).toBe(75);
    expect((JSON.parse(noteBlocked.errText()) as { error: { code: string } }).error.code).toBe("REVIEW_NOTE_PRESENT");

    // Withdraw the note, then prove the stale guards.
    expect(runCli(["review", "withdraw", handoffId, "--json"], capture().ports)).toBe(0);
    const staleRevision = capture();
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "7", "--expected-row-version", "3", "--json"],
        staleRevision.ports,
      ),
    ).toBe(75);
    expect((JSON.parse(staleRevision.errText()) as { error: { code: string } }).error.code).toBe("REVISION_CONFLICT");
    const staleRowVersion = capture();
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "9", "--json"],
        staleRowVersion.ports,
      ),
    ).toBe(75);
    expect((JSON.parse(staleRowVersion.errText()) as { error: { code: string } }).error.code).toBe(
      "ROW_VERSION_CONFLICT",
    );

    const unmaterialized = capture();
    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      database.prepare("UPDATE artifacts SET materialized = 0").run();
    } finally {
      database.close();
    }
    expect(
      runCli(
        ["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "3", "--json"],
        unmaterialized.ports,
      ),
    ).toBe(75);
    expect((JSON.parse(unmaterialized.errText()) as { error: { code: string } }).error.code).toBe(
      "ARTIFACT_MATERIALIZING",
    );

    // Restore materialization and accept for real.
    const restore = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      restore.prepare("UPDATE artifacts SET materialized = 1").run();
    } finally {
      restore.close();
    }
    const accept = capture();
    expect(
      runCli(["accept", handoffId, "--expected-revision", "1", "--expected-row-version", "3", "--json"], accept.ports),
    ).toBe(0);
    process.chdir(original);
  });

  it("declines with a reason and withdraws only before engagement", () => {
    const original = process.cwd();
    const { home, workA, workB } = fixture();
    const document = join(home, "brief.md");
    process.chdir(workA);
    const send = capture();
    expect(
      runCli(
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
      ),
    ).toBe(0);
    const handoffId = handoffIdOf(send.outText());

    // Withdraw works before any fetch or review.
    const withdrawn = capture();
    expect(runCli(["withdraw", handoffId, "--json"], withdrawn.ports)).toBe(0);

    // A fetched Handoff can no longer be withdrawn.
    const send2 = capture();
    expect(
      runCli(
        [
          "send",
          "--as",
          "alpha",
          "--to",
          "beta",
          "--title",
          "Second",
          "--file",
          document,
          "--allow-external-source",
          "--json",
        ],
        send2.ports,
      ),
    ).toBe(0);
    const second = handoffIdOf(send2.outText());
    process.chdir(workB);
    expect(runCli(["fetch", second, "--json"], capture().ports)).toBe(0);
    process.chdir(workA);
    const fetched = capture();
    expect(runCli(["withdraw", second, "--json"], fetched.ports)).toBe(65);
    expect((JSON.parse(fetched.errText()) as { error: { code: string } }).error.code).toBe("HANDOFF_ALREADY_FETCHED");

    // A Note present blocks withdraw and decline closes the exchange with a reason.
    process.chdir(workB);
    expect(runCli(["review", "set", second, "--text", "no", "--json"], capture().ports)).toBe(0);
    process.chdir(workA);
    const blocked = capture();
    expect(runCli(["withdraw", second, "--json"], blocked.ports)).toBe(75);
    expect((JSON.parse(blocked.errText()) as { error: { code: string } }).error.code).toBe("REVIEW_NOTE_PRESENT");

    process.chdir(workB);
    const declined = capture();
    expect(
      runCli(["decline", second, "--reason", "out of scope", "--expected-row-version", "2", "--json"], declined.ports),
    ).toBe(0);
    const declinedReport = JSON.parse(declined.outText()) as { data: { reviewState: string } };
    expect(declinedReport.data.reviewState).toBe("declined");

    // The reason is recorded.
    const database = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const row = database.prepare("SELECT declined_at, decline_reason FROM handoffs WHERE id = ?").get(second) as {
        declined_at: string | null;
        decline_reason: string | null;
      };
      expect(row.declined_at).not.toBeNull();
      expect(row.decline_reason).toBe("out of scope");
    } finally {
      database.close();
    }
    process.chdir(original);
  });
});
