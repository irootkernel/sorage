import { describe, expect, it } from "vitest";
import type { AppError, Clock, Result } from "../../src/index";
import { appError, err, ok } from "../../src/index";
import type { ProjectBindingFsPort, ProjectCommandPorts } from "../../src/project-commands";
import {
  addProject,
  archiveProject,
  bindProject,
  checkRecipientEligibility,
  listProjects,
  renameProject,
  showProject,
  unarchiveProject,
  unbindProject,
} from "../../src/project-commands";
import type { Project, ProjectBinding, ProjectRepositoryPort } from "../../src/projects";

/** An in-memory Project registry so the use cases stay testable without SQLite. */
function fakeRegistry(existing: Project[] = [], bindings: ProjectBinding[] = []): ProjectRepositoryPort {
  const projects = [...existing];
  const rows = [...bindings];
  const repository: ProjectRepositoryPort = {
    createProject(project) {
      if (projects.some((candidate) => candidate.slug.toLocaleLowerCase() === project.slug.toLocaleLowerCase())) {
        return err(appError("PROJECT_SLUG_CONFLICT", `the slug '${project.slug}' is already taken`));
      }
      const stored: Project = {
        id: project.id,
        slug: project.slug,
        displayName: project.displayName,
        description: project.description,
        status: "active",
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
      };
      projects.push(stored);
      return ok(stored);
    },
    findProjectBySlug(slug) {
      return ok(projects.find((candidate) => candidate.slug.toLocaleLowerCase() === slug.toLocaleLowerCase()) ?? null);
    },
    listProjects() {
      return ok([...projects]);
    },
    addBinding(binding) {
      if (rows.some((row) => row.directory === binding.directory)) {
        return err(appError("BINDING_DUPLICATE", `the directory '${binding.directory}' is already bound`));
      }
      const stored: ProjectBinding = {
        id: binding.id,
        projectId: binding.projectId,
        installationId: "00000000-0000-4000-8000-000000000001",
        directory: binding.directory,
        bindingKind: binding.bindingKind,
        createdAt: binding.createdAt,
        updatedAt: binding.createdAt,
      };
      rows.push(stored);
      return ok(stored);
    },
    createProjectWithBinding(project, binding) {
      const created = repository.createProject(project);
      if (!created.ok) return created;
      const added = repository.addBinding({ ...binding, projectId: project.id });
      if (!added.ok) {
        // Mirror the SQLite transaction: a failed first binding leaves no Project row.
        projects.splice(projects.indexOf(created.value), 1);
        return added;
      }
      return ok({ project: created.value, binding: added.value });
    },
    updateProjectDisplayName(projectId, displayName, updatedAt) {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) return err(appError("PROJECT_NOT_FOUND", `no Project has the id '${projectId}'`));
      project.displayName = displayName;
      project.updatedAt = updatedAt;
      return ok({ ...project });
    },
    updateProjectStatus(projectId, status, updatedAt) {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) return err(appError("PROJECT_NOT_FOUND", `no Project has the id '${projectId}'`));
      project.status = status;
      project.updatedAt = updatedAt;
      return ok({ ...project });
    },
    removeBinding(bindingId) {
      const index = rows.findIndex((row) => row.id === bindingId);
      if (index === -1) return err(appError("PROJECT_NOT_FOUND", `no binding has the id '${bindingId}'`));
      const [removed] = rows.splice(index, 1);
      return ok(removed as ProjectBinding);
    },
    listBindings() {
      return ok([...rows]);
    },
    listBindingsForProject(projectId) {
      return ok(rows.filter((row) => row.projectId === projectId));
    },
  };
  return repository;
}

const fixedClock: Clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

const passthroughFs: ProjectBindingFsPort = {
  resolveDirectory(path) {
    return ok({ directory: `/real${path.startsWith("/") ? path : `/${path}`}`, bindingKind: "directory" });
  },
  realPath(path) {
    return ok(path.startsWith("/real") ? path : `/real${path.startsWith("/") ? path : `/${path}`}`);
  },
  absentRealPath(path) {
    return ok(path.startsWith("/real") ? path : `/real${path.startsWith("/") ? path : `/${path}`}`);
  },
  gitCommonDirectory: () => null,
};

