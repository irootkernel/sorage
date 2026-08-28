import { describe, expect, it } from "vitest";
import { renderInboxMarker } from "../../src/inbox-marker";
import type { HandoffView } from "../../src/handoff-read";

/** The derived marker of HND-026 renders the recipient's actionable inbox as a stable, advisory Markdown view. */

function view(id: string, reviewState: HandoffView["reviewState"], title: string): HandoffView {
  return {
    id,
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title,
    senderKind: "registered_project",
    senderProjectId: "00000000-0000-4000-8000-0000000000a1",
    senderProjectSlug: "alpha",
    senderWorkspaceKey: null,
    senderPathSnapshot: null,
    recipientProjectId: "00000000-0000-4000-8000-0000000000b1",
    recipientProjectSlug: "beta",
    revision: 1,
    rowVersion: 1,
    reviewState,
    nextActors: { reviewNextActor: "recipient", administrativeNextActor: null },
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    currentArtifact: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    pendingDeletionRequest: false,
    hasReviewNote: false,
    consecutiveNoChangeResolutions: 0,
  };
}

describe("renderInboxMarker", () => {
  it("lists each open Handoff with its id, state, title, and revision", () => {
    const marker = renderInboxMarker([
      view("h1", "awaiting_recipient", "Brief"),
      view("h2", "changes_requested", "Notes"),
    ]);
    expect(marker).toContain("# Inbox");
    expect(marker).toContain('- h1 awaiting_recipient "Brief" revision 1');
    expect(marker).toContain('- h2 changes_requested "Notes" revision 1');
    expect(marker).toContain("never read it as authority");
  });

  it("states the empty inbox plainly", () => {
    expect(renderInboxMarker([])).toContain("- (no open Handoffs)");
  });
});
