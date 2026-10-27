import { isUtf8ExactText } from "@sorage/core";
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
} from "./usage-sentences";

/**
 * The 35-tool catalogue of interface section 39, pinned as a contract artifact
 * beside the CLI goldens (MCP-005). Property names are the CLI options in
 * camelCase and carry the CLI's own semantics, bounds and validation by
 * reference; the published `inputSchema` states the section's full contract,
 * while the runtime admission enforced here covers only the first two layers
 * of section 39's first clarification paragraph — encodability, and the CLI
 * parser's exit-2 class mirrored exactly. Everything the CLI refuses with a
 * code flows to the child untouched, so the CLI stays the single behavior
 * source (MCP-002).
 */

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

type PropertyType = "string" | "integer" | "boolean" | "stringArray" | "integerArray";

interface PropertySpec {
  type: PropertyType;
}

interface OptionMapping {
  property: string;
  flag: string;
  /** `pair` emits `--flag <value>`; `flag` emits the bare option when true; `repeat` emits one pair per item. */
  form: "pair" | "flag" | "repeat";
}

export interface McpTool {
  name: string;
  description: string;
  annotations: McpToolAnnotations;
  inputSchema: Record<string, unknown>;
  properties: Record<string, PropertySpec>;
  /** The argv elements after the self-invocation entry: command words, option pairs, `--json`, `--`, positionals. */
  argv: (arguments_: Record<string, unknown>) => string[];
  /**
   * Admission layer 2 — the CLI parser's own exit-2 rules for this tool.
   * Returns the CLI's usage sentence on refusal, `undefined` when admitted.
   * The generic layer (types, array item types, unknown properties, string
   * encodability) and the Handoff/Channel integer bounds run before this.
   */
  guard: (arguments_: Record<string, unknown>) => string | undefined;
  /** Whether the parser's integer bounds mirror at layer 2; the Memo CLI reports its numeric failures coded. */
  mirrorsIntegerBounds: boolean;
}

const READ: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const WRITE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const IDEMPOTENT: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const CLOSE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const KINDS = ["report", "question", "relay_request"];
/** `replayOnly` requires the original `idempotencyKey` (section 39's carriers). */
const REPLAY_ONLY_WITH_KEY: Record<string, unknown> = {
  // A false-valued flag counts as absent, exactly as the CLI treats an
  // omitted flag: only `replayOnly: true` requires the original key.
  if: { required: ["replayOnly"], properties: { replayOnly: { const: true } } },
  // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
  then: { required: ["idempotencyKey"] },
};
// The parser's own sentences (main.ts parseInteger and the commander
// required-option/choice/variadic messages), carried verbatim in `-32602`.
const NON_NEGATIVE_INTEGER = "expected a non-negative integer";
const KIND_CHOICES = "kind must be one of report, question, or relay_request";
function requiredOptionSentence(flag: string): string {
  return `required option '${flag}' not specified`;
}
function requiredArgumentSentence(name: string): string {
  return `missing required argument '${name}'`;
}

/**
 * Builds an argv builder from an ordered option list: each mapping emits its
 * pair, repeat or true-flag; the result appends `--json`, the end-of-options
 * marker, and the positionals — the lossless layout of interface section 39
 * under which a name or handle beginning with `-` reaches the CLI intact.
 */
function optionsArgv(
  command: string[],
  mappings: OptionMapping[],
  positional: (arguments_: Record<string, unknown>) => string[],
): (arguments_: Record<string, unknown>) => string[] {
  return (arguments_) => {
    const argv = [...command];
    for (const mapping of mappings) {
      const value = arguments_[mapping.property];
      if (value === undefined) continue;
      if (mapping.form === "flag") {
        if (value === true) argv.push(mapping.flag);
        continue;
      }
      if (mapping.form === "repeat") {
        for (const item of value as unknown[]) argv.push(mapping.flag, String(item));
        continue;
      }
      argv.push(mapping.flag, String(value));
    }
    argv.push("--json", "--");
    argv.push(...positional(arguments_));
    return argv;
  };
}

