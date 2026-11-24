import { type ExchangeLifecycle, exchangeLifecycleHead, initialOwnership } from "./exchange-lifecycle";
import { type ExchangeAcceptanceInput, type ExchangeCollaboration, exchangeFingerprint } from "./exchanges";

export const EXCHANGE_RESPONSE_NOTICE_MS = 300_000;
export const EXCHANGE_NOTICE_PRIORITY_MS = 60_000;
export const EXCHANGE_REPORTING_CLAIM_MS = 30_000;

export type ExchangeNoticeKind = "connection-check" | "unread-delivery";

export interface ExchangeResponseBasis {
  response: "report" | "acceptance";
  requestId: string;
  version: number;
  sourceSeq: number;
  responsibilitySeq: number;
  resumeSeq: number;
}

export interface ExchangeResponseObligation {
  affectedProjectId: string;
  obligation: ExchangeResponseBasis;
  availableAt: string;
}

export interface ExchangeNoticeIncident extends ExchangeResponseObligation {
  incidentId: string;
  noticeKind: ExchangeNoticeKind;
  eligibleAt: string;
  priorityUntil: string;
}

export interface ExchangeNoticeList {
  exchangeId: string;
  projectId: string;
  notices: (ExchangeNoticeIncident & { canAcquire: boolean })[];
}

export interface ExchangeReportingClaim {
  exchangeId: string;
  projectId: string;
  incidentId: string;
  reportingClaimId: string;
  expiresAt: string;
}

export interface ExchangeNoticeAckInput {
  kind: "notice-ack";
  exchangeId: string;
  incidentId: string;
  claim?: string | undefined;
  reportingClaim?: string | undefined;
  operationId: string;
  replayOnly: boolean;
}

export interface ExchangeNoticeOutcome {
  kind: "notice-ack";
  exchangeId: string;
  incidentId: string;
  noticeKind: ExchangeNoticeKind;
  affectedProjectId: string;
  projectId: string;
  obligation: ExchangeResponseBasis;
  observedThroughSeq: number;
  issuedAt: string;
}

export interface ExchangeNoticePresence {
  heartbeatAt: string;
  onlineSince: string;
  epoch: string;
}

export interface ExchangeNoticeInventory {
  compatibilityAt: string | null;
  openConnectionIssues: string[];
}

export type ExchangeResponseRecords = Pick<ExchangeCollaboration, "requests" | "reports" | "messages"> & {
  acceptances: readonly ExchangeAcceptanceInput[];
};

export function exchangeNoticeBasisKey(
  response: Pick<ExchangeResponseObligation, "affectedProjectId" | "obligation">,
): string {
  return exchangeFingerprint({ affectedProjectId: response.affectedProjectId, obligation: response.obligation });
}

export function exchangeNoticeAckFingerprint(incidentId: string): string {
  return exchangeFingerprint({ kind: "notice-ack", incidentId });
}

