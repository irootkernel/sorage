import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildContentStorageKey,
  classifyPreparedBody,
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
  planContentRecordRemoval,
  planLegacyUnlinkEligibility,
  sha256OfBytes,
  sha256OfText,
  utf8ByteLength,
  validateCommonContentEventMetadata,
  validateContentRecord,
  type ContentRecord,
} from "../../src/content";
import { ok } from "../../src/errors";
import { buildStorageKey } from "../../src/artifacts";

const UUID = "0123abcd-0000-4000-8000-000000000001";
const OWNER = "0123abcd-0000-4000-8000-0000000000ff";
const INTENT = "0123abcd-0000-4000-8000-0000000000ee";
const HANDOFF = "0123abcd-0000-4000-8000-0000000000aa";
const ARTIFACT = "0123abcd-0000-4000-8000-0000000000ab";

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

describe("Handoff prepare routing (section 4, SHR-002)", () => {
  const context = (overrides: Partial<Parameters<typeof classifyPreparedBody>[0]> = {}) => ({
    logicalName: "brief.md",
    storedName: "brief.md",
    classification: "mime-first" as const,
    handoffId: HANDOFF,
    artifactId: ARTIFACT,
    maxBytes: 1024 * 1024,
    ...overrides,
  });

  it("routes small decodable text inline with exact BOM, CRLF, and no-final-newline bytes", () => {
    const text = "\uFEFFtitle\r\n한국어 body-no-final";
    const bytes = Buffer.from(text, "utf8");
    const routing = classifyPreparedBody(context(), bytes);
    expect(routing).toEqual(
      ok({
        kind: "inline",
        text,
        sizeBytes: bytes.byteLength,
        sha256: sha256OfBytes(bytes),
        mimeType: "text/markdown",
        storageKey: null,
      }),
    );
  });

  it("routes the exact threshold inline and one byte over it to the Vault, with multibyte boundaries", () => {
    const atThreshold = Buffer.from(`${"한".repeat(21845)}a`, "utf8"); // 3 * 21845 + 1 = 65,536
    expect(atThreshold.byteLength).toBe(CONTENT_INLINE_MAX_UTF8_BYTES);
    expect(classifyPreparedBody(context(), atThreshold)).toMatchObject({ ok: true, value: { kind: "inline" } });
    const overThreshold = Buffer.from(`${"한".repeat(21845)}ab`, "utf8");
    expect(classifyPreparedBody(context(), overThreshold)).toMatchObject({
      ok: true,
      value: { kind: "vault", storageKey: `artifacts/${HANDOFF}/${ARTIFACT}/brief.md` },
    });
  });

  it("keeps a binary-classified body Vault-backed even when its bytes decode as valid UTF-8", () => {
    const routing = classifyPreparedBody(
      context({ logicalName: "logo.png", storedName: "logo.png" }),
      Buffer.from("plain ascii", "utf8"),
    );
    expect(routing).toMatchObject({ ok: true, value: { kind: "vault", mimeType: "application/octet-stream" } });
  });

  it("falls an undecodable text-classified body back to the Vault instead of rejecting the import", () => {
    const routing = classifyPreparedBody(
      context({ logicalName: "notes.txt", storedName: "notes.txt" }),
      Buffer.from([0x74, 0x78, 0x74, 0xff]),
    );
    expect(routing).toMatchObject({ ok: true, value: { kind: "vault", mimeType: "text/plain; charset=utf-8" } });
  });

  it("builds the Vault key from the supplied identities and the stored name", () => {
    const storedName = "report 1.md";
    const key = buildStorageKey({ handoffId: HANDOFF, artifactId: ARTIFACT, storedName });
    expect(key.ok).toBe(true);
    const routing = classifyPreparedBody(
      context({ logicalName: storedName, storedName }),
      Buffer.alloc(CONTENT_INLINE_MAX_UTF8_BYTES + 1, 0x78),
    );
    expect(routing.ok && routing.value.kind === "vault" ? routing.value.storageKey : null).toBe(
      key.ok ? key.value : null,
    );
  });

  it("rejects a body over the shared accepted bound with the surface's symbolic code", () => {
    const routing = classifyPreparedBody(
      context({ maxBytes: 10, tooLargeCode: "MEMO_TOO_LARGE" }),
      Buffer.from("this is far longer than ten bytes", "utf8"),
    );
    expect(routing.ok).toBe(false);
    if (!routing.ok) expect(routing.error.code).toBe("MEMO_TOO_LARGE");
  });
});