const HANDOFF_TOOLS: McpTool[] = [
  {
    name: "handoff_send",
    description: "hand one current document to one or more recipient Projects, one Handoff each",
    annotations: WRITE,
    mirrorsIntegerBounds: true,
    properties: {
      to: { type: "stringArray" },
      title: { type: "string" },
      body: { type: "string" },
      file: { type: "string" },
      supersedes: { type: "string" },
      allowUnregistered: { type: "boolean" },
      idempotencyKey: { type: "string" },
      replayOnly: { type: "boolean" },
    },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, minItems: 1 },
        title: { type: "string" },
        body: { type: "string" },
        file: { type: "string" },
        supersedes: { type: "string" },
        allowUnregistered: { type: "boolean" },
        idempotencyKey: { type: "string" },
        replayOnly: { type: "boolean" },
      },
      required: ["to", "title"],
      oneOf: [{ required: ["body"] }, { required: ["file"] }],
      allOf: [REPLAY_ONLY_WITH_KEY],
    },
    argv: optionsArgv(
      ["send"],
      [
        { property: "to", flag: "--to", form: "repeat" },
        { property: "title", flag: "--title", form: "pair" },
        { property: "body", flag: "--body", form: "pair" },
        { property: "file", flag: "--file", form: "pair" },
        { property: "supersedes", flag: "--supersedes", form: "pair" },
        { property: "allowUnregistered", flag: "--allow-unregistered", form: "flag" },
        { property: "idempotencyKey", flag: "--idempotency-key", form: "pair" },
        { property: "replayOnly", flag: "--replay-only", form: "flag" },
      ],
      () => [],
    ),
    guard: (a) => {
      if (a.title === undefined) return requiredOptionSentence("--title <title>");
      if ((a.body !== undefined) === (a.file !== undefined)) return SEND_TAKES_ONE_SOURCE;
      if (a.body !== undefined && String(a.body).trim() === "") return BODY_MUST_NOT_BE_EMPTY;
      if (a.replayOnly === true && (typeof a.idempotencyKey !== "string" || a.idempotencyKey.trim() === ""))
        return SEND_REPLAY_ONLY_KEY;
      return undefined;
    },
  },
  {
    name: "handoff_inbox",
    description: "list the Handoffs sent to the resolved recipient Project",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: {
      state: { type: "string" },
      sender: { type: "string" },
      recipient: { type: "string" },
      updatedSince: { type: "string" },
      updatedUntil: { type: "string" },
      includeArchived: { type: "boolean" },
      includeDeleted: { type: "boolean" },
      limit: { type: "integer" },
      cursor: { type: "string" },
      wait: { type: "boolean" },
      timeout: { type: "integer" },
      interval: { type: "integer" },
    },
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        sender: { type: "string" },
        recipient: { type: "string" },
        updatedSince: { type: "string" },
        updatedUntil: { type: "string" },
        includeArchived: { type: "boolean" },
        includeDeleted: { type: "boolean" },
        limit: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        cursor: { type: "string" },
        wait: { type: "boolean", default: false },
        timeout: { type: "integer", minimum: 0, maximum: 9007199254740991, default: 30 },
        interval: { type: "integer", minimum: 0, maximum: 9007199254740991, default: 2 },
      },
      allOf: [
        {
          if: { required: ["wait"], properties: { wait: { const: true } } },
          // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
          then: { not: { required: ["cursor"] } },
        },
      ] satisfies Array<Record<string, unknown>>,
    },
    // The wait triple is explicit whenever `wait` holds, so the tool-schema's
    // 30-second default reaches the CLI whose own default is 300; without
    // `wait` a supplied timeout or interval passes through unchanged, exactly
    // as the CLI accepts and ignores it (section 39's wait-defaults paragraph).
    argv: (a) => {
      const argv = [
        "inbox",
        ...pair(a, "state", "--state"),
        ...pair(a, "sender", "--sender"),
        ...pair(a, "recipient", "--recipient"),
        ...pair(a, "updatedSince", "--updated-since"),
        ...pair(a, "updatedUntil", "--updated-until"),
        ...flag(a, "includeArchived", "--include-archived"),
        ...flag(a, "includeDeleted", "--include-deleted"),
        ...pair(a, "limit", "--limit"),
        ...pair(a, "cursor", "--cursor"),
      ];
      if (a.wait === true) {
        argv.push("--wait", "--timeout", String(a.timeout ?? 30), "--interval", String(a.interval ?? 2));
      } else {
        argv.push(...pair(a, "timeout", "--timeout"), ...pair(a, "interval", "--interval"));
      }
      argv.push("--json", "--");
      return argv;
    },
    guard: (a) => {
      if (a.wait === true && a.cursor !== undefined) return INBOX_WAIT_NO_CURSOR;
      if (a.wait === true && typeof a.interval === "number" && a.interval < 1) return INBOX_WAIT_WHOLE_SECONDS;
      return undefined;
    },
  },
  {
    name: "handoff_outbox",
    description: "list the Handoffs the resolved sender sent",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: {
      currentWorkspace: { type: "boolean" },
      state: { type: "string" },
      sender: { type: "string" },
      recipient: { type: "string" },
      updatedSince: { type: "string" },
      updatedUntil: { type: "string" },
      includeArchived: { type: "boolean" },
      includeDeleted: { type: "boolean" },
      limit: { type: "integer" },
      cursor: { type: "string" },
    },
    inputSchema: {
      type: "object",
      properties: {
        currentWorkspace: { type: "boolean" },
        state: { type: "string" },
        sender: { type: "string" },
        recipient: { type: "string" },
        updatedSince: { type: "string" },
        updatedUntil: { type: "string" },
        includeArchived: { type: "boolean" },
        includeDeleted: { type: "boolean" },
        limit: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        cursor: { type: "string" },
      },
    },
    argv: optionsArgv(
      ["outbox"],
      [
        { property: "currentWorkspace", flag: "--current-workspace", form: "flag" },
        { property: "state", flag: "--state", form: "pair" },
        { property: "sender", flag: "--sender", form: "pair" },
        { property: "recipient", flag: "--recipient", form: "pair" },
        { property: "updatedSince", flag: "--updated-since", form: "pair" },
        { property: "updatedUntil", flag: "--updated-until", form: "pair" },
        { property: "includeArchived", flag: "--include-archived", form: "flag" },
        { property: "includeDeleted", flag: "--include-deleted", form: "flag" },
        { property: "limit", flag: "--limit", form: "pair" },
        { property: "cursor", flag: "--cursor", form: "pair" },
      ],
      () => [],
    ),
    guard: () => undefined,
  },
  {
    name: "handoff_get",
    description: "read one Handoff's metadata; records nothing",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: { handoffId: { type: "string" } },
    inputSchema: { type: "object", properties: { handoffId: { type: "string" } }, required: ["handoffId"] },
    argv: optionsArgv(["get"], [], (a) => [String(a.handoffId)]),
    guard: () => undefined,
  },
  {
    name: "handoff_events",
    description: "read the bounded recent metadata timeline; records nothing",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: { handoffId: { type: "string" } },
    inputSchema: { type: "object", properties: { handoffId: { type: "string" } }, required: ["handoffId"] },
    argv: optionsArgv(["events"], [], (a) => [String(a.handoffId)]),
    guard: () => undefined,
  },
  {
    name: "handoff_fetch",
    description: "read the current Artifact's metadata and local path; the recipient's first fetch is recorded",
    annotations: WRITE,
    mirrorsIntegerBounds: true,
    properties: { handoffId: { type: "string" } },
    inputSchema: { type: "object", properties: { handoffId: { type: "string" } }, required: ["handoffId"] },
    argv: optionsArgv(["fetch"], [], (a) => [String(a.handoffId)]),
    guard: () => undefined,
  },
  {
    name: "handoff_review_show",
    description: "read the current Review Note; records nothing",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: { handoffId: { type: "string" } },
    inputSchema: { type: "object", properties: { handoffId: { type: "string" } }, required: ["handoffId"] },
    argv: optionsArgv(["review", "show"], [], (a) => [String(a.handoffId)]),
    guard: () => undefined,
  },
  ...handoffReportingTools(),
  {
    name: "handoff_review_set",
    description: "create or update this Handoff's Review Note as the recipient or the User",
    annotations: WRITE,
    mirrorsIntegerBounds: true,
    properties: {
      handoffId: { type: "string" },
      text: { type: "string" },
      file: { type: "string" },
      targetRevision: { type: "integer" },
      expectedRowVersion: { type: "integer" },
    },
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string" },
        text: { type: "string" },
        file: { type: "string" },
        targetRevision: { type: "integer", minimum: 1, maximum: 9007199254740991 },
        expectedRowVersion: { type: "integer", minimum: 1, maximum: 9007199254740991 },
      },
      required: ["handoffId", "targetRevision", "expectedRowVersion"],
      oneOf: [{ required: ["text"] }, { required: ["file"] }],
    },
    argv: optionsArgv(
      ["review", "set"],
      [
        { property: "text", flag: "--text", form: "pair" },
        { property: "file", flag: "--file", form: "pair" },
        { property: "targetRevision", flag: "--target-revision", form: "pair" },
        { property: "expectedRowVersion", flag: "--expected-row-version", form: "pair" },
      ],
      (a) => [String(a.handoffId)],
    ),
    guard: (a) => {
      if (a.targetRevision === undefined) return requiredOptionSentence("--target-revision <n>");
      if (a.expectedRowVersion === undefined) return "this command requires --expected-row-version";
      return (a.text !== undefined) === (a.file !== undefined) ? REVIEW_SET_ONE_SOURCE : undefined;
    },
  },
  {
    name: "handoff_review_withdraw",
    description: "withdraw this Handoff's current Review Note as the recipient, whichever actor authored it",
    annotations: WRITE,
    mirrorsIntegerBounds: true,
    properties: { handoffId: { type: "string" }, expectedRowVersion: { type: "integer" } },
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string" },
        expectedRowVersion: { type: "integer", minimum: 1, maximum: 9007199254740991 },
      },
      required: ["handoffId", "expectedRowVersion"],
    },
    argv: optionsArgv(
      ["review", "withdraw"],
      [{ property: "expectedRowVersion", flag: "--expected-row-version", form: "pair" }],
      (a) => [String(a.handoffId)],
    ),
    guard: (a) => (a.expectedRowVersion === undefined ? "this command requires --expected-row-version" : undefined),
  },
  {
    name: "handoff_revise",
    description:
      "replace the current Artifact or resolve the Review Note; expectedRowVersion is required for fresh mutation and optional only for successful recorded replay",
    annotations: WRITE,
    mirrorsIntegerBounds: true,
    properties: {
      handoffId: { type: "string" },
      body: { type: "string" },
      file: { type: "string" },
      noChange: { type: "boolean" },
      reason: { type: "string" },
      expectedRowVersion: { type: "integer" },
      idempotencyKey: { type: "string" },
    },
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string" },
        body: { type: "string" },
        file: { type: "string" },
        noChange: { type: "boolean" },
        reason: { type: "string" },
        expectedRowVersion: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        idempotencyKey: { type: "string" },
      },
      required: ["handoffId"],
      oneOf: [
        { required: ["body"] },
        { required: ["file"] },
        { required: ["noChange"], properties: { noChange: { const: true } } },
      ],
      allOf: [
        {
          if: { required: ["noChange"], properties: { noChange: { const: true } } },
          // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
          then: { required: ["reason"] },
        },
        {
          if: { required: ["reason"] },
          // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
          then: { required: ["noChange"], properties: { noChange: { const: true } } },
        },
      ] satisfies Array<Record<string, unknown>>,
    },
    argv: optionsArgv(
      ["revise"],
      [
        { property: "body", flag: "--body", form: "pair" },
        { property: "file", flag: "--file", form: "pair" },
        { property: "noChange", flag: "--no-change", form: "flag" },
        { property: "reason", flag: "--reason", form: "pair" },
        { property: "expectedRowVersion", flag: "--expected-row-version", form: "pair" },
        { property: "idempotencyKey", flag: "--idempotency-key", form: "pair" },
      ],
      (a) => [String(a.handoffId)],
    ),
    guard: (a) => {
      const supplied = [a.body !== undefined, a.file !== undefined, a.noChange === true].filter(Boolean).length;
      if (supplied !== 1) return REVISE_ONE_SOURCE;
      if (a.body !== undefined && String(a.body).trim() === "") return BODY_MUST_NOT_BE_EMPTY;
      return undefined;
    },
  },
  {
    name: "handoff_accept",
    description: "accept the exact Revision as the recipient, closing the exchange",
    annotations: WRITE,
    mirrorsIntegerBounds: true,
    properties: {
      handoffId: { type: "string" },
      expectedRevision: { type: "integer" },
      expectedRowVersion: { type: "integer" },
    },
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        expectedRowVersion: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      },
      required: ["handoffId", "expectedRevision", "expectedRowVersion"],
    },
    argv: optionsArgv(
      ["accept"],
      [
        { property: "expectedRevision", flag: "--expected-revision", form: "pair" },
        { property: "expectedRowVersion", flag: "--expected-row-version", form: "pair" },
      ],
      (a) => [String(a.handoffId)],
    ),
    guard: (a) => {
      if (a.expectedRevision === undefined) return requiredOptionSentence("--expected-revision <n>");
      if (a.expectedRowVersion === undefined) return ACCEPT_REQUIRES_ROW_VERSION;
      return undefined;
    },
  },
  {
    name: "handoff_decline",
    description: "decline the Handoff as the recipient with a recorded reason",
    annotations: DESTRUCTIVE,
    mirrorsIntegerBounds: true,
    properties: { handoffId: { type: "string" }, reason: { type: "string" }, expectedRowVersion: { type: "integer" } },
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string" },
        reason: { type: "string" },
        expectedRowVersion: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      },
      required: ["handoffId", "reason", "expectedRowVersion"],
    },
    argv: optionsArgv(
      ["decline"],
      [
        { property: "reason", flag: "--reason", form: "pair" },
        { property: "expectedRowVersion", flag: "--expected-row-version", form: "pair" },
      ],
      (a) => [String(a.handoffId)],
    ),
    guard: (a) => {
      if (a.reason === undefined) return requiredOptionSentence("--reason <text>");
      if (a.expectedRowVersion === undefined) return DECLINE_REQUIRES_ROW_VERSION;
      return undefined;
    },
  },
  {
    name: "handoff_withdraw",
    description: "withdraw the Handoff as the sender before the recipient has engaged",
    annotations: DESTRUCTIVE,
    mirrorsIntegerBounds: true,
    properties: { handoffId: { type: "string" }, expectedRowVersion: { type: "integer" } },
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string" },
        expectedRowVersion: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      },
      required: ["handoffId"],
    },
    argv: optionsArgv(
      ["withdraw"],
      [{ property: "expectedRowVersion", flag: "--expected-row-version", form: "pair" }],
      (a) => [String(a.handoffId)],
    ),
    guard: () => undefined,
  },
];

