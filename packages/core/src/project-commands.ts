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
}

export interface ProjectCommandPorts {
  projects: ProjectRepositoryPort;
  bindings: ProjectBindingFsPort;
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
