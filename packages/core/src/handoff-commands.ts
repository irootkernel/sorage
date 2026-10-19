import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type ActorRef, type NewDomainEvent, projectActor, SYSTEM_ACTOR, USER_ACTOR, workspaceActor } from "./events";
import type { ArtifactStore } from "./artifacts";
import { isUtf8ExactText, type ArtifactBodyPrepareRequest, type PreparedArtifactBody } from "./content";
import { checkExternalSource, checkVaultContainment, sanitizeStoredName } from "./import-policy";
import { type ProjectCommandPorts, checkRecipientEligibility } from "./project-commands";
import type { NewPendingFsOp } from "./intent-log";
import { resolveSenderIdentity, type SenderIdentity, workspaceKey } from "./workspace-identity";
import type { Clock, IdGenerator } from "./ids";

/**
 * Handoff creation and fan-out (HND-002, HND-006 to HND-009, HND-018, HND-023, PRJ-012,
 * PRJ-019, VLT-021, CLI-007/008/021): one independent Handoff per recipient, all-or-nothing
 * in one transaction, staged outside it, activated after it, and completed in a second
 * short transaction — the four-phase shape of section 19 that ADR-0013 fixed.
 */

export interface SendInput {
  to: string[];
  title: string;
  file?: string | undefined;
  body?: string | undefined;
  /** Streamed HTTP `body` spool; mutually exclusive with `file` and `body` (API-013). */
  bodyFile?: string | undefined;
  supersedes?: string | undefined;
  allowExternalSource: boolean;
  allowUnregistered: boolean;
  idempotencyKey?: string | undefined;
  path: string;
  userHome: string;
  as?: string | undefined;
  asUser?: boolean | undefined;
  /** Names the caller's original file when `file` points at an opaque spool (VLT-007). */
  originalName?: string | undefined;
  /**
   * Marks `file` as an authenticated multipart upload spool rather than a
   * workspace path import (API-003): the spool's logical name comes from
   * `originalName`, its provenance records no workspace path, and the
   * workspace external-source rule does not apply to it.
   */
  fileSourceKind?: "authenticated-spool" | undefined;
}

export interface SentHandoff {
  handoffId: string;
  recipientSlug: string;
  artifactId: string;
  /** Always present; null exactly when the accepted body routed inline (SHR-013). */
  storageKey: string | null;
  revision: 1;
  rowVersion: 1;
  reviewState: "awaiting_recipient";
}

export interface SendOutcome {
  handoffs: SentHandoff[];
  dispatchGroupId: string | null;
  replayed: boolean;
}

export interface NewHandoffRecord {
  id: string;
  dispatchGroupId: string | null;
  supersedesHandoffId: string | null;
  title: string;
  senderKind: "registered_project" | "unregistered_workspace" | "user";
  senderProjectId: string | null;
  senderWorkspaceKey: string | null;
  senderPathSnapshot: string | null;
  recipientProjectId: string;
  currentArtifactId: string;
  createdAt: string;
}

export interface NewArtifactRecord {
  id: string;
  handoffId: string;
  /** Always present; null exactly when inlineBody carries the authoritative text (SHR-013). */
  storageKey: string | null;
  /** The exact accepted inline text, or null for a file-backed Artifact. */
  inlineBody: string | null;
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  importedFromPath: string | null;
  createdAt: string;
}

export interface FanoutCommit {
  handoffs: NewHandoffRecord[];
  /** Filesystem identity captured before staging; SQLite rechecks binding ownership at commit. */
  unregisteredSenderPath?: { directory: string; gitCommonDirectory: string | null; allowUnregistered: boolean };
  registeredSender?:
    | { projectId: string; asOverride: true }
    | { projectId: string; asOverride: false; bindingId: string; directory: string; gitCommonDirectory: string | null };
  artifacts: NewArtifactRecord[];
  intents: NewPendingFsOp[];
  events: NewDomainEvent[];
  idempotency?:
    | { key: string; scope: string; requestHash: string; responseJson: string; expiresAt: string }
    | undefined;
}

