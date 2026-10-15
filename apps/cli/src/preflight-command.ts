import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { inspectPreflight } from "@sorage/adapters/src/preflight";
import {
  type AppError,
  type ErrorCode,
  type PreflightReport,
  appError,
  errorEnvelope,
  errorSpec,
  preflightEnvelope,
  preflightExitCode,
} from "@sorage/core";

export interface PreflightCommandPorts {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface PreflightCommandOptions {
  ports: PreflightCommandPorts;
  json: boolean;
  confirm: boolean;
  requestId: string;
  /** Test seam for an unexpected invocation failure. The shipped command does not set it. */
  inspect?: (home: string) => PreflightReport;
}

function inspectionGuidance(requestId: string): { message: string; suggestedCommand: string } {
  return {
    message: `Inspection failed before a report could be produced. Retain request ${requestId} and this output.`,
    suggestedCommand: `Retain request ${requestId} and this output, then run sorage preflight. This failure wrote no installation log.`,
  };
}
export function runPreflightCommand(options: PreflightCommandOptions): number {
  if (options.confirm) {
    options.ports.err("sorage: preflight accepts no confirmation flag\n");
    options.ports.err("Run 'sorage --help' for usage.\n");
    return 2;
  }
  try {
    const home = createNodeHomePaths().home;
    const report = (options.inspect ?? inspectPreflight)(home);
    if (options.json) {
      options.ports.out(`${JSON.stringify(preflightEnvelope(report, options.requestId), null, 2)}\n`);
    } else {
      renderHuman(report, options.ports);
    }
    return preflightExitCode(report.status);
  } catch (error) {
    return renderInvocationError(error, options.ports, options.json, options.requestId);
  }
}

function renderHuman(report: PreflightReport, ports: PreflightCommandPorts): void {
  const blocks = report.checks.map((check) => {
    const lines = [`[${check.severity}] ${check.id}`, check.message];
    if (check.recovery !== undefined) {
      lines.push(`Recovery: ${check.recovery.message}`);
      if (check.recovery.suggestedCommand !== undefined) lines.push("Run:", `  ${check.recovery.suggestedCommand}`);
    }
    return lines.join("\n");
  });
  ports.out(`Preflight status: ${report.status}\n\n${blocks.join("\n\n")}\n`);
}

function renderInvocationError(error: unknown, ports: PreflightCommandPorts, json: boolean, requestId: string): number {
  const typed = asAppError(error);
  const code: ErrorCode = typed?.code ?? "INTERNAL_ERROR";
  const exitCode = errorSpec(code).exitCode;
  const guidance = inspectionGuidance(requestId);
  const failure = appError(code, guidance.message, typed?.details);
  failure.recovery = { suggestedCommand: guidance.suggestedCommand };
  if (json) {
    ports.err(`${JSON.stringify(errorEnvelope(failure, requestId), null, 2)}\n`);
  } else {
    ports.err(`${code}: ${guidance.message}\n`);
    ports.err(`Recovery: ${guidance.suggestedCommand}\n`);
  }
  return exitCode;
}

function asAppError(error: unknown): AppError | undefined {
  if (typeof error !== "object" || error === null || !("code" in error) || !("message" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  const message = (error as { message: unknown }).message;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  try {
    errorSpec(code as ErrorCode);
  } catch {
    return undefined;
  }
  if (typeof errorSpec(code as ErrorCode).exitCode !== "number") return undefined;
  const details = (error as { details?: unknown }).details;
  return appError(code as ErrorCode, message, detailsRecord(details));
}

function detailsRecord(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined || typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  return details as Record<string, unknown>;
}
