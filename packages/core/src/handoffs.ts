import { type AppError, appError, err, ok, type Result } from "./errors";
import type { EventType } from "./events";

/**
 * The review state machine of sections 4.1 and 4.2 of domain-and-architecture.md.
 * Every transition, including every explicit rejection, appears in the 25-row table,
 * and any state-and-operation pair that is not listed is undefined and rejected. The
 * evaluator is pure: an adapter loads the row, evaluates, and then runs the
 * compare-and-set, so the table is exhaustively unit-testable without a database.
 */

export const REVIEW_STATES = ["awaiting_recipient", "changes_requested", "accepted", "declined", "withdrawn"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const TERMINAL_REVIEW_STATES: readonly ReviewState[] = ["accepted", "declined", "withdrawn"];

export function isTerminalReviewState(state: ReviewState): boolean {
  return TERMINAL_REVIEW_STATES.includes(state);
}

/** The actor's role relative to one Handoff; the permission matrix is a function of this. */
export type ActorRole = "sender" | "recipient" | "user";

export type HandoffOperation =
  | "send"
  | "review set"
  | "review withdraw"
  | "review remove"
  | "revise"
  | "revise no-change"
  | "accept"
  | "decline"
  | "withdraw"
  | "get"
  | "inbox"
  | "outbox"
  | "fetch"
  | "pin"
  | "unpin"
  | "archive"
  | "unarchive"
  | "delete request"
  | "delete approve"
  | "delete reject";

/** The orthogonal lifecycle facts of section 5 the state machine needs to see. */
export interface HandoffFacts {
  reviewState: ReviewState;
  /** A tombstone: `deletedAt` is set, the row is terminal, and no current Artifact exists. */
  tombstone: boolean;
  /** A Review Note exists; in `changes_requested` it is always true, elsewhere it is false. */
  hasReviewNote: boolean;
  firstFetchedAt: string | null;
  reviewEngagedAt: string | null;
  pinned: boolean;
  archived: boolean;
  /** The current Artifact reached its `storageKey`; reading an unmaterialized Artifact fails. */
  artifactMaterialized: boolean;
  consecutiveNoChangeResolutions: number;
  /** A Deletion Request is pending on this Handoff. */
  pendingDeletionRequest: boolean;
}

/** The operation-supplied guards of the table's Guard column, each optional per operation. */
export interface OperationGuards {
  /** The actor participates in the Handoff; a non-participant read discloses nothing (HND-020). */
  participant: boolean;
  /** The supplied target Revision equals the current Revision (REV-005, REV-006). */
  targetRevisionCurrent?: boolean;
  /** The expected Revision matches the row the client last read; mandatory on `accept` (LIFE-002). */
  expectedRevisionMatches?: boolean;
  /** The expected Row Version matches; enforced whenever supplied (HND-014). */
  expectedRowVersionMatches?: boolean;
  /** The new content's SHA-256 differs from the current Artifact's (HND-015). */
  contentChanged?: boolean;
  /** The mandatory free-text guard: a decline reason or a no-change reason was supplied. */
  reasonSupplied?: boolean;
  /** The current Artifact's bytes match the recorded checksum (VLT-023). */
  artifactChecksumOk?: boolean;
  /** The distinct pinned confirmation `--confirm-pinned <id>` was supplied (LIFE-012). */
  confirmPinnedSupplied?: boolean;
}

export interface TransitionOutcome {
  /** The resulting review state; state-preserving operations return the current one. */
  reviewState: ReviewState;
  /** The Revision delta of a successful transition; reads never move it (section 9). */
  revisionDelta: 0 | 1;
  /** The Row Version delta; exactly one bump for every successful mutation (HND-025). */
  rowVersionDelta: 0 | 1;
  /** Domain events appended in the mutation transaction, in table order. */
  events: EventType[];
  /** System events appended later by the transaction that clears the executed intents. */
  completionEvents: EventType[];
  /** `reviewEngagedAt` is set by the first `review set` and is never cleared. */
  setsReviewEngagedAt: boolean;
  /** The no-change counter resets on a content revision, advances on a no-change resolution. */
  noChangeCounter: "reset" | "advance" | "keep";
  /** `accept` records the exact accepted Revision in `acceptedRevision` (LIFE-004). */
  recordsAcceptedRevision: boolean;
}

const READ_OUTCOME: Omit<TransitionOutcome, "reviewState"> = {
  revisionDelta: 0,
  rowVersionDelta: 0,
  events: [],
  completionEvents: [],
  setsReviewEngagedAt: false,
  noChangeCounter: "keep",
  recordsAcceptedRevision: false,
};

function mutation(
  reviewState: ReviewState,
  events: EventType[],
  extra?: Partial<Omit<TransitionOutcome, "reviewState" | "events">>,
): TransitionOutcome {
  return {
    ...READ_OUTCOME,
    reviewState,
    events,
    rowVersionDelta: 1,
    ...extra,
  };
}

/**
 * Evaluates one row of the section 4.2 table. The precedence is fixed: the tombstone
 * rules (rows 24 and 25) come first, then the terminal rule (row 23), then the
 * permission matrix (section 7), then the operation's own guards, so an actor mistake
 * on a terminal row still reports `HANDOFF_TERMINAL`, exactly as the table orders it.
 */
export function evaluateHandoffOperation(
  operation: HandoffOperation,
  facts: HandoffFacts,
  role: ActorRole,
  guards: OperationGuards,
): Result<TransitionOutcome, AppError> {
  if (operation === "send") {
    // Row 1: creation is guarded before this point (recipient eligibility, staging,
    // supersedes validation), so the table's send row only fixes the initial values.
    return ok(
      mutation("awaiting_recipient", ["HANDOFF_CREATED"], {
        completionEvents: ["ARTIFACT_ACTIVATED"],
        noChangeCounter: "reset",
      }),
    );
  }

  if (facts.tombstone) {
    return evaluateOnTombstone(operation, guards, facts, role);
  }

  if (isTerminalReviewState(facts.reviewState)) {
    // Row 23: every content operation on a terminal Handoff is rejected, whatever the actor.
    switch (operation) {
      case "revise":
      case "review set":
      case "review withdraw":
      case "review remove":
      case "accept":
      case "decline":
      case "withdraw":
      case "revise no-change":
        return err(terminal());
      default:
        break;
    }
  }

  switch (operation) {
    case "get":
    case "inbox":
    case "outbox":
      // Row 15: participant-only metadata reads that never record anything.
      return readOutcome(guards, false, facts.reviewState, facts.artifactMaterialized);
    case "fetch":
      // Row 16: participant-only, materialized, and the first recipient or User fetch
      // sets `firstFetchedAt` and appends `ARTIFACT_FETCHED_FIRST_TIME`; a sender fetch
      // of its own Handoff sets nothing and emits nothing.
      return readOutcome(guards, true, facts.reviewState, facts.artifactMaterialized);
    default:
      break;
  }

  // The permission matrix of section 7, evaluated after the state rules above.
  const permission = handoffPermission(operation, role);
  if (!permission.ok) return permission;

  switch (operation) {
    case "review set": {
      // Rows 2 and 3: the sender may never author a Note; a stale target Revision fails.
      if (guards.targetRevisionCurrent === false) {
        return err(revisionConflict("the target Revision is stale"));
      }
      const creating = facts.reviewState === "awaiting_recipient";
      return ok(
        mutation("changes_requested", [creating ? "REVIEW_NOTE_CREATED" : "REVIEW_NOTE_UPDATED"], {
          setsReviewEngagedAt: true,
        }),
      );
    }
    case "review withdraw": {
      // Row 4: the recipient withdraws the current Note whichever actor authored it.
      if (!facts.hasReviewNote) {
        return err(noteAbsent());
      }
      return ok(mutation("awaiting_recipient", ["REVIEW_NOTE_WITHDRAWN"]));
    }
    case "review remove": {
      // Row 5: the audited administrative removal returns the Handoff to awaiting.
      if (!facts.hasReviewNote) {
        return err(noteAbsent());
      }
      return ok(mutation("awaiting_recipient", ["REVIEW_NOTE_REMOVED"]));
    }
    case "revise": {
      // Rows 6 and 7: content revision; the Note is resolved in the same transaction.
      if (facts.hasReviewNote) {
        return ok(
          mutation("awaiting_recipient", ["HANDOFF_REVISED", "REVIEW_NOTE_RESOLVED"], {
            revisionDelta: 1,
            completionEvents: ["ARTIFACT_ACTIVATED", "ARTIFACT_UNLINKED"],
            noChangeCounter: "reset",
          }),
        );
      }
      return ok(
        mutation(facts.reviewState, ["HANDOFF_REVISED"], {
          revisionDelta: 1,
          completionEvents: ["ARTIFACT_ACTIVATED", "ARTIFACT_UNLINKED"],
          noChangeCounter: "reset",
        }),
      );
    }
    case "revise no-change": {
      // Row 8 succeeds only in `changes_requested` with the counter at zero; row 9
      // rejects the operation in `awaiting_recipient` because there is no Note to resolve.
      if (!facts.hasReviewNote) {
        return err(
          appError("NO_REVIEW_NOTE", "revise --no-change is valid only in changes_requested; use revise --file <path>"),
        );
      }
      if (guards.reasonSupplied === false) {
        return err(appError("CONFIG_INVALID", "the no-change resolution requires a --reason"));
      }
      if (facts.consecutiveNoChangeResolutions > 0) {
        return err(
          appError(
            "NO_CHANGE_LIMIT",
            "a second consecutive no-change resolution is impossible; the next resolution must change content",
          ),
        );
      }
      return ok(
        mutation("awaiting_recipient", ["HANDOFF_NO_CHANGE_RESOLVED", "REVIEW_NOTE_RESOLVED"], {
          noChangeCounter: "advance",
        }),
      );
    }
    case "accept": {
      // Row 10: no Note, a materialized Artifact, and both expected values matching.
      if (facts.hasReviewNote) {
        return err(notePresent());
      }
      if (!facts.artifactMaterialized) {
        return err(materializing());
      }
      if (guards.expectedRevisionMatches === false) {
        return err(revisionConflict("the expected Revision is stale"));
      }
      if (guards.expectedRowVersionMatches === false) {
        return err(rowVersionConflict());
      }
      return ok(mutation("accepted", ["HANDOFF_ACCEPTED"], { recordsAcceptedRevision: true }));
    }
    case "decline": {
      // Rows 11 and 12: a mandatory reason and a matching expected Row Version.
      if (guards.reasonSupplied === false) {
        return err(appError("CONFIG_INVALID", "decline requires a --reason"));
      }
      if (guards.expectedRowVersionMatches === false) {
        return err(rowVersionConflict());
      }
      return ok(mutation("declined", ["HANDOFF_DECLINED"]));
    }
    case "withdraw": {
      // Row 14: a Handoff carrying a Note is withdrawn only after the Note is resolved.
      if (facts.hasReviewNote) {
        return err(notePresent());
      }
      // Row 13: only while the recipient has neither fetched nor reviewed.
      if (facts.firstFetchedAt !== null || facts.reviewEngagedAt !== null) {
        return err(
          appError(
            "HANDOFF_ALREADY_FETCHED",
            "the recipient has engaged with this Handoff; ask the recipient to decline, or supersede the Handoff",
          ),
        );
      }
      return ok(mutation("withdrawn", ["HANDOFF_WITHDRAWN"]));
    }
    case "pin":
      // Row 17: independent of the review state.
      return ok(mutation(facts.reviewState, ["HANDOFF_PINNED"]));
    case "unpin":
      return ok(mutation(facts.reviewState, ["HANDOFF_UNPINNED"]));
    case "archive": {
      // Row 18: terminal-only; a tombstone reached this branch only through row 25.
      if (!isTerminalReviewState(facts.reviewState)) {
        return err(
          appError(
            "HANDOFF_ARCHIVE_INVALID",
            "archiving is available only on a terminal Handoff; reach a terminal state first",
          ),
        );
      }
      return ok(mutation(facts.reviewState, ["HANDOFF_ARCHIVED"]));
    }
    case "unarchive": {
      // Row 19: only an archived Handoff can return.
      if (!facts.archived) {
        return err(appError("HANDOFF_NOT_ARCHIVED", "the Handoff is not archived; nothing to do"));
      }
      return ok(mutation(facts.reviewState, ["HANDOFF_UNARCHIVED"]));
    }
    case "delete request": {
      // Row 20: any participant, any non-tombstone state, at most one pending request.
      if (!guards.participant) {
        return err(notFound());
      }
      if (facts.pendingDeletionRequest) {
        return err(
          appError(
            "DELETION_ALREADY_REQUESTED",
            "a Deletion Request is already pending; wait for the User decision or reject it first",
          ),
        );
      }
      return ok(mutation(facts.reviewState, ["DELETION_REQUESTED"]));
    }
    case "delete approve": {
      // Row 21: terminal review state, a pending request, a verified Artifact, and the
      // distinct pinned confirmation when the Handoff is pinned.
      if (!isTerminalReviewState(facts.reviewState)) {
        return err(
          appError("HANDOFF_NOT_TERMINAL", "deletion approval requires a terminal review state; reach one first"),
        );
      }
      if (!facts.pendingDeletionRequest) {
        return err(appError("HANDOFF_NOT_FOUND", "no Deletion Request is pending for this Handoff"));
      }
      if (facts.pinned && !guards.confirmPinnedSupplied) {
        return err(
          appError(
            "PINNED_DELETE_CONFIRMATION",
            "a pinned Handoff needs the distinct --confirm-pinned <id> confirmation besides --confirm",
          ),
        );
      }
      if (guards.artifactChecksumOk === false) {
        return err(
          appError(
            "ARTIFACT_CORRUPTED",
            "the current Artifact is missing or mismatched; run sorage vault verify and restore from backup before deletion",
          ),
        );
      }
      return ok(mutation(facts.reviewState, ["DELETION_APPROVED"], { completionEvents: ["ARTIFACT_UNLINKED"] }));
    }
    case "delete reject": {
      // Row 22: a pending request is required.
      if (!facts.pendingDeletionRequest) {
        return err(appError("HANDOFF_NOT_FOUND", "no Deletion Request is pending for this Handoff"));
      }
      return ok(mutation(facts.reviewState, ["DELETION_REJECTED"]));
    }
    default:
      // Any pair that is not listed is undefined and MUST be rejected.
      return err(appError("INTERNAL_ERROR", `the operation '${operation}' is undefined for this Handoff`));
  }
}

function evaluateOnTombstone(
  operation: HandoffOperation,
  guards: OperationGuards,
  facts: HandoffFacts,
  role: ActorRole,
): Result<TransitionOutcome, AppError> {
  switch (operation) {
    case "get":
    case "inbox":
    case "outbox":
      // Row 25 keeps the reads available; row 15's participant rule still applies.
      return readOutcome(guards, false, facts.reviewState, facts.artifactMaterialized);
    case "pin":
    case "unpin":
    case "archive":
    case "unarchive": {
      // Row 25 keeps retention available on a tombstone, for the User only; every
      // tombstone is terminal, so the row 18 terminal-only rule holds by construction.
      if (role !== "user") {
        return err(
          appError("FORBIDDEN_ACTOR", "retention decisions are User-admin operations; run them with --as-user"),
        );
      }
      if (operation === "unarchive" && !facts.archived) {
        return err(appError("HANDOFF_NOT_ARCHIVED", "the Handoff is not archived; nothing to do"));
      }
      return ok(mutation(facts.reviewState, [retentionEvent(operation)]));
    }
    default:
      // Row 24: the nine content operations are rejected with `HANDOFF_DELETED`, and
      // every unlisted tombstone pair is rejected as well.
      return err(deleted());
  }
}

function retentionEvent(operation: HandoffOperation): EventType {
  switch (operation) {
    case "pin":
      return "HANDOFF_PINNED";
    case "unpin":
      return "HANDOFF_UNPINNED";
    case "archive":
      return "HANDOFF_ARCHIVED";
    default:
      return "HANDOFF_UNARCHIVED";
  }
}

function readOutcome(
  guards: OperationGuards,
  fetch: boolean,
  currentState: ReviewState,
  artifactMaterialized: boolean,
): Result<TransitionOutcome, AppError> {
  if (!guards.participant) {
    return err(notFound());
  }
  if (fetch && !artifactMaterialized) {
    return err(materializing());
  }
  return ok({ ...READ_OUTCOME, reviewState: currentState });
}

function deleted(): AppError {
  return appError(
    "HANDOFF_DELETED",
    "the Handoff is a tombstone; use get or a listing with --include-deleted, or create a new Handoff",
  );
}

function terminal(): AppError {
  return appError(
    "HANDOFF_TERMINAL",
    "the Handoff is accepted, declined, or withdrawn; create a superseding Handoff with --supersedes",
  );
}

function notFound(): AppError {
  return appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request");
}

function notePresent(): AppError {
  return appError(
    "REVIEW_NOTE_PRESENT",
    "the operation is blocked while a Review Note exists; resolve it by revising, withdrawing, or removing it",
  );
}

function noteAbsent(): AppError {
  return appError("NO_REVIEW_NOTE", "no Review Note exists on this Handoff");
}

function materializing(): AppError {
  return appError(
    "ARTIFACT_MATERIALIZING",
    "the current Artifact has not reached its storage key yet; retry after the next process start drains the intent",
  );
}

function revisionConflict(detail: string): AppError {
  return appError("REVISION_CONFLICT", detail);
}

function rowVersionConflict(): AppError {
  return appError(
    "ROW_VERSION_CONFLICT",
    "the Handoff changed since it was last read; re-read it and retry with the new Row Version",
  );
}

/**
 * The permission matrix of section 7. The User acts as an administrative proxy for
 * recipient-side and retention operations; the sender never touches the review side,
 * and the recipient never revises content. `FORBIDDEN_ACTOR` is a guardrail against
 * acting from the wrong directory, not a security boundary (SEC-013).
 */
export function handoffPermission(operation: HandoffOperation, role: ActorRole): Result<true, AppError> {
  const forbidden = () =>
    err(
      appError(
        "FORBIDDEN_ACTOR",
        "the resolved actor may not perform this operation; run it from the correct directory, or use --as or --as-user",
      ),
    );
  switch (operation) {
    case "send":
    case "revise":
    case "revise no-change":
    case "withdraw":
      // Sender or User proxy; the recipient never mutates content.
      return role === "recipient" ? forbidden() : ok(true);
    case "delete request":
      // Row 20: every participant may request deletion, whatever side they are on.
      return ok(true);
    case "review set":
    case "accept":
    case "decline":
      // Recipient or User proxy; the sender may never author a Note or decide (REV-004).
      return role === "sender" ? forbidden() : ok(true);
    case "review withdraw":
      // Row 4: the Recipient withdraws the current Note whichever actor authored it;
      // the User removes a Note only through `review remove` (REV-016).
      return role === "recipient" ? ok(true) : forbidden();
    case "get":
    case "inbox":
    case "outbox":
    case "fetch":
      // Participant-only reads; the participant guard, not this matrix, hides existence.
      return ok(true);
    default:
      // review remove, pin, unpin, archive, unarchive, delete approve, delete reject:
      // the User-admin rows of section 7.1; without `--as-user` the CLI answers
      // `USER_CONTEXT_REQUIRED` before the domain sees anything (CLI-019).
      return role === "user" ? ok(true) : forbidden();
  }
}

/** The User-admin operations whose CLI surface requires `--as-user` (section 7.1, CLI-019). */
export const USER_ADMIN_OPERATIONS: readonly HandoffOperation[] = [
  "review remove",
  "pin",
  "unpin",
  "archive",
  "unarchive",
  "delete approve",
  "delete reject",
];

/**
 * The next-actor derivation of section 6. The protocol exposes the review next actor
 * and the administrative next actor separately: a pending Deletion Request adds the
 * User to whoever owns the review, and an integrity or configuration failure belongs
 * to the User as well.
 */
export interface NextActors {
  reviewNextActor: "recipient" | "sender" | null;
  administrativeNextActor: "user" | null;
}

export function deriveNextActors(facts: {
  reviewState: ReviewState;
  tombstone: boolean;
  pendingDeletionRequest: boolean;
  integrityOrConfigurationFailure: boolean;
}): NextActors {
  let reviewNextActor: NextActors["reviewNextActor"];
  if (facts.tombstone || isTerminalReviewState(facts.reviewState)) {
    reviewNextActor = null;
  } else if (facts.reviewState === "awaiting_recipient") {
    reviewNextActor = "recipient";
  } else {
    reviewNextActor = "sender";
  }
  const administrativeNextActor =
    facts.pendingDeletionRequest || facts.integrityOrConfigurationFailure ? ("user" as const) : null;
  return { reviewNextActor, administrativeNextActor };
}
