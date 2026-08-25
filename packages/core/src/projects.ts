import type { AppError, Result } from "./errors";

/**
 * The Project registry model of section 3.1 and 3.2 of domain-and-architecture.md.
 * Registrations and bindings live in SQLite, never in `config.yaml` (CFG-017), so the
 * port behind them is a repository, not a configuration reader.
 */

export type ProjectStatus = "active" | "archived";

export type BindingKind = "git_repository" | "directory";

export interface Project {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBinding {
  id: string;
  projectId: string;
  installationId: string;
  /** The normalized real path itself, or the git common directory for a `git_repository` binding. */
  directory: string;
  bindingKind: BindingKind;
  createdAt: string;
  updatedAt: string;
}

export interface NewProject {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  createdAt: string;
}

export interface NewProjectBinding {
  id: string;
  projectId: string;
  /** Stored as the normalized real path; the repository never persists the caller's raw spelling. */
  directory: string;
  bindingKind: BindingKind;
  createdAt: string;
}

/**
 * The persistence port for the Project registry. `installationId` comes from the
 * installation the database belongs to, never from the caller, because the sole
 * uniqueness constraint is `UNIQUE(installationId, directory)` (PRJ-016).
 */
export interface ProjectRepositoryPort {
  /** Fails with `PROJECT_SLUG_CONFLICT` when the slug collides case-insensitively (PRJ-005). */
  createProject(project: NewProject): Result<Project, AppError>;
  findProjectBySlug(slug: string): Result<Project | null, AppError>;
  listProjects(): Result<Project[], AppError>;
  /** Fails with `BINDING_DUPLICATE` when the directory is already bound on this installation (PRJ-016). */
  addBinding(binding: NewProjectBinding): Result<ProjectBinding, AppError>;
  listBindings(): Result<ProjectBinding[], AppError>;
  listBindingsForProject(projectId: string): Result<ProjectBinding[], AppError>;
}
