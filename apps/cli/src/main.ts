import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDoctorPorts } from "@sorage/adapters/src/doctor";
// Deep import: the adapters index also exports the testkit, which is vitest-only and
// must never load inside the shipped CLI process.
import {
  createNodeHandoffReadPorts,
  createNodeRetentionPorts,
  createNodeReviewPorts,
  createNodeRevisionPorts,
  createNodeSendPorts,
  createNodeTerminalPorts,
} from "@sorage/adapters/src/handoff-command-ports";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { inspectSourceFile } from "@sorage/adapters/src/import-source";
// Deep import: the adapters index also exports the testkit, which is vitest-only and
// must never load inside the shipped CLI process.
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createLogger, type Logger } from "@sorage/adapters/src/logging";
import { createNodeProjectPorts } from "@sorage/adapters/src/project-command-ports";
import { createNodeInboxMarkerPorts } from "@sorage/adapters/src/inbox-marker-ports";
import { blockingSleepMs } from "@sorage/adapters/src/sleep";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  type ActorRef,
  type AddProjectOutcome,
  type AppError,
  acceptHandoff,
  addProject,
  appError,
  approveDeletion,
  archiveHandoff,
  archiveProject,
  bindProject,
  type DoctorReport,
  declineHandoff,
  type Envelope,
  editConfiguration,
  errorEnvelope,
  errorSpec,
  fetchHandoff,
  getHandoff,
  hasBlockingCheck,
  initializeInstallation,
  type ListedProject,
  listInbox,
  listOutbox,
  listProjects,
  moveVault,
  pinHandoff,
  protocolVersion,
  rejectDeletion,
  removeReviewNote,
  renameProject,
  requestDeletion,
  resolveCommandActor,
  resolveWorkspaceActor,
  reviseHandoff,
  runDoctor,
  sendHandoffs,
  setConfigurationValue,
  setReviewNote,
  showConfiguration,
  showProject,
  successEnvelope,
  USER_ACTOR,
  unarchiveHandoff,
  unarchiveProject,
  unbindProject,
  unpinHandoff,
  validateConfigurationFile,
  vaultStatus,
  vaultVerify,
  refreshInboxMarker,
  waitForNewInboxItems,
  withdrawHandoff,
  withdrawReviewNote,
  workspaceKey,
} from "@sorage/core";
import { buildCompletionScript } from "./completion";
import { Command, InvalidArgumentError } from "commander";

export const CLI_NAME = "sorage" as const;
export const CLI_VERSION = "0.0.0" as const;

export interface GlobalOptions {
  as?: string;
  asUser: boolean;
  confirm: boolean;
  expectedRowVersion?: number;
  limit?: number;
  cursor?: string;
  json: boolean;
}

/** Standard-output and standard-error sinks, injectable for the golden harness. */
export interface OutputPorts {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultPorts: OutputPorts = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Deterministic request identifiers for golden tests; never set in production. */
const GOLDEN_REQUEST_ID = process.env.SORAGE_TEST_REQUEST_ID;

function requestId(): string {
  return GOLDEN_REQUEST_ID ?? randomUUID();
}

function parseInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("expected a non-negative integer");
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new InvalidArgumentError("expected a non-negative integer");
  }
  return parsed;
}

/** Collects a repeatable option value, so `--to a --to b` becomes ["a", "b"]. */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...(previous ?? []), value];
}

/** Runs one CLI action and remembers its exit code for `runCli` to return. */
type ReportExitCode = (code: number) => void;

