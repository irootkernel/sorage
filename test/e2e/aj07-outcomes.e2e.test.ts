import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { errorEnvelopeOf, runCleanups, sorage, twoProjectFixture } from "./helpers";

/** AJ-07: the terminal-alternative matrix - decline, withdraw, Note withdrawal, the no-change bound, and removal. */
afterAll(runCleanups);

describe("AJ-07 terminal alternatives", () => {
  it("declines with a recorded reason", () => {
    const fixture = twoProjectFixture("aj07-decline");
    const id = fixture.sendTo("a", "b", "Decline me");
    const run = sorage(["decline", id, "--reason", "Wrong scope", "--expected-row-version", "1", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(run.status).toBe(0);
  });

  it("refuses withdrawal once the recipient has fetched or reviewed", () => {
    const fixture = twoProjectFixture("aj07-withdraw");
    const fetched = fixture.sendTo("a", "b", "Fetched then withdraw");
    expect(sorage(["fetch", fetched, "--json"], { home: fixture.home, cwd: fixture.workB }).status).toBe(0);
    const refused = sorage(["withdraw", fetched, "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(refused.status).toBe(65);
    expect(errorEnvelopeOf(refused).error.code).toBe("HANDOFF_ALREADY_FETCHED");

    const reviewed = fixture.sendTo("a", "b", "Reviewed then withdraw");
    expect(
      sorage(["review", "set", reviewed, "--text", "Note", "--json"], { home: fixture.home, cwd: fixture.workB })
        .status,
    ).toBe(0);
    const refusedNote = sorage(["withdraw", reviewed, "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(refusedNote.status).toBe(75);
    expect(errorEnvelopeOf(refusedNote).error.code).toBe("REVIEW_NOTE_PRESENT");

    // A withdrawal before any engagement still works.
    const untouched = fixture.sendTo("a", "b", "Untouched");
    expect(sorage(["withdraw", untouched, "--json"], { home: fixture.home, cwd: fixture.workA }).status).toBe(0);
  });

  it("bounds the no-change resolution and resets it on content revision", () => {
    const fixture = twoProjectFixture("aj07-nochange");
    const id = fixture.sendTo("a", "b", "No-change bound");
    expect(
      sorage(["review", "set", id, "--text", "Change it", "--json"], { home: fixture.home, cwd: fixture.workB }).status,
    ).toBe(0);
    const first = sorage(["revise", id, "--no-change", "--reason", "Addressed by the reply", "--json"], {
      home: fixture.home,
      cwd: fixture.workA,
    });
    expect(first.status).toBe(0);
    expect(
      sorage(["review", "set", id, "--text", "Still wrong", "--json"], { home: fixture.home, cwd: fixture.workB })
        .status,
    ).toBe(0);
    const second = sorage(["revise", id, "--no-change", "--reason", "Again", "--json"], {
      home: fixture.home,
      cwd: fixture.workA,
    });
    expect(second.status).toBe(65);
    expect(errorEnvelopeOf(second).error.code).toBe("NO_CHANGE_LIMIT");
    // A content revision resets the bound.
    writeFileSync(join(fixture.home, "changed.md"), "# Changed\n", "utf8");
    const content = sorage(
      ["revise", id, "--file", join(fixture.home, "changed.md"), "--allow-external-source", "--json"],
      { home: fixture.home, cwd: fixture.workA },
    );
    expect(content.status).toBe(0);
    expect(
      sorage(["review", "set", id, "--text", "Once more", "--json"], { home: fixture.home, cwd: fixture.workB }).status,
    ).toBe(0);
    expect(
      sorage(["revise", id, "--no-change", "--reason", "Fine now", "--json"], {
        home: fixture.home,
        cwd: fixture.workA,
      }).status,
    ).toBe(0);
    // Without a Note there is nothing to resolve.
    const noNote = sorage(
      ["revise", fixture.sendTo("a", "b", "No note here"), "--no-change", "--reason", "Nothing", "--json"],
      { home: fixture.home, cwd: fixture.workA },
    );
    expect(noNote.status).toBe(65);
    expect(errorEnvelopeOf(noNote).error.code).toBe("NO_REVIEW_NOTE");
  });

  it("withdraws and removes Notes, with removal gated on the User", () => {
    const fixture = twoProjectFixture("aj07-notes");
    const id = fixture.sendTo("a", "b", "Notes");
    expect(
      sorage(["review", "set", id, "--text", "Withdraw me", "--json"], { home: fixture.home, cwd: fixture.workB })
        .status,
    ).toBe(0);
    const withdraw = sorage(["review", "withdraw", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(withdraw.status).toBe(0);

    expect(
      sorage(["review", "set", id, "--text", "Remove me", "--json"], { home: fixture.home, cwd: fixture.workB }).status,
    ).toBe(0);
    const gate = sorage(["review", "remove", id, "--confirm", "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(gate.status).toBe(77);
    expect(errorEnvelopeOf(gate).error.code).toBe("USER_CONTEXT_REQUIRED");
    const remove = sorage(["review", "remove", id, "--as-user", "--confirm", "--json"], { home: fixture.home });
    expect(remove.status).toBe(0);
  });
});
