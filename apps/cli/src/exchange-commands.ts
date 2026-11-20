import {
  admitExchangeJoin,
  executeExchange,
  type ExchangeCommandOptions,
  type ExchangeJoinAdmission,
} from "@sorage/adapters/src/exchange-command-ports";
import {
  appError,
  type AppError,
  type ExchangeAcceptanceInput,
  type ExchangeBodyInput,
  type ExchangeInformationKind,
  type ExchangeInput,
  EXCHANGE_POLL_SECONDS,
  EXCHANGE_WAIT_SECONDS,
  exchangeInvalid,
  type ExchangeMaterialInput,
  type ExchangeRange,
  successEnvelope,
} from "@sorage/core";
import type { Command } from "commander";
import { awaitExchangeJoinAck, EXCHANGE_JOIN_GATE } from "./exchange-join-gate";
import { guardedLeaseOwner, joinOwnedExchange, ownExchangeSession, ownedLeaseOf } from "./exchange-owner";

interface ExchangeOutput {
  out(text: string): void;
  err(text: string): void;
  exit(code: number): void;
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

export function registerExchangeCommands(program: Command, output: ExchangeOutput, processRuntime = false): void {
  const exchange = program
    .command("exchange")
    .description("collaborate between registered Projects")
    .option("--project <id-or-slug>", "assert the acting Project resolved from this workspace");

  function run(command: Command, input: () => ExchangeInput, session?: { stdinLifetime: boolean }) {
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
    const options: ExchangeCommandOptions = {
      project: typeof globals.project === "string" ? globals.project : undefined,
      asProject: typeof globals.as === "string" ? globals.as : undefined,
      asUser: globals.asUser === true,
      leaseOwnerAlive: processRuntime ? guardedLeaseOwner() : undefined,
      onFreshWrite: () => {
        fresh = true;
      },
    };
    const reject = (failure: AppError) => {
      const error =
        !fresh && failure.code === "INTERNAL_ERROR" && failure.recovery === undefined
          ? {
              ...failure,
              recovery: { suggestedCommand: "Retain this command and its output. Inspect or retry in the same mode." },
            }
          : failure;
      output.fail(error, json, fresh);
    };
    const execute = (joinAdmission?: ExchangeJoinAdmission) => {
      const result = executeExchange(parsed, { ...options, joinAdmission });
      if (!result.ok) {
        reject(result.error);
        return;
      }
      const id = output.requestId();
      for (const warning of result.value.warnings ?? []) output.activationWarning(warning.code, id);
      if (json && "timedOut" in result.value) {
        const { timedOut, ...data } = result.value;
        output.out(`${JSON.stringify(successEnvelope(data, id, timedOut ? { timedOut } : undefined), null, 2)}\n`);
      } else {
        output.out(`${JSON.stringify(json ? successEnvelope(result.value, id) : result.value, null, 2)}\n`);
      }
    };
    if (session) {
      if (!processRuntime || parsed.kind !== "join") {
        reject(appError("INTERNAL_ERROR", "Start an Exchange session in its own CLI process."));
        return;
      }
      const failure = () =>
        reject(appError("INTERNAL_ERROR", "The Exchange session could not confirm its initial join."));
      void joinOwnedExchange({ ...parsed, ...options }).then(({ stdout, stderr, status }) => {
        try {
          const envelope = JSON.parse(status === 0 ? stdout : stderr);
          if (status === 0 && envelope.ok === true) {
            const lease = ownedLeaseOf(envelope.data, process.cwd());
            if (envelope.data?.exchangeId !== parsed.exchangeId || (envelope.data?.state === "active" && !lease))
              return failure();
            if (lease) ownExchangeSession(lease, session.stdinLifetime);
            output.out(json ? stdout : `${JSON.stringify(envelope.data, null, 2)}\n`);
          } else if (
            status !== null &&
            status !== 0 &&
            envelope.ok === false &&
            typeof envelope.error?.code === "string"
          ) {
            if (json) {
              output.err(stderr);
              output.exit(status);
            } else {
              reject(envelope.error);
            }
          } else failure();
        } catch {
          failure();
        }
      }, failure);
      return;
    }
    if (processRuntime && parsed.kind === "join" && process.env[EXCHANGE_JOIN_GATE] === "1") {
      const admitted = admitExchangeJoin(parsed, options);
      if (!admitted.ok) {
        reject(admitted.error);
        return;
      }
      const { exchangeId, projectId } = admitted.value;
      const parent = process.ppid;
      options.leaseOwnerAlive = () => parent > 1 && process.ppid === parent;
      void awaitExchangeJoinAck({ exchangeId, projectId }).then((ack) => {
        if (ack) execute(admitted.value);
        else reject(appError("INTERNAL_ERROR", "The Exchange join admission ended before it could run."));
      });
      return;
    }
    execute();
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

  const join = (name: "join" | "session", description: string) =>
    exchange
      .command(name)
      .description(description)
      .argument("<exchange-id>")
      .option("--replace-claim <id>", "replace the exact observed competing claim")
      .addHelpText("after", "\nReplacement also requires the global --confirm option.\n");
  const joinInput = (exchangeId: string, opts: { replaceClaim?: string }, command: Command) =>
    ({
      kind: "join",
      exchangeId,
      replaceClaim: opts.replaceClaim,
      confirmed: command.optsWithGlobals().confirm === true,
    }) as const;
  join("join", "acquire an Active Exchange claim and return the current view").action((exchangeId, opts, command) =>
    run(command, () => joinInput(exchangeId, opts, command)),
  );

  join("session", "own and renew an Active Exchange claim for this CLI process")
    .option("--stdin-lifetime", "gracefully release the claim when stdin reaches EOF")
    .action((exchangeId, opts, command) =>
      run(command, () => joinInput(exchangeId, opts, command), { stdinLifetime: opts.stdinLifetime === true }),
    );

  for (const kind of ["renew", "release"] as const) {
    exchange
      .command(kind)
      .description(`${kind} the exact current Exchange claim`)
      .argument("<exchange-id>")
      .requiredOption("--claim <id>", "current Exchange claim")
      .action((exchangeId, opts, command) => run(command, () => ({ kind, exchangeId, claim: opts.claim })));
  }

  exchange
    .command("inspect")
    .description("inspect the Exchange and current obligations without writing")
    .argument("<exchange-id>")
    .action((exchangeId, _opts, command) => run(command, () => ({ kind: "inspect", exchangeId })));

  exchange
    .command("history")
    .description("read a bounded page of Exchange history without confirming it")
    .argument("<exchange-id>")
    .option("--after-seq <n>", "return messages after this sequence")
    .option("--history-cursor <cursor>", "continue from an Exchange delivery cursor")
    .addHelpText("after", "\nUse the global --limit option or the configured ui.defaultPageSize.\n")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "history",
        exchangeId,
        afterSeq: opts.afterSeq === undefined ? undefined : unsigned(opts.afterSeq, "History sequence"),
        cursor: opts.historyCursor,
        limit: command.optsWithGlobals().limit,
      })),
    );

  exchange
    .command("wait")
    .description("wait without writes for new relevant Exchange activity")
    .argument("<exchange-id>")
    .option("--history-cursor <cursor>", "observe activity after this Exchange delivery cursor")
    .option("--timeout <s>", "seconds until a quiet wait returns", String(EXCHANGE_WAIT_SECONDS))
    .option("--interval <s>", "seconds between covered reads", String(EXCHANGE_POLL_SECONDS))
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        kind: "wait",
        exchangeId,
        cursor: opts.historyCursor,
        limit: command.optsWithGlobals().limit,
        timeout: unsigned(opts.timeout, "Wait timeout"),
        interval: unsigned(opts.interval, "Wait interval"),
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