export function buildProgram(ports: OutputPorts = defaultPorts, reportExitCode: ReportExitCode = () => {}): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description("Local document-handoff broker for AI coding sessions.")
    .option("--as <project-slug>", "resolve the acting Project by slug instead of the working directory")
    .option(
      "--as-user",
      "assert the local User as the actor for a User-admin operation; User-admin rows express workflow intent, and any process able to run the CLI as this operating-system user can assert User context",
    )
    .option("--confirm", "confirm a state-conditional operation")
    .option("--expected-row-version <n>", "compare-and-set against this Row Version", parseInteger)
    .option("--limit <n>", "page size for list commands", parseInteger)
    .option("--cursor <cursor>", "resume a listing from an opaque cursor")
    .option("--json", "emit the versioned JSON envelope on standard output");

  program
    .command("version")
    .description("print the CLI, product, and protocol versions")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (json) {
        ports.out(
          `${JSON.stringify(successEnvelope({ cli: CLI_NAME, version: CLI_VERSION, protocolVersion: protocolVersion() }, requestId()), null, 2)}\n`,
        );
      } else {
        ports.out(`${CLI_NAME} ${CLI_VERSION} (protocol ${protocolVersion()})\n`);
      }
    });

  program
    .command("init")
    .description("create the Sorage installation: home tree, configuration, database, and Vault")
    .option("--vault <path>", "Vault directory; defaults to ~/.sorage/vault")
    .option("--non-interactive", "never prompt; missing answers use the documented defaults")
    .option("--reconfigure", "explicitly repair or backfill an existing installation")
    .action((options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (options.nonInteractive !== true) {
        ports.err(`${CLI_NAME}: the interactive wizard arrives in milestone 0.3; pass --non-interactive\n`);
        ports.err(`Run '${CLI_NAME} --help' for usage.\n`);
        reportExitCode(2);
        return;
      }
      // A relative --vault resolves against the cwd once, so the recorded path and
      // every later probe agree no matter where subsequent commands run from.
      const vaultOption =
        typeof options.vault === "string" && options.vault.trim() !== "" && !isAbsolute(options.vault)
          ? resolve(options.vault)
          : typeof options.vault === "string"
            ? options.vault
            : undefined;
      const result = initializeInstallation(createNodeInitPorts(), {
        vaultPath: vaultOption,
        reconfigure: options.reconfigure === true,
      });
      if (!result.ok) {
        // A malformed configuration routes to the doctor, which names every defect.
        reportExitCode(
          renderAppError(
            result.error,
            ports,
            json,
            result.error.code === "CONFIG_INVALID" ? "sorage doctor" : undefined,
          ),
        );
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else if (result.value.outcome === "created") {
        ports.out(`Initialized Sorage at ${result.value.home}\n`);
        ports.out(`Installation: ${result.value.installationId}\n`);
        ports.out(`Vault: ${result.value.vaultPath}\n`);
      } else {
        ports.out(`Sorage is already initialized at ${result.value.home}\n`);
        ports.out(`Installation: ${result.value.installationId}\n`);
        ports.out(`Vault: ${result.value.vaultPath}\n`);
        ports.out(`Nothing was changed; run '${CLI_NAME} init --reconfigure --non-interactive' for explicit repair.\n`);
      }
    });

  const config = program.command("config").description("inspect and change the installation configuration");

  config
    .command("show")
    .description("print the effective configuration exactly as declared in config.yaml")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = showConfiguration(createNodeConfigCommandPorts());
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      else {
        const text = createNodeConfigCommandPorts().store.readText();
        ports.out(text === null ? "" : `${text.endsWith("\n") ? text : `${text}\n`}`);
      }
    });

  config
    .command("validate")
    .description("validate config.yaml against the schema and report every issue")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = validateConfigurationFile(createNodeConfigCommandPorts());
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json)
        ports.out(
          `${JSON.stringify(successEnvelope({ valid: true, path: result.value.path }, requestId()), null, 2)}\n`,
        );
      else ports.out(`Configuration is valid: ${result.value.path}\n`);
    });

  config
    .command("set")
    .description("set one configuration leaf through the atomic comment-preserving store")
    .argument("<key>", "the dotted configuration key, for example server.port")
    .argument("<value>", "the value written verbatim for strings, as integers or booleans otherwise")
    .option("--expected-revision <n>", "compare-and-set against this configRevision", parseInteger)
    .action((key, value, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = setConfigurationValue(createNodeConfigCommandPorts(), {
        key,
        rawValue: value,
        asUser: globals.asUser === true,
        expectedRevision: options.expectedRevision,
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(
          `Set ${result.value.key} = ${String(result.value.value)} (configRevision ${result.value.configRevision})\n`,
        );
      }
    });

  config
    .command("edit")
    .description("open config.yaml in $EDITOR and adopt the result through the atomic store")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = editConfiguration(createNodeConfigCommandPorts(), { asUser: globals.asUser === true });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else if (result.value.outcome === "changed") {
        ports.out(`Configuration updated (configRevision ${result.value.configRevision})\n`);
      } else {
        ports.out(`No changes (configRevision ${result.value.configRevision})\n`);
      }
    });

  program
    .command("doctor")
    .description("run the milestone-scoped installation checks and report the catalog")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      const doctorPorts = createNodeDoctorPorts();
      const report = runDoctor(doctorPorts, createNodeConfigCommandPorts().configFile);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(report, requestId()), null, 2)}\n`);
      } else {
        renderDoctorReport(report, ports);
      }
      reportExitCode(hasBlockingCheck(report) ? 1 : 0);
    });

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
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const commandPorts = createNodeProjectPorts();
      const actor = resolveCommandActor(commandPorts, {
        path: process.cwd(),
        userHome: homedir(),
        as: typeof globals.as === "string" ? globals.as : undefined,
        asUser: globals.asUser === true,
      });
      if (!actor.ok) {
        reportExitCode(renderAppError(actor.error, ports, json));
        return;
      }
      const result = addProject(commandPorts, {
        name: options.name,
        slug: options.slug,
        dir: options.dir,
        userHome: homedir(),
        actor: actor.value,
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(renderAddedProject(result.value), requestId()), null, 2)}\n`);
      } else {
        ports.out(`Added Project ${result.value.project.slug} (${result.value.project.displayName})\n`);
        ports.out(`Bound ${result.value.binding.bindingKind} ${result.value.binding.directory}\n`);
      }
    });

  project
    .command("list")
    .description("list every Project with its binding count, flagging unbound Projects")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = listProjects(createNodeProjectPorts());
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value.map(renderListedProject), requestId()), null, 2)}\n`);
      } else {
        if (result.value.length === 0) ports.out("No Projects registered.\n");
        for (const listed of result.value) {
          const unbound = listed.unbound ? " (unbound)" : "";
          ports.out(`${listed.project.slug}${unbound} — ${listed.project.displayName} [${listed.project.status}]\n`);
          ports.out(`    bindings: ${listed.bindingCount}\n`);
        }
      }
    });

  project
    .command("show")
    .description("show one Project with every binding, its counts, and its lifecycle state")
    .argument("<project>", "Project slug")
    .action((slug, _options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = showProject(createNodeProjectPorts(), slug);
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
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

  project
    .command("rename")
    .description("change the display name; the slug is identity and is never renamed")
    .argument("<project>", "Project slug")
    .requiredOption("--name <name>", "the new display name")
    .action((slug, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const commandPorts = createNodeProjectPorts();
      const actor = resolveCommandActor(commandPorts, {
        path: process.cwd(),
        userHome: homedir(),
        as: typeof globals.as === "string" ? globals.as : undefined,
        asUser: globals.asUser === true,
      });
      if (!actor.ok) {
        reportExitCode(renderAppError(actor.error, ports, json));
        return;
      }
      const result = renameProject(commandPorts, { slug, name: options.name, actor: actor.value });
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
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const commandPorts = createNodeProjectPorts();
      const actor = resolveCommandActor(commandPorts, {
        path: process.cwd(),
        userHome: homedir(),
        as: typeof globals.as === "string" ? globals.as : undefined,
        asUser: globals.asUser === true,
      });
      if (!actor.ok) {
        reportExitCode(renderAppError(actor.error, ports, json));
        return;
      }
      const result = bindProject(commandPorts, { slug, dir: options.dir, userHome: homedir(), actor: actor.value });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
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
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const commandPorts = createNodeProjectPorts();
      const actor = resolveCommandActor(commandPorts, {
        path: process.cwd(),
        userHome: homedir(),
        as: typeof globals.as === "string" ? globals.as : undefined,
        asUser: globals.asUser === true,
      });
      if (!actor.ok) {
        reportExitCode(renderAppError(actor.error, ports, json));
        return;
      }
      const result = unbindProject(commandPorts, {
        slug,
        dir: options.dir,
        userHome: homedir(),
        confirm: globals.confirm === true,
        actor: actor.value,
      });
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

  for (const [name, description, run] of [
    [
      "archive",
      "archive a Project: its existing inbox keeps working, new incoming Handoffs are refused",
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
        if (!requireInitialized(ports, json, reportExitCode)) return;
        if (globals.asUser !== true) {
          reportExitCode(
            renderAppError(
              {
                code: "USER_CONTEXT_REQUIRED",
                message: `Project ${name} is a User administration operation.`,
              },
              ports,
              json,
            ),
          );
          return;
        }
        const result = run(createNodeProjectPorts(), { slug, actor: USER_ACTOR });
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
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const resolvePorts = createNodeProjectPorts();
      const result = resolveWorkspaceActor(resolvePorts, {
        path: typeof options.path === "string" && options.path !== "" ? options.path : process.cwd(),
        userHome: homedir(),
        as: globals.as,
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      const actor = result.value;
      if (json) {
        const payload =
          actor.kind === "unregistered_workspace"
            ? { ...actor, workspaceKey: workspaceKey(resolvePorts.installationId, actor.directory) }
            : actor;
        ports.out(`${JSON.stringify(successEnvelope(payload, requestId()), null, 2)}\n`);
      } else if (actor.kind === "registered_project") {
        ports.out(`${actor.project.slug} (${actor.binding.bindingKind} ${actor.binding.directory})\n`);
      } else {
        ports.out(`unregistered workspace: ${actor.directory}\n`);
      }
    });

  program
    .command("send")
    .description("hand one current document to one or more recipient Projects, one Handoff each")
    .requiredOption("--to <project>", "recipient Project slug; repeat for a fan-out", collectRepeatable, [])
    .requiredOption("--title <title>", "the Handoff title, in any script")
    .option("--file <path>", "the document to hand over, with ~ expansion")
    .option("--body <text>", "inline Markdown text materialized as the document")
    .option("--supersedes <handoff-id>", "link this Handoff to a terminal predecessor")
    .option("--allow-external-source", "import a source outside the resolved sender workspace")
    .option("--allow-unregistered", "send as an unregistered Workspace despite the downgrade guard")
    .option("--idempotency-key <uuid>", "replay an identical send instead of creating a new one")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if ((options.file === undefined) === (options.body === undefined)) {
        ports.err("sorage: send takes exactly one of --file or --body\n");
        ports.err("Run 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (options.body !== undefined && options.body.trim() === "") {
        ports.err("sorage: the --body text must not be empty\n");
        ports.err("Run 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      // RUN-002: an intent-recording command drains at start before it creates anything.
      const vaultPorts = createNodeVaultCommandPorts();
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const result = sendHandoffs(createNodeSendPorts(), {
        to: options.to as string[],
        title: options.title,
        file: options.file,
        body: options.body,
        supersedes: options.supersedes,
        allowExternalSource: options.allowExternalSource === true,
        allowUnregistered: options.allowUnregistered === true,
        idempotencyKey: options.idempotencyKey,
        path: process.cwd(),
        userHome: homedir(),
        as: typeof globals.as === "string" ? globals.as : undefined,
        asUser: globals.asUser === true,
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      for (const handoff of result.value.handoffs) {
        refreshMarker(handoff.handoffId, ports);
      }
      if (json) {
        ports.out(
          `${JSON.stringify(successEnvelope({ handoffs: result.value.handoffs, dispatchGroupId: result.value.dispatchGroupId, replayed: result.value.replayed }, requestId()), null, 2)}
