import { describe, expect, it } from "vitest";
import { validateSnapshot } from "../../src/backup-commands";
import { canonicalJson } from "../../src/backup-snapshot";
import { sha256OfText } from "../../src/content";
import { snapshotFilesV3, validateSnapshotHandoffV3 } from "../../src/content-snapshot";
import { snapshotEventTypeAllowed } from "../../src/events";
import {
  reportingSnapshotBase,
  type SnapshotDataV4,
  type SnapshotHandoffV4,
  snapshotFilesV4,
  upgradeSnapshotHandoff,
  validateSnapshotHandoffV4,
} from "../../src/handoff-reporting-snapshot";
import { parseVersionedSnapshotManifest } from "../../src/memo-snapshot";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const HANDOFF = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const TIME = "2026-10-27T00:00:00.000Z";
function fixture(): SnapshotHandoffV4 {
  return {
    id: HANDOFF,
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: "Request",
    senderKind: "user",
    senderProjectId: null,
    senderWorkspaceKey: null,
    recipientProjectId: PROJECT,
    currentArtifactId: ARTIFACT,
    revision: 2,
    rowVersion: 4,
    reviewState: "accepted",
    acceptedRevision: 2,
    acceptedAt: TIME,
    declinedAt: null,
    declineReason: null,
    withdrawnAt: null,
    consecutiveNoChangeResolutions: 0,
    firstFetchedAt: TIME,
    reviewEngagedAt: TIME,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: TIME,
    updatedAt: TIME,
    artifact: {
      id: ARTIFACT,
      handoffId: HANDOFF,
      storageKey: null,
      inlineBody: "body",
      originalName: "request.md",
      storedName: "request.md",
      mimeType: "text/markdown",
      sizeBytes: 4,
      sha256: sha256OfText("body"),
      importedFromPath: null,
      materialized: true,
      createdAt: TIME,
    },
    comment: {
      handoffId: HANDOFF,
      authorKind: "registered_project",
      authorProjectId: PROJECT,
      targetRevision: 1,
      body: "\uFEFFOlder feedback\r\n",
      createdAt: TIME,
      updatedAt: TIME,
      purpose: "change_request",
      active: false,
    },
    read: { revision: 2, status: "read", readAt: TIME },
    processing: { revision: 2, status: "completed", startedAt: null, completedAt: TIME },
    deletionRequests: [],
  };
}
function data(handoff = fixture()): SnapshotDataV4 {
  return {
    projects: [
      {
        id: PROJECT,
        slug: "recipient",
        displayName: "Recipient",
        description: null,
        status: "active",
        createdAt: TIME,
        updatedAt: TIME,
        bindings: [],
      },
    ],
    handoffs: [handoff],
    events: [],
  };
}

