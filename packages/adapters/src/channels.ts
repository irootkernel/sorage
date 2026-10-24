import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  type AcceptedChannelBody,
  type AppError,
  appError,
  type ChannelCommandPorts,
  type ChannelCounters,
  type ChannelDomainEventType,
  type ChannelReader,
  type ChannelRecord,
  type ChannelRepository,
  type ChannelTransaction,
  type Clock,
  channelDomainEvent,
  err,
  type MessageBodyRef,
  type MessagePageQuery,
  type MessageRecord,
  ok,
  type ParticipantRecord,
  type ResolvedMessageBody,
  type Result,
  SystemClock,
  UuidGenerator,
  validateChannelEventMetadata,
} from "@sorage/core";
import { createConfigStore } from "./config-store";
import {
  activateCommonFile,
  completeCommonIntentTx,
  createSqliteContentStore,
  type SqliteContentStore,
} from "./content-store";
import { createSqliteEventLedger } from "./events";
import { createHomePaths, type HomeEnvironment } from "./home";
import { isSafeVaultRelativePath } from "./intent-log";
import { createNodeLockProbePorts, vaultMoveLockHeld } from "./lockfile";
import { managedRoot } from "./managed-paths";
import {
  type AcceptedBodyCaptureCodes,
  captureMemoBodyFile,
  captureMemoBodyText,
  streamMemoSpool,
} from "./memo-body-file";
import { releaseMemoInputSpool, sweepMemoInputSpool } from "./memo-input-spool";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
import { runInTransaction } from "./sqlite/transaction";
import { AppCommandError, carriedAppError, storageContentionOf } from "./storage-contention";

/**
 * The TASK-123 rebuilt Channel storage adapter (CHN-001 to CHN-014, interface
 * sections 38.3 to 38.6, ADR-0034): the SQLite repository behind the rebuilt
 * core ports over the `channels-v2` tables, and the production node
 * composition. Mutations run one `BEGIN IMMEDIATE` transaction through the
 * shared transaction helper with its vault-move fence check; the one-shot
 * reads run a plain `BEGIN`/`COMMIT` with no SQL fence, because the covered
 * read's admission checked the fence once; and there is no coherence loop, no
 * rollback-and-retry, no backoff and no receipt machinery. The content record
 * and its activation intent commit through the shared in-transaction
 * primitives — never the standalone `write` family — the exact Channel domain
 * event, and nothing else; filesystem activation happens only after the
 * commit behind the move-lock gate (SHR-004, SHR-005).
 */

/** Keeps database admission details inside the composition boundary (SHR-015 unwrap seam). */
export function channelStorageError(error: unknown): AppError {
  const admission = asSchemaAdmission(error);
  if (admission !== null) return admission;
  const contention = storageContentionOf(error, "channel");
  if (contention !== null) return contention;
  if (error instanceof AppCommandError) return error.error;
  return appError("INTERNAL_ERROR", `Channel storage could not be opened: ${String(error)}`);
}

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
      databaseResult(() => {
        // A plain deferred read: no SQL fence check, because the covered read's
        // admission already checked the vault-move fence once (plan §3).
        db.exec("BEGIN");
        try {
          const result = work(reader);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
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
  // An operational read at an advisory seam: the sweep itself is void and
  // skips on any read failure, and the command's factory read — which runs
  // immediately afterwards — refuses CONFIG_INVALID on an unreadable file, so
  // the operational mode here records the seam's kind without changing the
  // sweep's silent-skip behavior (SHR-015).
  const current = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome }).readForOperation();
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
}

