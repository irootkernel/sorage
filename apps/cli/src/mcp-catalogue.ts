import { EXCHANGE_POLL_SECONDS, EXCHANGE_READ_BYTES, EXCHANGE_WAIT_SECONDS, isUtf8ExactText } from "@sorage/core";
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

interface McpOptionSpec extends OptionMapping {
  type: PropertyType;
  schema?: Record<string, unknown>;
  /** `true` marks schema-required; a placeholder string also names the CLI option for required-option guards. */
  required?: boolean | string;
  /** When true, integer schemas place `maximum` before `schema` keys (Exchange golden order). */
  maxFirst?: boolean;
}

interface McpPositionalSpec {
  property: string;
  argument: string;
  type?: PropertyType;
  schema?: Record<string, unknown>;
  optional?: boolean;
  /** When true, missing positional enforcement stays in `tool.guard` rather than pre-guard `REQUIRED_POSITIONALS`. */
  guardOrder?: boolean;
}

interface McpToolSpec {
  name: string;
  description: string;
  annotations: McpToolAnnotations;
  mirrorsIntegerBounds: boolean;
  command: string[];
  options?: McpOptionSpec[];
  positionals?: McpPositionalSpec[];
  /** Explicit `properties`/`inputSchema.properties` key order when it differs from `[...positionals, ...options]`. */
  propertyOrder?: string[];
  /** Additional schema-required properties beyond non-optional positionals and required options. */
  required?: string[];
  /** Emit `required: []` even when empty (Exchange golden shape). */
  emitEmptyRequired?: boolean;
  /** Optional JSON Schema combinators (`oneOf`, `allOf`, `not`). */
  extra?: Record<string, unknown>;
  argv?: (arguments_: Record<string, unknown>) => string[];
  guard?: (arguments_: Record<string, unknown>) => string | undefined;
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

/** Internal communication is available in Plan mode (interface section 39).
 * Broker persistence is not caller workspace write authority. */
const COMMUNICATION: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const IDEMPOTENT_COMMUNICATION: McpToolAnnotations = {
  ...COMMUNICATION,
  idempotentHint: true,
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

const DERIVED_REQUIRED_POSITIONALS = new Map<string, ReadonlyArray<{ property: string; argument: string }>>();

function optionSchema(option: McpOptionSpec): Record<string, unknown> {
  if (option.maxFirst) {
    return {
      type: option.type,
      ...(option.type === "integer" ? { maximum: Number.MAX_SAFE_INTEGER } : {}),
      ...option.schema,
    };
  }
  if (option.schema !== undefined) {
    return "type" in option.schema ? option.schema : { type: option.type, ...option.schema };
  }
  if (option.type === "stringArray") {
    return { type: "array", items: { type: "string" }, minItems: 1 };
  }
  if (option.type === "integerArray") {
    return { type: "array", items: { type: "integer" }, minItems: 1 };
  }
  return { type: option.type };
}

function positionalSchema(positional: McpPositionalSpec): Record<string, unknown> {
  const type = positional.type ?? "string";
  if (positional.schema !== undefined) {
    return "type" in positional.schema ? positional.schema : { type, ...positional.schema };
  }
  return { type };
}

/**
 * Derives a tool's `properties`, `inputSchema`, `argv`, `guard`, and pre-guard
 * required-positional metadata from one declarative specification while preserving
 * exact MCP-005 golden key order and CLI parser admission precedence.
 */
function defineMcpTool(spec: McpToolSpec): McpTool {
  const positionals = spec.positionals ?? [];
  const options = spec.options ?? [];
  const entries = new Map<string, { type: PropertyType; schema: Record<string, unknown> }>();
  for (const positional of positionals) {
    entries.set(positional.property, {
      type: positional.type ?? "string",
      schema: positionalSchema(positional),
    });
  }
  for (const option of options) {
    entries.set(option.property, {
      type: option.type,
      schema: optionSchema(option),
    });
  }
  const orderedKeys = spec.propertyOrder ?? [
    ...positionals.map(({ property }) => property),
    ...options.map(({ property }) => property),
  ];
  const properties: Record<string, PropertySpec> = {};
  const schemaProperties: Record<string, unknown> = {};
  for (const key of orderedKeys) {
    const entry = entries.get(key);
    if (entry === undefined) throw new Error(`MCP tool ${spec.name} references unknown property ${key}`);
    properties[key] = { type: entry.type };
    schemaProperties[key] = entry.schema;
  }
  const required = [
    ...positionals.filter((p) => !p.optional).map((p) => p.property),
    ...options.filter((o) => o.required !== undefined && o.required !== false).map((o) => o.property),
    ...(spec.required ?? []),
  ];
  const inputSchema: Record<string, unknown> = {
    type: "object",
    properties: schemaProperties,
    ...(required.length > 0 || spec.emitEmptyRequired ? { required } : {}),
    ...spec.extra,
  };
  const preGuardPositionals = positionals
    .filter((p) => !p.optional && !p.guardOrder)
    .map(({ property, argument }) => ({ property, argument }));
  if (preGuardPositionals.length > 0) {
    DERIVED_REQUIRED_POSITIONALS.set(spec.name, preGuardPositionals);
  }
  return {
    name: spec.name,
    description: spec.description,
    annotations: spec.annotations,
    mirrorsIntegerBounds: spec.mirrorsIntegerBounds,
    properties,
    inputSchema,
    argv:
      spec.argv ??
      optionsArgv(spec.command, options, (arguments_) =>
        positionals.flatMap(({ property }) => {
          const value = arguments_[property];
          if (value === undefined) return [];
          return Array.isArray(value) ? value.map((item) => String(item)) : [String(value)];
        }),
      ),
    guard: spec.guard ?? (() => undefined),
  };
}

const NON_NEGATIVE_SAFE_INT = { type: "integer", minimum: 0, maximum: 9007199254740991 };
const POSITIVE_SAFE_INT = { type: "integer", minimum: 1, maximum: 9007199254740991 };
const HANDOFF_ID_POSITIONAL: McpPositionalSpec = { property: "handoffId", argument: "handoff-id" };

const HANDOFF_TOOLS: McpTool[] = [
  defineMcpTool({
    name: "handoff_send",
    description: "hand one current document to one or more recipient Projects, one Handoff each",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["send"],
    options: [
      { property: "to", flag: "--to", form: "repeat", type: "stringArray", required: true },
      { property: "title", flag: "--title", form: "pair", type: "string", required: true },
      { property: "body", flag: "--body", form: "pair", type: "string" },
      { property: "file", flag: "--file", form: "pair", type: "string" },
      { property: "supersedes", flag: "--supersedes", form: "pair", type: "string" },
      { property: "allowUnregistered", flag: "--allow-unregistered", form: "flag", type: "boolean" },
      { property: "idempotencyKey", flag: "--idempotency-key", form: "pair", type: "string" },
      { property: "replayOnly", flag: "--replay-only", form: "flag", type: "boolean" },
    ],
    extra: {
      oneOf: [{ required: ["body"] }, { required: ["file"] }],
      allOf: [REPLAY_ONLY_WITH_KEY],
    },
    guard: (a) => {
      if (a.title === undefined) return requiredOptionSentence("--title <title>");
      if ((a.body !== undefined) === (a.file !== undefined)) return SEND_TAKES_ONE_SOURCE;
      if (a.body !== undefined && String(a.body).trim() === "") return BODY_MUST_NOT_BE_EMPTY;
      if (a.replayOnly === true && (typeof a.idempotencyKey !== "string" || a.idempotencyKey.trim() === ""))
        return SEND_REPLAY_ONLY_KEY;
      return undefined;
    },
  }),
  defineMcpTool({
    name: "handoff_inbox",
    description: "list the Handoffs sent to the resolved recipient Project",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["inbox"],
    options: [
      { property: "state", flag: "--state", form: "pair", type: "string" },
      { property: "sender", flag: "--sender", form: "pair", type: "string" },
      { property: "recipient", flag: "--recipient", form: "pair", type: "string" },
      { property: "updatedSince", flag: "--updated-since", form: "pair", type: "string" },
      { property: "updatedUntil", flag: "--updated-until", form: "pair", type: "string" },
      { property: "includeArchived", flag: "--include-archived", form: "flag", type: "boolean" },
      { property: "includeDeleted", flag: "--include-deleted", form: "flag", type: "boolean" },
      { property: "limit", flag: "--limit", form: "pair", type: "integer", schema: NON_NEGATIVE_SAFE_INT },
      { property: "cursor", flag: "--cursor", form: "pair", type: "string" },
      { property: "wait", flag: "--wait", form: "flag", type: "boolean", schema: { type: "boolean", default: false } },
      {
        property: "timeout",
        flag: "--timeout",
        form: "pair",
        type: "integer",
        schema: { ...NON_NEGATIVE_SAFE_INT, default: 30 },
      },
      {
        property: "interval",
        flag: "--interval",
        form: "pair",
        type: "integer",
        schema: { ...NON_NEGATIVE_SAFE_INT, default: 2 },
      },
    ],
    extra: {
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
  }),
  defineMcpTool({
    name: "handoff_outbox",
    description: "list the Handoffs the resolved sender sent",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["outbox"],
    options: [
      { property: "currentWorkspace", flag: "--current-workspace", form: "flag", type: "boolean" },
      { property: "state", flag: "--state", form: "pair", type: "string" },
      { property: "sender", flag: "--sender", form: "pair", type: "string" },
      { property: "recipient", flag: "--recipient", form: "pair", type: "string" },
      { property: "updatedSince", flag: "--updated-since", form: "pair", type: "string" },
      { property: "updatedUntil", flag: "--updated-until", form: "pair", type: "string" },
      { property: "includeArchived", flag: "--include-archived", form: "flag", type: "boolean" },
      { property: "includeDeleted", flag: "--include-deleted", form: "flag", type: "boolean" },
      { property: "limit", flag: "--limit", form: "pair", type: "integer", schema: NON_NEGATIVE_SAFE_INT },
      { property: "cursor", flag: "--cursor", form: "pair", type: "string" },
    ],
  }),
  defineMcpTool({
    name: "handoff_get",
    description: "read one Handoff's metadata; records nothing",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["get"],
    positionals: [HANDOFF_ID_POSITIONAL],
  }),
  defineMcpTool({
    name: "handoff_events",
    description: "read the bounded recent metadata timeline; records nothing",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["events"],
    positionals: [HANDOFF_ID_POSITIONAL],
  }),
  defineMcpTool({
    name: "handoff_fetch",
    description:
      "read the current document's metadata and local path; does not edit the document, report processing or accept it",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["fetch"],
    positionals: [HANDOFF_ID_POSITIONAL],
  }),
  defineMcpTool({
    name: "handoff_review_show",
    description: "read the current Review Note; records nothing",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["review", "show"],
    positionals: [HANDOFF_ID_POSITIONAL],
  }),
  ...handoffReportingTools(),
  defineMcpTool({
    name: "handoff_review_set",
    description: "create or update this Handoff's Review Note as the recipient or the User",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["review", "set"],
    positionals: [HANDOFF_ID_POSITIONAL],
    options: [
      { property: "text", flag: "--text", form: "pair", type: "string" },
      { property: "file", flag: "--file", form: "pair", type: "string" },
      {
        property: "targetRevision",
        flag: "--target-revision",
        form: "pair",
        type: "integer",
        schema: POSITIVE_SAFE_INT,
        required: true,
      },
      {
        property: "expectedRowVersion",
        flag: "--expected-row-version",
        form: "pair",
        type: "integer",
        schema: POSITIVE_SAFE_INT,
        required: true,
      },
    ],
    extra: { oneOf: [{ required: ["text"] }, { required: ["file"] }] },
    guard: (a) => {
      if (a.targetRevision === undefined) return requiredOptionSentence("--target-revision <n>");
      if (a.expectedRowVersion === undefined) return "this command requires --expected-row-version";
      return (a.text !== undefined) === (a.file !== undefined) ? REVIEW_SET_ONE_SOURCE : undefined;
    },
  }),
  defineMcpTool({
    name: "handoff_review_withdraw",
    description: "withdraw this Handoff's current Review Note as the recipient, whichever actor authored it",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["review", "withdraw"],
    positionals: [HANDOFF_ID_POSITIONAL],
    options: [
      {
        property: "expectedRowVersion",
        flag: "--expected-row-version",
        form: "pair",
        type: "integer",
        schema: POSITIVE_SAFE_INT,
        required: true,
      },
    ],
    guard: (a) => (a.expectedRowVersion === undefined ? "this command requires --expected-row-version" : undefined),
  }),
  defineMcpTool({
    name: "handoff_revise",
    description:
      "replace the current Artifact or resolve the Review Note; expectedRowVersion is required for fresh mutation and optional only for successful recorded replay",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["revise"],
    positionals: [HANDOFF_ID_POSITIONAL],
    options: [
      { property: "body", flag: "--body", form: "pair", type: "string" },
      { property: "file", flag: "--file", form: "pair", type: "string" },
      { property: "noChange", flag: "--no-change", form: "flag", type: "boolean" },
      { property: "reason", flag: "--reason", form: "pair", type: "string" },
      {
        property: "expectedRowVersion",
        flag: "--expected-row-version",
        form: "pair",
        type: "integer",
        schema: NON_NEGATIVE_SAFE_INT,
      },
      { property: "idempotencyKey", flag: "--idempotency-key", form: "pair", type: "string" },
    ],
    extra: {
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
    guard: (a) => {
      const supplied = [a.body !== undefined, a.file !== undefined, a.noChange === true].filter(Boolean).length;
      if (supplied !== 1) return REVISE_ONE_SOURCE;
      if (a.body !== undefined && String(a.body).trim() === "") return BODY_MUST_NOT_BE_EMPTY;
      return undefined;
    },
  }),
  defineMcpTool({
    name: "handoff_accept",
    description: "accept the exact Revision as the recipient, closing the exchange",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["accept"],
    positionals: [HANDOFF_ID_POSITIONAL],
    options: [
      {
        property: "expectedRevision",
        flag: "--expected-revision",
        form: "pair",
        type: "integer",
        schema: NON_NEGATIVE_SAFE_INT,
        required: true,
      },
      {
        property: "expectedRowVersion",
        flag: "--expected-row-version",
        form: "pair",
        type: "integer",
        schema: NON_NEGATIVE_SAFE_INT,
        required: true,
      },
    ],
    guard: (a) => {
      if (a.expectedRevision === undefined) return requiredOptionSentence("--expected-revision <n>");
      if (a.expectedRowVersion === undefined) return ACCEPT_REQUIRES_ROW_VERSION;
      return undefined;
    },
  }),
  defineMcpTool({
    name: "handoff_decline",
    description: "decline the Handoff as the recipient with a recorded reason",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["decline"],
    positionals: [HANDOFF_ID_POSITIONAL],
    options: [
      { property: "reason", flag: "--reason", form: "pair", type: "string", required: true },
      {
        property: "expectedRowVersion",
        flag: "--expected-row-version",
        form: "pair",
        type: "integer",
        schema: NON_NEGATIVE_SAFE_INT,
        required: true,
      },
    ],
    guard: (a) => {
      if (a.reason === undefined) return requiredOptionSentence("--reason <text>");
      if (a.expectedRowVersion === undefined) return DECLINE_REQUIRES_ROW_VERSION;
      return undefined;
    },
  }),
  defineMcpTool({
    name: "handoff_withdraw",
    description: "withdraw the Handoff as the sender before the recipient has engaged",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["withdraw"],
    positionals: [HANDOFF_ID_POSITIONAL],
    options: [
      {
        property: "expectedRowVersion",
        flag: "--expected-row-version",
        form: "pair",
        type: "integer",
        schema: NON_NEGATIVE_SAFE_INT,
      },
    ],
  }),
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
    const options: McpOptionSpec[] = show
      ? []
      : [
          {
            property: "expectedRevision",
            flag: "--expected-revision",
            form: "pair",
            type: "integer",
            schema: POSITIVE_SAFE_INT,
            required: true,
          },
          {
            property: "expectedRowVersion",
            flag: "--expected-row-version",
            form: "pair",
            type: "integer",
            schema: POSITIVE_SAFE_INT,
            required: true,
          },
          ...(set
            ? ([
                { property: "text", flag: "--text", form: "pair", type: "string" },
                { property: "file", flag: "--file", form: "pair", type: "string" },
                {
                  property: "purpose",
                  flag: "--purpose",
                  form: "pair",
                  type: "string",
                  schema: { type: "string", enum: ["general", "change_request"], default: "general" },
                },
              ] satisfies McpOptionSpec[])
            : ([
                { property: "commentText", flag: "--comment-text", form: "pair", type: "string" },
                { property: "commentFile", flag: "--comment-file", form: "pair", type: "string" },
              ] satisfies McpOptionSpec[])),
        ];
    return defineMcpTool({
      name: `handoff_${operation}`,
      description: show
        ? "read the retained recipient comment; records nothing"
        : set
          ? "replace the recipient comment using the observed document and Row Version"
          : `${operation === "processing_start" ? "start" : "complete"} processing with an optional general comment`,
      annotations: COMMUNICATION,
      mirrorsIntegerBounds: true,
      command: operation.split("_"),
      positionals: [HANDOFF_ID_POSITIONAL],
      options,
      ...(set
        ? { extra: { oneOf: [{ required: ["text"] }, { required: ["file"] }] } }
        : show
          ? {}
          : { extra: { not: { required: ["commentText", "commentFile"] } } }),
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
    });
  });
}

const MEMO_TOOLS: McpTool[] = [
  defineMcpTool({
    name: "memo_list",
    description: "list Project Memos, open by default",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: false,
    command: ["memo", "list"],
    options: [
      { property: "project", flag: "--project", form: "pair", type: "string" },
      { property: "allProjects", flag: "--all-projects", form: "flag", type: "boolean" },
      {
        property: "state",
        flag: "--state",
        form: "pair",
        type: "string",
        schema: { type: "string", enum: ["open", "done", "dismissed", "all"], default: "open" },
      },
      { property: "query", flag: "--query", form: "pair", type: "string" },
      { property: "cursor", flag: "--cursor", form: "pair", type: "string" },
      { property: "limit", flag: "--limit", form: "pair", type: "integer", schema: NON_NEGATIVE_SAFE_INT },
    ],
    extra: {
      allOf: [
        {
          if: { required: ["project"], properties: { allProjects: { const: true } } },
          // biome-ignore lint/suspicious/noThenProperty: the JSON-Schema `then` keyword is schema data, not a promise
          then: { not: { required: ["allProjects"], properties: { allProjects: { const: true } } } },
        },
      ] satisfies Array<Record<string, unknown>>,
    },
  }),
  defineMcpTool({
    name: "memo_show",
    description: "show one complete Memo",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: false,
    command: ["memo", "show"],
    positionals: [{ property: "memoId", argument: "id" }],
    options: [{ property: "project", flag: "--project", form: "pair", type: "string" }],
  }),
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
  const hasContent = operation === "add" || operation === "update";
  const options: McpOptionSpec[] = [
    ...(hasContent
      ? ([
          { property: "title", flag: "--title", form: "pair", type: "string", required: operation === "add" },
          { property: "body", flag: "--body", form: "pair", type: "string" },
          { property: "bodyFile", flag: "--body-file", form: "pair", type: "string" },
        ] satisfies McpOptionSpec[])
      : []),
    ...(operation === "add"
      ? []
      : ([
          {
            property: "expectedRowVersion",
            flag: "--expected-row-version",
            form: "pair",
            type: "integer",
            schema: NON_NEGATIVE_SAFE_INT,
            required: true,
          },
        ] satisfies McpOptionSpec[])),
    { property: "project", flag: "--project", form: "pair", type: "string" },
    { property: "idempotencyKey", flag: "--idempotency-key", form: "pair", type: "string" },
    { property: "replayOnly", flag: "--replay-only", form: "flag", type: "boolean" },
  ];
  // Every cross-field rule of the Memo CLI answers coded (MEMO_INVALID_INPUT),
  // so no layer-2 guard exists and every refusal flows to the child.
  return defineMcpTool({
    name: `memo_${operation}`,
    description: descriptions[operation],
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: false,
    command: ["memo", operation],
    positionals: operation === "add" ? [] : [{ property: "memoId", argument: "id" }],
    options,
    propertyOrder: [
      "idempotencyKey",
      "replayOnly",
      ...(hasContent ? ["title", "body", "bodyFile"] : []),
      ...(operation === "add" ? [] : ["memoId", "expectedRowVersion"]),
      "project",
    ],
    extra: {
      allOf: [
        // The body-source exclusion and the at-least-one rule exist only
        // where the command declares the body properties (EE nit 1).
        ...(hasContent ? [{ not: { allOf: [{ required: ["body"] }, { required: ["bodyFile"] }] } }] : []),
        ...(operation === "update"
          ? [{ anyOf: [{ required: ["title"] }, { required: ["body"] }, { required: ["bodyFile"] }] }]
          : []),
        REPLAY_ONLY_WITH_KEY,
      ],
    },
  });
}

const CHANNEL_REF_POSITIONAL: McpPositionalSpec = { property: "channel", argument: "channel" };

const CHANNEL_TOOLS: McpTool[] = [
  defineMcpTool({
    name: "channel_create",
    description: "create an open Channel with its single main participant",
    annotations: IDEMPOTENT_COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "create"],
    positionals: [{ property: "name", argument: "name" }],
    options: [
      { property: "title", flag: "--title", form: "pair", type: "string" },
      { property: "main", flag: "--main", form: "pair", type: "string", schema: { type: "string", default: "main" } },
    ],
  }),
  defineMcpTool({
    name: "channel_add",
    description: "register a worker or judge participant on an open Channel",
    annotations: IDEMPOTENT_COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "add"],
    positionals: [CHANNEL_REF_POSITIONAL, { property: "handle", argument: "handle" }],
    options: [
      {
        property: "role",
        flag: "--role",
        form: "pair",
        type: "string",
        schema: { type: "string", enum: ["worker", "judge"] },
        required: true,
      },
    ],
    // A bad role value is the CLI's own coded CHN_INVALID_INPUT; only its
    // absence mirrors the parser's required-option exit 2.
    guard: (a) => (a.role === undefined ? requiredOptionSentence("--role <role>") : undefined),
  }),
  defineMcpTool({
    name: "channel_remove",
    description: "remove a participant idempotently; reversible by re-adding the handle",
    annotations: IDEMPOTENT_COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "remove"],
    positionals: [CHANNEL_REF_POSITIONAL, { property: "handle", argument: "handle" }],
  }),
  defineMcpTool({
    name: "channel_post",
    description: "post one attributed message upstream through the shared content interface",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "post"],
    positionals: [CHANNEL_REF_POSITIONAL],
    options: [
      { property: "from", flag: "--from", form: "pair", type: "string", required: true },
      {
        property: "kind",
        flag: "--kind",
        form: "pair",
        type: "string",
        schema: { type: "string", enum: KINDS },
        required: true,
      },
      { property: "body", flag: "--body", form: "pair", type: "string" },
      { property: "bodyFile", flag: "--body-file", form: "pair", type: "string" },
      { property: "to", flag: "--to", form: "pair", type: "string" },
      { property: "ref", flag: "--ref", form: "pair", type: "string" },
    ],
    extra: {
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
    guard: (a) => {
      if (a.from === undefined) return requiredOptionSentence("--from <handle>");
      if (a.kind === undefined) return requiredOptionSentence("--kind <kind>");
      if (!KINDS.includes(String(a.kind))) return KIND_CHOICES;
      return undefined;
    },
  }),
  defineMcpTool({
    name: "channel_messages",
    description: "list messages with full inline bodies; unhandled oldest first by default",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "messages"],
    positionals: [CHANNEL_REF_POSITIONAL],
    options: [
      { property: "all", flag: "--all", form: "flag", type: "boolean", schema: { type: "boolean", default: false } },
      { property: "after", flag: "--after", form: "pair", type: "integer", schema: NON_NEGATIVE_SAFE_INT },
      { property: "from", flag: "--from", form: "pair", type: "string" },
      { property: "kind", flag: "--kind", form: "pair", type: "string", schema: { type: "string", enum: KINDS } },
      { property: "limit", flag: "--limit", form: "pair", type: "integer", schema: NON_NEGATIVE_SAFE_INT },
      { property: "wait", flag: "--wait", form: "flag", type: "boolean", schema: { type: "boolean", default: false } },
      {
        property: "timeout",
        flag: "--timeout",
        form: "pair",
        type: "integer",
        schema: { ...NON_NEGATIVE_SAFE_INT, default: 30 },
      },
      {
        property: "interval",
        flag: "--interval",
        form: "pair",
        type: "integer",
        schema: { ...NON_NEGATIVE_SAFE_INT, default: 2 },
      },
    ],
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
  }),
  defineMcpTool({
    name: "channel_ack",
    description: "record the User handling decision for the named messages",
    annotations: IDEMPOTENT_COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "ack"],
    positionals: [
      CHANNEL_REF_POSITIONAL,
      {
        property: "seq",
        argument: "seq...",
        type: "integerArray",
        schema: { type: "array", items: POSITIVE_SAFE_INT, minItems: 1 },
      },
    ],
    options: [{ property: "note", flag: "--note", form: "pair", type: "string" }],
    // An absent or empty seq is the required variadic missing (the generic
    // positional check); a seq item below 1 or above the safe range is the
    // CLI's coded CHN_INVALID_INPUT and flows to the child.
  }),
  defineMcpTool({
    name: "channel_close",
    description: "terminal idempotent close; freezes posting, keeps reads and acks",
    annotations: IDEMPOTENT_COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "close"],
    positionals: [CHANNEL_REF_POSITIONAL],
  }),
  defineMcpTool({
    name: "channel_list",
    description: "list Channels with both identifiers",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "list"],
    options: [
      {
        property: "state",
        flag: "--state",
        form: "pair",
        type: "string",
        schema: { type: "string", enum: ["open", "closed", "all"], default: "all" },
      },
    ],
  }),
  defineMcpTool({
    name: "channel_show",
    description: "show one Channel with its complete participant roster and counts",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["channel", "show"],
    positionals: [CHANNEL_REF_POSITIONAL],
  }),
];

