import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Expands a leading `~` to the user's home directory, matching the CLI rule for
 * path options so workspace confinement and CLI file inputs agree exactly.
 */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export type CwdResolution = { ok: true; cwd: string } | { ok: false };

/** Layer 1: the call's workspace root must be an existing directory (MCP-004). */
export function resolveCallCwd(cwd: unknown): CwdResolution {
  if (cwd === undefined) return { ok: true, cwd: process.cwd() };
  if (typeof cwd !== "string" || cwd === "") return { ok: false };
  try {
    if (!statSync(cwd).isDirectory()) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, cwd };
}

/**
 * The real path of `path`, following every existing component of its chain;
 * for a not-yet-existing target the nearest existing ancestor's real path
 * plus the remaining segments, so a symlinked ancestor cannot smuggle a
 * target past the containment comparison (SEC-006, as `import-source.ts`).
 */
export function realPathOf(path: string): string {
  let probe = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length === 0 ? real : `${real}/${tail.join("/")}`;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return path;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

export function isInsideWorkspace(workspaceRoot: string, resolvedPath: string): boolean {
  const rel = relative(realpathSync(workspaceRoot), realPathOf(resolvedPath));
  // A leading `..` segment escapes; a confined filename that merely begins
  // with two dots (`..draft.md`) does not.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export type Confinement =
  | { ok: true; realPath: string; tildeExpanded: string }
  | { ok: false; resolvedPath: string; workspaceRoot: string };

/**
 * MCP-004's confinement check on real paths: expand the tilde exactly as the
 * CLI does, resolve against the workspace root, and compare real path against
 * real path with the prefix rule expressed through `path.relative` — correct
 * at the filesystem root too. An inside-but-nonexistent path passes, so the
 * child returns the CLI's typed missing-source error.
 */
export function confineFileArgument(workspaceRoot: string, argument: string): Confinement {
  const tildeExpanded = expandTilde(argument);
  const resolvedPath = resolve(workspaceRoot, tildeExpanded);
  if (!isInsideWorkspace(workspaceRoot, resolvedPath)) {
    return { ok: false, resolvedPath, workspaceRoot: realpathSync(workspaceRoot) };
  }
  return { ok: true, realPath: realPathOf(resolvedPath), tildeExpanded };
}
