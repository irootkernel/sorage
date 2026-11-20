import { canonicalJson } from "./backup-snapshot";
import { isUtf8ExactText, sha256OfText, utf8ByteLength } from "./content";
import { appError, err, type ErrorCode, type Result, ok } from "./errors";
import { isMemoUuid } from "./memos";

export const EXCHANGE_LEASE_SECONDS = 40;
export const EXCHANGE_RENEW_SECONDS = 10;
export const EXCHANGE_WAIT_SECONDS = 60;
export const EXCHANGE_POLL_SECONDS = 2;
export const EXCHANGE_WORKFLOW_BYTES = 8_192;
export const EXCHANGE_READ_BYTES = 65_536;
export const EXCHANGE_INFORMATION_KINDS = ["information", "progress", "clarification", "blocked"] as const;
export type ExchangeInformationKind = (typeof EXCHANGE_INFORMATION_KINDS)[number];
export type ExchangeMaterialKind = "body" | "copy" | "live" | "versioned" | "external";
export type ExchangeMessageKind = ExchangeInformationKind | "request" | "report" | "accept";

export interface ExchangeAcceptanceInput {
  requestId: string;
  reportVersion: number;
}

export interface ExchangeRange {
  firstSeq: number;
  lastSeq: number;
}

export type ExchangeBodyInput = { text: string } | { file: string };

export type ExchangeMaterialInput =
  | { kind: "copy" | "live" | "versioned"; path: string; offset: number; length: number | null }
  | { kind: "external"; access: "url" | "run-id" | "query"; value: string };

interface BusinessIdentity {
  operationId: string;
  replayOnly: boolean;
}

interface ParticipantBusinessIdentity extends BusinessIdentity {
  exchangeId: string;
  claim: string | undefined;
}

export type ExchangeBusinessInput =
  | (BusinessIdentity & { kind: "create"; peers: string[]; goal: string; criteria: string[] })
  | (ParticipantBusinessIdentity & {
      kind: "send";
      messageKind: ExchangeInformationKind;
      body: ExchangeBodyInput;
      recipient?: string | undefined;
      replyTo?: number | undefined;
      accept: ExchangeAcceptanceInput[];
    })
  | (ParticipantBusinessIdentity & {
      kind: "request";
      assignee: string;
      condition: string;
      criteria: string[];
      replyTo?: number | undefined;
    })
  | (ParticipantBusinessIdentity & {
      kind: "report";
      requestId: string;
      assignmentVersion: number;
      body: ExchangeBodyInput;
      evidence: string[];
      accept: ExchangeAcceptanceInput[];
    })
  | (ParticipantBusinessIdentity & { kind: "accept"; accept: ExchangeAcceptanceInput[] })
  | (ParticipantBusinessIdentity & { kind: "material-register"; material: ExchangeMaterialInput });

export type ExchangeReadInput =
  | { kind: "inspect"; exchangeId: string }
  | {
      kind: "history";
      exchangeId: string;
      afterSeq?: number | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    }
  | {
      kind: "wait";
      exchangeId: string;
      cursor?: string | undefined;
      limit?: number | undefined;
      timeout: number;
      interval: number;
    }
  | { kind: "material-read"; exchangeId: string; materialId: string; offset: number; limit: number }
  | { kind: "recover"; exchangeId?: string | undefined; operationId?: string | undefined };

export type ExchangeLifecycleInput =
  | { kind: "join"; exchangeId: string; replaceClaim?: string | undefined; confirmed: boolean }
  | { kind: "renew"; exchangeId: string; claim: string }
  | { kind: "release"; exchangeId: string; claim: string }
  | { kind: "confirm-read"; exchangeId: string; claim: string | undefined; ranges: ExchangeRange[] };

export type ExchangeInput = ExchangeBusinessInput | ExchangeReadInput | ExchangeLifecycleInput;

export type ExchangeOutcome =
  | { kind: "create"; exchangeId: string }
  | { kind: "send"; exchangeId: string; seq: number; materialId: string }
  | { kind: "request"; exchangeId: string; seq: number; requestId: string; assignmentVersion: number }
  | { kind: "report"; exchangeId: string; seq: number; requestId: string; reportVersion: number; materialId: string }
  | { kind: "accept"; exchangeId: string; sequences: number[] }
  | { kind: "material-register"; exchangeId: string; materialId: string };

export interface ExchangeMessage {
  seq: number;
  senderId: string;
  recipientId: string | null;
  kind: ExchangeMessageKind;
  replyTo: number | null;
  materialId: string | null;
  requestId: string | null;
  reportVersion: number | null;
  createdAt: string;
}

