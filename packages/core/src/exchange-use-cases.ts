import { appError, err, ok, type Result } from "./errors";
import {
  EXCHANGE_INFORMATION_KINDS,
  type ExchangeAcceptance,
  type ExchangeAcceptanceInput,
  type ExchangeAcceptanceReceipt,
  type ExchangeBusinessInput,
  exchangeAccessDenied,
  type ExchangeClaim,
  exchangeCount,
  exchangeFingerprint,
  exchangeInvalid,
  type ExchangeMaterial,
  type ExchangeMessage,
  type ExchangeOutcome,
  type ExchangeRange,
  type ExchangeReport,
  type ExchangeRequest,
  type ExchangeView,
  exchangeWorkflowText,
  requireExchangeAcceptance,
  requireExchangeClaim,
  requireExchangeReport,
  type RetainedExchangeAcceptance,
  validateExchangeAcceptances,
  validateExchangeExternal,
} from "./exchanges";
import { isMemoUuid } from "./memos";
import type { Project } from "./projects";

export interface ExchangeCapturedBody {
  sizeBytes: number;
  sha256: string;
  classification: "text" | "binary";
}

export interface ExchangeCapturedInput {
  body?: ExchangeCapturedBody;
  local?: {
    relativePath: string;
    offset: number;
    length: number | null;
    sizeBytes: number | null;
    sha256: string | null;
  };
}

type NewMessage = Omit<ExchangeMessage, "seq" | "senderId" | "createdAt">;
type NewMaterial = Omit<ExchangeMaterial, "id" | "ownerProjectId">;

/** Every repository operation is synchronous. A prepared material reference records SQL rows only. */
export interface ExchangeBusinessRepository {
  actorId: string;
  project(reference: string): Result<Pick<Project, "id" | "status"> | null>;
  activeMember(exchangeId: string, projectId: string): boolean;
  hasMessage(exchangeId: string, seq: number): boolean;
  request(exchangeId: string, requestId: string): ExchangeRequest | undefined;
  latestReport(exchangeId: string, requestId: string): number;
  currentReport?(exchangeId: string, requestId: string): number;
  isAccepted(exchangeId: string, requestId: string, reportVersion: number): boolean;
  hasMaterial(exchangeId: string, materialId: string): boolean;
  claim(exchangeId: string): ExchangeClaim | null;
  now(): Date;
  newId(): string;
  createExchange(id: string, goal: string, criteria: string[], members: string[]): void;
  addMaterial(exchangeId: string, material: NewMaterial): string;
  addRequest(exchangeId: string, request: ExchangeRequest): void;
  addReport(exchangeId: string, report: ExchangeReport): void;
  addAcceptance(exchangeId: string, acceptance: RetainedExchangeAcceptance): void;
  appendMessage(exchangeId: string, message: NewMessage): number;
  saveOutcome(outcome: ExchangeOutcome, operationId: string, fingerprint: string): void;
}

interface ExchangeBusinessPlan {
  fingerprint: string;
  write(): Result<ExchangeOutcome>;
}

const invalid = (message: string): Result<never> => err(exchangeInvalid(message));
const denied = (): Result<never> => err(exchangeAccessDenied());
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function plan(normalized: object, write: ExchangeBusinessPlan["write"]): Result<ExchangeBusinessPlan> {
  return ok({ fingerprint: exchangeFingerprint(normalized), write });
}

function projectId(repository: ExchangeBusinessRepository, reference: string): Result<string> {
  const project = repository.project(reference);
  if (!project.ok) return project;
  return project.value
    ? ok(project.value.id)
    : err(appError("PROJECT_NOT_FOUND", "The Exchange Project could not be resolved."));
}

function message(
  repository: ExchangeBusinessRepository,
  exchangeId: string,
  kind: NewMessage["kind"],
  extras: Partial<Omit<NewMessage, "kind">> = {},
): number {
  return repository.appendMessage(exchangeId, {
    kind,
    recipientId: null,
    replyTo: null,
    materialId: null,
    requestId: null,
    reportVersion: null,
    ...extras,
  });
}

function acceptedSet(choices: ExchangeAcceptanceInput[]): ExchangeAcceptanceInput[] {
  return [...choices].sort((a, b) => compare(a.requestId, b.requestId) || a.reportVersion - b.reportVersion);
}

export function acceptExchangeReports(
  repository: ExchangeBusinessRepository,
  exchangeId: string,
  choices: ExchangeAcceptanceInput[],
  receipt: ExchangeAcceptanceReceipt,
): Result<number[]> {
  for (const choice of choices) {
    const request = repository.request(exchangeId, choice.requestId);
    if (!request) return invalid("The named request is not recorded on this Exchange.");
    const allowed = requireExchangeAcceptance(
      request,
      repository.actorId,
      choice.reportVersion,
      repository.currentReport?.(exchangeId, choice.requestId) ?? repository.latestReport(exchangeId, choice.requestId),
      repository.isAccepted(exchangeId, choice.requestId, choice.reportVersion),
    );
    if (!allowed.ok) return allowed;
  }
  const sequences = choices.map((choice) => {
    repository.addAcceptance(exchangeId, {
      ...choice,
      requesterId: repository.actorId,
      acceptedAt: repository.now().toISOString(),
      receipt,
    });
    return message(repository, exchangeId, "accept", choice);
  });
  return ok(sequences);
}

