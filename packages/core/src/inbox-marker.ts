import { type AppError, ok, type Result } from "./errors";
import type { HandoffReadPorts, HandoffView, ListingScope } from "./handoff-read";

/**
 * The derived inbox marker of HND-026: when `handoff.inboxMarker` is enabled, every
 * Handoff creation and state change rewrites `.sorage/INBOX.md` under each recipient
 * binding directory as a rendered view of that recipient's current inbox. The marker
 * exists only to be noticed by a human or an agent sitting in the directory; it is
 * never read back as authority, deleting it is always safe, and the next state change
 * recreates it.
 */

/** Writes one derived marker atomically under `<binding-directory>/.sorage/INBOX.md`. */
export interface InboxMarkerWritePort {
  writeInboxMarker(bindingDirectory: string, content: string): Result<void, AppError>;
  removeInboxMarker(bindingDirectory: string): Result<void, AppError>;
}

export interface InboxMarkerPorts extends HandoffReadPorts {
  marker: {
    /** The effective `handoff.inboxMarker` flag of the current configuration. */
    enabled: boolean;
    writes: InboxMarkerWritePort;
    /** Serializes binding reads, marker writes, and retired-path cleanup across processes. */
    withLock<T>(body: () => Result<T, AppError>): Result<T, AppError>;
  };
}

/** One page bound of the marker's derived listing; the inbox is small by construction. */
const MARKER_PAGE_SIZE = 100;

export function renderInboxMarker(items: HandoffView[]): string {
  const lines = [
    "# Inbox",
    "",
    "Derived by Sorage from this Project's current inbox; never edit it and never read it as authority (HND-026).",
    "Deleting it is safe: the next Handoff creation or state change recreates it.",
    "",
  ];
  if (items.length === 0) {
    lines.push("- (no open Handoffs)");
  } else {
    for (const item of items) {
      lines.push(`- ${item.id} ${item.reviewState} "${item.title}" revision ${item.revision}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function currentInboxItems(ports: HandoffReadPorts, scope: ListingScope): Result<HandoffView[], AppError> {
  const items: HandoffView[] = [];
  let afterSortKey: string | null = null;
  for (;;) {
    const page = ports.handoffs.listPage(
      scope,
      { includeArchived: false, includeDeleted: false },
      MARKER_PAGE_SIZE,
      afterSortKey,
    );
    if (!page.ok) return page;
    items.push(...page.value.items);
    if (page.value.items.length < MARKER_PAGE_SIZE || page.value.lastSortKey === null) {
      return ok(items);
    }
    afterSortKey = page.value.lastSortKey;
  }
}

/**
 * Rewrites the marker of one Handoff's recipient under every binding directory of
 * that recipient. A disabled key, an unknown Handoff, or a recipient with no bindings
 * writes nothing and succeeds, because the marker is derived and advisory: the caller
 * renders a warning on stderr when this fails but never fails the command itself.
 */
export function refreshInboxMarker(
  ports: InboxMarkerPorts,
  handoffId: string,
): Result<{ written: string[]; skipped: boolean }, AppError> {
  if (!ports.marker.enabled) {
    return ok({ written: [], skipped: true });
  }
  const found = ports.handoffs.findHandoffView(handoffId);
  if (!found.ok) return found;
  if (found.value === null) {
    return ok({ written: [], skipped: true });
  }
  const recipientProjectId = found.value.recipientProjectId;
  return refreshProjectInboxMarker(ports, recipientProjectId);
}

/** Refreshes every current binding after a Project binding changes. */
export function refreshProjectInboxMarker(
  ports: InboxMarkerPorts,
  recipientProjectId: string,
): Result<{ written: string[]; skipped: boolean }, AppError> {
  if (!ports.marker.enabled) {
    return ok({ written: [], skipped: true });
  }
  return ports.marker.withLock(() => refreshProjectInboxMarkerUnlocked(ports, recipientProjectId));
}

/** Reconciles a binding move under the same lock used by Handoff marker refreshes. */
export function reconcileReboundInboxMarker(
  ports: InboxMarkerPorts,
  recipientProjectId: string,
  oldDirectory: string,
  newDirectory: string,
): Result<{ written: string[]; skipped: boolean }, AppError> {
  if (!ports.marker.enabled) return ok({ written: [], skipped: true });
  return ports.marker.withLock(() => {
    const refreshed = refreshProjectInboxMarkerUnlocked(ports, recipientProjectId);
    if (!refreshed.ok || oldDirectory === newDirectory) return refreshed;
    const currentBindings = ports.projectPorts.projects.listBindings();
    if (!currentBindings.ok) return currentBindings;
    if (currentBindings.value.some((binding) => binding.directory === oldDirectory)) return refreshed;
    const removed = ports.marker.writes.removeInboxMarker(oldDirectory);
    if (!removed.ok) return removed;
    return refreshed;
  });
}

function refreshProjectInboxMarkerUnlocked(
  ports: InboxMarkerPorts,
  recipientProjectId: string,
): Result<{ written: string[]; skipped: boolean }, AppError> {
  const bindings = ports.projectPorts.projects.listBindingsForProject(recipientProjectId);
  if (!bindings.ok) return bindings;
  if (bindings.value.length === 0) {
    return ok({ written: [], skipped: true });
  }
  const items = currentInboxItems(ports, { kind: "inbox", recipientProjectId });
  if (!items.ok) return items;
  const content = renderInboxMarker(items.value);
  const written: string[] = [];
  for (const binding of bindings.value) {
    const write = ports.marker.writes.writeInboxMarker(binding.directory, content);
    if (!write.ok) return write;
    written.push(binding.directory);
  }
  return ok({ written, skipped: false });
}
