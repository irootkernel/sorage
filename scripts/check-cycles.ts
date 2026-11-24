// Enforces zero runtime circular dependencies across all four Sorage packages (ADR-0038, NFR-014).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const PACKAGES: ReadonlyArray<{ name: string; relDir: string }> = [
  { name: "@sorage/core", relDir: "packages/core" },
  { name: "@sorage/adapters", relDir: "packages/adapters" },
  { name: "@sorage/cli", relDir: "apps/cli" },
  { name: "@sorage/daemon", relDir: "apps/daemon" },
];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

const root = resolve(process.argv[2] ?? ".");
const packageDirs = new Map<string, string>(PACKAGES.map((pkg) => [pkg.name, resolve(root, pkg.relDir)]));

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
  }
}

function resolveCandidateFile(base: string): string | null {
  if (SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) && isFile(base)) return base;
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (isFile(candidate)) return candidate;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const indexCandidate = join(base, `index${ext}`);
    if (isFile(indexCandidate)) return indexCandidate;
  }
  return null;
}

function resolveInternalSpecifier(fromFile: string, spec: string): { resolved: string | null; internal: boolean } {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    return { resolved: resolveCandidateFile(resolve(dirname(fromFile), spec)), internal: true };
  }
  if (!spec.startsWith("@sorage/")) {
    return { resolved: null, internal: false };
  }
  const parts = spec.split("/");
  const pkgName = parts.slice(0, 2).join("/");
  const pkgDir = packageDirs.get(pkgName);
  if (pkgDir === undefined) {
    return { resolved: null, internal: true };
  }
  const subpath = parts.slice(2).join("/");
  if (subpath === "") {
    return { resolved: resolveCandidateFile(join(pkgDir, "src", "index")), internal: true };
  }
  if (subpath.startsWith("src/")) {
    return { resolved: resolveCandidateFile(join(pkgDir, subpath)), internal: true };
  }
  return { resolved: null, internal: true };
}

function specifierText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function extractRuntimeSpecifiers(filePath: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = specifierText(node.moduleSpecifier);
      if (spec !== null) {
        const clause = node.importClause;
        if (clause === undefined) {
          // Side-effect import: `import "./x"`.
          specifiers.push(spec);
        } else if (!clause.isTypeOnly) {
          const hasDefault = clause.name !== undefined;
          const bindings = clause.namedBindings;
          const hasRuntimeBindings =
            bindings === undefined
              ? false
              : ts.isNamespaceImport(bindings)
                ? true
                : bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
          if (hasDefault || hasRuntimeBindings) {
            specifiers.push(spec);
          }
        }
      }
      return;
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && !node.isTypeOnly) {
        const spec = specifierText(node.moduleSpecifier);
        if (spec !== null) {
          const clause = node.exportClause;
          const isRuntime =
            clause === undefined ||
            ts.isNamespaceExport(clause) ||
            clause.elements.length === 0 ||
            clause.elements.some((element) => !element.isTypeOnly);
          if (isRuntime) {
            specifiers.push(spec);
          }
        }
      }
      return;
    }

    if (ts.isImportTypeNode(node)) {
      // `import("x").T` is type-only; do not descend into it.
      return;
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const firstArg = node.arguments[0];
      if (firstArg !== undefined) {
        const spec = specifierText(firstArg);
        if (spec !== null) {
          specifiers.push(spec);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function relPath(filePath: string): string {
  return relative(root, filePath).split("\\").join("/");
}

const files: string[] = [];
for (const pkg of PACKAGES) {
  walk(join(root, pkg.relDir, "src"), files);
}
files.sort();

const graph = new Map<string, Set<string>>();
for (const file of files) {
  graph.set(file, new Set());
}

const unresolvedErrors: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const edges = graph.get(file) as Set<string>;
  for (const spec of extractRuntimeSpecifiers(file, text)) {
    const result = resolveInternalSpecifier(file, spec);
    if (!result.internal) continue;
    if (result.resolved === null) {
      unresolvedErrors.push(`${relPath(file)}: unresolved internal specifier "${spec}"`);
      continue;
    }
    edges.add(result.resolved);
    if (!graph.has(result.resolved)) {
      graph.set(result.resolved, new Set());
    }
  }
}

// Tarjan's strongly connected components algorithm.
let nextIndex = 0;
const indices = new Map<string, number>();
const lowlinks = new Map<string, number>();
const onStack = new Set<string>();
const stack: string[] = [];
const cycles: string[][] = [];

function strongConnect(node: string): void {
  indices.set(node, nextIndex);
  lowlinks.set(node, nextIndex);
  nextIndex += 1;
  stack.push(node);
  onStack.add(node);

  const neighbors = [...(graph.get(node) ?? [])].sort();
  for (const neighbor of neighbors) {
    if (!indices.has(neighbor)) {
      strongConnect(neighbor);
      lowlinks.set(node, Math.min(lowlinks.get(node) as number, lowlinks.get(neighbor) as number));
    } else if (onStack.has(neighbor)) {
      lowlinks.set(node, Math.min(lowlinks.get(node) as number, indices.get(neighbor) as number));
    }
  }

  if (lowlinks.get(node) === indices.get(node)) {
    const component: string[] = [];
    for (;;) {
      const member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) {
      cycles.push(component.map(relPath).sort());
    } else if (component.length === 1 && graph.get(node)?.has(node)) {
      cycles.push([relPath(node), relPath(node)]);
    }
  }
}

for (const node of [...graph.keys()].sort()) {
  if (!indices.has(node)) strongConnect(node);
}

if (unresolvedErrors.length > 0 || cycles.length > 0) {
  console.error("cycle check failed:");
  for (const error of unresolvedErrors) {
    console.error(`  ${error}`);
  }
  for (const cycle of cycles) {
    console.error(`  runtime cycle: ${cycle.join(" <-> ")}`);
  }
  process.exit(1);
}

console.log(`cycle check passed: zero runtime circular dependencies across ${String(files.length)} files.`);