function addBody(repository: ExchangeBusinessRepository, exchangeId: string, captured: ExchangeCapturedBody): string {
  return repository.addMaterial(exchangeId, {
    kind: "body",
    sizeBytes: captured.sizeBytes,
    sha256: captured.sha256,
    scope: null,
  });
}

/** Normalize verified observations without opening files, and produce the transactional business transition. */
export function planExchangeBusiness(
  repository: ExchangeBusinessRepository,
  input: ExchangeBusinessInput,
  capture: ExchangeCapturedInput,
): Result<ExchangeBusinessPlan> {
  const { kind } = input;
  if (kind === "create") {
    if (!exchangeWorkflowText(input.goal, input.criteria) || input.peers.length === 0) {
      return invalid("Supply a peer Project, goal and completion criteria totaling at most 8192 UTF-8 bytes.");
    }
    const peers = new Set([repository.actorId]);
    for (const peer of input.peers) {
      const id = projectId(repository, peer);
      if (!id.ok) return id;
      peers.add(id.value);
    }
    if (peers.size < 2) return invalid("An Exchange must include the opening Project and a peer.");
    const members = [...peers].sort(compare);
    return plan({ kind, members, goal: input.goal, criteria: input.criteria }, () => {
      for (const member of members) {
        const project = repository.project(member);
        if (!project.ok) return project;
        if (project.value?.status !== "active")
          return err(appError("PROJECT_ARCHIVED", "An initial Exchange Project is no longer active."));
      }
      const exchangeId = repository.newId();
      repository.createExchange(exchangeId, input.goal, input.criteria, members);
      return ok({ kind, exchangeId });
    });
  }
  const { exchangeId } = input;
  if (kind === "send") {
    if (
      !EXCHANGE_INFORMATION_KINDS.includes(input.messageKind) ||
      !validateExchangeAcceptances(input.accept) ||
      (input.replyTo !== undefined && !exchangeCount(input.replyTo, 1))
    )
      return invalid("Invalid Exchange message kind or observations.");
    const body = capture.body;
    if (!body) return invalid("The Exchange message needs a captured body.");
    const recipient = input.recipient === undefined ? ok(null) : projectId(repository, input.recipient);
    if (!recipient.ok) return recipient;
    const accept = acceptedSet(input.accept);
    return plan(
      {
        kind,
        messageKind: input.messageKind,
        recipient: recipient.value ?? undefined,
        replyTo: input.replyTo,
        accept,
        ...body,
      },
      () => {
        if (recipient.value !== null && !repository.activeMember(exchangeId, recipient.value))
          return invalid("The addressed Project is not an active member of this Exchange.");
        if (input.replyTo !== undefined && !repository.hasMessage(exchangeId, input.replyTo))
          return invalid("The reply must name an existing message on this Exchange.");
        const accepted = acceptExchangeReports(repository, exchangeId, accept, {
          kind,
          operationId: input.operationId,
        });
        if (!accepted.ok) return accepted;
        const materialId = addBody(repository, exchangeId, body);
        const seq = message(repository, exchangeId, input.messageKind, {
          recipientId: recipient.value,
          replyTo: input.replyTo ?? null,
          materialId,
        });
        return ok({ kind, exchangeId, seq, materialId });
      },
    );
  }
  if (kind === "request") {
    if (!exchangeWorkflowText(input.condition, input.criteria))
      return invalid("A request condition and criteria must fit 8192 UTF-8 bytes.");
    if (input.replyTo !== undefined && !exchangeCount(input.replyTo, 1))
      return invalid("The reply must name an existing message on this Exchange.");
    const assignee = projectId(repository, input.assignee);
    if (!assignee.ok) return assignee;
    return plan(
      { kind, assignee: assignee.value, condition: input.condition, criteria: input.criteria, replyTo: input.replyTo },
      () => {
        if (!repository.activeMember(exchangeId, assignee.value))
          return invalid("The addressed Project is not an active member of this Exchange.");
        if (input.replyTo !== undefined && !repository.hasMessage(exchangeId, input.replyTo))
          return invalid("The reply must name an existing message on this Exchange.");
        const requestId = repository.newId();
        const assignmentVersion = 1;
        repository.addRequest(exchangeId, {
          id: requestId,
          requesterId: repository.actorId,
          assigneeId: assignee.value,
          assignmentVersion,
          condition: input.condition,
          criteria: input.criteria,
        });
        const seq = message(repository, exchangeId, kind, {
          requestId,
          recipientId: assignee.value,
          replyTo: input.replyTo ?? null,
        });
        return ok({ kind, exchangeId, seq, requestId, assignmentVersion });
      },
    );
  }
  if (kind === "report") {
    const { requestId, assignmentVersion } = input;
    if (
      !isMemoUuid(requestId) ||
      !exchangeCount(assignmentVersion, 1) ||
      !validateExchangeAcceptances(input.accept) ||
      !input.evidence.every(isMemoUuid) ||
      new Set(input.evidence).size !== input.evidence.length ||
      input.accept.some((choice) => choice.requestId === requestId)
    )
      return invalid("Invalid report observations or evidence IDs.");
    const body = capture.body;
    if (!body) return invalid("The Exchange report needs a captured body.");
    const evidence = [...input.evidence].sort(compare);
    const accept = acceptedSet(input.accept);
    return plan({ kind, requestId, assignmentVersion, evidence, accept, ...body }, () => {
      const request = repository.request(exchangeId, requestId);
      if (!request) return invalid("The named request is not recorded on this Exchange.");
      const authorized = requireExchangeReport(request, repository.actorId, assignmentVersion);
      if (!authorized.ok) return authorized;
      if (evidence.some((materialId) => !repository.hasMaterial(exchangeId, materialId)))
        return invalid("A report evidence ID is outside this Exchange.");
      const reportVersion = repository.latestReport(exchangeId, requestId) + 1;
      if (!exchangeCount(reportVersion, 1)) return invalid("The report version is exhausted.");
      const accepted = acceptExchangeReports(repository, exchangeId, accept, { kind, operationId: input.operationId });
      if (!accepted.ok) return accepted;
      const materialId = addBody(repository, exchangeId, body);
      repository.addReport(exchangeId, {
        requestId,
        version: reportVersion,
        assignmentVersion,
        authorId: repository.actorId,
        materialId,
        evidence,
      });
      const seq = message(repository, exchangeId, kind, {
        recipientId: request.ownership ? request.ownership.acceptanceOwnerId : request.requesterId,
        materialId,
        requestId,
        reportVersion,
      });
      return ok({ kind, exchangeId, seq, requestId, reportVersion, materialId });
    });
  }
  if (kind === "accept") {
    if (!validateExchangeAcceptances(input.accept) || input.accept.length === 0)
      return invalid("Name at least one exact request and report version.");
    const accept = acceptedSet(input.accept);
    return plan({ kind, accept }, () => {
      const accepted = acceptExchangeReports(repository, exchangeId, accept, { kind, operationId: input.operationId });
      return accepted.ok ? ok({ kind, exchangeId, sequences: accepted.value }) : accepted;
    });
  }
  const { material } = input;
  if (material.kind === "external") {
    const scope = { access: material.access, value: material.value };
    if (!validateExchangeExternal(scope))
      return invalid("Supply a bounded external reference descriptor without credentials.");
    return plan({ kind, form: material.kind, scope }, () => {
      const materialId = repository.addMaterial(exchangeId, {
        kind: material.kind,
        scope,
        sizeBytes: null,
        sha256: null,
      });
      return ok({ kind, exchangeId, materialId });
    });
  }
  const local = capture.local;
  if (!local) return invalid("The Exchange material needs a captured local source.");
  const { sizeBytes, sha256, ...scope } = local;
  return plan({ kind, form: material.kind, scope, sizeBytes, sha256 }, () => {
    const materialId = repository.addMaterial(exchangeId, { kind: material.kind, scope, sizeBytes, sha256 });
    return ok({ kind, exchangeId, materialId });
  });
}

