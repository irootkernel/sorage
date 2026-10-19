import { describe, expect, it } from "vitest";
import {
  createMemoSnapshot,
  changeMemoSnapshot,
  publicMemoOf,
  MEMO_BODY_BYTES,
  type MemoSnapshot,
} from "../../src/memos";
import {
  memoPreviewOf,
  parseMemoDetail,
  parseStoredMemoReceipt,
  serializeMemoReceiptForStorage,
} from "../../src/memo-protocol";

/**
 * Shared-content Memo core: the routed-body invariants (inline threshold,
 * file identity), the snapshot lifecycle's no-op rules across the inline/file
 * boundary, the public DTO projection, the shared preview rule, and the
 * dual-form stored receipt of SHR-008 — a legacy embedded receipt stays
 * verbatim and a file-backed receipt references its immutable record without
 * ever serializing the body.
 */

const PROJECT = "cd000000-0000-4000-8000-000000000001";
const MEMO = "ab000000-0000-4000-8000-000000000002";
const RECORD = "ab000000-0000-4000-8000-000000000003";
const NOW = "2026-10-19T00:00:00.000Z";

function inlineSnapshot(body: string): MemoSnapshot {
  const created = createMemoSnapshot(MEMO, PROJECT, { title: "t", body: { kind: "inline", text: body } }, NOW);
  expect(created.ok).toBe(true);
  return created.ok ? created.value.memo : (undefined as never);
}

function fileSnapshot(sizeBytes: number, sha256: string): MemoSnapshot {
  const created = createMemoSnapshot(
    MEMO,
    PROJECT,
    { title: "t", body: { kind: "file", identity: { recordId: RECORD, sizeBytes, sha256 } } },
    NOW,
  );
  expect(created.ok).toBe(true);
  return created.ok ? created.value.memo : (undefined as never);
}

describe("routed body invariants", () => {
  it("accepts an inline body at the threshold and rejects one byte above", () => {
    const atThreshold = "a".repeat(MEMO_BODY_BYTES);
    expect(inlineSnapshot(atThreshold).body).toBe(atThreshold);
    const created = createMemoSnapshot(
      MEMO,
      PROJECT,
      { title: "t", body: { kind: "inline", text: `${atThreshold}x` } },
      NOW,
    );
    expect(created.ok).toBe(false);
    expect(created.ok === false && created.error.code).toBe("MEMO_TOO_LARGE");
  });

  it("requires a file body to exceed the threshold with a complete identity", () => {
    const valid = fileSnapshot(MEMO_BODY_BYTES + 1, "0".repeat(64));
    expect(valid.body).toBeNull();
    expect(valid.bodyRef.recordId).toBe(RECORD);
    const tooSmall = createMemoSnapshot(
      MEMO,
      PROJECT,
      {
        title: "t",
        body: { kind: "file", identity: { recordId: RECORD, sizeBytes: MEMO_BODY_BYTES, sha256: "0".repeat(64) } },
      },
      NOW,
    );
    expect(tooSmall.ok).toBe(false);
    const badDigest = createMemoSnapshot(
      MEMO,
      PROJECT,
      {
        title: "t",
        body: { kind: "file", identity: { recordId: RECORD, sizeBytes: MEMO_BODY_BYTES + 1, sha256: "X".repeat(64) } },
      },
      NOW,
    );
    expect(badDigest.ok).toBe(false);
  });
});

describe("snapshot lifecycle", () => {
  it("compares an inline replacement by exact string equality", () => {
    const snapshot = inlineSnapshot("original");
    const same = changeMemoSnapshot(
      snapshot,
      { operation: "update", expectedRowVersion: 1, body: { kind: "inline", text: "original" } },
      NOW,
    );
    expect(same.ok && same.value.changed).toBe(false);
    const other = changeMemoSnapshot(
      snapshot,
      { operation: "update", expectedRowVersion: 1, body: { kind: "inline", text: "changed" } },
      NOW,
    );
    expect(other.ok && other.value.changed).toBe(true);
  });

  it("compares a file-backed current body through its recorded identity without any body read", () => {
    const snapshot = fileSnapshot(MEMO_BODY_BYTES + 10, "a".repeat(64));
    const sameIdentity = changeMemoSnapshot(
      snapshot,
      {
        operation: "update",
        expectedRowVersion: 1,
        body: {
          kind: "file",
          identity: {
            recordId: "ab000000-0000-4000-8000-000000000004",
            sizeBytes: MEMO_BODY_BYTES + 10,
            sha256: "a".repeat(64),
          },
        },
      },
      NOW,
    );
    expect(sameIdentity.ok && sameIdentity.value.changed).toBe(false);
    const differentSize = changeMemoSnapshot(
      snapshot,
      {
        operation: "update",
        expectedRowVersion: 1,
        body: {
          kind: "file",
          identity: {
            recordId: "ab000000-0000-4000-8000-000000000004",
            sizeBytes: MEMO_BODY_BYTES + 11,
            sha256: "a".repeat(64),
          },
        },
      },
      NOW,
    );
    expect(differentSize.ok && differentSize.value.changed).toBe(true);
  });

  it("keeps title-only and state changes free of body I/O fields", () => {
    const snapshot = inlineSnapshot("body");
    const renamed = changeMemoSnapshot(snapshot, { operation: "update", expectedRowVersion: 1, title: "renamed" }, NOW);
    expect(renamed.ok && renamed.value.memo.body).toBe("body");
    const closed = changeMemoSnapshot(snapshot, { operation: "done", expectedRowVersion: 1 }, NOW);
    expect(closed.ok && closed.value.memo.state).toBe("done");
  });

  it("projects the public DTO without the private record reference", () => {
    const snapshot = inlineSnapshot("body");
    const projected = publicMemoOf(snapshot);
    expect(Object.keys(projected).sort()).toEqual(
      [
        "body",
        "closedAt",
        "closedBy",
        "createdAt",
        "createdBy",
        "id",
        "projectId",
        "rowVersion",
        "state",
        "title",
        "updatedAt",
        "updatedBy",
      ].sort(),
    );
  });
});

