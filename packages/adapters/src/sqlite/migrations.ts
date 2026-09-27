import type { Migration } from "./migrator";

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

export const MIGRATIONS: Migration[] = [
  FIRST_RELEASED_SCHEMA,
  PROJECT_REGISTRY_MIGRATION,
  INTENT_LOG_MIGRATION,
  HANDOFF_DOMAIN_MIGRATION,
  VAULT_MOVE_FENCE_MIGRATION,
  BACKUP_RUNS_MIGRATION,
  PROJECT_MEMOS_MIGRATION,
];
