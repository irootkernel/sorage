import { decodeCursor, encodeCursor, filterHash } from "./cursor";
import { appError, err, ok, type AppError, type Result } from "./errors";
import { buildContentStorageKey, CONTENT_INLINE_MAX_UTF8_BYTES, sha256OfText, utf8ByteLength } from "./content";
import type { Clock, IdGenerator } from "./ids";
import {
  changeMemoSnapshot,
  createMemoSnapshot,
  isMemoTimestamp,
  isMemoUuid,
  publicMemoOf,
  type MemoBodyRef,
  type MemoSnapshot,
  type MemoBodyReplacement,
} from "./memos";
import {
  memoPreviewOf,
  parseMemoCreate,
  parseMemoExecution,
  parseMemoListFilter,
  parseMemoStateRequest,
  parseMemoUpdate,
  type MemoExecution,
  type MemoPage,
  type MemoReceipt,
  type MemoStateRequest,
  type MemoSummary,
  type MemoUpdateRequest,
  type MemoCandidateDescriptor,
} from "./memo-protocol";
import type {
  MemoContentPlan,
  MemoListCapture,
  MemoReader,
  MemoRepository,
  MemoTransaction,
  MemoWriteOutcome,
  StoredMemoReceiptLookup,
} from "./memo-repository";
import {
  composeMemoRequestDigest,
  memoTextBodySource,
  type MemoBodyByteSource,
  type MemoHashRequest,
} from "./memo-request-hash";
import { resolveWorkspaceActor, type ProjectCommandPorts } from "./project-commands";

/**
 * The Memo application after shared-content adoption (SHR-001 to SHR-008,
 * MEM-005 to MEM-011, ADR-0032): one canonical request hash composed once over
 * once-captured accepted input, a finite preparation-coherence budget whose
 * every attempt captures the connection-local external-commit version before
 * its fresh Vault binding and staging, metadata-only write transactions whose
 * file plans activate after commit behind the known runDir gate and whose
 * receipts — fresh outcomes and immutable references alike — commit atomically
 * with the domain rows, bounded own-page list capture against the same fresh
 * binding, and replay that resolves immutable references without ever
 * re-storing receipts or extending expiry.
 */

/** One accepted Memo body captured once at the transport boundary (ADR-0032 plan). */
export type AcceptedMemoBody =
  | { kind: "text"; text: string; sizeBytes: number; sha256: string }
  | { kind: "spool"; spoolPath: string; sizeBytes: number; sha256: string };

/** The bounded body readers and scanners backed by the shared content store. */
export interface MemoBodyPorts {
  /** Streams an accepted spool's exact bytes in bounded chunks for the request hash. */
  spoolSource(spoolPath: string): MemoBodyByteSource;
  /** Bounded literal scan of one immutable record's bytes against the bound Vault. */
  scanBodyForQuery(ref: MemoBodyRef, query: string, binding: { vaultPath: string }): Result<boolean, AppError>;
  /** Reads and fatally decodes the record's bounded head bytes for the shared preview rule. */
  readBodyPreviewSeed(ref: MemoBodyRef, binding: { vaultPath: string }): Result<string, AppError>;
  /** Resolves a record's complete exact text outside any transaction, honestly reporting materializing and corrupt bytes. */
  resolveBody(ref: MemoBodyRef, binding: { vaultPath: string }): Result<string, AppError>;
}

/** The connection-local operation-coherence seam of ADR-0032. */
export interface MemoCoherencePorts {
  /** The same-connection external-commit counter, captured before each attempt's fresh binding. */
  captureExternalVersion(): Result<number, AppError>;
  /** Classifies an external-change mismatch after the transaction rolled back. */
  classifyExternalChange(
    expectedVaultPath: string,
  ): Result<"vault-move-held" | "vault-path-changed" | "external-commit", AppError>;
  /** The known runDir's vault-move.lock liveness: the write entry gate and the post-commit activation gate. */
  moveLockHeld(): boolean;
}

/** The per-attempt fresh Vault binding plus the staging and activation seams. */
export interface MemoStagingPorts {
  freshBinding(): Result<{ vaultPath: string }, AppError>;
  /**
   * Stages one accepted body's exact bytes into the bound Vault's `staging/`
   * tree — a spool by streamed copy, an in-memory text by chunked encoding —
   * never a whole-body buffer; the staged file is reused while the binding holds.
   */
  stageAccepted(
    accepted: AcceptedMemoBody,
    binding: { vaultPath: string },
  ): Result<{ stagedPath: string; sizeBytes: number; sha256: string }, AppError>;
  /** The post-commit activation gate and shared completion transaction; `paused` leaves the committed intent durably pending. */
  activateContent(
    input: {
      intentId: string;
      contentId: string;
      ownerMemoId: string;
      stagedPath: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    },
    binding: { vaultPath: string },
  ): Result<{ status: "completed" } | { status: "paused" }, AppError>;
}

