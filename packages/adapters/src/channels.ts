import { homedir } from "node:os";
import { join, relative } from "node:path";
import { openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import {
  SystemClock,
  UuidGenerator,
  appError,
  err,
  ok,
  channelDomainEvent,
  parseStoredChannelCreateReceipt,
  parseStoredChannelSubmitReceipt,
  validateChannelEventMetadata,
  type AcceptedChannelBody,
  type AppError,
  type Clock,
  type ChannelAggregate,
  type ChannelAssignmentRecord,
  type ChannelAuthorityKind,
  type ChannelCommandPorts,
  type ChannelListCapture,
  type ChannelMessageRecord,
  type ChannelParticipantRecord,
  type ChannelRecord,
  type ChannelReader,
  type ChannelReceiptReader,
  type ChannelRecoveryPorts,
  type ChannelRepository,
  type ChannelRunOptions,
  type ChannelTransaction,
  type MessageListCapture,
  type Result,
  type StoredChannelCreateReceipt,
  type StoredChannelSubmitReceipt,
} from "@sorage/core";
import { createConfigStore } from "./config-store";
import {
  activateCommonFile,
  completeCommonIntentTx,
  createSqliteContentStore,
  type SqliteContentStore,
} from "./content-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts, vaultMoveLockHeld } from "./lockfile";
import {
  captureMemoBodyFile,
  captureMemoBodyText,
  streamMemoSpool,
  type AcceptedBodyCaptureCodes,
} from "./memo-body-file";
import { releaseMemoInputSpool, sweepMemoInputSpool } from "./memo-input-spool";
import { appendStructuredLog } from "./structured-log";
import type { SorageSqlite } from "./sqlite/connection";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
import { productionMigrationPlan } from "./sqlite/migrations";
import { createSqliteEventLedger } from "./events";
import { isSafeVaultRelativePath, liveFencePaused } from "./intent-log";
import { readRecoveryConfiguration, withInstallationInspection } from "./preflight";

/**
 * The TASK-109 Channel storage adapter (CHN-001 to CHN-009, interface sections
 * 38.3 to 38.6, the reviewed P3 operative addendum): the SQLite repository
 * behind the core ports, the production node composition with the required
 * runDir fence, fresh binding, and external-version coherence on every
 * mutation and bounded list page, and the non-migrating replay-only
 * inspection ports. Every mutation's one SQL transaction commits the domain
 * rows, the content record and its activation intent through the shared
 * in-transaction primitives — never the standalone `write` family — the exact
 * Channel domain event, and the bounded metadata-only receipt together;
 * filesystem activation happens only after the commit behind the move-lock
 * gate (SHR-004, SHR-005, P3 steps 3 to 5).
 */

/** Keeps database admission details inside the composition boundary. */
export function channelStorageError(error: unknown): AppError {
  return asSchemaAdmission(error) ?? appError("INTERNAL_ERROR", "Channel storage could not be opened");
}

/**
 * The pinned-Bun verbatim-text binding of the shared content store's
 * established strategy: a leading byte-order mark in a directly bound string
 * parameter is stripped by the engine's text binding, so every verbatim
 * Channel field — handles, the three context columns, the handling note, and
 * the opaque idempotency key — binds its exact UTF-8 bytes with
 * `CAST(? AS TEXT)`, preserving SQL NULL for absent values and byte-exact
 * comparisons on both sides of every lookup (SHR-003, section 38.3).
 */
const text = (value: string | null): Buffer | null => (value === null ? null : Buffer.from(value, "utf8"));

interface ChannelRow {
  id: string;
  title: string | null;
  state: string;
  creator_kind: string;
  creator_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by_participant_id: string | null;
  closed_by_kind: string | null;
}

interface ParticipantRow {
  id: string;
  channel_id: string;
  role: string;
  handle: string;
  native_provenance_json: string;
  active: number;
  registered_at: string;
  deactivated_at: string | null;
}

interface AssignmentRow {
  id: string;
  channel_id: string;
  participant_id: string | null;
  label: string;
  state: string;
  created_at: string;
  closed_at: string | null;
}

interface MessageRow {
  id: string;
  channel_id: string;
  sender_participant_id: string;
  sender_handle: string;
  kind: string;
  content_record_id: string;
  assignment_id: string | null;
  assignment_late: number;
  relay_to_participant_id: string | null;
  context_session: string | null;
  context_node: string | null;
  context_attempt: string | null;
  handled: number;
  handled_at: string | null;
  handled_by_participant_id: string | null;
  handled_by_kind: string | null;
  handle_note: string | null;
  processing_row_version: number;
  created_at: string;
}

function channelFromRow(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    title: row.title,
    state: row.state === "closed" ? "closed" : "open",
    creatorKind: row.creator_kind as ChannelRecord["creatorKind"],
    creatorId: row.creator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedByParticipantId: row.closed_by_participant_id,
    closedByKind: row.closed_by_kind === null ? null : (row.closed_by_kind as ChannelAuthorityKind),
  };
}

