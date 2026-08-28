import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, projectActor, USER_ACTOR } from "./events";
import { decodeCursor, encodeCursor, filterHash } from "./cursor";
import { deriveNextActors, type ReviewState } from "./handoffs";
import { type ProjectCommandPorts, resolveWorkspaceActor } from "./project-commands";
import { workspaceKey as deriveWorkspaceKey } from "./workspace-identity";

/**
 * The read side of the Handoff surface (HND-010 to HND-012, HND-020, HND-024, VLT-009,
 * CLI-009, CLI-010, NFR-006): participant-only listings and reads that never mutate,
 * `fetch` as the one surface that records the first recipient or User fetch, and the
 * deterministic cursor pagination of section 19 of interfaces-and-operations.md.
 */

export interface HandoffArtifactSummary {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  materialized: boolean;
}

export interface HandoffView {
  id: string;
  dispatchGroupId: string | null;
  supersedesHandoffId: string | null;
  title: string;
  senderKind: "registered_project" | "unregistered_workspace" | "user";
  senderProjectId: string | null;
  senderProjectSlug: string | null;
  senderWorkspaceKey: string | null;
  /** The historical provenance snapshot of the original send (PRJ-020). */
  senderPathSnapshot: string | null;
  recipientProjectId: string;
  recipientProjectSlug: string;
  revision: number;
  rowVersion: number;
  reviewState: ReviewState;
  nextActors: { reviewNextActor: "recipient" | "sender" | null; administrativeNextActor: "user" | null };
  firstFetchedAt: string | null;
  reviewEngagedAt: string | null;
  pinned: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  currentArtifact: HandoffArtifactSummary | null;
  createdAt: string;
  updatedAt: string;
  /** Derived for the next-actor exposure; never a status column (HND-013). */
  pendingDeletionRequest: boolean;
}

export interface HandoffListFilters {
  state?: string | undefined;
  senderSlug?: string | undefined;
  recipientSlug?: string | undefined;
  includeArchived: boolean;
  includeDeleted: boolean;
}

export type ListingScope =
  | { kind: "inbox"; recipientProjectId: string }
  | { kind: "outbox_project"; senderProjectId: string }
  | { kind: "outbox_workspace"; workspaceKey: string }
  | { kind: "all" };

export interface HandoffReadPort {
  /** One keyset page in the fixed (updatedAt DESC, id DESC) order; no events. */
  listPage(
    scope: ListingScope,
    filters: HandoffListFilters,
    limit: number,
    afterSortKey: string | null,
  ): Result<{ items: HandoffView[]; lastSortKey: string | null }, AppError>;
  /** The full view of one Handoff, or null when the id does not exist. */
  findHandoffView(id: string): Result<HandoffView | null, AppError>;
  /** Records the first fetch in its own short transaction; never a Row Version bump. */
  recordFirstFetch(handoffId: string, event: NewDomainEvent): Result<void, AppError>;
}

export interface HandoffReadPorts {
  projectPorts: ProjectCommandPorts;
  handoffs: HandoffReadPort;
  config: { vaultPath: string; verifyChecksumOnFetch: boolean };
  artifact: {
    checksum(storageKey: string): Result<string, AppError>;
    pathOf(storageKey: string): Result<string, AppError>;
  };
  ids: { next(): string };
  clock: { now(): Date };
}

export interface ListQuery {
  limit: number;
  cursor?: string | undefined;
  filters: HandoffListFilters;
}

export interface ListedHandoffs {
  handoffs: HandoffView[];
  nextCursor: string | null;
}

function filterIdentity(filters: HandoffListFilters, scope: ListingScope): string {
  return filterHash({
    scopeKind: scope.kind,
    scopeId:
      scope.kind === "inbox"
        ? scope.recipientProjectId
        : scope.kind === "outbox_project"
          ? scope.senderProjectId
          : scope.kind === "outbox_workspace"
            ? scope.workspaceKey
            : null,
    state: filters.state ?? null,
    senderSlug: filters.senderSlug ?? null,
    recipientSlug: filters.recipientSlug ?? null,
    includeArchived: filters.includeArchived,
    includeDeleted: filters.includeDeleted,
  });
}

