import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type ActorRef, type NewDomainEvent, projectActor, SYSTEM_ACTOR, USER_ACTOR, workspaceActor } from "./events";
import { type ArtifactStore, buildStorageKey } from "./artifacts";
import { classifyMimeType, type PreparedImport, prepareArtifactImport } from "./import-policy";
import { type ProjectCommandPorts, checkRecipientEligibility } from "./project-commands";
import type { NewPendingFsOp } from "./intent-log";
import { resolveSenderIdentity, type SenderIdentity } from "./workspace-identity";
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
}

export interface SentHandoff {
  handoffId: string;
  recipientSlug: string;
  artifactId: string;
  storageKey: string;
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
  storageKey: string;
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
}

export interface SendPorts {
  projectPorts: ProjectCommandPorts;
  handoffs: HandoffWritePort;
  artifactStore: ArtifactStore;
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
  /** Writes the `--body` text to a scratch source file and returns its path (HND-023). */
  writeBodySource(text: string, storedName: string): Result<{ sourcePath: string; cleanup: () => void }, AppError>;
  /** Digests a file with a bounded read, for the idempotency request hash (CLI-021). */
  digestSource(path: string): Result<string, AppError>;
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
}): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    title: input.title,
    to: [...new Set(input.to)].sort(),
    content: input.contentSha256,
    supersedes: input.supersedes ?? null,
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

  const cleanups: Array<() => void> = [];
  try {
    return sendStaged(ports, input, title, cleanups);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
}

