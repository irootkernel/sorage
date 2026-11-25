import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "../shared/errors";
import { type NewDomainEvent, SYSTEM_ACTOR, USER_ACTOR } from "../shared/events";
import { type HandoffReadPorts, type ReadActorInput, resolveHandoffParticipantRole } from "./handoff-read";
import { evaluateHandoffOperation, expectedRowVersionGuard, type HandoffFacts } from "./handoffs";
import { type CompletionWarningSink, emitCompletionWarning } from "../primitives/disclosures";
import { validateHandoffObservations } from "./reporting-commands";

/**
 * Retention and deletion of sections 5 and 12 (LIFE-007 to LIFE-018, VLT-023,
 * CLI-014, CLI-019): pin and unpin are User-admin and independent of the review
 * state, archive is terminal-only, the deletion request is open to every participant
 * in any non-tombstone state, and approval verifies the Artifact checksum before one
 * transaction leaves the tombstone with an unlink intent the drain completes.
 */

export type RetentionChange =
  | { kind: "pin" }
  | { kind: "unpin" }
  | { kind: "archive" }
  | { kind: "unarchive" }
  | {
      kind: "deletion-request";
      requestId: string;
      requestedByKind: string;
      requestedById: string | null;
      reason: string | null;
    }
  | {
      kind: "deletion-approve";
      /**
       * The honest logical-deletion signal: current content — its Artifact rows
       * and records — is removed in this transaction whether or not a physical
       * unlink intent exists, so an approved inline Artifact leaves no orphaned
       * record and no fake intent is manufactured (SHR-004, SHR-008).
       */
      removeContent: boolean;
      unlinkIntent?: { id: string; toPath: string; artifactId: string } | undefined;
      idempotency?:
        | { key: string; scope: string; requestHash: string; responseJson: string; expiresAt: string }
        | undefined;
    }
  | { kind: "deletion-reject"; resolutionNote: string | null };

export interface RetentionMutationPort {
  /** Applies one retention decision in a single transaction with its events. */
  applyRetentionMutation(input: {
    handoffId: string;
    expectedRowVersion: number;
    change: RetentionChange;
    at: string;
    events: NewDomainEvent[];
  }): Result<{ rowVersion: number }, AppError>;
  /** Looks up one recorded idempotency key in its scope (section 17.3). */
  idempotencyLookup(key: string, scope: string): Result<{ requestHash: string; responseJson: string } | null, AppError>;
  /** The pending deletion request of one Handoff, or null. */
  findPendingRequest(handoffId: string): Result<{ id: string } | null, AppError>;
  /**
   * Marks the executed unlink complete and appends ARTIFACT_UNLINKED, gated on
   * the completion's own row clear; `completed` counts the actual winner only.
   * The explicit `artifactId` is the authorized retired Artifact this
   * completion may settle — it must exactly match the persisted intent's
   * artifact row before anything is cleared, and it preserves the ordinary
   * command's Handoff association when the Artifact row was already deleted
   * (section 3).
   */
  completeUnlink(input: {
    intentId: string;
    artifactId: string | null;
    event: NewDomainEvent;
  }): Result<{ completed: number }, AppError>;
}

