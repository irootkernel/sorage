import { type AppError, appError, err, ok, type Result } from "../shared/errors";
import { workspaceKey } from "../primitives/identity";
import { type ProjectResolutionPorts, resolveWorkspaceActor, workspaceRootOf } from "./project-commands";

/**
 * Unregistered Workspace identity and the downgrade guard of section 22.3 (PRJ-013,
 * PRJ-014, PRJ-019). A Workspace that is registered as a Project later inherits sender
 * authority over the Handoffs it already sent, while the recorded sender kind and path
 * snapshot stay historically accurate (PRJ-015, PRJ-020); the snapshot storage itself
 * is the handoffs table of EPIC-005.
 */

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
  ports: ProjectResolutionPorts,
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

export interface CommitSenderBindingFact {
  id: string;
  projectId: string;
  directory: string;
  bindingKind: string;
  slug: string;
  status: string;
}

export type CommitRegisteredSender =
  | { projectId: string; asOverride: true }
  | { projectId: string; asOverride: false; bindingId: string; directory: string; gitCommonDirectory: string | null };

export interface CommitUnregisteredSenderPath {
  directory: string;
  gitCommonDirectory: string | null;
  allowUnregistered: boolean;
}

export interface CommitSenderCheck {
  registeredSender?: CommitRegisteredSender | undefined;
  unregisteredSenderPath?: CommitUnregisteredSenderPath | undefined;
}

function posixParentDirectory(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return trimmed.slice(0, lastSlash);
}

function atOrBelowRootSafe(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function matchDirectoryOwner(
  bindings: readonly CommitSenderBindingFact[],
  directory: string,
): CommitSenderBindingFact | undefined {
  return bindings
    .filter(
      (row) =>
        row.bindingKind === "directory" && (directory === row.directory || directory.startsWith(`${row.directory}/`)),
    )
    .sort((a, b) => b.directory.length - a.directory.length)[0];
}

/**
 * Revalidates a prepared Handoff sender's Project or Workspace identity against
 * the current binding snapshot at commit time (PRJ-019, PRJ-021, PRJ-022).
 */
export function revalidateSenderAtCommit(
  bindings: readonly CommitSenderBindingFact[],
  sender: CommitSenderCheck,
): Result<void, AppError> {
  if (sender.registeredSender !== undefined) {
    const registered = sender.registeredSender;
    if (registered.asOverride) {
      if (!bindings.some((row) => row.projectId === registered.projectId)) {
        return err(
          appError("PROJECT_UNBOUND", "the sender Project lost its last binding while the Handoff was prepared"),
        );
      }
    } else {
      const gitOwner = bindings.find(
        (row) => row.bindingKind === "git_repository" && row.directory === registered.gitCommonDirectory,
      );
      const directoryOwner = matchDirectoryOwner(bindings, registered.directory);
      const owner = gitOwner ?? directoryOwner;
      if (owner?.id !== registered.bindingId || owner.projectId !== registered.projectId) {
        return err(
          owner?.status === "archived"
            ? appError(
                "PROJECT_ARCHIVED",
                "the sender path changed to an archived Project while the Handoff was prepared",
                {
                  slug: owner.slug,
                },
              )
            : appError(
                "SENDER_IDENTITY_DOWNGRADE",
                "the sender path changed Project identity while the Handoff was prepared; retry the send",
                {
                  slug: owner?.slug,
                },
              ),
        );
      }
    }
  }
  if (sender.unregisteredSenderPath !== undefined) {
    const { directory, gitCommonDirectory, allowUnregistered } = sender.unregisteredSenderPath;
    const gitOwner = bindings.find(
      (row) => row.bindingKind === "git_repository" && row.directory === gitCommonDirectory,
    );
    const directoryOwner = matchDirectoryOwner(bindings, directory);
    const owner = gitOwner ?? directoryOwner;
    const unresolvedRoot = bindings.find((row) => {
      const root = row.bindingKind === "directory" ? row.directory : posixParentDirectory(row.directory);
      return atOrBelowRootSafe(root, directory) || atOrBelowRootSafe(directory, root);
    });
    if (owner !== undefined || (!allowUnregistered && unresolvedRoot !== undefined)) {
      return err(
        owner?.status === "archived"
          ? appError("PROJECT_ARCHIVED", "the sender Project was archived while the Handoff was prepared", {
              slug: owner.slug,
            })
          : appError(
              "SENDER_IDENTITY_DOWNGRADE",
              "the sender Workspace overlapped a registered Project while the Handoff was prepared; retry the send",
              { slug: (owner ?? unresolvedRoot)?.slug },
            ),
      );
    }
  }
  return ok(undefined);
}
