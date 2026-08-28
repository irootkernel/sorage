import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, projectActor, USER_ACTOR } from "./events";
import { evaluateHandoffOperation, type HandoffFacts } from "./handoffs";
import type { HandoffReadPorts, ReadActorInput } from "./handoff-read";
import { resolveWorkspaceActor } from "./project-commands";

/**
 * The Review Note lifecycle of section 10 (REV-002 to REV-007, REV-014 to REV-016,
 * CLI-011, CLI-019): the recipient or the User authors against a target Revision, the
 * sender may never author, the recipient withdraws the current Note whichever actor
 * authored it, and only the User removes one administratively. Every mutation runs
 * through the section 4.2 evaluator, the Row Version compare-and-set, and the event
 * ledger inside one transaction.
 */

export interface ReviewNoteView {
  handoffId: string;
  authorKind: "registered_project" | "user";
  authorProjectId: string | null;
  targetRevision: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMutationPort {
  /** Loads the note of one Handoff, or null when none exists. */
  findNote(handoffId: string): Result<ReviewNoteView | null, AppError>;
  /**
   * Applies one evaluated review mutation in a single transaction: the compare-and-set
   * on the Handoff row, the note upsert or delete, the review_engaged_at first-set,
   * and the event append all commit together or not at all.
   */
  applyReviewMutation(input: {
    handoffId: string;
    expectedRowVersion: number;
    reviewState: string;
    setReviewEngagedAt: boolean;
    note:
      | {
          op: "upsert";
          authorKind: "registered_project" | "user";
          authorProjectId: string | null;
          targetRevision: number;
          body: string;
          now: string;
        }
      | { op: "delete" };
    event: NewDomainEvent;
  }): Result<{ rowVersion: number }, AppError>;
}

export interface ReviewPorts extends HandoffReadPorts {
  reviews: ReviewMutationPort;
}

export interface ReviewSetInput extends ReadActorInput {
  handoffId: string;
  text?: string | undefined;
  file?: string | undefined;
  targetRevision?: number | undefined;
}

function roleFor(
  ports: ReviewPorts,
  actorInput: ReadActorInput,
  facts: HandoffFacts & {
    senderKind: string;
    senderProjectId: string | null;
    senderWorkspaceKey: string | null;
    recipientProjectId: string;
  },
): Result<"sender" | "recipient" | "user", AppError> {
  if (actorInput.asUser === true) return ok("user");
  const resolved = resolveWorkspaceActor(ports.projectPorts, {
    path: actorInput.path,
    userHome: actorInput.userHome,
    as: actorInput.as,
  });
  if (!resolved.ok) return err(resolved.error);
  if (resolved.value.kind === "registered_project") {
    if (resolved.value.project.id === facts.recipientProjectId) return ok("recipient");
    if (facts.senderKind === "registered_project" && facts.senderProjectId === resolved.value.project.id)
      return ok("sender");
  }
  return err(
    appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request", { handoffId: "" }),
  );
}

export function setReviewNote(
  ports: ReviewPorts,
  input: ReviewSetInput,
): Result<
  { handoff: { id: string; reviewState: string; rowVersion: number; revision: number }; note: ReviewNoteView },
  AppError
> {
  if ((input.text === undefined) === (input.file === undefined)) {
    return err(appError("CONFIG_INVALID", "review set takes exactly one of --text or --file"));
  }
  if (input.text !== undefined && input.text.trim() === "") {
    return err(appError("CONFIG_INVALID", "the review note text must not be empty"));
  }
  const found = ports.handoffs.findHandoffView(input.handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(
      appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${input.handoffId}'`, { handoffId: input.handoffId }),
    );
  }
  const handoff = found.value;
  const note = ports.reviews.findNote(input.handoffId);
  if (!note.ok) return err(note.error);
  const targetRevision = input.targetRevision ?? handoff.revision;
  const facts: HandoffFacts = {
    reviewState: handoff.reviewState,
    tombstone: handoff.deletedAt !== null,
    hasReviewNote: note.value !== null,
    firstFetchedAt: handoff.firstFetchedAt,
    reviewEngagedAt: handoff.reviewEngagedAt,
    pinned: handoff.pinned,
    archived: handoff.archivedAt !== null,
    artifactMaterialized: handoff.currentArtifact?.materialized === true,
    consecutiveNoChangeResolutions: 0,
    pendingDeletionRequest: handoff.pendingDeletionRequest,
  };
  const role = roleFor(ports, input, {
    ...facts,
    senderKind: handoff.senderKind,
    senderProjectId: handoff.senderProjectId,
    senderWorkspaceKey: handoff.senderWorkspaceKey,
    recipientProjectId: handoff.recipientProjectId,
  });
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation("review set", facts, role.value, {
    participant: true,
    targetRevisionCurrent: targetRevision === handoff.revision,
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const body = input.text as string;
  const authorKind = role.value === "user" ? ("user" as const) : ("registered_project" as const);
  const authorProjectId = role.value === "user" ? null : handoff.recipientProjectId;
  const applied = ports.reviews.applyReviewMutation({
    handoffId: input.handoffId,
    expectedRowVersion: handoff.rowVersion,
    reviewState: outcome.value.reviewState,
    setReviewEngagedAt: outcome.value.setsReviewEngagedAt,
    note: { op: "upsert", authorKind, authorProjectId, targetRevision, body, now },
    event: {
      id: ports.ids.next(),
      handoffId: input.handoffId,
      eventType: outcome.value.events[0] as "REVIEW_NOTE_CREATED" | "REVIEW_NOTE_UPDATED",
      actor: role.value === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId),
      rowVersion: handoff.rowVersion + 1,
      metadata: { targetRevision, authorKind },
      createdAt: now,
    },
  });
  if (!applied.ok) return err(applied.error);
  const saved = ports.reviews.findNote(input.handoffId);
  if (!saved.ok || saved.value === null) {
    return err(appError("INTERNAL_ERROR", "the review note did not survive its own transaction"));
  }
  return ok({
    handoff: {
      id: input.handoffId,
      reviewState: outcome.value.reviewState,
      rowVersion: applied.value.rowVersion,
      revision: handoff.revision,
    },
    note: saved.value,
  });
}

export function withdrawReviewNote(
  ports: ReviewPorts,
  input: ReadActorInput & { handoffId: string },
): Result<{ handoff: { id: string; reviewState: string; rowVersion: number; revision: number } }, AppError> {
  return removeSide(ports, input, "review withdraw");
}

export function removeReviewNote(
  ports: ReviewPorts,
  input: ReadActorInput & { handoffId: string; confirm: boolean },
): Result<{ handoff: { id: string; reviewState: string; rowVersion: number; revision: number } }, AppError> {
  if (input.confirm !== true) {
    return err(appError("CONFIRMATION_REQUIRED", "review remove is an audited User operation; pass --confirm", {}));
  }
  return removeSide(ports, input, "review remove");
}

function removeSide(
  ports: ReviewPorts,
  input: ReadActorInput & { handoffId: string },
  operation: "review withdraw" | "review remove",
): Result<{ handoff: { id: string; reviewState: string; rowVersion: number; revision: number } }, AppError> {
  const found = ports.handoffs.findHandoffView(input.handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(
      appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${input.handoffId}'`, { handoffId: input.handoffId }),
    );
  }
  const handoff = found.value;
  const note = ports.reviews.findNote(input.handoffId);
  if (!note.ok) return err(note.error);
  const facts: HandoffFacts = {
    reviewState: handoff.reviewState,
    tombstone: handoff.deletedAt !== null,
    hasReviewNote: note.value !== null,
    firstFetchedAt: handoff.firstFetchedAt,
    reviewEngagedAt: handoff.reviewEngagedAt,
    pinned: handoff.pinned,
    archived: handoff.archivedAt !== null,
    artifactMaterialized: handoff.currentArtifact?.materialized === true,
    consecutiveNoChangeResolutions: 0,
    pendingDeletionRequest: handoff.pendingDeletionRequest,
  };
  const role = roleFor(ports, input, {
    ...facts,
    senderKind: handoff.senderKind,
    senderProjectId: handoff.senderProjectId,
    senderWorkspaceKey: handoff.senderWorkspaceKey,
    recipientProjectId: handoff.recipientProjectId,
  });
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation(operation, facts, role.value, { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = ports.reviews.applyReviewMutation({
    handoffId: input.handoffId,
    expectedRowVersion: handoff.rowVersion,
    reviewState: outcome.value.reviewState,
    setReviewEngagedAt: outcome.value.setsReviewEngagedAt,
    note: { op: "delete" },
    event: {
      id: ports.ids.next(),
      handoffId: input.handoffId,
      eventType: outcome.value.events[0] as "REVIEW_NOTE_WITHDRAWN" | "REVIEW_NOTE_REMOVED",
      actor: role.value === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId),
      rowVersion: handoff.rowVersion + 1,
      metadata: operation === "review withdraw" ? {} : { administrative: true },
      createdAt: now,
    },
  });
  if (!applied.ok) return err(applied.error);
  return ok({
    handoff: {
      id: input.handoffId,
      reviewState: outcome.value.reviewState,
      rowVersion: applied.value.rowVersion,
      revision: handoff.revision,
    },
  });
}

export type { ReadActorInput };
