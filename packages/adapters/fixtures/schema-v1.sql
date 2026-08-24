CREATE TABLE installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE migration_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'operational-baseline-v1', '2026-08-24T06:14:02.302Z');

