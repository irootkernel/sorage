import type { AppError, Result } from "./errors";
import type { ActorRef } from "./events";

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
 * uniqueness constraint is `UNIQUE(installationId, directory)` (PRJ-016). Every
 * mutation carries the actor whose Project lifecycle event is appended in the same
 * transaction (SEC-012).
 */
export interface ProjectRepositoryPort {
  /** Fails with `PROJECT_SLUG_CONFLICT` when the slug collides case-insensitively (PRJ-005). */
  createProject(project: NewProject, actor: ActorRef): Result<Project, AppError>;
  findProjectBySlug(slug: string): Result<Project | null, AppError>;
  listProjects(): Result<Project[], AppError>;
  /** Fails with `BINDING_DUPLICATE` when the directory is already bound on this installation (PRJ-016). */
  addBinding(binding: NewProjectBinding, actor: ActorRef): Result<ProjectBinding, AppError>;
  /**
   * Registers a Project and its first binding in one transaction, so a duplicate
   * binding leaves no orphan Project row behind (PRJ-003, PRJ-016).
   */
  createProjectWithBinding(
    project: NewProject,
    binding: NewProjectBinding,
    actor: ActorRef,
  ): Result<{ project: Project; binding: ProjectBinding }, AppError>;
  /** Renames the display name only; the slug is identity and never changes (PRJ-001). */
  updateProjectDisplayName(
    projectId: string,
    displayName: string,
    updatedAt: string,
    actor: ActorRef,
  ): Result<Project, AppError>;
  /** Moves the lifecycle status between `active` and `archived`; rows are never deleted. */
  updateProjectStatus(
    projectId: string,
    status: ProjectStatus,
    updatedAt: string,
    actor: ActorRef,
  ): Result<Project, AppError>;
  /** Removes one binding; a Project with zero bindings remains, derived unbound (PRJ-010, PRJ-022). */
  removeBinding(bindingId: string, actor: ActorRef): Result<ProjectBinding, AppError>;
  /** Replaces one binding in place, preserving its id and Project identity. */
  replaceBinding(
    bindingId: string,
    expectedDirectory: string,
    replacement: { directory: string; bindingKind: BindingKind; physicalPath: string; updatedAt: string },
    actor: ActorRef,
  ): Result<ProjectBinding, AppError>;
  listBindings(): Result<ProjectBinding[], AppError>;
  listBindingsForProject(projectId: string): Result<ProjectBinding[], AppError>;
}
