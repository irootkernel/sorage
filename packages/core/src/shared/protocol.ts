import { errorSpec, type AppError, type ErrorCode } from "./errors";

/**
 * Versioned protocol DTO base shared by the CLI JSON envelope and the HTTP API
 * (section 14 of interfaces-and-operations.md). The envelope is versioned and
 * contract-tested; an unreviewed shape change fails make test-contract.
 */
export const PROTOCOL_VERSION = 1;

export interface RequestMeta {
  requestId: string;
  timedOut?: boolean;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: RequestMeta;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown>;
    recovery?: { suggestedCommand: string };
  };
  meta: RequestMeta;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function successEnvelope<T>(data: T, requestId: string, extraMeta?: { timedOut?: boolean }): SuccessEnvelope<T> {
  return {
    ok: true,
    data,
    meta: extraMeta?.timedOut === undefined ? { requestId } : { requestId, timedOut: extraMeta.timedOut },
  };
}

export function errorEnvelope(error: AppError, requestId: string): ErrorEnvelope {
  const recovery = error.recovery ?? errorSpec(error.code).recovery;
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? {},
      ...(recovery !== undefined ? { recovery } : {}),
    },
    meta: { requestId },
  };
}

/** The version stamp every protocol DTO carries; HTTP exposes it as a response header. */
export function protocolVersion(): number {
  return PROTOCOL_VERSION;
}
