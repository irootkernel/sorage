import { afterEach, describe, expect, it, vi } from "vitest";
import { type BackupRestorePorts, backupRestore, validateSnapshot } from "../../src/backup/backup-restore";
import type { SnapshotEvent } from "../../src/backup/snapshot/backup-snapshot";
import * as contentSnapshot from "../../src/backup/snapshot/content-snapshot";
import { ok } from "../../src/shared/errors";
import * as exchangeLifecycle from "../../src/exchange/exchange-lifecycle";
import { validateExchangeNoticeInventory } from "../../src/backup/snapshot/exchange-notice-snapshot";
import * as exchangeNotices from "../../src/exchange/exchange-notices";
import {
  EXCHANGE_SNAPSHOT_FILE,
  type ExchangeSnapshotRecord,
  type SnapshotDataV5,
  snapshotFilesV5,
} from "../../src/backup/snapshot/exchange-snapshot";
import type { ExchangeCollaboration } from "../../src/exchange/exchanges";
import * as handoffReportingSnapshot from "../../src/backup/snapshot/handoff-reporting-snapshot";
import {
  type SnapshotHandoffV4,
  validateReportingSnapshotEvent,
} from "../../src/backup/snapshot/handoff-reporting-snapshot";
import { sha256OfText } from "../../src/primitives/validation";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const HANDOFF = "33333333-3333-4333-8333-333333333333";
const EXCHANGE = "77777777-7777-4777-8777-777777777771";
const REQ_1 = "78888888-8888-4888-8888-888888888881";
const REQ_2 = "78888888-8888-4888-8888-888888888882";
const EVT_1 = "88888888-8888-4888-8888-888888888881";
const TIME_0 = "2026-11-20T00:00:00.000Z";
const TIME_1 = "2026-11-20T00:01:00.000Z";
const TIME_NOTICE = "2026-11-20T00:10:00.000Z";

function makeHandoff(overrides: Partial<SnapshotHandoffV4> = {}): SnapshotHandoffV4 {
  return {
    id: HANDOFF,
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: "Task 165 handoff",
    senderKind: "registered_project",
    senderProjectId: ALPHA,
    senderWorkspaceKey: null,
    recipientProjectId: BETA,
    currentArtifactId: null,
    revision: 1,
    rowVersion: 2,
    reviewState: "awaiting_recipient",
    acceptedRevision: null,
    acceptedAt: null,
    declinedAt: null,
    declineReason: null,
    withdrawnAt: null,
    consecutiveNoChangeResolutions: 0,
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: TIME_0,
    updatedAt: TIME_0,
    artifact: null,
    comment: null,
    read: { revision: 1, status: "unconfirmed", readAt: null },
    processing: { revision: 1, status: "not_started", startedAt: null, completedAt: null },
    deletionRequests: [],
    ...overrides,
  };
}