const PROJECT_TOOLS: McpTool[] = [
  defineMcpTool({
    name: "project_list",
    description: "list every Project with its binding count, flagging unbound Projects",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["project", "list"],
  }),
  defineMcpTool({
    name: "project_show",
    description: "show one Project with every binding, its counts, and its lifecycle state",
    annotations: COMMUNICATION,
    mirrorsIntegerBounds: true,
    command: ["project", "show"],
    positionals: [{ property: "project", argument: "project" }],
  }),
];

const exchangePair = (
  property: string,
  flag: string,
  required?: string,
  type: PropertyType = "string",
  schema?: Record<string, unknown>,
): McpOptionSpec => ({
  property,
  flag,
  form: "pair",
  type,
  ...(type === "integer" ? { maxFirst: true } : {}),
  ...(required ? { required } : {}),
  ...(schema ? { schema } : {}),
});

const exchangeList = (property: string, flag: string): McpOptionSpec => ({
  property,
  flag,
  form: "repeat",
  type: "stringArray",
  schema: { type: "array", items: { type: "string" }, minItems: 1 },
});

const exchangeFlag = (property: string, flag: string): McpOptionSpec => ({
  property,
  flag,
  form: "flag",
  type: "boolean",
});

const exchangeId = { property: "exchangeId", argument: "exchange-id" };
const exchangeProject = exchangePair("project", "--project");
const exchangeOperationId = exchangePair("operationId", "--operation-id", "id");
const exchangeBusiness = [exchangeOperationId, exchangeFlag("replayOnly", "--replay-only")];
const exchangeClaim = exchangePair("claim", "--claim");
const exchangeParticipant = [exchangeClaim, ...exchangeBusiness];
const exchangeBody = [exchangePair("body", "--body"), exchangePair("file", "--file")];
const exchangeAccept = exchangeList("accept", "--accept");
const exchangeReply = exchangePair("replyTo", "--reply-to", undefined, "integer", { type: "integer", minimum: 1 });
const exchangeCursor = exchangePair("historyCursor", "--history-cursor");
const exchangePageLimit = exchangePair("limit", "--limit", undefined, "integer", {
  type: "integer",
  minimum: 1,
  maximum: 200,
});
const exchangeBodySchema = { oneOf: [{ required: ["body"] }, { required: ["file"] }] };
const exchangeVersion = (property: string, flag: string, required?: string) =>
  exchangePair(property, flag, required, "integer", { type: "integer", minimum: 1 });
