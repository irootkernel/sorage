import {
  type ExchangeClaim,
  type ExchangeCollaboration,
  type ExchangeLifecycle,
  type ExchangeNoticeIncident,
  type ExchangeNoticeInventory,
  type ExchangeNoticeOutcome,
  type ExchangeNoticePresence,
  exchangeNoticeBasisKey,
  exchangeNoticeIncident,
  exchangeResponseObligations,
} from "@sorage/core";
import {
  exchangeAcceptances,
  exchangeReports,
  exchangeRequests,
  exchangeResponseMessages,
} from "./exchange-collaboration-records";
import type { SorageSqlite } from "./sqlite/connection";

export const EXCHANGE_NOTICE_TABLES = [
  "exchange_notice_presence",
  "exchange_notice_claims",
  "exchange_notice_issues",
] as const;

interface ProjectLease extends ExchangeClaim {
  projectId: string;
}

export interface NoticeSlot {
  incidentId: string;
  reportingClaimId: string;
  projectId: string;
  participantClaimId: string;
  expiresAt: string;
}

function compatibilityTime(db: SorageSqlite, exchangeId: string): string | null {
  const row = db.prepare("SELECT notice_compatibility_at time FROM exchanges WHERE id = ?").get(exchangeId) as
    | { time: string | null }
    | undefined;
  return row?.time ?? null;
}

export function readNoticeInventory(
  db: SorageSqlite,
  exchangeId: string,
  lifecycle: ExchangeLifecycle,
  collaboration: ExchangeCollaboration,
): ExchangeNoticeInventory {
  const compatibilityAt = compatibilityTime(db, exchangeId);
  const current = new Set(
    exchangeResponseObligations(lifecycle, collaboration, compatibilityAt).map(exchangeNoticeBasisKey),
  );
  const openConnectionIssues = db
    .prepare<{ basisKey: string; incidentId: string }>(
      "SELECT basis_key basisKey, incident_id incidentId FROM exchange_notice_issues WHERE exchange_id = ?",
    )
    .all(exchangeId)
    .filter((row) => current.has(row.basisKey))
    .map(({ incidentId }) => incidentId);
  return { compatibilityAt, openConnectionIssues };
}

export function retainConnectionIssue(db: SorageSqlite, outcome: ExchangeNoticeOutcome, operationId: string): void {
  db.prepare(`INSERT INTO exchange_notice_issues
    (exchange_id, basis_key, incident_id, affected_project_id, reporter_project_id, operation_id)
    VALUES (?,?,?,?,?,?)`).run(
    outcome.exchangeId,
    exchangeNoticeBasisKey(outcome),
    outcome.incidentId,
    outcome.affectedProjectId,
    outcome.projectId,
    operationId,
  );
}

export function observeExchangeNotices(
  db: SorageSqlite,
  installationId: string,
  exchangeId: string,
  lifecycle: ExchangeLifecycle,
  now: Date,
): { incidents: ExchangeNoticeIncident[]; live: Map<string, ProjectLease>; slots: Map<string, NoticeSlot> } {
  const responses = exchangeResponseObligations(
    lifecycle,
    {
      requests: exchangeRequests(db, exchangeId),
      reports: exchangeReports(db, exchangeId),
      acceptances: exchangeAcceptances(db, exchangeId),
      messages: exchangeResponseMessages(db, exchangeId),
    },
    compatibilityTime(db, exchangeId),
  );
  const time = now.toISOString();
  const live = new Map(
    db
      .prepare<ProjectLease>(`SELECT c.project_id projectId, c.claim_id claimId, c.expires_at expiresAt
    FROM exchange_claims c JOIN exchange_members m ON m.exchange_id = c.exchange_id AND m.project_id = c.project_id
    JOIN projects p ON p.id = c.project_id
    WHERE c.exchange_id = ? AND c.expires_at > ? AND m.active = 1 AND p.status = 'active'
      AND EXISTS (SELECT 1 FROM project_bindings b WHERE b.project_id = c.project_id AND b.installation_id = ?)`)
      .all(exchangeId, time, installationId)
      .map((row) => [row.projectId, row]),
  );
  const slots = new Map(
    db
      .prepare<NoticeSlot>(`SELECT incident_id incidentId, reporting_claim_id reportingClaimId,
      project_id projectId, participant_claim_id participantClaimId, expires_at expiresAt
    FROM exchange_notice_claims WHERE exchange_id = ? AND expires_at > ?`)
      .all(exchangeId, time)
      .filter((row) => live.get(row.projectId)?.claimId === row.participantClaimId)
      .map((row) => [row.incidentId, row]),
  );
  if (responses.length === 0) return { incidents: [], live, slots };
  const presence = new Map(
    db
      .prepare<ExchangeNoticePresence & { projectId: string }>(`SELECT project_id projectId,
      heartbeat_at heartbeatAt, online_since onlineSince, epoch FROM exchange_notice_presence WHERE exchange_id = ?`)
      .all(exchangeId)
      .map((row) => [row.projectId, row]),
  );
  const issued = new Set<string>();
  const connectionAcks = new Map<string, number>();
  const acknowledgements = db
    .prepare<{ outcome: string }>(`SELECT outcome_json outcome
    FROM exchange_operation_outcomes WHERE exchange_id = ? AND json_extract(outcome_json, '$.kind') = 'notice-ack'`)
    .all(exchangeId);
  for (const { outcome } of acknowledgements) {
    const notice = JSON.parse(outcome) as ExchangeNoticeOutcome;
    issued.add(notice.incidentId);
    if (notice.noticeKind === "connection-check") {
      const basis = exchangeNoticeBasisKey(notice);
      connectionAcks.set(basis, (connectionAcks.get(basis) ?? 0) + 1);
    }
  }
  const issues = new Set(
    db
      .prepare<{ basisKey: string }>("SELECT basis_key basisKey FROM exchange_notice_issues WHERE exchange_id = ?")
      .all(exchangeId)
      .map(({ basisKey }) => basisKey),
  );
  const didRead = db.prepare(`SELECT 1 FROM exchange_read_ranges
    WHERE exchange_id = ? AND project_id = ? AND first_seq <= ? AND last_seq >= ? LIMIT 1`);
  const incidents: ExchangeNoticeIncident[] = [];
  for (const response of responses) {
    const {
      affectedProjectId,
      obligation: { sourceSeq },
    } = response;
    const isLive = live.has(affectedProjectId);
    const read = isLive && Boolean(didRead.get(exchangeId, affectedProjectId, sourceSeq, sourceSeq));
    const basis = exchangeNoticeBasisKey(response);
    if (!isLive && issues.has(basis)) continue;
    const incident = exchangeNoticeIncident(
      response,
      now,
      isLive,
      read,
      presence.get(affectedProjectId),
      connectionAcks.get(basis),
    );
    if (incident && !issued.has(incident.incidentId)) incidents.push(incident);
  }
  incidents.sort((a, b) => a.eligibleAt.localeCompare(b.eligibleAt) || a.incidentId.localeCompare(b.incidentId));
  return { incidents, live, slots };
}
