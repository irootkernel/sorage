import { createHash } from "node:crypto";
import { buildStorageKey, isManagedStorageKey, isValidStorageKeySegment } from "./artifacts";
import { type AppError, appError, err, ok, type Result } from "./errors";
import type { CommonContentEventType } from "./events";
import { classifyMimeType } from "./import-policy";

/**
 * The shared content model and port of M9 (SHR-001 to SHR-006, SHR-008, SHR-011,
 * ADR-0030): one immutable content-record representation in which exactly one of
 * inline text and a managed Vault-relative storage key is present, byte size and
 * SHA-256 recorded over the exact accepted bytes, file-backed writes reusing the
 * existing intent machinery, and reference-aware cleanup as the only deleter.
 * Core owns the pure contract; the SQLite/filesystem mechanics live in adapters.
 */

/** The fixed normative routing threshold of SHR-002: 65,536 UTF-8 bytes. */
export const CONTENT_INLINE_MAX_UTF8_BYTES = 65_536;

/** The owner domains of file-backed shared content; Handoff Artifacts keep `artifacts/` (section 38.1). */
export const CONTENT_OWNER_DOMAINS = ["memo", "channel"] as const;
export type ContentOwnerDomain = (typeof CONTENT_OWNER_DOMAINS)[number];

export function isContentOwnerDomain(value: string): value is ContentOwnerDomain {
  return (CONTENT_OWNER_DOMAINS as readonly string[]).includes(value);
}

/** One authoritative content record: exactly one of inline text and a managed storage key (SHR-004). */
export interface ContentRecord {
  id: string;
  inlineText: string | null;
  storageKey: string | null;
  sizeBytes: number;
  /** Lowercase hexadecimal SHA-256 of the exact accepted bytes. */
  sha256: string;
  /** Meaningful only for file-backed rows; inline rows are pinned to materialized. */
  materialized: boolean;
  createdAt: string;
}

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

export function isLowercaseSha256(value: string): boolean {
  return LOWERCASE_SHA256.test(value);
}

/**
 * Validates one content record against the XOR contract of SHR-001 and SHR-004:
 * exactly one representation present, a nonempty managed key for the
 * file-backed form — a generic record may name the shared `content/` subtree or
 * the existing `artifacts/` subtree, while the common owner triple and
 * `CONTENT_*` events stay Memo/Channel-only — a nonnegative safe-integer size,
 * a lowercase 64-hex digest, and the single readability invariant that an
 * inline row is always materialized.
 */
export function validateContentRecord(record: ContentRecord): Result<void, AppError> {
  const inlinePresent = record.inlineText !== null;
  const filePresent = record.storageKey !== null;
  if (inlinePresent === filePresent) {
    return err(
      appError(
        "INTERNAL_ERROR",
        `Content record ${record.id} must carry exactly one of inline content and a storage key.`,
        { contentId: record.id },
      ),
    );
  }
  if (
    filePresent &&
    !(isManagedContentStorageKey(record.storageKey as string) || isManagedStorageKey(record.storageKey as string))
  ) {
    return err(
      appError("INTERNAL_ERROR", `Content record ${record.id} carries a non-managed storage key.`, {
        contentId: record.id,
        storageKey: record.storageKey,
      }),
    );
  }
  if (typeof record.sizeBytes !== "number" || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) {
    return err(
      appError("INTERNAL_ERROR", `Content record ${record.id} carries an invalid byte size.`, {
        contentId: record.id,
        sizeBytes: record.sizeBytes,
      }),
    );
  }
  if (typeof record.sha256 !== "string" || !LOWERCASE_SHA256.test(record.sha256)) {
    return err(
      appError("INTERNAL_ERROR", `Content record ${record.id} carries a malformed SHA-256.`, {
        contentId: record.id,
      }),
    );
  }
  if (typeof record.materialized !== "boolean") {
    return err(
      appError("INTERNAL_ERROR", `Content record ${record.id} carries a non-boolean materialized flag.`, {
        contentId: record.id,
      }),
    );
  }
  if (inlinePresent && !record.materialized) {
    return err(
      appError("INTERNAL_ERROR", `Inline content record ${record.id} must be materialized.`, {
        contentId: record.id,
      }),
    );
  }
  return ok(undefined);
}

