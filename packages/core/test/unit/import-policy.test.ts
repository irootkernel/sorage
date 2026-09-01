import { describe, expect, it } from "vitest";
import { errorSpec, ok as okResult, type AppError, type Result } from "../../src/errors";
import type { ArtifactStore, StagedFile } from "../../src/artifacts";
import {
  checkExternalSource,
  checkVaultContainment,
  classifyMimeType,
  prepareArtifactImport,
  sanitizeStoredName,
} from "../../src/import-policy";

describe("sanitizeStoredName", () => {
  it("keeps an ordinary name unchanged", () => {
    expect(sanitizeStoredName("report.md")).toBe("report.md");
    expect(sanitizeStoredName("notes final.txt")).toBe("notes final.txt");
  });

  it("turns separators into dashes and drops control bytes (VLT-018)", () => {
    expect(sanitizeStoredName("a/b/c.txt")).toBe("a-b-c.txt");
    expect(sanitizeStoredName("..\\evil.md")).toBe("..-evil.md");
    expect(sanitizeStoredName("na\u0000me.md")).toBe("name.md");
    expect(sanitizeStoredName("be\u007fll.md")).toBe("bell.md");
  });

  it("never produces a traversal or empty segment", () => {
    expect(sanitizeStoredName("..")).toBe("_..");
    expect(sanitizeStoredName(".")).toBe("_.");
    expect(sanitizeStoredName("///")).toBe("---");
    expect(sanitizeStoredName("\u0000\u0001")).toBe("unnamed");
    expect(sanitizeStoredName("")).toBe("unnamed");
  });

  it("produces segments the storage-key contract accepts", () => {
    for (const name of ["report.md", "../evil.md", "..", "", "a/b/c.txt", "c\u0000.md"]) {
      const stored = sanitizeStoredName(name);
      expect(stored).not.toBe("");
      expect(stored).not.toBe(".");
      expect(stored).not.toBe("..");
      expect(stored.includes("/")).toBe(false);
      expect(stored.includes("\\")).toBe(false);
    }
  });
});

describe("classifyMimeType", () => {
  it("classifies by extension allowlist only (section 11.2)", () => {
    expect(classifyMimeType("report.md")).toBe("text/markdown");
    expect(classifyMimeType("notes.txt")).toBe("text/plain; charset=utf-8");
    expect(classifyMimeType("archive.zip")).toBe("application/octet-stream");
    expect(classifyMimeType("no-extension")).toBe("application/octet-stream");
    expect(classifyMimeType("report.MD")).toBe("application/octet-stream");
  });
});

