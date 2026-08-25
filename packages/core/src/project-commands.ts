import { type AppError, appError, err, ok, type Result } from "./errors";
import type { Clock, IdGenerator } from "./ids";
import type { BindingKind, Project, ProjectBinding, ProjectRepositoryPort } from "./projects";

/**
 * The application layer behind the `sorage project` commands of section 8 of
 * interfaces-and-operations.md. A Project referenced by Handoffs is never physically
 * deleted (PRJ-011): this module exposes no removal path at all, because archive plus
 * unbind is the complete retirement path.
 */

/** The filesystem facts a directory binding needs: normalization plus git detection. */
export interface ProjectBindingFsPort {
  /**
   * Applies the section 8 path rules to one `--dir` value: expand `~`, make absolute,
   * resolve symlinks, require an existing directory, and fold a directory inside a git
   * working tree onto its git common directory with `bindingKind = git_repository`
   * (PRJ-006, PRJ-017).
   */
  resolveDirectory(path: string, userHome: string): Result<{ directory: string; bindingKind: BindingKind }, AppError>;
  /** The normalized real path of any candidate path: ~ expansion, absolutization, symlink resolution. */
  realPath(path: string, userHome: string): Result<string, AppError>;
  /** The git common directory when the path is inside a working tree, otherwise null (PRJ-017). */
  gitCommonDirectory(path: string): string | null;
}

/** The Handoff facts the Project commands need; the handoffs table itself arrives with EPIC-005. */
export interface ProjectHandoffStatsPort {
  /** An open Handoff is one in `awaiting_recipient` or `changes_requested` that is not deleted (PRJ-022). */
  openHandoffCount(projectId: string): Result<number, AppError>;
}

export interface ProjectCommandPorts {
  projects: ProjectRepositoryPort;
  bindings: ProjectBindingFsPort;
  handoffs: ProjectHandoffStatsPort;
  clock: Clock;
  ids: IdGenerator;
}

export interface AddProjectInput {
  name: string;
  slug?: string | undefined;
  dir: string;
  userHome: string;
}

export interface AddProjectOutcome {
  project: Project;
  binding: ProjectBinding;
  derivedSlug: boolean;
}

export interface ListedProject {
  project: Project;
  bindingCount: number;
  /** An `active` Project with zero bindings is derived unbound, never a status value (PRJ-022). */
  unbound: boolean;
}

export interface ShownProject {
  project: Project;
  bindings: ProjectBinding[];
}

/**
 * Derives a slug from a display name in any script (PRJ-003): case-folded, runs of
 * non-alphanumerics collapsed to one hyphen, hyphens trimmed. Unicode letters and
 * digits survive, so a name in any script derives a usable slug without inventing a
 * transliteration.
 */
export function deriveProjectSlug(name: string): string {
  const folded = name.trim().toLocaleLowerCase();
  const slug = folded
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug;
}

/** An explicit slug must have the same shape a derived one would: non-empty, no separators. */
export function validateProjectSlug(slug: string): Result<string, AppError> {
  if (slug === "" || slug.startsWith("-") || slug.endsWith("-") || /[^\p{L}\p{N}-]/u.test(slug)) {
    return err(
      appError("CONFIG_INVALID", `the slug '${slug}' is not a valid slug`, {
        expected: "non-empty, letters and digits of any script with single hyphen separators",
      }),
    );
  }
  return ok(slug);
}