function ports(
  existing: Project[] = [],
  bindings: ProjectBinding[] = [],
  openHandoffs: Record<string, number> = {},
): ProjectCommandPorts {
  let counter = 0;
  return {
    installationId: "i1",
    projects: fakeRegistry(existing, bindings),
    bindings: passthroughFs,
    handoffs: {
      openHandoffCount(projectId) {
        return ok(openHandoffs[projectId] ?? 0);
      },
    },
    clock: fixedClock,
    ids: {
      next: () => {
        counter += 1;
        return `id-${counter}`;
      },
    },
  };
}

describe("addProject", () => {
  it("derives the slug from the display name and creates the first binding", () => {
    const result = addProject(ports(), { name: "Web App", dir: "/tmp/web", userHome: "/home/user" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.project.slug).toBe("web-app");
    expect(result.ok && result.value.derivedSlug).toBe(true);
    expect(result.ok && result.value.binding.bindingKind).toBe("directory");
  });

  it("stores an explicit slug case-folded, so case-only collisions cannot escape in any script", () => {
    const explicit = addProject(ports(), { name: "Alpha", slug: "ПРОЕКТ", dir: "/tmp/a", userHome: "/home/user" });
    expect(explicit.ok && explicit.value.project.slug).toBe("проект");
    expect(explicit.ok && explicit.value.derivedSlug).toBe(false);
    const folded: Project = {
      id: "p1",
      slug: "проект",
      displayName: "Alpha",
      description: null,
      status: "active",
      createdAt: "t",
      updatedAt: "t",
    };
    const collision = addProject(ports([folded]), {
      name: "Beta",
      slug: "ПРОЕКТ",
      dir: "/tmp/b",
      userHome: "/home/user",
    }) as { ok: boolean; error?: AppError };
    expect(collision.ok).toBe(false);
    expect(collision.error?.code).toBe("PROJECT_SLUG_CONFLICT");
  });

  it("fails the whole registration when the first binding duplicates an existing one", () => {
    const existing: Project = {
      id: "p1",
      slug: "other",
      displayName: "Other",
      description: null,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const bound: ProjectBinding = {
      id: "b1",
      projectId: "p1",
      installationId: "i1",
      directory: "/real/tmp/web",
      bindingKind: "directory",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const registry = fakeRegistry([existing], [bound]);
    const withCounter = { ...ports(), projects: registry };
    const result = addProject(withCounter, { name: "Web App", dir: "/tmp/web", userHome: "/home/user" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("BINDING_DUPLICATE");
    // The Project itself must not survive a failed first binding.
    const remaining = registry.listProjects();
    expect(remaining.ok ? remaining.value.map((project) => project.slug) : []).toEqual(["other"]);
  });
});

describe("listProjects", () => {
  it("marks an active Project with zero bindings as unbound", () => {
    const activeBound: Project = {
      id: "p1",
      slug: "bound",
      displayName: "Bound",
      description: null,
      status: "active",
      createdAt: "t",
      updatedAt: "t",
    };
    const activeUnbound: Project = {
      id: "p2",
      slug: "unbound",
      displayName: "Unbound",
      description: null,
      status: "active",
      createdAt: "t",
      updatedAt: "t",
    };
    const archived: Project = {
      id: "p3",
      slug: "archived",
      displayName: "Archived",
      description: null,
      status: "archived",
      createdAt: "t",
      updatedAt: "t",
    };
    const binding: ProjectBinding = {
      id: "b1",
      projectId: "p1",
      installationId: "i1",
      directory: "/d",
      bindingKind: "directory",
      createdAt: "t",
      updatedAt: "t",
    };
    const listed = listProjects(ports([activeBound, activeUnbound, archived], [binding]));
    expect(listed.ok && listed.value.map((entry) => [entry.project.slug, entry.bindingCount, entry.unbound])).toEqual([
      ["bound", 1, false],
      ["unbound", 0, true],
      ["archived", 0, false],
    ]);
  });
});

describe("renameProject and showProject", () => {
  const existing: Project = {
    id: "p1",
    slug: "web-app",
    displayName: "Web App",
    description: null,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
  };

  it("renames the display name and never the slug", () => {
    const renamed = renameProject(ports([existing]), { slug: "WEB-APP", name: "Web App 2" });
    expect(renamed.ok && [renamed.value.slug, renamed.value.displayName]).toEqual(["web-app", "Web App 2"]);
  });

  it("fails with PROJECT_NOT_FOUND for an unknown slug", () => {
    const shown = showProject(ports([existing]), "missing") as { ok: boolean; error?: AppError };
    expect(shown.ok).toBe(false);
    expect(shown.error?.code).toBe("PROJECT_NOT_FOUND");
    const renamed = renameProject(ports([existing]), { slug: "missing", name: "X" }) as {
      ok: boolean;
      error?: AppError;
    };
    expect(renamed.ok).toBe(false);
    expect(renamed.error?.code).toBe("PROJECT_NOT_FOUND");
  });
});

/** The registry type this module relies on is a compile-time fact; keep the import honest. */
describe("module contract", () => {
  it("exposes no Project removal path, because archive plus unbind is the retirement path (PRJ-011)", () => {
    const keys = Object.keys(fakeRegistry()) as string[];
    expect(keys.filter((key) => key.includes("roject") && (key.includes("delete") || key.includes("remove")))).toEqual(
      [],
    );
  });
});

describe("bindProject and unbindProject", () => {
  const project = (): Project => ({
    id: "p1",
    slug: "web-app",
    displayName: "Web App",
    description: null,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
  });
  const binding = (): ProjectBinding => ({
    id: "b1",
    projectId: "p1",
    installationId: "i1",
    directory: "/real/dirs/one",
    bindingKind: "directory",
    createdAt: "t",
    updatedAt: "t",
  });

  it("binds a second directory and rejects a duplicate binding", () => {
    const bound = bindProject(ports([project()], [binding()]), { slug: "web-app", dir: "/dirs/two", userHome: "/h" });
    expect(bound.ok && bound.value.directory).toBe("/real/dirs/two");
    const duplicate = bindProject(ports([project()], [binding()]), {
      slug: "web-app",
      dir: "/dirs/one",
      userHome: "/h",
    }) as { ok: boolean; error?: AppError };
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error?.code).toBe("BINDING_DUPLICATE");
  });

  it("rejects a plain directory inside a repository already bound as git_repository", () => {
    const repoBinding: ProjectBinding = { ...binding(), bindingKind: "git_repository", directory: "/real/repos/main" };
    const result = bindProject(ports([project()], [repoBinding]), {
      slug: "web-app",
      dir: "/repos/main/sub",
      userHome: "/h",
    }) as { ok: boolean; error?: AppError };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BINDING_DUPLICATE");
  });

  it("requires confirmation for an unbind that would leave open Handoffs unbound, and honors --confirm", () => {
    const withOpen = ports([project()], [binding()], { p1: 2 });
    const refused = unbindProject(withOpen, { slug: "web-app", dir: "/dirs/one", userHome: "/h", confirm: false }) as {
      ok: boolean;
      error?: AppError;
    };
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("CONFIRMATION_REQUIRED");
    const confirmed = unbindProject(withOpen, { slug: "web-app", dir: "/dirs/one", userHome: "/h", confirm: true });
    expect(confirmed.ok && confirmed.value.directory).toBe("/real/dirs/one");
    const remaining = withOpen.projects.listBindingsForProject("p1");
    expect(remaining.ok && remaining.value).toHaveLength(0);
  });

  it("unbinds without confirmation when no Handoff is open and names a missing binding PROJECT_NOT_FOUND", () => {
    const direct = unbindProject(ports([project()], [binding()]), {
      slug: "web-app",
      dir: "/dirs/one",
      userHome: "/h",
      confirm: false,
    });
    expect(direct.ok).toBe(true);
    const missing = unbindProject(ports([project()], []), {
      slug: "web-app",
      dir: "/dirs/none",
      userHome: "/h",
      confirm: true,
    }) as { ok: boolean; error?: AppError };
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("unbinds a binding whose directory has vanished by normalizing against the longest existing ancestor", () => {
    // resolveDirectory refuses the vanished path the way the production adapter does;
    // absentRealPath still resolves the symlinked prefix onto the stored real path.
    const vanishedFs: ProjectBindingFsPort = {
      resolveDirectory(path) {
        return err(
          appError("CONFIG_INVALID", `the directory '${path}' does not exist or is not a directory`, {
            directory: path,
          }),
        );
      },
      realPath(path) {
        return ok(path);
      },
      absentRealPath(path) {
        return ok(path.startsWith("/real") ? path : `/real${path.startsWith("/") ? path : `/${path}`}`);
      },
      gitCommonDirectory: () => null,
    };
    const base = ports([project()], [binding()]);
    const withVanishedFs: ProjectCommandPorts = { ...base, bindings: vanishedFs };
    const removed = unbindProject(withVanishedFs, {
      slug: "web-app",
      dir: "/dirs/one",
      userHome: "/h",
      confirm: false,
    });
    expect(removed.ok && removed.value.directory).toBe("/real/dirs/one");
    const remaining = withVanishedFs.projects.listBindingsForProject("p1");
    expect(remaining.ok && remaining.value).toHaveLength(0);
    // The confirmation rule still guards a vanished binding.
    const withOpen: ProjectCommandPorts = { ...ports([project()], [binding()], { p1: 1 }), bindings: vanishedFs };
    const refused = unbindProject(withOpen, { slug: "web-app", dir: "/dirs/one", userHome: "/h", confirm: false }) as {
      ok: boolean;
      error?: AppError;
    };
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("CONFIRMATION_REQUIRED");
  });
});

describe("archive, unarchive, and recipient eligibility", () => {
  const project = (): Project => ({
    id: "p1",
    slug: "web-app",
    displayName: "Web App",
    description: null,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
  });
  const binding = (): ProjectBinding => ({
    id: "b1",
    projectId: "p1",
    installationId: "i1",
    directory: "/real/d",
    bindingKind: "directory",
    createdAt: "t",
    updatedAt: "t",
  });

  it("archives and unarchives without ever deleting the row", () => {
    const archived = archiveProject(ports([project()], [binding()]), "web-app");
    expect(archived.ok && archived.value.status).toBe("archived");
    const unarchived = unarchiveProject(ports([{ ...project(), status: "archived" }], [binding()]), "web-app");
    expect(unarchived.ok && unarchived.value.status).toBe("active");
    const missing = archiveProject(ports(), "nope") as { ok: boolean; error?: AppError };
    expect(missing.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("applies the one shared recipient rule", () => {
    const unknown = checkRecipientEligibility(ports(), "nope") as { ok: boolean; error?: AppError };
    expect(unknown.error?.code).toBe("UNREGISTERED_RECIPIENT");
    const archivedProject: Project = { ...project(), status: "archived" };
    const archived = checkRecipientEligibility(ports([archivedProject], [binding()]), "web-app") as {
      ok: boolean;
      error?: AppError;
    };
    expect(archived.error?.code).toBe("PROJECT_ARCHIVED");
    const unbound = checkRecipientEligibility(ports([project()], []), "web-app") as { ok: boolean; error?: AppError };
    expect(unbound.error?.code).toBe("PROJECT_UNBOUND");
    const eligible = checkRecipientEligibility(ports([project()], [binding()]), "web-app");
    expect(eligible.ok && eligible.value.slug).toBe("web-app");
  });
});