export interface MemoCommandPorts {
  installationId: string;
  /** The current `artifact.maxBytes` accepting bound for this installation. */
  maxBytes: number;
  memos: MemoRepository;
  bodies: MemoBodyPorts;
  coherence: MemoCoherencePorts;
  staging: MemoStagingPorts;
  clock: Clock;
  ids: IdGenerator;
  defaultPageSize: number;
  /**
   * The optional large-content Git-history disclosure seam of SHR-011 and
   * interface section 38.7: the production compositions supply the configured
   * `gitBackup.enabled` and `gitBackup.largeArtifactWarningBytes`, and the
   * notification fires once, strictly after the fresh body's SQL commit and
   * strictly before activation or body resolution, so a committed write that
   * later reports an activation or resolution boundary still disclosed its
   * Git-history growth. Metadata-only arguments; a throwing or failing sink
   * never changes the committed outcome, the activation path, or the exit
   * code (WR2).
   */
  disclosures?: {
    backupEnabled: boolean;
    thresholdBytes: number;
    largeContent(sizeBytes: number, thresholdBytes: number): void;
  };
}

/** The finite preparation-coherence budget and list-restart bound of ADR-0032. */
export const MEMO_WRITE_ATTEMPTS = 3;
export const MEMO_LIST_ATTEMPTS = 2;
/** The bounded list-capture batch size: the repository reads at most this many candidate descriptors per short transaction. */
export const MEMO_LIST_BATCH = 200;
/** The original retained-response window: receipts expire 24 hours after their commit. */
export const MEMO_RECEIPT_RETENTION_MS = 86_400_000;

const unavailable = () =>
  err(appError("MEMO_REPLAY_UNAVAILABLE", "No retained Memo receipt; the original outcome is unknown"));
const notFound = () => err(appError("MEMO_NOT_FOUND", "Memo does not exist in the selected Project"));
const invalid = () => err(appError("MEMO_INVALID_INPUT", "Invalid Memo identity or execution context"));

function context(ports: MemoCommandPorts): Result<void> {
  return isMemoUuid(ports.installationId) ? ok(undefined) : invalid();
}

/** Explicit-only Project selection; only CLI inference uses native workspace resolution. */
export function resolveMemoProject(
  ports: ProjectCommandPorts,
  selector: string | undefined,
  currentDirectory?: { path: string; userHome: string },
): Result<string> {
  if (selector !== undefined) {
    // CLI --project is a slug, including valid slugs that happen to look like UUIDs.
    const project = ports.projects.findProjectBySlug(selector);
    if (!project.ok) return project;
    if (project.value) return ok(project.value.id);
    if (isMemoUuid(selector)) {
      const projects = ports.projects.listProjects();
      if (!projects.ok) return projects;
      return projects.value.some((project) => project.id === selector)
        ? ok(selector)
        : err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
    }
    return err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
  }
  if (currentDirectory) {
    const resolved = resolveWorkspaceActor(ports, currentDirectory);
    if (!resolved.ok) return resolved;
    if (resolved.value.kind === "registered_project") return ok(resolved.value.project.id);
  }
  return err(appError("PROJECT_NOT_FOUND", "Select or register a Project for Memos"));
}

/** Wraps an already-validated body string as the captured accepted text input. */
export function acceptedTextBody(text: string): AcceptedMemoBody {
  return { kind: "text", text, sizeBytes: utf8ByteLength(text), sha256: sha256OfText(text) };
}

function bodySourceOf(ports: MemoCommandPorts, accepted: AcceptedMemoBody): MemoBodyByteSource {
  return accepted.kind === "text" ? memoTextBodySource(accepted.text) : ports.bodies.spoolSource(accepted.spoolPath);
}

function isCoherenceMismatch(error: AppError): boolean {
  return (
    error.details !== null &&
    typeof error.details === "object" &&
    (error.details as Record<string, unknown>).coherenceMismatch === true
  );
}

function paused(): AppError {
  return appError(
    "SERVICE_PAUSED",
    "A Vault move or restore is in progress; the Memo write paused instead of racing it",
  );
}

/** One retained lookup or fresh outcome before its body is resolved for the response. */
type PendingReceipt =
  | { kind: "replay"; memo: MemoSnapshot; changed: boolean }
  | { kind: "fresh"; outcome: MemoWriteOutcome; binding: { vaultPath: string } };

/** The committed-failure recovery that never suggests a repeated create or a replacement key. */
function committedRecovery(execution: MemoExecution, memoId: string): { suggestedCommand: string } {
  return execution.idempotencyKey === undefined
    ? {
        suggestedCommand: `The Memo ${memoId} was committed; after the next process start drains the intent, run sorage memo show ${memoId}`,
      }
    : {
        suggestedCommand:
          "The Memo write is committed; retain the original key and input and inspect with replay-only after the next process start drains the intent; do not execute a new request or replace the key",
      };
}

