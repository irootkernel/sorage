import { decodeCursor, encodeCursor, filterHash } from "./cursor";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type NewDomainEvent, projectActor, USER_ACTOR } from "./events";
import type { ReviewState } from "./handoffs";
import { type ProjectCommandPorts, resolveWorkspaceActor } from "./project-commands";
import type { ReviewNoteView } from "./review-commands";
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
  /** True while a Review Note exists; the section 4.2 guard input for revisions. */
  hasReviewNote: boolean;
  /** No-change resolutions since the last content revision (REV-017 bound). */
  consecutiveNoChangeResolutions: number;
}

export interface HandoffListFilters {
  state?: string | undefined;
  senderSlug?: string | undefined;
  recipientSlug?: string | undefined;
  /** Inclusive lower bound on updatedAt, as an ISO-8601 UTC instant (WEB-003). */
  updatedSince?: string | undefined;
  /** Inclusive upper bound on updatedAt, as an ISO-8601 UTC instant (WEB-003). */
  updatedUntil?: string | undefined;
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
    updatedSince: filters.updatedSince ?? null,
    updatedUntil: filters.updatedUntil ?? null,
    senderSlug: filters.senderSlug ?? null,
    recipientSlug: filters.recipientSlug ?? null,
    includeArchived: filters.includeArchived,
    includeDeleted: filters.includeDeleted,
  });
}

/** An ISO-8601 UTC instant with an optional fractional part, the bound shape (WEB-003). */
const UPDATED_BOUND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** `2026-08-01T00:00:00Z` and `2026-08-01T00:00:00.000Z` name one instant. */
function normalizeWholeSeconds(value: string): string {
  return /\.\d+Z$/.test(value) ? value : value.replace(/Z$/, ".000Z");
}

/**
 * Parses one bound into its canonical millisecond form. Stored `updatedAt`
 * values always carry three fractional digits, and a whole-second bound
 * compares lexicographically above `.5Z`, so every bound is normalized to the
 * stored shape before it reaches SQL or the reversed-bounds comparison;
 * impossible calendar values are rejected here rather than silently filtering
 * everything.
 */
function parseBound(field: string, value: string): Result<string, AppError> {
  if (!UPDATED_BOUND_PATTERN.test(value)) {
    return err(
      appError("CONFIG_INVALID", `the ${field} bound must be an ISO-8601 UTC instant like 2026-08-01T00:00:00Z`, {
        field,
        value,
      }),
    );
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return err(appError("CONFIG_INVALID", `the ${field} bound is not a real UTC instant: ${value}`, { field, value }));
  }
  const canonical = new Date(parsed).toISOString();
  // Exactly representable means the canonical millisecond form names the same
  // instant the input spelled: equal after an all-zero fractional tail is
  // dropped. A sub-millisecond remainder is refused rather than silently
  // reshaped into a neighboring millisecond the user never named.
  const trimmed = (text: string): string => text.replace(/(\.\d{3})0+Z$/, "$1Z").replace(/\.000Z$/, "Z");
  // ISO 8601 permits one or two fractional digits: pad a short fraction to the
  // canonical three before comparing, so `.0Z` and `.00Z` name their whole
  // millisecond instead of reading as a mismatch.
  const padded = (text: string): string =>
    text.replace(/\.(\d{1,2})Z$/, (_match, digits: string) => `.${digits.padEnd(3, "0")}Z`);
  if (trimmed(padded(canonical)) !== trimmed(padded(normalizeWholeSeconds(value)))) {
    return err(
      appError("CONFIG_INVALID", `the ${field} bound is finer than one millisecond: ${value}`, { field, value }),
    );
  }
  return ok(canonical);
}

function validateBounds(filters: HandoffListFilters): Result<null, AppError> {
  let since: string | null = null;
  let until: string | null = null;
  for (const [field, value] of [
    ["updatedSince", filters.updatedSince],
    ["updatedUntil", filters.updatedUntil],
  ] as const) {
    if (value === undefined) continue;
    const parsed = parseBound(field, value);
    if (!parsed.ok) return parsed;
    if (field === "updatedSince") {
      since = parsed.value;
      filters.updatedSince = parsed.value;
    } else {
      until = parsed.value;
      filters.updatedUntil = parsed.value;
    }
  }
  if (until !== null && since !== null && Date.parse(since) > Date.parse(until)) {
    return err(
      appError("CONFIG_INVALID", "the updatedSince bound is later than the updatedUntil bound", {
        updatedSince: since,
        updatedUntil: until,
      }),
    );
  }
  return ok(null);
}

function runListing(ports: HandoffReadPorts, scope: ListingScope, query: ListQuery): Result<ListedHandoffs, AppError> {
  const bounds = validateBounds(query.filters);
  if (!bounds.ok) return bounds;
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
  const scope = inboxScopeOf(ports, actorInput);
  if (!scope.ok) return err(scope.error);
  return runListing(ports, scope.value, query);
}

/** The inbox scope of the resolved actor: the User sees every Handoff, a Project only its own inbox. */
function inboxScopeOf(ports: HandoffReadPorts, actorInput: ReadActorInput): Result<ListingScope, AppError> {
  if (actorInput.asUser === true) {
    return ok({ kind: "all" });
  }
  const resolved = resolveRegisteredProject(ports, actorInput);
  if (!resolved.ok) return err(resolved.error);
  return ok({ kind: "inbox", recipientProjectId: resolved.value });
}

