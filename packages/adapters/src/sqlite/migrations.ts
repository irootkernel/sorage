import { createHash, randomUUID } from "node:crypto";
import type { SorageSqlite } from "./connection";
import type { Migration } from "./migrator";

/**
 * The TASK-108 Memo adoption rebuild (SHR-004, SHR-009, SHR-014, interface
 * section 38.7, ADR-0030): the complete `project_memos` table together with
 * `events` — which references both domains — is rebuilt through the official
 * SQLite generalized `ALTER TABLE` procedure on a dedicated non-operational
 * connection. `project_memos` loses its `body` column and keeps domain
 * metadata plus a NOT NULL reference to one immutable shared content record
 * that becomes the single physical authority; every existing inline body
 * moves into a fresh inline content record with its exact stored bytes —
 * byte-order mark, CRLF, empty bodies, and the presence or absence of a final
 * newline included — with size recomputed in SQL-verified form and SHA-256
 * computed in the synchronous segmented callback over the same
 * `CAST(body AS BLOB)` bytes it reads, never an invented SQLite digest
 * function. Memo UUIDs, all metadata, event rows and associations, pending
 * filesystem intents, and the exact raw `idempotency_keys` receipts are
 * preserved verbatim with no threshold repacking. Executed in-transaction
 * assertions prove per-table counts, the one-to-one Memo-to-record mapping,
 * SQL-expressible physical fidelity (inline presence, materialization, size
 * agreement, and created_at), NULL-safe column fidelity, and event
 * association preservation; the digest itself is verified by the migration
 * tests' independent recomputation. The private `:memory:` reference catalog
 * executes the same segments, where the backfill is an honest no-op over an
 * empty table.
 */