const rosterVersion = exchangeVersion("rosterVersion", "--roster-version", "n");
const observedPauseVersion = exchangePair("pauseVersion", "--pause-version", undefined, "integer", { minimum: 0 });
const ownershipVersion = exchangeVersion("ownershipVersion", "--ownership-version", "n");
const requestId = exchangePair("request", "--request", "id");
const controlReason = exchangePair("reason", "--reason", "text");
const confirmedControl = { properties: { confirm: { const: true } } };
const confirmControl = exchangeFlag("confirm", "--confirm");

function exchangeTool(
  command: string,
  description: string,
  options: McpOptionSpec[],
  settings: {
    positionals?: (typeof exchangeId)[];
    optionalPositionals?: boolean;
    idempotent?: boolean;
    required?: string[];
    schema?: Record<string, unknown>;
  } = {},
): McpTool {
  const positionals = settings.positionals ?? [exchangeId];
  const allOptions = [exchangeProject, ...options];
  return defineMcpTool({
    name: `exchange_${command.replaceAll("-", "_")}`,
    description,
    annotations: settings.idempotent ? IDEMPOTENT_COMMUNICATION : COMMUNICATION,
    mirrorsIntegerBounds: false,
    command: ["exchange", command],
    positionals: positionals.map((positional) => ({
      ...positional,
      ...(settings.optionalPositionals ? { optional: true } : {}),
      guardOrder: true,
    })),
    options: allOptions,
    ...(settings.required !== undefined ? { required: settings.required } : {}),
    emitEmptyRequired: true,
    ...(settings.schema !== undefined ? { extra: settings.schema } : {}),
    guard: (args) => {
      // Commander parses the global limit before checking required command operands.
      if (typeof args.limit === "number" && (!Number.isSafeInteger(args.limit) || args.limit < 0)) {
        return `option '--limit <n>' argument '${args.limit}' is invalid. ${NON_NEGATIVE_INTEGER}`;
      }
      const required = allOptions.find(
        ({ property, required }) => typeof required === "string" && args[property] === undefined,
      );
      if (required) return requiredOptionSentence(`${required.flag} <${required.required}>`);
      const missing = settings.optionalPositionals
        ? undefined
        : positionals.find(({ property }) => args[property] === undefined);
      if (missing) return requiredArgumentSentence(missing.argument);
      return undefined;
    },
  });
}

