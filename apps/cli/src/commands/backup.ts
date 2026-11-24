import { isAbsolute, resolve } from "node:path";
import { createNodeBackupCommandPorts } from "@sorage/adapters/src/backup-command-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import {
  type AppError,
  appError,
  type BackupConfigPorts,
  backupRestore,
  backupStatus,
  backupVerify,
  type Configuration,
  configureBackup,
  ok,
  runBackupCommand,
  successEnvelope,
} from "@sorage/core";
import type { Command } from "commander";
import { type OutputPorts, type ReportExitCode, renderAppError, requestId, requireInitialized } from "../cli-output";

export function backupConfigPorts(): {
  read(): ReturnType<BackupConfigPorts["read"]>;
  write(
    next: Configuration,
    expect: { etag: string },
  ): { ok: true; value: { etag: string } } | { ok: false; error: AppError };
} {
  const commandPorts = createNodeConfigCommandPorts();
  const store = commandPorts.store;
  return {
    read: () => {
      const read = store.read();
      if (!read.ok) return read;
      if (read.value === null) return ok(null);
      return ok({ config: read.value.config, etag: read.value.etag });
    },
    write: (next, expect) => {
      const written = store.write(next, { etag: expect.etag });
      if (!written.ok) return written;
      return ok({ etag: written.value.etag });
    },
  };
}

function reportBackupConfig(
  result: { ok: true; value: { gitBackup: unknown } } | { ok: false; error: AppError },
  ports: OutputPorts,
  json: boolean,
  reportExitCode: (code: number) => void,
): void {
  if (!result.ok) {
    reportExitCode(renderAppError(result.error, ports, json));
    return;
  }
  if (json) {
    ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
  } else {
    ports.out("Backup configuration updated.\n");
  }
}

