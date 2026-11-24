import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeHandoffReadPorts } from "@sorage/adapters/src/handoff-command-ports";
import { runHandoffInboxWait } from "@sorage/adapters/src/wait-storage";
import {
  type AppError,
  appError,
  err,
  fetchHandoff,
  getHandoff,
  type HandoffListFilters,
  listInbox,
  listOutbox,
  ok,
  type Result,
  readHandoffTimeline,
  successEnvelope,
} from "@sorage/core";
import type { Command } from "commander";
import {
  actorInputOf,
  type OutputPorts,
  parseInteger,
  type ReportExitCode,
  refreshMarker,
  renderAppError,
  reportingSummary,
  reportListing,
  requestId,
  requireInitialized,
  requireInitializedConfiguration,
  withPorts,
} from "../cli-output";
import { withCoveredRead } from "../covered-read";
import { INBOX_WAIT_NO_CURSOR, INBOX_WAIT_WHOLE_SECONDS } from "../usage-sentences";

/**
 * The page-size default of section 13.9: the configured `ui.defaultPageSize`, never a CLI-local constant.
 * An operational read: a configuration that cannot be read refuses with the typed `CONFIG_INVALID`
 * (exit 78, nothing listed), and an absent file follows the factory mapping `NOT_INITIALIZED` (SHR-015).
 */
function defaultPageSize(): Result<number, AppError> {
  const gate = createNodeConfigCommandPorts();
  const current = gate.store.readForOperation();
  if (!current.ok) return err(current.error);
  if (current.value === null) {
    return err(
      appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: gate.configFile }),
    );
  }
  return ok(current.value.config.ui.defaultPageSize);
}

function listQueryOf(
  options: Record<string, unknown>,
  globals: Record<string, unknown>,
): Result<{ limit: number; cursor: string | undefined; filters: HandoffListFilters }, AppError> {
  const cursor = typeof globals.cursor === "string" ? globals.cursor : undefined;
  const filters: HandoffListFilters = {
    state: typeof options.state === "string" ? options.state : undefined,
    senderSlug: typeof options.sender === "string" ? options.sender : undefined,
    recipientSlug: typeof options.recipient === "string" ? options.recipient : undefined,
    updatedSince: typeof options.updatedSince === "string" ? options.updatedSince : undefined,
    updatedUntil: typeof options.updatedUntil === "string" ? options.updatedUntil : undefined,
    includeArchived: options.includeArchived === true,
    includeDeleted: options.includeDeleted === true,
  };
  if (typeof globals.limit === "number" && globals.limit > 0) {
    return ok({ limit: globals.limit, cursor, filters });
  }
  const limit = defaultPageSize();
  if (!limit.ok) return limit;
  return ok({ limit: limit.value, cursor, filters });
}