function pair(a: Record<string, unknown>, property: string, flag: string): string[] {
  const value = a[property];
  return value === undefined ? [] : [flag, String(value)];
}

function flag(a: Record<string, unknown>, property: string, option: string): string[] {
  return a[property] === true ? [option] : [];
}

/** New reporting tools encode only the public CLI and preserve its parser/application refusal split. */
function handoffReportingTools(): McpTool[] {
  return (["comment_show", "comment_set", "processing_start", "processing_complete"] as const).map((operation) => {
    const show = operation === "comment_show";
    const set = operation === "comment_set";
    const properties: Record<string, PropertySpec> = { handoffId: { type: "string" } };
    const schemaProperties: Record<string, unknown> = { handoffId: { type: "string" } };
    const mappings: OptionMapping[] = [];
    if (!show) {
      for (const [property, flag] of [
        ["expectedRevision", "--expected-revision"],
        ["expectedRowVersion", "--expected-row-version"],
      ] as const) {
        properties[property] = { type: "integer" };
        schemaProperties[property] = { type: "integer", minimum: 1, maximum: 9007199254740991 };
        mappings.push({ property, flag, form: "pair" });
      }
      const sources: Array<[string, string]> = set
        ? [
            ["text", "--text"],
            ["file", "--file"],
            ["purpose", "--purpose"],
          ]
        : [
            ["commentText", "--comment-text"],
            ["commentFile", "--comment-file"],
          ];
      for (const [property, flag] of sources) {
        properties[property] = { type: "string" };
        schemaProperties[property] =
          property === "purpose"
            ? { type: "string", enum: ["general", "change_request"], default: "general" }
            : { type: "string" };
        mappings.push({ property, flag, form: "pair" });
      }
    }
    return {
      name: `handoff_${operation}`,
      description: show
        ? "read the retained recipient comment; records nothing"
        : set
          ? "replace the recipient comment using the observed document and Row Version"
          : `${operation === "processing_start" ? "start" : "complete"} processing with an optional general comment`,
      annotations: show ? READ : WRITE,
      mirrorsIntegerBounds: true,
      properties,
      inputSchema: {
        type: "object",
        properties: schemaProperties,
        required: show ? ["handoffId"] : ["handoffId", "expectedRevision", "expectedRowVersion"],
        ...(set
          ? { oneOf: [{ required: ["text"] }, { required: ["file"] }] }
          : show
            ? {}
            : { not: { required: ["commentText", "commentFile"] } }),
      },
      argv: optionsArgv(operation.split("_"), mappings, (a) => [String(a.handoffId)]),
      guard: (a) => {
        if (show) return undefined;
        if (a.expectedRevision === undefined) return requiredOptionSentence("--expected-revision <n>");
        if (set)
          return a.expectedRowVersion === undefined || (a.text !== undefined) === (a.file !== undefined)
            ? "comment set requires one --text/--file source and --expected-row-version"
            : undefined;
        return a.expectedRowVersion === undefined || (a.commentText !== undefined && a.commentFile !== undefined)
          ? "processing requires --expected-row-version and at most one comment source"
          : undefined;
      },
    };
  });
}

