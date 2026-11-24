import {
  appError,
  type ChannelCounters,
  type ChannelDomainEventType,
  type ChannelReader,
  type ChannelRecord,
  type ChannelRepository,
  type ChannelTransaction,
  channelDomainEvent,
  err,
  type MessagePageQuery,
  type MessageRecord,
  ok,
  type ParticipantRecord,
  type Result,
  validateChannelEventMetadata,
} from "@sorage/core";
import type { SqliteContentStore } from "./content-store";
import { createSqliteEventLedger } from "./events";
import { isSafeVaultRelativePath } from "./managed-paths";
import type { SorageSqlite } from "./sqlite/connection";
import { runInTransaction } from "./sqlite/transaction";
import { storageContentionOf } from "./storage-contention";

/**
 * The TASK-123 rebuilt Channel SQLite repository (CHN-001 to CHN-014, interface
 * sections 38.3 to 38.6, ADR-0034): the SQLite repository and row mappers behind
 * the rebuilt core ports over the `channels-v2` tables. Mutations run one
 * `BEGIN IMMEDIATE` transaction through the shared transaction helper with its
 * vault-move fence check; one-shot reads run a plain `BEGIN`/`COMMIT` with no
 * SQL fence. Node composition lives in `channel-command-ports.ts`.
 */

/** Binds one verbatim text value's exact UTF-8 bytes (a leading BOM stays byte-exact). */
const text = (value: string | null): Buffer | null => (value === null ? null : Buffer.from(value, "utf8"));

interface ChannelRow {
  id: string;
  name: string;
  title: string | null;
  state: string;
  created_at: string;
  closed_at: string | null;
}

interface ParticipantRow {
  channel_id: string;
  handle: string;
  role: string;
  added_at: string;
  removed_at: string | null;
}

/** One message row joined with its immutable content record (a dangling record is a whole-page integrity refusal, SHR-004). */
interface MessageJoinRow {
  channel_id: string;
  seq: number;
  sender_handle: string;
  kind: string;
  to_handle: string | null;
  ref: string | null;
  handled: number;
  handled_at: string | null;
  handle_note: string | null;
  created_at: string;
  record_id: string | null;
  inline_text: string | null;
  storage_key: string | null;
  materialized: number | null;
  size_bytes: number | null;
  sha256: string | null;
}

function channelFromRow(row: ChannelRow | null | undefined): ChannelRecord | null {
  if (row === null || row === undefined) return null;
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    state: row.state === "closed" ? "closed" : "open",
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function participantFromRow(row: ParticipantRow): ParticipantRecord {
  return {
    channelId: row.channel_id,
    handle: row.handle,
    role: row.role === "main" ? "main" : row.role === "judge" ? "judge" : "worker",
    addedAt: row.added_at,
    removedAt: row.removed_at,
  };
}

function messageFromRow(row: MessageJoinRow): Result<MessageRecord> {
  if (
    row.record_id === null ||
    row.record_id === undefined ||
    row.size_bytes === null ||
    row.size_bytes === undefined ||
    row.sha256 === null ||
    row.sha256 === undefined
  ) {
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        `The Channel ${row.channel_id} message ${String(row.seq)} references a missing content record; the page could not be assembled`,
        { channelId: row.channel_id, seq: row.seq },
      ),
    );
  }
  return ok({
    channelId: row.channel_id,
    seq: Number(row.seq),
    senderHandle: row.sender_handle,
    kind: row.kind as MessageRecord["kind"],
    toHandle: row.to_handle,
    ref: row.ref,
    content: {
      recordId: row.record_id,
      representation: row.inline_text !== null ? "inline" : "file",
      materialized: row.materialized === 1,
      inlineText: row.inline_text,
      storageKey: row.storage_key,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
    },
    handled: row.handled === 1,
    handledAt: row.handled_at,
    handleNote: row.handle_note,
    createdAt: row.created_at,
  });
}

function databaseResult<T>(work: () => Result<T>): Result<T> {
  try {
    return work();
  } catch (error) {
    // The channels adapter is Channel-family by construction, so a busy
    // signature in any repository transaction becomes the stamped refusal.
    const contention = storageContentionOf(error, "channel");
    if (contention !== null) return err(contention);
    return err(
      appError(
        "INTERNAL_ERROR",
        `The Channel storage operation failed: ${error instanceof Error ? error.message : String(error)}.`,
        {
          cause: String(error),
        },
      ),
    );
  }
}

