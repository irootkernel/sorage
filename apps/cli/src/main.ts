import { Command, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { errorSpec, successEnvelope, errorEnvelope, protocolVersion, type AppError, type Envelope } from "@sorage/core";

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
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new InvalidArgumentError("expected a non-negative integer");
  }
  return parsed;
}

export function buildProgram(ports: OutputPorts = defaultPorts): Command {
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

  program.helpOption("-h, --help", "display help for the command");

  return program;
}

/** Runs one CLI invocation and returns its process exit code without exiting. */
export function runCli(argv: string[], ports: OutputPorts = defaultPorts): number {
  const program = buildProgram(ports);
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

/** Maps an application error to its envelope rendering and published exit code. */
export function renderAppError(error: AppError, ports: OutputPorts, json: boolean): number {
  const spec = errorSpec(error.code);
  if (json) {
    ports.err(`${JSON.stringify(errorEnvelope(error, requestId()), null, 2)}\n`);
  } else {
    ports.err(`${error.code}: ${error.message}\n`);
    if (spec.recovery !== undefined) ports.err(`Recovery: ${spec.recovery.suggestedCommand}\n`);
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