export const MEMO_SHARED_CONTENT_REBUILD_MIGRATION: Migration = {
  version: 10,
  name: "memo-shared-content-v1",
  sqlBefore: `
CREATE TABLE project_memos_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  content_record_id TEXT NOT NULL REFERENCES content_records(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'dismissed')),
  row_version INTEGER NOT NULL CHECK (row_version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT,
  CHECK ((state = 'open' AND closed_at IS NULL AND closed_by IS NULL)
    OR (state != 'open' AND row_version >= 2 AND closed_at IS NOT NULL AND closed_at = updated_at AND closed_by IS NOT NULL))
);

CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  handoff_id TEXT REFERENCES handoffs(id),
  memo_id TEXT REFERENCES project_memos(id),
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('registered_project', 'unregistered_workspace', 'user', 'system')),
  actor_id TEXT,
  row_version INTEGER,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  backfill: backfillMemoContentRecords,
  sqlAfter: `
INSERT INTO events_new (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
  SELECT id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at FROM events;

CREATE TABLE migration_v10_assertions (
  name TEXT PRIMARY KEY,
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL,
  CHECK (expected = actual)
);

INSERT INTO migration_v10_assertions (name, expected, actual) VALUES
  ('memo-count', (SELECT COUNT(*) FROM project_memos), (SELECT COUNT(*) FROM project_memos_new)),
  ('event-count', (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM events_new)),
  ('memo-record-mapping', (SELECT COUNT(*) FROM project_memos),
    (SELECT COUNT(*) FROM content_records cr JOIN project_memos_new n ON cr.id = n.content_record_id)),
  ('record-physical-fidelity', (SELECT COUNT(*) FROM project_memos),
    (SELECT COUNT(*) FROM project_memos m
      JOIN project_memos_new n ON n.id = m.id
      JOIN content_records cr ON cr.id = n.content_record_id
      WHERE cr.inline_text IS NOT NULL
        AND cr.storage_key IS NULL
        AND cr.materialized = 1
        AND cr.size_bytes = length(CAST(m.body AS BLOB))
        AND cr.created_at = m.created_at)),
  ('memo-column-fidelity', (SELECT COUNT(*) FROM project_memos),
    (SELECT COUNT(*) FROM project_memos m JOIN project_memos_new n ON n.id = m.id
      WHERE n.project_id IS m.project_id
        AND n.title IS m.title
        AND n.state IS m.state
        AND n.row_version IS m.row_version
        AND n.created_at IS m.created_at
        AND n.updated_at IS m.updated_at
        AND n.created_by IS m.created_by
        AND n.updated_by IS m.updated_by
        AND n.closed_at IS m.closed_at
        AND n.closed_by IS m.closed_by)),
  ('event-association-pairs', (SELECT COUNT(*) FROM events),
    (SELECT COUNT(*) FROM events e
      JOIN events_new en ON en.id = e.id
      WHERE en.handoff_id IS e.handoff_id
        AND en.memo_id IS e.memo_id));

DROP TABLE migration_v10_assertions;

DROP TABLE events;
DROP TABLE project_memos;

ALTER TABLE project_memos_new RENAME TO project_memos;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_project_memos_project_state ON project_memos(project_id, state, created_at DESC, id DESC);
CREATE INDEX idx_project_memos_created ON project_memos(created_at DESC, id DESC);
CREATE INDEX idx_events_handoff_created ON events(handoff_id, created_at);
CREATE INDEX idx_events_memo ON events(memo_id, created_at);
CREATE UNIQUE INDEX idx_events_memo_version ON events(memo_id, row_version) WHERE memo_id IS NOT NULL;

CREATE TRIGGER events_append_only_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;

CREATE TRIGGER events_append_only_delete
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;

CREATE TRIGGER events_memo_association
  BEFORE INSERT ON events
  WHEN (NEW.event_type IN ('MEMO_CREATED', 'MEMO_UPDATED', 'MEMO_MARKED_DONE', 'MEMO_DISMISSED', 'MEMO_REOPENED')
    AND (NEW.memo_id IS NULL OR NEW.handoff_id IS NOT NULL OR NEW.actor_kind != 'user'
      OR NEW.actor_id IS NOT NULL OR NEW.row_version IS NULL))
    OR (NEW.event_type NOT IN ('MEMO_CREATED', 'MEMO_UPDATED', 'MEMO_MARKED_DONE', 'MEMO_DISMISSED', 'MEMO_REOPENED')
      AND NEW.memo_id IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'invalid Memo event association');
  END;
`,
};

/** The bounded synchronous backfill: keyset batches over the old rows, exact stored bytes, JS-computed digests. */
function backfillMemoContentRecords(connection: SorageSqlite): void {
  const insertRecord = connection.prepare(
    `INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
    VALUES (?, CAST(? AS TEXT), NULL, ?, ?, 1, ?)`,
  );
  const insertMemo = connection.prepare(
    `INSERT INTO project_memos_new
    (id, project_id, title, content_record_id, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectBatch = connection.prepare(
    `SELECT id, CAST(body AS BLOB) AS body_bytes, project_id, title, state, row_version, created_at, updated_at, created_by, updated_by, closed_at, closed_by
    FROM project_memos WHERE id > ? ORDER BY id LIMIT ?`,
  );
  const batchSize = 200;
  let lastId = "";
  for (;;) {
    const rows = selectBatch.all(lastId, batchSize) as Array<{
      id: string;
      body_bytes: Uint8Array;
      project_id: string;
      title: string;
      state: string;
      row_version: number;
      created_at: string;
      updated_at: string;
      created_by: string;
      updated_by: string;
      closed_at: string | null;
      closed_by: string | null;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      const bytes = Buffer.from(row.body_bytes);
      const recordId = randomUUID();
      const digest = createHash("sha256").update(bytes).digest("hex");
      insertRecord.run(recordId, bytes, bytes.byteLength, digest, row.created_at);
      insertMemo.run(
        row.id,
        row.project_id,
        row.title,
        recordId,
        row.state,
        row.row_version,
        row.created_at,
        row.updated_at,
        row.created_by,
        row.updated_by,
        row.closed_at,
        row.closed_by,
      );
    }
    lastId = rows[rows.length - 1]?.id ?? "";
    if (rows.length < batchSize) break;
  }
}

/**
 * The first released schema, captured as the upgrade fixture for TASK-063. Version 1
 * holds the operational baseline the foundation milestone ships: the installation
 * identity table. Domain tables arrive with their own later migrations.
 */
export const FIRST_RELEASED_SCHEMA: Migration = {
  version: 1,
  name: "operational-baseline-v1",
  sql: `
CREATE TABLE installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`,
};

/**
 * The Project registry of EPIC-003. The slug uniqueness is case-insensitive through
 * COLLATE NOCASE (PRJ-005), and `UNIQUE(installation_id, directory)` is the sole
 * binding constraint (PRJ-016). Domain tables for Handoffs arrive with EPIC-005.
 */
export const PROJECT_REGISTRY_MIGRATION: Migration = {
  version: 2,
  name: "project-registry-v1",
  sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  installation_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('git_repository', 'directory')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, directory)
);

CREATE INDEX idx_project_bindings_project_id ON project_bindings(project_id);
`,
};

/**
 * The intent log of EPIC-004 (ADR-0013, VLT-021): one row in `pending_fs_ops` is
 * a promise the database has already made, every process drains outstanding rows
 * in `created_at` order before doing anything else, and an unresolved row after
 * a drain is the durable integrity-failed signal the doctor check reports. Paths
 * are Vault-relative; `attempts` increments on every drain evaluation (CP-7).
 */
export const INTENT_LOG_MIGRATION: Migration = {
  version: 3,
  name: "intent-log-v1",
  sql: `
CREATE TABLE pending_fs_ops (
  id TEXT PRIMARY KEY,
  op TEXT NOT NULL CHECK (op IN ('activate', 'unlink')),
  from_path TEXT,
  to_path TEXT NOT NULL,
  artifact_id TEXT,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_pending_fs_ops_created_at ON pending_fs_ops(created_at);
`,
};

/**
 * The Handoff domain of EPIC-005 (sections 3.3 to 3.9 and 18). The `handoffs` row
 * carries exactly one recipient and the nullable engagement timestamps; the
 * handoff-to-artifact reference cycle uses deferred foreign keys so one transaction
 * can insert the Artifact row and the Handoff row that names it as current in either
 * order; `review_notes.handoff_id` is the primary key and therefore the at-most-one
 * Note constraint; a partial unique index keeps at most one pending Deletion Request
 * per Handoff; and the `events` triggers make the ledger append-only in practice,
 * because every update or delete aborts (SEC-012).
 */
export const HANDOFF_DOMAIN_MIGRATION: Migration = {
  version: 4,
  name: "handoff-domain-v1",
  sql: `
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  dispatch_group_id TEXT,
  supersedes_handoff_id TEXT REFERENCES handoffs(id),
  title TEXT NOT NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('registered_project', 'unregistered_workspace', 'user')),
  sender_project_id TEXT REFERENCES projects(id),
  sender_workspace_key TEXT,
  sender_path_snapshot TEXT,
  recipient_project_id TEXT NOT NULL REFERENCES projects(id),
  current_artifact_id TEXT REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  review_state TEXT NOT NULL CHECK (review_state IN ('awaiting_recipient', 'changes_requested', 'accepted', 'declined', 'withdrawn')),
  accepted_revision INTEGER,
  accepted_at TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  withdrawn_at TEXT,
  consecutive_no_change_resolutions INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_no_change_resolutions >= 0),
  first_fetched_at TEXT,
  review_engaged_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (deleted_at IS NOT NULL OR current_artifact_id IS NOT NULL)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) DEFERRABLE INITIALLY DEFERRED,
  storage_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  imported_from_path TEXT,
  materialized INTEGER NOT NULL DEFAULT 0 CHECK (materialized IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE review_notes (
  handoff_id TEXT PRIMARY KEY REFERENCES handoffs(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('registered_project', 'user')),
  author_project_id TEXT REFERENCES projects(id),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deletion_requests (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('registered_project', 'unregistered_workspace', 'user')),
  requested_by_id TEXT,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_user TEXT,
  resolution_note TEXT
);

CREATE UNIQUE INDEX idx_deletion_requests_pending
  ON deletion_requests(handoff_id) WHERE status = 'pending';

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  handoff_id TEXT REFERENCES handoffs(id),
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('registered_project', 'unregistered_workspace', 'user', 'system')),
  actor_id TEXT,
  row_version INTEGER,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER events_append_only_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;