const MEMO_TOOLS: McpTool[] = [
  {
    name: "memo_list",
    description: "list Project Memos, open by default",
    annotations: READ,
    mirrorsIntegerBounds: false,
    properties: {
      project: { type: "string" },
      allProjects: { type: "boolean" },
      state: { type: "string" },
      query: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "integer" },
    },
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        allProjects: { type: "boolean" },
        state: { type: "string", enum: ["open", "done", "dismissed", "all"], default: "open" },
        query: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      },
      allOf: [
        {
          if: { required: ["project"], properties: { allProjects: { const: true } } },
          // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
          then: { not: { required: ["allProjects"], properties: { allProjects: { const: true } } } },
        },
      ] satisfies Array<Record<string, unknown>>,
    },
    argv: optionsArgv(
      ["memo", "list"],
      [
        { property: "project", flag: "--project", form: "pair" },
        { property: "allProjects", flag: "--all-projects", form: "flag" },
        { property: "state", flag: "--state", form: "pair" },
        { property: "query", flag: "--query", form: "pair" },
        { property: "cursor", flag: "--cursor", form: "pair" },
        { property: "limit", flag: "--limit", form: "pair" },
      ],
      () => [],
    ),
    guard: () => undefined,
  },
  {
    name: "memo_show",
    description: "show one complete Memo",
    annotations: READ,
    mirrorsIntegerBounds: false,
    properties: { memoId: { type: "string" }, project: { type: "string" } },
    inputSchema: {
      type: "object",
      properties: { memoId: { type: "string" }, project: { type: "string" } },
      required: ["memoId"],
    },
    argv: optionsArgv(["memo", "show"], [{ property: "project", flag: "--project", form: "pair" }], (a) => [
      String(a.memoId),
    ]),
    guard: () => undefined,
  },
  ...(["add", "update", "done", "dismiss", "reopen"] as const).map((operation) => memoMutationTool(operation)),
];

