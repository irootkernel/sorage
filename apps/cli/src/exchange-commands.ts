import { executeExchange } from "@sorage/adapters/src/exchange-command-ports";
import {
  type AppError,
  type ExchangeAcceptanceInput,
  type ExchangeBodyInput,
  type ExchangeInformationKind,
  type ExchangeInput,
  exchangeInvalid,
  type ExchangeMaterialInput,
  type ExchangeRange,
  successEnvelope,
} from "@sorage/core";
import type { Command } from "commander";

interface ExchangeOutput {
  out(text: string): void;
  fail(error: AppError, json: boolean, fresh?: boolean): void;
  activationWarning(code: string, requestId: string): void;
  requestId(): string;
}

class InvalidInput extends Error {}

function unsigned(value: string, label: string): number {
  const numeric = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(numeric)) {
    throw new InvalidInput(`${label} must be a non-negative safe integer.`);
  }
  return numeric;
}

function body(options: { body?: string; file?: string }): ExchangeBodyInput {
  if ((options.body === undefined) === (options.file === undefined)) {
    throw new InvalidInput("Use exactly one of --body and --file.");
  }
  return options.body === undefined ? { file: options.file as string } : { text: options.body };
}

function accept(input: string[]): ExchangeAcceptanceInput[] {
  return input.map((raw) => {
    const match = /^([^:]+):(\d+)$/.exec(raw);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new InvalidInput("Each --accept must be a request ID and report version separated by a colon.");
    }
    return { requestId: match[1], reportVersion: unsigned(match[2], "Report version") };
  });
}

function range(input: string): ExchangeRange {
  const match = /^(\d+)(?:-(\d+))?$/.exec(input);
  if (match === null || match[1] === undefined)
    throw new InvalidInput("Use a sequence or an inclusive first-last range.");
  return { firstSeq: unsigned(match[1], "First sequence"), lastSeq: unsigned(match[2] ?? match[1], "Last sequence") };
}

function material(options: {
  kind: string;
  source?: string;
  offset?: string;
  length?: string;
  access?: string;
  value?: string;
}): ExchangeMaterialInput {
  if (options.kind === "external") {
    if (
      (options.access !== "url" && options.access !== "run-id" && options.access !== "query") ||
      options.value === undefined ||
      options.source !== undefined ||
      options.offset !== undefined ||
      options.length !== undefined
    ) {
      throw new InvalidInput("External references use --access and --value only.");
    }
    return { kind: "external", access: options.access, value: options.value };
  }
  if (
    (options.kind !== "copy" && options.kind !== "live" && options.kind !== "versioned") ||
    options.source === undefined ||
    options.access !== undefined ||
    options.value !== undefined
  ) {
    throw new InvalidInput("A local copy, live or versioned reference requires --source.");
  }
  return {
    kind: options.kind,
    path: options.source,
    offset: unsigned(options.offset ?? "0", "Source offset"),
    length: options.length === undefined ? null : unsigned(options.length, "Source length"),
  };
}

