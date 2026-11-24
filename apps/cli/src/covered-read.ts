import { appCommandErrorOf, schemaAdmissionOf } from "@sorage/adapters/src/daemon-command-ports";
import { type CoveredReadStorage, openCoveredReadStorage } from "@sorage/adapters/src/read-storage";
import { type AppError, appError, err, type Result } from "@sorage/core";
import { Command, Option } from "commander";
import { type OutputPorts, renderAppError } from "./cli-output";

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
  // A normal Exchange mutation can resolve entirely through receipt inspection.
  // Its focused dispatcher owns write admission. Parser failures must stay log-free.
  ["exchange"],
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
export function thrownReadError(error: unknown): AppError {
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
