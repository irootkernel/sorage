import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createNodeBackupCommandPorts } from "@sorage/adapters/src/backup-command-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import * as daemonCommandPorts from "@sorage/adapters/src/daemon-command-ports";
import { appCommandErrorOf, schemaAdmissionOf } from "@sorage/adapters/src/daemon-command-ports";
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
import { createNodeInboxMarkerPorts } from "@sorage/adapters/src/inbox-marker-ports";
// Deep import: the adapters index also exports the testkit, which is vitest-only and
// must never load inside the shipped CLI process.
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import {
  createNodeLaunchAgentPorts,
  launchAgentsDirectory,
  launchAgentUid,
} from "@sorage/adapters/src/launchagent-ports";
import { createLogger, type Logger } from "@sorage/adapters/src/logging";
import { createNodeProjectPorts } from "@sorage/adapters/src/project-command-ports";
import { type CoveredReadStorage, openCoveredReadStorage } from "@sorage/adapters/src/read-storage";
import { blockingSleepMs } from "@sorage/adapters/src/sleep";
import { createNodeApiTokenStore } from "@sorage/adapters/src/token-store";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  type AddProjectOutcome,
  type AppError,
  acceptHandoff,
  addProject,
  appError,
  approveDeletion,
  archiveHandoff,
  archiveProject,
  backupRestore,
  backupStatus,
  backupVerify,
  bindProject,
  CONFIG_ACCESS_REPAIR,
  CONFIG_PATH_REPAIR,
  type Configuration,
  channelError,
  completeProcessing,
  configurationPathState,
  configureBackup,
  type DoctorReport,
  declineHandoff,
  type Envelope,
  editConfiguration,
  err,
  errorEnvelope,
  errorSpec,
  fetchHandoff,
  getHandoff,
  type HandoffDetailReadPorts,
  type HandoffListFilters,
  type HandoffView,
  hasBlockingCheck,
  initializeInstallation,
  installLaunchAgent,
  type ListedProject,
  largeContentDisclosureMessage,
  listInbox,
  listOutbox,
  listProjects,
  memoError,
  moveVault,
  ok,
  pinHandoff,
  probeConfigurationPath,
  type Result,
  readHandoffTimeline,
  readRecipientComment,
  readReviewNote,
  rebindProject,
  reconcileReboundInboxMarker,
  refreshInboxMarker,
  refreshProjectInboxMarker,
  rejectDeletion,
  removeReviewNote,
  renameProject,
  requestDeletion,
  resolveCommandActor,
  resolveWorkspaceActor,
  reviseHandoff,
  rotateApiToken,
  runBackupCommand,
  runDoctor,
  SORAGE_VERSION,
  sendHandoffs,
  setConfigurationValue,
  setRecipientComment,
  setReviewNote,
  showConfiguration,
  showProject,
  startProcessing,
  successEnvelope,
  USER_ACTOR,
  unarchiveHandoff,
  unarchiveProject,
  unbindProject,
  uninstallInstallation,
  unpinHandoff,
  validateConfigurationFile,
  vaultStatus,
  vaultVerify,
  waitForNewInboxItems,
  withdrawHandoff,
  withdrawReviewNote,
  workspaceKey,
} from "@sorage/core";
import * as daemonModule from "@sorage/daemon";
import { Command, InvalidArgumentError, Option } from "commander";
import { registerChannelCommands } from "./channel-commands";
import { buildCompletionScript } from "./completion";
import { createDaemonRuntimePorts, daemonRestart, daemonStart, daemonStatus, daemonStop } from "./daemon-commands";
import { expandTilde } from "./expand-tilde";
import { createStdinPrompt, type InitChoices, type PromptPorts, runInitWizard } from "./init-wizard";
import { serveMcp } from "./mcp-server";
import { memoNumericErrorContext, registerMemoCommands } from "./memo-commands";
import { runPreflightCommand } from "./preflight-command";
import { runSendRecoveryCommand } from "./send-recovery-command";
import {
  ACCEPT_REQUIRES_ROW_VERSION,
  BODY_MUST_NOT_BE_EMPTY,
  DECLINE_REQUIRES_ROW_VERSION,
  INBOX_WAIT_NO_CURSOR,
  INBOX_WAIT_WHOLE_SECONDS,
  REVIEW_SET_ONE_SOURCE,
  REVISE_ONE_SOURCE,
  SEND_REPLAY_ONLY_KEY,
  SEND_TAKES_ONE_SOURCE,
} from "./usage-sentences";
import * as webBindings from "./web";
import { createWebRuntimePorts, runWebCommand } from "./web";

export const CLI_NAME = "sorage" as const;
/** Kept as a CLI-facing alias while the product version has one source. */
export const CLI_VERSION = SORAGE_VERSION;

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

/** The command surface's input side: prompts for the interactive wizard, injectable for tests. */
export type CommandInput = PromptPorts;