describe("shared preview rule", () => {
  it("accumulates scalars within 512 bytes and marks truncation by total bytes", () => {
    const short = memoPreviewOf("한글 body", Buffer.byteLength("한글 body"));
    expect(short.bodyPreview).toBe("한글 body");
    expect(short.bodyPreviewTruncated).toBe(false);
    const long = "가".repeat(600);
    const preview = memoPreviewOf(long, Buffer.byteLength(long));
    expect(Buffer.byteLength(preview.bodyPreview)).toBeLessThanOrEqual(512);
    expect(preview.bodyPreviewTruncated).toBe(true);
  });
});

describe("dual-form stored receipts", () => {
  it("serializes an inline original verbatim and parses it back through the frozen legacy bound", () => {
    const snapshot = inlineSnapshot("receipt body");
    const stored = JSON.parse(serializeMemoReceiptForStorage({ memo: snapshot, changed: true }));
    expect(stored.memo.body).toBe("receipt body");
    expect(stored.memo.bodyRef).toBeUndefined();
    const parsed = parseStoredMemoReceipt(stored);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.memo.body).toBe("receipt body");
      // An embedded legacy receipt owns its bytes and has no content record identity.
      expect(parsed.value.memo.bodyRef.recordId).toBe("");
      expect(parsed.value.changed).toBe(true);
    }
    expect(parseMemoDetail(stored.memo).ok).toBe(true);
  });

  it("stores a file-backed original as its immutable reference without the body", () => {
    const snapshot = fileSnapshot(MEMO_BODY_BYTES + 5, "b".repeat(64));
    const stored = JSON.parse(serializeMemoReceiptForStorage({ memo: snapshot, changed: false }));
    expect(stored.memo.body).toBeUndefined();
    expect(stored.memo.bodyRef).toEqual({ recordId: RECORD, sizeBytes: MEMO_BODY_BYTES + 5, sha256: "b".repeat(64) });
    const parsed = parseStoredMemoReceipt(stored);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.memo.body).toBeNull();
      expect(parsed.value.memo.bodyRef.recordId).toBe(RECORD);
      expect(parsed.value.changed).toBe(false);
    }
  });

  it("refuses malformed stored receipts as integrity errors, never absence", () => {
    const snapshot = fileSnapshot(MEMO_BODY_BYTES + 5, "b".repeat(64));
    const stored = JSON.parse(serializeMemoReceiptForStorage({ memo: snapshot, changed: false }));
    stored.memo.bodyRef.sha256 = "not-a-digest";
    const parsed = parseStoredMemoReceipt(stored);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    const both = JSON.parse(serializeMemoReceiptForStorage({ memo: snapshot, changed: true }));
    both.memo.body = "text";
    const mixed = parseStoredMemoReceipt(both);
    expect(mixed.ok).toBe(false);
  });

  it("round-trips a legacy embedded receipt from the frozen M7 shape", () => {
    const memo = parseMemoDetail({
      id: MEMO,
      projectId: PROJECT,
      title: "legacy",
      body: "legacy body",
      state: "open",
      rowVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: { kind: "user", id: null },
      updatedBy: { kind: "user", id: null },
      closedAt: null,
      closedBy: null,
    });
    expect(memo.ok).toBe(true);
    const legacyJson = JSON.stringify({ memo: memo.ok ? memo.value : undefined, changed: true, replayed: false });
    const parsed = parseStoredMemoReceipt(JSON.parse(legacyJson));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.memo.body).toBe("legacy body");
    const replayed = parseStoredMemoReceipt(JSON.parse(legacyJson.replace('"replayed":false', '"replayed":true')));
    expect(replayed.ok).toBe(false);
  });
});
