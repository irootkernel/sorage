import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildContentStorageKey,
  classifyTextRouting,
  commonContentFailureMetadata,
  commonContentSuccessMetadata,
  CONTENT_INLINE_MAX_UTF8_BYTES,
  contentOwnerFromStorageKey,
  decodeStrictUtf8,
  fetchCacheRelativePath,
  isManagedContentStorageKey,
  isUtf8ExactText,
  mapLegacyDrainOutcome,
  sha256OfText,
  utf8ByteLength,
  validateCommonContentEventMetadata,
  validateContentRecord,
} from "../../src/content";
import { ok } from "../../src/errors";

const UUID = "0123abcd-0000-4000-8000-000000000001";
const OWNER = "0123abcd-0000-4000-8000-0000000000ff";
const INTENT = "0123abcd-0000-4000-8000-0000000000ee";

describe("decodeStrictUtf8 and byte-exact text", () => {
  it("preserves a byte-order mark instead of stripping it as a decoder directive", () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x62, 0x6f, 0x64, 0x79, 0x0d, 0x0a]);
    const decoded = decodeStrictUtf8(bytes);
    expect(decoded).toBe("\uFEFFbody\r\n");
    expect(isUtf8ExactText(decoded as string)).toBe(true);
  });

  it("round-trips exact bytes with CRLF, multibyte characters, and no final newline", () => {
    const text = " first\r\n한국어line-no-final";
    const bytes = Buffer.from(text, "utf8");
    const decoded = decodeStrictUtf8(bytes);
    expect(decoded).toBe(text);
    expect(isUtf8ExactText(text)).toBe(true);
    expect(utf8ByteLength(text)).toBe(bytes.byteLength);
    expect(sha256OfText(text)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("returns null for invalid UTF-8 rather than storing replacement characters", () => {
    expect(decodeStrictUtf8(Buffer.from([0xff, 0xfe, 0xfd]))).toBeNull();
  });

  it("rejects text whose UTF-8 encoding would not round-trip, like a lone surrogate", () => {
    expect(isUtf8ExactText("bad \ud800 surrogate")).toBe(false);
  });
});

describe("text routing threshold", () => {
  it("routes threshold-minus-one, threshold, and threshold-plus-one around 65,536 UTF-8 bytes with multibyte characters", () => {
    const base = "한".repeat(10); // 30 bytes
    expect(utf8ByteLength(base)).toBe(30);
    const atThresholdMinusOne = `${"x".repeat(CONTENT_INLINE_MAX_UTF8_BYTES - 31)}${base}`;
    expect(utf8ByteLength(atThresholdMinusOne)).toBe(CONTENT_INLINE_MAX_UTF8_BYTES - 1);
    const atThreshold = `${atThresholdMinusOne}x`;
    const atThresholdPlusOne = `${atThreshold}x`;
    expect(classifyTextRouting(atThresholdMinusOne)).toEqual({
      kind: "inline",
      sizeBytes: CONTENT_INLINE_MAX_UTF8_BYTES - 1,
    });
    expect(classifyTextRouting(atThreshold)).toEqual({ kind: "inline", sizeBytes: CONTENT_INLINE_MAX_UTF8_BYTES });
    expect(classifyTextRouting(atThresholdPlusOne)).toEqual({
      kind: "vault",
      sizeBytes: CONTENT_INLINE_MAX_UTF8_BYTES + 1,
    });
    // A multibyte body counts bytes, not scalar values.
    const multibyte = "한".repeat(Math.floor((CONTENT_INLINE_MAX_UTF8_BYTES + 2) / 3));
    expect(classifyTextRouting(multibyte).kind).toBe("vault");
  });

  it("treats an empty text as inline with an empty byte size", () => {
    expect(classifyTextRouting("")).toEqual({ kind: "inline", sizeBytes: 0 });
    expect(sha256OfText("")).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });
});

describe("content storage keys", () => {
  it("builds and recognizes content/<domain>/<owner-id>/<content-id>", () => {
    const key = buildContentStorageKey({ domain: "memo", ownerId: OWNER, contentId: UUID });
    expect(key).toEqual(ok(`content/memo/${OWNER}/${UUID}`));
    expect(isManagedContentStorageKey(`content/memo/${OWNER}/${UUID}`)).toBe(true);
    expect(isManagedContentStorageKey(`content/channel/${OWNER}/${UUID}`)).toBe(true);
    expect(isManagedContentStorageKey(`artifacts/${OWNER}/${UUID}/name.md`)).toBe(false);
    expect(isManagedContentStorageKey(`content/handoff/${OWNER}/${UUID}`)).toBe(false);
    expect(isManagedContentStorageKey(`content/memo/${OWNER}`)).toBe(false);
    expect(isManagedContentStorageKey(`content/memo/${OWNER}/..`)).toBe(false);
    expect(isManagedContentStorageKey(`content/memo/${OWNER}/${UUID}/extra`)).toBe(false);
  });

  it("refuses unsafe segments", () => {
    expect(buildContentStorageKey({ domain: "memo", ownerId: "../escape", contentId: UUID }).ok).toBe(false);
    expect(buildContentStorageKey({ domain: "memo", ownerId: OWNER, contentId: "a/b" }).ok).toBe(false);
    expect(buildContentStorageKey({ domain: "other" as "memo", ownerId: OWNER, contentId: UUID }).ok).toBe(false);
  });

  it("derives the owner only when the key's record segment equals the record id", () => {
    expect(contentOwnerFromStorageKey({ id: UUID, storageKey: `content/memo/${OWNER}/${UUID}` })).toEqual(
      ok({
        domain: "memo",
        ownerId: OWNER,
      }),
    );
    const mismatch = contentOwnerFromStorageKey({ id: UUID, storageKey: `content/memo/${OWNER}/${INTENT}` });
    expect(mismatch.ok).toBe(false);
    expect(contentOwnerFromStorageKey({ id: UUID, storageKey: null }).ok).toBe(false);
  });
});

describe("validateContentRecord", () => {
  const sha = "a".repeat(64);
  it("accepts exactly-one-of representations, including an existing artifacts/ key", () => {
    expect(
      validateContentRecord({
        id: UUID,
        inlineText: "body",
        storageKey: null,
        sizeBytes: 4,
        sha256: sha,
        materialized: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(true);
    expect(
      validateContentRecord({
        id: UUID,
        inlineText: null,
        storageKey: `content/memo/${OWNER}/${UUID}`,
        sizeBytes: 10,
        sha256: sha,
        materialized: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(true);
    expect(
      validateContentRecord({
        id: UUID,
        inlineText: null,
        storageKey: `artifacts/${OWNER}/${UUID}/notes.md`,
        sizeBytes: 10,
        sha256: sha,
        materialized: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(true);
  });

  it("rejects both-present, both-absent, unmanaged keys, bad digests, and unmaterialized inline rows", () => {
    const base = {
      id: UUID,
      sizeBytes: 4,
      sha256: sha,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      validateContentRecord({ ...base, inlineText: "b", storageKey: "content/memo/o/i", materialized: true }).ok,
    ).toBe(false);
    expect(validateContentRecord({ ...base, inlineText: null, storageKey: null, materialized: true }).ok).toBe(false);
    expect(validateContentRecord({ ...base, inlineText: null, storageKey: "/abs/path", materialized: false }).ok).toBe(
      false,
    );
    expect(validateContentRecord({ ...base, inlineText: null, storageKey: "", materialized: false }).ok).toBe(false);
    expect(
      validateContentRecord({
        ...base,
        inlineText: null,
        storageKey: `content/memo/${OWNER}/${UUID}`,
        materialized: false,
        sha256: "ABC",
      }).ok,
    ).toBe(false);
    expect(validateContentRecord({ ...base, inlineText: "b", storageKey: null, materialized: false }).ok).toBe(false);
    expect(
      validateContentRecord({
        ...base,
        inlineText: null,
        storageKey: `content/memo/${OWNER}/${UUID}`,
        materialized: true,
        sizeBytes: -1,
      }).ok,
    ).toBe(false);
  });
});

describe("common content event metadata", () => {
  it("accepts a failed unlink assessment: failure carries either operation", () => {
    const identity = {
      contentId: UUID,
      ownerDomain: "channel" as const,
      ownerId: OWNER,
      intentId: INTENT,
      operation: "unlink" as const,
    };
    const metadata = commonContentFailureMetadata(identity, { attempt: 3, reason: "io_error" });
    const verified = validateCommonContentEventMetadata(metadata, "CONTENT_INTEGRITY_FAILED");
    expect(verified).toEqual(ok(undefined));
  });

  it("accepts a failed activation assessment with the same closed shape", () => {
    const metadata = commonContentFailureMetadata(
      {
        contentId: UUID,
        ownerDomain: "memo" as const,
        ownerId: OWNER,
        intentId: INTENT,
        operation: "activate" as const,
      },
      { attempt: 1, reason: "missing_content" },
    );
    expect(validateCommonContentEventMetadata(metadata, "CONTENT_INTEGRITY_FAILED")).toEqual(ok(undefined));
  });

  it("rejects an invalid operation value and non-positive attempts on failures", () => {
    const identity = {
      contentId: UUID,
      ownerDomain: "memo" as const,
      ownerId: OWNER,
      intentId: INTENT,
      operation: "activate" as const,
    };
    expect(
      validateCommonContentEventMetadata(
        { ...commonContentFailureMetadata(identity, { attempt: 1, reason: "io_error" }), operation: "replace" },
        "CONTENT_INTEGRITY_FAILED",
      ).ok,
    ).toBe(false);
    // Invalid unknown reasons and attempts arrive as raw unknown input, exactly
    // as a snapshot reader sees them, rather than through a typed builder.
    expect(
      validateCommonContentEventMetadata(
        { ...commonContentFailureMetadata(identity, { attempt: 1, reason: "io_error" }), reason: "exploded" },
        "CONTENT_INTEGRITY_FAILED",
      ).ok,
    ).toBe(false);
    expect(
      validateCommonContentEventMetadata(
        { ...commonContentFailureMetadata(identity, { attempt: 1, reason: "io_error" }), attempt: 0 },
        "CONTENT_INTEGRITY_FAILED",
      ).ok,
    ).toBe(false);
  });

  it("pins the operation only on success families and rejects a mismatch there", () => {
    const activated = commonContentSuccessMetadata({
      contentId: UUID,
      ownerDomain: "memo" as const,
      ownerId: OWNER,
      intentId: INTENT,
      operation: "activate" as const,
    });
    expect(validateCommonContentEventMetadata(activated, "CONTENT_ACTIVATED")).toEqual(ok(undefined));
    expect(validateCommonContentEventMetadata({ ...activated, operation: "unlink" }, "CONTENT_ACTIVATED").ok).toBe(
      false,
    );
    const unlinked = commonContentSuccessMetadata({
      contentId: UUID,
      ownerDomain: "channel" as const,
      ownerId: OWNER,
      intentId: INTENT,
      operation: "unlink" as const,
    });
    expect(validateCommonContentEventMetadata(unlinked, "CONTENT_UNLINKED")).toEqual(ok(undefined));
    expect(validateCommonContentEventMetadata({ ...unlinked, extra: 1 }, "CONTENT_UNLINKED").ok).toBe(false);
    expect(validateCommonContentEventMetadata({ ...unlinked, attempt: 1 }, "CONTENT_UNLINKED").ok).toBe(false);
  });
});

describe("legacy drain outcome mapping", () => {
  it("maps the legacy outcomes onto the closed common reasons", () => {
    expect(mapLegacyDrainOutcome("both-gone")).toBe("missing_content");
    expect(mapLegacyDrainOutcome("destination-conflict")).toBe("destination_conflict");
    expect(mapLegacyDrainOutcome("unsafe-path")).toBe("unsafe_path");
  });
});

describe("fetch cache identity", () => {
  it("derives one deterministic state-relative path per checksum", () => {
    const sha = "b".repeat(64);
    expect(fetchCacheRelativePath(sha)).toEqual(ok(`fetch-cache/${sha}`));
    expect(fetchCacheRelativePath("not-a-digest").ok).toBe(false);
  });
});

describe("error catalogue rows", () => {
  it("carries the SOT HTTP and exit mappings for the content codes", async () => {
    const { errorSpec } = await import("../../src/errors");
    expect(errorSpec("CONTENT_MATERIALIZING")).toMatchObject({ httpStatus: 409, exitCode: 75 });
    expect(errorSpec("CONTENT_CORRUPTED")).toMatchObject({ httpStatus: 409, exitCode: 73 });
  });
});
