// Enforces the package import rules of docs/implementation-tips/README.md section 2 and the
// rule that no `await` appears inside a `UnitOfWork.run` callback (NFR-014).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Package name -> packages whose imports it may reference.
const IMPORT_RULES: Record<string, string[]> = {
  "@sorage/core": [],
  "@sorage/adapters": ["@sorage/core"],
  "@sorage/cli": ["@sorage/core", "@sorage/adapters", "@sorage/daemon"],
  "@sorage/daemon": ["@sorage/core", "@sorage/adapters"],
  "@sorage/web": ["@sorage/core"],
};

/**
 * The composition surface an app may deep-import from `@sorage/adapters` (CLI-018): a
 * shipped process reaches SQLite and the Vault only through these command-port and
 * infrastructure modules, never the adapters index (which also exports the vitest-only
 * testkit) and never a storage implementation module directly.
 */
const APP_ADAPTERS_ALLOWLIST: Record<string, readonly string[]> = {
  "@sorage/cli": [
    "src/backup-command-ports",
    "src/config-command-ports",
    "src/daemon-command-ports",
    "src/token-store",
    "src/inbox-marker-ports",
    "src/doctor",
    "src/home",
    "src/init-ports",
    "src/launchagent-ports",
    "src/logging",
    "src/handoff-command-ports",
    "src/project-command-ports",
    "src/vault-command-ports",
    "src/import-source",
    "src/memo-command-ports",
    "src/memo-body-file",
    "src/sleep",
  ],
  "@sorage/daemon": [
    "src/memo-command-ports",
    "src/backup-command-ports",
    "src/config-command-ports",
    "src/daemon-command-ports",
    "src/token-store",
    "src/inbox-marker-ports",
    "src/doctor",
    "src/home",
    "src/init-ports",
    "src/logging",
    "src/handoff-command-ports",
    "src/project-command-ports",
    "src/vault-command-ports",
    "src/import-source",
    "src/sleep",
  ],
};

const ECOSYSTEM_PACKAGES = ["aquarium", "podway", "mulgae", "gaori", "sanho", "ouroboros", "dolgorae"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const IMPORT_SPEC_PATTERN = /(?:from\s*|import\s*|import\(\s*|require\(\s*)["']([^"']+)["']/g;

const root = process.argv[2] ?? ".";
const violations: string[] = [];

function walk(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, visit);
    else if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) visit(path);
  }
}

// Removes comments so scanners cannot match on prose; string literal contents survive
// because import specifiers themselves are quoted.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// Additionally blanks string literal contents so the UnitOfWork scanner cannot match
// the word await inside a quoted value.
function stripStrings(text: string): string {
  return text
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function ecosystemToolFor(spec: string): string | null {
  for (const tool of ECOSYSTEM_PACKAGES) {
    if (new RegExp(`(^|/)@?${tool}(/|$)|(^|/)@?${tool}-`).test(spec)) return tool;
  }
  return null;
}

function checkImportsForPackage(pkgDir: string, pkgName: string, allowed: string[]): void {
  walk(join(pkgDir, "src"), (path) => {
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

function checkAwaitInUnitOfWork(pkgDir: string): void {
  walk(join(pkgDir, "src"), (path) => {
    const text = stripStrings(stripComments(readFileSync(path, "utf8")));
    const pattern = /\bUnitOfWork\.run\s*\(/g;
    for (const match of text.matchAll(pattern)) {
      const openParen = match.index + match[0].length - 1;
      let depth = 0;
      for (let i = openParen; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") {
          depth--;
          if (depth === 0) {
            const body = text.slice(openParen, i);
            if (/\bawait\b/.test(body)) {
              violations.push(`${path}: await is forbidden inside a UnitOfWork.run callback`);
            }
            break;
          }
        }
      }
    }
  });
}

for (const [pkgName, allowed] of Object.entries(IMPORT_RULES)) {
  const pkgDir = join(root, "packages", pkgName.replace("@sorage/", ""));
  const appDir = join(root, "apps", pkgName.replace("@sorage/", ""));
  const dir = existsSync(pkgDir) ? pkgDir : appDir;
  checkImportsForPackage(dir, pkgName, allowed);
  checkAwaitInUnitOfWork(dir);
}

if (violations.length > 0) {
  console.error("import-boundary check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("import-boundary check passed: package import rules and the UnitOfWork await rule hold.");