CREATE TRIGGER events_append_only_delete
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (key, scope)
);

CREATE INDEX idx_handoffs_inbox ON handoffs(recipient_project_id, review_state, updated_at);
CREATE INDEX idx_handoffs_outbox_project ON handoffs(sender_project_id, review_state, updated_at);
CREATE INDEX idx_handoffs_outbox_workspace ON handoffs(sender_workspace_key);
CREATE INDEX idx_handoffs_dispatch_group ON handoffs(dispatch_group_id);
CREATE INDEX idx_events_handoff_created ON events(handoff_id, created_at);
CREATE INDEX idx_artifacts_handoff ON artifacts(handoff_id);
CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys(expires_at);
`,
};

/**
 * The vault-move fence of TASK-029 (RUN-002, the EPIC-004 accepted seam): the mover
 * sets the single fence row in the same write transaction as its pre-switch intent
 * re-count, and every intent commit reads the row inside its own transaction, so the
 * two serialize on the database write lock and a promise can never land between the
 * re-count and the configuration switch. The row carries the mover's pid, and a fence
 * whose pid is dead is stale and ignored, matching the lockfile staleness philosophy.
 */
export const VAULT_MOVE_FENCE_MIGRATION: Migration = {
  version: 5,
  name: "vault-move-fence-v1",
  sql: `