function runListing(ports: HandoffReadPorts, scope: ListingScope, query: ListQuery): Result<ListedHandoffs, AppError> {
  const identity = filterIdentity(query.filters, scope);
  let afterSortKey: string | null = null;
  let limit = query.limit;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor, identity);
    if (!decoded.ok) return err(decoded.error);
    afterSortKey = decoded.value.lastSortKey;
    limit = decoded.value.limit;
  }
  const page = ports.handoffs.listPage(scope, query.filters, limit + 1, afterSortKey);
  if (!page.ok) return err(page.error);
  const overflow = page.value.items.length > limit;
  const items = overflow ? page.value.items.slice(0, limit) : page.value.items;
  const last = items[items.length - 1];
  const nextCursor =
    overflow && last !== undefined
      ? encodeCursor({ filterHash: identity, lastSortKey: `${last.updatedAt}|${last.id}`, limit })
      : null;
  return ok({ handoffs: items, nextCursor });
}

export interface ReadActorInput {
  path: string;
  userHome: string;
  as: string | undefined;
  asUser: boolean | undefined;
}

export function listInbox(
  ports: HandoffReadPorts,
  actorInput: ReadActorInput,
  query: ListQuery,
): Result<ListedHandoffs, AppError> {
  if (actorInput.asUser === true) {
    return runListing(ports, { kind: "all" }, query);
  }
  const resolved = resolveRegisteredProject(ports, actorInput);
  if (!resolved.ok) return err(resolved.error);
  return runListing(ports, { kind: "inbox", recipientProjectId: resolved.value }, query);
}

export function listOutbox(
  ports: HandoffReadPorts,
  actorInput: ReadActorInput,
  query: ListQuery,
  currentWorkspace: boolean,
): Result<ListedHandoffs, AppError> {
  if (actorInput.asUser === true && !currentWorkspace) {
    return runListing(ports, { kind: "all" }, query);
  }
  const workspace = resolveWorkspaceKeyOf(ports, actorInput);
  if (!workspace.ok) return err(workspace.error);
  if (currentWorkspace || actorInput.asUser === true) {
    return runListing(ports, { kind: "outbox_workspace", workspaceKey: workspace.value.key }, query);
  }
  const registered = resolveRegisteredProjectOrNull(ports, actorInput);
  if (registered !== null) {
    return runListing(ports, { kind: "outbox_project", senderProjectId: registered }, query);
  }
  return runListing(ports, { kind: "outbox_workspace", workspaceKey: workspace.value.key }, query);
}

export function getHandoff(
  ports: HandoffReadPorts,
  actorInput: ReadActorInput,
  id: string,
): Result<HandoffView, AppError> {
  const found = ports.handoffs.findHandoffView(id);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${id}'`, { handoffId: id }));
  }
  const participant = participantRoleOf(ports, actorInput, found.value);
  if (participant === null) {
    return err(
      appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request", { handoffId: id }),
    );
  }
  return ok(found.value);
}

export interface FetchedHandoff {
  handoff: HandoffView;
  artifact: HandoffArtifactSummary;
  localPath: string;
}

