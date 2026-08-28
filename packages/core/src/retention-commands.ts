import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, SYSTEM_ACTOR, USER_ACTOR } from "./events";
import { evaluateHandoffOperation, type HandoffFacts } from "./handoffs";
import type { HandoffReadPorts, ReadActorInput } from "./handoff-read";
import { resolveWorkspaceActor } from "./project-commands";
import { workspaceKey } from "./workspace-identity";

/**
 * Retention and deletion of sections 5 and 12 (LIFE-007 to LIFE-018, VLT-023,
 * CLI-014, CLI-019): pin and unpin are User-admin and independent of the review
 * state, archive is terminal-only, the deletion request is open to every participant
 * in any non-tombstone state, and approval verifies the Artifact checksum before one
 * transaction leaves the tombstone with an unlink intent the drain completes.
 */

export interface RetentionMutationPort {
  /** Applies one retention decision in a single transaction with its events. */
  applyRetentionMutation(input: {
    handoffId: string;
    expectedRowVersion: number;
    assignments: Record<string, string | number | null>;
    events: NewDomainEvent[];
    deletionRequest?:
      | { op: "insert"; id: string; requestedByKind: string; requestedById: string | null; reason: string | null }
      | { op: "resolve"; status: "approved" | "rejected"; resolvedByUser: string; resolutionNote: string | null }
      | undefined;
    unlinkIntent?: { id: string; toPath: string; artifactId: string } | undefined;
    idempotency?:
      | { key: string; scope: string; requestHash: string; responseJson: string; expiresAt: string }
      | undefined;
  }): Result<{ rowVersion: number }, AppError>;
  /** Looks up one recorded idempotency key in its scope (section 17.3). */
  idempotencyLookup(key: string, scope: string): Result<{ requestHash: string; responseJson: string } | null, AppError>;
  /** The pending deletion request of one Handoff, or null. */
  findPendingRequest(handoffId: string): Result<{ id: string } | null, AppError>;
  /** Marks the executed unlink complete and appends ARTIFACT_UNLINKED. */
  completeUnlink(input: { intentId: string; event: NewDomainEvent }): Result<{ completed: number }, AppError>;
}

