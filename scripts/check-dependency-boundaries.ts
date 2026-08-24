// Enforces GEN-009 and GEN-010: no Sorage package declares an ecosystem tool as a source dependency.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ECOSYSTEM_TOOLS = ["aquarium", "podway", "mulgae", "gaori", "sanho", "ouroboros", "dolgorae"];
const DEPENDENCY_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const root = process.argv[2] ?? ".";
const violations: string[] = [];

function checkManifest(manifestPath: string): void {
  let pkg: Record<string, Record<string, string>>;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Record<string, string>>;
  } catch {
    violations.push(`${manifestPath}: not parseable JSON`);
    return;
  }
  for (const block of DEPENDENCY_BLOCKS) {
    for (const name of Object.keys(pkg[block] ?? {})) {
      if (ECOSYSTEM_TOOLS.some((tool) => new RegExp(`^(?:@${tool}/|${tool}(?:[-/]|$))`).test(name))) {
        violations.push(`${manifestPath}: ${block} declares the ecosystem tool "${name}"`);
      }
    }
  }
}

checkManifest(join(root, "package.json"));
for (const group of ["packages", "apps"]) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir)) {
    const manifest = join(groupDir, entry, "package.json");
    if (existsSync(manifest)) checkManifest(manifest);
  }
}

if (violations.length > 0) {
  console.error("dependency-boundary check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "Aquarium, Podway, Mulgae, Gaori, and Sanho are development tooling and never Sorage source dependencies.",
  );
  process.exit(1);
}

console.log("dependency-boundary check passed: no ecosystem tool appears in any dependency block.");
