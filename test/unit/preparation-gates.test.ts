import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeFixture(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "sorage-boundary-"));
  tempRoots.push(root);
  mkdirSync(join(root, "packages/core/src"), { recursive: true });
  mkdirSync(join(root, "packages/adapters/src"), { recursive: true });
  mkdirSync(join(root, "apps/cli/src"), { recursive: true });
  mkdirSync(join(root, "apps/daemon/src"), { recursive: true });
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*", "apps/*"] }));
  build(root);
  return root;
}

function runScript(name: string, root: string): { exitCode: number; stderr: string } {
  const result = spawnSync("bun", [fileURLToPath(new URL("../../scripts/", import.meta.url)) + name, root], {
    encoding: "utf8",
  });
  return { exitCode: result.status ?? -1, stderr: result.stderr ?? "" };
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("import-boundary gate", () => {
  it("accepts a layout that respects the package import rules", () => {
    const root = makeFixture((r) => {
      writeFileSync(join(r, "packages/core/src/ok.ts"), "export const x = 1;\n");
      writeFileSync(join(r, "packages/adapters/src/ok.ts"), 'import { x } from "@sorage/core";\nexport const y = x;\n');
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).toBe(0);
  });

  it("fails when core imports adapters", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/core/src/bad.ts"),
        'import { y } from "@sorage/adapters";\nexport const x = y;\n',
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@sorage/core must not import @sorage/adapters");
  });

  it("fails when web imports adapters", () => {
    const root = makeFixture((r) => {
      writeFileSync(join(r, "apps/web/src/bad.ts"), 'import { y } from "@sorage/adapters";\nexport const x = y;\n');
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@sorage/web must not import @sorage/adapters");
  });

  it("fails when await appears inside a UnitOfWork.run callback", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/adapters/src/uow.ts"),
        "export function run(callback: () => void): void { callback(); }\nexport const UnitOfWork = { run };\n",
      );
      writeFileSync(
        join(r, "packages/adapters/src/bad.ts"),
        "export function g(): void {\n  UnitOfWork.run(async () => {\n    await Promise.resolve(1);\n  });\n}\n",
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("await is forbidden inside a UnitOfWork.run callback");
  });

  it("accepts await outside a UnitOfWork.run callback", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/adapters/src/ok.ts"),
        "export async function h(): Promise<number> {\n  return await Promise.resolve(1);\n}\n",
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).toBe(0);
  });
});

describe("dependency-boundary gate", () => {
  it("accepts manifests without ecosystem tools", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/adapters/package.json"),
        JSON.stringify({ name: "@sorage/adapters", dependencies: { yaml: "2.8.0" } }),
      );
    });
    const result = runScript("check-dependency-boundaries.ts", root);
    expect(result.exitCode).toBe(0);
  });

  it("fails when a package declares an ecosystem tool dependency", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/adapters/package.json"),
        JSON.stringify({ name: "@sorage/adapters", dependencies: { podway: "0.2.5" } }),
      );
    });
    const result = runScript("check-dependency-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('declares the ecosystem tool "podway"');
  });

  it("fails when the root declares an ecosystem devDependency", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "package.json"),
        JSON.stringify({ name: "fixture", devDependencies: { "@aquarium/tools": "1.0.0" } }),
      );
    });
    const result = runScript("check-dependency-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@aquarium/tools");
  });

  it("accepts an app deep-importing an allowlisted adapters composition module", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "apps/cli/src/ok.ts"),
        'import { createNodeHomePaths } from "@sorage/adapters/src/home";\nexport const p = createNodeHomePaths;\n',
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).toBe(0);
  });

  it("fails when the CLI deep-imports an adapters module outside the composition allowlist", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "apps/cli/src/bad.ts"),
        'import { migrate } from "@sorage/adapters/src/sqlite/migrator";\nexport const m = migrate;\n',
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("composition allowlist");
  });

  it("fails when an app imports the adapters index instead of a command-port module", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "apps/daemon/src/bad.ts"),
        'import { makeTempHome } from "@sorage/adapters";\nexport const t = makeTempHome;\n',
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("must not import the @sorage/adapters index");
  });
});