function memoMutationTool(operation: "add" | "update" | "done" | "dismiss" | "reopen"): McpTool {
  const descriptions = {
    add: "record an open Memo",
    update: "edit an open Memo at its observed Row Version",
    done: "mark a Memo handled",
    dismiss: "dismiss a Memo without claiming work was done",
    reopen: "reopen a closed Memo without executing its content",
  } as const;
  const properties: Record<string, PropertySpec> = {
    idempotencyKey: { type: "string" },
    replayOnly: { type: "boolean" },
  };
  const schemaProperties: Record<string, unknown> = {
    idempotencyKey: { type: "string" },
    replayOnly: { type: "boolean" },
  };
  if (operation === "add" || operation === "update") {
    properties.title = { type: "string" };
    properties.body = { type: "string" };
    properties.bodyFile = { type: "string" };
    schemaProperties.title = { type: "string" };
    schemaProperties.body = { type: "string" };
    schemaProperties.bodyFile = { type: "string" };
  }
  if (operation !== "add") {
    properties.memoId = { type: "string" };
    properties.expectedRowVersion = { type: "integer" };
    schemaProperties.memoId = { type: "string" };
    schemaProperties.expectedRowVersion = { type: "integer", minimum: 0, maximum: 9007199254740991 };
  }
  properties.project = { type: "string" };
  schemaProperties.project = { type: "string" };
  const mappings: OptionMapping[] = [
    { property: "title", flag: "--title", form: "pair" },
    { property: "body", flag: "--body", form: "pair" },
    { property: "bodyFile", flag: "--body-file", form: "pair" },
    { property: "expectedRowVersion", flag: "--expected-row-version", form: "pair" },
    { property: "project", flag: "--project", form: "pair" },
    { property: "idempotencyKey", flag: "--idempotency-key", form: "pair" },
    { property: "replayOnly", flag: "--replay-only", form: "flag" },
  ];
  return {
    name: `memo_${operation}`,
    description: descriptions[operation],
    annotations: WRITE,
    mirrorsIntegerBounds: false,
    properties,
    inputSchema:
      operation === "add"
        ? {
            type: "object",
            properties: schemaProperties,
            required: ["title"],
            allOf: [{ not: { allOf: [{ required: ["body"] }, { required: ["bodyFile"] }] } }, REPLAY_ONLY_WITH_KEY],
          }
        : {
            type: "object",
            properties: schemaProperties,
            required: ["memoId", "expectedRowVersion"],
            allOf: [
              // The body-source exclusion and the at-least-one rule exist only
              // where the command declares the body properties (EE nit 1).
              ...(operation === "update"
                ? [
                    { not: { allOf: [{ required: ["body"] }, { required: ["bodyFile"] }] } },
                    { anyOf: [{ required: ["title"] }, { required: ["body"] }, { required: ["bodyFile"] }] },
                  ]
                : []),
              REPLAY_ONLY_WITH_KEY,
            ],
          },
    argv:
      operation === "add"
        ? optionsArgv(["memo", "add"], mappings, () => [])
        : optionsArgv(["memo", operation], mappings, (a) => [String(a.memoId)]),
    // Every cross-field rule of the Memo CLI answers coded (MEMO_INVALID_INPUT),
    // so no layer-2 guard exists and every refusal flows to the child.
    guard: () => undefined,
  };
}