CREATE TABLE vault_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  move_fence_pid INTEGER,
  move_fence_at TEXT
);
`,
};

/**
 * The backup run history of TASK-054 (BKP-006, BKP-009, BKP-010, BKP-016):
 * `backup_runs` is the single scheduler authority — there is no separate
 * scheduler state file — and every attempt that held `backup.lock` writes
 * exactly one row carrying its snapshot, commit, and push outcomes separately
 * (section 30), the created commit when there was one, and the symbolic
 * failure code when there was none.
 */
export const BACKUP_RUNS_MIGRATION: Migration = {
  version: 6,
  name: "backup-runs-v1",
  sql: `
CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('manual', 'scheduled', 'catch-up')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'no-change', 'failure')),
  snapshot_outcome TEXT NOT NULL CHECK (snapshot_outcome IN ('success', 'skipped', 'failure')),
  commit_outcome TEXT NOT NULL CHECK (commit_outcome IN ('committed', 'no-change', 'skipped', 'failure')),
  push_outcome TEXT NOT NULL CHECK (push_outcome IN ('pushed', 'skipped', 'failure', 'disabled')),
  commit_sha TEXT,
  failure_code TEXT,
  failure_message TEXT
);

CREATE INDEX idx_backup_runs_started_at ON backup_runs(started_at);
`,
};

export const PROJECT_MEMOS_MIGRATION: Migration = {
  version: 7,
  name: "project-memos-v1",
  sql: `
CREATE TABLE project_memos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536),
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'dismissed')),
  row_version INTEGER NOT NULL CHECK (row_version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT,
  CHECK ((state = 'open' AND closed_at IS NULL AND closed_by IS NULL)
    OR (state != 'open' AND row_version >= 2 AND closed_at IS NOT NULL AND closed_at = updated_at AND closed_by IS NOT NULL))
);
CREATE INDEX idx_project_memos_project_state ON project_memos(project_id, state, created_at DESC, id DESC);
CREATE INDEX idx_project_memos_created ON project_memos(created_at DESC, id DESC);
ALTER TABLE events ADD COLUMN memo_id TEXT REFERENCES project_memos(id);
CREATE INDEX idx_events_memo ON events(memo_id, created_at);
CREATE UNIQUE INDEX idx_events_memo_version ON events(memo_id, row_version) WHERE memo_id IS NOT NULL;
CREATE TRIGGER events_memo_association
  BEFORE INSERT ON events
  WHEN (NEW.event_type IN ('MEMO_CREATED', 'MEMO_UPDATED', 'MEMO_MARKED_DONE', 'MEMO_DISMISSED', 'MEMO_REOPENED')
    AND (NEW.memo_id IS NULL OR NEW.handoff_id IS NOT NULL OR NEW.actor_kind != 'user'
      OR NEW.actor_id IS NOT NULL OR NEW.row_version IS NULL))
    OR (NEW.event_type NOT IN ('MEMO_CREATED', 'MEMO_UPDATED', 'MEMO_MARKED_DONE', 'MEMO_DISMISSED', 'MEMO_REOPENED')
      AND NEW.memo_id IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'invalid Memo event association');
  END;
`,
};

/**
 * The TASK-106 shared-content infrastructure migration (SHR-004, SHR-009,
 * SHR-011, interface section 38.7): additive DDL only, rebuilding no domain
 * table, so every existing transport keeps working at this commit. The
 * immutable content registry enforces the XOR representation at the table
 * level — exactly one of inline content and a managed storage key, a nonempty
 * key, a nonnegative size, a lowercase 64-hex digest, and inline rows pinned
 * materialized — and the sha256 index is deliberately nonunique, because
 * immutable records are never deduplicated by digest. `pending_fs_ops` gains
 * the common-intent owner columns: SQLite `ALTER TABLE ... ADD COLUMN` cannot
 * add a multi-column table CHECK and rebuilding the intent log is out of scope,
 * so all-null legacy rows versus the all-present owner triple is application
 * validation plus tests, with the single-column enum CHECK as the database
 * bound; legacy `artifact_id` semantics stay unchanged.
 */
export const SHARED_CONTENT_MIGRATION: Migration = {
  version: 8,
  name: "shared-content-v1",
  sql: `
