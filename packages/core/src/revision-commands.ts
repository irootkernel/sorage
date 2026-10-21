import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, projectActor, SYSTEM_ACTOR, USER_ACTOR, workspaceActor } from "./events";
import { type NewArtifactRecord, type NewHandoffRecord, sendRequestHash } from "./handoff-commands";
import type { HandoffReadPorts, ReadActorInput } from "./handoff-read";
import { evaluateHandoffOperation, expectedRowVersionGuard, type HandoffFacts } from "./handoffs";
import { checkExternalSource, checkVaultContainment, sanitizeStoredName } from "./import-policy";
import type { ArtifactBodyPrepareRequest, PreparedArtifactBody } from "./content";
import type { NewPendingFsOp } from "./intent-log";
import { resolveWorkspaceActor, workspaceRootOf } from "./project-commands";
import { workspaceKey } from "./workspace-identity";

/**
 * Sender revision of sections 9 and 10 (REV-008 to REV-013, REV-017, HND-015, VLT-011,
 * VLT-012, CLI-012, CLI-021): the new content is routed through the shared body
 * preparation — inline text or a staged artifact-id slot — before any transaction,
 * one transaction then swaps the current reference, resolves the Note, replaces the
 * Artifact row, records only the intents the representations owe, and appends the
 * events, and the committed file intents execute and complete afterwards. The
 * bounded no-change resolution resolves the Note without touching content, and the
 * mandatory current-body verification of VLT-023 precedes every success.
 */