function append(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function business(command: Command): Command {
  return command
    .requiredOption("--operation-id <id>", "identity of this intended business operation")
    .option("--replay-only", "recover only the matching historical operation without execution");
}

function participant(command: Command): Command {
  return business(command.argument("<exchange-id>")).option("--claim <id>", "current Exchange claim for fresh work");
}

function withBody(command: Command): Command {
  return command
    .option("--body <text>", "exact message or report text")
    .option("--file <path>", "exact working body from the supplying Project's workspace");
}

function withAcceptance(command: Command): Command {
  return command.option("--accept <request-id:version>", "accept exactly this checked report version", append, []);
}

export function registerExchangeCommands(program: Command, output: ExchangeOutput): void {
  const exchange = program
    .command("exchange")
    .description("collaborate between registered Projects")
    .option("--project <id-or-slug>", "assert the acting Project resolved from this workspace");

  function run(command: Command, input: () => ExchangeInput) {
    const globals = command.optsWithGlobals();
    const json = globals.json === true;
    let parsed: ExchangeInput;
    try {
      parsed = input();
    } catch (error) {
      if (!(error instanceof InvalidInput)) throw error;
      output.fail(exchangeInvalid(error.message), json);
      return;
    }
    if (
      globals.cursor !== undefined ||
      globals.expectedRowVersion !== undefined ||
      (globals.confirm === true && (parsed.kind !== "join" || parsed.replaceClaim === undefined))
    ) {
      output.fail(
        exchangeInvalid(
          "Exchange does not use --cursor or --expected-row-version. Use --confirm only for claim replacement.",
        ),
        json,
      );
      return;
    }
    let fresh = false;
    const result = executeExchange(parsed, {
      project: typeof globals.project === "string" ? globals.project : undefined,
      asProject: typeof globals.as === "string" ? globals.as : undefined,
      asUser: globals.asUser === true,
      onFreshWrite: () => {
        fresh = true;
      },
    });
    if (!result.ok) {
      const error =
        !fresh && result.error.code === "INTERNAL_ERROR" && result.error.recovery === undefined
          ? {
              ...result.error,
              recovery: { suggestedCommand: "Retain this command and its output. Inspect or retry in the same mode." },
            }
          : result.error;
      output.fail(error, json, fresh);
      return;
    }
    const id = output.requestId();
    for (const warning of result.value.warnings ?? []) output.activationWarning(warning.code, id);
    output.out(`${JSON.stringify(json ? successEnvelope(result.value, id) : result.value, null, 2)}\n`);
  }

  business(exchange.command("create").description("create an Exchange and return its ID without a claim"))
    .option("--member <project>", "initial peer Project by ID or slug", append, [])
    .requiredOption("--goal <text>", "bounded Exchange goal")
    .option("--criterion <text>", "bounded completion criterion", append, [])
    .action((opts, command) =>
      run(command, () => ({
        kind: "create",
        peers: opts.member,
        goal: opts.goal,
        criteria: opts.criterion,
        operationId: opts.operationId,
        replayOnly: opts.replayOnly === true,
      })),
    );

  exchange
    .command("join")
    .description("acquire an Active Exchange claim and return the current view")
    .argument("<exchange-id>")
    .option("--replace-claim <id>", "replace the exact observed competing claim")
    .addHelpText("after", "\nReplacement also requires the global --confirm option.\n")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "join",
        exchangeId,
        replaceClaim: opts.replaceClaim,
        confirmed: command.optsWithGlobals().confirm === true,
      })),
    );

  exchange
    .command("inspect")
    .description("inspect the Exchange and current obligations without writing")
    .argument("<exchange-id>")
    .action((exchangeId, _opts, command) => run(command, () => ({ kind: "inspect", exchangeId })));

  exchange
    .command("history")
    .description("read a bounded page of Exchange history without confirming it")
    .argument("<exchange-id>")
    .option("--after-seq <n>", "return messages after this sequence", "0")
    .addHelpText("after", "\nUse the global --limit option or the configured ui.defaultPageSize.\n")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "history",
        exchangeId,
        afterSeq: unsigned(opts.afterSeq, "History sequence"),
        limit: command.optsWithGlobals().limit,
      })),
    );

  withAcceptance(withBody(participant(exchange.command("send").description("send an informational Exchange message"))))
    .option("--kind <kind>", "information, progress, clarification or blocked", "information")
    .option("--to <project>", "address an Exchange member explicitly")
    .option("--reply-to <seq>", "reply to a message on this Exchange")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "send",
        exchangeId,
        claim: opts.claim,
        operationId: opts.operationId,
        replayOnly: opts.replayOnly === true,
        messageKind: opts.kind as ExchangeInformationKind,
        body: body(opts),
        recipient: opts.to,
        replyTo: opts.replyTo === undefined ? undefined : unsigned(opts.replyTo, "Reply sequence"),
        accept: accept(opts.accept),
      })),
    );

  participant(exchange.command("request").description("direct an actionable request to a current Project"))
    .requiredOption("--assignee <project>", "accountable Project")
    .requiredOption("--condition <text>", "bounded requested condition")
    .option("--criterion <text>", "bounded request criterion", append, [])
    .option("--reply-to <seq>", "link an existing message on this Exchange")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "request",
        exchangeId,
        claim: opts.claim,
        operationId: opts.operationId,
        replayOnly: opts.replayOnly === true,
        assignee: opts.assignee,
        condition: opts.condition,
        criteria: opts.criterion,
        replyTo: opts.replyTo === undefined ? undefined : unsigned(opts.replyTo, "Reply sequence"),
      })),
    );

  withAcceptance(
    withBody(participant(exchange.command("report").description("report a versioned result on an assigned request"))),
  )
    .requiredOption("--request <id>", "assigned request")
    .requiredOption("--assignment-version <n>", "observed assignment version")
    .option("--evidence <material-id>", "registered material supporting the report", append, [])
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "report",
        exchangeId,
        claim: opts.claim,
        operationId: opts.operationId,
        replayOnly: opts.replayOnly === true,
        requestId: opts.request,
        assignmentVersion: unsigned(opts.assignmentVersion, "Assignment version"),
        body: body(opts),
        evidence: opts.evidence,
        accept: accept(opts.accept),
      })),
    );

  withAcceptance(
    participant(exchange.command("accept").description("accept exactly the named report versions as requester")),
  ).action((exchangeId, opts, command) =>
    run(command, () => ({
      kind: "accept",
      exchangeId,
      claim: opts.claim,
      operationId: opts.operationId,
      replayOnly: opts.replayOnly === true,
      accept: accept(opts.accept),
    })),
  );

  participant(exchange.command("material-register").description("register a working copy or original reference"))
    .requiredOption("--kind <kind>", "copy, live, versioned or external")
    .option("--source <path>", "local source inside the supplying Project's workspace")
    .option("--offset <n>", "local source start byte")
    .option("--length <n>", "local source byte count")
    .option("--access <kind>", "external descriptor kind for an already authorized tool")
    .option("--value <descriptor>", "opaque external URL, run ID or query")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "material-register",
        exchangeId,
        claim: opts.claim,
        operationId: opts.operationId,
        replayOnly: opts.replayOnly === true,
        material: material(opts),
      })),
    );

  exchange
    .command("material-read")
    .description("read registered material by ID in bounded exact byte ranges")
    .argument("<exchange-id>")
    .argument("<material-id>")
    .requiredOption("--offset <n>", "byte offset within the registered material")
    .addHelpText("after", "\nSupply the global --limit option for an exact byte limit from 1 to 65536.\n")
    .action((exchangeId, materialId, opts, command) =>
      run(command, () => ({
        kind: "material-read",
        exchangeId,
        materialId,
        offset: unsigned(opts.offset, "Material offset"),
        limit: command.optsWithGlobals().limit ?? 0,
      })),
    );

  exchange
    .command("confirm-read")
    .description("explicitly confirm delivered messages without filling unread gaps")
    .argument("<exchange-id>")
    .requiredOption("--claim <id>", "current Exchange claim")
    .option("--range <sequence-or-range>", "one delivered sequence or inclusive range", append, [])
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "confirm-read",
        exchangeId,
        claim: opts.claim,
        ranges: (opts.range as string[]).map(range),
      })),
    );

  exchange
    .command("recover")
    .description("discover the current Project's prior committed operations without writing")
    .argument("[exchange-id]", "omit to show only the acting Project's Exchange creation outcomes")
    .option("--operation-id <id>", "look up a specific caller operation ID")
    .action((exchangeId, opts, command) =>
      run(command, () => ({ kind: "recover", exchangeId, operationId: opts.operationId })),
    );
}