CREATE TABLE content_records (
  id TEXT PRIMARY KEY,
  inline_text TEXT,
  storage_key TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  materialized INTEGER NOT NULL DEFAULT 0 CHECK (materialized IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK ((inline_text IS NULL) != (storage_key IS NULL)),
  CHECK (storage_key IS NULL OR storage_key != ''),
  CHECK (inline_text IS NULL OR materialized = 1)
);
CREATE INDEX idx_content_records_sha256 ON content_records(sha256);
ALTER TABLE pending_fs_ops ADD COLUMN owner_domain TEXT CHECK (owner_domain IS NULL OR owner_domain IN ('memo', 'channel'));
ALTER TABLE pending_fs_ops ADD COLUMN owner_id TEXT;
ALTER TABLE pending_fs_ops ADD COLUMN content_id TEXT;
`,
};

/**
 * The TASK-123 rebuilt Channel domain migration (CHN-001 to CHN-014, SHR-009,
 * interface sections 38.7 and 38.3): the version-11 slot is replaced in place
 * under the migration name `channels-v2` before first publication, so a
 * development home holding `11 / channels-v1` is refused by the existing
 * migration-name check rather than migrated. Pure additive DDL that rebuilds no
 * existing table, so `events` keeps its v9/v10 shape and only gains the Channel
 * association trigger over the six rebuilt event names. The three Channel
 * tables carry the closed domain constraints at the database level — lifecycle
 * states, roles, message kinds, the relay target's presence exactly on
 * `relay_request`, the one-main invariant through a partial unique index, handle
 * uniqueness inside one Channel, per-Channel sequence numbers as the message
 * primary key, the handled/handled-at/handled-note coherence, and the NOT NULL
 * reference from a message to its immutable shared content record — while
 * application validation owns the closed event metadata and same-Channel
 * membership rules the mutation transaction enforces.
 */
export const CHANNEL_DOMAIN_MIGRATION: Migration = {
  version: 11,
  name: "channels-v2",
  sql: `
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK ((state = 'open' AND closed_at IS NULL) OR (state = 'closed' AND closed_at IS NOT NULL))
);

CREATE INDEX idx_channels_state_created ON channels(state, created_at DESC, id DESC);

CREATE TABLE channel_participants (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  handle TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('main', 'worker', 'judge')),
  added_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (channel_id, handle)
);

CREATE UNIQUE INDEX idx_channel_one_main ON channel_participants(channel_id) WHERE role = 'main';

CREATE TABLE channel_messages (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  sender_handle TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('report', 'question', 'relay_request')),
  to_handle TEXT,
  ref TEXT,
  content_record_id TEXT NOT NULL REFERENCES content_records(id),
  handled INTEGER NOT NULL CHECK (handled IN (0, 1)),
  handled_at TEXT,
  handle_note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, seq),
  FOREIGN KEY (channel_id, sender_handle) REFERENCES channel_participants(channel_id, handle),
  FOREIGN KEY (channel_id, to_handle) REFERENCES channel_participants(channel_id, handle),
  CHECK ((kind = 'relay_request' AND to_handle IS NOT NULL) OR (kind != 'relay_request' AND to_handle IS NULL)),
  CHECK ((handled = 0 AND handled_at IS NULL AND handle_note IS NULL)
      OR (handled = 1 AND handled_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_channel_messages_record ON channel_messages(content_record_id);
CREATE INDEX idx_channel_messages_unhandled ON channel_messages(channel_id, seq) WHERE handled = 0;
CREATE INDEX idx_channel_messages_unhandled_identity
  ON channel_messages(channel_id, sender_handle, kind, to_handle, ref) WHERE handled = 0;

CREATE TRIGGER events_channel_association
  BEFORE INSERT ON events
  WHEN NEW.event_type IN ('CHANNEL_CREATED', 'CHANNEL_PARTICIPANT_ADDED', 'CHANNEL_PARTICIPANT_REMOVED',
      'CHANNEL_MESSAGE_POSTED', 'CHANNEL_MESSAGE_ACKED', 'CHANNEL_CLOSED')
    AND (NEW.handoff_id IS NOT NULL OR NEW.memo_id IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'invalid Channel event association');
  END;
`,
};

/**
 * The TASK-107 Handoff adoption rebuild (SHR-004, SHR-009, SHR-014, interface
 * section 38.7, ADR-0030/0031): the complete `handoffs`/`artifacts` FK cycle
 * plus its dependents `review_notes`, `deletion_requests`, and `events` is
 * rebuilt through the official SQLite generalized `ALTER TABLE` procedure on a
 * dedicated non-operational connection. Artifacts lose the mirrored physical
 * columns — `storage_key`, `size_bytes`, `sha256`, `materialized` — and keep
 * domain metadata plus a NOT NULL reference to one immutable shared content
 * record that becomes the single physical authority. The backfill mints one
 * independent content-record UUID per Artifact row in SQL (`randomblob`-based
 * canonical v4, distinct from the Artifact's own id, never reusing it) and
 * reuses that same generated value for both the record row and the Artifact
 * reference, so the mapping is created exactly once with no key-based join.
 * Existing Artifact identities — including the legacy short `a[0-9a-f]{8}`
 * form — storage keys, byte sizes, digests, materialization states, ledger
 * associations, pending filesystem intents, and retained receipt rows are
 * copied verbatim with no repacking; pre-existing version-8 content records
 * are untouched. Executed in-transaction assertions — a CHECK-constrained
 * assertion table whose every inserted row must carry equal expected/actual
 * counts — prove per-table row counts, the one-to-one Artifact-to-record
 * mapping, exact physical-column fidelity of every backfilled record, and the
 * preservation of every original association compared per original row identity
 * with NULL-safe equality: Handoff current-Artifact and supersedes references,
 * Artifact handoff ownership, Review Note and Deletion Request handoff
 * associations, and Event handoff and Memo associations alike. Any mismatch
 * aborts the whole batch before a drop or commit. The unique index on
 * `content_record_id` and the guarded runner's final whole-database
 * `PRAGMA foreign_key_check` gate close the remaining structural obligations.
 */
export const HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION: Migration = {
  version: 9,
  name: "handoff-shared-content-v1",
  sql: `
CREATE TABLE handoffs_new (
  id TEXT PRIMARY KEY,
  dispatch_group_id TEXT,
  supersedes_handoff_id TEXT REFERENCES handoffs(id),
  title TEXT NOT NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('registered_project', 'unregistered_workspace', 'user')),
  sender_project_id TEXT REFERENCES projects(id),
  sender_workspace_key TEXT,
  sender_path_snapshot TEXT,
  recipient_project_id TEXT NOT NULL REFERENCES projects(id),
  current_artifact_id TEXT REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  review_state TEXT NOT NULL CHECK (review_state IN ('awaiting_recipient', 'changes_requested', 'accepted', 'declined', 'withdrawn')),
  accepted_revision INTEGER,
  accepted_at TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  withdrawn_at TEXT,
  consecutive_no_change_resolutions INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_no_change_resolutions >= 0),
  first_fetched_at TEXT,
  review_engaged_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (deleted_at IS NOT NULL OR current_artifact_id IS NOT NULL)
);

