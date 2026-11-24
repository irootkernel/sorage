import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
  createNodeHandoffReadPorts,
  createNodeRetentionPorts,
  createNodeReviewPorts,
  createNodeRevisionPorts,
  createNodeSendPorts,
  createNodeTerminalPorts,
  openNodeHandoffDatabase,
} from "@sorage/adapters/src/handoff-command-ports";
import { inspectSourceFile } from "@sorage/adapters/src/import-source";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import { expandTilde } from "@sorage/adapters/src/workspace-confinement";
import {
  acceptHandoff,
  appError,
  approveDeletion,
  archiveHandoff,
  completeProcessing,
  declineHandoff,
  pinHandoff,
  readRecipientComment,
  readReviewNote,
  rejectDeletion,
  removeReviewNote,
  requestDeletion,
  reviseHandoff,
  sendHandoffs,
  setRecipientComment,
  setReviewNote,
  startProcessing,
  successEnvelope,
  unarchiveHandoff,
  unpinHandoff,
  withdrawHandoff,
  withdrawReviewNote,
} from "@sorage/core";
import type { Command } from "commander";
import {
  actorInputOf,
  collectRepeatable,
  expectedRowVersionOf,
  type OutputPorts,
  parseInteger,
  type ReportExitCode,
  refreshMarker,
  refreshMarkers,
  renderAppError,
  reportingSummary,
  requestId,
  requireInitialized,
  requireInitializedConfiguration,
  withPorts,
} from "../cli-output";
import { withCoveredRead } from "../covered-read";
import { createDisclosureBuffer } from "../disclosure-buffer";
import { runSendRecoveryCommand } from "../send-recovery-command";
import {
  ACCEPT_REQUIRES_ROW_VERSION,
  BODY_MUST_NOT_BE_EMPTY,
  DECLINE_REQUIRES_ROW_VERSION,
  REVIEW_SET_ONE_SOURCE,
  REVISE_ONE_SOURCE,
  SEND_REPLAY_ONLY_KEY,
  SEND_TAKES_ONE_SOURCE,
} from "../usage-sentences";

function readNoteFile(path: string): string | null {
  try {
    const resolved = expandTilde(path);
    if (!statSync(resolved).isFile()) return null;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(resolved));
  } catch {
    return null;
  }
}