const CHANNEL_TOOLS: McpTool[] = [
  {
    name: "channel_create",
    description: "create an open Channel with its single main participant",
    annotations: IDEMPOTENT,
    mirrorsIntegerBounds: true,
    properties: { name: { type: "string" }, title: { type: "string" }, main: { type: "string" } },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        main: { type: "string", default: "main" },
      },
      required: ["name"],
    },
    argv: optionsArgv(
      ["channel", "create"],
      [
        { property: "title", flag: "--title", form: "pair" },
        { property: "main", flag: "--main", form: "pair" },
      ],
      (a) => [String(a.name)],
    ),
    guard: () => undefined,
  },
  {
    name: "channel_add",
    description: "register a worker or judge participant on an open Channel",
    annotations: IDEMPOTENT,
    mirrorsIntegerBounds: true,
    properties: { channel: { type: "string" }, handle: { type: "string" }, role: { type: "string" } },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        handle: { type: "string" },
        role: { type: "string", enum: ["worker", "judge"] },
      },
      required: ["channel", "handle", "role"],
    },
    argv: optionsArgv(["channel", "add"], [{ property: "role", flag: "--role", form: "pair" }], (a) => [
      String(a.channel),
      String(a.handle),
    ]),
    // A bad role value is the CLI's own coded CHN_INVALID_INPUT; only its
    // absence mirrors the parser's required-option exit 2.
    guard: (a) => (a.role === undefined ? requiredOptionSentence("--role <role>") : undefined),
  },
  {
    name: "channel_remove",
    description: "remove a participant idempotently; reversible by re-adding the handle",
    annotations: IDEMPOTENT,
    mirrorsIntegerBounds: true,
    properties: { channel: { type: "string" }, handle: { type: "string" } },
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, handle: { type: "string" } },
      required: ["channel", "handle"],
    },
    argv: optionsArgv(["channel", "remove"], [], (a) => [String(a.channel), String(a.handle)]),
    guard: () => undefined,
  },
  {
    name: "channel_post",
    description: "post one attributed message upstream through the shared content interface",
    annotations: WRITE,
    mirrorsIntegerBounds: true,
    properties: {
      channel: { type: "string" },
      from: { type: "string" },
      kind: { type: "string" },
      body: { type: "string" },
      bodyFile: { type: "string" },
      to: { type: "string" },
      ref: { type: "string" },
    },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        from: { type: "string" },
        kind: { type: "string", enum: KINDS },
        body: { type: "string" },
        bodyFile: { type: "string" },
        to: { type: "string" },
        ref: { type: "string" },
      },
      required: ["channel", "from", "kind"],
      oneOf: [{ required: ["body"] }, { required: ["bodyFile"] }],
      allOf: [
        {
          if: { required: ["kind"], properties: { kind: { const: "relay_request" } } },
          // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
          then: { required: ["to"] },
        },
        {
          if: { not: { required: ["kind"], properties: { kind: { const: "relay_request" } } } },
          // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
          then: { not: { required: ["to"] } },
        },
      ] satisfies Array<Record<string, unknown>>,
    },
    argv: optionsArgv(
      ["channel", "post"],
      [
        { property: "from", flag: "--from", form: "pair" },
        { property: "kind", flag: "--kind", form: "pair" },
        { property: "body", flag: "--body", form: "pair" },
        { property: "bodyFile", flag: "--body-file", form: "pair" },
        { property: "to", flag: "--to", form: "pair" },
        { property: "ref", flag: "--ref", form: "pair" },
      ],
      (a) => [String(a.channel)],
    ),
    guard: (a) => {
      if (a.from === undefined) return requiredOptionSentence("--from <handle>");
      if (a.kind === undefined) return requiredOptionSentence("--kind <kind>");
      if (!KINDS.includes(String(a.kind))) return KIND_CHOICES;
      return undefined;
    },
  },
  {
    name: "channel_messages",
    description: "list messages with full inline bodies; unhandled oldest first by default",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: {
      channel: { type: "string" },
      all: { type: "boolean" },
      after: { type: "integer" },
      from: { type: "string" },
      kind: { type: "string" },
      limit: { type: "integer" },
      wait: { type: "boolean" },
      timeout: { type: "integer" },
      interval: { type: "integer" },
    },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        all: { type: "boolean", default: false },
        after: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        from: { type: "string" },
        kind: { type: "string", enum: KINDS },
        limit: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        wait: { type: "boolean", default: false },
        timeout: { type: "integer", minimum: 0, maximum: 9007199254740991, default: 30 },
        interval: { type: "integer", minimum: 0, maximum: 9007199254740991, default: 2 },
      },
      required: ["channel"],
    },
    argv: (a) => {
      const argv = [
        "channel",
        "messages",
        ...flag(a, "all", "--all"),
        ...pair(a, "after", "--after"),
        ...pair(a, "from", "--from"),
        ...pair(a, "kind", "--kind"),
        ...pair(a, "limit", "--limit"),
      ];
      if (a.wait === true) {
        argv.push("--wait", "--timeout", String(a.timeout ?? 30), "--interval", String(a.interval ?? 2));
      }
      argv.push("--json", "--", String(a.channel));
      return argv;
    },
    guard: (a) => {
      if (a.kind !== undefined && !KINDS.includes(String(a.kind))) return KIND_CHOICES;
      if (a.wait === true && a.all === true) return CHANNEL_WAIT_UNHANDLED_ONLY;
      if (a.wait === true && typeof a.interval === "number" && a.interval < 1) return CHANNEL_WAIT_WHOLE_SECONDS;
      if (a.wait !== true && (a.timeout !== undefined || a.interval !== undefined)) return CHANNEL_WAIT_ONLY_OPTIONS;
      return undefined;
    },
  },
  {
    name: "channel_ack",
    description: "record the User handling decision for the named messages",
    annotations: IDEMPOTENT,
    mirrorsIntegerBounds: true,
    properties: { channel: { type: "string" }, seq: { type: "integerArray" }, note: { type: "string" } },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        seq: { type: "array", items: { type: "integer", minimum: 1, maximum: 9007199254740991 }, minItems: 1 },
        note: { type: "string" },
      },
      required: ["channel", "seq"],
    },
    argv: optionsArgv(["channel", "ack"], [{ property: "note", flag: "--note", form: "pair" }], (a) => [
      String(a.channel),
      ...(a.seq as number[]).map((seq) => String(seq)),
    ]),
    // An absent or empty seq is the required variadic missing (the generic
    // positional check); a seq item below 1 or above the safe range is the
    // CLI's coded CHN_INVALID_INPUT and flows to the child.
    guard: () => undefined,
  },
  {
    name: "channel_close",
    description: "terminal idempotent close; freezes posting, keeps reads and acks",
    annotations: CLOSE,
    mirrorsIntegerBounds: true,
    properties: { channel: { type: "string" } },
    inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
    argv: optionsArgv(["channel", "close"], [], (a) => [String(a.channel)]),
    guard: () => undefined,
  },
  {
    name: "channel_list",
    description: "list Channels with both identifiers",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: { state: { type: "string" } },
    inputSchema: {
      type: "object",
      properties: { state: { type: "string", enum: ["open", "closed", "all"], default: "all" } },
    },
    argv: optionsArgv(["channel", "list"], [{ property: "state", flag: "--state", form: "pair" }], () => []),
    guard: () => undefined,
  },
  {
    name: "channel_show",
    description: "show one Channel with its complete participant roster and counts",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: { channel: { type: "string" } },
    inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
    argv: optionsArgv(["channel", "show"], [], (a) => [String(a.channel)]),
    guard: () => undefined,
  },
];

