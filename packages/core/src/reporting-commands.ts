import { isUtf8ExactText } from "./content";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, projectActor, USER_ACTOR } from "./events";
import { gatedHandoffView, type HandoffReadPorts, type HandoffView, type ReadActorInput } from "./handoff-read";
import { resolveWorkspaceActor } from "./project-commands";
import type { ReviewNoteView, ReviewPorts } from "./review-commands";
import { workspaceKey } from "./workspace-identity";

export interface HandoffReadEvidence {
  revision: number;
  status: "unrecorded" | "unconfirmed" | "read";
  readAt: string | null;
}
export interface HandoffProcessingEvidence {
  revision: number;
  status: "unrecorded" | "not_started" | "in_progress" | "completed";
  startedAt: string | null;
  completedAt: string | null;
}
export interface RecipientComment extends ReviewNoteView {
  purpose: "general" | "change_request";
  active: boolean;
}
export type RecipientCommentMetadata = Omit<RecipientComment, "body">;
export interface ReportMutation {
  handoffId: string;
  expectedRowVersion: number;
  /** Explicit document observation; absent on legacy Row-Version-only writers. */
  expectedRevision?: number | undefined;
  reviewState: HandoffView["reviewState"];
  processing?: HandoffProcessingEvidence | undefined;
  comment: RecipientComment | null | "retain" | "deactivate";
  engage: boolean;
  now: string;
  events: NewDomainEvent[];
}
export interface ReportResult {
  handoff: HandoffView;
  comment: RecipientComment | null;
}

