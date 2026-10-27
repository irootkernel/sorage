import { createNodeSendRecoveryPorts } from "@sorage/adapters/src/send-recovery";
import {
  type AppError,
  appError,
  ERROR_CODES,
  type ErrorCode,
  errorEnvelope,
  errorSpec,
  type Result,
  recoverSend,
  type SendOutcome,
  type SendRecoveryInput,
  successEnvelope,
} from "@sorage/core";

interface RecoveryOutput {
  out(text: string): void;
  err(text: string): void;
}
export interface SendRecoveryCommandOptions {
  ports: RecoveryOutput;
  json: boolean;
  requestId: string;
  input: SendRecoveryInput;
  /** Internal unit seam; the shipped CLI always uses the dedicated inspection adapter. */
  recover?: (input: SendRecoveryInput) => Result<SendOutcome, AppError>;
}

/** Recovery errors have their own no-log context; operational catalogue defaults are unchanged. */
export function renderSendRecoveryError(
  error: AppError,
  options: Pick<SendRecoveryCommandOptions, "ports" | "json" | "requestId">,
): number {
  const bounded =
    error.code === "INTERNAL_ERROR"
      ? "Send recovery could not complete original-source validation or receipt inspection."
      : error.code === "IDEMPOTENCY_CONFLICT"
        ? "The retained receipt does not match the original request and sender."
        : error.code === "HANDOFF_REPLAY_UNAVAILABLE"
          ? "No eligible historical send receipt is available."
          : `Send recovery was refused (${error.code}).`;
  const failure = appError(
    error.code,
    `${bounded} The original send outcome remains unknown. Retain the original key, exact input/source bytes, Installation and sender context, request ${options.requestId} and this output.`,
    error.details,
  );
  failure.recovery = {
    suggestedCommand: `Keep the original key, exact input/source bytes, Installation and sender context. Retain request ${options.requestId} and this output for diagnosis; the unknown outcome does not authorize another send.${error.code === "STORAGE_INSPECTION_UNAVAILABLE" ? " CLI inspection needs writable private temporary scratch, without writing the Sorage home or Vault. If that scratch is denied and an already permitted MCP server is available, inspect the identical request through handoff_send with replayOnly: true and the same context; never switch to execution or replace the key." : ""}`,
  };
  if (options.json) options.ports.err(`${JSON.stringify(errorEnvelope(failure, options.requestId), null, 2)}\n`);
  else options.ports.err(`${failure.code}: ${failure.message}\nRecovery: ${failure.recovery.suggestedCommand}\n`);
  return errorSpec(failure.code).exitCode;
}

/** This entire branch bypasses operational send, startup drain, logging and derived marker refresh. */
export function runSendRecoveryCommand(options: SendRecoveryCommandOptions): number {
  try {
    const result = options.recover?.(options.input) ?? recoverSend(createNodeSendRecoveryPorts(), options.input);
    if (!result.ok) return renderSendRecoveryError(result.error, options);
    if (options.json)
      options.ports.out(`${JSON.stringify(successEnvelope(result.value, options.requestId), null, 2)}\n`);
    else {
      options.ports.out(
        "Historical send receipt (replayed); this does not report current delivery or Artifact activation.\n",
      );
      for (const handoff of result.value.handoffs)
        options.ports.out(
          `Recorded Handoff ${handoff.handoffId} → ${handoff.recipientSlug} (creation revision ${handoff.revision})\n`,
        );
      if (result.value.dispatchGroupId !== null)
        options.ports.out(
          `Recorded dispatch group ${result.value.dispatchGroupId} (${result.value.handoffs.length} Handoffs)\n`,
        );
    }
    return 0;
  } catch (error) {
    const candidate = error as Partial<AppError> | null;
    const code =
      candidate !== null &&
      typeof candidate === "object" &&
      typeof candidate.code === "string" &&
      (ERROR_CODES as readonly string[]).includes(candidate.code)
        ? (candidate.code as ErrorCode)
        : "INTERNAL_ERROR";
    return renderSendRecoveryError(appError(code, "send recovery failed"), options);
  }
}