function makeV5Data(): SnapshotDataV5 {
  const exchange: ExchangeSnapshotRecord = {
    id: EXCHANGE,
    openingProjectId: ALPHA,
    goal: "Single-pass V5 driver check",
    criteria: ["Deterministic bytes"],
    createdAt: TIME_0,
    members: [ALPHA, BETA],
    readRanges: [],
    creationOutcomes: [],
  };
  return {
    projects: [
      {
        id: ALPHA,
        slug: "alpha",
        displayName: "Alpha",
        description: null,
        status: "active",
        createdAt: TIME_0,
        updatedAt: TIME_0,
        bindings: [],
      },
      {
        id: BETA,
        slug: "beta",
        displayName: "Beta",
        description: null,
        status: "active",
        createdAt: TIME_0,
        updatedAt: TIME_0,
        bindings: [],
      },
    ],
    handoffs: [makeHandoff()],
    memos: [],
    memoContentFiles: [],
    channels: [],
    channelContentFiles: [],
    events: [
      {
        id: EVT_1,
        handoffId: HANDOFF,
        memoId: null,
        eventType: "HANDOFF_PROCESSING_STARTED",
        actorKind: "registered_project",
        actorId: BETA,
        rowVersion: 2,
        metadata: { revision: 1 },
        createdAt: TIME_1,
      },
    ],
    exchanges: [exchange],
    exchangeRepresentation: "foundation",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TASK-165 single-pass V5 codec driver and indexed validators", () => {
  it("builds V5 snapshots directly without delegating to snapshotFilesV4 or snapshotFilesV3", () => {
    const v4Spy = vi.spyOn(handoffReportingSnapshot, "snapshotFilesV4");
    const v3Spy = vi.spyOn(contentSnapshot, "snapshotFilesV3");

    const built = snapshotFilesV5(makeV5Data());
    expect(built.ok).toBe(true);
    expect(v4Spy).toHaveBeenCalledTimes(0);
    expect(v3Spy).toHaveBeenCalledTimes(0);
    if (built.ok) {
      expect(built.value.manifest.formatVersion).toBe(5);
      expect(built.value.files.map((file) => file.path)).toEqual([
        "projects.json",
        `handoffs/${HANDOFF.slice(0, 2)}/${HANDOFF}.json`,
        "events.jsonl",
        "manifest.json",
        EXCHANGE_SNAPSHOT_FILE,
      ]);
      expect(built.value.files.filter((file) => file.path === "manifest.json")).toHaveLength(1);
    }
  });

  it("preserves first-wins semantics in validateReportingSnapshotEvent across array and ReadonlyMap callers", () => {
    const first = makeHandoff({ id: HANDOFF, recipientProjectId: BETA, rowVersion: 2 });
    const duplicateSecond = makeHandoff({ id: HANDOFF, recipientProjectId: ALPHA, rowVersion: 1 });
    const event: SnapshotEvent = {
      id: EVT_1,
      handoffId: HANDOFF,
      memoId: null,
      eventType: "HANDOFF_PROCESSING_STARTED",
      actorKind: "registered_project",
      actorId: BETA,
      rowVersion: 2,
      metadata: { revision: 1 },
      createdAt: TIME_1,
    };

    const byId = new Map<string, SnapshotHandoffV4>();
    for (const h of [first, duplicateSecond]) {
      if (!byId.has(h.id)) byId.set(h.id, h);
    }
    expect(validateReportingSnapshotEvent(event, [first, duplicateSecond]).ok).toBe(true);
    expect(validateReportingSnapshotEvent(event, byId).ok).toBe(true);

    const missingEvent: SnapshotEvent = { ...event, handoffId: "99999999-9999-4999-8999-999999999999" };
    expect(validateReportingSnapshotEvent(missingEvent, byId)).toEqual(
      validateReportingSnapshotEvent(missingEvent, [first, duplicateSecond]),
    );
  });

  it("evaluates exchangeResponseObligations at most once per distinct observedThroughSeq across repeated notice-acks", () => {
    const lifecycle: exchangeLifecycle.ExchangeLifecycle = {
      initialMembers: [ALPHA, BETA],
      workRevision: 3,
      transitions: [],
    };
    const obligation1 = {
      response: "report" as const,
      requestId: REQ_1,
      version: 1,
      sourceSeq: 1,
      responsibilitySeq: 0,
      resumeSeq: 0,
    };
    const obligation2 = {
      response: "report" as const,
      requestId: REQ_2,
      version: 1,
      sourceSeq: 2,
      responsibilitySeq: 0,
      resumeSeq: 0,
    };
    const collaboration: ExchangeCollaboration = {
      lastSeq: 2,
      messages: [
        {
          seq: 1,
          senderId: ALPHA,
          recipientId: BETA,
          kind: "request",
          replyTo: null,
          materialId: null,
          requestId: REQ_1,
          reportVersion: null,
          createdAt: TIME_0,
        },
        {
          seq: 2,
          senderId: ALPHA,
          recipientId: BETA,
          kind: "request",
          replyTo: null,
          materialId: null,
          requestId: REQ_2,
          reportVersion: null,
          createdAt: TIME_1,
        },
      ],
      requests: [
        {
          id: REQ_1,
          requesterId: ALPHA,
          assigneeId: BETA,
          assignmentVersion: 1,
          condition: "First request",
          criteria: ["Done"],
        },
        {
          id: REQ_2,
          requesterId: ALPHA,
          assigneeId: BETA,
          assignmentVersion: 1,
          condition: "Second request",
          criteria: ["Done"],
        },
      ],
      reports: [],
      acceptances: [],
      materials: [],
      operations: [
        // Three notice-ack operations sharing only TWO distinct observedThroughSeq values (1 and 2).
        {
          projectId: ALPHA,
          operationId: "notice-op-1",
          fingerprint: exchangeNotices.exchangeNoticeAckFingerprint(sha256OfText("inc-1")),
          outcome: {
            kind: "notice-ack",
            exchangeId: EXCHANGE,
            incidentId: sha256OfText("inc-1"),
            noticeKind: "connection-check",
            affectedProjectId: BETA,
            projectId: ALPHA,
            obligation: obligation1,
            observedThroughSeq: 1,
            issuedAt: TIME_NOTICE,
          },
        },
        {
          projectId: ALPHA,
          operationId: "notice-op-2",
          fingerprint: exchangeNotices.exchangeNoticeAckFingerprint(sha256OfText("inc-2")),
          outcome: {
            kind: "notice-ack",
            exchangeId: EXCHANGE,
            incidentId: sha256OfText("inc-2"),
            noticeKind: "connection-check",
            affectedProjectId: BETA,
            projectId: ALPHA,
            obligation: obligation1,
            observedThroughSeq: 2,
            issuedAt: TIME_NOTICE,
          },
        },
        {
          projectId: ALPHA,
          operationId: "notice-op-3",
          fingerprint: exchangeNotices.exchangeNoticeAckFingerprint(sha256OfText("inc-3")),
          outcome: {
            kind: "notice-ack",
            exchangeId: EXCHANGE,
            incidentId: sha256OfText("inc-3"),
            noticeKind: "connection-check",
            affectedProjectId: BETA,
            projectId: ALPHA,
            obligation: obligation2,
            observedThroughSeq: 2,
            issuedAt: TIME_NOTICE,
          },
        },
      ],
    };

    const obligationsSpy = vi.spyOn(exchangeNotices, "exchangeResponseObligations");
    const headSpy = vi.spyOn(exchangeLifecycle, "exchangeLifecycleHead");

    const valid = validateExchangeNoticeInventory(
      { compatibilityAt: null, openConnectionIssues: [sha256OfText("inc-2"), sha256OfText("inc-3")] },
      lifecycle,
      collaboration,
      new Set([1, 2]),
    );
    expect(valid).toBe(true);
    // 2 distinct observedThroughSeq heads (1 and 2) + 1 final current obligations evaluation = 3 total.
    expect(obligationsSpy).toHaveBeenCalledTimes(3);
    // 2 explicit head checks for distinct heads + 3 internal head calls inside exchangeResponseObligations = 5 total.
    expect(headSpy).toHaveBeenCalledTimes(5);
  });

  it("uses readValidatedSourceSnapshot once in backupRestore while preserving the legacy fallback path", () => {
    const data = makeV5Data();
    const built = snapshotFilesV5(data);
    if (!built.ok) throw new Error(built.error.message);
    const validated = validateSnapshot(data, built.value.manifest);
    if (!validated.ok) throw new Error(validated.error.message);

    const readSourceSnapshot = vi.fn(() => ok(data));
    const readSourceManifest = vi.fn(() => ok(built.value.manifest));
    const readValidatedSourceSnapshot = vi.fn(() =>
      ok({ data, manifest: built.value.manifest, reviewNotes: validated.value.reviewNotes }),
    );
    const basePorts: BackupRestorePorts = {
      sourcePath: "/tmp/source-vault",
      installationId: "10000000-0000-4000-8000-000000000001",
      daemonRunning: () => ok(false),
      lock: { acquire: () => ok({ release: () => undefined }) },
      readSourceMarker: () =>
        ok({
          type: "sorage-vault" as const,
          schemaVersion: 1,
          installationId: "10000000-0000-4000-8000-000000000001",
          createdAt: TIME_0,
        }),
      readSourceSnapshot,
      readSourceManifest,
      targetIsEmpty: () => ok(true),
      verifyArtifacts: () => ok({ verified: 0 }),
      copyArtifacts: () => ok({ copied: 0 }),
      adoptMarker: () => ok(undefined),
      adoptInstallationId: () => ok(undefined),
      rebuildDatabase: () => ok(undefined),
      regenerateApiToken: () => ok(undefined),
    };

    const fastDryRun = backupRestore({ ...basePorts, readValidatedSourceSnapshot }, { dryRun: true });
    expect(fastDryRun.ok).toBe(true);
    expect(readValidatedSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(readSourceSnapshot).toHaveBeenCalledTimes(0);
    expect(readSourceManifest).toHaveBeenCalledTimes(0);

    const legacyDryRun = backupRestore(basePorts, { dryRun: true });
    expect(legacyDryRun.ok).toBe(true);
    expect(readSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(readSourceManifest).toHaveBeenCalledTimes(1);
  });
});
