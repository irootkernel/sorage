import { isAbsolute, resolve } from "node:path";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import { appError, moveVault, successEnvelope, vaultStatus, vaultVerify } from "@sorage/core";
import type { Command } from "commander";
import { type OutputPorts, type ReportExitCode, renderAppError, requestId, requireInitialized } from "../cli-output";

export function registerVaultCommands(program: Command, ports: OutputPorts, reportExitCode: ReportExitCode): void {
  const vault = program.command("vault").description("inspect, verify, and relocate the Artifact Vault");

  vault
    .command("status")
    .description("report the Vault path, marker, counts, and sizes")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const vaultPorts = createNodeVaultCommandPorts();
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const statusPorts = vaultPorts.statusPorts();
      if (!statusPorts.ok) {
        reportExitCode(renderAppError(statusPorts.error, ports, json));
        return;
      }
      const report = vaultStatus(statusPorts.value);
      if (!report.ok) {
        reportExitCode(renderAppError(report.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(report.value, requestId()), null, 2)}\n`);
      } else {
        const value = report.value;
        ports.out(`Vault: ${value.path}\n`);
        ports.out(
          `marker: schemaVersion ${value.marker.schemaVersion}, installation ${value.marker.installationId}, created ${value.marker.createdAt}\n`,
        );
        ports.out(`artifacts: ${value.counts.artifacts} files, ${value.sizes.artifactsBytes} bytes\n`);
        ports.out(`staging: ${value.counts.stagedFiles} files, ${value.sizes.stagingBytes} bytes\n`);
        ports.out(`pending intents: ${value.counts.pendingIntents}\n`);
        for (const problem of value.layoutProblems) ports.out(`warning: ${problem}\n`);
      }
    });

  vault
    .command("verify")
    .description("run the Git-independent integrity sweep and name every finding; never repairs")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const vaultPorts = createNodeVaultCommandPorts();
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const verifyPorts = vaultPorts.verifyPorts();
      if (!verifyPorts.ok) {
        reportExitCode(renderAppError(verifyPorts.error, ports, json));
        return;
      }
      const report = vaultVerify(verifyPorts.value, { now: new Date() });
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
          `The Vault is consistent: ${report.value.checked.recordedArtifacts} recorded Artifact(s), ${report.value.checked.stagedFiles} staged file(s).\n`,
        );
      }
      reportExitCode(blocking ? 1 : 0);
    });

  vault
    .command("move")
    .description("relocate the Vault under vault-move.lock; every other mutation pauses while it runs")
    .requiredOption("--to <path>", "the target directory for the relocated Vault")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            appError("USER_CONTEXT_REQUIRED", "sorage vault move records a User decision and requires --as-user."),
            ports,
            json,
          ),
        );
        return;
      }
      // A relative --to resolves against the cwd once, so the recorded path and
      // every later probe agree no matter where subsequent commands run from.
      const targetPath = isAbsolute(options.to) ? options.to : resolve(options.to);
      const vaultPorts = createNodeVaultCommandPorts({ targetPath });
      const drained = vaultPorts.drainAtStart();
      if (!drained.ok) {
        reportExitCode(renderAppError(drained.error, ports, json));
        return;
      }
      const movePorts = vaultPorts.movePorts();
      if (!movePorts.ok) {
        reportExitCode(renderAppError(movePorts.error, ports, json));
        return;
      }
      const result = moveVault(movePorts.value);
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(
          `Moved the Vault from ${result.value.fromPath} to ${result.value.toPath} (${result.value.artifactsMoved} artifacts); the previous Vault was kept in place.\n`,
        );
      }
    });
}
