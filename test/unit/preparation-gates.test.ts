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

  it.each(["home", "channel-command-ports"])("accepts the adapters composition module %s", (module) => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "apps/cli/src/ok.ts"),
        `import * as ports from "@sorage/adapters/src/${module}";\nexport const p = ports;\n`,
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).toBe(0);
  });

  it.each(["sqlite/migrator", "channels"])("refuses direct CLI access to adapters storage module %s", (module) => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "apps/cli/src/bad.ts"),
        `import * as storage from "@sorage/adapters/src/${module}";\nexport const m = storage;\n`,
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

describe("cycle gate", () => {
  it("passes on an acyclic multi-package layout and ignores type-only cycles", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/core/src/a.ts"),
        'import type { B } from "./b";\nimport { type B2 } from "./b";\nexport type A = { b?: B; b2?: B2; c?: import("./b").B };\nexport const a = 1;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/b.ts"),
        'import { a } from "./a";\nexport type { A } from "./a";\nexport type B = { a: number };\nexport type B2 = B;\nexport const b = a + 1;\n',
      );
      writeFileSync(join(r, "packages/core/src/index.ts"), 'export * from "./a";\nexport * from "./b";\n');
      writeFileSync(
        join(r, "packages/adapters/src/entry.ts"),
        'import { b } from "@sorage/core";\nexport const value = b;\n',
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(0);
  });

  it("fails with exit 1 and named diagnostics on a two-file intra-package runtime cycle", () => {
    const root = makeFixture((r) => {
      writeFileSync(join(r, "packages/core/src/a.ts"), 'import { b } from "./b";\nexport const a = () => b;\n');
      writeFileSync(join(r, "packages/core/src/b.ts"), 'import { a } from "./a";\nexport const b = () => a;\n');
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runtime cycle:");
    expect(result.stderr).toContain("packages/core/src/a.ts");
    expect(result.stderr).toContain("packages/core/src/b.ts");
  });

  it("fails with exit 1 and named diagnostics on a cross-package cycle via an @sorage subpath", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/adapters/src/bridge.ts"),
        'import { entry } from "@sorage/cli/src/entry";\nexport const bridge = () => entry;\n',
      );
      writeFileSync(
        join(r, "apps/cli/src/entry.ts"),
        'import { bridge } from "@sorage/adapters/src/bridge";\nexport const entry = () => bridge;\n',
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runtime cycle:");
    expect(result.stderr).toContain("packages/adapters/src/bridge.ts");
    expect(result.stderr).toContain("apps/cli/src/entry.ts");
  });

  it("fails with exit 1 and named diagnostics on unresolved relative or internal @sorage specifiers", () => {
    const root = makeFixture((r) => {
      writeFileSync(join(r, "packages/core/src/a.ts"), 'import { x } from "./missing";\nexport const a = x;\n');
      writeFileSync(
        join(r, "apps/cli/src/entry.ts"),
        'import { y } from "@sorage/adapters/src/missing-port";\nexport const e = y;\n',
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unresolved internal specifier "./missing"');
    expect(result.stderr).toContain('unresolved internal specifier "@sorage/adapters/src/missing-port"');
  });

  it("detects runtime cycles through export *, mixed default+type, side-effect, and dynamic template imports", () => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, "packages/core/src/default-cycle-a.ts"),
        'import defB, { type UnusedType } from "./default-cycle-b";\nexport type Keep = UnusedType;\nexport default defB;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/default-cycle-b.ts"),
        'import "./default-cycle-a";\nexport type UnusedType = string;\nexport default 1;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/dyn-a.ts"),
        'export * from "./dyn-b";\nexport const loadB = () => import(`./dyn-b`);\n',
      );
      writeFileSync(join(r, "packages/core/src/dyn-b.ts"), "export const loadA = () => import(`./dyn-a`);\n");
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/core/src/default-cycle-a.ts");
    expect(result.stderr).toContain("packages/core/src/default-cycle-b.ts");
    expect(result.stderr).toContain("packages/core/src/dyn-a.ts");
    expect(result.stderr).toContain("packages/core/src/dyn-b.ts");
  });
});
