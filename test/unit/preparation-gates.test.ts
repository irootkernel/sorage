import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { APP_ADAPTERS_ALLOWLIST, isExportsMap, resolveExportTarget } from "../../scripts/workspace";

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

function runScript(name: string, root: string): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [fileURLToPath(new URL("../../scripts/", import.meta.url)) + name, root], {
    encoding: "utf8",
  });
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

  it.each(["node:fs", "@sorage/core", "pkg", "../server"])("rejects browser import %s", (specifier) => {
    const root = makeFixture((r) => {
      mkdirSync(join(r, "apps/daemon/src/web"));
      writeFileSync(join(r, "apps/daemon/src/web/illegal.ts"), `import "${specifier}";\n`);
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`browser source may import only relative modules within src/web, not ${specifier}`);
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

  it.each(["src/init-ports", "src/import-source", "src/sleep"])(
    "refuses removed daemon allowlist entry %s in apps/daemon/src",
    (entry) => {
      const root = makeFixture((r) => {
        writeFileSync(
          join(r, "apps/daemon/src/bad.ts"),
          `import * as removed from "@sorage/adapters/${entry}";\nexport const r = removed;\n`,
        );
      });
      const result = runScript("check-import-boundaries.ts", root);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("composition allowlist");
    },
  );

  it.each([
    ["apps/cli/src", "src/sqlite/connection"],
    ["apps/cli/src", "src/sqlite/migrator"],
    ["apps/cli/src", "testkit"],
    ["apps/daemon/src", "src/sqlite/connection"],
    ["apps/daemon/src", "src/sqlite/migrator"],
    ["apps/daemon/src", "testkit"],
  ])("refuses test-only adapters export %s/%s in app production source", (dir, subpath) => {
    const root = makeFixture((r) => {
      writeFileSync(
        join(r, dir, "bad.ts"),
        `import * as forbidden from "@sorage/adapters/${subpath}";\nexport const f = forbidden;\n`,
      );
    });
    const result = runScript("check-import-boundaries.ts", root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("composition allowlist");
  });

  it("verifies every real app allowlist entry resolves to an exported file in packages/adapters/package.json", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const adaptersDir = join(repoRoot, "packages/adapters");
    const manifest = JSON.parse(readFileSync(join(adaptersDir, "package.json"), "utf8")) as {
      exports?: unknown;
    };
    expect(isExportsMap(manifest.exports)).toBe(true);

    const daemonAllowlist = APP_ADAPTERS_ALLOWLIST["@sorage/daemon"] ?? [];
    expect(daemonAllowlist).not.toContain("src/init-ports");
    expect(daemonAllowlist).not.toContain("src/import-source");
    expect(daemonAllowlist).not.toContain("src/sleep");

    for (const [appName, entries] of Object.entries(APP_ADAPTERS_ALLOWLIST)) {
      for (const entry of entries) {
        const resolved = resolveExportTarget(adaptersDir, manifest.exports, `./${entry}`);
        expect(resolved.ok, `${appName} allowlist entry "${entry}" must resolve to a real exported file`).toBe(true);
      }
      expect(entries).not.toContain("src/sqlite/connection");
      expect(entries).not.toContain("src/sqlite/migrator");
      expect(entries).not.toContain("testkit");
    }

    for (const testOnlyKey of ["./src/sqlite/connection", "./src/sqlite/migrator", "./testkit"]) {
      const resolved = resolveExportTarget(adaptersDir, manifest.exports, testOnlyKey);
      expect(resolved.ok, `test-only export "${testOnlyKey}" must resolve to a real file`).toBe(true);
    }

    const result = runScript("check-import-boundaries.ts", repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("import-boundary check passed: package import rules hold.");
  });

  it("fails closed when a present adapters manifest omits exports, is malformed, or misses an allowlisted target", () => {
    const missingExports = makeFixture((r) => {
      writeFileSync(join(r, "packages/adapters/package.json"), JSON.stringify({ name: "@sorage/adapters" }));
    });
    const missingExportsResult = runScript("check-import-boundaries.ts", missingExports);
    expect(missingExportsResult.exitCode).toBe(1);
    expect(missingExportsResult.stderr).toContain('missing or invalid "exports" map');

    const malformed = makeFixture((r) => {
      writeFileSync(join(r, "packages/adapters/package.json"), "{not-json");
    });
    const malformedResult = runScript("check-import-boundaries.ts", malformed);
    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stderr).toContain("not parseable JSON");

    const missingKey = makeFixture((r) => {
      writeFileSync(join(r, "packages/adapters/src/home.ts"), "export const home = 1;\n");
      writeFileSync(
        join(r, "packages/adapters/package.json"),
        JSON.stringify({ name: "@sorage/adapters", exports: { "./src/home": "./src/home.ts" } }),
      );
    });
    const missingKeyResult = runScript("check-import-boundaries.ts", missingKey);
    expect(missingKeyResult.exitCode).toBe(1);
    expect(missingKeyResult.stderr).toContain("does not resolve to an exported file");
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

  it("fails with exit 1 on a core inter-directory runtime cycle with zero file-level cycles", () => {
    const root = makeFixture((r) => {
      mkdirSync(join(r, "packages/core/src/alpha"), { recursive: true });
      mkdirSync(join(r, "packages/core/src/beta"), { recursive: true });
      writeFileSync(join(r, "packages/core/src/alpha/a2.ts"), "export const a2 = 2;\n");
      writeFileSync(join(r, "packages/core/src/beta/b1.ts"), "export const b1 = 1;\n");
      writeFileSync(
        join(r, "packages/core/src/alpha/a1.ts"),
        'import { b1 } from "../beta/b1";\nexport const a1 = b1;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/beta/b2.ts"),
        'import { a2 } from "../alpha/a2";\nexport const b2 = a2;\n',
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("core directory cycle: alpha <-> beta");
    expect(result.stderr).not.toContain("runtime cycle:");
  });

  it("fails with exit 1 on a nested backup <-> backup/snapshot runtime directory cycle", () => {
    const root = makeFixture((r) => {
      mkdirSync(join(r, "packages/core/src/backup/snapshot"), { recursive: true });
      writeFileSync(join(r, "packages/core/src/backup/helper.ts"), "export const helper = 1;\n");
      writeFileSync(join(r, "packages/core/src/backup/snapshot/reader.ts"), "export const reader = 2;\n");
      writeFileSync(
        join(r, "packages/core/src/backup/entry.ts"),
        'import { reader } from "./snapshot/reader";\nexport const entry = reader;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/backup/snapshot/writer.ts"),
        'import { helper } from "../helper";\nexport const writer = helper;\n',
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("core directory cycle: backup <-> backup/snapshot");
    expect(result.stderr).not.toContain("runtime cycle:");
  });

  it("fails with exit 1 when only the top-level core directory rollup exposes a cycle", () => {
    const root = makeFixture((r) => {
      mkdirSync(join(r, "packages/core/src/backup/snapshot"), { recursive: true });
      mkdirSync(join(r, "packages/core/src/other"), { recursive: true });
      writeFileSync(join(r, "packages/core/src/backup/snapshot/leaf.ts"), "export const leaf = 1;\n");
      writeFileSync(
        join(r, "packages/core/src/other/bridge.ts"),
        'import { leaf } from "../backup/snapshot/leaf";\nexport const bridge = leaf;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/backup/entry.ts"),
        'import { bridge } from "../other/bridge";\nexport const entry = bridge;\n',
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("core directory cycle (top-level rollup): backup <-> other");
    expect(result.stderr).not.toContain("runtime cycle:");
  });

  it("passes on an acyclic multi-directory core layout with root barrel re-exports and type-only reverse edges", () => {
    const root = makeFixture((r) => {
      mkdirSync(join(r, "packages/core/src/shared"), { recursive: true });
      mkdirSync(join(r, "packages/core/src/domain"), { recursive: true });
      writeFileSync(
        join(r, "packages/core/src/shared/base.ts"),
        'import type { DomainShape } from "../domain/model";\nexport type BaseRef = DomainShape;\nexport const base = 1;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/domain/model.ts"),
        'import { base } from "../shared/base";\nexport type DomainShape = { base: number };\nexport const model = base;\n',
      );
      writeFileSync(
        join(r, "packages/core/src/index.ts"),
        'export * from "./shared/base";\nexport * from "./domain/model";\n',
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(0);
  });

  it("resolves workspace package imports through package.json exports targets including custom root and subpaths", () => {
    const root = makeFixture((r) => {
      mkdirSync(join(r, "packages/adapters/src/testkit"), { recursive: true });
      writeFileSync(join(r, "packages/core/src/index.ts"), "export const coreVal = 1;\n");
      writeFileSync(
        join(r, "packages/core/package.json"),
        JSON.stringify({ name: "@sorage/core", exports: { ".": "./src/index.ts" } }),
      );
      writeFileSync(
        join(r, "packages/adapters/src/testkit/index.ts"),
        'import { cliEntry } from "@sorage/cli";\nexport const kit = cliEntry;\n',
      );
      writeFileSync(
        join(r, "packages/adapters/package.json"),
        JSON.stringify({ name: "@sorage/adapters", exports: { "./testkit": "./src/testkit/index.ts" } }),
      );
      writeFileSync(
        join(r, "apps/cli/src/main.ts"),
        'import { kit } from "@sorage/adapters/testkit";\nexport const cliEntry = () => kit;\n',
      );
      writeFileSync(
        join(r, "apps/cli/package.json"),
        JSON.stringify({ name: "@sorage/cli", exports: { ".": "./src/main.ts" } }),
      );
    });
    const result = runScript("check-cycles.ts", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runtime cycle:");
    expect(result.stderr).toContain("apps/cli/src/main.ts");
    expect(result.stderr).toContain("packages/adapters/src/testkit/index.ts");
  });

  it("fails closed on unexported internal specifiers, missing export targets, or missing/malformed manifest exports", () => {
    const unexported = makeFixture((r) => {
      writeFileSync(join(r, "packages/adapters/src/index.ts"), "export const idx = 1;\n");
      writeFileSync(join(r, "packages/adapters/src/private.ts"), "export const secret = 2;\n");
      writeFileSync(
        join(r, "packages/adapters/package.json"),
        JSON.stringify({ name: "@sorage/adapters", exports: { ".": "./src/index.ts" } }),
      );
      writeFileSync(
        join(r, "apps/cli/src/main.ts"),
        'import { secret } from "@sorage/adapters/src/private";\nexport const v = secret;\n',
      );
      writeFileSync(
        join(r, "apps/cli/package.json"),
        JSON.stringify({ name: "@sorage/cli", exports: { ".": "./src/main.ts" } }),
      );
    });
    const unexportedResult = runScript("check-cycles.ts", unexported);
    expect(unexportedResult.exitCode).toBe(1);
    expect(unexportedResult.stderr).toContain('unresolved internal specifier "@sorage/adapters/src/private"');

    const missingTarget = makeFixture((r) => {
      writeFileSync(join(r, "packages/adapters/src/index.ts"), "export const idx = 1;\n");
      writeFileSync(
        join(r, "packages/adapters/package.json"),
        JSON.stringify({
          name: "@sorage/adapters",
          exports: { ".": "./src/index.ts", "./ghost": "./src/ghost.ts" },
        }),
      );
    });
    const missingTargetResult = runScript("check-cycles.ts", missingTarget);
    expect(missingTargetResult.exitCode).toBe(1);
    expect(missingTargetResult.stderr).toContain('export "./ghost" target "./src/ghost.ts" is invalid or missing');

    const missingExportsField = makeFixture((r) => {
      writeFileSync(join(r, "packages/core/src/index.ts"), "export const x = 1;\n");
      writeFileSync(join(r, "packages/core/package.json"), JSON.stringify({ name: "@sorage/core" }));
      writeFileSync(
        join(r, "packages/adapters/src/entry.ts"),
        'import { x } from "@sorage/core";\nexport const y = x;\n',
      );
    });
    const missingExportsResult = runScript("check-cycles.ts", missingExportsField);
    expect(missingExportsResult.exitCode).toBe(1);
    expect(missingExportsResult.stderr).toContain('missing or invalid "exports" map');
    expect(missingExportsResult.stderr).toContain('unresolved internal specifier "@sorage/core"');
  });

  it("passes on the real repository core directory layout", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const result = runScript("check-cycles.ts", repoRoot);
    expect(result.exitCode).toBe(0);
  });
});