export interface ContentStorageKeyParts {
  domain: ContentOwnerDomain;
  ownerId: string;
  contentId: string;
}

/**
 * Builds `content/<domain>/<owner-id>/<content-id>` (section 38.1). Every segment
 * passes the shared managed-key segment validation, so no traversal or separator
 * can ride a segment into a managed path.
 */
export function buildContentStorageKey(parts: ContentStorageKeyParts): Result<string, AppError> {
  const named: Array<[keyof ContentStorageKeyParts, string]> = [
    ["domain", parts.domain],
    ["ownerId", parts.ownerId],
    ["contentId", parts.contentId],
  ];
  for (const [name, value] of named) {
    if (typeof value !== "string" || !isValidStorageKeySegment(value)) {
      return err(
        appError("INTERNAL_ERROR", `The content storage key segment '${name}' is not a safe path segment.`, {
          segment: name,
        }),
      );
    }
  }
  if (!isContentOwnerDomain(parts.domain)) {
    return err(
      appError("INTERNAL_ERROR", `The content owner domain must be 'memo' or 'channel': ${String(parts.domain)}.`),
    );
  }
  return ok(`content/${parts.domain}/${parts.ownerId}/${parts.contentId}`);
}

/** True when a candidate is a managed `content/<domain>/<owner>/<record>` key with safe segments. */
export function isManagedContentStorageKey(candidate: string): boolean {
  if (!candidate.startsWith("content/")) return false;
  const segments = candidate.split("/").slice(1);
  if (segments.length !== 3) return false;
  const [domain] = segments as [string, string, string];
  if (!isContentOwnerDomain(domain)) return false;
  return segments.every((segment) => isValidStorageKeySegment(segment));
}

/**
 * The owner identity a content record's managed key carries by construction. The
 * key's record segment must equal the record id, so the owner is verified against
 * the row it names, never invented from an arbitrary pathname (section 10.1).
 */
export function contentOwnerFromStorageKey(record: {
  id: string;
  storageKey: string | null;
}): Result<{ domain: ContentOwnerDomain; ownerId: string }, AppError> {
  if (record.storageKey === null || !isManagedContentStorageKey(record.storageKey)) {
    return err(
      appError("INTERNAL_ERROR", `Content record ${record.id} has no managed key to derive an owner from.`, {
        contentId: record.id,
      }),
    );
  }
  const [domain, ownerId, contentId] = record.storageKey.split("/").slice(1) as [string, string, string];
  if (contentId !== record.id) {
    return err(
      appError(
        "INTERNAL_ERROR",
        `Content record ${record.id} has a storage key whose record segment names ${contentId}.`,
        { contentId: record.id },
      ),
    );
  }
  return ok({ domain: domain as ContentOwnerDomain, ownerId });
}

/** The exact UTF-8 byte length of a text body; the routing measure of SHR-002. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Fatal UTF-8 decoding for text-only surfaces; null when the bytes are not valid UTF-8 (SHR-002). The decoder preserves a byte-order mark, exactly as the Memo body-file rules do, because a BOM is accepted body content rather than a decoder directive to discard bytes. */
export function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type ContentTextRouting = { kind: "inline" | "vault"; sizeBytes: number };

/**
 * Routes a text body by the fixed threshold: text of at most 65,536 UTF-8 bytes
 * is inline, every larger accepted text body is Vault-backed (SHR-002). A
 * binary-classified body stays Vault-backed at every size; that classification
 * is the Handoff MIME policy's decision, not this function's.
 */
export function classifyTextRouting(text: string): ContentTextRouting {
  const sizeBytes = utf8ByteLength(text);
  return { kind: sizeBytes <= CONTENT_INLINE_MAX_UTF8_BYTES ? "inline" : "vault", sizeBytes };
}

/** SHA-256 over the exact UTF-8 bytes of a text body, the digest an inline record stores. */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** SHA-256 over exact bytes; the digest every content record stores (SHR-003). */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Guard for byte-exact inline storage: a JavaScript string that cannot round-trip
 * through UTF-8 (a lone surrogate) must be rejected by the accepting surface
 * before it reaches the store, because its stored bytes would not be its bytes.
 */
export function isUtf8ExactText(text: string): boolean {
  return decodeStrictUtf8(Buffer.from(text, "utf8")) === text;
}

