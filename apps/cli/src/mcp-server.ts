import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { confineFileArgument, resolveCallCwd } from "@sorage/adapters/src/workspace-confinement";
import { appError, errorEnvelope, SORAGE_VERSION } from "@sorage/core";
import { EXCHANGE_JOIN_ACK, EXCHANGE_JOIN_GATE, ExchangeJoinGate } from "./exchange-join-gate";
import {
  ExchangeKeeper,
  type ExchangePair,
  exchangePairOf,
  EXCHANGE_JOIN_TIMEOUT_MS,
  interruptExchangeChild,
  ownedLeaseOf,
  reportExchangeKeeperStop,
} from "./exchange-owner";
import { admitArguments, type McpTool, mcpToolByName, MCP_TOOLS } from "./mcp-catalogue";
import { selfInvocationArgv } from "./self-invocation";

/**
 * The `sorage mcp` STDIO server of interface section 39 (MCP-001 to MCP-006):
 * newline-delimited JSON-RPC 2.0 over the process streams, the initialize
 * handshake of the supported revisions, and one `sorage … --json` child process
 * per accepted tool call — the CLI is the single behavior source, and this
 * process performs no storage access of its own (ADR-0007, ADR-0034). The
 * admission layers, the refusal envelope and the diagnostic relay follow
 * section 39's two clarification paragraphs verbatim.
 */

export const MCP_SUPPORTED_VERSIONS = ["2025-06-18", "2025-11-25"] as const;
export const MCP_LATEST_VERSION = "2025-11-25";

export const WORKSPACE_ESCAPE_RECOVERY =
  "Pass a file inside the call's workspace (the call's `cwd`), or use the inline body";

const GOLDEN_REQUEST_ID = process.env.SORAGE_TEST_REQUEST_ID;

/** Deterministic request identifiers for golden tests; never set in production. */
export function mcpRequestId(): string {
  return GOLDEN_REQUEST_ID ?? randomUUID();
}

export interface TextItem {
  type: "text";
  text: string;
}

export interface ToolResultPayload {
  content: TextItem[];
  structuredContent: unknown;
  isError: boolean;
}

/** The recorded outcome of one child run, the single input of result building. */
export interface ChildOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ParsedEnvelope {
  envelope: unknown;
  /** The child's own serialization, taken verbatim; never re-serialized by the server. */
  raw: string;
  /** Any diagnostic text the child wrote before the envelope on the same stream. */
  preceding: string;
}

/** The trailing JSON object of a stream, with its verbatim bytes (SOT-2). */
export function parseTrailingEnvelope(text: string): ParsedEnvelope | undefined {
  const trimmed = text.trimEnd();
  let start = trimmed.lastIndexOf("{");
  while (start >= 0) {
    const candidate = trimmed.slice(start);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const envelope = parsed as { ok?: unknown };
        if (envelope.ok === true || envelope.ok === false) {
          return { envelope, raw: text.slice(start), preceding: text.slice(0, start) };
        }
      }
    } catch {
      // Try the next opening brace closer to the start.
    }
    if (start === 0) break;
    start = trimmed.lastIndexOf("{", start - 1);
  }
  return undefined;
}

function internalErrorPayload(error: ReturnType<typeof appError>): ToolResultPayload {
  const envelope = errorEnvelope(error, mcpRequestId());
  return {
    content: [{ type: "text", text: `${JSON.stringify(envelope, null, 2)}\n` }],
    structuredContent: envelope,
    isError: true,
  };
}

/** A child crash, signal or spawn failure: the child itself failed, so the message names the child. */
function synthesizedInternalError(outcome: ChildOutcome, detail: string): ToolResultPayload {
  return internalErrorPayload(
    appError("INTERNAL_ERROR", `the sorage child process failed (${detail})`, {
      status: outcome.status,
      signal: outcome.signal,
      stderr: outcome.stderr.slice(0, 400),
    }),
  );
}

/**
 * A server fault — an admission or dispatch exception: the command never ran,
 * so the message names the server (c3-decision item 2, CO-6).
 */
export function synthesizedServerError(detail: string): ToolResultPayload {
  return internalErrorPayload(
    appError("INTERNAL_ERROR", `the sorage server failed before running the command (${detail})`, {}),
  );
}

