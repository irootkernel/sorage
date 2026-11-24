// Enforces zero runtime circular dependencies across all four Sorage packages (ADR-0038, NFR-014).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  enumerateWorkspaceDirectories,
  isExportsMap,
  readPackageManifest,
  reportViolationsAndExit,
  resolveExportTarget,
  SOURCE_EXTENSIONS,
  walkSourceFiles,
} from "./workspace";

const root = resolve(process.argv[2] ?? ".");

interface WorkspacePackageInfo {
  readonly name: string;
  readonly dir: string;
  readonly hasManifest: boolean;
  readonly exports: Record<string, unknown> | null;
}

function relPath(filePath: string): string {
  return relative(root, filePath).split("\\").join("/");
}

const workspaceDirs = enumerateWorkspaceDirectories(root);
const packagesByName = new Map<string, WorkspacePackageInfo>();
const manifestErrors: string[] = [];

for (const ws of workspaceDirs) {
  const fallbackName = `@sorage/${ws.entry}`;
  if (!existsSync(ws.manifestPath)) {
    // Minimal temp fixtures omit workspace manifests; retain legacy fallback only when absent.
    packagesByName.set(fallbackName, {
      name: fallbackName,
      dir: ws.dir,
      hasManifest: false,
      exports: null,
    });
    continue;
  }

  const manifestResult = readPackageManifest(ws.manifestPath);
  if (!manifestResult.ok) {
    manifestErrors.push(`${relPath(ws.manifestPath)}: not parseable JSON`);
    packagesByName.set(fallbackName, {
      name: fallbackName,
      dir: ws.dir,
      hasManifest: true,
      exports: null,
    });
    continue;
  }

  const pkgName =
    typeof manifestResult.manifest.name === "string" && manifestResult.manifest.name.length > 0
      ? manifestResult.manifest.name
      : fallbackName;

  if (!isExportsMap(manifestResult.manifest.exports)) {
    manifestErrors.push(`${relPath(ws.manifestPath)}: missing or invalid "exports" map`);
    packagesByName.set(pkgName, {
      name: pkgName,
      dir: ws.dir,
      hasManifest: true,
      exports: null,
    });
    continue;
  }

  for (const key of Object.keys(manifestResult.manifest.exports).sort()) {
    const resolved = resolveExportTarget(ws.dir, manifestResult.manifest.exports, key);
    if (!resolved.ok) {
      const targetDisplay = resolved.target === undefined ? "(invalid)" : `"${resolved.target}"`;
      manifestErrors.push(
        `${relPath(ws.manifestPath)}: export "${key}" target ${targetDisplay} is invalid or missing (${resolved.reason})`,
      );
    }
  }

  packagesByName.set(pkgName, {
    name: pkgName,
    dir: ws.dir,
    hasManifest: true,
    exports: manifestResult.manifest.exports,
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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
  const pkg = packagesByName.get(pkgName);
  if (pkg === undefined) {
    return { resolved: null, internal: true };
  }
  const subpath = parts.slice(2).join("/");
  if (pkg.hasManifest) {
    // Fail closed when a package manifest is present: resolve strictly through its exports map.
    if (pkg.exports === null) {
      return { resolved: null, internal: true };
    }
    const exportKey = subpath === "" ? "." : `./${subpath}`;
    const result = resolveExportTarget(pkg.dir, pkg.exports, exportKey);
    return { resolved: result.ok ? result.path : null, internal: true };
  }
  if (subpath === "") {
    return { resolved: resolveCandidateFile(join(pkg.dir, "src", "index")), internal: true };
  }
  if (subpath.startsWith("src/")) {
    return { resolved: resolveCandidateFile(join(pkg.dir, subpath)), internal: true };
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

const files: string[] = [];
for (const ws of workspaceDirs) {
  walkSourceFiles(join(ws.dir, "src"), (file) => files.push(file));
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
function findStronglyConnectedCycles(adjacency: Map<string, Set<string>>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];

  function strongConnect(node: string): void {
    indices.set(node, nextIndex);
    lowlinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    const neighbors = [...(adjacency.get(node) ?? [])].sort();
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
        found.push(component.sort());
      } else if (component.length === 1 && adjacency.get(node)?.has(node)) {
        found.push([node, node]);
      }
    }
  }

  for (const node of [...adjacency.keys()].sort()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return found;
}

const cycles = findStronglyConnectedCycles(graph).map((component) => component.map(relPath).sort());

// Core inter-directory runtime DAG check (ADR-0038, TASK-166):
// Projects resolved runtime edges inside packages/core/src/<subdir>/** onto both
// leaf subdirectories (distinguishing backup vs backup/snapshot) and top-level
// subdirectories (rolling backup/snapshot up into backup), excluding root files
// such as index.ts and version.ts.
const coreSrcDir = resolve(root, "packages/core/src");

function coreSubdirectoryKeys(filePath: string): { leaf: string; top: string } | null {
  const rel = relative(coreSrcDir, filePath).split("\\").join("/");
  if (rel.startsWith("..") || !rel.includes("/")) return null;
  const leaf = rel.slice(0, rel.lastIndexOf("/"));
  const top = rel.slice(0, rel.indexOf("/"));
  return { leaf, top };
}

const coreLeafDirGraph = new Map<string, Set<string>>();
const coreTopDirGraph = new Map<string, Set<string>>();

function addDirEdge(targetGraph: Map<string, Set<string>>, fromDir: string, toDir: string): void {
  if (fromDir === toDir) return;
  let edges = targetGraph.get(fromDir);
  if (edges === undefined) {
    edges = new Set();
    targetGraph.set(fromDir, edges);
  }
  edges.add(toDir);
  if (!targetGraph.has(toDir)) {
    targetGraph.set(toDir, new Set());
  }
}

for (const [fromFile, targets] of graph.entries()) {
  const fromKeys = coreSubdirectoryKeys(fromFile);
  if (fromKeys === null) continue;
  for (const toFile of targets) {
    const toKeys = coreSubdirectoryKeys(toFile);
    if (toKeys === null) continue;
    addDirEdge(coreLeafDirGraph, fromKeys.leaf, toKeys.leaf);
    addDirEdge(coreTopDirGraph, fromKeys.top, toKeys.top);
  }
}

const coreLeafDirCycles = findStronglyConnectedCycles(coreLeafDirGraph);
const leafCycleKeys = new Set(coreLeafDirCycles.map((cycle) => cycle.join(" <-> ")));
const coreTopOnlyDirCycles = findStronglyConnectedCycles(coreTopDirGraph).filter(
  (cycle) => !leafCycleKeys.has(cycle.join(" <-> ")),
);

const allViolations = [
  ...manifestErrors,
  ...unresolvedErrors,
  ...cycles.map((cycle) => `runtime cycle: ${cycle.join(" <-> ")}`),
  ...coreLeafDirCycles.map((cycle) => `core directory cycle: ${cycle.join(" <-> ")}`),
  ...coreTopOnlyDirCycles.map((cycle) => `core directory cycle (top-level rollup): ${cycle.join(" <-> ")}`),
];

reportViolationsAndExit("cycle check failed:", allViolations);

console.log(
  `cycle check passed: zero runtime circular dependencies across ${String(files.length)} files and zero core directory cycles.`,
);