const MESSAGE_JOIN_SELECT = `SELECT m.channel_id AS channel_id, m.seq AS seq, m.sender_handle AS sender_handle, m.kind AS kind,
    m.to_handle AS to_handle, m.ref AS ref, m.handled AS handled, m.handled_at AS handled_at, m.handle_note AS handle_note, m.created_at AS created_at,
    c.id AS record_id, c.inline_text AS inline_text, c.storage_key AS storage_key, c.materialized AS materialized, c.size_bytes AS size_bytes, c.sha256 AS sha256
  FROM channel_messages m LEFT JOIN content_records c ON c.id = m.content_record_id`;

function pageOfRows(rows: MessageJoinRow[]): Result<MessageRecord[]> {
  const records: MessageRecord[] = [];
  for (const row of rows) {
    const mapped = messageFromRow(row);
    if (!mapped.ok) return mapped;
    records.push(mapped.value);
  }
  return ok(records);
}

export interface SqliteChannelRepositoryOptions {
  contentStore: SqliteContentStore;
}

export function createSqliteChannelRepository(
  db: SorageSqlite,
  options: SqliteChannelRepositoryOptions,
): ChannelRepository {
  const store = options.contentStore;
  const ledger = createSqliteEventLedger(db);

  const channelRowById = (id: string): ChannelRow | null =>
    (db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | null | undefined) ?? null;
  const channelRowByName = (name: string): ChannelRow | null =>
    (db.prepare("SELECT * FROM channels WHERE name = CAST(? AS TEXT)").get(text(name)) as
      | ChannelRow
      | null
      | undefined) ?? null;
  const participantsOf = (channelId: string): ParticipantRow[] =>
    db
      .prepare("SELECT * FROM channel_participants WHERE channel_id = ? ORDER BY handle COLLATE BINARY")
      .all(channelId) as unknown as ParticipantRow[];
  const participantOf = (channelId: string, handle: string): ParticipantRow | null =>
    (db
      .prepare("SELECT * FROM channel_participants WHERE channel_id = ? AND handle = CAST(? AS TEXT)")
      .get(channelId, text(handle)) as ParticipantRow | null | undefined) ?? null;

  const queryMessages = (channelId: string, query: MessagePageQuery, limit: number): Result<MessageRecord[]> => {
    const where: string[] = ["m.channel_id = ?"];
    const params: unknown[] = [channelId];
    if (query.handling === "unhandled") where.push("m.handled = 0");
    if (query.afterSeq !== null) {
      where.push("m.seq > ?");
      params.push(query.afterSeq);
    }
    if (query.fromHandle !== null) {
      where.push("m.sender_handle = CAST(? AS TEXT)");
      params.push(text(query.fromHandle));
    }
    if (query.kind !== null) {
      where.push("m.kind = ?");
      params.push(query.kind);
    }
    const rows = db
      .prepare(`${MESSAGE_JOIN_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.seq ASC LIMIT ?`)
      .all(...params, limit) as unknown as MessageJoinRow[];
    return databaseResult(() => pageOfRows(rows));
  };

  const countersOf = (channelId: string): ChannelCounters => {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN handled = 0 THEN 1 ELSE 0 END) AS unhandled FROM channel_messages WHERE channel_id = ?",
      )
      .get(channelId) as { total: number; unhandled: number | null };
    return { total: Number(row.total), unhandled: Number(row.unhandled ?? 0) };
  };

  const transaction: ChannelTransaction = {
    channelByName: (name) => databaseResult(() => ok(channelFromRow(channelRowByName(name)))),
    channelById: (id) => databaseResult(() => ok(channelFromRow(channelRowById(id)))),
    participants: (channelId) => databaseResult(() => ok(participantsOf(channelId).map(participantFromRow))),
    participant: (channelId, handle) =>
      databaseResult(() => {
        const row = participantOf(channelId, handle);
        return ok(row === null ? null : participantFromRow(row));
      }),
    messageBySeq: (channelId, seq) =>
      databaseResult(() => {
        const row = db
          .prepare(`${MESSAGE_JOIN_SELECT} WHERE m.channel_id = ? AND m.seq = ?`)
          .get(channelId, seq) as unknown as MessageJoinRow;
        if (row === null || row === undefined) return ok(null);
        const mapped = messageFromRow(row);
        if (!mapped.ok) return mapped;
        return ok(mapped.value);
      }),
    pageMessages: (channelId, query, limit) => queryMessages(channelId, query, limit),
    counters: (channelId) => databaseResult(() => ok(countersOf(channelId))),
    findUnhandledDuplicate: (channelId, senderHandle, kind, toHandle, ref, bodySha256) =>
      databaseResult(() => {
        // The NULL-safe identity of CHN-005: `IS` compares the optional `--to`
        // and `--ref` exactly, including both-absent NULLs, and the body is its
        // content record's digest through the join.
        const row = db
          .prepare(
            `${MESSAGE_JOIN_SELECT} WHERE m.channel_id = ? AND m.sender_handle = CAST(? AS TEXT) AND m.kind = ?
               AND m.to_handle IS CAST(? AS TEXT) AND m.ref IS CAST(? AS TEXT) AND c.sha256 = ? AND m.handled = 0
             ORDER BY m.seq DESC LIMIT 1`,
          )
          .get(channelId, text(senderHandle), kind, text(toHandle), text(ref), bodySha256) as
          | MessageJoinRow
          | null
          | undefined;
        if (row === null || row === undefined) return ok(null);
        const mapped = messageFromRow(row);
        if (!mapped.ok) return mapped;
        return ok(mapped.value);
      }),
    nextSeq: (channelId) =>
      databaseResult(() => {
        const row = db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM channel_messages WHERE channel_id = ?")
          .get(channelId) as { next: number };
        return ok(Number(row.next));
      }),
    commitContent: (plan, ownerChannelId, createdAt) =>
      databaseResult(() => {
        if (plan.kind === "inline") {
          store.insertContentRecord({
            id: plan.contentId,
            inlineText: plan.text,
            storageKey: null,
            sizeBytes: plan.sizeBytes,
            sha256: plan.sha256,
            materialized: true,
            createdAt,
          });
          return ok(undefined);
        }
        if (!isSafeVaultRelativePath(plan.stagedPath)) {
          return err(appError("INTERNAL_ERROR", "A file content plan carries an unsafe path"));
        }
        store.insertContentRecord({
          id: plan.contentId,
          inlineText: null,
          storageKey: plan.storageKey,
          sizeBytes: plan.sizeBytes,
          sha256: plan.sha256,
          materialized: false,
          createdAt,
        });
        store.insertCommonIntent({
          id: plan.intentId,
          op: "activate",
          fromPath: plan.stagedPath,
          toPath: plan.storageKey,
          owner: { domain: "channel", ownerId: ownerChannelId },
          contentId: plan.contentId,
          createdAt,
        });
        return ok(undefined);
      }),
    insertMessage: (row) =>
      databaseResult(() => {
        db.prepare(
          `INSERT INTO channel_messages (channel_id, seq, sender_handle, kind, to_handle, ref, content_record_id,
             handled, handled_at, handle_note, created_at)
           VALUES (?, ?, CAST(? AS TEXT), ?, CAST(? AS TEXT), CAST(? AS TEXT), ?, 0, NULL, NULL, ?)`,
        ).run(
          row.channelId,
          row.seq,
          text(row.senderHandle),
          row.kind,
          text(row.toHandle),
          text(row.ref),
          row.content.recordId,
          row.createdAt,
        );
        return ok(undefined);
      }),
    insertChannel: (row) =>
      databaseResult(() => {
        db.prepare(
          "INSERT INTO channels (id, name, title, state, created_at, closed_at) VALUES (?, CAST(? AS TEXT), ?, 'open', ?, NULL)",
        ).run(row.id, text(row.name), row.title, row.createdAt);
        return ok(undefined);
      }),
    insertParticipant: (channelId, handle, role, addedAt) =>
      databaseResult(() => {
        db.prepare(
          "INSERT INTO channel_participants (channel_id, handle, role, added_at, removed_at) VALUES (?, CAST(? AS TEXT), ?, ?, NULL)",
        ).run(channelId, text(handle), role, addedAt);
        return ok(undefined);
      }),
    reRegisterParticipant: (channelId, handle, addedAt) =>
      databaseResult(() => {
        db.prepare(
          "UPDATE channel_participants SET removed_at = NULL, added_at = ? WHERE channel_id = ? AND handle = CAST(? AS TEXT)",
        ).run(addedAt, channelId, text(handle));
        return ok(undefined);
      }),
    removeParticipant: (channelId, handle, removedAt) =>
      databaseResult(() => {
        db.prepare(
          "UPDATE channel_participants SET removed_at = ? WHERE channel_id = ? AND handle = CAST(? AS TEXT)",
        ).run(removedAt, channelId, text(handle));
        return ok(undefined);
      }),
    closeChannelRow: (id, closedAt) =>
      databaseResult(() => {
        const changed = db
          .prepare("UPDATE channels SET state = 'closed', closed_at = ? WHERE id = ? AND state = 'open'")
          .run(closedAt, id) as { changes: number };
        return ok(changed.changes === 1 ? ("changed" as const) : ("unchanged" as const));
      }),
    markHandled: (channelId, seq, handledAt, note) =>
      databaseResult(() => {
        const changed = db
          .prepare(
            "UPDATE channel_messages SET handled = 1, handled_at = ?, handle_note = CAST(? AS TEXT) WHERE channel_id = ? AND seq = ? AND handled = 0",
          )
          .run(handledAt, text(note), channelId, seq) as { changes: number };
        if (changed.changes !== 1) {
          return err(
            appError(
              "STORAGE_INTEGRITY_ERROR",
              `The unhandled message ${String(seq)} could not be marked handled inside its transaction`,
              { channelId, seq },
            ),
          );
        }
        return ok(undefined);
      }),
    appendEvent: (id, event, createdAt) =>
      databaseResult(() => {
        // The closed metadata and association rules are application-level and
        // validated before the insert; the migration's trigger is the
        // association backstop (security section 10.1, section 38.9).
        const row = channelDomainEvent(id, event, createdAt);
        const checked = validateChannelEventMetadata(row.eventType as ChannelDomainEventType, row.metadata);
        if (!checked.ok) return checked;
        const channelRow = channelRowById(row.metadata.channelId as string);
        if (channelRow === null) {
          return err(appError("STORAGE_INTEGRITY_ERROR", `The ${row.eventType} event names an unknown Channel.`));
        }
        ledger.append(row);
        return ok(undefined);
      }),
  };

  const reader: ChannelReader = {
    channelByName: transaction.channelByName,
    channelById: transaction.channelById,
    participants: transaction.participants,
    participant: transaction.participant,
    pageMessages: transaction.pageMessages,
    counters: transaction.counters,
    listChannels: (filter) =>
      databaseResult(() => {
        const rows = (filter.state === "all"
          ? db
              .prepare(
                `SELECT c.*, (SELECT p.handle FROM channel_participants p WHERE p.channel_id = c.id AND p.role = 'main') AS main_handle
                     FROM channels c ORDER BY c.created_at DESC, c.id DESC`,
              )
              .all()
          : db
              .prepare(
                `SELECT c.*, (SELECT p.handle FROM channel_participants p WHERE p.channel_id = c.id AND p.role = 'main') AS main_handle
                     FROM channels c WHERE c.state = ? ORDER BY c.created_at DESC, c.id DESC`,
              )
              .all(filter.state)) as unknown as Array<ChannelRow & { main_handle: string | null }>;
        return ok(
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            title: row.title,
            state: row.state === "closed" ? ("closed" as const) : ("open" as const),
            main: row.main_handle ?? "",
            createdAt: row.created_at,
            closedAt: row.closed_at,
          })),
        );
      }),
  };

  return {
    run: (work) =>
      runInTransaction(db, "BEGIN IMMEDIATE", () => work(transaction), {
        failure: (error) =>
          storageContentionOf(error, "channel") ??
          appError(
            "INTERNAL_ERROR",
            `The Channel storage operation failed: ${error instanceof Error ? error.message : String(error)}.`,
            {
              cause: String(error),
            },
          ),
      }),
    read: (work) =>
      // A plain deferred read: no SQL fence check, because the covered read's
      // admission already checked the vault-move fence once (plan §3).
      runInTransaction(db, "BEGIN", () => work(reader), {
        checkFence: false,
        failure: (error) =>
          storageContentionOf(error, "channel") ??
          appError(
            "INTERNAL_ERROR",
            `The Channel storage operation failed: ${error instanceof Error ? error.message : String(error)}.`,
            {
              cause: String(error),
            },
          ),
      }),
  };
}