export type BuiltResult =
  | { kind: "result"; payload: ToolResultPayload }
  | { kind: "protocolError"; code: -32602; message: string };

/**
 * Builds the tool result from one child outcome (SOT-2): `content[0]` is
 * unconditionally the CLI envelope item — the trailing JSON object of stdout
 * on exit 0, of stderr on a coded failure — and the child's remaining stderr
 * lines travel verbatim, in their original order, as exactly one additional
 * text item after it. Exit 2 without an envelope is a guard gap answered
 * `-32602` with the child's stderr text; a crash, a signal or an envelope-less
 * other exit settles as the synthesized `INTERNAL_ERROR` envelope.
 */
export function buildChildResult(outcome: ChildOutcome): BuiltResult {
  if (outcome.status === 0) {
    const parsed = parseTrailingEnvelope(outcome.stdout);
    if (parsed === undefined) {
      return { kind: "result", payload: synthesizedInternalError(outcome, "exit 0 without a JSON envelope") };
    }
    const content: TextItem[] = [{ type: "text", text: parsed.raw }];
    if (outcome.stderr.trim().length > 0) {
      content.push({ type: "text", text: outcome.stderr });
    }
    return { kind: "result", payload: { content, structuredContent: parsed.envelope, isError: false } };
  }
  const parsed = parseTrailingEnvelope(outcome.stderr);
  if (parsed === undefined) {
    if (outcome.status === 2) {
      return { kind: "protocolError", code: -32602, message: outcome.stderr.trim() };
    }
    const detail = outcome.signal !== null ? `signal ${outcome.signal}` : `exit ${String(outcome.status)}`;
    return { kind: "result", payload: synthesizedInternalError(outcome, detail) };
  }
  const content: TextItem[] = [{ type: "text", text: parsed.raw }];
  if (parsed.preceding.trim().length > 0) {
    content.push({ type: "text", text: parsed.preceding });
  }
  return { kind: "result", payload: { content, structuredContent: parsed.envelope, isError: true } };
}

/** The fixed refusal envelope of MCP-004, with section 39's message and recovery. */
export function workspaceEscapeEnvelope(resolvedPath: string, workspaceRoot: string): ToolResultPayload {
  const envelope = errorEnvelope(
    appError(
      "SOURCE_OUTSIDE_WORKSPACE",
      `The source ${resolvedPath} is outside the call's workspace ${workspaceRoot}.`,
      {
        resolvedSourcePath: resolvedPath,
        workspaceRoot,
        policy: "mcp-workspace-only",
      },
    ),
    mcpRequestId(),
  );
  // Section 39 fixes this recovery for MCP and forbids the CLI catalogue's
  // `--allow-external-source` text, an option no MCP tool has.
  const fixed = {
    ...envelope,
    error: { ...envelope.error, recovery: { suggestedCommand: WORKSPACE_ESCAPE_RECOVERY } },
  };
  return {
    content: [{ type: "text", text: `${JSON.stringify(fixed, null, 2)}\n` }],
    structuredContent: fixed,
    isError: true,
  };
}

/** The file-like property of each tool that carries a workspace-confined argument. */
export function fileLikePropertyOf(toolName: string): string | undefined {
  if (
    toolName === "handoff_send" ||
    toolName === "handoff_review_set" ||
    toolName === "handoff_revise" ||
    toolName === "handoff_comment_set" ||
    toolName === "exchange_send" ||
    toolName === "exchange_report"
  )
    return "file";
  if (toolName === "exchange_material_register" || toolName === "exchange_material_revalidate") return "source";
  if (toolName === "memo_add" || toolName === "memo_update" || toolName === "channel_post") return "bodyFile";
  if (toolName === "handoff_processing_start" || toolName === "handoff_processing_complete") return "commentFile";
  return undefined;
}