export interface ExchangeRequest {
  id: string;
  requesterId: string;
  assigneeId: string;
  assignmentVersion: number;
  condition: string;
  criteria: string[];
}

export interface ExchangeReport {
  requestId: string;
  version: number;
  assignmentVersion: number;
  authorId: string;
  materialId: string;
  evidence: string[];
}

export interface ExchangeAcceptance extends ExchangeAcceptanceInput {
  requesterId: string;
  acceptedAt: string;
}

export interface ExchangeAcceptanceReceipt {
  operationId: string;
  kind: "accept" | "send" | "report";
}

export interface RetainedExchangeAcceptance extends ExchangeAcceptance {
  receipt: ExchangeAcceptanceReceipt;
}

export interface ExchangeLocalScope {
  offset: number;
  length: number | null;
  root?: string;
  relativePath?: string;
}

export interface ExchangeExternalScope {
  access: "url" | "run-id" | "query";
  value: string;
}

export interface ExchangeMaterial {
  id: string;
  ownerProjectId: string;
  kind: ExchangeMaterialKind;
  sizeBytes: number | null;
  sha256: string | null;
  scope: ExchangeLocalScope | ExchangeExternalScope | null;
}

export interface RetainedExchangeOperation {
  projectId: string;
  operationId: string;
  fingerprint: string;
  outcome: Exclude<ExchangeOutcome, { kind: "create" }>;
}

export interface ExchangeCollaboration {
  lastSeq: number;
  messages: ExchangeMessage[];
  requests: ExchangeRequest[];
  reports: ExchangeReport[];
  acceptances: RetainedExchangeAcceptance[];
  materials: ExchangeMaterial[];
  operations: RetainedExchangeOperation[];
}

export type ExchangeMaterialAvailability = "available" | "pending" | "omitted" | "unavailable";

export interface ExchangeActivationWarning {
  code: ErrorCode;
  message: string;
  recovery: { suggestedCommand: string };
}

export type ExchangeBusinessResult = ExchangeOutcome & {
  replayed: boolean;
  availability?: ExchangeMaterialAvailability;
};

export interface ExchangeRequestView extends ExchangeRequest {
  report: ExchangeReport | null;
  acceptance: ExchangeAcceptance | null;
  state: "in-progress" | "completion-reported" | "resolved";
}

export interface ExchangeView {
  exchangeId: string;
  openingProjectId: string;
  projectId: string;
  goal: string;
  criteria: string[];
  lastSeq: number;
  createdAt: string;
  state: "active";
  members: string[];
  requests: ExchangeRequestView[];
  reports: ExchangeReport[];
  acceptances: ExchangeAcceptance[];
  readRanges: ExchangeRange[];
}

export interface ExchangeHistoryPage {
  exchangeId: string;
  messages: ExchangeMessage[];
  hasMore: boolean;
  afterSeq: number;
  lastSeq: number;
  cursor: string;
}

export interface ExchangeWaitPage {
  exchangeId: string;
  projectId: string;
  messages: ExchangeMessage[];
  cursor: string;
  stateChanged: boolean;
}

export interface ExchangeWaitResult extends ExchangeWaitPage {
  timedOut: boolean;
}

export interface ExchangeLeaseResult extends ExchangeClaim {
  exchangeId: string;
  projectId: string;
}

export interface ExchangeMaterialPage {
  materialId: string;
  kind: Exclude<ExchangeMaterialKind, "external">;
  encoding: "base64";
  bytes: string;
  offset: number;
  sizeBytes: number;
  sha256: string | null;
  end: boolean;
  nextOffset: number | null;
  observedVersion?: string;
  ownerProjectId?: string;
}

export interface ExchangeExternalReference {
  materialId: string;
  kind: "external";
  descriptor: ExchangeExternalScope;
}

export interface ExchangeRecovery {
  operations: Array<{ operationId: string; outcome: ExchangeOutcome }>;
}

export interface ExchangeReadConfirmation {
  exchangeId: string;
  projectId: string;
  readRanges: ExchangeRange[];
  changed: boolean;
}

export type ExchangeActionData = (
  | ExchangeBusinessResult
  | ExchangeView
  | (ExchangeView & ExchangeClaim)
  | ExchangeHistoryPage
  | ExchangeWaitResult
  | ExchangeLeaseResult
  | ExchangeMaterialPage
  | ExchangeExternalReference
  | ExchangeRecovery
  | ExchangeReadConfirmation
) & { warnings?: ExchangeActivationWarning[] };

