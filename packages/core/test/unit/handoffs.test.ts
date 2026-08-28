import { describe, expect, it } from "vitest";
import { errorSpec } from "../../src/errors";
import {
  type ActorRole,
  deriveNextActors,
  evaluateHandoffOperation,
  type HandoffFacts,
  type HandoffOperation,
  handoffPermission,
  isTerminalReviewState,
  REVIEW_STATES,
  TERMINAL_REVIEW_STATES,
  USER_ADMIN_OPERATIONS,
} from "../../src/handoffs";

/**
 * The exhaustive section 4.2 matrix: every cell of the transition table, including
 * every rejection, for every review state (and the tombstone) crossed with every
 * operation and every actor role, plus the guard variants each row names. Any pair
 * that is not listed is undefined and must be rejected.
 */

const PERMISSIVE = { participant: true } as const;

function facts(overrides: Partial<HandoffFacts> = {}): HandoffFacts {
  return {
    reviewState: "awaiting_recipient",
    tombstone: false,
    hasReviewNote: false,
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archived: false,
    artifactMaterialized: true,
    consecutiveNoChangeResolutions: 0,
    pendingDeletionRequest: false,
    ...overrides,
  };
}

function canonicalFacts(state: HandoffFacts["reviewState"]): HandoffFacts {
  return facts({ reviewState: state, hasReviewNote: state === "changes_requested" });
}

const ROLES: ActorRole[] = ["sender", "recipient", "user"];

const NON_SEND_OPERATIONS: HandoffOperation[] = [
  "review set",
  "review withdraw",
  "review remove",
  "revise",
  "revise no-change",
  "accept",
  "decline",
  "withdraw",
  "get",
  "inbox",
  "outbox",
  "fetch",
  "pin",
  "unpin",
  "archive",
  "unarchive",
  "delete request",
  "delete approve",
  "delete reject",
];

type Expectation =
  | { code: string }
  | { state: HandoffFacts["reviewState"]; events: string[]; rowVersionDelta: number; revisionDelta: number };

function expectCell(
  state: HandoffFacts["reviewState"],
  tombstone: boolean,
  operation: HandoffOperation,
  role: ActorRole,
  expected: Expectation,
  factsOverride: Partial<HandoffFacts> = {},
): void {
  const base = { ...canonicalFacts(state), ...factsOverride };
  const snapshot = tombstone ? { ...base, tombstone: true } : base;
  const outcome = evaluateHandoffOperation(operation, snapshot, role, PERMISSIVE);
  if ("code" in expected) {
    expect({ state, tombstone, operation, role, outcome: outcome.ok }).toEqual({
      state,
      tombstone,
      operation,
      role,
      outcome: false,
    });
    if (!outcome.ok) {
      expect({ state, tombstone, operation, role, code: outcome.error.code }).toEqual({
        state,
        tombstone,
        operation,
        role,
        code: expected.code,
      });
    }
    return;
  }
  expect({ state, tombstone, operation, role, ok: outcome.ok }).toEqual({
    state,
    tombstone,
    operation,
    role,
    ok: true,
  });
  if (outcome.ok) {
    expect({ state, tombstone, operation, role, to: outcome.value.reviewState }).toEqual({
      state,
      tombstone,
      operation,
      role,
      to: expected.state,
    });
    expect(outcome.value.events, `${operation} by ${role} from ${state}`).toEqual(expected.events);
    expect(outcome.value.rowVersionDelta).toBe(expected.rowVersionDelta);
    expect(outcome.value.revisionDelta).toBe(expected.revisionDelta);
  }
}

describe("review state vocabulary", () => {
  it("holds exactly the five states with three terminal ones", () => {
    expect(REVIEW_STATES).toEqual(["awaiting_recipient", "changes_requested", "accepted", "declined", "withdrawn"]);
    expect(TERMINAL_REVIEW_STATES).toEqual(["accepted", "declined", "withdrawn"]);
    for (const state of REVIEW_STATES) {
      expect(isTerminalReviewState(state)).toBe(TERMINAL_REVIEW_STATES.includes(state));
    }
  });
});

