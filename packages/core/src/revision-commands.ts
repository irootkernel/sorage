import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewArtifactRecord, type NewHandoffRecord, sendRequestHash } from "./handoff-commands";
import { type NewDomainEvent, projectActor, SYSTEM_ACTOR, USER_ACTOR, workspaceActor } from "./events";
import { evaluateHandoffOperation, type HandoffFacts } from "./handoffs";
import type { HandoffReadPorts, ReadActorInput } from "./handoff-read";
import { resolveWorkspaceActor } from "./project-commands";
import { workspaceKey } from "./workspace-identity";
import type { NewPendingFsOp } from "./intent-log";
import type { PreparedImport } from "./import-policy";

/**
 * Sender revision of sections 9 and 10 (REV-008 to REV-013, REV-017, HND-015, VLT-011,
 * VLT-012, CLI-012, CLI-021): the new content is staged into a fresh artifact-id slot
 * before any transaction, one transaction then swaps the current reference, resolves
 * the Note, replaces the Artifact row, records the activate and unlink intents, and
 * appends the events, and the committed intents execute and complete afterwards. The
 * bounded no-change resolution resolves the Note without touching content.
 */

export interface RevisionMutationPort {
  idempotencyLookup(key: string, scope: string): Result<{ requestHash: string; responseJson: string } | null, AppError>;
  /** The whole content-revision transaction of section 20.4. */
  applyContentRevision(input: {
    handoffId: string;
    expectedRowVersion: number;
    newArtifact: NewArtifactRecord;
    activateIntent: NewPendingFsOp;
    unlinkIntent: NewPendingFsOp | null;
    events: NewDomainEvent[];
    idempotency?:
      | { key: string; scope: string; requestHash: string; responseJson: string; expiresAt: string }
      | undefined;
  }): Result<{ rowVersion: number }, AppError>;
  /** The no-change resolution transaction: CAS, Note delete, events, idempotency. */
  applyNoChangeResolution(input: {
    handoffId: string;
    expectedRowVersion: number;
    events: NewDomainEvent[];
    idempotency?:
      | { key: string; scope: string; requestHash: string; responseJson: string; expiresAt: string }
      | undefined;
  }): Result<{ rowVersion: number }, AppError>;
  /** Marks the activation complete and appends ARTIFACT_ACTIVATED (ADR-0013 step 4). */
  completeActivations(
    completions: Array<{ intentId: string; artifactId: string; event: NewDomainEvent }>,
  ): Result<{ completed: number }, AppError>;
  /** Marks the unlink complete and appends ARTIFACT_UNLINKED. */
  completeUnlinks(
    completions: Array<{ intentId: string; event: NewDomainEvent }>,
  ): Result<{ completed: number }, AppError>;
}

export interface RevisionPorts extends HandoffReadPorts {
  revisions: RevisionMutationPort;
  artifactStore: {
    stage(request: {
      sourcePath: string;
      maxBytes: number;
    }): Result<{ stagingPath: string; sizeBytes: number; sha256: string }, AppError>;
    activate(request: { stagingPath: string; storageKey: string }): Result<{ path: string }, AppError>;
    remove(storageKey: string): Result<void, AppError>;
  };
  config: { vaultPath: string; maxBytes: number; verifyChecksumOnFetch: boolean };
}

export interface ReviseInput extends ReadActorInput {
  handoffId: string;
  file?: string | undefined;
  noChange?: boolean | undefined;
  reason?: string | undefined;
  idempotencyKey?: string | undefined;
  resolvedSourcePath?: string | undefined;
  originalName?: string | undefined;
}

export interface ReviseOutcome {
  handoffId: string;
  revision: number;
  rowVersion: number;
  reviewState: string;
  storageKey: string | null;
  replayed: boolean;
}

