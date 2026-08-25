import { Command, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  errorSpec,
  successEnvelope,
  errorEnvelope,
  protocolVersion,
  initializeInstallation,
  type AppError,
  type Envelope,
} from "@sorage/core";
// Deep import: the adapters index also exports the testkit, which is vitest-only and
// must never load inside the shipped CLI process.
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDoctorPorts } from "@sorage/adapters/src/doctor";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { createLogger, type Logger } from "@sorage/adapters/src/logging";
import { runDoctor, hasBlockingCheck, type DoctorReport } from "@sorage/core";
import { editConfiguration, setConfigurationValue, showConfiguration, validateConfigurationFile } from "@sorage/core";

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

  program.helpOption("-h, --help", "display help for the command");

  return program;
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