CREATE TABLE artifacts_new (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) DEFERRABLE INITIALLY DEFERRED,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  imported_from_path TEXT,
  created_at TEXT NOT NULL,
  content_record_id TEXT NOT NULL REFERENCES content_records(id)
);

CREATE TABLE review_notes_new (
  handoff_id TEXT PRIMARY KEY REFERENCES handoffs(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('registered_project', 'user')),
  author_project_id TEXT REFERENCES projects(id),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deletion_requests_new (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('registered_project', 'unregistered_workspace', 'user')),
  requested_by_id TEXT,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_user TEXT,
  resolution_note TEXT
);

CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  handoff_id TEXT REFERENCES handoffs(id),
  memo_id TEXT REFERENCES project_memos(id),
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('registered_project', 'unregistered_workspace', 'user', 'system')),
  actor_id TEXT,
  row_version INTEGER,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO handoffs_new (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, accepted_revision, accepted_at, declined_at, decline_reason, withdrawn_at, consecutive_no_change_resolutions, first_fetched_at, review_engaged_at, pinned, archived_at, deleted_at, created_at, updated_at)
  SELECT id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, accepted_revision, accepted_at, declined_at, decline_reason, withdrawn_at, consecutive_no_change_resolutions, first_fetched_at, review_engaged_at, pinned, archived_at, deleted_at, created_at, updated_at FROM handoffs;

INSERT INTO artifacts_new (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id)
  SELECT id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at,
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
  FROM artifacts;

INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at)
  SELECT n.content_record_id, NULL, a.storage_key, a.size_bytes, a.sha256, a.materialized, a.created_at
  FROM artifacts_new n JOIN artifacts a ON a.id = n.id;

INSERT INTO review_notes_new (handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at)
  SELECT handoff_id, author_kind, author_project_id, target_revision, body, created_at, updated_at FROM review_notes;

INSERT INTO deletion_requests_new (id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at, resolved_at, resolved_by_user, resolution_note)
  SELECT id, handoff_id, requested_by_kind, requested_by_id, reason, status, requested_at, resolved_at, resolved_by_user, resolution_note FROM deletion_requests;

INSERT INTO events_new (id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at)
  SELECT id, handoff_id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at FROM events;

CREATE TABLE migration_v9_assertions (
  name TEXT PRIMARY KEY,
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL,
  CHECK (expected = actual)
);

