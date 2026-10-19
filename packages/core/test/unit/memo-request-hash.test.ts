import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  composeMemoRequestDigest,
  memoTextBodySource,
  type MemoHashRequest,
  type MemoBodyByteSource,
} from "../../src/memo-request-hash";

/**
 * The composer must reproduce the legacy
 * `sha256(JSON.stringify([operation, installationId, {"kind":"user",id:null}, request]))`
 * bytes exactly for every request shape — optional fields, body presence, and
 * adversarial body content — while streaming the body instead of materializing
 * the JSON envelope (MEM-007, the ADR-0032 reviewed plan).
 */

const INSTALLATION = "ef000000-0000-4000-8000-000000000001";

function legacyDigest(operation: string, request: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, INSTALLATION, { kind: "user", id: null }, request]))
    .digest("hex");
}

function chunkedTextSource(text: string, chunkBytes: number): MemoBodyByteSource {
  // Byte-level chunking of the whole valid string's encoding: the escaper is
  // byte-local, so chunk boundaries may split multibyte sequences the way a
  // real spool read would, without ever corrupting the bytes themselves.
  return {
    stream(sink) {
      const bytes = Buffer.from(text, "utf8");
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        sink(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)));
      }
      return { ok: true, value: undefined };
    },
  };
}

const addOf = (title: string): Extract<MemoHashRequest, { kind: "add" }> => ({
  kind: "add",
  operation: "add",
  installationId: INSTALLATION,
  projectId: "cd000000-0000-4000-8000-000000000001",
  title,
});

const updateOf = (extra: { projectId?: string; title?: string }): Extract<MemoHashRequest, { kind: "update" }> => ({
  kind: "update",
  operation: "update",
  installationId: INSTALLATION,
  id: "ab000000-0000-4000-8000-000000000001",
  expectedRowVersion: 3,
  ...extra,
});

const doneOf = (): Extract<MemoHashRequest, { kind: "state" }> => ({
  kind: "state",
  operation: "done",
  installationId: INSTALLATION,
  id: "ab000000-0000-4000-8000-000000000001",
  expectedRowVersion: 2,
});

describe("memo request hash composer", () => {
  it("matches the legacy digest for text bodies across adversarial content", () => {
    const bodies = [
      "",
      "plain",
      'quote " and backslash \\',
      "controls \b\t\n\f\r and \u0001\u001f",
      "delimiter \u2028 and sep \u2029 and del \u007f",
      "한글 😀 e\u0301\r\nCRLF\nfinal newline\n",
      "no final newline",
      "\uFEFFBOM preserved as content",
    ];
    for (const body of bodies) {
      const legacy = legacyDigest("add", { projectId: addOf("t").projectId, title: "t", body });
      const composed = composeMemoRequestDigest(addOf("t"), { present: true, source: memoTextBodySource(body) });
      expect(composed.ok).toBe(true);
      if (composed.ok) {
        expect(composed.value.digest).toBe(legacy);
        expect(composed.value.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
      }
    }
  });

  it("matches the legacy digest across chunk boundaries and chunk sizes", () => {
    const body = "경계 😀 다중바이트 query-overlap 최종줄\n".repeat(97);
    const legacy = legacyDigest("add", { projectId: addOf("title").projectId, title: "title", body });
    for (const chunkScalars of [1, 3, 17, 512]) {
      const composed = composeMemoRequestDigest(addOf("title"), {
        present: true,
        source: chunkedTextSource(body, chunkScalars),
      });
      expect(composed.ok && composed.value.digest).toBe(legacy);
    }
    const streamed = composeMemoRequestDigest(addOf("title"), { present: true, source: memoTextBodySource(body) });
    expect(streamed.ok && streamed.value.digest).toBe(legacy);
  });

  it("matches the legacy digest for every optional-field shape", () => {
    const shapes: Array<[MemoHashRequest, Record<string, unknown>, { present: boolean }]> = [
      [addOf("제목"), { projectId: addOf("제목").projectId, title: "제목", body: "" }, { present: true }],
      [updateOf({}), { id: updateOf({}).id, expectedRowVersion: 3, body: "b" }, { present: true }],
      [
        updateOf({ projectId: "cd000000-0000-4000-8000-000000000002" }),
        { id: updateOf({}).id, projectId: "cd000000-0000-4000-8000-000000000002", expectedRowVersion: 3 },
        { present: false },
      ],
      [updateOf({ title: "new" }), { id: updateOf({}).id, expectedRowVersion: 3, title: "new" }, { present: false }],
      [
        updateOf({ title: "new" }),
        { id: updateOf({}).id, expectedRowVersion: 3, title: "new", body: "\r\n" },
        { present: true },
      ],
      [
        { ...doneOf(), projectId: "cd000000-0000-4000-8000-000000000003" },
        { id: doneOf().id, projectId: "cd000000-0000-4000-8000-000000000003", expectedRowVersion: 2 },
        { present: false },
      ],
      [doneOf(), { id: doneOf().id, expectedRowVersion: 2 }, { present: false }],
    ];
    for (const [request, legacyRequest, body] of shapes) {
      const legacy = legacyDigest(request.operation, legacyRequest);
      const composed = composeMemoRequestDigest(
        request,
        body.present
          ? { present: true, source: memoTextBodySource(String(legacyRequest.body ?? "")) }
          : { present: false },
      );
      expect(composed.ok && composed.value.digest).toBe(legacy);
    }
  });

  it("keeps identical bodies identical across text and byte sources", () => {
    const body = '동일 바이트 비교 😀 \\ " \n';
    const fromText = composeMemoRequestDigest(addOf("t"), { present: true, source: memoTextBodySource(body) });
    const fromBytes = composeMemoRequestDigest(addOf("t"), {
      present: true,
      source: chunkedTextSource(body, 2),
    });
    expect(fromText).toEqual(fromBytes);
  });
});