function roleOf(
  ports: RevisionPorts,
  input: ReadActorInput,
  handoff: {
    senderKind: string;
    senderProjectId: string | null;
    senderWorkspaceKey: string | null;
    recipientProjectId: string;
  },
): Result<"sender" | "user", AppError> {
  if (input.asUser === true) return ok("user");
  const resolved = resolveWorkspaceActor(ports.projectPorts, {
    path: input.path,
    userHome: input.userHome,
    as: input.as,
  });
  if (!resolved.ok) return err(resolved.error);
  if (resolved.value.kind === "registered_project") {
    if (handoff.senderKind === "registered_project" && handoff.senderProjectId === resolved.value.project.id) {
      return ok("sender");
    }
    return err(
      appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request", { handoffId: "" }),
    );
  }
  if (handoff.senderKind === "unregistered_workspace") {
    const key = workspaceKey(ports.projectPorts.installationId, resolved.value.directory);
    if (handoff.senderWorkspaceKey === key) return ok("sender");
  }
  return err(
    appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request", { handoffId: "" }),
  );
}

function senderActorOf(
  ports: RevisionPorts,
  handoff: { senderKind: string; senderProjectId: string | null; senderWorkspaceKey: string | null },
): NewDomainEvent["actor"] {
  if (handoff.senderKind === "registered_project" && handoff.senderProjectId !== null)
    return projectActor(handoff.senderProjectId);
  if (handoff.senderKind === "unregistered_workspace" && handoff.senderWorkspaceKey !== null) {
    return workspaceActor(handoff.senderWorkspaceKey);
  }
  return USER_ACTOR;
}

export function reviseHandoff(ports: RevisionPorts, input: ReviseInput): Result<ReviseOutcome, AppError> {
  const found = ports.handoffs.findHandoffView(input.handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(
      appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${input.handoffId}'`, { handoffId: input.handoffId }),
    );
  }
  const handoff = found.value;
  const role = roleOf(ports, input, handoff);
  if (!role.ok) return err(role.error);
  if (input.noChange === true && input.file !== undefined) {
    return err(appError("CONFIG_INVALID", "revise takes either --file or --no-change, not both"));
  }
  if (input.noChange !== true && input.file === undefined) {
    return err(appError("CONFIG_INVALID", "revise takes either --file or --no-change"));
  }

  const facts: HandoffFacts = {
    reviewState: handoff.reviewState,
    tombstone: handoff.deletedAt !== null,
    hasReviewNote: handoff.hasReviewNote,
    firstFetchedAt: handoff.firstFetchedAt,
    reviewEngagedAt: handoff.reviewEngagedAt,
    pinned: handoff.pinned,
    archived: handoff.archivedAt !== null,
    artifactMaterialized: handoff.currentArtifact?.materialized === true,
    consecutiveNoChangeResolutions: handoff.consecutiveNoChangeResolutions,
    pendingDeletionRequest: handoff.pendingDeletionRequest,
  };

  return reviseContent(ports, input, handoff, role.value, facts);
}

/** The HandoffView slice the revision flow reads; hasReviewNote comes from the view. */
interface RevisionHandoff {
  id: string;
  title: string;
  consecutiveNoChangeResolutions: number;
  revision: number;
  rowVersion: number;
  reviewState: string;
  senderKind: string;
  senderProjectId: string | null;
  senderWorkspaceKey: string | null;
  currentArtifact: { id: string; storageKey: string; sha256: string } | null;
  hasReviewNote: boolean;
  deletedAt: string | null;
}