export interface RetentionPorts extends HandoffReadPorts {
  retention: RetentionMutationPort;
  artifact: {
    checksum(storageKey: string): Result<string, AppError>;
    pathOf(storageKey: string): Result<string, AppError>;
    remove(storageKey: string): Result<void, AppError>;
  };
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

function participantOf(
  ports: RetentionPorts,
  input: ReadActorInput,
  handoff: {
    senderKind: string;
    senderProjectId: string | null;
    senderWorkspaceKey: string | null;
    recipientProjectId: string;
  },
): Result<"sender" | "recipient" | "user", AppError> {
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
  }
  if (resolved.value.kind === "unregistered_workspace" && handoff.senderKind === "unregistered_workspace") {
    const key = workspaceKey(ports.projectPorts.installationId, resolved.value.directory);
    if (handoff.senderWorkspaceKey === key) return ok("sender");
  }
  return err(appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request"));
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
  const found = ports.handoffs.findHandoffView(handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${handoffId}'`, { handoffId }));
  }
  return ok({ handoff: found.value });
}

function apply(
  ports: RetentionPorts,
  handoff: { id: string; rowVersion: number },
  assignments: Record<string, string | number | null>,
  events: NewDomainEvent[],
  extras: {
    deletionRequest?: Parameters<RetentionMutationPort["applyRetentionMutation"]>[0]["deletionRequest"];
    unlinkIntent?: { id: string; toPath: string; artifactId: string } | undefined;
    idempotency?: Parameters<RetentionMutationPort["applyRetentionMutation"]>[0]["idempotency"];
  } = {},
): Result<{ rowVersion: number }, AppError> {
  return ports.retention.applyRetentionMutation({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    assignments,
    events,
    deletionRequest: extras.deletionRequest === undefined ? undefined : extras.deletionRequest,
    unlinkIntent: extras.unlinkIntent === undefined ? undefined : extras.unlinkIntent,
    idempotency: extras.idempotency === undefined ? undefined : extras.idempotency,
  });
}

export function pinHandoff(
  ports: RetentionPorts,
  input: ReadActorInput & { handoffId: string },
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("pin", factsOf(handoff), "user", { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { pinned: 1, updated_at: now }, [
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

export function unpinHandoff(
  ports: RetentionPorts,
  input: ReadActorInput & { handoffId: string },
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("unpin", factsOf(handoff), "user", { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { pinned: 0, updated_at: now }, [
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
  input: ReadActorInput & { handoffId: string },
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("archive", factsOf(handoff), "user", { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { archived_at: now, updated_at: now }, [
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
  input: ReadActorInput & { handoffId: string },
): Result<RetentionOutcome, AppError> {
  const guard = requireUser(input);
  if (!guard.ok) return err(guard.error);
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const outcome = evaluateHandoffOperation("unarchive", factsOf(handoff), "user", { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(ports, handoff, { archived_at: null, updated_at: now }, [
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
  input: ReadActorInput & { handoffId: string; reason?: string | undefined },
): Result<RetentionOutcome, AppError> {
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const role = participantOf(ports, input, handoff);
  if (!role.ok) return err(role.error);
  const outcome = evaluateHandoffOperation("delete request", factsOf(handoff), role.value, { participant: true });
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const requestedById =
    role.value === "user"
      ? null
      : role.value === "recipient"
        ? handoff.recipientProjectId
        : (handoff.senderProjectId ?? handoff.senderWorkspaceKey);
  const applied = apply(
    ports,
    handoff,
    { updated_at: now },
    [
      {
        id: ports.ids.next(),
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
    {
      deletionRequest: {
        op: "insert",
        id: ports.ids.next(),
        requestedByKind:
          role.value === "user" ? "user" : role.value === "recipient" ? "registered_project" : handoff.senderKind,
        requestedById,
        reason: input.reason ?? null,
      },
    },
  );
  if (!applied.ok) return err(applied.error);
  return ok({ handoffId: handoff.id, reviewState: handoff.reviewState, rowVersion: applied.value.rowVersion });
}

export interface ApproveDeletionInput extends ReadActorInput {
  handoffId: string;
  confirm: boolean;
  confirmPinned?: string | undefined;
  idempotencyKey?: string | undefined;
}

/** The canonical request identity of one deletion approval, hashed for idempotency replay (section 17.3). */
function deletionApprovalRequestHash(handoffId: string, confirmPinned: string | undefined): string {
  const canonical = JSON.stringify({ kind: "deletion-approve", handoffId, confirmPinned: confirmPinned ?? null });
  return createHash("sha256").update(canonical).digest("hex");
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
  // Replay is evaluated before every other guard, so a retried approval returns the
  // recorded outcome instead of HANDOFF_DELETED on the tombstone it created (section 17.3).
  const requestHash = deletionApprovalRequestHash(input.handoffId, input.confirmPinned);
  if (input.idempotencyKey !== undefined) {
    const seen = ports.retention.idempotencyLookup(input.idempotencyKey, "deletion-approve");
    if (!seen.ok) return err(seen.error);
    if (seen.value !== null) {
      if (seen.value.requestHash !== requestHash) {
        return err(
          appError(
            "IDEMPOTENCY_CONFLICT",
            "this idempotency key was used with a different request; use a new key or replay the identical request",
            { idempotencyKey: input.idempotencyKey },
          ),
        );
      }
      return ok({ ...(JSON.parse(seen.value.responseJson) as RetentionOutcome), replayed: true });
    }
  }
  const loaded = load(ports, input.handoffId);
  if (!loaded.ok) return err(loaded.error);
  const handoff = loaded.value.handoff;
  const pending = ports.retention.findPendingRequest(handoff.id);
  if (!pending.ok) return err(pending.error);
  const outcome = evaluateHandoffOperation(
    "delete approve",
    { ...factsOf(handoff), pendingDeletionRequest: pending.value !== null },
    "user",
    { participant: true, confirmPinnedSupplied: input.confirmPinned === handoff.id, artifactChecksumOk: true },
  );
  if (!outcome.ok) return err(outcome.error);
  // The checksum runs before any mutation: a Missing or Mismatched Artifact never
  // reaches the tombstone (VLT-023, LIFE-012).
  if (handoff.currentArtifact !== null) {
    const checksum = ports.artifact.checksum(handoff.currentArtifact.storageKey);
    if (!checksum.ok) return err(checksum.error);
    if (checksum.value.toLowerCase() !== handoff.currentArtifact.sha256.toLowerCase()) {
      return err(
        appError(
          "ARTIFACT_CORRUPTED",
          "the current Artifact is missing or mismatched; run sorage vault verify and restore from backup before deletion",
          {
            handoffId: handoff.id,
          },
        ),
      );
    }
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
  const applied = apply(
    ports,
    handoff,
    { deleted_at: now, current_artifact_id: null, updated_at: now },
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
    {
      deletionRequest: { op: "resolve", status: "approved", resolvedByUser: "user", resolutionNote: null },
      unlinkIntent:
        handoff.currentArtifact !== null
          ? { id: intentId, toPath: handoff.currentArtifact.storageKey, artifactId: handoff.currentArtifact.id }
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
  );
  if (!applied.ok) return err(applied.error);
  // Execute the committed unlink, then complete it with its system event (CP-6).
  if (handoff.currentArtifact !== null) {
    const removed = ports.artifact.remove(handoff.currentArtifact.storageKey);
    if (removed.ok) {
      const completed = ports.retention.completeUnlink({
        intentId,
        event: {
          id: ports.ids.next(),
          handoffId: handoff.id,
          eventType: "ARTIFACT_UNLINKED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: { storageKey: handoff.currentArtifact.storageKey },
          createdAt: ports.clock.now().toISOString(),
        },
      });
      if (!completed.ok) return err(completed.error);
    }
  }
  return ok(approval);
}

export function rejectDeletion(
  ports: RetentionPorts,
  input: ReadActorInput & { handoffId: string; reason?: string | undefined },
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
    { participant: true },
  );
  if (!outcome.ok) return err(outcome.error);
  const now = ports.clock.now().toISOString();
  const applied = apply(
    ports,
    handoff,
    { updated_at: now },
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
    {
      deletionRequest: {
        op: "resolve",
        status: "rejected",
        resolvedByUser: "user",
        resolutionNote: input.reason ?? null,
      },
    },
  );
  if (!applied.ok) return err(applied.error);
  return ok({ handoffId: handoff.id, reviewState: handoff.reviewState, rowVersion: applied.value.rowVersion });
}
