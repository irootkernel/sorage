import { homedir } from "node:os";
import { createNodeInboxMarkerPorts, isNodeInboxMarkerEnabled } from "@sorage/adapters/src/inbox-marker-ports";
import { createNodeProjectPorts } from "@sorage/adapters/src/project-command-ports";
import {
  type AddProjectOutcome,
  addProject,
  archiveProject,
  bindProject,
  type ListedProject,
  listProjects,
  rebindProject,
  reconcileReboundInboxMarker,
  renameProject,
  resolveCommandActor,
  resolveWorkspaceActor,
  showProject,
  successEnvelope,
  USER_ACTOR,
  unarchiveProject,
  unbindProject,
  workspaceKey,
} from "@sorage/core";
import type { Command } from "commander";
import {
  type OutputPorts,
  type ReportExitCode,
  refreshProjectMarker,
  renderAppError,
  requestId,
  requireInitialized,
  requireInitializedConfiguration,
  withPorts,
} from "../cli-output";
import { withCoveredRead } from "../covered-read";

/** The JSON view of one added Project: identity, first binding, and slug provenance. */
function renderAddedProject(outcome: AddProjectOutcome) {
  return {
    project: outcome.project,
    binding: outcome.binding,
    derivedSlug: outcome.derivedSlug,
  };
}

/** The JSON view of one listed Project; `unbound` is derived, never stored (PRJ-022). */
function renderListedProject(listed: ListedProject) {
  return {
    slug: listed.project.slug,
    displayName: listed.project.displayName,
    status: listed.project.status,
    bindingCount: listed.bindingCount,
    unbound: listed.unbound,
  };
}