/**
 * Resolves one snapshot's body for the public receipt. A fresh file-backed
 * outcome resolves after its activation attempt, so an unmaterialized record
 * reports the committed `CONTENT_MATERIALIZING` boundary honestly and any
 * other resolution failure reports a committed write with the original-key
 * recovery — never a repeated create, never a fabricated body (SHR-005,
 * SHR-008, ADR-0032).
 */
function resolveReceipt(
  ports: MemoCommandPorts,
  pending: PendingReceipt,
  execution: MemoExecution,
): Result<MemoReceipt> {
  const snapshot = pending.kind === "replay" ? pending.memo : pending.outcome.memo;
  const changed = pending.kind === "replay" ? pending.changed : pending.outcome.changed;
  if (snapshot.body !== null) {
    return ok({ memo: publicMemoOf(snapshot), changed, replayed: pending.kind === "replay" });
  }
  // A mover can complete after the domain commit and activation. Resolve the
  // response from the current binding, never the pre-commit Vault's retained copy.
  const binding = ports.staging.freshBinding();
  if (!binding.ok) {
    return err({
      ...binding.error,
      details: { ...(binding.error.details ?? {}), memoId: snapshot.id },
      message: `The ${pending.kind === "replay" ? "original " : ""}Memo write is committed; its body could not be resolved: ${binding.error.message}`,
      recovery: committedRecovery(execution, snapshot.id),
    });
  }
  const resolved = ports.bodies.resolveBody(snapshot.bodyRef, binding.value);
  if (!resolved.ok) {
    const details: Record<string, unknown> = { memoId: snapshot.id };
    if (resolved.error.code === "CONTENT_MATERIALIZING") {
      return pending.kind === "replay"
        ? err({
            ...resolved.error,
            recovery: {
              suggestedCommand:
                "Retry after the next process start drains the intent; the retained receipt is unchanged",
            },
          })
        : err({
            ...resolved.error,
            message: "The Memo write is committed; its body has not reached its storage key yet",
            details,
            recovery: committedRecovery(execution, snapshot.id),
          });
    }
    return err({
      ...resolved.error,
      details,
      message: `The ${pending.kind === "replay" ? "original " : ""}Memo write is committed; its body could not be resolved: ${resolved.error.message}`,
      recovery: committedRecovery(execution, snapshot.id),
    });
  }
  return ok({
    memo: publicMemoOf({ ...snapshot, body: resolved.value }),
    changed,
    replayed: pending.kind === "replay",
  });
}

/** The write transaction's result: a fresh outcome, or a retained receipt found before any work. */
type TransactionOutcome =
  | { kind: "fresh"; outcome: MemoWriteOutcome }
  | { kind: "replay"; lookup: StoredMemoReceiptLookup };

/** Routes one accepted body by the fixed threshold (SHR-002). */
function routesFile(accepted: AcceptedMemoBody): boolean {
  return accepted.sizeBytes > CONTENT_INLINE_MAX_UTF8_BYTES;
}

function keepPlan(): MemoContentPlan {
  return { kind: "keep" };
}

/** Builds the file plan's managed key; the caller supplies fresh identities. */
function fileStorageKey(ownerMemoId: string, contentId: string): Result<string, AppError> {
  return buildContentStorageKey({ domain: "memo", ownerId: ownerMemoId, contentId });
}

/**
 * The finite preparation-coherence write loop (ADR-0032): each attempt captures
 * the external-commit version before the fresh binding, stages a file-routed
 * accepted body into the freshly bound Vault, and commits the domain rows, the
 * content plan, the event, and — when a key is present — the receipt in one
 * transaction behind the fence and version guards. A mismatch classifies into
 * a pause, a restage, or a plain restart, and exhaustion reports exactly the
 * condition that last occurred. A retained receipt inside the transaction
 * replays without any re-storage or expiry refresh.
 */
