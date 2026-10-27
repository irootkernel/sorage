import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createNodeMemoPorts,
  memoStorageError,
  memoStartupError,
  sweepMemoAcceptedInputs,
  type NodeMemoPorts,
} from "@sorage/adapters/src/memo-command-ports";
import { appCommandErrorOf } from "@sorage/adapters/src/daemon-command-ports";
import { type CoveredReadStorage, openCoveredReadStorage } from "@sorage/adapters/src/read-storage";
import { captureMemoBodyFile, captureMemoBodyText } from "@sorage/adapters/src/memo-body-file";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  addMemo,
  appError,
  err,
  largeContentDisclosureMessage,
  listMemos,
  mutateMemo,
  ok,
  parseMemoExecution,
  resolveMemoProject,
  showMemo,
  successEnvelope,
  type AcceptedMemoBody,
  type AppError,
  type Memo,
  type MemoPage,
  type MemoReceipt,
  type Result,
} from "@sorage/core";
import { Option, Command } from "commander";

type Operation = "add" | "list" | "show" | "update" | "done" | "dismiss" | "reopen";
/** Whether a failure rendering also records the failure in the installation log. */
export interface MemoRenderOptions {
  /** `false` for the covered zero-write reads of RDR-001, which never create the log. */
  log?: boolean;
}

interface MemoCliOutput {
  out(text: string): void;
  fail(error: AppError, json: boolean, options?: MemoRenderOptions): void;
  requestId(): string;
  /** The diagnostic sink for the large-content Git-history disclosure: stderr, never stdout, never the JSON DTO (WR2). */
  warn(text: string): void;
  /**
   * The existing pre-initialization gate (INIT-011, INIT-012), which the
   * covered reads enter through and render without a log write (RDR-001).
   */
  requireInitialized(json: boolean): boolean;
}

/** Captures the selected body source once: small text stays in the request, larger accepted input reaches the application as its private spool. */
function bodyInput(
  options: Record<string, unknown>,
  ports: NodeMemoPorts,
): Result<{ fields: { body?: string }; accepted?: AcceptedMemoBody }> {
  const captureOptions = { maxBytes: ports.maxBytes, stateDir: ports.stateDir, spoolId: randomUUID() };
  if (typeof options.bodyFile === "string") {
    const captured = captureMemoBodyFile(options.bodyFile, captureOptions);
    if (!captured.ok) return captured;
    return captured.value.kind === "text"
      ? ok({ fields: { body: captured.value.text } })
      : ok({ fields: {}, accepted: captured.value });
  }
  if (options.body !== undefined) {
    const captured = captureMemoBodyText(String(options.body), captureOptions);
    if (!captured.ok) return captured;
    return captured.value.kind === "text"
      ? ok({ fields: { body: captured.value.text } })
      : ok({ fields: {}, accepted: captured.value });
  }
  return ok({ fields: {} });
}

