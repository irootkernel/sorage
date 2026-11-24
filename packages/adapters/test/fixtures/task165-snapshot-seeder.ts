import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeMemo,
  createMemo,
  type ExchangeLifecycle,
  type ExchangeNoticeOutcome,
  type ExchangeSnapshotRecord,
  exchangeControlOutcome,
  exchangeNoticeAckFingerprint,
  exchangeNoticeBasisKey,
  exchangeNoticeIncident,
  exchangeResponseObligations,
  exportSnapshot,
  initializeInstallation,
  type Memo,
  type Result,
  redactSnapshotData,
  redactSnapshotDataV3,
  redactSnapshotDataV4,
  reportingSnapshotBase,
  type SnapshotData,
  type SnapshotDataV3,
  type SnapshotDataV4,
  type SnapshotDataV5,
  type SnapshotFile,
  sha256OfText,
  snapshotFiles,
  snapshotFilesV2,
  snapshotFilesV3,
  snapshotFilesV4,
  snapshotFilesV5,
  utf8ByteLength,
  validateExchangeInventory,
  validateSnapshot,
} from "@sorage/core";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { readExchangeCollaboration } from "../../src/exchange-collaboration-records";
import { readExchangeRecords, restoreExchangeRecords } from "../../src/exchange-records";
import { createNodeInitPorts } from "../../src/init-ports";
import {
  insertMemoWithFileRecordRows,
  insertMemoWithInlineRecord,
  placeMemoContentFile,
} from "../../src/memo-backup-records";
import { openSorageDatabase, type SorageSqlite } from "../../src/sqlite/connection";
import { FakeClock } from "../../src/testkit/fakes";

export const TASK165_BASE_SHA = "e52f6b37737f8594d7134ef3c57fa82a0702b50b";
export const TASK165_FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "task165-snapshots");

export const TASK165_V5_TREES = ["v5-foundation", "v5-collaboration", "v5-notices"] as const;
export const TASK165_FORMAT_TREES = ["formats/v1", "formats/v2", "formats/v3", "formats/v4", "formats/v5"] as const;

export const TASK165_IDS = {
  installation: "10000000-0000-4000-8000-000000000001",
  projects: {
    alpha: "11000000-0000-4000-8000-000000000001",
    beta: "11000000-0000-4000-8000-000000000002",
    gamma: "11000000-0000-4000-8000-000000000003",
  },
  bindings: {
    alpha: "12000000-0000-4000-8000-000000000001",
    beta: "12000000-0000-4000-8000-000000000002",
  },
  handoffs: {
    file: "21000000-0000-4000-8000-000000000001",
    inline: "21000000-0000-4000-8000-000000000002",
    tombstone: "21000000-0000-4000-8000-000000000003",
  },
  artifacts: {
    file: "22000000-0000-4000-8000-000000000001",
    fileRecord: "23000000-0000-4000-8000-000000000001",
    inline: "22000000-0000-4000-8000-000000000002",
    inlineRecord: "23000000-0000-4000-8000-000000000002",
  },
  deletionRequest: "24000000-0000-4000-8000-000000000001",
  memos: {
    inline: "31000000-0000-4000-8000-000000000001",
    inlineRecord: "32000000-0000-4000-8000-000000000001",
    file: "31000000-0000-4000-8000-000000000002",
    fileRecord: "32000000-0000-4000-8000-000000000002",
  },
  channels: {
    open: "41000000-0000-4000-8000-000000000001",
    closed: "41000000-0000-4000-8000-000000000002",
    openMsg1Record: "42000000-0000-4000-8000-000000000001",
    openMsg2Record: "42000000-0000-4000-8000-000000000002",
    closedMsg1Record: "42000000-0000-4000-8000-000000000003",
  },
  exchanges: {
    active: "51000000-0000-4000-8000-000000000001",
    activeReq: "52000000-0000-4000-8000-000000000001",
    activeExtMat: "53000000-0000-4000-8000-000000000001",
    activeReportMat: "53000000-0000-4000-8000-000000000002",
    paused: "51000000-0000-4000-8000-000000000002",
    pausedSendMat: "53000000-0000-4000-8000-000000000003",
    completed: "51000000-0000-4000-8000-000000000003",
    completedReq: "52000000-0000-4000-8000-000000000003",
    completedReportMat: "53000000-0000-4000-8000-000000000004",
    collabOnly: "51000000-0000-4000-8000-000000000004",
    collabSendMat: "53000000-0000-4000-8000-000000000005",
    collabReq: "52000000-0000-4000-8000-000000000004",
    collabReportMat: "53000000-0000-4000-8000-000000000006",
  },
  events: {
    handoffFileCreated: "61000000-0000-4000-8000-000000000001",
    handoffFileRead: "61000000-0000-4000-8000-000000000002",
    handoffFileComment: "61000000-0000-4000-8000-000000000003",
    handoffFileStarted: "61000000-0000-4000-8000-000000000004",
    handoffFileCompleted: "61000000-0000-4000-8000-000000000005",
    handoffInlineCreated: "61000000-0000-4000-8000-000000000006",
    handoffInlineNote: "61000000-0000-4000-8000-000000000007",
    handoffTombstoneCreated: "61000000-0000-4000-8000-000000000008",
    memoInlineCreated: "62000000-0000-4000-8000-000000000001",
    memoInlineUpdated: "62000000-0000-4000-8000-000000000002",
    memoInlineDone: "62000000-0000-4000-8000-000000000003",
    memoFileCreated: "62000000-0000-4000-8000-000000000004",
    chOpenCreated: "63000000-0000-4000-8000-000000000001",
    chOpenAddWorker: "63000000-0000-4000-8000-000000000002",
    chOpenAddJudge: "63000000-0000-4000-8000-000000000003",
    chOpenMsg1Posted: "63000000-0000-4000-8000-000000000004",
    chOpenMsg1Acked: "63000000-0000-4000-8000-000000000005",
    chOpenMsg2Posted: "63000000-0000-4000-8000-000000000006",
    chOpenRemoveJudge: "63000000-0000-4000-8000-000000000007",
    chClosedCreated: "63000000-0000-4000-8000-000000000008",
    chClosedAddWorker: "63000000-0000-4000-8000-000000000009",
    chClosedMsg1Posted: "63000000-0000-4000-8000-000000000010",
    chClosedMsg1Acked: "63000000-0000-4000-8000-000000000011",
    chClosedClosed: "63000000-0000-4000-8000-000000000012",
  },
} as const;

export const TASK165_TIMES = {
  base: "2026-11-20T00:00:00.000Z",
  t01: "2026-11-20T00:01:00.000Z",
  t02: "2026-11-20T00:02:00.000Z",
  t03: "2026-11-20T00:03:00.000Z",
  t04: "2026-11-20T00:04:00.000Z",
  t05: "2026-11-20T00:05:00.000Z",
  t06: "2026-11-20T00:06:00.000Z",
  t07: "2026-11-20T00:07:00.000Z",
  t08: "2026-11-20T00:08:00.000Z",
  t09: "2026-11-20T00:09:00.000Z",
  t10: "2026-11-20T00:10:00.000Z",
  t11: "2026-11-20T00:11:00.000Z",
  t12: "2026-11-20T00:12:00.000Z",
  t13: "2026-11-20T00:13:00.000Z",
  t14: "2026-11-20T00:14:00.000Z",
  t15: "2026-11-20T00:15:00.000Z",
  noticeIssued: "2026-11-20T00:25:00.000Z",
} as const;

export const TASK165_BODIES = {
  fileArtifact: "\uFEFF# File Brief\r\nExact CRLF bytes without trailing LF",
  inlineArtifact: "\uFEFF# Inline Brief\r\nExact inline bytes",
  inlineMemoInitial: "Initial memo body",
  inlineMemoFinal: "\uFEFFUpdated inline memo\r\nline 2",
  fileMemo: `\uFEFF# Large Memo\r\n${"M".repeat(70_000)}\r\nno-eol`,
  openChannelInline: "Inline channel report\r\nline 2",
  openChannelFile: `\uFEFF# Large Channel Relay\r\n${"C".repeat(70_000)}\r\nno-eol`,
  closedChannelInline: "Closed channel question",
} as const;

