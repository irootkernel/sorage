import { realpathSync } from "node:fs";
import type { ActorRef, Project, ProjectBinding, ProjectRepositoryPort } from "@sorage/core";
import { type AppError, appError, err, ok, UuidGenerator } from "@sorage/core";
import type { SqliteEventLedger } from "./events";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The SQLite Project repository behind the core port. The installation identity is
 * read from the single `installation` row so a binding can never claim another
 * installation, and every directory is normalized to its real path before it is
 * stored (PRJ-006). Every mutation appends its Project lifecycle event inside the
 * same transaction (SEC-012), so a mutation and its event land together or not at all.
 */

type ProjectRow = {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type BindingRow = {
  id: string;
  project_id: string;
  installation_id: string;
  directory: string;
  binding_kind: string;
  created_at: string;
  updated_at: string;
};

export type ProjectRepositoryFs = {
  realpath: (path: string) => string;
};

const nativeFs: ProjectRepositoryFs = { realpath: (path) => realpathSync(path) };

export interface SqliteProjectRepositoryOptions {
  /**
   * The installation identity that owns every binding. The canonical value is the
   * generated `installationId` in the effective configuration, so the wiring reads it
   * from the config store and the repository never trusts a caller-supplied identity.
   */
  installationId: string;
  fs?: ProjectRepositoryFs;
  /** The append-only ledger every mutation's event lands in, inside the same transaction. */
  events: SqliteEventLedger;
}

const defaultEventIds = new UuidGenerator();

export function createSqliteProjectRepository(
  db: SorageSqlite,
  options: SqliteProjectRepositoryOptions,
): ProjectRepositoryPort {
  const fs = options.fs ?? nativeFs;
  const ledger = options.events;
  const emit = (
    eventType:
      | "PROJECT_REGISTERED"
      | "PROJECT_BINDING_ADDED"
      | "PROJECT_BINDING_REMOVED"
      | "PROJECT_STATUS_ARCHIVED"
      | "PROJECT_STATUS_ACTIVE"
      | "PROJECT_RENAMED",
    actor: ActorRef,
    metadata: Record<string, unknown>,
    createdAt: string,
  ): void => {
    ledger.appendNow({ eventType, actor, metadata, id: defaultEventIds.next(), createdAt });
  };
  return {
    createProject(project, actor) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
          ).run(
            project.id,
            project.slug,
            project.displayName,
            project.description,
            project.createdAt,
            project.createdAt,
          );
          emit("PROJECT_REGISTERED", actor, { projectId: project.id, slug: project.slug }, project.createdAt);
          db.exec("COMMIT");
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction may already be closed; the original failure is decisive.
          }
          throw transactionError;
        }
        return ok(
          toProject({
            id: project.id,
            slug: project.slug,
            display_name: project.displayName,
            description: project.description,
            status: "active",
            created_at: project.createdAt,
            updated_at: project.createdAt,
          }),
        );
      } catch (error) {
        const conflict = uniqueViolation(error);
        if (conflict === "projects.slug") {
          return err(
            appError("PROJECT_SLUG_CONFLICT", `the slug '${project.slug}' is already taken`, { slug: project.slug }),
          );
        }
        return err(internal(error));
      }
    },
    createProjectWithBinding(project, binding, actor) {
      try {
        const installationId = options.installationId;
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
          ).run(
            project.id,
            project.slug,
            project.displayName,
            project.description,
            project.createdAt,
            project.createdAt,
          );
          const directory = fs.realpath(binding.directory);
          db.prepare(
            "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            binding.id,
            project.id,
            installationId,
            directory,
            binding.bindingKind,
            binding.createdAt,
            binding.createdAt,
          );
          emit("PROJECT_REGISTERED", actor, { projectId: project.id, slug: project.slug }, project.createdAt);
          emit(
            "PROJECT_BINDING_ADDED",
            actor,
            { projectId: project.id, bindingId: binding.id, directory, bindingKind: binding.bindingKind },
            binding.createdAt,
          );
          db.exec("COMMIT");
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction may already be closed; the original failure is decisive.
          }
          throw transactionError;
        }
        const projectRow = db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id) as ProjectRow;
        const bindingRow = db.prepare("SELECT * FROM project_bindings WHERE id = ?").get(binding.id) as BindingRow;
        return ok({ project: toProject(projectRow), binding: toBinding(bindingRow) });
      } catch (error) {
        return err(mapInsertError(error, project.slug, binding.directory));
      }
    },
    findProjectBySlug(slug) {
      try {
        // NOCASE folds only ASCII, so the query folds the way every stored slug is
        // folded (deriveProjectSlug and addProject use toLowerCase, which is
        // locale-independent) and lookup stays case-insensitive in every script and on
        // every host (PRJ-005). bun:sqlite returns null for a no-row get and
        // node:sqlite returns undefined, so both mean absence.
        const row = db.prepare("SELECT * FROM projects WHERE slug = ? COLLATE NOCASE").get(slug.toLowerCase()) as
          | ProjectRow
          | null
          | undefined;
        return ok(row ? toProject(row) : null);
      } catch (error) {
        return err(internal(error));
      }
    },
    listProjects() {
      try {
        const rows = db.prepare("SELECT * FROM projects ORDER BY slug COLLATE NOCASE").all() as unknown as ProjectRow[];
        return ok(rows.map(toProject));
      } catch (error) {
        return err(internal(error));
      }
    },
    addBinding(binding, actor) {
      try {
        // Inside the try like createProjectWithBinding, so a directory that vanishes
        // between the resolveDirectory check and this insert surfaces as an error
        // result instead of a raw throw past the error envelope.
        const directory = fs.realpath(binding.directory);
        const installationId = options.installationId;
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            binding.id,
            binding.projectId,
            installationId,
            directory,
            binding.bindingKind,
            binding.createdAt,
            binding.createdAt,
          );
          emit(
            "PROJECT_BINDING_ADDED",
            actor,
            { projectId: binding.projectId, bindingId: binding.id, directory, bindingKind: binding.bindingKind },
            binding.createdAt,
          );
          db.exec("COMMIT");
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // As above: nothing left to roll back.
          }
          throw transactionError;
        }
        return ok(
          toBinding({
            id: binding.id,
            project_id: binding.projectId,
            installation_id: installationId,
            directory,
            binding_kind: binding.bindingKind,
            created_at: binding.createdAt,
            updated_at: binding.createdAt,
          }),
        );
      } catch (error) {
        const conflict = uniqueViolation(error);
        if (conflict === "project_bindings.installation_id, project_bindings.directory") {
          return err(
            appError(
              "BINDING_DUPLICATE",
              `the directory '${binding.directory}' is already bound on this installation`,
              {
                directory: binding.directory,
              },
            ),
          );
        }
        return err(internal(error));
      }
    },
    updateProjectDisplayName(projectId, displayName, updatedAt, actor) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const changed = db
            .prepare("UPDATE projects SET display_name = ?, updated_at = ? WHERE id = ?")
            .run(displayName, updatedAt, projectId) as { changes: number };
          if (changed.changes !== 1) {
            db.exec("ROLLBACK");
            return err(appError("PROJECT_NOT_FOUND", `no Project has the id '${projectId}'`, { projectId }));
          }
          emit("PROJECT_RENAMED", actor, { projectId, displayName }, updatedAt);
          db.exec("COMMIT");
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // As above.
          }
          throw transactionError;
        }
        const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | null | undefined;
        if (!row) {
          return err(internal(new Error("the renamed Project row disappeared mid-transaction")));
        }
        return ok(toProject(row));
      } catch (error) {
        return err(internal(error));
      }
    },
    updateProjectStatus(projectId, status, updatedAt, actor) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const changed = db
            .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?")
            .run(status, updatedAt, projectId) as { changes: number };
          if (changed.changes !== 1) {
            db.exec("ROLLBACK");
            return err(appError("PROJECT_NOT_FOUND", `no Project has the id '${projectId}'`, { projectId }));
          }
          emit(
            status === "archived" ? "PROJECT_STATUS_ARCHIVED" : "PROJECT_STATUS_ACTIVE",
            actor,
            { projectId, status },
            updatedAt,
          );
          db.exec("COMMIT");
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // As above.
          }
          throw transactionError;
        }
        const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow;
        return ok(toProject(row));
      } catch (error) {
        return err(internal(error));
      }
    },
    removeBinding(bindingId, actor) {
      try {
        // bun:sqlite returns null for a no-row get and node:sqlite returns undefined;
        // both mean the binding is already gone.
        const row = db.prepare("SELECT * FROM project_bindings WHERE id = ?").get(bindingId) as
          | BindingRow
          | null
          | undefined;
        if (!row) {
          return err(appError("PROJECT_NOT_FOUND", `no binding has the id '${bindingId}'`, { bindingId }));
        }
        const removedAt = row.updated_at;
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM project_bindings WHERE id = ?").run(bindingId);
          emit(
            "PROJECT_BINDING_REMOVED",
            actor,
            { projectId: row.project_id, bindingId, directory: row.directory, bindingKind: row.binding_kind },
            removedAt,
          );
          db.exec("COMMIT");
        } catch (transactionError) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // As above.
          }
          throw transactionError;
        }
        return ok(toBinding(row));
      } catch (error) {
        return err(internal(error));
      }
    },
    listBindings() {
      try {
        const rows = db.prepare("SELECT * FROM project_bindings ORDER BY directory").all() as unknown as BindingRow[];
        return ok(rows.map(toBinding));
      } catch (error) {
        return err(internal(error));
      }
    },
    listBindingsForProject(projectId) {
      try {
        const rows = db
          .prepare("SELECT * FROM project_bindings WHERE project_id = ? ORDER BY directory")
          .all(projectId) as unknown as BindingRow[];
        return ok(rows.map(toBinding));
      } catch (error) {
        return err(internal(error));
      }
    },
  };
}

/** Maps one insert failure to its published conflict code, or an internal error. */
function mapInsertError(error: unknown, slug: string, directory: string): AppError {
  const conflict = uniqueViolation(error);
  if (conflict === "projects.slug") {
    return appError("PROJECT_SLUG_CONFLICT", `the slug '${slug}' is already taken`, { slug });
  }
  if (conflict === "project_bindings.installation_id, project_bindings.directory") {
    return appError("BINDING_DUPLICATE", `the directory '${directory}' is already bound on this installation`, {
      directory,
    });
  }
  return internal(error);
}

/** Returns the violated unique constraint's columns, or undefined for any other failure. */
function uniqueViolation(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /UNIQUE constraint failed: (.+)$/.exec(message);
  return match === null ? undefined : match[1];
}

function internal(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return appError("INTERNAL_ERROR", `the project repository failed: ${message}`);
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    status: row.status === "archived" ? "archived" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBinding(row: BindingRow): ProjectBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    installationId: row.installation_id,
    directory: row.directory,
    bindingKind: row.binding_kind === "git_repository" ? "git_repository" : "directory",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
