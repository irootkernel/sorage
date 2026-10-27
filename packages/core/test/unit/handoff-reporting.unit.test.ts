import { describe, expect, it } from "vitest";
import { ok } from "../../src/errors";
import type { HandoffView } from "../../src/handoff-read";
import {
  completeProcessing,
  type RecipientComment,
  type ReportMutation,
  setRecipientComment,
  startProcessing,
} from "../../src/reporting-commands";
import { type ReviewPorts, removeReviewNote, setReviewNote, withdrawReviewNote } from "../../src/review-commands";

const NOW = "2026-10-27T10:00:00.000Z";
const request = {
  path: "/workspace",
  userHome: "/fixture",
  as: undefined,
  asUser: true,
  handoffId: "handoff",
  expectedRevision: 1,
  expectedRowVersion: 1,
};
const comment: RecipientComment = {
  handoffId: "handoff",
  purpose: "change_request",
  active: true,
  authorKind: "user",
  authorProjectId: null,
  targetRevision: 1,
  body: "Retain this",
  createdAt: NOW,
  updatedAt: NOW,
};
function fixture(overrides: Partial<HandoffView> = {}, currentComment: RecipientComment | null = null) {
  const handoff: HandoffView = {
    id: "handoff",
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: "Document",
    senderKind: "user",
    senderProjectId: null,
    senderProjectSlug: null,
    senderWorkspaceKey: null,
    senderPathSnapshot: null,
    recipientProjectId: "recipient",
    recipientProjectSlug: "recipient",
    revision: 1,
    rowVersion: 1,
    reviewState: "awaiting_recipient",
    nextActors: { reviewNextActor: "recipient", administrativeNextActor: null },
    read: { revision: 1, status: "unconfirmed", readAt: null },
    processing: { revision: 1, status: "not_started", startedAt: null, completedAt: null },
    comment: null,
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    currentArtifact: null,
    createdAt: NOW,
    updatedAt: NOW,
    pendingDeletionRequest: false,
    hasReviewNote: false,
    consecutiveNoChangeResolutions: 0,
    ...overrides,
  };
  const writes: ReportMutation[] = [];
  let id = 0;
  const ports: ReviewPorts = {
    projectPorts: null as never,
    handoffs: {
      listPage: () => ok({ items: [], lastSortKey: null }),
      findHandoffView: () => ok(handoff),
      loadHandoff: () => ok({ view: handoff, contentIntegrity: "ok" }),
      recordFirstFetch: () => {
        throw new Error("reporting must not invent a read");
      },
    },
    config: { vaultPath: "/unused", verifyChecksumOnFetch: false },
    artifact: null as never,
    reviews: {
      findNote: () => ok(currentComment?.active ? currentComment : null),
      findComment: () => ok(currentComment),
      applyReportMutation: (input) => {
        writes.push(input);
        return ok({ rowVersion: input.expectedRowVersion + 1 });
      },
    },
    ids: { next: () => String(++id) },
    clock: { now: () => new Date(NOW) },
  };
  return { ports, handoff, writes };
}

