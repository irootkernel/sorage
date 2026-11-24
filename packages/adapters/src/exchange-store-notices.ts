import { randomUUID } from "node:crypto";
import {
  appError,
  EXCHANGE_REPORTING_CLAIM_MS,
  type ExchangeBusinessResult,
  type ExchangeLifecycleInput,
  type ExchangeNoticeAckInput,
  type ExchangeNoticeIncident,
  type ExchangeNoticeList,
  type ExchangeNoticeOutcome,
  type ExchangeReportingClaim,
  isLowercaseSha256,
  requireExchangeClaim,
} from "@sorage/core";
import { conflict, type ExchangeStoreInternals, fail, type Header, invalid, need } from "./exchange-context";
import { readExchangeLifecycle } from "./exchange-lifecycle-records";
import { type NoticeSlot, observeExchangeNotices, retainConnectionIssue } from "./exchange-notice-records";

export function listExchangeNotices(store: ExchangeStoreInternals, header: Header, claim?: string): ExchangeNoticeList {
  const now = store.now();
  const { incidents, live, slots } = observeExchangeNotices(
    store.db,
    store.context.config.installationId,
    header.id,
    readExchangeLifecycle(store.db, header.id),
    now,
  );
  const callerLive = claim !== undefined && live.get(store.actorId)?.claimId === claim;
  return {
    exchangeId: header.id,
    projectId: store.actorId,
    notices: incidents.map((incident) => {
      const slot = slots.get(incident.incidentId);
      const canAcquire =
        callerLive &&
        (slot
          ? slot.projectId === store.actorId
          : store.actorId === header.openingProjectId ||
            !live.has(header.openingProjectId) ||
            Date.parse(incident.priorityUntil) <= now.getTime());
      return { ...incident, canAcquire };
    }),
  };
}

function noticeAdmission(
  store: ExchangeStoreInternals,
  input: Pick<ExchangeNoticeAckInput, "exchangeId" | "incidentId" | "claim">,
) {
  const { exchangeId, incidentId, claim } = input;
  const header = store.access(exchangeId);
  if (!isLowercaseSha256(incidentId)) return invalid("Supply a current Exchange notice incident ID.");
  const now = store.now();
  const { incidents, live, slots } = observeExchangeNotices(
    store.db,
    store.context.config.installationId,
    exchangeId,
    readExchangeLifecycle(store.db, exchangeId),
    now,
  );
  const participant = need(requireExchangeClaim(live.get(store.actorId) ?? null, claim, now));
  const incident = incidents.find((entry) => entry.incidentId === incidentId);
  if (!incident) return conflict("The Exchange notice incident is no longer current or has already been issued.");
  return { now, header, incident, participant, live, slot: slots.get(incidentId) };
}

export function acquireExchangeNotice(
  store: ExchangeStoreInternals,
  input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
  write: true,
): ExchangeReportingClaim;
export function acquireExchangeNotice(
  store: ExchangeStoreInternals,
  input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
  write: false,
): ExchangeReportingClaim | undefined;
export function acquireExchangeNotice(
  store: ExchangeStoreInternals,
  input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
  write: boolean,
): ExchangeReportingClaim | undefined;
export function acquireExchangeNotice(
  store: ExchangeStoreInternals,
  input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
  write: boolean,
): ExchangeReportingClaim | undefined {
  const { exchangeId, incidentId } = input;
  const { now, header, incident, participant, live, slot } = noticeAdmission(store, input);
  const retained = (entry: Pick<NoticeSlot, "reportingClaimId" | "expiresAt">) => ({
    exchangeId,
    projectId: store.actorId,
    incidentId,
    reportingClaimId: entry.reportingClaimId,
    expiresAt: entry.expiresAt,
  });
  if (slot) {
    if (slot.projectId !== store.actorId) return conflict("A current reporting claim already owns this notice.");
    return retained(slot);
  }
  if (
    header.openingProjectId !== store.actorId &&
    live.has(header.openingProjectId) &&
    Date.parse(incident.priorityUntil) > now.getTime()
  )
    return conflict("The opening Project still has priority for this notice.");
  if (!write) return;
  const reportingClaimId = randomUUID();
  const expiresAt = new Date(now.getTime() + EXCHANGE_REPORTING_CLAIM_MS).toISOString();
  store.context.onFreshWrite?.();
  store.db
    .prepare("DELETE FROM exchange_notice_claims WHERE exchange_id = ? AND expires_at <= ?")
    .run(exchangeId, now.toISOString());
  store.db
    .prepare(`INSERT INTO exchange_notice_claims VALUES (?,?,?,?,?,?)
      ON CONFLICT(exchange_id,incident_id) DO UPDATE SET reporting_claim_id=excluded.reporting_claim_id,
        project_id=excluded.project_id, participant_claim_id=excluded.participant_claim_id, expires_at=excluded.expires_at`)
    .run(exchangeId, incidentId, reportingClaimId, store.actorId, participant.claimId, expiresAt);
  return retained({ reportingClaimId, expiresAt });
}

export function admitExchangeNoticeAck(
  store: ExchangeStoreInternals,
  input: ExchangeNoticeAckInput,
): { now: Date; header: Header; incident: ExchangeNoticeIncident } {
  const { now, header, incident, slot } = noticeAdmission(store, input);
  if (slot?.projectId !== store.actorId || slot.reportingClaimId !== input.reportingClaim)
    return fail({
      ...appError("ROW_VERSION_CONFLICT", "Use the exact live reporting claim for this Exchange notice."),
      recovery: {
        suggestedCommand:
          "Run sorage exchange notice-list <exchange-id> --claim <id> --json or call exchange_notice_list with the current claim. Acknowledge the same incident only after issuing it while its exact reporting slot is live. If the outcome is uncertain, use replay-only with the original incident and operation IDs.",
      },
    });
  return { now, header, incident };
}

export function acknowledgeExchangeNotice(
  store: ExchangeStoreInternals,
  input: ExchangeNoticeAckInput,
  fingerprint: string,
): ExchangeBusinessResult {
  const { now, header, incident } = admitExchangeNoticeAck(store, input);
  const outcome: ExchangeNoticeOutcome = {
    kind: "notice-ack",
    exchangeId: input.exchangeId,
    incidentId: incident.incidentId,
    noticeKind: incident.noticeKind,
    affectedProjectId: incident.affectedProjectId,
    projectId: store.actorId,
    obligation: incident.obligation,
    observedThroughSeq: header.lastSeq,
    issuedAt: now.toISOString(),
  };
  store.context.onFreshWrite?.();
  store.saveOutcome(outcome, input.operationId, fingerprint);
  if (incident.noticeKind === "connection-check") {
    // Admission already established this lease was non-live. It cannot become live after a clock correction.
    store.db
      .prepare("DELETE FROM exchange_claims WHERE exchange_id = ? AND project_id = ?")
      .run(outcome.exchangeId, outcome.affectedProjectId);
    retainConnectionIssue(store.db, outcome, input.operationId);
  }
  store.db
    .prepare("DELETE FROM exchange_notice_claims WHERE exchange_id = ? AND incident_id = ?")
    .run(input.exchangeId, incident.incidentId);
  return store.outcomeData(outcome, false);
}