export function registerMemoCommands(program: Command, output: MemoCliOutput): void {
  const memo = program.command("memo").description("record and manage Project reminders separately from Handoffs");
  const descriptions: Record<Operation, string> = {
    add: "record an open Memo",
    list: "list Project Memos, open by default",
    show: "show one complete Memo",
    update: "edit an open Memo at its observed Row Version",
    done: "mark a Memo handled",
    dismiss: "dismiss a Memo without claiming work was done",
    reopen: "reopen a closed Memo without executing its content",
  };
  for (const operation of Object.keys(descriptions) as Operation[]) {
    const command = memo
      .command(operation)
      .description(descriptions[operation])
      .option("--project <slug>", "select a Project, or assert the existing Memo's Project");
    const mutation = operation !== "list" && operation !== "show";
    if (operation !== "add" && operation !== "list") command.argument("<id>", "Memo UUID");
    if (operation === "add" || operation === "update")
      command
        .option("--title <text>", "single-line Memo title")
        .option("--body <text>", "exact Memo body text, including an empty body")
        .option("--body-file <path>", "import one bounded regular UTF-8 file");
    if (operation === "list")
      command
        .option("--all-projects", "explicitly list Memos in every registered Project")
        .option("--state <state>", "open, done, dismissed, or all")
        .option("--query <text>", "case-sensitive literal title/body search");
    if (mutation)
      command
        .option("--idempotency-key <uuid>", "original UUID key for a retriable mutation")
        .option("--replay-only", "inspect the original receipt without executing on a miss");
    if (!mutation) command.addOption(new Option("--replay-only").hideHelp());
    if (operation === "add" || operation === "list")
      command.action((options, current) => run(operation, undefined, options, current));
    else command.action((id, options, current) => run(operation, id, options, current));
  }

  function run(operation: Operation, id: string | undefined, options: Record<string, unknown>, command: Command) {
    const globals = command.optsWithGlobals();
    const json = globals.json === true;
    const mutation = operation !== "list" && operation !== "show";
    // A covered read renders every failure, usage errors included, without the log (RDR-001).
    const render: MemoRenderOptions | undefined = mutation ? undefined : { log: false };
    const invalid = (message: string) => output.fail(appError("MEMO_INVALID_INPUT", message), json, render);
    if (options.body !== undefined && options.bodyFile !== undefined)
      return invalid("Choose one Memo body source: --body or --body-file");
    if (globals.as !== undefined || globals.confirm !== undefined)
      return invalid("Memo commands do not accept --as or --confirm; provenance is always User");
    if (operation !== "list" && (globals.limit !== undefined || globals.cursor !== undefined))
      return invalid("Memo pagination options apply only to list");
    if ((operation === "add" || !mutation) && globals.expectedRowVersion !== undefined)
      return invalid("Expected Row Version applies only to existing-Memo mutations");
    if (operation === "list" && options.allProjects === true && options.project !== undefined)
      return invalid("Select --project or --all-projects, not both");
    const execution = parseMemoExecution(
      options.replayOnly === true ? ["replay-only"] : [],
      options.idempotencyKey,
      mutation,
    );
    if (!execution.ok) return output.fail(execution.error, json, render);
    if (operation === "add" && options.title === undefined) return invalid("Memo add requires --title");
    if (mutation && operation !== "add" && globals.expectedRowVersion === undefined)
      return invalid("Memo mutations require --expected-row-version from the observed Memo");
    if (!mutation) return runCoveredRead(operation, id, options, globals, json);
    // Existing native recovery remains separate from the Memo operation's own effects.
    let ports: NodeMemoPorts;
    try {
      const drained = createNodeVaultCommandPorts().drainAtStart();
      if (!drained.ok) return output.fail(memoStartupError(drained.error), json);
      ports = createNodeMemoPorts();
    } catch (error) {
      return output.fail(memoStartupError(error), json);
    }
    let accepted: AcceptedMemoBody | undefined;
    // The per-invocation disclosure buffer of WR3: the core callback records
    // metadata only — never output at commit time — and the flush below owns
    // the presentation, so a post-commit failure still yields exactly one
    // error document on stderr with the disclosure inside the existing
    // message field, and a success keeps its stdout JSON and exit 0.
    const warnings: Array<{ sizeBytes: number; thresholdBytes: number }> = [];
    try {
      // The crash-orphan backstop runs at the command entry, before this
      // operation's own spool can exist, under the configured grace window.
      sweepMemoAcceptedInputs();
      if (ports.disclosures !== undefined) {
        const composed = ports.disclosures;
        ports = {
          ...ports,
          disclosures: {
            ...composed,
            largeContent: (sizeBytes: number, thresholdBytes: number) => {
              warnings.push({ sizeBytes, thresholdBytes });
            },
          },
        };
      }
      const body = bodyInput(options, ports);
      if (!body.ok) return output.fail(body.error, json);
      accepted = body.value.accepted;
      let projectId: string | undefined;
      if (options.project !== undefined || (operation === "add" && options.allProjects !== true)) {
        const selected = resolveMemoProject(
          ports.projectPorts,
          typeof options.project === "string" ? options.project : undefined,
          { path: process.cwd(), userHome: homedir() },
        );
        if (!selected.ok) return output.fail(selected.error, json);
        projectId = selected.value;
      }
      let result: Result<MemoReceipt | Memo>;
      if (operation === "add")
        result = addMemo(ports, { projectId, title: options.title, ...body.value.fields }, execution.value, accepted);
      else
        result = mutateMemo(
          ports,
          operation,
          id as string,
          {
            expectedRowVersion: globals.expectedRowVersion,
            ...(projectId === undefined ? {} : { projectId }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...body.value.fields,
          },
          execution.value,
          accepted,
        );
      if (!result.ok) {
        // WR3: a JSON failure keeps stdout empty and emits exactly one error
        // envelope; a buffered disclosure rides inside the existing message
        // field as a conditional append, preserving the base message prefix,
        // code, details, recovery, and exit. A non-JSON failure flushes the
        // warning lines to stderr before the human error. The formatter is
        // best-effort: if building the appended message itself fails, the
        // original error renders unchanged.
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
          return output.fail(error, json);
        }
        for (const warning of warnings) {
          try {
            output.warn(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
          } catch {
            // A diagnostic flush failure never masks the real error.
          }
        }
        return output.fail(result.error, json);
      }
      // Success: the disclosure is a stderr diagnostic; the stdout success
      // JSON, its shape, and exit 0 are unchanged.
      for (const warning of warnings) {
        try {
          output.warn(`${largeContentDisclosureMessage(warning.sizeBytes, warning.thresholdBytes)}.\n`);
        } catch {
          // A diagnostic flush failure never changes a committed outcome.
        }
      }
      if (json) output.out(`${JSON.stringify(successEnvelope(result.value, output.requestId()), null, 2)}\n`);
      else renderMemo(result.value, output.out);
    } finally {
      if (accepted !== undefined) ports.releaseAcceptedBody(accepted);
      ports.close();
    }
  }

  /**
   * The covered zero-write Memo reads (RDR-001 to RDR-004): the existing
   * pre-initialization gate, then read-only storage through the shared
   * primitive injected into the Memo composition. No startup drain, no
   * accepted-input sweep, no log write; every failure — returned or thrown —
   * renders log-free, and the connection closes when the read ends.
   */
  function runCoveredRead(
    operation: "list" | "show",
    id: string | undefined,
    options: Record<string, unknown>,
    globals: Record<string, unknown>,
    json: boolean,
  ) {
    const fail = (error: AppError) => output.fail(error, json, { log: false });
    if (!output.requireInitialized(json)) return;
    let storage: Result<CoveredReadStorage, AppError>;
    try {
      // The covered Memo reads keep their pre-Task Vault admission, read-only,
      // with the same refusal envelope the drain produced (RDR-005).
      storage = openCoveredReadStorage({ vaultAdmission: true });
    } catch (error) {
      storage = err(thrownMemoReadError(error));
    }
    if (!storage.ok) return fail(storage.error);
    let ports: NodeMemoPorts | undefined;
    try {
      ports = createNodeMemoPorts({ database: storage.value.db });
      const body = bodyInput(options, ports);
      if (!body.ok) return fail(body.error);
      let projectId: string | undefined;
      if (options.project !== undefined || (operation === "list" && options.allProjects !== true)) {
        const selected = resolveMemoProject(
          ports.projectPorts,
          typeof options.project === "string" ? options.project : undefined,
          { path: process.cwd(), userHome: homedir() },
        );
        if (!selected.ok) return fail(selected.error);
        projectId = selected.value;
      }
      const result: Result<MemoPage | Memo> =
        operation === "list"
          ? listMemos(ports, {
              ...(options.allProjects === true ? { allProjects: true } : { projectId }),
              ...(options.state === undefined ? {} : { state: options.state }),
              ...(options.query === undefined ? {} : { query: options.query }),
              ...(globals.limit === undefined ? {} : { limit: globals.limit }),
              ...(globals.cursor === undefined ? {} : { cursor: globals.cursor }),
            })
          : showMemo(ports, id as string, projectId);
      if (!result.ok) return fail(result.error);
      if (json) output.out(`${JSON.stringify(successEnvelope(result.value, output.requestId()), null, 2)}\n`);
      else renderMemo(result.value, output.out);
    } catch (error) {
      return fail(thrownMemoReadError(error));
    } finally {
      ports?.close();
      storage.value.close();
    }
  }
}

/** A throw escaping a covered Memo read keeps its carried typed code, else the existing unclassified mapping. */
function thrownMemoReadError(error: unknown): AppError {
  return appCommandErrorOf(error) ?? memoStorageError(error);
}

function renderMemo(value: MemoReceipt | MemoPage | Memo, out: (text: string) => void): void {
  if ("items" in value) {
    for (const item of value.items)
      out(`${item.id} [${item.state}] ${item.projectSlug}: ${item.title}\n${item.bodyPreview}\n`);
    if (value.nextCursor) out(`Next cursor: ${value.nextCursor}\n`);
    return;
  }
  const memo = "memo" in value ? value.memo : value;
  out(
    `${memo.id} [${memo.state}] ${memo.title}\nProject: ${memo.projectId}\nRow Version: ${memo.rowVersion}\n${memo.body}\n`,
  );
  if ("replayed" in value && value.replayed)
    out("Replayed the original recorded outcome; refetch before a new write.\n");
  else if ("changed" in value && !value.changed) out("No change.\n");
}

/** Identify the root command without interpreting numeric values or executing an action. */
export function memoNumericErrorContext(program: Command, argv: string[]): { json: boolean } | null {
  const probe = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const option of program.options) probe.addOption(new Option(option.flags));
  try {
    const parsed = probe.parseOptions(argv);
    return parsed.operands[0] === "memo" ? { json: probe.opts().json === true } : null;
  } catch {
    return null; // Missing option arguments remain ordinary usage errors.
  }
}