/** The spawn seam: minimal child surface the call handler needs, injectable for tests. */
export interface SpawnedChild {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ChildSpawner = (argv: string[], cwd: string) => SpawnedChild;

function defaultSpawner(argv: string[], cwd: string): SpawnedChild {
  // The child never inherits the server's stdin or stdout: no child byte can
  // corrupt the JSON-RPC stream (MCP-002). The environment passes through so
  // the harness's per-invocation SORAGE_HOME reaches every child.
  return spawn(process.execPath, argv, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as SpawnedChild;
}

export interface CallAnswer {
  jsonrpc: "2.0";
  id: unknown;
  result?: ToolResultPayload;
  error?: { code: number; message: string };
}

/**
 * One `tools/call` through the full admission pipeline: the two runtime layers
 * of section 39's clarification (arguments, then `cwd`), the MCP-004
 * confinement of file-like arguments on real paths with no child on refusal,
 * and one child process whose outcome builds the envelope-first result. The
 * `handoff_send` and `handoff_revise` children receive the tilde-expanded user
 * path — their own `checkExternalSource` re-checks the real path, keeping the
 * CLI's recorded naming; the server-only-guarded properties receive the
 * checked real path, because nothing downstream re-validates them.
 */
export async function handleToolCall(
  name: unknown,
  rawArguments: unknown,
  rawCwd: unknown,
  spawnChild: ChildSpawner = defaultSpawner,
): Promise<CallAnswer | { jsonrpc: "2.0"; id: null; error: { code: number; message: string } }> {
  const refuse = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id: null, error: { code, message } });
  if (typeof name !== "string") return refuse(-32602, "params.name must be a string");
  const callTool = mcpToolByName(name);
  if (callTool === undefined) return refuse(-32602, `Unknown tool: ${name}`);
  const admitted = admitArguments(callTool, rawArguments);
  if (!admitted.ok || admitted.argv === undefined) return refuse(-32602, admitted.message as string);
  const arguments_ = (rawArguments ?? {}) as Record<string, unknown>;
  const cwdResolution = resolveCallCwd(rawCwd);
  if (!cwdResolution.ok) return refuse(-32602, "cwd must be an existing directory");
  const cwd = cwdResolution.cwd;
  const fileProperty = fileLikePropertyOf(name);
  const fileFlag =
    fileProperty === "source"
      ? "--source"
      : fileProperty === "file"
        ? "--file"
        : fileProperty === "commentFile"
          ? "--comment-file"
          : "--body-file";
  let argv = selfInvocationArgv(admitted.argv);
  if (fileProperty !== undefined && typeof arguments_[fileProperty] === "string") {
    const confinement = confineFileArgument(cwd, arguments_[fileProperty] as string);
    if (!confinement.ok) {
      return {
        jsonrpc: "2.0",
        id: null,
        result: workspaceEscapeEnvelope(confinement.resolvedPath, confinement.workspaceRoot),
      };
    }
    if (name.startsWith("exchange_")) {
      argv = selfInvocationArgv(callTool.argv({ ...arguments_, [fileProperty]: confinement.tildeExpanded }));
    } else if (name === "handoff_send" || name === "handoff_revise") {
      argv = selfInvocationArgv(replaceArgvValue(admitted.argv, fileFlag, confinement.tildeExpanded));
    } else {
      argv = selfInvocationArgv(replaceArgvValue(admitted.argv, fileFlag, confinement.realPath));
    }
  }
  return await new Promise<CallAnswer>((settle) => {
    let child: SpawnedChild;
    const outcome: ChildOutcome = { status: null, signal: null, stdout: "", stderr: "" };
    try {
      child = spawnChild(argv, cwd);
    } catch (error) {
      settle({ jsonrpc: "2.0", id: null, result: synthesizedInternalError(outcome, `spawn threw: ${String(error)}`) });
      return;
    }
    // A multibyte character can split across pipe chunks, so the bytes are
    // collected and decoded once at close — never chunk by chunk (MCP-006).
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      settle({ jsonrpc: "2.0", id: null, result: synthesizedInternalError(outcome, `spawn error: ${error.message}`) });
    });
    child.on("close", (code, signal) => {
      outcome.status = code;
      outcome.signal = signal;
      outcome.stdout = Buffer.concat(stdoutChunks).toString("utf8");
      outcome.stderr = Buffer.concat(stderrChunks).toString("utf8");
      const built = buildChildResult(outcome);
      if (built.kind === "protocolError") {
        settle(refuse(built.code, built.message));
        return;
      }
      settle({ jsonrpc: "2.0", id: null, result: built.payload });
    });
  });
}

/** Replaces the value of one `--flag <value>` pair, leaving every other element intact. */
function replaceArgvValue(argv: string[], flag: string, value: string): string[] {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return argv;
  return [...argv.slice(0, index), flag, value, ...argv.slice(index + 2)];
}

