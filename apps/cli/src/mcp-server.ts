import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { appError, errorEnvelope, SORAGE_VERSION } from "@sorage/core";
import { admitArguments, type McpTool, mcpToolByName, MCP_TOOLS } from "./mcp-catalogue";
import { expandTilde } from "./expand-tilde";

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

export type CwdResolution = { ok: true; cwd: string } | { ok: false };

/** Layer 1: the call's workspace root must be an existing directory (MCP-004). */
export function resolveCallCwd(cwd: unknown): CwdResolution {
  if (cwd === undefined) return { ok: true, cwd: process.cwd() };
  if (typeof cwd !== "string" || cwd === "") return { ok: false };
  try {
    if (!statSync(cwd).isDirectory()) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, cwd };
}

/**
 * The real path of `path`, following every existing component of its chain;
 * for a not-yet-existing target the nearest existing ancestor's real path
 * plus the remaining segments, so a symlinked ancestor cannot smuggle a
 * target past the containment comparison (SEC-006, as `import-source.ts`).
 */
export function realPathOf(path: string): string {
  let probe = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length === 0 ? real : `${real}/${tail.join("/")}`;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return path;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

export function isInsideWorkspace(workspaceRoot: string, resolvedPath: string): boolean {
  const rel = relative(realpathSync(workspaceRoot), realPathOf(resolvedPath));
  // A leading `..` segment escapes; a confined filename that merely begins
  // with two dots (`..draft.md`) does not.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The file-like property of each tool that carries a workspace-confined argument. */
export function fileLikePropertyOf(toolName: string): string | undefined {
  if (toolName === "handoff_send" || toolName === "handoff_review_set" || toolName === "handoff_revise") return "file";
  if (toolName === "memo_add" || toolName === "memo_update" || toolName === "channel_post") return "bodyFile";
  return undefined;
}

export type Confinement =
  | { ok: true; realPath: string; tildeExpanded: string }
  | { ok: false; resolvedPath: string; workspaceRoot: string };

/**
 * MCP-004's confinement check on real paths: expand the tilde exactly as the
 * CLI does, resolve against the workspace root, and compare real path against
 * real path with the prefix rule expressed through `path.relative` — correct
 * at the filesystem root too. An inside-but-nonexistent path passes, so the
 * child returns the CLI's typed missing-source error.
 */
export function confineFileArgument(workspaceRoot: string, argument: string): Confinement {
  const tildeExpanded = expandTilde(argument);
  const resolvedPath = resolve(workspaceRoot, tildeExpanded);
  if (!isInsideWorkspace(workspaceRoot, resolvedPath)) {
    return { ok: false, resolvedPath, workspaceRoot: realpathSync(workspaceRoot) };
  }
  return { ok: true, realPath: realPathOf(resolvedPath), tildeExpanded };
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

/** The self-invocation prefix: the entry argument only when running from source. */
export function selfInvocationArgv(argv: string[]): string[] {
  return process.argv[1]?.endsWith("main.ts") === true ? [process.argv[1] as string, ...argv] : argv;
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
 * CLI's recorded naming; the four server-only-guarded properties receive the
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
    if (name === "handoff_send" || name === "handoff_revise") {
      argv = selfInvocationArgv(
        replaceArgvValue(
          admitted.argv,
          `--${fileProperty === "file" ? "file" : "body-file"}`,
          confinement.tildeExpanded,
        ),
      );
    } else {
      argv = selfInvocationArgv(
        replaceArgvValue(admitted.argv, `--${fileProperty === "file" ? "file" : "body-file"}`, confinement.realPath),
      );
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

/** The `tools/list` entries, in the catalogue's pinned order and key order. */
export function toolsListResult(): Array<Record<string, unknown>> {
  return MCP_TOOLS.map((entry) => ({
    name: entry.name,
    description: entry.description,
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
  const children = new Map<string, SpawnedChild>();
  const cancelled = new Set<string>();
  let shuttingDown = false;
  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  // Bounded child cleanup (plan r4 section 4.5): ownership is kept until the
  // child exits, SIGTERM escalates to SIGKILL after the grace, and every exit
  // path — cancellation, EOF, SIGTERM, SIGINT, EPIPE — runs the same rule.
  const KILL_GRACE_MS = 1_500;
  const killChild = (child: SpawnedChild): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // A child that is already gone needs no signal.
    }
    const escalate = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    escalate.unref?.();
  };

  let lines: ReturnType<typeof createInterface> | undefined;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop accepting input: the remaining buffered lines are dropped and the
    // stdin keep-alive ends, so a signal ends the server even with stdin open.
    lines?.close();
    process.stdin.destroy();
    for (const child of children.values()) killChild(child);
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
        const child = children.get(requestKey);
        // A late cancellation — the answer already left — finds no child and
        // must not poison the key against a later request that reuses the id.
        if (child !== undefined) {
          cancelled.add(requestKey);
          killChild(child);
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
      void handleToolCall(callParams.name, callParams.arguments, callParams.arguments?.cwd, (argv, cwd) => {
        const child = defaultSpawner(argv, cwd);
        children.set(requestKey, child);
        return child;
      })
        .then((answer) => {
          children.delete(requestKey);
          if (cancelled.has(requestKey)) {
            cancelled.delete(requestKey);
            return;
          }
          write({ ...answer, id });
        })
        .catch((error: unknown) => {
          // An unexpected dispatch failure settles this one call with the
          // crash row's synthesized envelope — a server fault, so the message
          // names the server — and never ends the server.
          children.delete(requestKey);
          const detail = error instanceof Error ? error.message : String(error);
          write({
            jsonrpc: "2.0",
            id,
            result: synthesizedServerError(`dispatch failed: ${detail}`),
          });
        });
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