describe("format-4 Handoff reporting", () => {
  it("serializes one retained body deterministically, preserving the format-3 codec", () => {
    const source = data();
    const built = snapshotFilesV4(source);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.manifest.formatVersion).toBe(4);
    expect(snapshotFilesV4(source)).toEqual(built);
    expect(parseVersionedSnapshotManifest(canonicalJson(built.value.manifest)).ok).toBe(true);
    expect(validateSnapshot(source, built.value.manifest).ok).toBe(true);
    const shard = built.value.files.find((file) => file.path.startsWith("handoffs/"));
    const record = JSON.parse(String(shard?.content));
    expect(record.comment.body).toBe(source.handoffs[0]?.comment?.body);
    expect(record).not.toHaveProperty("reviewNote");
    expect(validateSnapshotHandoffV3(record).ok).toBe(false);
    const legacy = snapshotFilesV3({ ...source, handoffs: source.handoffs.map(reportingSnapshotBase) });
    expect(legacy.ok && legacy.value.manifest.formatVersion).toBe(3);
  });
  it("converts legacy acceptance/first-fetch honestly and derives only request activity", () => {
    const old = reportingSnapshotBase(fixture());
    const converted = upgradeSnapshotHandoff(old);
    expect(converted.read).toEqual({ revision: 2, status: "unrecorded", readAt: null });
    expect(converted.processing.status).toBe("unrecorded");
    expect(converted.firstFetchedAt).toBe(TIME);
    expect(converted.comment).toMatchObject({ purpose: "change_request", active: false, targetRevision: 1 });
    expect(upgradeSnapshotHandoff({ ...old, reviewState: "changes_requested" }).comment?.active).toBe(true);
  });
  it.each([
    [
      "duplicate legacy comment",
      (h: Record<string, unknown>) => {
        h.reviewNote = null;
      },
    ],
    [
      "missing report",
      (h: Record<string, unknown>) => {
        delete h.read;
      },
    ],
    [
      "unknown report field",
      (h: Record<string, unknown>) => {
        (h.read as Record<string, unknown>).body = "leak";
      },
    ],
    [
      "wrong read Revision",
      (h: Record<string, unknown>) => {
        (h.read as Record<string, unknown>).revision = 1;
      },
    ],
    [
      "read timestamp missing",
      (h: Record<string, unknown>) => {
        (h.read as Record<string, unknown>).readAt = null;
      },
    ],
    [
      "unknown status",
      (h: Record<string, unknown>) => {
        (h.processing as Record<string, unknown>).status = "pending";
      },
    ],
    [
      "completion timestamp missing",
      (h: Record<string, unknown>) => {
        (h.processing as Record<string, unknown>).completedAt = null;
      },
    ],
    [
      "inactive request relabeled active",
      (h: Record<string, unknown>) => {
        (h.comment as Record<string, unknown>).active = true;
      },
    ],
    [
      "future comment target",
      (h: Record<string, unknown>) => {
        (h.comment as Record<string, unknown>).targetRevision = 3;
      },
    ],
    [
      "wrong recipient author",
      (h: Record<string, unknown>) => {
        (h.comment as Record<string, unknown>).authorProjectId = ARTIFACT;
      },
    ],
    [
      "tombstone with live content",
      (h: Record<string, unknown>) => {
        h.deletedAt = TIME;
      },
    ],
  ] as const)("rejects %s before serialization or restore", (_name, mutate) => {
    const handoff = fixture() as unknown as Record<string, unknown>;
    mutate(handoff);
    expect(validateSnapshotHandoffV4(handoff)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
    expect(snapshotFilesV4(data(handoff as unknown as SnapshotHandoffV4)).ok).toBe(false);
  });
  it("requires an active request for changes_requested and supports stopped retained feedback", () => {
    const h = fixture();
    h.reviewState = "changes_requested";
    expect(validateSnapshotHandoffV4(h).ok).toBe(false);
    if (h.comment) h.comment.active = true;
    expect(validateSnapshotHandoffV4(h).ok).toBe(true);
    h.reviewState = "declined";
    if (h.comment) h.comment.active = false;
    expect(validateSnapshotHandoffV4(h).ok).toBe(true);
  });
  it("admits reporting events only in format4 and refuses forged associations or body metadata", () => {
    const source = data();
    source.events = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        handoffId: HANDOFF,
        memoId: null,
        eventType: "HANDOFF_PROCESSING_COMPLETED",
        actorKind: "user",
        actorId: null,
        rowVersion: 4,
        metadata: { revision: 2 },
        createdAt: TIME,
      },
    ];
    const event = source.events[0];
    if (event === undefined) throw new Error("Missing reporting event fixture");
    expect(snapshotEventTypeAllowed(3, event.eventType)).toBe(false);
    expect(snapshotEventTypeAllowed(4, event.eventType)).toBe(true);
    expect(snapshotFilesV4(source).ok).toBe(true);
    event.metadata = { revision: 2, body: "must not be in events" };
    expect(snapshotFilesV4(source).ok).toBe(false);
    event.metadata = { revision: 2 };
    event.actorId = ARTIFACT;
    expect(snapshotFilesV4(source).ok).toBe(false);
  });
  it.each([
    ["matching current Artifact", 2, ARTIFACT, false, true],
    ["wrong current Artifact", 2, PROJECT, false, false],
    ["older Revision with removed Artifact", 1, PROJECT, false, true],
    ["tombstone with removed Artifact", 2, PROJECT, true, true],
  ] as const)("validates read-event association: %s", (_name, revision, artifactId, deleted, valid) => {
    const source = data();
    const handoff = source.handoffs[0];
    if (handoff === undefined) throw new Error("Missing Handoff fixture");
    if (deleted) {
      handoff.deletedAt = TIME;
      handoff.currentArtifactId = null;
      handoff.artifact = null;
      handoff.comment = null;
      handoff.read = { revision: 2, status: "unrecorded", readAt: null };
      handoff.processing = { revision: 2, status: "unrecorded", startedAt: null, completedAt: null };
    }
    source.events = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        handoffId: HANDOFF,
        memoId: null,
        eventType: "HANDOFF_REVISION_READ",
        actorKind: "user",
        actorId: null,
        rowVersion: 4,
        metadata: { revision, artifactId: ARTIFACT },
        createdAt: TIME,
      },
    ];
    const baseline = snapshotFilesV4(source);
    if (!baseline.ok) throw new Error(baseline.error.message);
    const event = source.events[0];
    if (event === undefined) throw new Error("Missing read event fixture");
    event.metadata = { revision, artifactId };
    expect(snapshotFilesV4(source).ok).toBe(valid);
    expect(validateSnapshot(source, baseline.value.manifest).ok).toBe(valid);
  });
});
