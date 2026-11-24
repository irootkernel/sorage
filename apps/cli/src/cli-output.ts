import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import type { NodeHandoffCommandPortsOptions, ReadConfiguration } from "@sorage/adapters/src/handoff-command-ports";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { createNodeInboxMarkerPorts, isNodeInboxMarkerEnabled } from "@sorage/adapters/src/inbox-marker-ports";
import { createLogger, type Logger } from "@sorage/adapters/src/logging";
import {
  type AppError,
  ERROR_CODES,
  type ErrorCode,
  errorEnvelope,
  errorSpec,
  type HandoffView,
  refreshInboxMarker,
  refreshProjectInboxMarker,
  SORAGE_VERSION,
  successEnvelope,
} from "@sorage/core";
import { type Command, InvalidArgumentError } from "commander";

export const CLI_NAME = "sorage" as const;
/** Kept as a CLI-facing alias while the product version has one source. */
export const CLI_VERSION = SORAGE_VERSION;

/** Standard-output and standard-error sinks, injectable for the golden harness. */
export interface OutputPorts {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const defaultPorts: OutputPorts = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Runs one CLI action and remembers its exit code for `runCli` to return. */
export type ReportExitCode = (code: number) => void;

/** Deterministic request identifiers for golden tests; never set in production. */
const GOLDEN_REQUEST_ID = process.env.SORAGE_TEST_REQUEST_ID;

export function requestId(): string {
  return GOLDEN_REQUEST_ID ?? randomUUID();
}

export function parseInteger(value: string): number {
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
export function collectRepeatable(value: string, previous: string[]): string[] {
  return [...(previous ?? []), value];
}

export function withPorts<P extends { close(): void }, R>(ports: P, body: (ports: P) => R): R {
  try {
    return body(ports);
  } finally {
    ports.close();
  }
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

export function knownErrorCode(code: unknown): ErrorCode {
  return typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? (code as ErrorCode) : "INTERNAL_ERROR";
}

/** The optional HND-014 expectation one mutating command forwards; undefined when the global flag was not supplied. */
export function expectedRowVersionOf(globals: Record<string, unknown>): number | undefined {
  return typeof globals.expectedRowVersion === "number" ? globals.expectedRowVersion : undefined;
}

export function actorInputOf(globals: Record<string, unknown>): {
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

export function reportingSummary(handoff: HandoffView): string {
  const stopped = handoff.reviewState === "declined" || handoff.reviewState === "withdrawn";
  const comment =
    handoff.comment === null
      ? ""
      : `, ${handoff.comment.purpose} comment for revision ${handoff.comment.targetRevision}${handoff.comment.targetRevision < handoff.revision ? " (older revision)" : ""}`;
  return `${handoff.reviewState}, read ${handoff.read.status}, processing ${stopped ? `stopped (${handoff.processing.status})` : handoff.processing.status}${comment}`;
}

export function reportListing(
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

export function renderUsageError(error: unknown, program: Command, ports: OutputPorts): number {
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
export function failureLogger(): Logger | null {
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

/** Whether a failure rendering also records the failure in the installation log. */
export interface RenderOptions {
  /**
   * `false` for the covered zero-write reads of RDR-001, whose failures render
   * without creating or rotating the installation log, including on failure.
   */
  log?: boolean;
  /** Record a fixed message when the user-facing explanation carries scoped context. */
  logMessage?: string;
}

/** The log-free `INTERNAL_ERROR` recovery, so no covered-read route can miss it. */
function logFreeInternalRecovery(id: string): string {
  return `Retain request ${id} and this output, then retry the read. This failure wrote no installation log.`;
}

/** Maps an application error to its envelope rendering and published exit code. */
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
  if (options.log !== false)
    logCommandFailure(options.logMessage === undefined ? error : { ...error, message: options.logMessage }, id);
  if (json) {
    ports.err(`${JSON.stringify(errorEnvelope(rendered, id), null, 2)}\n`);
  } else {
    ports.err(`${error.code}: ${error.message}\n`);
    const recovery = recoveryOverride ?? rendered.recovery?.suggestedCommand ?? spec.recovery?.suggestedCommand;
    if (recovery !== undefined) ports.err(`Recovery: ${recovery}\n`);
  }
  return spec.exitCode;
}

/**
 * The pre-initialization gate (INIT-011, INIT-012): renders the documented human or
 * JSON NOT_INITIALIZED form with the expected configuration path and reports exit 78
 * when the installation does not exist yet.
 */
export function requireInitializedConfiguration(
  ports: OutputPorts,
  json: boolean,
  reportExitCode: (code: number) => void,
  covered = false,
  options: RenderOptions = {},
): ReadConfiguration | null {
  const gate = createNodeConfigCommandPorts();
  const current = covered ? gate.store.readForOperation() : gate.store.read();
  if (current.ok && current.value !== null) return current.value;
  if (!current.ok) {
    // A present but broken configuration is doctor territory, not a gate case.
    reportExitCode(renderAppError(current.error, ports, json, undefined, options));
    return null;
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
  return null;
}

export function requireInitialized(
  ports: OutputPorts,
  json: boolean,
  reportExitCode: (code: number) => void,
  covered = false,
  options: RenderOptions = {},
): boolean {
  return requireInitializedConfiguration(ports, json, reportExitCode, covered, options) !== null;
}

/**
 * Rewrites the derived inbox marker for one or more Handoffs (HND-026); a
 * failure warns and never fails the command.
 */
export function refreshMarkers(
  handoffIds: readonly string[],
  ports: OutputPorts,
  options: NodeHandoffCommandPortsOptions = {},
): void {
  if (handoffIds.length === 0) return;
  let enabled: boolean;
  try {
    enabled = isNodeInboxMarkerEnabled(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ports.err(`warning: the inbox marker could not be refreshed: ${message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
    return;
  }
  if (!enabled) return;
  let markerPorts: ReturnType<typeof createNodeInboxMarkerPorts>;
  try {
    markerPorts = createNodeInboxMarkerPorts(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ports.err(`warning: the inbox marker could not be refreshed: ${message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
    return;
  }
  try {
    for (const handoffId of handoffIds) {
      let refreshed: ReturnType<typeof refreshInboxMarker>;
      try {
        refreshed = refreshInboxMarker(markerPorts, handoffId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          ports.err(`warning: the inbox marker could not be refreshed: ${message}\n`);
        } catch {
          // A diagnostic sink failure never changes the committed result.
        }
        continue;
      }
      if (!refreshed.ok) {
        try {
          ports.err(`warning: ${refreshed.error.message}\n`);
        } catch {
          // A diagnostic sink failure never changes the committed result.
        }
      }
    }
  } finally {
    markerPorts.close();
  }
}

export function refreshMarker(
  handoffId: string,
  ports: OutputPorts,
  options: NodeHandoffCommandPortsOptions = {},
): void {
  refreshMarkers([handoffId], ports, options);
}

export function refreshProjectMarker(
  projectId: string,
  ports: OutputPorts,
  options: NodeHandoffCommandPortsOptions = {},
): void {
  let enabled: boolean;
  try {
    enabled = isNodeInboxMarkerEnabled(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ports.err(`warning: the project inbox marker could not be refreshed: ${message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
    return;
  }
  if (!enabled) return;
  let markerPorts: ReturnType<typeof createNodeInboxMarkerPorts>;
  try {
    markerPorts = createNodeInboxMarkerPorts(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ports.err(`warning: the project inbox marker could not be refreshed: ${message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
    return;
  }
  let refreshed: ReturnType<typeof refreshProjectInboxMarker>;
  try {
    refreshed = refreshProjectInboxMarker(markerPorts, projectId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ports.err(`warning: the project inbox marker could not be refreshed: ${message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
    return;
  } finally {
    markerPorts.close();
  }
  if (!refreshed.ok) {
    try {
      ports.err(`warning: ${refreshed.error.message}\n`);
    } catch {
      // A diagnostic sink failure never changes the committed result.
    }
  }
}
