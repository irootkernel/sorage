import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonLine,
  snapshotFiles,
  parseSnapshotManifest,
  parseVersionedSnapshotManifest,
  memoIdFromSnapshotPath,
  parseMemoSnapshot,
  serializeMemoSnapshot,
  parseMemoEventAssociation,
  parseMemoReceipt,
  parseMemoPage,
  parseMemoCreate,
  parseMemoUpdate,
  parseMemoStateRequest,
  type Memo,
  type MemoSnapshotEvent,
  MEMO_EVENT_TYPES,
  EVENT_TYPES,
  isEventType,
  isActorKind,
  isMemoEventType,
  changeMemo,
} from "../../src/index";

function fixture(name: string): Buffer {
  return readFileSync(new URL(`./golden/memos/${name}`, import.meta.url));
}
const bytes = fixture("memo.json");
const memo: Memo = JSON.parse(bytes.toString("utf8"));
const identity: { path: string; sha256: string; byteLength: number } = JSON.parse(
  fixture("memo-identity.json").toString(),
);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("frozen Memo snapshot bytes and paths", () => {
  it("pins independently serialized bytes and Python hashlib digest including final LF", () => {
    const result = serializeMemoSnapshot(memo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.value.bytes)).toEqual(bytes);
    expect(result.value.path).toBe(identity.path);
    expect(result.value.digest).toBe("544d0b376ff57a2b478e52d42c92e62c66707d385f222167b1ad89f27efb4473");
    expect(result.value.digest).toBe(identity.sha256);
    expect(bytes.byteLength).toBe(identity.byteLength);
    expect(bytes.at(-1)).toBe(10);
    expect(parseMemoSnapshot(identity.path, bytes, identity.sha256)).toEqual({ ok: true, value: memo });
  });
  it.each([
    "snapshots/memos/ab/ab000000-0000-4000-8000-000000000001.json",
    "/memos/ab/ab000000-0000-4000-8000-000000000001.json",
    "memos/cd/ab000000-0000-4000-8000-000000000001.json",
    "memos/ab/AB000000-0000-4000-8000-000000000001.json",
    "memos/ab/../ab/ab000000-0000-4000-8000-000000000001.json",
    "memos//ab/ab000000-0000-4000-8000-000000000001.json",
    "memos/ab/./ab000000-0000-4000-8000-000000000001.json",
    "memos\\ab\\ab000000-0000-4000-8000-000000000001.json",
    "memos/ab/%61b000000-0000-4000-8000-000000000001.json",
  ])("rejects noncanonical path %s", (path) => {
    expect(memoIdFromSnapshotPath(path).ok).toBe(false);
  });
  it("rejects noncanonical bytes even with recalculated digest", () => {
    for (const text of [
      bytes.toString().trimEnd(),
      `${bytes}\n`,
      bytes.toString().replaceAll("\n", "\r\n"),
      `\uFEFF${bytes}`,
      JSON.stringify(memo),
      bytes.toString().replace("Review", "\\u0052eview"),
    ]) {
      const altered = Buffer.from(text);
      expect(parseMemoSnapshot(identity.path, altered, identity.sha256).ok).toBe(false);
      expect(parseMemoSnapshot(identity.path, altered, hash(altered)).ok).toBe(false);
    }
  });
  it("rejects duplicate decoded keys at every depth, including escaped aliases", () => {
    for (const text of [
      bytes.toString().replace('"body":', '"body": "duplicate", "body":'),
      bytes.toString().replace('"kind": "user"', '"kind": "user", "k\\u0069nd": "user"'),
    ]) {
      const altered = Buffer.from(text);
      expect(parseMemoSnapshot(identity.path, altered, hash(altered)).ok).toBe(false);
    }
  });
  it("requires exact stored field set, invariant values and matching record UUID", () => {
    for (const patch of [
      { id: memo.projectId },
      { title: " Review " },
      { state: "done" },
      { state: "done", rowVersion: 1, closedAt: memo.createdAt, closedBy: memo.createdBy },
      { state: "dismissed", rowVersion: 1, closedAt: memo.createdAt, closedBy: memo.createdBy },
      { rowVersion: 0 },
      { bodyPreview: "bad" },
      { closedBy: { kind: "user", id: null } },
      { updatedBy: { kind: "registered_project", id: memo.projectId } },
    ]) {
      const altered = Buffer.from(canonicalJson({ ...memo, ...patch }));
      expect(parseMemoSnapshot(identity.path, altered, hash(altered)).ok).toBe(false);
    }
    const { closedBy: _closedBy, ...missing } = memo;
    const altered = Buffer.from(canonicalJson(missing));
    expect(parseMemoSnapshot(identity.path, altered, hash(altered)).ok).toBe(false);
  });
  it("rejects mismatched closed timestamps even with canonical bytes and a matching digest", () => {
    for (const operation of ["done", "dismiss"] as const) {
      const closedAt = "2026-09-26T23:00:00.000Z";
      const closed = changeMemo(memo, { operation, expectedRowVersion: memo.rowVersion }, closedAt);
      if (!closed.ok) throw new Error(closed.error.code);
      const serialized = serializeMemoSnapshot(closed.value.memo);
      if (!serialized.ok) throw new Error(serialized.error.code);
      expect(parseMemoSnapshot(serialized.value.path, serialized.value.bytes, serialized.value.digest)).toEqual({
        ok: true,
        value: closed.value.memo,
      });
      for (const updatedAt of ["2026-09-26T22:00:00.000Z", memo.updatedAt]) {
        const invalid = { ...closed.value.memo, updatedAt };
        const altered = Buffer.from(canonicalJson(invalid));
        expect(serializeMemoSnapshot(invalid).ok).toBe(false);
        expect(parseMemoSnapshot(identity.path, altered, hash(altered)).ok).toBe(false);
      }
    }
  });
  it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), `sha256:${identity.sha256}`, "g".repeat(64)])(
    "rejects invalid digest %s",
    (digest) => {
      expect(parseMemoSnapshot(identity.path, bytes, digest).ok).toBe(false);
    },
  );
});

