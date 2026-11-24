import { describe, expect, it } from "vitest";
import { ok } from "../../src/index";
import type { ProjectBindingFsPort, ProjectCommandPorts } from "../../src/project/project-commands";
import type { Project, ProjectBinding, ProjectRepositoryPort } from "../../src/project/projects";
import { workspaceKey } from "../../src/primitives/identity";
import {
  type CommitSenderBindingFact,
  resolveSenderIdentity,
  revalidateSenderAtCommit,
} from "../../src/project/workspace-identity";

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
  replaceBinding: () => {
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
    physicalIdentity: () => null,
    gitCommonDirectory: (path) => git[path] ?? null,
  };
  return {
    installationId: "i1",
    vaultPath: "/vault",
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

describe("revalidateSenderAtCommit", () => {
  const activeDir: CommitSenderBindingFact = {
    id: "b-dir",
    projectId: "p-active",
    directory: "/work/alpha",
    bindingKind: "directory",
    slug: "alpha",
    status: "active",
  };
  const archivedDir: CommitSenderBindingFact = {
    id: "b-arch",
    projectId: "p-archived",
    directory: "/work/alpha/nested",
    bindingKind: "directory",
    slug: "archived-proj",
    status: "archived",
  };
  const activeGit: CommitSenderBindingFact = {
    id: "b-git",
    projectId: "p-git",
    directory: "/repos/app/.git",
    bindingKind: "git_repository",
    slug: "git-app",
    status: "active",
  };

  it("refuses PROJECT_UNBOUND with no details when an --as override Project lost its last binding", () => {
    const result = revalidateSenderAtCommit([activeDir], {
      registeredSender: { projectId: "p-missing", asOverride: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROJECT_UNBOUND");
      expect(result.error.message).toBe("the sender Project lost its last binding while the Handoff was prepared");
      expect(result.error.details).toBeUndefined();
    }
  });

  it("allows an --as override when any binding for that Project remains", () => {
    const result = revalidateSenderAtCommit([activeDir], {
      registeredSender: { projectId: "p-active", asOverride: true },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses PROJECT_ARCHIVED and SENDER_IDENTITY_DOWNGRADE when a registered sender path changes owner", () => {
    const archived = revalidateSenderAtCommit([activeDir, archivedDir], {
      registeredSender: {
        projectId: "p-active",
        asOverride: false,
        bindingId: "b-dir",
        directory: "/work/alpha/nested/sub",
        gitCommonDirectory: null,
      },
    });
    expect(archived.ok).toBe(false);
    if (!archived.ok) {
      expect(archived.error.code).toBe("PROJECT_ARCHIVED");
      expect(archived.error.message).toBe(
        "the sender path changed to an archived Project while the Handoff was prepared",
      );
      expect(archived.error.details).toEqual({ slug: "archived-proj" });
    }

    const changed = revalidateSenderAtCommit([activeGit], {
      registeredSender: {
        projectId: "p-active",
        asOverride: false,
        bindingId: "b-dir",
        directory: "/work/alpha",
        gitCommonDirectory: "/repos/app/.git",
      },
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
      expect(changed.error.message).toBe(
        "the sender path changed Project identity while the Handoff was prepared; retry the send",
      );
      expect(changed.error.details).toEqual({ slug: "git-app" });
    }

    const removed = revalidateSenderAtCommit([], {
      registeredSender: {
        projectId: "p-active",
        asOverride: false,
        bindingId: "b-dir",
        directory: "/work/alpha",
        gitCommonDirectory: null,
      },
    });
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
      expect(removed.error.details).toEqual({ slug: undefined });
    }
  });

  it("allows a registered sender whose matching owner binding is unchanged", () => {
    expect(
      revalidateSenderAtCommit([activeDir], {
        registeredSender: {
          projectId: "p-active",
          asOverride: false,
          bindingId: "b-dir",
          directory: "/work/alpha/sub",
          gitCommonDirectory: null,
        },
      }).ok,
    ).toBe(true);
    expect(
      revalidateSenderAtCommit([activeGit], {
        registeredSender: {
          projectId: "p-git",
          asOverride: false,
          bindingId: "b-git",
          directory: "/repos/wt",
          gitCommonDirectory: "/repos/app/.git",
        },
      }).ok,
    ).toBe(true);
  });

  it("refuses unregistered senders for archived owners, active owners even with allowUnregistered, and overlapping roots", () => {
    const archivedOwner = revalidateSenderAtCommit([archivedDir], {
      unregisteredSenderPath: {
        directory: "/work/alpha/nested/sub",
        gitCommonDirectory: null,
        allowUnregistered: true,
      },
    });
    expect(archivedOwner.ok).toBe(false);
    if (!archivedOwner.ok) {
      expect(archivedOwner.error.code).toBe("PROJECT_ARCHIVED");
      expect(archivedOwner.error.message).toBe("the sender Project was archived while the Handoff was prepared");
      expect(archivedOwner.error.details).toEqual({ slug: "archived-proj" });
    }

    const activeOwnerAllowed = revalidateSenderAtCommit([activeDir], {
      unregisteredSenderPath: {
        directory: "/work/alpha/sub",
        gitCommonDirectory: null,
        allowUnregistered: true,
      },
    });
    expect(activeOwnerAllowed.ok).toBe(false);
    if (!activeOwnerAllowed.ok) {
      expect(activeOwnerAllowed.error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
      expect(activeOwnerAllowed.error.message).toBe(
        "the sender Workspace overlapped a registered Project while the Handoff was prepared; retry the send",
      );
      expect(activeOwnerAllowed.error.details).toEqual({ slug: "alpha" });
    }

    const aboveGitRoot = revalidateSenderAtCommit([activeGit], {
      unregisteredSenderPath: {
        directory: "/repos",
        gitCommonDirectory: null,
        allowUnregistered: false,
      },
    });
    expect(aboveGitRoot.ok).toBe(false);
    if (!aboveGitRoot.ok) {
      expect(aboveGitRoot.error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
      expect(aboveGitRoot.error.details).toEqual({ slug: "git-app" });
    }

    const belowGitRootAllowed = revalidateSenderAtCommit([activeGit], {
      unregisteredSenderPath: {
        directory: "/repos/app/nested-independent",
        gitCommonDirectory: "/repos/app/nested-independent/.git",
        allowUnregistered: true,
      },
    });
    expect(belowGitRootAllowed.ok).toBe(true);

    const rootGitBinding: CommitSenderBindingFact = {
      id: "b-root-git",
      projectId: "p-root",
      directory: "/.git",
      bindingKind: "git_repository",
      slug: "root-repo",
      status: "active",
    };
    const underRootGit = revalidateSenderAtCommit([rootGitBinding], {
      unregisteredSenderPath: {
        directory: "/anywhere",
        gitCommonDirectory: null,
        allowUnregistered: false,
      },
    });
    expect(underRootGit.ok).toBe(false);
    if (!underRootGit.ok) {
      expect(underRootGit.error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
      expect(underRootGit.error.details).toEqual({ slug: "root-repo" });
    }
  });
});