type ExchangeOtherResults = {
  join: ExchangeView & ExchangeClaim;
  inspect: ExchangeView;
  history: ExchangeHistoryPage;
  wait: ExchangeWaitResult;
  renew: ExchangeLeaseResult;
  release: ExchangeLeaseResult;
  "material-read": ExchangeMaterialPage | ExchangeExternalReference;
  recover: ExchangeRecovery;
  "confirm-read": ExchangeReadConfirmation;
};

export type ExchangeActionFor<Kind extends ExchangeInput["kind"]> = (Kind extends keyof ExchangeOtherResults
  ? ExchangeOtherResults[Kind]
  : Extract<ExchangeBusinessResult, { kind: Kind }>) & { warnings?: ExchangeActivationWarning[] };

export interface ExchangeReadDecision {
  data?: ExchangeActionData;
  fingerprint?: string;
}

export interface ExchangeCommandPorts {
  inspect(input: ExchangeInput): Result<ExchangeReadDecision>;
  executeFresh(input: ExchangeBusinessInput | ExchangeLifecycleInput, fingerprint?: string): Result<ExchangeActionData>;
}

export function isExchangeRead(input: ExchangeInput): input is ExchangeReadInput {
  return (
    input.kind === "inspect" ||
    input.kind === "history" ||
    input.kind === "wait" ||
    input.kind === "material-read" ||
    input.kind === "recover"
  );
}

export function isExchangeBusiness(input: ExchangeInput): input is ExchangeBusinessInput {
  return "replayOnly" in input;
}

/** A composed command must inspect coherent current authority and receipts before opening a writer. */
export function runExchangeCommand(ports: ExchangeCommandPorts, input: ExchangeInput): Result<ExchangeActionData> {
  if ("exchangeId" in input && input.exchangeId !== undefined && !isMemoUuid(input.exchangeId)) {
    return err(exchangeInvalid("Supply an Exchange UUID."));
  }
  if ("operationId" in input && input.operationId !== undefined && !exchangeOperationId(input.operationId)) {
    return err(exchangeInvalid("Supply a bounded operation ID."));
  }
  const inspected = ports.inspect(input);
  if (isExchangeRead(input) || (isExchangeBusiness(input) && input.replayOnly)) {
    if (!inspected.ok) return inspected;
    return inspected.value.data === undefined
      ? err(appError("INTERNAL_ERROR", "The Exchange read returned no outcome."))
      : ok(inspected.value.data);
  }
  if (!inspected.ok && inspected.error.code !== "STORAGE_MIGRATION_REQUIRED") return inspected;
  if (inspected.ok && inspected.value.data !== undefined) return ok(inspected.value.data);
  return ports.executeFresh(input, inspected.ok ? inspected.value.fingerprint : undefined);
}

export interface ExchangeClaim {
  claimId: string;
  expiresAt: string;
}

export function requireExchangeClaim(
  slot: ExchangeClaim | null,
  supplied: string | undefined,
  now: Date,
): Result<ExchangeClaim> {
  return slot !== null && slot.claimId === supplied && Date.parse(slot.expiresAt) > now.getTime()
    ? ok(slot)
    : err(appError("EXCHANGE_CLAIM_CONFLICT", "The Exchange claim is absent, replaced or expired."));
}

export function authorizeExchangeJoin(
  slot: ExchangeClaim | null,
  observed: string | undefined,
  confirmed: boolean,
  now: Date,
): Result<void> {
  const observedClaim = slot ? exchangeFingerprint({ competingClaim: slot.claimId }) : undefined;
  if (observed !== undefined && observedClaim !== observed) {
    return err(appError("EXCHANGE_CLAIM_CONFLICT", "The observed competing Exchange claim no longer matches."));
  }
  if (observed !== undefined && !confirmed) {
    return err(appError("CONFIRMATION_REQUIRED", "Replacing the observed Exchange claim requires confirmation."));
  }
  if (slot && Date.parse(slot.expiresAt) > now.getTime() && observed === undefined) {
    return err(
      appError("EXCHANGE_CLAIM_CONFLICT", "A live Exchange claim already owns this Project's slot.", {
        observedClaim,
        expiresAt: slot.expiresAt,
      }),
    );
  }
  return ok(undefined);
}

export function requireExchangeReport(
  request: ExchangeRequest,
  actorId: string,
  assignmentVersion: number,
): Result<void> {
  if (request.assigneeId !== actorId) return err(exchangeAccessDenied());
  return request.assignmentVersion === assignmentVersion
    ? ok(undefined)
    : err(appError("ROW_VERSION_CONFLICT", "The request assignment version changed."));
}

