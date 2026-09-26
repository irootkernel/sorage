import { createHash } from "node:crypto";
import { type AppError, appError, err, ok, type Result } from "./errors";
import { type ProjectCommandPorts, resolveWorkspaceActor, workspaceRootOf } from "./project-commands";

/**
 * Unregistered Workspace identity and the downgrade guard of section 22.3 (PRJ-013,
 * PRJ-014, PRJ-019). A Workspace that is registered as a Project later inherits sender
 * authority over the Handoffs it already sent, while the recorded sender kind and path
 * snapshot stay historically accurate (PRJ-015, PRJ-020); the snapshot storage itself
 * is the handoffs table of EPIC-005.
 */

/**
 * The stable key of one unregistered Workspace: the Installation identity and the
 * normalized real path hashed together, so the same directory under another
 * Installation is a different Workspace (PRJ-014).
 */
export function workspaceKey(installationId: string, normalizedPath: string): string {
  return createHash("sha256").update(`${installationId}\n${normalizedPath}`).digest("hex");
}

export type SenderIdentity =
  | { kind: "registered_project"; project: import("./projects").Project; binding: import("./projects").ProjectBinding }
  | { kind: "unregistered_workspace"; workspaceKey: string; pathSnapshot: string };

export interface SenderIdentityInput {
  path: string;
  userHome: string;
  installationId: string;
  allowUnregistered: boolean;
  as?: string | undefined;
}

/**
 * Resolves the sender identity for one send. A resolved Project is returned as-is; an
 * unregistered Workspace is checked against every binding's workspace root before it is
 * accepted: standing above a workspace root, or inside one while resolving to no
 * Project — the nested independent repository case — would silently demote a registered
 * sender, so it fails with SENDER_IDENTITY_DOWNGRADE unless `--allow-unregistered` was
 * supplied (PRJ-019). A worktree of a bound repository never reaches the guard, because
 * resolution folds it onto the bound common directory first.
 */
export function resolveSenderIdentity(
  ports: ProjectCommandPorts,
  input: SenderIdentityInput,
): Result<SenderIdentity, AppError> {
  const actor = resolveWorkspaceActor(ports, { path: input.path, userHome: input.userHome, as: input.as });
  if (!actor.ok) return actor;
  if (actor.value.kind === "registered_project") {
    return ok({ kind: "registered_project", project: actor.value.project, binding: actor.value.binding });
  }
  const directory = actor.value.directory;
  if (!input.allowUnregistered) {
    const bindings = ports.projects.listBindings();
    if (!bindings.ok) return bindings;
    const roots = bindings.value.map(workspaceRootOf);
    const aboveARoot = roots.some((root) => root === directory || root.startsWith(`${directory}/`));
    const insideAnUnresolvedRoot = roots.some((root) => directory.startsWith(`${root}/`));
    if (aboveARoot || insideAnUnresolvedRoot) {
      return err(
        appError(
          "SENDER_IDENTITY_DOWNGRADE",
          aboveARoot
            ? `the working directory '${directory}' is above a registered workspace; send from inside it, bind this directory, or pass --allow-unregistered`
            : `the working directory '${directory}' lies inside a registered workspace but resolves to no Project; pass --allow-unregistered to send anyway`,
          { directory },
        ),
      );
    }
  }
  return ok({
    kind: "unregistered_workspace",
    workspaceKey: workspaceKey(input.installationId, directory),
    pathSnapshot: directory,
  });
}