/** The knobs of one `inbox --wait` (CLI-020); the sleep is injected so tests drive time deterministically. */
export interface InboxWaitOptions {
  intervalSeconds: number;
  timeoutSeconds: number;
  sleepMs: (ms: number) => void;
}

/** What one wait returns: the items that appeared after the wait began, or an empty list on timeout. */
export interface WaitedInbox {
  handoffs: HandoffView[];
  timedOut: boolean;
}

/**
 * `inbox --wait` (CLI-020): polls the listing every `intervalSeconds` until a Handoff
 * that did not exist when the wait began appears for the resolved actor, or until
 * `timeoutSeconds` elapse. A state change on an item the waiter already saw is not a
 * new item and does not wake the wait, and the timeout result is the documented empty
 * list, never the items the waiter started from.
 */
function pageThrough(
  ports: HandoffReadPorts,
  scope: ListingScope,
  filters: HandoffListFilters,
  pageSize: number,
): Result<HandoffView[], AppError> {
  const items: HandoffView[] = [];
  let afterSortKey: string | null = null;
  for (;;) {
    const page = ports.handoffs.listPage(scope, filters, pageSize, afterSortKey);
    if (!page.ok) return page;
    items.push(...page.value.items);
    if (page.value.items.length < pageSize || page.value.lastSortKey === null) {
      return ok(items);
    }
    afterSortKey = page.value.lastSortKey;
  }
}

export function waitForNewInboxItems(
  ports: HandoffReadPorts,
  actorInput: ReadActorInput,
  query: ListQuery,
  options: InboxWaitOptions,
): Result<WaitedInbox, AppError> {
  const bounds = validateBounds(query.filters);
  if (!bounds.ok) return bounds;
  const scope = inboxScopeOf(ports, actorInput);
  if (!scope.ok) return err(scope.error);
  // The wait began now: no Handoff created after this instant can sort below an
  // item that has not changed since, which is what lets each poll stop paging at
  // the first item older than the wait.
  const startedAtIso = ports.clock.now().toISOString();
  // The known set must cover the whole filtered inbox, not only the first page:
  // an off-page item that changes state resurfaces at the head of a later poll,
  // and without the full seed it would falsely wake the wait as new.
  const initial = pageThrough(ports, scope.value, query.filters, query.limit);
  if (!initial.ok) return err(initial.error);
  const known = new Set(initial.value.map((handoff) => handoff.id));
  const deadlineMs = ports.clock.now().getTime() + options.timeoutSeconds * 1000;
  for (;;) {
    const remainingMs = deadlineMs - ports.clock.now().getTime();
    if (remainingMs <= 0) {
      return ok({ handoffs: [], timedOut: true });
    }
    options.sleepMs(Math.min(options.intervalSeconds * 1000, remainingMs));
    // A poll pages past churned known items, because enough of them can fill the
    // first page and hide a genuinely new item one page deeper until the timeout.
    let afterSortKey: string | null = null;
    let fresh: HandoffView[] = [];
    for (;;) {
      const page = ports.handoffs.listPage(scope.value, query.filters, query.limit, afterSortKey);
      if (!page.ok) return page;
      fresh = fresh.concat(page.value.items.filter((handoff) => !known.has(handoff.id)));
      const last = page.value.items[page.value.items.length - 1];
      if (fresh.length > 0 || page.value.items.length < query.limit || page.value.lastSortKey === null) {
        break;
      }
      // The first item last touched before the wait began is a safe cutoff:
      // nothing sorting below it can be new.
      if (last !== undefined && last.updatedAt < startedAtIso) {
        break;
      }
      afterSortKey = page.value.lastSortKey;
    }
    if (fresh.length > 0) {
      return ok({ handoffs: fresh, timedOut: false });
    }
  }
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

/** One metadata event of the bounded detail timeline; never Artifact bytes (HND-017). */
export interface HandoffEventView {
  id: string;
  eventType: string;
  actorKind: "registered_project" | "unregistered_workspace" | "user" | "system";
  actorId: string | null;
  rowVersion: number | null;
  createdAt: string;
}

/** The bounded number of timeline events the detail surface reads (WEB-004). */
export const HANDOFF_TIMELINE_LIMIT = 50;

export interface HandoffDetailReadPorts extends HandoffReadPorts {
  reviews: { findNote(handoffId: string): Result<ReviewNoteView | null, AppError> };
  events: { listRecent(handoffId: string, limit: number): Result<HandoffEventView[], AppError> };
}

function gatedHandoffView(
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

/** Reads the current Review Note, participant-gated like get itself (HND-020). */
export function readReviewNote(
  ports: HandoffDetailReadPorts,
  actorInput: ReadActorInput,
  id: string,
): Result<ReviewNoteView | null, AppError> {
  const gated = gatedHandoffView(ports, actorInput, id);
  if (!gated.ok) return err(gated.error);
  return ports.reviews.findNote(id);
}

/**
 * Reads the bounded recent timeline, participant-gated and newest-first, including
 * for a tombstone; the timeline never implies historical content is retrievable.
 */
export function readHandoffTimeline(
  ports: HandoffDetailReadPorts,
  actorInput: ReadActorInput,
  id: string,
): Result<HandoffEventView[], AppError> {
  const gated = gatedHandoffView(ports, actorInput, id);
  if (!gated.ok) return err(gated.error);
  return ports.events.listRecent(id, HANDOFF_TIMELINE_LIMIT);
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