INSERT INTO migration_v9_assertions (name, expected, actual) VALUES
  ('handoff-count', (SELECT COUNT(*) FROM handoffs), (SELECT COUNT(*) FROM handoffs_new)),
  ('artifact-count', (SELECT COUNT(*) FROM artifacts), (SELECT COUNT(*) FROM artifacts_new)),
  ('review-note-count', (SELECT COUNT(*) FROM review_notes), (SELECT COUNT(*) FROM review_notes_new)),
  ('deletion-request-count', (SELECT COUNT(*) FROM deletion_requests), (SELECT COUNT(*) FROM deletion_requests_new)),
  ('event-count', (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM events_new)),
  ('artifact-record-mapping', (SELECT COUNT(*) FROM artifacts),
    (SELECT COUNT(*) FROM content_records cr JOIN artifacts_new n ON cr.id = n.content_record_id)),
  ('record-physical-fidelity', (SELECT COUNT(*) FROM artifacts),
    (SELECT COUNT(*) FROM artifacts a
      JOIN artifacts_new n ON n.id = a.id
      JOIN content_records cr ON cr.id = n.content_record_id
      WHERE cr.inline_text IS NULL
        AND cr.storage_key = a.storage_key
        AND cr.size_bytes = a.size_bytes
        AND cr.sha256 = a.sha256
        AND cr.materialized = a.materialized
        AND cr.created_at = a.created_at)),
  ('handoff-association-pairs', (SELECT COUNT(*) FROM handoffs),
    (SELECT COUNT(*) FROM handoffs h
      JOIN handoffs_new n ON n.id = h.id
      WHERE n.current_artifact_id IS h.current_artifact_id
        AND n.supersedes_handoff_id IS h.supersedes_handoff_id)),
  ('artifact-ownership-pairs', (SELECT COUNT(*) FROM artifacts),
    (SELECT COUNT(*) FROM artifacts a
      JOIN artifacts_new n ON n.id = a.id
      WHERE n.handoff_id IS a.handoff_id)),
  ('review-note-association-pairs', (SELECT COUNT(*) FROM review_notes),
    (SELECT COUNT(*) FROM review_notes_new rn JOIN handoffs h ON h.id = rn.handoff_id)),
  ('deletion-request-association-pairs', (SELECT COUNT(*) FROM deletion_requests),
    (SELECT COUNT(*) FROM deletion_requests d
      JOIN deletion_requests_new dn ON dn.id = d.id
      WHERE dn.handoff_id IS d.handoff_id)),
  ('event-association-pairs', (SELECT COUNT(*) FROM events),
    (SELECT COUNT(*) FROM events e
      JOIN events_new en ON en.id = e.id
      WHERE en.handoff_id IS e.handoff_id
        AND en.memo_id IS e.memo_id));

DROP TABLE migration_v9_assertions;

DROP TABLE events;
DROP TABLE deletion_requests;
DROP TABLE review_notes;
DROP TABLE artifacts;
DROP TABLE handoffs;

ALTER TABLE handoffs_new RENAME TO handoffs;
ALTER TABLE artifacts_new RENAME TO artifacts;
ALTER TABLE review_notes_new RENAME TO review_notes;
ALTER TABLE deletion_requests_new RENAME TO deletion_requests;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_handoffs_inbox ON handoffs(recipient_project_id, review_state, updated_at);
CREATE INDEX idx_handoffs_outbox_project ON handoffs(sender_project_id, review_state, updated_at);
CREATE INDEX idx_handoffs_outbox_workspace ON handoffs(sender_workspace_key);
CREATE INDEX idx_handoffs_dispatch_group ON handoffs(dispatch_group_id);
CREATE INDEX idx_events_handoff_created ON events(handoff_id, created_at);
CREATE INDEX idx_artifacts_handoff ON artifacts(handoff_id);
CREATE UNIQUE INDEX idx_artifacts_content_record ON artifacts(content_record_id);
CREATE UNIQUE INDEX idx_deletion_requests_pending ON deletion_requests(handoff_id) WHERE status = 'pending';
CREATE INDEX idx_events_memo ON events(memo_id, created_at);
CREATE UNIQUE INDEX idx_events_memo_version ON events(memo_id, row_version) WHERE memo_id IS NOT NULL;

CREATE TRIGGER events_append_only_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;

CREATE TRIGGER events_append_only_delete
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;