export function registerHandoffReadCommands(
  program: Command,
  ports: OutputPorts,
  reportExitCode: ReportExitCode,
): void {
  program
    .command("inbox")
    .description("list the Handoffs sent to the resolved recipient Project")
    .option("--state <state>", "filter by review state")
    .option("--sender <slug>", "filter by sender Project slug")
    .option("--recipient <slug>", "filter by recipient Project slug")
    .option("--updated-since <instant>", "inclusive lower bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--updated-until <instant>", "inclusive upper bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--include-archived", "include archived Handoffs")
    .option("--include-deleted", "include tombstones")
    .option("--wait", "poll until a new inbox item appears for the resolved actor, then list it")
    .option("--interval <s>", "seconds between two waits' polls; the default is 2", parseInteger, 2)
    .option("--timeout <s>", "seconds a wait gives up after; the default is 300", parseInteger, 300)
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      if (options.wait === true && typeof options.interval === "number" && options.interval < 1) {
        ports.err(`sorage: ${INBOX_WAIT_WHOLE_SECONDS}\n`);
        ports.err("Run 'sorage inbox --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (options.wait === true && typeof globals.cursor === "string") {
        ports.err(`sorage: ${INBOX_WAIT_NO_CURSOR}\n`);
        ports.err("Run 'sorage inbox --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (options.wait === true) {
        const intervalSeconds = typeof options.interval === "number" && options.interval >= 0 ? options.interval : 2;
        const timeoutSeconds = typeof options.timeout === "number" && options.timeout >= 0 ? options.timeout : 300;
        const waited = runHandoffInboxWait({
          actorInput: actorInputOf(globals),
          buildQuery: () => listQueryOf(options, globals),
          intervalSeconds,
          timeoutSeconds,
        });
        if (!waited.ok) {
          reportExitCode(renderAppError(waited.error, ports, json, undefined, { log: false }));
          return;
        }
        if (waited.value.timedOut) {
          if (json) {
            ports.out(
              `${JSON.stringify(successEnvelope({ handoffs: [], nextCursor: null }, requestId(), { timedOut: true }), null, 2)}\n`,
            );
          } else {
            ports.out(`No new Handoff appeared within ${timeoutSeconds}s\n`);
          }
          return;
        }
        reportListing({ handoffs: waited.value.handoffs, nextCursor: null }, ports, json, globals);
        return;
      }
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const readPorts = createNodeHandoffReadPorts({ database: storage.db });
        const inboxQuery = listQueryOf(options, globals);
        if (!inboxQuery.ok) {
          reportExitCode(renderAppError(inboxQuery.error, ports, json, undefined, { log: false }));
          return;
        }
        const result = listInbox(readPorts, actorInputOf(globals), inboxQuery.value);
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        reportListing(result.value, ports, json, globals);
      });
    });

  program
    .command("outbox")
    .description("list the Handoffs the resolved sender sent")
    .option("--current-workspace", "list the Workspace's Handoffs instead of the Project's")
    .option("--state <state>", "filter by review state")
    .option("--sender <slug>", "filter by sender Project slug")
    .option("--recipient <slug>", "filter by recipient Project slug")
    .option("--updated-since <instant>", "inclusive lower bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--updated-until <instant>", "inclusive upper bound on updatedAt, as an ISO-8601 UTC instant")
    .option("--include-archived", "include archived Handoffs")
    .option("--include-deleted", "include tombstones")
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const outboxPorts = createNodeHandoffReadPorts({ database: storage.db });
        const outboxQuery = listQueryOf(options, globals);
        if (!outboxQuery.ok) {
          reportExitCode(renderAppError(outboxQuery.error, ports, json, undefined, { log: false }));
          return;
        }
        const result = listOutbox(
          outboxPorts,
          actorInputOf(globals),
          outboxQuery.value,
          options.currentWorkspace === true,
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        reportListing(result.value, ports, json, globals);
      });
    });

  program
    .command("get <handoff-id>")
    .description("read one Handoff's metadata; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = getHandoff(createNodeHandoffReadPorts({ database: storage.db }), actorInputOf(globals), id);
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
        } else {
          ports.out(`${result.value.title} (${result.value.id})
`);
          ports.out(`  ${reportingSummary(result.value)}, revision ${result.value.revision}, rowVersion ${result.value.rowVersion}
`);
        }
      });
    });

  program
    .command("fetch <handoff-id>")
    .description(
      "read the current document's metadata and local path; does not edit the document, report processing or accept it",
    )
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(createNodeHandoffReadPorts({ configuration }), (readPorts) =>
        fetchHandoff(readPorts, actorInputOf(globals), id),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(
          `${JSON.stringify(successEnvelope({ handoff: result.value.handoff, artifact: result.value.artifact, localPath: result.value.localPath }, requestId()), null, 2)}
`,
        );
      } else {
        ports.out(`${result.value.artifact.originalName} (${result.value.artifact.sizeBytes} bytes)
`);
        ports.out(`  ${result.value.localPath}
`);
      }
    });

  program
    .command("events <handoff-id>")
    .description("read the bounded recent metadata timeline; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = readHandoffTimeline(
          createNodeHandoffReadPorts({ database: storage.db }),
          actorInputOf(globals),
          id,
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
        } else if (result.value.length === 0) {
          ports.out("no events\n");
        } else {
          for (const event of result.value) {
            const rowVersion = event.rowVersion === null ? "-" : String(event.rowVersion);
            ports.out(`${event.eventType}  actor ${event.actorKind}  rowVersion ${rowVersion}\n`);
          }
        }
      });
    });
}
