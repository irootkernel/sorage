import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SORAGE_VERSION } from "../packages/core/src/version";
import { DEPENDENCY_BLOCKS, enumerateManifestPaths, readPackageManifest, reportViolationsAndExit } from "./workspace";

const root =
  process.argv[2] === undefined ? join(dirname(fileURLToPath(import.meta.url)), "..") : resolve(process.argv[2]);
const manifestPaths = enumerateManifestPaths(root);
const violations: string[] = [];

for (const manifestPath of manifestPaths) {
  const result = readPackageManifest(manifestPath);
  if (!result.ok) {
    violations.push(result.error);
    continue;
  }
  const { manifest } = result;

  if (manifest.version !== SORAGE_VERSION) {
    violations.push(
      `${manifestPath}: version ${JSON.stringify(manifest.version)} does not match ${JSON.stringify(SORAGE_VERSION)}`,
    );
  }
  for (const block of DEPENDENCY_BLOCKS) {
    for (const [name, declaredVersion] of Object.entries(manifest[block] ?? {})) {
      if (name.startsWith("@sorage/") && declaredVersion !== SORAGE_VERSION) {
        violations.push(
          `${manifestPath}: ${block}.${name} ${JSON.stringify(declaredVersion)} does not match ${JSON.stringify(SORAGE_VERSION)}`,
        );
      }
    }
  }
}

reportViolationsAndExit("version consistency check failed:", violations);

console.log(
  `version consistency check passed: ${manifestPaths.length} manifests and every internal dependency match Sorage ${SORAGE_VERSION}.`,
);
