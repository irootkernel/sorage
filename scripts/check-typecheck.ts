import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".";
const groups = ["packages", "apps"];
const failures: string[] = [];

for (const group of groups) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir)) {
    const project = join(group, entry);
    if (!existsSync(join(root, project, "tsconfig.json"))) continue;
    const result = Bun.spawnSync({
      cmd: ["bunx", "tsc", "-p", join(project, "tsconfig.json")],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const diagnostics = result.stdout.toString() || result.stderr.toString();
      failures.push(`${project}: tsc exited ${result.exitCode}\n${diagnostics}`);
    }
  }
}

if (existsSync(join(root, "tsconfig.json"))) {
  const result = Bun.spawnSync({
    cmd: ["bunx", "tsc", "-p", "tsconfig.json"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const diagnostics = result.stdout.toString() || result.stderr.toString();
    failures.push(`root: tsc exited ${result.exitCode}\n${diagnostics}`);
  }
}

if (failures.length > 0) {
  console.error("typecheck failed:");
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log("typecheck passed for every workspace package.");