function executeCoherent(
  ports: MemoCommandPorts,
  execution: MemoExecution,
  hash: string,
  bodyAccepted: AcceptedMemoBody | null,
  work: (tx: MemoTransaction, now: string, staged: { stagedPath: string } | null) => Result<MemoWriteOutcome>,
): Result<PendingReceipt> {
  const scope = `memo:${ports.installationId}:user`;
  const key = execution.idempotencyKey;
  let staged: { vaultPath: string; stagedPath: string } | null = null;
  let lastClass: "vault-path-changed" | "external-commit" = "external-commit";
  for (let attempt = 0; attempt < MEMO_WRITE_ATTEMPTS; attempt++) {
    if (ports.coherence.moveLockHeld()) return err(paused());
    const version = ports.coherence.captureExternalVersion();
    if (!version.ok) return version;
    const binding = ports.staging.freshBinding();
    if (!binding.ok) return binding;
    if (
      bodyAccepted !== null &&
      routesFile(bodyAccepted) &&
      (staged === null || staged.vaultPath !== binding.value.vaultPath)
    ) {
      const stage = ports.staging.stageAccepted(bodyAccepted, binding.value);
      if (!stage.ok) return stage;
      if (stage.value.sizeBytes !== bodyAccepted.sizeBytes || stage.value.sha256 !== bodyAccepted.sha256) {
        return err(appError("STORAGE_INTEGRITY_ERROR", "The accepted Memo body changed before staging completed"));
      }
      staged = { vaultPath: binding.value.vaultPath, stagedPath: stage.value.stagedPath };
    }
    const run = ports.memos.run(
      (tx): Result<TransactionOutcome> => {
        const now = ports.clock.now().toISOString();
        if (key !== undefined) {
          const stored = replayLookup(tx, key, scope, hash, now);
          if (!stored.ok) return stored;
          if (stored.value !== null) return ok({ kind: "replay", lookup: stored.value });
        }
        const outcome = work(tx, now, staged === null ? null : { stagedPath: staged.stagedPath });
        if (!outcome.ok) return outcome;
        // The receipt commits atomically with the fresh outcome — including a
        // committed no-op — and a retained receipt is returned without any
        // re-storage or expiry refresh (MEM-007).
        if (key !== undefined) {
          const expiresAt = new Date(Date.parse(now) + MEMO_RECEIPT_RETENTION_MS).toISOString();
          const stored = tx.storeReceipt(
            key,
            scope,
            hash,
            { memo: outcome.value.memo, changed: outcome.value.changed },
            now,
            expiresAt,
          );
          if (!stored.ok) return stored;
        }
        return ok({ kind: "fresh", outcome: outcome.value });
      },
      { expectedExternalVersion: version.value },
    );
    if (run.ok) {
      if (run.value.kind === "replay") {
        return ok({
          kind: "replay",
          memo: run.value.lookup.memo,
          changed: run.value.lookup.changed,
        });
      }
      return finishWrite(ports, { kind: "fresh", outcome: run.value.outcome, binding: binding.value }, execution);
    }
    if (isCoherenceMismatch(run.error)) {
      const classified = ports.coherence.classifyExternalChange(binding.value.vaultPath);
      if (!classified.ok) return classified;
      if (classified.value === "vault-move-held") return err(paused());
      lastClass = classified.value;
      continue;
    }
    return err(run.error);
  }
  if (lastClass === "vault-path-changed") {
    return err({
      ...appError("CONFIG_CONFLICT", "The Vault path kept changing while this Memo write was being prepared"),
      recovery: { suggestedCommand: "Reload the configuration and retry the identical request" },
    });
  }
  const keyless = key === undefined;
  return err({
    ...appError(
      "STORAGE_INSPECTION_UNAVAILABLE",
      "A coherent storage state could not be established while this Memo write was being prepared; this invocation committed nothing",
    ),
    recovery: {
      suggestedCommand: keyless
        ? "Retry the identical request; no Memo was committed by this invocation"
        : "Retry the identical request with its original mode, inputs, and key; this invocation committed nothing and settles no earlier unknown outcome",
    },
  });
}

/** The common large-content Git-history disclosure wording every surface shares (SHR-011, WR2). */
export function largeContentDisclosureMessage(sizeBytes: number, thresholdBytes: number): string {
  return `The accepted body is ${String(sizeBytes)} bytes, above gitBackup.largeArtifactWarningBytes (${String(
    thresholdBytes,
  )} bytes); with Git backup enabled, Git history keeps every committed revision of that body forever`;
}

/** Fires the post-commit disclosure exactly when a fresh changed outcome committed a new body plan (WR2). */
function discloseLargeContent(ports: MemoCommandPorts, outcome: MemoWriteOutcome): void {
  const disclosures = ports.disclosures;
  if (disclosures === undefined || !disclosures.backupEnabled) return;
  if (!outcome.changed || outcome.content.kind === "keep") return;
  const sizeBytes = outcome.content.sizeBytes;
  if (!(sizeBytes > disclosures.thresholdBytes)) return;
  try {
    disclosures.largeContent(sizeBytes, disclosures.thresholdBytes);
  } catch {
    // A diagnostic sink failure never changes the committed outcome.
  }
}

/** The post-commit half: disclosure, activation gate, shared completion, and the fresh outcome handoff. */
function finishWrite(
  ports: MemoCommandPorts,
  pending: { kind: "fresh"; outcome: MemoWriteOutcome; binding: { vaultPath: string } },
  execution: MemoExecution,
): Result<PendingReceipt> {
  const { content, intentId, memo } = pending.outcome;
  // The disclosure runs immediately after the SQL commit and before the
  // activation attempt or any body resolution, so a later CONTENT_MATERIALIZING
  // or resolution failure still disclosed the committed body's growth (WR2).
  discloseLargeContent(ports, pending.outcome);
  if (content.kind === "file" && intentId !== null) {
    const activation = ports.staging.activateContent(
      {
        intentId,
        contentId: content.contentId,
        ownerMemoId: memo.id,
        stagedPath: content.stagedPath,
        storageKey: content.storageKey,
        sizeBytes: content.sizeBytes,
        sha256: content.sha256,
      },
      pending.binding,
    );
    if (!activation.ok) {
      return err({
        ...activation.error,
        details: { ...(activation.error.details ?? {}), memoId: memo.id },
        message: `The Memo write is committed; its activation could not complete: ${activation.error.message}`,
        recovery: committedRecovery(execution, memo.id),
      });
    }
    // `paused` and a durably recorded failed assessment both leave the intent
    // pending; the uniform output resolution reports the honest boundary.
  }
  return ok(pending);
}

