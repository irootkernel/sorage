import { randomUUID } from "node:crypto";
import {
  captureChannelBodyFile,
  captureChannelBodyText,
  channelStorageError,
  createNodeChannelPorts,
  type NodeChannelPorts,
  releaseAcceptedChannelBody,
  sweepChannelAcceptedInputs,
} from "@sorage/adapters/src/channel-command-ports";
import { type CoveredReadStorage, openCoveredReadStorage } from "@sorage/adapters/src/read-storage";
import { blockingSleepMs } from "@sorage/adapters/src/sleep";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  type AcceptedChannelBody,
  type AppError,
  ackMessages,
  addParticipant,
  appError,
  type ChannelCommandPorts,
  channelError,
  closeChannel,
  createChannel,
  err,
  largeContentDisclosureMessage,
  listChannelMessages,
  listChannels,
  type MessageView,
  ok,
  postMessage,
  type Result,
  removeParticipant,
  showChannel,
  successEnvelope,
  isRetryableWaitListingFailure,
  waitForChannelMessages,
} from "@sorage/core";
import { type Command, InvalidArgumentError, Option } from "commander";
import { CHANNEL_WAIT_ONLY_OPTIONS, CHANNEL_WAIT_UNHANDLED_ONLY, CHANNEL_WAIT_WHOLE_SECONDS } from "./usage-sentences";

/**
 * The rebuilt Channel command group of TASK-123 (CHN-001 to CHN-014, interface
 * sections 38.3 to 38.6): the nine-command catalog with the existing global
 * options, JSON envelope, help and completion conventions, and exit-code
 * categories. Channels are addressed by name or UUID, participants by handle
 * and messages by per-Channel sequence number; there is no `--as-participant`,
 * no version comparison, no Project resolution and no replay-only mode, and
 * provenance is always the User (CHN-013). The covered zero-write reads —
 * `messages` (with `--wait`), `list` and `show` — open storage through the
 * TASK-122 primitive with the Vault and pause admission the pre-Task drain
 * performed, render log-free, and re-admit on every poll of a wait without
 * that admission (RDR-001, RDR-005); every mutation runs the ordinary drain,
 * ports, and sweep composition and one fenced transaction.
 */

type ChannelOperation = "create" | "add" | "remove" | "post" | "messages" | "ack" | "close" | "list" | "show";

const KINDS = ["report", "question", "relay_request"] as const;

interface ChannelCliOutput {
  out(text: string): void;
  /** The usage-error and diagnostic sink: stderr, never stdout. */
  err(text: string): void;
  fail(error: AppError, json: boolean, options?: { log?: boolean }): void;
  requestId(): string;
  /** The diagnostic sink for warnings: stderr, never stdout, never the JSON DTO. */
  warn(text: string): void;
  /** Reports a usage-error exit code for the enclosing CLI action. */
  usageExit(): void;
}

