import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, projectActor, USER_ACTOR } from "./events";
import { evaluateHandoffOperation, type HandoffFacts } from "./handoffs";
import type { HandoffReadPorts, ReadActorInput } from "./handoff-read";
import { resolveWorkspaceActor } from "./project-commands";
import { workspaceKey } from "./workspace-identity";

/**
 * The terminal transitions of sections 11 and 12 (HND-014, HND-021, HND-022,
 * LIFE-001 to LIFE-006, CLI-013): accept names the exact accepted Revision, decline
 * records its mandatory reason, and withdraw is available only before the recipient
 * has engaged. Every transition runs through the section 4.2 evaluator, the Row
 * Version compare-and-set, and the event ledger in one transaction.
 */

export interface TerminalMutationPort {
  /** Applies one evaluated terminal transition in a single transaction. */
  applyTerminalTransition(input: {
    handoffId: string;
    expectedRowVersion: number;
    assignments: Record<string, string | number | null>;
    event: NewDomainEvent;
  }): Result<{ rowVersion: number }, AppError>;
}

export interface TerminalPorts extends HandoffReadPorts {
  terminals: TerminalMutationPort;
}

export interface AcceptInput extends ReadActorInput {
  handoffId: string;
  expectedRevision: number;
  expectedRowVersion: number;
}

export interface DeclineInput extends ReadActorInput {
  handoffId: string;
  reason: string;
  expectedRowVersion: number;
}

export interface WithdrawInput extends ReadActorInput {
  handoffId: string;
}

type TerminalRole = "recipient" | "sender" | "user";

function roleFor(
  ports: TerminalPorts,
  input: ReadActorInput,
  handoff: {
    senderKind: string;
    senderProjectId: string | null;
    senderWorkspaceKey: string | null;
    recipientProjectId: string;
  },
): Result<TerminalRole, AppError> {
  if (input.asUser === true) return ok("user");
  const resolved = resolveWorkspaceActor(ports.projectPorts, {
    path: input.path,
    userHome: input.userHome,
    as: input.as,
  });
  if (!resolved.ok) return err(resolved.error);
  if (resolved.value.kind === "registered_project") {
    if (resolved.value.project.id === handoff.recipientProjectId) return ok("recipient");
    if (handoff.senderKind === "registered_project" && handoff.senderProjectId === resolved.value.project.id)
      return ok("sender");
    return err(notParticipant());
  }
  if (handoff.senderKind === "unregistered_workspace") {
    const key = workspaceKey(ports.projectPorts.installationId, resolved.value.directory);
    if (handoff.senderWorkspaceKey === key) return ok("sender");
  }
  return err(notParticipant());
}

function notParticipant(): AppError {
  return appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request");
}

function factsOf(handoff: {
  reviewState: HandoffFacts["reviewState"];
  deletedAt: string | null;
  hasReviewNote: boolean;
  firstFetchedAt: string | null;
  reviewEngagedAt: string | null;
  pinned: boolean;
  archivedAt: string | null;
  currentArtifact: { materialized: boolean } | null;
  pendingDeletionRequest: boolean;
}): HandoffFacts {
  return {
    reviewState: handoff.reviewState,
    tombstone: handoff.deletedAt !== null,
    hasReviewNote: handoff.hasReviewNote,
    firstFetchedAt: handoff.firstFetchedAt,
    reviewEngagedAt: handoff.reviewEngagedAt,
    pinned: handoff.pinned,
    archived: handoff.archivedAt !== null,
    artifactMaterialized: handoff.currentArtifact?.materialized === true,
    consecutiveNoChangeResolutions: 0,
    pendingDeletionRequest: handoff.pendingDeletionRequest,
  };
}

export interface TerminalOutcome {
  handoffId: string;
  reviewState: string;
  revision: number;
  rowVersion: number;
  acceptedRevision?: number | undefined;
}

export function acceptHandoff(ports: TerminalPorts, input: AcceptInput): Result<TerminalOutcome, AppError> {
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const { handoff } = loaded.value;
  const role = roleFor(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation("accept", factsOf(handoff), role.value, {
    participant: true,
    expectedRevisionMatches: input.expectedRevision === handoff.revision,
    expectedRowVersionMatches: input.expectedRowVersion === handoff.rowVersion,
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = ports.terminals.applyTerminalTransition({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    assignments: {
      review_state: "accepted",
      accepted_revision: input.expectedRevision,
      accepted_at: now,
      updated_at: now,
    },
    event: {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_ACCEPTED",
      actor: role.value === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId),
      rowVersion: handoff.rowVersion + 1,
      metadata: { acceptedRevision: input.expectedRevision },
      createdAt: now,
    },
  });
  if (!applied.ok) return err(applied.error);
  return ok({
    handoffId: handoff.id,
    reviewState: "accepted",
    revision: handoff.revision,
    rowVersion: applied.value.rowVersion,
    acceptedRevision: input.expectedRevision,
  });
}

export function declineHandoff(ports: TerminalPorts, input: DeclineInput): Result<TerminalOutcome, AppError> {
  if (input.reason.trim() === "") {
    return err(appError("CONFIG_INVALID", "decline requires a --reason"));
  }
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const { handoff } = loaded.value;
  const role = roleFor(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation("decline", factsOf(handoff), role.value, {
    participant: true,
    reasonSupplied: input.reason.trim() !== "",
    expectedRowVersionMatches: input.expectedRowVersion === handoff.rowVersion,
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = ports.terminals.applyTerminalTransition({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    assignments: { review_state: "declined", declined_at: now, decline_reason: input.reason, updated_at: now },
    event: {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_DECLINED",
      actor: role.value === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId),
      rowVersion: handoff.rowVersion + 1,
      metadata: { reason: input.reason },
      createdAt: now,
    },
  });
  if (!applied.ok) return err(applied.error);
  return ok({
    handoffId: handoff.id,
    reviewState: "declined",
    revision: handoff.revision,
    rowVersion: applied.value.rowVersion,
  });
}

export function withdrawHandoff(ports: TerminalPorts, input: WithdrawInput): Result<TerminalOutcome, AppError> {
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const { handoff } = loaded.value;
  const role = roleFor(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation("withdraw", factsOf(handoff), role.value, { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = ports.terminals.applyTerminalTransition({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    assignments: { review_state: "withdrawn", withdrawn_at: now, updated_at: now },
    event: {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_WITHDRAWN",
      actor:
        role.value === "user"
          ? USER_ACTOR
          : handoff.senderKind === "registered_project" && handoff.senderProjectId !== null
            ? projectActor(handoff.senderProjectId)
            : handoff.senderWorkspaceKey !== null
              ? { kind: "unregistered_workspace", id: handoff.senderWorkspaceKey }
              : USER_ACTOR,
      rowVersion: handoff.rowVersion + 1,
      metadata: {},
      createdAt: now,
    },
  });
  if (!applied.ok) return err(applied.error);
  return ok({
    handoffId: handoff.id,
    reviewState: "withdrawn",
    revision: handoff.revision,
    rowVersion: applied.value.rowVersion,
  });
}

function load(ports: TerminalPorts, handoffId: string) {
  const found = ports.handoffs.findHandoffView(handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${handoffId}'`, { handoffId }));
  }
  return ok({ handoff: found.value });
}