function replayLookup(
  reader: MemoReader,
  key: string,
  scope: string,
  hash: string,
  now: string,
): Result<StoredMemoReceiptLookup | null> {
  const stored = reader.receipt(key, scope, now);
  if (!stored.ok) return stored;
  if (stored.value === null) return ok(null);
  if (stored.value.requestHash !== hash)
    return err(appError("IDEMPOTENCY_CONFLICT", "Memo key belongs to another request"));
  return ok(stored.value);
}

/** One semantic identity and one durable authority for every public transport. */
function execute(
  ports: MemoCommandPorts,
  hashRequest: MemoHashRequest,
  bodyAccepted: AcceptedMemoBody | null,
  execution: MemoExecution,
  work: (tx: MemoTransaction, now: string, staged: { stagedPath: string } | null) => Result<MemoWriteOutcome>,
): Result<PendingReceipt> {
  const checked = context(ports);
  if (!checked.ok) return checked;
  const policy = parseMemoExecution([execution.mode], execution.idempotencyKey, true);
  if (!policy.ok) return err(policy.error);
  if (bodyAccepted !== null && bodyAccepted.sizeBytes > ports.maxBytes) {
    return err(appError("MEMO_TOO_LARGE", `Memo body exceeds ${String(ports.maxBytes)} UTF-8 bytes`));
  }
  const composed = composeMemoRequestDigest(
    hashRequest,
    bodyAccepted === null ? { present: false } : { present: true, source: bodySourceOf(ports, bodyAccepted) },
  );
  if (!composed.ok) return composed;
  if (bodyAccepted !== null && composed.value.bodyBytes !== bodyAccepted.sizeBytes) {
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        "The accepted Memo body changed after capture; the request identity cannot be recomputed",
      ),
    );
  }
  const hash = composed.value.digest;
  if (policy.value.mode === "replay-only") {
    // Clock sampling occurs inside the consistent, fenced read transaction; a
    // retained receipt returns without re-storage or expiry refresh. Its
    // file-backed reference resolves against a fresh binding after the read.
    const inspected = ports.memos.inspect((reader) =>
      replayLookup(
        reader,
        policy.value.idempotencyKey as string,
        `memo:${ports.installationId}:user`,
        hash,
        ports.clock.now().toISOString(),
      ),
    );
    if (!inspected.ok) return inspected;
    if (inspected.value === null) return unavailable();
    return ok({ kind: "replay", memo: inspected.value.memo, changed: inspected.value.changed });
  }
  return executeCoherent(ports, policy.value, hash, bodyAccepted, work);
}

export function addMemo(
  ports: MemoCommandPorts,
  input: unknown,
  execution: MemoExecution = { mode: "execute" },
  accepted?: AcceptedMemoBody,
): Result<MemoReceipt> {
  const request = parseMemoCreate(input, ports.maxBytes);
  if (!request.ok) return request;
  const { projectId, title } = request.value;
  const hasInlineBody = Object.hasOwn(input as Record<string, unknown>, "body");
  if (accepted !== undefined && hasInlineBody) return invalid();
  const body: AcceptedMemoBody = accepted ?? acceptedTextBody(request.value.body);
  const pending = execute(
    ports,
    { kind: "add", operation: "add", installationId: ports.installationId, projectId, title },
    body,
    execution,
    (tx, now, staged) => {
      const project = tx.projectStatus(projectId);
      if (!project.ok) return project;
      if (!project.value) return err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
      if (project.value === "archived")
        return err(appError("PROJECT_ARCHIVED", "Cannot add a Memo to an archived Project"));
      const memoId = ports.ids.next();
      let plan: MemoContentPlan;
      if (routesFile(body)) {
        if (staged === null) {
          return err(
            appError(
              "INTERNAL_ERROR",
              "A Vault-routed Memo body requires its staged file before the write transaction",
            ),
          );
        }
        const contentId = ports.ids.next();
        const key = fileStorageKey(memoId, contentId);
        if (!key.ok) return key;
        plan = {
          kind: "file",
          contentId,
          intentId: ports.ids.next(),
          stagedPath: staged.stagedPath,
          storageKey: key.value,
          sizeBytes: body.sizeBytes,
          sha256: body.sha256,
        };
      } else {
        plan = {
          kind: "inline",
          contentId: ports.ids.next(),
          text: body.kind === "text" ? body.text : "",
          sizeBytes: body.sizeBytes,
          sha256: body.sha256,
        };
      }
      const replacement: MemoBodyReplacement =
        plan.kind === "file"
          ? { kind: "file", identity: { recordId: plan.contentId, sizeBytes: plan.sizeBytes, sha256: plan.sha256 } }
          : { kind: "inline", text: plan.kind === "inline" ? plan.text : "" };
      const created = createMemoSnapshot(memoId, projectId, { title, body: replacement }, now);
      if (!created.ok) return created;
      const memo: MemoSnapshot =
        plan.kind === "inline"
          ? { ...created.value.memo, bodyRef: { ...created.value.memo.bodyRef, recordId: plan.contentId } }
          : created.value.memo;
      const committed = tx.commitContent(plan, memoId, now);
      if (!committed.ok) return committed;
      const inserted = tx.insertMemo(memo);
      if (!inserted.ok) return inserted;
      if (created.value.event !== null) {
        const appended = tx.appendEvent(ports.ids.next(), created.value.event);
        if (!appended.ok) return appended;
      }
      return ok({
        memo,
        changed: true,
        event: created.value.event,
        content: plan,
        intentId: plan.kind === "file" ? plan.intentId : null,
      });
    },
  );
  return finishReceipt(ports, pending, execution);
}