export function createNodeChannelPorts(options: NodeChannelPortsOptions = {}): NodeChannelPorts {
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths(options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME }, userHome);
  const plan = productionMigrationPlan();
  let db: SorageSqlite;
  try {
    db =
      options.database ??
      openAndMigrate(join(home.stateDir, "sorage.sqlite3"), plan.migrations, {
        rebuilds: plan.rebuilds,
      }).db;
  } catch (error) {
    // A schema admission refusal keeps its public code; contention becomes the
    // stamped Channel refusal (SHR-015).
    if (asSchemaAdmission(error) !== null || error instanceof AppCommandError) throw error;
    const contention = storageContentionOf(error, "channel");
    if (contention !== null) throw carriedAppError(contention);
    throw error;
  }
  try {
    const configStore = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
    const read = configStore.readForOperation();
    if (!read.ok || read.value === null) {
      throw carriedAppError(
        read.ok
          ? appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: home.configFile })
          : read.error,
      );
    }
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
    const relativeStaged = (
      stagingPath: string,
      vaultPath: string,
      sizeBytes: number,
      sha256: string,
    ): Result<{ stagedPath: string; sizeBytes: number; sha256: string }> => {
      let stagedPath: string;
      try {
        stagedPath = relative(managedRoot(vaultPath), stagingPath);
      } catch (error) {
        return err(
          appError("INTERNAL_ERROR", "The bound Channel Vault root could not be resolved", {
            cause: String(error),
          }),
        );
      }
      if (stagedPath.startsWith("..") || stagedPath.length === 0) {
        return err(appError("INTERNAL_ERROR", "The staged Channel body escaped the bound Vault"));
      }
      return ok({ stagedPath, sizeBytes, sha256 });
    };
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
        largeContent: () => {},
      },
      bodies: {
        proveAcceptedNonBlank: (accepted) => proveAcceptedNonBlank(accepted),
        resolveBody: (ref) => resolveRecordBody(contentStore, config.vault.path, ref),
      },
      staging: {
        freshBinding: () => {
          // An operational re-read: a present-but-unreadable configuration is
          // the typed CONFIG_INVALID refusal, never a swallowed absence
          // (SHR-015's W4 clarification). The staged-file post re-reads this
          // binding inside its transaction (CHN-014).
          const current = configStore.readForOperation();
          if (!current.ok) return current;
          if (!current.value) return err(appError("INTERNAL_ERROR", "Channel configuration could not be re-read"));
          return ok({ vaultPath: current.value.config.vault.path });
        },
        stageAccepted: (accepted, binding) => {
          if (accepted.kind === "spool") {
            const staged = boundStore(binding).stage({
              sourcePath: accepted.spoolPath,
              maxBytes: config.artifact.maxBytes,
              tooLargeCode: "CHN_TOO_LARGE",
            });
            if (!staged.ok) return staged;
            return relativeStaged(
              staged.value.stagingPath,
              binding.vaultPath,
              staged.value.sizeBytes,
              staged.value.sha256,
            );
          }
          // A large in-memory text (the JSON transport's bounded string) reaches
          // the Vault through the same two guarded primitives a file body uses:
          // the owned private spool capture and the content store's
          // managed-path-guarded streaming stage. No raw Vault write bypasses
          // those guards, and the temporary owned spool is released on every
          // exit; the accepted input itself stays immutable.
          const spoolId = randomUUID();
          const captured = captureMemoBodyText(accepted.text, {
            maxBytes: config.artifact.maxBytes,
            stateDir: home.stateDir,
            spoolId,
          });
          if (!captured.ok) return captured;
          if (captured.value.kind !== "spool") {
            return err(appError("INTERNAL_ERROR", "A below-threshold Channel body never stages into the Vault"));
          }
          try {
            const staged = boundStore(binding).stage({
              sourcePath: captured.value.spoolPath,
              maxBytes: config.artifact.maxBytes,
              tooLargeCode: "CHN_TOO_LARGE",
            });
            if (!staged.ok) return staged;
            return relativeStaged(
              staged.value.stagingPath,
              binding.vaultPath,
              staged.value.sizeBytes,
              staged.value.sha256,
            );
          } finally {
            releaseMemoInputSpool(captured.value.spoolPath);
          }
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
          // post's post-commit half reports it honestly as committed but
          // unmaterialized — never a fabricated success, never a rollback
          // claim, and never a raw error or body detail (SHR-005, CHN-012).
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
    };
  } catch (error) {
    if (!options.database) db.close();
    throw error;
  }
}

/**
 * The full accepted-spool nonblank proof (CHN-004): streams the accepted
 * bytes in bounded chunks through the shared spool reader and proves at least
 * one non-whitespace scalar exists — bounded memory, the exact accepted bytes,
 * and no second UTF-8 or bound validator, because the capture pass already
 * owns those.
 */
function proveAcceptedNonBlank(accepted: AcceptedChannelBody): Result<void, AppError> {
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

/**
 * The complete-content resolution of one record's body against the current
 * Vault binding, outside every transaction: an inline record is its exact
 * text, an unmaterialized file-backed record is pending in place, and a
 * materialized file is read and digest-verified with its immutable Vault
 * path (section 38.4 line 1716).
 */
function resolveRecordBody(
  store: SqliteContentStore,
  vaultPath: string,
  ref: MessageBodyRef,
): Result<ResolvedMessageBody, AppError> {
  // Every representation resolves through the shared store's verified read:
  // an inline record's bytes are checked against their recorded size and
  // SHA-256 exactly as a file-backed body's are (SHR-005).
  const read = store.read(ref.recordId);
  if (!read.ok) {
    if (read.error.code === "CONTENT_MATERIALIZING") return ok({ state: "pending" });
    return read;
  }
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.value.bytes);
  if (read.value.kind === "inline") {
    return ok({ state: "inline", text: decoded });
  }
  const root = managedRoot(vaultPath);
  const path = ref.storageKey === null ? root : join(root, ref.storageKey);
  return ok({ state: "materialized", text: decoded, path });
}
