import { type ExchangeLifecycle, type ExchangeTransitionRecord, exchangeLifecycleHead } from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

export const EXCHANGE_LIFECYCLE_TABLES = [
  "exchange_transitions",
  "exchange_cleanup_intents",
  "exchange_cleanup_items",
] as const;

export function readExchangeLifecycle(db: SorageSqlite, exchangeId: string): ExchangeLifecycle {
  const revision = db.prepare("SELECT work_revision workRevision FROM exchanges WHERE id = ?").get(exchangeId) as
    | { workRevision: number }
    | undefined;
  if (!revision) throw new Error("The Exchange work revision is missing.");
  const initialMembers = db
    .prepare<{ projectId: string }>(
      "SELECT project_id projectId FROM exchange_members WHERE exchange_id = ? AND initial = 1 ORDER BY project_id",
    )
    .all(exchangeId)
    .map((row) => row.projectId);
  const transitions = db
    .prepare<
      Omit<ExchangeTransitionRecord, "transition" | "recordedAt"> & { value: string; recordedAt: string | null }
    >(
      `SELECT seq, work_revision workRevision, actor_id actorId, operation_id operationId, transition_json value, recorded_at recordedAt
     FROM exchange_transitions WHERE exchange_id = ? ORDER BY seq`,
    )
    .all(exchangeId)
    .map(({ value, recordedAt, ...row }) => ({
      ...row,
      transition: JSON.parse(value) as ExchangeTransitionRecord["transition"],
      ...(recordedAt === null ? {} : { recordedAt }),
    }));
  return { initialMembers, workRevision: revision.workRevision, transitions };
}

export function recordExchangeTransition(db: SorageSqlite, exchangeId: string, record: ExchangeTransitionRecord): void {
  db.prepare("INSERT INTO exchange_transitions VALUES (?,?,?,?,?,?,?)").run(
    exchangeId,
    record.seq,
    record.workRevision,
    record.actorId,
    record.operationId,
    JSON.stringify(record.transition),
    record.recordedAt ?? null,
  );
}

export function restoreExchangeLifecycle(db: SorageSqlite, exchangeId: string, lifecycle: ExchangeLifecycle): void {
  const head = exchangeLifecycleHead(lifecycle);
  db.prepare("UPDATE exchanges SET work_revision = ? WHERE id = ?").run(lifecycle.workRevision, exchangeId);
  db.prepare("UPDATE exchange_members SET active = 0, initial = 0 WHERE exchange_id = ?").run(exchangeId);
  for (const member of lifecycle.initialMembers)
    db.prepare("UPDATE exchange_members SET initial = 1 WHERE exchange_id = ? AND project_id = ?").run(
      exchangeId,
      member,
    );
  for (const member of head.members)
    db.prepare("UPDATE exchange_members SET active = 1 WHERE exchange_id = ? AND project_id = ?").run(
      exchangeId,
      member,
    );
  for (const transition of lifecycle.transitions) recordExchangeTransition(db, exchangeId, transition);
  if (head.state === "completed")
    db.prepare("UPDATE exchange_materials SET retired = 1 WHERE exchange_id = ? AND kind IN ('body', 'copy')").run(
      exchangeId,
    );
}
