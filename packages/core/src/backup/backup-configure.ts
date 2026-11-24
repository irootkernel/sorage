import { type Configuration, isValidTimezone, SCHEDULE_AT_PATTERN } from "../config/config";
import { type AppError, appError, err, ok, type Result } from "../shared/errors";

/**
 * The four User-admin backup configuration commands of TASK-057 (BKP-002,
 * BKP-011, BKP-025, CLI-019): `enable` turns the schedule on with its local
 * time and zone, `disable` turns it off, `enable-push` names the remote and
 * branch, and `disable-push` turns the remote off. Each applies its whole
 * group of leaf writes in one configuration write, and the HTTP endpoints
 * call this same use case so the two surfaces cannot drift.
 */
export interface BackupConfigPorts {
  read(): Result<{ config: Configuration; etag: string } | null, AppError>;
  write(next: Configuration, expect: { etag: string }): Result<{ etag: string }, AppError>;
}

export type BackupConfigAction = "enable" | "disable" | "enable-push" | "disable-push";

export interface BackupConfigInput {
  action: BackupConfigAction;
  asUser: boolean;
  /** `enable`: the local `HH:MM`. */
  dailyAt?: string | undefined;
  /** `enable`: an optional IANA zone replacement. */
  timezone?: string | undefined;
  /** `enable-push`: the remote name. */
  remote?: string | undefined;
  /** `enable-push`: the branch name. */
  branch?: string | undefined;
}

export function configureBackup(
  ports: BackupConfigPorts,
  input: BackupConfigInput,
): Result<{ gitBackup: Configuration["gitBackup"] }, AppError> {
  if (!input.asUser) {
    return err(
      appError("USER_CONTEXT_REQUIRED", "backup configuration commands record a User decision and require --as-user."),
    );
  }
  const read = ports.read();
  if (!read.ok) return err(read.error);
  if (read.value === null) return err(appError("NOT_INITIALIZED", "Sorage is not initialized.", {}));
  const config = read.value.config;

  if (input.action === "enable") {
    if (input.dailyAt === undefined || !SCHEDULE_AT_PATTERN.test(input.dailyAt)) {
      return err(appError("CONFIG_INVALID", "backup enable requires --daily-at <HH:MM> with a 24-hour local time."));
    }
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
      return err(appError("CONFIG_INVALID", `The timezone '${input.timezone}' is not a known IANA zone.`));
    }
    config.gitBackup.enabled = true;
    config.gitBackup.schedule.at = input.dailyAt;
    if (input.timezone !== undefined) config.gitBackup.schedule.timezone = input.timezone;
  } else if (input.action === "disable") {
    config.gitBackup.enabled = false;
  } else if (input.action === "enable-push") {
    if (input.remote === undefined || input.remote.trim() === "") {
      return err(appError("CONFIG_INVALID", "backup enable-push requires --remote <name>."));
    }
    if (input.branch === undefined || input.branch.trim() === "") {
      return err(appError("CONFIG_INVALID", "backup enable-push requires --branch <name>."));
    }
    config.gitBackup.push.enabled = true;
    config.gitBackup.push.remote = input.remote;
    config.gitBackup.push.branch = input.branch;
  } else {
    config.gitBackup.push.enabled = false;
  }

  const written = ports.write(config, { etag: read.value.etag });
  if (!written.ok) return err(written.error);
  return ok({ gitBackup: config.gitBackup });
}