`,
        );
      } else {
        for (const handoff of result.value.handoffs) {
          ports.out(`Handoff ${handoff.handoffId} → ${handoff.recipientSlug} (revision 1, awaiting_recipient)
`);
        }
        if (result.value.dispatchGroupId !== null) {
          ports.out(`Dispatch group ${result.value.dispatchGroupId} (${result.value.handoffs.length} Handoffs)
`);
        }
        if (result.value.replayed) {
          ports.out("Replayed the recorded idempotent send\n");
        }
      }
    });

  program
    .command("inbox")
    .description("list the Handoffs sent to the resolved recipient Project")
    .option("--state <state>", "filter by review state")
    .option("--sender <slug>", "filter by sender Project slug")
    .option("--recipient <slug>", "filter by recipient Project slug")
    .option("--include-archived", "include archived Handoffs")
    .option("--include-deleted", "include tombstones")
    .option("--wait", "poll until a new inbox item appears for the resolved actor, then list it")
    .option("--interval <s>", "seconds between two waits' polls; the default is 2", parseInteger, 2)
    .option("--timeout <s>", "seconds a wait gives up after; the default is 300", parseInteger, 300)
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (options.wait === true && typeof globals.cursor === "string") {
        ports.err("sorage: inbox --wait cannot combine with --cursor; a wait lists only new items\n");
        ports.err("Run 'sorage inbox --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const readPorts = createNodeHandoffReadPorts();
      if (options.wait === true) {
        const intervalSeconds = typeof options.interval === "number" && options.interval >= 0 ? options.interval : 2;
        const timeoutSeconds = typeof options.timeout === "number" && options.timeout >= 0 ? options.timeout : 300;
        const waited = waitForNewInboxItems(readPorts, actorInputOf(globals), listQueryOf(options, globals), {
          intervalSeconds,
          timeoutSeconds,
          sleepMs: blockingSleepMs,
        });
        if (!waited.ok) {
          reportExitCode(renderAppError(waited.error, ports, json));
          return;
        }
        if (waited.value.timedOut) {
          if (json) {
            ports.out(
              `${JSON.stringify(successEnvelope({ handoffs: [], nextCursor: null }, requestId(), { timedOut: true }), null, 2)}\n`,
            );
          } else {
            ports.out(`No new Handoff appeared within ${timeoutSeconds}s\n`);
          }
          return;
        }
        reportListing({ handoffs: waited.value.handoffs, nextCursor: null }, ports, json, globals);
        return;
      }
      const result = listInbox(readPorts, actorInputOf(globals), listQueryOf(options, globals));
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      reportListing(result.value, ports, json, globals);
    });

  program
    .command("outbox")
    .description("list the Handoffs the resolved sender sent")
    .option("--current-workspace", "list the Workspace's Handoffs instead of the Project's")
    .option("--state <state>", "filter by review state")
    .option("--sender <slug>", "filter by sender Project slug")
    .option("--recipient <slug>", "filter by recipient Project slug")
    .option("--include-archived", "include archived Handoffs")
    .option("--include-deleted", "include tombstones")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = listOutbox(
        createNodeHandoffReadPorts(),
        actorInputOf(globals),
        listQueryOf(options, globals),
        options.currentWorkspace === true,
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      reportListing(result.value, ports, json, globals);
    });

  program
    .command("get <handoff-id>")
    .description("read one Handoff's metadata; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = getHandoff(createNodeHandoffReadPorts(), actorInputOf(globals), id);
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`${result.value.title} (${result.value.id})
`);
        ports.out(`  state ${result.value.reviewState}, revision ${result.value.revision}, rowVersion ${result.value.rowVersion}