CREATE TRIGGER events_memo_association
  BEFORE INSERT ON events
  WHEN (NEW.event_type IN ('MEMO_CREATED', 'MEMO_UPDATED', 'MEMO_MARKED_DONE', 'MEMO_DISMISSED', 'MEMO_REOPENED')
    AND (NEW.memo_id IS NULL OR NEW.handoff_id IS NOT NULL OR NEW.actor_kind != 'user'
      OR NEW.actor_id IS NOT NULL OR NEW.row_version IS NULL))
    OR (NEW.event_type NOT IN ('MEMO_CREATED', 'MEMO_UPDATED', 'MEMO_MARKED_DONE', 'MEMO_DISMISSED', 'MEMO_REOPENED')
      AND NEW.memo_id IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'invalid Memo event association');
  END;
`,
};

/** Add current reporting evidence without rewriting the immutable schema-11 generation. */
export const HANDOFF_REPORTING_MIGRATION: Migration = {
  version: 12,
  name: "handoff-reporting-v1",
  sql: `
ALTER TABLE handoffs ADD COLUMN read_status TEXT NOT NULL DEFAULT 'unrecorded'
  CHECK (read_status IN ('unrecorded', 'unconfirmed', 'read'));
ALTER TABLE handoffs ADD COLUMN read_revision INTEGER
  CHECK (read_revision IS NULL OR (read_revision >= 1 AND read_revision <= revision));
ALTER TABLE handoffs ADD COLUMN revision_read_at TEXT;
ALTER TABLE handoffs ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'unrecorded'
  CHECK (processing_status IN ('unrecorded', 'not_started', 'in_progress', 'completed'));
ALTER TABLE handoffs ADD COLUMN processing_started_at TEXT;
ALTER TABLE handoffs ADD COLUMN processing_completed_at TEXT
  CHECK ((read_status = 'read' AND read_revision IS NOT NULL AND read_revision = revision AND revision_read_at IS NOT NULL)
    OR (read_status != 'read' AND read_revision IS NULL AND revision_read_at IS NULL))
  CHECK ((processing_status IN ('unrecorded', 'not_started') AND processing_started_at IS NULL AND processing_completed_at IS NULL)
    OR (processing_status = 'in_progress' AND processing_started_at IS NOT NULL AND processing_completed_at IS NULL)
    OR (processing_status = 'completed' AND processing_completed_at IS NOT NULL));
ALTER TABLE review_notes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'change_request'
  CHECK (purpose IN ('general', 'change_request'));
ALTER TABLE review_notes ADD COLUMN active INTEGER NOT NULL DEFAULT 1
  CHECK (active IN (0, 1) AND (active = 0 OR purpose = 'change_request'));
UPDATE review_notes SET active = CASE WHEN EXISTS (
  SELECT 1 FROM handoffs h WHERE h.id = review_notes.handoff_id AND h.review_state = 'changes_requested'
) THEN 1 ELSE 0 END;
`,
};

export interface ProductionMigrationPlan {
  migrations: Migration[];
  rebuilds: Migration[];
}

/**
 * The single production migration plan of TASK-107 through TASK-129 (SHR-009,
 * interface section 38.7): the raw `MIGRATIONS` list stays exactly versions 1
 * to 8 — the legacy fixture catalog every historical builder migrates with —
 * while the production accessor appends the Channel migration at version 11
 * and Handoff reporting migration at version 12 as ordinary steps and registers versions 9 and 10
 * exactly once each as the rebuild-marked steps. The combined runner orders
 * every pending step by version, so ordinary 11 and 12 execute after rebuilds
 * 9 and 10 inside the one guarded whole-batch path the non-empty rebuild set already
 * selects; no runner branch changes. Every production opener, the migrator's
 * admission catalog, and preflight's reference catalog consume this one
 * accessor so no surface can drift, never a second ordinary registration, and
 * never a silent bypass of the dedicated path.
 */
export function productionMigrationPlan(): ProductionMigrationPlan {
  return {
    migrations: [...MIGRATIONS, CHANNEL_DOMAIN_MIGRATION, HANDOFF_REPORTING_MIGRATION],
    rebuilds: [HANDOFF_SHARED_CONTENT_REBUILD_MIGRATION, MEMO_SHARED_CONTENT_REBUILD_MIGRATION],
  };
}

export const MIGRATIONS: Migration[] = [
  FIRST_RELEASED_SCHEMA,
  PROJECT_REGISTRY_MIGRATION,
  INTENT_LOG_MIGRATION,
  HANDOFF_DOMAIN_MIGRATION,
  VAULT_MOVE_FENCE_MIGRATION,
  BACKUP_RUNS_MIGRATION,
  PROJECT_MEMOS_MIGRATION,
  SHARED_CONTENT_MIGRATION,
];