describe("pure Handoff reporting transitions", () => {
  it("replaces the unique comment as general without changing review, reading or processing", () => {
    const f = fixture({}, { ...comment, active: false });
    const result = setRecipientComment(f.ports, { ...request, text: " General explanation\r\n" });
    expect(result).toMatchObject({
      ok: true,
      value: {
        handoff: {
          reviewState: "awaiting_recipient",
          hasReviewNote: false,
          read: f.handoff.read,
          processing: f.handoff.processing,
          rowVersion: 2,
        },
        comment: { purpose: "general", active: false, body: " General explanation\r\n" },
      },
    });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      engage: true,
      events: [
        {
          eventType: "HANDOFF_COMMENT_SET",
          metadata: { targetRevision: 1, purpose: "general", active: false, authorKind: "user" },
        },
      ],
    });
  });
  it("legacy review set creates an active request and both metadata events at the same Row Version", () => {
    const f = fixture();
    expect(setReviewNote(f.ports, { ...request, targetRevision: 1, text: "Please revise" })).toMatchObject({
      ok: true,
      value: { handoff: { reviewState: "changes_requested" }, note: { body: "Please revise", targetRevision: 1 } },
    });
    expect(f.writes[0]?.events.map((event) => [event.eventType, event.rowVersion])).toEqual([
      ["REVIEW_NOTE_CREATED", 2],
      ["HANDOFF_COMMENT_SET", 2],
    ]);
  });
  it("starts alongside an active request without replacing it and blocks completion/general replacement", () => {
    const f = fixture({ reviewState: "changes_requested", hasReviewNote: true, comment }, comment);
    expect(startProcessing(f.ports, request)).toMatchObject({
      ok: true,
      value: {
        handoff: {
          reviewState: "changes_requested",
          processing: { status: "in_progress", startedAt: NOW },
          read: { status: "unconfirmed" },
        },
        comment,
      },
    });
    expect(f.writes[0]?.comment).toBe("retain");
    const count = f.writes.length;
    expect(completeProcessing(f.ports, { ...request, comment: "Rejected" })).toMatchObject({
      ok: false,
      error: { code: "REVIEW_NOTE_PRESENT" },
    });
    expect(setRecipientComment(f.ports, { ...request, text: "Rejected" })).toMatchObject({
      ok: false,
      error: { code: "REVIEW_NOTE_PRESENT" },
    });
    expect(f.writes).toHaveLength(count);
  });
  it("withdraws activity while retaining the comment and administratively removes a general comment without reopening review", () => {
    const active = fixture({ reviewState: "changes_requested", hasReviewNote: true, comment }, comment);
    const recipientPorts = {
      ...active.ports,
      projectPorts: {
        projects: {
          findProjectBySlug: () => ok({ id: "recipient" }),
          listBindingsForProject: () => ok([{ directory: "/workspace" }]),
        },
      } as never,
    };
    expect(withdrawReviewNote(recipientPorts, { ...request, asUser: false, as: "recipient" })).toMatchObject({
      ok: true,
      value: { handoff: { reviewState: "awaiting_recipient" } },
    });
    expect(active.writes[0]).toMatchObject({ comment: "deactivate", engage: false });
    const general = fixture({}, { ...comment, purpose: "general", active: false });
    expect(removeReviewNote(general.ports, { ...request, confirm: true })).toMatchObject({
      ok: true,
      value: { handoff: { reviewState: "awaiting_recipient" } },
    });
    expect(general.writes[0]?.comment).toBeNull();
  });
  it.each(["accepted", "declined", "withdrawn"] as const)(
    "allows terminal general reporting for %s without reopening review",
    (reviewState) => {
      const f = fixture(
        { reviewState, archivedAt: NOW, comment: { ...comment, active: false } },
        { ...comment, active: false },
      );
      expect(setRecipientComment(f.ports, { ...request, text: "Result explanation" })).toMatchObject({
        ok: true,
        value: {
          handoff: { reviewState, processing: { status: "not_started" }, nextActors: { reviewNextActor: null } },
          comment: { purpose: "general", active: false },
        },
      });
      expect(
        setRecipientComment(f.ports, { ...request, text: "New request", purpose: "change_request" }),
      ).toMatchObject({ ok: false, error: { code: "HANDOFF_TERMINAL" } });
      if (reviewState !== "accepted")
        expect(completeProcessing(f.ports, request)).toMatchObject({ ok: false, error: { code: "HANDOFF_TERMINAL" } });
      else
        expect(completeProcessing(f.ports, request)).toMatchObject({
          ok: true,
          value: { handoff: { reviewState, processing: { status: "completed", startedAt: null } } },
        });
    },
  );
});

describe("T130-R1-002 legacy and report refusal order", () => {
  it.each(["accepted", "deleted", "sender", "no-note"] as const)(
    "retains legacy refusal before stale observations for %s",
    (state) => {
      const terminal = state === "accepted";
      const deleted = state === "deleted";
      const f = fixture({
        revision: 2,
        rowVersion: 5,
        reviewState: terminal ? "accepted" : "awaiting_recipient",
        deletedAt: deleted ? NOW : null,
        senderKind: "registered_project",
        senderProjectId: "sender",
      });
      const sender = {
        ...f.ports,
        projectPorts: {
          projects: {
            findProjectBySlug: () => ok({ id: "sender" }),
            listBindingsForProject: () => ok([{ directory: "/sender" }]),
          },
        } as never,
      };
      const input = {
        ...request,
        expectedRevision: 1,
        expectedRowVersion: 1,
        asUser: state !== "sender",
        as: state === "sender" ? "sender" : undefined,
      };
      const ports = state === "sender" ? sender : f.ports;
      const expected = deleted
        ? "HANDOFF_DELETED"
        : terminal
          ? "HANDOFF_TERMINAL"
          : state === "sender"
            ? "FORBIDDEN_ACTOR"
            : "NO_REVIEW_NOTE";
      if (state !== "no-note")
        expect(setReviewNote(ports, { ...input, targetRevision: 1, text: "Original proposal" })).toMatchObject({
          ok: false,
          error: { code: expected },
        });
      if (state !== "sender")
        expect(removeReviewNote(ports, { ...input, confirm: true })).toMatchObject({
          ok: false,
          error: { code: expected },
        });
      if (state === "sender")
        expect(withdrawReviewNote(ports, input)).toMatchObject({ ok: false, error: { code: expected } });
      expect(f.writes).toEqual([]);
    },
  );
  it("keeps new report operation refusals ahead of stale observations", () => {
    const f = fixture({ rowVersion: 2, reviewState: "changes_requested", hasReviewNote: true }, comment);
    expect(setRecipientComment(f.ports, { ...request, text: "Rejected replacement" })).toMatchObject({
      ok: false,
      error: { code: "REVIEW_NOTE_PRESENT" },
    });
    expect(completeProcessing(f.ports, request)).toMatchObject({ ok: false, error: { code: "REVIEW_NOTE_PRESENT" } });
    expect(f.writes).toEqual([]);
  });
});