describe("checkExternalSource", () => {
  const root = "/resolved/workspace";

  it("accepts a source inside the resolved workspace", () => {
    for (const source of [root, `${root}/doc.md`, `${root}/deep/nested/doc.md`]) {
      expect(
        checkExternalSource({
          resolvedSourcePath: source,
          workspaceRoot: root,
          policy: "workspace_or_explicit",
          allowExternalSource: false,
        }).ok,
      ).toBe(true);
    }
  });

  it("rejects an outside source with SOURCE_OUTSIDE_WORKSPACE at exit 77 unless overridden (VLT-016)", () => {
    const check = { resolvedSourcePath: "/elsewhere/doc.md", workspaceRoot: root } as const;
    const refused = checkExternalSource({ ...check, policy: "workspace_or_explicit", allowExternalSource: false });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
    expect(errorSpec(refused.error.code).exitCode).toBe(77);
    const allowed = checkExternalSource({ ...check, policy: "workspace_or_explicit", allowExternalSource: true });
    expect(allowed.ok).toBe(true);
  });

  it("never honors the override under workspace_only", () => {
    const refused = checkExternalSource({
      resolvedSourcePath: "/elsewhere/doc.md",
      workspaceRoot: root,
      policy: "workspace_only",
      allowExternalSource: true,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
  });

  it("rejects when no workspace root resolves", () => {
    const refused = checkExternalSource({
      resolvedSourcePath: "/elsewhere/doc.md",
      workspaceRoot: null,
      policy: "workspace_or_explicit",
      allowExternalSource: false,
    });
    expect(refused.ok).toBe(false);
  });
});

describe("checkVaultContainment", () => {
  it("accepts disjoint directories", () => {
    expect(
      checkVaultContainment({ resolvedVaultPath: "/vault", resolvedBindingDirectories: ["/projects/a", "/projects/b"] })
        .ok,
    ).toBe(true);
  });

  it("rejects a Vault inside a bound Project directory at exit 64 (VLT-017)", () => {
    const refused = checkVaultContainment({
      resolvedVaultPath: "/projects/a/vault",
      resolvedBindingDirectories: ["/projects/a"],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("VAULT_CONTAINMENT");
    expect(errorSpec(refused.error.code).exitCode).toBe(64);
    expect(refused.error.details?.side).toBe("vault-inside-project");
  });

  it("rejects a Project directory inside the Vault", () => {
    const refused = checkVaultContainment({
      resolvedVaultPath: "/vault",
      resolvedBindingDirectories: ["/vault/projects/a"],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("VAULT_CONTAINMENT");
    expect(refused.error.details?.side).toBe("project-inside-vault");
  });

  it("rejects an identical path in both roles", () => {
    expect(checkVaultContainment({ resolvedVaultPath: "/same", resolvedBindingDirectories: ["/same"] }).ok).toBe(false);
  });
});

describe("prepareArtifactImport", () => {
  it("composes the policy into one VLT-007 record", () => {
    const store = fakeStore(okResult({ stagingPath: "/vault/staging/u1", sizeBytes: 3, sha256: "abc" }));
    const prepared = prepareArtifactImport(
      { artifactStore: store },
      {
        sourcePath: "doc.md",
        resolvedSourcePath: "/resolved/workspace/doc.md",
        originalName: "../secret report.md",
        workspaceRoot: "/resolved/workspace",
        externalPolicy: "workspace_or_explicit",
        allowExternalSource: false,
        maxBytes: 1000,
        handoffId: "h-1",
        artifactId: "a-1",
        resolvedVaultPath: "/vault",
        resolvedBindingDirectories: [],
      },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.originalName).toBe("../secret report.md");
    expect(prepared.value.storedName).toBe("..-secret report.md");
    expect(prepared.value.mimeType).toBe("text/markdown");
    expect(prepared.value.storageKey).toBe("artifacts/h-1/a-1/..-secret report.md");
    expect(prepared.value.importedFromPath).toBe("doc.md");
  });

  it("stops at the first failing policy", () => {
    const store = fakeStore(okResult({ stagingPath: "/s", sizeBytes: 1, sha256: "x" }));
    const contained = prepareArtifactImport(
      { artifactStore: store },
      {
        sourcePath: "d",
        resolvedSourcePath: "/outside/d",
        originalName: "d",
        workspaceRoot: "/w",
        externalPolicy: "workspace_only",
        allowExternalSource: true,
        maxBytes: 10,
        handoffId: "h",
        artifactId: "a",
        resolvedVaultPath: "/w/vault",
        resolvedBindingDirectories: ["/w"],
      },
    );
    expect(contained.ok).toBe(false);
    if (contained.ok) return;
    expect(contained.error.code).toBe("VAULT_CONTAINMENT");
  });
});

function fakeStore(result: Result<StagedFile, AppError>): ArtifactStore {
  return {
    stage: () => result,
    activate: () => {
      throw new Error("not used in this test");
    },
    pathOf: () => {
      throw new Error("not used in this test");
    },
    exists: () => {
      throw new Error("not used in this test");
    },
    remove: () => ({ ok: true, value: undefined }),
    checksum: () => {
      throw new Error("not used in this test");
    },
  };
}