function reviseContent(
  ports: RevisionPorts,
  input: ReviseInput,
  handoff: RevisionHandoff,
  role: "sender" | "user",
  facts: HandoffFacts,
): Result<ReviseOutcome, AppError> {
  // The no-change resolution resolves the Note without staging anything.
  if (input.noChange === true) {
    const requestHash = sendRequestHash({
      to: [handoff.id],
      title: handoff.title,
      contentSha256: `no-change:${input.reason ?? ""}`,
      kind: "body",
    });
    if (input.idempotencyKey !== undefined) {
      const replayed = replay(ports, input.idempotencyKey, requestHash);
      if (!replayed.ok) return err(replayed.error);
      if (replayed.value !== null) return ok(replayed.value);
    }
    const outcome = evaluateHandoffOperation(
      "revise no-change",
      { ...facts, hasReviewNote: handoff.hasReviewNote },
      role,
      {
        participant: true,
        reasonSupplied: input.reason !== undefined && input.reason.trim() !== "",
      },
    );
    if (!outcome.ok) return err(outcome.error);
    const now = ports.clock.now().toISOString();
    const response: ReviseOutcome = {
      handoffId: handoff.id,
      revision: handoff.revision,
      rowVersion: handoff.rowVersion + 1,
      reviewState: outcome.value.reviewState,
      storageKey: handoff.currentArtifact?.storageKey ?? null,
      replayed: false,
    };
    const applied = ports.revisions.applyNoChangeResolution({
      handoffId: handoff.id,
      expectedRowVersion: handoff.rowVersion,
      events: outcome.value.events.map((eventType, index) => ({
        id: ports.ids.next(),
        handoffId: handoff.id,
        eventType,
        actor: senderActorOf(ports, handoff),
        rowVersion: handoff.rowVersion + 1,
        metadata: { reason: input.reason ?? null },
        createdAt: now,
      })) as NewDomainEvent[],
      idempotency:
        input.idempotencyKey !== undefined
          ? {
              key: input.idempotencyKey,
              scope: "revise",
              requestHash,
              responseJson: JSON.stringify(response),
              expiresAt: new Date(ports.clock.now().getTime() + 24 * 3_600_000).toISOString(),
            }
          : undefined,
    });
    if (!applied.ok) return err(applied.error);
    return ok({ ...response, rowVersion: applied.value.rowVersion });
  }

  // Content revision: stage the new slot first, outside any transaction.
  const file = input.file as string;
  const staged = ports.artifactStore.stage({
    sourcePath: input.resolvedSourcePath ?? file,
    maxBytes: ports.config.maxBytes,
  });
  if (!staged.ok) return err(staged.error);
  const requestHash = sendRequestHash({
    to: [handoff.id],
    title: handoff.title,
    contentSha256: staged.value.sha256,
    kind: "file",
  });
  if (input.idempotencyKey !== undefined) {
    const replayed = replay(ports, input.idempotencyKey, requestHash);
    if (!replayed.ok) return err(replayed.error);
    if (replayed.value !== null) return ok(replayed.value);
  }
  // The same content refuses before anything mutates (HND-015).
  if (
    handoff.currentArtifact !== null &&
    staged.value.sha256.toLowerCase() === handoff.currentArtifact.sha256.toLowerCase()
  ) {
    return err(
      appError(
        "NO_CONTENT_CHANGE",
        "the supplied file carries the current Artifact's SHA-256; change the document or use revise --no-change --reason",
        { handoffId: handoff.id },
      ),
    );
  }
  const outcome = evaluateHandoffOperation("revise", facts, role, { participant: true, contentChanged: true });
  if (!outcome.ok) return err(outcome.error);

  const now = ports.clock.now().toISOString();
  const artifactId = `a${createHash("sha1")
    .update(`${handoff.id}:${handoff.revision + 1}:${now}`)
    .digest("hex")
    .slice(0, 8)}`;
  const storedName = (input.originalName ?? "document").replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const storageKey = `artifacts/${handoff.id}/${artifactId}/${storedName}`;
  const vaultPrefix = `${ports.config.vaultPath.replace(/\/+$/, "")}/`;
  const activateIntent: NewPendingFsOp = {
    id: createHash("sha1").update(`activate:${storageKey}`).digest("hex"),
    op: "activate",
    fromPath: staged.value.stagingPath.startsWith(vaultPrefix)
      ? staged.value.stagingPath.slice(vaultPrefix.length)
      : staged.value.stagingPath,
    toPath: storageKey,
    artifactId,
    createdAt: now,
  };
  const unlinkIntent: NewPendingFsOp | null =
    handoff.currentArtifact !== null
      ? {
          id: createHash("sha1").update(`unlink:${handoff.currentArtifact.storageKey}`).digest("hex"),
          op: "unlink",
          fromPath: null,
          toPath: handoff.currentArtifact.storageKey,
          artifactId: handoff.currentArtifact.id,
          createdAt: now,
        }
      : null;
  const response: ReviseOutcome = {
    handoffId: handoff.id,
    revision: handoff.revision + 1,
    rowVersion: handoff.rowVersion + 1,
    reviewState: outcome.value.reviewState,
    storageKey,
    replayed: false,
  };
  const applied = ports.revisions.applyContentRevision({
    handoffId: handoff.id,
    expectedRowVersion: handoff.rowVersion,
    newArtifact: {
      id: artifactId,
      handoffId: handoff.id,
      storageKey,
      originalName: input.originalName ?? storedName,
      storedName,
      mimeType: storedName.endsWith(".md") ? "text/markdown" : "application/octet-stream",
      sizeBytes: staged.value.sizeBytes,
      sha256: staged.value.sha256,
      importedFromPath: file,
      createdAt: now,
    },
    activateIntent,
    unlinkIntent,
    events: outcome.value.events.map((eventType, index) => ({
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType,
      actor: senderActorOf(ports, handoff),
      rowVersion: handoff.rowVersion + 1,
      metadata: { revision: handoff.revision + 1, storageKey, resolvedNote: handoff.hasReviewNote },
      createdAt: now,
    })) as NewDomainEvent[],
    idempotency:
      input.idempotencyKey !== undefined
        ? {
            key: input.idempotencyKey,
            scope: "revise",
            requestHash,
            responseJson: JSON.stringify(response),
            expiresAt: new Date(ports.clock.now().getTime() + 24 * 3_600_000).toISOString(),
          }
        : undefined,
  });
  if (!applied.ok) return err(applied.error);

  // Execute the committed intents, then complete each with its system event.
  const activated = ports.artifactStore.activate({ stagingPath: staged.value.stagingPath, storageKey });
  if (activated.ok) {
    const completed = ports.revisions.completeActivations([
      {
        intentId: activateIntent.id,
        artifactId,
        event: {
          id: ports.ids.next(),
          handoffId: handoff.id,
          eventType: "ARTIFACT_ACTIVATED",
          actor: SYSTEM_ACTOR,
          rowVersion: null,
          metadata: { storageKey, sha256: staged.value.sha256 },
          createdAt: now,
        },
      },
    ]);
    if (!completed.ok) return err(completed.error);
  }
  if (unlinkIntent !== null) {
    const removed = ports.artifactStore.remove(handoff.currentArtifact?.storageKey ?? "");
    if (removed.ok) {
      const completed = ports.revisions.completeUnlinks([
        {
          intentId: unlinkIntent.id,
          event: {
            id: ports.ids.next(),
            handoffId: handoff.id,
            eventType: "ARTIFACT_UNLINKED",
            actor: SYSTEM_ACTOR,
            rowVersion: null,
            metadata: { storageKey: handoff.currentArtifact?.storageKey ?? null },
            createdAt: now,
          },
        },
      ]);
      if (!completed.ok) return err(completed.error);
    }
  }
  return ok({ ...response, rowVersion: applied.value.rowVersion });
}

function replay(ports: RevisionPorts, key: string, requestHash: string): Result<ReviseOutcome | null, AppError> {
  const seen = ports.revisions.idempotencyLookup(key, "revise");
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
  return ok({ ...(JSON.parse(seen.value.responseJson) as ReviseOutcome), replayed: true });
}

export type { NewHandoffRecord };