/**
 * The published form of one tool's input schema: the domain contract plus the
 * section 39 common rules — every tool takes an optional `cwd: string`, and no
 * unknown properties are accepted. The runtime admission is unchanged: layer 1
 * still refuses unknown properties and still requires `cwd` to be an existing
 * directory.
 */
export function publishedInputSchema(tool: McpTool): Record<string, unknown> {
  const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
  return {
    ...tool.inputSchema,
    properties: { ...(properties ?? {}), cwd: { type: "string" } },
    additionalProperties: false,
  };
}

const COMMUNICATION_CONTEXT =
  "Sorage internal communication tool. Exchanging or recording messages is not project implementation or execution of the work described in a message. Use this tool for requested communication while planning. ";

/** The `tools/list` entries, in the catalogue's pinned order and key order. */
export function toolsListResult(): Array<Record<string, unknown>> {
  return MCP_TOOLS.map((entry) => ({
    name: entry.name,
    description: COMMUNICATION_CONTEXT + entry.description,
    inputSchema: publishedInputSchema(entry),
    annotations: entry.annotations,
  }));
}

export function initializeResult(requestedVersion: unknown): Record<string, unknown> {
  const version =
    typeof requestedVersion === "string" && (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requestedVersion)
      ? requestedVersion
      : MCP_LATEST_VERSION;
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: "sorage", version: SORAGE_VERSION },
    instructions: COMMUNICATION_CONTEXT.trim(),
  };
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * The STDIO loop: one JSON-RPC message per line on stdin, one response line
 * per request on stdout, never stderr (section 39's transport). Cancellation
 * kills the in-flight child and suppresses its response; stdin close or a
 * termination signal kills every remaining child and ends the process.
 */
export function serveMcp(): void {
  interface ActiveCall {
    child?: SpawnedChild;
    cancelled: boolean;
    escalation?: ReturnType<typeof setTimeout>;
    gated?: ReturnType<ExchangeJoinGate["add"]>;
    deadline?: ReturnType<typeof setTimeout>;
    reaped?: Promise<void>;
    pair?: ExchangePair;
    cwd?: string;
    acknowledged: boolean;
  }
  const children = new Map<string, ActiveCall>();
  const pending = new Set<Promise<void>>();
  const gate = new ExchangeJoinGate();
  const keeper = new ExchangeKeeper(undefined, reportExchangeKeeperStop);
  let shuttingDown = false;
  let outputOpen = true;
  const write = (message: unknown): void => {
    if (outputOpen && !process.stdout.destroyed) process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  // Bounded child cleanup (plan r4 section 4.5): ownership is kept until the
  // child exits, SIGTERM escalates to SIGKILL after the grace, and every exit
  // path — cancellation, EOF, SIGTERM, SIGINT, EPIPE — runs the same rule.
  const abort = (call: ActiveCall): void => {
    call.gated?.cancel();
    if (call.child) call.escalation ??= interruptExchangeChild(call.child);
  };

  function launchJoin(argv: string[], cwd: string, exchangeId: string, call: ActiveCall): SpawnedChild {
    const child: ChildProcess = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, [EXCHANGE_JOIN_GATE]: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    call.child = child as unknown as SpawnedChild;
    call.cwd = cwd;
    call.reaped = new Promise((resolve) => child.once("close", () => resolve()));
    const slot = gate.add(exchangeId, () => {
      if (!child.connected) {
        abort(call);
        return;
      }
      call.acknowledged = true;
      clearTimeout(call.deadline);
      child.send(EXCHANGE_JOIN_ACK, (error) => {
        if (error) abort(call);
      });
    });
    call.gated = slot;
    call.deadline = setTimeout(() => abort(call), EXCHANGE_JOIN_TIMEOUT_MS);
    child.on("message", (message) => {
      const pair = exchangePairOf(message);
      if (!pair) {
        abort(call);
        return;
      }
      call.pair = pair;
      if (!slot.announce(pair)) abort(call);
    });
    return call.child;
  }

  let lines: ReturnType<typeof createInterface> | undefined;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    gate.close();
    keeper.quiesce();
    // Stop accepting input: the remaining buffered lines are dropped and the
    // stdin keep-alive ends, so a signal ends the server even with stdin open.
    lines?.close();
    process.stdin.destroy();
    for (const call of children.values()) abort(call);
    void Promise.allSettled([...pending]).then(async () => {
      if (!(await keeper.shutdown())) process.exitCode = 1;
    });
    process.exitCode = 0;
  };

  process.on("SIGTERM", () => {
    shutdown();
  });
  process.on("SIGINT", () => {
    shutdown();
  });
  // A client that is already gone must not turn the next response write into
  // an unhandled error; the server ends quietly through the same cleanup.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      outputOpen = false;
      shutdown();
      return;
    }
    throw error;
  });

  const keyOf = (id: unknown): string => JSON.stringify(id ?? null);

  const dispatch = (message: JsonRpcMessage): void => {
    const { id, method, params } = message;
    if (message.jsonrpc !== "2.0" || typeof method !== "string") {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    if (
      id !== undefined &&
      (id === null || (typeof id !== "string" && (typeof id !== "number" || !Number.isInteger(id))))
    ) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const isRequest = id !== undefined;
    const answerError = (code: number, text: string): void => {
      write({ jsonrpc: "2.0", id: isRequest ? id : null, error: { code, message: text } });
    };
    if (!isRequest) {
      if (method === "notifications/cancelled") {
        const cancelledId = (params as { requestId?: unknown } | undefined)?.requestId;
        if (cancelledId === undefined) return;
        const requestKey = keyOf(cancelledId);
        const call = children.get(requestKey);
        // A late cancellation — the answer already left — finds no child and
        // must not poison the key against a later request that reuses the id.
        if (call?.child !== undefined) {
          call.cancelled = true;
          abort(call);
        }
      }
      return;
    }
    if (method === "initialize") {
      write({
        jsonrpc: "2.0",
        id,
        result: initializeResult((params as { protocolVersion?: unknown } | undefined)?.protocolVersion),
      });
      return;
    }
    if (method === "ping") {
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      write({ jsonrpc: "2.0", id, result: { tools: toolsListResult() } });
      return;
    }
    if (method === "tools/call") {
      const callParams = (params ?? {}) as { name?: unknown; arguments?: { cwd?: unknown } };
      const requestKey = keyOf(id);
      const call: ActiveCall = { cancelled: false, acknowledged: false };
      const execution = handleToolCall(
        callParams.name,
        callParams.arguments,
        callParams.arguments?.cwd,
        (argv, cwd) => {
          children.set(requestKey, call);
          if (callParams.name === "exchange_join") {
            return launchJoin(argv, cwd, argv.at(-1) as string, call);
          }
          call.child = defaultSpawner(argv, cwd);
          return call.child;
        },
      )
        .then(async (answer) => {
          if (call.reaped) await call.reaped;
          if (call.acknowledged && call.pair && call.cwd && "result" in answer) {
            const envelope = answer.result?.structuredContent as { ok?: unknown; data?: unknown } | undefined;
            if (envelope?.ok === true) {
              const lease = ownedLeaseOf(envelope.data, call.cwd);
              if (lease?.exchangeId === call.pair.exchangeId && lease.projectId === call.pair.projectId) {
                keeper.install(lease);
              }
            }
          }
          if (!call.cancelled) write({ ...answer, id });
        })
        .catch((error: unknown) => {
          // An unexpected dispatch failure settles this one call with the
          // crash row's synthesized envelope — a server fault, so the message
          // names the server — and never ends the server.
          if (call.cancelled) return;
          const detail = error instanceof Error ? error.message : String(error);
          write({
            jsonrpc: "2.0",
            id,
            result: synthesizedServerError(`dispatch failed: ${detail}`),
          });
        })
        .finally(() => {
          clearTimeout(call.escalation);
          clearTimeout(call.deadline);
          call.gated?.finish();
          if (children.get(requestKey) === call) children.delete(requestKey);
          pending.delete(execution);
        });
      pending.add(execution);
      return;
    }
    answerError(-32601, `method not found: ${method}`);
  };

  lines = createInterface({ input: process.stdin });
  lines.on("line", (line: string) => {
    if (shuttingDown) return;
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    dispatch(message as JsonRpcMessage);
  });
  lines.on("close", () => {
    shutdown();
  });
}