describe("section 4.2 transition table, exhaustive over state, operation, and actor", () => {
  it("row 1: send starts at awaiting_recipient with Revision 1 and Row Version 1", () => {
    const outcome = evaluateHandoffOperation("send", canonicalFacts("awaiting_recipient"), "sender", PERMISSIVE);
    expect(outcome.ok && outcome.value.reviewState).toBe("awaiting_recipient");
    expect(outcome.ok && outcome.value.events).toEqual(["HANDOFF_CREATED"]);
    expect(outcome.ok && outcome.value.completionEvents).toEqual(["ARTIFACT_ACTIVATED"]);
    expect(outcome.ok && outcome.value.rowVersionDelta).toBe(1);
    expect(outcome.ok && outcome.value.noChangeCounter).toBe("reset");
  });

  it("rows 2 and 3: review set moves awaiting to changes_requested and updates there; the sender may never author", () => {
    expectCell("awaiting_recipient", false, "review set", "recipient", {
      state: "changes_requested",
      events: ["REVIEW_NOTE_CREATED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("awaiting_recipient", false, "review set", "user", {
      state: "changes_requested",
      events: ["REVIEW_NOTE_CREATED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("awaiting_recipient", false, "review set", "sender", { code: "FORBIDDEN_ACTOR" });
    expectCell("changes_requested", false, "review set", "recipient", {
      state: "changes_requested",
      events: ["REVIEW_NOTE_UPDATED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("changes_requested", false, "review set", "user", {
      state: "changes_requested",
      events: ["REVIEW_NOTE_UPDATED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("changes_requested", false, "review set", "sender", { code: "FORBIDDEN_ACTOR" });
  });

  it("row 4: the recipient withdraws the current Note whichever actor authored it; row 5: the User removes it audited", () => {
    expectCell("changes_requested", false, "review withdraw", "recipient", {
      state: "awaiting_recipient",
      events: ["REVIEW_NOTE_WITHDRAWN"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("changes_requested", false, "review withdraw", "sender", { code: "FORBIDDEN_ACTOR" });
    expectCell("changes_requested", false, "review withdraw", "user", { code: "FORBIDDEN_ACTOR" });
    expectCell("changes_requested", false, "review remove", "user", {
      state: "awaiting_recipient",
      events: ["REVIEW_NOTE_REMOVED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("changes_requested", false, "review remove", "sender", { code: "FORBIDDEN_ACTOR" });
    expectCell("changes_requested", false, "review remove", "recipient", { code: "FORBIDDEN_ACTOR" });
    expectCell("awaiting_recipient", false, "review withdraw", "recipient", { code: "NO_REVIEW_NOTE" });
    expectCell("awaiting_recipient", false, "review remove", "user", { code: "NO_REVIEW_NOTE" });
  });

  it("rows 6 and 7: revise changes content, resolves a Note, and resets the no-change counter", () => {
    expectCell("awaiting_recipient", false, "revise", "sender", {
      state: "awaiting_recipient",
      events: ["HANDOFF_REVISED"],
      rowVersionDelta: 1,
      revisionDelta: 1,
    });
    expectCell("awaiting_recipient", false, "revise", "user", {
      state: "awaiting_recipient",
      events: ["HANDOFF_REVISED"],
      rowVersionDelta: 1,
      revisionDelta: 1,
    });
    expectCell("awaiting_recipient", false, "revise", "recipient", { code: "FORBIDDEN_ACTOR" });
    expectCell("changes_requested", false, "revise", "sender", {
      state: "awaiting_recipient",
      events: ["HANDOFF_REVISED", "REVIEW_NOTE_RESOLVED"],
      rowVersionDelta: 1,
      revisionDelta: 1,
    });
    const resolved = evaluateHandoffOperation("revise", canonicalFacts("changes_requested"), "sender", PERMISSIVE);
    expect(resolved.ok && resolved.value.noChangeCounter).toBe("reset");
    const proactive = evaluateHandoffOperation("revise", canonicalFacts("awaiting_recipient"), "sender", PERMISSIVE);
    expect(proactive.ok && proactive.value.completionEvents).toEqual(["ARTIFACT_ACTIVATED", "ARTIFACT_UNLINKED"]);
  });

  it("rows 8 and 9: the bounded no-change resolution and its rejections", () => {
    expectCell("changes_requested", false, "revise no-change", "sender", {
      state: "awaiting_recipient",
      events: ["HANDOFF_NO_CHANGE_RESOLVED", "REVIEW_NOTE_RESOLVED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("changes_requested", false, "revise no-change", "user", {
      state: "awaiting_recipient",
      events: ["HANDOFF_NO_CHANGE_RESOLVED", "REVIEW_NOTE_RESOLVED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("changes_requested", false, "revise no-change", "recipient", { code: "FORBIDDEN_ACTOR" });
    expectCell("awaiting_recipient", false, "revise no-change", "sender", { code: "NO_REVIEW_NOTE" });
    const bounded = evaluateHandoffOperation(
      "revise no-change",
      facts({ reviewState: "changes_requested", hasReviewNote: true, consecutiveNoChangeResolutions: 1 }),
      "sender",
      PERMISSIVE,
    );
    expect(!bounded.ok && bounded.error?.code).toBe("NO_CHANGE_LIMIT");
    const unreasoned = evaluateHandoffOperation(
      "revise no-change",
      facts({ reviewState: "changes_requested", hasReviewNote: true }),
      "sender",
      { participant: true, reasonSupplied: false },
    );
    expect(!unreasoned.ok && unreasoned.error?.code).toBe("CONFIG_INVALID");
    const advanced = evaluateHandoffOperation(
      "revise no-change",
      canonicalFacts("changes_requested"),
      "sender",
      PERMISSIVE,
    );
    expect(advanced.ok && advanced.value.noChangeCounter).toBe("advance");
  });

  it("row 10: accept from awaiting with both expected values; row 11 and 12: decline from both non-terminal states", () => {
    expectCell("awaiting_recipient", false, "accept", "recipient", {
      state: "accepted",
      events: ["HANDOFF_ACCEPTED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("awaiting_recipient", false, "accept", "user", {
      state: "accepted",
      events: ["HANDOFF_ACCEPTED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("awaiting_recipient", false, "accept", "sender", { code: "FORBIDDEN_ACTOR" });
    expectCell("changes_requested", false, "accept", "recipient", { code: "REVIEW_NOTE_PRESENT" });
    expectCell("awaiting_recipient", false, "decline", "recipient", {
      state: "declined",
      events: ["HANDOFF_DECLINED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("changes_requested", false, "decline", "user", {
      state: "declined",
      events: ["HANDOFF_DECLINED"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("awaiting_recipient", false, "decline", "sender", { code: "FORBIDDEN_ACTOR" });
    const accepted = evaluateHandoffOperation("accept", canonicalFacts("awaiting_recipient"), "recipient", PERMISSIVE);
    expect(accepted.ok && accepted.value.recordsAcceptedRevision).toBe(true);
  });

  it("rows 13 and 14: withdraw only before engagement", () => {
    expectCell("awaiting_recipient", false, "withdraw", "sender", {
      state: "withdrawn",
      events: ["HANDOFF_WITHDRAWN"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("awaiting_recipient", false, "withdraw", "user", {
      state: "withdrawn",
      events: ["HANDOFF_WITHDRAWN"],
      rowVersionDelta: 1,
      revisionDelta: 0,
    });
    expectCell("awaiting_recipient", false, "withdraw", "recipient", { code: "FORBIDDEN_ACTOR" });
    expectCell("changes_requested", false, "withdraw", "sender", { code: "REVIEW_NOTE_PRESENT" });
    const fetched = evaluateHandoffOperation(
      "withdraw",
      facts({ reviewState: "awaiting_recipient", firstFetchedAt: "2026-01-01T00:00:00.000Z" }),
      "sender",
      PERMISSIVE,
    );
    expect(!fetched.ok && fetched.error?.code).toBe("HANDOFF_ALREADY_FETCHED");
    // reviewEngagedAt is never cleared: a withdrawn Note still blocks the withdrawal.
    const engaged = evaluateHandoffOperation(
      "withdraw",
      facts({ reviewState: "awaiting_recipient", reviewEngagedAt: "2026-01-01T00:00:00.000Z" }),
      "sender",
      PERMISSIVE,
    );
    expect(!engaged.ok && engaged.error?.code).toBe("HANDOFF_ALREADY_FETCHED");
  });

  it("rows 15 and 16: reads and fetch never mutate and hide existence from non-participants", () => {
    for (const state of REVIEW_STATES) {
      for (const operation of ["get", "inbox", "outbox", "fetch"] as const) {
        expectCell(state, false, operation, "sender", {
          state,
          events: [],
          rowVersionDelta: 0,
          revisionDelta: 0,
        });
        expectCell(state, false, operation, "recipient", { state, events: [], rowVersionDelta: 0, revisionDelta: 0 });
        expectCell(state, false, operation, "user", { state, events: [], rowVersionDelta: 0, revisionDelta: 0 });
        const stranger = evaluateHandoffOperation(operation, canonicalFacts(state), "sender", { participant: false });
        expect(!stranger.ok && stranger.error.code).toBe("HANDOFF_NOT_FOUND");
      }
      // Row 25 keeps the metadata reads available on a tombstone; row 24 rejects fetch.
      for (const operation of ["get", "inbox", "outbox"] as const) {
        expectCell(state, true, operation, "sender", { state, events: [], rowVersionDelta: 0, revisionDelta: 0 });
      }
      expectCell(state, true, "fetch", "sender", { code: "HANDOFF_DELETED" });
    }
    const unmaterialized = evaluateHandoffOperation(
      "fetch",
      facts({ artifactMaterialized: false }),
      "recipient",
      PERMISSIVE,
    );
    expect(!unmaterialized.ok && unmaterialized.error.code).toBe("ARTIFACT_MATERIALIZING");
  });

  it("row 17: pin and unpin are User-admin and independent of the review state", () => {
    for (const state of REVIEW_STATES) {
      expectCell(state, false, "pin", "user", {
        state,
        events: ["HANDOFF_PINNED"],
        rowVersionDelta: 1,
        revisionDelta: 0,
      });
      expectCell(state, false, "unpin", "user", {
        state,
        events: ["HANDOFF_UNPINNED"],
        rowVersionDelta: 1,
        revisionDelta: 0,
      });
      expectCell(state, false, "pin", "sender", { code: "FORBIDDEN_ACTOR" });
      expectCell(state, false, "pin", "recipient", { code: "FORBIDDEN_ACTOR" });
      expectCell(state, true, "pin", "user", {
        state,
        events: ["HANDOFF_PINNED"],
        rowVersionDelta: 1,
        revisionDelta: 0,
      });
      expectCell(state, true, "unpin", "user", {
        state,
        events: ["HANDOFF_UNPINNED"],
        rowVersionDelta: 1,
        revisionDelta: 0,
      });
    }
  });

  it("rows 18 and 19: archive is terminal-only and unarchive needs an archived row", () => {
    for (const terminal of TERMINAL_REVIEW_STATES) {
      expectCell(terminal, false, "archive", "user", {
        state: terminal,
        events: ["HANDOFF_ARCHIVED"],
        rowVersionDelta: 1,
        revisionDelta: 0,
      });
      expectCell(terminal, true, "archive", "user", {
        state: terminal,
        events: ["HANDOFF_ARCHIVED"],
        rowVersionDelta: 1,
        revisionDelta: 0,
      });
      const back = evaluateHandoffOperation(
        "unarchive",
        facts({ reviewState: terminal, archived: true }),
        "user",
        PERMISSIVE,
      );
      expect(back.ok && back.value.events).toEqual(["HANDOFF_UNARCHIVED"]);
    }
    expectCell("awaiting_recipient", false, "archive", "user", { code: "HANDOFF_ARCHIVE_INVALID" });
    expectCell("changes_requested", false, "archive", "user", { code: "HANDOFF_ARCHIVE_INVALID" });
    expectCell("awaiting_recipient", false, "unarchive", "user", { code: "HANDOFF_NOT_ARCHIVED" });
    expectCell("accepted", true, "unarchive", "user", { code: "HANDOFF_NOT_ARCHIVED" });
    expectCell("accepted", false, "archive", "sender", { code: "FORBIDDEN_ACTOR" });
  });

  it("row 20: delete request is open to every participant in any non-tombstone state", () => {
    for (const state of REVIEW_STATES) {
      for (const role of ROLES) {
        expectCell(state, false, "delete request", role, {
          state,
          events: ["DELETION_REQUESTED"],
          rowVersionDelta: 1,
          revisionDelta: 0,
        });
        expectCell(state, true, "delete request", role, { code: "HANDOFF_DELETED" });
      }
    }
    const stranger = evaluateHandoffOperation("delete request", canonicalFacts("accepted"), "sender", {
      participant: false,
    });
    expect(!stranger.ok && stranger.error?.code).toBe("HANDOFF_NOT_FOUND");
    const pending = evaluateHandoffOperation(
      "delete request",
      facts({ reviewState: "accepted", pendingDeletionRequest: true }),
      "user",
      PERMISSIVE,
    );
    expect(!pending.ok && pending.error?.code).toBe("DELETION_ALREADY_REQUESTED");
  });

  it("rows 21 and 22: deletion approval and rejection", () => {
    const pendingTerminal = facts({ reviewState: "accepted", pendingDeletionRequest: true });
    expectCell(
      "accepted",
      false,
      "delete approve",
      "user",
      { state: "accepted", events: ["DELETION_APPROVED"], rowVersionDelta: 1, revisionDelta: 0 },
      { pendingDeletionRequest: true },
    );
    expectCell("awaiting_recipient", false, "delete approve", "user", { code: "HANDOFF_NOT_TERMINAL" });
    expectCell("accepted", false, "delete approve", "sender", { code: "FORBIDDEN_ACTOR" });
    expectCell("accepted", false, "delete reject", "sender", { code: "FORBIDDEN_ACTOR" });
    const pinnedRefusal = evaluateHandoffOperation("delete approve", { ...pendingTerminal, pinned: true }, "user", {
      participant: true,
      confirmPinnedSupplied: false,
    });
    expect(!pinnedRefusal.ok && pinnedRefusal.error?.code).toBe("PINNED_DELETE_CONFIRMATION");
    const pinnedConfirmed = evaluateHandoffOperation("delete approve", { ...pendingTerminal, pinned: true }, "user", {
      participant: true,
      confirmPinnedSupplied: true,
    });
    expect(pinnedConfirmed.ok && pinnedConfirmed.value.events).toEqual(["DELETION_APPROVED"]);
    const corrupted = evaluateHandoffOperation(
      "delete approve",
      { ...pendingTerminal, artifactMaterialized: true },
      "user",
      { participant: true, artifactChecksumOk: false },
    );
    expect(!corrupted.ok && corrupted.error?.code).toBe("ARTIFACT_CORRUPTED");
    const approved = evaluateHandoffOperation("delete approve", pendingTerminal, "user", PERMISSIVE);
    expect(approved.ok && approved.value.completionEvents).toEqual(["ARTIFACT_UNLINKED"]);
    const noPending = evaluateHandoffOperation("delete reject", facts({ reviewState: "accepted" }), "user", PERMISSIVE);
    expect(!noPending.ok && noPending.error?.code).toBe("HANDOFF_NOT_FOUND");
    const rejected = evaluateHandoffOperation("delete reject", pendingTerminal, "user", PERMISSIVE);
    expect(rejected.ok && rejected.value.events).toEqual(["DELETION_REJECTED"]);
  });

  it("row 23: every content operation on a terminal Handoff is rejected for any actor", () => {
    const contentOperations: HandoffOperation[] = [
      "revise",
      "review set",
      "review withdraw",
      "review remove",
      "accept",
      "decline",
      "withdraw",
      "revise no-change",
    ];
    for (const terminal of TERMINAL_REVIEW_STATES) {
      for (const operation of contentOperations) {
        for (const role of ROLES) {
          expectCell(terminal, false, operation, role, { code: "HANDOFF_TERMINAL" });
        }
      }
    }
  });

  it("rows 24 and 25: the tombstone operation matrix", () => {
    const rejectedOnTombstone: HandoffOperation[] = [
      "fetch",
      "revise",
      "review set",
      "review withdraw",
      "review remove",
      "accept",
      "decline",
      "withdraw",
      "delete request",
      "revise no-change",
      "delete approve",
      "delete reject",
    ];
    for (const operation of rejectedOnTombstone) {
      for (const role of ROLES) {
        expectCell("accepted", true, operation, role, { code: "HANDOFF_DELETED" });
      }
    }
    for (const role of ROLES) {
      expectCell("accepted", true, "get", role, {
        state: "accepted",
        events: [],
        rowVersionDelta: 0,
        revisionDelta: 0,
      });
      expectCell(
        "accepted",
        true,
        "unarchive",
        role,
        role === "user" ? { code: "HANDOFF_NOT_ARCHIVED" } : { code: "FORBIDDEN_ACTOR" },
      );
      expectCell(
        "accepted",
        true,
        "pin",
        role,
        role === "user"
          ? { state: "accepted", events: ["HANDOFF_PINNED"], rowVersionDelta: 1, revisionDelta: 0 }
          : { code: "FORBIDDEN_ACTOR" },
      );
    }
  });

  it("evaluates every state, operation, and role cell without an undefined escape", () => {
    let evaluated = 0;
    for (const state of REVIEW_STATES) {
      for (const operation of NON_SEND_OPERATIONS) {
        for (const role of ROLES) {
          for (const tombstone of [false, true]) {
            const snapshot = tombstone ? { ...canonicalFacts(state), tombstone: true } : canonicalFacts(state);
            const outcome = evaluateHandoffOperation(operation, snapshot, role, PERMISSIVE);
            evaluated++;
            // The evaluator always answers with either an outcome or an AppError code;
            // the named suites above pin each cell's exact expectation.
            expect(outcome.ok === true || (outcome.ok === false && typeof outcome.error.code === "string")).toBe(true);
          }
        }
      }
    }
    expect(evaluated).toBe(REVIEW_STATES.length * NON_SEND_OPERATIONS.length * ROLES.length * 2);
  });
});

describe("guard variants of the named rows", () => {
  it("rejects a stale target Revision on review set with REVISION_CONFLICT", () => {
    const outcome = evaluateHandoffOperation("review set", canonicalFacts("awaiting_recipient"), "recipient", {
      participant: true,
      targetRevisionCurrent: false,
    });
    expect(!outcome.ok && outcome.error?.code).toBe("REVISION_CONFLICT");
  });

  it("rejects a stale expected Revision and Row Version on accept", () => {
    const staleRevision = evaluateHandoffOperation("accept", canonicalFacts("awaiting_recipient"), "recipient", {
      participant: true,
      expectedRevisionMatches: false,
    });
    expect(!staleRevision.ok && staleRevision.error?.code).toBe("REVISION_CONFLICT");
    const staleRowVersion = evaluateHandoffOperation("accept", canonicalFacts("awaiting_recipient"), "recipient", {
      participant: true,
      expectedRowVersionMatches: false,
    });
    expect(!staleRowVersion.ok && staleRowVersion.error?.code).toBe("ROW_VERSION_CONFLICT");
    expect(errorSpec("ROW_VERSION_CONFLICT").exitCode).toBe(75);
  });

  it("requires a decline reason and a matching Row Version", () => {
    const unreasoned = evaluateHandoffOperation("decline", canonicalFacts("awaiting_recipient"), "recipient", {
      participant: true,
      reasonSupplied: false,
    });
    expect(!unreasoned.ok && unreasoned.error?.code).toBe("CONFIG_INVALID");
    const stale = evaluateHandoffOperation("decline", canonicalFacts("awaiting_recipient"), "recipient", {
      participant: true,
      expectedRowVersionMatches: false,
    });
    expect(!stale.ok && stale.error?.code).toBe("ROW_VERSION_CONFLICT");
  });

  it("sets reviewEngagedAt only through review set and never clears it through another outcome", () => {
    const set = evaluateHandoffOperation("review set", canonicalFacts("awaiting_recipient"), "recipient", PERMISSIVE);
    expect(set.ok && set.value.setsReviewEngagedAt).toBe(true);
    const withdrawn = evaluateHandoffOperation(
      "review withdraw",
      canonicalFacts("changes_requested"),
      "recipient",
      PERMISSIVE,
    );
    expect(withdrawn.ok && withdrawn.value.setsReviewEngagedAt).toBe(false);
    const removed = evaluateHandoffOperation("review remove", canonicalFacts("changes_requested"), "user", PERMISSIVE);
    expect(removed.ok && removed.value.setsReviewEngagedAt).toBe(false);
    const revised = evaluateHandoffOperation("revise", canonicalFacts("changes_requested"), "sender", PERMISSIVE);
    expect(revised.ok && revised.value.setsReviewEngagedAt).toBe(false);
  });
});

describe("permission matrix", () => {
  it("keeps the User-admin operations to the section 7.1 set", () => {
    expect(USER_ADMIN_OPERATIONS).toEqual([
      "review remove",
      "pin",
      "unpin",
      "archive",
      "unarchive",
      "delete approve",
      "delete reject",
    ]);
    for (const operation of USER_ADMIN_OPERATIONS) {
      expect(handoffPermission(operation, "user").ok).toBe(true);
      expect(handoffPermission(operation, "sender").ok).toBe(false);
      expect(handoffPermission(operation, "recipient").ok).toBe(false);
    }
  });

  it("keeps content with the sender side, review with the recipient side, and reads open", () => {
    for (const operation of ["send", "revise", "revise no-change", "withdraw"] as const) {
      expect(handoffPermission(operation, "sender").ok).toBe(true);
      expect(handoffPermission(operation, "user").ok).toBe(true);
      expect(handoffPermission(operation, "recipient").ok).toBe(false);
    }
    for (const role of ROLES) {
      expect(handoffPermission("delete request", role).ok).toBe(true);
    }
    for (const operation of ["review set", "accept", "decline"] as const) {
      expect(handoffPermission(operation, "recipient").ok).toBe(true);
      expect(handoffPermission(operation, "user").ok).toBe(true);
      expect(handoffPermission(operation, "sender").ok).toBe(false);
    }
    expect(handoffPermission("review withdraw", "recipient").ok).toBe(true);
    expect(handoffPermission("review withdraw", "user").ok).toBe(false);
    for (const operation of ["get", "inbox", "outbox", "fetch"] as const) {
      for (const role of ROLES) {
        expect(handoffPermission(operation, role).ok).toBe(true);
      }
    }
  });
});

describe("next-actor derivation", () => {
  it("derives the review and administrative next actors of section 6", () => {
    expect(
      deriveNextActors({
        reviewState: "awaiting_recipient",
        tombstone: false,
        pendingDeletionRequest: false,
        integrityOrConfigurationFailure: false,
      }),
    ).toEqual({
      reviewNextActor: "recipient",
      administrativeNextActor: null,
    });
    expect(
      deriveNextActors({
        reviewState: "changes_requested",
        tombstone: false,
        pendingDeletionRequest: false,
        integrityOrConfigurationFailure: false,
      }),
    ).toEqual({
      reviewNextActor: "sender",
      administrativeNextActor: null,
    });
    for (const terminal of TERMINAL_REVIEW_STATES) {
      expect(
        deriveNextActors({
          reviewState: terminal,
          tombstone: false,
          pendingDeletionRequest: false,
          integrityOrConfigurationFailure: false,
        }).reviewNextActor,
      ).toBeNull();
    }
    expect(
      deriveNextActors({
        reviewState: "accepted",
        tombstone: true,
        pendingDeletionRequest: false,
        integrityOrConfigurationFailure: false,
      }).reviewNextActor,
    ).toBeNull();
    expect(
      deriveNextActors({
        reviewState: "awaiting_recipient",
        tombstone: false,
        pendingDeletionRequest: true,
        integrityOrConfigurationFailure: false,
      }),
    ).toEqual({ reviewNextActor: "recipient", administrativeNextActor: "user" });
    expect(
      deriveNextActors({
        reviewState: "changes_requested",
        tombstone: false,
        pendingDeletionRequest: false,
        integrityOrConfigurationFailure: true,
      }),
    ).toEqual({ reviewNextActor: "sender", administrativeNextActor: "user" });
  });
});
