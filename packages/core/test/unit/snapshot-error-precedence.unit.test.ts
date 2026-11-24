import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportSnapshot } from "../../src/backup/backup-export";
import { validateSnapshot } from "../../src/backup/backup-restore";
import type { SnapshotData, SnapshotEvent, SnapshotFile } from "../../src/backup/snapshot/backup-snapshot";
import type { SnapshotChannelShard, SnapshotDataV3, SnapshotMemoV3 } from "../../src/backup/snapshot/content-snapshot";
import { ok } from "../../src/shared/errors";
import {
  EXCHANGE_SNAPSHOT_FILE,
  type ExchangeSnapshotRecord,
  openExchangeSnapshot,
  parseExchangeSnapshot,
  type SnapshotDataV5,
  snapshotFilesV5,
} from "../../src/backup/snapshot/exchange-snapshot";
import type { SnapshotHandoffV4 } from "../../src/backup/snapshot/handoff-reporting-snapshot";
import { type ExchangeSnapshotManifest, parseVersionedSnapshotManifest } from "../../src/backup/snapshot/memo-snapshot";
import { canonicalJson } from "../../src/primitives/json";
import { sha256OfText, utf8ByteLength } from "../../src/primitives/validation";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const HANDOFF = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";
const MEMO_1 = "55555555-5555-4555-8555-555555555551";
const MEMO_2 = "55555555-5555-4555-8555-555555555552";
const MEMO_CONTENT = "56666666-6666-4666-8666-666666666661";
const CHANNEL_1 = "66666666-6666-4666-8666-666666666661";
const CHANNEL_2 = "66666666-6666-4666-8666-666666666662";
const CHANNEL_CONTENT = "67777777-7777-4777-8777-777777777771";
const EXCHANGE = "77777777-7777-4777-8777-777777777771";
const REQ_ID = "78888888-8888-4888-8888-888888888881";
const MAT_ID = "79999999-9999-4999-8999-999999999991";
const MAT_LIVE = "79999999-9999-4999-8999-999999999992";
const EVT_1 = "88888888-8888-4888-8888-888888888881";
const EVT_2 = "88888888-8888-4888-8888-888888888882";
const EVT_3 = "88888888-8888-4888-8888-888888888883";
const EVT_4 = "88888888-8888-4888-8888-888888888884";
const EVT_5 = "88888888-8888-4888-8888-888888888885";
const EVT_6 = "88888888-8888-4888-8888-888888888886";
const TIME = "2026-11-20T00:00:00.000Z";
const TIME_2 = "2026-11-20T00:01:00.000Z";

function baseHandoffV4(): SnapshotHandoffV4 {
  return {
    id: HANDOFF,
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: "Brief",
    senderKind: "registered_project",
    senderProjectId: ALPHA,
    senderWorkspaceKey: null,
    recipientProjectId: BETA,
    currentArtifactId: ARTIFACT,
    revision: 1,
    rowVersion: 2,
    reviewState: "accepted",
    acceptedRevision: 1,
    acceptedAt: TIME_2,
    declinedAt: null,
    declineReason: null,
    withdrawnAt: null,
    consecutiveNoChangeResolutions: 0,
    firstFetchedAt: TIME_2,
    reviewEngagedAt: TIME_2,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: TIME,
    updatedAt: TIME_2,
    artifact: {
      id: ARTIFACT,
      handoffId: HANDOFF,
      storageKey: null,
      inlineBody: "inline body",
      originalName: "brief.md",
      storedName: "brief.md",
      mimeType: "text/markdown",
      sizeBytes: 11,
      sha256: sha256OfText("inline body"),
      importedFromPath: null,
      materialized: true,
      createdAt: TIME,
    },
    comment: {
      handoffId: HANDOFF,
      authorKind: "registered_project",
      authorProjectId: BETA,
      targetRevision: 1,
      body: "Looks good",
      createdAt: TIME_2,
      updatedAt: TIME_2,
      purpose: "general",
      active: false,
    },
    read: { revision: 1, status: "read", readAt: TIME_2 },
    processing: { revision: 1, status: "completed", startedAt: TIME_2, completedAt: TIME_2 },
    deletionRequests: [],
  };
}

