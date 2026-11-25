import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertManagedBun, runtimePath, toolchainRoot as root } from "./toolchain-runtime";

assertManagedBun();
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const bunVersion = readFileSync(join(root, ".bun-version"), "utf8").trim();
const command = process.argv[2] ?? "check";
function run(binary: string, args: string[]): void {
  const result = spawnSync(binary, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
function node(): string {
  const path = runtimePath("node");
  const expected = readFileSync(join(root, ".node-version"), "utf8").trim();
  const probe = spawnSync(path, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== `v${expected}`) {
    throw new Error(`expected Node ${expected} at ${path}; run make toolchain-install`);
  }
  return path;
}
function metadata(): void {
  if (pkg.engines?.bun !== bunVersion || pkg.packageManager !== `bun@${bunVersion}`) {
    throw new Error("toolchain metadata differs from .bun-version; run make toolchain-sync");
  }
}
function local(name: string, entry: string): string {
  const manifest = join(root, "node_modules", name, "package.json");
  let installed: { version: string };
  try {
    installed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    throw new Error(`missing local ${name}; run make deps`);
  }
  if (name === "typescript" && installed.version !== pkg.devDependencies.typescript) {
    throw new Error("local TypeScript differs from package.json; run make deps");
  }
  return join(root, "node_modules", name, entry);
}
if (command === "sync") {
  pkg.engines = { ...pkg.engines, bun: bunVersion };
  pkg.packageManager = `bun@${bunVersion}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
} else if (command === "check") {
  metadata();
  const nodePath = node();
  const compiler = local("typescript", "bin/tsc");
  const result = spawnSync(nodePath, [compiler, "--version"], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() !== `Version ${pkg.devDependencies.typescript}`) {
    throw new Error("TypeScript compiler verification failed; run make deps");
  }
  console.log(
    JSON.stringify(
      {
        bun: { declared: bunVersion, observed: process.versions.bun, path: realpathSync(process.execPath) },
        node: {
          declared: readFileSync(join(root, ".node-version"), "utf8").trim(),
          path: realpathSync(nodePath),
          observed: spawnSync(nodePath, ["--version"], { encoding: "utf8" }).stdout.trim(),
        },
        typescript: {
          declared: pkg.devDependencies.typescript,
          observed: result.stdout.trim(),
          path: realpathSync(compiler),
        },
        packageManager: pkg.packageManager,
      },
      null,
      2,
    ),
  );
} else if (command === "script") {
  metadata();
  const name = process.argv[3];
  if (!name) throw new Error("missing project script name");
  const args = process.argv.slice(4);
  if (name.startsWith("test:")) {
    const layer = name.slice(5);
    if (!["unit", "int", "contract", "e2e", "release"].includes(layer)) throw new Error("unknown test layer");
    run(node(), [local("vitest", "vitest.mjs"), "run", "--config", `vitest.${layer}.config.ts`, ...args]);
  }
  if (name === "format" || name === "check:format" || name === "check:lint") {
    run(node(), [
      local("@biomejs/biome", "bin/biome"),
      name === "check:lint" ? "lint" : "format",
      ".",
      ...(name === "format" ? ["--write"] : []),
      ...(name === "check:lint" ? ["--error-on-warnings"] : []),
      ...args,
    ]);
  }
  const scripts: Record<string, string> = {
    "check:version": "check-version.ts",
    "check:typecheck": "check-typecheck.ts",
    "check:import-boundaries": "check-import-boundaries.ts",
    "check:cycles": "check-cycles.ts",
    "check:dependency-boundaries": "check-dependency-boundaries.ts",
    "check:sot": "sot-check.ts",
    "build:web": "build-web-assets.ts",
    "build:cli": "build-cli.ts",
    package: "package.ts",
  };
  if (name === "check:toolchain") run(process.execPath, ["--no-install", import.meta.filename, "check", ...args]);
  const script = scripts[name];
  if (!script) throw new Error(`unknown project script: ${name}`);
  run(process.execPath, ["--no-install", join(root, "scripts", script), ...args]);
} else {
  throw new Error(`unknown toolchain command: ${command}`);
}