export function fetchHandoff(
  ports: HandoffReadPorts,
  actorInput: ReadActorInput,
  id: string,
): Result<FetchedHandoff, AppError> {
  const found = ports.handoffs.findHandoffView(id);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(appError("HANDOFF_NOT_FOUND", `no Handoff has the id '${id}'`, { handoffId: id }));
  }
  const handoff = found.value;
  if (handoff.deletedAt !== null) {
    return err(
      appError(
        "HANDOFF_DELETED",
        "the Handoff is a tombstone; use get or a listing with --include-deleted, or create a new Handoff",
        { handoffId: id },
      ),
    );
  }
  const role = participantRoleOf(ports, actorInput, handoff);
  if (role === null) {
    return err(
      appError("HANDOFF_NOT_FOUND", "no Handoff this actor participates in matches the request", { handoffId: id }),
    );
  }
  if (handoff.currentArtifact === null) {
    return err(
      appError(
        "ARTIFACT_MATERIALIZING",
        "the Handoff has no current Artifact row; retry after the next process start drains the intent",
        { handoffId: id },
      ),
    );
  }
  if (!handoff.currentArtifact.materialized) {
    return err(
      appError(
        "ARTIFACT_MATERIALIZING",
        "the current Artifact has not reached its storage key yet; retry after the next process start drains the intent",
        { handoffId: id },
      ),
    );
  }
  if (ports.config.verifyChecksumOnFetch) {
    const checksum = ports.artifact.checksum(handoff.currentArtifact.storageKey);
    if (!checksum.ok) return err(checksum.error);
    if (checksum.value.toLowerCase() !== handoff.currentArtifact.sha256.toLowerCase()) {
      return err(
        appError(
          "ARTIFACT_CORRUPTED",
          "the recomputed checksum does not match the recorded Artifact digest; run sorage vault verify and restore from backup",
          { handoffId: id },
        ),
      );
    }
  }
  const path = ports.artifact.pathOf(handoff.currentArtifact.storageKey);
  if (!path.ok) return err(path.error);
  // Only the recipient Project and the User record a first fetch; a sender fetch of
  // its own Handoff sets nothing and emits nothing (HND-012).
  const firstFetchEligible = role === "recipient" || role === "user";
  if (firstFetchEligible && handoff.firstFetchedAt === null) {
    const actor = role === "user" ? USER_ACTOR : projectActor(handoff.recipientProjectId);
    const recorded = ports.handoffs.recordFirstFetch(handoff.id, {
      id: ports.ids.next(),
      handoffId: handoff.id,
      eventType: "ARTIFACT_FETCHED_FIRST_TIME",
      actor,
      rowVersion: null,
      metadata: { artifactId: handoff.currentArtifact.id, sha256: handoff.currentArtifact.sha256 },
      createdAt: ports.clock.now().toISOString(),
    });
    if (!recorded.ok) return err(recorded.error);
  }
  return ok({ handoff, artifact: handoff.currentArtifact, localPath: path.value });
}

/** The actor's role relative to the Handoff, or null when it does not participate. */
function participantRoleOf(
  ports: HandoffReadPorts,
  actorInput: ReadActorInput,
  handoff: HandoffView,
): "sender" | "recipient" | "user" | "workspace" | null {
  if (actorInput.asUser === true) return "user";
  const workspace = resolveWorkspaceKeyOf(ports, actorInput);
  const key = workspace.ok ? workspace.value.key : null;
  if (handoff.senderKind === "registered_project" && handoff.senderProjectId !== null) {
    const registered = resolveRegisteredProjectOrNull(ports, actorInput);
    if (registered !== null && registered === handoff.senderProjectId) return "sender";
  }
  if (handoff.senderKind === "unregistered_workspace" && key !== null && handoff.senderWorkspaceKey === key) {
    return "workspace";
  }
  const registered2 = resolveRegisteredProjectOrNull(ports, actorInput);
  if (registered2 !== null && registered2 === handoff.recipientProjectId) {
    return "recipient";
  }
  return null;
}

function resolveRegisteredProject(ports: HandoffReadPorts, actorInput: ReadActorInput): Result<string, AppError> {
  const id = resolveRegisteredProjectOrNull(ports, actorInput);
  if (id === null) {
    return err(
      appError(
        "FORBIDDEN_ACTOR",
        "the resolved actor is not a registered Project; run from a bound directory or use --as or --as-user",
      ),
    );
  }
  return ok(id);
}

function resolveRegisteredProjectOrNull(ports: HandoffReadPorts, actorInput: ReadActorInput): string | null {
  const resolved = resolveWorkspaceActor(ports.projectPorts, {
    path: actorInput.path,
    userHome: actorInput.userHome,
    as: actorInput.as,
  });
  if (!resolved.ok) return null;
  if (resolved.value.kind === "registered_project") return resolved.value.project.id;
  return null;
}

function resolveWorkspaceKeyOf(ports: HandoffReadPorts, actorInput: ReadActorInput): Result<{ key: string }, AppError> {
  const resolved = resolveWorkspaceActor(ports.projectPorts, {
    path: actorInput.path,
    userHome: actorInput.userHome,
    as: actorInput.as,
  });
  if (!resolved.ok) return err(resolved.error);
  if (resolved.value.kind === "registered_project") {
    // A registered Project acting from a bound directory still has a workspace key
    // for the --current-workspace view: the binding's directory is the workspace.
    return ok({ key: deriveWorkspaceKey(ports.projectPorts.installationId, resolved.value.binding.directory) });
  }
  return ok({ key: deriveWorkspaceKey(ports.projectPorts.installationId, resolved.value.directory) });
}