export type MemoMutation = "update" | "done" | "dismiss" | "reopen";

/**
 * The accepted-body policy (SHR-002, MEM-012): exactly one body source per
 * request — an inline `body` field in the request object or a transport-held
 * accepted input, never both; a supplied accepted input counts as the update's
 * body-bearing change even though the normalized request object carries no
 * `body` field; state operations take no body at all.
 */
export function mutateMemo(
  ports: MemoCommandPorts,
  operation: MemoMutation,
  id: string,
  input: unknown,
  execution: MemoExecution = { mode: "execute" },
  accepted?: AcceptedMemoBody,
): Result<MemoReceipt> {
  if (!isMemoUuid(id) || !["update", "done", "dismiss", "reopen"].includes(operation)) return invalid();
  if (operation !== "update" && accepted !== undefined) return invalid();
  // The presence probe guards its input type first: a null or non-object input
  // keeps its `MEMO_INVALID_INPUT` behavior instead of throwing (MEM-013).
  const hasBodyField =
    operation === "update" &&
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input as Record<string, unknown>, "body");
  const parsed =
    operation === "update"
      ? parseMemoUpdate(input, ports.maxBytes, { externalBody: accepted !== undefined })
      : parseMemoStateRequest(input);
  if (!parsed.ok) return parsed;
  const fields = parsed.value as MemoUpdateRequest;
  if (accepted !== undefined && hasBodyField) return invalid();
  const body: AcceptedMemoBody | null =
    operation !== "update"
      ? null
      : accepted !== undefined
        ? accepted
        : hasBodyField
          ? acceptedTextBody(fields.body as string)
          : null;
  const hashRequest: MemoHashRequest =
    operation === "update"
      ? {
          kind: "update",
          operation: "update",
          installationId: ports.installationId,
          id,
          ...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
          expectedRowVersion: fields.expectedRowVersion,
          ...(fields.title === undefined ? {} : { title: fields.title }),
        }
      : {
          kind: "state",
          operation,
          installationId: ports.installationId,
          id,
          ...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
          expectedRowVersion: fields.expectedRowVersion,
        };
  const pending = execute(ports, hashRequest, body, execution, (tx, now, staged) => {
    const current = tx.get(id);
    if (!current.ok) return current;
    if (!current.value || (fields.projectId !== undefined && fields.projectId !== current.value.projectId))
      return notFound();
    // Route the accepted body before the lifecycle calculation so the replacement carries its final record identity.
    let routedFile = false;
    let replacement: MemoBodyReplacement | undefined;
    let contentId = "";
    if (body !== null) {
      if (routesFile(body)) {
        routedFile = true;
        contentId = ports.ids.next();
        replacement = {
          kind: "file",
          identity: { recordId: contentId, sizeBytes: body.sizeBytes, sha256: body.sha256 },
        };
      } else {
        contentId = ports.ids.next();
        replacement = { kind: "inline", text: body.kind === "text" ? body.text : "" };
      }
    }
    const change =
      operation === "update"
        ? {
            operation: "update" as const,
            expectedRowVersion: fields.expectedRowVersion,
            ...(fields.title === undefined ? {} : { title: fields.title }),
            ...(replacement === undefined ? {} : { body: replacement }),
          }
        : { operation, expectedRowVersion: fields.expectedRowVersion };
    const changed = changeMemoSnapshot(current.value, change, now);
    if (!changed.ok) return changed;
    if (!changed.value.changed) {
      return ok({ memo: current.value, changed: false, event: null, content: keepPlan(), intentId: null });
    }
    if (operation === "reopen") {
      const project = tx.projectStatus(current.value.projectId);
      if (!project.ok) return project;
      if (project.value === "archived")
        return err(appError("PROJECT_ARCHIVED", "Cannot reopen a Memo in an archived Project"));
    }
    let memo = changed.value.memo;
    let plan: MemoContentPlan = keepPlan();
    if (replacement !== undefined) {
      if (routedFile) {
        if (staged === null) {
          return err(
            appError(
              "INTERNAL_ERROR",
              "A Vault-routed Memo body requires its staged file before the write transaction",
            ),
          );
        }
        const key = fileStorageKey(memo.id, contentId);
        if (!key.ok) return key;
        plan = {
          kind: "file",
          contentId,
          intentId: ports.ids.next(),
          stagedPath: staged.stagedPath,
          storageKey: key.value,
          sizeBytes: body === null ? 0 : body.sizeBytes,
          sha256: body === null ? "" : body.sha256,
        };
      } else {
        plan = {
          kind: "inline",
          contentId,
          text: body === null ? "" : body.kind === "text" ? body.text : "",
          sizeBytes: body === null ? 0 : body.sizeBytes,
          sha256: body === null ? "" : body.sha256,
        };
        memo = { ...memo, bodyRef: { ...memo.bodyRef, recordId: contentId } };
      }
      const committed = tx.commitContent(plan, memo.id, now);
      if (!committed.ok) return committed;
    }
    const written = tx.compareAndSetMemo(memo, fields.expectedRowVersion);
    if (!written.ok) return written;
    if (changed.value.event !== null) {
      const event = tx.appendEvent(ports.ids.next(), changed.value.event);
      if (!event.ok) return event;
    }
    return ok({
      memo,
      changed: true,
      event: changed.value.event,
      content: plan,
      intentId: plan.kind === "file" ? plan.intentId : null,
    });
  });
  return finishReceipt(ports, pending, execution);
}

