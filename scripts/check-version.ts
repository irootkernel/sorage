import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SORAGE_VERSION } from "../packages/core/src/version";

const root =
  process.argv[2] === undefined ? join(dirname(fileURLToPath(import.meta.url)), "..") : resolve(process.argv[2]);
const dependencyBlocks = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const manifestPaths = [join(root, "package.json")];
const violations: string[] = [];

for (const group of ["packages", "apps"]) {
  const groupDirectory = join(root, group);
  if (!existsSync(groupDirectory)) continue;
  for (const entry of readdirSync(groupDirectory)) {
    const manifestPath = join(groupDirectory, entry, "package.json");
    if (existsSync(manifestPath)) manifestPaths.push(manifestPath);
  }
}

for (const manifestPath of manifestPaths) {
  let manifest: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    violations.push(`${manifestPath}: not parseable JSON`);
    continue;
  }

  if (manifest.version !== SORAGE_VERSION) {
    violations.push(
      `${manifestPath}: version ${JSON.stringify(manifest.version)} does not match ${JSON.stringify(SORAGE_VERSION)}`,
    );
  }
  for (const block of dependencyBlocks) {
    for (const [name, declaredVersion] of Object.entries(manifest[block] ?? {})) {
      if (name.startsWith("@sorage/") && declaredVersion !== SORAGE_VERSION) {
        violations.push(
          `${manifestPath}: ${block}.${name} ${JSON.stringify(declaredVersion)} does not match ${JSON.stringify(SORAGE_VERSION)}`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("version consistency check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(
  `version consistency check passed: ${manifestPaths.length} manifests and every internal dependency match Sorage ${SORAGE_VERSION}.`,
);