const PROJECT_TOOLS: McpTool[] = [
  {
    name: "project_list",
    description: "list every Project with its binding count, flagging unbound Projects",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: {},
    inputSchema: { type: "object", properties: {} },
    argv: optionsArgv(["project", "list"], [], () => []),
    guard: () => undefined,
  },
  {
    name: "project_show",
    description: "show one Project with every binding, its counts, and its lifecycle state",
    annotations: READ,
    mirrorsIntegerBounds: true,
    properties: { project: { type: "string" } },
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    argv: optionsArgv(["project", "show"], [], (a) => [String(a.project)]),
    guard: () => undefined,
  },
];

/** The catalogue in section 39's order: 17 Handoff, 7 Memo, 9 Channel, 2 Project. */
export const MCP_TOOLS: readonly McpTool[] = [...HANDOFF_TOOLS, ...MEMO_TOOLS, ...CHANNEL_TOOLS, ...PROJECT_TOOLS];

export function mcpToolByName(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

const HANDOFF_ID = [{ property: "handoffId", argument: "handoff-id" }] as const;
const MEMO_ID = [{ property: "memoId", argument: "id" }] as const;
const CHANNEL_REF = [{ property: "channel", argument: "channel" }] as const;

/**
 * The positional argument every command declares, with commander's own
 * argument names: admission layer 2 refuses an absent positional (an empty
 * `seq` array counts as absent) with commander's missing-argument sentence,
 * so no builder ever stringifies `undefined` into an operand.
 */
const REQUIRED_POSITIONALS: Record<string, ReadonlyArray<{ property: string; argument: string }>> = {
  handoff_get: HANDOFF_ID,
  handoff_events: HANDOFF_ID,
  handoff_fetch: HANDOFF_ID,
  handoff_review_show: HANDOFF_ID,
  handoff_comment_show: HANDOFF_ID,
  handoff_comment_set: HANDOFF_ID,
  handoff_processing_start: HANDOFF_ID,
  handoff_processing_complete: HANDOFF_ID,
  handoff_review_set: HANDOFF_ID,
  handoff_review_withdraw: HANDOFF_ID,
  handoff_revise: HANDOFF_ID,
  handoff_accept: HANDOFF_ID,
  handoff_decline: HANDOFF_ID,
  handoff_withdraw: HANDOFF_ID,
  memo_show: MEMO_ID,
  memo_update: [...MEMO_ID],
  memo_done: MEMO_ID,
  memo_dismiss: MEMO_ID,
  memo_reopen: MEMO_ID,
  channel_create: [{ property: "name", argument: "name" }],
  channel_add: [...CHANNEL_REF, { property: "handle", argument: "handle" }],
  channel_remove: [...CHANNEL_REF, { property: "handle", argument: "handle" }],
  channel_post: CHANNEL_REF,
  channel_messages: CHANNEL_REF,
  channel_ack: [...CHANNEL_REF, { property: "seq", argument: "seq..." }],
  channel_close: CHANNEL_REF,
  channel_show: CHANNEL_REF,
  project_show: [{ property: "project", argument: "project" }],
};

function requiredPositionalsOf(name: string): ReadonlyArray<{ property: string; argument: string }> {
  return REQUIRED_POSITIONALS[name] ?? [];
}

export interface ArgumentsAdmission {
  ok: boolean;
  /** The shared usage sentence on a layer-2 refusal, or the encodability reason on a layer-1 refusal. */
  message?: string;
  argv?: string[];
}

function encodableString(value: string): boolean {
  return !value.includes("\0") && isUtf8ExactText(value);
}

/**
 * Admits a `tools/call`'s arguments for one tool: layer 1 (encodability — the
 * JSON types and array item types of the pinned contract, unknown properties,
 * NUL and lone surrogates) then layer 2 (the mirrored exit-2 class: the
 * parser's integer bounds on Handoff and Channel tools, then the tool's own
 * guard sentences). Everything else — a count rule, a coded cross-field rule —
 * passes through to the child, exactly as section 39's clarification fixes.
 */
export function admitArguments(tool: McpTool, rawArguments: unknown): ArgumentsAdmission {
  if (rawArguments === undefined || rawArguments === null) rawArguments = {};
  if (typeof rawArguments !== "object" || Array.isArray(rawArguments)) {
    return { ok: false, message: "arguments must be an object" };
  }
  const arguments_ = rawArguments as Record<string, unknown>;
  for (const key of Object.keys(arguments_)) {
    if (key !== "cwd" && !Object.hasOwn(tool.properties, key))
      return { ok: false, message: `unknown property '${key}'` };
  }
  for (const [property, spec] of Object.entries(tool.properties)) {
    const value = arguments_[property];
    if (value === undefined) continue;
    const encodable = encodableValue(spec.type, value);
    if (encodable !== undefined) return { ok: false, message: encodable };
    if (
      tool.mirrorsIntegerBounds &&
      spec.type === "integer" &&
      typeof value === "number" &&
      (value < 0 || !Number.isSafeInteger(value))
    ) {
      return { ok: false, message: NON_NEGATIVE_INTEGER };
    }
  }
  for (const required of requiredPositionalsOf(tool.name)) {
    const value = arguments_[required.property];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      return { ok: false, message: requiredArgumentSentence(required.argument) };
    }
  }
  const sentence = tool.guard(arguments_);
  if (sentence !== undefined) return { ok: false, message: sentence };
  // An expected refusal is a returned value. An unexpected builder exception
  // is not a judgement about the arguments at all — it is a server fault, so
  // it propagates to the tools/call dispatch's rejection handler, which
  // answers the synthesized INTERNAL_ERROR envelope (the crash row) while the
  // server keeps serving (c2-decision item 1).
  return { ok: true, argv: tool.argv(arguments_) };
}

function encodableValue(type: PropertyType, value: unknown): string | undefined {
  switch (type) {
    case "string":
      if (typeof value !== "string") return "expected a string";
      return encodableString(value) ? undefined : "strings must not contain NUL or an unpaired surrogate";
    case "integer":
      // Integrality is encodability; the parser's bounds are layer 2 on the
      // non-Memo option tools and the coded numeric refusals flow to the child.
      if (typeof value !== "number" || !Number.isInteger(value)) return "expected an integer";
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected a boolean";
    case "stringArray": {
      if (!Array.isArray(value)) return "expected an array of strings";
      for (const item of value) {
        if (typeof item !== "string") return "expected an array of strings";
        if (!encodableString(item)) return "strings must not contain NUL or an unpaired surrogate";
      }
      return undefined;
    }
    case "integerArray": {
      if (!Array.isArray(value)) return "expected an array of integers";
      for (const item of value) {
        if (typeof item !== "number" || !Number.isInteger(item)) return "expected an array of integers";
      }
      return undefined;
    }
  }
}
