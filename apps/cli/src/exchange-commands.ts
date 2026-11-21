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
  type ExchangeControlInput,
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

function accept(input: string[], option: "accept" | "report" | "disposition" = "accept"): ExchangeAcceptanceInput[] {
  const version = option === "disposition" ? "ownership version" : "report version";
  return input.map((raw) => {
    const match = /^([^:]+):(\d+)$/.exec(raw);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new InvalidInput(`Each --${option} must be a request ID and ${version} separated by a colon.`);
    }
    return {
      requestId: match[1],
      reportVersion: unsigned(match[2], option === "disposition" ? "Ownership version" : "Report version"),
    };
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
      (globals.confirm === true &&
        !(
          (parsed.kind === "join" && (parsed.replaceClaim !== undefined || parsed.resume !== undefined)) ||
          parsed.kind === "roster" ||
          parsed.kind === "owner-correct" ||
          parsed.kind === "stop"
        ))
    ) {
      output.fail(
        exchangeInvalid(
          "Exchange does not use --cursor or --expected-row-version. Use --confirm only for an authorized Exchange control.",
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
            if (
              envelope.data?.exchangeId !== parsed.exchangeId ||
              (envelope.data?.state === "active" && !lease && !envelope.data?.replayed)
            )
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
      .option("--pause-version <n>", "resume the exact observed pause")
      .option("--decision <text>", "required user decision for the observed pause")
      .option("--operation-id <id>", "caller operation ID for durable resumption")
      .option("--replay-only", "recover an exact recorded resumption without acquiring a claim")
      .addHelpText("after", "\nReplacement and resumption require the global --confirm option.\n");
  const joinInput = (
    exchangeId: string,
    opts: {
      replaceClaim?: string;
      pauseVersion?: string;
      decision?: string;
      operationId?: string;
      replayOnly?: boolean;
    },
    command: Command,
  ): ExchangeInput => {
    const confirmed = command.optsWithGlobals().confirm === true;
    let resume: Extract<ExchangeControlInput, { kind: "resume" }> | undefined;
    if (
      opts.pauseVersion !== undefined ||
      opts.decision !== undefined ||
      opts.operationId !== undefined ||
      opts.replayOnly
    ) {
      if (opts.pauseVersion === undefined || opts.operationId === undefined)
        throw new InvalidInput("Resumption requires --pause-version and --operation-id.");
      resume = {
        kind: "resume",
        exchangeId,
        pauseVersion: unsigned(opts.pauseVersion, "Pause version"),
        decision: opts.decision,
        operationId: opts.operationId,
        confirmed,
        replayOnly: opts.replayOnly === true,
      };
    }
    return {
      kind: "join",
      exchangeId,
      replaceClaim: opts.replaceClaim,
      confirmed,
      ...(resume ? { resume } : {}),
    };
  };
  join("join", "acquire an Active claim, resume an observed pause, or return the retained Exchange view").action(
    (exchangeId, opts, command) => run(command, () => joinInput(exchangeId, opts, command)),
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

  const controls = (kind: string, description: string) => {
    const command = exchange.command(kind).description(description);
    return kind === "roster" || kind === "owner-correct" || kind === "stop"
      ? business(command.argument("<exchange-id>"))
      : participant(command);
  };
  const reason = (command: Command) => command.requiredOption("--reason <text>", "bounded Exchange workflow reason");
  const rosterObservation = (command: Command) =>
    command.requiredOption("--roster-version <n>", "observed roster version");
  const stateObservation = (command: Command) =>
    command.option("--pause-version <n>", "observed pause version, initially zero");
  const requestObservation = (command: Command) =>
    command
      .requiredOption("--request <id>", "retained request ID")
      .requiredOption("--ownership-version <n>", "observed request ownership version");
  const identity = (exchangeId: string, opts: { operationId: string; replayOnly?: boolean; claim?: string }) => ({
    exchangeId,
    operationId: opts.operationId,
    replayOnly: opts.replayOnly === true,
    claim: opts.claim,
  });
  const observedRoster = (opts: { rosterVersion: string }) => unsigned(opts.rosterVersion, "Roster version");
  const observedPause = (opts: { pauseVersion?: string }) => unsigned(opts.pauseVersion ?? "0", "Pause version");
  const observedOwner = (opts: { ownershipVersion: string }) => unsigned(opts.ownershipVersion, "Ownership version");

  stateObservation(rosterObservation(reason(controls("roster", "apply an authorized versioned roster correction"))))
    .option("--add <project>", "add the registered Project", append, [])
    .option("--remove <project>", "remove the current Project", append, [])
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        ...identity(exchangeId, opts),
        kind: "roster",
        rosterVersion: observedRoster(opts),
        pauseVersion: observedPause(opts),
        add: opts.add,
        remove: opts.remove,
        reason: opts.reason,
        confirmed: command.optsWithGlobals().confirm === true,
      })),
    );
  stateObservation(
    rosterObservation(
      requestObservation(reason(controls("owner-correct", "correct request responsibility with user authorization"))),
    ),
  )
    .option("--acceptance-owner <project>", "current accountable requester")
    .option("--assignee <project>", "current assignee")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        ...identity(exchangeId, opts),
        kind: "owner-correct",
        requestId: opts.request,
        rosterVersion: observedRoster(opts),
        pauseVersion: observedPause(opts),
        ownershipVersion: observedOwner(opts),
        acceptanceOwner: opts.acceptanceOwner,
        assignee: opts.assignee,
        reason: opts.reason,
        confirmed: command.optsWithGlobals().confirm === true,
      })),
    );
  requestObservation(reason(controls("request-disposition", "record an accountable cancellation or agreed transfer")))
    .requiredOption("--disposition <kind>", "cancel or transfer")
    .option("--follow-up <project>", "current Project accountable for the agreed follow-up")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        ...identity(exchangeId, opts),
        kind: "request-disposition",
        requestId: opts.request,
        ownershipVersion: observedOwner(opts),
        disposition: opts.disposition,
        followUp: opts.followUp,
        reason: opts.reason,
      })),
    );
  stateObservation(
    rosterObservation(reason(controls("stop", "pause by explicit user direction and revoke claims"))),
  ).action((exchangeId, opts, command) =>
    run(command, () => ({
      ...identity(exchangeId, opts),
      kind: "stop",
      rosterVersion: observedRoster(opts),
      pauseVersion: observedPause(opts),
      reason: opts.reason,
      confirmed: command.optsWithGlobals().confirm === true,
    })),
  );
  reason(controls("pause", "request an explicit user decision and revoke claims"))
    .requiredOption("--question <text>", "specific user decision needed")
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        ...identity(exchangeId, opts),
        kind: "pause",
        reason: opts.reason,
        question: opts.question,
      })),
    );
  rosterObservation(controls("propose", "propose an exact retained completion summary"))
    .requiredOption("--work-revision <n>", "observed substantive work revision")
    .requiredOption("--summary <text>", "exact retained candidate summary")
    .option("--criterion <text>", "exact Exchange criterion", append, [])
    .option("--report <request-id:version>", "name the observed report", append, [])
    .option("--disposition <request-id:version>", "name the observed disposition", append, [])
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        ...identity(exchangeId, opts),
        kind: "propose",
        rosterVersion: observedRoster(opts),
        workRevision: unsigned(opts.workRevision, "Work revision"),
        summary: opts.summary,
        criterion: opts.criterion,
        report: accept(opts.report, "report"),
        disposition: accept(opts.disposition, "disposition").map(({ requestId, reportVersion }) => ({
          requestId,
          version: reportVersion,
        })),
      })),
    );
  controls("vote", "approve or object to the exact current proposal")
    .requiredOption("--proposal-version <n>", "observed proposal version")
    .requiredOption("--vote <kind>", "approve or object")
    .option("--objection <text>", "bounded reason for objecting")
    .option("--accept <request-id:version>", "explicitly accept a covered checked report", append, [])
    .action((exchangeId, opts, command) =>
      run(command, () => ({
        ...identity(exchangeId, opts),
        kind: "vote",
        proposalVersion: unsigned(opts.proposalVersion, "Proposal version"),
        vote: opts.vote,
        objection: opts.objection,
        accept: accept(opts.accept),
      })),
    );
  controls("material-revalidate", "revalidate a restored original as its supplying Project")
    .argument("<material-id>")
    .requiredOption("--source <path>", "confined original in the supplying Project workspace")
    .action((exchangeId, materialId, opts, command) =>
      run(command, () => ({
        ...identity(exchangeId, opts),
        kind: "material-revalidate",
        materialId,
        source: opts.source,
      })),
    );
  exchange
    .command("cleanup")
    .description("settle exact Exchange retirement and proven abandoned preparations")
    .argument("<exchange-id>")
    .action((exchangeId, _opts, command) => run(command, () => ({ kind: "cleanup", exchangeId })));

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
