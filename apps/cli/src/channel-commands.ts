import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  channelStorageError,
  createNodeChannelPorts,
  createNodeChannelRecoveryPorts,
  readChannelRecoveryConfiguration,
  captureChannelBodyFile,
  captureChannelBodyText,
  releaseAcceptedChannelBody,
  sweepChannelAcceptedInputs,
  type NodeChannelPorts,
} from "@sorage/adapters/src/channel-command-ports";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import { blockingSleepMs } from "@sorage/adapters/src/sleep";
import { createHomePaths } from "@sorage/adapters/src/home";
import {
  addAssignment,
  addParticipant,
  appError,
  closeAssignment,
  closeChannel,
  createChannel,
  deactivateParticipant,
  err,
  errorEnvelope,
  errorSpec,
  handleChannelMessage,
  listChannelMessages,
  listChannels,
  ok,
  readChannelMessage,
  showChannel,
  submitMessage,
  submitMessageReplayOnly,
  waitForChannelMessages,
  resolveCommandActor,
  successEnvelope,
  largeContentDisclosureMessage,
  type AcceptedChannelBody,
  type AppError,
  type ChannelActorAssertion,
  type ChannelCommandPorts,
  type ChannelSummary,
  type ChannelView,
  type MessageSummary,
  type MessageDetail,
  type ParticipantView,
  type AssignmentView,
  type Result,
} from "@sorage/core";
import { type Command, InvalidArgumentError } from "commander";

/**
 * The Channel command group of TASK-109 B2 (CHN-001 to CHN-011, interface
 * section 38.4): the complete CLI catalog with the existing global options,
 * JSON envelope, help and completion conventions, and exit-code categories.
 * Participant identity is asserted explicitly with `--as-participant`; main-
 * role operations accept the main participant assertion or the User context;
 * channel selection and participant identity are never inferred from the
 * working directory. The replay-only branch runs before any operational
 * drain, normal ports, migration, logger, marker refresh, or sweep: it reads
 * the selected installation's identity and bound non-mutating from
 * `config.yaml`, captures its original input into a private scratch
 * directory outside both the installation home and the Vault (climbing from
 * the system temporary directory and rejecting any candidate inside those
 * roots, following the M8 preflight scratch-parent pattern), and cleans the
 * scratch on every exit.
 */

type ChannelOperation =
  | "create"
  | "list"
  | "show"
  | "close"
  | "participant-add"
  | "participant-deactivate"
  | "assignment-add"
  | "assignment-close"
  | "submit"
  | "messages"
  | "read"
  | "handle";

interface ChannelCliOutput {
  out(text: string): void;
  /** The usage-error and diagnostic sink: stderr, never stdout. */
  err(text: string): void;
  fail(error: AppError, json: boolean): void;
  /** Recovery refusals must never create or append an installation log. */
  failReadOnly(error: AppError, json: boolean): void;
  requestId(): string;
  /** The diagnostic sink for the large-content Git-history disclosure: stderr, never stdout, never the JSON DTO. */
  warn(text: string): void;
  /** Reports a usage-error exit code for the enclosing CLI action. */
  usageExit(): void;
}

/** Recovery has its own no-log context; operational error guidance is unchanged. */
export function renderChannelRecoveryError(
  error: AppError,
  options: { err(text: string): void; json: boolean; requestId: string },
): number {
  const description =
    error.code === "INTERNAL_ERROR"
      ? "Channel submission recovery could not complete original-source validation or receipt inspection."
      : error.message;
  const failure = appError(
    error.code,
    `${description} The original submission outcome remains unknown. Retain the original key, exact input/source bytes, Installation, Channel, sender participant, request ${options.requestId} and this output.`,
    error.details,
  );
  failure.recovery = {
    suggestedCommand: `Keep the original key, exact input/source bytes, Installation, Channel and sender participant. Retain request ${options.requestId} and this output for diagnosis; an unknown outcome does not authorize another submission or blind external dispatch.`,
  };
  if (options.json) options.err(`${JSON.stringify(errorEnvelope(failure, options.requestId), null, 2)}\n`);
  else options.err(`${failure.code}: ${failure.message}\nRecovery: ${failure.recovery.suggestedCommand}\n`);
  return errorSpec(failure.code).exitCode;
}

