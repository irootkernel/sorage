import { describe, expect, it } from "vitest";
import type { AppError, Clock, Result } from "../../src/index";
import { appError, err, ok } from "../../src/index";
import type { ProjectBindingFsPort, ProjectCommandPorts } from "../../src/project-commands";
import { addProject, listProjects, renameProject, showProject } from "../../src/project-commands";
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
};

function ports(existing: Project[] = [], bindings: ProjectBinding[] = []): ProjectCommandPorts {
  let counter = 0;
  return {
    projects: fakeRegistry(existing, bindings),
    bindings: passthroughFs,
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
    const keys = Object.keys(fakeRegistry()) as Array<keyof ProjectRepositoryPort>;
    expect(keys.filter((key) => key.toLowerCase().includes("delete") || key.toLowerCase().includes("remove"))).toEqual(
      [],
    );
  });
});
