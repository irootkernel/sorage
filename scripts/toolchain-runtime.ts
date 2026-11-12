import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const toolchainRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function runtimePath(kind: "bun" | "node"): string {
  const version = readFileSync(join(toolchainRoot, `.${kind}-version`), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid .${kind}-version`);
  return join(toolchainRoot, ".toolchains", kind, version, "bin", kind);
}

export function assertManagedBun(): void {
  const expected = runtimePath("bun");
  const version = readFileSync(join(toolchainRoot, ".bun-version"), "utf8").trim();
  if (process.versions.bun !== version || realpathSync(process.execPath) !== realpathSync(expected)) {
    throw new Error(`use the project toolchain: expected Bun ${version} at ${expected}; run make toolchain-install`);
  }
}
import { spawnSync } from "node:child_process";

export function managedNode(): string {
  const path = runtimePath("node");
  const expected = readFileSync(join(toolchainRoot, ".node-version"), "utf8").trim();
  const probe = spawnSync(path, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== `v${expected}`) {
    throw new Error(`expected Node ${expected} at ${path}; run make toolchain-install`);
  }
  return path;
}

export function managedCompiler(): string {
  const pkg = JSON.parse(readFileSync(join(toolchainRoot, "package.json"), "utf8"));
  const compiler = join(toolchainRoot, "node_modules/typescript/bin/tsc");
  const probe = spawnSync(managedNode(), [compiler, "--version"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== `Version ${pkg.devDependencies.typescript}`) {
    throw new Error("missing or mismatched TypeScript compiler; run make deps");
  }
  return compiler;
}