/**
 * The derived inline fetch cache of SHR-006: `<state>/fetch-cache/<sha256>` inside
 * the existing `state` tree, one deterministic path per checksum so repeated
 * fetches reuse it. The file is never authoritative: a deleted entry is recreated
 * on the next fetch and a corrupted entry is replaced, never trusted.
 */
export const FETCH_CACHE_DIRECTORY = "fetch-cache";

export function fetchCacheRelativePath(sha256: string): Result<string, AppError> {
  if (!LOWERCASE_SHA256.test(sha256)) {
    return err(appError("INTERNAL_ERROR", "The fetch cache identity must be a lowercase SHA-256."));
  }
  return ok(`${FETCH_CACHE_DIRECTORY}/${sha256}`);
}

/** The closed failure reasons of a committed common-intent failure assessment (section 10.1). */
export const COMMON_CONTENT_FAILURE_REASONS = [
  "missing_content",
  "checksum_mismatch",
  "size_mismatch",
  "unsafe_path",
  "io_error",
  "destination_conflict",
] as const;
export type CommonContentFailureReason = (typeof COMMON_CONTENT_FAILURE_REASONS)[number];

export function isCommonContentFailureReason(value: string): value is CommonContentFailureReason {
  return (COMMON_CONTENT_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * Maps the legacy drain outcomes onto the common failure reasons for new common
 * intents only (section 10.1); existing Artifact intents keep their reason
 * strings and `ARTIFACT_INTEGRITY_FAILED` interpretations verbatim.
 */
export function mapLegacyDrainOutcome(
  outcome: "both-gone" | "destination-conflict" | "unsafe-path",
): CommonContentFailureReason {
  if (outcome === "both-gone") return "missing_content";
  if (outcome === "destination-conflict") return "destination_conflict";
  return "unsafe_path";
}

export interface CommonContentEventIdentity {
  contentId: string;
  ownerDomain: ContentOwnerDomain;
  ownerId: string;
  intentId: string;
  operation: "activate" | "unlink";
}

/**
 * The closed success metadata of the common physical-content family: exactly
 * `contentId`, `ownerDomain`, `ownerId`, `intentId`, and `operation`, with the
 * operation matching the event type (section 10.1).
 */
export function commonContentSuccessMetadata(identity: CommonContentEventIdentity): Record<string, unknown> {
  return {
    contentId: identity.contentId,
    ownerDomain: identity.ownerDomain,
    ownerId: identity.ownerId,
    intentId: identity.intentId,
    operation: identity.operation,
  };
}

export function commonContentFailureMetadata(
  identity: CommonContentEventIdentity,
  failure: { attempt: number; reason: CommonContentFailureReason },
): Record<string, unknown> {
  return {
    ...commonContentSuccessMetadata(identity),
    attempt: failure.attempt,
    reason: failure.reason,
  };
}

function isUuidShape(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** Legacy ownership stays absent; common ownership must be complete before any filesystem effect. */
export function classifyContentIntentOwnership(intent: {
  id: unknown;
  artifactId: unknown;
  ownerDomain?: unknown;
  ownerId?: unknown;
  contentId?: unknown;
}): "legacy" | "common" | "invalid" {
  const fields = [intent.ownerDomain, intent.ownerId, intent.contentId];
  if (fields.every((field) => field === null || field === undefined)) return "legacy";
  if (
    intent.artifactId !== null ||
    !isUuidShape(intent.id) ||
    (intent.ownerDomain !== "memo" && intent.ownerDomain !== "channel") ||
    !isUuidShape(intent.ownerId) ||
    !isUuidShape(intent.contentId)
  )
    return "invalid";
  return "common";
}

/** Stored ownership corruption cannot authorize legacy fallback or an invented common event. */
export function contentIntentIntegrityError(intentId: string): AppError {
  return {
    ...appError(
      "STORAGE_INTEGRITY_ERROR",
      `Filesystem intent ${intentId} has invalid content ownership; no filesystem or completion effect was authorized.`,
      { intentId },
    ),
    recovery: { suggestedCommand: "Preserve the intent and files; diagnose content ownership before retrying" },
  };
}

/**
 * Validates the closed metadata of one common physical-content event exactly as
 * the snapshot reader and the completion transaction must (section 10.1): the
 * success form carries exactly the five identity keys with the operation matching
 * the event type, and the failure form adds a positive safe-integer `attempt` and
 * one of the closed `reason` values. The identifiers are historical attribution
 * only; no live owner, record, or file lookup ever rides this validation.
 */
export function validateCommonContentEventMetadata(
  metadata: unknown,
  eventType: CommonContentEventType,
): Result<void, AppError> {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return err(appError("VAULT_INTEGRITY_ERROR", "Common content event metadata is not an object."));
  }
  const value = metadata as Record<string, unknown>;
  const failure = eventType === "CONTENT_INTEGRITY_FAILED";
  const allowed = failure
    ? ["contentId", "ownerDomain", "ownerId", "intentId", "operation", "attempt", "reason"]
    : ["contentId", "ownerDomain", "ownerId", "intentId", "operation"];
  const keys = Object.keys(value);
  if (!allowed.every((key) => Object.hasOwn(value, key)) || keys.some((key) => !allowed.includes(key))) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata does not carry its closed key set.`));
  }
  if (!isUuidShape(value.contentId) || !isUuidShape(value.ownerId) || !isUuidShape(value.intentId)) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries a non-UUID identifier.`));
  }
  if (typeof value.ownerDomain !== "string" || !isContentOwnerDomain(value.ownerDomain)) {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid ownerDomain.`));
  }
  if (value.operation !== "activate" && value.operation !== "unlink") {
    return err(appError("VAULT_INTEGRITY_ERROR", `The ${eventType} event metadata carries an invalid operation.`));
  }
  // Only the success families pin the operation to the event type (section 10.1):
  // a committed failure assessment may describe either a failed activation or a
  // failed unlink, whichever intent it assessed.
  if (!failure) {
    const expectedOperation = eventType === "CONTENT_UNLINKED" ? "unlink" : "activate";
    if (value.operation !== expectedOperation) {
      return err(
        appError(
          "VAULT_INTEGRITY_ERROR",
          `The ${eventType} event metadata names operation '${String(value.operation)}', expected '${expectedOperation}'.`,
        ),
      );
    }
  }
  if (failure) {
    if (
      typeof value.attempt !== "number" ||
      !Number.isSafeInteger(value.attempt) ||
      value.attempt < 1 ||
      typeof value.reason !== "string" ||
      !isCommonContentFailureReason(value.reason)
    ) {
      return err(
        appError("VAULT_INTEGRITY_ERROR", "The CONTENT_INTEGRITY_FAILED event metadata carries an invalid assessment."),
      );
    }
  }
  return ok(undefined);
}

/**
 * The reference providers of reference-aware cleanup (SHR-004, SHR-008, section
 * 38.1), immutable-record based: record identity protects rows, inline and
 * file-backed alike, for both current domain rows and unexpired retained
 * responses. Physical storage-key guards are a distinct concern the garbage
 * collector applies to files. A receipt that embeds an inline body string
 * references no record merely by that text: its copy is verbatim and its
 * original record is removable the moment no domain row names it.
 */
export interface ContentReferences {
  /**
   * Content-record ids current domain rows reference. No domain row references
   * a content record at schema 8; the adoption Tasks of TASK-107 and TASK-108
   * populate this provider, and tests inject positive references.
   */
  domainReferencedRecordIds(): Result<string[], AppError>;
  /**
   * Content-record ids unexpired retained responses reference through their
   * immutable records, so replay can still resolve the original bytes (SHR-008).
   * Schema-8 production receipts embed legacy outcomes and reference no content
   * record; the adoption Tasks introduce the reference format and its parser.
   */
  receiptReferencedRecordIds(now: Date): Result<string[], AppError>;
}

/**
 * The body a domain surface hands the shared store after its own surface
 * classification (section 38.2): exact accepted text from a text-only surface,
 * already fatally decoded with a byte-order mark preserved, or bytes a Handoff
 * surface classified as binary. The surface classifies; the store routes.
 */
export type ContentBodyInput = { kind: "text"; text: string } | { kind: "binary"; bytes: Uint8Array };

export interface WriteContentInput {
  body: ContentBodyInput;
  owner: { domain: ContentOwnerDomain; ownerId: string };
  /** The configured `artifact.maxBytes`, the shared accepted-body bound of every domain (SHR-002). */
  maxBytes: number;
  createdAt: string;
  /** The symbolic code a bound crossing surfaces as for this surface; the shared bound's existing code is the default. */
  tooLargeCode?: StageContentRequest["tooLargeCode"];
}

export interface WriteContentOutcome {
  recordId: string;
  representation: "inline" | "file";
  /** Null exactly when the representation is inline (SHR-001). */
  storageKey: string | null;
  sizeBytes: number;
  sha256: string;
  /** Present for the file representation: the activation state after the completion transaction. */
  activated?: "completed" | "failed-assessment";
  /** Present when `activated` is a durably recorded failed assessment the start-up drain keeps reporting. */
  failureReason?: CommonContentFailureReason;
  /** The `gitBackup.largeArtifactWarningBytes` disclosure seam extended to shared content (SHR-011). */
  largeContentWarning: boolean;
}

export interface StageContentRequest {
  sourcePath: string;
  /** The configured `artifact.maxBytes`, the shared accepted-body bound (SHR-002). */
  maxBytes: number;
  /**
   * The symbolic code a mid-stream bound crossing surfaces as; the shared bound's
   * existing code is `ARTIFACT_TOO_LARGE`, and a domain surface with its own
   * code in this build's catalogue passes it here. Channel ingestion selects
   * `CHN_TOO_LARGE` from TASK-109 on.
   */
  tooLargeCode?: "ARTIFACT_TOO_LARGE" | "MEMO_TOO_LARGE" | "CHN_TOO_LARGE";
}

export interface StagedContentFile {
  /** The staged path under `<Vault>/staging/`. */
  stagingPath: string;
  sizeBytes: number;
  sha256: string;
}

export interface WriteContentFileInput {
  owner: { domain: ContentOwnerDomain; ownerId: string };
  contentId: string;
  staged: StagedContentFile;
  createdAt: string;
  intentId: string;
}

export interface WriteInlineInput {
  contentId: string;
  text: string;
  createdAt: string;
}

export interface WriteInlineOutcome {
  recordId: string;
  sizeBytes: number;
  sha256: string;
}

export interface ContentRead {
  recordId: string;
  kind: "inline" | "file";
  /** The exact accepted bytes; inline bytes are the stored text's UTF-8 encoding. */
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
  materialized: boolean;
}

export interface ContentCleanupReport {
  /** Inline rows removed by the reference rule alone; no file, intent, or event. */
  removedInlineIds: string[];
  /** File-backed rows whose unlink intent committed; the drain executes and completes them. */
  scheduledUnlinkIds: string[];
  /**
   * File-backed rows removed without scheduling a common unlink: artifact-keyed records whose
   * physical removal is owed to the legacy Artifact unlink intent, never to the common store.
   */
  removedFileOnlyIds: string[];
}

/**
 * The application-level content interface of section 38.1: callers hand the
 * store accepted bytes or text and read complete content back; they never
 * select or inspect the physical backend. `write` is the application boundary
 * that owns routing under the fixed threshold — text of at most 65,536 UTF-8
 * bytes inline, larger text and every binary body in the Vault — while the
 * stage, file-record, and inline-record operations below it are the internal
 * transaction primitives a domain composition composes inside its own
 * UnitOfWork. The adapter binds both levels to SQLite and the Vault beside the
 * intent log.
 */
export interface ContentStore {
  /**
   * The backend-agnostic application boundary (SHR-001, SHR-002): classifies the
   * accepted body, routes it inline or Vault-backed, and completes file-backed
   * writes through the shared intent machinery in one durability order.
   */
  write(input: WriteContentInput): Result<WriteContentOutcome, AppError>;
  /** Streams a bounded copy into `staging/`, hashing in the same pass (SHR-002, SHR-012). */
  stage(request: StageContentRequest): Result<StagedContentFile, AppError>;
  /**
   * Commits one file-backed record and its activation intent in one transaction,
   * activates on the filesystem, and completes through the shared completion
   * transaction that appends `CONTENT_ACTIVATED` (SHR-005).
   */
  writeFile(input: WriteContentFileInput): Result<WriteContentOutcome, AppError>;
  /** Commits one inline record in a single transaction; inline content never creates files or physical events. */
  writeInline(input: WriteInlineInput): Result<WriteInlineOutcome, AppError>;
  /**
   * Reads the exact accepted bytes of one record: `CONTENT_MATERIALIZING` while a
   * file-backed record has not reached its key, `CONTENT_CORRUPTED` for missing or
   * checksum-mismatched bytes, never a synthesized success (SHR-005).
   */
  read(recordId: string): Result<ContentRead, AppError>;
  /**
   * Reference-aware cleanup, the only deleter of content records: a record is
   * removable exactly when no current domain row and no unexpired retained
   * response references it (SHR-004, SHR-008).
   */
  cleanup(references: ContentReferences, now: Date): Result<ContentCleanupReport, AppError>;
  /**
   * The uniform bounded read of TASK-107 (section 2 of the adopted plan): one
   * backend-independent handle over the exact accepted bytes with recorded
   * size/hash, bounded positional reads, explicit disposal, and an explicit
   * digest-verification policy. Inline bytes are always verified when opened
   * because they are bounded by the routing threshold; file-backed bodies are
   * hashed at open only when the policy demands it, so no hot fetch gains an
   * unconditional whole-file read.
   */
  openBody(recordId: string, policy: ContentBodyOpenPolicy): Result<ContentBodyHandle, AppError>;
  /**
   * The uniform local-path surface of SHR-006 and section 2: an inline record
   * lazily materializes its read-only checksum-addressed `state/fetch-cache/`
   * file, a file-backed record resolves its managed in-Vault path, and the
   * caller never chooses the physical backend. Path resolution alone is not a
   * checksum-verification claim.
   */
  materializeLocalPath(recordId: string, policy: ContentLocalPathPolicy): Result<string, AppError>;
  /**
   * The Handoff prepare seam of section 4: one routing implementation that
   * classifies by the logical original name's MIME allowlist, decodes text
   * fatally, and routes at the fixed threshold — inline for decodable text at
   * or below it, the Vault for binary at every size and for larger or
   * undecodable text — building the Artifact storage key from the supplied
   * identities. The adapter owns the bounded pre-read, the streamed staging of
   * Vault-routed bodies, and the `artifact.maxBytes` mid-stream bound.
   */
  prepareArtifactBody(request: ArtifactBodyPrepareRequest): Result<PreparedArtifactBody, AppError>;
}

/**
 * The closed prepare context of section 4: every source or text caller supplies
 * the logical name the MIME allowlist classifies, the sanitized stored name the
 * key is built from, the Handoff/Artifact identities, and the shared bound. The
 * MIME classification reads only this logical name — never a spool path's
 * extension and never a client-declared type.
 */
export interface BodyPrepareContext {
  /** The original or rule-produced name (for example `<title-slug>-<revision>.md`) the allowlist classifies. */
  logicalName: string;
  /** The sanitized segment-safe stored name used to build the Artifact storage key. */
  storedName: string;
  classification: "mime-first";
  handoffId: string;
  artifactId: string;
  maxBytes: number;
  tooLargeCode?: StageContentRequest["tooLargeCode"];
}

/** One routing decision over exact bytes: inline authoritative text, or the Vault for everything else. */
export type PreparedBodyRouting =
  | {
      kind: "inline";
      text: string;
      sizeBytes: number;
      sha256: string;
      mimeType: string;
      storageKey: null;
    }
  | {
      kind: "vault";
      mimeType: string;
      storageKey: string;
      text: null;
    };

/**
 * The one Handoff routing implementation (SHR-002, section 11 of
 * interfaces-and-operations): classification is by the logical name's MIME
 * allowlist first, so a binary-classified body stays Vault-backed at every size
 * even when its bytes decode as valid UTF-8; a text-classified body routes
 * inline only when it decodes fatally and fits the fixed threshold, and an
 * undecodable text-classified body falls back to the Vault because the Handoff
 * surface accepts binary documents. The caller supplies bytes already bounded
 * to at most the threshold; the adapter's staging pass owns the mid-stream
 * `artifact.maxBytes` enforcement for Vault-routed bodies.
 */
export function classifyPreparedBody(
  context: BodyPrepareContext,
  bytes: Uint8Array,
): Result<PreparedBodyRouting, AppError> {
  const tooLarge = context.tooLargeCode ?? "ARTIFACT_TOO_LARGE";
  if (bytes.byteLength > context.maxBytes) {
    return err(
      appError(
        tooLarge,
        `The accepted body crossed the shared bound artifact.maxBytes ${String(context.maxBytes)} bytes.`,
        {
          maxBytes: context.maxBytes,
          sizeBytes: bytes.byteLength,
        },
      ),
    );
  }
  const key = buildStorageKey({
    handoffId: context.handoffId,
    artifactId: context.artifactId,
    storedName: context.storedName,
  });
  if (!key.ok) return key;
  const mimeType = classifyMimeType(context.logicalName);
  if (mimeType === "application/octet-stream") {
    return ok({ kind: "vault", mimeType, storageKey: key.value, text: null });
  }
  const text = decodeStrictUtf8(bytes);
  if (text === null) {
    return ok({ kind: "vault", mimeType, storageKey: key.value, text: null });
  }
  const sizeBytes = utf8ByteLength(text);
  if (sizeBytes > CONTENT_INLINE_MAX_UTF8_BYTES) {
    return ok({ kind: "vault", mimeType, storageKey: key.value, text: null });
  }
  return ok({ kind: "inline", text, sizeBytes, sha256: sha256OfBytes(bytes), mimeType, storageKey: null });
}

/** The file-or-text body a Handoff surface hands prepare, with its logical identity (section 4). */
export type ArtifactBodySource =
  | { kind: "text"; text: string; logicalName: string }
  | {
      kind: "file";
      physicalPath: string;
      logicalOriginalName: string;
      sourceKind: "workspace-path" | "authenticated-spool";
    };

/** The closed prepare request every Handoff source or text caller supplies (section 4). */
export interface ArtifactBodyPrepareRequest {
  body: ArtifactBodySource;
  classification: "mime-first";
  identities: { handoffId: string; artifactId: string };
  bounds: { maxBytes: number; tooLargeCode?: StageContentRequest["tooLargeCode"] };
  provenance: { importedFromPath: string | null };
}

/** The prepared body a domain composition then records inline or activates through its legacy Artifact intent. */
export type PreparedArtifactBody =
  | {
      kind: "inline";
      text: string;
      sizeBytes: number;
      sha256: string;
      mimeType: string;
      storageKey: null;
      logicalName: string;
      importedFromPath: string | null;
    }
  | {
      kind: "file";
      stagingPath: string;
      sizeBytes: number;
      sha256: string;
      mimeType: string;
      storageKey: string;
      logicalName: string;
      importedFromPath: string | null;
    };

/** When a file-backed body is digest-verified at open: never for pure resolution, always at mandatory gates. */
export type ContentDigestVerification = "never" | "if-configured" | "always";

/** The explicit integrity policy of one bounded read (section 2): hot surfaces keep `verifyChecksumOnFetch` default-false. */
export interface ContentBodyOpenPolicy {
  verifyFileDigest: ContentDigestVerification;
  /** The existing `artifact.verifyChecksumOnFetch` setting, honored only under `if-configured`. */
  verifyChecksumOnFetch?: boolean;
}

/**
 * The uniform backend-independent read handle (section 2, section 11.3): the
 * opened body's authoritative byte length for both representations — the
 * fstat of the actually opened file for a file-backed row, the verified
 * inline length for an inline row — plus the recorded digest, bounded
 * positional reads, and explicit disposal. A read returns at most the
 * requested length and never buffers a whole large body; `position` at or
 * beyond the size reads empty.
 */
export interface ContentBodyHandle {
  readonly recordId: string;
  readonly representation: "inline" | "file";
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string | null;
  /** One bounded read of at most `maxLength` exact bytes starting at `position`; empty at end-of-body. */
  read(position: number, maxLength: number): Result<Uint8Array, AppError>;
  /** Releases every opened resource; safe to call more than once. */
  close(): void;
}

/** The local-path materialization policy: which resolved home's `state` tree carries the fetch cache. */
export interface ContentLocalPathPolicy {
  stateDir: string;
}

/** The eligibility verdict for one legacy unlink intent under the causal rule of section 3. */
export interface LegacyUnlinkEligibility {
  eligible: boolean;
  /** The persisted `to_path` of a still-pending activation that blocks this unlink, when one exists. */
  blockingActivateToPath: string | null;
}

/**
 * The causal eligibility primitive of section 3: a legacy unlink may take its
 * physical effect and clear only while no pending activation names the same
 * persisted `to_path`, because a later activation of that one-shot key would
 * otherwise recreate the retired file after the unlink completed. A failed
 * activation is still a pending activation — failure never releases its
 * dependent unlink.
 */
export function planLegacyUnlinkEligibility(
  pendingActivateToPaths: readonly string[],
  unlink: { toPath: string },
): LegacyUnlinkEligibility {
  const blocking = pendingActivateToPaths.find((toPath) => toPath === unlink.toPath) ?? null;
  return { eligible: blocking === null, blockingActivateToPath: blocking };
}

/** The reference/pending proof snapshot the shared removal planner decides on, read inside one transaction. */
export interface ContentRemovalProof {
  domainReferencedRecordIds: ReadonlySet<string>;
  receiptReferencedRecordIds: ReadonlySet<string>;
  /** Record ids named by still-pending common activation intents. */
  pendingCommonActivationContentIds: ReadonlySet<string>;
  /** Every persisted `to_path` a pending intent still names, the physical-key protection of section 3. */
  pendingPhysicalToPaths: ReadonlySet<string>;
  moveFencePaused: boolean;
}

/** What reference-aware cleanup may do with one record; `retain` always carries its reason. */
export type ContentRecordRemovalPlan =
  | { action: "remove-inline" }
  | { action: "remove-record"; physicalUnlink: "common-intent" | "owed-elsewhere" }
  | {
      action: "retain";
      reason:
        | "move-fence"
        | "domain-reference"
        | "receipt-reference"
        | "pending-common-activation"
        | "pending-physical-op";
    };

/**
 * The shared reference-proof removal decision of SHR-004, SHR-008, and sections
 * 1 and 3: a record is removable exactly when no current domain row, no
 * unexpired retained response, and no pending activation names it, and no
 * pending intent names its physical key. Inline rows are removed by the
 * reference rule alone; a `content/`-keyed file row's physical unlink is the
 * common intent; an `artifacts/`-keyed file row's physical removal is owed to
 * the legacy Artifact unlink intent elsewhere, never to a fabricated common
 * owner. A file-backed row whose key is neither a valid managed `content/` key
 * nor a valid managed `artifacts/` key is stored corruption: the decision fails
 * closed with `STORAGE_INTEGRITY_ERROR`, the row is preserved, and the caller
 * aborts its transaction — a malformed key is never silently deleted, mapped to
 * the legacy family, or given an inferred owner. Every caller — the memo/channel
 * cleanup and a Handoff domain transaction — decides through this one function.
 */
export function planContentRecordRemoval(
  record: ContentRecord,
  proof: ContentRemovalProof,
): Result<ContentRecordRemovalPlan, AppError> {
  if (proof.moveFencePaused) return ok({ action: "retain", reason: "move-fence" });
  if (proof.domainReferencedRecordIds.has(record.id)) return ok({ action: "retain", reason: "domain-reference" });
  if (proof.receiptReferencedRecordIds.has(record.id)) return ok({ action: "retain", reason: "receipt-reference" });
  if (proof.pendingCommonActivationContentIds.has(record.id)) {
    return ok({ action: "retain", reason: "pending-common-activation" });
  }
  if (record.storageKey !== null && proof.pendingPhysicalToPaths.has(record.storageKey)) {
    return ok({ action: "retain", reason: "pending-physical-op" });
  }
  if (record.inlineText !== null) return ok({ action: "remove-inline" });
  const key = record.storageKey as string;
  if (isManagedContentStorageKey(key)) {
    return ok({ action: "remove-record", physicalUnlink: "common-intent" });
  }
  if (isManagedStorageKey(key)) {
    return ok({ action: "remove-record", physicalUnlink: "owed-elsewhere" });
  }
  return err(
    appError(
      "STORAGE_INTEGRITY_ERROR",
      `Content record ${record.id} carries the storage key '${key}', which is neither a managed content/ key nor a managed artifacts/ key; preserve the record and files and diagnose the stored key before retrying.`,
      { contentId: record.id, storageKey: key },
    ),
  );
}