export function registerHandoffSendCommand(program: Command, ports: OutputPorts, reportExitCode: ReportExitCode): void {
  program
    .command("send")
    .description("hand one current document to one or more recipient Projects, one Handoff each")
    .requiredOption("--to <project>", "recipient Project slug; repeat for a fan-out", collectRepeatable, [])
    .requiredOption("--title <title>", "the Handoff title, in any script")
    .option("--file <path>", "the document to hand over, with ~ expansion")
    .option("--body <text>", "inline Markdown text materialized as the document")
    .option("--supersedes <handoff-id>", "link this Handoff to a terminal predecessor")
    .option("--allow-external-source", "import a source outside the resolved sender workspace")
    .option("--allow-unregistered", "send as an unregistered Workspace despite the downgrade guard")
    .option(
      "--idempotency-key <key>",
      "original receipt key, including retained legacy keys; ordinary send may execute on a miss",
    )
    .option("--replay-only", "inspect the original send receipt without executing; requires the original key and input")
    .addHelpText(
      "after",
      "\nFor an unknown result, retain the original key, exact input/source bytes, Installation and sender context. Use only --replay-only with that material. A missing receipt leaves the outcome unknown; historical success does not establish current delivery or Artifact activation.\n",
    )
    .action((options, command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (options.replayOnly === true) {
        let usage: string | undefined;
        if (typeof options.idempotencyKey !== "string" || options.idempotencyKey.trim() === "")
          usage = SEND_REPLAY_ONLY_KEY;
        else if ((options.file === undefined) === (options.body === undefined)) usage = SEND_TAKES_ONE_SOURCE;
        else if (options.body !== undefined && options.body.trim() === "") usage = "the --body text must not be empty";
        if (usage !== undefined) {
          ports.err(`sorage: ${usage}\nRun 'sorage --help' for usage.\n`);
          reportExitCode(2);
          return;
        }
        reportExitCode(
          runSendRecoveryCommand({
            ports,
            json,
            requestId: requestId(),
            input: {
              to: options.to as string[],
              title: options.title,
              file: options.file,
              body: options.body,
              supersedes: options.supersedes,
              allowExternalSource: options.allowExternalSource === true,
              allowUnregistered: options.allowUnregistered === true,
              idempotencyKey: options.idempotencyKey,
              path: process.cwd(),
              userHome: homedir(),
              as: typeof globals.as === "string" ? globals.as : undefined,
              asUser: globals.asUser === true,
            },
          }),
        );
        return;
      }
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      if ((options.file === undefined) === (options.body === undefined)) {
        ports.err(`sorage: ${SEND_TAKES_ONE_SOURCE}\n`);
        ports.err("Run 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      if (options.body !== undefined && options.body.trim() === "") {
        ports.err(`sorage: ${BODY_MUST_NOT_BE_EMPTY}\n`);
        ports.err("Run 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      // Reuse one command-scoped operational database and configuration across
      // startup drain, Handoff send, and enabled marker refresh (ADR-0036).
      const opened = openNodeHandoffDatabase();
      if (!opened.ok) {
        reportExitCode(renderAppError(opened.error, ports, json));
        return;
      }
      const db = opened.value;
      try {
        // RUN-002: an intent-recording command drains at start before it creates anything.
        const vaultPorts = createNodeVaultCommandPorts({
          contentionSurface: "handoff",
          database: db,
          configuration,
        });
        const drained = vaultPorts.drainAtStart();
        if (!drained.ok) {
          reportExitCode(renderAppError(drained.error, ports, json));
          return;
        }
        // Post-commit completion warnings buffer here and flush to stderr after
        // the committed result (SHR-015 category (i)).
        const sendCompletionWarnings: string[] = [];
        const sendPorts = createNodeSendPorts({
          database: db,
          configuration,
          completionWarning: (text) => sendCompletionWarnings.push(text),
        });
        const disclosureBuffer = createDisclosureBuffer();
        if (sendPorts.disclosures !== undefined) {
          sendPorts.disclosures = disclosureBuffer.wrap(sendPorts.disclosures);
        }
        let result: ReturnType<typeof sendHandoffs>;
        try {
          result = sendHandoffs(sendPorts, {
            to: options.to as string[],
            title: options.title,
            file: options.file,
            body: options.body,
            supersedes: options.supersedes,
            allowExternalSource: options.allowExternalSource === true,
            allowUnregistered: options.allowUnregistered === true,
            idempotencyKey: options.idempotencyKey,
            path: process.cwd(),
            userHome: homedir(),
            as: typeof globals.as === "string" ? globals.as : undefined,
            asUser: globals.asUser === true,
          });
        } finally {
          sendPorts.close();
        }
        if (!result.ok) {
          const error = disclosureBuffer.applyOnFailure(result.error, json, ports.err);
          reportExitCode(renderAppError(error, ports, json));
          return;
        }
        disclosureBuffer.flushOnSuccess(ports.err);
        // The committed outcome precedes every post-commit diagnostic: the
        // completion warnings flush to stderr after the result, contained.
        for (const text of sendCompletionWarnings) {
          try {
            ports.err(`warning: ${text}\n`);
          } catch {
            // A diagnostic flush failure never changes a committed outcome.
          }
        }
        refreshMarkers(
          result.value.handoffs.map((handoff) => handoff.handoffId),
          ports,
          { database: db, configuration },
        );
        if (json) {
          ports.out(
            `${JSON.stringify(successEnvelope({ handoffs: result.value.handoffs, dispatchGroupId: result.value.dispatchGroupId, replayed: result.value.replayed }, requestId()), null, 2)}
`,
          );
        } else {
          for (const handoff of result.value.handoffs) {
            ports.out(`Handoff ${handoff.handoffId} → ${handoff.recipientSlug} (revision 1, awaiting_recipient)
`);
          }
          if (result.value.dispatchGroupId !== null) {
            ports.out(`Dispatch group ${result.value.dispatchGroupId} (${result.value.handoffs.length} Handoffs)
`);
          }
          if (result.value.replayed) {
            ports.out("Replayed the recorded idempotent send\n");
          }
        }
      } finally {
        db.close();
      }
    });
}

export function registerHandoffMutationCommands(
  program: Command,
  ports: OutputPorts,
  reportExitCode: ReportExitCode,
): void {
  const comment = program.command("comment").description("read and replace the retained recipient comment");
  comment
    .command("show <handoff-id>")
    .description("read the retained recipient comment; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = readRecipientComment(
          createNodeHandoffReadPorts({ database: storage.db }),
          actorInputOf(globals),
          id,
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        else if (result.value === null) ports.out("no recipient comment\n");
        else
          ports.out(
            `${result.value.body}\n  purpose ${result.value.purpose}, active ${result.value.active}, targetRevision ${result.value.targetRevision}, author ${result.value.authorKind}\n`,
          );
      });
    });
  comment
    .command("set <handoff-id>")
    .description("replace the recipient comment using the observed document and Row Version")
    .option("--text <text>", "the comment text inline")
    .option("--file <path>", "read UTF-8 comment text from a regular file")
    .option("--purpose <purpose>", "general or change_request", "general")
    .requiredOption("--expected-revision <n>", "the observed document Revision", parseInteger)
    .action(
      (
        id: string,
        options: { text?: string; file?: string; purpose: string; expectedRevision: number },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        if (
          typeof globals.expectedRowVersion !== "number" ||
          (options.text === undefined) === (options.file === undefined)
        ) {
          ports.err("sorage: comment set requires one --text/--file source and --expected-row-version\n");
          reportExitCode(2);
          return;
        }
        const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
        if (configuration === null) return;
        const text = options.text ?? readNoteFile(options.file as string);
        if (text === null) {
          reportExitCode(
            renderAppError(
              appError("HANDOFF_INVALID_INPUT", "the comment source must be a readable regular UTF-8 file"),
              ports,
              json,
            ),
          );
          return;
        }
        const result = withPorts(createNodeReviewPorts({ configuration }), (reviewPorts) =>
          setRecipientComment(reviewPorts, {
            ...actorInputOf(globals),
            handoffId: id,
            text,
            purpose: options.purpose as "general" | "change_request",
            expectedRevision: options.expectedRevision,
            expectedRowVersion: globals.expectedRowVersion,
          }),
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        refreshMarker(id, ports, { configuration });
        if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        else ports.out(`Comment set on ${id}; ${reportingSummary(result.value.handoff)}\n`);
      },
    );
  const processing = program.command("processing").description("report work independently of document acceptance");
  for (const [name, mutate] of [
    ["start", startProcessing],
    ["complete", completeProcessing],
  ] as const) {
    processing
      .command(`${name} <handoff-id>`)
      .description(`${name} processing with an optional general comment`)
      .requiredOption("--expected-revision <n>", "the observed document Revision", parseInteger)
      .option("--comment-text <text>", "replace the general comment inline")
      .option("--comment-file <path>", "replace the general comment from a regular UTF-8 file")
      .action(
        (
          id: string,
          options: { expectedRevision: number; commentText?: string; commentFile?: string },
          command: Command,
        ) => {
          const globals = command.optsWithGlobals();
          const json = globals.json === true;
          if (
            typeof globals.expectedRowVersion !== "number" ||
            (options.commentText !== undefined && options.commentFile !== undefined)
          ) {
            ports.err("sorage: processing requires --expected-row-version and at most one comment source\n");
            reportExitCode(2);
            return;
          }
          const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
          if (configuration === null) return;
          const text =
            options.commentText ?? (options.commentFile === undefined ? undefined : readNoteFile(options.commentFile));
          if (text === null) {
            reportExitCode(
              renderAppError(
                appError("HANDOFF_INVALID_INPUT", "the comment source must be a readable regular UTF-8 file"),
                ports,
                json,
              ),
            );
            return;
          }
          const result = withPorts(createNodeReviewPorts({ configuration }), (reviewPorts) =>
            mutate(reviewPorts, {
              ...actorInputOf(globals),
              handoffId: id,
              expectedRevision: options.expectedRevision,
              expectedRowVersion: globals.expectedRowVersion,
              comment: text,
            }),
          );
          if (!result.ok) {
            reportExitCode(renderAppError(result.error, ports, json));
            return;
          }
          refreshMarker(id, ports, { configuration });
          if (json) ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
          else ports.out(`Processing ${name} on ${id}; ${reportingSummary(result.value.handoff)}\n`);
        },
      );
  }

  const review = program.command("review").description("read, create, withdraw, and remove Review Notes");

  review
    .command("show <handoff-id>")
    .description("read the current Review Note; records nothing")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (!requireInitialized(ports, json, reportExitCode, true, { log: false })) return;
      withCoveredRead(ports, json, reportExitCode, "handoff", (storage) => {
        const result = readReviewNote(createNodeHandoffReadPorts({ database: storage.db }), actorInputOf(globals), id);
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json, undefined, { log: false }));
          return;
        }
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
        } else if (result.value === null) {
          ports.out("no Review Note\n");
        } else {
          ports.out(`${result.value.body}\n`);
          ports.out(`  targetRevision ${result.value.targetRevision}, author ${result.value.authorKind}\n`);
        }
      });
    });

  review
    .command("set <handoff-id>")
    .description("create or update this Handoff's Review Note as the recipient or the User")
    .option("--text <text>", "the note text inline")
    .option("--file <path>", "read the note text from a file, with ~ expansion")
    .requiredOption("--target-revision <n>", "the observed Revision the note targets", parseInteger)
    .action((id: string, options: { text?: string; file?: string; targetRevision?: number }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: this command requires --expected-row-version\nRun 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      if ((options.text === undefined) === (options.file === undefined)) {
        ports.err(`sorage: ${REVIEW_SET_ONE_SOURCE}\n`);
        ports.err("Run 'sorage --help' for usage." + "\n");
        reportExitCode(2);
        return;
      }
      const text = options.text !== undefined ? options.text : readNoteFile(options.file as string);
      if (text === null) {
        reportExitCode(
          renderAppError(appError("CONFIG_INVALID", `the note file '${options.file}' could not be read`), ports, json),
        );
        return;
      }
      const result = withPorts(createNodeReviewPorts({ configuration }), (reviewPorts) =>
        setReviewNote(reviewPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          text,
          targetRevision: options.targetRevision,
          expectedRowVersion: expectedRowVersionOf(globals),
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Review Note set on ${id}; state ${result.value.handoff.reviewState}, rowVersion ${result.value.handoff.rowVersion}
`);
      }
    });

  review
    .command("withdraw <handoff-id>")
    .description("withdraw this Handoff's current Review Note as the recipient, whichever actor authored it")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: this command requires --expected-row-version\nRun 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(createNodeReviewPorts({ configuration }), (reviewPorts) =>
        withdrawReviewNote(reviewPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          expectedRowVersion: expectedRowVersionOf(globals),
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Review Note withdrawn from ${id}; state ${result.value.handoff.reviewState}
`);
      }
    });

  review
    .command("remove <handoff-id>")
    .description("remove this Handoff's Review Note administratively; a User-admin operation")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err("sorage: this command requires --expected-row-version\nRun 'sorage --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            { code: "USER_CONTEXT_REQUIRED", message: "review remove is a User administration operation." },
            ports,
            json,
          ),
        );
        return;
      }
      const result = withPorts(createNodeReviewPorts({ configuration }), (reviewPorts) =>
        removeReviewNote(reviewPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          confirm: globals.confirm === true,
          expectedRowVersion: expectedRowVersionOf(globals),
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Review Note removed from ${id}; state ${result.value.handoff.reviewState}
`);
      }
    });

  program
    .command("revise <handoff-id>")
    .description(
      "replace the current Artifact or resolve the Review Note; expectedRowVersion is required for fresh mutation and optional only for successful recorded replay",
    )
    .option("--body <text>", "inline Markdown text materialized as the replacement document")
    .option("--file <path>", "the replacement document, with ~ expansion")
    .option("--no-change", "resolve the Review Note without changing content")
    .option("--reason <text>", "the reason a no-change resolution carries")
    .option("--idempotency-key <uuid>", "replay an identical revise instead of applying it again")
    .option("--allow-external-source", "revise from a source outside the resolved sender workspace")
    .action(
      (
        id: string,
        options: {
          body?: string;
          file?: string;
          noChange?: boolean;
          reason?: string;
          idempotencyKey?: string;
          allowExternalSource?: boolean;
        },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
        if (configuration === null) return;
        // Commander parses --no-change as the negation of a defaulted `change` flag.
        const noChange = (options as { change?: boolean }).change === false;
        const suppliedSources = [options.body !== undefined, options.file !== undefined, noChange].filter(
          Boolean,
        ).length;
        if (suppliedSources !== 1) {
          ports.err(`sorage: ${REVISE_ONE_SOURCE}\n`);
          ports.err("Run 'sorage --help' for usage.\n");
          reportExitCode(2);
          return;
        }
        if (options.body !== undefined && options.body.trim() === "") {
          ports.err(`sorage: ${BODY_MUST_NOT_BE_EMPTY}\n`);
          ports.err("Run 'sorage --help' for usage.\n");
          reportExitCode(2);
          return;
        }
        // Reuse one command-scoped operational database and configuration across
        // startup drain, revision, and enabled marker refresh (ADR-0036).
        const opened = openNodeHandoffDatabase();
        if (!opened.ok) {
          reportExitCode(renderAppError(opened.error, ports, json));
          return;
        }
        const db = opened.value;
        try {
          // RUN-002: an intent-recording command drains at start before it revises.
          const vaultPorts = createNodeVaultCommandPorts({
            contentionSurface: "handoff",
            database: db,
            configuration,
          });
          const drained = vaultPorts.drainAtStart();
          if (!drained.ok) {
            reportExitCode(renderAppError(drained.error, ports, json));
            return;
          }
          let resolvedSourcePath: string | undefined;
          let originalName: string | undefined;
          if (options.file !== undefined) {
            const expanded = expandTilde(options.file);
            const inspected = inspectSourceFile(expanded);
            if (!inspected.ok) {
              reportExitCode(renderAppError(inspected.error, ports, json));
              return;
            }
            resolvedSourcePath = inspected.value.resolvedPath;
            originalName = basename(expanded);
          }
          // Post-commit completion warnings buffer here and flush to stderr after
          // the committed result (SHR-015 category (i)).
          const reviseCompletionWarnings: string[] = [];
          const revisionPorts = createNodeRevisionPorts({
            database: db,
            configuration,
            completionWarning: (text) => reviseCompletionWarnings.push(text),
          });
          const disclosureBuffer = createDisclosureBuffer();
          if (revisionPorts.disclosures !== undefined) {
            revisionPorts.disclosures = disclosureBuffer.wrap(revisionPorts.disclosures);
          }
          let result: ReturnType<typeof reviseHandoff>;
          try {
            result = reviseHandoff(revisionPorts, {
              ...actorInputOf(globals),
              handoffId: id,
              body: options.body,
              file: options.file,
              noChange,
              reason: options.reason,
              idempotencyKey: options.idempotencyKey,
              resolvedSourcePath,
              originalName,
              allowExternalSource: options.allowExternalSource === true,
              expectedRowVersion: expectedRowVersionOf(globals),
            });
          } finally {
            revisionPorts.close();
          }
          if (!result.ok) {
            const error = disclosureBuffer.applyOnFailure(result.error, json, ports.err);
            reportExitCode(renderAppError(error, ports, json));
            return;
          }
          disclosureBuffer.flushOnSuccess(ports.err);
          for (const text of reviseCompletionWarnings) {
            try {
              ports.err(`warning: ${text}\n`);
            } catch {
              // A diagnostic flush failure never changes a committed outcome.
            }
          }
          refreshMarker(id, ports, { database: db, configuration });
          if (json) {
            ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
          } else {
            ports.out(`Revised ${id}; revision ${result.value.revision}, state ${result.value.reviewState}
`);
          }
        } finally {
          db.close();
        }
      },
    );

  program
    .command("accept <handoff-id>")
    .description("accept the exact Revision as the recipient, closing the exchange")
    .requiredOption("--expected-revision <n>", "the Revision being accepted", parseInteger)
    .action((id: string, options: { expectedRevision: number }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      // --expected-row-version is a root-level global, so its requiredness is
      // enforced here rather than by a subcommand-local requiredOption (CLI-013).
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err(`sorage: ${ACCEPT_REQUIRES_ROW_VERSION}\n`);
        ports.err("Run 'sorage accept --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const result = withPorts(createNodeTerminalPorts({ configuration }), (terminalPorts) =>
        acceptHandoff(terminalPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          expectedRevision: options.expectedRevision,
          expectedRowVersion: globals.expectedRowVersion,
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Accepted ${id} at revision ${result.value.acceptedRevision}
`);
      }
    });

  program
    .command("decline <handoff-id>")
    .description("decline the Handoff as the recipient with a recorded reason")
    .requiredOption("--reason <text>", "the recorded decline reason")
    .action((id: string, options: { reason: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      if (typeof globals.expectedRowVersion !== "number") {
        ports.err(`sorage: ${DECLINE_REQUIRES_ROW_VERSION}\n`);
        ports.err("Run 'sorage decline --help' for usage.\n");
        reportExitCode(2);
        return;
      }
      const result = withPorts(createNodeTerminalPorts({ configuration }), (terminalPorts) =>
        declineHandoff(terminalPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          reason: options.reason,
          expectedRowVersion: globals.expectedRowVersion,
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Declined ${id}: ${options.reason}
`);
      }
    });

  program
    .command("withdraw <handoff-id>")
    .description("withdraw the Handoff as the sender before the recipient has engaged")
    .action((id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(createNodeTerminalPorts({ configuration }), (terminalPorts) =>
        withdrawHandoff(terminalPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          expectedRowVersion: expectedRowVersionOf(globals),
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}
`);
      } else {
        ports.out(`Withdrew ${id}
`);
      }
    });

  for (const [name, description, run] of [
    ["pin", "pin the Handoff against deletion; a User-admin operation", pinHandoff],
    ["unpin", "release a pinned Handoff; a User-admin operation", unpinHandoff],
  ] as const) {
    program
      .command(`${name} <handoff-id>`)
      .description(description)
      .action((id: string, _options: unknown, command: Command) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
        if (configuration === null) return;
        if (globals.asUser !== true) {
          reportExitCode(
            renderAppError(
              { code: "USER_CONTEXT_REQUIRED", message: `Handoff ${name} is a User administration operation.` },
              ports,
              json,
            ),
          );
          return;
        }
        const result = withPorts(createNodeRetentionPorts({ configuration }), (retentionPorts) =>
          run(retentionPorts, {
            ...actorInputOf(globals),
            handoffId: id,
            expectedRowVersion: expectedRowVersionOf(globals),
          }),
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        refreshMarker(id, ports, { configuration });
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        } else {
          ports.out(`${name === "pin" ? "Pinned" : "Unpinned"} ${id}\n`);
        }
      });
  }

  for (const [name, description, run] of [
    ["archive", "archive a terminal Handoff out of the default listings; a User-admin operation", archiveHandoff],
    ["unarchive", "return an archived Handoff to the default listings; a User-admin operation", unarchiveHandoff],
  ] as const) {
    program
      .command(`${name} <handoff-id>`)
      .description(description)
      .action((id: string, _options: unknown, command: Command) => {
        const globals = command.optsWithGlobals();
        const json = globals.json === true;
        const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
        if (configuration === null) return;
        if (globals.asUser !== true) {
          reportExitCode(
            renderAppError(
              { code: "USER_CONTEXT_REQUIRED", message: `Handoff ${name} is a User administration operation.` },
              ports,
              json,
            ),
          );
          return;
        }
        const result = withPorts(createNodeRetentionPorts({ configuration }), (retentionPorts) =>
          run(retentionPorts, {
            ...actorInputOf(globals),
            handoffId: id,
            expectedRowVersion: expectedRowVersionOf(globals),
          }),
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        refreshMarker(id, ports, { configuration });
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        } else {
          ports.out(`${name === "archive" ? "Archived" : "Unarchived"} ${id}\n`);
        }
      });
  }

  const remove = program.command("delete").description("request and decide Handoff deletion");

  remove
    .command("request <handoff-id>")
    .description("ask the User to delete this Handoff in any non-deleted state")
    .option("--reason <text>", "why the deletion is requested")
    .action((id: string, options: { reason?: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      const result = withPorts(createNodeRetentionPorts({ configuration }), (retentionPorts) =>
        requestDeletion(retentionPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          reason: options.reason,
          expectedRowVersion: expectedRowVersionOf(globals),
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Deletion requested for ${id}\n`);
      }
    });

  remove
    .command("approve <handoff-id>")
    .description("approve a pending deletion as the User; the tombstone keeps no content")
    .option("--confirm-pinned <handoff-id>", "the distinct confirmation a pinned Handoff requires")
    .option("--idempotency-key <uuid>", "replay an identical approval instead of applying it again")
    .action((id: string, options: { confirmPinned?: string; idempotencyKey?: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            { code: "USER_CONTEXT_REQUIRED", message: "Deletion approval is a User administration operation." },
            ports,
            json,
          ),
        );
        return;
      }
      const opened = openNodeHandoffDatabase();
      if (!opened.ok) {
        reportExitCode(renderAppError(opened.error, ports, json));
        return;
      }
      const db = opened.value;
      try {
        // RUN-002: an intent-recording command drains at start before it approves anything.
        const vaultPorts = createNodeVaultCommandPorts({
          contentionSurface: "handoff",
          database: db,
          configuration,
        });
        const drained = vaultPorts.drainAtStart();
        if (!drained.ok) {
          reportExitCode(renderAppError(drained.error, ports, json));
          return;
        }
        // Post-commit completion warnings buffer here and flush to stderr after
        // the committed result (SHR-015 category (i)).
        const approveCompletionWarnings: string[] = [];
        const result = withPorts(
          createNodeRetentionPorts({
            database: db,
            configuration,
            completionWarning: (text) => approveCompletionWarnings.push(text),
          }),
          (retentionPorts) =>
            approveDeletion(retentionPorts, {
              ...actorInputOf(globals),
              handoffId: id,
              confirm: globals.confirm === true,
              confirmPinned: options.confirmPinned,
              idempotencyKey: options.idempotencyKey,
              expectedRowVersion: expectedRowVersionOf(globals),
            }),
        );
        if (!result.ok) {
          reportExitCode(renderAppError(result.error, ports, json));
          return;
        }
        for (const text of approveCompletionWarnings) {
          try {
            ports.err(`warning: ${text}\n`);
          } catch {
            // A diagnostic flush failure never changes a committed outcome.
          }
        }
        refreshMarker(id, ports, { database: db, configuration });
        if (json) {
          ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
        } else {
          ports.out(`Deleted ${id}; prior Git commits may retain earlier content\n`);
          if (result.value.replayed === true) {
            ports.out("Replayed the recorded deletion approval\n");
          }
        }
      } finally {
        db.close();
      }
    });

  remove
    .command("reject <handoff-id>")
    .description("reject a pending deletion as the User; the Handoff is retained")
    .option("--reason <text>", "why the deletion was rejected")
    .action((id: string, options: { reason?: string }, command: Command) => {
      const globals = command.optsWithGlobals();
      const json = globals.json === true;
      const configuration = requireInitializedConfiguration(ports, json, reportExitCode, true);
      if (configuration === null) return;
      if (globals.asUser !== true) {
        reportExitCode(
          renderAppError(
            { code: "USER_CONTEXT_REQUIRED", message: "Deletion rejection is a User administration operation." },
            ports,
            json,
          ),
        );
        return;
      }
      const result = withPorts(createNodeRetentionPorts({ configuration }), (retentionPorts) =>
        rejectDeletion(retentionPorts, {
          ...actorInputOf(globals),
          handoffId: id,
          reason: options.reason,
          expectedRowVersion: expectedRowVersionOf(globals),
        }),
      );
      if (!result.ok) {
        reportExitCode(renderAppError(result.error, ports, json));
        return;
      }
      refreshMarker(id, ports, { configuration });
      if (json) {
        ports.out(`${JSON.stringify(successEnvelope(result.value, requestId()), null, 2)}\n`);
      } else {
        ports.out(`Deletion rejected for ${id}\n`);
      }
    });
}
