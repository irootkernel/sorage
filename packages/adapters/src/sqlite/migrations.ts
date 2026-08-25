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

export const MIGRATIONS: Migration[] = [FIRST_RELEASED_SCHEMA, PROJECT_REGISTRY_MIGRATION];
