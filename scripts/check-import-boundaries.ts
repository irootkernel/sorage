// Enforces the package import rules of docs/implementation-tips/README.md section 2 (NFR-014).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  APP_ADAPTERS_ALLOWLIST,
  ECOSYSTEM_TOOLS,
  enumerateWorkspaceDirectories,
  isExportsMap,
  readPackageManifest,
  reportViolationsAndExit,
  resolveExportTarget,
  walkSourceFiles,
} from "./workspace";

// Package name -> packages whose imports it may reference.
const IMPORT_RULES: Record<string, readonly string[]> = {
  "@sorage/core": [],
  "@sorage/adapters": ["@sorage/core"],
  "@sorage/cli": ["@sorage/core", "@sorage/adapters", "@sorage/daemon"],
  "@sorage/daemon": ["@sorage/core", "@sorage/adapters"],
};

const IMPORT_SPEC_PATTERN = /(?:from\s*|import\s*|import\(\s*|require\(\s*)["']([^"']+)["']/g;

const root = process.argv[2] ?? ".";
const violations: string[] = [];

// Removes comments so scanners cannot match on prose; string literal contents survive
// because import specifiers themselves are quoted.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function ecosystemToolFor(spec: string): string | null {
  for (const tool of ECOSYSTEM_TOOLS) {
    if (new RegExp(`(^|/)@?${tool}(/|$)|(^|/)@?${tool}-`).test(spec)) return tool;
  }
  return null;
}

function checkImportsForPackage(pkgDir: string, pkgName: string, allowed: readonly string[]): void {
  walkSourceFiles(join(pkgDir, "src"), (path) => {
    const text = stripComments(readFileSync(path, "utf8"));
    for (const match of text.matchAll(IMPORT_SPEC_PATTERN)) {
      const spec = match[1];
      if (spec === undefined) continue;
      if (spec.startsWith(".")) continue;
      const target = spec.startsWith("@sorage/") ? spec.split("/").slice(0, 2).join("/") : null;
      if (target && target !== pkgName && !allowed.includes(target)) {
        violations.push(`${path}: ${pkgName} must not import ${target}`);
      }
      const appAllowlist = target === "@sorage/adapters" ? APP_ADAPTERS_ALLOWLIST[pkgName] : undefined;
      if (appAllowlist !== undefined) {
        const modulePath = spec.slice("@sorage/adapters/".length);
        if (modulePath === "") {
          violations.push(
            `${path}: an app must not import the @sorage/adapters index; deep-import a command-port module instead`,
          );
        } else if (!appAllowlist.includes(modulePath)) {
          violations.push(
            `${path}: ${pkgName} must reach the adapters only through the composition allowlist, not ${spec}`,
          );
        }
      }
      const tool = ecosystemToolFor(spec);
      if (tool) {
        violations.push(`${path}: no Sorage package may import the ecosystem tool ${tool}`);
      }
    }
  });
}

function checkAllowlistExportsAlignment(): void {
  const adaptersDir = join(root, "packages", "adapters");
  const adaptersManifestPath = join(adaptersDir, "package.json");
  // Minimal temporary fixtures omit package manifests; fail closed whenever the manifest exists.
  if (!existsSync(adaptersManifestPath)) return;

  const result = readPackageManifest(adaptersManifestPath);
  if (!result.ok) {
    violations.push(result.error);
    return;
  }
  if (!isExportsMap(result.manifest.exports)) {
    violations.push(`${adaptersManifestPath}: missing or invalid "exports" map`);
    return;
  }
  for (const [appName, entries] of Object.entries(APP_ADAPTERS_ALLOWLIST)) {
    for (const entry of entries) {
      const exportKey = `./${entry}`;
      const resolved = resolveExportTarget(adaptersDir, result.manifest.exports, exportKey);
      if (!resolved.ok) {
        violations.push(
          `${adaptersManifestPath}: allowlisted ${appName} entry "${entry}" (${exportKey}) does not resolve to an exported file (${resolved.reason})`,
        );
      }
    }
  }
}

for (const ws of enumerateWorkspaceDirectories(root)) {
  let pkgName = `@sorage/${ws.entry}`;
  if (existsSync(ws.manifestPath)) {
    const manifestResult = readPackageManifest(ws.manifestPath);
    if (manifestResult.ok && typeof manifestResult.manifest.name === "string" && manifestResult.manifest.name !== "") {
      pkgName = manifestResult.manifest.name;
    }
  }
  const allowed = IMPORT_RULES[pkgName];
  if (allowed !== undefined) {
    checkImportsForPackage(ws.dir, pkgName, allowed);
  }
}

checkAllowlistExportsAlignment();
const browserRoot = join(root, "apps/daemon/src/web");
if (existsSync(browserRoot)) {
  walkSourceFiles(browserRoot, (path) => {
    for (const match of stripComments(readFileSync(path, "utf8")).matchAll(IMPORT_SPEC_PATTERN)) {
      const spec = match[1];
      if (spec === undefined) continue;
      const withinBrowser = relative(browserRoot, resolve(dirname(path), spec));
      if (
        !(spec.startsWith("./") || spec.startsWith("../")) ||
        withinBrowser === ".." ||
        withinBrowser.startsWith("../")
      ) {
        violations.push(`${path}: browser source may import only relative modules within src/web, not ${spec}`);
      }
    }
  });
}

reportViolationsAndExit("import-boundary check failed:", violations);

console.log("import-boundary check passed: package import rules hold.");
