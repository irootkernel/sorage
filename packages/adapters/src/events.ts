import {
  type AppError,
  appError,
  type DomainEventRow,
  type EventAppendPort,
  type EventType,
  err,
  type NewDomainEvent,
  ok,
  type Result,
} from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The SQLite append-only event ledger behind the core port (SEC-012, HND-016, HND-017).
 * `append` runs inside the caller's open write transaction and lets a failure abort
 * that whole transaction, so an event never lands without the mutation it describes.
 * The migration's triggers reject an update or delete against `events`, which makes
 * the ledger append-only in practice, not by convention.
 */

interface EventRow {
  id: string;
  handoff_id: string | null;
  event_type: string;
  actor_kind: string;
  actor_id: string | null;
  row_version: number | null;
  metadata_json: string;
  created_at: string;
}

export interface SqliteEventLedger {
  /** The in-transaction append; throws on failure so the caller's transaction aborts. */
  append: EventAppendPort["append"];
  /** A convenience append for command wiring: generates the id and timestamp. */
  appendNow(input: {
    eventType: EventType;
    actor: NewDomainEvent["actor"];
    metadata: Record<string, unknown>;
    handoffId?: string | null;
    rowVersion?: number | null;
    id: string;
    createdAt: string;
  }): void;
  /** Commits one append in its own short transaction, for events without a sibling row. */
  appendStandalone(event: NewDomainEvent): Result<{ id: string }, AppError>;
  /** Reads events newest-first, optionally bounded to one Handoff; reads append nothing. */
  list(input?: { handoffId?: string; limit?: number }): Result<DomainEventRow[], AppError>;
}

export function createSqliteEventLedger(db: SorageSqlite): SqliteEventLedger {
  const insert = () =>
    db.prepare(
      "INSERT INTO events (id, handoff_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
  return {
    append(event) {
      insert().run(
        event.id,
        event.handoffId ?? null,
        event.eventType,
        event.actor.kind,
        event.actor.id,
        event.rowVersion ?? null,
        JSON.stringify(event.metadata),
        event.createdAt,
      );
    },
    appendNow(input) {
      insert().run(
        input.id,
        input.handoffId ?? null,
        input.eventType,
        input.actor.kind,
        input.actor.id,
        input.rowVersion ?? null,
        JSON.stringify(input.metadata),
        input.createdAt,
      );
    },
    appendStandalone(event) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          insert().run(
            event.id,
            event.handoffId ?? null,
            event.eventType,
            event.actor.kind,
            event.actor.id,
            event.rowVersion ?? null,
            JSON.stringify(event.metadata),
            event.createdAt,
          );
          db.exec("COMMIT");
          return ok({ id: event.id });
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Appending the ${event.eventType} event failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
    list(input) {
      try {
        const limit = Math.min(input?.limit ?? 100, 1_000);
        const rows = (input?.handoffId !== undefined
          ? db
              .prepare("SELECT * FROM events WHERE handoff_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
              .all(input.handoffId, limit)
          : db
              .prepare("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?")
              .all(limit)) as unknown as EventRow[];
        return ok(rows.map(toDomainEventRow));
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", `Reading the event ledger failed: ${messageOf(error)}.`, {
            cause: String(error),
          }),
        );
      }
    },
  };
}

function toDomainEventRow(row: EventRow): DomainEventRow {
  return {
    id: row.id,
    handoffId: row.handoff_id,
    eventType: row.event_type,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    rowVersion: row.row_version,
    metadata: safeParse(row.metadata_json),
    createdAt: row.created_at,
  };
}

function safeParse(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