/** Renders one contained warning through the diagnostic sink; a throwing sink never changes the result (SHR-015). */
function emitContainedWarning(output: ChannelCliOutput, text: string): void {
  try {
    output.warn(`warning: ${text}\n`);
  } catch {
    // A diagnostic sink failure never changes the command's output or exit code.
  }
}

/** The message of an unknown throwable, for warning text only. */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerChannelCommands(program: Command, output: ChannelCliOutput): void {
  const channel = program
    .command("channel")
    .description("manage attributed agent communication Channels for one orchestration invocation")
    .addHelpText(
      "after",
      "\nOnly channel handle compares --expected-row-version with an observed processing version. Other mutations accept the global option for uniformity without a version comparison; reads reject it. --as selects Project provenance only, never a Channel or participant.\n",
    );

  channel
    .command("create")
    .description("create an open Channel with its single main participant")
    .requiredOption("--main-handle <handle>", "handle of the single main participant")
    .option("--title <title>", "optional trimmed single-line Channel title")
    .option("--idempotency-key <key>", "original key for a retriable creation")
    .action((options, current) => {
      run("create", undefined, options, current);
    });

  channel
    .command("list")
    .description("list Channels with bounded keyset paging")
    .option("--state <state>", "open, closed, or all (default)")
    .action((options, current) => {
      run("list", undefined, options, current);
    });

  channel
    .command("show")
    .description("show one Channel with its participants, assignments, and counts")
    .argument("<channel>", "Channel UUID")
    .action((id, options, current) => {
      run("show", id, options, current);
    });

  channel
    .command("close")
    .description("terminal main-role close; freezes submissions, keeps reads and processing")
    .argument("<channel>", "Channel UUID")
    .option("--as-participant <id>", "acting main participant UUID")
    .action((id, options, current) => {
      run("close", id, options, current);
    });

  const participant = channel.command("participant").description("register and deactivate Channel participants");
  participant
    .command("add")
    .description("register a worker or judge participant on an open Channel")
    .argument("<channel>", "Channel UUID")
    .requiredOption("--role <role>", "worker or judge")
    .requiredOption("--handle <handle>", "bounded handle unique within the Channel")
    .option("--as-participant <id>", "acting main participant UUID")
    .option("--native <text>", "bounded native provenance entry (repeatable, at most four)", collectNative, [])
    .action((id, options, current) => {
      run("participant-add", id, options, current);
    });
  participant
    .command("deactivate")
    .description("deactivate a non-main participant")
    .argument("<channel>", "Channel UUID")
    .argument("<participant>", "participant UUID")
    .option("--as-participant <id>", "acting main participant UUID")
    .action((channelId, participantId, options, current) => {
      run("participant-deactivate", `${channelId} ${participantId}`, options, current);
    });

  const assignment = channel.command("assignment").description("create and close Channel assignments");
  assignment
    .command("add")
    .description("create a labeled assignment, optionally bound to a participant")
    .argument("<channel>", "Channel UUID")
    .requiredOption("--label <text>", "bounded assignment label")
    .option("--participant <id>", "optional participant UUID to bind")
    .option("--as-participant <id>", "acting main participant UUID")
    .action((id, options, current) => {
      run("assignment-add", id, options, current);
    });
  assignment
    .command("close")
    .description("close an assignment as metadata")
    .argument("<channel>", "Channel UUID")
    .argument("<assignment>", "assignment UUID")
    .option("--as-participant <id>", "acting main participant UUID")
    .action((channelId, assignmentId, options, current) => {
      run("assignment-close", `${channelId} ${assignmentId}`, options, current);
    });

  channel
    .command("submit")
    .description("submit one attributed message through the shared content interface")
    .argument("<channel>", "Channel UUID")
    .requiredOption("--as-participant <id>", "sender participant UUID")
    .requiredOption("--kind <kind>", "report, question, or relay_request")
    .option("--body <text>", "exact body text")
    .option("--body-file <path>", "import one bounded regular UTF-8 file")
    .option("--assignment <id>", "optional assignment UUID")
    .option("--relay-to <participant>", "target participant UUID for relay_request")
    .option("--context-session <s>", "external workflow context")
    .option("--context-node <s>", "external workflow context")
    .option("--context-attempt <s>", "external workflow context")
    .option("--idempotency-key <key>", "original key for a retriable submission")
    .option("--replay-only", "inspect the original receipt without executing on a miss")
    .action((id, options, current) => {
      run("submit", id, options, current);
    });

  channel
    .command("messages")
    .description("list message summaries with bounded previews and keyset paging")
    .argument("<channel>", "Channel UUID")
    .option("--unhandled", "list only unhandled messages (default)")
    .option("--handled", "list only handled messages")
    .option("--all", "list all messages")
    .option("--participant <id>", "filter by sender participant UUID")
    .option("--assignment <id>", "filter by assignment UUID")
    .option("--kind <kind>", "filter by message kind")
    .option("--wait", "poll until an unhandled message matches, then list it")
    .option("--interval <s>", "seconds between wait polls; the default is 2", parseInteger, 2)
    .option("--timeout <s>", "seconds a wait gives up after; the default is 300", parseInteger, 300)
    .action((id, options, current) => {
      run("messages", id, options, current);
    });

  channel
    .command("read")
    .description("return the complete message with its full body")
    .argument("<channel>", "Channel UUID")
    .argument("<message>", "message UUID")
    .action((channelId, messageId, options, current) => {
      run("read", `${channelId} ${messageId}`, options, current);
    });

  channel
    .command("handle")
    .description("main-role processing decision with compare-and-set")
    .argument("<channel>", "Channel UUID")
    .argument("<message>", "message UUID")
    .option("--expected-row-version <n>", "observed processing row version", parseInteger)
    .option("--as-participant <id>", "acting main participant UUID")
    .option("--note <text>", "optional bounded handling note")
    .action((channelId, messageId, options, current) => {
      run("handle", `${channelId} ${messageId}`, options, current);
    });

  function parseInteger(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError("expected a non-negative integer");
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
      throw new InvalidArgumentError("expected a non-negative integer");
    }
    return parsed;
  }

  /** Collects repeatable native provenance entries, preserving empty supplied values. */
  function collectNative(value: string, previous: string[]): string[] {
    return [...(previous ?? []), value];
  }

  function run(
    operation: ChannelOperation,
    ids: string | undefined,
    options: Record<string, unknown>,
    command: Command,
  ): null {
    const globals = command.optsWithGlobals();
    const json = globals.json === true;
    const readOnly = operation === "submit" && options.replayOnly === true;
    const invalid = (message: string): null => {
      if (readOnly) output.failReadOnly(appError("CHN_INVALID_INPUT", message), json);
      else output.fail(appError("CHN_INVALID_INPUT", message), json);
      return null;
    };
    const isMainRole =
      operation === "close" ||
      operation === "participant-add" ||
      operation === "participant-deactivate" ||
      operation === "assignment-add" ||
      operation === "assignment-close" ||
      operation === "handle";

    // Global-option coherence per operation.
    if (globals.confirm !== undefined) return invalid("Channel commands do not accept --confirm");
    // P3-G: the global --expected-row-version is required by channel handle
    // (which compares the observed processing row version). Other Channel
    // mutations accept a syntactically valid global value for uniformity,
    // following section 13.9, but have no version comparison target and
    // provide no compare-and-set guarantee. Read-only Channel commands reject
    // the mutation-only option as a usage error before any startup.
    const isReadOperation =
      operation === "list" || operation === "show" || operation === "messages" || operation === "read";
    if (globals.expectedRowVersion !== undefined && isReadOperation) {
      output.err("sorage: --expected-row-version is a mutation-only option; remove it from read commands\n");
      output.err("Run 'sorage channel --help' for usage.\n");
      output.usageExit();
      return null;
    }
    if (
      (globals.limit !== undefined || globals.cursor !== undefined) &&
      operation !== "list" &&
      operation !== "messages"
    )
      return invalid("Channel pagination options apply only to list and messages");

    // D2: mutually exclusive handling filters refuse combinations rather than
    // silently prioritizing one.
    if (operation === "messages") {
      const handlingFlags = [options.unhandled === true, options.handled === true, options.all === true].filter(
        Boolean,
      ).length;
      if (handlingFlags > 1) {
        output.err("sorage: channel messages accepts at most one of --unhandled, --handled, or --all\n");
        output.err("Run 'sorage channel messages --help' for usage.\n");
        output.usageExit();
        return null;
      }
    }

    // D1: the wait variant permits only unhandled (its pending-inclusive
    // contract); a different handling filter with --wait is a usage error
    // before any operational startup, never a silent override.
    // D2 extension: --interval or --timeout supplied without --wait is also a
    // usage error; Commander's `getOptionValueSource` distinguishes user
    // input from the declared defaults (2 and 300).
    if (operation === "messages") {
      if (options.wait === true) {
        if (options.handled === true || options.all === true) {
          output.err("sorage: channel messages --wait lists only unhandled messages; remove --handled or --all\n");
          output.err("Run 'sorage channel messages --help' for usage.\n");
          output.usageExit();
          return null;
        }
        if (typeof globals.cursor === "string") {
          output.err(
            "sorage: channel messages --wait cannot combine with --cursor; a wait lists only matching messages\n",
          );
          output.err("Run 'sorage channel messages --help' for usage.\n");
          output.usageExit();
          return null;
        }
        if (typeof options.interval === "number" && options.interval < 1) {
          output.err("sorage: channel messages --wait polls at whole-second intervals; pass --interval 1 or more\n");
          output.err("Run 'sorage channel messages --help' for usage.\n");
          output.usageExit();
          return null;
        }
      } else {
        // --interval/--timeout without --wait: refuse only when the user
        // actually supplied them (not the defaults), using the Commander
        // option-value source.
        const current = command;
        const intervalSource = current.getOptionValueSource("interval");
        const timeoutSource = current.getOptionValueSource("timeout");
        if (intervalSource === "cli" || timeoutSource === "cli") {
          output.err("sorage: channel messages --interval and --timeout apply only with --wait\n");
          output.err("Run 'sorage channel messages --help' for usage.\n");
          output.usageExit();
          return null;
        }
      }
    }

    // The two modes share one source-choice gate before operational startup
    // or recovery capture, so neither silently discards supplied material.
    if (operation === "submit" && options.body !== undefined && options.bodyFile !== undefined) {
      return invalid("Choose one body source: --body or --body-file");
    }

    // Replay-only branch: before any operational drain, normal ports,
    // migration, logger, marker refresh, or sweep.
    if (readOnly) {
      try {
        return runReplayOnly(ids as string, options, json);
      } catch (error) {
        output.failReadOnly(channelStorageError(error), json);
        return null;
      }
    }

    // Existing native recovery remains separate from the Channel operation's own effects.
    const drained = createNodeVaultCommandPorts({ contentionSurface: "channel" }).drainAtStart();
    if (!drained.ok) {
      output.fail(drained.error, json);
      return null;
    }

    let ports: NodeChannelPorts;
    try {
      ports = createNodeChannelPorts();
    } catch (error) {
      output.fail(channelStorageError(error), json);
      return null;
    }

    let accepted: AcceptedChannelBody | undefined;
    const warnings: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    try {
      sweepChannelAcceptedInputs();
      if (ports.disclosures !== undefined) {
        const composed = ports.disclosures;
        (ports as ChannelCommandPorts).disclosures = {
          ...composed,
          largeContent: (sizeBytes: number, thresholdBytes: number) => {
            warnings.push({ sizeBytes, thresholdBytes });
          },
        };
      }

      // SHR-015: the actor resolves on this command's existing open-and-migrated
      // connection — the Channel ports' own Project composition — so no extra
      // open-and-migrate and no unclosed connection exist.
      const actor = resolveCommandActor(ports.projectPorts, {
        path: process.cwd(),
        userHome: homedir(),
        as: typeof globals.as === "string" ? globals.as : undefined,
        asUser: globals.asUser === true,
      });
      if (!actor.ok) {
        output.fail(actor.error, json);
        return null;
      }

      const asParticipant = typeof options.asParticipant === "string" ? options.asParticipant : undefined;
      const assertion: ChannelActorAssertion = {
        actor: actor.value,
        ...(asParticipant !== undefined ? { asParticipant } : {}),
        ...(globals.asUser === true ? { asUser: true } : {}),
      };

      if (isMainRole && asParticipant === undefined && globals.asUser !== true) {
        return invalid("Main-role operations require --as-participant <main-id> or --as-user");
      }

      const idList = (ids ?? "").split(" ").filter((part) => part.length > 0);

      let result: Result<unknown> | undefined;
      switch (operation) {
        case "create":
          result = createChannel(ports, {
            creator: actor.value,
            mainHandle: options.mainHandle,
            title: options.title,
            ...(options.idempotencyKey !== undefined ? { idempotencyKey: String(options.idempotencyKey) } : {}),
          });
          break;
        case "list":
          result = listChannels(ports, {
            ...(options.state === undefined ? {} : { state: options.state }),
            ...(globals.limit === undefined ? {} : { limit: globals.limit }),
            ...(globals.cursor === undefined ? {} : { cursor: globals.cursor }),
          });
          break;
        case "show":
          result = showChannel(ports, idList[0]);
          break;
        case "close":
          result = closeChannel(ports, { channelId: idList[0], assertion });
          break;
        case "participant-add":
          result = addParticipant(ports, {
            channelId: idList[0],
            assertion,
            role: options.role,
            handle: options.handle,
            nativeProvenance: Array.isArray(options.native)
              ? (options.native as string[])
              : options.native !== undefined
                ? [String(options.native)]
                : [],
          });
          break;
        case "participant-deactivate":
          result = deactivateParticipant(ports, { channelId: idList[0], participantId: idList[1], assertion });
          break;
        case "assignment-add":
          result = addAssignment(ports, {
            channelId: idList[0],
            assertion,
            participantId: options.participant,
            label: options.label,
          });
          break;
        case "assignment-close":
          result = closeAssignment(ports, { channelId: idList[0], assignmentId: idList[1], assertion });
          break;
        case "submit": {
          const body = bodyInput(options, ports);
          if (!body.ok) {
            output.fail(body.error, json);
            return null;
          }
          accepted = body.value;
          result = submitMessage(ports, {
            channelId: idList[0],
            senderParticipantId: options.asParticipant,
            kind: options.kind,
            accepted,
            ...(options.assignment !== undefined ? { assignmentId: options.assignment } : {}),
            ...(options.relayTo !== undefined ? { relayToParticipantId: options.relayTo } : {}),
            ...(options.contextSession !== undefined ? { contextSession: options.contextSession } : {}),
            ...(options.contextNode !== undefined ? { contextNode: options.contextNode } : {}),
            ...(options.contextAttempt !== undefined ? { contextAttempt: options.contextAttempt } : {}),
            ...(options.idempotencyKey !== undefined ? { idempotencyKey: String(options.idempotencyKey) } : {}),
            actor: actor.value,
          });
          break;
        }
        case "messages": {
          if (options.wait === true) {
            const intervalSeconds = typeof options.interval === "number" ? options.interval : 2;
            const timeoutSeconds = typeof options.timeout === "number" ? options.timeout : 300;
            const waited = waitForChannelMessages(
              ports,
              idList[0] as string,
              {
                participantId: typeof options.participant === "string" ? options.participant : null,
                assignmentId: typeof options.assignment === "string" ? options.assignment : null,
                kind:
                  typeof options.kind === "string" ? (options.kind as "report" | "question" | "relay_request") : null,
              },
              {
                intervalSeconds,
                timeoutSeconds,
                sleepMs: blockingSleepMs,
                ...(globals.limit === undefined ? {} : { limit: globals.limit }),
              },
            );
            if (!waited.ok) {
              output.fail(waited.error, json);
              return null;
            }
            if (waited.value.timedOut) {
              if (json) {
                output.out(
                  `${JSON.stringify(successEnvelope({ items: [], nextCursor: null }, output.requestId(), { timedOut: true }), null, 2)}\n`,
                );
              } else {
                output.out(`No matching unhandled message appeared within ${String(timeoutSeconds)}s\n`);
              }
              return null;
            }
            result = ok({ items: waited.value.messages, nextCursor: waited.value.nextCursor });
          } else {
            const handling = options.handled === true ? "handled" : options.all === true ? "all" : "unhandled";
            result = listChannelMessages(ports, idList[0], {
              handling,
              ...(options.participant === undefined ? {} : { participantId: options.participant }),
              ...(options.assignment === undefined ? {} : { assignmentId: options.assignment }),
              ...(options.kind === undefined ? {} : { kind: options.kind }),
              ...(globals.limit === undefined ? {} : { limit: globals.limit }),
              ...(globals.cursor === undefined ? {} : { cursor: globals.cursor }),
            });
          }
          break;
        }
        case "read":
          result = readChannelMessage(ports, idList[0], idList[1]);
          break;
        case "handle": {
          // P3-G: the global --expected-row-version works through
          // optsWithGlobals before or after the command; the local option
          // is the same flag, and handle alone requires it.
          const expectedVersion = globals.expectedRowVersion ?? options.expectedRowVersion;
          if (expectedVersion === undefined) {
            return invalid("channel handle requires --expected-row-version from the observed message");
          }
          result = handleChannelMessage(ports, {
            channelId: idList[0],
            messageId: idList[1],
            assertion,
            expectedRowVersion: expectedVersion,
            ...(options.note !== undefined ? { note: options.note } : {}),
          });
          break;
        }
      }
      if (result === undefined) return invalid("An internal Channel command dispatch failed");
      if (!result.ok) {
        if (warnings.length > 0 && json) {
          let error = result.error;
          try {
            const appended = warnings
              .map((warning) => largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes))
              .join(" ");
            error = { ...error, message: `${error.message}; ${appended}` };
          } catch {
            // Formatting failure leaves the original error intact.
          }
          output.fail(error, json);
          return null;
        }
        for (const warning of warnings) {
          try {
            output.warn(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
          } catch {
            // A diagnostic flush failure never masks the real error.
          }
        }
        output.fail(result.error, json);
        return null;
      }
      for (const warning of warnings) {
        try {
          output.warn(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
        } catch {
          // A diagnostic flush failure never changes a committed outcome.
        }
      }
      emitResult(operation, result.value, json);
      return null;
    } finally {
      // Post-commit cleanup (SHR-015 category (iv)): each step is separately
      // contained so a failure warns and never changes the emitted result or
      // skips the remaining cleanup.
      try {
        if (accepted !== undefined) releaseAcceptedChannelBody(accepted);
      } catch (error) {
        emitContainedWarning(output, `the accepted Channel body could not be released: ${errorMessageOf(error)}`);
      }
      try {
        ports.close();
      } catch (error) {
        emitContainedWarning(output, `the Channel storage connection could not be closed: ${errorMessageOf(error)}`);
      }
    }
  }

  /**
   * The non-mutating selected-installation read for the replay-only branch:
   * reads `config.yaml` and parses it, extracting the installation identity
   * and the configured accepted-body bound. Never a lock, never a write.
   */
  function readSelectedInstallation(): Result<
    { installationId: string; maxBytes: number; vaultPath: string },
    AppError
  > {
    return readChannelRecoveryConfiguration();
  }

  /**
   * The private scratch parent outside both the installation home and the
   * Vault, following the M8 preflight scratch-parent pattern: climb from the
   * system temporary directory through its parents, and take the first
   * candidate that is a writable directory NOT inside either root.
   */
  function scratchOutsideRoots(homeRoot: string, vaultRoot: string): Result<string, AppError> {
    const roots = [homeRoot, vaultRoot];
    let current = tmpdir();
    for (let depth = 0; depth < 8; depth += 1) {
      const resolved = tryRealpath(current) ?? current;
      if (!isInsideRoots(resolved, roots) && isWritableDirectory(resolved)) {
        return ok(resolved);
      }
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }
    return err(
      appError(
        "INTERNAL_ERROR",
        "No writable scratch directory outside the installation and Vault was found for the recovery capture",
      ),
    );
  }

  function tryRealpath(path: string): string | undefined {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  }

  function isInsideRoots(candidate: string, roots: string[]): boolean {
    return roots.some((root) => {
      const resolvedRoot = tryRealpath(root) ?? root;
      return candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}/`);
    });
  }

  function isWritableDirectory(path: string): boolean {
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) return false;
      accessSync(path, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  function runReplayOnly(channelId: string, options: Record<string, unknown>, json: boolean): null {
    if (options.idempotencyKey === undefined) {
      output.failReadOnly(appError("CHN_INVALID_INPUT", "--replay-only requires the original --idempotency-key"), json);
      return null;
    }
    if (options.body === undefined && options.bodyFile === undefined) {
      output.failReadOnly(appError("CHN_INVALID_INPUT", "--replay-only requires the original body input"), json);
      return null;
    }
    // The selected installation's identity and bound, read non-mutating from
    // its configuration: no lock, no write, no normal ports.
    const installation = readSelectedInstallation();
    if (!installation.ok) {
      output.failReadOnly(installation.error, json);
      return null;
    }
    // The private capture scratch lives outside both the installation home
    // and the Vault, so a TMPDIR pointing inside either root is rejected.
    const userHome = homedir();
    const home = createHomePaths({ SORAGE_HOME: process.env.SORAGE_HOME }, userHome);
    const scratchParent = scratchOutsideRoots(home.home, installation.value.vaultPath);
    if (!scratchParent.ok) {
      output.failReadOnly(scratchParent.error, json);
      return null;
    }
    const scratch = mkdtempSync(join(scratchParent.value, "sorage-channel-recovery-"));
    let accepted: AcceptedChannelBody | undefined;
    try {
      const capture = { maxBytes: installation.value.maxBytes, stateDir: scratch, spoolId: randomUUID() };
      const body =
        options.bodyFile !== undefined
          ? captureChannelBodyFile(String(options.bodyFile), capture)
          : captureChannelBodyText(String(options.body), capture);
      if (!body.ok) {
        output.failReadOnly(body.error, json);
        return null;
      }
      accepted = body.value;
      const recovery = createNodeChannelRecoveryPorts();
      const result = submitMessageReplayOnly(recovery, {
        installationId: installation.value.installationId,
        maxBytes: installation.value.maxBytes,
        channelId,
        senderParticipantId: options.asParticipant,
        kind: options.kind,
        accepted,
        ...(options.assignment !== undefined ? { assignmentId: options.assignment } : {}),
        ...(options.relayTo !== undefined ? { relayToParticipantId: options.relayTo } : {}),
        ...(options.contextSession !== undefined ? { contextSession: options.contextSession } : {}),
        ...(options.contextNode !== undefined ? { contextNode: options.contextNode } : {}),
        ...(options.contextAttempt !== undefined ? { contextAttempt: options.contextAttempt } : {}),
        idempotencyKey: String(options.idempotencyKey),
      });
      if (!result.ok) {
        output.failReadOnly(result.error, json);
        return null;
      }
      if (json) {
        output.out(
          `${JSON.stringify(successEnvelope({ message: result.value, replayed: true }, output.requestId()), null, 2)}\n`,
        );
      } else {
        renderMessageSummary(result.value, output.out);
        output.out("Replayed the original recorded outcome; the original outcome is historical.\n");
      }
      return null;
    } finally {
      if (accepted !== undefined) releaseAcceptedChannelBody(accepted);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  function bodyInput(options: Record<string, unknown>, ports: NodeChannelPorts): Result<AcceptedChannelBody> {
    const capture = { maxBytes: ports.maxBytes, stateDir: ports.stateDir, spoolId: randomUUID() };
    if (options.bodyFile !== undefined) {
      return captureChannelBodyFile(String(options.bodyFile), capture);
    }
    if (options.body !== undefined) {
      return captureChannelBodyText(String(options.body), capture);
    }
    return { ok: false, error: appError("CHN_INVALID_INPUT", "A submission requires --body or --body-file") };
  }

  function emitResult(operation: ChannelOperation, value: unknown, json: boolean): void {
    if (json) {
      // F1: every operation returns its exact closed JSON data wrapper from
      // section 38.4 line 1710 — no flat or extra fields.
      let data: unknown;
      switch (operation) {
        case "create":
          data = { channel: (value as { channel: ChannelView }).channel };
          break;
        case "show":
        case "close":
          data = { channel: value };
          break;
        case "participant-add":
        case "participant-deactivate":
          data = { participant: value };
          break;
        case "assignment-add":
        case "assignment-close":
          data = { assignment: value };
          break;
        case "submit":
          data = value;
          break; // {message, replayed} — already the exact shape
        case "read":
        case "handle":
          data = { message: value };
          break;
        case "list":
        case "messages":
          data = value;
          break; // {items, nextCursor} — already the exact shape
      }
      output.out(`${JSON.stringify(successEnvelope(data, output.requestId()), null, 2)}\n`);
      return;
    }
    switch (operation) {
      case "create": {
        const { channel } = value as { channel: ChannelView; replayed: boolean };
        output.out(`${channel.id} [${channel.state}] ${channel.title ?? "(untitled)"}\n`);
        output.out(`Main: ${channel.mainParticipantId}\n`);
        break;
      }
      case "list": {
        const page = value as { items: ChannelSummary[]; nextCursor: string | null };
        for (const item of page.items) {
          output.out(`${item.id} [${item.state}] ${item.title ?? "(untitled)"} — main: ${item.mainHandle}\n`);
        }
        if (page.nextCursor) output.out(`Next cursor: ${page.nextCursor}\n`);
        break;
      }
      case "messages": {
        const page = value as { items: MessageSummary[]; nextCursor: string | null };
        for (const item of page.items) {
          output.out(
            `${item.id} [${item.kind}] ${item.senderHandle}: ${item.bodyPreview}${item.bodyPreviewTruncated ? "…" : ""}\n`,
          );
        }
        if (page.nextCursor) output.out(`Next cursor: ${page.nextCursor}\n`);
        break;
      }
      case "show": {
        const view = value as ChannelView;
        output.out(`${view.id} [${view.state}] ${view.title ?? "(untitled)"}\n`);
        output.out(`Created: ${view.createdAt} by ${view.creatorKind}\n`);
        for (const p of view.participants) {
          output.out(`  ${p.id} [${p.role}] ${p.handle}${p.active ? "" : " (inactive)"}\n`);
        }
        for (const a of view.assignments) {
          output.out(`  ${a.id} [${a.state}] ${a.label}\n`);
        }
        output.out(`Messages: ${String(view.messageCount)} (${String(view.unhandledCount)} unhandled)\n`);
        break;
      }
      case "close": {
        const view = value as ChannelView;
        output.out(`${view.id} closed at ${view.closedAt ?? "unknown"}\n`);
        break;
      }
      case "participant-add":
      case "participant-deactivate": {
        const view = value as ParticipantView;
        output.out(
          `${view.id} [${view.role}] ${view.handle} ${view.active ? "active" : `deactivated at ${view.deactivatedAt}`}\n`,
        );
        break;
      }
      case "assignment-add":
      case "assignment-close": {
        const view = value as AssignmentView;
        output.out(`${view.id} [${view.state}] ${view.label}\n`);
        break;
      }
      case "submit": {
        const { message, replayed } = value as { message: MessageSummary; replayed: boolean };
        renderMessageSummary(message, output.out);
        if (replayed) output.out("Replayed the original recorded outcome.\n");
        break;
      }
      case "read": {
        const detail = value as MessageDetail;
        output.out(`${detail.id} [${detail.kind}] ${detail.senderHandle}\n`);
        output.out(`${detail.body}\n`);
        break;
      }
      case "handle": {
        renderMessageSummary(value as MessageSummary, output.out);
        break;
      }
    }
  }

  function renderMessageSummary(message: MessageSummary, out: (text: string) => void): void {
    out(
      `${message.id} [${message.kind}] ${message.senderHandle}: ${message.bodyPreview}${message.bodyPreviewTruncated ? "…" : ""}\n`,
    );
    out(
      `  ${message.handled ? `handled at ${message.handledAt ?? "unknown"}` : "unhandled"} (version ${String(message.processingRowVersion)})\n`,
    );
  }
}