/**
 * The transactional write port behind creation and completion. `createFanout` is the
 * all-or-nothing transaction of section 8; `completeActivations` is the short
 * completion transaction that marks Artifacts materialized, clears their executed
 * intents, and appends the activation events.
 */
export interface HandoffWritePort {
  createFanout(commit: FanoutCommit): Result<{ recorded: number }, AppError>;
  completeActivations(
    completions: Array<{ intentId: string; artifactId: string; event: NewDomainEvent }>,
  ): Result<{ completed: number }, AppError>;
  /** The review facts a `--supersedes` target must show, or null when it does not exist. */
  findSupersedesTarget(id: string): Result<{ reviewState: string; deletedAt: string | null } | null, AppError>;
  idempotencyLookup(key: string, scope: string): Result<{ requestHash: string; responseJson: string } | null, AppError>;
  senderOfHandoff(
    id: string,
  ): Result<
    { kind: NewHandoffRecord["senderKind"]; projectId: string | null; workspaceKey: string | null } | null,
    AppError
  >;
}

export interface SendPorts {
  projectPorts: ProjectCommandPorts;
  handoffs: HandoffWritePort;
  artifactStore: ArtifactStore;
  /**
   * The shared body-prepare seam of section 38.2 (SHR-002): one routing
   * 1): one routing implementation that classifies by the logical original
   * name's MIME allowlist, decodes text fatally, and routes at the fixed
   * threshold — inline for decodable text at or below it, the Vault for binary
   * at every size and for larger or undecodable text.
   */
  content: {
    prepareArtifactBody(request: ArtifactBodyPrepareRequest): Result<PreparedArtifactBody, AppError>;
  };
  ids: IdGenerator;
  clock: Clock;
  config: {
    vaultPath: string;
    maxBytes: number;
    allowUnregisteredSenders: boolean;
  };
  bindingDirectories: string[];
  /** Realpath-resolves a source and rejects special or unreadable files (VLT-008, SEC-006). */
  inspectSource(path: string, userHome: string): Result<{ resolvedSourcePath: string; originalName: string }, AppError>;
  /** Digests a file with a bounded read, for the idempotency request hash (CLI-021). */
  digestSource(path: string): Result<string, AppError>;
  /**
   * The optional large-content Git-history disclosure seam of SHR-011 (WR2):
   * supplied by the production composition from `gitBackup.enabled` and
   * `gitBackup.largeArtifactWarningBytes`; fired once per original source body
   * strictly after the fanout commit succeeds and strictly before activation,
   * so a later activation failure still disclosed the growth. Metadata-only;
   * a failing sink never changes the outcome (WR2).
   */
  disclosures?: {
    backupEnabled: boolean;
    thresholdBytes: number;
    largeContent(sizeBytes: number, thresholdBytes: number): void;
  };
}

/** Derives the stored-name slug of a title: the same folding rule a Project slug uses. */
export function titleSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** The canonical request identity of one send, hashed for idempotency replay (API-012). */
export function sendRequestHash(input: {
  to: string[];
  title: string;
  contentSha256: string;
  supersedes?: string | undefined;
  kind: "file" | "body";
  sender?: string | undefined;
}): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    title: input.title,
    to: [...new Set(input.to)].sort(),
    content: input.contentSha256,
    supersedes: input.supersedes ?? null,
    ...(input.sender === undefined ? {} : { sender: input.sender }),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function senderActorRef(sender: SenderIdentity | { kind: "user" }): ActorRef {
  if (sender.kind === "registered_project") return projectActor(sender.project.id);
  if (sender.kind === "unregistered_workspace") return workspaceActor(sender.workspaceKey);
  return USER_ACTOR;
}

function senderColumns(sender: SenderIdentity | { kind: "user" }): {
  senderKind: NewHandoffRecord["senderKind"];
  senderProjectId: string | null;
  senderWorkspaceKey: string | null;
  senderPathSnapshot: string | null;
} {
  if (sender.kind === "registered_project") {
    return {
      senderKind: "registered_project",
      senderProjectId: sender.project.id,
      senderWorkspaceKey: null,
      senderPathSnapshot: null,
    };
  }
  if (sender.kind === "unregistered_workspace") {
    return {
      senderKind: "unregistered_workspace",
      senderProjectId: null,
      senderWorkspaceKey: sender.workspaceKey,
      senderPathSnapshot: sender.pathSnapshot,
    };
  }
  return { senderKind: "user", senderProjectId: null, senderWorkspaceKey: null, senderPathSnapshot: null };
}

