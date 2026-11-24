import { type AppError, appError } from "../shared/errors";

// ---------------------------------------------------------------------------
// The CLI's typed-error refinement of the shared mappings

/**
 * Refines a shared typed error for the Channel surface: the read-side
 * materialization state carries the rebuilt surface's own recovery, and the
 * unclassified integrity and schema refusals name the Channel commands.
 */
export function channelError(error: AppError): AppError {
  if (error.code === "CONTENT_MATERIALIZING") {
    return {
      ...appError(
        "CONTENT_MATERIALIZING",
        "The message itself is committed and needs no resubmission; its file-backed content has not activated yet",
        error.details,
        error.cause,
      ),
      recovery: {
        suggestedCommand:
          "Retry the read or wait after activation; the next process start retries the pending activation, and the message needs no resubmission",
      },
    };
  }
  if (error.code === "STORAGE_INTEGRITY_ERROR" && error.recovery === undefined) {
    return {
      ...error,
      recovery: {
        suggestedCommand:
          "Diagnose the installation with sorage doctor and sorage vault verify before further Channel work; any committed outcome already reported stands",
      },
    };
  }
  if (error.code === "STORAGE_SCHEMA_UNSUPPORTED" && error.recovery === undefined) {
    return {
      ...error,
      recovery: {
        suggestedCommand:
          "Retain the original Channel command and its input; use a Sorage version that supports this storage layout; never downgrade the database",
      },
    };
  }
  return error;
}
