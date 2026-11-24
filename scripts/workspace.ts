import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const WORKSPACE_GROUPS = ["packages", "apps"] as const;
export const DEPENDENCY_BLOCKS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
export const ECOSYSTEM_TOOLS = ["aquarium", "podway", "mulgae", "gaori", "sanho", "ouroboros", "dolgorae"] as const;
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * The composition surface an app may deep-import from `@sorage/adapters` (CLI-018): a
 * shipped process reaches SQLite and the Vault only through these command-port and
 * infrastructure modules, never the adapters root index, never `@sorage/adapters/testkit`,
 * and never test-support or raw storage implementation modules directly.
 */
export const APP_ADAPTERS_ALLOWLIST: Record<string, readonly string[]> = {
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
    "src/channel-command-ports",
    "src/exchange-command-ports",
    "src/memo-body-file",
    "src/preflight",
    "src/read-storage",
    "src/send-recovery",
    "src/sleep",
    "src/daemon-probes",
    "src/uninstall-ports",
    "src/wait-storage",
    "src/workspace-confinement",
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
    "src/logging",
    "src/handoff-command-ports",
    "src/read-storage",
    "src/project-command-ports",
    "src/vault-command-ports",
  ],
};

export type WorkspaceGroup = (typeof WORKSPACE_GROUPS)[number];
export type DependencyBlock = (typeof DEPENDENCY_BLOCKS)[number];

export interface WorkspaceDirectory {
  readonly group: WorkspaceGroup;
  readonly entry: string;
  readonly relDir: string;
  readonly dir: string;
  readonly manifestPath: string;
}

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

export type ManifestReadResult =
  | { readonly ok: true; readonly manifest: PackageManifest }
  | { readonly ok: false; readonly error: string };

export type ExportResolutionResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: "invalid-exports" | "unexported" | "invalid-target" | "outside-package" | "missing-target";
      readonly target?: string;
    };

export function enumerateWorkspaceDirectories(root: string): WorkspaceDirectory[] {
  const directories: WorkspaceDirectory[] = [];
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir).sort()) {
      const dir = join(groupDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      directories.push({
        group,
        entry,
        relDir: join(group, entry),
        dir,
        manifestPath: join(dir, "package.json"),
      });
    }
  }
  return directories;
}

export function enumerateManifestPaths(root: string): string[] {
  const manifestPaths = [join(root, "package.json")];
  for (const ws of enumerateWorkspaceDirectories(root)) {
    if (existsSync(ws.manifestPath)) {
      manifestPaths.push(ws.manifestPath);
    }
  }
  return manifestPaths;
}

export function readPackageManifest(manifestPath: string): ManifestReadResult {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `${manifestPath}: not parseable JSON` };
    }
    return { ok: true, manifest: parsed as PackageManifest };
  } catch {
    return { ok: false, error: `${manifestPath}: not parseable JSON` };
  }
}

export function isExportsMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveExportTarget(pkgDir: string, exportsField: unknown, exportKey: string): ExportResolutionResult {
  if (!isExportsMap(exportsField)) {
    return { ok: false, reason: "invalid-exports" };
  }
  if (!Object.hasOwn(exportsField, exportKey)) {
    return { ok: false, reason: "unexported" };
  }
  const rawTarget = exportsField[exportKey];
  if (typeof rawTarget !== "string" || !rawTarget.startsWith("./")) {
    return typeof rawTarget === "string"
      ? { ok: false, reason: "invalid-target", target: rawTarget }
      : { ok: false, reason: "invalid-target" };
  }
  const resolvedPkgDir = resolve(pkgDir);
  const resolvedTarget = resolve(resolvedPkgDir, rawTarget);
  const relToPkg = relative(resolvedPkgDir, resolvedTarget);
  if (relToPkg === "" || relToPkg.startsWith("..") || isAbsolute(relToPkg)) {
    return { ok: false, reason: "outside-package", target: rawTarget };
  }
  try {
    if (statSync(resolvedTarget).isFile()) {
      return { ok: true, path: resolvedTarget };
    }
  } catch {
    // Missing target is reported below.
  }
  return { ok: false, reason: "missing-target", target: rawTarget };
}

export function walkSourceFiles(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSourceFiles(full, visit);
    else if (SOURCE_EXTENSIONS.some((extension) => full.endsWith(extension))) visit(full);
  }
}

export function reportViolationsAndExit(
  header: string,
  violations: readonly string[],
  options?: { readonly indent?: string; readonly footer?: readonly string[] },
): void {
  if (violations.length === 0) return;
  const indent = options?.indent ?? "  ";
  console.error(header);
  for (const violation of violations) {
    console.error(`${indent}${violation}`);
  }
  for (const line of options?.footer ?? []) {
    console.error(line);
  }
  process.exit(1);
}
