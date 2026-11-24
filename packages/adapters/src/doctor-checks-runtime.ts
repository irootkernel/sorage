import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CheckOutcome, isManagedVaultPath, nextDueAt } from "@sorage/core";
import type { DoctorContext } from "./doctor-context";
import { blocking, CONFIG_REPAIR, ok, warning, withRecovery } from "./doctor-recoveries";
import { createNodeGitClient } from "./git-client";
import { launchAgentPlistPath, launchAgentsDirectory, launchAgentUid, plistPointsAtBinary } from "./launchagent-ports";
import { isPidAlive } from "./lockfile";

function readDaemonRecord(path: string): { pid: number; host: string; port: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; host?: unknown; port?: unknown };
    // The staleness evaluator treats out-of-domain pids as malformed, because
    // kill(-1, 0) and kill(0, 0) probe the caller's set rather than one daemon;
    // the same domain rules keep the doctor from framing a corrupt record as a
    // live-but-unhealthy daemon.
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port > 65535
    ) {
      return null;
    }
    return parsed as { pid: number; host: string; port: number };
  } catch {
    return null;
  }
}

export const runtimeDoctorChecks: Record<
  "daemon.reachable" | "daemon.port" | "token.permissions" | "service.installed" | "backup.schedule" | "git.state",
  (context: DoctorContext) => CheckOutcome