describe("causal legacy-unlink eligibility (section 3)", () => {
  it("defers an unlink while any pending activation names the same persisted path", () => {
    const verdict = planLegacyUnlinkEligibility(["artifacts/h1/a1/old.md", "content/memo/o1/c1"], {
      toPath: "artifacts/h1/a1/old.md",
    });
    expect(verdict).toEqual({ eligible: false, blockingActivateToPath: "artifacts/h1/a1/old.md" });
  });

  it("finds an unlink eligible when no pending activation names its path, and other paths never block", () => {
    expect(planLegacyUnlinkEligibility(["artifacts/h2/a2/other.md"], { toPath: "artifacts/h1/a1/old.md" })).toEqual({
      eligible: true,
      blockingActivateToPath: null,
    });
    expect(planLegacyUnlinkEligibility([], { toPath: "artifacts/h1/a1/old.md" })).toEqual({
      eligible: true,
      blockingActivateToPath: null,
    });
  });
});

describe("reference-proof record removal planning (SHR-004, SHR-008, sections 1 and 3)", () => {
  const inlineRecord: ContentRecord = {
    id: UUID,
    inlineText: "body",
    storageKey: null,
    sizeBytes: 4,
    sha256: "a".repeat(64),
    materialized: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const commonFileRecord: ContentRecord = {
    ...inlineRecord,
    id: "0123abcd-0000-4000-8000-0000000000c1",
    inlineText: null,
    storageKey: `content/memo/${OWNER}/0123abcd-0000-4000-8000-0000000000c1`,
    materialized: false,
  };
  const artifactFileRecord: ContentRecord = {
    ...commonFileRecord,
    id: "0123abcd-0000-4000-8000-0000000000c2",
    storageKey: `artifacts/${HANDOFF}/a1b2c3d4e/report.md`,
  };
  const emptyProof = {
    domainReferencedRecordIds: new Set<string>(),
    receiptReferencedRecordIds: new Set<string>(),
    pendingCommonActivationContentIds: new Set<string>(),
    pendingPhysicalToPaths: new Set<string>(),
    moveFencePaused: false,
  };

  it("removes an unreferenced inline record by the reference rule alone", () => {
    expect(planContentRecordRemoval(inlineRecord, emptyProof)).toEqual(ok({ action: "remove-inline" }));
  });

  it("schedules a content-keyed file row's unlink as a common intent and an artifact-keyed row's elsewhere", () => {
    expect(planContentRecordRemoval(commonFileRecord, emptyProof)).toEqual(
      ok({ action: "remove-record", physicalUnlink: "common-intent" }),
    );
    expect(planContentRecordRemoval(artifactFileRecord, emptyProof)).toEqual(
      ok({ action: "remove-record", physicalUnlink: "owed-elsewhere" }),
    );
  });

  it("refuses a file-backed record whose key is neither a managed content/ nor a managed artifacts/ key", () => {
    for (const storageKey of ["/outside/x.md", "../outside/x.md", "content//leaf"]) {
      const malformed: ContentRecord = {
        ...artifactFileRecord,
        id: "0123abcd-0000-4000-8000-0000000000d1",
        storageKey,
      };
      const refused = planContentRecordRemoval(malformed, emptyProof);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    }
  });

  it("retains a record on every proof reason, in a deterministic precedence", () => {
    expect(planContentRecordRemoval(inlineRecord, { ...emptyProof, moveFencePaused: true })).toEqual(
      ok({ action: "retain", reason: "move-fence" }),
    );
    expect(
      planContentRecordRemoval(inlineRecord, { ...emptyProof, domainReferencedRecordIds: new Set([UUID]) }),
    ).toEqual(ok({ action: "retain", reason: "domain-reference" }));
    expect(
      planContentRecordRemoval(inlineRecord, { ...emptyProof, receiptReferencedRecordIds: new Set([UUID]) }),
    ).toEqual(ok({ action: "retain", reason: "receipt-reference" }));
    expect(
      planContentRecordRemoval(inlineRecord, {
        ...emptyProof,
        pendingCommonActivationContentIds: new Set([UUID]),
      }),
    ).toEqual(ok({ action: "retain", reason: "pending-common-activation" }));
    expect(
      planContentRecordRemoval(artifactFileRecord, {
        ...emptyProof,
        pendingPhysicalToPaths: new Set([`artifacts/${HANDOFF}/a1b2c3d4e/report.md`]),
      }),
    ).toEqual(ok({ action: "retain", reason: "pending-physical-op" }));
  });
});