export function registerBackupCommands(program: Command, ports: OutputPorts, reportExitCode: ReportExitCode): void {
  const backup = program.command("backup").description("verify, run, and restore Vault backups");

  backup
    .command("run")
    .description("run one backup now: export the snapshot, commit managed changes, and report each outcome")
    .option("--idempotency-key <uuid>", "replay the identical run under the same key instead of running again")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const backupPorts = createNodeBackupCommandPorts();
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const runPorts = backupPorts.runPorts();
      if (!runPorts.ok) {
        reportExitCode(renderAppError(runPorts.error, ports, json));
        return;
      }
      const idempotencyKey =
        typeof options.idempotencyKey === "string" && options.idempotencyKey.trim() !== ""
          ? options.idempotencyKey
          : undefined;
      const result = runBackupCommand(runPorts.value, { idempotencyKey });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        const value = result.value;
        ports.out(
          `Backup ${value.outcome}: snapshot ${value.snapshot}, commit ${value.commit}, push ${value.push}${value.commitSha !== null ? ` (${value.commitSha.slice(0, 12)})` : ""}\n`,
        );
        if (value.replayed) ports.out("replayed from the recorded outcome of this idempotency key\n");
      }
    });

  backup
    .command("status")
    .description("report the backup history from backup_runs: last attempt, success, commit, push, and failure")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const backupPorts = createNodeBackupCommandPorts();
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const statusPorts = backupPorts.statusPorts();
      if (!statusPorts.ok) {
        reportExitCode(renderAppError(statusPorts.error, ports, json));
        return;
      }
      const report = backupStatus(statusPorts.value);
      if (!report.ok) {
        reportExitCode(renderAppError(report.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(report.value, requestId()), null, 2)}\n`);
      } else {
        const value = report.value;
        if (value.lastAttempt === null) {
          ports.out("No backup has run yet.\n");
        } else {
          ports.out(`Last attempt: ${value.lastAttempt.outcome} at ${value.lastAttempt.startedAt}\n`);
          if (value.lastCommit !== null) {
            ports.out(
              `Last commit: ${String(value.lastCommit.commitSha).slice(0, 12)} at ${value.lastCommit.startedAt}\n`,
            );
          } else {
            ports.out("Last commit: none\n");
          }
          if (value.lastFailure !== null) {
            ports.out(`Last failure: ${String(value.lastFailure.failureCode)} at ${value.lastFailure.startedAt}\n`);
          }
        }
        ports.out(
          value.schedule.enabled
            ? `Schedule: daily at ${value.schedule.at} in ${value.schedule.timezone}\n`
            : "Schedule: disabled\n",
        );
      }
    });

  backup
    .command("verify")
    .description(
      "run every vault verify check plus the Git configuration and snapshot consistency checks; never repairs",
    )
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const backupPorts = createNodeBackupCommandPorts();
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const verifyPorts = backupPorts.verifyPorts();
      if (!verifyPorts.ok) {
        reportExitCode(renderAppError(verifyPorts.error, ports, json));
        return;
      }
      const report = backupVerify(verifyPorts.value, { now: new Date() });
      if (!report.ok) {
        reportExitCode(renderAppError(report.error, ports, json));
        return;
      }
      const blocking = report.value.findings.length > 0;
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope({ ...report.value, blocking }, requestId()), null, 2)}\n`);
      } else if (blocking) {
        for (const finding of report.value.findings) ports.err(`${finding}\n`);
      } else {
        ports.out(
          `The Vault and its backup are consistent: ${report.value.checked.vault.recordedArtifacts} recorded Artifact(s), ${report.value.checked.manifest.handoffs} exported Handoff(s), ${report.value.checked.trackedFiles} tracked file(s).\n`,
        );
      }
      for (const warning of report.value.warnings) ports.err(`warning: ${warning}\n`);
      reportExitCode(blocking ? 1 : 0);
    });

  backup
    .command("enable")
    .description("turn the daily backup schedule on with its local time and zone")
    .requiredOption("--daily-at <HH:MM>", "the local time of day the schedule runs")
    .option("--timezone <zone>", "the IANA zone the local time lives in")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), {
        action: "enable",
        asUser: globals.asUser === true,
        dailyAt: options.dailyAt,
        timezone: options.timezone,
      });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("disable")
    .description("turn the daily backup schedule off")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), { action: "disable", asUser: globals.asUser === true });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("enable-push")
    .description("turn remote push on for one configured remote and branch; the push is a fast-forward only")
    .requiredOption("--remote <name>", "the Git remote name to push to")
    .requiredOption("--branch <name>", "the branch to push")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), {
        action: "enable-push",
        asUser: globals.asUser === true,
        remote: options.remote,
        branch: options.branch,
      });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("disable-push")
    .description("turn remote push off; local commits continue")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = configureBackup(backupConfigPorts(), { action: "disable-push", asUser: globals.asUser === true });
      reportBackupConfig(result, ports, json, reportExitCode);
    });

  backup
    .command("restore")
    .description(
      "rebuild an empty installation from a Vault backup copy, adopting its installationId; the daemon must be stopped",
    )
    .requiredOption("--from <vault-path>", "the Vault copy to restore from")
    .option("--dry-run", "validate the backup and report the plan without writing")
    .option("--confirm", "required for the writing restore")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            appError(
              "USER_CONTEXT_REQUIRED",
              "sorage backup restore adopts another installation's identity and requires --as-user.",
            ),
            ports,
            json,
          ),
        );
        return;
      }
      // --confirm is a global option shared with the deletion commands, so
      // it arrives on the globals rather than a command-local flag.
      const dryRun = options.dryRun === true;
      const confirm = globals.confirm === true || options.confirm === true;
      if (dryRun === confirm) {
        ports.err("sorage: pass exactly one of --dry-run or --confirm.\n");
        ports.err("Run 'sorage backup restore --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      // A relative --from resolves against the cwd once, matching the vault
      // move's --to anchoring so the recorded path is stable across commands.
      const sourcePath = isAbsolute(options.from) ? options.from : resolve(options.from);
      const backupPorts = createNodeBackupCommandPorts({ sourcePath });
      const drained = backupPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const restorePorts = backupPorts.restorePorts();
      if (!restorePorts.ok) {
        reportExitCode(renderAppError(restorePorts.error, ports, json));
        return;
      }
      const result = backupRestore(restorePorts.value, { dryRun });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else if (result.value.dryRun) {
        const value = result.value;
        ports.out(`Dry run against ${value.sourcePath}:\n`);
        ports.out(
          `would create ${value.wouldCreate.projects} project(s), ${value.wouldCreate.handoffs} handoff(s), ${value.wouldCreate.reviewNotes} review note(s), ${value.wouldCreate.artifacts} artifact(s), and ${value.wouldCreate.events} ledger event(s)\n`,
        );
        ports.out(`would adopt installationId ${value.adoptedInstallationId}\n`);
        ports.out("nothing was written; run with --confirm to restore\n");
      } else {
        const value = result.value;
        ports.out(
          `Restored ${value.restored.handoffs} handoff(s) and ${value.restored.artifacts} artifact(s) from ${value.sourcePath}; adopted installationId ${value.adoptedInstallationId} and regenerated the API token.\n`,
        );
        ports.out(
          "Project directory bindings are machine-local and were not restored; re-bind them with sorage project bind.\n",
        );
      }
    });
}