describe("versioned manifest and Memo event association", () => {
  it("pins mandatory populated and zero-Memo format-2 shapes", () => {
    for (const name of ["manifest-v2.json", "manifest-v2-empty.json"]) {
      const text = fixture(name).toString();
      const parsed = parseVersionedSnapshotManifest(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(canonicalJson(parsed.value)).toBe(text);
    }
  });
  it("preserves the format-1 writer, reader, bytes and no-Memo interpretation", () => {
    const legacy = fixture("manifest-v1-empty.json").toString();
    expect(parseSnapshotManifest(legacy).ok).toBe(true);
    expect(
      snapshotFiles({ projects: [], handoffs: [], events: [] }).find((file) => file.path === "manifest.json")?.content,
    ).toBe(legacy);
    expect(parseSnapshotManifest(legacy)).toEqual(parseVersionedSnapshotManifest(legacy));
    // TASK-088 owns activating the new format in the existing runtime reader/writer.
    expect(parseSnapshotManifest(fixture("manifest-v2-empty.json").toString())).toMatchObject({
      ok: false,
      error: { code: "VAULT_SCHEMA_UNSUPPORTED" },
    });
    expect(parseVersionedSnapshotManifest(canonicalJson({ ...JSON.parse(legacy), memoDigests: {} })).ok).toBe(false);
  });
  it("rejects missing/unknown fields, unsafe counts, digest inventory and duplicate map keys", () => {
    const manifest = JSON.parse(fixture("manifest-v2.json").toString());
    for (const input of [
      { ...manifest, memoDigests: undefined },
      { ...manifest, memoDigests: {} },
      { ...manifest, extra: true },
      { ...manifest, counts: { ...manifest.counts, memos: undefined } },
      { ...manifest, counts: { ...manifest.counts, memos: -1 } },
      { ...manifest, counts: { ...manifest.counts, projects: Number.MAX_SAFE_INTEGER + 1 } },
      { ...manifest, memoDigests: { [identity.path]: identity.sha256.toUpperCase() } },
      { ...manifest, memoDigests: { [`snapshots/${identity.path}`]: identity.sha256 } },
    ])
      expect(parseVersionedSnapshotManifest(canonicalJson(input)).ok).toBe(false);
    const duplicate = fixture("manifest-v2.json")
      .toString()
      .replace(`"${identity.path}":`, `"${identity.path}": "${identity.sha256}", "${identity.path}":`);
    expect(parseVersionedSnapshotManifest(duplicate).ok).toBe(false);
    expect(parseVersionedSnapshotManifest('{"formatVersion":3}')).toMatchObject({
      ok: false,
      error: { code: "VAULT_SCHEMA_UNSUPPORTED" },
    });
  });
  const event: MemoSnapshotEvent = {
    id: "ef000000-0000-4000-8000-000000000001",
    handoffId: null,
    memoId: memo.id,
    eventType: "MEMO_CREATED",
    actorKind: "user",
    actorId: null,
    rowVersion: 1,
    createdAt: memo.createdAt,
    metadata: { memoId: memo.id, projectId: memo.projectId, rowVersion: 1, toState: "open" },
  };
  const memos = new Map([[memo.id, memo]]);
  it("requires Memo ownership and no Handoff association", () => {
    expect(parseMemoEventAssociation(event, 2, memos)).toEqual({ ok: true, value: event });
    for (const patch of [
      { memoId: null },
      { handoffId: memo.id },
      { actorKind: "system" },
      { actorId: memo.id },
      { rowVersion: 2 },
      { rowVersion: null },
      { eventType: "MEMO_NOT_A_CATALOG_EVENT" },
      { metadata: { ...event.metadata, rowVersion: 2 } },
      { metadata: { ...event.metadata, projectId: memo.id } },
      { metadata: { ...event.metadata, memoId: null } },
    ])
      expect(parseMemoEventAssociation({ ...event, ...patch }, 2, memos).ok).toBe(false);
    expect(parseMemoEventAssociation(event, 2, new Map()).ok).toBe(false);
    expect(parseMemoEventAssociation(event, 1, memos).ok).toBe(false);
  });
  it("pins the five Memo catalog names and their guards to the Memo event documentation", () => {
    const expected = ["MEMO_CREATED", "MEMO_UPDATED", "MEMO_MARKED_DONE", "MEMO_DISMISSED", "MEMO_REOPENED"];
    expect([...MEMO_EVENT_TYPES]).toEqual(expected);
    expect(EVENT_TYPES.filter((name) => name.startsWith("MEMO_"))).toEqual(expected);
    for (const name of expected) {
      expect(isEventType(name)).toBe(true);
      expect(isMemoEventType(name)).toBe(true);
    }
    expect(isEventType("MEMO_BOGUS")).toBe(false);
    expect(isMemoEventType("HANDOFF_CREATED")).toBe(false);
    for (const kind of ["user", "system", "registered_project", "unregistered_workspace"])
      expect(isActorKind(kind)).toBe(true);
    expect(isActorKind("unknown")).toBe(false);
    const doc = readFileSync(new URL("../../../../docs/specs/security-reliability.md", import.meta.url), "utf8");
    expect([...doc.matchAll(/^\| `(MEMO_[A-Z_]+)` \| `user` \| M7 \|$/gm)].map((match) => match[1])).toEqual(expected);
  });
  it("requires each event's exact metadata fields and legal transition", () => {
    const owners = new Map([[memo.id, { ...memo, rowVersion: 10 }]]);
    const identityFields = { projectId: memo.projectId, memoId: memo.id, rowVersion: 2 };
    const cases = [
      { eventType: "MEMO_CREATED", rowVersion: 1, metadata: { ...identityFields, rowVersion: 1, toState: "open" } },
      { eventType: "MEMO_UPDATED", rowVersion: 2, metadata: { ...identityFields, changedFields: ["title", "body"] } },
      {
        eventType: "MEMO_MARKED_DONE",
        rowVersion: 2,
        metadata: { ...identityFields, fromState: "open", toState: "done" },
      },
      {
        eventType: "MEMO_DISMISSED",
        rowVersion: 2,
        metadata: { ...identityFields, fromState: "open", toState: "dismissed" },
      },
      {
        eventType: "MEMO_REOPENED",
        rowVersion: 3,
        metadata: { ...identityFields, rowVersion: 3, fromState: "done", toState: "open" },
      },
      {
        eventType: "MEMO_REOPENED",
        rowVersion: 3,
        metadata: { ...identityFields, rowVersion: 3, fromState: "dismissed", toState: "open" },
      },
    ];
    for (const item of cases) {
      const row = { ...event, ...item };
      expect(parseMemoEventAssociation(row, 2, owners)).toEqual({ ok: true, value: row });
      if (item.eventType !== "MEMO_CREATED") {
        for (let rowVersion = 1; rowVersion < item.rowVersion; rowVersion++)
          expect(
            parseMemoEventAssociation({ ...row, rowVersion, metadata: { ...item.metadata, rowVersion } }, 2, owners).ok,
          ).toBe(false);
      }
      const resultState = "toState" in item.metadata ? item.metadata.toState : "open";
      for (const state of ["open", "done", "dismissed"] as const) {
        const owner = {
          ...memo,
          state,
          rowVersion: item.rowVersion,
          closedAt: state === "open" ? null : memo.createdAt,
          closedBy: state === "open" ? null : memo.createdBy,
        };
        expect(parseMemoEventAssociation(row, 2, new Map([[memo.id, owner]])).ok).toBe(state === resultState);
      }
      for (const forbidden of ["body", "title", "fromPath", "prompt"])
        expect(
          parseMemoEventAssociation(
            { ...row, metadata: { ...item.metadata, [forbidden]: "private content" } },
            2,
            owners,
          ).ok,
        ).toBe(false);
      expect(
        parseMemoEventAssociation({ ...row, metadata: { ...identityFields, rowVersion: item.rowVersion } }, 2, owners)
          .ok,
      ).toBe(false);
    }
    for (const changedFields of [[], ["body", "body"], ["secret"], 42, null])
      expect(
        parseMemoEventAssociation(
          { ...event, eventType: "MEMO_UPDATED", rowVersion: 2, metadata: { ...identityFields, changedFields } },
          2,
          owners,
        ).ok,
      ).toBe(false);
    for (const patch of [
      { eventType: "MEMO_MARKED_DONE", fromState: "dismissed", toState: "done" },
      { eventType: "MEMO_REOPENED", fromState: "open", toState: "open" },
      { eventType: "MEMO_DISMISSED", fromState: "open", toState: "bogus" },
    ])
      expect(
        parseMemoEventAssociation(
          {
            ...event,
            eventType: patch.eventType,
            rowVersion: 2,
            metadata: { ...identityFields, fromState: patch.fromState, toState: patch.toState },
          },
          2,
          owners,
        ).ok,
      ).toBe(false);
  });
  it("maps legacy event associations to null without changing historical serialization", () => {
    const { memoId: _memoId, ...legacy } = { ...event, eventType: "RESTORE_COMPLETED", metadata: {} };
    const before = canonicalJsonLine(legacy);
    expect(parseMemoEventAssociation(legacy, 1, memos)).toEqual({ ok: true, value: { ...legacy, memoId: null } });
    expect(canonicalJsonLine(legacy)).toBe(before);
    expect(parseMemoEventAssociation(legacy, 2, memos).ok).toBe(false);
    expect(parseMemoEventAssociation({ ...legacy, memoId: memo.id }, 2, memos).ok).toBe(false);
  });
  it("pins complete receipt and normalized request examples", () => {
    const receipt = JSON.parse(fixture("receipt.json").toString());
    expect(parseMemoReceipt(receipt)).toEqual({ ok: true, value: receipt });
    const page = JSON.parse(fixture("page.json").toString());
    expect(parseMemoPage(page)).toEqual({ ok: true, value: page });
    expect(parseMemoPage({ ...page, total: 1 }).ok).toBe(false);
    expect(parseMemoPage({ items: [{ ...page.items[0], bodyPreview: "x".repeat(513) }], nextCursor: null }).ok).toBe(
      false,
    );
    const requests = JSON.parse(fixture("requests.json").toString());
    expect(parseMemoCreate(requests.create)).toEqual({ ok: true, value: requests.create });
    expect(parseMemoUpdate(requests.update)).toEqual({ ok: true, value: requests.update });
    expect(parseMemoStateRequest(requests.close)).toEqual({ ok: true, value: requests.close });
  });
});