function baseMemoInline(id = MEMO_1): SnapshotMemoV3 {
  return {
    id,
    projectId: ALPHA,
    title: "Inline Memo",
    state: "open",
    rowVersion: 1,
    createdAt: TIME,
    updatedAt: TIME,
    createdBy: { kind: "user", id: null },
    updatedBy: { kind: "user", id: null },
    closedAt: null,
    closedBy: null,
    bodyContent: { kind: "inline", text: "Memo body" },
  };
}

function baseChannel(id = CHANNEL_1, name = "ch-one"): SnapshotChannelShard {
  return {
    id,
    name,
    title: null,
    state: "open",
    main: "main",
    createdAt: TIME,
    closedAt: null,
    participants: [
      { handle: "main", role: "main", addedAt: TIME, removedAt: null },
      { handle: "worker-1", role: "worker", addedAt: TIME_2, removedAt: null },
    ],
    messages: [
      {
        seq: 1,
        senderHandle: "worker-1",
        kind: "report",
        toHandle: null,
        ref: null,
        bodyContent: { inline: "Channel report" },
        handled: false,
        handledAt: null,
        handleNote: null,
        createdAt: TIME_2,
      },
    ],
  };
}

function baseExchangeFoundation(): ExchangeSnapshotRecord {
  return {
    id: EXCHANGE,
    openingProjectId: ALPHA,
    goal: "Foundation exchange",
    criteria: ["Stay deterministic"],
    createdAt: TIME,
    members: [ALPHA, BETA],
    readRanges: [{ projectId: BETA, firstSeq: 1, lastSeq: 2 }],
    creationOutcomes: [{ projectId: ALPHA, operationId: "create-1", fingerprint: sha256OfText("create") }],
  };
}

function baseEvents(): SnapshotEvent[] {
  return [
    {
      id: EVT_1,
      handoffId: HANDOFF,
      memoId: null,
      eventType: "HANDOFF_REVISION_READ",
      actorKind: "registered_project",
      actorId: BETA,
      rowVersion: 2,
      metadata: { revision: 1, artifactId: ARTIFACT },
      createdAt: TIME_2,
    },
    {
      id: EVT_2,
      handoffId: null,
      memoId: MEMO_1,
      eventType: "MEMO_CREATED",
      actorKind: "user",
      actorId: null,
      rowVersion: 1,
      metadata: { projectId: ALPHA, memoId: MEMO_1, rowVersion: 1, toState: "open" },
      createdAt: TIME,
    },
    {
      id: EVT_3,
      handoffId: null,
      memoId: null,
      eventType: "CHANNEL_CREATED",
      actorKind: "user",
      actorId: null,
      rowVersion: null,
      metadata: { channelId: CHANNEL_1, actingHandle: "main", mainHandle: "main" },
      createdAt: TIME,
    },
    {
      id: EVT_4,
      handoffId: null,
      memoId: null,
      eventType: "CHANNEL_PARTICIPANT_ADDED",
      actorKind: "user",
      actorId: null,
      rowVersion: null,
      metadata: { channelId: CHANNEL_1, actingHandle: "main", handle: "worker-1", role: "worker" },
      createdAt: TIME_2,
    },
    {
      id: EVT_5,
      handoffId: null,
      memoId: null,
      eventType: "CHANNEL_MESSAGE_POSTED",
      actorKind: "user",
      actorId: null,
      rowVersion: null,
      metadata: { channelId: CHANNEL_1, actingHandle: "worker-1", seq: 1, kind: "report", toHandle: null },
      createdAt: TIME_2,
    },
  ];
}