`);
      }
    });

  program
    .command("fetch <handoff-id>")
    .description("read the current Artifact's metadata and local path; the recipient's first fetch is recorded")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = fetchHandoff(createNodeHandoffReadPorts(), actorInputOf(globals), id);
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(
          `${JSON.stringify(successEnvelope({ handoff: result.value.handoff, artifact: result.value.artifact, localPath: result.value.localPath }, requestId()), null, 2)}
`,
        );
      } else {
        ports.out(`${result.value.artifact.originalName} (${result.value.artifact.sizeBytes} bytes)
`);
        ports.out(`  ${result.value.localPath}
`);
      }
    });

  const review = program.command("review").description("create, withdraw, and remove Review Notes");

  review
    .command("set <handoff-id>")
    .description("create or update this Handoff's Review Note as the recipient or the User")
    .option("--text <text>", "the note text inline")
    .option("--file <path>", "read the note text from a file, with ~ expansion")
    .option("--target-revision <n>", "the Revision the note targets", parseInteger)
    .action((id: string, options: { text?: string; file?: string; targetRevision?: number }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if ((options.text === undefined) === (options.file === undefined)) {
        ports.err("sorage: review set takes exactly one of --text or --file" + "\n");
        ports.err("Run 'sorage --help' for usage." + "\n");
        reportExitCode(2);
        return;
      }
      const text = options.text !== undefined ? options.text : readNoteFile(options.file as string);
      if (text === null) {
        reportExitCode(
          renderAppError(appError("CONFIG_INVALID", `the note file '${options.file}' could not be read`), ports, json),
        );
        return;
      }
      const result = setReviewNote(createNodeReviewPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        text,
        targetRevision: options.targetRevision,
        expectedRowVersion: expectedRowVersionOf(globals),
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Review Note set on ${id}; state ${result.value.handoff.reviewState}, rowVersion ${result.value.handoff.rowVersion}
`);
      }
    });

  review
    .command("withdraw <handoff-id>")
    .description("withdraw this Handoff's current Review Note as the recipient, whichever actor authored it")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = withdrawReviewNote(createNodeReviewPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        expectedRowVersion: expectedRowVersionOf(globals),
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Review Note withdrawn from ${id}; state ${result.value.handoff.reviewState}
`);
      }
    });

  review
    .command("remove <handoff-id>")
    .description("remove this Handoff's Review Note administratively; a User-admin operation")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            { code: "USER_CONTEXT_REQUIRED", message: "review remove is a User administration operation." },
            ports,
            json,
          ),
        );
        return;
      }
      const result = removeReviewNote(createNodeReviewPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        confirm: globals.confirm === true,
        expectedRowVersion: expectedRowVersionOf(globals),
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Review Note removed from ${id}; state ${result.value.handoff.reviewState}
`);
      }
    });

  program
    .command("revise <handoff-id>")
    .description("replace the current Artifact or resolve the Review Note without changing content")
    .option("--file <path>", "the replacement document, with ~ expansion")
    .option("--no-change", "resolve the Review Note without changing content")
    .option("--reason <text>", "the reason a no-change resolution carries")
    .option("--idempotency-key <uuid>", "replay an identical revise instead of applying it again")
    .option("--allow-external-source", "revise from a source outside the resolved sender workspace")
    .action(
      (
        id: string,
        options: {
          file?: string;
          noChange?: boolean;
          reason?: string;
          idempotencyKey?: string;
          allowExternalSource?: boolean;
        },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        if (!requireInitialized(ports, json, reportExitCode)) return;
        // Commander parses --no-change as the negation of a defaulted `change` flag.
        const noChange = (options as { change?: boolean }).change === false;
        if (noChange && options.file !== undefined) {
          ports.err("sorage: revise takes either --file or --no-change, not both\n");
          ports.err("Run 'sorage --help' for usage.\n");
          reportExitCode(2);
          return;
        }
        if (!noChange && options.file === undefined) {
          ports.err("sorage: revise takes either --file or --no-change\n");
          ports.err("Run 'sorage --help' for usage.\n");
          reportExitCode(2);
          return;
        }
        // RUN-002: an intent-recording command drains at start before it revises.
        const vaultPorts = createNodeVaultCommandPorts();
        const drained = vaultPorts.drainAtStart();
        if (!drained.ok) {
          reportExitCode(renderAppError(drained.error, ports, json));
          return;
        }
        let resolvedSourcePath: string | undefined;
        let originalName: string | undefined;
        if (options.file !== undefined) {
          const expanded = expandTilde(options.file);
          const inspected = inspectSourceFile(expanded);
          if (!inspected.ok) {
            reportExitCode(renderAppError(inspected.error, ports, json));
            return;
          }
          resolvedSourcePath = inspected.value.resolvedPath;
          originalName = basename(expanded);
        }
        const result = reviseHandoff(createNodeRevisionPorts(), {
          ...actorInputOf(globals),
          handoffId: id,
          file: options.file,
          noChange,
          reason: options.reason,
          idempotencyKey: options.idempotencyKey,
          resolvedSourcePath,
          originalName,
          allowExternalSource: options.allowExternalSource === true,
          expectedRowVersion: expectedRowVersionOf(globals),
        });
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        refreshMarker(id, ports);
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
        } else {
          ports.out(`Revised ${id}; revision ${result.value.revision}, state ${result.value.reviewState}
`);
        }
      },
    );

  program
    .command("accept <handoff-id>")
    .description("accept the exact Revision as the recipient, closing the exchange")
    .requiredOption("--expected-revision <n>", "the Revision being accepted", parseInteger)
    .action((id: string, options: { expectedRevision: number }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      // --expected-row-version is a root-level global, so its requiredness is
      // enforced here rather than by a subcommand-local requiredOption (CLI-013).
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: accept requires --expected-row-version <n>\n");
        ports.err("Run 'sorage accept --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const result = acceptHandoff(createNodeTerminalPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        expectedRevision: options.expectedRevision,
        expectedRowVersion: globals.expectedRowVersion,
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Accepted ${id} at revision ${result.value.acceptedRevision}
`);
      }
    });

  program
    .command("decline <handoff-id>")
    .description("decline the Handoff as the recipient with a recorded reason")
    .requiredOption("--reason <text>", "the recorded decline reason")
    .action((id: string, options: { reason: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: decline requires --expected-row-version <n>\n");
        ports.err("Run 'sorage decline --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const result = declineHandoff(createNodeTerminalPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        reason: options.reason,
        expectedRowVersion: globals.expectedRowVersion,
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Declined ${id}: ${options.reason}
`);
      }
    });

  program
    .command("withdraw <handoff-id>")
    .description("withdraw the Handoff as the sender before the recipient has engaged")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = withdrawHandoff(createNodeTerminalPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        expectedRowVersion: expectedRowVersionOf(globals),
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Withdrew ${id}
`);
      }
    });

  for (const [name, description, run] of [
    ["pin", "pin the Handoff against deletion; a User-admin operation", pinHandoff],
    ["unpin", "release a pinned Handoff; a User-admin operation", unpinHandoff],
  ] as const) {
    program
      .command(`${name} <handoff-id>`)
      .description(description)
      .action((id: string, _options: unknown, command: Command) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        if (!requireInitialized(ports, json, reportExitCode)) return;
        if (globals.asUser !== true) {
          reportExitCode(
            renderAppError(
              { code: "USER_CONTEXT_REQUIRED", message: `Handoff ${name} is a User administration operation.` },
              ports,
              json,
            ),
          );
          return;
        }
        const result = run(createNodeRetentionPorts(), {
          ...actorInputOf(globals),
          handoffId: id,
          expectedRowVersion: expectedRowVersionOf(globals),
        });
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        refreshMarker(id, ports);
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        } else {
          ports.out(`${name === "pin" ? "Pinned" : "Unpinned"} ${id}\n`);
        }
      });
  }

  for (const [name, description, run] of [
    ["archive", "archive a terminal Handoff out of the default listings; a User-admin operation", archiveHandoff],
    ["unarchive", "return an archived Handoff to the default listings; a User-admin operation", unarchiveHandoff],
  ] as const) {
    program
      .command(`${name} <handoff-id>`)
      .description(description)
      .action((id: string, _options: unknown, command: Command) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        if (!requireInitialized(ports, json, reportExitCode)) return;
        if (globals.asUser !== true) {
          reportExitCode(
            renderAppError(
              { code: "USER_CONTEXT_REQUIRED", message: `Handoff ${name} is a User administration operation.` },
              ports,
              json,
            ),
          );
          return;
        }
        const result = run(createNodeRetentionPorts(), {
          ...actorInputOf(globals),
          handoffId: id,
          expectedRowVersion: expectedRowVersionOf(globals),
        });
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        refreshMarker(id, ports);
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        } else {
          ports.out(`${name === "archive" ? "Archived" : "Unarchived"} ${id}\n`);
        }
      });
  }

  const remove = program.command("delete").description("request and decide Handoff deletion");

  remove
    .command("request <handoff-id>")
    .description("ask the User to delete this Handoff in any non-deleted state")
    .option("--reason <text>", "why the deletion is requested")
    .action((id: string, options: { reason?: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = requestDeletion(createNodeRetentionPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        reason: options.reason,
        expectedRowVersion: expectedRowVersionOf(globals),
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Deletion requested for ${id}\n`);
      }
    });

  remove
    .command("approve <handoff-id>")
    .description("approve a pending deletion as the User; the tombstone keeps no content")
    .option("--confirm-pinned <handoff-id>", "the distinct confirmation a pinned Handoff requires")
    .option("--idempotency-key <uuid>", "replay an identical approval instead of applying it again")
    .action((id: string, options: { confirmPinned?: string; idempotencyKey?: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            { code: "USER_CONTEXT_REQUIRED", message: "Deletion approval is a User administration operation." },
            ports,
            json,
          ),
        );
        return;
      }
      // RUN-002: an intent-recording command drains at start before it approves anything.
      const vaultPorts = createNodeVaultCommandPorts();
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const result = approveDeletion(createNodeRetentionPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        confirm: globals.confirm === true,
        confirmPinned: options.confirmPinned,
        idempotencyKey: options.idempotencyKey,
        expectedRowVersion: expectedRowVersionOf(globals),
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Deleted ${id}; prior Git commits may retain earlier content\n`);
        if (result.value.replayed === true) {
          ports.out("Replayed the recorded deletion approval\n");
        }
      }
    });

  remove
    .command("reject <handoff-id>")
    .description("reject a pending deletion as the User; the Handoff is retained")
    .option("--reason <text>", "why the deletion was rejected")
    .action((id: string, options: { reason?: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            { code: "USER_CONTEXT_REQUIRED", message: "Deletion rejection is a User administration operation." },
            ports,
            json,
          ),
        );
        return;
      }
      const result = rejectDeletion(createNodeRetentionPorts(), {
        ...actorInputOf(globals),
        handoffId: id,
        reason: options.reason,
        expectedRowVersion: expectedRowVersionOf(globals),
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports);
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Deletion rejected for ${id}\n`);
      }
    });

  const vault = program.command("vault").description("inspect, verify, and relocate the Artifact Vault");

  vault
    .command("status")
    .description("report the Vault path, marker, counts, and sizes")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const vaultPorts = createNodeVaultCommandPorts();
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const statusPorts = vaultPorts.statusPorts();
      if (!statusPorts.ok) {
        reportExitCode(renderAppError(statusPorts.error, ports, json));
        return;
      }
      const report = vaultStatus(statusPorts.value);
      if (!report.ok) {
        reportExitCode(renderAppError(report.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(report.value, requestId()), null, 2)}\n`);
      } else {
        const value = report.value;
        ports.out(`Vault: ${value.path}\n`);
        ports.out(
          `marker: schemaVersion ${value.marker.schemaVersion}, installation ${value.marker.installationId}, created ${value.marker.createdAt}\n`,
        );
        ports.out(`artifacts: ${value.counts.artifacts} files, ${value.sizes.artifactsBytes} bytes\n`);
        ports.out(`staging: ${value.counts.stagedFiles} files, ${value.sizes.stagingBytes} bytes\n`);
        ports.out(`pending intents: ${value.counts.pendingIntents}\n`);
        for (const problem of value.layoutProblems) ports.out(`warning: ${problem}\n`);
      }
    });

  vault
    .command("verify")
    .description("run the Git-independent integrity sweep and name every finding; never repairs")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const vaultPorts = createNodeVaultCommandPorts();
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const verifyPorts = vaultPorts.verifyPorts();
      if (!verifyPorts.ok) {
        reportExitCode(renderAppError(verifyPorts.error, ports, json));
        return;
      }
      const report = vaultVerify(verifyPorts.value, { now: new Date() });
      if (!report.ok) {
        reportExitCode(renderAppError(report.error, ports, json));
        return;
      }
      const blocking = report.value.findings.length > 0;
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope({ ...report.value, blocking }, requestId()), null, 2)}\n`);
      } else if (blocking) {
        for (const finding of report.value.findings) ports.err(`${finding}\n`);
      } else {
        ports.out(
          `The Vault is consistent: ${report.value.checked.recordedArtifacts} recorded Artifact(s), ${report.value.checked.stagedFiles} staged file(s).\n`,
        );
      }
      reportExitCode(blocking ? 1 : 0);
    });

  vault
    .command("move")
    .description("relocate the Vault under vault-move.lock; every other mutation pauses while it runs")
    .requiredOption("--to <path>", "the target directory for the relocated Vault")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            appError("USER_CONTEXT_REQUIRED", "sorage vault move records a User decision and requires --as-user."),
            ports,
            json,
          ),
        );
        return;
      }
      // A relative --to resolves against the cwd once, so the recorded path and
      // every later probe agree no matter where subsequent commands run from.
      const targetPath = isAbsolute(options.to) ? options.to : resolve(options.to);
      const vaultPorts = createNodeVaultCommandPorts({ targetPath });
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const movePorts = vaultPorts.movePorts();
      if (!movePorts.ok) {
        reportExitCode(renderAppError(movePorts.error, ports, json));
        return;
      }
      const result = moveVault(movePorts.value);
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(
          `Moved the Vault from ${result.value.fromPath} to ${result.value.toPath} (${result.value.artifactsMoved} artifacts); the previous Vault was kept in place.\n`,
        );
      }
    });

  program
    .command("completion <shell>")
    .description("print the shell completion script for zsh or bash; source it from the shell's profile")
    .action((shell: string, _options: unknown, command: Command) => {
      const script = buildCompletionScript(command.parent ?? program, shell, CLI_NAME);
      if (script === null) {
        ports.err(`sorage: completion supports zsh and bash, not '${shell}'\n`);
        ports.err("Run 'sorage completion --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      ports.out(script);
    });

  program.helpOption("-h, --help", "display help for the command");

  // A subcommand's --help or parse error exits through the subcommand's own Command,
  // so the process guards must reach every level of the tree: without this propagation
  // a subcommand help would bypass runCli's catch block and exit the process directly.
  const propagateProcessGuards = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: (str) => ports.out(str), writeErr: () => {} });
    for (const child of command.commands) propagateProcessGuards(child);
  };
  propagateProcessGuards(program);

  return program;
}

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

