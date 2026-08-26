import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDoctorPorts } from "@sorage/adapters/src/doctor";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
// Deep import: the adapters index also exports the testkit, which is vitest-only and
// must never load inside the shipped CLI process.
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createLogger, type Logger } from "@sorage/adapters/src/logging";
// Deep import: the adapters index also exports the testkit, which is vitest-only and
// must never load inside the shipped CLI process.
import { createNodeProjectPorts } from "@sorage/adapters/src/project-command-ports";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  type AddProjectOutcome,
  type AppError,
  addProject,
  appError,
  archiveProject,
  bindProject,
  type DoctorReport,
  type Envelope,
  editConfiguration,
  errorEnvelope,
  errorSpec,
  hasBlockingCheck,
  initializeInstallation,
  type ListedProject,
  listProjects,
  moveVault,
  protocolVersion,
  renameProject,
  resolveWorkspaceActor,
  runDoctor,
  setConfigurationValue,
  showConfiguration,
  showProject,
  successEnvelope,
  unarchiveProject,
  unbindProject,
  validateConfigurationFile,
  vaultStatus,
  vaultVerify,
  workspaceKey,
} from "@sorage/core";
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

/** Runs one CLI action and remembers its exit code for `runCli` to return. */
type ReportExitCode = (code: number) => void;

export function buildProgram(ports: OutputPorts = defaultPorts, reportExitCode: ReportExitCode = () => {}): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description("Local document-handoff broker for AI coding sessions.")
    .option("--as <project-slug>", "resolve the acting Project by slug instead of the working directory")
    .option("--as-user", "assert the local User as the actor for a User-admin operation")
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
      const result = addProject(createNodeProjectPorts(), {
        name: options.name,
        slug: options.slug,
        dir: options.dir,
        userHome: homedir(),
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
      const result = renameProject(createNodeProjectPorts(), { slug, name: options.name });
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
      const result = bindProject(createNodeProjectPorts(), { slug, dir: options.dir, userHome: homedir() });
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
      const result = unbindProject(createNodeProjectPorts(), {
        slug,
        dir: options.dir,
        userHome: homedir(),
        confirm: globals.confirm === true,
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
        const result = run(createNodeProjectPorts(), slug);
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

  program.helpOption("-h, --help", "display help for the command");

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
