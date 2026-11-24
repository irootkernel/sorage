import { spawnSync } from "node:child_process";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDaemonPorts } from "@sorage/adapters/src/daemon-command-ports";
import {
  type AppError,
  appError,
  editConfiguration,
  parseLeafValue,
  setConfigurationValue,
  showConfiguration,
  successEnvelope,
  validateConfigurationFile,
} from "@sorage/core";
import type { Command } from "commander";
import {
  knownErrorCode,
  type OutputPorts,
  parseInteger,
  type ReportExitCode,
  renderAppError,
  requestId,
  requireInitialized,
} from "../cli-output";
import { selfInvocationArgv } from "../self-invocation";

/** The address of a daemon whose record is live, or null when none runs (CFG-016). */
function liveDaemonAddress(): { host: string; port: number } | null {
  const ports = createNodeDaemonPorts();
  const record = ports.readDaemonRecord();
  if (record === null || !ports.isPidAlive(record.pid)) return null;
  return { host: record.host, port: record.port };
}

/** Runs one routed configuration change through the daemon as a subprocess (CFG-016). */
function routedConfigSet(
  address: { host: string; port: number },
  key: string,
  value: string,
  ports: OutputPorts,
  options: { json: boolean; expectedRevision?: number | undefined },
): number {
  const subArgs = ["__config-put", address.host, String(address.port), key, value];
  if (options.expectedRevision !== undefined) subArgs.push(String(options.expectedRevision));
  const result = spawnSync(process.execPath, selfInvocationArgv(subArgs), { encoding: "utf8", timeout: 15000 });
  const unavailable = () =>
    renderAppError(
      appError("DAEMON_UNAVAILABLE", "the daemon did not answer the routed configuration change"),
      ports,
      options.json,
    );
  if (result.status === null || !result.stdout.trim()) return unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return unavailable();
  }
  if (typeof parsed !== "object" || parsed === null) return unavailable();
  const envelope = parsed as {
    ok?: unknown;
    data?: Record<string, unknown>;
    error?: {
      code?: unknown;
      message?: unknown;
      details?: Record<string, unknown>;
      recovery?: { suggestedCommand: string };
    };
    meta?: { requestId?: unknown };
  };
  if (envelope.ok === true && typeof envelope.data === "object" && envelope.data !== null) {
    const data = envelope.data;
    const resolvedKey = typeof data.key === "string" ? data.key : key;
    const resolvedValue = Object.hasOwn(data, "value")
      ? data.value
      : (() => {
          const parsedLeaf = parseLeafValue(resolvedKey, value);
          return parsedLeaf.ok ? parsedLeaf.value : value;
        })();
    const resolvedRevision = typeof data.configRevision === "number" ? data.configRevision : undefined;
    if (options.json) {
      const reqId = typeof envelope.meta?.requestId === "string" ? envelope.meta.requestId : requestId();
      ports.out(
        `${JSON.stringify(
          successEnvelope({ key: resolvedKey, value: resolvedValue, configRevision: resolvedRevision }, reqId),
          null,
          2,
        )}\n`,
      );
    } else {
      ports.out(`Set ${resolvedKey} = ${String(resolvedValue)} (configRevision ${String(resolvedRevision)})\n`);
    }
    return 0;
  }
  const code = knownErrorCode(envelope.error?.code);
  const message =
    typeof envelope.error?.message === "string" && envelope.error.message.length > 0
      ? envelope.error.message
      : "the routed configuration change failed";
  const error: AppError = {
    code,
    message,
    ...(typeof envelope.error?.details === "object" && envelope.error.details !== null
      ? { details: envelope.error.details }
      : {}),
    ...(typeof envelope.error?.recovery?.suggestedCommand === "string"
      ? { recovery: { suggestedCommand: envelope.error.recovery.suggestedCommand } }
      : {}),
  };
  return renderAppError(error, ports, options.json);
}

export function registerConfigCommands(program: Command, ports: OutputPorts, reportExitCode: ReportExitCode): void {
  const config = program.command("config").description("inspect and change the installation configuration");

  config
    .command("show")
    .description("print the effective configuration exactly as declared in config.yaml")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = showConfiguration(createNodeConfigCommandPorts());
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      else {
        const text = createNodeConfigCommandPorts().store.readText();
        ports.out(text === null ? "" : `${text.endsWith("\n") ? text : `${text}\n`}`);
      }
    });

  config
    .command("validate")
    .description("validate config.yaml against the schema and report every issue")
    .action((_options, command) => {
      const json = command.optsWithGlobals().json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      const result = validateConfigurationFile(createNodeConfigCommandPorts());
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json)
        ports.out(
          `${JSON.stringify(successEnvelope({ valid: true, path: result.value.path }, requestId()), null, 2)}\n`,
        );
      else ports.out(`Configuration is valid: ${result.value.path}\n`);
    });

  config
    .command("set")
    .description("set one configuration leaf through the atomic comment-preserving store")
    .argument("<key>", "the dotted configuration key, for example server.port")
    .argument("<value>", "the value written verbatim for strings, as integers or booleans otherwise")
    .option("--expected-revision <n>", "compare-and-set against this configRevision", parseInteger)
    .action((key, value, options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            appError(
              "USER_CONTEXT_REQUIRED",
              "config set and config edit are User-admin operations; re-run with --as-user",
            ),
            ports,
            json,
          ),
        );
        return;
      }
      // While the daemon runs it is the only writer of config.yaml (CFG-016): the
      // change routes through PUT /api/v1/config instead of the file store.
      const owned = liveDaemonAddress();
      if (owned !== null) {
        reportExitCode(routedConfigSet(owned, key, value, ports, { json, expectedRevision: options.expectedRevision }));
        return;
      }
      const result = setConfigurationValue(createNodeConfigCommandPorts(), {
        key,
        rawValue: value,
        asUser: globals.asUser === true,
        expectedRevision: options.expectedRevision,
      });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(
          `Set ${result.value.key} = ${String(result.value.value)} (configRevision ${result.value.configRevision})\n`,
        );
      }
    });

  config
    .command("edit")
    .description("open config.yaml in $EDITOR and adopt the result through the atomic store")
    .action((_options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode)) return;
      // An editor writes the file directly, which the daemon's exclusive writer rule
      // forbids while it runs (CFG-016).
      if (liveDaemonAddress() !== null) {
        reportExitCode(
          renderAppError(
            appError(
              "SERVICE_PAUSED",
              "the running daemon is the only writer of config.yaml; stop it before editing the file, or change settings through the Web settings page",
            ),
            ports,
            json,
          ),
        );
        return;
      }
      const result = editConfiguration(createNodeConfigCommandPorts(), { asUser: globals.asUser === true });
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else if (result.value.outcome === "changed") {
        ports.out(`Configuration updated (configRevision ${result.value.configRevision})\n`);
      } else {
        ports.out(`No changes (configRevision ${result.value.configRevision})\n`);
      }
    });
}