export function addProject(ports: ProjectCommandPorts, input: AddProjectInput): Result<AddProjectOutcome, AppError> {
  const name = input.name.trim();
  if (name === "") {
    return err(appError("CONFIG_INVALID", "the project name must not be empty"));
  }
  let slug = deriveProjectSlug(name);
  let derivedSlug = true;
  if (input.slug !== undefined) {
    const explicit = validateProjectSlug(input.slug);
    if (!explicit.ok) return explicit;
    slug = explicit.value;
    derivedSlug = false;
  }
  if (slug === "") {
    return err(appError("CONFIG_INVALID", "the display name derives an empty slug; pass an explicit --slug", { name }));
  }
  const directory = ports.bindings.resolveDirectory(input.dir, input.userHome);
  if (!directory.ok) return directory;
  const now = ports.clock.now().toISOString();
  const projectId = ports.ids.next();
  // One transaction, so a duplicate first binding cannot strand an orphan Project.
  const registered = ports.projects.createProjectWithBinding(
    { id: projectId, slug, displayName: name, description: null, createdAt: now },
    {
      id: ports.ids.next(),
      projectId,
      directory: directory.value.directory,
      bindingKind: directory.value.bindingKind,
      createdAt: now,
    },
  );
  if (!registered.ok) return registered;
  return ok({ project: registered.value.project, binding: registered.value.binding, derivedSlug });
}

export function listProjects(ports: ProjectCommandPorts): Result<ListedProject[], AppError> {
  const projects = ports.projects.listProjects();
  if (!projects.ok) return projects;
  const bindings = ports.projects.listBindings();
  if (!bindings.ok) return bindings;
  return ok(
    projects.value.map((project) => {
      const bindingCount = bindings.value.filter((binding) => binding.projectId === project.id).length;
      return { project, bindingCount, unbound: project.status === "active" && bindingCount === 0 };
    }),
  );
}

export function showProject(ports: ProjectCommandPorts, slug: string): Result<ShownProject, AppError> {
  const project = ports.projects.findProjectBySlug(slug);
  if (!project.ok) return project;
  if (project.value === null) {
    return err(appError("PROJECT_NOT_FOUND", `no Project matches the slug '${slug}'`, { slug }));
  }
  const bindings = ports.projects.listBindingsForProject(project.value.id);
  if (!bindings.ok) return bindings;
  return ok({ project: project.value, bindings: bindings.value });
}

export function renameProject(
  ports: ProjectCommandPorts,
  input: { slug: string; name: string },
): Result<Project, AppError> {
  const name = input.name.trim();
  if (name === "") {
    return err(appError("CONFIG_INVALID", "the project name must not be empty"));
  }
  const existing = ports.projects.findProjectBySlug(input.slug);
  if (!existing.ok) return existing;
  if (existing.value === null) {
    return err(appError("PROJECT_NOT_FOUND", `no Project matches the slug '${input.slug}'`, { slug: input.slug }));
  }
  // The slug is identity and is never renamed (PRJ-001); only the display name moves.
  return ports.projects.updateProjectDisplayName(existing.value.id, name, ports.clock.now().toISOString());
}

function projectBySlug(projects: ProjectRepositoryPort, slug: string): Result<Project, AppError> {
  const found = projects.findProjectBySlug(slug);
  if (!found.ok) return found;
  if (found.value === null) {
    return err(appError("PROJECT_NOT_FOUND", `no Project matches the slug '${slug}'`, { slug }));
  }
  return ok(found.value);
}

