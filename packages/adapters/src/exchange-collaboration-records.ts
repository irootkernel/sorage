import type {
  ExchangeAcceptance,
  ExchangeAcceptanceReceipt,
  ExchangeCollaboration,
  ExchangeMaterial,
  ExchangeMessage,
  ExchangeReport,
  ExchangeRequest,
  RetainedExchangeAcceptance,
  RetainedExchangeOperation,
} from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

export const EXCHANGE_COLLABORATION_TABLES = [
  "exchange_claims",
  "exchange_materials",
  "exchange_requests",
  "exchange_reports",
  "exchange_acceptances",
  "exchange_messages",
  "exchange_operation_outcomes",
] as const;

export function exchangeMessages(db: SorageSqlite, exchangeId: string, after = 0, limit = Number.MAX_SAFE_INTEGER) {
  return db
    .prepare<ExchangeMessage>(
      `SELECT seq, sender_id senderId, recipient_id recipientId, kind, reply_to replyTo,
      material_id materialId, request_id requestId, report_version reportVersion, created_at createdAt
      FROM exchange_messages WHERE exchange_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(exchangeId, after, limit);
}

export function exchangeRequests(db: SorageSqlite, exchangeId: string): ExchangeRequest[] {
  return db
    .prepare<Omit<ExchangeRequest, "criteria"> & { criteria: string }>(
      `SELECT id, requester_id requesterId, assignee_id assigneeId, assignment_version assignmentVersion,
      condition, criteria_json criteria FROM exchange_requests WHERE exchange_id = ? ORDER BY id`,
    )
    .all(exchangeId)
    .map(({ criteria, ...request }) => ({ ...request, criteria: JSON.parse(criteria) }));
}

export function exchangeReports(db: SorageSqlite, exchangeId: string): ExchangeReport[] {
  return db
    .prepare<Omit<ExchangeReport, "evidence"> & { evidence: string }>(
      `SELECT request_id requestId, version, assignment_version assignmentVersion, author_id authorId,
      material_id materialId, evidence_json evidence FROM exchange_reports WHERE exchange_id = ? ORDER BY request_id, version`,
    )
    .all(exchangeId)
    .map(({ evidence, ...report }) => ({ ...report, evidence: JSON.parse(evidence) }));
}

function acceptanceRows(db: SorageSqlite, exchangeId: string) {
  return db
    .prepare<ExchangeAcceptance & { receiptKind: ExchangeAcceptanceReceipt["kind"]; receiptOperationId: string }>(
      `SELECT request_id requestId, report_version reportVersion, requester_id requesterId, accepted_at acceptedAt,
      receipt_kind receiptKind, receipt_operation_id receiptOperationId
      FROM exchange_acceptances WHERE exchange_id = ? ORDER BY request_id, report_version`,
    )
    .all(exchangeId);
}

export function exchangeAcceptances(db: SorageSqlite, exchangeId: string): ExchangeAcceptance[] {
  return acceptanceRows(db, exchangeId).map(({ receiptKind: _kind, receiptOperationId: _operationId, ...row }) => row);
}

export function insertExchangeAcceptance(db: SorageSqlite, exchangeId: string, row: RetainedExchangeAcceptance): void {
  db.prepare(
    `INSERT INTO exchange_acceptances
    (exchange_id, request_id, report_version, requester_id, accepted_at, receipt_operation_id, receipt_kind)
    VALUES (?,?,?,?,?,?,?)`,
  ).run(
    exchangeId,
    row.requestId,
    row.reportVersion,
    row.requesterId,
    row.acceptedAt,
    row.receipt.operationId,
    row.receipt.kind,
  );
}

export interface MaterialRow extends Omit<ExchangeMaterial, "scope"> {
  contentId: string | null;
  source: string | null;
  available: number;
}

const SELECT_MATERIALS = `SELECT id, owner_project_id ownerProjectId, kind, size_bytes sizeBytes,
  sha256, content_id contentId, scope_json source, available FROM exchange_materials WHERE exchange_id = ?`;

export function exchangeMaterial(db: SorageSqlite, exchangeId: string, id: string) {
  return db.prepare(`${SELECT_MATERIALS} AND id = ?`).get(exchangeId, id) as MaterialRow | undefined;
}

function retainedMaterial(row: MaterialRow, redact: boolean): ExchangeMaterial {
  const { contentId: _content, available: _available, source, ...metadata } = row;
  let scope: ExchangeMaterial["scope"] = null;
  if (source !== null) {
    if (row.kind === "external") scope = JSON.parse(source);
    else {
      const { offset, length, root, relativePath } = JSON.parse(source);
      scope = { offset, length, ...(!redact && root !== undefined ? { root, relativePath } : {}) };
    }
  }
  return { ...metadata, scope };
}

export function exchangeOperations(db: SorageSqlite, exchangeId: string, projectId?: string) {
  return db
    .prepare<Omit<RetainedExchangeOperation, "outcome"> & { outcome: string }>(
      `SELECT project_id projectId, operation_id operationId, fingerprint, outcome_json outcome
      FROM exchange_operation_outcomes WHERE exchange_id = ? AND (? IS NULL OR project_id = ?)
      ORDER BY project_id, operation_id`,
    )
    .all(exchangeId, projectId ?? null, projectId ?? null)
    .map(({ outcome, ...record }): RetainedExchangeOperation => ({ ...record, outcome: JSON.parse(outcome) }));
}

/** Select only compact typed facts, inside the backup reader's transaction. */
export function readExchangeCollaboration(
  db: SorageSqlite,
  exchangeId: string,
  redact: boolean,
): ExchangeCollaboration {
  const sequence = db.prepare("SELECT last_seq lastSeq FROM exchanges WHERE id = ?").get(exchangeId) as
    | { lastSeq: number }
    | undefined;
  if (!sequence) throw new Error("An Exchange disappeared from the retained read transaction");
  return {
    lastSeq: sequence.lastSeq,
    messages: exchangeMessages(db, exchangeId),
    requests: exchangeRequests(db, exchangeId),
    reports: exchangeReports(db, exchangeId),
    acceptances: acceptanceRows(db, exchangeId).map(({ receiptKind, receiptOperationId, ...row }) => ({
      ...row,
      receipt: { operationId: receiptOperationId, kind: receiptKind },
    })),
    materials: db
      .prepare<MaterialRow>(`${SELECT_MATERIALS} ORDER BY id`)
      .all(exchangeId)
      .map((row) => retainedMaterial(row, redact)),
    operations: exchangeOperations(db, exchangeId),
  };
}

/** Insert the validated inventory into the existing restore transaction. */
export function restoreExchangeCollaboration(
  db: SorageSqlite,
  exchangeId: string,
  collaboration: ExchangeCollaboration,
): void {
  db.prepare("UPDATE exchanges SET last_seq = ? WHERE id = ?").run(collaboration.lastSeq, exchangeId);
  const materials = db.prepare(
    "INSERT INTO exchange_materials (exchange_id,id,owner_project_id,kind,size_bytes,sha256,scope_json,available) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const row of collaboration.materials) {
    materials.run(
      exchangeId,
      row.id,
      row.ownerProjectId,
      row.kind,
      row.sizeBytes,
      row.sha256,
      row.scope === null ? null : JSON.stringify(row.scope),
      row.kind === "external" ? 1 : 0,
    );
  }
  const requests = db.prepare("INSERT INTO exchange_requests VALUES (?,?,?,?,?,?,?)");
  for (const row of collaboration.requests) {
    requests.run(
      exchangeId,
      row.id,
      row.requesterId,
      row.assigneeId,
      row.assignmentVersion,
      row.condition,
      JSON.stringify(row.criteria),
    );
  }
  const reports = db.prepare("INSERT INTO exchange_reports VALUES (?,?,?,?,?,?,?)");
  for (const row of collaboration.reports) {
    reports.run(
      exchangeId,
      row.requestId,
      row.version,
      row.assignmentVersion,
      row.authorId,
      row.materialId,
      JSON.stringify(row.evidence),
    );
  }
  for (const row of collaboration.acceptances) {
    insertExchangeAcceptance(db, exchangeId, row);
  }
  const messages = db.prepare("INSERT INTO exchange_messages VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const row of collaboration.messages) {
    messages.run(
      exchangeId,
      row.seq,
      row.senderId,
      row.recipientId,
      row.kind,
      row.replyTo,
      row.materialId,
      row.requestId,
      row.reportVersion,
      row.createdAt,
    );
  }
  const operations = db.prepare("INSERT INTO exchange_operation_outcomes VALUES (?,?,?,?,?)");
  for (const row of collaboration.operations) {
    operations.run(exchangeId, row.projectId, row.operationId, row.fingerprint, JSON.stringify(row.outcome));
  }
}