export function registerProjectCommands(program: Command, ports: OutputPorts, reportExitCode: ReportExitCode): void {
  const project = program.command("project").description("register and inspect Projects and their bindings");

  project
    .command("add")
    .description("register a Project and its first directory binding")
    .requiredOption("--name <name>", "display name of the Project, in any script")
    .option("--slug <slug>", "explicit slug; defaults to the one derived from the display name")
    .requiredOption("--dir <path>", "working directory to bind, with ~ expansion")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const outcome = withPorts(
        createNodeProjectPorts({ contentionSurface: "project", configuration }),
        (commandPorts) => {
          const actor = resolveCommandActor(commandPorts, {
            path: process.cwd(),
            userHome: homedir(),
            as: typeof globals.as === "string" ? globals.as : undefined,
            asUser: globals.asUser === true,
          });
          if (!actor.ok) return actor;
          return addProject(commandPorts, {
            name: options.name,
            slug: options.slug,
            dir: options.dir,
            userHome: homedir(),
            actor: actor.value,
          });
        },
      );
      if (!outcome.ok) {
        reportExitCode(renderAppError(outcome.error, ports, json));
        return;
      }
      refreshProjectMarker(outcome.value.project.id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(renderAddedProject(outcome.value), requestId()), null, 2)}\n`);
      } else {
        ports.out(`Added Project ${outcome.value.project.slug} (${outcome.value.project.displayName})\n`);
        ports.out(`Bound ${outcome.value.binding.bindingKind} ${outcome.value.binding.directory}\n`);
      }
    });

  project
    .command("list")
    .description("list every Project with its binding count, flagging unbound Projects")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "project", (storage) => {
        const result = listProjects(createNodeProjectPorts({ database: storage.db, contentionSurface: "project" }));
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(
            `${JSON.stringify(successEnvelope(result.value.map(renderListedProject), requestId()), null, 2)}\n`,
          );
        } else {
          if (result.value.length === 0) ports.out("No Projects registered.\n");
          for (const listed of result.value) {
            const unbound = listed.unbound ? " (unbound)" : "";
            ports.out(`${listed.project.slug}${unbound} — ${listed.project.displayName} [${listed.project.status}]\n`);
            ports.out(`    bindings: ${listed.bindingCount}\n`);
          }
        }
      });
    });

  project
    .command("show")
    .description("show one Project with every binding, its counts, and its lifecycle state")
    .argument("<project>", "Project slug")
    .action((slug, _options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "project", (storage) => {
        const result = showProject(
          createNodeProjectPorts({ database: storage.db, contentionSurface: "project" }),
          slug,
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(
            `${JSON.stringify(
              successEnvelope(
                {
                  project: result.value.project,
                  bindings: result.value.bindings,
                  bindingCount: result.value.bindings.length,
                  unbound: result.value.project.status === "active" && result.value.bindings.length === 0,
                },
                requestId(),
              ),
              null,
              2,
            )}\n`,
          );
        } else {
          ports.out(
            `${result.value.project.slug} — ${result.value.project.displayName} [${result.value.project.status}]\n`,
          );
          if (result.value.bindings.length === 0) ports.out("  no bindings (unbound)\n");
          for (const binding of result.value.bindings) {
            ports.out(`  ${binding.bindingKind} ${binding.directory}\n`);
          }
        }
      });
    });

  project
    .command("rename")
    .description("change the display name; the slug is identity and is never renamed")
    .argument("<project>", "Project slug")
    .requiredOption("--name <name>", "the new display name")
    .action((slug, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(
        createNodeProjectPorts({ contentionSurface: "project", configuration }),
        (commandPorts) => {
          const actor = resolveCommandActor(commandPorts, {
            path: process.cwd(),
            userHome: homedir(),
            as: typeof globals.as === "string" ? globals.as : undefined,
            asUser: globals.asUser === true,
          });
          if (!actor.ok) return actor;
          return renameProject(commandPorts, { slug, name: options.name, actor: actor.value });
        },
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Renamed ${result.value.slug} to ${result.value.displayName}\n`);
      }
    });

  project
    .command("bind")
    .description("add another directory binding to a registered Project")
    .argument("<project>", "Project slug")
    .requiredOption("--dir <path>", "working directory to bind, with ~ expansion")
    .action((slug, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(
        createNodeProjectPorts({ contentionSurface: "project", configuration }),
        (commandPorts) => {
          const actor = resolveCommandActor(commandPorts, {
            path: process.cwd(),
            userHome: homedir(),
            as: typeof globals.as === "string" ? globals.as : undefined,
            asUser: globals.asUser === true,
          });
          if (!actor.ok) return actor;
          return bindProject(commandPorts, { slug, dir: options.dir, userHome: homedir(), actor: actor.value });
        },
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshProjectMarker(result.value.projectId, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Bound ${result.value.bindingKind} ${result.value.directory} to ${slug}\n`);
      }
    });

  project
    .command("unbind")
    .description("remove a directory binding; --confirm is required when open Handoffs would lose their binding")
    .argument("<project>", "Project slug")
    .requiredOption("--dir <path>", "the bound directory, with ~ expansion")
    .action((slug, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(
        createNodeProjectPorts({ contentionSurface: "project", configuration }),
        (commandPorts) => {
          const actor = resolveCommandActor(commandPorts, {
            path: process.cwd(),
            userHome: homedir(),
            as: typeof globals.as === "string" ? globals.as : undefined,
            asUser: globals.asUser === true,
          });
          if (!actor.ok) return actor;
          return unbindProject(commandPorts, {
            slug,
            dir: options.dir,
            userHome: homedir(),
            confirm: globals.confirm === true,
            actor: actor.value,
          });
        },
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Unbound ${result.value.directory} from ${slug}\n`);
      }
    });

  project
    .command("rebind")
    .description("replace one recorded Project binding with an existing directory")
    .argument("<project>", "Project slug")
    .requiredOption("--from <path>", "recorded binding path to replace")
    .requiredOption("--to <path>", "existing directory to bind")
    .action((slug, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(
        createNodeProjectPorts({ contentionSurface: "project", configuration }),
        (commandPorts) =>
          rebindProject(commandPorts, {
            slug,
            from: options.from,
            to: options.to,
            userHome: homedir(),
            actor: USER_ACTOR,
          }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (result.value.changed) {
        // The direct post-rebind marker reconciliation is advisory derived-view
        // refresh (SHR-015 category (ii)): a failure — including the failure to
        // create its ports — warns contained and never changes the committed
        // rebind's result.
        try {
          if (isNodeInboxMarkerEnabled({ configuration })) {
            const markerPorts = createNodeInboxMarkerPorts({ configuration });
            try {
              const refreshed = reconcileReboundInboxMarker(
                markerPorts,
                result.value.binding.projectId,
                result.value.previousBinding.directory,
                result.value.binding.directory,
              );
              if (!refreshed.ok) {
                try {
                  ports.err(`warning: ${refreshed.error.message}\n`);
                } catch {
                  // A diagnostic sink failure never changes the committed result.
                }
              }
            } finally {
              markerPorts.close();
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            ports.err(`warning: the rebound inbox marker could not be refreshed: ${message}\n`);
          } catch {
            // A diagnostic sink failure never changes the committed result.
          }
        }
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value.binding, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Rebound ${result.value.previousBinding.directory} to ${result.value.binding.directory}\n`);
      }
    });

  for (const [name, description, run] of [
    [
      "archive",
      "archive a Project: existing Handoffs remain available, new sends and receipts are refused",
      archiveProject,
    ],
    ["unarchive", "return an archived Project to active", unarchiveProject],
  ] as const) {
    project
      .command(name)
      .description(description)
      .argument("<project>", "Project slug")
      .action((slug: string, _options: unknown, command: Command) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
        if (configuration === null) return;
        const result = withPorts(
          createNodeProjectPorts({ contentionSurface: "project", configuration }),
          (commandPorts) => run(commandPorts, { slug }),
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        } else {
          ports.out(`${name === "archive" ? "Archived" : "Unarchived"} ${result.value.slug}\n`);
        }
      });
  }

  project
    .command("resolve")
    .description("print what the actor resolver would decide for a path, or for --as <project-slug>")
    .option("--path <path>", "the directory to resolve; defaults to the current working directory")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const resolved = withPorts(
        createNodeProjectPorts({ contentionSurface: "project", configuration }),
        (resolvePorts) => ({
          installationId: resolvePorts.installationId,
          result: resolveWorkspaceActor(resolvePorts, {
            path: typeof options.path === "string" && options.path !== "" ? options.path : process.cwd(),
            userHome: homedir(),
            as: globals.as,
          }),
        }),
      );
      const { result, installationId } = resolved;
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      const actor = result.value;
      if (json) {
        const payload =
          actor.kind === "unregistered_workspace"
            ? { ...actor, workspaceKey: workspaceKey(installationId, actor.directory) }
            : actor;
        ports.out(`${JSON.stringify(successEnvelope(payload, requestId()), null, 2)}\n`);
      } else if (actor.kind === "registered_project") {
        ports.out(`${actor.project.slug} (${actor.binding.bindingKind} ${actor.binding.directory})\n`);
      } else {
        ports.out(`unregistered workspace: ${actor.directory}\n`);
      }
    });
}
