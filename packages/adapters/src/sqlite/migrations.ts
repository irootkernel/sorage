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

export const MIGRATIONS: Migration[] = [FIRST_RELEASED_SCHEMA];
