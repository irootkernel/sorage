import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/main";
import { admitArguments, type McpTool, MCP_TOOLS, mcpToolByName } from "../../src/mcp-catalogue";
import {
  ACCEPT_REQUIRES_ROW_VERSION,
  BODY_MUST_NOT_BE_EMPTY,
  CHANNEL_WAIT_ONLY_OPTIONS,
  CHANNEL_WAIT_UNHANDLED_ONLY,
  CHANNEL_WAIT_WHOLE_SECONDS,
  DECLINE_REQUIRES_ROW_VERSION,
  INBOX_WAIT_NO_CURSOR,
  INBOX_WAIT_WHOLE_SECONDS,
  REVIEW_SET_ONE_SOURCE,
  REVISE_ONE_SOURCE,
  SEND_REPLAY_ONLY_KEY,
  SEND_TAKES_ONE_SOURCE,
} from "../../src/usage-sentences";

/**
 * The 31-tool catalogue of interface section 39 against the CLI it mirrors:
 * the pinned shape (names, annotations, wait defaults), each tool's argv
 * mapping with the options-first `--` layout, and the two admission layers of
 * section 39's clarification — one case per inventory row, plus the positive
 * counterparts proving the layer-3 rules emit their argv unchanged.
 */
const COMMAND_PATHS: Record<string, string[]> = {
  handoff_send: ["send"],
  handoff_inbox: ["inbox"],
  handoff_outbox: ["outbox"],
  handoff_get: ["get"],
  handoff_events: ["events"],
  handoff_fetch: ["fetch"],
  handoff_review_show: ["review", "show"],
  handoff_review_set: ["review", "set"],
  handoff_review_withdraw: ["review", "withdraw"],
  handoff_revise: ["revise"],
  handoff_accept: ["accept"],
  handoff_decline: ["decline"],
  handoff_withdraw: ["withdraw"],
  memo_list: ["memo", "list"],
  memo_show: ["memo", "show"],
  memo_add: ["memo", "add"],
  memo_update: ["memo", "update"],
  memo_done: ["memo", "done"],
  memo_dismiss: ["memo", "dismiss"],
  memo_reopen: ["memo", "reopen"],
  channel_create: ["channel", "create"],
  channel_add: ["channel", "add"],
  channel_remove: ["channel", "remove"],
  channel_post: ["channel", "post"],
  channel_messages: ["channel", "messages"],
  channel_ack: ["channel", "ack"],
  channel_close: ["channel", "close"],
  channel_list: ["channel", "list"],
  channel_show: ["channel", "show"],
  project_list: ["project", "list"],
  project_show: ["project", "show"],
};

const COMMANDER_PATHS_OF_CLOSED_LIST = [
  ["init"],
  ["config"],
  ["vault"],
  ["backup"],
  ["uninstall"],
  ["daemon"],
  ["token"],
  ["project", "add"],
  ["project", "rename"],
  ["project", "bind"],
  ["project", "unbind"],
  ["project", "rebind"],
  ["project", "resolve"],
  ["pin"],
  ["unpin"],
  ["archive"],
  ["unarchive"],
  ["delete"],
];

function commandAt(program: Command, path: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const segment of path) {
    current = current.commands.find((child) => child.name() === segment);
    if (current === undefined) return undefined;
  }
  return current;
}

