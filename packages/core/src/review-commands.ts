import { type AppError, appError, err, ok, type Result } from "./errors";
import { projectActor, USER_ACTOR } from "./events";
import type { HandoffReadPorts, ReadActorInput } from "./handoff-read";
import { evaluateHandoffOperation, type HandoffFacts } from "./handoffs";
import {
  compareHandoffObservations,
  type RecipientComment,
  type ReportMutation,
  reportingRole,
  setRecipientComment,
  validateHandoffObservations,
} from "./reporting-commands";

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
  findNote(handoffId: string): Result<ReviewNoteView | null, AppError>;
  findComment(handoffId: string): Result<RecipientComment | null, AppError>;
  applyReportMutation(input: ReportMutation): Result<{ rowVersion: number }, AppError>;
}
export interface ReviewPorts extends HandoffReadPorts {
  reviews: ReviewMutationPort;
}
export interface ReviewSetInput extends ReadActorInput {
  handoffId: string;
  text: string;
  targetRevision?: number | undefined;
  expectedRowVersion?: number | undefined;
}
export function setReviewNote(
  ports: ReviewPorts,
  input: ReviewSetInput,
): Result<
  { handoff: { id: string; reviewState: string; rowVersion: number; revision: number }; note: ReviewNoteView },
  AppError
> {
  const result = setRecipientComment(
    ports,
    { ...input, expectedRevision: input.targetRevision, purpose: "change_request" },
    true,
  );
  if (!result.ok) return err(result.error);
  const { id, reviewState, rowVersion, revision } = result.value.handoff;
  const { purpose: _purpose, active: _active, ...note } = result.value.comment as RecipientComment;
  return ok({ handoff: { id, reviewState, rowVersion, revision }, note });
}
export function withdrawReviewNote(
  ports: ReviewPorts,
  input: ReadActorInput & { handoffId: string; expectedRowVersion?: number | undefined },
): Result<{ handoff: { id: string; reviewState: string; rowVersion: number; revision: number } }, AppError> {
  return removeSide(ports, input, "review withdraw");
}
export function removeReviewNote(
  ports: ReviewPorts,
  input: ReadActorInput & { handoffId: string; confirm: boolean; expectedRowVersion?: number | undefined },
): Result<{ handoff: { id: string; reviewState: string; rowVersion: number; revision: number } }, AppError> {
  if (input.confirm !== true)
    return err(appError("CONFIRMATION_REQUIRED", "review remove is an audited User operation; pass --confirm", {}));
  return removeSide(ports, input, "review remove");
}
function removeSide(
  ports: ReviewPorts,
  input: ReadActorInput & { handoffId: string; expectedRowVersion?: number | undefined },
  operation: "review withdraw" | "review remove",
): Result<{ handoff: { id: string; reviewState: string; rowVersion: number; revision: number } }, AppError> {
  const found = ports.handoffs.findHandoffView(input.handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(appError("HANDOFF_NOT_FOUND", "the Handoff does not exist"));
  const handoff = found.value;
  const role = reportingRole(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const valid = validateHandoffObservations(input, ["expectedRowVersion"]);
  if (!valid.ok) return err(valid.error);
  const comment = ports.reviews.findComment(handoff.id);
  if (!comment.ok) return err(comment.error);
  const facts: HandoffFacts = {
    reviewState: handoff.reviewState,
    tombstone: handoff.deletedAt !== null,
    hasReviewNote: operation === "review remove" ? comment.value !== null : handoff.hasReviewNote,
    firstFetchedAt: handoff.firstFetchedAt,
    reviewEngagedAt: handoff.reviewEngagedAt,
    pinned: handoff.pinned,
    archived: handoff.archivedAt !== null,
    artifactMaterialized: handoff.currentArtifact?.materialized === true,
    consecutiveNoChangeResolutions: handoff.consecutiveNoChangeResolutions,
    pendingDeletionRequest: handoff.pendingDeletionRequest,
  };
  const outcome = evaluateHandoffOperation(operation, facts, role.value, { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const compared = compareHandoffObservations(handoff, input);
  if (!compared.ok) return err(compared.error);
  const now = ports.clock.now().toISOString();
  const reviewState = handoff.hasReviewNote ? "awaiting_recipient" : handoff.reviewState;
  const applied = ports.reviews.applyReportMutation({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    reviewState,
    comment: operation === "review remove" ? null : "deactivate",
    engage: false,
    now,
    events: [
      {
        id: ports.ids.next(),
        handoffId: handoff.id,
        eventType: operation === "review remove" ? "REVIEW_NOTE_REMOVED" : "REVIEW_NOTE_WITHDRAWN",
        actor: role.value === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId),
        rowVersion: handoff.rowVersion + 1,
        metadata: operation === "review remove" ? { administrative: true } : {},
        createdAt: now,
      },
    ],
  });
  if (!applied.ok) return err(applied.error);
  return ok({
    handoff: { id: handoff.id, revision: handoff.revision, rowVersion: applied.value.rowVersion, reviewState },
  });
}
export type { ReadActorInput };