const EXCHANGE_TOOLS: McpTool[] = [
  exchangeTool(
    "create",
    "create an Exchange and return its ID without a claim",
    [
      ...exchangeBusiness,
      exchangeList("member", "--member"),
      exchangePair("goal", "--goal", "text"),
      exchangeList("criterion", "--criterion"),
    ],
    { positionals: [], required: ["member", "criterion"], idempotent: true },
  ),
  exchangeTool(
    "join",
    "acquire an Active claim, resume an observed pause, or return the retained Exchange view",
    [
      exchangePair("replaceClaim", "--replace-claim"),
      confirmControl,
      exchangeVersion("pauseVersion", "--pause-version"),
      exchangePair("decision", "--decision"),
      exchangePair("operationId", "--operation-id"),
      exchangeFlag("replayOnly", "--replay-only"),
    ],
    {
      schema: {
        oneOf: [
          {
            not: {
              anyOf: [
                { required: ["replaceClaim"] },
                { required: ["pauseVersion"] },
                { required: ["operationId"] },
                { required: ["decision"] },
                { required: ["replayOnly"], properties: { replayOnly: { const: true } } },
                { required: ["confirm"], properties: { confirm: { const: true } } },
              ],
            },
          },
          {
            required: ["replaceClaim", "confirm"],
            properties: { confirm: { const: true } },
            not: {
              anyOf: [
                { required: ["pauseVersion"] },
                { required: ["operationId"] },
                { required: ["decision"] },
                { required: ["replayOnly"], properties: { replayOnly: { const: true } } },
              ],
            },
          },
          {
            required: ["pauseVersion", "operationId", "confirm"],
            properties: { confirm: { const: true } },
            not: { required: ["replaceClaim"] },
          },
        ],
      },
    },
  ),
  exchangeTool("inspect", "inspect the Exchange and current obligations without writing", [], { idempotent: true }),
  exchangeTool(
    "history",
    "read a bounded page of Exchange history without confirming it",
    [
      exchangePair("afterSeq", "--after-seq", undefined, "integer", { type: "integer", minimum: 0 }),
      exchangeCursor,
      exchangePageLimit,
    ],
    { idempotent: true, schema: { not: { required: ["afterSeq", "historyCursor"] } } },
  ),
  exchangeTool(
    "wait",
    "wait without writes for new relevant Exchange activity",
    [
      exchangeCursor,
      exchangePageLimit,
      exchangePair("timeout", "--timeout", undefined, "integer", {
        type: "integer",
        minimum: 1,
        maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1_000),
        default: EXCHANGE_WAIT_SECONDS,
      }),
      exchangePair("interval", "--interval", undefined, "integer", {
        type: "integer",
        minimum: 1,
        maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1_000),
        default: EXCHANGE_POLL_SECONDS,
      }),
    ],
    { idempotent: true },
  ),
  exchangeTool(
    "send",
    "send an informational Exchange message",
    [
      ...exchangeParticipant,
      ...exchangeBody,
      exchangePair("kind", "--kind", undefined, "string", {
        type: "string",
        enum: ["information", "progress", "clarification", "blocked"],
        default: "information",
      }),
      exchangePair("to", "--to"),
      exchangeReply,
      exchangeAccept,
    ],
    { idempotent: true, schema: exchangeBodySchema },
  ),
  exchangeTool(
    "request",
    "direct an actionable request to a current Project",
    [
      ...exchangeParticipant,
      exchangePair("assignee", "--assignee", "project"),
      exchangePair("condition", "--condition", "text"),
      exchangeList("criterion", "--criterion"),
      exchangeReply,
    ],
    { idempotent: true, required: ["criterion"] },
  ),
  exchangeTool(
    "report",
    "report a versioned result on an assigned request",
    [
      ...exchangeParticipant,
      ...exchangeBody,
      exchangePair("request", "--request", "id"),
      exchangePair("assignmentVersion", "--assignment-version", "n", "integer", { type: "integer", minimum: 1 }),
      exchangeList("evidence", "--evidence"),
      exchangeAccept,
    ],
    { idempotent: true, schema: exchangeBodySchema },
  ),
  exchangeTool(
    "accept",
    "accept exactly the named report versions as requester",
    [...exchangeParticipant, exchangeAccept],
    { required: ["accept"], idempotent: true },
  ),
  exchangeTool(
    "material-register",
    "register a working copy or original reference",
    [
      ...exchangeParticipant,
      exchangePair("kind", "--kind", "kind", "string", {
        type: "string",
        enum: ["copy", "live", "versioned", "external"],
      }),
      exchangePair("source", "--source"),
      exchangePair("offset", "--offset", undefined, "integer", { type: "integer", minimum: 0 }),
      exchangePair("length", "--length", undefined, "integer", { type: "integer", minimum: 0 }),
      exchangePair("access", "--access", undefined, "string", { type: "string", enum: ["url", "run-id", "query"] }),
      exchangePair("value", "--value"),
    ],
    {
      idempotent: true,
      schema: {
        oneOf: [
          {
            properties: { kind: { enum: ["copy", "live", "versioned"] } },
            required: ["source"],
            not: { anyOf: [{ required: ["access"] }, { required: ["value"] }] },
          },
          {
            properties: { kind: { const: "external" } },
            required: ["access", "value"],
            not: { anyOf: [{ required: ["source"] }, { required: ["offset"] }, { required: ["length"] }] },
          },
        ],
      },
    },
  ),
  exchangeTool(
    "material-read",
    "read registered material by ID in bounded exact byte ranges",
    [
      exchangePair("offset", "--offset", "n", "integer", { type: "integer", minimum: 0 }),
      exchangePair("limit", "--limit", undefined, "integer", {
        type: "integer",
        minimum: 1,
        maximum: EXCHANGE_READ_BYTES,
      }),
    ],
    {
      positionals: [exchangeId, { property: "materialId", argument: "material-id" }],
      required: ["limit"],
      idempotent: true,
    },
  ),
  exchangeTool(
    "confirm-read",
    "explicitly confirm delivered messages without filling unread gaps",
    [exchangePair("claim", "--claim", "id"), exchangeList("range", "--range")],
    { required: ["range"], idempotent: true },
  ),
  exchangeTool(
    "recover",
    "discover the current Project's prior committed operations without writing",
    [exchangePair("operationId", "--operation-id")],
    { optionalPositionals: true, idempotent: true },
  ),
  exchangeTool(
    "roster",
    "apply an authorized versioned roster correction",
    [
      ...exchangeBusiness,
      controlReason,
      rosterVersion,
      observedPauseVersion,
      exchangeList("add", "--add"),
      exchangeList("remove", "--remove"),
      confirmControl,
    ],
    {
      required: ["confirm"],
      idempotent: true,
      schema: { allOf: [confirmedControl, { anyOf: [{ required: ["add"] }, { required: ["remove"] }] }] },
    },
  ),
  exchangeTool(
    "owner-correct",
    "correct request responsibility with user authorization",
    [
      ...exchangeBusiness,
      controlReason,
      requestId,
      ownershipVersion,
      rosterVersion,
      observedPauseVersion,
      exchangePair("acceptanceOwner", "--acceptance-owner"),
      exchangePair("assignee", "--assignee"),
      confirmControl,
    ],
    {
      required: ["confirm"],
      idempotent: true,
      schema: { allOf: [confirmedControl, { anyOf: [{ required: ["acceptanceOwner"] }, { required: ["assignee"] }] }] },
    },
  ),
  exchangeTool(
    "request-disposition",
    "record an accountable cancellation or agreed transfer",
    [
      ...exchangeParticipant,
      controlReason,
      requestId,
      ownershipVersion,
      exchangePair("disposition", "--disposition", "kind", "string", { enum: ["cancel", "transfer"] }),
      exchangePair("followUp", "--follow-up"),
    ],
    {
      idempotent: true,
      schema: {
        oneOf: [
          { properties: { disposition: { const: "cancel" } }, not: { required: ["followUp"] } },
          { properties: { disposition: { const: "transfer" } }, required: ["followUp"] },
        ],
      },
    },
  ),
  exchangeTool(
    "stop",
    "pause by explicit user direction and revoke claims",
    [...exchangeBusiness, controlReason, rosterVersion, observedPauseVersion, confirmControl],
    { required: ["confirm"], idempotent: true, schema: { allOf: [confirmedControl] } },
  ),
  exchangeTool(
    "pause",
    "request an explicit user decision and revoke claims",
    [...exchangeParticipant, controlReason, exchangePair("question", "--question", "text")],
    { idempotent: true },
  ),
  exchangeTool(
    "propose",
    "propose an exact retained completion summary",
    [
      ...exchangeParticipant,
      rosterVersion,
      exchangeVersion("workRevision", "--work-revision", "n"),
      exchangePair("summary", "--summary", "text"),
      exchangeList("criterion", "--criterion"),
      exchangeList("report", "--report"),
      exchangeList("disposition", "--disposition"),
    ],
    { required: ["criterion"], idempotent: true },
  ),
  exchangeTool(
    "vote",
    "approve or object to the exact current proposal",
    [
      ...exchangeParticipant,
      exchangeVersion("proposalVersion", "--proposal-version", "n"),
      exchangePair("vote", "--vote", "kind", "string", { enum: ["approve", "object"] }),
      exchangePair("objection", "--objection"),
      exchangeAccept,
    ],
    {
      idempotent: true,
      schema: {
        oneOf: [
          { properties: { vote: { const: "approve" } }, not: { required: ["objection"] } },
          { properties: { vote: { const: "object" } }, required: ["objection"], not: { required: ["accept"] } },
        ],
      },
    },
  ),
  exchangeTool(
    "material-revalidate",
    "revalidate a restored original as its supplying Project",
    [...exchangeParticipant, exchangePair("source", "--source", "path")],
    { positionals: [exchangeId, { property: "materialId", argument: "material-id" }], idempotent: true },
  ),
  exchangeTool("notice-list", "inspect eligible response notices without writing", [exchangeClaim], {
    idempotent: true,
  }),
  exchangeTool("notice-acquire", "acquire the finite reporting slot for a current Exchange notice", [
    exchangePair("incidentId", "--incident", "id"),
    exchangePair("claim", "--claim", "id"),
  ]),
  exchangeTool(
    "notice-ack",
    "acknowledge an Exchange notice after issuing it to the user",
    [
      ...exchangeParticipant,
      exchangePair("incidentId", "--incident", "id"),
      exchangePair("reportingClaim", "--reporting-claim"),
    ],
    { idempotent: true },
  ),
];

/** Append the M10 Exchange extension after the unchanged 35 tools of section 39. */
export const MCP_TOOLS: readonly McpTool[] = [
  ...HANDOFF_TOOLS,
  ...MEMO_TOOLS,
  ...CHANNEL_TOOLS,
  ...PROJECT_TOOLS,
  ...EXCHANGE_TOOLS,
];

const MCP_TOOLS_BY_NAME = new Map<string, McpTool>(MCP_TOOLS.map((tool) => [tool.name, tool]));

export function mcpToolByName(name: string): McpTool | undefined {
  return MCP_TOOLS_BY_NAME.get(name);
}

function requiredPositionalsOf(name: string): ReadonlyArray<{ property: string; argument: string }> {
  return DERIVED_REQUIRED_POSITIONALS.get(name) ?? [];
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
