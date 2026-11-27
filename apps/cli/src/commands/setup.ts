import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createNodeConfigCommandPorts, probeConfigurationPath } from "@sorage/adapters/src/config-command-ports";
import { createNodeDoctorPorts } from "@sorage/adapters/src/doctor";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createNodeBackgroundServicePort } from "@sorage/adapters/src/launchagent-ports";
import { createNodeProjectPorts } from "@sorage/adapters/src/project-command-ports";
import { createNodeUninstallPorts } from "@sorage/adapters/src/uninstall-ports";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  addProject,
  appError,
  applyInitChoices,
  configurationPathState,
  configureBackup,
  type DoctorReport,
  type ExistingConfigurationState,
  err,
  hasBlockingCheck,
  initializeInstallation,
  ok,
  runDoctor,
  successEnvelope,
  USER_ACTOR,
  uninstallInstallation,
} from "@sorage/core";
import type { Command } from "commander";
import {
  CLI_NAME,
  CLI_VERSION,
  type OutputPorts,
  parseInteger,
  type ReportExitCode,
  renderAppError,
  requestId,
  withPorts,
} from "../cli-output";
import { createDaemonRuntimePorts, daemonStart, daemonStop } from "../daemon-commands";
import { type InitChoices, type PromptPorts, runInitWizard } from "../init-wizard";
import { runPreflightCommand } from "../preflight-command";
import { selfInvocationScriptArgs } from "../self-invocation";
import { backupConfigPorts } from "./backup";

function renderDoctorReport(report: DoctorReport, ports: OutputPorts): void {
  for (const check of report.checks) {
    ports.out(`[${check.severity}] ${check.id} — ${check.message}\n`);
    if (check.recovery !== undefined) ports.out(`        recovery: ${check.recovery.suggestedCommand}\n`);
  }
}

function configuredVaultOpens(): boolean {
  try {
    const vaultPorts = createNodeVaultCommandPorts().statusPorts();
    if (!vaultPorts.ok) return false;
    return vaultPorts.value.openVault().ok;
  } catch {
    return false;
  }
}