function participantFromRow(row: ParticipantRow): ChannelParticipantRecord {
  let native: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.native_provenance_json);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) native = parsed as string[];
  } catch {
    // A malformed stored array surfaces as empty attribution, never a crash;
    // the closed catalog forbids writing such a row and the guard reads stay
    // metadata-only.
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    role: row.role as ChannelParticipantRecord["role"],
    handle: row.handle,
    nativeProvenance: native,
    active: row.active === 1,
    registeredAt: row.registered_at,
    deactivatedAt: row.deactivated_at,
  };
}

function assignmentFromRow(row: AssignmentRow): ChannelAssignmentRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    participantId: row.participant_id,
    label: row.label,
    state: row.state === "closed" ? "closed" : "open",
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function messageFromRow(db: SorageSqlite, row: MessageRow): Result<ChannelMessageRecord> {
  const record = db
    .prepare("SELECT inline_text, storage_key, size_bytes, sha256, materialized FROM content_records WHERE id = ?")
    .get(row.content_record_id) as
    | {
        inline_text: string | null;
        storage_key: string | null;
        size_bytes: number;
        sha256: string;
        materialized: number;
      }
    | null
    | undefined;
  if (record === null || record === undefined) {
    return err(
      appError(
        "STORAGE_INTEGRITY_ERROR",
        `The Channel message ${row.id} references content record ${row.content_record_id}, which is missing.`,
        {
          messageId: row.id,
          contentRecordId: row.content_record_id,
        },
      ),
    );
  }
  return ok({
    id: row.id,
    channelId: row.channel_id,
    senderParticipantId: row.sender_participant_id,
    senderHandle: row.sender_handle,
    kind: row.kind as ChannelMessageRecord["kind"],
    body: {
      recordId: row.content_record_id,
      representation: record.inline_text !== null ? "inline" : "file",
      sizeBytes: record.size_bytes,
      sha256: record.sha256,
      inlineText: record.inline_text,
    },
    assignmentId: row.assignment_id,
    assignmentLate: row.assignment_late === 1,
    relayToParticipantId: row.relay_to_participant_id,
    contextSession: row.context_session,
    contextNode: row.context_node,
    contextAttempt: row.context_attempt,
    handled: row.handled === 1,
    handledAt: row.handled_at,
    handledByParticipantId: row.handled_by_participant_id,
    handledByKind: row.handled_by_kind === null ? null : (row.handled_by_kind as ChannelAuthorityKind),
    handleNote: row.handle_note,
    processingRowVersion: row.processing_row_version,
    createdAt: row.created_at,
  });
}

function externalVersion(db: SorageSqlite): number {
  const row = db.prepare("PRAGMA data_version").get() as { data_version: number } | null | undefined;
  return Number(row?.data_version ?? 0);
}

function coherenceMarker(): Result<never> {
  return err(
    appError(
      "SERVICE_PAUSED",
      "External database state changed during this Channel operation; the attempt rolled back",
      {
        coherenceMismatch: true,
      },
    ),
  );
}