function validV5Data(): SnapshotDataV5 {
  return {
    projects: [
      {
        id: ALPHA,
        slug: "alpha",
        displayName: "Alpha",
        description: null,
        status: "active",
        createdAt: TIME,
        updatedAt: TIME,
        bindings: [],
      },
      {
        id: BETA,
        slug: "beta",
        displayName: "Beta",
        description: null,
        status: "active",
        createdAt: TIME,
        updatedAt: TIME,
        bindings: [],
      },
    ],
    handoffs: [baseHandoffV4()],
    memos: [baseMemoInline()],
    channels: [baseChannel()],
    events: baseEvents(),
    exchanges: [baseExchangeFoundation()],
    exchangeRepresentation: "foundation",
  };
}

function validV5Manifest(data: SnapshotDataV5): ExchangeSnapshotManifest {
  const built = snapshotFilesV5(data);
  if (!built.ok) throw new Error(`Expected valid fixture: ${built.error.code}: ${built.error.message}`);
  return built.value.manifest;
}

function runExportThroughUseCase(data: SnapshotDataV5) {
  let written: SnapshotFile[] = [];
  const result = exportSnapshot({
    vaultPath: "/virtual/vault",
    redactWorkspacePaths: false,
    readSnapshotData: () => ok(data),
    writeSnapshotTree: (files) => {
      written = files;
      return ok(undefined);
    },
  });
  return { result, written };
}

function mustAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing fixture item at index ${String(index)}`);
  return item;
}

describe("validateSnapshot first-error code, message, and stage precedence", () => {
  it("prioritizes V5 missing exchanges over V4 handoff and manifest count defects", () => {
    const data = validV5Data();
    const manifest = validV5Manifest(data);
    const { exchanges: _missing, ...withoutExchanges } = data;
    const broken = {
      ...withoutExchanges,
      handoffs: [{ ...baseHandoffV4(), reviewNote: null }],
    } as unknown as SnapshotDataV5;
    const res = validateSnapshot(broken, { ...manifest, counts: { ...manifest.counts, projects: 99 } });
    expect(res).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "A format-5 snapshot must provide an Exchange inventory." },
    });
  });

  it("prioritizes Exchange inventory errors over V4 handoff, reporting, memo, channel, and count defects", () => {
    const data = validV5Data();
    const manifest = validV5Manifest(data);
    const brokenHandoff = { ...baseHandoffV4(), reviewNote: null } as unknown as SnapshotHandoffV4;
    const cases: Array<{
      label: string;
      patch: Partial<SnapshotDataV5>;
      manifestPatch?: Partial<ExchangeSnapshotManifest>;
      message: string;
    }> = [
      {
        label: "exchange count mismatch",
        patch: { handoffs: [brokenHandoff] },
        manifestPatch: { counts: { ...manifest.counts, exchanges: 2 } },
        message: "The manifest's Exchange count disagrees with its retained inventory.",
      },
      {
        label: "invalid foundation fields",
        patch: {
          handoffs: [brokenHandoff],
          exchanges: [{ ...baseExchangeFoundation(), goal: "" }],
        },
        message: "An Exchange foundation record has invalid fields.",
      },
      {
        label: "representation mismatch",
        patch: {
          handoffs: [brokenHandoff],
          exchangeRepresentation: "collaboration",
        },
        message: "An Exchange collaboration record has invalid fields or associations.",
      },
      {
        label: "duplicate exchange ID",
        patch: {
          handoffs: [brokenHandoff],
          exchanges: [baseExchangeFoundation(), baseExchangeFoundation()],
        },
        manifestPatch: { counts: { ...manifest.counts, exchanges: 2 } },
        message: "The Exchange inventory repeats an Exchange identity.",
      },
      {
        label: "missing member project",
        patch: {
          handoffs: [brokenHandoff],
          exchanges: [{ ...baseExchangeFoundation(), members: [ALPHA, "ffffffff-ffff-4fff-8fff-ffffffffffff"] }],
        },
        message: "An Exchange member is repeated or does not identify an exported Project.",
      },
      {
        label: "overlapping read ranges",
        patch: {
          handoffs: [brokenHandoff],
          exchanges: [
            {
              ...baseExchangeFoundation(),
              readRanges: [
                { projectId: BETA, firstSeq: 1, lastSeq: 3 },
                { projectId: BETA, firstSeq: 3, lastSeq: 5 },
              ],
            },
          ],
        },
        message: "Exchange read ranges must be disjoint, with gaps preserved.",
      },
      {
        label: "duplicate creation outcome",
        patch: {
          handoffs: [brokenHandoff],
          exchanges: [
            {
              ...baseExchangeFoundation(),
              creationOutcomes: [
                { projectId: ALPHA, operationId: "dup-op", fingerprint: sha256OfText("a") },
                { projectId: ALPHA, operationId: "dup-op", fingerprint: sha256OfText("b") },
              ],
            },
          ],
        },
        message: "The Exchange inventory repeats a creation operation identity.",
      },
    ];
    for (const item of cases) {
      const result = validateSnapshot({ ...data, ...item.patch }, { ...manifest, ...item.manifestPatch });
      expect(result, item.label).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR", message: item.message },
      });
    }
  });

  it("rejects exchanges in legacy formats before all other checks", () => {
    const data = validV5Data();
    const manifest = validV5Manifest(data);
    const { exchanges: _exCount, ...v4Counts } = manifest.counts;
    const res = validateSnapshot(data, { ...manifest, formatVersion: 4, counts: v4Counts });
    expect(res).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "A legacy snapshot cannot contain Exchange records." },
    });
  });

  it("pins exact V4 -> V3 -> Memo -> Channel -> Project -> Handoff -> Event -> Counts stage precedence", () => {
    const base = validV5Data();
    const manifest = validV5Manifest(base);
    const firstEvent = mustAt(baseEvents(), 0);
    const project0 = mustAt(base.projects, 0);
    const project1 = mustAt(base.projects, 1);

    // 1. V4 Handoff shape beats reporting event missing-handoff and counts.
    const badHandoffAndEvent: SnapshotDataV5 = {
      ...base,
      handoffs: [{ ...baseHandoffV4(), reviewNote: null } as unknown as SnapshotHandoffV4],
      events: [{ ...firstEvent, handoffId: "99999999-9999-4999-8999-999999999999" }, ...baseEvents().slice(1)],
    };
    expect(validateSnapshot(badHandoffAndEvent, manifest)).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_INTEGRITY_ERROR",
        message: "Format-4 Handoff must carry one comment and reporting fields, not reviewNote",
      },
    });

    // 2. Reporting event missing Handoff beats Memo content and Channel defects.
    const badReportingAndChannel: SnapshotDataV5 = {
      ...base,
      events: [{ ...firstEvent, handoffId: "99999999-9999-4999-8999-999999999999" }, ...baseEvents().slice(1)],
      channels: [],
    };
    expect(validateSnapshot(badReportingAndChannel, manifest)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Format-4 reporting event association is invalid" },
    });

    // 3. Memo content defect beats Channel count mismatch.
    const missingMemoContent: SnapshotDataV5 = {
      ...base,
      memos: [
        {
          ...baseMemoInline(MEMO_1),
          bodyContent: {
            kind: "file-backed",
            contentPath: `content/memo/${MEMO_1}/${MEMO_CONTENT}`,
            sizeBytes: 10,
            sha256: sha256OfText("0123456789"),
          },
        },
      ],
      channels: [],
    };
    expect(validateSnapshot(missingMemoContent, manifest)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Memo snapshot content bytes are missing or invalid" },
    });

    // 4. Channel content (count / duplicate ID / duplicate name) beats Channel history & Project duplicate.
    const dupChannelName: SnapshotDataV5 = {
      ...base,
      channels: [baseChannel(CHANNEL_1, "dup-name"), baseChannel(CHANNEL_2, "dup-name")],
      projects: [project0, project1, project0],
    };
    expect(
      validateSnapshot(dupChannelName, { ...manifest, counts: { ...manifest.counts, channels: 2 } }),
    ).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "The snapshot repeats a Channel name" },
    });

    // 5. Channel history (missing CHANNEL_CREATED) beats Project duplicate ID/slug.
    const missingChannelCreated: SnapshotDataV5 = {
      ...base,
      events: baseEvents().filter((e) => e.eventType !== "CHANNEL_CREATED"),
      projects: [project0, project1, project0],
    };
    expect(validateSnapshot(missingChannelCreated, manifest)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "A Channel's creation event is missing" },
    });

    // 6. Project V3 duplicate ID/slug beats Memo inventory duplicate event ID.
    const dupProjectAndEvent: SnapshotDataV5 = {
      ...base,
      projects: [project0, project1, { ...project0, slug: "ALPHA" }],
      events: [...baseEvents(), { ...firstEvent }],
    };
    expect(validateSnapshot(dupProjectAndEvent, manifest)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "The format-3 snapshot repeats a Project identity or slug." },
    });

    // 7. Memo inventory duplicate event ID beats Handoff missing recipientProjectId.
    const dupEventAndMissingRecipient: SnapshotDataV5 = {
      ...base,
      handoffs: [{ ...baseHandoffV4(), recipientProjectId: "99999999-9999-4999-8999-999999999999", comment: null }],
      events: [
        ...baseEvents().filter((e) => e.handoffId === null),
        {
          id: EVT_3,
          handoffId: null,
          memoId: null,
          eventType: "VAULT_MOVED",
          actorKind: "user",
          actorId: null,
          rowVersion: null,
          metadata: {},
          createdAt: TIME_2,
        },
      ],
    };
    expect(validateSnapshot(dupEventAndMissingRecipient, manifest)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Duplicate snapshot event ID" },
    });

    // 8. Handoff missing recipientProjectId beats ledger event missing handoffId.
    const missingProjectId = "99999999-9999-4999-8999-999999999999";
    const missingHandoffId = "99999999-9999-4999-8999-999999999998";
    const missingRecipientAndEventHandoff: SnapshotDataV5 = {
      ...base,
      handoffs: [{ ...baseHandoffV4(), recipientProjectId: missingProjectId, comment: null }],
      events: [
        ...baseEvents().filter((e) => e.handoffId === null),
        {
          id: EVT_6,
          handoffId: missingHandoffId,
          memoId: null,
          eventType: "HANDOFF_CREATED",
          actorKind: "user",
          actorId: null,
          rowVersion: 1,
          metadata: {},
          createdAt: TIME_2,
        },
      ],
    };
    expect(validateSnapshot(missingRecipientAndEventHandoff, manifest)).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_INTEGRITY_ERROR",
        message: `Handoff ${HANDOFF} names recipient project ${missingProjectId}, which the snapshot does not contain.`,
      },
    });

    // 9. Ledger event missing handoffId beats manifest count mismatch.
    const missingEventHandoff: SnapshotDataV5 = {
      ...base,
      events: [
        ...baseEvents().filter((e) => e.handoffId === null),
        {
          id: EVT_6,
          handoffId: missingHandoffId,
          memoId: null,
          eventType: "HANDOFF_CREATED",
          actorKind: "user",
          actorId: null,
          rowVersion: 1,
          metadata: {},
          createdAt: TIME_2,
        },
      ],
    };
    expect(
      validateSnapshot(missingEventHandoff, { ...manifest, counts: { ...manifest.counts, events: 99 } }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_INTEGRITY_ERROR",
        message: `Ledger event ${EVT_6} names handoff ${missingHandoffId}, which the snapshot does not contain.`,
      },
    });

    // 10. Final manifest counts mismatch fires when all earlier checks pass.
    const countMismatch = validateSnapshot(base, { ...manifest, counts: { ...manifest.counts, projects: 99 } });
    expect(countMismatch.ok).toBe(false);
    if (!countMismatch.ok) {
      expect(countMismatch.error.code).toBe("VAULT_INTEGRITY_ERROR");
      expect(countMismatch.error.message).toContain("The backup manifest counts do not match the snapshot content:");
    }
  });
});

describe("pre-refactor multi-defect snapshotFilesV5 and exportSnapshot first-error precedence (D3)", () => {
  it("pins exact interleaved export error ordering identically across snapshotFilesV5 and exportSnapshot", () => {
    const base = validV5Data();
    const invalidChannel: SnapshotChannelShard = { ...baseChannel(), name: "" };
    const invalidChannelContent = { channelId: CHANNEL_1, contentId: CHANNEL_CONTENT, bytes: Buffer.from("\0bad") };
    const badHandoff = { ...baseHandoffV4(), reviewNote: null } as unknown as SnapshotHandoffV4;
    const badReportingEvent: SnapshotEvent = {
      ...mustAt(baseEvents(), 0),
      handoffId: "99999999-9999-4999-8999-999999999999",
    };

    const assertBothFailWith = (label: string, candidate: SnapshotDataV5, expectedMessage: string) => {
      const direct = snapshotFilesV5(candidate);
      const viaExport = runExportThroughUseCase(candidate).result;
      expect(direct, `snapshotFilesV5: ${label}`).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR", message: expectedMessage },
      });
      expect(viaExport, `exportSnapshot: ${label}`).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR", message: expectedMessage },
      });
    };

    // 1. Exchange > Handoff V4 > Reporting > Memo > Channel.
    assertBothFailWith(
      "exchange beats handoff V4",
      {
        ...base,
        exchanges: [{ ...baseExchangeFoundation(), goal: "" }],
        handoffs: [badHandoff],
        channels: [invalidChannel],
      },
      "An Exchange foundation record has invalid fields.",
    );

    // 2. Handoff V4 > Reporting event > Memo > Channel.
    assertBothFailWith(
      "handoff V4 beats reporting event",
      {
        ...base,
        handoffs: [badHandoff],
        events: [badReportingEvent, ...baseEvents().slice(1)],
        channels: [invalidChannel],
      },
      "Format-4 Handoff must carry one comment and reporting fields, not reviewNote",
    );

    // 3. Reporting event > Memo content > Channel.
    assertBothFailWith(
      "reporting event beats memo content and channel",
      {
        ...base,
        events: [badReportingEvent, ...baseEvents().slice(1)],
        memos: [baseMemoInline(MEMO_1), baseMemoInline(MEMO_1)],
        channels: [invalidChannel],
      },
      "Format-4 reporting event association is invalid",
    );

    // 4. Memo content validation > Duplicate inline Memo ID > Channel.
    assertBothFailWith(
      "memo content beats duplicate memo ID and channel",
      {
        ...base,
        memos: [
          {
            ...baseMemoInline(MEMO_1),
            bodyContent: {
              kind: "file-backed",
              contentPath: `content/memo/${MEMO_1}/${MEMO_CONTENT}`,
              sizeBytes: 4,
              sha256: sha256OfText("body"),
            },
          },
          baseMemoInline(MEMO_1),
        ],
        channels: [invalidChannel],
      },
      "Memo snapshot content bytes are missing or invalid",
    );

    // 5. CRITICAL (D3): Duplicate inline Memo ID fires BEFORE Channel content & Channel shard validation!
    assertBothFailWith(
      "duplicate inline Memo ID beats channel content and channel shard defects",
      {
        ...base,
        memos: [baseMemoInline(MEMO_1), baseMemoInline(MEMO_1)],
        channelContentFiles: [invalidChannelContent],
        channels: [invalidChannel],
      },
      "Duplicate Memo snapshot ID",
    );

    // 6. Channel content proof fires BEFORE Channel shard validation.
    assertBothFailWith(
      "channel content proof beats channel shard validation",
      {
        ...base,
        channelContentFiles: [invalidChannelContent],
        channels: [invalidChannel],
      },
      "A Channel message body carries a NUL byte",
    );

    // 7. Channel shard validation fires BEFORE cross-family orphan content check.
    const validExtraChannelBytes = Buffer.from("orphan channel content", "utf8");
    assertBothFailWith(
      "channel shard validation beats orphan content check",
      {
        ...base,
        channelContentFiles: [{ channelId: CHANNEL_1, contentId: CHANNEL_CONTENT, bytes: validExtraChannelBytes }],
        channels: [invalidChannel],
      },
      "A Channel shard name is outside the recorded name rules",
    );

    // 8. Cross-family orphan content file fires when shards are valid.
    assertBothFailWith(
      "orphan carried channel content file",
      {
        ...base,
        channelContentFiles: [{ channelId: CHANNEL_1, contentId: CHANNEL_CONTENT, bytes: validExtraChannelBytes }],
      },
      "The export carries a content file no shard names",
    );
  });
});

describe("Exchange representation rules (D1) and manifest/framing duplicate JSON keys", () => {
  it("enforces collaboration boundaries and supports material-register without registrationAfterSeq plus lifecycle", () => {
    const base = validV5Data();
    const reportBody = "Report body";
    const baseCollab = {
      lastSeq: 2,
      messages: [
        {
          seq: 1,
          senderId: ALPHA,
          recipientId: BETA,
          kind: "request" as const,
          replyTo: null,
          materialId: null,
          requestId: REQ_ID,
          reportVersion: null,
          createdAt: TIME,
        },
        {
          seq: 2,
          senderId: BETA,
          recipientId: ALPHA,
          kind: "report" as const,
          replyTo: 1,
          materialId: MAT_ID,
          requestId: REQ_ID,
          reportVersion: 1,
          createdAt: TIME_2,
        },
      ],
      requests: [
        {
          id: REQ_ID,
          requesterId: ALPHA,
          assigneeId: BETA,
          assignmentVersion: 1,
          condition: "Deliver report",
          criteria: ["Deterministic"],
        },
      ],
      reports: [
        {
          requestId: REQ_ID,
          version: 1,
          assignmentVersion: 1,
          authorId: BETA,
          materialId: MAT_ID,
          evidence: [MAT_LIVE],
        },
      ],
      acceptances: [],
      materials: [
        {
          id: MAT_ID,
          ownerProjectId: BETA,
          kind: "body" as const,
          sizeBytes: utf8ByteLength(reportBody),
          sha256: sha256OfText(reportBody),
          scope: null,
        },
        {
          id: MAT_LIVE,
          ownerProjectId: ALPHA,
          kind: "live" as const,
          sizeBytes: null,
          sha256: null,
          scope: { offset: 0, length: null, root: "/workspace/alpha", relativePath: "src/main.ts" },
        },
      ],
      operations: [
        {
          projectId: ALPHA,
          operationId: "op-req",
          fingerprint: sha256OfText("req"),
          outcome: { kind: "request" as const, exchangeId: EXCHANGE, seq: 1, requestId: REQ_ID, assignmentVersion: 1 },
        },
        {
          projectId: ALPHA,
          operationId: "op-mat",
          fingerprint: sha256OfText("mat"),
          outcome: { kind: "material-register" as const, exchangeId: EXCHANGE, materialId: MAT_LIVE },
        },
        {
          projectId: BETA,
          operationId: "op-rep",
          fingerprint: sha256OfText("rep"),
          outcome: {
            kind: "report" as const,
            exchangeId: EXCHANGE,
            seq: 2,
            requestId: REQ_ID,
            reportVersion: 1,
            materialId: MAT_ID,
          },
        },
      ],
    };

    const collabRecord: ExchangeSnapshotRecord = {
      ...baseExchangeFoundation(),
      readRanges: [{ projectId: BETA, firstSeq: 1, lastSeq: 2 }],
      collaboration: baseCollab,
    };

    // Legal literal collaboration with material-register (no registrationAfterSeq).
    const collabOk = snapshotFilesV5({
      ...base,
      exchanges: [collabRecord],
      exchangeRepresentation: "collaboration",
    });
    expect(collabOk.ok).toBe(true);

    // Literal collaboration rejects registrationAfterSeq, lifecycle, notices, and vote receipts.
    const withRegAfterSeq: ExchangeSnapshotRecord = {
      ...collabRecord,
      collaboration: {
        ...baseCollab,
        operations: baseCollab.operations.map((op) =>
          op.outcome.kind === "material-register" ? { ...op, registrationAfterSeq: 1 } : op,
        ),
      },
    };
    expect(
      snapshotFilesV5({ ...base, exchanges: [withRegAfterSeq], exchangeRepresentation: "collaboration" }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_INTEGRITY_ERROR",
        message: "An Exchange collaboration record has invalid fields or associations.",
      },
    });

    // Legal 4th wire value: "lifecycle" (collaboration + lifecycle, with registrationAfterSeq, no notices).
    const lifecycleRecord: ExchangeSnapshotRecord = {
      ...withRegAfterSeq,
      lifecycle: { initialMembers: [ALPHA, BETA], workRevision: 4, transitions: [] },
    };
    const lifecycleBuilt = snapshotFilesV5({
      ...base,
      exchanges: [lifecycleRecord],
      exchangeRepresentation: "lifecycle",
    });
    expect(lifecycleBuilt.ok).toBe(true);
    if (lifecycleBuilt.ok) {
      const exchangeFile = lifecycleBuilt.value.files.find((f) => f.path === EXCHANGE_SNAPSHOT_FILE);
      expect(exchangeFile).toBeDefined();
      expect(parseExchangeSnapshot(String(exchangeFile?.content), base.projects, 1).ok).toBe(true);
      expect(
        validateSnapshot(
          { ...base, exchanges: [lifecycleRecord], exchangeRepresentation: "lifecycle" },
          lifecycleBuilt.value.manifest,
        ).ok,
      ).toBe(true);
    }

    // Passing lifecycleRecord under literal "collaboration" fails closed.
    expect(
      snapshotFilesV5({ ...base, exchanges: [lifecycleRecord], exchangeRepresentation: "collaboration" }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "VAULT_INTEGRITY_ERROR",
        message: "An Exchange collaboration record has invalid fields or associations.",
      },
    });
  });

  it("pins duplicate JSON keys and unsupported schema precedence in manifest and Exchange framing", () => {
    const base = validV5Data();
    const manifest = validV5Manifest(base);
    const rawManifest = canonicalJson(manifest);
    const dupManifest = rawManifest.replace('"formatVersion": 5,', '"formatVersion": 5, "formatVersion": 5,');
    expect(parseVersionedSnapshotManifest(dupManifest)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Snapshot contains duplicate JSON keys" },
    });
    expect(parseVersionedSnapshotManifest('{"formatVersion":6}')).toMatchObject({
      ok: false,
      error: { code: "VAULT_SCHEMA_UNSUPPORTED", message: "Snapshot format is not supported" },
    });

    const built = snapshotFilesV5(base);
    if (!built.ok) throw new Error(built.error.message);
    const rawExchanges = String(built.value.files.find((f) => f.path === EXCHANGE_SNAPSHOT_FILE)?.content);
    expect(
      openExchangeSnapshot(rawExchanges.replace('"representation": "foundation"', '"representation": "future-v9"'), 1),
    ).toMatchObject({
      ok: false,
      error: { code: "VAULT_SCHEMA_UNSUPPORTED", message: "This Exchange snapshot representation is not supported." },
    });
    expect(openExchangeSnapshot(rawExchanges.replace('"goal":', '"goal": "dup", "goal":'), 1)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR", message: "Snapshot contains duplicate JSON keys" },
    });
  });

  it("sanity-checks unused helper types stay aligned with SnapshotData/SnapshotDataV3", () => {
    const emptyV1: SnapshotData = { projects: [], handoffs: [], events: [] };
    const emptyV3: SnapshotDataV3 = { projects: [], handoffs: [], events: [] };
    expect(createHash("sha256").update(canonicalJson(emptyV1)).digest("hex")).toBe(
      createHash("sha256").update(canonicalJson(emptyV3)).digest("hex"),
    );
    expect(MEMO_2).not.toBe(MEMO_1);
  });
});