/** Project the current exact response and the last effective authority/resume observations. */
export function exchangeResponseObligations(
  lifecycle: ExchangeLifecycle,
  records: ExchangeResponseRecords,
  compatibilityAt: string | null,
): ExchangeResponseObligation[] {
  const head = exchangeLifecycleHead(lifecycle);
  if (head.state !== "active") return [];
  const requestMessages = new Map(
    records.messages.filter((message) => message.kind === "request").map((m) => [m.requestId, m]),
  );
  const reportMessages = new Map(
    records.messages
      .filter((message) => message.kind === "report")
      .map((m) => [`${m.requestId}:${m.reportVersion}`, m]),
  );
  const ownership = new Map(records.requests.map((request) => [request.id, initialOwnership(request)]));
  const assigneeChanged = new Map<string, { seq: number; recordedAt?: string }>();
  const ownerChanged = new Map<string, { seq: number; recordedAt?: string }>();
  let resume: { seq: number; recordedAt?: string } | undefined;
  for (const effect of lifecycle.transitions) {
    const { transition } = effect;
    if (transition.kind === "resume") resume = effect;
    const changes =
      transition.kind === "roster"
        ? transition.ownership
        : transition.kind === "owner-correct"
          ? [transition.ownership]
          : [];
    for (const next of changes) {
      const previous = ownership.get(next.requestId);
      if (
        previous?.assignedProjectId !== next.assignedProjectId ||
        previous?.assignmentVersion !== next.assignmentVersion
      )
        assigneeChanged.set(next.requestId, effect);
      if (previous?.acceptanceOwnerId !== next.acceptanceOwnerId) ownerChanged.set(next.requestId, effect);
      ownership.set(next.requestId, next);
    }
  }
  const currentReports = new Map<string, ExchangeCollaboration["reports"][number]>();
  for (const report of records.reports) {
    if ((currentReports.get(report.requestId)?.version ?? 0) < report.version)
      currentReports.set(report.requestId, report);
  }
  const accepted = new Set(records.acceptances.map((entry) => `${entry.requestId}:${entry.reportVersion}`));
  const available: ExchangeResponseObligation[] = [];
  for (const request of records.requests) {
    const current = head.ownership.get(request.id) ?? initialOwnership(request);
    if (current.disposition !== null) continue;
    const latest = currentReports.get(request.id);
    const report = latest?.assignmentVersion === current.assignmentVersion ? latest : undefined;
    if (report && accepted.has(`${request.id}:${report.version}`)) continue;
    const affectedProjectId = report ? current.acceptanceOwnerId : current.assignedProjectId;
    if (affectedProjectId === null || !head.members.has(affectedProjectId)) continue;
    const source = report ? reportMessages.get(`${request.id}:${report.version}`) : requestMessages.get(request.id);
    if (!source) continue;
    const authority = (report ? ownerChanged : assigneeChanged).get(request.id);
    const authorityAt = authority ? (authority.recordedAt ?? compatibilityAt) : null;
    const resumeAt = resume ? (resume.recordedAt ?? compatibilityAt) : null;
    const availableAt = [source.createdAt, authorityAt, resumeAt].reduce<string>(
      (latestAt, candidate) => (candidate && candidate > latestAt ? candidate : latestAt),
      source.createdAt,
    );
    available.push({
      affectedProjectId,
      obligation: {
        response: report ? "acceptance" : "report",
        requestId: request.id,
        version: report?.version ?? current.assignmentVersion,
        sourceSeq: source.seq,
        responsibilitySeq: authority?.seq ?? 0,
        resumeSeq: resume?.seq ?? 0,
      },
      availableAt,
    });
  }
  return available;
}

export function exchangeNoticeIncident(
  response: ExchangeResponseObligation,
  now: Date,
  live: boolean,
  read: boolean,
  presence: ExchangeNoticePresence | undefined,
  priorConnectionAcks = 0,
): ExchangeNoticeIncident | null {
  if (live && read) return null;
  const noticeKind = live ? "unread-delivery" : "connection-check";
  const available = Date.parse(response.availableAt);
  const heartbeat = presence ? Date.parse(presence.heartbeatAt) : available;
  const eligible = (live ? available : Math.max(available, heartbeat)) + EXCHANGE_RESPONSE_NOTICE_MS;
  if (now.getTime() < eligible) return null;
  const episode = live && presence ? Math.max(eligible, Date.parse(presence.onlineSince)) : eligible;
  return {
    ...response,
    incidentId: exchangeFingerprint({
      basis: exchangeNoticeBasisKey(response),
      noticeKind,
      epoch: presence?.epoch ?? null,
      startedAt: episode,
      // Restore omits presence. Previous connection acknowledgements distinguish a closed episode from a new one.
      ...(noticeKind === "connection-check" && priorConnectionAcks > 0 ? { priorConnectionAcks } : {}),
    }),
    noticeKind,
    eligibleAt: new Date(eligible).toISOString(),
    priorityUntil: new Date(episode + EXCHANGE_NOTICE_PRIORITY_MS).toISOString(),
  };
}
