import { homedir } from "node:os";
import { createNodeMemoPorts } from "@sorage/adapters/src/memo-command-ports";
import { readMemoBodyFile } from "@sorage/adapters/src/memo-body-file";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  addMemo,
  appError,
  err,
  listMemos,
  mutateMemo,
  ok,
  parseMemoExecution,
  resolveMemoProject,
  showMemo,
  successEnvelope,
  type AppError,
  type Memo,
  type MemoPage,
  type MemoReceipt,
  type Result,
} from "@sorage/core";
import { Option, Command } from "commander";

type Operation = "add" | "list" | "show" | "update" | "done" | "dismiss" | "reopen";
interface MemoCliOutput {
  out(text: string): void;
  fail(error: AppError, json: boolean): void;
  requestId(): string;
}

function bodyInput(options: Record<string, unknown>): Result<{ body?: string }> {
  if (options.body !== undefined && options.bodyFile !== undefined)
    return err(appError("MEMO_INVALID_INPUT", "Choose one Memo body source: --body or --body-file"));
  if (typeof options.bodyFile === "string") {
    const body = readMemoBodyFile(options.bodyFile);
    return body.ok ? ok({ body: body.value }) : body;
  }
  return ok(typeof options.body === "string" ? { body: options.body } : {});
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
    const invalid = (message: string) => output.fail(appError("MEMO_INVALID_INPUT", message), json);
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
    if (!execution.ok) return output.fail(execution.error, json);
    const body = bodyInput(options);
    if (!body.ok) return output.fail(body.error, json);
    if (operation === "add" && options.title === undefined) return invalid("Memo add requires --title");
    if (mutation && operation !== "add" && globals.expectedRowVersion === undefined)
      return invalid("Memo mutations require --expected-row-version from the observed Memo");
    // Existing native recovery remains separate from the Memo operation's own effects.
    const drained = createNodeVaultCommandPorts().drainAtStart();
    if (!drained.ok) return output.fail(drained.error, json);
    let ports: ReturnType<typeof createNodeMemoPorts>;
    try {
      ports = createNodeMemoPorts();
    } catch {
      return output.fail(appError("INTERNAL_ERROR", "Memo storage could not be opened"), json);
    }
    try {
      let projectId: string | undefined;
      if (
        options.project !== undefined ||
        ((operation === "add" || operation === "list") && options.allProjects !== true)
      ) {
        const selected = resolveMemoProject(
          ports.projectPorts,
          typeof options.project === "string" ? options.project : undefined,
          { path: process.cwd(), userHome: homedir() },
        );
        if (!selected.ok) return output.fail(selected.error, json);
        projectId = selected.value;
      }
      let result: Result<MemoReceipt | MemoPage | Memo>;
      if (operation === "add")
        result = addMemo(ports, { projectId, title: options.title, ...body.value }, execution.value);
      else if (operation === "list")
        result = listMemos(ports, {
          ...(options.allProjects === true ? { allProjects: true } : { projectId }),
          ...(options.state === undefined ? {} : { state: options.state }),
          ...(options.query === undefined ? {} : { query: options.query }),
          ...(globals.limit === undefined ? {} : { limit: globals.limit }),
          ...(globals.cursor === undefined ? {} : { cursor: globals.cursor }),
        });
      else if (operation === "show") result = showMemo(ports, id as string, projectId);
      else
        result = mutateMemo(
          ports,
          operation,
          id as string,
          {
            expectedRowVersion: globals.expectedRowVersion,
            ...(projectId === undefined ? {} : { projectId }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...body.value,
          },
          execution.value,
        );
      if (!result.ok) return output.fail(result.error, json);
      if (json) output.out(`${JSON.stringify(successEnvelope(result.value, output.requestId()), null, 2)}\n`);
      else renderMemo(result.value, output.out);
    } finally {
      ports.close();
    }
  }
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
