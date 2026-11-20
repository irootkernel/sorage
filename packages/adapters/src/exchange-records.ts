import type { ExchangeSnapshotRecord } from "@sorage/core";
import {
  EXCHANGE_COLLABORATION_TABLES,
  readExchangeCollaboration,
  restoreExchangeCollaboration,
} from "./exchange-collaboration-records";
import type { SorageSqlite } from "./sqlite/connection";

export const EXCHANGE_FOUNDATION_TABLES = [
  "exchanges",
  "exchange_members",
  "exchange_read_ranges",
  "exchange_creation_outcomes",
  "exchange_working_content",
  "exchange_activation_intents",
  ...EXCHANGE_COLLABORATION_TABLES,
] as const;

interface FoundationRow {
  id: string;
  opening_project_id: string;
  goal: string;
  criteria_json: string;
  created_at: string;
}

interface MemberRow {
  exchange_id: string;
  project_id: string;
}

/** Project only retained Exchange fields. This must run in the export's existing read transaction. */
export function readExchangeRecords(db: SorageSqlite): ExchangeSnapshotRecord[] {
  const rows = db
    .prepare<FoundationRow>("SELECT id, opening_project_id, goal, criteria_json, created_at FROM exchanges ORDER BY id")
    .all();
  const snapshots = new Map(
    rows.map((row): [string, ExchangeSnapshotRecord] => [
      row.id,
      {
        id: row.id,
        openingProjectId: row.opening_project_id,
        goal: row.goal,
        criteria: JSON.parse(row.criteria_json) as string[],
        createdAt: row.created_at,
        members: [],
        readRanges: [],
        creationOutcomes: [],
      },
    ]),
  );
  const record = (exchangeId: string): ExchangeSnapshotRecord => {
    const snapshot = snapshots.get(exchangeId);
    if (!snapshot) throw new Error("An Exchange association names a missing retained record.");
    return snapshot;
  };
  for (const row of db.prepare<MemberRow>("SELECT exchange_id, project_id FROM exchange_members").all()) {
    record(row.exchange_id).members.push(row.project_id);
  }
  for (const row of db
    .prepare<MemberRow & { first_seq: number; last_seq: number }>(
      "SELECT exchange_id, project_id, first_seq, last_seq FROM exchange_read_ranges",
    )
    .all()) {
    record(row.exchange_id).readRanges.push({
      projectId: row.project_id,
      firstSeq: row.first_seq,
      lastSeq: row.last_seq,
    });
  }
  for (const row of db
    .prepare<MemberRow & { operation_id: string; fingerprint: string }>(
      "SELECT exchange_id, project_id, operation_id, fingerprint FROM exchange_creation_outcomes",
    )
    .all()) {
    record(row.exchange_id).creationOutcomes.push({
      projectId: row.project_id,
      operationId: row.operation_id,
      fingerprint: row.fingerprint,
    });
  }
  return [...snapshots.values()];
}

export function readExchangeCollaborationRecords(db: SorageSqlite, redact: boolean): ExchangeSnapshotRecord[] {
  return readExchangeRecords(db).map((row) => ({
    ...row,
    collaboration: readExchangeCollaboration(db, row.id, redact),
  }));
}

/** Restore validated compact records in the existing import transaction, after Projects. */
export function restoreExchangeRecords(db: SorageSqlite, records: ExchangeSnapshotRecord[]): void {
  for (const record of records) {
    db.prepare(
      "INSERT INTO exchanges (id, opening_project_id, goal, criteria_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(record.id, record.openingProjectId, record.goal, JSON.stringify(record.criteria), record.createdAt);
    for (const projectId of record.members) {
      db.prepare("INSERT INTO exchange_members (exchange_id, project_id) VALUES (?, ?)").run(record.id, projectId);
    }
    for (const range of record.readRanges) {
      db.prepare(
        "INSERT INTO exchange_read_ranges (exchange_id, project_id, first_seq, last_seq) VALUES (?, ?, ?, ?)",
      ).run(record.id, range.projectId, range.firstSeq, range.lastSeq);
    }
    for (const outcome of record.creationOutcomes) {
      db.prepare(
        "INSERT INTO exchange_creation_outcomes (project_id, operation_id, exchange_id, fingerprint) VALUES (?, ?, ?, ?)",
      ).run(outcome.projectId, outcome.operationId, record.id, outcome.fingerprint);
    }
    if (record.collaboration) restoreExchangeCollaboration(db, record.id, record.collaboration);
    else
      db.prepare("UPDATE exchanges SET last_seq = ? WHERE id = ?").run(
        record.readRanges.reduce((maximum, range) => Math.max(maximum, range.lastSeq), 0),
        record.id,
      );
  }
}
