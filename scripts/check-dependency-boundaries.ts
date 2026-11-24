// Enforces GEN-009 and GEN-010: no Sorage package declares an ecosystem tool as a source dependency.
import {
  DEPENDENCY_BLOCKS,
  ECOSYSTEM_TOOLS,
  enumerateManifestPaths,
  readPackageManifest,
  reportViolationsAndExit,
} from "./workspace";

const root = process.argv[2] ?? ".";
const violations: string[] = [];

function checkManifest(manifestPath: string): void {
  const result = readPackageManifest(manifestPath);
  if (!result.ok) {
    violations.push(result.error);
    return;
  }
  const { manifest } = result;
  for (const block of DEPENDENCY_BLOCKS) {
    for (const name of Object.keys(manifest[block] ?? {})) {
      if (ECOSYSTEM_TOOLS.some((tool) => new RegExp(`^(?:@${tool}/|${tool}(?:[-/]|$))`).test(name))) {
        violations.push(`${manifestPath}: ${block} declares the ecosystem tool "${name}"`);
      }
    }
  }
}

for (const manifestPath of enumerateManifestPaths(root)) {
  checkManifest(manifestPath);
}

reportViolationsAndExit("dependency-boundary check failed:", violations, {
  footer: ["Aquarium, Podway, Mulgae, Gaori, and Sanho are development tooling and never Sorage source dependencies."],
});

console.log("dependency-boundary check passed: no ecosystem tool appears in any dependency block.");