function databaseResult<T>(work: () => Result<T>): Result<T> {
  try {
    return work();
  } catch (error) {
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

export interface SqliteChannelRepositoryOptions {
  contentStore: SqliteContentStore;
}

export function createSqliteChannelRepository(
  db: SorageSqlite,
  options: SqliteChannelRepositoryOptions,
): ChannelRepository {
  const store = options.contentStore;
  const ledger = createSqliteEventLedger(db);

  const channelById = (id: string): ChannelRecord | null => {
    const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | null | undefined;
    return row === null || row === undefined ? null : channelFromRow(row);
  };

  const participantsOf = (channelId: string): ChannelParticipantRecord[] =>
    (
      db
        .prepare("SELECT * FROM channel_participants WHERE channel_id = ? ORDER BY registered_at, id")
        .all(channelId) as unknown as ParticipantRow[]
    ).map(participantFromRow);

  const participantOf = (channelId: string, participantId: string): ChannelParticipantRecord | null => {
    const row = db
      .prepare("SELECT * FROM channel_participants WHERE channel_id = ? AND id = ?")
      .get(channelId, participantId) as ParticipantRow | null | undefined;
    return row === null || row === undefined ? null : participantFromRow(row);
  };

  const participantHandleOf = (channelId: string, handle: string): ChannelParticipantRecord | null => {
    const row = db
      .prepare("SELECT * FROM channel_participants WHERE channel_id = ? AND handle = CAST(? AS TEXT)")
      .get(channelId, text(handle)) as ParticipantRow | null | undefined;
    return row === null || row === undefined ? null : participantFromRow(row);
  };

  const assignmentOf = (channelId: string, assignmentId: string): ChannelAssignmentRecord | null => {
    const row = db
      .prepare("SELECT * FROM channel_assignments WHERE channel_id = ? AND id = ?")
      .get(channelId, assignmentId) as AssignmentRow | null | undefined;
    return row === null || row === undefined ? null : assignmentFromRow(row);
  };

  const messageOf = (channelId: string, messageId: string): Result<ChannelMessageRecord | null> => {
    const row = db
      .prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND id = ?")
      .get(channelId, messageId) as MessageRow | null | undefined;
    if (row === null || row === undefined) return ok(null);
    return messageFromRow(db, row);
  };

  const aggregateOf = (channelId: string): ChannelAggregate | null => {
    const channel = channelById(channelId);
    if (channel === null) return null;
    const participants = participantsOf(channelId);
    const main = participants.find((candidate) => candidate.role === "main");
    if (main === undefined) {
      throw new Error(`The Channel ${channelId} has no main participant.`);
    }
    const assignments = (
      db
        .prepare("SELECT * FROM channel_assignments WHERE channel_id = ? ORDER BY created_at, id")
        .all(channelId) as unknown as AssignmentRow[]
    ).map(assignmentFromRow);
    const counts = db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN handled = 0 THEN 1 ELSE 0 END) AS unhandled FROM channel_messages WHERE channel_id = ?",
      )
      .get(channelId) as { total: number; unhandled: number | null } | undefined;
    return {
      channel,
      participants,
      assignments,
      mainParticipantId: main.id,
      messageCount: Number(counts?.total ?? 0),
      unhandledCount: Number(counts?.unhandled ?? 0),
    };
  };

  const transaction: ChannelTransaction = {
    channel: (id) => databaseResult(() => ok(channelById(id))),
    participants: (channelId) => databaseResult(() => ok(participantsOf(channelId))),
    participant: (channelId, participantId) => databaseResult(() => ok(participantOf(channelId, participantId))),
    participantByHandle: (channelId, handle) => databaseResult(() => ok(participantHandleOf(channelId, handle))),
    assignment: (channelId, assignmentId) => databaseResult(() => ok(assignmentOf(channelId, assignmentId))),
    message: (channelId, messageId) => databaseResult(() => messageOf(channelId, messageId)),
    submitReceipt: (key, scope, now) => databaseResult(() => lookupSubmitReceipt(db, key, scope, now)),
    createReceipt: (key, scope, now) => databaseResult(() => lookupCreateReceipt(db, key, scope, now)),
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
    insertChannel: (row) =>
      databaseResult(() => {
        db.prepare(
          "INSERT INTO channels (id, title, state, creator_kind, creator_id, created_at, updated_at, closed_at, closed_by_participant_id, closed_by_kind) VALUES (?, ?, 'open', ?, ?, ?, ?, NULL, NULL, NULL)",
        ).run(row.id, row.title, row.creatorKind, row.creatorId, row.createdAt, row.updatedAt);
        return ok(undefined);
      }),
    insertParticipant: (row) =>
      databaseResult(() => {
        db.prepare(
          "INSERT INTO channel_participants (id, channel_id, role, handle, native_provenance_json, active, registered_at, deactivated_at) VALUES (?, ?, ?, CAST(? AS TEXT), ?, 1, ?, NULL)",
        ).run(
          row.id,
          row.channelId,
          row.role,
          text(row.handle),
          JSON.stringify(row.nativeProvenance),
          row.registeredAt,
        );
        return ok(undefined);
      }),
    insertAssignment: (row) =>
      databaseResult(() => {
        db.prepare(
          "INSERT INTO channel_assignments (id, channel_id, participant_id, label, state, created_at, closed_at) VALUES (?, ?, ?, ?, 'open', ?, NULL)",
        ).run(row.id, row.channelId, row.participantId, row.label, row.createdAt);
        return ok(undefined);
      }),
    insertMessage: (row) =>
      databaseResult(() => {
        db.prepare(
          `INSERT INTO channel_messages (id, channel_id, sender_participant_id, sender_handle, kind, content_record_id,
             assignment_id, assignment_late, relay_to_participant_id, context_session, context_node, context_attempt,
             handled, handled_at, handled_by_participant_id, handled_by_kind, handle_note, processing_row_version, created_at)
           VALUES (?, ?, ?, CAST(? AS TEXT), ?, ?, ?, ?, ?, CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT),
             0, NULL, NULL, NULL, NULL, 1, ?)`,
        ).run(
          row.id,
          row.channelId,
          row.senderParticipantId,
          text(row.senderHandle),
          row.kind,
          row.body.recordId,
          row.assignmentId,
          row.assignmentLate ? 1 : 0,
          row.relayToParticipantId,
          text(row.contextSession),
          text(row.contextNode),
          text(row.contextAttempt),
          row.createdAt,
        );
        return ok(undefined);
      }),
    closeChannel: (id, closedAt, closedByParticipantId, closedByKind) =>
      databaseResult(() => {
        const changed = db
          .prepare(
            "UPDATE channels SET state = 'closed', closed_at = ?, closed_by_participant_id = ?, closed_by_kind = ?, updated_at = ? WHERE id = ? AND state = 'open'",
          )
          .run(closedAt, closedByParticipantId, closedByKind, closedAt, id) as { changes: number };
        return ok(changed.changes === 1 ? ("changed" as const) : ("unchanged" as const));
      }),
    deactivateParticipant: (id, deactivatedAt) =>
      databaseResult(() => {
        const changed = db
          .prepare("UPDATE channel_participants SET active = 0, deactivated_at = ? WHERE id = ? AND active = 1")
          .run(deactivatedAt, id) as { changes: number };
        return ok(changed.changes === 1 ? ("changed" as const) : ("unchanged" as const));
      }),
    closeAssignment: (id, closedAt) =>
      databaseResult(() => {
        const changed = db
          .prepare("UPDATE channel_assignments SET state = 'closed', closed_at = ? WHERE id = ? AND state = 'open'")
          .run(closedAt, id) as { changes: number };
        return ok(changed.changes === 1 ? ("changed" as const) : ("unchanged" as const));
      }),
    handleMessage: (channelId, messageId, decision) =>
      databaseResult(() => {
        const changed = db
          .prepare(
            `UPDATE channel_messages SET handled = 1, handled_at = ?, handled_by_participant_id = ?, handled_by_kind = ?,
               handle_note = CAST(? AS TEXT), processing_row_version = 2
             WHERE channel_id = ? AND id = ? AND handled = 0 AND processing_row_version = 1`,
          )
          .run(
            decision.handledAt,
            decision.handledByParticipantId,
            decision.handledByKind,
            text(decision.handleNote),
            channelId,
            messageId,
          ) as { changes: number };
        if (changed.changes !== 1) {
          return err(
            appError("ROW_VERSION_CONFLICT", "Another handling attempt won the compare-and-set on this message"),
          );
        }
        return ok("changed" as const);
      }),
    appendEvent: (id, event) =>
      databaseResult(() => {
        // The closed metadata and association rules are application-level and
        // validated before the insert; the migration's trigger is the
        // association backstop (security section 10.1, section 38.9).
        const checked = validateChannelEventMetadata(event.eventType, event.metadata);
        if (!checked.ok) return checked;
        const channel = channelById(event.metadata.channelId as string);
        if (channel === null) {
          return err(appError("STORAGE_INTEGRITY_ERROR", `The ${event.eventType} event names an unknown Channel.`));
        }
        ledger.append(channelDomainEvent(id, event));
        return ok(undefined);
      }),
    storeSubmitReceipt: (key, scope, requestHash, summary, createdAt, expiresAt) =>
      databaseResult(() => {
        // Reuse only this expired key; no global cleanup of other families.
        // The opaque key binds its exact bytes on every statement, so a
        // leading-BOM original key keeps its identity through the expiry
        // cleanup and the retained insert alike.
        db.prepare("DELETE FROM idempotency_keys WHERE key = CAST(? AS TEXT) AND scope = ? AND expires_at <= ?").run(
          text(key),
          scope,
          createdAt,
        );
        db.prepare(
          "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (CAST(? AS TEXT), ?, ?, ?, ?, ?)",
        ).run(text(key), scope, requestHash, JSON.stringify({ message: summary }), createdAt, expiresAt);
        return ok(undefined);
      }),
    storeCreateReceipt: (key, scope, requestHash, view, createdAt, expiresAt) =>
      databaseResult(() => {
        db.prepare("DELETE FROM idempotency_keys WHERE key = CAST(? AS TEXT) AND scope = ? AND expires_at <= ?").run(
          text(key),
          scope,
          createdAt,
        );
        db.prepare(
          "INSERT INTO idempotency_keys (key, scope, request_hash, response_json, created_at, expires_at) VALUES (CAST(? AS TEXT), ?, ?, ?, ?, ?)",
        ).run(text(key), scope, requestHash, JSON.stringify({ channel: view }), createdAt, expiresAt);
        return ok(undefined);
      }),
  };

  function inTransaction<T>(begin: string, work: () => Result<T>, options?: ChannelRunOptions): Result<T> {
    return databaseResult(() => {
      db.exec(begin);
      try {
        if (liveFencePaused(db) !== null) {
          db.exec("ROLLBACK");
          return err(appError("SERVICE_PAUSED", "A Vault move or restore is in progress"));
        }
        if (options?.expectedExternalVersion !== undefined && begin === "BEGIN IMMEDIATE") {
          if (externalVersion(db) !== options.expectedExternalVersion) {
            db.exec("ROLLBACK");
            return coherenceMarker();
          }
        }
        const result = work();
        db.exec(result.ok ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  return {
    aggregate: (channelId) => databaseResult(() => ok(aggregateOf(channelId))),
    message: (channelId, messageId) => databaseResult(() => messageOf(channelId, messageId)),
    captureChannelList: (filter, after, batchSize) =>
      databaseResult(() => {
        db.exec("BEGIN");
        try {
          const where: string[] = [];
          const params: unknown[] = [];
          if (filter.state !== "all") {
            where.push("c.state = ?");
            params.push(filter.state);
          }
          if (after !== undefined) {
            where.push("(c.created_at < ? OR (c.created_at = ? AND c.id < ?))");
            params.push(after.createdAt, after.createdAt, after.id);
          }
          const rows = db
            .prepare(
              `SELECT c.id AS id, c.title AS title, c.state AS state, c.created_at AS created_at, c.closed_at AS closed_at,
                 (SELECT p.handle FROM channel_participants p WHERE p.channel_id = c.id AND p.role = 'main') AS main_handle
               FROM channels c${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
               ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
            )
            .all(...(params.length > 0 ? params : []), batchSize + 1) as unknown as Array<{
            id: string;
            title: string | null;
            state: string;
            created_at: string;
            closed_at: string | null;
            main_handle: string | null;
          }>;
          db.exec("COMMIT");
          const exhausted = rows.length <= batchSize;
          const page = rows.slice(0, batchSize);
          const last =
            page.length > 0
              ? { createdAt: page[page.length - 1]?.created_at ?? "", id: page[page.length - 1]?.id ?? "" }
              : null;
          const capture: ChannelListCapture = {
            summaries: page.map((row) => ({
              id: row.id,
              title: row.title,
              state: row.state === "closed" ? ("closed" as const) : ("open" as const),
              mainHandle: row.main_handle ?? "",
              createdAt: row.created_at,
              closedAt: row.closed_at,
            })),
            lastSortKey: last,
            exhausted,
          };
          return ok(capture);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
    captureMessageList: (channelId, filter, after, batchSize) =>
      databaseResult(() => {
        db.exec("BEGIN");
        try {
          if (channelById(channelId) === null) {
            db.exec("COMMIT");
            return err(appError("CHN_NOT_FOUND", "Unknown Channel UUID"));
          }
          const where: string[] = ["m.channel_id = ?"];
          const params: unknown[] = [channelId];
          if (filter.handling === "unhandled") where.push("m.handled = 0");
          if (filter.handling === "handled") where.push("m.handled = 1");
          if (filter.participantId !== null) {
            where.push("m.sender_participant_id = ?");
            params.push(filter.participantId);
          }
          if (filter.assignmentId !== null) {
            where.push("m.assignment_id = ?");
            params.push(filter.assignmentId);
          }
          if (filter.kind !== null) {
            where.push("m.kind = ?");
            params.push(filter.kind);
          }
          if (after !== undefined) {
            where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
            params.push(after.createdAt, after.createdAt, after.id);
          }
          const rows = db
            .prepare(
              `SELECT * FROM channel_messages m WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
            )
            .all(...params, batchSize + 1) as unknown as MessageRow[];
          db.exec("COMMIT");
          const exhausted = rows.length <= batchSize;
          const page = rows.slice(0, batchSize);
          const records: ChannelMessageRecord[] = [];
          for (const row of page) {
            const mapped = messageFromRow(db, row);
            if (!mapped.ok) return mapped;
            // List descriptors stay metadata-only: the capture carries the
            // record identity, never the inline text, and every preview seed
            // resolves outside the capture transaction (the Memo listing's
            // retained discipline).
            records.push({ ...mapped.value, body: { ...mapped.value.body, inlineText: null } });
          }
          const last =
            page.length > 0
              ? { createdAt: page[page.length - 1]?.created_at ?? "", id: page[page.length - 1]?.id ?? "" }
              : null;
          const capture: MessageListCapture = {
            records,
            lastSortKey: last,
            exhausted,
          };
          return ok(capture);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
    run: (work, options) => inTransaction("BEGIN IMMEDIATE", () => work(transaction), options),
    inspect: (work) => {
      const reader: ChannelReader = {
        aggregate: (channelId) => databaseResult(() => ok(aggregateOf(channelId))),
        message: (channelId, messageId) => databaseResult(() => messageOf(channelId, messageId)),
      };
      return databaseResult(() => {
        db.exec("BEGIN");
        try {
          const result = work(reader);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
  };
}

function lookupSubmitReceipt(
  db: SorageSqlite,
  key: string,
  scope: string,
  now: string,
): Result<StoredChannelSubmitReceipt | null> {
  const row = db
    .prepare(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = CAST(? AS TEXT) AND scope = ? AND expires_at > ?",
    )
    .get(text(key), scope, now) as { request_hash: string; response_json: string } | null | undefined;
  if (row === null || row === undefined) return ok(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_json);
  } catch {
    // A malformed stored receipt is a body-free integrity refusal, never
    // absence and never a fresh execute (SHR-008).
    return err(
      appError("STORAGE_INTEGRITY_ERROR", `A stored Channel receipt under scope ${scope} is not valid JSON.`, {
        scope,
      }),
    );
  }
  const message = parseStoredChannelSubmitReceipt(parsed);
  if (!message.ok) return message;
  return ok({ requestHash: row.request_hash, message: message.value });
}

function lookupCreateReceipt(
  db: SorageSqlite,
  key: string,
  scope: string,
  now: string,
): Result<StoredChannelCreateReceipt | null> {
  const row = db
    .prepare(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = CAST(? AS TEXT) AND scope = ? AND expires_at > ?",
    )
    .get(text(key), scope, now) as { request_hash: string; response_json: string } | null | undefined;
  if (row === null || row === undefined) return ok(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_json);
  } catch {
    return err(
      appError("STORAGE_INTEGRITY_ERROR", `A stored Channel receipt under scope ${scope} is not valid JSON.`, {
        scope,
      }),
    );
  }
  const channel = parseStoredChannelCreateReceipt(parsed);
  if (!channel.ok) return channel;
  return ok({ requestHash: row.request_hash, channel: channel.value });
}

// ---------------------------------------------------------------------------
// The production node composition

export interface NodeChannelPortsOptions {
  env?: HomeEnvironment;
  userHome?: string;
  database?: SorageSqlite;
  clock?: Clock;
}

const CHANNEL_BODY_CAPTURE_CODES: AcceptedBodyCaptureCodes = {
  invalidInput: "CHN_INVALID_INPUT",
  tooLarge: "CHN_TOO_LARGE",
  fileReadFailed: "CHN_INVALID_INPUT",
};

/** The Channel surface's once-only accepted-input capture over the one shared capture primitive (SHR-012, P3 step 1). */
export function captureChannelBodyFile(path: string, options: { maxBytes: number; stateDir: string; spoolId: string }) {
  return captureMemoBodyFile(path, { ...options, codes: CHANNEL_BODY_CAPTURE_CODES });
}

export function captureChannelBodyText(text: string, options: { maxBytes: number; stateDir: string; spoolId: string }) {
  if (!text.isWellFormed()) {
    return err(appError("CHN_INVALID_INPUT", "Channel message body must be valid Unicode without NUL"));
  }
  return captureMemoBodyText(text, { ...options, codes: CHANNEL_BODY_CAPTURE_CODES });
}

/** Optional startup maintenance, without opening or migrating the database: the shared spool policy the Memo sweep honors. */
export function sweepChannelAcceptedInputs(options: NodeChannelPortsOptions = {}): void {
  const env: HomeEnvironment = options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME };
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const current = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome }).read();
  if (!current.ok || !current.value) return;
  sweepMemoInputSpool(home.stateDir, {
    graceHours: current.value.config.gc.graceHours,
    now: (options.clock ?? new SystemClock()).now(),
  });
}

export function releaseAcceptedChannelBody(accepted: AcceptedChannelBody): void {
  if (accepted.kind === "spool") releaseMemoInputSpool(accepted.spoolPath);
}

export interface NodeChannelPorts extends ChannelCommandPorts {
  close(): void;
  releaseAcceptedBody(accepted: AcceptedChannelBody): void;
  stateDir: string;
  /** The configured `gc.graceHours` window the shared accepted-input spool sweep honors. */
  graceHours: number;
}

export function createNodeChannelPorts(options: NodeChannelPortsOptions = {}): NodeChannelPorts {
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths(options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME }, userHome);
  const plan = productionMigrationPlan();
  const db =
    options.database ??
    openAndMigrate(join(home.stateDir, "sorage.sqlite3"), plan.migrations, {
      rebuilds: plan.rebuilds,
    }).db;
  try {
    const configStore = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
    const read = configStore.read();
    if (!read.ok || read.value === null) throw new Error("Channel configuration could not be read");
    const config = read.value.config;
    const clock = options.clock ?? new SystemClock();
    const ledger = createSqliteEventLedger(db);
    const contentStore = createSqliteContentStore({
      db,
      vaultPath: config.vault.path,
      installationId: config.installationId,
      runDir: home.runDir,
      ledger,
    });
    const repository = createSqliteChannelRepository(db, { contentStore });
    const externalVersion = (): number => {
      const row = db.prepare("PRAGMA data_version").get() as { data_version: number } | null | undefined;
      return Number(row?.data_version ?? 0);
    };
    /** One content store aimed at the binding the current operation captured, not the composition-time path. */
    const boundStore = (binding: { vaultPath: string }): SqliteContentStore =>
      binding.vaultPath === config.vault.path
        ? contentStore
        : createSqliteContentStore({
            db,
            vaultPath: binding.vaultPath,
            installationId: config.installationId,
            runDir: home.runDir,
            ledger,
          });
    return {
      installationId: config.installationId,
      maxBytes: config.artifact.maxBytes,
      defaultPageSize: config.ui.defaultPageSize,
      clock,
      ids: new UuidGenerator(),
      channels: repository,
      disclosures: {
        backupEnabled: config.gitBackup.enabled,
        thresholdBytes: config.gitBackup.largeArtifactWarningBytes,
        largeContent: (sizeBytes: number, thresholdBytes: number) => {
          appendStructuredLog(
            { level: "warn", event: "LARGE_CONTENT_DISCLOSED", domain: "channel", sizeBytes, thresholdBytes },
            home,
            config.logging,
          );
        },
      },
      bodies: {
        readAcceptedPreviewSeed: (accepted) => readSpoolPreviewSeed(accepted),
        proveAcceptedNonBlank: (accepted) => proveSpoolNonBlank(accepted),
        readRecordPreviewSeed: (ref, binding) => readRecordPreviewSeed(boundStore(binding), ref),
        resolveBody: (ref, binding) => resolveRecordBody(boundStore(binding), ref),
      },
      coherence: {
        captureExternalVersion: () => ok(externalVersion()),
        classifyExternalChange: (expectedVaultPath) => {
          if (vaultMoveLockHeld(home.runDir)) {
            return ok("vault-move-held" as const);
          }
          const current = configStore.read();
          if (!current.ok) return current;
          if (!current.value) return err(appError("INTERNAL_ERROR", "Channel configuration could not be re-read"));
          return {
            ok: true as const,
            value:
              current.value.config.vault.path === expectedVaultPath
                ? ("external-commit" as const)
                : ("vault-path-changed" as const),
          };
        },
        moveLockHeld: () => vaultMoveLockHeld(home.runDir),
      },
      staging: {
        freshBinding: () => {
          const current = configStore.read();
          if (!current.ok) return current;
          if (!current.value) return err(appError("INTERNAL_ERROR", "Channel configuration could not be re-read"));
          return ok({ vaultPath: current.value.config.vault.path });
        },
        stageAccepted: (accepted, binding) => {
          if (accepted.kind === "text") {
            return err(appError("INTERNAL_ERROR", "An inline Channel body never stages into the Vault"));
          }
          const staged = boundStore(binding).stage({
            sourcePath: accepted.spoolPath,
            maxBytes: config.artifact.maxBytes,
            tooLargeCode: "CHN_TOO_LARGE",
          });
          if (!staged.ok) return staged;
          const stagedPath = relative(binding.vaultPath, staged.value.stagingPath);
          if (stagedPath.startsWith("..") || stagedPath.length === 0) {
            return err(appError("INTERNAL_ERROR", "The staged Channel body escaped the bound Vault"));
          }
          return ok({ stagedPath, sizeBytes: staged.value.sizeBytes, sha256: staged.value.sha256 });
        },
        activateContent: (input, binding) => {
          // The post-commit gate: a held lock leaves the committed intent durably
          // pending, emits no fabricated event, and reports paused honestly.
          if (vaultMoveLockHeld(home.runDir)) return ok({ status: "paused" as const });
          const outcome = activateCommonFile({
            vaultPath: binding.vaultPath,
            fromPath: input.stagedPath,
            toPath: input.storageKey,
            expect: { sizeBytes: input.sizeBytes, sha256: input.sha256 },
          });
          const completion = completeCommonIntentTx(db, ledger, input.intentId, outcome);
          if (!completion.ok) return completion;
          // A committed failed assessment retains the intent and its
          // CONTENT_INTEGRITY_FAILED event with materialized left 0; the
          // submission's post-commit half reports it honestly as committed but
          // unmaterialized — never a fabricated success, never a rollback
          // claim, and never a raw error or body detail (SHR-005, P3 step 5).
          if (completion.value.status === "failed") {
            return err(
              appError(
                "CONTENT_MATERIALIZING",
                `The Channel message is committed; its activation could not complete: a committed failure assessment retained the intent (reason: ${String(completion.value.reason)})`,
              ),
            );
          }
          return ok({ status: "completed" as const });
        },
      },
      close: () => {
        if (!options.database) db.close();
      },
      releaseAcceptedBody: (accepted) => releaseAcceptedChannelBody(accepted),
      stateDir: home.stateDir,
      graceHours: config.gc.graceHours,
    };
  } catch (error) {
    if (!options.database) db.close();
    throw error;
  }
}

function readSpoolPreviewSeed(accepted: AcceptedChannelBody): Result<string, AppError> {
  if (accepted.kind === "text") return ok(accepted.text);
  const head = readSpoolHead(accepted.spoolPath, 2048);
  if (!head.ok) return head;
  return ok(head.value);
}

/**
 * One bounded head read of an accepted spool: at most `bytes` bytes feed the
 * 512-byte preview rule, never the whole body. The accepted bytes were already
 * fatally validated by the capture pass, so a scalar split at the read boundary
 * is a truncation artifact handled by decoding non-fatally for the seed only,
 * never an invalid-UTF-8 conclusion about the accepted input.
 */
function readSpoolHead(spoolPath: string, bytes: number): Result<string, AppError> {
  let handle: number | undefined;
  try {
    handle = openSync(spoolPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(handle);
    if (!stat.isFile()) return err(appError("INTERNAL_ERROR", "The accepted Channel body spool is not a regular file"));
    const buffer = Buffer.allocUnsafe(Math.min(bytes, 64 * 1024));
    const read = readSync(handle, buffer, 0, buffer.byteLength, 0);
    const head = buffer.subarray(0, read);
    // Non-fatal decode: the capture pass proved the full stream's UTF-8, and a
    // trailing partial scalar here is only the head-cut boundary.
    return ok(new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(head));
  } catch {
    return err(appError("INTERNAL_ERROR", "The accepted Channel body spool could not be read"));
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * The full accepted-spool nonblank proof (the F5 correction): streams the
 * spool's exact bytes in bounded chunks through the shared spool reader and
 * proves at least one non-whitespace scalar exists — bounded memory, the exact
 * accepted bytes, and no second UTF-8 or bound validator, because the capture
 * pass already owns those. The streaming decoder keeps multibyte scalars
 * whole across chunk boundaries, and whitespace membership is per scalar and
 * matches `String.prototype.trim`'s WhiteSpace+LineTerminator definition, so
 * chunk boundaries cannot split a verdict.
 */
function proveSpoolNonBlank(accepted: AcceptedChannelBody): Result<void, AppError> {
  if (accepted.kind === "text") return ok(undefined);
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let sawNonWhitespace = false;
  const outcome = streamMemoSpool(accepted.spoolPath, (chunk) => {
    if (!sawNonWhitespace && /\S/u.test(decoder.decode(chunk, { stream: true }))) {
      sawNonWhitespace = true;
    }
  });
  if (!outcome.ok) return outcome;
  if (!sawNonWhitespace) {
    return err(appError("CHN_INVALID_INPUT", "Channel message body must be nonempty after trimming"));
  }
  return ok(undefined);
}

/** The bounded record-head seed for list summaries: inline text directly, a file body through one positional read. */
function readRecordPreviewSeed(
  store: SqliteContentStore,
  ref: { recordId: string; representation: "inline" | "file"; sizeBytes: number; sha256: string },
): Result<string, AppError> {
  const opened = store.openBody(ref.recordId, { verifyFileDigest: "never" });
  if (!opened.ok) return opened;
  try {
    const head = opened.value.read(0, 2048);
    if (!head.ok) return head;
    return ok(new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(head.value));
  } finally {
    opened.value.close();
  }
}

/** The complete-content resolution of one record's exact text, outside every transaction. */
function resolveRecordBody(
  store: SqliteContentStore,
  ref: { recordId: string; representation: "inline" | "file"; sizeBytes: number; sha256: string },
): Result<string, AppError> {
  const read = store.read(ref.recordId);
  if (!read.ok) return read;
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.value.bytes);
  return ok(decoded);
}

// ---------------------------------------------------------------------------
// The replay-only inspection ports (CHN-006, P3 section C)

export interface NodeChannelRecoveryOptions {
  env?: HomeEnvironment;
  userHome?: string;
  inspection?: Parameters<typeof withInstallationInspection>[1];
}

/** Read only the safely observed configuration needed before original-body capture. */
export function readChannelRecoveryConfiguration(
  options: Pick<NodeChannelRecoveryOptions, "env" | "userHome"> = {},
): Result<{ installationId: string; maxBytes: number; vaultPath: string }, AppError> {
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths(options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME }, userHome);
  const loaded = readRecoveryConfiguration(home.home, userHome);
  if (!loaded.ok) return loaded;
  return ok({
    installationId: loaded.value.installationId,
    maxBytes: loaded.value.artifact.maxBytes,
    vaultPath: loaded.value.vault.path,
  });
}

export function createNodeChannelRecoveryPorts(options: NodeChannelRecoveryOptions = {}): ChannelRecoveryPorts {
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths(options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME }, userHome);
  return {
    clock: new SystemClock(),
    bodies: {
      // The read-only seam reuses the same full proofs over the accepted
      // input — the nonblank scan and the bounded preview-head seed — each a
      // private input read, never a Vault or database effect, so replay-only
      // stays non-mutating (the F5 and C1 corrections).
      proveAcceptedNonBlank: (accepted) => proveSpoolNonBlank(accepted),
      readAcceptedPreviewSeed: (accepted) => readSpoolPreviewSeed(accepted),
    },
    inspect(consume) {
      return withInstallationInspection(home.home, { ...options.inspection, userHome }, (observation) => {
        if (observation.kind === "refused") return err(observation.error);
        const receipts: ChannelReceiptReader = {
          submitReceipt: (key, scope, now) => {
            try {
              const row = observation.reader
                .prepare(
                  "SELECT request_hash, response_json FROM idempotency_keys WHERE key = CAST(? AS TEXT) AND scope = ? AND expires_at > ?",
                )
                .get(text(key), scope, now) as { request_hash: string; response_json: string } | null | undefined;
              if (row === null || row === undefined) return ok(null);
              let parsed: unknown;
              try {
                parsed = JSON.parse(row.response_json);
              } catch {
                return err(
                  appError(
                    "STORAGE_INTEGRITY_ERROR",
                    `A stored Channel receipt under scope ${scope} is not valid JSON.`,
                    {
                      scope,
                    },
                  ),
                );
              }
              // The one shared strict parser: the read-only inspection never
              // trusts a stored receipt shape the mutation path would not
              // accept either (SHR-008 fail-closed).
              const message = parseStoredChannelSubmitReceipt(parsed);
              if (!message.ok) return message;
              return ok({ requestHash: row.request_hash, message: message.value });
            } catch (error) {
              return err(
                appError(
                  "STORAGE_INTEGRITY_ERROR",
                  `The inspected Channel receipt rows are malformed: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            }
          },
        };
        return consume({
          installationId: observation.config.installationId,
          migrationVersion: observation.migrationVersion,
          receipts,
        });
      });
    },
  };
}
