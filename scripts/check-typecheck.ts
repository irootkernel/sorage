import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertManagedBun, managedCompiler, managedNode } from "./toolchain-runtime";
import { enumerateWorkspaceDirectories, reportViolationsAndExit } from "./workspace";

assertManagedBun();
const node = managedNode();
const tsc = managedCompiler();

const root = process.argv[2] ?? ".";
const failures: string[] = [];

for (const ws of enumerateWorkspaceDirectories(root)) {
  if (!existsSync(join(ws.dir, "tsconfig.json"))) continue;
  const result = Bun.spawnSync({
    cmd: [node, tsc, "-p", join(ws.relDir, "tsconfig.json")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const diagnostics = result.stdout.toString() || result.stderr.toString();
    failures.push(`${ws.relDir}: tsc exited ${result.exitCode}\n${diagnostics}`);
  }
}

if (existsSync(join(root, "tsconfig.json"))) {
  const result = Bun.spawnSync({
    cmd: [node, tsc, "-p", "tsconfig.json"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const diagnostics = result.stdout.toString() || result.stderr.toString();
    failures.push(`root: tsc exited ${result.exitCode}\n${diagnostics}`);
  }
}

reportViolationsAndExit("typecheck failed:", failures, { indent: "" });

console.log("typecheck passed for every workspace package.");