function renderDoctorReport(report: DoctorReport, ports: OutputPorts): void {
  for (const check of report.checks) {
    ports.out(`[${check.severity}] ${check.id} — ${check.message}\n`);
    if (check.recovery !== undefined) ports.out(`        recovery: ${check.recovery.suggestedCommand}\n`);
  }
}

/**
 * The pre-initialization gate (INIT-011, INIT-012): renders the documented human or
 * JSON NOT_INITIALIZED form with the expected configuration path and reports exit 78
 * when the installation does not exist yet.
 */
function requireInitialized(ports: OutputPorts, json: boolean, reportExitCode: (code: number) => void): boolean {
  const gate = createNodeConfigCommandPorts();
  const current = gate.store.read();
  if (current.ok && current.value !== null) return true;
  if (!current.ok) {
    // A present but broken configuration is doctor territory, not a gate case.
    reportExitCode(renderAppError(current.error, ports, json));
    return false;
  }
  const error: AppError = {
    code: "NOT_INITIALIZED",
    message: "Sorage has not been initialized.",
    details: { expectedConfigPath: gate.configFile },
  };
  const id = requestId();
  logCommandFailure(error, id);
  if (json) {
    ports.err(`${JSON.stringify(errorEnvelope(error, id), null, 2)}\n`);
  } else {
    ports.err(
      `ERROR [${error.code}]\n\n${error.message}\n\nExpected configuration:\n  ${gate.configFile}\n\nRun:\n  sorage init\n`,
    );
  }
  reportExitCode(errorSpec(error.code).exitCode);
  return false;
}

