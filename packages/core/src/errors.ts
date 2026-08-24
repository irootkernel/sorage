/**
 * The typed error model and the symbolic error catalogue from section 15 and 16 of
 * interfaces-and-operations.md. The symbolic code is the primary machine contract;
 * HTTP status and exit code are derived mappings, never independent decisions.
 */
export const ERROR_CODES = [
  "NOT_INITIALIZED",
  "CONFIG_INVALID",
  "CONFIG_CONFLICT",
  "DAEMON_UNAVAILABLE",
  "PROJECT_NOT_FOUND",
  "PROJECT_ARCHIVED",
  "PROJECT_UNBOUND",
  "PROJECT_SLUG_CONFLICT",
  "BINDING_DUPLICATE",
  "UNREGISTERED_RECIPIENT",
  "AMBIGUOUS_PROJECT",
  "SENDER_IDENTITY_DOWNGRADE",
  "VAULT_CONTAINMENT",
  "HANDOFF_NOT_FOUND",
  "FORBIDDEN_ACTOR",
  "USER_CONTEXT_REQUIRED",
  "CONFIRMATION_REQUIRED",
  "HOST_NOT_ALLOWED",
  "UNAUTHENTICATED",
  "TOKEN_INVALID",
  "ROW_VERSION_CONFLICT",
  "REVISION_CONFLICT",
  "REVIEW_NOTE_PRESENT",
  "NO_REVIEW_NOTE",
  "NO_CONTENT_CHANGE",
  "NO_CHANGE_LIMIT",
  "HANDOFF_TERMINAL",
  "HANDOFF_NOT_TERMINAL",
  "HANDOFF_DELETED",
  "HANDOFF_ALREADY_FETCHED",
  "HANDOFF_ARCHIVE_INVALID",
  "HANDOFF_NOT_ARCHIVED",
  "DELETION_ALREADY_REQUESTED",
  "PINNED_DELETE_CONFIRMATION",
  "IDEMPOTENCY_CONFLICT",
  "CURSOR_INVALID",
  "ARTIFACT_TOO_LARGE",
  "ARTIFACT_MATERIALIZING",
  "ARTIFACT_CORRUPTED",
  "SOURCE_OUTSIDE_WORKSPACE",
  "VAULT_INTEGRITY_ERROR",
  "VAULT_SCHEMA_UNSUPPORTED",
  "SERVICE_PAUSED",
  "PORT_IN_USE",
  "BACKUP_IN_PROGRESS",
  "GIT_BACKUP_CONFLICT",
  "GIT_AUTH_REQUIRED",
  "RESTORE_TARGET_NOT_EMPTY",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export interface ErrorSpec {
  code: ErrorCode;
  httpStatus: number;
  exitCode: number;
  recovery?: { suggestedCommand: string } | undefined;
}

/** Exit-code categories from section 16 of interfaces-and-operations.md. */
export const EXIT_USAGE = 2;
export const EXIT_INTERNAL = 1;

const RECOVERY: Partial<Record<ErrorCode, string>> = {
  NOT_INITIALIZED: "sorage init",
  CONFIG_INVALID: "sorage config validate",
  DAEMON_UNAVAILABLE: "sorage daemon start",
  PROJECT_NOT_FOUND: "sorage project list",
  PROJECT_ARCHIVED: "sorage project unarchive <project> --as-user",
  PROJECT_UNBOUND: "sorage project bind <project> --dir <path>",
  PROJECT_SLUG_CONFLICT: "sorage project show <project>",
  BINDING_DUPLICATE: "sorage project resolve --path <path>",
  UNREGISTERED_RECIPIENT: "sorage project add",
  AMBIGUOUS_PROJECT: "Pass --as <project-slug>, or remove the aliased binding",
  SENDER_IDENTITY_DOWNGRADE: "Bind the directory, or pass --allow-unregistered",
  VAULT_CONTAINMENT: "Choose a directory outside the Vault, or move the Vault with sorage vault move",
  HANDOFF_NOT_FOUND: "Verify the UUID with sorage inbox or sorage outbox",
  FORBIDDEN_ACTOR: "Run from the correct directory, or use --as or --as-user",
  USER_CONTEXT_REQUIRED: "Re-run with --as-user",
  CONFIRMATION_REQUIRED: "Re-run with --confirm",
  HOST_NOT_ALLOWED: "Reach the daemon as 127.0.0.1, localhost, or [::1] on the configured port",
  UNAUTHENTICATED: "sorage web",
  TOKEN_INVALID: "sorage web",
  ROW_VERSION_CONFLICT: "Re-read the Handoff and retry with the new Row Version",
  REVISION_CONFLICT: "Re-read the current Revision",
  REVIEW_NOTE_PRESENT: "Resolve the Note by revising, withdrawing, or removing it",
  NO_REVIEW_NOTE: "Use revise --file <path>",
  NO_CONTENT_CHANGE: "Change the document, or resolve the Note with revise --no-change --reason",
  NO_CHANGE_LIMIT: "The next resolution MUST change content",
  HANDOFF_TERMINAL: "Create a superseding Handoff with --supersedes",
  HANDOFF_NOT_TERMINAL: "Reach a terminal state first with accept, decline, or withdraw",
  HANDOFF_DELETED: "Use get or a listing with --include-deleted",
  HANDOFF_ALREADY_FETCHED: "Ask the recipient to decline, or supersede the Handoff",
  HANDOFF_ARCHIVE_INVALID: "Reach a terminal state first",
  HANDOFF_NOT_ARCHIVED: "Nothing to do; archivedAt is already null",
  DELETION_ALREADY_REQUESTED: "Wait for the User decision, or sorage delete reject <id> --as-user first",
  PINNED_DELETE_CONFIRMATION: "Re-run with --confirm-pinned <id>",
  IDEMPOTENCY_CONFLICT: "Use a new key, or replay the identical request",
  CURSOR_INVALID: "Restart the listing without --cursor",
  ARTIFACT_TOO_LARGE: "Reduce the file, or raise the limit deliberately",
  ARTIFACT_MATERIALIZING: "Retry; the next process start drains the intent",
  ARTIFACT_CORRUPTED: "sorage vault verify, then restore from backup",
  SOURCE_OUTSIDE_WORKSPACE: "Re-run with --allow-external-source",
  VAULT_INTEGRITY_ERROR: "sorage vault verify",
  VAULT_SCHEMA_UNSUPPORTED: "Upgrade Sorage; Sorage never downgrades a Vault",
  SERVICE_PAUSED: "Wait for that operation to finish, then retry",
  PORT_IN_USE: "Stop the other listener, or change server.port and restart",
  BACKUP_IN_PROGRESS: "Wait for the running backup to finish, then retry",
  GIT_BACKUP_CONFLICT: "Resolve the repository state manually",
  GIT_AUTH_REQUIRED: "Configure the credential helper or SSH key, then retry",
  RESTORE_TARGET_NOT_EMPTY: "Restore into a fresh installation",
  INTERNAL_ERROR: "Inspect meta.requestId in ~/.sorage/logs/sorage.log",
};

const HTTP_STATUS: Record<ErrorCode, number> = {
  NOT_INITIALIZED: 503,
  CONFIG_INVALID: 422,
  CONFIG_CONFLICT: 409,
  DAEMON_UNAVAILABLE: 503,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  PROJECT_UNBOUND: 409,
  PROJECT_SLUG_CONFLICT: 409,
  BINDING_DUPLICATE: 409,
  UNREGISTERED_RECIPIENT: 422,
  AMBIGUOUS_PROJECT: 409,
  SENDER_IDENTITY_DOWNGRADE: 409,
  VAULT_CONTAINMENT: 422,
  HANDOFF_NOT_FOUND: 404,
  FORBIDDEN_ACTOR: 403,
  USER_CONTEXT_REQUIRED: 403,
  CONFIRMATION_REQUIRED: 422,
  HOST_NOT_ALLOWED: 421,
  UNAUTHENTICATED: 401,
  TOKEN_INVALID: 401,
  ROW_VERSION_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  REVIEW_NOTE_PRESENT: 409,
  NO_REVIEW_NOTE: 409,
  NO_CONTENT_CHANGE: 422,
  NO_CHANGE_LIMIT: 409,
  HANDOFF_TERMINAL: 409,
  HANDOFF_NOT_TERMINAL: 409,
  HANDOFF_DELETED: 409,
  HANDOFF_ALREADY_FETCHED: 409,
  HANDOFF_ARCHIVE_INVALID: 409,
  HANDOFF_NOT_ARCHIVED: 409,
  DELETION_ALREADY_REQUESTED: 409,
  PINNED_DELETE_CONFIRMATION: 422,
  IDEMPOTENCY_CONFLICT: 409,
  CURSOR_INVALID: 422,
  ARTIFACT_TOO_LARGE: 413,
  ARTIFACT_MATERIALIZING: 409,
  ARTIFACT_CORRUPTED: 409,
  SOURCE_OUTSIDE_WORKSPACE: 403,
  VAULT_INTEGRITY_ERROR: 409,
  VAULT_SCHEMA_UNSUPPORTED: 409,
  SERVICE_PAUSED: 423,
  PORT_IN_USE: 409,
  BACKUP_IN_PROGRESS: 409,
  GIT_BACKUP_CONFLICT: 409,
  GIT_AUTH_REQUIRED: 409,
  RESTORE_TARGET_NOT_EMPTY: 409,
  INTERNAL_ERROR: 500,
};

const EXIT_CODE: Record<ErrorCode, number> = {
  INTERNAL_ERROR: 1,
  AMBIGUOUS_PROJECT: 64,
  VAULT_CONTAINMENT: 64,
  CONFIRMATION_REQUIRED: 64,
  PINNED_DELETE_CONFIRMATION: 64,
  CURSOR_INVALID: 64,
  PROJECT_ARCHIVED: 65,
  PROJECT_UNBOUND: 65,
  PROJECT_SLUG_CONFLICT: 65,
  BINDING_DUPLICATE: 65,
  UNREGISTERED_RECIPIENT: 65,
  SENDER_IDENTITY_DOWNGRADE: 65,
  NO_REVIEW_NOTE: 65,
  NO_CONTENT_CHANGE: 65,
  NO_CHANGE_LIMIT: 65,
  HANDOFF_TERMINAL: 65,
  HANDOFF_NOT_TERMINAL: 65,
  HANDOFF_DELETED: 65,
  HANDOFF_ALREADY_FETCHED: 65,
  HANDOFF_ARCHIVE_INVALID: 65,
  HANDOFF_NOT_ARCHIVED: 65,
  ARTIFACT_TOO_LARGE: 65,
  PROJECT_NOT_FOUND: 66,
  HANDOFF_NOT_FOUND: 66,
  DAEMON_UNAVAILABLE: 69,
  VAULT_INTEGRITY_ERROR: 73,
  ARTIFACT_CORRUPTED: 73,
  CONFIG_CONFLICT: 75,
  ROW_VERSION_CONFLICT: 75,
  REVISION_CONFLICT: 75,
  REVIEW_NOTE_PRESENT: 75,
  IDEMPOTENCY_CONFLICT: 75,
  DELETION_ALREADY_REQUESTED: 75,
  ARTIFACT_MATERIALIZING: 75,
  SERVICE_PAUSED: 75,
  PORT_IN_USE: 75,
  GIT_BACKUP_CONFLICT: 75,
  BACKUP_IN_PROGRESS: 75,
  RESTORE_TARGET_NOT_EMPTY: 75,
  FORBIDDEN_ACTOR: 77,
  USER_CONTEXT_REQUIRED: 77,
  HOST_NOT_ALLOWED: 77,
  UNAUTHENTICATED: 77,
  TOKEN_INVALID: 77,
  SOURCE_OUTSIDE_WORKSPACE: 77,
  GIT_AUTH_REQUIRED: 77,
  NOT_INITIALIZED: 78,
  CONFIG_INVALID: 78,
  VAULT_SCHEMA_UNSUPPORTED: 78,
};

/** The full published specification for one symbolic error code. */
export function errorSpec(code: ErrorCode): ErrorSpec {
  const recovery = RECOVERY[code];
  return {
    code,
    httpStatus: HTTP_STATUS[code],
    exitCode: EXIT_CODE[code],
    recovery: recovery === undefined ? undefined : { suggestedCommand: recovery },
  };
}

/** Constructs a typed application error. */
export function appError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): AppError {
  return details === undefined && cause === undefined
    ? { code, message }
    : { code, message, ...(details !== undefined ? { details } : {}), ...(cause !== undefined ? { cause } : {}) };
}

export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