/** True when `candidate` is `directory` itself or any path beneath it. */
function isAtOrBelow(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

export interface BindProjectInput {
  slug: string;
  dir: string;
  userHome: string;
}

export function bindProject(ports: ProjectCommandPorts, input: BindProjectInput): Result<ProjectBinding, AppError> {
  const project = projectBySlug(ports.projects, input.slug);
  if (!project.ok) return project;
  const directory = ports.bindings.resolveDirectory(input.dir, input.userHome);
  if (!directory.ok) return directory;
  // A directory inside a repository already bound as git_repository would create a
  // second identity for that repository, so it is a duplicate even though the stored
  // directories differ (PRJ-016).
  const bindings = ports.projects.listBindings();
  if (!bindings.ok) return bindings;
  if (directory.value.bindingKind === "directory") {
    for (const binding of bindings.value) {
      if (binding.bindingKind === "git_repository" && isAtOrBelow(directory.value.directory, binding.directory)) {
        return err(
          appError(
            "BINDING_DUPLICATE",
            `the directory '${directory.value.directory}' lies inside the repository already bound at '${binding.directory}'`,
            {
              directory: directory.value.directory,
              existing: binding.directory,
            },
          ),
        );
      }
    }
  }
  return ports.projects.addBinding({
    id: ports.ids.next(),
    projectId: project.value.id,
    directory: directory.value.directory,
    bindingKind: directory.value.bindingKind,
    createdAt: ports.clock.now().toISOString(),
  });
}

export interface UnbindProjectInput {
  slug: string;
  dir: string;
  userHome: string;
  confirm: boolean;
}

export function unbindProject(ports: ProjectCommandPorts, input: UnbindProjectInput): Result<ProjectBinding, AppError> {
  const project = projectBySlug(ports.projects, input.slug);
  if (!project.ok) return project;
  const directory = ports.bindings.resolveDirectory(input.dir, input.userHome);
  if (!directory.ok) return directory;
  const bindings = ports.projects.listBindingsForProject(project.value.id);
  if (!bindings.ok) return bindings;
  const binding = bindings.value.find((row) => row.directory === directory.value.directory);
  if (binding === undefined) {
    return err(
      appError("PROJECT_NOT_FOUND", `the Project '${input.slug}' has no binding on '${directory.value.directory}'`, {
        slug: input.slug,
        directory: directory.value.directory,
      }),
    );
  }
  // Removing the last reachable identity of Handoffs still in flight is a confirmed
  // step, never a silent one (PRJ-022).
  const open = ports.handoffs.openHandoffCount(project.value.id);
  if (!open.ok) return open;
  if (open.value > 0 && !input.confirm) {
    return err(
      appError(
        "CONFIRMATION_REQUIRED",
        `the Project '${input.slug}' still has ${open.value} open Handoff(s); pass --confirm to unbind anyway`,
        {
          slug: input.slug,
          openHandoffs: open.value,
        },
      ),
    );
  }
  return ports.projects.removeBinding(binding.id);
}

export function archiveProject(ports: ProjectCommandPorts, slug: string): Result<Project, AppError> {
  const project = projectBySlug(ports.projects, slug);
  if (!project.ok) return project;
  if (project.value.status === "archived") return ok(project.value);
  return ports.projects.updateProjectStatus(project.value.id, "archived", ports.clock.now().toISOString());
}

export function unarchiveProject(ports: ProjectCommandPorts, slug: string): Result<Project, AppError> {
  const project = projectBySlug(ports.projects, slug);
  if (!project.ok) return project;
  if (project.value.status === "active") return ok(project.value);
  return ports.projects.updateProjectStatus(project.value.id, "active", ports.clock.now().toISOString());
}

/**
 * The one shared recipient rule (PRJ-012, PRJ-021, PRJ-022): a recipient must be an
 * existing, active, bound Project. Every creation path — CLI `send`, HTTP, Web —
 * evaluates this rule before anything is staged or written.
 */
export function checkRecipientEligibility(ports: ProjectCommandPorts, slug: string): Result<Project, AppError> {
  const found = ports.projects.findProjectBySlug(slug);
  if (!found.ok) return found;
  if (found.value === null) {
    return err(appError("UNREGISTERED_RECIPIENT", `no registered Project matches '${slug}'`, { slug }));
  }
  if (found.value.status === "archived") {
    // The existing inbox keeps working; only new incoming Handoffs are refused (PRJ-021).
    return err(
      appError("PROJECT_ARCHIVED", `the Project '${slug}' is archived and receives no new Handoffs`, { slug }),
    );
  }
  const bindings = ports.projects.listBindingsForProject(found.value.id);
  if (!bindings.ok) return bindings;
  if (bindings.value.length === 0) {
    return err(appError("PROJECT_UNBOUND", `the Project '${slug}' has no binding on this installation`, { slug }));
  }
  return ok(found.value);
}

/** The workspace root a binding claims on disk: the stored directory, or the main working tree for a repository binding. */
export function workspaceRootOf(binding: ProjectBinding): string {
  if (binding.bindingKind === "directory") return binding.directory;
  // The stored directory is the git common directory; the main working tree is its parent.
  const parent = binding.directory.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return parent === "" ? "/" : parent;
}

export type ResolvedActor =
  | { kind: "registered_project"; project: Project; binding: ProjectBinding }
  | { kind: "unregistered_workspace"; directory: string };

export interface ResolveWorkspaceInput {
  path: string;
  userHome: string;
  as?: string | undefined;
}

/**
 * The actor resolution of section 22.2, a pure function of the normalized path and the
 * binding set: git common-directory folding, longest-prefix deepest match, git_repository
 * precedence, the same-kind same-depth ambiguity, and the `--as` override (PRJ-006 to
 * PRJ-008, PRJ-017, PRJ-018).
 */
export function resolveWorkspaceActor(
  ports: ProjectCommandPorts,
  input: ResolveWorkspaceInput,
): Result<ResolvedActor, AppError> {
  if (input.as !== undefined) {
    const found = ports.projects.findProjectBySlug(input.as);
    if (!found.ok) return found;
    if (found.value === null) {
      return err(appError("PROJECT_NOT_FOUND", `no Project matches the slug '${input.as}'`, { slug: input.as }));
    }
    const bindings = ports.projects.listBindingsForProject(found.value.id);
    if (!bindings.ok) return bindings;
    if (bindings.value.length === 0) {
      return err(
        appError("PROJECT_UNBOUND", `the Project '${input.as}' has no binding on this installation`, {
          slug: input.as,
        }),
      );
    }
    return ok({ kind: "registered_project", project: found.value, binding: bindings.value[0] as ProjectBinding });
  }
  const real = ports.bindings.realPath(input.path, input.userHome);
  if (!real.ok) return real;
  const bindings = ports.projects.listBindings();
  if (!bindings.ok) return bindings;
  const common = ports.bindings.gitCommonDirectory(real.value);
  const registered = new Map<string, Project>();
  const projects = ports.projects.listProjects();
  if (!projects.ok) return projects;
  for (const project of projects.value) registered.set(project.id, project);

  if (common !== null) {
    // Step 5: a repository binding outranks every directory binding, whatever the depths.
    const gitMatches = bindings.value.filter(
      (binding) => binding.bindingKind === "git_repository" && binding.directory === common,
    );
    if (gitMatches.length === 1) {
      const binding = gitMatches[0] as ProjectBinding;
      const project = registered.get(binding.projectId);
      if (project !== undefined) return ok({ kind: "registered_project", project, binding });
    }
    if (gitMatches.length > 1) {
      return err(ambiguity(gitMatches, registered));
    }
  }

  // Step 4: the deepest directory binding wins; a same-depth tie is ambiguous (step 6).
  const directoryMatches = bindings.value.filter(
    (binding) => binding.bindingKind === "directory" && isAtOrBelow(real.value, binding.directory),
  );
  if (directoryMatches.length > 0) {
    const deepest = Math.max(...directoryMatches.map((binding) => depthOf(binding.directory)));
    const best = directoryMatches.filter((binding) => depthOf(binding.directory) === deepest);
    if (best.length === 1) {
      const binding = best[0] as ProjectBinding;
      const project = registered.get(binding.projectId);
      if (project !== undefined) return ok({ kind: "registered_project", project, binding });
    } else {
      return err(ambiguity(best, registered));
    }
  }

  return ok({ kind: "unregistered_workspace", directory: real.value });
}

function depthOf(directory: string): number {
  return directory
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => segment !== "").length;
}

function ambiguity(bindings: ProjectBinding[], registered: Map<string, Project>): AppError {
  const slugs = bindings.map((binding) => registered.get(binding.projectId)?.slug ?? binding.projectId).sort();
  return appError("AMBIGUOUS_PROJECT", `two bindings match at the same depth: ${slugs.join(" and ")}`, {
    projects: slugs,
  });
}
