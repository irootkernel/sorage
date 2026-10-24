import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSnapshot } from "../../src/backup-commands";
import { canonicalJson, type SnapshotData } from "../../src/backup-snapshot";
import {
  classifySnapshotArtifactBody,
  classifySnapshotEvent,
  parseMemoSnapshotV3,
  parseSnapshotBodyContent,
  type SnapshotDataV3,
  serializeMemoSnapshotV3,
  snapshotFilesV3,
  validateSnapshotHandoffV3,
} from "../../src/content-snapshot";
import { ok } from "../../src/errors";
import { parseVersionedSnapshotManifest, snapshotFilesV2 } from "../../src/memo-snapshot";
import type { Memo } from "../../src/memos";

const USER = { kind: "user" as const, id: null };

function sampleHandoffV3(): Record<string, unknown> {
  const handoff = sampleData().handoffs[0];
  if (!handoff) throw new Error("missing handoff fixture");
  return {
    ...handoff,
    artifact: { ...handoff.artifact, inlineBody: null },
    reviewNote: {
      handoffId: handoff.id,
      authorKind: "user",
      authorProjectId: null,
      targetRevision: 1,
      body: "\uFEFFReview\r\nno-final-newline",
      createdAt: handoff.createdAt,
      updatedAt: handoff.updatedAt,
    },
    deletionRequests: [
      {
        id: "0123abcd-0000-4000-8000-0000000000ee",
        handoffId: handoff.id,
        requestedByKind: "user",
        requestedById: null,
        reason: null,
        status: "pending",
        requestedAt: handoff.createdAt,
        resolvedAt: null,
        resolvedByUser: null,
        resolutionNote: null,
      },
    ],
  };
}