export function sendHandoffs(ports: SendPorts, input: SendInput): Result<SendOutcome, AppError> {
  const title = input.title.trim();
  if (title === "") {
    return err(appError("CONFIG_INVALID", "the Handoff title must not be empty"));
  }
  const sources = [input.file !== undefined, input.body !== undefined, input.bodyFile !== undefined].filter(Boolean);
  if (sources.length !== 1) {
    return err(appError("CONFIG_INVALID", "send takes exactly one of --file or --body"));
  }
  if (input.body !== undefined && input.body.trim() === "") {
    return err(appError("CONFIG_INVALID", "the --body text must not be empty"));
  }
  if (input.body !== undefined && !isUtf8ExactText(input.body)) {
    // A body that cannot round-trip UTF-8 (a lone surrogate) is rejected before
    // any digest, idempotency lookup, or staging: its lossy UTF-8 digest could
    // otherwise collide with a valid body's digest and replay a retained
    // outcome past the store's byte-exact rejection (SHR-003).
    return err(
      appError("CONFIG_INVALID", "the --body text cannot be stored byte-exactly; it contains an unpaired surrogate"),
    );
  }
  return sendStaged(ports, input, title);
}

function sendStaged(ports: SendPorts, input: SendInput, title: string): Result<SendOutcome, AppError> {
  // The request hash needs the content digest, so the body or file is digested before
  // anything else: the idempotency replay is evaluated first, before any eligibility,
  // supersedes, or Row Version check (API-012). A `--body` send is explicit user
  // content digested from the exact text; no scratch-file roundtrip exists anymore
  // (HND-023, section 38.2).
  let contentSha256: string;
  const asBody = input.body !== undefined || input.bodyFile !== undefined;
  const storedName = asBody ? `${titleSlug(title)}-1.md` : "";
  if (input.body !== undefined) {
    contentSha256 = createHash("sha256").update(input.body, "utf8").digest("hex");
  } else if (input.bodyFile !== undefined) {
    const digest = ports.digestSource(input.bodyFile);
    if (!digest.ok) return err(digest.error);
    contentSha256 = digest.value;
  } else {
    const file = input.file as string;
    const digest = ports.digestSource(file);
    if (!digest.ok) return err(digest.error);
    contentSha256 = digest.value;
  }
  const seen =
    input.idempotencyKey === undefined ? ok(null) : ports.handoffs.idempotencyLookup(input.idempotencyKey, "send");
  if (!seen.ok) return err(seen.error);
  // A newly registered descendant may activate the downgrade guard for a Workspace
  // that sent before registration. Its own exact stored request remains replayable.
  const legacyRequestHash = sendRequestHash({
    to: input.to,
    title,
    contentSha256,
    supersedes: input.supersedes,
    kind: asBody ? "body" : "file",
  });
  const sender: Result<SenderIdentity | { kind: "user" }, AppError> =
    input.asUser === true
      ? ok({ kind: "user" })
      : resolveSenderIdentity(ports.projectPorts, {
          path: input.path,
          userHome: input.userHome,
          installationId: ports.projectPorts.installationId,
          allowUnregistered: input.allowUnregistered,
          as: input.as,
        });
  if (!sender.ok) {
    if (sender.error.code === "SENDER_IDENTITY_DOWNGRADE" && seen.value !== null && input.as === undefined) {
      const path = ports.projectPorts.bindings.realPath(input.path, input.userHome);
      if (!path.ok) return err(path.error);
      const key = workspaceKey(ports.projectPorts.installationId, path.value);
      const original = JSON.parse(seen.value.responseJson) as SendOutcome;
      const firstId = original.handoffs[0]?.handoffId;
      if (firstId !== undefined) {
        const originalSender = ports.handoffs.senderOfHandoff(firstId);
        if (!originalSender.ok) return err(originalSender.error);
        const workspaceRequestHash = sendRequestHash({
          to: input.to,
          title,
          contentSha256,
          supersedes: input.supersedes,
          kind: asBody ? "body" : "file",
          sender: `unregistered_workspace:${key}`,
        });
        if (
          originalSender.value?.kind === "unregistered_workspace" &&
          originalSender.value.workspaceKey === key &&
          (seen.value.requestHash === workspaceRequestHash || seen.value.requestHash === legacyRequestHash)
        ) {
          return ok({ ...original, replayed: true });
        }
      }
    }
    return err(sender.error);
  }
  const senderId = senderColumns(sender.value);
  const requestHash = sendRequestHash({
    to: input.to,
    title,
    contentSha256,
    supersedes: input.supersedes,
    kind: asBody ? "body" : "file",
    sender: `${senderId.senderKind}:${senderId.senderProjectId ?? senderId.senderWorkspaceKey ?? "user"}`,
  });
  const replaySeen = (
    record: { requestHash: string; responseJson: string } | null,
  ): Result<SendOutcome | null, AppError> => {
    if (record !== null) {
      let identical = record.requestHash === requestHash;
      if (!identical) {
        const prior = JSON.parse(record.responseJson) as SendOutcome;
        const firstId = prior.handoffs[0]?.handoffId;
        if (firstId !== undefined) {
          const originalSender = ports.handoffs.senderOfHandoff(firstId);
          if (!originalSender.ok) return err(originalSender.error);
          const sameSender =
            originalSender.value?.kind === senderId.senderKind &&
            originalSender.value.projectId === senderId.senderProjectId &&
            originalSender.value.workspaceKey === senderId.senderWorkspaceKey;
          let inheritedWorkspace = false;
          let priorWorkspaceHash: string | null = null;
          if (
            sender.value.kind === "registered_project" &&
            input.as === undefined &&
            originalSender.value?.kind === "unregistered_workspace"
          ) {
            const path = ports.projectPorts.bindings.realPath(input.path, input.userHome);
            if (!path.ok) return err(path.error);
            const key = workspaceKey(ports.projectPorts.installationId, path.value);
            inheritedWorkspace = originalSender.value.workspaceKey === key;
            priorWorkspaceHash = sendRequestHash({
              to: input.to,
              title,
              contentSha256,
              supersedes: input.supersedes,
              kind: asBody ? "body" : "file",
              sender: `unregistered_workspace:${key}`,
            });
          }
          identical =
            (record.requestHash === legacyRequestHash && (sameSender || inheritedWorkspace)) ||
            (priorWorkspaceHash !== null && record.requestHash === priorWorkspaceHash && inheritedWorkspace);
        }
      }
      if (!identical) {
        if (sender.value.kind === "registered_project" && sender.value.project.status === "archived") {
          return err(
            appError("PROJECT_ARCHIVED", "the sender Project is archived and sends no new Handoffs", {
              slug: sender.value.project.slug,
            }),
          );
        }
        return err(
          appError(
            "IDEMPOTENCY_CONFLICT",
            "this idempotency key was used with a different request; use a new key or replay the identical request",
            {
              idempotencyKey: input.idempotencyKey,
            },
          ),
        );
      }
      const replayed = JSON.parse(record.responseJson) as SendOutcome;
      return ok({ ...replayed, replayed: true });
    }
    return ok(null);
  };
  const replay = replaySeen(seen.value);
  if (!replay.ok) return err(replay.error);
  if (replay.value !== null) {
    return ok(replay.value);
  }

  if (sender.value.kind === "registered_project" && sender.value.project.status === "archived") {
    return err(
      appError("PROJECT_ARCHIVED", "the sender Project is archived and sends no new Handoffs", {
        slug: sender.value.project.slug,
      }),
    );
  }

  // One recipient Handoff per distinct recipient, in first-seen order; an ineligible
  // recipient creates nothing at all (PRJ-012).
  const recipients: Array<{ slug: string; projectId: string }> = [];
  const seenSlugs = new Set<string>();
  for (const slug of input.to) {
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    const eligible = checkRecipientEligibility(ports.projectPorts, slug);
    if (!eligible.ok) return err(eligible.error);
    recipients.push({ slug, projectId: eligible.value.id });
  }
  if (recipients.length === 0) {
    return err(appError("CONFIG_INVALID", "send requires at least one --to recipient"));
  }

  // The supersedes link: the target must exist and be terminal; a tombstone qualifies
  // and the recipient need not match (HND-018).
  if (input.supersedes !== undefined) {
    const target = ports.handoffs.findSupersedesTarget(input.supersedes);
    if (!target.ok) return err(target.error);
    if (target.value === null) {
      return err(
        appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${input.supersedes}'`, { handoffId: input.supersedes }),
      );
    }
    const state = target.value.reviewState;
    const terminal =
      state === "accepted" || state === "declined" || state === "withdrawn" || target.value.deletedAt !== null;
    if (!terminal) {
      return err(
        appError("HANDOFF_NOT_TERMINAL", "the --supersedes target is not in a terminal review state; reach one first", {
          handoffId: input.supersedes,
        }),
      );
    }
  }

  const now = ports.clock.now().toISOString();
  const dispatchGroupId = recipients.length > 1 ? ports.ids.next() : null;
  const actor = senderActorRef(sender.value);
  const columns = senderColumns(sender.value);
  const workspaceRoot = ports.projectPorts.bindings.realPath(input.path, input.userHome);
  if (!workspaceRoot.ok) return err(workspaceRoot.error);

  // Resolve the file sources' policy once, before the per-recipient loop: the
  // containment and external-source rules answer per source, not per recipient,
  // and a refusal here still precedes any staging or transaction (CP-1).
  let fileSource: {
    physicalPath: string;
    logicalOriginalName: string;
    sourceKind: "workspace-path" | "authenticated-spool";
    importedFromPath: string | null;
  } | null = null;
  if (input.file !== undefined) {
    const file = input.file;
    const spoolUpload = input.fileSourceKind === "authenticated-spool";
    const inspected = ports.inspectSource(file, input.userHome);
    if (!inspected.ok) return err(inspected.error);
    const contained = checkVaultContainment({
      resolvedVaultPath: ports.config.vaultPath,
      resolvedBindingDirectories: ports.bindingDirectories,
    });
    if (!contained.ok) return err(contained.error);
    // The workspace external-source rule governs path imports; an
    // authenticated multipart upload is its own already-authenticated source
    // and never a workspace claim (API-003, SEC-006).
    if (!spoolUpload) {
      const external = checkExternalSource({
        resolvedSourcePath: inspected.value.resolvedSourcePath,
        workspaceRoot: workspaceRoot.value,
        policy: "workspace_or_explicit",
        allowExternalSource: input.allowExternalSource,
      });
      if (!external.ok) return err(external.error);
    }
    fileSource = {
      physicalPath: inspected.value.resolvedSourcePath,
      // A browser upload hands over an opaque spool path, so the route names
      // the user's file; a path import keeps the inspected name.
      logicalOriginalName: input.originalName ?? inspected.value.originalName,
      sourceKind: spoolUpload ? "authenticated-spool" : "workspace-path",
      importedFromPath: spoolUpload ? null : file,
    };
  } else if (input.bodyFile !== undefined) {
    // A streamed compose body is an authenticated spool: its recorded logical
    // name follows the title-slug Markdown rule, and the opaque spool path
    // never contributes an extension (HND-023, API-013).
    fileSource = {
      physicalPath: input.bodyFile,
      logicalOriginalName: storedName,
      sourceKind: "authenticated-spool",
      importedFromPath: null,
    };
  }

  // Prepare every recipient's body before any transaction: the one shared
  // routing implementation classifies by the logical name's MIME allowlist and
  // routes at the fixed threshold — inline text, or a staged Vault copy — so an
  // injected failure here leaves zero Handoffs and only sweepable staged files
  // (CP-1, SHR-002, section 38.2).
  const preparedBodies: Array<{
    recipient: { slug: string; projectId: string };
    handoffId: string;
    artifactId: string;
    prepared: PreparedArtifactBody;
  }> = [];
  for (const recipient of recipients) {
    const handoffId = ports.ids.next();
    const artifactId = ports.ids.next();
    const prepared = ports.content.prepareArtifactBody({
      body:
        input.body !== undefined
          ? { kind: "text", text: input.body, logicalName: storedName }
          : {
              kind: "file",
              physicalPath: (fileSource as { physicalPath: string }).physicalPath,
              logicalOriginalName: (fileSource as { logicalOriginalName: string }).logicalOriginalName,
              sourceKind: (fileSource as { sourceKind: "workspace-path" | "authenticated-spool" }).sourceKind,
            },
      classification: "mime-first",
      identities: { handoffId, artifactId },
      bounds: { maxBytes: ports.config.maxBytes },
      provenance: { importedFromPath: fileSource?.importedFromPath ?? null },
    });
    if (!prepared.ok) return err(prepared.error);
    preparedBodies.push({ recipient, handoffId, artifactId, prepared: prepared.value });
  }

  // One all-or-nothing transaction: every Handoff row, its Artifact row, its
  // content record and — for a file-backed body only — its activate intent and
  // HANDOFF_CREATED event, plus the idempotency response when keyed.
  const vaultPrefix = `${ports.config.vaultPath.replace(/\/+$/, "")}/`;
  const handoffRecords: NewHandoffRecord[] = preparedBodies.map(({ recipient, handoffId, artifactId }) => ({
    id: handoffId,
    dispatchGroupId,
    supersedesHandoffId: input.supersedes ?? null,
    title,
    ...columns,
    recipientProjectId: recipient.projectId,
    currentArtifactId: artifactId,
    createdAt: now,
  }));
  const artifactRecords: NewArtifactRecord[] = preparedBodies.map(({ handoffId, artifactId, prepared }) => ({
    id: artifactId,
    handoffId,
    storageKey: prepared.storageKey,
    inlineBody: prepared.kind === "inline" ? prepared.text : null,
    originalName: prepared.logicalName,
    storedName: sanitizeStoredName(prepared.logicalName),
    mimeType: prepared.mimeType,
    sizeBytes: prepared.sizeBytes,
    sha256: prepared.sha256,
    importedFromPath: prepared.importedFromPath,
    createdAt: now,
  }));
  // An inline body commits materialized with no activation and no physical
  // event; a file-backed body keeps its staged copy and causal legacy intent.
  const intents: NewPendingFsOp[] = preparedBodies.flatMap(({ artifactId, prepared }) => {
    if (prepared.kind !== "file") return [];
    return [
      {
        id: ports.ids.next(),
        op: "activate" as const,
        fromPath: prepared.stagingPath.startsWith(vaultPrefix)
          ? prepared.stagingPath.slice(vaultPrefix.length)
          : prepared.stagingPath,
        toPath: prepared.storageKey,
        artifactId,
        createdAt: now,
      },
    ];
  });
  const events: NewDomainEvent[] = preparedBodies.map(({ handoffId, prepared }) => ({
    id: ports.ids.next(),
    handoffId,
    eventType: "HANDOFF_CREATED" as const,
    actor,
    rowVersion: 1,
    metadata: {
      title,
      dispatchGroupId,
      sha256: prepared.sha256,
      storageKey: prepared.storageKey,
    },
    createdAt: now,
  }));
  const outcome: SendOutcome = {
    handoffs: preparedBodies.map(({ recipient, handoffId, artifactId, prepared }) => ({
      handoffId,
      recipientSlug: recipient.slug,
      artifactId,
      storageKey: prepared.storageKey,
      revision: 1,
      rowVersion: 1,
      reviewState: "awaiting_recipient",
    })),
    dispatchGroupId,
    replayed: false,
  };
  let registeredSender: FanoutCommit["registeredSender"];
  if (sender.value.kind === "registered_project") {
    if (input.as !== undefined) {
      registeredSender = { projectId: sender.value.project.id, asOverride: true };
    } else {
      const path = ports.projectPorts.bindings.realPath(input.path, input.userHome);
      if (!path.ok) return err(path.error);
      registeredSender = {
        projectId: sender.value.project.id,
        asOverride: false,
        bindingId: sender.value.binding.id,
        directory: path.value,
        gitCommonDirectory: ports.projectPorts.bindings.gitCommonDirectory(path.value),
      };
    }
  }
  const committed = ports.handoffs.createFanout({
    handoffs: handoffRecords,
    ...(registeredSender === undefined ? {} : { registeredSender }),
    ...(sender.value.kind === "unregistered_workspace"
      ? {
          unregisteredSenderPath: {
            directory: sender.value.pathSnapshot,
            gitCommonDirectory: ports.projectPorts.bindings.gitCommonDirectory(sender.value.pathSnapshot),
            allowUnregistered: input.allowUnregistered,
          },
        }
      : {}),
    artifacts: artifactRecords,
    intents,
    events,
    idempotency:
      input.idempotencyKey !== undefined
        ? {
            key: input.idempotencyKey,
            scope: "send",
            requestHash,
            responseJson: JSON.stringify(outcome),
            expiresAt: new Date(ports.clock.now().getTime() + 24 * 3_600_000).toISOString(),
          }
        : undefined,
  });
  if (!committed.ok) {
    // Another writer may have committed the same key after the first lookup but
    // before this transaction. Re-evaluate the stored request after rollback.
    if (input.idempotencyKey !== undefined) {
      const latest = ports.handoffs.idempotencyLookup(input.idempotencyKey, "send");
      if (!latest.ok) return err(latest.error);
      const racedReplay = replaySeen(latest.value);
      if (!racedReplay.ok) return err(racedReplay.error);
      if (racedReplay.value !== null) return ok(racedReplay.value);
    }
    return err(committed.error);
  }

  // The fanout commit succeeded, so the original source body is durably stored:
  // fire the large-content Git-history disclosure once per source body — never
  // per fan-out copy — before any activation runs, so a later activation
  // failure still disclosed the growth (SHR-011, WR2). A racing-replay return
  // above never reaches this point, so a replayed send never notifies.
  if (ports.disclosures !== undefined && ports.disclosures.backupEnabled) {
    const sourceBytes = preparedBodies[0]?.prepared.sizeBytes;
    if (sourceBytes !== undefined && sourceBytes > ports.disclosures.thresholdBytes) {
      try {
        ports.disclosures.largeContent(sourceBytes, ports.disclosures.thresholdBytes);
      } catch {
        // A diagnostic sink failure never changes the committed outcome.
      }
    }
  }

  // Execute the committed file intents outside any transaction, then complete
  // each in one short transaction: materialized, intent cleared, activation
  // event appended. A failed activation stays pending for the idempotent drain
  // (CP-2 to CP-4). An inline body has no intent and no physical event: its
  // record committed materialized in the fanout transaction.
  const completions: Array<{ intentId: string; artifactId: string; event: NewDomainEvent }> = [];
  let intentIndex = 0;
  for (const entry of preparedBodies) {
    if (entry.prepared.kind !== "file") continue;
    const intent = intents[intentIndex] as NewPendingFsOp;
    intentIndex += 1;
    const activated = ports.artifactStore.activate({
      stagingPath: entry.prepared.stagingPath,
      storageKey: entry.prepared.storageKey,
    });
    if (!activated.ok) continue;
    completions.push({
      intentId: intent.id,
      artifactId: entry.artifactId,
      event: {
        id: ports.ids.next(),
        handoffId: entry.handoffId,
        eventType: "ARTIFACT_ACTIVATED",
        actor: SYSTEM_ACTOR,
        rowVersion: null,
        metadata: { storageKey: entry.prepared.storageKey, sha256: entry.prepared.sha256 },
        createdAt: ports.clock.now().toISOString(),
      },
    });
  }
  if (completions.length > 0) {
    const completed = ports.handoffs.completeActivations(completions);
    if (!completed.ok) return err(completed.error);
  }
  return ok(outcome);
}