function tool(name: string): McpTool {
  const found = mcpToolByName(name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

function argvOf(name: string, arguments_: Record<string, unknown>): string[] {
  const admitted = admitArguments(tool(name), arguments_);
  if (!admitted.ok || admitted.argv === undefined) {
    throw new Error(`${name} refused arguments that the test meant to admit: ${admitted.message}`);
  }
  return admitted.argv;
}

function refusalOf(name: string, arguments_: Record<string, unknown>): string {
  const admitted = admitArguments(tool(name), arguments_);
  if (admitted.ok) throw new Error(`${name} admitted arguments the test meant to refuse`);
  return admitted.message as string;
}

const silent = { out: () => {}, err: () => {} };

describe("the MCP catalogue shape (MCP-005)", () => {
  it("holds exactly the 31 pinned tools in section 39's order", () => {
    expect(MCP_TOOLS.map((entry) => entry.name)).toEqual([
      ...[
        "send",
        "inbox",
        "outbox",
        "get",
        "events",
        "fetch",
        "review_show",
        "review_set",
        "review_withdraw",
        "revise",
        "accept",
        "decline",
        "withdraw",
      ].map((leaf) => `handoff_${leaf}`),
      "memo_list",
      "memo_show",
      "memo_add",
      "memo_update",
      "memo_done",
      "memo_dismiss",
      "memo_reopen",
      ...["create", "add", "remove", "post", "messages", "ack", "close", "list", "show"].map(
        (leaf) => `channel_${leaf}`,
      ),
      "project_list",
      "project_show",
    ]);
    expect(MCP_TOOLS).toHaveLength(31);
  });

  it("sets the exact annotation memberships of section 39", () => {
    const readOnly = MCP_TOOLS.filter((entry) => entry.annotations.readOnlyHint).map((entry) => entry.name);
    expect(readOnly).toEqual([
      "handoff_inbox",
      "handoff_outbox",
      "handoff_get",
      "handoff_events",
      "handoff_review_show",
      "memo_list",
      "memo_show",
      "channel_messages",
      "channel_list",
      "channel_show",
      "project_list",
      "project_show",
    ]);
    const destructive = MCP_TOOLS.filter((entry) => entry.annotations.destructiveHint).map((entry) => entry.name);
    expect(destructive).toEqual(["handoff_decline", "handoff_withdraw", "channel_close"]);
    const idempotent = MCP_TOOLS.filter((entry) => entry.annotations.idempotentHint).map((entry) => entry.name);
    expect(idempotent).toEqual(["channel_create", "channel_add", "channel_remove", "channel_ack", "channel_close"]);
    expect(MCP_TOOLS.every((entry) => entry.annotations.openWorldHint === false)).toBe(true);
  });

  it("reuses each CLI command's own commander description and never names an excluded command", () => {
    const program = buildProgram(silent, () => {}, { confirm: () => {}, prompt: () => Promise.resolve("") } as never);
    for (const entry of MCP_TOOLS) {
      const command = commandAt(program, COMMAND_PATHS[entry.name] as string[]);
      expect(command, entry.name).toBeDefined();
      expect(entry.description, entry.name).toBe(command?.description());
    }
    const cataloguedCommands = Object.values(COMMAND_PATHS).map((path) => path.join(" "));
    for (const path of COMMANDER_PATHS_OF_CLOSED_LIST) {
      expect(cataloguedCommands.includes(path.join(" ")), path.join(" ")).toBe(false);
    }
  });

  it("builds every argv on the command path the description check pinned", () => {
    for (const entry of MCP_TOOLS) {
      const path = COMMAND_PATHS[entry.name] as string[] | undefined;
      expect(path, entry.name).toBeDefined();
      const sample = sampleArguments(entry.name);
      expect(argvOf(entry.name, sample).slice(0, path?.length), entry.name).toEqual(path);
    }
  });
});

describe("the argv mapping (MCP-002)", () => {
  it("handoff_send maps every option with repeatable --to pairs", () => {
    expect(
      argvOf("handoff_send", {
        to: ["alpha", "beta"],
        title: "The title",
        body: "the body",
        supersedes: "h-1",
        allowUnregistered: true,
        idempotencyKey: "k-1",
        replayOnly: true,
      }),
    ).toEqual([
      "send",
      "--to",
      "alpha",
      "--to",
      "beta",
      "--title",
      "The title",
      "--body",
      "the body",
      "--supersedes",
      "h-1",
      "--allow-unregistered",
      "--idempotency-key",
      "k-1",
      "--replay-only",
      "--json",
      "--",
    ]);
  });

  it("handoff_send maps a file source and discrete handles joined never", () => {
    expect(argvOf("handoff_send", { to: ["a b"], title: "T", file: "doc.md" })).toEqual([
      "send",
      "--to",
      "a b",
      "--title",
      "T",
      "--file",
      "doc.md",
      "--json",
      "--",
    ]);
  });

  it("handoff_inbox maps the wait triple explicitly and passes unmatched timeout and interval through", () => {
    expect(argvOf("handoff_inbox", { state: "awaiting_recipient", wait: true })).toEqual([
      "inbox",
      "--state",
      "awaiting_recipient",
      "--wait",
      "--timeout",
      "30",
      "--interval",
      "2",
      "--json",
      "--",
    ]);
    expect(argvOf("handoff_inbox", { timeout: 10, interval: 5 })).toEqual([
      "inbox",
      "--timeout",
      "10",
      "--interval",
      "5",
      "--json",
      "--",
    ]);
    expect(
      argvOf("handoff_inbox", {
        sender: "alpha",
        recipient: "beta",
        updatedSince: "2026-01-01T00:00:00Z",
        updatedUntil: "2026-01-02T00:00:00Z",
        includeArchived: true,
        includeDeleted: true,
        limit: 5,
        cursor: "c-1",
      }),
    ).toEqual([
      "inbox",
      "--sender",
      "alpha",
      "--recipient",
      "beta",
      "--updated-since",
      "2026-01-01T00:00:00Z",
      "--updated-until",
      "2026-01-02T00:00:00Z",
      "--include-archived",
      "--include-deleted",
      "--limit",
      "5",
      "--cursor",
      "c-1",
      "--json",
      "--",
    ]);
  });

  it("handoff_outbox maps the workspace switch and the listing filters", () => {
    expect(argvOf("handoff_outbox", { currentWorkspace: true, limit: 5, cursor: "c-1" })).toEqual([
      "outbox",
      "--current-workspace",
      "--limit",
      "5",
      "--cursor",
      "c-1",
      "--json",
      "--",
    ]);
  });

  it("the Handoff id reads and mutations place their positional after the end-of-options marker", () => {
    expect(argvOf("handoff_get", { handoffId: "h 1" })).toEqual(["get", "--json", "--", "h 1"]);
    expect(argvOf("handoff_events", { handoffId: "h1" })).toEqual(["events", "--json", "--", "h1"]);
    expect(argvOf("handoff_fetch", { handoffId: "h1" })).toEqual(["fetch", "--json", "--", "h1"]);
    expect(argvOf("handoff_review_show", { handoffId: "h1" })).toEqual(["review", "show", "--json", "--", "h1"]);
    expect(
      argvOf("handoff_review_set", { handoffId: "h1", text: "the note", targetRevision: 2, expectedRowVersion: 3 }),
    ).toEqual([
      "review",
      "set",
      "--text",
      "the note",
      "--target-revision",
      "2",
      "--expected-row-version",
      "3",
      "--json",
      "--",
      "h1",
    ]);
    expect(argvOf("handoff_review_withdraw", { handoffId: "h1", expectedRowVersion: 2 })).toEqual([
      "review",
      "withdraw",
      "--expected-row-version",
      "2",
      "--json",
      "--",
      "h1",
    ]);
    expect(argvOf("handoff_revise", { handoffId: "h1", body: "new body", idempotencyKey: "k" })).toEqual([
      "revise",
      "--body",
      "new body",
      "--idempotency-key",
      "k",
      "--json",
      "--",
      "h1",
    ]);
    expect(argvOf("handoff_revise", { handoffId: "h1", noChange: true, reason: "nothing to change" })).toEqual([
      "revise",
      "--no-change",
      "--reason",
      "nothing to change",
      "--json",
      "--",
      "h1",
    ]);
    expect(argvOf("handoff_accept", { handoffId: "h1", expectedRevision: 1, expectedRowVersion: 2 })).toEqual([
      "accept",
      "--expected-revision",
      "1",
      "--expected-row-version",
      "2",
      "--json",
      "--",
      "h1",
    ]);
    expect(argvOf("handoff_decline", { handoffId: "h1", reason: "not wanted", expectedRowVersion: 2 })).toEqual([
      "decline",
      "--reason",
      "not wanted",
      "--expected-row-version",
      "2",
      "--json",
      "--",
      "h1",
    ]);
    expect(argvOf("handoff_withdraw", { handoffId: "h1", expectedRowVersion: 2 })).toEqual([
      "withdraw",
      "--expected-row-version",
      "2",
      "--json",
      "--",
      "h1",
    ]);
  });
});

/** One admitted argument object per tool, for the argv-prefix check. */
function sampleArguments(name: string): Record<string, unknown> {
  const samples: Record<string, Record<string, unknown>> = {
    handoff_send: { to: ["alpha"], title: "T", body: "b" },
    handoff_inbox: {},
    handoff_outbox: {},
    handoff_get: { handoffId: "h1" },
    handoff_events: { handoffId: "h1" },
    handoff_fetch: { handoffId: "h1" },
    handoff_review_show: { handoffId: "h1" },
    handoff_review_set: { handoffId: "h1", text: "n", targetRevision: 1, expectedRowVersion: 1 },
    handoff_review_withdraw: { handoffId: "h1", expectedRowVersion: 1 },
    handoff_revise: { handoffId: "h1", body: "b" },
    handoff_accept: { handoffId: "h1", expectedRevision: 1, expectedRowVersion: 2 },
    handoff_decline: { handoffId: "h1", reason: "r", expectedRowVersion: 2 },
    handoff_withdraw: { handoffId: "h1" },
    memo_list: {},
    memo_show: { memoId: "m1" },
    memo_add: { title: "t" },
    memo_update: { memoId: "m1", expectedRowVersion: 2, title: "t2" },
    memo_done: { memoId: "m1", expectedRowVersion: 2 },
    memo_dismiss: { memoId: "m1", expectedRowVersion: 2 },
    memo_reopen: { memoId: "m1", expectedRowVersion: 2 },
    channel_create: { name: "n" },
    channel_add: { channel: "c", handle: "h", role: "worker" },
    channel_remove: { channel: "c", handle: "h" },
    channel_post: { channel: "c", from: "h", kind: "report", body: "b" },
    channel_messages: { channel: "c" },
    channel_ack: { channel: "c", seq: [1] },
    channel_close: { channel: "c" },
    channel_list: {},
    channel_show: { channel: "c" },
    project_list: {},
    project_show: { project: "p" },
  };
  const sample = samples[name];
  if (sample === undefined) throw new Error(`no sample arguments for ${name}`);
  return sample;
}

describe("the argv mapping of the Memo, Channel and Project tools (MCP-002)", () => {
  it("maps the Memo reads and mutations with discrete positionals", () => {
    expect(argvOf("memo_list", { project: "alpha", state: "done", query: "needle", limit: 3, cursor: "c-1" })).toEqual([
      "memo",
      "list",
      "--project",
      "alpha",
      "--state",
      "done",
      "--query",
      "needle",
      "--cursor",
      "c-1",
      "--limit",
      "3",
      "--json",
      "--",
    ]);
    expect(argvOf("memo_list", { allProjects: true })).toEqual(["memo", "list", "--all-projects", "--json", "--"]);
    expect(argvOf("memo_show", { memoId: "m 1", project: "alpha" })).toEqual([
      "memo",
      "show",
      "--project",
      "alpha",
      "--json",
      "--",
      "m 1",
    ]);
    expect(argvOf("memo_add", { title: "t", body: "b", idempotencyKey: "k", replayOnly: true })).toEqual([
      "memo",
      "add",
      "--title",
      "t",
      "--body",
      "b",
      "--idempotency-key",
      "k",
      "--replay-only",
      "--json",
      "--",
    ]);
    expect(argvOf("memo_add", { title: "t", bodyFile: "f.md", project: "alpha" })).toEqual([
      "memo",
      "add",
      "--title",
      "t",
      "--body-file",
      "f.md",
      "--project",
      "alpha",
      "--json",
      "--",
    ]);
    expect(argvOf("memo_update", { memoId: "m1", expectedRowVersion: 2, title: "t2", bodyFile: "f.md" })).toEqual([
      "memo",
      "update",
      "--title",
      "t2",
      "--body-file",
      "f.md",
      "--expected-row-version",
      "2",
      "--json",
      "--",
      "m1",
    ]);
    for (const operation of ["done", "dismiss", "reopen"]) {
      expect(argvOf(`memo_${operation}`, { memoId: "m1", expectedRowVersion: 2, idempotencyKey: "k" })).toEqual([
        "memo",
        operation,
        "--expected-row-version",
        "2",
        "--idempotency-key",
        "k",
        "--json",
        "--",
        "m1",
      ]);
    }
  });

  it("maps the nine Channel commands with discrete names, handles and sequence numbers", () => {
    expect(argvOf("channel_create", { name: "aq-run", title: "the run", main: "orchestrator" })).toEqual([
      "channel",
      "create",
      "--title",
      "the run",
      "--main",
      "orchestrator",
      "--json",
      "--",
      "aq-run",
    ]);
    expect(argvOf("channel_add", { channel: "aq-run", handle: "worker 1", role: "judge" })).toEqual([
      "channel",
      "add",
      "--role",
      "judge",
      "--json",
      "--",
      "aq-run",
      "worker 1",
    ]);
    expect(argvOf("channel_remove", { channel: "aq-run", handle: "w1" })).toEqual([
      "channel",
      "remove",
      "--json",
      "--",
      "aq-run",
      "w1",
    ]);
    expect(
      argvOf("channel_post", {
        channel: "aq-run",
        from: "w1",
        kind: "relay_request",
        bodyFile: "r.md",
        to: "main",
        ref: "ref-1",
      }),
    ).toEqual([
      "channel",
      "post",
      "--from",
      "w1",
      "--kind",
      "relay_request",
      "--body-file",
      "r.md",
      "--to",
      "main",
      "--ref",
      "ref-1",
      "--json",
      "--",
      "aq-run",
    ]);
    expect(
      argvOf("channel_messages", { channel: "aq-run", all: true, after: 2, from: "w1", kind: "report", limit: 5 }),
    ).toEqual([
      "channel",
      "messages",
      "--all",
      "--after",
      "2",
      "--from",
      "w1",
      "--kind",
      "report",
      "--limit",
      "5",
      "--json",
      "--",
      "aq-run",
    ]);
    expect(argvOf("channel_messages", { channel: "aq-run", wait: true })).toEqual([
      "channel",
      "messages",
      "--wait",
      "--timeout",
      "30",
      "--interval",
      "2",
      "--json",
      "--",
      "aq-run",
    ]);
    expect(argvOf("channel_ack", { channel: "aq-run", seq: [1, 2, 10], note: "handled" })).toEqual([
      "channel",
      "ack",
      "--note",
      "handled",
      "--json",
      "--",
      "aq-run",
      "1",
      "2",
      "10",
    ]);
    expect(argvOf("channel_close", { channel: "aq-run" })).toEqual(["channel", "close", "--json", "--", "aq-run"]);
    expect(argvOf("channel_list", { state: "open" })).toEqual(["channel", "list", "--state", "open", "--json", "--"]);
    expect(argvOf("channel_show", { channel: "aq-run" })).toEqual(["channel", "show", "--json", "--", "aq-run"]);
    expect(argvOf("project_list", {})).toEqual(["project", "list", "--json", "--"]);
    expect(argvOf("project_show", { project: "alpha" })).toEqual(["project", "show", "--json", "--", "alpha"]);
  });
});

describe("admission layer 1 — encodability (section 39's clarification)", () => {
  it("refuses a wrong JSON type, an unknown property, a NUL and a lone surrogate, and non-array forms", () => {
    expect(refusalOf("handoff_send", { to: ["alpha"], title: 5, body: "b" })).toBe("expected a string");
    expect(refusalOf("handoff_inbox", { limit: "5" })).toBe("expected an integer");
    expect(refusalOf("handoff_inbox", { includeArchived: "yes" })).toBe("expected a boolean");
    expect(refusalOf("handoff_send", { to: "alpha", title: "T", body: "b" })).toBe("expected an array of strings");
    expect(refusalOf("channel_ack", { channel: "c", seq: [1, "2"] })).toBe("expected an array of integers");
    expect(refusalOf("handoff_get", { handoffId: "h1", mystery: 1 })).toBe("unknown property 'mystery'");
    expect(refusalOf("handoff_send", { to: ["alpha"], title: "T", body: "a\u0000b" })).toBe(
      "strings must not contain NUL or an unpaired surrogate",
    );
    expect(refusalOf("handoff_send", { to: ["alpha"], title: "T", body: "a\uD800b" })).toBe(
      "strings must not contain NUL or an unpaired surrogate",
    );
    expect(admitArguments(tool("handoff_get"), "not an object")).toEqual({
      ok: false,
      message: "arguments must be an object",
    });
  });
});

describe("admission layer 2 — the CLI parser's exit-2 class mirrored exactly", () => {
  it("refuses the missing commander-required options and arguments with the parser's sentences", () => {
    expect(refusalOf("handoff_send", { to: ["alpha"], body: "b" })).toBe(
      "required option '--title <title>' not specified",
    );
    expect(refusalOf("channel_add", { channel: "c", handle: "h" })).toBe(
      "required option '--role <role>' not specified",
    );
    expect(refusalOf("channel_post", { channel: "c", kind: "report", body: "b" })).toBe(
      "required option '--from <handle>' not specified",
    );
    expect(refusalOf("channel_post", { channel: "c", from: "h", body: "b" })).toBe(
      "required option '--kind <kind>' not specified",
    );
    expect(refusalOf("handoff_accept", { handoffId: "h1", expectedRowVersion: 2 })).toBe(
      "required option '--expected-revision <n>' not specified",
    );
    expect(refusalOf("handoff_decline", { handoffId: "h1", expectedRowVersion: 2 })).toBe(
      "required option '--reason <text>' not specified",
    );
    expect(refusalOf("channel_ack", { channel: "c", seq: [] })).toBe("missing required argument 'seq...'");
  });

  it("refuses the commander kind choices and the Handoff and Channel integer bounds", () => {
    expect(refusalOf("channel_post", { channel: "c", from: "h", kind: "notice", body: "b" })).toBe(
      "kind must be one of report, question, or relay_request",
    );
    expect(refusalOf("channel_messages", { channel: "c", kind: "notice" })).toBe(
      "kind must be one of report, question, or relay_request",
    );
    expect(refusalOf("handoff_inbox", { limit: -1 })).toBe("expected a non-negative integer");
    expect(refusalOf("handoff_accept", { handoffId: "h1", expectedRevision: -1, expectedRowVersion: 2 })).toBe(
      "expected a non-negative integer",
    );
    expect(refusalOf("channel_messages", { channel: "c", after: -3 })).toBe("expected a non-negative integer");
  });

  it("refuses the plain-text usage rules with the CLI's own sentences from the shared module", () => {
    expect(refusalOf("handoff_inbox", { wait: true, cursor: "c-1" })).toBe(INBOX_WAIT_NO_CURSOR);
    expect(refusalOf("handoff_inbox", { wait: true, interval: 0 })).toBe(INBOX_WAIT_WHOLE_SECONDS);
    expect(refusalOf("channel_messages", { channel: "c", wait: true, all: true })).toBe(CHANNEL_WAIT_UNHANDLED_ONLY);
    expect(refusalOf("channel_messages", { channel: "c", wait: true, interval: 0 })).toBe(CHANNEL_WAIT_WHOLE_SECONDS);
    expect(refusalOf("channel_messages", { channel: "c", timeout: 5 })).toBe(CHANNEL_WAIT_ONLY_OPTIONS);
    expect(refusalOf("channel_messages", { channel: "c", interval: 5 })).toBe(CHANNEL_WAIT_ONLY_OPTIONS);
    expect(refusalOf("handoff_send", { to: ["alpha"], title: "T" })).toBe(SEND_TAKES_ONE_SOURCE);
    expect(refusalOf("handoff_send", { to: ["alpha"], title: "T", body: "b", file: "f.md" })).toBe(
      SEND_TAKES_ONE_SOURCE,
    );
    expect(refusalOf("handoff_send", { to: ["alpha"], title: "T", body: "  " })).toBe(BODY_MUST_NOT_BE_EMPTY);
    expect(refusalOf("handoff_send", { to: ["alpha"], title: "T", body: "b", replayOnly: true })).toBe(
      SEND_REPLAY_ONLY_KEY,
    );
    expect(
      refusalOf("handoff_send", { to: ["alpha"], title: "T", body: "b", replayOnly: true, idempotencyKey: "  " }),
    ).toBe(SEND_REPLAY_ONLY_KEY);
    expect(refusalOf("handoff_review_set", { handoffId: "h1", targetRevision: 1, expectedRowVersion: 1 })).toBe(
      REVIEW_SET_ONE_SOURCE,
    );
    expect(
      refusalOf("handoff_review_set", {
        handoffId: "h1",
        text: "n",
        file: "f.md",
        targetRevision: 1,
        expectedRowVersion: 1,
      }),
    ).toBe(REVIEW_SET_ONE_SOURCE);
    expect(refusalOf("handoff_revise", { handoffId: "h1" })).toBe(REVISE_ONE_SOURCE);
    expect(refusalOf("handoff_revise", { handoffId: "h1", body: "b", file: "f.md" })).toBe(REVISE_ONE_SOURCE);
    expect(refusalOf("handoff_revise", { handoffId: "h1", body: "  " })).toBe(BODY_MUST_NOT_BE_EMPTY);
    expect(refusalOf("handoff_accept", { handoffId: "h1", expectedRevision: 1 })).toBe(ACCEPT_REQUIRES_ROW_VERSION);
    expect(refusalOf("handoff_decline", { handoffId: "h1", reason: "r" })).toBe(DECLINE_REQUIRES_ROW_VERSION);
  });
});

describe("the layer-3 pass-through (everything else goes to the child)", () => {
  it("emits the argv unchanged for every rule the CLI answers coded", () => {
    // An absent or empty to: the option's default satisfies the parser, and
    // core refuses the empty fan-out with CONFIG_INVALID.
    expect(argvOf("handoff_send", { title: "T", body: "b" })).toEqual([
      "send",
      "--title",
      "T",
      "--body",
      "b",
      "--json",
      "--",
    ]);
    expect(argvOf("handoff_send", { to: [], title: "T", body: "b" })).toEqual([
      "send",
      "--title",
      "T",
      "--body",
      "b",
      "--json",
      "--",
    ]);
    // The Memo numeric failures: runCli's catch path answers MEMO_INVALID_INPUT.
    expect(argvOf("memo_list", { limit: -1 })).toEqual(["memo", "list", "--limit", "-1", "--json", "--"]);
    expect(argvOf("memo_done", { memoId: "m1", expectedRowVersion: -1 })).toEqual([
      "memo",
      "done",
      "--expected-row-version",
      "-1",
      "--json",
      "--",
      "m1",
    ]);
    // A Memo mutation without its Row Version: coded MEMO_INVALID_INPUT.
    expect(argvOf("memo_done", { memoId: "m1" })).toEqual(["memo", "done", "--json", "--", "m1"]);
    // Two Memo body sources and project/allProjects conflicts: coded.
    expect(argvOf("memo_add", { title: "t", body: "b", bodyFile: "f.md" })).toEqual([
      "memo",
      "add",
      "--title",
      "t",
      "--body",
      "b",
      "--body-file",
      "f.md",
      "--json",
      "--",
    ]);
    expect(argvOf("memo_list", { project: "alpha", allProjects: true })).toEqual([
      "memo",
      "list",
      "--project",
      "alpha",
      "--all-projects",
      "--json",
      "--",
    ]);
    // A channel_ack seq item below 1 and a bad role or state value: coded
    // CHN_INVALID_INPUT, with `--` carrying the negative operand intact.
    expect(argvOf("channel_ack", { channel: "c", seq: [-1] })).toEqual(["channel", "ack", "--json", "--", "c", "-1"]);
    expect(argvOf("channel_add", { channel: "c", handle: "h", role: "boss" })).toEqual([
      "channel",
      "add",
      "--role",
      "boss",
      "--json",
      "--",
      "c",
      "h",
    ]);
    expect(argvOf("channel_list", { state: "archived" })).toEqual([
      "channel",
      "list",
      "--state",
      "archived",
      "--json",
      "--",
    ]);
    // The relay to rule and two Channel body sources: coded.
    expect(argvOf("channel_post", { channel: "c", from: "h", kind: "report", body: "b", to: "main" })).toEqual([
      "channel",
      "post",
      "--from",
      "h",
      "--kind",
      "report",
      "--body",
      "b",
      "--to",
      "main",
      "--json",
      "--",
      "c",
    ]);
    expect(argvOf("channel_post", { channel: "c", from: "h", kind: "report" })).toEqual([
      "channel",
      "post",
      "--from",
      "h",
      "--kind",
      "report",
      "--json",
      "--",
      "c",
    ]);
    // A noChange resolution without reason: coded CONFIG_INVALID.
    expect(argvOf("handoff_revise", { handoffId: "h1", noChange: true })).toEqual([
      "revise",
      "--no-change",
      "--json",
      "--",
      "h1",
    ]);
  });

  it("passes handoff_inbox timeout and interval without wait through unchanged", () => {
    expect(argvOf("handoff_inbox", { timeout: 10 })).toEqual(["inbox", "--timeout", "10", "--json", "--"]);
    expect(admitArguments(tool("handoff_inbox"), { timeout: 10 }).ok).toBe(true);
  });
});

describe("missing required positionals are mirrored at layer 2 (C2 item 1)", () => {
  const positionalCases: Array<[string, Record<string, unknown>, string]> = [
    ["handoff_get", {}, "handoff-id"],
    ["handoff_events", {}, "handoff-id"],
    ["handoff_fetch", {}, "handoff-id"],
    ["handoff_review_show", {}, "handoff-id"],
    ["handoff_review_set", { text: "n" }, "handoff-id"],
    ["handoff_review_withdraw", {}, "handoff-id"],
    ["handoff_revise", { body: "b" }, "handoff-id"],
    ["handoff_accept", { expectedRevision: 1, expectedRowVersion: 2 }, "handoff-id"],
    ["handoff_decline", { reason: "r", expectedRowVersion: 2 }, "handoff-id"],
    ["handoff_withdraw", {}, "handoff-id"],
    ["memo_show", {}, "id"],
    ["memo_update", { expectedRowVersion: 2, title: "t" }, "id"],
    ["memo_done", {}, "id"],
    ["memo_dismiss", {}, "id"],
    ["memo_reopen", {}, "id"],
    ["channel_create", {}, "name"],
    ["channel_add", { handle: "h" }, "channel"],
    ["channel_add", { channel: "c" }, "handle"],
    ["channel_remove", { channel: "c" }, "handle"],
    ["channel_post", { from: "h", kind: "report", body: "b" }, "channel"],
    ["channel_messages", {}, "channel"],
    ["channel_ack", { channel: "c" }, "seq..."],
    ["channel_ack", {}, "channel"],
    ["channel_close", {}, "channel"],
    ["channel_show", {}, "channel"],
    ["project_show", {}, "project"],
  ];

  for (const [name, arguments_, argument] of positionalCases) {
    it(`refuses ${name} without its ${argument} positional with commander's sentence`, () => {
      expect(refusalOf(name, arguments_)).toBe(`missing required argument '${argument}'`);
    });
  }

  it("refuses channel_ack with an empty seq array exactly like an absent variadic", () => {
    expect(refusalOf("channel_ack", { channel: "c", seq: [] })).toBe("missing required argument 'seq...'");
  });
});

describe("own properties only (C2 item 8)", () => {
  it("refuses a prototype-named key such as toString as an unknown property", () => {
    expect(refusalOf("handoff_get", { handoffId: "h1", toString: "no" })).toBe("unknown property 'toString'");
    expect(refusalOf("memo_list", { constructor: 1 })).toBe("unknown property 'constructor'");
  });
});

describe("integer typing and bounds split across the layers (C2 item 10)", () => {
  it("refuses an unsafe integer on a Handoff or Channel option at layer 2 with the parser's sentence", () => {
    expect(refusalOf("handoff_inbox", { limit: 9007199254740992 })).toBe("expected a non-negative integer");
    expect(refusalOf("channel_messages", { channel: "c", after: 9007199254740992 })).toBe(
      "expected a non-negative integer",
    );
  });

  it("passes unsafe Memo numerics and ack operands to the child's coded refusal", () => {
    expect(argvOf("memo_list", { limit: 9007199254740992 })).toEqual([
      "memo",
      "list",
      "--limit",
      "9007199254740992",
      "--json",
      "--",
    ]);
    expect(argvOf("memo_done", { memoId: "m1", expectedRowVersion: 9007199254740992 })).toEqual([
      "memo",
      "done",
      "--expected-row-version",
      "9007199254740992",
      "--json",
      "--",
      "m1",
    ]);
    expect(argvOf("channel_ack", { channel: "c", seq: [9007199254740992] })).toEqual([
      "channel",
      "ack",
      "--json",
      "--",
      "c",
      "9007199254740992",
    ]);
  });
});
