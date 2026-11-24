import { type AppError, largeContentDisclosureMessage } from "@sorage/core";

export interface LargeContentWarning {
  sizeBytes: number;
  thresholdBytes: number;
}

export interface LargeContentDisclosureBuffer {
  readonly warnings: LargeContentWarning[];
  record(sizeBytes: number, thresholdBytes: number): void;
  wrap<T extends { largeContent?: (sizeBytes: number, thresholdBytes: number) => void }>(disclosures: T): T;
  /**
   * Applies buffered disclosures to a failed command (WR3): JSON failures
   * append them to `error.message`; human failures flush them to stderr unless
   * `flushOnHumanFailure` is `false` (preserving Channel's asymmetric failure stderr).
   */
  applyOnFailure(
    error: AppError,
    json: boolean,
    warn: (text: string) => void,
    options?: { flushOnHumanFailure?: boolean },
  ): AppError;
  /** Flushes buffered disclosures to stderr after a committed command succeeds. */
  flushOnSuccess(warn: (text: string) => void): void;
}

/** Per-invocation large-content disclosure buffer shared by send, revise, Memo, and Channel commands. */
export function createDisclosureBuffer(): LargeContentDisclosureBuffer {
  const warnings: LargeContentWarning[] = [];
  const record = (sizeBytes: number, thresholdBytes: number): void => {
    warnings.push({ sizeBytes, thresholdBytes });
  };
  return {
    warnings,
    record,
    wrap<T extends { largeContent?: (sizeBytes: number, thresholdBytes: number) => void }>(disclosures: T): T {
      return {
        ...disclosures,
        largeContent: record,
      };
    },
    applyOnFailure(
      error: AppError,
      json: boolean,
      warn: (text: string) => void,
      options: { flushOnHumanFailure?: boolean } = {},
    ): AppError {
      if (json) {
        if (warnings.length === 0) return error;
        try {
          const appended = warnings
            .map((warning) => largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes))
            .join(" ");
          return { ...error, message: `${error.message}; ${appended}` };
        } catch {
          // Formatting failure leaves the original error intact.
          return error;
        }
      }
      if (options.flushOnHumanFailure !== false) {
        for (const warning of warnings) {
          try {
            warn(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
          } catch {
            // A diagnostic flush failure never masks the real error.
          }
        }
      }
      return error;
    },
    flushOnSuccess(warn: (text: string) => void): void {
      for (const warning of warnings) {
        try {
          warn(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
        } catch {
          // A diagnostic flush failure never changes a committed outcome.
        }
      }
    },
  };
}
