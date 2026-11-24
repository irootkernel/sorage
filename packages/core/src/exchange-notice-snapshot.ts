import { isLowercaseSha256 } from "./content";
import { type ExchangeLifecycle, exchangeLifecycleHead, exchangeRequiresParticipantClaim } from "./exchange-lifecycle";
import {
  EXCHANGE_RESPONSE_NOTICE_MS,
  type ExchangeNoticeOutcome,
  type ExchangeResponseObligation,
  exchangeNoticeBasisKey,
  exchangeResponseObligations,
} from "./exchange-notices";
import { type ExchangeCollaboration, exchangeCount } from "./exchanges";
import { isCanonicalUtcTimestamp, isCanonicalUuid } from "./primitives/identity";
import { canonicalJson } from "./primitives/json";
import { memoObject } from "./primitives/validation";

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
    isCanonicalUuid(value.exchangeId) &&
    typeof value.incidentId === "string" &&
    isLowercaseSha256(value.incidentId) &&
    (value.noticeKind === "connection-check" || value.noticeKind === "unread-delivery") &&
    isCanonicalUuid(value.affectedProjectId) &&
    isCanonicalUuid(value.projectId) &&
    (value.noticeKind !== "connection-check" || value.projectId !== value.affectedProjectId) &&
    exchangeCount(value.observedThroughSeq, 1) &&
    isCanonicalUtcTimestamp(value.issuedAt) &&
    memoObject(obligation, ["response", "requestId", "version", "sourceSeq", "responsibilitySeq", "resumeSeq"]) &&
    (obligation.response === "report" || obligation.response === "acceptance") &&
    isCanonicalUuid(obligation.requestId) &&
    exchangeCount(obligation.version, 1) &&
    exchangeCount(obligation.sourceSeq, 1) &&
    exchangeCount(obligation.responsibilitySeq) &&
    exchangeCount(obligation.resumeSeq) &&
    Math.max(obligation.sourceSeq, obligation.responsibilitySeq, obligation.resumeSeq) <= value.observedThroughSeq
  );
}

function requestVersionKey(requestId: unknown, version: unknown): string {
  return JSON.stringify([requestId, version]);
}

function obligationLookupKey(affectedProjectId: string, obligation: ExchangeNoticeOutcome["obligation"]): string {
  return `${affectedProjectId}\0${canonicalJson(obligation)}`;
}

export function validateExchangeNoticeInventory(
  value: unknown,
  lifecycle: ExchangeLifecycle,
  collaboration: ExchangeCollaboration,
  committedHeads: ReadonlySet<number>,
): boolean {
  if (
    !memoObject(value, ["compatibilityAt", "openConnectionIssues"]) ||
    (value.compatibilityAt !== null && !isCanonicalUtcTimestamp(value.compatibilityAt)) ||
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

  const distinctHeadSet = new Set<number>();
  for (const { outcome } of collaboration.operations) {
    if (outcome.kind === "notice-ack" && committedHeads.has(outcome.observedThroughSeq)) {
      distinctHeadSet.add(outcome.observedThroughSeq);
    }
  }
  const headCache = new Map<
    number,
    { members: ReadonlySet<string>; obligationsByKey: ReadonlyMap<string, ExchangeResponseObligation> }
  >();
  if (distinctHeadSet.size > 0) {
    const distinctHeads = [...distinctHeadSet].sort((a, b) => a - b);
    const sortedTransitions = [...lifecycle.transitions].sort((a, b) => a.seq - b.seq);
    const sortedMessages = [...collaboration.messages].sort((a, b) => a.seq - b.seq);
    const requestsById = new Map<string, ExchangeCollaboration["requests"][number]>();
    for (const request of collaboration.requests) {
      if (!requestsById.has(request.id)) requestsById.set(request.id, request);
    }
    const reportsByKey = new Map<string, ExchangeCollaboration["reports"][number]>();
    for (const report of collaboration.reports) {
      const key = requestVersionKey(report.requestId, report.version);
      if (!reportsByKey.has(key)) reportsByKey.set(key, report);
    }
    const acceptancesByKey = new Map<string, ExchangeCollaboration["acceptances"][number]>();
    for (const acceptance of collaboration.acceptances) {
      const key = requestVersionKey(acceptance.requestId, acceptance.reportVersion);
      if (!acceptancesByKey.has(key)) acceptancesByKey.set(key, acceptance);
    }

    const prefixTransitions: ExchangeLifecycle["transitions"] = [];
    const prefixMessages: ExchangeCollaboration["messages"] = [];
    const prefixRequests: ExchangeCollaboration["requests"] = [];
    const prefixReports: ExchangeCollaboration["reports"] = [];
    const prefixAcceptances: ExchangeCollaboration["acceptances"] = [];
    const seenRequestIds = new Set<string>();
    const seenReportKeys = new Set<string>();
    const seenAcceptanceKeys = new Set<string>();
    let transitionIndex = 0;
    let messageIndex = 0;

    for (const headSeq of distinctHeads) {
      while (transitionIndex < sortedTransitions.length) {
        const record = sortedTransitions[transitionIndex];
        if (!record || record.seq > headSeq) break;
        prefixTransitions.push(record);
        transitionIndex++;
      }
      while (messageIndex < sortedMessages.length) {
        const message = sortedMessages[messageIndex];
        if (!message || message.seq > headSeq) break;
        prefixMessages.push(message);
        if (message.kind === "request" && message.requestId !== null && !seenRequestIds.has(message.requestId)) {
          seenRequestIds.add(message.requestId);
          const request = requestsById.get(message.requestId);
          if (request) prefixRequests.push(request);
        } else if (message.kind === "report" && message.requestId !== null && message.reportVersion !== null) {
          const key = requestVersionKey(message.requestId, message.reportVersion);
          if (!seenReportKeys.has(key)) {
            seenReportKeys.add(key);
            const report = reportsByKey.get(key);
            if (report) prefixReports.push(report);
          }
        } else if (message.kind === "accept" && message.requestId !== null && message.reportVersion !== null) {
          const key = requestVersionKey(message.requestId, message.reportVersion);
          if (!seenAcceptanceKeys.has(key)) {
            seenAcceptanceKeys.add(key);
            const acceptance = acceptancesByKey.get(key);
            if (acceptance) prefixAcceptances.push(acceptance);
          }
        }
        messageIndex++;
      }
      const observedLifecycle = { ...lifecycle, transitions: prefixTransitions };
      const observed = exchangeLifecycleHead(observedLifecycle);
      const obligations = exchangeResponseObligations(
        observedLifecycle,
        {
          requests: prefixRequests,
          reports: prefixReports,
          acceptances: prefixAcceptances,
          messages: prefixMessages,
        },
        compatibilityAt,
      );
      const obligationsByKey = new Map<string, ExchangeResponseObligation>();
      for (const candidate of obligations) {
        const key = obligationLookupKey(candidate.affectedProjectId, candidate.obligation);
        if (!obligationsByKey.has(key)) obligationsByKey.set(key, candidate);
      }
      headCache.set(headSeq, { members: observed.members, obligationsByKey });
    }
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
    const cached = headCache.get(outcome.observedThroughSeq);
    if (!cached || !cached.members.has(outcome.projectId)) return false;
    const response = cached.obligationsByKey.get(obligationLookupKey(outcome.affectedProjectId, outcome.obligation));
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
