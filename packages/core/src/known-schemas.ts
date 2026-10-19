import { type AppError, appError } from "./errors";

/**
 * The central ordered known-schema inventory of SHR-009 and interface section
 * 38.7: one shared knowledge source in core, consumed by the migrator,
 * preflight, send replay inspection, doctor, and restore through per-surface
 * legacy prefix eligibility. The database migration maximum before M9 is 7;
 * version 8 is the TASK-106 additive infrastructure migration; version 9 is
 * the TASK-107 Handoff rebuild that normalizes Artifact storage onto the shared
 * content records. A build's operational catalog must match this inventory
 * exactly — an adapter test pins `MIGRATIONS` plus the production rebuild plan
 * to it — while read-only surfaces consult the eligibility rules below so a
 * database whose applied maximum exceeds this build fails closed with
 * `STORAGE_SCHEMA_UNSUPPORTED` before operational work.
 */

export interface KnownSchemaVersion {
  version: number;
  name: string;
}

export const KNOWN_SCHEMA_HISTORY: readonly KnownSchemaVersion[] = [
  { version: 1, name: "operational-baseline-v1" },
  { version: 2, name: "project-registry-v1" },
  { version: 3, name: "intent-log-v1" },
  { version: 4, name: "handoff-domain-v1" },
  { version: 5, name: "vault-move-fence-v1" },
  { version: 6, name: "backup-runs-v1" },
  { version: 7, name: "project-memos-v1" },
  { version: 8, name: "shared-content-v1" },
  { version: 9, name: "handoff-shared-content-v1" },
];

/** The highest database schema version this build knows. */
export function knownSchemaMaximum(): number {
  return KNOWN_SCHEMA_HISTORY[KNOWN_SCHEMA_HISTORY.length - 1]?.version ?? 0;
}

export function knownSchemaEntry(version: number): KnownSchemaVersion | undefined {
  return KNOWN_SCHEMA_HISTORY.find((entry) => entry.version === version);
}

/**
 * The read surfaces that share this inventory (section 38.7): the operational
 * migrator and preflight read every known version; send replay-only reads
 * complete known receipt histories from version 4 on; Memo surfaces read only
 * histories that contain the Memo domain from version 7 on; Channel surfaces
 * exist only after the Channel migration of TASK-109, so no version is eligible
 * for them at this build.
 */
export type SchemaSurface = "operational" | "preflight" | "send-replay" | "memo" | "channel";

export const SCHEMA_SURFACE_FLOORS: Record<SchemaSurface, number> = {
  operational: 1,
  preflight: 1,
  "send-replay": 4,
  memo: 7,
  channel: 11,
};

/** The lowest applied maximum a surface can read; a floor above the build's maximum means the surface does not exist yet. */
export function schemaSurfaceFloor(surface: SchemaSurface): number {
  return SCHEMA_SURFACE_FLOORS[surface];
}

/**
 * True when a surface of this build may operate on a database whose applied
 * maximum migration is `appliedMaximum`: never above this build's known
 * maximum, and never below the surface's legacy prefix floor.
 */
export function schemaSurfaceSupports(surface: SchemaSurface, appliedMaximum: number): boolean {
  if (!Number.isSafeInteger(appliedMaximum) || appliedMaximum < 0) return false;
  if (appliedMaximum > knownSchemaMaximum()) return false;
  return appliedMaximum >= SCHEMA_SURFACE_FLOORS[surface];
}

export type AppliedMigrationRow = { version: number; name: string };

export type HistoryAdmission =
  | { kind: "ok" }
  | { kind: "unsupported"; error: AppError }
  | { kind: "integrity"; error: AppError };

/**
 * Admits an applied `schema_migrations` history against one ordered catalog
 * before any DDL runs (SHR-009): an applied version the catalog does not know
 * is a forward `STORAGE_SCHEMA_UNSUPPORTED` refusal; a hole below the applied
 * maximum, a duplicate version, or a version/name mismatch is an integrity
 * refusal. Admission only reads; a refused database is provably untouched.
 */
export function admitAppliedHistory(
  rows: readonly AppliedMigrationRow[],
  catalog: readonly KnownSchemaVersion[],
): HistoryAdmission {
  const catalogMaximum = catalog[catalog.length - 1]?.version ?? 0;
  const appliedVersions = new Set<number>();
  let appliedMaximum = 0;
  const duplicates: number[] = [];
  for (const row of rows) {
    if (appliedVersions.has(row.version)) {
      duplicates.push(row.version);
      continue;
    }
    appliedVersions.add(row.version);
    appliedMaximum = Math.max(appliedMaximum, row.version);
  }
  // The conclusively higher maximum wins the mandated unsupported refusal even
  // when a duplicate is encountered earlier in the ordered rows: an unknown
  // forward version is a forward refusal, never deferred behind a local
  // integrity finding wholly below it (SHR-009, R2.4.5.2 section 7).
  if (appliedMaximum > catalogMaximum) {
    return {
      kind: "unsupported",
      error: appError(
        "STORAGE_SCHEMA_UNSUPPORTED",
        `The database schema is at migration ${String(appliedMaximum)}, newer than this build's known maximum ${String(catalogMaximum)}; Sorage never downgrades a database.`,
      ),
    };
  }
  if (duplicates.length > 0) {
    return {
      kind: "integrity",
      error: appError(
        "STORAGE_INTEGRITY_ERROR",
        `schema_migrations records version ${String(duplicates[0])} more than once.`,
      ),
    };
  }
  for (const row of rows) {
    const known = catalog.find((entry) => entry.version === row.version);
    if (known === undefined || known.name !== row.name) {
      return {
        kind: "integrity",
        error: appError(
          "STORAGE_INTEGRITY_ERROR",
          `schema_migrations records version ${String(row.version)} as '${row.name}', which this build does not know.`,
        ),
      };
    }
  }
  for (const entry of catalog) {
    if (entry.version <= appliedMaximum && !appliedVersions.has(entry.version)) {
      return {
        kind: "integrity",
        error: appError(
          "STORAGE_INTEGRITY_ERROR",
          `schema_migrations is missing known version ${String(entry.version)} below its applied maximum ${String(appliedMaximum)}.`,
        ),
      };
    }
  }
  return { kind: "ok" };
}

/** Admits against the central inventory; the production catalog every surface shares. */
export function admitKnownAppliedHistory(rows: readonly AppliedMigrationRow[]): HistoryAdmission {
  return admitAppliedHistory(rows, KNOWN_SCHEMA_HISTORY);
}