/** Runs one CLI invocation and returns its process exit code without exiting. */
export function runCli(argv: string[], ports: OutputPorts = defaultPorts): number {
  let actionExitCode: number | null = null;
  const program = buildProgram(ports, (code) => {
    actionExitCode = code;
  });
  program.configureOutput({
    writeOut: (str) => ports.out(str),
    // The catch block below is the single renderer for usage errors; suppressing
    // commander's own error write keeps every diagnostic in exactly one format.
    writeErr: () => {},
  });
  program.exitOverride();
  if (argv.length === 0) {
    ports.out(program.helpInformation());
    return 0;
  }
  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    const commanderError = error as { code?: string; exitCode?: number; message?: string };
    const informational = new Set([
      "help",
      "commandHelp",
      "version",
      "(outputHelp)",
      "(outputVersion)",
      // commander 14 exits the implicit `help` command through `commander.help`
      // while the `--help` flag throws `commander.helpDisplayed`; both are exits 0.
      "commander.help",
      "commander.helpDisplayed",
      "commander.helpCommandDisplayed",
      "commander.version",
    ]);
    if (commanderError.code !== undefined && informational.has(commanderError.code)) {
      return 0;
    }
    const message = error instanceof Error ? error.message : String(error);
    ports.err(`${program.name()}: ${message}\n`);
    ports.err(`Run '${program.name()} --help' for usage.\n`);
    return 2;
  }
  if (actionExitCode !== null) {
    return actionExitCode;
  }
  const [first] = program.args;
  if (first !== undefined && program.commands.every((cmd) => cmd.name() !== first)) {
    return renderUsageError(new InvalidArgumentError(`unknown command '${first}'`), program, ports);
  }
  return 0;
}