export interface RetentionPorts extends HandoffReadPorts {
  retention: RetentionMutationPort;
  artifact: HandoffReadPorts["artifact"] & {
    remove(storageKey: string): Result<void, AppError>;
  };
  /**
   * The post-commit completion warning sink of SHR-015's category (i): a
   * physical unlink or completion failure after the committed deletion
   * approval is disclosed here and never fails the command; a throwing sink
   * changes nothing.
   */
  disclosures?: CompletionWarningSink | undefined;
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

function requireUser(input: ReadActorInput): Result<true, AppError> {
  if (input.asUser !== true) {
    return err(appError("USER_CONTEXT_REQUIRED", "this is a User administration operation; re-run with --as-user"));
  }
  return ok(true);
}

export interface RetentionOutcome {
  handoffId: string;
  reviewState: string;
  rowVersion: number;
  pinned?: boolean | undefined;
  archived?: boolean | undefined;
  deleted?: boolean | undefined;
  /** Presented by every deletion approval so no rendering claims a purge (LIFE-015). */
  warning?: string | undefined;
  /** True when an idempotency replay returned the recorded approval (section 17.3). */
  replayed?: boolean | undefined;
}

function load(ports: RetentionPorts, handoffId: string) {
  const found = ports.handoffs.loadHandoff(handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${handoffId}'`, { handoffId }));
  }
  return ok({ handoff: found.value.view, integrity: found.value.contentIntegrity });
}

function apply(
  ports: RetentionPorts,
  handoff: { id: string; rowVersion: number },
  change: RetentionChange,
  at: string,
  events: NewDomainEvent[],
): Result<{ rowVersion: number }, AppError> {
  return ports.retention.applyRetentionMutation({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    change,
    at,
    events,
  });
}

export function pinHandoff(ports: RetentionPorts, input: RetentionMutationInput): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("pin", factsOf(handoff), "user", {
    participant: true,
    expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { kind: "pin" }, now, [
    {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_PINNED",
      actor: USER_ACTOR,
      rowVersion: handoff.rowVersion + 1,
      metadata: {},
      createdAt: now,
    },
  ]);
  if (!applied.ok) return err(applied.error);
  return ok({
    handoffId: handoff.id,
    reviewState: handoff.reviewState,
    rowVersion: applied.value.rowVersion,
    pinned: true,
  });
}

export function unpinHandoff(ports: RetentionPorts, input: RetentionMutationInput): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("unpin", factsOf(handoff), "user", {
    participant: true,
    expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { kind: "unpin" }, now, [
    {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_UNPINNED",
      actor: USER_ACTOR,
      rowVersion: handoff.rowVersion + 1,
      metadata: {},
      createdAt: now,
    },
  ]);
  if (!applied.ok) return err(applied.error);
  return ok({
    handoffId: handoff.id,
    reviewState: handoff.reviewState,
    rowVersion: applied.value.rowVersion,
    pinned: false,
  });
}

export function archiveHandoff(
  ports: RetentionPorts,
  input: RetentionMutationInput,
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("archive", factsOf(handoff), "user", {
    participant: true,
    expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { kind: "archive" }, now, [
    {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_ARCHIVED",
      actor: USER_ACTOR,
      rowVersion: handoff.rowVersion + 1,
      metadata: {},
      createdAt: now,
    },
  ]);
  if (!applied.ok) return err(applied.error);
  return ok({
    handoffId: handoff.id,
    reviewState: handoff.reviewState,
    rowVersion: applied.value.rowVersion,
    archived: true,
  });
}

export function unarchiveHandoff(
  ports: RetentionPorts,
  input: RetentionMutationInput,
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("unarchive", factsOf(handoff), "user", {
    participant: true,
    expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { kind: "unarchive" }, now, [
    {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "HANDOFF_UNARCHIVED",
      actor: USER_ACTOR,
      rowVersion: handoff.rowVersion + 1,
      metadata: {},
      createdAt: now,
    },
  ]);
  if (!applied.ok) return err(applied.error);
  return ok({
    handoffId: handoff.id,
    reviewState: handoff.reviewState,
    rowVersion: applied.value.rowVersion,
    archived: false,
  });
}

export function requestDeletion(
  ports: RetentionPorts,
  input: RetentionMutationInput & { reason?: string | undefined },
): Result<RetentionOutcome, AppError> {
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const role = resolveHandoffParticipantRole(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation("delete request", factsOf(handoff), role.value, {
    participant: true,
    expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
  });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const requestedById =
    role.value === "user"
      ? null
      : role.value === "recipient"
        ? handoff.recipientProjectId
        : (handoff.senderProjectId ?? handoff.senderWorkspaceKey);
  const eventId = ports.ids.next();
  const requestId = ports.ids.next();
  const applied = apply(
    ports,
    handoff,
    {
      kind: "deletion-request",
      requestId,
      requestedByKind:
        role.value === "user" ? "user" : role.value === "recipient" ? "registered_project" : handoff.senderKind,
      requestedById,
      reason: input.reason ?? null,
    },
    now,
    [
      {
        id: eventId,
        handoffId: handoff.id,
        eventType: "DELETION_REQUESTED",
        actor:
          role.value === "user"
            ? USER_ACTOR
            : handoff.senderKind === "registered_project" && role.value === "sender" && handoff.senderProjectId !== null
              ? { kind: "registered_project", id: handoff.senderProjectId }
              : role.value === "recipient"
                ? { kind: "registered_project", id: handoff.recipientProjectId }
                : { kind: "unregistered_workspace", id: handoff.senderWorkspaceKey ?? "" },
        rowVersion: handoff.rowVersion + 1,
        metadata: { reason: input.reason ?? null },
        createdAt: now,
      },
    ],
  );
  if (!applied.ok) return err(applied.error);
  return ok({ handoffId: handoff.id, reviewState: handoff.reviewState, rowVersion: applied.value.rowVersion });
}

export interface ApproveDeletionInput extends ReadActorInput {
  handoffId: string;
  confirm: boolean;
  confirmPinned?: string | undefined;
  idempotencyKey?: string | undefined;
  /** Enforced against the current Row Version whenever supplied (HND-014, CLI-020). */
  expectedRowVersion?: number | undefined;
}

/** Every retention mutation input: one Handoff, its actor, and the optional HND-014 expectation. */
export type RetentionMutationInput = ReadActorInput & {
  handoffId: string;
  /** Enforced against the current Row Version whenever supplied (HND-014, CLI-020). */
  expectedRowVersion?: number | undefined;
};

/** The canonical request identity of one deletion approval, hashed for idempotency replay (section 17.3). */
function deletionApprovalRequestHash(handoffId: string, confirmPinned: string | undefined): string {
  const canonical = JSON.stringify({ kind: "deletion-approve", handoffId, confirmPinned: confirmPinned ?? null });
  return createHash("sha256").update(canonical).digest("hex");
}

function replayDeletionApproval(
  ports: RetentionPorts,
  key: string,
  requestHash: string,
): Result<RetentionOutcome | null, AppError> {
  const seen = ports.retention.idempotencyLookup(key, "deletion-approve");
  if (!seen.ok) return err(seen.error);
  if (seen.value === null) return ok(null);
  if (seen.value.requestHash !== requestHash) {
    return err(
      appError(
        "IDEMPOTENCY_CONFLICT",
        "this idempotency key was used with a different request; use a new key or replay the identical request",
        { idempotencyKey: key },
      ),
    );
  }
  return ok({ ...(JSON.parse(seen.value.responseJson) as RetentionOutcome), replayed: true });
}

export function approveDeletion(
  ports: RetentionPorts,
  input: ApproveDeletionInput,
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  if (input.confirm !== true) {
    return err(appError("CONFIRMATION_REQUIRED", "deletion approval is destructive; pass --confirm", {}));
  }
  const scalar = validateHandoffObservations(input);
  if (!scalar.ok) return err(scalar.error);
  // Replay is evaluated before every other guard, so a retried approval returns the
  // recorded outcome instead of HANDOFF_DELETED on the tombstone it created (section 17.3).
  const requestHash = deletionApprovalRequestHash(input.handoffId, input.confirmPinned);
  if (input.idempotencyKey !== undefined) {
    const replayed = replayDeletionApproval(ports, input.idempotencyKey, requestHash);
    if (!replayed.ok) return err(replayed.error);
    if (replayed.value !== null) return ok(replayed.value);
  }
  const fresh = validateHandoffObservations(input, ["expectedRowVersion"]);
  if (!fresh.ok) return err(fresh.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const pending = ports.retention.findPendingRequest(handoff.id);
  if (!pending.ok) return err(pending.error);
  const outcome = evaluateHandoffOperation(
    "delete approve",
    { ...factsOf(handoff), pendingDeletionRequest: pending.value !== null },
    "user",
    {
      participant: true,
      confirmPinnedSupplied: input.confirmPinned === handoff.id,
      artifactChecksumOk: true,
      expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
    },
  );
  if (!outcome.ok) return err(outcome.error);
  // A missing authoritative Artifact row or record is the honest corruption
  // refusal after the evaluator's earlier refusals, independent of the
  // optional public artifact summary — a deletion can never proceed past a
  // body it cannot see (SHR-004, SHR-014). A present body is verified
  // through the common bounded reader before any tombstone is written, so a
  // Missing or Mismatched Artifact never reaches deletion (VLT-023,
  // LIFE-012).
  if (loaded.value.integrity === "artifact-record-missing") {
    return err(
      appError(
        "ARTIFACT_CORRUPTED",
        "the current Artifact is missing or mismatched; run sorage vault verify and restore from backup before deletion",
        { handoffId: handoff.id },
      ),
    );
  }
  if (handoff.currentArtifact !== null) {
    const verified = ports.artifact.verifyArtifactBody(handoff.currentArtifact.id, { verifyFileDigest: "always" });
    if (!verified.ok) return err(verified.error);
  }
  const now = ports.clock.now().toISOString();
  const intentId = ports.ids.next();
  // The recorded response is built before the transaction so the row and the returned
  // approval are the same object; the compare-and-set makes the Row Version deterministic.
  const approval: RetentionOutcome = {
    handoffId: handoff.id,
    reviewState: handoff.reviewState,
    rowVersion: handoff.rowVersion + 1,
    deleted: true,
    warning: "prior Git commits may retain earlier content",
  };
  const retiredFile =
    handoff.currentArtifact !== null && handoff.currentArtifact.storageKey !== null ? handoff.currentArtifact : null;
  const applied = apply(
    ports,
    handoff,
    {
      kind: "deletion-approve",
      // Logical content removal always accompanies the approval; the physical
      // unlink intent exists only for a retired file-backed Artifact, and an
      // inline record leaves through the same transaction's reference-proof
      // removal with no manufactured intent (SHR-004, SHR-008).
      removeContent: handoff.currentArtifact !== null,
      unlinkIntent:
        retiredFile !== null
          ? { id: intentId, toPath: retiredFile.storageKey as string, artifactId: retiredFile.id }
          : undefined,
      idempotency:
        input.idempotencyKey !== undefined
          ? {
              key: input.idempotencyKey,
              scope: "deletion-approve",
              requestHash,
              responseJson: JSON.stringify(approval),
              expiresAt: new Date(ports.clock.now().getTime() + 24 * 3_600_000).toISOString(),
            }
          : undefined,
    },
    now,
    [
      {
        id: ports.ids.next(),
        handoffId: handoff.id,
        eventType: "DELETION_APPROVED",
        actor: USER_ACTOR,
        rowVersion: handoff.rowVersion + 1,
        metadata: { priorGitCommitsMayRetainContent: true },
        createdAt: now,
      },
    ],
  );
  if (!applied.ok) {
    if (input.idempotencyKey !== undefined) {
      const racedReplay = replayDeletionApproval(ports, input.idempotencyKey, requestHash);
      if (!racedReplay.ok) return err(racedReplay.error);
      if (racedReplay.value !== null) return ok(racedReplay.value);
    }
    return err(applied.error);
  }
  // Execute the committed unlink, then complete it with its system event (CP-6).
  // Both steps are post-commit work (SHR-015 category (i)): a failure is
  // disclosed as a warning and never fails the command, and the pending
  // intent is left to the next process start's drain.
  if (retiredFile !== null) {
    const removed = ports.artifact.remove(retiredFile.storageKey as string);
    if (!removed.ok) {
      emitCompletionWarning(
        ports.disclosures,
        `The deletion approval committed, but unlinking the retired ${retiredFile.storageKey} failed: ${removed.error.message}. The pending unlink intent remains for the next process start.`,
      );
    } else {
      const completed = ports.retention.completeUnlink({
        intentId,
        // The authorized retired Artifact this completion may settle, captured
        // from the same loaded Handoff that built the unlink intent.
        artifactId: retiredFile.id,
        event: {
          id: ports.ids.next(),
          handoffId: handoff.id,
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: { storageKey: retiredFile.storageKey },
          createdAt: ports.clock.now().toISOString(),
        },
      });
      if (!completed.ok) {
        emitCompletionWarning(
          ports.disclosures,
          `The deletion approval committed, but recording its unlink completion failed: ${completed.error.message}. The pending unlink intent remains for the next process start.`,
        );
      }
    }
  }
  return ok(approval);
}

export function rejectDeletion(
  ports: RetentionPorts,
  input: RetentionMutationInput & { reason?: string | undefined },
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const pending = ports.retention.findPendingRequest(handoff.id);
  if (!pending.ok) return err(pending.error);
  const outcome = evaluateHandoffOperation(
    "delete reject",
    { ...factsOf(handoff), pendingDeletionRequest: pending.value !== null },
    "user",
    {
      participant: true,
      expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
    },
  );
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(
    ports,
    handoff,
    {
      kind: "deletion-reject",
      resolutionNote: input.reason ?? null,
    },
    now,
    [
      {
        id: ports.ids.next(),
        handoffId: handoff.id,
        eventType: "DELETION_REJECTED",
        actor: USER_ACTOR,
        rowVersion: handoff.rowVersion + 1,
        metadata: { reason: input.reason ?? null },
        createdAt: now,
      },
    ],
  );
  if (!applied.ok) return err(applied.error);
  return ok({ handoffId: handoff.id, reviewState: handoff.reviewState, rowVersion: applied.value.rowVersion });
}
