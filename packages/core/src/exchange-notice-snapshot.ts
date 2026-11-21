import { canonicalJson } from "./backup-snapshot";
import { isLowercaseSha256 } from "./content";
import { type ExchangeLifecycle, exchangeLifecycleHead, exchangeRequiresParticipantClaim } from "./exchange-lifecycle";
import {
  EXCHANGE_RESPONSE_NOTICE_MS,
  type ExchangeNoticeOutcome,
  exchangeNoticeBasisKey,
  exchangeResponseObligations,
} from "./exchange-notices";
import { type ExchangeCollaboration, exchangeCount } from "./exchanges";
import { memoObject } from "./memo-protocol";
import { isMemoTimestamp, isMemoUuid } from "./memos";

export function validExchangeNoticeOutcome(value: unknown): value is ExchangeNoticeOutcome {
  if (
    !memoObject(value, [
      "kind",
      "exchangeId",
      "incidentId",
      "noticeKind",
      "affectedProjectId",
      "projectId",
      "obligation",
      "observedThroughSeq",
      "issuedAt",
    ])
  )
    return false;
  const { obligation } = value;
  return (
    value.kind === "notice-ack" &&
    isMemoUuid(value.exchangeId) &&
    typeof value.incidentId === "string" &&
    isLowercaseSha256(value.incidentId) &&
    (value.noticeKind === "connection-check" || value.noticeKind === "unread-delivery") &&
    isMemoUuid(value.affectedProjectId) &&
    isMemoUuid(value.projectId) &&
    (value.noticeKind !== "connection-check" || value.projectId !== value.affectedProjectId) &&
    exchangeCount(value.observedThroughSeq, 1) &&
    isMemoTimestamp(value.issuedAt) &&
    memoObject(obligation, ["response", "requestId", "version", "sourceSeq", "responsibilitySeq", "resumeSeq"]) &&
    (obligation.response === "report" || obligation.response === "acceptance") &&
    isMemoUuid(obligation.requestId) &&
    exchangeCount(obligation.version, 1) &&
    exchangeCount(obligation.sourceSeq, 1) &&
    exchangeCount(obligation.responsibilitySeq) &&
    exchangeCount(obligation.resumeSeq) &&
    Math.max(obligation.sourceSeq, obligation.responsibilitySeq, obligation.resumeSeq) <= value.observedThroughSeq
  );
}

export function validateExchangeNoticeInventory(
  value: unknown,
  lifecycle: ExchangeLifecycle,
  collaboration: ExchangeCollaboration,
  committedHeads: ReadonlySet<number>,
): boolean {
  if (
    !memoObject(value, ["compatibilityAt", "openConnectionIssues"]) ||
    (value.compatibilityAt !== null && !isMemoTimestamp(value.compatibilityAt)) ||
    !Array.isArray(value.openConnectionIssues)
  )
    return false;
  const compatibilityAt = value.compatibilityAt;
  if (
    lifecycle.transitions.some(({ transition, recordedAt }) => {
      const timed = transition.kind === "roster" || transition.kind === "owner-correct" || transition.kind === "resume";
      return timed ? recordedAt === undefined && compatibilityAt === null : recordedAt !== undefined;
    })
  )
    return false;
  const lastPresentHeads = new Map<string, number>();
  const observePresence = (projectId: string, head: number) => {
    lastPresentHeads.set(projectId, Math.max(lastPresentHeads.get(projectId) ?? 0, head));
  };
  for (const { seq, senderId } of collaboration.messages) {
    if (committedHeads.has(seq)) observePresence(senderId, seq);
  }
  for (const { seq, actorId, transition } of lifecycle.transitions) {
    if (exchangeRequiresParticipantClaim(transition.kind)) observePresence(actorId, seq);
  }
  const issued = new Map<string, ExchangeNoticeOutcome>();
  const lastConnectionHeads = new Map<string, number>();
  for (const { outcome, projectId, registrationAfterSeq } of collaboration.operations) {
    if (
      outcome.kind === "material-register" &&
      registrationAfterSeq !== undefined &&
      committedHeads.has(registrationAfterSeq)
    )
      observePresence(projectId, registrationAfterSeq);
    if (outcome.kind !== "notice-ack") continue;
    if (!committedHeads.has(outcome.observedThroughSeq) || issued.has(outcome.incidentId)) return false;
    const observedLifecycle = {
      ...lifecycle,
      transitions: lifecycle.transitions.filter(({ seq }) => seq <= outcome.observedThroughSeq),
    };
    const observed = exchangeLifecycleHead(observedLifecycle);
    if (!observed.members.has(outcome.projectId)) return false;
    const messages = collaboration.messages.filter(({ seq }) => seq <= outcome.observedThroughSeq);
    const requestIds = new Set(messages.filter(({ kind }) => kind === "request").map(({ requestId }) => requestId));
    const versions = (kind: "report" | "accept") =>
      new Set(
        messages
          .filter((message) => message.kind === kind)
          .map((message) => `${message.requestId}:${message.reportVersion}`),
      );
    const reports = versions("report");
    const acceptances = versions("accept");
    const response = exchangeResponseObligations(
      observedLifecycle,
      {
        requests: collaboration.requests.filter(({ id }) => requestIds.has(id)),
        reports: collaboration.reports.filter(({ requestId, version }) => reports.has(`${requestId}:${version}`)),
        acceptances: collaboration.acceptances.filter(({ requestId, reportVersion }) =>
          acceptances.has(`${requestId}:${reportVersion}`),
        ),
        messages,
      },
      compatibilityAt,
    ).find(
      (candidate) =>
        candidate.affectedProjectId === outcome.affectedProjectId &&
        canonicalJson(candidate.obligation) === canonicalJson(outcome.obligation),
    );
    if (!response || Date.parse(outcome.issuedAt) < Date.parse(response.availableAt) + EXCHANGE_RESPONSE_NOTICE_MS)
      return false;
    issued.set(outcome.incidentId, outcome);
    observePresence(outcome.projectId, outcome.observedThroughSeq);
    if (outcome.noticeKind === "unread-delivery") {
      observePresence(outcome.affectedProjectId, outcome.observedThroughSeq);
    } else {
      const key = exchangeNoticeBasisKey(outcome);
      lastConnectionHeads.set(key, Math.max(lastConnectionHeads.get(key) ?? 0, outcome.observedThroughSeq));
    }
  }
  const current = new Set(
    exchangeResponseObligations(lifecycle, collaboration, compatibilityAt).map(exchangeNoticeBasisKey),
  );
  const seen = new Set<string>();
  return value.openConnectionIssues.every((incidentId) => {
    const outcome = typeof incidentId === "string" ? issued.get(incidentId) : undefined;
    if (outcome?.noticeKind !== "connection-check") return false;
    const key = exchangeNoticeBasisKey(outcome);
    // Only a strictly later head can order these portable observations.
    if (
      seen.has(key) ||
      !current.has(key) ||
      (lastConnectionHeads.get(key) ?? 0) > outcome.observedThroughSeq ||
      (lastPresentHeads.get(outcome.affectedProjectId) ?? 0) > outcome.observedThroughSeq
    )
      return false;
    seen.add(key);
    return true;
  });
}