export const FILE_ARTIFACT_STORAGE_KEY = `artifacts/${TASK165_IDS.handoffs.file}/${TASK165_IDS.artifacts.file}/brief.md`;

function unwrap<T>(result: Result<T>, label = "operation"): T {
  if (!result.ok) throw new Error(`${label} failed: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildPrimaryExchangeRecords(): ExchangeSnapshotRecord[] {
  const alpha = TASK165_IDS.projects.alpha;
  const beta = TASK165_IDS.projects.beta;
  const activeId = TASK165_IDS.exchanges.active;
  const activeReqId = TASK165_IDS.exchanges.activeReq;
  const activeExtMatId = TASK165_IDS.exchanges.activeExtMat;
  const activeReportMatId = TASK165_IDS.exchanges.activeReportMat;
  const activeReportBody = "Active report body";

  const activeLifecycle: ExchangeLifecycle = {
    initialMembers: [alpha, beta],
    workRevision: 4,
    transitions: [],
  };
  const activeCollabBase = {
    lastSeq: 2,
    messages: [
      {
        seq: 1,
        senderId: alpha,
        recipientId: beta,
        kind: "request" as const,
        replyTo: null,
        materialId: null,
        requestId: activeReqId,
        reportVersion: null,
        createdAt: TASK165_TIMES.t10,
      },
      {
        seq: 2,
        senderId: beta,
        recipientId: alpha,
        kind: "report" as const,
        replyTo: 1,
        materialId: activeReportMatId,
        requestId: activeReqId,
        reportVersion: 1,
        createdAt: TASK165_TIMES.t11,
      },
    ],
    requests: [
      {
        id: activeReqId,
        requesterId: alpha,
        assigneeId: beta,
        assignmentVersion: 1,
        condition: "Deliver deterministic report",
        criteria: ["Exact bytes preserved"],
      },
    ],
    reports: [
      {
        requestId: activeReqId,
        version: 1,
        assignmentVersion: 1,
        authorId: beta,
        materialId: activeReportMatId,
        evidence: [activeExtMatId],
      },
    ],
    acceptances: [],
    materials: [
      {
        id: activeExtMatId,
        ownerProjectId: alpha,
        kind: "external" as const,
        sizeBytes: null,
        sha256: null,
        scope: { access: "url" as const, value: "https://example.invalid/spec/v1" },
      },
      {
        id: activeReportMatId,
        ownerProjectId: beta,
        kind: "body" as const,
        sizeBytes: utf8ByteLength(activeReportBody),
        sha256: sha256OfText(activeReportBody),
        scope: null,
      },
    ],
  };

  const obligations = exchangeResponseObligations(activeLifecycle, activeCollabBase, null);
  const obligation = obligations[0];
  if (!obligation) throw new Error("Expected active exchange obligation for notice fixture");
  const incident = exchangeNoticeIncident(obligation, new Date(TASK165_TIMES.noticeIssued), false, false, undefined, 0);
  if (!incident) throw new Error("Expected eligible connection-check incident");
  const noticeOutcome: ExchangeNoticeOutcome = {
    kind: "notice-ack",
    exchangeId: activeId,
    incidentId: incident.incidentId,
    noticeKind: "connection-check",
    affectedProjectId: obligation.affectedProjectId,
    projectId: beta,
    obligation: obligation.obligation,
    observedThroughSeq: 2,
    issuedAt: TASK165_TIMES.noticeIssued,
  };
  // Sanity: notice basis key must resolve consistently.
  void exchangeNoticeBasisKey(noticeOutcome);

  const activeExchange: ExchangeSnapshotRecord = {
    id: activeId,
    openingProjectId: alpha,
    goal: "Active exchange with notice tracking",
    criteria: ["Track active report and connection notice"],
    createdAt: TASK165_TIMES.t09,
    members: [alpha, beta],
    readRanges: [{ projectId: beta, firstSeq: 1, lastSeq: 1 }],
    creationOutcomes: [
      { projectId: alpha, operationId: "op-active-create", fingerprint: sha256OfText("active-create") },
    ],
    collaboration: {
      ...activeCollabBase,
      operations: [
        {
          projectId: alpha,
          operationId: "op-active-req",
          fingerprint: sha256OfText("active-req"),
          outcome: {
            kind: "request",
            exchangeId: activeId,
            seq: 1,
            requestId: activeReqId,
            assignmentVersion: 1,
          },
        },
        {
          projectId: alpha,
          operationId: "op-active-mat",
          fingerprint: sha256OfText("active-mat"),
          registrationAfterSeq: 1,
          outcome: { kind: "material-register", exchangeId: activeId, materialId: activeExtMatId },
        },
        {
          projectId: beta,
          operationId: "op-active-report",
          fingerprint: sha256OfText("active-report"),
          outcome: {
            kind: "report",
            exchangeId: activeId,
            seq: 2,
            requestId: activeReqId,
            reportVersion: 1,
            materialId: activeReportMatId,
          },
        },
        {
          projectId: beta,
          operationId: "op-active-notice",
          fingerprint: exchangeNoticeAckFingerprint(incident.incidentId),
          outcome: noticeOutcome,
        },
      ],
    },
    lifecycle: activeLifecycle,
    notices: {
      compatibilityAt: null,
      openConnectionIssues: [incident.incidentId],
    },
  };

  const pausedId = TASK165_IDS.exchanges.paused;
  const pausedMatId = TASK165_IDS.exchanges.pausedSendMat;
  const pausedBody = "Paused update";
  const pauseTransition = {
    kind: "pause" as const,
    pause: { version: 1, reason: "Awaiting user decision", question: "Approve scope freeze?" },
  };
  const pausedExchange: ExchangeSnapshotRecord = {
    id: pausedId,
    openingProjectId: alpha,
    goal: "Paused exchange waiting for decision",
    criteria: ["Pause cleanly with decision prompt"],
    createdAt: TASK165_TIMES.t11,
    members: [alpha, beta],
    readRanges: [{ projectId: alpha, firstSeq: 1, lastSeq: 1 }],
    creationOutcomes: [
      { projectId: alpha, operationId: "op-paused-create", fingerprint: sha256OfText("paused-create") },
    ],
    collaboration: {
      lastSeq: 2,
      messages: [
        {
          seq: 1,
          senderId: alpha,
          recipientId: beta,
          kind: "information",
          replyTo: null,
          materialId: pausedMatId,
          requestId: null,
          reportVersion: null,
          createdAt: TASK165_TIMES.t12,
        },
      ],
      requests: [],
      reports: [],
      acceptances: [],
      materials: [
        {
          id: pausedMatId,
          ownerProjectId: alpha,
          kind: "body",
          sizeBytes: utf8ByteLength(pausedBody),
          sha256: sha256OfText(pausedBody),
          scope: null,
        },
      ],
      operations: [
        {
          projectId: alpha,
          operationId: "op-paused-send",
          fingerprint: sha256OfText("paused-send"),
          outcome: { kind: "send", exchangeId: pausedId, seq: 1, materialId: pausedMatId },
        },
        {
          projectId: beta,
          operationId: "op-paused-pause",
          fingerprint: sha256OfText("paused-pause"),
          outcome: exchangeControlOutcome(pausedId, 2, pauseTransition),
        },
      ],
    },
    lifecycle: {
      initialMembers: [alpha, beta],
      workRevision: 1,
      transitions: [
        {
          seq: 2,
          workRevision: 1,
          actorId: beta,
          operationId: "op-paused-pause",
          transition: pauseTransition,
        },
      ],
    },
    notices: {
      compatibilityAt: null,
      openConnectionIssues: [],
    },
  };

  const completedId = TASK165_IDS.exchanges.completed;
  const completedReqId = TASK165_IDS.exchanges.completedReq;
  const completedReportMatId = TASK165_IDS.exchanges.completedReportMat;
  const completedReportBody = "Completed report body";
  const completedCriteria = ["All requests accepted"];
  const proposeTransition = {
    kind: "propose" as const,
    proposal: {
      version: 1,
      proposerId: alpha,
      members: [alpha, beta],
      rosterVersion: 1,
      workRevision: 4,
      criterion: completedCriteria,
      summary: "All criteria satisfied",
      report: [{ requestId: completedReqId, reportVersion: 1 }],
      disposition: [],
    },
  };
  const voteAlpha = {
    kind: "vote" as const,
    proposalVersion: 1,
    vote: "approve" as const,
    objection: null,
    acceptanceSequences: [],
    completed: false,
  };
  const voteBeta = {
    kind: "vote" as const,
    proposalVersion: 1,
    vote: "approve" as const,
    objection: null,
    acceptanceSequences: [],
    completed: true,
  };
  const completedExchange: ExchangeSnapshotRecord = {
    id: completedId,
    openingProjectId: alpha,
    goal: "Completed exchange with full vote closure",
    criteria: completedCriteria,
    createdAt: TASK165_TIMES.t12,
    members: [alpha, beta],
    readRanges: [],
    creationOutcomes: [{ projectId: alpha, operationId: "op-done-create", fingerprint: sha256OfText("done-create") }],
    collaboration: {
      lastSeq: 6,
      messages: [
        {
          seq: 1,
          senderId: alpha,
          recipientId: beta,
          kind: "request",
          replyTo: null,
          materialId: null,
          requestId: completedReqId,
          reportVersion: null,
          createdAt: TASK165_TIMES.t13,
        },
        {
          seq: 2,
          senderId: beta,
          recipientId: alpha,
          kind: "report",
          replyTo: 1,
          materialId: completedReportMatId,
          requestId: completedReqId,
          reportVersion: 1,
          createdAt: TASK165_TIMES.t14,
        },
        {
          seq: 3,
          senderId: alpha,
          recipientId: null,
          kind: "accept",
          replyTo: 2,
          materialId: null,
          requestId: completedReqId,
          reportVersion: 1,
          createdAt: TASK165_TIMES.t15,
        },
      ],
      requests: [
        {
          id: completedReqId,
          requesterId: alpha,
          assigneeId: beta,
          assignmentVersion: 1,
          condition: "Produce final report",
          criteria: ["Report accepted"],
        },
      ],
      reports: [
        {
          requestId: completedReqId,
          version: 1,
          assignmentVersion: 1,
          authorId: beta,
          materialId: completedReportMatId,
          evidence: [],
        },
      ],
      acceptances: [
        {
          requestId: completedReqId,
          reportVersion: 1,
          requesterId: alpha,
          acceptedAt: TASK165_TIMES.t15,
          receipt: { operationId: "op-done-accept", kind: "accept" },
        },
      ],
      materials: [
        {
          id: completedReportMatId,
          ownerProjectId: beta,
          kind: "body",
          sizeBytes: utf8ByteLength(completedReportBody),
          sha256: sha256OfText(completedReportBody),
          scope: null,
        },
      ],
      operations: [
        {
          projectId: alpha,
          operationId: "op-done-req",
          fingerprint: sha256OfText("done-req"),
          outcome: {
            kind: "request",
            exchangeId: completedId,
            seq: 1,
            requestId: completedReqId,
            assignmentVersion: 1,
          },
        },
        {
          projectId: beta,
          operationId: "op-done-report",
          fingerprint: sha256OfText("done-report"),
          outcome: {
            kind: "report",
            exchangeId: completedId,
            seq: 2,
            requestId: completedReqId,
            reportVersion: 1,
            materialId: completedReportMatId,
          },
        },
        {
          projectId: alpha,
          operationId: "op-done-accept",
          fingerprint: sha256OfText("done-accept"),
          outcome: { kind: "accept", exchangeId: completedId, sequences: [3] },
        },
        {
          projectId: alpha,
          operationId: "op-done-propose",
          fingerprint: sha256OfText("done-propose"),
          outcome: exchangeControlOutcome(completedId, 4, proposeTransition),
        },
        {
          projectId: alpha,
          operationId: "op-done-vote-alpha",
          fingerprint: sha256OfText("done-vote-alpha"),
          outcome: exchangeControlOutcome(completedId, 5, voteAlpha),
        },
        {
          projectId: beta,
          operationId: "op-done-vote-beta",
          fingerprint: sha256OfText("done-vote-beta"),
          outcome: exchangeControlOutcome(completedId, 6, voteBeta),
        },
      ],
    },
    lifecycle: {
      initialMembers: [alpha, beta],
      workRevision: 4,
      transitions: [
        {
          seq: 4,
          workRevision: 4,
          actorId: alpha,
          operationId: "op-done-propose",
          transition: proposeTransition,
        },
        {
          seq: 5,
          workRevision: 4,
          actorId: alpha,
          operationId: "op-done-vote-alpha",
          transition: voteAlpha,
        },
        {
          seq: 6,
          workRevision: 4,
          actorId: beta,
          operationId: "op-done-vote-beta",
          transition: voteBeta,
        },
      ],
    },
    notices: {
      compatibilityAt: null,
      openConnectionIssues: [],
    },
  };

  const projects = [{ id: alpha }, { id: beta }, { id: TASK165_IDS.projects.gamma }];
  unwrap(
    validateExchangeInventory([activeExchange, pausedExchange, completedExchange], projects, 3, "notices"),
    "primary exchanges",
  );
  return [activeExchange, pausedExchange, completedExchange];
}

function buildActiveCollaborationExchangeRecords(): ExchangeSnapshotRecord[] {
  const alpha = TASK165_IDS.projects.alpha;
  const beta = TASK165_IDS.projects.beta;
  const collabId = TASK165_IDS.exchanges.collabOnly;
  const sendMatId = TASK165_IDS.exchanges.collabSendMat;
  const reqId = TASK165_IDS.exchanges.collabReq;
  const reportMatId = TASK165_IDS.exchanges.collabReportMat;
  const sendBody = "Collaboration intro message";
  const reportBody = "Collaboration report body";

  const record: ExchangeSnapshotRecord = {
    id: collabId,
    openingProjectId: alpha,
    goal: "Pure active collaboration exchange without lifecycle or notices",
    criteria: ["Verify literal collaboration wire representation"],
    createdAt: TASK165_TIMES.t09,
    members: [alpha, beta],
    readRanges: [{ projectId: beta, firstSeq: 1, lastSeq: 2 }],
    creationOutcomes: [
      { projectId: alpha, operationId: "op-collab-create", fingerprint: sha256OfText("collab-create") },
    ],
    collaboration: {
      lastSeq: 4,
      messages: [
        {
          seq: 1,
          senderId: alpha,
          recipientId: beta,
          kind: "information",
          replyTo: null,
          materialId: sendMatId,
          requestId: null,
          reportVersion: null,
          createdAt: TASK165_TIMES.t10,
        },
        {
          seq: 2,
          senderId: alpha,
          recipientId: beta,
          kind: "request",
          replyTo: 1,
          materialId: null,
          requestId: reqId,
          reportVersion: null,
          createdAt: TASK165_TIMES.t11,
        },
        {
          seq: 3,
          senderId: beta,
          recipientId: alpha,
          kind: "report",
          replyTo: 2,
          materialId: reportMatId,
          requestId: reqId,
          reportVersion: 1,
          createdAt: TASK165_TIMES.t12,
        },
        {
          seq: 4,
          senderId: alpha,
          recipientId: null,
          kind: "accept",
          replyTo: 3,
          materialId: null,
          requestId: reqId,
          reportVersion: 1,
          createdAt: TASK165_TIMES.t13,
        },
      ],
      requests: [
        {
          id: reqId,
          requesterId: alpha,
          assigneeId: beta,
          assignmentVersion: 1,
          condition: "Submit collaboration report",
          criteria: ["Body-only collaboration materials"],
        },
      ],
      reports: [
        {
          requestId: reqId,
          version: 1,
          assignmentVersion: 1,
          authorId: beta,
          materialId: reportMatId,
          evidence: [],
        },
      ],
      acceptances: [
        {
          requestId: reqId,
          reportVersion: 1,
          requesterId: alpha,
          acceptedAt: TASK165_TIMES.t13,
          receipt: { operationId: "op-collab-accept", kind: "accept" },
        },
      ],
      materials: [
        {
          id: sendMatId,
          ownerProjectId: alpha,
          kind: "body",
          sizeBytes: utf8ByteLength(sendBody),
          sha256: sha256OfText(sendBody),
          scope: null,
        },
        {
          id: reportMatId,
          ownerProjectId: beta,
          kind: "body",
          sizeBytes: utf8ByteLength(reportBody),
          sha256: sha256OfText(reportBody),
          scope: null,
        },
      ],
      operations: [
        {
          projectId: alpha,
          operationId: "op-collab-send",
          fingerprint: sha256OfText("collab-send"),
          outcome: { kind: "send", exchangeId: collabId, seq: 1, materialId: sendMatId },
        },
        {
          projectId: alpha,
          operationId: "op-collab-req",
          fingerprint: sha256OfText("collab-req"),
          outcome: {
            kind: "request",
            exchangeId: collabId,
            seq: 2,
            requestId: reqId,
            assignmentVersion: 1,
          },
        },
        {
          projectId: beta,
          operationId: "op-collab-report",
          fingerprint: sha256OfText("collab-report"),
          outcome: {
            kind: "report",
            exchangeId: collabId,
            seq: 3,
            requestId: reqId,
            reportVersion: 1,
            materialId: reportMatId,
          },
        },
        {
          projectId: alpha,
          operationId: "op-collab-accept",
          fingerprint: sha256OfText("collab-accept"),
          outcome: { kind: "accept", exchangeId: collabId, sequences: [4] },
        },
      ],
    },
  };

  const projects = [{ id: alpha }, { id: beta }, { id: TASK165_IDS.projects.gamma }];
  unwrap(validateExchangeInventory([record], projects, 1, "collaboration"), "active collaboration exchange");
  return [record];
}

function seedCommonInstallation(
  home: string,
  vault: string,
  exchanges: ExchangeSnapshotRecord[],
): { home: string; vault: string; database: string } {
  const clock = new FakeClock(Date.parse(TASK165_TIMES.base));
  const initPorts = {
    ...createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock }),
    ids: { next: () => TASK165_IDS.installation },
  };
  unwrap(initializeInstallation(initPorts, { vaultPath: vault }), "initializeInstallation");

  // Place file-backed Artifact, Memo, and Channel Vault files before the SQLite transaction.
  const artifactBytes = Buffer.from(TASK165_BODIES.fileArtifact, "utf8");
  const artifactDest = join(vault, FILE_ARTIFACT_STORAGE_KEY);
  mkdirSync(dirname(artifactDest), { recursive: true });
  writeFileSync(artifactDest, artifactBytes);
  chmodSync(artifactDest, 0o444);

  const fileMemoBytes = Buffer.from(TASK165_BODIES.fileMemo, "utf8");
  const placedMemo = unwrap(
    placeMemoContentFile(vault, TASK165_IDS.memos.file, TASK165_IDS.memos.fileRecord, fileMemoBytes),
    "placeMemoContentFile",
  );

  const openChannelFileBytes = Buffer.from(TASK165_BODIES.openChannelFile, "utf8");
  const channelFileStorageKey = `content/channel/${TASK165_IDS.channels.open}/${TASK165_IDS.channels.openMsg2Record}`;
  const channelFileDest = join(vault, channelFileStorageKey);
  mkdirSync(dirname(channelFileDest), { recursive: true });
  writeFileSync(channelFileDest, openChannelFileBytes);
  chmodSync(channelFileDest, 0o444);

  const database = join(home, "state", "sorage.sqlite3");
  const db = openSorageDatabase(database);
  try {
    db.exec("BEGIN");
    seedProjectsAndBindings(db);
    restoreExchangeRecords(db, exchanges, TASK165_TIMES.base);
    seedHandoffs(db, artifactBytes);
    seedMemos(db, placedMemo);
    seedChannels(db, openChannelFileBytes, channelFileStorageKey);
    seedEvents(db);
    db.exec("COMMIT");

    const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (fkErrors.length !== 0) {
      throw new Error(`Seeded DB failed foreign_key_check: ${JSON.stringify(fkErrors)}`);
    }
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw error;
  } finally {
    db.close();
  }
  return { home, vault, database };
}

function seedProjectsAndBindings(db: SorageSqlite): void {
  const insertProject = db.prepare(
    `INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProject.run(
    TASK165_IDS.projects.alpha,
    "alpha",
    "Alpha",
    "Primary sender project",
    "active",
    TASK165_TIMES.base,
    TASK165_TIMES.base,
  );
  insertProject.run(
    TASK165_IDS.projects.beta,
    "beta",
    "Beta",
    "Primary recipient project",
    "active",
    TASK165_TIMES.base,
    TASK165_TIMES.base,
  );
  insertProject.run(
    TASK165_IDS.projects.gamma,
    "gamma",
    "Gamma",
    null,
    "archived",
    TASK165_TIMES.base,
    TASK165_TIMES.t01,
  );

  const insertBinding = db.prepare(
    `INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertBinding.run(
    TASK165_IDS.bindings.alpha,
    TASK165_IDS.projects.alpha,
    TASK165_IDS.installation,
    "/deterministic/work/alpha",
    "directory",
    TASK165_TIMES.base,
    TASK165_TIMES.base,
  );
  insertBinding.run(
    TASK165_IDS.bindings.beta,
    TASK165_IDS.projects.beta,
    TASK165_IDS.installation,
    "/deterministic/work/beta",
    "git_repository",
    TASK165_TIMES.base,
    TASK165_TIMES.base,
  );
}

function seedHandoffs(db: SorageSqlite, artifactBytes: Buffer): void {
  const inlineArtifactBytes = Buffer.from(TASK165_BODIES.inlineArtifact, "utf8");
  const insertContent = db.prepare(
    `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
     VALUES (?, CAST(? AS TEXT), ?, ?, ?, 1, ?)`,
  );
  insertContent.run(
    TASK165_IDS.artifacts.fileRecord,
    null,
    FILE_ARTIFACT_STORAGE_KEY,
    artifactBytes.byteLength,
    sha256Bytes(artifactBytes),
    TASK165_TIMES.t01,
  );
  insertContent.run(
    TASK165_IDS.artifacts.inlineRecord,
    inlineArtifactBytes,
    null,
    inlineArtifactBytes.byteLength,
    sha256Bytes(inlineArtifactBytes),
    TASK165_TIMES.t02,
  );

  const insertHandoff = db.prepare(
    `INSERT INTO handoffs (
       id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id,
       sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id,
       revision, row_version, review_state, accepted_revision, accepted_at, declined_at,
       decline_reason, withdrawn_at, consecutive_no_change_resolutions, first_fetched_at,
       review_engaged_at, pinned, archived_at, deleted_at, created_at, updated_at,
       read_status, read_revision, revision_read_at,
       processing_status, processing_started_at, processing_completed_at
     ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // 1. File-backed Handoff with completed V4 reporting state, general comment, and rejected deletion request.
  insertHandoff.run(
    TASK165_IDS.handoffs.file,
    "File-backed Reported Handoff",
    "registered_project",
    TASK165_IDS.projects.alpha,
    null,
    "/deterministic/work/alpha",
    TASK165_IDS.projects.beta,
    TASK165_IDS.artifacts.file,
    1,
    4,
    "accepted",
    1,
    TASK165_TIMES.t03,
    TASK165_TIMES.t02,
    TASK165_TIMES.t02,
    1,
    null,
    TASK165_TIMES.t01,
    TASK165_TIMES.t04,
    "read",
    1,
    TASK165_TIMES.t02,
    "completed",
    TASK165_TIMES.t03,
    TASK165_TIMES.t04,
  );

  // 2. Inline Handoff with active change_request comment.
  insertHandoff.run(
    TASK165_IDS.handoffs.inline,
    "Inline Review Handoff",
    "unregistered_workspace",
    null,
    "deterministic-workspace-key",
    "/deterministic/work/unregistered",
    TASK165_IDS.projects.beta,
    TASK165_IDS.artifacts.inline,
    1,
    2,
    "changes_requested",
    null,
    null,
    TASK165_TIMES.t03,
    TASK165_TIMES.t03,
    0,
    null,
    TASK165_TIMES.t02,
    TASK165_TIMES.t03,
    "unconfirmed",
    null,
    null,
    "not_started",
    null,
    null,
  );

  // 3. Tombstone Handoff.
  insertHandoff.run(
    TASK165_IDS.handoffs.tombstone,
    "Deleted Tombstone Handoff",
    "user",
    null,
    null,
    null,
    TASK165_IDS.projects.beta,
    null,
    1,
    1,
    "accepted",
    1,
    TASK165_TIMES.t03,
    null,
    null,
    0,
    TASK165_TIMES.t04,
    TASK165_TIMES.t03,
    TASK165_TIMES.t04,
    "unrecorded",
    null,
    null,
    "unrecorded",
    null,
    null,
  );

  const insertArtifact = db.prepare(
    `INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertArtifact.run(
    TASK165_IDS.artifacts.file,
    TASK165_IDS.handoffs.file,
    "brief.md",
    "brief.md",
    "text/markdown",
    "/deterministic/work/alpha/brief.md",
    TASK165_TIMES.t01,
    TASK165_IDS.artifacts.fileRecord,
  );
  insertArtifact.run(
    TASK165_IDS.artifacts.inline,
    TASK165_IDS.handoffs.inline,
    "inline.md",
    "inline.md",
    "text/markdown",
    null,
    TASK165_TIMES.t02,
    TASK165_IDS.artifacts.inlineRecord,
  );

  const insertNote = db.prepare(
    `INSERT INTO review_notes (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at, purpose, active)
     VALUES (?, ?, ?, ?, CAST(? AS TEXT), ?, ?, ?, ?)`,
  );
  insertNote.run(
    TASK165_IDS.handoffs.file,
    "registered_project",
    TASK165_IDS.projects.beta,
    1,
    Buffer.from("\uFEFFGeneral note\r\n", "utf8"),
    TASK165_TIMES.t03,
    TASK165_TIMES.t03,
    "general",
    0,
  );
  insertNote.run(
    TASK165_IDS.handoffs.inline,
    "registered_project",
    TASK165_IDS.projects.beta,
    1,
    Buffer.from("Please clarify section 2", "utf8"),
    TASK165_TIMES.t03,
    TASK165_TIMES.t03,
    "change_request",
    1,
  );

  db.prepare(
    `INSERT INTO deletion_requests (id, handoff_id, requested_by_kind, requested_by_id, reason, status,
       requested_at, resolved_at, resolved_by_user, resolution_note)
     VALUES (?, ?, 'registered_project', ?, 'Keep audit history', 'rejected', ?, ?, 'user', 'Retained')`,
  ).run(
    TASK165_IDS.deletionRequest,
    TASK165_IDS.handoffs.file,
    TASK165_IDS.projects.beta,
    TASK165_TIMES.t02,
    TASK165_TIMES.t03,
  );
}

function seedMemos(db: SorageSqlite, placedMemo: { storageKey: string; sizeBytes: number; sha256: string }): void {
  const inlineCreated = unwrap(
    createMemo(
      TASK165_IDS.memos.inline,
      TASK165_IDS.projects.alpha,
      { title: "Inline Memo", body: TASK165_BODIES.inlineMemoInitial },
      TASK165_TIMES.t04,
    ),
    "create inline memo",
  );
  const inlineUpdated = unwrap(
    changeMemo(
      inlineCreated.memo,
      { operation: "update", expectedRowVersion: 1, body: TASK165_BODIES.inlineMemoFinal },
      TASK165_TIMES.t05,
    ),
    "update inline memo",
  );
  const inlineDone = unwrap(
    changeMemo(inlineUpdated.memo, { operation: "done", expectedRowVersion: 2 }, TASK165_TIMES.t06),
    "done inline memo",
  );
  insertMemoWithInlineRecord(db, inlineDone.memo, TASK165_IDS.memos.inlineRecord);

  const fileCreated = unwrap(
    createMemo(
      TASK165_IDS.memos.file,
      TASK165_IDS.projects.beta,
      { title: "File-backed Memo", body: "placeholder" },
      TASK165_TIMES.t05,
    ),
    "create file memo",
  );
  const { body: _ignoredBody, ...fileMemoMeta } = fileCreated.memo;
  insertMemoWithFileRecordRows(
    db,
    fileMemoMeta,
    { sizeBytes: placedMemo.sizeBytes, sha256: placedMemo.sha256 },
    TASK165_IDS.memos.fileRecord,
    placedMemo.storageKey,
  );
}

function seedChannels(db: SorageSqlite, openFileBytes: Buffer, channelFileStorageKey: string): void {
  const insertChannel = db.prepare(
    `INSERT INTO channels (id, name, title, state, created_at, closed_at)
     VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?)`,
  );
  insertChannel.run(
    TASK165_IDS.channels.open,
    Buffer.from("ch-open", "utf8"),
    "Open Channel",
    "open",
    TASK165_TIMES.t06,
    null,
  );
  insertChannel.run(
    TASK165_IDS.channels.closed,
    Buffer.from("ch-closed", "utf8"),
    null,
    "closed",
    TASK165_TIMES.t07,
    TASK165_TIMES.t09,
  );

  const insertParticipant = db.prepare(
    `INSERT INTO channel_participants (channel_id, handle, role, added_at, removed_at)
     VALUES (?, CAST(? AS TEXT), ?, ?, ?)`,
  );
  insertParticipant.run(TASK165_IDS.channels.open, Buffer.from("main", "utf8"), "main", TASK165_TIMES.t06, null);
  insertParticipant.run(TASK165_IDS.channels.open, Buffer.from("worker-1", "utf8"), "worker", TASK165_TIMES.t07, null);
  insertParticipant.run(
    TASK165_IDS.channels.open,
    Buffer.from("judge-1", "utf8"),
    "judge",
    TASK165_TIMES.t07,
    TASK165_TIMES.t08,
  );
  insertParticipant.run(TASK165_IDS.channels.closed, Buffer.from("main", "utf8"), "main", TASK165_TIMES.t07, null);
  insertParticipant.run(
    TASK165_IDS.channels.closed,
    Buffer.from("worker-1", "utf8"),
    "worker",
    TASK165_TIMES.t08,
    null,
  );

  const openInlineBytes = Buffer.from(TASK165_BODIES.openChannelInline, "utf8");
  const closedInlineBytes = Buffer.from(TASK165_BODIES.closedChannelInline, "utf8");
  const insertContent = db.prepare(
    `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
     VALUES (?, CAST(? AS TEXT), ?, ?, ?, 1, ?)`,
  );
  insertContent.run(
    TASK165_IDS.channels.openMsg1Record,
    openInlineBytes,
    null,
    openInlineBytes.byteLength,
    sha256Bytes(openInlineBytes),
    TASK165_TIMES.t07,
  );
  insertContent.run(
    TASK165_IDS.channels.openMsg2Record,
    null,
    channelFileStorageKey,
    openFileBytes.byteLength,
    sha256Bytes(openFileBytes),
    TASK165_TIMES.t08,
  );
  insertContent.run(
    TASK165_IDS.channels.closedMsg1Record,
    closedInlineBytes,
    null,
    closedInlineBytes.byteLength,
    sha256Bytes(closedInlineBytes),
    TASK165_TIMES.t08,
  );

  const insertMessage = db.prepare(
    `INSERT INTO channel_messages (
       channel_id, seq, sender_handle, kind, to_handle, ref, content_record_id,
       handled, handled_at, handle_note, created_at
     ) VALUES (?, ?, CAST(? AS TEXT), ?, CAST(? AS TEXT), CAST(? AS TEXT), ?, ?, ?, CAST(? AS TEXT), ?)`,
  );
  insertMessage.run(
    TASK165_IDS.channels.open,
    1,
    Buffer.from("worker-1", "utf8"),
    "report",
    null,
    Buffer.from("pr-165", "utf8"),
    TASK165_IDS.channels.openMsg1Record,
    1,
    TASK165_TIMES.t08,
    Buffer.from("Reviewed", "utf8"),
    TASK165_TIMES.t07,
  );
  insertMessage.run(
    TASK165_IDS.channels.open,
    2,
    Buffer.from("worker-1", "utf8"),
    "relay_request",
    Buffer.from("judge-1", "utf8"),
    null,
    TASK165_IDS.channels.openMsg2Record,
    0,
    null,
    null,
    TASK165_TIMES.t08,
  );
  insertMessage.run(
    TASK165_IDS.channels.closed,
    1,
    Buffer.from("worker-1", "utf8"),
    "question",
    null,
    null,
    TASK165_IDS.channels.closedMsg1Record,
    1,
    TASK165_TIMES.t09,
    null,
    TASK165_TIMES.t08,
  );
}

function seedEvents(db: SorageSqlite): void {
  const insertEvent = db.prepare(
    `INSERT INTO events (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const add = (
    id: string,
    handoffId: string | null,
    memoId: string | null,
    eventType: string,
    actorKind: string,
    actorId: string | null,
    rowVersion: number | null,
    metadata: Record<string, unknown>,
    createdAt: string,
  ) =>
    insertEvent.run(
      id,
      handoffId,
      memoId,
      eventType,
      actorKind,
      actorId,
      rowVersion,
      JSON.stringify(metadata),
      createdAt,
    );

  // Handoff + V4 reporting events (including a metadata path field to exercise BKP-003 redaction).
  add(
    TASK165_IDS.events.handoffFileCreated,
    TASK165_IDS.handoffs.file,
    null,
    "HANDOFF_CREATED",
    "registered_project",
    TASK165_IDS.projects.alpha,
    1,
    {
      title: "File-backed Reported Handoff",
      storageKey: FILE_ARTIFACT_STORAGE_KEY,
      fromPath: "/deterministic/redacted",
    },
    TASK165_TIMES.t01,
  );
  add(
    TASK165_IDS.events.handoffFileRead,
    TASK165_IDS.handoffs.file,
    null,
    "HANDOFF_REVISION_READ",
    "registered_project",
    TASK165_IDS.projects.beta,
    2,
    { revision: 1, artifactId: TASK165_IDS.artifacts.file },
    TASK165_TIMES.t02,
  );
  add(
    TASK165_IDS.events.handoffFileComment,
    TASK165_IDS.handoffs.file,
    null,
    "HANDOFF_COMMENT_SET",
    "registered_project",
    TASK165_IDS.projects.beta,
    3,
    { targetRevision: 1, purpose: "general", active: false, authorKind: "registered_project" },
    TASK165_TIMES.t03,
  );
  add(
    TASK165_IDS.events.handoffFileStarted,
    TASK165_IDS.handoffs.file,
    null,
    "HANDOFF_PROCESSING_STARTED",
    "registered_project",
    TASK165_IDS.projects.beta,
    3,
    { revision: 1 },
    TASK165_TIMES.t03,
  );
  add(
    TASK165_IDS.events.handoffFileCompleted,
    TASK165_IDS.handoffs.file,
    null,
    "HANDOFF_PROCESSING_COMPLETED",
    "registered_project",
    TASK165_IDS.projects.beta,
    4,
    { revision: 1 },
    TASK165_TIMES.t04,
  );
  add(
    TASK165_IDS.events.handoffInlineCreated,
    TASK165_IDS.handoffs.inline,
    null,
    "HANDOFF_CREATED",
    "unregistered_workspace",
    "deterministic-workspace-key",
    1,
    { title: "Inline Review Handoff" },
    TASK165_TIMES.t02,
  );
  add(
    TASK165_IDS.events.handoffInlineNote,
    TASK165_IDS.handoffs.inline,
    null,
    "REVIEW_NOTE_CREATED",
    "registered_project",
    TASK165_IDS.projects.beta,
    2,
    { targetRevision: 1 },
    TASK165_TIMES.t03,
  );
  add(
    TASK165_IDS.events.handoffTombstoneCreated,
    TASK165_IDS.handoffs.tombstone,
    null,
    "HANDOFF_CREATED",
    "user",
    null,
    1,
    { title: "Deleted Tombstone Handoff" },
    TASK165_TIMES.t03,
  );

  // Memo lifecycle events.
  add(
    TASK165_IDS.events.memoInlineCreated,
    null,
    TASK165_IDS.memos.inline,
    "MEMO_CREATED",
    "user",
    null,
    1,
    { projectId: TASK165_IDS.projects.alpha, memoId: TASK165_IDS.memos.inline, rowVersion: 1, toState: "open" },
    TASK165_TIMES.t04,
  );
  add(
    TASK165_IDS.events.memoInlineUpdated,
    null,
    TASK165_IDS.memos.inline,
    "MEMO_UPDATED",
    "user",
    null,
    2,
    { projectId: TASK165_IDS.projects.alpha, memoId: TASK165_IDS.memos.inline, rowVersion: 2, changedFields: ["body"] },
    TASK165_TIMES.t05,
  );
  add(
    TASK165_IDS.events.memoInlineDone,
    null,
    TASK165_IDS.memos.inline,
    "MEMO_MARKED_DONE",
    "user",
    null,
    3,
    {
      projectId: TASK165_IDS.projects.alpha,
      memoId: TASK165_IDS.memos.inline,
      rowVersion: 3,
      fromState: "open",
      toState: "done",
    },
    TASK165_TIMES.t06,
  );
  add(
    TASK165_IDS.events.memoFileCreated,
    null,
    TASK165_IDS.memos.file,
    "MEMO_CREATED",
    "user",
    null,
    1,
    { projectId: TASK165_IDS.projects.beta, memoId: TASK165_IDS.memos.file, rowVersion: 1, toState: "open" },
    TASK165_TIMES.t05,
  );

  // Channel domain events.
  add(
    TASK165_IDS.events.chOpenCreated,
    null,
    null,
    "CHANNEL_CREATED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.open, actingHandle: "main", mainHandle: "main" },
    TASK165_TIMES.t06,
  );
  add(
    TASK165_IDS.events.chOpenAddWorker,
    null,
    null,
    "CHANNEL_PARTICIPANT_ADDED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.open, actingHandle: "main", handle: "worker-1", role: "worker" },
    TASK165_TIMES.t07,
  );
  add(
    TASK165_IDS.events.chOpenAddJudge,
    null,
    null,
    "CHANNEL_PARTICIPANT_ADDED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.open, actingHandle: "main", handle: "judge-1", role: "judge" },
    TASK165_TIMES.t07,
  );
  add(
    TASK165_IDS.events.chOpenMsg1Posted,
    null,
    null,
    "CHANNEL_MESSAGE_POSTED",
    "user",
    null,
    null,
    {
      channelId: TASK165_IDS.channels.open,
      actingHandle: "worker-1",
      seq: 1,
      kind: "report",
      toHandle: null,
    },
    TASK165_TIMES.t07,
  );
  add(
    TASK165_IDS.events.chOpenMsg1Acked,
    null,
    null,
    "CHANNEL_MESSAGE_ACKED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.open, actingHandle: "main", seq: 1 },
    TASK165_TIMES.t08,
  );
  add(
    TASK165_IDS.events.chOpenMsg2Posted,
    null,
    null,
    "CHANNEL_MESSAGE_POSTED",
    "user",
    null,
    null,
    {
      channelId: TASK165_IDS.channels.open,
      actingHandle: "worker-1",
      seq: 2,
      kind: "relay_request",
      toHandle: "judge-1",
    },
    TASK165_TIMES.t08,
  );
  add(
    TASK165_IDS.events.chOpenRemoveJudge,
    null,
    null,
    "CHANNEL_PARTICIPANT_REMOVED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.open, actingHandle: "main", handle: "judge-1" },
    TASK165_TIMES.t08,
  );
  add(
    TASK165_IDS.events.chClosedCreated,
    null,
    null,
    "CHANNEL_CREATED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.closed, actingHandle: "main", mainHandle: "main" },
    TASK165_TIMES.t07,
  );
  add(
    TASK165_IDS.events.chClosedAddWorker,
    null,
    null,
    "CHANNEL_PARTICIPANT_ADDED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.closed, actingHandle: "main", handle: "worker-1", role: "worker" },
    TASK165_TIMES.t08,
  );
  add(
    TASK165_IDS.events.chClosedMsg1Posted,
    null,
    null,
    "CHANNEL_MESSAGE_POSTED",
    "user",
    null,
    null,
    {
      channelId: TASK165_IDS.channels.closed,
      actingHandle: "worker-1",
      seq: 1,
      kind: "question",
      toHandle: null,
    },
    TASK165_TIMES.t08,
  );
  add(
    TASK165_IDS.events.chClosedMsg1Acked,
    null,
    null,
    "CHANNEL_MESSAGE_ACKED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.closed, actingHandle: "main", seq: 1 },
    TASK165_TIMES.t09,
  );
  add(
    TASK165_IDS.events.chClosedClosed,
    null,
    null,
    "CHANNEL_CLOSED",
    "user",
    null,
    null,
    { channelId: TASK165_IDS.channels.closed, actingHandle: "main" },
    TASK165_TIMES.t09,
  );
}

export function seedPrimaryInstallation(home: string, vault: string) {
  return seedCommonInstallation(home, vault, buildPrimaryExchangeRecords());
}

export function seedActiveCollaborationInstallation(home: string, vault: string) {
  return seedCommonInstallation(home, vault, buildActiveCollaborationExchangeRecords());
}

export function readPrimaryFoundationData(home: string): SnapshotDataV5 {
  const ports = unwrap(
    createNodeBackupCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      clock: new FakeClock(Date.parse(TASK165_TIMES.base)),
    }).exportPorts(),
    "foundation exportPorts",
  );
  const full = unwrap(ports.readSnapshotData(), "foundation readSnapshotData");
  if (!("exchanges" in full)) throw new Error("Expected V5 SnapshotData from current adapter");
  const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
  try {
    const exchanges = readExchangeRecords(db);
    return { ...redactSnapshotDataV4(full), exchanges, exchangeRepresentation: "foundation" };
  } finally {
    db.close();
  }
}

export function readActiveCollaborationData(home: string): SnapshotDataV5 {
  const ports = unwrap(
    createNodeBackupCommandPorts({
      env: { SORAGE_HOME: home },
      userHome: home,
      clock: new FakeClock(Date.parse(TASK165_TIMES.base)),
    }).exportPorts(),
    "collaboration exportPorts",
  );
  const full = unwrap(ports.readSnapshotData(), "collaboration readSnapshotData");
  if (!("exchanges" in full)) throw new Error("Expected V5 SnapshotData from current adapter");
  const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
  try {
    const exchanges = readExchangeRecords(db).map((row) => ({
      ...row,
      collaboration: readExchangeCollaboration(db, row.id, true),
    }));
    return { ...redactSnapshotDataV4(full), exchanges, exchangeRepresentation: "collaboration" };
  } finally {
    db.close();
  }
}

export function projectFormatData(full: SnapshotDataV5) {
  const optionalShared = {
    ...(full.memos !== undefined ? { memos: full.memos } : {}),
    ...(full.memoContentFiles !== undefined ? { memoContentFiles: full.memoContentFiles } : {}),
    ...(full.channels !== undefined ? { channels: full.channels } : {}),
    ...(full.channelContentFiles !== undefined ? { channelContentFiles: full.channelContentFiles } : {}),
  };
  const v4: SnapshotDataV4 = redactSnapshotDataV4({
    projects: full.projects,
    handoffs: full.handoffs,
    events: full.events,
    ...optionalShared,
  });

  const reportingTypes = new Set([
    "HANDOFF_COMMENT_SET",
    "HANDOFF_REVISION_READ",
    "HANDOFF_PROCESSING_STARTED",
    "HANDOFF_PROCESSING_COMPLETED",
  ]);
  const v3: SnapshotDataV3 = redactSnapshotDataV3({
    projects: full.projects,
    handoffs: full.handoffs.map(reportingSnapshotBase),
    events: full.events.filter((event) => !reportingTypes.has(event.eventType)),
    ...optionalShared,
  });

  const v2Handoffs: SnapshotData["handoffs"] = v3.handoffs
    .filter((handoff) => handoff.artifact === null || typeof handoff.artifact.storageKey === "string")
    .map((handoff) => {
      if (handoff.artifact === null) return { ...handoff, artifact: null };
      const { inlineBody: _inline, storageKey, ...rest } = handoff.artifact;
      return { ...handoff, artifact: { ...rest, storageKey: storageKey as string } };
    });
  const v2HandoffIds = new Set(v2Handoffs.map((h) => h.id));
  const v2Memos: Memo[] = (full.memos ?? [])
    .filter((memo) => memo.bodyContent.kind === "inline")
    .map(({ bodyContent, ...meta }) => ({
      ...meta,
      body: bodyContent.kind === "inline" ? bodyContent.text : "",
    }));
  const v2MemoIds = new Set(v2Memos.map((m) => m.id));
  const v2Events = v3.events.filter(
    (event) =>
      !event.eventType.startsWith("CHANNEL_") &&
      !event.eventType.startsWith("CONTENT_") &&
      (event.handoffId === null || v2HandoffIds.has(event.handoffId)) &&
      (event.memoId === null || event.memoId === undefined || v2MemoIds.has(event.memoId)),
  );
  const v2: SnapshotData = redactSnapshotData({
    projects: full.projects,
    handoffs: v2Handoffs,
    events: v2Events,
    memos: v2Memos,
  });

  const v1: SnapshotData = redactSnapshotData({
    projects: full.projects,
    handoffs: v2Handoffs,
    events: v2Events
      .filter((event) => !event.eventType.startsWith("MEMO_"))
      .map(({ memoId: _memoId, ...event }) => event),
  });

  return { v1, v2, v3, v4 };
}

function writeVaultFixtureTree(destRoot: string, sourceVault: string, files: SnapshotFile[]): void {
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });
  for (const policy of [".sorage-vault.json", ".gitattributes", ".gitignore"]) {
    writeFileSync(join(destRoot, policy), readFileSync(join(sourceVault, policy)));
  }
  const artifactDest = join(destRoot, FILE_ARTIFACT_STORAGE_KEY);
  mkdirSync(dirname(artifactDest), { recursive: true });
  writeFileSync(artifactDest, readFileSync(join(sourceVault, FILE_ARTIFACT_STORAGE_KEY)));

  const snapshotsRoot = join(destRoot, "snapshots");
  mkdirSync(snapshotsRoot, { recursive: true });
  for (const file of files) {
    const target = join(snapshotsRoot, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

export function collectSortedTreeChecksums(root: string, excludeRelative = new Set<string>()): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const walk = (directory: string, prefix: string): void => {
    const names = readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const full = join(directory, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Fixture tree must contain only regular files: ${full}`);
      const rel = `${prefix}${name}`;
      if (stat.isDirectory()) {
        walk(full, `${rel}/`);
      } else if (stat.isFile()) {
        if (excludeRelative.has(rel)) continue;
        entries.push([rel, sha256Bytes(readFileSync(full))]);
      } else {
        throw new Error(`Non-regular entry in fixture tree: ${full}`);
      }
    }
  };
  walk(root, "");
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

export function readTreeBuffers(root: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const walk = (directory: string, prefix: string): void => {
    const names = readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const full = join(directory, name);
      const stat = lstatSync(full);
      const rel = `${prefix}${name}`;
      if (stat.isDirectory()) walk(full, `${rel}/`);
      else if (stat.isFile()) files[rel] = readFileSync(full);
    }
  };
  walk(root, "");
  return files;
}

export function copyFixtureTreeToTempVault(
  fixtureDir: string,
  destDir: string,
  options: { artifactMode: number },
): void {
  mkdirSync(destDir, { recursive: true });
  const walk = (source: string, target: string, relPrefix: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const srcPath = join(source, entry.name);
      const dstPath = join(target, entry.name);
      const rel = `${relPrefix}${entry.name}`;
      if (entry.isDirectory()) {
        mkdirSync(dstPath, { recursive: true });
        walk(srcPath, dstPath, `${rel}/`);
      } else if (entry.isFile()) {
        writeFileSync(dstPath, readFileSync(srcPath));
        const mode = rel.startsWith("artifacts/") || rel.startsWith("content/") ? options.artifactMode : 0o644;
        chmodSync(dstPath, mode);
      }
    }
  };
  walk(fixtureDir, destDir, "");
}

export function generateTask165Fixtures(outputRoot = TASK165_FIXTURE_ROOT): {
  checksums: Record<string, string>;
  provenancePath: string;
} {
  if (process.env.TASK165_GENERATE_FIXTURES !== "1") {
    throw new Error("Refusing to write fixtures without explicit TASK165_GENERATE_FIXTURES=1");
  }
  const scratch = mkdtempSync(join(tmpdir(), "sorage-task165-gen-"));
  try {
    const primaryHome = join(scratch, "primary");
    const primaryVault = join(primaryHome, "vault");
    seedPrimaryInstallation(primaryHome, primaryVault);

    const collabHome = join(scratch, "collab");
    const collabVault = join(collabHome, "vault");
    seedActiveCollaborationInstallation(collabHome, collabVault);

    // 1. Production V5 notices tree via unchanged exportSnapshot.
    const primaryBackupPorts = createNodeBackupCommandPorts({
      env: { SORAGE_HOME: primaryHome },
      userHome: primaryHome,
      clock: new FakeClock(Date.parse(TASK165_TIMES.base)),
    });
    const exportPorts = unwrap(primaryBackupPorts.exportPorts(), "primary exportPorts");
    unwrap(exportSnapshot(exportPorts), "production exportSnapshot (v5-notices)");
    const primaryFullData = unwrap(exportPorts.readSnapshotData(), "primary readSnapshotData");
    if (!("exchanges" in primaryFullData)) throw new Error("Expected V5 SnapshotData from production adapter");

    // 2. Literal V5 foundation tree via unchanged snapshotFilesV5.
    const foundationData = readPrimaryFoundationData(primaryHome);
    const foundationBuilt = unwrap(snapshotFilesV5(foundationData), "snapshotFilesV5(foundation)");
    unwrap(validateSnapshot(foundationData, foundationBuilt.manifest), "validateSnapshot(foundation)");

    // 3. Literal V5 collaboration tree from separate active-only installation via unchanged snapshotFilesV5.
    const collabData = readActiveCollaborationData(collabHome);
    const collabBuilt = unwrap(snapshotFilesV5(collabData), "snapshotFilesV5(collaboration)");
    unwrap(validateSnapshot(collabData, collabBuilt.manifest), "validateSnapshot(collaboration)");

    // 4. Formats 1..4 via unchanged snapshotFiles / snapshotFilesV2 / snapshotFilesV3 / snapshotFilesV4.
    const { v1, v2, v3, v4 } = projectFormatData(primaryFullData);
    const v1Files = snapshotFiles(v1);
    const v2Built = unwrap(snapshotFilesV2(v2), "snapshotFilesV2");
    const v3Built = unwrap(snapshotFilesV3(v3), "snapshotFilesV3");
    const v4Built = unwrap(snapshotFilesV4(v4), "snapshotFilesV4");
    const v5NoticesFiles: SnapshotFile[] = Object.entries(readTreeBuffers(join(primaryVault, "snapshots"))).map(
      ([path, content]) => ({ path, content }),
    );

    rmSync(outputRoot, { recursive: true, force: true });
    mkdirSync(outputRoot, { recursive: true });
    // Freeze exact bytes in Git for all fixture trees (LF, CRLF, BOM, no trailing LF).
    writeFileSync(join(outputRoot, ".gitattributes"), "* -text -diff\n");

    writeVaultFixtureTree(join(outputRoot, "v5-foundation"), primaryVault, foundationBuilt.files);
    writeVaultFixtureTree(join(outputRoot, "v5-collaboration"), collabVault, collabBuilt.files);
    writeVaultFixtureTree(join(outputRoot, "v5-notices"), primaryVault, v5NoticesFiles);

    writeVaultFixtureTree(join(outputRoot, "formats/v1"), primaryVault, v1Files);
    writeVaultFixtureTree(join(outputRoot, "formats/v2"), primaryVault, v2Built.files);
    writeVaultFixtureTree(join(outputRoot, "formats/v3"), primaryVault, v3Built.files);
    writeVaultFixtureTree(join(outputRoot, "formats/v4"), primaryVault, v4Built.files);
    writeVaultFixtureTree(join(outputRoot, "formats/v5"), primaryVault, v5NoticesFiles);

    const checksums = collectSortedTreeChecksums(outputRoot, new Set(["PROVENANCE.json"]));
    const provenance = {
      task: "TASK-165",
      baseSha: TASK165_BASE_SHA,
      fixedClockBase: TASK165_TIMES.base,
      fixedInstallationId: TASK165_IDS.installation,
      writers: {
        "v5-foundation": "snapshotFilesV5(readPrimaryFoundationData, exchangeRepresentation='foundation')",
        "v5-collaboration": "snapshotFilesV5(readActiveCollaborationData, exchangeRepresentation='collaboration')",
        "v5-notices": "exportSnapshot(createNodeBackupCommandPorts().exportPorts()) [exchangeRepresentation='notices']",
        "formats/v1": "snapshotFiles(v1)",
        "formats/v2": "snapshotFilesV2(v2)",
        "formats/v3": "snapshotFilesV3(v3)",
        "formats/v4": "snapshotFilesV4(v4)",
        "formats/v5": "exportSnapshot(createNodeBackupCommandPorts().exportPorts()) [exchangeRepresentation='notices']",
      },
      trees: [...TASK165_V5_TREES, ...TASK165_FORMAT_TREES],
      fileCount: Object.keys(checksums).length,
      sha256: checksums,
    };
    const provenancePath = join(outputRoot, "PROVENANCE.json");
    writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    return { checksums, provenancePath };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = generateTask165Fixtures();
  console.log(
    JSON.stringify(
      {
        generated: Object.keys(result.checksums).length,
        provenance: result.provenancePath,
      },
      null,
      2,
    ),
  );
}