> = {
  "daemon.reachable"(context) {
    const recordPath = join(context.home.runDir, "daemon.json");
    const daemon = readDaemonRecord(recordPath);
    if (daemon === null) {
      if (existsSync(recordPath)) {
        return warning("run/daemon.json exists but cannot be parsed; delete it and start the daemon again.");
      }
      return ok("No daemon is recorded; start one with sorage daemon start when the API is needed.");
    }
    if (!isPidAlive(daemon.pid)) {
      return warning(`run/daemon.json names pid ${String(daemon.pid)}, which is not running; the record is stale.`);
    }
    const state = context.configurationState();
    if (state.kind !== "valid") {
      return withRecovery(
        warning("The daemon record cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    const config = state.config;
    // The CLI process blocks synchronously (CLI-020), so the health check
    // runs as the command's own subprocess exactly like the web probe; the
    // expected installationId is the configuration's, not the record's.
    const scriptArgs = process.argv[1]?.endsWith("main.ts")
      ? [process.argv[1], "__health-probe", daemon.host, String(daemon.port), config.installationId]
      : ["__health-probe", daemon.host, String(daemon.port), config.installationId];
    const probe = spawnSync(process.execPath, scriptArgs, { timeout: 5000, encoding: "utf8" });
    if (probe.status === 0) {
      return ok("The daemon answers /api/v1/health with the expected installationId.");
    }
    return warning("The daemon's pid is alive but /api/v1/health does not confirm this installation.");
  },

  "daemon.port"(context) {
    const state = context.configurationState();
    if (state.kind !== "valid") {
      return withRecovery(
        warning("The daemon port cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    const config = state.config;
    if (!context.portProbe(config.server.host, config.server.port)) {
      return ok(`Nothing is listening on ${config.server.host}:${config.server.port} yet.`);
    }
    const daemon = readDaemonRecord(join(context.home.runDir, "daemon.json"));
    if (
      daemon !== null &&
      isPidAlive(daemon.pid) &&
      daemon.host === config.server.host &&
      daemon.port === config.server.port
    ) {
      return ok("This installation's daemon is listening on the configured port.");
    }
    return warning(
      `Another process is listening on ${config.server.host}:${config.server.port}, so the daemon cannot bind it.`,
    );
  },

  "token.permissions"(context) {
    const tokenPath = join(context.home.stateDir, "api-token");
    if (!existsSync(tokenPath)) {
      return warning("The API token file does not exist yet; it is created at init or by a rotation.");
    }
    try {
      const stats = statSync(tokenPath);
      const mode = stats.mode & 0o777;
      if (mode !== 0o600) {
        return blocking(`The API token file mode is ${mode.toString(8)}, not 0600.`);
      }
      if (stats.size < 32) {
        return blocking("The API token file holds fewer than 32 bytes.");
      }
      return ok("The API token file is owner-only and holds at least 32 bytes.");
    } catch {
      return blocking("The API token file could not be inspected.");
    }
  },

  "service.installed"(context) {
    const agentsDirectory = launchAgentsDirectory(context.userHome);
    const plistPath = launchAgentPlistPath(agentsDirectory);
    const plist = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : null;
    if (plist === null) {
      return warning("The xyz.rootkernel.sorage LaunchAgent is not installed.");
    }
    const candidates = [process.execPath];
    if (process.argv[1]?.endsWith("main.ts")) {
      candidates.push(process.argv[1]);
    }
    if (!candidates.some((candidate) => plistPointsAtBinary(plist, candidate))) {
      return warning("The installed LaunchAgent plist points at a different sorage binary.");
    }
    const print = spawnSync("launchctl", ["print", `gui/${launchAgentUid()}/xyz.rootkernel.sorage`], {
      timeout: 5000,
      encoding: "utf8",
    });
    if (print.status !== 0) {
      return warning("The LaunchAgent plist exists but the agent is not bootstrapped in gui/$UID.");
    }
    return ok("The xyz.rootkernel.sorage LaunchAgent is bootstrapped and points at this binary.");
  },

  "backup.schedule"(context) {
    const state = context.configurationState();
    if (state.kind !== "valid") {
      return withRecovery(
        warning("The backup schedule cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    const config = state.config;
    const spec = {
      enabled: config.gitBackup.enabled,
      at: config.gitBackup.schedule.at,
      timezone: config.gitBackup.schedule.timezone,
      catchUpAfterMissedRun: config.gitBackup.schedule.catchUpAfterMissedRun,
    };
    if (!spec.enabled) return ok("The backup schedule is disabled.");
    let due: string | null;
    try {
      due = nextDueAt(spec, new Date());
    } catch {
      return warning(
        `The next due time is not computable in the configured zone ${spec.timezone}; sorage config validate names the accepted zones.`,
      );
    }
    if (due === null) {
      return warning("The next due time is not computable; check the schedule configuration.");
    }
    const history = context.backupRunRows();
    if (history === "unavailable") {
      return warning("The backup schedule cannot be verified because the database history could not be inspected.");
    }
    const lastFailure = history.findLast((row) => row.outcome === "failure");
    if (lastFailure !== undefined) {
      return warning(`The last backup run failed with ${String(lastFailure.failureCode)}.`);
    }
    const lastSuccess = history.findLast((row) => row.outcome !== "failure");
    if (lastSuccess !== undefined && Date.now() - Date.parse(lastSuccess.startedAt) > 25 * 3_600_000) {
      return warning(
        `The last successful backup is older than the configured cadence (last success ${lastSuccess.startedAt}).`,
      );
    }
    return ok(`The next backup is due at ${due}.`);
  },

  "git.state"(context) {
    const state = context.configurationState();
    const config = state.kind === "valid" ? state.config : null;
    if (config === null) {
      return withRecovery(
        warning("The Vault repository cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    const vault = context.vaultPath(config);
    if (vault === null) {
      return withRecovery(
        warning("The Vault repository cannot be checked without a valid configuration."),
        CONFIG_REPAIR,
      );
    }
    if (!existsSync(join(vault, ".git"))) return ok("The Vault has no Git repository yet.");
    const git = createNodeGitClient();
    const completed = git.run({ cwd: vault, args: ["symbolic-ref", "--short", "HEAD"] });
    const branch = completed.ok && completed.value.exitCode === 0 ? completed.value.stdout.trim() : "";
    if (branch !== config.gitBackup.push.branch) {
      return warning(
        `The Vault repository is on '${branch === "" ? "a detached HEAD" : branch}', not the configured branch '${config.gitBackup.push.branch}'.`,
      );
    }
    if (
      existsSync(join(vault, ".git", "MERGE_HEAD")) ||
      existsSync(join(vault, ".git", "rebase-merge")) ||
      existsSync(join(vault, ".git", "rebase-apply"))
    ) {
      return warning("The Vault repository has a merge or rebase in progress.");
    }
    const staged = git.run({ cwd: vault, args: ["diff", "--cached", "--name-only"] });
    const stagedPaths = (staged.ok ? staged.value.stdout : "").split("\n").filter((line) => line !== "");
    const unmanaged = stagedPaths.filter((path) => !isManagedVaultPath(path));
    if (unmanaged.length > 0) {
      return warning(`The index holds staged work outside the managed pathspecs: ${unmanaged.join(", ")}.`);
    }
    const listed = git.run({ cwd: vault, args: ["remote"] });
    const remotes =
      listed.ok && listed.value.exitCode === 0 ? listed.value.stdout.split("\n").filter((line) => line !== "") : [];
    if (config.gitBackup.push.enabled && !remotes.includes(config.gitBackup.push.remote)) {
      return warning(
        `Push is enabled for remote '${config.gitBackup.push.remote}' but the repository does not know that remote.`,
      );
    }
    return ok(`The Vault repository is on '${branch}' with a clean index.`);
  },
};