function sendStaged(
  ports: SendPorts,
  input: SendInput,
  title: string,
  cleanups: Array<() => void>,
): Result<SendOutcome, AppError> {
  // The request hash needs the content digest, so the body or file is digested before
  // anything else: the idempotency replay is evaluated first, before any eligibility,
  // supersedes, or Row Version check (API-012).
  let contentSha256: string;
  let bodySource: { sourcePath: string; cleanup: () => void } | null = null;
  const asBody = input.body !== undefined || input.bodyFile !== undefined;
  const storedName = asBody ? `${titleSlug(title)}-1.md` : "";
  if (input.body !== undefined) {
    contentSha256 = createHash("sha256").update(input.body, "utf8").digest("hex");
    const written = ports.writeBodySource(input.body, storedName);
    if (!written.ok) return err(written.error);
    bodySource = written.value;
    cleanups.push(written.value.cleanup);
  } else if (input.bodyFile !== undefined) {
    const digest = ports.digestSource(input.bodyFile);
    if (!digest.ok) return err(digest.error);
    contentSha256 = digest.value;
    bodySource = { sourcePath: input.bodyFile, cleanup: () => undefined };
  } else {
    const file = input.file as string;
    const digest = ports.digestSource(file);
    if (!digest.ok) return err(digest.error);
    contentSha256 = digest.value;
  }
  const requestHash = sendRequestHash({
    to: input.to,
    title,
    contentSha256,
    supersedes: input.supersedes,
    kind: asBody ? "body" : "file",
  });

  if (input.idempotencyKey !== undefined) {
    const seen = ports.handoffs.idempotencyLookup(input.idempotencyKey, "send");
    if (!seen.ok) return err(seen.error);
    if (seen.value !== null) {
      if (seen.value.requestHash !== requestHash) {
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
      const replayed = JSON.parse(seen.value.responseJson) as SendOutcome;
      return ok({ ...replayed, replayed: true });
    }
  }

  // The sender identity, with the downgrade guard of section 22.3 (PRJ-019).
  const sender: Result<SenderIdentity | { kind: "user" }, AppError> =
    input.asUser === true
      ? ok({ kind: "user" })
      : resolveSenderIdentity(ports.projectPorts, {
          path: input.path,
          userHome: input.userHome,
          installationId: ports.projectPorts.installationId,
          allowUnregistered: input.allowUnregistered || ports.config.allowUnregisteredSenders,
          as: input.as,
        });
  if (!sender.ok) return err(sender.error);
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

  // Stage every recipient's copy before any transaction: an injected failure here
  // leaves zero Handoffs and only sweepable staged files (CP-1).
  const staged: Array<{
    recipient: { slug: string; projectId: string };
    handoffId: string;
    artifactId: string;
    prepared: PreparedImport;
  }> = [];
  for (const recipient of recipients) {
    const handoffId = ports.ids.next();
    const artifactId = ports.ids.next();
    // A --body send is explicit user content, so the external-source rule does not
    // apply to it; the containment, sanitization, and staging halves still do (HND-023).
    const prepared: Result<PreparedImport, AppError> =
      bodySource !== null
        ? (() => {
            const stagedFile = ports.artifactStore.stage({
              sourcePath: bodySource.sourcePath,
              maxBytes: ports.config.maxBytes,
            });
            if (!stagedFile.ok) return err(stagedFile.error);
            const key = buildStorageKey({ handoffId, artifactId, storedName });
            if (!key.ok) return err(key.error);
            const bodyImport: PreparedImport = {
              ...stagedFile.value,
              originalName: storedName,
              storedName,
              mimeType: classifyMimeType(storedName),
              storageKey: key.value,
              importedFromPath: null,
            };
            return ok(bodyImport);
          })()
        : (() => {
            const file = input.file as string;
            const inspected = ports.inspectSource(file, input.userHome);
            if (!inspected.ok) return err(inspected.error);
            return prepareArtifactImport(
              { artifactStore: ports.artifactStore },
              {
                sourcePath: file,
                resolvedSourcePath: inspected.value.resolvedSourcePath,
                // A browser upload hands over an opaque spool path, so the route
                // names the user's file; a path import keeps the inspected name.
                originalName: input.originalName ?? inspected.value.originalName,
                workspaceRoot: workspaceRoot.value,
                externalPolicy: "workspace_or_explicit",
                allowExternalSource: input.allowExternalSource,
                maxBytes: ports.config.maxBytes,
                handoffId,
                artifactId,
                resolvedVaultPath: ports.config.vaultPath,
                resolvedBindingDirectories: ports.bindingDirectories,
              },
            );
          })();
    if (!prepared.ok) return err(prepared.error);
    staged.push({ recipient, handoffId, artifactId, prepared: prepared.value });
  }

  // One all-or-nothing transaction: every Handoff row, its Artifact row, its activate
  // intent, and its HANDOFF_CREATED event, plus the idempotency response when keyed.
  const vaultPrefix = `${ports.config.vaultPath.replace(/\/+$/, "")}/`;
  const handoffRecords: NewHandoffRecord[] = staged.map(({ recipient, handoffId, artifactId }) => ({
    id: handoffId,
    dispatchGroupId,
    supersedesHandoffId: input.supersedes ?? null,
    title,
    ...columns,
    recipientProjectId: recipient.projectId,
    currentArtifactId: artifactId,
    createdAt: now,
  }));
  const artifactRecords: NewArtifactRecord[] = staged.map(({ handoffId, artifactId, prepared }) => ({
    id: artifactId,
    handoffId,
    storageKey: prepared.storageKey,
    originalName: prepared.originalName,
    storedName: prepared.storedName,
    mimeType: prepared.mimeType,
    sizeBytes: prepared.sizeBytes,
    sha256: prepared.sha256,
    importedFromPath: prepared.importedFromPath,
    createdAt: now,
  }));
  const intents: NewPendingFsOp[] = staged.map(({ artifactId, prepared }) => ({
    id: ports.ids.next(),
    op: "activate" as const,
    fromPath: prepared.stagingPath.startsWith(vaultPrefix)
      ? prepared.stagingPath.slice(vaultPrefix.length)
      : prepared.stagingPath,
    toPath: prepared.storageKey,
    artifactId,
    createdAt: now,
  }));
  const events: NewDomainEvent[] = staged.map(({ handoffId, prepared }) => ({
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
    handoffs: staged.map(({ recipient, handoffId, artifactId, prepared }) => ({
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
  const committed = ports.handoffs.createFanout({
    handoffs: handoffRecords,
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
  if (!committed.ok) return err(committed.error);

  // Execute the committed intents outside any transaction, then complete each in one
  // short transaction: materialized, intent cleared, activation event appended. A
  // failed activation stays pending for the idempotent drain (CP-2 to CP-4).
  const completions: Array<{ intentId: string; artifactId: string; event: NewDomainEvent }> = [];
  for (const [index, entry] of staged.entries()) {
    const activated = ports.artifactStore.activate({
      stagingPath: entry.prepared.stagingPath,
      storageKey: entry.prepared.storageKey,
    });
    if (!activated.ok) continue;
    const intent = intents[index] as NewPendingFsOp;
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
