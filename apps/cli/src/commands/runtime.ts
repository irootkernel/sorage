import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { createNodeApiTokenStore } from "@sorage/adapters/src/token-store";
import { rotateApiToken, successEnvelope } from "@sorage/core";
import type { Command } from "commander";
import {
  CLI_NAME,
  type OutputPorts,
  type ReportExitCode,
  renderAppError,
  requestId,
  requireInitialized,
} from "../cli-output";
import { buildCompletionScript } from "../completion";
import { createDaemonRuntimePorts, daemonRestart, daemonStart, daemonStatus, daemonStop } from "../daemon-commands";
import { createWebRuntimePorts, runWebCommand } from "../web";

type DaemonAction = "start" | "stop" | "restart" | "status";

function runDaemonCommand(action: DaemonAction, ports: OutputPorts, options = { json: false }): number {
  const runtime = createDaemonRuntimePorts();
  const sinks = { out: ports.out, err: ports.err };
  if (action === "start") return daemonStart(runtime, sinks, { json: options.json });
  if (action === "stop") return daemonStop(runtime, sinks, { json: options.json });
  if (action === "restart") return daemonRestart(runtime, sinks, { json: options.json });
  return daemonStatus(runtime, sinks, { json: options.json });
}

export function registerRuntimeCommands(
  program: Command,
  ports: OutputPorts,
  reportExitCode: ReportExitCode,
  onMcpRequested?: () => void,
): void {
  program
    .command("completion <shell>")
    .description("print the shell completion script for zsh or bash; source it from the shell's profile")
    .action((shell: string, _options: unknown, command: Command) => {
      const script = buildCompletionScript(command.parent ?? program, shell, CLI_NAME);
      if (script === null) {
        ports.err(`sorage: completion supports zsh and bash, not '${shell}'\n`);
        ports.err("Run 'sorage completion --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      ports.out(script);
    });

  program.helpOption("-h, --help", "display help for the command");

  const daemon = program.command("daemon").description("run and control the local daemon");
  daemon
    .command("start")
    .description("start the daemon and confirm it through health")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      reportExitCode(runDaemonCommand("start", ports, { json }));
    });
  daemon
    .command("stop")
    .description("stop the daemon after a graceful drain of in-flight requests")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      reportExitCode(runDaemonCommand("stop", ports, { json }));
    });
  daemon
    .command("restart")
    .description("stop and start again; required after a server.host or server.port change")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      reportExitCode(runDaemonCommand("restart", ports, { json }));
    });
  daemon
    .command("status")
    .description("read run/daemon.json and verify installationId through health")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      reportExitCode(runDaemonCommand("status", ports, { json }));
    });
  daemon
    .command("serve", { hidden: true })
    .description("internal entry point that runs the daemon in the foreground until stopped");

  program
    .command("web")
    .description("start the daemon when needed and open the Web control plane with a one-time session secret")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const home = createNodeHomePaths();
      const code = runWebCommand(createWebRuntimePorts(home.stateDir), ports, { openBrowser: true, json });
      reportExitCode(code);
    });

  program
    .command("mcp")
    .description("serve the STDIO MCP adapter whose tools mirror the messaging CLI (interface section 39)")
    // Reached when a global option precedes the command (`sorage --json mcp`)
    // or through help; excess operands are commander's own usage exit, and the
    // plain form is intercepted in `main` before parsing.
    .allowExcessArguments(false)
    .action(() => {
      onMcpRequested?.();
      reportExitCode(-1);
    });

  const token = program.command("token").description("manage the Installation API token");
  token
    .command("rotate")
    .description("replace the Installation API token, invalidating every live browser session")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const home = createNodeHomePaths();
      const result = rotateApiToken(
        { token: createNodeApiTokenStore({ stateDir: home.stateDir }) },
        { asUser: globals.asUser === true },
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      const payload = { rotated: true, note: "run sorage web again for a fresh browser session" };
      if (json) ports.out(`${JSON.stringify(successEnvelope(payload, requestId()), null, 2)}\n`);
      else
        ports.out(
          `API token rotated; every live browser session is invalidated.\nRun 'sorage web' again for a fresh session.\n`,
        );
    });
}
