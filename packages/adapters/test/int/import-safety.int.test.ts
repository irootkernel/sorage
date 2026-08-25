import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorSpec, prepareArtifactImport, type AppError } from "@sorage/core";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { inspectSourceFile } from "../../src/import-source";
import { createVaultInitializer } from "../../src/vault";
import { FakeClock } from "../../src/testkit/fakes";
import { makeTempHome } from "../../src/testkit/temp-home";
import { makeTempVault } from "../../src/testkit/temp-vault";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";

function exitCodeOf(error: AppError): number {
  return errorSpec(error.code).exitCode;
}

function vaultFixture(prefix: string) {
  const fixture = makeTempVault(prefix);
  if (!createVaultInitializer(new FakeClock()).initialize(fixture.vaultPath, INSTALLATION).ok) {
    throw new Error("fixture init must succeed");
  }
  const store = createNodeArtifactStore({ vaultPath: fixture.vaultPath, installationId: INSTALLATION });
  return { ...fixture, store };
}

describe("inspectSourceFile", () => {
  it("resolves a regular file and returns its real path (SEC-006)", () => {
    const home = makeTempHome("sorage-inspect-");
    try {
      const file = join(home.home, "doc.md");
      writeFileSync(file, "body");
      const inspected = inspectSourceFile(file);
      expect(inspected.ok).toBe(true);
      if (inspected.ok) expect(inspected.value.resolvedPath).toBe(realpathSync(file));
    } finally {
      home.cleanup();
    }
  });

  it("rejects a FIFO, a device, and a directory (VLT-015, SEC-007)", () => {
    const home = makeTempHome("sorage-special-");
    try {
      const fifo = join(home.home, "pipe");
      execFileSync("mkfifo", [fifo]);
      for (const source of [fifo, "/dev/null", home.home]) {
        const inspected = inspectSourceFile(source);
        expect(inspected.ok, source).toBe(false);
        if (inspected.ok) return;
        expect(inspected.error.message).toContain("cannot be imported as an Artifact");
      }
    } finally {
      home.cleanup();
    }
  });

  it("rejects a symlink loop as unresolvable", () => {
    const home = makeTempHome("sorage-loop-");
    try {
      const loop = join(home.home, "loop");
      execFileSync("ln", ["-s", loop, loop]);
      const inspected = inspectSourceFile(loop);
      expect(inspected.ok).toBe(false);
    } finally {
      home.cleanup();
    }
  });

  it("rejects an unreadable file at read time", () => {
    const home = makeTempHome("sorage-unreadable-");
    try {
      const file = join(home.home, "secret.md");
      writeFileSync(file, "body");
      chmodSync(file, 0o000);
      const { store, cleanup } = vaultFixture("sorage-unreadable-v-");
      try {
        const staged = store.stage({ sourcePath: file, maxBytes: 100 });
        expect(staged.ok).toBe(false);
        if (staged.ok) return;
        expect(staged.error.message).toContain("could not be read");
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });
});

describe("prepareArtifactImport over the real store", () => {
  it("stores a sanitized name while recording the original verbatim (VLT-018)", () => {
    const home = makeTempHome("sorage-sanitize-");
    try {
      const workspace = join(home.home, "workspace");
      mkdirSync(workspace);
      const source = join(workspace, "..\\evil report.md");
      writeFileSync(source, "content");
      const { store, vaultPath, cleanup } = vaultFixture("sorage-sanitize-v-");
      try {
        const prepared = prepareArtifactImport(
          { artifactStore: store },
          {
            sourcePath: source,
            resolvedSourcePath: source,
            originalName: "..\\evil report.md",
            workspaceRoot: workspace,
            externalPolicy: "workspace_or_explicit",
            allowExternalSource: false,
            maxBytes: 1000,
            handoffId: "h-1",
            artifactId: "a-1",
            resolvedVaultPath: vaultPath,
            resolvedBindingDirectories: [],
          },
        );
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) return;
        expect(prepared.value.originalName).toBe("..\\evil report.md");
        expect(prepared.value.storedName).toBe("..-evil report.md");
        expect(prepared.value.storageKey).toBe("artifacts/h-1/a-1/..-evil report.md");
        expect(existsSync(prepared.value.stagingPath)).toBe(true);
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("rejects an outside source at exit 77 and honors the explicit override (VLT-016)", () => {
    const home = makeTempHome("sorage-external-");
    try {
      const workspace = join(home.home, "workspace");
      const outside = join(home.home, "outside");
      mkdirSync(workspace);
      mkdirSync(outside);
      const source = join(outside, "doc.md");
      writeFileSync(source, "content");
      const { store, vaultPath, cleanup } = vaultFixture("sorage-external-v-");
      try {
        const base = {
          sourcePath: source,
          resolvedSourcePath: source,
          originalName: "doc.md",
          maxBytes: 1000,
          handoffId: "h-1",
          artifactId: "a-1",
          resolvedVaultPath: vaultPath,
          resolvedBindingDirectories: [] as string[],
        };
        const refused = prepareArtifactImport(
          { artifactStore: store },
          { ...base, workspaceRoot: workspace, externalPolicy: "workspace_or_explicit", allowExternalSource: false },
        );
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
        expect(exitCodeOf(refused.error)).toBe(77);

        const allowed = prepareArtifactImport(
          { artifactStore: store },
          { ...base, workspaceRoot: workspace, externalPolicy: "workspace_or_explicit", allowExternalSource: true },
        );
        expect(allowed.ok).toBe(true);

        const strict = prepareArtifactImport(
          { artifactStore: store },
          { ...base, workspaceRoot: workspace, externalPolicy: "workspace_only", allowExternalSource: true },
        );
        expect(strict.ok).toBe(false);
        if (strict.ok) return;
        expect(strict.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
        expect(exitCodeOf(strict.error)).toBe(77);
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("rejects Vault and Project containment cycles at exit 64 at configuration time (VLT-017)", () => {
    const home = makeTempHome("sorage-contain-");
    try {
      const project = join(home.home, "project");
      const vaultInside = join(project, "vault");
      mkdirSync(project);
      const inside = vaultFixture("sorage-contain-in-");
      try {
        const source = join(home.home, "doc.md");
        writeFileSync(source, "content");
        const refused = prepareArtifactImport(
          { artifactStore: inside.store },
          {
            sourcePath: source,
            resolvedSourcePath: source,
            originalName: "doc.md",
            workspaceRoot: home.home,
            externalPolicy: "workspace_or_explicit",
            allowExternalSource: false,
            maxBytes: 1000,
            handoffId: "h",
            artifactId: "a",
            resolvedVaultPath: vaultInside,
            resolvedBindingDirectories: [project],
          },
        );
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.error.code).toBe("VAULT_CONTAINMENT");
        expect(exitCodeOf(refused.error)).toBe(64);
      } finally {
        inside.cleanup();
      }

      const around = vaultFixture("sorage-contain-out-");
      try {
        const boundInside = join(around.vaultPath, "project");
        mkdirSync(boundInside);
        const source = join(home.home, "doc2.md");
        writeFileSync(source, "content");
        const refused = prepareArtifactImport(
          { artifactStore: around.store },
          {
            sourcePath: source,
            resolvedSourcePath: source,
            originalName: "doc2.md",
            workspaceRoot: home.home,
            externalPolicy: "workspace_or_explicit",
            allowExternalSource: false,
            maxBytes: 1000,
            handoffId: "h",
            artifactId: "a",
            resolvedVaultPath: around.vaultPath,
            resolvedBindingDirectories: [boundInside],
          },
        );
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.error.code).toBe("VAULT_CONTAINMENT");
        expect(refused.error.details?.["side"]).toBe("project-inside-vault");
      } finally {
        around.cleanup();
      }
    } finally {
      home.cleanup();
    }
  });

  it("marks the activated Artifact file read-only (VLT-008)", () => {
    const home = makeTempHome("sorage-readonly-");
    try {
      const source = join(home.home, "doc.md");
      writeFileSync(source, "readonly body");
      const { store, vaultPath, cleanup } = vaultFixture("sorage-readonly-v-");
      try {
        const staged = store.stage({ sourcePath: source, maxBytes: 1000 });
        if (!staged.ok) throw new Error("staging must succeed");
        const placed = store.activate({
          stagingPath: staged.value.stagingPath,
          storageKey: "artifacts/h-1/a-1/doc.md",
        });
        expect(placed.ok).toBe(true);
        const mode = statSync(join(vaultPath, "artifacts/h-1/a-1/doc.md")).mode & 0o777;
        expect(mode.toString(8)).toBe("444");
        // The staged copy and the source stay untouched by the mark.
        expect(readFileSync(source, "utf8")).toBe("readonly body");
      } finally {
        cleanup();
      }
    } finally {
      home.cleanup();
    }
  });
});