function finishReceipt(
  ports: MemoCommandPorts,
  pending: Result<PendingReceipt>,
  execution: MemoExecution,
): Result<MemoReceipt> {
  if (!pending.ok) return pending;
  return resolveReceipt(ports, pending.value, execution);
}

export const updateMemo = (
  ports: MemoCommandPorts,
  id: string,
  input: unknown,
  execution?: MemoExecution,
  accepted?: AcceptedMemoBody,
) => mutateMemo(ports, "update", id, input, execution, accepted);
export const doneMemo = (ports: MemoCommandPorts, id: string, input: MemoStateRequest, execution?: MemoExecution) =>
  mutateMemo(ports, "done", id, input, execution);
export const dismissMemo = (ports: MemoCommandPorts, id: string, input: MemoStateRequest, execution?: MemoExecution) =>
  mutateMemo(ports, "dismiss", id, input, execution);
export const reopenMemo = (ports: MemoCommandPorts, id: string, input: MemoStateRequest, execution?: MemoExecution) =>
  mutateMemo(ports, "reopen", id, input, execution);

export function showMemo(ports: MemoCommandPorts, id: string, projectId?: string): Result<MemoReceipt["memo"]> {
  const checked = context(ports);
  if (!checked.ok) return checked;
  if (!isMemoUuid(id) || (projectId !== undefined && !isMemoUuid(projectId))) return invalid();
  const found = ports.memos.get(id);
  if (!found.ok) return found;
  const snapshot = found.value && (projectId === undefined || projectId === found.value.projectId) ? found.value : null;
  if (snapshot === null) return notFound();
  if (snapshot.body !== null) return ok(publicMemoOf(snapshot));
  const binding = ports.staging.freshBinding();
  if (!binding.ok) return binding;
  const resolved = ports.bodies.resolveBody(snapshot.bodyRef, binding.value);
  if (!resolved.ok) return resolved;
  return ok(publicMemoOf({ ...snapshot, body: resolved.value }));
}

/** Builds one list summary from a captured descriptor; file rows read their bounded head outside any transaction. */
function summaryOf(
  ports: MemoCommandPorts,
  descriptor: MemoCandidateDescriptor,
  binding: { vaultPath: string },
): Result<MemoSummary, AppError> {
  let previewSeed: string;
  if (descriptor.representation === "inline") {
    previewSeed = descriptor.previewSeed ?? "";
  } else {
    const seed = ports.bodies.readBodyPreviewSeed(
      { recordId: descriptor.recordId, sizeBytes: descriptor.sizeBytes, sha256: descriptor.sha256 },
      binding,
    );
    if (!seed.ok) return seed;
    previewSeed = seed.value;
  }
  const preview = memoPreviewOf(previewSeed, descriptor.sizeBytes);
  return ok({
    id: descriptor.id,
    projectId: descriptor.projectId,
    title: descriptor.title,
    state: descriptor.state,
    rowVersion: descriptor.rowVersion,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.updatedAt,
    closedAt: descriptor.closedAt,
    projectSlug: descriptor.project.slug,
    projectDisplayName: descriptor.project.displayName,
    projectStatus: descriptor.project.status,
    bodyPreview: preview.bodyPreview,
    bodyPreviewTruncated: preview.bodyPreviewTruncated,
  });
}