/** Scalar validation precedes replay; presence is conditional on a fresh receipt miss. */
export function validateHandoffObservations(
  input: {
    expectedRowVersion?: number | undefined;
    expectedRevision?: number | undefined;
    targetRevision?: number | undefined;
  },
  required: readonly ("expectedRowVersion" | "expectedRevision" | "targetRevision")[] = [],
): Result<void, AppError> {
  for (const field of ["expectedRevision", "targetRevision", "expectedRowVersion"] as const) {
    const value = input[field];
    if (
      (value === undefined && required.includes(field)) ||
      (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    ) {
      return err(appError("HANDOFF_INVALID_INPUT", `${field} must be an observed positive safe integer`, { field }));
    }
  }
  return ok(undefined);
}
export function compareHandoffObservations(
  handoff: Pick<HandoffView, "revision" | "rowVersion">,
  input: {
    expectedRevision?: number | undefined;
    targetRevision?: number | undefined;
    expectedRowVersion?: number | undefined;
  },
): Result<void, AppError> {
  const revision = input.expectedRevision ?? input.targetRevision;
  if (revision !== undefined && revision !== handoff.revision)
    return err(
      appError(
        "REVISION_CONFLICT",
        "the observed document Revision is stale; retain the proposal and inspect current state",
      ),
    );
  if (input.expectedRowVersion !== undefined && input.expectedRowVersion !== handoff.rowVersion)
    return err(
      appError(
        "ROW_VERSION_CONFLICT",
        "the observed Row Version is stale; retain the proposal and inspect current state",
      ),
    );
  return ok(undefined);
}
export function validateCommentText(text: string): Result<void, AppError> {
  if (typeof text !== "string" || text.trim() === "" || text.includes("\0") || !isUtf8ExactText(text))
    return err(
      appError("HANDOFF_INVALID_INPUT", "comment text must be nonempty valid UTF-8 without NUL or lone surrogates"),
    );
  return ok(undefined);
}
export function reportingRole(
  ports: HandoffReadPorts,
  input: ReadActorInput,
  handoff: HandoffView,
): Result<"sender" | "recipient" | "user", AppError> {
  if (input.asUser === true) return ok("user");
  const actor = resolveWorkspaceActor(ports.projectPorts, input);
  if (!actor.ok) return err(actor.error);
  if (actor.value.kind === "registered_project") {
    if (actor.value.project.id === handoff.recipientProjectId) return ok("recipient");
    if (actor.value.project.id === handoff.senderProjectId) return ok("sender");
  } else if (
    handoff.senderKind === "unregistered_workspace" &&
    handoff.senderWorkspaceKey === workspaceKey(ports.projectPorts.installationId, actor.value.directory)
  )
    return ok("sender");
  return err(appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request"));
}
export function readRecipientComment(
  ports: HandoffReadPorts & { reviews: { findComment(id: string): Result<RecipientComment | null, AppError> } },
  input: ReadActorInput,
  id: string,
): Result<RecipientComment | null, AppError> {
  const gated = gatedHandoffView(ports, input, id);
  return gated.ok ? ports.reviews.findComment(id) : err(gated.error);
}
export interface CommentSetInput extends ReadActorInput {
  handoffId: string;
  text: string;
  purpose?: "general" | "change_request" | undefined;
  expectedRevision?: number | undefined;
  expectedRowVersion?: number | undefined;
}
export interface ProcessingInput extends ReadActorInput {
  handoffId: string;
  expectedRevision?: number | undefined;
  expectedRowVersion?: number | undefined;
  comment?: string | undefined;
}
export function setRecipientComment(
  ports: ReviewPorts,
  input: CommentSetInput,
  legacyReview = false,
): Result<ReportResult, AppError> {
  return report(ports, input, "comment", legacyReview);
}
export function startProcessing(ports: ReviewPorts, input: ProcessingInput): Result<ReportResult, AppError> {
  return report(ports, input, "start");
}
export function completeProcessing(ports: ReviewPorts, input: ProcessingInput): Result<ReportResult, AppError> {
  return report(ports, input, "complete");
}
function report(
  ports: ReviewPorts,
  input: CommentSetInput | ProcessingInput,
  operation: "comment" | "start" | "complete",
  legacyReview = false,
): Result<ReportResult, AppError> {
  const found = ports.handoffs.findHandoffView(input.handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(appError("HANDOFF_NOT_FOUND", "the Handoff does not exist"));
  const handoff = found.value;
  const role = reportingRole(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const observations = validateHandoffObservations(input, ["expectedRevision", "expectedRowVersion"]);
  if (!observations.ok) return err(observations.error);
  const text = "text" in input ? input.text : "comment" in input ? input.comment : undefined;
  const purpose = "purpose" in input && input.purpose !== undefined ? input.purpose : "general";
  if (operation === "comment" && text === undefined)
    return err(appError("HANDOFF_INVALID_INPUT", "comment set requires text"));
  if (purpose !== "general" && purpose !== "change_request")
    return err(appError("HANDOFF_INVALID_INPUT", "purpose must be general or change_request"));
  if (text !== undefined) {
    const valid = validateCommentText(text);
    if (!valid.ok) return err(valid.error);
  }
  if (handoff.deletedAt !== null) return err(appError("HANDOFF_DELETED", "a tombstone admits no report writes"));
  const terminal = ["accepted", "declined", "withdrawn"].includes(handoff.reviewState);
  if (
    (operation === "comment" && purpose === "change_request" && terminal) ||
    (operation !== "comment" && ["declined", "withdrawn"].includes(handoff.reviewState))
  )
    return err(appError("HANDOFF_TERMINAL", "this review outcome forbids the requested transition"));
  if (role.value === "sender")
    return err(appError("FORBIDDEN_ACTOR", "only the recipient or explicit User proxy may report work"));
  if (
    operation !== "comment" &&
    (handoff.processing.status === "completed" ||
      (operation === "start" && handoff.processing.status === "in_progress"))
  )
    return err(
      appError("PROCESSING_STATE_CONFLICT", "the processing transition has already occurred or cannot be reversed"),
    );
  if (
    handoff.hasReviewNote &&
    ((operation === "comment" && purpose === "general") ||
      operation === "complete" ||
      (operation === "start" && text !== undefined))
  )
    return err(
      appError(
        "REVIEW_NOTE_PRESENT",
        "resolve the active change request before replacing it with a general comment or completing",
      ),
    );
  const compared = compareHandoffObservations(handoff, input);
  if (!compared.ok) return err(compared.error);
  const now = ports.clock.now().toISOString();
  const authorKind = role.value === "user" ? ("user" as const) : ("registered_project" as const);
  const actor = role.value === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId);
  const reviewState =
    operation === "comment" && purpose === "change_request" ? "changes_requested" : handoff.reviewState;
  const previous = ports.reviews.findComment(handoff.id);
  if (!previous.ok) return err(previous.error);
  const comment: RecipientComment | "retain" =
    text === undefined
      ? "retain"
      : {
          handoffId: handoff.id,
          purpose,
          active: purpose === "change_request",
          authorKind,
          authorProjectId: role.value === "user" ? null : handoff.recipientProjectId,
          targetRevision: handoff.revision,
          body: text,
          createdAt: previous.value?.createdAt ?? now,
          updatedAt: now,
        };
  const events: NewDomainEvent[] = [];
  const addEvent = (eventType: NewDomainEvent["eventType"], metadata: Record<string, unknown>) =>
    events.push({
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType,
      actor,
      rowVersion: handoff.rowVersion + 1,
      metadata,
      createdAt: now,
    });
  if (legacyReview)
    addEvent(handoff.hasReviewNote ? "REVIEW_NOTE_UPDATED" : "REVIEW_NOTE_CREATED", {
      targetRevision: handoff.revision,
      authorKind,
    });
  if (comment !== "retain")
    addEvent("HANDOFF_COMMENT_SET", { targetRevision: handoff.revision, purpose, active: comment.active, authorKind });
  const processing: HandoffProcessingEvidence | undefined =
    operation === "comment"
      ? undefined
      : {
          revision: handoff.revision,
          status: operation === "start" ? "in_progress" : "completed",
          startedAt: operation === "start" ? now : handoff.processing.startedAt,
          completedAt: operation === "complete" ? now : null,
        };
  if (operation !== "comment")
    addEvent(operation === "start" ? "HANDOFF_PROCESSING_STARTED" : "HANDOFF_PROCESSING_COMPLETED", {
      revision: handoff.revision,
    });
  const applied = ports.reviews.applyReportMutation({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    expectedRevision: input.expectedRevision,
    reviewState,
    processing,
    comment,
    engage: true,
    now,
    events,
  });
  if (!applied.ok) return err(applied.error);
  // Return the exact committed proposal, independent of a subsequent competing writer.
  const retained = comment === "retain" ? previous.value : comment;
  const { body: _body, ...metadata } = retained ?? { body: "" };
  return ok({
    handoff: {
      ...handoff,
      reviewState,
      rowVersion: handoff.rowVersion + 1,
      processing: processing ?? handoff.processing,
      comment: retained === null ? null : (metadata as RecipientCommentMetadata),
      hasReviewNote: retained?.active ?? false,
      reviewEngagedAt: handoff.reviewEngagedAt ?? now,
      updatedAt: now,
      nextActors: {
        ...handoff.nextActors,
        reviewNextActor: terminal ? null : reviewState === "changes_requested" ? "sender" : "recipient",
      },
    },
    comment: retained,
  });
}
