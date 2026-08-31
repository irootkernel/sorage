import { describe, expect, it } from "vitest";
import { ok } from "../../src/index";
import type { ProjectBindingFsPort, ProjectCommandPorts } from "../../src/project-commands";
import { resolveWorkspaceActor, workspaceRootOf } from "../../src/project-commands";
import type { Project, ProjectBinding, ProjectRepositoryPort } from "../../src/projects";

/**
 * Section 22.2 resolution over an in-memory binding set: the algorithm is a pure
 * function of the normalized path and the bindings, so the ordering rules are proved
 * here without touching the filesystem or git.
 */

function fakeRegistry(projects: Project[], bindings: ProjectBinding[]): ProjectRepositoryPort {
  return {
    createProject: () => {
      throw new Error("not used by resolution");
    },
    findProjectBySlug(slug) {
      return ok(projects.find((project) => project.slug === slug.toLowerCase()) ?? null);
    },
    listProjects() {
      return ok(projects);
    },
    addBinding: () => {
      throw new Error("not used by resolution");
    },
    createProjectWithBinding: () => {
      throw new Error("not used by resolution");
    },
    updateProjectDisplayName: () => {
      throw new Error("not used by resolution");
    },
    updateProjectStatus: () => {
      throw new Error("not used by resolution");
    },
    removeBinding: () => {
      throw new Error("not used by resolution");
    },
    listBindings() {
      return ok(bindings);
    },
    listBindingsForProject(projectId) {
      return ok(bindings.filter((binding) => binding.projectId === projectId));
    },
  };
}

function ports(
  bindings: ProjectBinding[],
  projects: Project[],
  git: Record<string, string>,
  identity: Record<string, string> = {},
): ProjectCommandPorts {
  const identityUses = new Map<string, number>();
  const fs: ProjectBindingFsPort = {
    resolveDirectory: () => {
      throw new Error("not used by resolution");
    },
    absentRealPath: () => {
      throw new Error("not used by resolution");
    },
    physicalIdentity(directory) {
      // Keyed with an optional "/index" suffix so several bindings sharing one
      // stored spelling can still answer with distinct dev:ino values.
      const ordinal = identityUses.get(directory) ?? 0;
      identityUses.set(directory, ordinal + 1);
      const value = identity[`${directory}#${ordinal}`] ?? identity[directory] ?? null;
      return value === undefined || value === null ? (identity[directory] ?? null) : value;
    },
    realPath(path) {
      return ok(path);
    },
    gitCommonDirectory(path) {
      return git[path] ?? null;
    },
  };
  return {
    installationId: "i1",
    projects: fakeRegistry(projects, bindings),
    bindings: fs,
    handoffs: { openHandoffCount: () => ok(0) },
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    ids: { next: () => "id" },
  };
}

function project(id: string, slug: string): Project {
  return { id, slug, displayName: slug, description: null, status: "active", createdAt: "t", updatedAt: "t" };
}

function binding(
  projectId: string,
  directory: string,
  bindingKind: "directory" | "git_repository" = "directory",
): ProjectBinding {
  return {
    id: `b-${projectId}-${directory}`,
    projectId,
    installationId: "i1",
    directory,
    bindingKind,
    createdAt: "t",
    updatedAt: "t",
  };
}

const projects = [project("p1", "alpha"), project("p2", "beta"), project("p3", "gamma")];