export function buildProgram(
  ports: OutputPorts = defaultPorts,
  reportExitCode: ReportExitCode = () => {},
  input: CommandInput = createStdinPrompt((text) => process.stderr.write(text)),
): Command {
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
    .option(
      "--expected-row-version <n>",
      "observed Row Version; mandatory for fresh revise and delete approve",
      parseInteger,
    )
    .option("--limit <n>", "page size for list commands", parseInteger)
    .option("--cursor <cursor>", "resume a listing from an opaque cursor")
    .option("--json", "emit the versioned JSON envelope on standard output");

  program
    .command("version")
    .description("print the product version")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (json) {
        ports.out(`${JSON.stringify({ name: CLI_NAME, version: `v${CLI_VERSION}` })}\n`);
      } else {
        ports.out(`${CLI_NAME} v${CLI_VERSION}\n`);
      }
    });

  program
    .command("preflight")
    .description("inspect the selected installation without initializing or opening it")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      reportExitCode(
        runPreflightCommand({
          ports,
          json: globals.json === true,
          confirm: globals.confirm === true,
          requestId: requestId(),
        }),
      );
    });

  program
    .command("init")
    .description("create the Sorage installation: home tree, configuration, database, and Vault")
    .option("--vault <path>", "Vault directory; defaults to ~/.sorage/vault")
    .option("--non-interactive", "never prompt; missing answers use the documented defaults")
    .option("--reconfigure", "explicitly repair or backfill an existing installation")
    .option(
      "--initialize-git",
      "initialize a Git repository in the Vault with core.autocrlf=false; an existing repository is reported, never reinitialized",
    )
    .option("--port <n>", "set server.port in the creating write", parseInteger)
    .option("--install-service", "install the xyz.rootkernel.sorage LaunchAgent (INIT-009)")
    .option("--start-daemon", "start the daemon after a successful init")
    .option("--enable-daily-backup", "enable the daily backup schedule (INIT-008)")
    .option("--backup-at <HH:MM>", "the daily backup local time; requires --enable-daily-backup")
    .option("--timezone <tz>", "the daily backup IANA zone; requires --enable-daily-backup")
    .action((options, command) => {
      const json = command.optsWithGlobals().json === true;
      const backupAtGiven = options.backupAt !== undefined || options.timezone !== undefined;
      if (backupAtGiven && options.enableDailyBackup !== true) {
        ports.err(`${CLI_NAME}: --backup-at and --timezone apply only together with --enable-daily-backup\n`);
        reportExitCode(2);
        return;
      }
      let choices: InitChoices | null = null;
      // A relative --vault resolves against the cwd once, so the recorded path and
      // every later probe agree no matter where subsequent commands run from.
      const home = createNodeHomePaths();
      const vaultOption =
        typeof options.vault === "string" && options.vault.trim() !== "" && !isAbsolute(options.vault)
          ? resolve(options.vault)
          : typeof options.vault === "string"
            ? options.vault
            : undefined;
      if (options.nonInteractive !== true) {
        // The wizard takes its answers interactively: only --vault may pre-seed a
        // default. Any other option is a usage error rather than a silent no-op.
        const wizardForbidden = [
          ["--json", json],
          ["--reconfigure", options.reconfigure === true],
          ["--initialize-git", options.initializeGit === true],
          ["--port", options.port !== undefined],
          ["--install-service", options.installService === true],
          ["--start-daemon", options.startDaemon === true],
          ["--enable-daily-backup", options.enableDailyBackup === true],
          ["--backup-at", options.backupAt !== undefined],
          ["--timezone", options.timezone !== undefined],
        ] as const;
        const conflicting = wizardForbidden.find(([, given]) => given);
        if (conflicting !== undefined) {
          ports.err(`${CLI_NAME}: ${conflicting[0]} needs --non-interactive; the wizard asks its own questions\n`);
          reportExitCode(2);
          return;
        }
        const wizard = runInitWizard(
          { out: ports.out, err: ports.err, ask: (question) => input.ask(question) },
          {
            defaultVaultPath: vaultOption ?? join(home.home, "vault"),
            defaultPort: 46321,
            defaultBackupAt: "03:00",
            defaultBackupTimezone: "UTC",
            systemTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
          },
        );
        if (wizard.status === "unanswered") {
          ports.err(`${CLI_NAME}: no answer available for the ${wizard.question}; pass --non-interactive\n`);
          ports.err(`Run '${CLI_NAME} --help' for usage.\n`);
          reportExitCode(2);
          return;
        }
        if (wizard.status === "declined") {
          ports.out("Nothing was changed.\n");
          return;
        }
        choices = wizard.choices;
      } else {
        choices = {
          vaultPath: vaultOption ?? join(home.home, "vault"),
          createVault: true,
          serverPort: typeof options.port === "number" ? options.port : 46321,
          installService: options.installService === true,
          startDaemon: options.startDaemon === true,
          initializeGit: options.initializeGit === true,
          enableDailyBackup: options.enableDailyBackup === true,
          backupAt: typeof options.backupAt === "string" ? options.backupAt : "03:00",
          backupTimezone: typeof options.timezone === "string" ? options.timezone : "UTC",
          enablePush: false,
          pushRemote: "origin",
          pushBranch: "main",
          registerProject: false,
          projectName: "",
          projectDir: "",
        };
      }
      applyInitChoices(ports, json, reportExitCode, choices, vaultOption, options.reconfigure === true);
    });

  program
    .command("uninstall")
    .description("remove the Sorage installation while keeping the Vault")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const home = createNodeHomePaths();
      const commandPorts = createNodeConfigCommandPorts();
      const daemonPorts = daemonCommandPorts.createNodeDaemonPorts();
      const result = uninstallInstallation(
        {
          home: home.home,
          stateDir: home.stateDir,
          logsDir: home.logsDir,
          runDir: home.runDir,
          configFile: commandPorts.configFile,
          configBackupFile: `${commandPorts.configFile}.bak`,
          userHome: homedir(),
          readConfiguration: () => {
            const read = commandPorts.store.read();
            if (!read.ok) return read;
            if (read.value === null) return ok(null);
            return ok({ config: read.value.config });
          },
          daemonRunning: () => {
            const record = daemonPorts.readDaemonRecord();
            return record !== null && daemonPorts.isPidAlive(record.pid);
          },
          stopDaemon: () => {
            const code = daemonStop(createDaemonRuntimePorts(), ports);
            // A non-zero stop leaves the daemon running, and the use case refuses
            // to remove live state from under it rather than reporting success.
            return code === 0
              ? ok({ stopped: true })
              : err(appError("DAEMON_UNAVAILABLE", "sorage daemon stop did not end the daemon."));
          },
          launchAgent: createNodeLaunchAgentPorts(),
          agentsDirectory: launchAgentsDirectory(),
          uid: launchAgentUid(),
          removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
          removeFile: (path) => rmSync(path, { force: true }),
          exists: (path) => existsSync(path),
        },
        { asUser: globals.asUser === true, confirm: globals.confirm === true },
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        for (const removed of result.value.removed) {
          ports.out(`Removed ${removed}\n`);
        }
        if (result.value.daemonStopped) {
          ports.out("Stopped the running daemon.\n");
        }
        if (result.value.launchAgent.wasLoaded) {
          ports.out("Removed the xyz.rootkernel.sorage LaunchAgent.\n");
        }
        ports.out(`Vault retained at ${result.value.retainedVaultPath}\n`);
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
      // While the daemon runs it is the only writer of config.yaml (CFG-016): the
      // change routes through PUT /api/v1/config instead of the file store.
      const owned = liveDaemonAddress();
      if (owned !== null) {
        reportExitCode(routedConfigSet(owned, key, value, ports));
        return;
      }
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
      // An editor writes the file directly, which the daemon's exclusive writer rule
      // forbids while it runs (CFG-016).
      if (liveDaemonAddress() !== null) {
        reportExitCode(
          renderAppError(
            appError(
              "SERVICE_PAUSED",
              "the running daemon is the only writer of config.yaml; stop it before editing the file, or change settings through the Web settings page",
            ),
            ports,
            json,
          ),
        );
        return;
      }
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

  registerMemoCommands(program, {
    out: ports.out,
    requestId,
    warn: (text) => ports.err(text),
    fail: (error, json, options) => {
      reportExitCode(renderAppError(memoError(error), ports, json, undefined, options));
    },
    // The covered Memo reads enter through the same pre-initialization gate as
    // every other covered read, rendered without a log write (RDR-001).
    requireInitialized: (json) => requireInitialized(ports, json, reportExitCode, true, { log: false }),
  });

  registerChannelCommands(program, {
    out: ports.out,
    err: (text) => ports.err(text),
    requestId,
    warn: (text) => ports.err(text),
    fail: (error, json, options) => {
      reportExitCode(renderAppError(channelError(error), ports, json, undefined, options));
    },
    usageExit: () => {
      reportExitCode(2);
    },
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      const commandPorts = createNodeProjectPorts({ contentionSurface: "project" });
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
      refreshProjectMarker(result.value.project.id, ports);
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      const commandPorts = createNodeProjectPorts({ contentionSurface: "project" });
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      const commandPorts = createNodeProjectPorts({ contentionSurface: "project" });
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
      refreshProjectMarker(result.value.projectId, ports);
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      const commandPorts = createNodeProjectPorts({ contentionSurface: "project" });
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

  project
    .command("rebind")
    .description("replace one recorded Project binding with an existing directory")
    .argument("<project>", "Project slug")
    .requiredOption("--from <path>", "recorded binding path to replace")
    .requiredOption("--to <path>", "existing directory to bind")
    .action((slug, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      const result = rebindProject(createNodeProjectPorts({ contentionSurface: "project" }), {
        slug,
        from: options.from,
        to: options.to,
        userHome: homedir(),
        actor: USER_ACTOR,
      });
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
          const markerPorts = createNodeInboxMarkerPorts();
          if (markerPorts.marker.enabled) {
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
        if (!requireInitialized(ports, json, reportExitCode, true)) return;
        const result = run(createNodeProjectPorts({ contentionSurface: "project" }), { slug });
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      const resolvePorts = createNodeProjectPorts({ contentionSurface: "project" });
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
    .option(
      "--idempotency-key <key>",
      "original receipt key, including retained legacy keys; ordinary send may execute on a miss",
    )
    .option("--replay-only", "inspect the original send receipt without executing; requires the original key and input")
    .addHelpText(
      "after",
      "\nFor an unknown result, retain the original key, exact input/source bytes, Installation and sender context. Use only --replay-only with that material. A missing receipt leaves the outcome unknown; historical success does not establish current delivery or Artifact activation.\n",
    )
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (options.replayOnly === true) {
        let usage: string | undefined;
        if (typeof options.idempotencyKey !== "string" || options.idempotencyKey.trim() === "")
          usage = SEND_REPLAY_ONLY_KEY;
        else if ((options.file === undefined) === (options.body === undefined)) usage = SEND_TAKES_ONE_SOURCE;
        else if (options.body !== undefined && options.body.trim() === "") usage = "the --body text must not be empty";
        if (usage !== undefined) {
          ports.err(`sorage: ${usage}\nRun 'sorage --help' for usage.\n`);
          reportExitCode(2);
          return;
        }
        reportExitCode(
          runSendRecoveryCommand({
            ports,
            json,
            requestId: requestId(),
            input: {
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
            },
          }),
        );
        return;
      }
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      if ((options.file === undefined) === (options.body === undefined)) {
        ports.err(`sorage: ${SEND_TAKES_ONE_SOURCE}\n`);
        ports.err("Run 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (options.body !== undefined && options.body.trim() === "") {
        ports.err(`sorage: ${BODY_MUST_NOT_BE_EMPTY}\n`);
        ports.err("Run 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      // RUN-002: an intent-recording command drains at start before it creates anything.
      const vaultPorts = createNodeVaultCommandPorts({ contentionSurface: "handoff" });
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      // Post-commit completion warnings buffer here and flush to stderr after
      // the committed result (SHR-015 category (i)).
      const sendCompletionWarnings: string[] = [];
      const sendPorts = createNodeSendPorts({ completionWarning: (text) => sendCompletionWarnings.push(text) });
      // WR3: the disclosure buffers metadata per invocation and flushes after
      // the result — a JSON failure appends it inside the existing error
      // message so stderr stays exactly one envelope; success prints it as a
      // stderr diagnostic before the unchanged stdout output.
      const sendWarnings: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
      if (sendPorts.disclosures !== undefined) {
        const composed = sendPorts.disclosures;
        sendPorts.disclosures = {
          ...composed,
          largeContent: (sizeBytes: number, thresholdBytes: number) => {
            sendWarnings.push({ sizeBytes, thresholdBytes });
          },
        };
      }
      const result = sendHandoffs(sendPorts, {
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
        let error = result.error;
        if (json) {
          try {
            if (sendWarnings.length > 0)
              error = {
                ...error,
                message: `${error.message}; ${sendWarnings.map((warning) => largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)).join(" ")}`,
              };
          } catch {
            // Formatting failure leaves the original error intact.
          }
        } else {
          for (const warning of sendWarnings) {
            try {
              ports.err(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
            } catch {
              /* Best effort. */
            }
          }
        }
        reportExitCode(renderAppError(error, ports, json));
        return;
      }
      for (const warning of sendWarnings) {
        try {
          ports.err(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
        } catch {
          // A diagnostic flush failure never changes a committed outcome.
        }
      }
      // The committed outcome precedes every post-commit diagnostic: the
      // completion warnings flush to stderr after the result, contained.
      for (const text of sendCompletionWarnings) {
        try {
          ports.err(`warning: ${text}\n`);
        } catch {
          // A diagnostic flush failure never changes a committed outcome.
        }
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
    .option("--updated-since <instant>", "inclusive lower bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--updated-until <instant>", "inclusive upper bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--include-archived", "include archived Handoffs")
    .option("--include-deleted", "include tombstones")
    .option("--wait", "poll until a new inbox item appears for the resolved actor, then list it")
    .option("--interval <s>", "seconds between two waits' polls; the default is 2", parseInteger, 2)
    .option("--timeout <s>", "seconds a wait gives up after; the default is 300", parseInteger, 300)
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      if (options.wait === true && typeof options.interval === "number" && options.interval < 1) {
        ports.err(`sorage: ${INBOX_WAIT_WHOLE_SECONDS}\n`);
        ports.err("Run 'sorage inbox --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (options.wait === true && typeof globals.cursor === "string") {
        ports.err(`sorage: ${INBOX_WAIT_NO_CURSOR}\n`);
        ports.err("Run 'sorage inbox --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const readPorts = createNodeHandoffReadPorts({ database: storage.db });
        if (options.wait === true) {
          const intervalSeconds = typeof options.interval === "number" && options.interval >= 0 ? options.interval : 2;
          const timeoutSeconds = typeof options.timeout === "number" && options.timeout >= 0 ? options.timeout : 300;
          const query = listQueryOf(options, globals);
          if (!query.ok) {
            reportExitCode(renderAppError(query.error, ports, json, undefined, { log: false }));
            return;
          }
          const waited = waitForNewInboxItems(pollingHandoffReadPorts(readPorts), actorInputOf(globals), query.value, {
            intervalSeconds,
            timeoutSeconds,
            sleepMs: blockingSleepMs,
          });
          if (!waited.ok) {
            reportExitCode(renderAppError(waited.error, ports, json, undefined, { log: false }));
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
        const inboxQuery = listQueryOf(options, globals);
        if (!inboxQuery.ok) {
          reportExitCode(renderAppError(inboxQuery.error, ports, json, undefined, { log: false }));
          return;
        }
        const result = listInbox(readPorts, actorInputOf(globals), inboxQuery.value);
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        reportListing(result.value, ports, json, globals);
      });
    });

  program
    .command("outbox")
    .description("list the Handoffs the resolved sender sent")
    .option("--current-workspace", "list the Workspace's Handoffs instead of the Project's")
    .option("--state <state>", "filter by review state")
    .option("--sender <slug>", "filter by sender Project slug")
    .option("--recipient <slug>", "filter by recipient Project slug")
    .option("--updated-since <instant>", "inclusive lower bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--updated-until <instant>", "inclusive upper bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--include-archived", "include archived Handoffs")
    .option("--include-deleted", "include tombstones")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const outboxPorts = createNodeHandoffReadPorts({ database: storage.db });
        const outboxQuery = listQueryOf(options, globals);
        if (!outboxQuery.ok) {
          reportExitCode(renderAppError(outboxQuery.error, ports, json, undefined, { log: false }));
          return;
        }
        const result = listOutbox(
          outboxPorts,
          actorInputOf(globals),
          outboxQuery.value,
          options.currentWorkspace === true,
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        reportListing(result.value, ports, json, globals);
      });
    });

  program
    .command("get <handoff-id>")
    .description("read one Handoff's metadata; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = getHandoff(createNodeHandoffReadPorts({ database: storage.db }), actorInputOf(globals), id);
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
        } else {
          ports.out(`${result.value.title} (${result.value.id})
`);
          ports.out(`  ${reportingSummary(result.value)}, revision ${result.value.revision}, rowVersion ${result.value.rowVersion}
`);
        }
      });
    });

  program
    .command("fetch <handoff-id>")
    .description("read the current Artifact's metadata and local path; the recipient's first fetch is recorded")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
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

  program
    .command("events <handoff-id>")
    .description("read the bounded recent metadata timeline; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = readHandoffTimeline(
          createNodeHandoffReadPorts({ database: storage.db }),
          actorInputOf(globals),
          id,
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
        } else if (result.value.length === 0) {
          ports.out("no events\n");
        } else {
          for (const event of result.value) {
            const rowVersion = event.rowVersion === null ? "-" : String(event.rowVersion);
            ports.out(`${event.eventType}  actor ${event.actorKind}  rowVersion ${rowVersion}\n`);
          }
        }
      });
    });

  const comment = program.command("comment").description("read and replace the retained recipient comment");
  comment
    .command("show <handoff-id>")
    .description("read the retained recipient comment; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = readRecipientComment(
          createNodeHandoffReadPorts({ database: storage.db }),
          actorInputOf(globals),
          id,
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        else if (result.value === null) ports.out("no recipient comment\n");
        else
          ports.out(
            `${result.value.body}\n  purpose ${result.value.purpose}, active ${result.value.active}, targetRevision ${result.value.targetRevision}, author ${result.value.authorKind}\n`,
          );
      });
    });
  comment
    .command("set <handoff-id>")
    .description("replace the recipient comment using the observed document and Row Version")
    .option("--text <text>", "the comment text inline")
    .option("--file <path>", "read UTF-8 comment text from a regular file")
    .option("--purpose <purpose>", "general or change_request", "general")
    .requiredOption("--expected-revision <n>", "the observed document Revision", parseInteger)
    .action(
      (
        id: string,
        options: { text?: string; file?: string; purpose: string; expectedRevision: number },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        if (
          typeof globals.expectedRowVersion !== "number" ||
          (options.text === undefined) === (options.file === undefined)
        ) {
          ports.err("sorage: comment set requires one --text/--file source and --expected-row-version\n");
          reportExitCode(2);
          return;
        }
        if (!requireInitialized(ports, json, reportExitCode, true)) return;
        const text = options.text ?? readNoteFile(options.file as string);
        if (text === null) {
          reportExitCode(
            renderAppError(
              appError("HANDOFF_INVALID_INPUT", "the comment source must be a readable regular UTF-8 file"),
              ports,
              json,
            ),
          );
          return;
        }
        const result = setRecipientComment(createNodeReviewPorts(), {
          ...actorInputOf(globals),
          handoffId: id,
          text,
          purpose: options.purpose as "general" | "change_request",
          expectedRevision: options.expectedRevision,
          expectedRowVersion: globals.expectedRowVersion,
        });
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        refreshMarker(id, ports);
        if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        else ports.out(`Comment set on ${id}; ${reportingSummary(result.value.handoff)}\n`);
      },
    );
  const processing = program.command("processing").description("report work independently of document acceptance");
  for (const [name, mutate] of [
    ["start", startProcessing],
    ["complete", completeProcessing],
  ] as const) {
    processing
      .command(`${name} <handoff-id>`)
      .description(`${name} processing with an optional general comment`)
      .requiredOption("--expected-revision <n>", "the observed document Revision", parseInteger)
      .option("--comment-text <text>", "replace the general comment inline")
      .option("--comment-file <path>", "replace the general comment from a regular UTF-8 file")
      .action(
        (
          id: string,
          options: { expectedRevision: number; commentText?: string; commentFile?: string },
          command: Command,
        ) => {
          const globals = command.optsWithGlobals();
          const json = globals.json === true;
          if (
            typeof globals.expectedRowVersion !== "number" ||
            (options.commentText !== undefined && options.commentFile !== undefined)
          ) {
            ports.err("sorage: processing requires --expected-row-version and at most one comment source\n");
            reportExitCode(2);
            return;
          }
          if (!requireInitialized(ports, json, reportExitCode, true)) return;
          const text =
            options.commentText ?? (options.commentFile === undefined ? undefined : readNoteFile(options.commentFile));
          if (text === null) {
            reportExitCode(
              renderAppError(
                appError("HANDOFF_INVALID_INPUT", "the comment source must be a readable regular UTF-8 file"),
                ports,
                json,
              ),
            );
            return;
          }
          const result = mutate(createNodeReviewPorts(), {
            ...actorInputOf(globals),
            handoffId: id,
            expectedRevision: options.expectedRevision,
            expectedRowVersion: globals.expectedRowVersion,
            comment: text,
          });
          if (!result.ok) {
            reportExitCode(renderAppError(result.error, ports, json));
            return;
          }
          refreshMarker(id, ports);
          if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
          else ports.out(`Processing ${name} on ${id}; ${reportingSummary(result.value.handoff)}\n`);
        },
      );
  }

  const review = program.command("review").description("read, create, withdraw, and remove Review Notes");

  review
    .command("show <handoff-id>")
    .description("read the current Review Note; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = readReviewNote(createNodeHandoffReadPorts({ database: storage.db }), actorInputOf(globals), id);
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
        } else if (result.value === null) {
          ports.out("no Review Note\n");
        } else {
          ports.out(`${result.value.body}\n`);
          ports.out(`  targetRevision ${result.value.targetRevision}, author ${result.value.authorKind}\n`);
        }
      });
    });

  review
    .command("set <handoff-id>")
    .description("create or update this Handoff's Review Note as the recipient or the User")
    .option("--text <text>", "the note text inline")
    .option("--file <path>", "read the note text from a file, with ~ expansion")
    .requiredOption("--target-revision <n>", "the observed Revision the note targets", parseInteger)
    .action((id: string, options: { text?: string; file?: string; targetRevision?: number }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: this command requires --expected-row-version\nRun 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      if ((options.text === undefined) === (options.file === undefined)) {
        ports.err(`sorage: ${REVIEW_SET_ONE_SOURCE}\n`);
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
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: this command requires --expected-row-version\nRun 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
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
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: this command requires --expected-row-version\nRun 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
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
    .description(
      "replace the current Artifact or resolve the Review Note; expectedRowVersion is required for fresh mutation and optional only for successful recorded replay",
    )
    .option("--body <text>", "inline Markdown text materialized as the replacement document")
    .option("--file <path>", "the replacement document, with ~ expansion")
    .option("--no-change", "resolve the Review Note without changing content")
    .option("--reason <text>", "the reason a no-change resolution carries")
    .option("--idempotency-key <uuid>", "replay an identical revise instead of applying it again")
    .option("--allow-external-source", "revise from a source outside the resolved sender workspace")
    .action(
      (
        id: string,
        options: {
          body?: string;
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
        if (!requireInitialized(ports, json, reportExitCode, true)) return;
        // Commander parses --no-change as the negation of a defaulted `change` flag.
        const noChange = (options as { change?: boolean }).change === false;
        const suppliedSources = [options.body !== undefined, options.file !== undefined, noChange].filter(
          Boolean,
        ).length;
        if (suppliedSources !== 1) {
          ports.err(`sorage: ${REVISE_ONE_SOURCE}\n`);
          ports.err("Run 'sorage --help' for usage.\n");
          reportExitCode(2);
          return;
        }
        if (options.body !== undefined && options.body.trim() === "") {
          ports.err(`sorage: ${BODY_MUST_NOT_BE_EMPTY}\n`);
          ports.err("Run 'sorage --help' for usage.\n");
          reportExitCode(2);
          return;
        }
        // RUN-002: an intent-recording command drains at start before it revises.
        const vaultPorts = createNodeVaultCommandPorts({ contentionSurface: "handoff" });
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
        // Post-commit completion warnings buffer here and flush to stderr after
        // the committed result (SHR-015 category (i)).
        const reviseCompletionWarnings: string[] = [];
        const revisionPorts = createNodeRevisionPorts({
          completionWarning: (text) => reviseCompletionWarnings.push(text),
        });
        // WR3: buffered per-invocation disclosure with the same flush rules as
        // send and Memo (SHR-011, WR2).
        const reviseWarnings: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
        if (revisionPorts.disclosures !== undefined) {
          const composed = revisionPorts.disclosures;
          revisionPorts.disclosures = {
            ...composed,
            largeContent: (sizeBytes: number, thresholdBytes: number) => {
              reviseWarnings.push({ sizeBytes, thresholdBytes });
            },
          };
        }
        const result = reviseHandoff(revisionPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          body: options.body,
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
          let error = result.error;
          if (json) {
            try {
              if (reviseWarnings.length > 0)
                error = {
                  ...error,
                  message: `${error.message}; ${reviseWarnings.map((warning) => largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)).join(" ")}`,
                };
            } catch {
              // Formatting failure leaves the original error intact.
            }
          } else {
            for (const warning of reviseWarnings) {
              try {
                ports.err(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
              } catch {
                /* Best effort. */
              }
            }
          }
          reportExitCode(renderAppError(error, ports, json));
          return;
        }
        for (const warning of reviseWarnings) {
          try {
            ports.err(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
          } catch {
            // A diagnostic flush failure never changes a committed outcome.
          }
        }
        for (const text of reviseCompletionWarnings) {
          try {
            ports.err(`warning: ${text}\n`);
          } catch {
            // A diagnostic flush failure never changes a committed outcome.
          }
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      // --expected-row-version is a root-level global, so its requiredness is
      // enforced here rather than by a subcommand-local requiredOption (CLI-013).
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err(`sorage: ${ACCEPT_REQUIRES_ROW_VERSION}\n`);
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err(`sorage: ${DECLINE_REQUIRES_ROW_VERSION}\n`);
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
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
        if (!requireInitialized(ports, json, reportExitCode, true)) return;
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
        if (!requireInitialized(ports, json, reportExitCode, true)) return;
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
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
      const vaultPorts = createNodeVaultCommandPorts({ contentionSurface: "handoff" });
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      // Post-commit completion warnings buffer here and flush to stderr after
      // the committed result (SHR-015 category (i)).
      const approveCompletionWarnings: string[] = [];
      const result = approveDeletion(
        createNodeRetentionPorts({ completionWarning: (text) => approveCompletionWarnings.push(text) }),
        {
          ...actorInputOf(globals),
          handoffId: id,
          confirm: globals.confirm === true,
          confirmPinned: options.confirmPinned,
          idempotencyKey: options.idempotencyKey,
          expectedRowVersion: expectedRowVersionOf(globals),
        },
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      for (const text of approveCompletionWarnings) {
        try {
          ports.err(`warning: ${text}\n`);
        } catch {
          // A diagnostic flush failure never changes a committed outcome.
        }
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
      if (!requireInitialized(ports, json, reportExitCode, true)) return;
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

  const backup = program.command("backup").description("verify, run, and restore Vault backups");

  backup
    .command("run")
    .description("run one backup now: export the snapshot, commit managed changes, and report each outcome")
    .option("--idempotency-key <uuid>", "replay the identical run under the same key instead of running again")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const backupPorts = createNodeBackupCommandPorts();
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const runPorts = backupPorts.runPorts();
      if (!runPorts.ok) {
        reportExitCode(renderAppError(runPorts.error, ports, json));
        return;
      }
      const idempotencyKey =
        typeof options.idempotencyKey === "string" && options.idempotencyKey.trim() !== ""
          ? options.idempotencyKey
          : undefined;
      const result = runBackupCommand(runPorts.value, { idempotencyKey });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        const value = result.value;
        ports.out(
          `Backup ${value.outcome}: snapshot ${value.snapshot}, commit ${value.commit}, push ${value.push}${value.commitSha !== null ? ` (${value.commitSha.slice(0, 12)})` : ""}\n`,
        );
        if (value.replayed) ports.out("replayed from the recorded outcome of this idempotency key\n");
      }
    });

  backup
    .command("status")
    .description("report the backup history from backup_runs: last attempt, success, commit, push, and failure")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const backupPorts = createNodeBackupCommandPorts();
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const statusPorts = backupPorts.statusPorts();
      if (!statusPorts.ok) {
        reportExitCode(renderAppError(statusPorts.error, ports, json));
        return;
      }
      const report = backupStatus(statusPorts.value);
      if (!report.ok) {
        reportExitCode(renderAppError(report.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(report.value, requestId()), null, 2)}\n`);
      } else {
        const value = report.value;
        if (value.lastAttempt === null) {
          ports.out("No backup has run yet.\n");
        } else {
          ports.out(`Last attempt: ${value.lastAttempt.outcome} at ${value.lastAttempt.startedAt}\n`);
          if (value.lastCommit !== null) {
            ports.out(
              `Last commit: ${String(value.lastCommit.commitSha).slice(0, 12)} at ${value.lastCommit.startedAt}\n`,
            );
          } else {
            ports.out("Last commit: none\n");
          }
          if (value.lastFailure !== null) {
            ports.out(`Last failure: ${String(value.lastFailure.failureCode)} at ${value.lastFailure.startedAt}\n`);
          }
        }
        ports.out(
          value.schedule.enabled
            ? `Schedule: daily at ${value.schedule.at} in ${value.schedule.timezone}\n`
            : "Schedule: disabled\n",
        );
      }
    });

  backup
    .command("verify")
    .description(
      "run every vault verify check plus the Git configuration and snapshot consistency checks; never repairs",
    )
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const backupPorts = createNodeBackupCommandPorts();
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const verifyPorts = backupPorts.verifyPorts();
      if (!verifyPorts.ok) {
        reportExitCode(renderAppError(verifyPorts.error, ports, json));
        return;
      }
      const report = backupVerify(verifyPorts.value, { now: new Date() });
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
          `The Vault and its backup are consistent: ${report.value.checked.vault.recordedArtifacts} recorded Artifact(s), ${report.value.checked.manifest.handoffs} exported Handoff(s), ${report.value.checked.trackedFiles} tracked file(s).\n`,
        );
      }
      for (const warning of report.value.warnings) ports.err(`warning: ${warning}\n`);
      reportExitCode(blocking ? 1 : 0);
    });

  backup
    .command("enable")
    .description("turn the daily backup schedule on with its local time and zone")
    .requiredOption("--daily-at <HH:MM>", "the local time of day the schedule runs")
    .option("--timezone <zone>", "the IANA zone the local time lives in")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), {
        action: "enable",
        asUser: globals.asUser === true,
        dailyAt: options.dailyAt,
        timezone: options.timezone,
      });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("disable")
    .description("turn the daily backup schedule off")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), { action: "disable", asUser: globals.asUser === true });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("enable-push")
    .description("turn remote push on for one configured remote and branch; the push is a fast-forward only")
    .requiredOption("--remote <name>", "the Git remote name to push to")
    .requiredOption("--branch <name>", "the branch to push")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), {
        action: "enable-push",
        asUser: globals.asUser === true,
        remote: options.remote,
        branch: options.branch,
      });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("disable-push")
    .description("turn remote push off; local commits continue")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), { action: "disable-push", asUser: globals.asUser === true });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("restore")
    .description(
      "rebuild an empty installation from a Vault backup copy, adopting its installationId; the daemon must be stopped",
    )
    .requiredOption("--from <vault-path>", "the Vault copy to restore from")
    .option("--dry-run", "validate the backup and report the plan without writing")
    .option("--confirm", "required for the writing restore")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            appError(
              "USER_CONTEXT_REQUIRED",
              "sorage backup restore adopts another installation's identity and requires --as-user.",
            ),
            ports,
            json,
          ),
        );
        return;
      }
      // --confirm is a global option shared with the deletion commands, so
      // it arrives on the globals rather than a command-local flag.
      const dryRun = options.dryRun === true;
      const confirm = globals.confirm === true || options.confirm === true;
      if (dryRun === confirm) {
        ports.err("sorage: pass exactly one of --dry-run or --confirm.\n");
        ports.err("Run 'sorage backup restore --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      // A relative --from resolves against the cwd once, matching the vault
      // move's --to anchoring so the recorded path is stable across commands.
      const sourcePath = isAbsolute(options.from) ? options.from : resolve(options.from);
      const backupPorts = createNodeBackupCommandPorts({ sourcePath });
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const restorePorts = backupPorts.restorePorts();
      if (!restorePorts.ok) {
        reportExitCode(renderAppError(restorePorts.error, ports, json));
        return;
      }
      const result = backupRestore(restorePorts.value, { dryRun });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else if (result.value.dryRun) {
        const value = result.value;
        ports.out(`Dry run against ${value.sourcePath}:\n`);
        ports.out(
          `would create ${value.wouldCreate.projects} project(s), ${value.wouldCreate.handoffs} handoff(s), ${value.wouldCreate.reviewNotes} review note(s), ${value.wouldCreate.artifacts} artifact(s), and ${value.wouldCreate.events} ledger event(s)\n`,
        );
        ports.out(`would adopt installationId ${value.adoptedInstallationId}\n`);
        ports.out("nothing was written; run with --confirm to restore\n");
      } else {
        const value = result.value;
        ports.out(
          `Restored ${value.restored.handoffs} handoff(s) and ${value.restored.artifacts} artifact(s) from ${value.sourcePath}; adopted installationId ${value.adoptedInstallationId} and regenerated the API token.\n`,
        );
        ports.out(
          "Project directory bindings are machine-local and were not restored; re-bind them with sorage project bind.\n",
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

  const daemon = program.command("daemon").description("run and control the local daemon");
  daemon
    .command("start")
    .description("start the daemon and confirm it through health")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      if (!requireInitialized(ports, globals.json === true, reportExitCode)) return;
      reportExitCode(runDaemonCommand("start", ports));
    });
  daemon
    .command("stop")
    .description("stop the daemon after a graceful drain of in-flight requests")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      if (!requireInitialized(ports, globals.json === true, reportExitCode)) return;
      reportExitCode(runDaemonCommand("stop", ports));
    });
  daemon
    .command("restart")
    .description("stop and start again; required after a server.host or server.port change")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      if (!requireInitialized(ports, globals.json === true, reportExitCode)) return;
      reportExitCode(runDaemonCommand("restart", ports));
    });
  daemon
    .command("status")
    .description("read run/daemon.json and verify installationId through health")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      if (!requireInitialized(ports, globals.json === true, reportExitCode)) return;
      reportExitCode(runDaemonCommand("status", ports, { json: globals.json === true }));
    });
  daemon
    .command("serve", { hidden: true })
    .description("internal entry point that runs the daemon in the foreground until stopped");

  program
    .command("web")
    .description("start the daemon when needed and open the Web control plane with a one-time session secret")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      if (!requireInitialized(ports, globals.json === true, reportExitCode)) return;
      const home = createNodeHomePaths();
      const code = runWebCommand(createWebRuntimePorts(home.stateDir), ports, { openBrowser: true });
      reportExitCode(code);
    });

  program
    .command("mcp")
    .description("serve the STDIO MCP adapter whose tools mirror the messaging CLI (interface section 39)")
    // Reached when a global option precedes the command (`sorage --json mcp`)
    // or through help; excess operands are commander's own usage exit, and the
    // plain form is intercepted in `main` before parsing.
    .allowExcessArguments(false)
    .action(() => {
      serveMcp();
      reportExitCode(-1);
    });

  const token = program.command("token").description("manage the Installation API token");
  token
    .command("rotate")
    .description("replace the Installation API token, invalidating every live browser session")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const home = createNodeHomePaths();
      const result = rotateApiToken(
        { token: createNodeApiTokenStore({ stateDir: home.stateDir }) },
        { asUser: globals.asUser === true },
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      const payload = { rotated: true, note: "run sorage web again for a fresh browser session" };
      if (json) ports.out(`${JSON.stringify(successEnvelope(payload, requestId()), null, 2)}\n`);
      else
        ports.out(
          `API token rotated; every live browser session is invalidated.\nRun 'sorage web' again for a fresh session.\n`,
        );
    });

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
 * when the installation does not exist yet. Covered Handoff and Project commands
 * read operationally, so a present-but-unreadable configuration is CONFIG_INVALID
 * (SHR-015); excluded commands keep the plain read and NOT_INITIALIZED.
 */
function requireInitialized(
  ports: OutputPorts,
  json: boolean,
  reportExitCode: (code: number) => void,
  covered = false,
  options: RenderOptions = {},
): boolean {
  const gate = createNodeConfigCommandPorts();
  const current = covered ? gate.store.readForOperation() : gate.store.read();
  if (current.ok && current.value !== null) return true;
  if (!current.ok) {
    // A present but broken configuration is doctor territory, not a gate case.
    reportExitCode(renderAppError(current.error, ports, json, undefined, options));
    return false;
  }
  const error: AppError = {
    code: "NOT_INITIALIZED",
    message: "Sorage has not been initialized.",
    details: { expectedConfigPath: gate.configFile },
  };
  const id = requestId();
  if (options.log !== false) logCommandFailure(error, id);
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
export function runCli(
  argv: string[],
  ports: OutputPorts = defaultPorts,
  input: CommandInput = createStdinPrompt((text) => process.stderr.write(text)),
): number {
  let actionExitCode: number | null = null;
  const program = buildProgram(
    ports,
    (code) => {
      actionExitCode = code;
    },
    input,
  );
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
    // A covered zero-write read renders every failure without the log (RDR-001),
    // including the parser-stage and composition-stage failures that reach this
    // catch before or outside its action; the operand probe decides coverage.
    const render: RenderOptions = { log: !coveredReadInvocation(program, argv) };
    const admission = schemaAdmissionOf(error);
    if (admission !== null) return renderAppError(admission, ports, program.opts().json === true, undefined, render);
    // A composition-thrown typed error (SHR-015 storage-preparation refusal or
    // configuration carrier) renders through the envelope path; genuine
    // commander parse and usage errors keep the exit-2 fallthrough below.
    const carried = appCommandErrorOf(error);
    if (carried !== null) return renderAppError(carried, ports, program.opts().json === true, undefined, render);
    const commanderError = error as { code?: string; exitCode?: number; message?: string };
    if (commanderError.code === "commander.invalidArgument") {
      const memoContext = memoNumericErrorContext(program, argv);
      if (memoContext)
        return renderAppError(
          appError("MEMO_INVALID_INPUT", "Memo numeric values must be safe non-negative integers"),
          ports,
          memoContext.json,
          undefined,
          render,
        );
    }
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

type DaemonAction = "start" | "stop" | "restart" | "status";

/** The address of a daemon whose record is live, or null when none runs (CFG-016). */
function liveDaemonAddress(): { host: string; port: number } | null {
  const ports = createNodeDaemonPortsForCli();
  const record = ports.readDaemonRecord();
  if (record === null || !ports.isPidAlive(record.pid)) return null;
  return { host: record.host, port: record.port };
}

function createNodeDaemonPortsForCli() {
  return daemonCommandPorts.createNodeDaemonPorts();
}

/** Runs one routed configuration change through the daemon as a subprocess (CFG-016). */
function routedConfigSet(
  address: { host: string; port: number },
  key: string,
  value: string,
  ports: OutputPorts,
): number {
  const scriptArgs = process.argv[1]?.endsWith("main.ts")
    ? [process.argv[1] as string, "__config-put", address.host, String(address.port), key, value]
    : ["__config-put", address.host, String(address.port), key, value];
  const result = spawnSync(process.execPath, scriptArgs, { encoding: "utf8", timeout: 15000 });
  if (result.stdout) ports.out(result.stdout);
  if (result.stderr) ports.err(result.stderr);
  if (result.status === null) {
    return renderAppError(
      appError("DAEMON_UNAVAILABLE", "the daemon did not answer the routed configuration change"),
      ports,
      false,
    );
  }
  return result.status;
}

function runDaemonCommand(action: DaemonAction, ports: OutputPorts, options = { json: false }): number {
  const runtime = createDaemonRuntimePorts();
  const sinks = { out: ports.out, err: ports.err };
  if (action === "start") return daemonStart(runtime, sinks);
  if (action === "stop") return daemonStop(runtime, sinks);
  if (action === "restart") return daemonRestart(runtime, sinks);
  return daemonStatus(runtime, sinks, { json: options.json });
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

/**
 * The page-size default of section 13.9: the configured `ui.defaultPageSize`, never a CLI-local constant.
 * An operational read: a configuration that cannot be read refuses with the typed `CONFIG_INVALID`
 * (exit 78, nothing listed), and an absent file follows the factory mapping `NOT_INITIALIZED` (SHR-015).
 */
function defaultPageSize(): Result<number, AppError> {
  const gate = createNodeConfigCommandPorts();
  const current = gate.store.readForOperation();
  if (!current.ok) return err(current.error);
  if (current.value === null) {
    return err(
      appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: gate.configFile }),
    );
  }
  return ok(current.value.config.ui.defaultPageSize);
}

function listQueryOf(
  options: Record<string, unknown>,
  globals: Record<string, unknown>,
): Result<{ limit: number; cursor: string | undefined; filters: HandoffListFilters }, AppError> {
  const cursor = typeof globals.cursor === "string" ? globals.cursor : undefined;
  const filters: HandoffListFilters = {
    state: typeof options.state === "string" ? options.state : undefined,
    senderSlug: typeof options.sender === "string" ? options.sender : undefined,
    recipientSlug: typeof options.recipient === "string" ? options.recipient : undefined,
    updatedSince: typeof options.updatedSince === "string" ? options.updatedSince : undefined,
    updatedUntil: typeof options.updatedUntil === "string" ? options.updatedUntil : undefined,
    includeArchived: options.includeArchived === true,
    includeDeleted: options.includeDeleted === true,
  };
  if (typeof globals.limit === "number" && globals.limit > 0) {
    return ok({ limit: globals.limit, cursor, filters });
  }
  const limit = defaultPageSize();
  if (!limit.ok) return limit;
  return ok({ limit: limit.value, cursor, filters });
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
  for (const handoff of value.handoffs as HandoffView[]) {
    ports.out(`${handoff.id}  ${reportingSummary(handoff)}  ${handoff.title}
`);
  }
  if (value.nextCursor !== null) {
    ports.out(`next page: --cursor ${value.nextCursor}
`);
  }
}

function reportingSummary(handoff: HandoffView): string {
  const stopped = handoff.reviewState === "declined" || handoff.reviewState === "withdrawn";
  const comment =
    handoff.comment === null
      ? ""
      : `, ${handoff.comment.purpose} comment for revision ${handoff.comment.targetRevision}${handoff.comment.targetRevision < handoff.revision ? " (older revision)" : ""}`;
  return `${handoff.reviewState}, read ${handoff.read.status}, processing ${stopped ? `stopped (${handoff.processing.status})` : handoff.processing.status}${comment}`;
}

function readNoteFile(path: string): string | null {
  try {
    const resolved = expandTilde(path);
    if (!statSync(resolved).isFile()) return null;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(resolved));
  } catch {
    return null;
  }
}

/**
 * Rewrites the derived inbox marker (HND-026); a failure warns and never fails the command.
 * The marker is advisory derived-view refresh (SHR-015 category (ii)): even the
 * failure to create its ports warns contained and never changes the committed
 * result, and a throwing diagnostic sink changes nothing either.
 */
function refreshMarker(handoffId: string, ports: OutputPorts): void {
  let refreshed: ReturnType<typeof refreshInboxMarker>;
  try {
    refreshed = refreshInboxMarker(createNodeInboxMarkerPorts(), handoffId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ports.err(`warning: the inbox marker could not be refreshed: ${message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
    return;
  }
  if (!refreshed.ok) {
    try {
      ports.err(`warning: ${refreshed.error.message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
  }
}

function refreshProjectMarker(projectId: string, ports: OutputPorts): void {
  let refreshed: ReturnType<typeof refreshProjectInboxMarker>;
  try {
    refreshed = refreshProjectInboxMarker(createNodeInboxMarkerPorts(), projectId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ports.err(`warning: the project inbox marker could not be refreshed: ${message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
    return;
  }
  if (!refreshed.ok) {
    try {
      ports.err(`warning: ${refreshed.error.message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
  }
}

function renderUsageError(error: unknown, program: Command, ports: OutputPorts): number {
  const message = error instanceof Error ? error.message : String(error);
  ports.err(`${program.name()}: ${message}\n`);
  ports.err(`Run '${program.name()} --help' for usage.\n`);
  return 2;
}

/** The operand paths of the covered zero-write read commands (RDR-001). */
const COVERED_READ_OPERANDS: ReadonlyArray<readonly string[]> = [
  ["inbox"],
  ["outbox"],
  ["get"],
  ["events"],
  ["review", "show"],
  ["comment", "show"],
  ["memo", "list"],
  ["memo", "show"],
  ["project", "list"],
  ["project", "show"],
  ["channel", "messages"],
  ["channel", "list"],
  ["channel", "show"],
];

/**
 * Whether an invocation names a covered zero-write read, decided from its
 * operands alone through the same root-option probe the Memo numeric-error
 * context uses, so parser-stage failures that never reach an action can still
 * render without the log.
 */
export function coveredReadInvocation(program: Command, argv: string[]): boolean {
  const probe = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const option of program.options) probe.addOption(new Option(option.flags));
  try {
    const operands = probe.parseOptions(argv).operands;
    return COVERED_READ_OPERANDS.some((path) => path.every((token, index) => operands[index] === token));
  } catch {
    return false;
  }
}

/** Maps a throw escaping a covered read onto its typed envelope; nothing raw escapes. */
function thrownReadError(error: unknown): AppError {
  return (
    schemaAdmissionOf(error) ??
    appCommandErrorOf(error) ??
    appError("INTERNAL_ERROR", `The read failed: ${error instanceof Error ? error.message : String(error)}`)
  );
}

/**
 * The covered zero-write read composition (RDR-001, RDR-002): storage opens
 * read-only through the shared primitive, the body composes the existing
 * domain ports over the injected connection, the connection closes when the
 * body returns, and every failure — returned by the body or thrown by a
 * composition — renders without creating the log. No drain, migration, spool
 * sweep or cleanup runs on this path.
 */
export function withCoveredRead(
  ports: OutputPorts,
  json: boolean,
  reportExitCode: (code: number) => void,
  surface: "handoff" | "project",
  body: (storage: CoveredReadStorage) => void,
): void {
  let storage: Result<CoveredReadStorage, AppError>;
  try {
    storage = openCoveredReadStorage({ surface });
  } catch (error) {
    storage = err(thrownReadError(error));
  }
  if (!storage.ok) {
    reportExitCode(renderAppError(storage.error, ports, json, undefined, { log: false }));
    return;
  }
  try {
    body(storage.value);
  } catch (error) {
    reportExitCode(renderAppError(thrownReadError(error), ports, json, undefined, { log: false }));
  } finally {
    storage.value.close();
  }
}

/**
 * Re-admits storage on every listing page of a wait: each poll opens the
 * covered read afresh, so a wait that started on the in-memory copy of a
 * quiescent database follows a later writer onto its sidecars, and every
 * poll's storage refusal flows through the wait's own retry classification.
 * The actor scope and clock stay those of the initial composition.
 */
function pollingHandoffReadPorts(initial: HandoffDetailReadPorts): HandoffDetailReadPorts {
  return {
    ...initial,
    handoffs: {
      ...initial.handoffs,
      listPage: (scope, filters, limit, afterSortKey) => {
        let storage: Result<CoveredReadStorage, AppError>;
        try {
          storage = openCoveredReadStorage({ surface: "handoff" });
        } catch (error) {
          storage = err(thrownReadError(error));
        }
        if (!storage.ok) return err(storage.error);
        try {
          return createNodeHandoffReadPorts({ database: storage.value.db }).handoffs.listPage(
            scope,
            filters,
            limit,
            afterSortKey,
          );
        } catch (error) {
          return err(thrownReadError(error));
        } finally {
          storage.value.close();
        }
      },
    },
  };
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
/**
 * Whether the configured Vault currently opens, for the plain-init hint
 * (TASK-118): the write-free `statusPorts` probe reads configuration only and
 * never drains, so it can answer in exactly the states where reconfiguration is
 * unsafe. A successful reconfigure is never taken as proof that the Vault
 * opens, because the initializer preserves an existing invalid or foreign
 * marker.
 */
function configuredVaultOpens(): boolean {
  try {
    const ports = createNodeVaultCommandPorts().statusPorts();
    if (!ports.ok) return false;
    return ports.value.openVault().ok;
  } catch {
    return false;
  }
}

/**
 * The observed state of an existing configuration before initialization writes
 * anything (TASK-118 K1, Z2): only a confirmed ENOENT is a new installation. An
 * unreadable file or an untraversable home is an access failure, and a
 * non-regular entry, a dangling symlink, or a symlink loop at the path is a
 * path fault (a live symlink to a regular file is accepted); both stop `init`
 * with the matching repair instead of rewriting an existing installation.
 */
type ExistingConfiguration = "absent" | "present" | "unreadable" | "unsafe-path";

function existingConfiguration(paths: { configFile: string }): ExistingConfiguration {
  // K15: one path rule — a live symlink to a regular file is accepted, a
  // non-regular entry or loop is a path fault, only an lstat ENOENT is absence,
  // and any other inspection failure is access.
  const state = configurationPathState(
    probeConfigurationPath(
      () => statSync(paths.configFile),
      () => lstatSync(paths.configFile),
    ),
  );
  if (state === "absent") return "absent";
  if (state === "path-fault") return "unsafe-path";
  if (state === "access-failure") return "unreadable";
  try {
    readFileSync(paths.configFile);
  } catch {
    return "unreadable";
  }
  return "present";
}

/**
 * Applies one confirmed set of init choices (INIT-004, section 3.1 and 3.2): the base
 * installation first, then the optional pieces in configuration order — backup
 * schedule, remote push, first Project, LaunchAgent, and daemon start — so a failure
 * in any step reports exactly where the sequence stopped. `vaultOption` is the
 * literal `--vault` value; when the choices keep the documented default the use case
 * receives `undefined` so `config.yaml` records the `~/.sorage/vault` default.
 * TASK-118 K1: an existing configuration that cannot be read, or whose home cannot
 * be traversed, stops here before the initializer can treat the installation as new.
 */
function applyInitChoices(
  ports: OutputPorts,
  json: boolean,
  reportExitCode: ReportExitCode,
  choices: InitChoices,
  vaultOption: string | undefined,
  reconfigure = false,
): void {
  const homePaths = createNodeHomePaths();
  const sentinel = join(homePaths.home, "vault");
  const wizardDefault = vaultOption ?? sentinel;
  const vaultForUseCase = choices.vaultPath === wizardDefault ? vaultOption : choices.vaultPath;

  const existing = existingConfiguration(homePaths);
  if (existing === "unreadable" || existing === "unsafe-path") {
    // K1/Z2: never treat an access failure as a new installation. The refusal
    // leaves the configuration, identity and Vault untouched.
    const message =
      existing === "unsafe-path"
        ? `The configuration path ${homePaths.configFile} is not a regular file.`
        : `The configuration at ${homePaths.configFile} cannot be read.`;
    const recovery = existing === "unsafe-path" ? CONFIG_PATH_REPAIR : CONFIG_ACCESS_REPAIR;
    reportExitCode(
      renderAppError({ code: "CONFIG_INVALID", message, recovery: { suggestedCommand: recovery } }, ports, json),
    );
    return;
  }

  if (!choices.createVault && !existsSync(choices.vaultPath)) {
    ports.err(`${CLI_NAME}: the Vault directory ${choices.vaultPath} does not exist and its creation was declined\n`);
    ports.err(`Run '${CLI_NAME} --help' for usage.\n`);
    reportExitCode(2);
    return;
  }

  const result = initializeInstallation(createNodeInitPorts(), {
    vaultPath: vaultForUseCase,
    reconfigure,
    initializeGit: choices.initializeGit,
    serverPort: choices.serverPort,
  });
  if (!result.ok) {
    // A malformed configuration routes to the doctor, which names every defect.
    reportExitCode(
      renderAppError(result.error, ports, json, result.error.code === "CONFIG_INVALID" ? "sorage doctor" : undefined),
    );
    return;
  }

  const created = result.value.outcome === "created";
  const installsServiceOnExisting = !created && reconfigure && choices.installService;
  if (!created && !installsServiceOnExisting) {
    // A plain repeat reports status only. Explicit reconfiguration may continue
    // into the idempotent LaunchAgent installer below because no other command
    // can add or refresh that optional service on an existing Installation.
    if (json) {
      ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
    } else {
      ports.out(`Sorage is already initialized at ${result.value.home}\n`);
      ports.out(`Installation: ${result.value.installationId}\n`);
      ports.out(`Vault: ${result.value.vaultPath}\n`);
      if (result.value.git !== undefined) {
        ports.out(
          result.value.git.existingReported
            ? "An existing Git repository was found at the Vault and was left untouched.\n"
            : "Initialized the Vault Git repository with core.autocrlf=false.\n",
        );
      } else {
        ports.out(
          configuredVaultOpens()
            ? `Nothing was changed; run '${CLI_NAME} init --reconfigure --non-interactive' for explicit repair.\n`
            : "Nothing was changed; the configured Vault cannot be opened, so reconfiguration is not suggested. Resolve the Vault-open refusal first.\n",
        );
      }
    }
    return;
  }

  // Every optional step runs before any rendering, so the JSON envelope reports
  // side effects that actually happened rather than the ones that were requested.
  const report: Record<string, unknown> = { ...result.value };
  const lines: string[] = created
    ? [
        `Initialized Sorage at ${result.value.home}\n`,
        `Installation: ${result.value.installationId}\n`,
        `Vault: ${result.value.vaultPath}\n`,
      ]
    : [
        `Sorage is already initialized at ${result.value.home}\n`,
        `Installation: ${result.value.installationId}\n`,
        `Vault: ${result.value.vaultPath}\n`,
      ];
  if (result.value.git !== undefined) {
    lines.push(
      result.value.git.initialized
        ? "Initialized the Vault Git repository with core.autocrlf=false.\n"
        : "An existing Git repository was found at the Vault and was left untouched.\n",
    );
  }

  if (created && choices.enableDailyBackup) {
    const enabled = configureBackup(backupConfigPorts(), {
      action: "enable",
      // The wizard or the flag pair carries the same intent the backup command's
      // --as-user gate protects, confirmed interactively or explicitly at init time.
      asUser: true,
      dailyAt: choices.backupAt,
      timezone: choices.backupTimezone,
    });
    if (!enabled.ok) {
      reportExitCode(renderAppError(enabled.error, ports, json));
      return;
    }
    report.backup = { enabled: true, at: choices.backupAt, timezone: choices.backupTimezone };
    lines.push(`Enabled daily backup at ${choices.backupAt} ${choices.backupTimezone}.\n`);
  }
  if (created && choices.enablePush) {
    const push = configureBackup(backupConfigPorts(), {
      action: "enable-push",
      asUser: true,
      remote: choices.pushRemote,
      branch: choices.pushBranch,
    });
    if (!push.ok) {
      reportExitCode(renderAppError(push.error, ports, json));
      return;
    }
    report.push = { remote: choices.pushRemote, branch: choices.pushBranch };
    lines.push(`Enabled remote push to ${choices.pushRemote} ${choices.pushBranch}.\n`);
  }
  if (created && choices.registerProject) {
    const project = addProject(createNodeProjectPorts(), {
      name: choices.projectName,
      dir: choices.projectDir,
      userHome: homedir(),
      actor: USER_ACTOR,
    });
    if (!project.ok) {
      reportExitCode(renderAppError(project.error, ports, json));
      return;
    }
    report.project = {
      slug: project.value.project.slug,
      displayName: project.value.project.displayName,
      binding: project.value.binding.directory,
    };
    lines.push(`Added Project ${project.value.project.slug} (${project.value.project.displayName})\n`);
    lines.push(`Bound ${project.value.binding.bindingKind} ${project.value.binding.directory}\n`);
  }
  if (choices.installService) {
    const installed = installLaunchAgent(createNodeLaunchAgentPorts(), {
      program: {
        binaryPath: process.execPath,
        scriptArgs: process.argv[1]?.endsWith("main.ts") ? [process.argv[1] as string] : [],
      },
      sorageHome: homePaths.home,
      agentsDirectory: launchAgentsDirectory(),
      uid: launchAgentUid(),
    });
    if (!installed.ok) {
      reportExitCode(renderAppError(installed.error, ports, json));
      return;
    }
    report.service = { label: "xyz.rootkernel.sorage", plistPath: installed.value.plistPath };
    if (choices.startDaemon) lines.push("--start-daemon is subsumed: the LaunchAgent starts the daemon now.\n");
    lines.push(
      installed.value.bootstrapped
        ? `Installed the xyz.rootkernel.sorage LaunchAgent at ${installed.value.plistPath}; the daemon starts now and at every login.\n`
        : `Wrote the xyz.rootkernel.sorage LaunchAgent plist at ${installed.value.plistPath}; the agent was already loaded.\n`,
    );
  }
  if (created && choices.startDaemon && !choices.installService) {
    const code = daemonStart(createDaemonRuntimePorts(), ports);
    if (code !== 0) {
      reportExitCode(code);
      return;
    }
    report.daemon = { started: true };
    lines.push("Started the daemon.\n");
  }

  if (json) {
    ports.out(`${JSON.stringify(successEnvelope(report, requestId()), null, 2)}\n`);
  } else {
    ports.out(lines.join(""));
  }
}

function backupConfigPorts(): {
  read(): ReturnType<import("@sorage/core").BackupConfigPorts["read"]>;
  write(
    next: Configuration,
    expect: { etag: string },
  ): { ok: true; value: { etag: string } } | { ok: false; error: AppError };
} {
  const commandPorts = createNodeConfigCommandPorts();
  const store = commandPorts.store;
  return {
    read: () => {
      const read = store.read();
      if (!read.ok) return read;
      if (read.value === null) return ok(null);
      return ok({ config: read.value.config, etag: read.value.etag });
    },
    write: (next, expect) => {
      const written = store.write(next, { etag: expect.etag });
      if (!written.ok) return written;
      return ok({ etag: written.value.etag });
    },
  };
}

function reportBackupConfig(
  result: { ok: true; value: { gitBackup: unknown } } | { ok: false; error: AppError },
  ports: OutputPorts,
  json: boolean,
  reportExitCode: (code: number) => void,
): void {
  if (!result.ok) {
    reportExitCode(renderAppError(result.error, ports, json));
    return;
  }
  if (json) {
    ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
  } else {
    ports.out("Backup configuration updated.\n");
  }
}

/** Whether a failure rendering also records the failure in the installation log. */
export interface RenderOptions {
  /**
   * `false` for the covered zero-write reads of RDR-001, whose failures render
   * without creating or rotating the installation log, including on failure.
   * On such a render an `INTERNAL_ERROR` with no site recovery carries the
   * log-free recovery — the covered reads never write the log the catalogue
   * default points at, so the recovery names the request id and the retained
   * output instead (the model of send-recovery and preflight's inspection
   * guidance, and a property of the log-free render itself).
   */
  log?: boolean;
}

/** The log-free `INTERNAL_ERROR` recovery, so no covered-read route can miss it. */
function logFreeInternalRecovery(requestId: string): string {
  return `Retain request ${requestId} and this output, then retry the read. This failure wrote no installation log.`;
}

export function renderAppError(
  error: AppError,
  ports: OutputPorts,
  json: boolean,
  recoveryOverride?: string,
  options: RenderOptions = {},
): number {
  const spec = errorSpec(error.code);
  const id = requestId();
  const rendered: AppError =
    options.log === false && error.code === "INTERNAL_ERROR" && error.recovery === undefined
      ? { ...error, recovery: { suggestedCommand: logFreeInternalRecovery(id) } }
      : error;
  if (options.log !== false) logCommandFailure(error, id);
  if (json) {
    ports.err(`${JSON.stringify(errorEnvelope(rendered, id), null, 2)}\n`);
  } else {
    ports.err(`${error.code}: ${error.message}\n`);
    const recovery = recoveryOverride ?? rendered.recovery?.suggestedCommand ?? spec.recovery?.suggestedCommand;
    if (recovery !== undefined) ports.err(`Recovery: ${recovery}\n`);
  }
  return spec.exitCode;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  // The health probe is a synchronous subprocess helper for `sorage web`: it answers
  // 0 when a daemon responds at the address and 1 when nothing does.
  if (argv[0] === "__health-probe") {
    const host = argv[1] ?? "127.0.0.1";
    const port = Number.parseInt(argv[2] ?? "46321", 10);
    const expected = argv[3];
    void probeHealthOnce(host, port)
      .then((body) => {
        process.exit(body !== null && (expected === undefined || body.installationId === expected) ? 0 : 1);
      })
      .catch(() => {
        process.exit(1);
      });
    // The probe owns the process until its answer exists; nothing else may run.
    return -1;
  }
  if (argv[0] === "__config-put") {
    const host = argv[1] ?? "127.0.0.1";
    const port = Number.parseInt(argv[2] ?? "46321", 10);
    const key = argv[3] ?? "";
    const value = argv[4] ?? "";
    void configPutOnce(host, port, key, value).then((outcome) => {
      if (outcome !== null) process.stdout.write(`${JSON.stringify(outcome.body, null, 2)}\n`);
      process.exit(
        outcome === null
          ? 1
          : (outcome.body as { ok: boolean }).ok
            ? 0
            : errorSpec((outcome.body as { error: { code: Parameters<typeof errorSpec>[0] } }).error.code).exitCode,
      );
    });
    return -1;
  }
  if (argv[0] === "__port-probe") {
    const host = argv[1] ?? "127.0.0.1";
    const port = Number.parseInt(argv[2] ?? "46321", 10);
    void portHeldOnce(host, port)
      .then((held) => {
        process.exit(held ? 0 : 1);
      })
      .catch(() => {
        process.exit(1);
      });
    return -1;
  }
  // `sorage mcp` runs the long-lived STDIO MCP server of interface section 39;
  // like `daemon serve` it owns the event loop rather than fitting the
  // synchronous command pipeline. Exactly `["mcp"]` is intercepted; `--help`
  // and `-h` fall through to the registered command, and every other form
  // reaches commander's own handling.
  if (argv.length === 1 && argv[0] === "mcp") {
    serveMcp();
    return -1;
  }
  // `daemon serve` runs the long-lived daemon process; it is spawned detached by
  // `sorage web` and by the lifecycle commands of TASK-044, so it owns the event loop
  // rather than fitting the synchronous command pipeline.
  if (argv[0] === "daemon" && argv[1] === "serve") {
    const { serveDaemon } = daemonRuntime();
    Promise.resolve()
      .then(() =>
        serveDaemon({
          armSignals: (drain) => {
            process.on("SIGTERM", drain);
            process.on("SIGINT", drain);
          },
        }),
      )
      .then(() => {
        process.stdout.write(`sorage daemon serving\n`);
      })
      .catch((error: unknown) => {
        const admission = schemaAdmissionOf(error);
        if (admission !== null) {
          process.exitCode = renderAppError(admission, defaultPorts, argv.includes("--json"));
          return;
        }
        const typed = error as AppError | null;
        if (typed?.code === "STORAGE_SCHEMA_UNSUPPORTED" || typed?.code === "STORAGE_INTEGRITY_ERROR") {
          process.exitCode = renderAppError(typed, defaultPorts, argv.includes("--json"));
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`the daemon could not start: ${message}\n`);
        // PORT_IN_USE and SERVICE_PAUSED carry their documented exit codes; an
        // unrecognized failure stays in the invalid-configuration category.
        const code = (error as { code?: unknown } | null)?.code;
        process.exitCode = typeof code === "string" ? errorSpec(code as Parameters<typeof errorSpec>[0]).exitCode : 78;
      });
    // The daemon owns the process until it stops; the serve promise keeps it alive.
    return -1;
  }
  return runCli(argv);
}

function daemonRuntime(): typeof import("@sorage/daemon") {
  return daemonModule;
}

function probeHealthOnce(host: string, port: number): Promise<{ installationId: string } | null> {
  return new Promise((resolve) => {
    const outgoing = httpRequest(
      { host, port, path: "/api/v1/health", method: "GET", headers: { host: `127.0.0.1:${port}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: { installationId?: string } };
            resolve(
              typeof body.data?.installationId === "string" ? { installationId: body.data.installationId } : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    outgoing.setTimeout(2000, () => {
      outgoing.destroy();
      resolve(null);
    });
    outgoing.on("error", () => resolve(null));
    outgoing.end();
  });
}

interface ConfigPutOutcome {
  ok: boolean;
  body: unknown;
}

/**
 * The routed configuration change (CFG-016): a GET for the ETag, then the PUT.
 * After a rotation the read half retries exactly once with a re-read token; the
 * PUT never retries, so a rotation can never cause a write to run twice (SEC-020).
 */
export function configPutOnce(
  host: string,
  port: number,
  key: string,
  value: string,
): Promise<ConfigPutOutcome | null> {
  const stateDir = join(createNodeHomePaths().stateDir);
  const { readApiToken } = webModule();
  const token = readApiToken(stateDir);
  if (token === null) {
    return Promise.resolve({
      ok: false,
      body: { ok: false, error: { code: "TOKEN_INVALID", message: "the Installation API token is missing" } },
    });
  }
  const headersFor = (bearer: string) => ({
    host: `127.0.0.1:${port}`,
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
  });
  return new Promise((resolve) => {
    // Section 17.1: after a rotation the CLI retries once, and only for the
    // read half of the routed change; the PUT never retries, so a rotation can
    // never cause a write to run twice.
    const issue = (bearer: string, retried: boolean): void => {
      const getOutgoing = httpRequest(
        { host, port, path: "/api/v1/config", method: "GET", headers: headersFor(bearer) },
        (getResponse) => {
          const chunks: Buffer[] = [];
          getResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          getResponse.on("end", () => {
            if (getResponse.statusCode === 401 && !retried) {
              const { readApiToken } = webModule();
              const fresh = readApiToken(stateDir);
              if (fresh !== null && fresh !== bearer) {
                issue(fresh, true);
                return;
              }
            }
            const etag = String(getResponse.headers.etag ?? "");
            const putOutgoing = httpRequest(
              {
                host,
                port,
                path: "/api/v1/config",
                method: "PUT",
                headers: { ...headersFor(bearer), "if-match": etag },
              },
              (putResponse) => {
                const putChunks: Buffer[] = [];
                putResponse.on("data", (chunk: Buffer) => putChunks.push(chunk));
                putResponse.on("end", () => {
                  try {
                    resolve({
                      ok: putResponse.statusCode === 200,
                      body: JSON.parse(Buffer.concat(putChunks).toString("utf8")),
                    });
                  } catch {
                    resolve(null);
                  }
                });
              },
            );
            putOutgoing.on("error", () => resolve(null));
            putOutgoing.end(JSON.stringify({ key, value }));
          });
        },
      );
      getOutgoing.setTimeout(5000, () => {
        getOutgoing.destroy();
        resolve(null);
      });
      getOutgoing.on("error", () => resolve(null));
      getOutgoing.end();
    };
    issue(token, false);
  });
}

function webModule(): typeof import("./web") {
  return webBindings;
}

function portHeldOnce(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

export type { Envelope };

if (import.meta.main) {
  const code = main();
  // A negative code means an internal probe owns the process and exits itself.
  // Let pending stdout/stderr writes drain, including full Memo bodies piped to a slow reader.
  if (code >= 0) process.exitCode = code;
}