export interface RevisionMutationPort {
  idempotencyLookup(key: string, scope: string): Result<{ requestHash: string; responseJson: string } | null, AppError>;
  /** The whole content-revision transaction of section 20.4. */
  applyContentRevision(input: {
    handoffId: string;
    expectedRowVersion: number;
    newArtifact: NewArtifactRecord;
    /** Null exactly for an inline replacement body, which owes no activation. */
    activateIntent: NewPendingFsOp | null;
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
  /**
   * Marks the activation complete and appends ARTIFACT_ACTIVATED (ADR-0013
   * step 4). `completed` counts actual winners only: a completion whose intent
   * row a competing drain already cleared appends nothing and is not counted.
   */
  completeActivations(
    completions: Array<{ intentId: string; artifactId: string; event: NewDomainEvent }>,
  ): Result<{ completed: number }, AppError>;
  /**
   * Marks the unlink complete and appends ARTIFACT_UNLINKED, gated on the
   * completion's own row clear; `completed` counts actual winners only. The
   * explicit `artifactId` is the authorized retired Artifact this completion
   * may settle — it must exactly match the persisted intent's artifact row
   * before anything is cleared, and it preserves the ordinary command's
   * Handoff association when the Artifact row was already superseded
   * (section 3).
   */
  completeUnlinks(
    completions: Array<{ intentId: string; artifactId: string | null; event: NewDomainEvent }>,
  ): Result<{ completed: number }, AppError>;
}

export interface RevisionPorts extends HandoffReadPorts {
  revisions: RevisionMutationPort;
  artifactStore: {
    activate(request: { stagingPath: string; storageKey: string }): Result<{ path: string }, AppError>;
    remove(storageKey: string): Result<void, AppError>;
  };
  /** The one shared body-prepare implementation behind every producer (SHR-002, section 38.2). */
  content: {
    prepareArtifactBody(request: ArtifactBodyPrepareRequest): Result<PreparedArtifactBody, AppError>;
  };
  config: { vaultPath: string; maxBytes: number; verifyChecksumOnFetch: boolean };
  /** Resolved binding directories for the Vault containment half of the import policy. */
  bindingDirectories: string[];
  /** Digests a file with a bounded read so the guards can run before staging (section 19). */
  digestSource(path: string): Result<string, AppError>;
  /**
   * The optional large-content Git-history disclosure seam of SHR-011 (WR2):
   * fired once strictly after `applyContentRevision` succeeds and strictly
   * before activation, for the prepared replacement body's bytes only — a
   * `--no-change` resolution or a replayed revise never notifies.
   */
  disclosures?: {
    backupEnabled: boolean;
    thresholdBytes: number;
    largeContent(sizeBytes: number, thresholdBytes: number): void;
    /**
     * The post-commit completion warning sink of SHR-015's category (i): a
     * physical activation, unlink, or completion failure after the committed
     * revision is disclosed here and never fails the command; a throwing sink
     * changes nothing.
     */
    completionWarning?(text: string): void;
  };
}

export interface ReviseInput extends ReadActorInput {
  handoffId: string;
  file?: string | undefined;
  noChange?: boolean | undefined;
  reason?: string | undefined;
  idempotencyKey?: string | undefined;
  resolvedSourcePath?: string | undefined;
  originalName?: string | undefined;
  /** Marks `file` as an authenticated multipart upload spool (API-003, VLT-007). */
  fileSourceKind?: "authenticated-spool" | undefined;
  /** The explicit override for a replacement file outside the resolved workspace. */
  allowExternalSource?: boolean | undefined;
  /** Enforced against the current Row Version whenever supplied (HND-014, CLI-020). */
  expectedRowVersion?: number | undefined;
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
): Result<"sender" | "recipient" | "user", AppError> {
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
    // The recipient participates: the evaluator answers FORBIDDEN_ACTOR for a living
    // Handoff and HANDOFF_DELETED for a tombstone before the permission row runs.
    if (resolved.value.project.id === handoff.recipientProjectId) {
      return ok("recipient");
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

function senderActorOf(handoff: {
  senderKind: string;
  senderProjectId: string | null;
  senderWorkspaceKey: string | null;
}): NewDomainEvent["actor"] {
  if (handoff.senderKind === "registered_project" && handoff.senderProjectId !== null)
    return projectActor(handoff.senderProjectId);
  if (handoff.senderKind === "unregistered_workspace" && handoff.senderWorkspaceKey !== null) {
    return workspaceActor(handoff.senderWorkspaceKey);
  }
  return USER_ACTOR;
}

export function reviseHandoff(ports: RevisionPorts, input: ReviseInput): Result<ReviseOutcome, AppError> {
  const found = ports.handoffs.loadHandoff(input.handoffId);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(
      appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${input.handoffId}'`, { handoffId: input.handoffId }),
    );
  }
  const handoff = found.value.view;
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

  return reviseContent(ports, input, handoff, found.value.contentIntegrity, role.value, facts);
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
  currentArtifact: { id: string; storageKey: string | null; sha256: string } | null;
  hasReviewNote: boolean;
  deletedAt: string | null;
}

/**
 * Resolves the missing-authority marker after the evaluator's earlier
 * state, tombstone, and role refusals have answered (SHR-004, SHR-014):
 * a stale observed Row Version reports its conflict first, then the missing
 * record surfaces as the honest corruption refusal.
 */
function missingRecordAfterVersion(
  input: { expectedRowVersion?: number | undefined },
  handoff: RevisionHandoff,
): AppError {
  const staleRowVersion = expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion) === false;
  if (staleRowVersion) {
    return appError(
      "ROW_VERSION_CONFLICT",
      "the Handoff changed since it was last read; re-read it and retry with the new Row Version",
    );
  }
  return appError(
    "ARTIFACT_CORRUPTED",
    "the current Artifact is missing, unreadable, or wrongly associated; run sorage vault verify and restore from backup",
  );
}

function reviseContent(
  ports: RevisionPorts,
  input: ReviseInput,
  handoff: RevisionHandoff,
  contentIntegrity: "ok" | "artifact-record-missing",
  role: "sender" | "recipient" | "user",
  facts: HandoffFacts,
): Result<ReviseOutcome, AppError> {
  // A successful competing revision can retire the captured Artifact before
  // its body is verified. Confirm the captured version before diagnosing
  // corruption; this failure-only check never retries the mutation.
  const currentBodyFailure = (error: AppError): Result<never, AppError> => {
    if (error.code !== "ARTIFACT_CORRUPTED") return err(error);
    const latest = ports.handoffs.loadHandoff(handoff.id);
    if (!latest.ok) return err(latest.error);
    if (latest.value !== null && latest.value.view.rowVersion !== handoff.rowVersion) {
      return err(
        appError(
          "ROW_VERSION_CONFLICT",
          "the Handoff changed since it was last read; re-read it and retry with the new Row Version",
        ),
      );
    }
    return err(error);
  };
  // The mandatory current-body verification of VLT-023 runs for both revision
  // variants after the earlier replay, state, and Note guards and before any
  // success is claimed: a missing authoritative row or record is refused
  // independently of the optional public artifact summary, and a present body
  // is verified through the common bounded reader. Either failure leaves the
  // domain, Row Version, events, and receipts unchanged.
  const verifyCurrentBody = (): Result<void, AppError> | null => {
    if (contentIntegrity === "artifact-record-missing") {
      return currentBodyFailure(missingRecordAfterVersion(input, handoff));
    }
    if (handoff.currentArtifact === null) return null;
    const verified = ports.artifact.verifyArtifactBody(handoff.currentArtifact.id, { verifyFileDigest: "always" });
    return verified.ok ? verified : currentBodyFailure(verified.error);
  };
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
        expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
      },
    );
    if (!outcome.ok) return err(outcome.error);
    const verifiedNoChange = verifyCurrentBody();
    if (verifiedNoChange !== null && !verifiedNoChange.ok) return err(verifiedNoChange.error);
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
      events: outcome.value.events.map((eventType) => ({
        id: ports.ids.next(),
        handoffId: handoff.id,
        eventType,
        actor: senderActorOf(handoff),
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

  // Content revision, in the section 19 coordination order: the source is digested
  // first with a bounded read, the idempotency replay, the state evaluation, the
  // same-content comparison, and the mandatory current-body verification all
  // answer before any mutation, and only a revision that will proceed routes
  // its body through the shared preparation — inline text or a staged Vault
  // copy — under the workspace import policy for path imports and the
  // authenticated-spool rule for multipart uploads.
  const file = input.file as string;
  const sourcePath = input.resolvedSourcePath ?? file;
  const digested = ports.digestSource(sourcePath);
  if (!digested.ok) return err(digested.error);
  const requestHash = sendRequestHash({
    to: [handoff.id],
    title: handoff.title,
    contentSha256: digested.value,
    kind: "file",
  });
  if (input.idempotencyKey !== undefined) {
    const replayed = replay(ports, input.idempotencyKey, requestHash);
    if (!replayed.ok) return err(replayed.error);
    if (replayed.value !== null) return ok(replayed.value);
  }
  // The state machine answers before any content comparison (row 23, row 24).
  const outcome = evaluateHandoffOperation("revise", facts, role, {
    participant: true,
    contentChanged: true,
    expectedRowVersionMatches: expectedRowVersionGuard(input.expectedRowVersion, handoff.rowVersion),
  });
  if (!outcome.ok) return err(outcome.error);
  // The missing-authority gate precedes every body-dependent comparison and
  // step — including the same-content refusal, which reads the recorded
  // digest — and is independent of the optional public artifact summary: a
  // missing Artifact row or record row can neither be compared against nor
  // revised past (SHR-004, SHR-014, VLT-023).
  if (contentIntegrity === "artifact-record-missing") {
    return currentBodyFailure(missingRecordAfterVersion(input, handoff));
  }
  // The same content refuses before anything mutates or stages (HND-015).
  if (
    handoff.currentArtifact !== null &&
    digested.value.toLowerCase() === handoff.currentArtifact.sha256.toLowerCase()
  ) {
    return err(
      appError(
        "NO_CONTENT_CHANGE",
        "the supplied file carries the current Artifact's SHA-256; change the document or use revise --no-change --reason",
        { handoffId: handoff.id },
      ),
    );
  }
  // The mandatory current-body gate (VLT-023): a present body is verified
  // through the common bounded reader before any staging or mutation.
  const verified = verifyCurrentBody();
  if (verified !== null && !verified.ok) return err(verified.error);
  const spoolUpload = input.fileSourceKind === "authenticated-spool";
  const contained = checkVaultContainment({
    resolvedVaultPath: ports.config.vaultPath,
    resolvedBindingDirectories: ports.bindingDirectories,
  });
  if (!contained.ok) return err(contained.error);
  if (!spoolUpload) {
    const workspace = resolveWorkspaceActor(ports.projectPorts, {
      path: input.path,
      userHome: input.userHome,
      as: input.as,
    });
    if (!workspace.ok) return err(workspace.error);
    const workspaceRoot =
      workspace.value.kind === "registered_project"
        ? workspaceRootOf(workspace.value.binding)
        : workspace.value.directory;
    const external = checkExternalSource({
      resolvedSourcePath: sourcePath,
      workspaceRoot,
      policy: "workspace_or_explicit",
      allowExternalSource: input.allowExternalSource === true,
    });
    if (!external.ok) return err(external.error);
  }
  // ADR-0031: every new Artifact, revisions included, takes its identity from
  // the existing UUID port, exactly as new sends already do. The legacy
  // `a`-plus-eight-hex producer is retired; existing IDs of that form stay
  // valid and are never rewritten.
  const artifactId = ports.ids.next();
  const prepared = ports.content.prepareArtifactBody({
    body: {
      kind: "file",
      physicalPath: sourcePath,
      logicalOriginalName: input.originalName ?? "document",
      sourceKind: spoolUpload ? "authenticated-spool" : "workspace-path",
    },
    classification: "mime-first",
    identities: { handoffId: handoff.id, artifactId },
    bounds: { maxBytes: ports.config.maxBytes },
    provenance: { importedFromPath: spoolUpload ? null : file },
  });
  if (!prepared.ok) return err(prepared.error);

  const now = ports.clock.now().toISOString();
  const storedName = sanitizeStoredName(prepared.value.logicalName);
  const storageKey = prepared.value.storageKey;
  const vaultPrefix = `${ports.config.vaultPath.replace(/\/+$/, "")}/`;
  // An inline replacement body owes no activation; a file-backed one keeps
  // the causal legacy intent exactly as a new send does (SHR-005).
  const activateIntent: NewPendingFsOp | null =
    prepared.value.kind === "file"
      ? {
          id: createHash("sha1").update(`activate:${storageKey}`).digest("hex"),
          op: "activate",
          fromPath: prepared.value.stagingPath.startsWith(vaultPrefix)
            ? prepared.value.stagingPath.slice(vaultPrefix.length)
            : prepared.value.stagingPath,
          toPath: prepared.value.storageKey,
          artifactId,
          createdAt: now,
        }
      : null;
  // Only a retired file-backed Artifact owes a physical unlink; a retired
  // inline body leaves through the same transaction's reference-proof removal
  // with no manufactured intent (SHR-004, section 38.2).
  const unlinkIntent: NewPendingFsOp | null =
    handoff.currentArtifact !== null && handoff.currentArtifact.storageKey !== null
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
      inlineBody: prepared.value.kind === "inline" ? prepared.value.text : null,
      originalName: prepared.value.logicalName,
      storedName,
      mimeType: prepared.value.mimeType,
      sizeBytes: prepared.value.sizeBytes,
      sha256: prepared.value.sha256,
      importedFromPath: prepared.value.importedFromPath,
      createdAt: now,
    },
    activateIntent,
    unlinkIntent,
    events: outcome.value.events.map((eventType) => ({
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType,
      actor: senderActorOf(handoff),
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

  // The revision committed: fire the large-content Git-history disclosure for
  // the prepared replacement body before any activation runs (SHR-011, WR2).
  // A `--no-change` resolution never prepared a body, and a replayed revise
  // returned earlier, so neither reaches this notification.
  if (ports.disclosures?.backupEnabled) {
    const replacementBytes = prepared.value.sizeBytes;
    if (replacementBytes > ports.disclosures.thresholdBytes) {
      try {
        ports.disclosures.largeContent(replacementBytes, ports.disclosures.thresholdBytes);
      } catch {
        // A diagnostic sink failure never changes the committed outcome.
      }
    }
  }

  // Execute the committed file intents, then complete each with its system
  // event; an inline replacement has nothing physical to execute. Every step
  // after the committed revision is post-commit work (SHR-015 category (i)):
  // a failure is disclosed as a warning and never fails the command, and the
  // pending intent is left to the next process start's drain.
  if (activateIntent !== null && prepared.value.kind === "file") {
    const activated = ports.artifactStore.activate({
      stagingPath: prepared.value.stagingPath,
      storageKey: prepared.value.storageKey,
    });
    if (!activated.ok) {
      warnCompletion(
        ports.disclosures,
        `The revision committed, but activating ${prepared.value.storageKey} failed: ${activated.error.message}. The pending activation intent remains for the next process start.`,
      );
    } else {
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
            metadata: { storageKey, sha256: prepared.value.sha256 },
            createdAt: now,
          },
        },
      ]);
      if (!completed.ok) {
        warnCompletion(
          ports.disclosures,
          `The revision committed, but recording its activation completion failed: ${completed.error.message}. The pending activation intent remains for the next process start.`,
        );
      }
    }
  }
  if (unlinkIntent !== null && handoff.currentArtifact !== null && handoff.currentArtifact.storageKey !== null) {
    const removed = ports.artifactStore.remove(handoff.currentArtifact.storageKey);
    if (!removed.ok) {
      warnCompletion(
        ports.disclosures,
        `The revision committed, but unlinking the retired ${handoff.currentArtifact.storageKey} failed: ${removed.error.message}. The pending unlink intent remains for the next process start.`,
      );
    } else {
      const completed = ports.revisions.completeUnlinks([
        {
          intentId: unlinkIntent.id,
          // The authorized retired Artifact this completion may settle,
          // captured from the same loaded Handoff that built the intent.
          artifactId: handoff.currentArtifact.id,
          event: {
            id: ports.ids.next(),
            handoffId: handoff.id,
            eventType: "ARTIFACT_UNLINKED",
            actor: SYSTEM_ACTOR,
            rowVersion: null,
            metadata: { storageKey: handoff.currentArtifact.storageKey },
            createdAt: now,
          },
        },
      ]);
      if (!completed.ok) {
        warnCompletion(
          ports.disclosures,
          `The revision committed, but recording its unlink completion failed: ${completed.error.message}. The pending unlink intent remains for the next process start.`,
        );
      }
    }
  }
  return ok({ ...response, rowVersion: applied.value.rowVersion });
}

/** Discloses one post-commit completion warning; a throwing sink never changes the committed outcome (SHR-015). */
function warnCompletion(disclosures: RevisionPorts["disclosures"] | undefined, text: string): void {
  try {
    disclosures?.completionWarning?.(text);
  } catch {
    // A diagnostic sink failure never changes the committed outcome.
  }
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