/** The optional HND-014 expectation one mutating command forwards; undefined when the global flag was not supplied. */
function expectedRowVersionOf(globals: Record<string, unknown>): number | undefined {
  return typeof globals.expectedRowVersion === "number" ? globals.expectedRowVersion : undefined;
}

function actorInputOf(globals: Record<string, unknown>): {
  path: string;
  userHome: string;
  as: string | undefined;
  asUser: boolean | undefined;
} {
  return {
    path: process.cwd(),
    userHome: homedir(),
    as: typeof globals.as === "string" ? globals.as : undefined,
    asUser: globals.asUser === true,
  };
}

/** The page-size default of section 13.9: the configured `ui.defaultPageSize`, never a CLI-local constant. */
function defaultPageSize(): number {
  const gate = createNodeConfigCommandPorts();
  const current = gate.store.read();
  return current.ok && current.value !== null ? current.value.config.ui.defaultPageSize : 50;
}

function listQueryOf(options: Record<string, unknown>, globals: Record<string, unknown>) {
  return {
    limit: typeof globals.limit === "number" && globals.limit > 0 ? globals.limit : defaultPageSize(),
    cursor: typeof globals.cursor === "string" ? globals.cursor : undefined,
    filters: {
      state: typeof options.state === "string" ? options.state : undefined,
      senderSlug: typeof options.sender === "string" ? options.sender : undefined,
      recipientSlug: typeof options.recipient === "string" ? options.recipient : undefined,
      includeArchived: options.includeArchived === true,
      includeDeleted: options.includeDeleted === true,
    },
  };
}

