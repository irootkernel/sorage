import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, errorEnvelopeOf, runCleanups, sorage, twoProjectFixture } from "./helpers";

/** AJ-10: the two-phase deletion - request, the guarded approval, rejection, and the tombstone. */
afterAll(runCleanups);

describe("AJ-10 deletion", () => {
  it("requests deletion, refuses a non-terminal approval and a non-User one, and rejects with a record", () => {
    const fixture = twoProjectFixture("aj10-reject");
    const id = fixture.sendTo("a", "b", "Deletion rejection");

    const request = sorage(["delete", "request", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(request.status).toBe(0);
    const again = sorage(["delete", "request", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(again.status).toBe(75);
    expect(errorEnvelopeOf(again).error.code).toBe("DELETION_ALREADY_REQUESTED");

    const nonTerminal = sorage(["delete", "approve", id, "--as-user", "--confirm", "--json"], { home: fixture.home });
    expect(nonTerminal.status).toBe(65);
    expect(errorEnvelopeOf(nonTerminal).error.code).toBe("HANDOFF_NOT_TERMINAL");

    expect(
      sorage(["decline", id, "--reason", "Closing", "--expected-row-version", "2", "--json"], {
        home: fixture.home,
        cwd: fixture.workB,
      }).status,
    ).toBe(0);
    const gate = sorage(["delete", "approve", id, "--confirm", "--json"], { home: fixture.home });
    expect(gate.status).toBe(77);
    expect(errorEnvelopeOf(gate).error.code).toBe("USER_CONTEXT_REQUIRED");

    const reject = sorage(["delete", "reject", id, "--as-user", "--json"], { home: fixture.home });
    expect(reject.status).toBe(0);
    const kept = sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(kept.status).toBe(0);
  });

  it("approves a terminal Handoff into a tombstone with the honest Git wording", () => {
    const fixture = twoProjectFixture("aj10-approve");
    const id = fixture.sendTo("a", "b", "Deletion approval");
    expect(
      sorage(["accept", id, "--expected-revision", "1", "--expected-row-version", "1", "--json"], {
        home: fixture.home,
        cwd: fixture.workB,
      }).status,
    ).toBe(0);
    expect(sorage(["delete", "request", id, "--json"], { home: fixture.home, cwd: fixture.workB }).status).toBe(0);

    const approve = sorage(["delete", "approve", id, "--as-user", "--confirm", "--json"], { home: fixture.home });
    expect(approve.status).toBe(0);

    for (const args of [
      ["fetch", id],
      ["revise", id, "--no-change", "--reason", "gone"],
      ["review", "set", id, "--text", "gone"],
      ["accept", id, "--expected-revision", "1", "--expected-row-version", "1"],
      ["delete", "request", id],
    ]) {
      const refused = sorage([...args, "--json"], { home: fixture.home, cwd: fixture.workB });
      expect(refused.status, args.join(" ")).toBe(65);
      expect(errorEnvelopeOf(refused).error.code, args.join(" ")).toBe("HANDOFF_DELETED");
    }

    const got = sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(got.status).toBe(0);
    const listed = sorage(["inbox", "--include-deleted", "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(listed.stdout).toContain(id);
    expect(sorage(["pin", id, "--as-user", "--json"], { home: fixture.home }).status).toBe(0);
    expect(sorage(["unpin", id, "--as-user", "--json"], { home: fixture.home }).status).toBe(0);
  });

  it("requires the distinct pinned confirmation before deleting a pinned Handoff", () => {
    const fixture = twoProjectFixture("aj10-pinned");
    const id = fixture.sendTo("a", "b", "Pinned deletion");
    expect(
      sorage(["accept", id, "--expected-revision", "1", "--expected-row-version", "1", "--json"], {
        home: fixture.home,
        cwd: fixture.workB,
      }).status,
    ).toBe(0);
    expect(sorage(["pin", id, "--as-user", "--json"], { home: fixture.home }).status).toBe(0);
    expect(sorage(["delete", "request", id, "--json"], { home: fixture.home, cwd: fixture.workB }).status).toBe(0);

    const blanket = sorage(["delete", "approve", id, "--as-user", "--confirm", "--json"], { home: fixture.home });
    expect(blanket.status).toBe(64);
    expect(errorEnvelopeOf(blanket).error.code).toBe("PINNED_DELETE_CONFIRMATION");

    const distinct = sorage(["delete", "approve", id, "--as-user", "--confirm", "--confirm-pinned", id, "--json"], {
      home: fixture.home,
    });
    expect(distinct.status).toBe(0);
    const gone = sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect((envelopeOf(gone) as { data: { deletedAt: string | null } }).data.deletedAt).not.toBeNull();
  });
});