export function registerChannelCommands(program: Command, output: ChannelCliOutput): void {
  const channel = program
    .command("channel")
    .description("manage attributed agent communication Channels for one orchestration invocation");

  channel
    .command("create")
    .description("create an open Channel with its single main participant")
    .argument("<name>", "globally unique Channel name")
    .option("--title <title>", "optional trimmed single-line Channel title")
    .option("--main <handle>", "handle of the single main participant", "main")
    .action((name, options, current) => {
      run("create", [name], options, current);
    });

  channel
    .command("add")
    .description("register a worker or judge participant on an open Channel")
    .argument("<channel>", "Channel name or UUID")
    .argument("<handle>", "bounded handle unique within the Channel")
    .requiredOption("--role <role>", "worker or judge")
    .action((channelRef, handle, options, current) => {
      run("add", [channelRef, handle], options, current);
    });

  channel
    .command("remove")
    .description("remove a participant idempotently; reversible by re-adding the handle")
    .argument("<channel>", "Channel name or UUID")
    .argument("<handle>", "participant handle")
    .action((channelRef, handle, options, current) => {
      run("remove", [channelRef, handle], options, current);
    });

  channel
    .command("post")
    .description("post one attributed message upstream through the shared content interface")
    .argument("<channel>", "Channel name or UUID")
    .requiredOption("--from <handle>", "sending participant handle")
    .addOption(
      new Option("--kind <kind>", "report, question, or relay_request").choices([...KINDS]).makeOptionMandatory(),
    )
    .option("--to <handle>", "target handle, required for relay_request")
    .option("--ref <text>", "optional bounded verbatim untrusted reference")
    .option("--body <text>", "exact body text")
    .option("--body-file <path>", "import one bounded regular UTF-8 file")
    .action((channelRef, options, current) => {
      run("post", [channelRef], options, current);
    });

  channel
    .command("messages")
    .description("list messages with full inline bodies; unhandled oldest first by default")
    .argument("<channel>", "Channel name or UUID")
    .option("--all", "list all messages, handled included")
    .option("--after <seq>", "restrict results to messages after this sequence number", parseInteger)
    .option("--from <handle>", "filter by sending handle")
    .addOption(new Option("--kind <kind>", "filter by message kind").choices([...KINDS]))
    .option("--limit <n>", "page size for the listing", parseInteger)
    .option("--wait", "poll until an unhandled message matches, then list it")
    .option("--interval <s>", "seconds between wait polls; the default is 2", parseInteger, 2)
    .option("--timeout <s>", "seconds a wait gives up after; the default is 60", parseInteger, 60)
    .action((channelRef, options, current) => {
      run("messages", [channelRef], options, current);
    });

  channel
    .command("ack")
    .description("record the User handling decision for the named messages")
    .argument("<channel>", "Channel name or UUID")
    .argument("<seq...>", "one or more per-Channel sequence numbers")
    .option("--note <text>", "optional bounded handling note")
    .action((channelRef, seqs, options, current) => {
      run("ack", [channelRef, ...seqs], options, current);
    });

  channel
    .command("close")
    .description("terminal idempotent close; freezes posting, keeps reads and acks")
    .argument("<channel>", "Channel name or UUID")
    .action((channelRef, options, current) => {
      run("close", [channelRef], options, current);
    });

  channel
    .command("list")
    .description("list Channels with both identifiers")
    .option("--state <state>", "open, closed, or all (default)")
    .action((options, current) => {
      run("list", [], options, current);
    });

  channel
    .command("show")
    .description("show one Channel with its complete participant roster and counts")
    .argument("<channel>", "Channel name or UUID")
    .action((channelRef, options, current) => {
      run("show", [channelRef], options, current);
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

  function run(
    operation: ChannelOperation,
    positionals: string[],
    options: Record<string, unknown>,
    command: Command,
  ): null {
    const globals = command.optsWithGlobals();
    const json = globals.json === true;
    const waiting = operation === "messages" && options.wait === true;
    const covered = operation === "list" || operation === "show" || operation === "messages";
    // A covered read renders every failure, usage errors included, without the
    // log (RDR-001); a mutation renders through the ordinary log path.
    const render: { log?: boolean } | undefined = covered ? { log: false } : undefined;
    const fail = (error: AppError): null => {
      output.fail(error, json, render);
      return null;
    };
    const invalid = (message: string): null => fail(appError("CHN_INVALID_INPUT", message));
    const usage = (message: string): null => {
      output.err(`sorage: ${message}\n`);
      output.err("Run 'sorage channel --help' for usage.\n");
      output.usageExit();
      return null;
    };

    // Commander's positional arguments arrive as separate values and reach
    // core byte-exact; identities with spaces are never split (CHN-002).
    const idList = positionals;

    // Root-option coherence: the rebuilt surface takes no Project context, no
    // confirmation, no row version, and no cursor anywhere (CHN-002, CHN-013).
    if (globals.as !== undefined) return invalid("Channel commands do not accept --as; provenance is always User");
    if (globals.confirm !== undefined) return invalid("Channel commands do not accept --confirm");
    if (globals.expectedRowVersion !== undefined)
      return usage("--expected-row-version is not a Channel option; the rebuilt surface compares no row version");
    if (globals.cursor !== undefined) return usage("--cursor is not a Channel option; there is no cursor");
    if (globals.limit !== undefined && operation !== "messages")
      return usage("--limit applies only to channel messages");

    if (operation === "messages") {
      if (waiting) {
        if (options.all === true) return usage(CHANNEL_WAIT_UNHANDLED_ONLY);
        if (typeof options.interval === "number" && options.interval < 1) return usage(CHANNEL_WAIT_WHOLE_SECONDS);
      } else {
        const intervalSource = command.getOptionValueSource("interval");
        const timeoutSource = command.getOptionValueSource("timeout");
        if (intervalSource === "cli" || timeoutSource === "cli") return usage(CHANNEL_WAIT_ONLY_OPTIONS);
      }
    }

    if (operation === "post" && options.body !== undefined && options.bodyFile !== undefined) {
      return invalid("Choose one body source: --body or --body-file");
    }
    if (operation === "ack") {
      // A whole decimal positive safe integer and nothing else: `1junk`,
      // `1.5`, `1e3`, `+1`, `0x1`, an empty operand and an unsafe value are
      // refused here, before any mutation, handling nothing.
      const operands = idList.slice(1);
      if (operands.length === 0) return invalid("An ack requires at least one sequence number");
      if (operands.some((operand) => !/^[0-9]+$/.test(operand))) {
        return invalid("Sequence numbers are positive integers");
      }
      const seqs = operands.map((operand) => Number.parseInt(operand, 10));
      if (seqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) {
        return invalid("Sequence numbers are positive integers");
      }
      options.seqs = seqs;
    }

    if (covered) return runCoveredRead(operation, idList, options, globals, json);

    // The mutation composition: the native recovery drain, the operational
    // ports, and the shared accepted-input sweep (RUN-002, SHR-015).
    const drained = createNodeVaultCommandPorts({ contentionSurface: "channel" }).drainAtStart();
    if (!drained.ok) return fail(channelError(drained.error));

    let ports: NodeChannelPorts;
    try {
      ports = createNodeChannelPorts();
    } catch (error) {
      return fail(channelError(channelStorageError(error)));
    }

    let accepted: AcceptedChannelBody | undefined;
    const warnings: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    try {
      sweepChannelAcceptedInputs();
      {
        // The contained sinks of SHR-015: the large-content disclosure buffers
        // for the result envelope, and the post-commit completion warning
        // reaches stderr as a diagnostic that never changes the outcome.
        const composed = ports.disclosures;
        (ports as ChannelCommandPorts).disclosures = {
          backupEnabled: composed?.backupEnabled ?? false,
          thresholdBytes: composed?.thresholdBytes ?? 0,
          largeContent: (sizeBytes: number, thresholdBytes: number) => {
            warnings.push({ sizeBytes, thresholdBytes });
          },
          completionWarning: (text: string) => {
            emitWarning(output, text);
          },
        };
      }

      let result: Result<unknown, AppError>;
      switch (operation) {
        case "create":
          result = createChannel(ports, { name: idList[0], title: options.title, main: options.main });
          break;
        case "add":
          result = addParticipant(ports, { channelRef: idList[0], handle: idList[1], role: options.role });
          break;
        case "remove":
          result = removeParticipant(ports, { channelRef: idList[0], handle: idList[1] });
          break;
        case "post": {
          const body = bodyInput(options, ports);
          if (!body.ok) {
            output.fail(channelError(body.error), json);
            return null;
          }
          accepted = body.value;
          result = postMessage(ports, {
            channelRef: idList[0],
            from: options.from,
            kind: options.kind,
            ...(options.to === undefined ? {} : { to: options.to }),
            ...(options.ref === undefined ? {} : { ref: options.ref }),
            accepted,
          });
          break;
        }
        case "ack":
          result = ackMessages(ports, {
            channelRef: idList[0],
            seqs: options.seqs as number[],
            ...(options.note === undefined ? {} : { note: options.note }),
          });
          break;
        case "close":
          result = closeChannel(ports, { channelRef: idList[0] });
          break;
        default:
          return invalid("An internal Channel command dispatch failed");
      }
      if (!result.ok) {
        let error = channelError(result.error);
        if (warnings.length > 0 && json) {
          try {
            const appended = warnings
              .map((warning) => largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes))
              .join(" ");
            error = { ...error, message: `${error.message}; ${appended}` };
          } catch {
            // Formatting failure leaves the original error intact.
          }
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
      emitResult(operation, result.value, json);
      return null;
    } catch (error) {
      output.fail(channelError(channelStorageError(error)), json);
      return null;
    } finally {
      // Post-commit cleanup (SHR-015 category (iv)): each step is separately
      // contained so a failure warns and never changes the emitted result.
      try {
        if (accepted !== undefined) releaseAcceptedChannelBody(accepted);
      } catch (error) {
        emitWarning(output, `the accepted Channel body could not be released: ${errorMessageOf(error)}`);
      }
      try {
        ports.close();
      } catch (error) {
        emitWarning(output, `the Channel storage connection could not be closed: ${errorMessageOf(error)}`);
      }
    }
  }

  /** Maps a throw escaping the covered Channel read onto its typed envelope; nothing raw escapes. */
  function thrownChannelReadError(error: unknown): AppError {
    return channelError(channelStorageError(error));
  }

  /**
   * The covered zero-write read composition (RDR-001, RDR-002): storage opens
   * read-only through the shared primitive with the Vault and pause admission
   * the pre-Task drain performed — a live `vault-move.lock` refuses with
   * `SERVICE_PAUSED`, then `openVault`'s state-specific refusal, both
   * read-only and in the drain's order (RDR-005) — the body composes the
   * domain ports over the injected connection, the connection closes when the
   * read ends, and every failure renders without creating the log.
   */
  function runCoveredRead(
    operation: ChannelOperation,
    idList: string[],
    options: Record<string, unknown>,
    globals: Record<string, unknown>,
    json: boolean,
  ): null {
    if (operation === "messages" && options.wait === true) {
      return runWait(idList[0] ?? "", options, globals, json);
    }
    const fail = (error: AppError): null => {
      output.fail(error, json, { log: false });
      return null;
    };
    let storage: Result<CoveredReadStorage, AppError>;
    try {
      storage = openCoveredReadStorage({ surface: "channel", vaultAdmission: true });
    } catch (error) {
      storage = err(thrownChannelReadError(error));
    }
    if (!storage.ok) return fail(storage.error);
    let ports: NodeChannelPorts | undefined;
    try {
      ports = createNodeChannelPorts({ database: storage.value.db });
      let result: Result<unknown, AppError>;
      switch (operation) {
        case "list":
          result = listChannels(ports, { ...(options.state === undefined ? {} : { state: options.state }) });
          break;
        case "show":
          result = showChannel(ports, { channelRef: idList[0] });
          break;
        case "messages":
          result = listChannelMessages(ports, {
            channelRef: idList[0],
            ...(options.all === true ? { all: true } : {}),
            ...(options.after === undefined ? {} : { after: options.after }),
            ...(options.from === undefined ? {} : { from: options.from }),
            ...(options.kind === undefined ? {} : { kind: options.kind }),
            ...(globals.limit === undefined ? {} : { limit: globals.limit }),
          });
          break;
        default:
          result = err(appError("INTERNAL_ERROR", "An internal Channel read dispatch failed"));
          break;
      }
      if (!result.ok) return fail(channelError(result.error));
      if (json) {
        output.out(`${JSON.stringify(successEnvelope(result.value, output.requestId()), null, 2)}\n`);
      } else {
        renderRead(operation, result.value, output.out);
      }
      return null;
    } catch (error) {
      return fail(thrownChannelReadError(error));
    } finally {
      try {
        ports?.close();
      } catch {
        // The storage close below owns the injected connection.
      }
      storage.value.close();
    }
  }

  /**
   * The Channel wait of CHN-007 and section 38.5: the Vault and pause
   * admission runs once, here at the start, exactly as the pre-Task drain did;
   * the Channel and `--from` validation runs on the start listing, which is
   * the wait's first poll; and every later poll re-admits storage without the
   * admission and never re-validates the handle, so a Vault move or a handle
   * removal that begins mid-wait does not end the wait (RDR-005 keeps the
   * pre-Task exit: arrival or timeout, exit 0).
   */
  function runWait(
    channelRef: string,
    options: Record<string, unknown>,
    globals: Record<string, unknown>,
    json: boolean,
  ): null {
    const fail = (error: AppError): null => {
      output.fail(error, json, { log: false });
      return null;
    };
    const intervalSeconds = typeof options.interval === "number" ? options.interval : 2;
    const timeoutSeconds = typeof options.timeout === "number" ? options.timeout : 60;
    // The deadline is measured from invocation, before the start admission and
    // the once-only validation run (section 38.5).
    const deadlineAt = Date.now() + timeoutSeconds * 1000;
    const listing = {
      channelRef,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(globals.limit === undefined ? {} : { limit: globals.limit }),
    };

    let start: Result<CoveredReadStorage, AppError>;
    try {
      start = openCoveredReadStorage({ surface: "channel", vaultAdmission: true });
    } catch (error) {
      start = err(thrownChannelReadError(error));
    }
    if (!start.ok) return fail(start.error);
    // The start listing is this wait's first poll (pending-inclusive): the
    // once-only Channel and `--from` validation runs on it, an unknown Channel
    // or handle fails here immediately (section 38.4 line 1712), its success
    // marks the filter validated, and a retryable read-side failure is the
    // first poll's failure inside the loop. No second listing runs at
    // invocation.
    let first: Result<MessageView[], AppError>;
    let startPorts: NodeChannelPorts | undefined;
    try {
      startPorts = createNodeChannelPorts({ database: start.value.db });
      const validated = listChannelMessages(startPorts, listing);
      first = validated.ok ? ok(validated.value.items) : validated;
    } catch (error) {
      first = err(thrownChannelReadError(error));
    } finally {
      try {
        startPorts?.close();
      } catch {
        // The storage close below owns the injected connection.
      }
      start.value.close();
    }
    if (!first.ok && !isRetryableWaitListingFailure(first.error)) return fail(channelError(first.error));

    let filterValidated = first.ok;
    let startListing: Result<MessageView[], AppError> | null = first;
    const poll = (): Result<MessageView[], AppError> => {
      if (startListing !== null) {
        const result = startListing;
        startListing = null;
        return result;
      }
      let storage: Result<CoveredReadStorage, AppError>;
      try {
        storage = openCoveredReadStorage({ surface: "channel" });
      } catch (error) {
        storage = err(thrownChannelReadError(error));
      }
      if (!storage.ok) return storage;
      let ports: NodeChannelPorts | undefined;
      try {
        ports = createNodeChannelPorts({ database: storage.value.db });
        if (!filterValidated) {
          // Only after a retryable start failure: every poll validates until
          // one listing succeeds — a typed unknown-Channel or handle refusal
          // ends the wait at once, and a retryable failure keeps polling.
          const first = listChannelMessages(ports, listing);
          if (!first.ok) return first;
          filterValidated = true;
          return ok(first.value.items);
        }
        // After validation the polls never re-validate the handle: a removal
        // mid-wait does not end the wait (section 38.5).
        const listed = listChannelMessages(ports, { ...listing, fromAlreadyValidated: true });
        return listed.ok ? ok(listed.value.items) : listed;
      } catch (error) {
        return err(thrownChannelReadError(error));
      } finally {
        try {
          ports?.close();
        } catch {
          // The storage close below owns the injected connection.
        }
        storage.value.close();
      }
    };

    const waited = waitForChannelMessages({ intervalSeconds, deadlineAt, sleepMs: blockingSleepMs, poll });
    if (!waited.ok) return fail(channelError(waited.error));
    if (waited.value.timedOut) {
      if (json) {
        output.out(
          `${JSON.stringify(successEnvelope({ items: [] }, output.requestId(), { timedOut: true }), null, 2)}\n`,
        );
      } else {
        output.out(`No matching unhandled message appeared within ${String(timeoutSeconds)}s\n`);
      }
      return null;
    }
    if (json) {
      output.out(`${JSON.stringify(successEnvelope({ items: waited.value.items }, output.requestId()), null, 2)}\n`);
    } else {
      renderRead("messages", { items: waited.value.items }, output.out);
    }
    return null;
  }

  function bodyInput(options: Record<string, unknown>, ports: NodeChannelPorts): Result<AcceptedChannelBody> {
    const capture = { maxBytes: ports.maxBytes, stateDir: ports.stateDir, spoolId: randomUUID() };
    if (options.bodyFile !== undefined) {
      return captureChannelBodyFile(String(options.bodyFile), capture);
    }
    if (options.body !== undefined) {
      return captureChannelBodyText(String(options.body), capture);
    }
    return err(appError("CHN_INVALID_INPUT", "A post requires --body or --body-file"));
  }

  function emitResult(operation: ChannelOperation, value: unknown, json: boolean): void {
    if (json) {
      // Every operation returns its exact closed JSON wrapper of section 38.4
      // — no flat or extra fields.
      output.out(`${JSON.stringify(successEnvelope(value, output.requestId()), null, 2)}\n`);
      return;
    }
    switch (operation) {
      case "create": {
        const created = value as { channel: ChannelCreateView; existing: boolean };
        output.out(`${created.channel.name} [${created.channel.state}] ${created.channel.title ?? "(untitled)"}\n`);
        output.out(`Main: ${created.channel.main}\n`);
        if (created.existing) output.out("The Channel already existed; nothing changed.\n");
        break;
      }
      case "add":
      case "remove": {
        const participant = value as { participant: ParticipantLine };
        const state =
          participant.participant.removedAt === null
            ? `registered at ${participant.participant.addedAt}`
            : `removed at ${participant.participant.removedAt}`;
        output.out(`${participant.participant.handle} [${participant.participant.role}] ${state}\n`);
        break;
      }
      case "post": {
        const posted = value as { message: MessageView; duplicate: boolean };
        output.out(describeMessage(posted.message));
        if (posted.duplicate) output.out("Duplicate of the original unhandled message; nothing changed.\n");
        break;
      }
      case "ack": {
        const acked = value as { handled: number[]; alreadyHandled: number[]; note: string | null };
        output.out(
          `Handled: ${acked.handled.length === 0 ? "none" : acked.handled.map((seq) => `#${String(seq)}`).join(", ")}\n`,
        );
        output.out(
          `Already handled: ${acked.alreadyHandled.length === 0 ? "none" : acked.alreadyHandled.map((seq) => `#${String(seq)}`).join(", ")}\n`,
        );
        break;
      }
      case "close": {
        const closed = value as { channel: ChannelCreateView };
        output.out(`${closed.channel.name} closed at ${closed.channel.closedAt ?? "unknown"}\n`);
        break;
      }
      default:
        break;
    }
  }

  function renderRead(operation: ChannelOperation, value: unknown, out: (text: string) => void): void {
    switch (operation) {
      case "list": {
        const page = value as { items: ChannelSummaryLine[] };
        for (const item of page.items) {
          out(`${item.name} [${item.state}] ${item.title ?? "(untitled)"} — main: ${item.main} (${item.id})\n`);
        }
        break;
      }
      case "show": {
        const view = value as { channel: ChannelCreateView };
        out(`${view.channel.name} [${view.channel.state}] ${view.channel.title ?? "(untitled)"}\n`);
        out(`Main: ${view.channel.main}\n`);
        for (const participant of view.channel.participants) {
          out(
            `  ${participant.handle} [${participant.role}]${participant.removedAt === null ? "" : ` removed at ${participant.removedAt}`}\n`,
          );
        }
        out(`Messages: ${String(view.channel.messageCount)} (${String(view.channel.unhandledCount)} unhandled)\n`);
        break;
      }
      case "messages": {
        const page = value as { items: MessageView[] };
        for (const item of page.items) {
          out(describeMessage(item));
        }
        break;
      }
      default:
        break;
    }
  }

  function describeMessage(message: MessageView): string {
    const target = message.to === null ? "" : ` → ${message.to}`;
    const body =
      message.bodyPending || message.body === null
        ? "body pending activation; the message is committed and needs no resubmission"
        : message.body;
    const reference = message.ref === null ? "" : ` ref: ${message.ref}`;
    return `#${String(message.seq)} [${message.kind}] ${message.from}${target}${reference}: ${body}\n`;
  }
}

interface ChannelCreateView {
  id: string;
  name: string;
  title: string | null;
  state: string;
  main: string;
  participantCount: number;
  messageCount: number;
  unhandledCount: number;
  participants: ParticipantLine[];
  createdAt: string;
  closedAt: string | null;
}

interface ParticipantLine {
  handle: string;
  role: string;
  addedAt: string;
  removedAt: string | null;
}

interface ChannelSummaryLine {
  id: string;
  name: string;
  title: string | null;
  state: string;
  main: string;
  createdAt: string;
  closedAt: string | null;
}

/** Renders one contained warning through the diagnostic sink; a throwing sink never changes the result (SHR-015). */
function emitWarning(output: ChannelCliOutput, text: string): void {
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