export function commitExchangeBusiness(
  repository: ExchangeBusinessRepository,
  input: ExchangeBusinessInput,
  prepared: ExchangeBusinessPlan,
  admitted: () => void,
): Result<ExchangeOutcome> {
  if (input.kind !== "create") {
    if (!repository.activeMember(input.exchangeId, repository.actorId)) return denied();
    const current = requireExchangeClaim(repository.claim(input.exchangeId), input.claim, repository.now());
    if (!current.ok) return current;
  }
  admitted();
  const outcome = prepared.write();
  if (outcome.ok) repository.saveOutcome(outcome.value, input.operationId, prepared.fingerprint);
  return outcome;
}

export function exchangeView(
  header: Omit<ExchangeView, "projectId" | "state" | "members" | "requests" | "reports" | "acceptances" | "readRanges">,
  projectId: string,
  members: string[],
  requests: ExchangeRequest[],
  reports: ExchangeReport[],
  acceptances: ExchangeAcceptance[],
  readRanges: ExchangeRange[],
): ExchangeView {
  const latest = new Map(reports.map((report) => [report.requestId, report]));
  return {
    ...header,
    projectId,
    state: "active",
    members,
    requests: requests.map((request) => {
      const latestReport = latest.get(request.id) ?? null;
      const report =
        latestReport?.assignmentVersion === (request.ownership?.assignmentVersion ?? request.assignmentVersion)
          ? latestReport
          : null;
      const acceptance = report
        ? (acceptances.find((row) => row.requestId === request.id && row.reportVersion === report.version) ?? null)
        : null;
      return {
        ...request,
        report,
        acceptance,
        state: request.ownership?.disposition
          ? "disposed"
          : acceptance
            ? "resolved"
            : report
              ? "completion-reported"
              : "in-progress",
      };
    }),
    reports,
    acceptances,
    readRanges,
  };
}
