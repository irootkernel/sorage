import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertManagedBun, managedCompiler, managedNode } from "./toolchain-runtime";
import { enumerateWorkspaceDirectories, reportViolationsAndExit } from "./workspace";

assertManagedBun();
const node = managedNode();
const tsc = managedCompiler();

const root = process.argv[2] ?? ".";
const failures: string[] = [];

const projects = [
  ...enumerateWorkspaceDirectories(root).map((ws) => ({ name: ws.relDir, path: join(ws.relDir, "tsconfig.json") })),
  { name: "daemon browser source", path: "apps/daemon/src/web/tsconfig.json" },
  { name: "daemon browser tests", path: "apps/daemon/test/unit/web/tsconfig.json" },
  { name: "root", path: "tsconfig.json" },
];
for (const project of projects) {
  if (!existsSync(join(root, project.path))) continue;
  const result = Bun.spawnSync({
    cmd: [node, tsc, "-p", project.path],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const diagnostics = result.stdout.toString() || result.stderr.toString();
    failures.push(`${project.name}: tsc exited ${result.exitCode}\n${diagnostics}`);
  }
}

reportViolationsAndExit("typecheck failed:", failures, { indent: "" });

console.log("typecheck passed for every workspace package.");