describe("resolveWorkspaceActor", () => {
  it("folds a path inside a git working tree onto the git common directory binding", () => {
    const result = resolveWorkspaceActor(
      ports([binding("p1", "/repos/main/.git", "git_repository")], projects, { "/worktrees/wt": "/repos/main/.git" }),
      {
        path: "/worktrees/wt",
        userHome: "/h",
      },
    );
    expect(result.ok && result.ok && result.value.kind === "registered_project" && result.value.project.slug).toBe(
      "alpha",
    );
  });

  it("returns the deepest match inside nested directory bindings", () => {
    const bindings = [binding("p1", "/work"), binding("p2", "/work/inner")];
    const shallow = resolveWorkspaceActor(ports(bindings, projects, {}), { path: "/work", userHome: "/h" });
    expect(shallow.ok && shallow.value.kind === "registered_project" && shallow.value.project.slug).toBe("alpha");
    const deep = resolveWorkspaceActor(ports(bindings, projects, {}), { path: "/work/inner/file", userHome: "/h" });
    expect(deep.ok && deep.value.kind === "registered_project" && deep.value.project.slug).toBe("beta");
  });

  it("prefers a git_repository binding over a directory binding at the same path", () => {
    const bindings = [binding("p1", "/repos/main"), binding("p2", "/repos/main/.git", "git_repository")];
    const result = resolveWorkspaceActor(ports(bindings, projects, { "/repos/main/sub": "/repos/main/.git" }), {
      path: "/repos/main/sub",
      userHome: "/h",
    });
    expect(result.ok && result.value.kind === "registered_project" && result.value.project.slug).toBe("beta");
  });

  it("fails a same-kind same-depth tie with AMBIGUOUS_PROJECT naming both Projects", () => {
    // On disk this needs a realpath-uncollapsed alias, so the two stored directories are
    // the same physical dir under two spellings; the in-memory set models that directly.
    const bindings = [binding("p1", "/alias/one"), binding("p2", "/alias/one")];
    const result = resolveWorkspaceActor(ports(bindings, projects, {}), { path: "/alias/one/x", userHome: "/h" }) as {
      ok: boolean;
      error?: { code: string; details?: { projects?: string[] } };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("AMBIGUOUS_PROJECT");
    expect(result.error?.code === "AMBIGUOUS_PROJECT" && result.error.details?.projects).toEqual(["alpha", "beta"]);
  });

  it("applies the as-override with both failure modes", () => {
    const bindings = [binding("p1", "/work")];
    const unknown = resolveWorkspaceActor(ports(bindings, projects, {}), {
      path: "/anywhere",
      userHome: "/h",
      as: "missing",
    }) as { ok: boolean; error?: { code: string } };
    expect(unknown.error?.code).toBe("PROJECT_NOT_FOUND");
    const unbound = resolveWorkspaceActor(ports(bindings, projects, {}), {
      path: "/anywhere",
      userHome: "/h",
      as: "gamma",
    }) as { ok: boolean; error?: { code: string } };
    expect(unbound.error?.code).toBe("PROJECT_UNBOUND");
    const override = resolveWorkspaceActor(ports(bindings, projects, {}), {
      path: "/anywhere",
      userHome: "/h",
      as: "ALPHA",
    });
    expect(override.ok && override.value.kind === "registered_project" && override.value.project.slug).toBe("alpha");
  });

  it("resolves a same-depth tie whose bindings are physically one directory under one Project", () => {
    // TASK-066: the physical probe answers, and both bindings collapse onto one
    // Project, so the tie is a spelling overlap rather than an ownership fight.
    // A same-depth tie needs both directories to match the query path, which
    // only a shared stored spelling models in memory; give that spelling an
    // identity so the probe can answer for it.
    const shared = ports(
      [binding("p1", "/shared/a"), binding("p1", "/shared/a")],
      projects,
      {},
      { "/shared/a": "17:7" },
    );
    const result = resolveWorkspaceActor(shared, { path: "/shared/a/file", userHome: "/h" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("registered_project");
  });

  it("keeps the tie ambiguous when the probe answers two Projects for one physical directory", () => {
    const aliased = ports(
      [binding("p1", "/shared/a"), binding("p2", "/shared/a")],
      projects,
      {},
      { "/shared/a": "17:4242" },
    );
    const result = resolveWorkspaceActor(aliased, { path: "/shared/a/file", userHome: "/h" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AMBIGUOUS_PROJECT");
    expect(result.error.message).toContain("alpha");
    expect(result.error.message).toContain("beta");
    expect(result.error.details).toMatchObject({ projects: ["alpha", "beta"] });
  });

  it("keeps the tie ambiguous when the probe reports distinct physical directories", () => {
    // The same stored spelling answering twice with distinct dev:ino values is
    // impossible through the command surface; the resolver must still fail
    // safe rather than silently pick a winner when it happens through restored
    // or directly edited data.
    const distinct = ports(
      [binding("p1", "/shared/a"), binding("p2", "/shared/a")],
      projects,
      {},
      { "/shared/a#0": "17:1", "/shared/a#1": "17:2" },
    );
    const result = resolveWorkspaceActor(distinct, { path: "/shared/a/file", userHome: "/h" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AMBIGUOUS_PROJECT");
  });

  it("selects the code-point-first binding for a multi-bound Project under --as", () => {
    const multi = ports([binding("p1", "/work/b"), binding("p1", "/work/a")], projects, {});
    const first = resolveWorkspaceActor(multi, { path: "/unrelated", userHome: "/h", as: "alpha" });
    expect(first.ok && first.value.kind === "registered_project" && first.value.binding.directory).toBe("/work/a");
    // An astral-plane name sorts after every BMP name by code point, where a
    // UTF-16 comparator would compare surrogate halves against BMP characters.
    const astral = ports([binding("p1", "/work/\u{1F980}"), binding("p1", "/work/\uFFFD")], projects, {});
    const chosen = resolveWorkspaceActor(astral, { path: "/unrelated", userHome: "/h", as: "alpha" });
    expect(chosen.ok && chosen.value.kind === "registered_project" && chosen.value.binding.directory).toBe(
      "/work/\uFFFD",
    );
  });

  it("reports an unregistered workspace when no binding matches", () => {
    const result = resolveWorkspaceActor(ports([binding("p1", "/work")], projects, {}), {
      path: "/elsewhere",
      userHome: "/h",
    });
    expect(result.ok && result.value.kind === "unregistered_workspace" && result.value.directory).toBe("/elsewhere");
  });
});

describe("workspaceRootOf", () => {
  it("uses the stored directory for directory bindings and the main working tree for repository bindings", () => {
    expect(workspaceRootOf(binding("p1", "/work"))).toBe("/work");
    expect(workspaceRootOf(binding("p1", "/repos/main/.git", "git_repository"))).toBe("/repos/main");
  });
});