function existingConfiguration(paths: { configFile: string }): ExistingConfigurationState {
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

function runInitChoices(
  ports: OutputPorts,
  json: boolean,
  reportExitCode: ReportExitCode,
  choices: InitChoices,
  vaultOption: string | undefined,
  reconfigure = false,
): void {
  const homePaths = createNodeHomePaths();
  const outcome = applyInitChoices(
    {
      configFile: homePaths.configFile,
      defaultVaultPath: join(homePaths.home, "vault"),
      existingConfiguration: () => existingConfiguration(homePaths),
      vaultExists: (path) => existsSync(path),
      initialize: (options) => initializeInstallation(createNodeInitPorts(), options),
      configuredVaultOpens,
      configureBackup: (input) => configureBackup(backupConfigPorts(), input),
      addProject: ({ name, dir }) =>
        withPorts(createNodeProjectPorts(), (projectPorts) =>
          addProject(projectPorts, { name, dir, userHome: homedir(), actor: USER_ACTOR }),
        ),
      installService: () =>
        createNodeBackgroundServicePort().install({
          program: {
            binaryPath: process.execPath,
            scriptArgs: selfInvocationScriptArgs(),
          },
          sorageHome: homePaths.home,
        }),
      startDaemon: () => {
        const code = daemonStart(createDaemonRuntimePorts(), { out: () => {}, err: ports.err }, { json });
        return code === 0 ? { ok: true } : { ok: false, exitCode: code };
      },
    },
    { choices, vaultOption, reconfigure, probeVaultOpens: !json },
  );

  if (outcome.kind === "declined-missing-vault") {
    ports.err(`${CLI_NAME}: the Vault directory ${outcome.vaultPath} does not exist and its creation was declined\n`);
    ports.err(`Run '${CLI_NAME} --help' for usage.\n`);
    reportExitCode(2);
    return;
  }
  if (outcome.kind === "error") {
    reportExitCode(renderAppError(outcome.error, ports, json, outcome.recoveryOverride));
    return;
  }
  if (outcome.kind === "daemon-start-failed") {
    reportExitCode(outcome.exitCode);
    return;
  }
  if (outcome.kind === "already-initialized") {
    if (json) {
      ports.out(`${JSON.stringify(successEnvelope(outcome.init, requestId()), null, 2)}\n`);
    } else {
      ports.out(`Sorage is already initialized at ${outcome.init.home}\n`);
      ports.out(`Installation: ${outcome.init.installationId}\n`);
      ports.out(`Vault: ${outcome.init.vaultPath}\n`);
      if (outcome.init.git !== undefined) {
        ports.out(
          outcome.init.git.existingReported
            ? "An existing Git repository was found at the Vault and was left untouched.\n"
            : "Initialized the Vault Git repository with core.autocrlf=false.\n",
        );
      } else {
        ports.out(
          outcome.vaultOpens
            ? `Nothing was changed; run '${CLI_NAME} init --reconfigure --non-interactive' for explicit repair.\n`
            : "Nothing was changed; the configured Vault cannot be opened, so reconfiguration is not suggested. Resolve the Vault-open refusal first.\n",
        );
      }
    }
    return;
  }

  const report: Record<string, unknown> = { ...outcome.init };
  const lines: string[] = outcome.created
    ? [
        `Initialized Sorage at ${outcome.init.home}\n`,
        `Installation: ${outcome.init.installationId}\n`,
        `Vault: ${outcome.init.vaultPath}\n`,
      ]
    : [
        `Sorage is already initialized at ${outcome.init.home}\n`,
        `Installation: ${outcome.init.installationId}\n`,
        `Vault: ${outcome.init.vaultPath}\n`,
      ];
  if (outcome.init.git !== undefined) {
    lines.push(
      outcome.init.git.initialized
        ? "Initialized the Vault Git repository with core.autocrlf=false.\n"
        : "An existing Git repository was found at the Vault and was left untouched.\n",
    );
  }
  if (outcome.backup !== undefined) {
    report.backup = outcome.backup;
    lines.push(`Enabled daily backup at ${outcome.backup.at} ${outcome.backup.timezone}.\n`);
  }
  if (outcome.push !== undefined) {
    report.push = outcome.push;
    lines.push(`Enabled remote push to ${outcome.push.remote} ${outcome.push.branch}.\n`);
  }
  if (outcome.project !== undefined) {
    report.project = {
      slug: outcome.project.slug,
      displayName: outcome.project.displayName,
      binding: outcome.project.binding,
    };
    lines.push(`Added Project ${outcome.project.slug} (${outcome.project.displayName})\n`);
    lines.push(`Bound ${outcome.project.bindingKind} ${outcome.project.binding}\n`);
  }
  if (outcome.service !== undefined) {
    report.service = { label: outcome.service.label, plistPath: outcome.service.plistPath };
    if (outcome.service.subsumedStartDaemon) {
      lines.push("--start-daemon is subsumed: the LaunchAgent starts the daemon now.\n");
    }
    lines.push(
      outcome.service.bootstrapped
        ? `Installed the xyz.rootkernel.sorage LaunchAgent at ${outcome.service.plistPath}; the daemon starts now and at every login.\n`
        : `Wrote the xyz.rootkernel.sorage LaunchAgent plist at ${outcome.service.plistPath}; the agent was already loaded.\n`,
    );
  }
  if (outcome.daemonStarted === true) {
    report.daemon = { started: true };
    lines.push("Started the daemon.\n");
  }

  if (json) {
    ports.out(`${JSON.stringify(successEnvelope(report, requestId()), null, 2)}\n`);
  } else {
    ports.out(lines.join(""));
  }
}

export function registerSetupCommands(
  program: Command,
  ports: OutputPorts,
  reportExitCode: ReportExitCode,
  input: PromptPorts,
): void {
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
      runInitChoices(ports, json, reportExitCode, choices, vaultOption, options.reconfigure === true);
    });

  program
    .command("uninstall")
    .description("remove the Sorage installation while keeping the Vault")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const uninstallPorts = createNodeUninstallPorts({
        stopDaemon: () => {
          const code = daemonStop(createDaemonRuntimePorts(), { out: () => {}, err: () => {} }, { json, log: false });
          // A non-zero stop leaves the daemon running, and the use case refuses
          // to remove live state from under it rather than reporting success.
          return code === 0
            ? ok({ stopped: true })
            : err(appError("DAEMON_UNAVAILABLE", "sorage daemon stop did not end the daemon."));
        },
      });
      const result = uninstallInstallation(uninstallPorts, {
        asUser: globals.asUser === true,
        confirm: globals.confirm === true,
      });
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
}

export function registerDoctorCommand(program: Command, ports: OutputPorts, reportExitCode: ReportExitCode): void {
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
}