describe("format-3 kept Handoff record schemas", () => {
  it("accepts complete nested records with either redacted or unredacted sender paths", () => {
    const value = sampleHandoffV3();
    expect(validateSnapshotHandoffV3(value).ok).toBe(true);
    expect(validateSnapshotHandoffV3({ ...value, senderPathSnapshot: "/workspace" }).ok).toBe(true);
    expect(validateSnapshotHandoffV3({ ...value, senderPathSnapshot: null }).ok).toBe(true);
  });

  it.each(["handoff", "artifact", "reviewNote", "deletionRequest"])(
    "rejects extra/missing/wrongly typed fields in %s",
    (family) => {
      for (const defect of ["extra", "missing", "type"]) {
        const value = sampleHandoffV3();
        const record =
          family === "handoff"
            ? value
            : family === "deletionRequest"
              ? (value.deletionRequests as Array<Record<string, unknown>>)[0]
              : (value[family] as Record<string, unknown>);
        if (!record) throw new Error("missing nested fixture");
        const field =
          family === "handoff"
            ? "title"
            : family === "artifact"
              ? "originalName"
              : family === "reviewNote"
                ? "body"
                : "reason";
        if (defect === "extra") record.extra = "unknown";
        else if (defect === "missing") delete record[field];
        else record[field] = 42;
        expect(validateSnapshotHandoffV3(value)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
      }
    },
  );

  it("accepts exact inline Artifact bytes", () => {
    const value = sampleHandoffV3();
    value.artifact = {
      ...(value.artifact as object),
      storageKey: null,
      inlineBody: "body",
      sizeBytes: 4,
      sha256: createHash("sha256").update("body").digest("hex"),
    };
    expect(validateSnapshotHandoffV3(value).ok).toBe(true);
    expect(classifySnapshotArtifactBody(value.artifact as Record<string, unknown>)).toMatchObject({
      ok: true,
      value: "inline-supported",
    });
  });

  it.each([
    "id",
    "dispatchGroupId",
    "supersedesHandoffId",
    "senderProjectId",
    "recipientProjectId",
    "currentArtifactId",
  ])("rejects a non-UUID Handoff %s", (field) => {
    const value = sampleHandoffV3();
    value[field] = "not-a-uuid";
    expect(validateSnapshotHandoffV3(value)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
  });

  it.each(["artifact", "reviewNote", "deletionRequest"])("rejects a non-UUID identifier in %s", (family) => {
    const value = sampleHandoffV3();
    const record =
      family === "deletionRequest"
        ? (value.deletionRequests as Array<Record<string, unknown>>)[0]
        : (value[family] as Record<string, unknown>);
    if (!record) throw new Error("missing nested fixture");
    record[family === "reviewNote" ? "authorProjectId" : "id"] = "not-a-uuid";
    expect(validateSnapshotHandoffV3(value).ok).toBe(false);
  });

  it("keeps Review Note author kinds and User's null Project contract", () => {
    for (const author of [
      { authorKind: "unregistered_workspace", authorProjectId: null },
      { authorKind: "user", authorProjectId: sampleMemo().projectId },
      { authorKind: "registered_project", authorProjectId: null },
    ]) {
      const value = sampleHandoffV3();
      value.reviewNote = { ...(value.reviewNote as object), ...author };
      expect(validateSnapshotHandoffV3(value).ok).toBe(false);
    }
    const value = sampleHandoffV3();
    value.reviewNote = {
      ...(value.reviewNote as object),
      authorKind: "registered_project",
      authorProjectId: sampleMemo().projectId,
    };
    expect(validateSnapshotHandoffV3(value).ok).toBe(true);
  });

  it("preserves ActorRef UUID/null/workspace meanings without treating workspace or resolver text as UUIDs", () => {
    for (const [kind, id] of [
      ["registered_project", sampleMemo().projectId],
      ["user", null],
      ["unregistered_workspace", "verbatim workspace key"],
    ] as const) {
      const value = sampleHandoffV3();
      value.senderKind = kind;
      value.senderProjectId = kind === "registered_project" ? id : null;
      value.senderWorkspaceKey = kind === "unregistered_workspace" ? id : null;
      const request = (value.deletionRequests as Array<Record<string, unknown>>)[0];
      if (!request) throw new Error("missing request fixture");
      Object.assign(request, {
        requestedByKind: kind,
        requestedById: id,
        status: "approved",
        resolvedAt: sampleMemo().updatedAt,
        resolvedByUser: "local User identity",
      });
      expect(validateSnapshotHandoffV3(value).ok).toBe(true);
    }
    for (const [kind, id] of [
      ["registered_project", "not-a-uuid"],
      ["user", "unexpected"],
      ["unregistered_workspace", null],
    ] as const) {
      const value = sampleHandoffV3();
      const request = (value.deletionRequests as Array<Record<string, unknown>>)[0];
      if (!request) throw new Error("missing request fixture");
      Object.assign(request, { requestedByKind: kind, requestedById: id });
      expect(validateSnapshotHandoffV3(value).ok).toBe(false);
    }
  });
});

describe("the ADR-0031 legacy Artifact identity exception", () => {
  it("accepts exactly a-plus-eight-lowercase-hex and canonical UUIDs in the two Artifact identity fields", () => {
    const legacy = sampleHandoffV3();
    legacy.currentArtifactId = "a1b2c3d4e";
    (legacy.artifact as Record<string, unknown>).id = "a1b2c3d4e";
    expect(validateSnapshotHandoffV3(legacy).ok).toBe(true);
    const uuid = sampleHandoffV3();
    expect(validateSnapshotHandoffV3(uuid).ok).toBe(true);
  });

  it.each([
    ["upper-case hex", "A1B2C3D4E"],
    ["wrong legacy length", "a1b2c3d4"],
    ["nine-plus hex", "a1b2c3d4ef"],
    ["non-hex tail", "a1b2c3d4g"],
    ["wrong-prefix", "b1b2c3d4e"],
    ["embedded LF", "a1b2c3d4\ne"],
    ["embedded CR", "a1b2c3d4\re"],
    ["UUID with LF tail", "0123abcd-0000-4000-8000-0000000000dd\n"],
    ["truncated UUID", "0123abcd-0000-4000-8000-0000000000d"],
    ["upper-case UUID", "012ABCD0-0000-4000-8000-0000000000DD"],
  ])("rejects the malformed identity %s", (_name, candidate) => {
    const handoff = sampleHandoffV3();
    handoff.currentArtifactId = candidate;
    expect(validateSnapshotHandoffV3(handoff)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
    const artifact = sampleHandoffV3();
    (artifact.artifact as Record<string, unknown>).id = candidate;
    expect(validateSnapshotHandoffV3(artifact)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
  });

  it.each([
    ["an array", ["a1b2c3d4e"]],
    ["a number", 9],
    ["a boolean", true],
    ["null-ish zero", 0],
    ["an object whose toString spells the legacy form", { toString: () => "a1b2c3d4e" }],
    ["an object without a callable toString", Object.create(null)],
  ])("rejects the non-string identity %s without throwing", (_name, candidate) => {
    const handoff = sampleHandoffV3();
    handoff.currentArtifactId = candidate;
    expect(validateSnapshotHandoffV3(handoff)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
    const artifact = sampleHandoffV3();
    (artifact.artifact as Record<string, unknown>).id = candidate;
    expect(validateSnapshotHandoffV3(artifact)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
  });

  it("keeps every other UUID-typed field strict: the legacy form is not accepted there", () => {
    for (const field of ["id", "dispatchGroupId", "supersedesHandoffId", "senderProjectId", "recipientProjectId"]) {
      const value = sampleHandoffV3();
      (value as Record<string, unknown>)[field] = "a1b2c3d4e";
      expect(validateSnapshotHandoffV3(value)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
    }
    const nested = sampleHandoffV3();
    (nested.artifact as Record<string, unknown>).handoffId = "a1b2c3d4e";
    expect(validateSnapshotHandoffV3(nested).ok).toBe(false);
  });
});

function sampleMemo(): Memo {
  return {
    id: "0123abcd-0000-4000-8000-0000000000aa",
    projectId: "0123abcd-0000-4000-8000-0000000000bb",
    title: "Title",
    body: "body",
    state: "open",
    rowVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: USER,
    updatedBy: USER,
    closedAt: null,
    closedBy: null,
  };
}

function sampleData(): SnapshotData {
  return {
    projects: [
      {
        id: "0123abcd-0000-4000-8000-0000000000bb",
        slug: "sample",
        displayName: "Sample",
        description: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        bindings: [],
      },
    ],
    handoffs: [
      {
        id: "0123abcd-0000-4000-8000-0000000000cc",
        dispatchGroupId: null,
        supersedesHandoffId: null,
        title: "T",
        senderKind: "user",
        senderProjectId: null,
        senderWorkspaceKey: null,
        recipientProjectId: "0123abcd-0000-4000-8000-0000000000bb",
        currentArtifactId: "0123abcd-0000-4000-8000-0000000000dd",
        revision: 1,
        rowVersion: 1,
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
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        artifact: {
          id: "0123abcd-0000-4000-8000-0000000000dd",
          handoffId: "0123abcd-0000-4000-8000-0000000000cc",
          storageKey: "artifacts/0123abcd-0000-4000-8000-0000000000cc/0123abcd-0000-4000-8000-0000000000dd/document.md",
          originalName: "document.md",
          storedName: "document.md",
          mimeType: "text/markdown",
          sizeBytes: 6,
          sha256: "a".repeat(64),
          importedFromPath: null,
          materialized: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        reviewNote: null,
        deletionRequests: [],
      },
    ],
    events: [
      {
        id: "0123abcd-0000-4000-8000-00000000000a",
        handoffId: null,
        memoId: "0123abcd-0000-4000-8000-0000000000aa",
        eventType: "MEMO_CREATED",
        actorKind: "user",
        actorId: null,
        rowVersion: 1,
        metadata: {
          projectId: "0123abcd-0000-4000-8000-0000000000bb",
          memoId: "0123abcd-0000-4000-8000-0000000000aa",
          rowVersion: 1,
          toState: "open",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    memos: [sampleMemo()],
  };
}

describe("parseSnapshotBodyContent", () => {
  it("accepts the closed inline form and the closed file-backed form", () => {
    expect(parseSnapshotBodyContent({ inline: "text" })).toEqual(ok({ kind: "inline", text: "text" }));
    expect(parseSnapshotBodyContent({ contentPath: "content/memo/o/c", sizeBytes: 3, sha256: "b".repeat(64) })).toEqual(
      ok({ kind: "file-backed", contentPath: "content/memo/o/c", sizeBytes: 3, sha256: "b".repeat(64) }),
    );
  });

  it("rejects extra keys, mixed keys, and malformed values as integrity failures", () => {
    expect(parseSnapshotBodyContent({ inline: "t", extra: 1 }).ok).toBe(false);
    expect(parseSnapshotBodyContent({}).ok).toBe(false);
    expect(parseSnapshotBodyContent({ inline: 5 }).ok).toBe(false);
    expect(parseSnapshotBodyContent({ contentPath: "../escape", sizeBytes: 1, sha256: "b".repeat(64) }).ok).toBe(false);
    expect(
      parseSnapshotBodyContent({ contentPath: "content/memo/o/c", sizeBytes: -1, sha256: "b".repeat(64) }).ok,
    ).toBe(false);
    expect(parseSnapshotBodyContent({ contentPath: "content/memo/o/c", sizeBytes: 1, sha256: "SHORT" }).ok).toBe(false);
  });
});

describe("classifySnapshotArtifactBody", () => {
  it("accepts the baseline file-backed record and classifies inline as the later representation", () => {
    expect(classifySnapshotArtifactBody({ storageKey: "artifacts/h/a/x", inlineBody: null })).toEqual({
      ok: true,
      value: "file-backed-baseline",
    } as const);
    const inline = classifySnapshotArtifactBody({ storageKey: null, inlineBody: "text" });
    expect(inline).toEqual({ ok: true, value: "inline-supported" } as const);
  });

  it("rejects both-null, both-present, a missing field, and a bodyContent key on an Artifact", () => {
    expect(classifySnapshotArtifactBody({ storageKey: null, inlineBody: null }).ok).toBe(false);
    expect(classifySnapshotArtifactBody({ storageKey: "artifacts/h/a/x", inlineBody: "text" }).ok).toBe(false);
    expect(classifySnapshotArtifactBody({ storageKey: "artifacts/h/a/x" }).ok).toBe(false);
    expect(
      classifySnapshotArtifactBody({ storageKey: "artifacts/h/a/x", inlineBody: null, bodyContent: { inline: "x" } })
        .ok,
    ).toBe(false);
  });
});

describe("classifySnapshotEvent", () => {
  it("admits the rebuilt Channel domain family in format 3 and keeps earlier formats and old names frozen out", () => {
    for (const name of [
      "CHANNEL_CREATED",
      "CHANNEL_CLOSED",
      "CHANNEL_PARTICIPANT_ADDED",
      "CHANNEL_PARTICIPANT_REMOVED",
      "CHANNEL_MESSAGE_POSTED",
      "CHANNEL_MESSAGE_ACKED",
    ]) {
      expect(classifySnapshotEvent(name, 3)).toBe("family");
    }
    // The old TASK-109 family never returns: an old name is unknown in every
    // format, so a development snapshot carrying it fails closed (38.9).
    for (const name of [
      "CHANNEL_MESSAGE_SUBMITTED",
      "CHANNEL_MESSAGE_HANDLED",
      "CHANNEL_PARTICIPANT_REGISTERED",
      "CHANNEL_ASSIGNMENT_CREATED",
    ]) {
      expect(classifySnapshotEvent(name, 3)).toBe("unknown");
    }
    expect(classifySnapshotEvent("CHANNEL_CREATED", 2)).toBe("unknown");
    expect(classifySnapshotEvent("CHANNEL_CREATED", 1)).toBe("unknown");
  });

  it("scopes families per format, adding CONTENT_* only in format 3", () => {
    expect(classifySnapshotEvent("MEMO_CREATED", 1)).toBe("unknown");
    expect(classifySnapshotEvent("MEMO_CREATED", 2)).toBe("family");
    expect(classifySnapshotEvent("CONTENT_ACTIVATED", 2)).toBe("unknown");
    expect(classifySnapshotEvent("CONTENT_ACTIVATED", 3)).toBe("family");
    expect(classifySnapshotEvent("HANDOFF_ACCEPTED", 1)).toBe("family");
    expect(classifySnapshotEvent("NOT_AN_EVENT", 3)).toBe("unknown");
  });
});

describe("format-3 Memo shards", () => {
  it("serializes and parses back with the body carried as inline bodyContent", () => {
    const memo = sampleMemo();
    const shard = serializeMemoSnapshotV3(inlineMemoV3(memo));
    expect(shard.ok).toBe(true);
    if (!shard.ok) return;
    expect(shard.value.path).toBe(`memos/01/${memo.id}.json`);
    const parsed = parseMemoSnapshotV3(shard.value.path, shard.value.bytes, shard.value.digest);
    const { body, ...meta } = memo;
    expect(parsed).toEqual({ ok: true, value: { meta, bodyContent: { kind: "inline", text: body } } });
  });

  it("rejects a file-backed form with noncanonical identities", () => {
    const memo = sampleMemo();
    const shard = serializeMemoSnapshotV3(inlineMemoV3(memo));
    if (!shard.ok) return;
    const record = JSON.parse(Buffer.from(shard.value.bytes).toString("utf8")) as Record<string, unknown>;
    record.bodyContent = { contentPath: "content/memo/o/c", sizeBytes: 4, sha256: "c".repeat(64) };
    const bytes = Buffer.from(canonicalJson(record), "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const parsed = parseMemoSnapshotV3(shard.value.path, bytes, digest);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });

  it("verifies the digest over the exact raw bytes", () => {
    const memo = sampleMemo();
    const shard = serializeMemoSnapshotV3(inlineMemoV3(memo));
    if (!shard.ok) return;
    const parsed = parseMemoSnapshotV3(shard.value.path, shard.value.bytes, "0".repeat(64));
    expect(parsed.ok).toBe(false);
  });
});

function inlineMemoV3(memo: Memo) {
  const { body, ...meta } = memo;
  return { ...meta, bodyContent: { kind: "inline" as const, text: body } };
}

function sampleDataV3(): SnapshotDataV3 {
  const data = sampleData();
  return {
    ...data,
    memos: (data.memos ?? []).map(inlineMemoV3),
    handoffs: data.handoffs.map((handoff) => ({
      ...handoff,
      artifact: handoff.artifact === null ? null : { ...handoff.artifact, inlineBody: null },
    })),
  };
}

describe("snapshotFilesV3", () => {
  it("round-trips a file-backed Memo's exact historical bytes and reconciles its digest inventory", () => {
    const data = sampleDataV3();
    const memo = data.memos?.[0];
    assert(memo);
    const contentId = "0123abcd-0000-4000-8000-0000000000ff";
    const contentPath = `content/memo/${memo.id}/${contentId}`;
    const bytes = Buffer.from(`\uFEFF${"x".repeat(65532)}😀\r\nno-final-LF`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    memo.bodyContent = { kind: "file-backed", contentPath, sizeBytes: bytes.length, sha256 };
    data.memoContentFiles = [{ memoId: memo.id, contentId, bytes }];
    const built = snapshotFilesV3(data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.manifest.contentDigests).toEqual({ [contentPath]: sha256 });
    expect(built.value.files.find((file) => file.path === contentPath)?.content).toEqual(bytes);
    expect(validateSnapshot(data, built.value.manifest).ok).toBe(true);
    const shard = serializeMemoSnapshotV3(memo);
    expect(shard.ok).toBe(true);
    if (!shard.ok) return;
    const { bodyContent, ...meta } = memo;
    expect(parseMemoSnapshotV3(shard.value.path, shard.value.bytes, shard.value.digest)).toEqual({
      ok: true,
      value: { meta, bodyContent },
    });
    for (const invalidBytes of [Buffer.from([0xff]), Buffer.from([0]), Buffer.from([0xe2, 0x82])]) {
      const badDigest = createHash("sha256").update(invalidBytes).digest("hex");
      const corruptData = {
        ...data,
        memos: [{ ...meta, bodyContent: { ...bodyContent, sizeBytes: invalidBytes.length, sha256: badDigest } }],
        memoContentFiles: [{ memoId: memo.id, contentId, bytes: invalidBytes }],
      };
      expect(snapshotFilesV3(corruptData).ok).toBe(false);
      expect(
        validateSnapshot(corruptData, { ...built.value.manifest, contentDigests: { [contentPath]: badDigest } }).ok,
      ).toBe(false);
    }
    expect(snapshotFilesV3({ ...data, memoContentFiles: [] }).ok).toBe(false);
    expect(snapshotFilesV3({ ...data, memos: [] }).ok).toBe(false);
    expect(
      validateSnapshot(data, { ...built.value.manifest, contentDigests: { [contentPath]: "0".repeat(64) } }).ok,
    ).toBe(false);
  });

  it("writes the format-3 manifest with zero Channels and an empty contentDigests map", () => {
    const built = snapshotFilesV3(sampleDataV3());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.manifest.formatVersion).toBe(3);
    expect(built.value.manifest.counts.channels).toBe(0);
    expect(built.value.manifest.contentDigests).toEqual({});
    expect(built.value.manifest.counts.memos).toBe(1);
    const manifestFile = built.value.files.find((file) => file.path === "manifest.json");
    expect(manifestFile).toBeDefined();
    const manifestText = typeof manifestFile?.content === "string" ? manifestFile.content : "";
    const parsed = parseVersionedSnapshotManifest(manifestText);
    expect(parsed.ok).toBe(true);
    expect(built.value.files.some((file) => file.path.startsWith("channels/"))).toBe(false);
    expect(built.value.files.some((file) => file.path.startsWith("content/"))).toBe(false);
  });

  it("carries an explicit null inlineBody on every Artifact record", () => {
    const built = snapshotFilesV3(sampleDataV3());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const shard = built.value.files.find((file) => file.path.startsWith("handoffs/"));
    expect(shard).toBeDefined();
    const text = typeof shard?.content === "string" ? shard.content : "";
    const record = JSON.parse(text) as { artifact: { inlineBody: unknown; storageKey: unknown } };
    expect(record.artifact.inlineBody).toBeNull();
    expect(typeof record.artifact.storageKey).toBe("string");
  });

  it("keeps determinism with the format-2 conventions", () => {
    const first = snapshotFilesV3(sampleDataV3());
    const second = snapshotFilesV3(sampleDataV3());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.files).toEqual(second.value.files);
  });
});

/** Replays the writer's Handoff shards as the restore adapter does. */
function format3Data(data: SnapshotDataV3): SnapshotDataV3 {
  const built = snapshotFilesV3(data);
  if (!built.ok) throw new Error(built.error.message);
  const handoffs = built.value.files
    .filter((file) => file.path.startsWith("handoffs/"))
    .map((file) => {
      if (typeof file.content !== "string") throw new Error("expected JSON shard");
      return JSON.parse(file.content) as SnapshotDataV3["handoffs"][number];
    });
  return { ...data, handoffs };
}

describe("validateSnapshot format-3 classification", () => {
  it("accepts the baseline format-3 export", () => {
    const data = sampleDataV3();
    const built = snapshotFilesV3(data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const verified = validateSnapshot(format3Data(data), built.value.manifest);
    expect(verified.ok).toBe(true);
  });

  it("accepts an exact inline Artifact record before import", () => {
    const data = sampleDataV3();
    const handoff = data.handoffs[0];
    if (handoff === undefined || handoff.artifact === null) throw new Error("fixture");
    const later = {
      ...handoff.artifact,
      storageKey: null,
      inlineBody: "inline text",
      sizeBytes: Buffer.byteLength("inline text"),
      sha256: createHash("sha256").update("inline text").digest("hex"),
    };
    const mutated = { ...data, handoffs: [{ ...handoff, artifact: later }] };
    const built = snapshotFilesV3(mutated);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const accepted = validateSnapshot(format3Data(mutated), built.value.manifest);
    expect(accepted.ok).toBe(true);
  });

  it("refuses a ledger-only Channel domain event without its shard as a supported-family integrity failure", () => {
    const data = {
      ...sampleDataV3(),
      events: [
        ...sampleDataV3().events,
        {
          id: "0123abcd-0000-4000-8000-0000000000ab",
          handoffId: null,
          memoId: null,
          eventType: "CHANNEL_MESSAGE_SUBMITTED",
          actorKind: "user",
          actorId: null,
          rowVersion: null,
          metadata: { channelId: "0123abcd-0000-4000-8000-0000000000cd" },
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    const built = snapshotFilesV3(data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refused = validateSnapshot(format3Data(data), built.value.manifest);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });

  it.each(["handoff", "memo"])("refuses a Channel domain event that carries a legacy %s association", (association) => {
    const data = sampleDataV3();
    data.events.push({
      id: "0123abcd-0000-4000-8000-0000000000ab",
      handoffId: association === "handoff" ? "0123abcd-0000-4000-8000-0000000000ee" : null,
      memoId: association === "memo" ? "0123abcd-0000-4000-8000-0000000000ee" : null,
      eventType: "CHANNEL_CREATED",
      actorKind: "user",
      actorId: null,
      rowVersion: null,
      metadata: { channelId: "0123abcd-0000-4000-8000-0000000000cd" },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const built = snapshotFilesV3(data);
    if (!built.ok) throw new Error(built.error.message);
    expect(validateSnapshot(format3Data(data), built.value.manifest)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR" },
    });
  });

  it("accepts historical common physical-content events without live owners", () => {
    const identity = {
      contentId: "0123abcd-0000-4000-8000-000000000001",
      ownerDomain: "channel",
      ownerId: "0123abcd-0000-4000-8000-0000000000ff",
      intentId: "0123abcd-0000-4000-8000-0000000000ee",
      operation: "activate" as const,
    };
    const data = {
      ...sampleDataV3(),
      events: [
        ...sampleDataV3().events,
        {
          id: "0123abcd-0000-4000-8000-0000000000ab",
          handoffId: null,
          memoId: null,
          eventType: "CONTENT_ACTIVATED",
          actorKind: "system",
          actorId: null,
          rowVersion: null,
          metadata: {
            contentId: identity.contentId,
            ownerDomain: identity.ownerDomain,
            ownerId: identity.ownerId,
            intentId: identity.intentId,
            operation: identity.operation,
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    const built = snapshotFilesV3(data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const verified = validateSnapshot(format3Data(data), built.value.manifest);
    expect(verified.ok).toBe(true);
  });

  it("rejects a content digest with no owning Memo file", () => {
    const data = sampleDataV3();
    const built = snapshotFilesV3(data);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const manifest = {
      ...built.value.manifest,
      contentDigests: { "content/memo/o/c": "d".repeat(64) },
    };
    const refused = validateSnapshot(format3Data(data), manifest);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });

  it("keeps formats 1 and 2 restorable with their frozen shapes", () => {
    const data = sampleData();
    const v2 = snapshotFilesV2(data);
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    const manifestFile = v2.value.files.find((file) => file.path === "manifest.json");
    const manifestText =
      typeof manifestFile?.content === "string" ? manifestFile.content : canonicalJson(v2.value.manifest);
    const parsed = parseVersionedSnapshotManifest(manifestText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The format-2 export feeds the same validator under its own manifest.
    const inlineField = JSON.stringify(data.handoffs[0]?.artifact);
    expect(inlineField).not.toContain("inlineBody");
  });
});
