import { describe, expect, it } from "vitest";
import { ok } from "../../src/index";
import type { ProjectBindingFsPort, ProjectCommandPorts } from "../../src/project-commands";
import type { Project, ProjectBinding, ProjectRepositoryPort } from "../../src/projects";
import { resolveSenderIdentity, workspaceKey } from "../../src/workspace-identity";

const projects: Project[] = [
  {
    id: "p1",
    slug: "bound-repo",
    displayName: "Bound Repo",
    description: null,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
  },
];

const bindings: ProjectBinding[] = [
  // A git_repository binding whose stored directory is the common dir; workspace root /work/main.
  {
    id: "b1",
    projectId: "p1",
    installationId: "i1",
    directory: "/work/main/.git",
    bindingKind: "git_repository",
    createdAt: "t",
    updatedAt: "t",
  },
];

const repository: ProjectRepositoryPort = {
  createProject: () => {
    throw new Error("unused");
  },
  findProjectBySlug: (slug) => ok(projects.find((project) => project.slug === slug) ?? null),
  listProjects: () => ok(projects),
  addBinding: () => {
    throw new Error("unused");
  },
  createProjectWithBinding: () => {
    throw new Error("unused");
  },
  updateProjectDisplayName: () => {
    throw new Error("unused");
  },
  updateProjectStatus: () => {
    throw new Error("unused");
  },
  removeBinding: () => {
    throw new Error("unused");
  },
  listBindings: () => ok(bindings),
  listBindingsForProject: (projectId) => ok(bindings.filter((binding) => binding.projectId === projectId)),
};

function ports(git: Record<string, string>): ProjectCommandPorts {
  const fs: ProjectBindingFsPort = {
    resolveDirectory: () => {
      throw new Error("unused");
    },
    absentRealPath: () => {
      throw new Error("unused");
    },
    realPath: (path) => ok(path),
    gitCommonDirectory: (path) => git[path] ?? null,
  };
  return {
    installationId: "i1",
    projects: repository,
    bindings: fs,
    handoffs: { openHandoffCount: () => ok(0) },
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    ids: { next: () => "id" },
  };
}

const base = { userHome: "/h", installationId: "i1", allowUnregistered: false };

describe("workspaceKey", () => {
  it("is stable per path and Installation and differs across Installations", () => {
    expect(workspaceKey("i1", "/work")).toBe(workspaceKey("i1", "/work"));
    expect(workspaceKey("i1", "/work")).not.toBe(workspaceKey("i2", "/work"));
    expect(workspaceKey("i1", "/work")).not.toBe(workspaceKey("i1", "/other"));
  });
});

describe("resolveSenderIdentity", () => {
  it("resolves a worktree of a bound repository without ever downgrading", () => {
    const result = resolveSenderIdentity(ports({ "/work/wt": "/work/main/.git" }), { ...base, path: "/work/wt" });
    expect(result.ok && result.value.kind === "registered_project" && result.value.project.slug).toBe("bound-repo");
  });

  it("fails from an ancestor of a workspace root with SENDER_IDENTITY_DOWNGRADE unless allowed", () => {
    const refused = resolveSenderIdentity(ports({}), { ...base, path: "/work" }) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("SENDER_IDENTITY_DOWNGRADE");
    const allowed = resolveSenderIdentity(ports({}), { ...base, path: "/work", allowUnregistered: true });
    expect(allowed.ok && allowed.value.kind === "unregistered_workspace" && allowed.value.workspaceKey).toBe(
      workspaceKey("i1", "/work"),
    );
    expect(allowed.ok && allowed.value.kind === "unregistered_workspace" && allowed.value.pathSnapshot).toBe("/work");
  });

  it("fails from a nested independent repository inside a bound tree, whose common directory matches no binding", () => {
    const result = resolveSenderIdentity(ports({ "/work/main/inner/.git": "/work/main/inner/.git" }), {
      ...base,
      path: "/work/main/inner",
    }) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("SENDER_IDENTITY_DOWNGRADE");
  });

  it("gives a later-bound directory Project authority at resolution level while the snapshot fields belong to EPIC-005", () => {
    bindings.push({
      id: "b2",
      projectId: "p1",
      installationId: "i1",
      directory: "/work/independent",
      bindingKind: "directory",
      createdAt: "t",
      updatedAt: "t",
    });
    const result = resolveSenderIdentity(ports({}), { ...base, path: "/work/independent" });
    expect(result.ok && result.value.kind === "registered_project" && result.value.project.slug).toBe("bound-repo");
  });
});
