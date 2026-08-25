import { realpathSync } from "node:fs";
import { appError, err, ok, type AppError, type Result } from "@sorage/core";
import type { NewProject, NewProjectBinding, Project, ProjectBinding, ProjectRepositoryPort } from "@sorage/core";
import type { SorageSqlite } from "./sqlite/connection";

/**
 * The SQLite Project repository behind the core port. The installation identity is
 * read from the single `installation` row so a binding can never claim another
 * installation, and every directory is normalized to its real path before it is
 * stored (PRJ-006).
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
  fs?: ProjectRepositoryFs;
}

export function createSqliteProjectRepository(
  db: SorageSqlite,
  options: SqliteProjectRepositoryOptions = {},
): ProjectRepositoryPort {
  const fs = options.fs ?? nativeFs;
  return {
    createProject(project) {
      try {
        db.prepare(
          "INSERT INTO projects (id, slug, display_name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
        ).run(project.id, project.slug, project.displayName, project.description, project.createdAt, project.createdAt);
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
    findProjectBySlug(slug) {
      try {
        const row = db.prepare("SELECT * FROM projects WHERE slug = ? COLLATE NOCASE").get(slug) as
          | ProjectRow
          | undefined;
        return ok(row === undefined ? null : toProject(row));
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
    addBinding(binding) {
      const directory = fs.realpath(binding.directory);
      try {
        const installationId = installationIdOf(db);
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
            appError("BINDING_DUPLICATE", `the directory '${directory}' is already bound on this installation`, {
              directory,
            }),
          );
        }
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

function installationIdOf(db: SorageSqlite): string {
  const row = db.prepare("SELECT installation_id FROM installation WHERE id = 1").get() as
    | { installation_id: string }
    | undefined;
  if (row === undefined) {
    throw new Error("the installation row is missing; the database was never initialized");
  }
  return row.installation_id;
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