/**
 * The bounded own-page list of ADR-0032: one fresh
 * binding per attempt captured after the external-commit version, candidate
 * batches from short SQL transactions with file scans outside them against
 * that binding, at most one batch of descriptors plus limit+1 summaries held,
 * the whole attempt accepted only when the same connection saw no external
 * commit, a bounded whole-page restart on change, and an honest whole-page
 * failure otherwise.
 */
export function listMemos(ports: MemoCommandPorts, input: unknown): Result<MemoPage> {
  const checked = context(ports);
  if (!checked.ok) return checked;
  const parsed = parseMemoListFilter(input, ports.defaultPageSize);
  if (!parsed.ok) return parsed;
  const filter = parsed.value;
  const identity = filterHash({
    namespace: "memos",
    installationId: ports.installationId,
    project: "projectId" in filter.scope ? filter.scope.projectId : "all",
    state: filter.state,
    query: filter.query,
    limit: filter.limit,
  });
  let after: { createdAt: string; id: string } | undefined;
  if (filter.cursor) {
    const decoded = decodeCursor(filter.cursor, identity);
    if (!decoded.ok) return decoded;
    try {
      const tuple: unknown = JSON.parse(decoded.value.lastSortKey);
      if (
        decoded.value.limit !== filter.limit ||
        !Array.isArray(tuple) ||
        tuple.length !== 2 ||
        !isMemoTimestamp(tuple[0]) ||
        !isMemoUuid(tuple[1])
      )
        throw new Error();
      after = { createdAt: tuple[0], id: tuple[1] };
    } catch {
      return err(appError("CURSOR_INVALID", "Invalid Memo cursor tuple"));
    }
  }
  for (let attempt = 0; attempt < MEMO_LIST_ATTEMPTS; attempt++) {
    const version = ports.coherence.captureExternalVersion();
    if (!version.ok) return version;
    const binding = ports.staging.freshBinding();
    if (!binding.ok) return binding;
    const summaries: MemoSummary[] = [];
    let position = after;
    let exhausted = false;
    let failure: AppError | null = null;
    while (summaries.length <= filter.limit && !exhausted && failure === null) {
      const capture: Result<MemoListCapture> = ports.memos.captureListBatch(filter, position, MEMO_LIST_BATCH);
      if (!capture.ok) {
        // The external-commit check takes precedence before classifying the
        // captured failure: a concurrent change restarts the whole page rather
        // than surfacing a stale integrity verdict (ADR-0032).
        failure = capture.error;
        break;
      }
      for (const descriptor of capture.value.descriptors) {
        if (summaries.length > filter.limit) break;
        if (descriptor.representation === "inline") {
          // Verify the bounded inline record outside the capture transaction,
          // including candidates that will not match the search. Corruption
          // cannot silently change page membership or emit an unchecked preview.
          const seed = ports.bodies.readBodyPreviewSeed(
            {
              recordId: descriptor.recordId,
              sizeBytes: descriptor.sizeBytes,
              sha256: descriptor.sha256,
            },
            binding.value,
          );
          if (!seed.ok) {
            failure = seed.error;
            break;
          }
          descriptor.previewSeed = seed.value;
        }
        let matches = filter.query === "";
        if (!matches) matches = descriptor.titleMatch || descriptor.inlineMatch;
        if (!matches && descriptor.representation === "file") {
          const scan = ports.bodies.scanBodyForQuery(
            { recordId: descriptor.recordId, sizeBytes: descriptor.sizeBytes, sha256: descriptor.sha256 },
            filter.query,
            binding.value,
          );
          if (!scan.ok) {
            failure = scan.error;
            break;
          }
          matches = scan.value;
        }
        if (!matches) continue;
        const summary = summaryOf(ports, descriptor, binding.value);
        if (!summary.ok) {
          failure = summary.error;
          break;
        }
        summaries.push(summary.value);
      }
      position = capture.value.lastSortKey ?? position;
      exhausted = capture.value.exhausted;
    }
    if (failure !== null) {
      // An external commit takes precedence over the captured failure classification.
      const current = ports.coherence.captureExternalVersion();
      if (current.ok && current.value !== version.value) continue;
      return err(failure);
    }
    const final = ports.coherence.captureExternalVersion();
    if (!final.ok) return final;
    if (final.value === version.value) {
      const items = summaries.slice(0, filter.limit);
      const last = items.at(-1);
      return ok({
        items,
        nextCursor:
          summaries.length > filter.limit && last
            ? encodeCursor({
                filterHash: identity,
                limit: filter.limit,
                lastSortKey: JSON.stringify([last.createdAt, last.id]),
              })
            : null,
      });
    }
  }
  return err({
    ...appError(
      "STORAGE_INSPECTION_UNAVAILABLE",
      "A coherent Memo list page could not be assembled because the database kept changing; no page was emitted",
    ),
    recovery: { suggestedCommand: "Retry the Memo list; no partial page was emitted" },
  });
}