export function requireExchangeAcceptance(
  request: ExchangeRequest,
  actorId: string,
  observedVersion: number,
  currentVersion: number,
  alreadyAccepted: boolean,
): Result<void> {
  if (request.requesterId !== actorId) return err(exchangeAccessDenied());
  if (observedVersion !== currentVersion) {
    return err(appError("ROW_VERSION_CONFLICT", "The named report version is no longer current."));
  }
  return alreadyAccepted
    ? err(appError("ROW_VERSION_CONFLICT", "The named report version is already accepted."))
    : ok(undefined);
}

export function matchExchangeFingerprint(stored: string, observed: string): Result<void> {
  return stored === observed
    ? ok(undefined)
    : err(appError("IDEMPOTENCY_CONFLICT", "That Exchange operation ID has different committed input."));
}

export const exchangeAccessDenied = () =>
  appError("FORBIDDEN_ACTOR", "The current bound Project has no access to this Exchange operation.");

export const exchangeInvalid = (message: string) => appError("EXCHANGE_INVALID_INPUT", message);

export function exchangeText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0") && isUtf8ExactText(value);
}

export function exchangeWorkflowText(text: unknown, criteria: unknown): boolean {
  return (
    exchangeText(text) &&
    Array.isArray(criteria) &&
    criteria.length > 0 &&
    criteria.every(exchangeText) &&
    utf8ByteLength(text) + criteria.reduce((sum: number, item: string) => sum + utf8ByteLength(item), 0) <=
      EXCHANGE_WORKFLOW_BYTES
  );
}

export function exchangeCount(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function exchangeOperationId(value: unknown): value is string {
  return exchangeText(value) && utf8ByteLength(value) <= 256;
}

export function exchangeFingerprint(normalized: object): string {
  return sha256OfText(canonicalJson(normalized));
}

export function validateExchangeAcceptances(accept: ExchangeAcceptanceInput[]): boolean {
  return (
    accept.every((entry) => isMemoUuid(entry.requestId) && exchangeCount(entry.reportVersion, 1)) &&
    new Set(accept.map((entry) => entry.requestId)).size === accept.length
  );
}

export function normalizeExchangeRanges(ranges: ExchangeRange[]): Result<ExchangeRange[]> {
  if (!ranges.every((range) => exchangeCount(range.firstSeq, 1) && exchangeCount(range.lastSeq, range.firstSeq))) {
    return err(exchangeInvalid("Exchange read ranges must name positive ordered sequences."));
  }
  const merged: ExchangeRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.firstSeq - b.firstSeq)) {
    const previous = merged.at(-1);
    if (previous && range.firstSeq - previous.lastSeq <= 1)
      previous.lastSeq = Math.max(previous.lastSeq, range.lastSeq);
    else merged.push({ ...range });
  }
  return ok(merged);
}

/** The parts of normalized requested ranges that the Project has yet to confirm. */
export function unconfirmedExchangeRanges(
  requested: readonly ExchangeRange[],
  confirmed: readonly ExchangeRange[],
): ExchangeRange[] {
  const result: ExchangeRange[] = [];
  let coveredIndex = 0;
  for (const range of requested) {
    let firstSeq: number | null = range.firstSeq;
    while (firstSeq !== null) {
      const covered = confirmed[coveredIndex];
      if (covered === undefined || covered.firstSeq > range.lastSeq) break;
      if (covered.lastSeq < firstSeq) {
        coveredIndex += 1;
        continue;
      }
      if (covered.firstSeq > firstSeq) result.push({ firstSeq, lastSeq: covered.firstSeq - 1 });
      if (covered.lastSeq >= range.lastSeq) {
        firstSeq = null;
      } else {
        firstSeq = covered.lastSeq + 1;
        coveredIndex += 1;
      }
    }
    if (firstSeq !== null) result.push({ firstSeq, lastSeq: range.lastSeq });
  }
  return result;
}

export function validateExchangeExternal(scope: ExchangeExternalScope): boolean {
  if (!exchangeText(scope.value) || utf8ByteLength(scope.value) > 2_048) return false;
  if (/\b(?:authorization|api[-_ ]?key|password|secret|token)\s*[:=]/i.test(scope.value)) return false;
  if (scope.access === "run-id") return /^[A-Za-z0-9_:./-]+$/.test(scope.value);
  if (scope.access === "query") return true;
  if (scope.access !== "url") return false;
  try {
    const url = new URL(scope.value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
