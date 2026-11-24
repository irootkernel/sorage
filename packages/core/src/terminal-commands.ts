import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, projectActor, USER_ACTOR } from "./events";
import { type HandoffReadPorts, type ReadActorInput, resolveHandoffParticipantRole } from "./handoff-read";
import { evaluateHandoffOperation, expectedRowVersionGuard, type HandoffFacts } from "./handoffs";
import { validateHandoffObservations } from "./reporting-commands";

/**
 * The terminal transitions of sections 11 and 12 (HND-014, HND-021, HND-022,
 * LIFE-001 to LIFE-006, CLI-013): accept names the exact accepted Revision, decline
 * records its mandatory reason, and withdraw is available only before the recipient
 * has engaged. Every transition runs through the section 4.2 evaluator, the Row
 * Version compare-and-set, and the event ledger in one transaction.
 */

export type TerminalTransition =
  | { kind: "accept"; acceptedRevision: number }
  | { kind: "decline"; reason: string }
  | { kind: "withdraw" };

export interface TerminalMutationPort {
  /** Applies one evaluated terminal transition in a single transaction. */
  applyTerminalTransition(input: {
    handoffId: string;
    expectedRowVersion: number;
    transition: TerminalTransition;
    at: string;
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
  /** Enforced against the current Row Version whenever supplied (HND-014, CLI-020). */
  expectedRowVersion?: number | undefined;
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
  const { handoff, integrity } = loaded.value;
  const role = resolveHandoffParticipantRole(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const valid = validateHandoffObservations(input, ["expectedRevision", "expectedRowVersion"]);
  if (!valid.ok) return err(valid.error);
  const outcome = evaluateHandoffOperation("accept", factsOf(handoff), role.value, {
    participant: true,
    expectedRevisionMatches: input.expectedRevision === handoff.revision,
    expectedRowVersionMatches: input.expectedRowVersion === handoff.rowVersion,
  });
  if (!outcome.ok) {
    // A missing record must never be masked as materializing: after the
    // evaluator's earlier tombstone, terminal, role, and Note refusals, the
    // observed expectations answer first — the expected Revision, then the
    // expected Row Version — and only a current observation surfaces the
    // honest corruption refusal (SHR-004, SHR-014, VLT-023).
    if (outcome.error.code === "ARTIFACT_MATERIALIZING" && integrity === "artifact-record-missing") {
      if (input.expectedRevision !== handoff.revision) {
        return err(appError("REVISION_CONFLICT", "the expected Revision is stale"));
      }
      if (input.expectedRowVersion !== handoff.rowVersion) {
        return err(
          appError(
            "ROW_VERSION_CONFLICT",
            "the Handoff changed since it was last read; re-read it and retry with the new Row Version",
          ),
        );
      }
      return err(
        appError(
          "ARTIFACT_CORRUPTED",
          "the current Artifact is missing, unreadable, or wrongly associated; run sorage vault verify and restore from backup",
        ),
      );
    }
    return err(outcome.error);
  }
  // The mandatory current-body gate of VLT-023: an accept claims the reviewed
  // content is intact, so the recorded body is verified through the common
  // bounded reader before any transition, leaving the domain untouched on
  // failure.
  if (handoff.currentArtifact !== null) {
    const verified = ports.artifact.verifyArtifactBody(handoff.currentArtifact.id, { verifyFileDigest: "always" });
    if (!verified.ok) return err(verified.error);
  }
  const now = ports.clock.now().toISOString();
  const applied = ports.terminals.applyTerminalTransition({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    transition: { kind: "accept", acceptedRevision: input.expectedRevision },
    at: now,
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
  const role = resolveHandoffParticipantRole(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const valid = validateHandoffObservations(input, ["expectedRowVersion"]);
  if (!valid.ok) return err(valid.error);
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
    transition: { kind: "decline", reason: input.reason },
    at: now,
    event: {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_DECLINED",
      actor: role.value === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId),
      rowVersion: handoff.rowVersion + 1,
      metadata: { reason: input.reason, ...(handoff.hasReviewNote ? { requestDeactivated: true } : {}) },
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
  const role = resolveHandoffParticipantRole(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation("withdraw", factsOf(handoff), role.value, {
    participant: true,
    expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = ports.terminals.applyTerminalTransition({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    transition: { kind: "withdraw" },
    at: now,
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
  const found = ports.handoffs.loadHandoff(handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${handoffId}'`, { handoffId }));
  }
  return ok({ handoff: found.value.view, integrity: found.value.contentIntegrity });
}
