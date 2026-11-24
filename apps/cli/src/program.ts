import { appCommandErrorOf, schemaAdmissionOf } from "@sorage/adapters/src/daemon-command-ports";
import { appError, channelError, memoError } from "@sorage/core";
import { Command, InvalidArgumentError } from "commander";
import { registerChannelCommands } from "./channel-commands";
import {
  CLI_NAME,
  defaultPorts,
  failureLogger,
  type OutputPorts,
  parseInteger,
  type RenderOptions,
  type ReportExitCode,
  renderAppError,
  renderUsageError,
  requestId,
  requireInitialized,
} from "./cli-output";
import { registerBackupCommands } from "./commands/backup";
import { registerConfigCommands } from "./commands/config";
import { registerHandoffMutationCommands, registerHandoffSendCommand } from "./commands/handoff";
import { registerHandoffReadCommands } from "./commands/handoff-read";
import { registerProjectCommands } from "./commands/project";
import { registerRuntimeCommands } from "./commands/runtime";
import { registerDoctorCommand, registerSetupCommands } from "./commands/setup";
import { registerVaultCommands } from "./commands/vault";
import { coveredReadInvocation } from "./covered-read";
import { registerExchangeCommands } from "./exchange-commands";
import { createStdinPrompt, type PromptPorts } from "./init-wizard";
import { memoNumericErrorContext, registerMemoCommands } from "./memo-commands";

export interface GlobalOptions {
  as?: string;
  asUser: boolean;
  confirm: boolean;
  expectedRowVersion?: number;
  limit?: number;
  cursor?: string;
  json: boolean;
}

/** The command surface's input side: prompts for the interactive wizard, injectable for tests. */
export type CommandInput = PromptPorts;

export interface RunCliOptions {
  /** Synchronous callback invoked when Commander matches `mcp` (e.g. `sorage --json mcp`). */
  onMcpRequested?: (() => void) | undefined;
}

export function buildProgram(
  ports: OutputPorts = defaultPorts,
  reportExitCode: ReportExitCode = () => {},
  input: CommandInput = createStdinPrompt((text) => process.stderr.write(text)),
  exchangeProcess = false,
  options: RunCliOptions = {},
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

  registerSetupCommands(program, ports, reportExitCode, input);
  registerConfigCommands(program, ports, reportExitCode);
  registerDoctorCommand(program, ports, reportExitCode);

  registerMemoCommands(program, {
    out: ports.out,
    requestId,
    warn: (text) => ports.err(text),
    fail: (error, json, renderOptions) => {
      reportExitCode(renderAppError(memoError(error), ports, json, undefined, renderOptions));
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
    fail: (error, json, renderOptions) => {
      reportExitCode(renderAppError(channelError(error), ports, json, undefined, renderOptions));
    },
    usageExit: () => {
      reportExitCode(2);
    },
  });

  registerExchangeCommands(
    program,
    {
      out: ports.out,
      err: ports.err,
      exit: reportExitCode,
      requestId,
      fail: (error, json, fresh) =>
        reportExitCode(
          renderAppError(
            error,
            ports,
            json,
            undefined,
            fresh ? { logMessage: "An admitted Exchange write returned a failure." } : { log: false },
          ),
        ),
      activationWarning: (code, id) => {
        try {
          failureLogger()?.warn("exchange.activation_warning", { code, requestId: id });
        } catch {
          // A logging failure cannot change the committed result.
        }
      },
    },
    exchangeProcess,
  );

  registerProjectCommands(program, ports, reportExitCode);
  registerHandoffSendCommand(program, ports, reportExitCode);
  registerHandoffReadCommands(program, ports, reportExitCode);
  registerHandoffMutationCommands(program, ports, reportExitCode);
  registerVaultCommands(program, ports, reportExitCode);
  registerBackupCommands(program, ports, reportExitCode);
  registerRuntimeCommands(program, ports, reportExitCode, options.onMcpRequested);

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

/** Runs one CLI invocation synchronously and returns its process exit code without exiting. */
export function runCli(
  argv: string[],
  ports: OutputPorts = defaultPorts,
  input: CommandInput = createStdinPrompt((text) => process.stderr.write(text)),
  exchangeProcess = false,
  options: RunCliOptions = {},
): number {
  let actionExitCode: number | null = null;
  let parsingDone = false;
  const program = buildProgram(
    ports,
    (code) => {
      actionExitCode = code;
      if (parsingDone && exchangeProcess) process.exitCode = code;
    },
    input,
    exchangeProcess,
    options,
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
  } finally {
    parsingDone = true;
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