function reportListing(
  value: { handoffs: unknown[]; nextCursor: string | null },
  ports: OutputPorts,
  json: boolean,
  globals: Record<string, unknown>,
): void {
  if (json) {
    const payload =
      typeof globals.cursor === "string"
        ? { handoffs: value.handoffs, nextCursor: value.nextCursor }
        : { handoffs: value.handoffs, nextCursor: value.nextCursor };
    ports.out(`${JSON.stringify(successEnvelope(payload, requestId()), null, 2)}
`);
    return;
  }
  for (const handoff of value.handoffs as Array<{ title: string; id: string; reviewState: string }>) {
    ports.out(`${handoff.id}  ${handoff.reviewState.padEnd(18)} ${handoff.title}
`);
  }
  if (value.nextCursor !== null) {
    ports.out(`next page: --cursor ${value.nextCursor}
`);
  }
}

function readNoteFile(path: string): string | null {
  try {
    return readFileSync(expandTilde(path), "utf8");
  } catch {
    return null;
  }
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Rewrites the derived inbox marker (HND-026); a failure warns and never fails the command. */
function refreshMarker(handoffId: string, ports: OutputPorts): void {
  const refreshed = refreshInboxMarker(createNodeInboxMarkerPorts(), handoffId);
  if (!refreshed.ok) {
    ports.err(`warning: ${refreshed.error.message}\n`);
  }
}

function renderUsageError(error: unknown, program: Command, ports: OutputPorts): number {
  const message = error instanceof Error ? error.message : String(error);
  ports.err(`${program.name()}: ${message}\n`);
  ports.err(`Run '${program.name()} --help' for usage.\n`);
  return 2;
}

let processLogger: Logger | null | undefined;

/**
 * Every process writes its failures to `<home>/logs/sorage.log` (RUN-009). The
 * logger is created lazily so a successful run never touches the log directory,
 * and a logging failure must never mask the command's own result.
 */
function failureLogger(): Logger | null {
  if (processLogger !== undefined) return processLogger;
  try {
    const home = createNodeHomePaths();
    processLogger = createLogger({ file: join(home.logsDir, "sorage.log"), level: "warn", homePath: home.home });
  } catch {
    processLogger = null;
  }
  return processLogger;
}

function logCommandFailure(error: AppError, id: string): void {
  try {
    const logger = failureLogger();
    if (logger === null) return;
    const record = { code: error.code, requestId: id, message: error.message };
    if (error.code === "INTERNAL_ERROR") logger.error("cli.command_failed", record);
    else logger.warn("cli.command_failed", record);
  } catch {
    // A logging failure must never change the command's output or exit code.
  }
}

/** Maps an application error to its envelope rendering and published exit code. */
export function renderAppError(error: AppError, ports: OutputPorts, json: boolean, recoveryOverride?: string): number {
  const spec = errorSpec(error.code);
  const id = requestId();
  logCommandFailure(error, id);
  if (json) {
    ports.err(`${JSON.stringify(errorEnvelope(error, id), null, 2)}\n`);
  } else {
    ports.err(`${error.code}: ${error.message}\n`);
    const recovery = recoveryOverride ?? spec.recovery?.suggestedCommand;
    if (recovery !== undefined) ports.err(`Recovery: ${recovery}\n`);
  }
  return spec.exitCode;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  return runCli(argv);
}

export type { Envelope };

if (import.meta.main) {
  process.exit(main());
}
