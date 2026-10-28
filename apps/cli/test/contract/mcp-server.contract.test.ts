import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LineSplitter } from "./mcp-line-splitter";

/**
 * The `sorage mcp` contract suite (MCP-001 to MCP-006, interface section 39
 * and its two clarification paragraphs): the server runs as a real process
 * speaking JSON-RPC over its stdio, every tool call runs a real CLI child, and
 * the catalogue is pinned byte-exact beside the CLI goldens (MCP-005).
 */
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const goldenPath = fileURLToPath(new URL("./golden/mcp-tools.json", import.meta.url));
const SANDBOX_FREE_CLEANUPS: Array<() => void> = [];

// Records the cleanup sequence of the current test, so a captured waiter can
// be proven dead before the temporary home that holds its files is removed
// (c3-decision item 5).
const CLEANUP_ORDER: string[] = [];

afterEach(async () => {
  CLEANUP_ORDER.length = 0;
  const settled: Array<PromiseSettledResult<unknown>> = [];
  // One cleanup at a time, in LIFO order, each fully awaited before the next
  // begins: a waiter's termination is confirmed before anything registered
  // earlier — including the home's rmSync — can run.
  while (SANDBOX_FREE_CLEANUPS.length > 0) {
    const cleanup = SANDBOX_FREE_CLEANUPS.pop();
    if (cleanup === undefined) continue;
    try {
      const value = await cleanup();
      settled.push({ status: "fulfilled", value });
    } catch (reason) {
      settled.push({ status: "rejected", reason });
    }
  }
  // A cleanup that failed — for example a waiter that survived its kill — is a
  // fixture leak, not a pass.
  const failed = settled.filter((each) => each.status === "rejected");
  expect(failed).toHaveLength(0);
  // When this test owned a waiter, its recorded death must precede the
  // escalation home's recorded removal.
  const homeRemoval = CLEANUP_ORDER.indexOf("escalation-home:removal");
  for (const [index, entry] of CLEANUP_ORDER.entries()) {
    if (!entry.startsWith("waiter:")) continue;
    expect(index, "the waiter died before the home removal").toBeLessThan(homeRemoval);
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SANDBOX_FREE_CLEANUPS.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(
  args: string[],
  home: string,
  cwd: string,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [entry, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, SORAGE_HOME: home, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** An initialized home with Projects alpha (work-a) and beta (work-b). */
function installation(prefix = "sorage-mcp-contract-"): { home: string; workA: string; workB: string } {
  const home = tempDir(prefix);
  const workA = join(home, "work-a");
  const workB = join(home, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  const init = runCli(["init", "--non-interactive"], home, workA);
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  for (const [name, dir] of [
    ["Alpha", workA],
    ["Beta", workB],
  ] as Array<[string, string]>) {
    const added = runCli(["project", "add", "--name", name, "--dir", dir], home, workA);
    if (added.status !== 0) throw new Error(`project add failed: ${added.stderr}`);
  }
  return { home, workA, workB };
}

interface Session {
  child: ChildProcess;
  lines: string[];
  stderr: string;
  send(message: unknown): void;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  waitForError(code: number, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForRequestId(id: number, afterLine: number, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForInvalidRequestCount(count: number, timeoutMs?: number): Promise<number>;
  close(): Promise<void>;
}

function startServer(home: string, cwd: string, env: Record<string, string> = {}): Session {
  const child = spawn("bun", [entry, "mcp"], {
    cwd,
    env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: undefined, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let nextId = 0;
  let stderr = "";
  // One byte-level splitter keeps the unconsumed remainder after every chunk
  // (mcp-line-splitter; its unit cases cover this client's framing).
  const splitter = new LineSplitter();
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) {
      if (line.trim().length === 0) continue;
      lines.push(line);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message.id;
        if (typeof id === "number") {
          const resolve = pending.get(id);
          if (resolve !== undefined) {
            pending.delete(id);
            resolve(message);
          }
        }
      } catch {
        // Non-JSON stdout lines are a defect the pinned tests will surface.
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  SANDBOX_FREE_CLEANUPS.push(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  const session: Session = {
    child,
    lines,
    get stderr() {
      return stderr;
    },
    send(message: unknown): void {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${String(timeoutMs)}ms; stderr: ${stderr.slice(0, 400)}`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method: string, params: unknown = {}): void {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    waitForRequestId(id: number, afterLine: number, timeoutMs = 5_000): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          for (let index = afterLine; index < session.lines.length; index++) {
            const message = JSON.parse(session.lines[index] as string) as Record<string, unknown>;
            if (message.id === id) resolve(message);
          }
          if (Date.now() - started > timeoutMs) reject(new Error(`no answer observed for id ${String(id)}`));
          else setTimeout(poll, 25);
        };
        poll();
      });
    },
    waitForInvalidRequestCount(count: number, timeoutMs = 5_000): Promise<number> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          const invalid = session.lines
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((message) => {
              const error = message.error as { code?: number } | undefined;
              return error !== undefined && error.code === -32600 && message.id === null;
            }).length;
          if (invalid >= count) resolve(invalid);
          else if (Date.now() - started > timeoutMs)
            reject(new Error(`only ${String(invalid)} invalid-request answers`));
          else setTimeout(poll, 25);
        };
        poll();
      });
    },
    waitForError(code: number, timeoutMs = 5_000): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          const found = session.lines
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((message) => {
              const error = message.error as { code?: number } | undefined;
              return error !== undefined && error.code === code && message.id === null;
            });
          if (found !== undefined) resolve(found);
          else if (Date.now() - started > timeoutMs) reject(new Error(`no error ${String(code)} observed`));
          else setTimeout(poll, 20);
        };
        poll();
      });
    },
    async close(): Promise<void> {
      child.stdin?.end();
      await done;
    },
  };
  return session;
}

async function toolCall(
  session: Session,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<{
  result?: {
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
    isError: boolean;
  } | null;
  error?: { code: number; message: string };
}> {
  const answer = (await session.request("tools/call", { name, arguments: args }, timeoutMs)) as unknown as {
    result?: {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
      isError: boolean;
    };
    error?: { code: number; message: string };
  };
  return answer;
}

function envelopeText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

function storageInventory(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = require("node:fs") as typeof import("node:fs");
      if (stat.statSync(path).isDirectory()) {
        rows.push(`d ${path}`);
        walk(path);
      } else {
        const metadata = stat.statSync(path);
        rows.push(
          `f ${path} ${String(metadata.size)} ${String(metadata.mtimeMs)} ${String(metadata.ctimeMs)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
        );
      }
    }
  };
  if (existsSync(root)) walk(root);
  return rows.sort();
}

/** Normalizes the per-process requestId two same-shape envelopes legitimately differ by. */
function normalizedRequestId(text: string): string {
  const parsed = JSON.parse(text) as { meta?: { requestId?: string } };
  if (parsed.meta !== undefined && "requestId" in parsed.meta) parsed.meta.requestId = "<requestId>";
  return JSON.stringify(parsed, null, 2);
}

describe("the initialize handshake and protocol errors", () => {
  it("echoes each supported protocol version and answers an unknown one with the latest", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    for (const requested of ["2025-06-18", "2025-11-25"]) {
      const answer = (await session.request("initialize", { protocolVersion: requested })) as unknown as {
        result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: Record<string, string> };
      };
      expect(answer.result.protocolVersion).toBe(requested);
      expect(answer.result.capabilities).toEqual({ tools: {} });
      expect(answer.result.serverInfo.name).toBe("sorage");
    }
    const fallback = (await session.request("initialize", { protocolVersion: "2024-11-05" })) as unknown as {
      result: { protocolVersion: string };
    };
    expect(fallback.result.protocolVersion).toBe("2025-11-25");
    await session.close();
  });

  it("answers a malformed line with -32700, a batch array with -32600, an unknown method with -32601, and recovers the stream", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    session.child.stdin?.write("this is not json\n");
    const malformed = await session.waitForError(-32700);
    expect(malformed.id).toBeNull();
    session.send([{ jsonrpc: "2.0", id: 901, method: "ping" }]);
    const batch = await session.waitForError(-32600);
    expect(batch.id).toBeNull();
    const unknownMethod = (await session.request("resources/list", {}, 5_000)) as unknown as {
      error: { code: number; message: string };
    };
    expect(unknownMethod.error.code).toBe(-32601);
    const recovered = (await session.request("ping", {}, 5_000)) as unknown as { result: Record<string, unknown> };
    expect(recovered.result).toEqual({});
    await session.close();
  });

  it("answers an unknown tool and an invalid cwd with -32602", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const unknownTool = (await toolCall(session, "sorage_init", {})) as unknown as { error: { code: number } };
    expect(unknownTool.error?.code).toBe(-32602);
    const badCwd = (await toolCall(session, "project_list", { cwd: "/definitely/not/a/directory" })) as unknown as {
      error: { code: number; message: string };
    };
    expect(badCwd.error?.code).toBe(-32602);
    expect(badCwd.error?.message).toContain("cwd");
    await session.close();
  });
});

describe("the catalogue golden (MCP-005)", () => {
  it("pins the initialize result and tools/list byte-exact beside the CLI goldens", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    const initialize = (await session.request("initialize", { protocolVersion: "2025-06-18" })) as unknown as {
      result: Record<string, unknown>;
    };
    const listing = (await session.request("tools/list", {})) as unknown as {
      result: { tools: Array<Record<string, unknown>> };
    };
    await session.close();
    expect(listing.result.tools).toHaveLength(35);
    expect(listing.result.tools.map((tool) => tool.name as string)).not.toContain("init");
    const rendered = `${JSON.stringify({ initializeResult: initialize.result, toolsResult: listing.result }, null, 2)}\n`;
    if (process.env.SORAGE_TEST_REGEN_MCP_GOLDEN === "1") {
      writeFileSync(goldenPath, rendered);
      return;
    }
    expect(rendered).toBe(readFileSync(goldenPath, "utf8"));
  });
});

describe("accepted calls through real children (MCP-002, MCP-006)", () => {
  it("pins an accepted call byte-exact with the inherited request id", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA, { SORAGE_TEST_REQUEST_ID: "2f0ac9a0-0000-4000-8000-0000000000bb" });
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(session, "project_list", {})) as unknown as {
      result: { content: Array<{ type: string; text: string }>; structuredContent: { ok: boolean }; isError: boolean };
    };
    expect(answer.result?.isError).toBe(false);
    expect(envelopeText(answer.result as { content: Array<{ type: string; text: string }> })).toBe(
      `${JSON.stringify(answer.result?.structuredContent, null, 2)}\n`,
    );
    const direct = runCli(["project", "list", "--json"], home, workA, {
      SORAGE_TEST_REQUEST_ID: "2f0ac9a0-0000-4000-8000-0000000000bb",
    });
    expect(envelopeText(answer.result as { content: Array<{ type: string; text: string }> })).toBe(`${direct.stdout}`);
    await session.close();
  });

  it("resolves a cwd-less call as a CLI run from the server's working directory", async () => {
    const { home, workA, workB } = installation();
    const send = runCli(["send", "--to", "alpha", "--title", "Journey", "--body", "the body", "--json"], home, workB);
    expect(send.status, send.stderr).toBe(0);
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(session, "handoff_inbox", {})) as unknown as {
      result: { structuredContent: { data: { handoffs: Array<{ title: string }> } } };
    };
    expect(answer.result?.structuredContent.data.handoffs.map((handoff) => handoff.title)).toContain("Journey");
    await session.close();
  });

  it("passes handoff_fetch through and records the recipient's first fetch", async () => {
    const { home, workA, workB } = installation();
    const send = runCli(["send", "--to", "alpha", "--title", "To fetch", "--body", "fetch me", "--json"], home, workB);
    const handoffId = (JSON.parse(send.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId as string;
    // Before the fetch, the recipient has not engaged: firstFetchedAt is null.
    const beforeFetch = JSON.parse(runCli(["get", handoffId, "--json"], home, workA).stdout) as {
      data: { firstFetchedAt: string | null };
    };
    expect(beforeFetch.data.firstFetchedAt).toBeNull();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(session, "handoff_fetch", { handoffId })) as unknown as {
      result: { structuredContent: { ok: boolean; data: { artifact: { originalName: string } } }; isError: boolean };
    };
    expect(answer.result?.structuredContent.ok).toBe(true);
    expect(answer.result?.structuredContent.data.artifact.originalName).toBe("to-fetch-1.md");
    // The claimed effect: the recipient's first fetch is recorded, so the read
    // after it observes a non-null firstFetchedAt where it was null before.
    const afterFetch = JSON.parse(runCli(["get", handoffId, "--json"], home, workA).stdout) as {
      data: { firstFetchedAt: string | null };
    };
    expect(afterFetch.data.firstFetchedAt).not.toBeNull();
    const fetched = (await toolCall(session, "handoff_get", { handoffId })) as unknown as {
      result: { structuredContent: { data: { firstFetchedAt: string | null } } };
    };
    expect(fetched.result?.structuredContent.data.firstFetchedAt).not.toBeNull();
    await session.close();
  });

  it("returns the not-initialized envelope byte-exact on an absent home", async () => {
    const absent = tempDir("sorage-mcp-absent-");
    const goldenHome = "/tmp/sorage-golden-home";
    const session = startServer(absent, absent, {
      SORAGE_HOME: goldenHome,
      SORAGE_TEST_REQUEST_ID: "2f0ac9a0-0000-4000-8000-0000000000aa",
    });
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(session, "project_list", {})) as unknown as {
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };
    expect(answer.result?.isError).toBe(true);
    const direct = runCli(["project", "list", "--json"], absent, absent, {
      SORAGE_HOME: goldenHome,
      SORAGE_TEST_REQUEST_ID: "2f0ac9a0-0000-4000-8000-0000000000aa",
    });
    expect(envelopeText(answer.result as { content: Array<{ type: string; text: string }> })).toBe(direct.stderr);
    await session.close();
  });

  it("returns STORAGE_MIGRATION_REQUIRED with isError on an empty version-0 database", async () => {
    const { home, workA, workB } = installation();
    const send = runCli(["send", "--to", "alpha", "--title", "Older", "--body", "older body", "--json"], home, workB);
    expect(send.status, send.stderr).toBe(0);
    truncateSync(join(home, "state", "sorage.sqlite3"), 0);
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(session, "handoff_inbox", {})) as unknown as {
      result: { structuredContent: { error: { code: string } }; isError: boolean };
    };
    expect(answer.result?.structuredContent.error.code).toBe("STORAGE_MIGRATION_REQUIRED");
    expect(answer.result?.isError).toBe(true);
    await session.close();
  });
});

describe("real-wire encoding refusals (layer 1, plan 4.1)", () => {
  it("answers a lone surrogate and a NUL in a body with -32602, commits nothing, and keeps serving", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const surrogate = (await toolCall(session, "memo_add", { title: "broken", body: "a\uD800b" })) as unknown as {
      error?: { code: number };
    };
    expect(surrogate.error?.code).toBe(-32602);
    const nul = (await toolCall(session, "memo_add", { title: "broken", body: "a\0b" })) as unknown as {
      error?: { code: number };
    };
    expect(nul.error?.code).toBe(-32602);
    const listing = (await toolCall(session, "memo_list", {})) as unknown as {
      result: { structuredContent: { data: { memos?: unknown[]; items?: unknown[] } } };
    };
    const memos = listing.result?.structuredContent.data.memos ?? listing.result?.structuredContent.data.items ?? [];
    expect(memos).toHaveLength(0);
    const next = (await session.request("ping", {}, 5_000)) as unknown as { result: Record<string, unknown> };
    expect(next.result).toEqual({});
    await session.close();
  });
});

describe("coded layer-3 refusals return the CLI's exact envelopes (SOT-1)", () => {
  it("flows the Memo and Channel coded refusals and the send empty-fan-out refusal to the child", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });

    const memoReplay = (await toolCall(session, "memo_add", { title: "t", replayOnly: true })) as unknown as {
      result: { structuredContent: { error: { code: string; message: string } }; isError: boolean };
    };
    expect(memoReplay.result?.structuredContent.error.code).toBe("MEMO_INVALID_INPUT");
    expect(memoReplay.result?.structuredContent.error.message).toContain("original idempotency key");
    expect(memoReplay.result?.isError).toBe(true);

    const memoNumeric = (await toolCall(session, "memo_list", { limit: -1 })) as unknown as {
      result: { structuredContent: { error: { code: string; message: string } } };
    };
    expect(memoNumeric.result?.structuredContent.error.code).toBe("MEMO_INVALID_INPUT");
    expect(memoNumeric.result?.structuredContent.error.message).toContain("safe non-negative integers");

    const badRole = (await toolCall(session, "channel_add", {
      channel: "c",
      handle: "h",
      role: "boss",
    })) as unknown as {
      result: { structuredContent: { error: { code: string } } };
    };
    expect(badRole.result?.structuredContent.error.code).toBe("CHN_INVALID_INPUT");

    const absentTo = (await toolCall(session, "handoff_send", { title: "T", body: "b" })) as unknown as {
      result: { structuredContent: { error: { code: string; message: string } } };
    };
    expect(absentTo.result?.structuredContent.error.code).toBe("CONFIG_INVALID");
    expect(absentTo.result?.structuredContent.error.message).toContain("at least one --to");
    const emptyTo = (await toolCall(session, "handoff_send", { to: [], title: "T", body: "b" })) as unknown as {
      result: { structuredContent: { error: { code: string } } };
    };
    expect(emptyTo.result?.structuredContent.error.code).toBe("CONFIG_INVALID");
    await session.close();
  });

  it("carries a channel_ack seq operand below 1 to the CLI's own operand check", async () => {
    const { home, workA } = installation();
    const created = runCli(["channel", "create", "ack-check", "--json"], home, workA);
    expect(created.status, created.stderr).toBe(0);
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(session, "channel_ack", { channel: "ack-check", seq: [0] })) as unknown as {
      result: { structuredContent: { error: { code: string; message: string } } };
    };
    expect(answer.result?.structuredContent.error.code).toBe("CHN_INVALID_INPUT");
    expect(answer.result?.structuredContent.error.message).toContain("positive integers");
    await session.close();
  });
});

describe("real-server symlink escapes with in-domain postconditions (MCP-004)", () => {
  it("refuses a Handoff file, a Memo bodyFile and a Channel bodyFile escape, importing nothing, beside confined controls", async () => {
    const { home, workA, workB } = installation();
    const outside = tempDir("sorage-mcp-outside-");
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "the outside secret\n");
    // Each calling workspace carries its own escape link and confined file,
    // so the confinement decision is about the symlink, never the cwd.
    const link = join(home, "work-a", "link.md");
    symlinkSync(secret, link);
    const confined = join(home, "work-a", "inside.md");
    writeFileSync(confined, "the inside document\n");
    const senderLink = join(home, "work-b", "link.md");
    symlinkSync(secret, senderLink);
    const senderConfined = join(home, "work-b", "inside.md");
    writeFileSync(senderConfined, "the inside document\n");

    const send = runCli(
      ["send", "--to", "alpha", "--title", "Baseline", "--body", "baseline body", "--json"],
      home,
      workB,
    );
    expect(send.status, send.stderr).toBe(0);
    const handoffId = (JSON.parse(send.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId as string;

    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });

    // Handoff: the escape is attempted by the authorized sender (workB owns
    // the send), and a confined revise from the same sender is the control.
    const handoffBefore = runCli(["get", handoffId, "--json"], home, workB);
    const handoffEscape = (await toolCall(session, "handoff_revise", {
      handoffId,
      file: "link.md",
      cwd: workB,
    })) as unknown as {
      result: {
        structuredContent: { error: { code: string; message: string } };
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(handoffEscape.result?.structuredContent.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
    expect(handoffEscape.result?.isError).toBe(true);
    expect(
      (
        handoffEscape.result?.structuredContent as unknown as {
          error: { recovery: { suggestedCommand: string } };
        }
      ).error.recovery.suggestedCommand,
    ).toContain("inline body");
    const handoffAfter = runCli(["get", handoffId, "--json"], home, workB);
    expect(normalizedRequestId(handoffAfter.stdout)).toBe(normalizedRequestId(handoffBefore.stdout));
    const handoffControl = (await toolCall(session, "handoff_revise", {
      handoffId,
      file: "inside.md",
      expectedRowVersion: 1,
      cwd: workB,
    })) as unknown as {
      result: { structuredContent: { ok: boolean; data: { revision: number } }; isError: boolean };
    };
    expect(handoffControl.result?.structuredContent.ok).toBe(true);
    expect(handoffControl.result?.structuredContent.data.revision).toBe(2);

    // Memo: the escape imports nothing; the confined control does.
    const memoEscape = (await toolCall(session, "memo_add", {
      title: "escape",
      bodyFile: "link.md",
      cwd: workA,
    })) as unknown as {
      result: { structuredContent: { error: { code: string } } };
    };
    expect(memoEscape.result?.structuredContent.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
    const memoListing = (await toolCall(session, "memo_list", {})) as unknown as {
      result: { structuredContent: { data: { memos?: unknown[]; items?: unknown[] } } };
    };
    const memos =
      memoListing.result?.structuredContent.data.memos ?? memoListing.result?.structuredContent.data.items ?? [];
    expect(memos).toHaveLength(0);
    const memoControl = (await toolCall(session, "memo_add", {
      title: "confined",
      bodyFile: "inside.md",
      cwd: workA,
    })) as unknown as {
      result: { structuredContent: { ok: boolean }; isError: boolean };
    };
    expect(memoControl.result?.structuredContent.ok).toBe(true);
    expect(memoControl.result?.isError).toBe(false);

    // Channel: an existing Channel with a registered sender, so the escape's
    // postcondition is an empty listing, not a missing Channel.
    for (const args of [
      ["channel", "create", "esc", "--json"],
      ["channel", "add", "esc", "w", "--role", "worker", "--json"],
    ]) {
      const created = runCli(args, home, workA);
      expect(created.status, created.stderr).toBe(0);
    }
    const channelEscape = (await toolCall(session, "channel_post", {
      channel: "esc",
      from: "w",
      kind: "report",
      bodyFile: "link.md",
      cwd: workA,
    })) as unknown as {
      result: { structuredContent: { error: { code: string } } };
    };
    expect(channelEscape.result?.structuredContent.error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
    const empty = (await toolCall(session, "channel_messages", { channel: "esc" })) as unknown as {
      result: { structuredContent: { data: { items: unknown[] } } };
    };
    expect(empty.result?.structuredContent.data.items).toHaveLength(0);
    const channelControl = (await toolCall(session, "channel_post", {
      channel: "esc",
      from: "w",
      kind: "report",
      bodyFile: "inside.md",
      cwd: workA,
    })) as unknown as {
      result: { structuredContent: { ok: boolean }; isError: boolean };
    };
    expect(channelControl.result?.structuredContent.ok).toBe(true);
    expect(channelControl.result?.isError).toBe(false);
    const one = (await toolCall(session, "channel_messages", { channel: "esc" })) as unknown as {
      result: { structuredContent: { data: { items: Array<{ body: string }> } } };
    };
    expect(one.result?.structuredContent.data.items.map((item) => item.body)).toContain("the inside document\n");
    await session.close();
  });
});

describe("the Gap 2 diagnostic relay (SOT-2)", () => {
  it("carries a success-path stderr warning as exactly one additional item after the envelope", async () => {
    const { home, workA } = installation();
    for (const [key, value] of [
      ["gitBackup.enabled", "true"],
      ["gitBackup.largeArtifactWarningBytes", "16"],
    ] as Array<[string, string]>) {
      const lowered = runCli(["config", "set", key, value, "--as-user", "--json"], home, workA);
      if (lowered.status !== 0) throw new Error(`config set ${key} failed: ${lowered.stderr}`);
    }
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(session, "handoff_send", {
      to: ["alpha"],
      title: "Large",
      body: "a body far above sixteen bytes",
    })) as unknown as {
      result: { content: Array<{ type: string; text: string }>; structuredContent: { ok: boolean }; isError: boolean };
    };
    expect(answer.result?.structuredContent.ok).toBe(true);
    expect(answer.result?.isError).toBe(false);
    expect(answer.result?.content).toHaveLength(2);
    expect(answer.result?.content[0]?.text).toBe(`${JSON.stringify(answer.result?.structuredContent, null, 2)}\n`);
    // The pinned content: the large-content disclosure itself, naming the
    // configured threshold, not just any stderr line.
    expect(answer.result?.content[1]?.text).toContain(
      `The accepted body is ${String(Buffer.byteLength("a body far above sixteen bytes", "utf8"))} bytes, above gitBackup.largeArtifactWarningBytes (16 bytes)`,
    );
    expect(answer.result?.content[1]?.text).toContain("Git history keeps every committed revision");
    await session.close();
  });
});

describe("the end-of-options marker with real children (plan 4.1)", () => {
  it("creates a Channel named --help with a handle -x, and carries a -1 ack operand to the CLI's check", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const created = (await toolCall(session, "channel_create", { name: "--help" })) as unknown as {
      result: { structuredContent: { ok: boolean; data: { channel: { name: string } } } };
    };
    expect(created.result?.structuredContent.ok).toBe(true);
    expect(created.result?.structuredContent.data.channel.name).toBe("--help");
    const added = (await toolCall(session, "channel_add", {
      channel: "--help",
      handle: "-x",
      role: "worker",
    })) as unknown as {
      result: { structuredContent: { ok: boolean } };
    };
    expect(added.result?.structuredContent.ok).toBe(true);
    const shown = (await toolCall(session, "channel_show", { channel: "--help" })) as unknown as {
      result: { structuredContent: { data: { channel: { participants: Array<{ handle: string }> } } } };
    };
    expect(
      shown.result?.structuredContent.data.channel.participants.map((participant) => participant.handle),
    ).toContain("-x");
    const negativeAck = (await toolCall(session, "channel_ack", { channel: "--help", seq: [-1] })) as unknown as {
      result: { structuredContent: { error: { code: string } } };
    };
    expect(negativeAck.result?.structuredContent.error.code).toBe("CHN_INVALID_INPUT");
    await session.close();
  });
});

describe("the command surface (plan 2.4)", () => {
  it("prints help for sorage mcp --help without starting a server", () => {
    const { home, workA } = installation();
    const helped = runCli(["mcp", "--help"], home, workA);
    expect(helped.status).toBe(0);
    expect(helped.stdout).toContain("STDIO MCP adapter");
  });

  it("refuses extra operands with a usage exit", () => {
    const { home, workA } = installation();
    const extra = runCli(["mcp", "extra"], home, workA);
    expect(extra.status).toBe(2);
    expect(extra.stderr).toContain("arguments");
  });

  it("starts the server when a global option precedes the command", async () => {
    const { home, workA } = installation();
    const child = spawn("bun", [entry, "--json", "mcp"], {
      cwd: workA,
      env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: undefined },
      stdio: ["pipe", "pipe", "pipe"],
    });
    SANDBOX_FREE_CLEANUPS.push(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    });
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no initialize answer")), 15_000);
      const initSplitter = new LineSplitter();
      child.stdout?.on("data", (chunk: Buffer) => {
        const produced = initSplitter.push(chunk);
        const first = produced[0];
        if (first !== undefined) {
          clearTimeout(timer);
          resolve(JSON.parse(first) as Record<string, unknown>);
        }
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
      );
    });
    expect((answer.result as { serverInfo: { name: string } }).serverInfo.name).toBe("sorage");
    child.stdin?.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });
});

describe("the server never self-registers (MCP-001)", () => {
  it("leaves the HOME inventory unchanged after a full session", async () => {
    const fakeHome = tempDir("sorage-mcp-home-inventory-");
    const { home, workA } = installation();
    const before = storageInventory(fakeHome);
    const session = startServer(home, workA, { HOME: fakeHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    await toolCall(session, "project_list", {});
    await session.close();
    expect(storageInventory(fakeHome)).toEqual(before);
  });
});

function childrenOfSession(session: Session): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(session.child.pid)])
      .toString()
      .split("\n")
      .map((line) => Number.parseInt(line, 10))
      .filter((value) => Number.isSafeInteger(value));
  } catch {
    return [];
  }
}

describe("the lifecycle (plan 4.5)", () => {
  function childrenOf(pid: number | null | undefined): number[] {
    if (pid === null || pid === undefined) return [];
    try {
      return execFileSync("pgrep", ["-P", String(pid)])
        .toString()
        .split("\n")
        .map((line) => Number.parseInt(line, 10))
        .filter((value) => Number.isSafeInteger(value));
    } catch {
      return [];
    }
  }

  it("answers a concurrent post first while a wait is in flight, then wakes with the message", async () => {
    const { home, workA } = installation();
    for (const args of [
      ["channel", "create", "race", "--json"],
      ["channel", "add", "race", "w1", "--role", "worker", "--json"],
    ]) {
      const created = runCli(args, home, workA);
      expect(created.status, created.stderr).toBe(0);
    }
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const arrivalOrder: string[] = [];
    const record = (message: Record<string, unknown>): void => {
      if (message.id === 2) arrivalOrder.push("wait");
      if (message.id === 3) arrivalOrder.push("post");
    };
    const waitPromise = toolCall(session, "channel_messages", { channel: "race", wait: true, timeout: 20 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const post = (await toolCall(session, "channel_post", {
      channel: "race",
      from: "w1",
      kind: "report",
      body: "the wake",
    })) as unknown as {
      result: { structuredContent: { ok: boolean } };
    };
    expect(post.result?.structuredContent.ok).toBe(true);
    const wait = (await waitPromise) as unknown as {
      result: { structuredContent: { data: { items: Array<{ body: string }> } } };
    };
    expect(wait.result?.structuredContent.data.items.map((item) => item.body)).toContain("the wake");
    // The claimed effect, recorded from the wire: the post's response arrives
    // before the wait's, on one connection with both in flight.
    for (const line of session.lines) {
      try {
        record(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Non-JSON lines are a defect the pinned tests surface elsewhere.
      }
    }
    expect(arrivalOrder).toEqual(["post", "wait"]);
    await session.close();
  });

  it("cancels an in-flight wait: the child is gone, no response arrives, and the next call works", async () => {
    const { home, workA } = installation();
    for (const args of [
      ["channel", "create", "cancel", "--json"],
      ["channel", "add", "cancel", "w1", "--role", "worker", "--json"],
    ]) {
      const created = runCli(args, home, workA);
      expect(created.status, created.stderr).toBe(0);
    }
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const linesBefore = session.lines.length;
    void toolCall(session, "channel_messages", { channel: "cancel", wait: true, timeout: 30 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const liveChildren = childrenOf(session.child.pid);
    expect(liveChildren).toHaveLength(1);
    const waiterPid = liveChildren[0] as number;
    session.notify("notifications/cancelled", { requestId: 2 });
    // The claimed effect: the captured child PID terminates — asserted before
    // any cleanup could conceal a leaked waiter.
    const cancelled = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = (): void => {
        try {
          process.kill(waiterPid, 0);
          if (Date.now() - started > 5_000) resolve(false);
          else setTimeout(poll, 50);
        } catch {
          resolve(true);
        }
      };
      poll();
    });
    expect(cancelled).toBe(true);
    expect(session.lines.length).toBe(linesBefore);
    const after = (await session.request("ping", {}, 5_000)) as unknown as { result: Record<string, unknown> };
    expect(after.result).toEqual({});
    await session.close();
  });

  it("kills the live waiter when stdin closes: the captured child PID exits, separately from the server", async () => {
    const { home, workA } = installation();
    for (const args of [
      ["channel", "create", "eof", "--json"],
      ["channel", "add", "eof", "w1", "--role", "worker", "--json"],
    ]) {
      const created = runCli(args, home, workA);
      expect(created.status, created.stderr).toBe(0);
    }
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    void toolCall(session, "channel_messages", { channel: "eof", wait: true, timeout: 30 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const liveChildren = childrenOf(session.child.pid);
    expect(liveChildren).toHaveLength(1);
    const waiterPid = liveChildren[0] as number;
    const waiterGone = new Promise<boolean>((resolve) => {
      const poll = (): void => {
        try {
          process.kill(waiterPid, 0);
          setTimeout(poll, 100);
        } catch {
          resolve(true);
        }
      };
      poll();
    });
    session.child.stdin?.end();
    await session.close();
    expect(await waiterGone).toBe(true);
    expect(session.child.exitCode).not.toBeNull();
  });

  it("returns a timed-out wait with isError false and meta.timedOut true", async () => {
    const { home, workA } = installation();
    const created = runCli(["channel", "create", "quiet", "--json"], home, workA);
    expect(created.status, created.stderr).toBe(0);
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const answer = (await toolCall(
      session,
      "channel_messages",
      { channel: "quiet", wait: true, timeout: 1 },
      20_000,
    )) as unknown as {
      result: { structuredContent: { data: unknown; meta: { timedOut?: boolean } }; isError: boolean };
    };
    expect(answer.result?.isError).toBe(false);
    expect(answer.result?.structuredContent.meta.timedOut).toBe(true);
    await session.close();
  });
});

describe("C2 additions: request validation, crash safety, late cancellation, multilingual children", () => {
  it("refuses a request object with a wrong protocol marker or an unusable id, executing nothing", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    session.send({ id: 41, method: "ping" });
    session.send({ jsonrpc: "1.0", id: 42, method: "ping" });
    session.send({
      jsonrpc: "2.0",
      id: { object: true },
      method: "tools/call",
      params: { name: "channel_create", arguments: { name: "smuggled" } },
    });
    session.send({
      jsonrpc: "2.0",
      id: null,
      method: "tools/call",
      params: { name: "channel_create", arguments: { name: "smuggled" } },
    });
    session.send({ jsonrpc: "2.0", id: 1.5, method: "ping" });
    const invalidCount = await session.waitForInvalidRequestCount(5);
    expect(invalidCount).toBe(5);
    // Nothing executed: the smuggled channel does not exist.
    const listing = (await toolCall(session, "channel_list", {})) as unknown as {
      result: { structuredContent: { data: { items: Array<{ name: string }> } } };
    };
    expect(listing.result?.structuredContent.data.items.map((item) => item.name)).not.toContain("smuggled");
    // A following valid request still works (stream recovery).
    const recovered = (await session.request("ping", {}, 5_000)) as unknown as { result: Record<string, unknown> };
    expect(recovered.result).toEqual({});
    await session.close();
  });

  it("refuses channel_ack without seq through the real server and keeps serving", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const refused = (await toolCall(session, "channel_ack", { channel: "c" })) as unknown as {
      error?: { code: number; message: string };
    };
    expect(refused.error?.code).toBe(-32602);
    expect(refused.error?.message).toBe("missing required argument 'seq...'");
    const next = (await session.request("ping", {}, 5_000)) as unknown as { result: Record<string, unknown> };
    expect(next.result).toEqual({});
    await session.close();
  });

  it("ignores a late cancellation and answers a request that reuses the id", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    // A tools/call whose id the session then genuinely reuses: only the
    // tools/call path consults the cancelled set, so this is the discriminating
    // reuse (a ping would never be suppressed either way).
    const linesBeforeReuse = session.lines.length;
    session.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "project_list", arguments: {} } });
    const firstAnswer = (await session.waitForRequestId(7, linesBeforeReuse)) as { result?: { result?: unknown } };
    expect(firstAnswer.result).toBeDefined();
    // The id is no longer in flight; this cancellation must not poison it.
    session.notify("notifications/cancelled", { requestId: 7 });
    session.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "project_list", arguments: {} } });
    const reusedAnswer = (await session.waitForRequestId(7, linesBeforeReuse + 1)) as { result?: { result?: unknown } };
    expect(reusedAnswer.result).toBeDefined();
    await session.close();
  });

  it("refuses a params-level non-object arguments with -32602 and keeps serving", async () => {
    const { home, workA } = installation();
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const bad = (await toolCall(
      session,
      "project_list",
      "not an object" as unknown as Record<string, unknown>,
    )) as unknown as {
      error?: { code: number };
    };
    expect(bad.error?.code).toBe(-32602);
    const next = (await session.request("ping", {}, 5_000)) as unknown as { result: Record<string, unknown> };
    expect(next.result).toEqual({});
    await session.close();
  });

  it(
    "settles a real injected builder fault with the crash row's INTERNAL_ERROR envelope and keeps serving",
    { timeout: 60_000 },
    async () => {
      const { home, workA } = installation();
      // The preload replaces project_list's argv builder at runtime with one
      // that records its own execution and then throws; no production seam
      // exists (probe p6 verified the mechanism against the real server).
      const marker = join(home, "inject-marker");
      const inject = join(home, "inject-builder.ts");
      const cataloguePath = fileURLToPath(new URL("../../src/mcp-catalogue.ts", import.meta.url));
      writeFileSync(
        inject,
        [
          `import { mcpToolByName } from ${JSON.stringify(cataloguePath)};`,
          'import { writeFileSync } from "node:fs";',
          'const tool = mcpToolByName("project_list") as unknown as { argv: (a: Record<string, unknown>) => string[] };',
          "tool.argv = () => {",
          `  writeFileSync(${JSON.stringify(marker)}, "ran");`,
          '  process.stderr.write("INJECTED-BUILDER-RAN\\n");',
          '  throw new Error("injected builder fault");',
          "};",
          "",
        ].join("\n"),
      );
      const child = spawn("bun", ["--preload", inject, entry, "mcp"], {
        cwd: workA,
        env: {
          ...process.env,
          SORAGE_HOME: home,
          SORAGE_TEST_REQUEST_ID: undefined,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      SANDBOX_FREE_CLEANUPS.push(() => {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      });
      let injectedStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        injectedStderr += chunk.toString("utf8");
      });
      const splitter = new LineSplitter();
      const answerFor = (id: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`no answer for ${String(id)}; stderr: ${injectedStderr.slice(0, 500)}`)),
            20_000,
          );
          const poll = (): void => {
            const found = splitter
              .recorded()
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .find((message) => message.id === id);
            if (found !== undefined) {
              clearTimeout(timer);
              resolve(found);
            } else setTimeout(poll, 25);
          };
          poll();
        });
      child.stdout?.on("data", (chunk: Buffer) => {
        splitter.push(chunk);
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
      );
      await answerFor(1);
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project_list", arguments: {} } })}\n`,
      );
      const fault = (await answerFor(2)) as {
        result?: { isError: boolean; structuredContent: { error: { code: string; message: string } } };
        error?: { code: number };
      };
      // The injection ran — recorded by the replaced builder itself.
      expect(readFileSync(marker, "utf8")).toBe("ran");
      expect(injectedStderr).toContain("INJECTED-BUILDER-RAN");
      // The crash row: the synthesized INTERNAL_ERROR envelope, isError true, with the call's id.
      expect(fault.error).toBeUndefined();
      expect(fault.result?.isError).toBe(true);
      expect(fault.result?.structuredContent.error.code).toBe("INTERNAL_ERROR");
      expect(fault.result?.structuredContent.error.message).toContain("injected builder fault");
      // A server fault names the server; only a child crash, signal or spawn
      // failure keeps the child wording (C4 item 2).
      expect(fault.result?.structuredContent.error.message).toContain(
        "the sorage server failed before running the command",
      );
      // The server keeps serving: a following tools/call succeeds (a different
      // tool, because the injected builder stays replaced for this process).
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "channel_list", arguments: {} } })}\n`,
      );
      const after = (await answerFor(3)) as { result?: { isError: boolean } };
      expect(after.result?.isError).toBe(false);
      child.stdin?.end();
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
    },
  );

  it("carries a multilingual body through a real child byte-exactly", async () => {
    const { home, workA } = installation();
    const body = "다국어 본문 — 서울 테스트";
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    const added = (await toolCall(session, "memo_add", { title: "다국어", body })) as unknown as {
      result: { structuredContent: { ok: boolean; data: { memo: { id: string } } } };
    };
    expect(added.result?.structuredContent.ok).toBe(true);
    const memoId = added.result?.structuredContent.data.memo.id as string;
    const shown = (await toolCall(session, "memo_show", { memoId })) as unknown as {
      result: { structuredContent: { data: { body: string } }; content: Array<{ type: string; text: string }> };
    };
    expect(shown.result?.structuredContent.data.body).toBe(body);
    const direct = runCli(["memo", "show", memoId, "--json"], home, workA);
    expect(normalizedRequestId(shown.result?.content[0]?.text ?? "")).toBe(normalizedRequestId(direct.stdout));
    await session.close();
  });

  it("ends the server on SIGTERM while stdin stays open, and the captured child PID terminates", async () => {
    const { home, workA } = installation();
    for (const args of [
      ["channel", "create", "sig", "--json"],
      ["channel", "add", "sig", "w1", "--role", "worker", "--json"],
    ]) {
      const created = runCli(args, home, workA);
      expect(created.status, created.stderr).toBe(0);
    }
    const session = startServer(home, workA);
    await session.request("initialize", { protocolVersion: "2025-06-18" });
    void toolCall(session, "channel_messages", { channel: "sig", wait: true, timeout: 30 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const live = await new Promise<number[]>((resolve) => {
      const poll = (): void => {
        const found = childrenOfSession(session);
        if (found.length === 1) resolve(found);
        else setTimeout(poll, 50);
      };
      poll();
    });
    const waiterPid = live[0] as number;
    const serverExit = new Promise<number | null>((resolve) => {
      session.child.on("close", (code) => resolve(code));
    });
    // stdin stays open; the signal alone must end the server.
    session.child.kill("SIGTERM");
    const serverCode = await serverExit;
    expect(serverCode).not.toBeNull();
    const waiterGone = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = (): void => {
        try {
          process.kill(waiterPid, 0);
          if (Date.now() - started > 5_000) resolve(false);
          else setTimeout(poll, 50);
        } catch {
          resolve(true);
        }
      };
      poll();
    });
    expect(waiterGone).toBe(true);
  });
});

describe("the SIGKILL escalation is discriminated by a waiter that cannot end on SIGTERM (C3 item 5)", () => {
  /**
   * The fixture: the server runs under a preload that rewrites process.execPath
   * to a wrapper which execs the real bun with a SIGTERM-trapping preload. A
   * wait child then traps SIGTERM by its own runtime choice (injected at test
   * scope only — no production seam), so the only thing that can end it within
   * the bound is the SIGTERM→SIGKILL escalation under test.
   */
  function escalationInstallation(): {
    home: string;
    workA: string;
    realBun: string;
    preload: string;
    trap: string;
    trapMarker: string;
  } {
    const { home, workA } = installation("sorage-mcp-escalation-");
    // Runs in LIFO order just before the home's rmSync (registered earlier by
    // tempDir), so the order record separates "the waiter died" from "the
    // home removal began".
    SANDBOX_FREE_CLEANUPS.push(() => {
      CLEANUP_ORDER.push("escalation-home:removal");
    });
    for (const args of [
      ["channel", "create", "esc", "--json"],
      ["channel", "add", "esc", "w1", "--role", "worker", "--json"],
    ]) {
      const created = runCli(args, home, workA);
      expect(created.status, created.stderr).toBe(0);
    }
    // Under vitest, process.execPath is the Node running the test runner; the
    // wrapper's exec resolves REAL_BUN through PATH, where bun lives.
    const realBun = "bun";
    const trapMarker = join(home, "trap-marker");
    const trap = join(home, "trap-term.ts");
    writeFileSync(
      trap,
      [
        'import { appendFileSync } from "node:fs";',
        "// Runs inside every child the server spawns for this test. A wait child",
        "// registers a SIGTERM handler at load — Bun replaces the default",
        "// terminate disposition at registration — and records that the trap is",
        "// installed. A blocking wait cannot run the handler promptly, so the",
        "// marker is written at load, not on signal.",
        "const argv = process.argv.slice(2).map(String);",
        'if (argv.includes("--wait")) {',
        '  process.on("SIGTERM", () => {});',
        `  appendFileSync(${JSON.stringify(trapMarker)}, "trap-installed\\n");`,
        "}",
        "",
      ].join("\n"),
    );
    const wrapper = join(home, "exec-wrapper.sh");
    writeFileSync(wrapper, ["#!/bin/sh", 'exec "$REAL_BUN" --preload "$TRAP_PRELOAD" "$@"', ""].join("\n"));
    chmodSync(wrapper, 0o755);
    const preload = join(home, "execpath-inject.ts");
    writeFileSync(
      preload,
      [
        'import { appendFileSync as af } from "node:fs";',
        `process.execPath = ${JSON.stringify(wrapper)};`,
        `af(${JSON.stringify(join(home, "patched-marker"))}, \`ran realBun=\${process.env.REAL_BUN} trap=\${process.env.TRAP_PRELOAD} execPathNow=\${process.execPath}\n\`);`,
        "",
      ].join("\n"),
    );
    return { home, workA, realBun, preload, trap, trapMarker };
  }

  interface EscalationSession {
    child: ChildProcess;
    waiterPid(): Promise<number>;
    cancel(id: number): void;
    endStdin(): void;
    exit: Promise<number | null>;
    stderr: () => string;
  }

  function startEscalationServer(setup: ReturnType<typeof escalationInstallation>): EscalationSession {
    const child = spawn("bun", ["--preload", setup.preload, entry, "mcp"], {
      cwd: setup.workA,
      env: {
        ...process.env,
        SORAGE_HOME: setup.home,
        SORAGE_TEST_REQUEST_ID: undefined,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        REAL_BUN: setup.realBun,
        TRAP_PRELOAD: setup.trap,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    SANDBOX_FREE_CLEANUPS.push(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const splitter = new LineSplitter();
    child.stdout?.on("data", (chunk: Buffer) => {
      splitter.push(chunk);
    });
    const send = (message: unknown): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    const waiterPid = async (): Promise<number> => {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          if (splitter.recorded().length > 0) resolve();
          else if (Date.now() - started > 10_000) reject(new Error("no initialize answer"));
          else setTimeout(poll, 25);
        };
        poll();
      });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "channel_messages", arguments: { channel: "esc", wait: true, timeout: 30 } },
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        const children = childrenOfSession({ child } as Session);
        const waiter = children.find((pid) => {
          try {
            return execFileSync("ps", ["-o", "command=", "-p", String(pid)])
              .toString()
              .includes("messages");
          } catch {
            return false;
          }
        });
        if (waiter !== undefined) return waiter;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`the waiter never appeared; stderr: ${stderr.slice(0, 400)}`);
    };
    const exit = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    return {
      child,
      waiterPid,
      cancel: (id) => send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }),
      endStdin: () => child.stdin?.end(),
      exit,
      stderr: () => stderr,
    };
  }

  /**
   * The fixture owns its waiter (c3-decision item 5, TE 3): once captured, a
   * cleanup kills that exact PID and resolves only when it is gone, on every
   * exit path — including a failed assertion — and before the afterEach that
   * removes the temporary home.
   */
  function ownWaiter(pid: number): void {
    SANDBOX_FREE_CLEANUPS.push(async () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      const started = Date.now();
      while (Date.now() - started < 5_000) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          CLEANUP_ORDER.push(`waiter:${String(pid)}:dead`);
          return;
        }
      }
      throw new Error(`waiter ${String(pid)} survived cleanup`);
    });
  }

  async function assertTerminatedWithinBound(pid: number, label: string): Promise<void> {
    const terminated = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = (): void => {
        try {
          process.kill(pid, 0);
          if (Date.now() - started > 8_000) resolve(false);
          else setTimeout(poll, 100);
        } catch {
          resolve(true);
        }
      };
      poll();
    });
    expect(terminated, label).toBe(true);
  }

  it(
    "escalates on cancellation: a SIGTERM-trapping waiter terminates within a bound above the grace",
    { timeout: 60_000 },
    async () => {
      const setup = escalationInstallation();
      const session = startEscalationServer(setup);
      const waiterPid = await session.waiterPid();
      ownWaiter(waiterPid);
      // The waiter cannot end on SIGTERM by its own runtime choice.
      // The wrapper exec and the trap install take a moment after the pid
      // appears; the marker is written at load inside the wait child.
      const trapInstalled = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const poll = (): void => {
          if (existsSync(setup.trapMarker)) resolve(true);
          else if (Date.now() - started > 8_000) resolve(false);
          else setTimeout(poll, 50);
        };
        poll();
      });
      if (!trapInstalled) {
        const command = execFileSync("ps", ["-o", "command=", "-p", String(waiterPid)]).toString();
        throw new Error(
          `the trap never installed; waiter: ${command}; patched: ${existsSync(join(setup.home, "patched-marker")) ? readFileSync(join(setup.home, "patched-marker"), "utf8").trim() : "absent"}; wrapper: ${readFileSync(join(setup.home, "exec-wrapper.sh"), "utf8").trim()}; stderr: ${session.stderr().slice(0, 200)}`,
        );
      }
      process.kill(waiterPid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(() => process.kill(waiterPid, 0), "the waiter ignored a direct SIGTERM").not.toThrow();
      session.cancel(2);
      await assertTerminatedWithinBound(waiterPid, "cancellation escalation");
      expect(existsSync(join(setup.home, "patched-marker")), "the execPath patch ran in the server").toBe(true);
      expect(existsSync(setup.trapMarker), "the trap ran and ignored SIGTERM").toBe(true);
      session.endStdin();
      await session.exit;
    },
  );

  it(
    "escalates on EOF shutdown: a SIGTERM-trapping waiter terminates within a bound above the grace",
    { timeout: 60_000 },
    async () => {
      const setup = escalationInstallation();
      const session = startEscalationServer(setup);
      const waiterPid = await session.waiterPid();
      ownWaiter(waiterPid);
      const eofStarted = Date.now();
      const trapInstalled = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const poll = (): void => {
          if (existsSync(setup.trapMarker)) resolve(true);
          else if (Date.now() - started > 8_000) resolve(false);
          else setTimeout(poll, 50);
        };
        poll();
      });
      expect(trapInstalled, "the trap installed in the wait child").toBe(true);
      process.kill(waiterPid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(() => process.kill(waiterPid, 0), "the waiter ignored a direct SIGTERM").not.toThrow();
      session.endStdin();
      const code = await session.exit;
      expect(code).not.toBeNull();
      await assertTerminatedWithinBound(waiterPid, "EOF escalation");
      // The whole shutdown must sit inside the escalation budget, so a child
      // that merely outlives the server to its own 30 s wait timeout cannot
      // satisfy this case.
      expect(Date.now() - eofStarted, "the EOF escalation ran inside its budget").toBeLessThan(15_000);
      expect(existsSync(join(setup.home, "patched-marker")), "the execPath patch ran in the server").toBe(true);
      expect(existsSync(setup.trapMarker), "the trap ran and ignored SIGTERM").toBe(true);
    },
  );
});

describe("reporting through real MCP CLI children (interface section 40)", () => {
  it("executes the shipped Handoff example with real version observations and sender discovery", async () => {
    const { home, workA, workB } = installation("sorage-mcp-skill-example-");
    const document = "Verify result.txt contains pending followed by LF; report the result.";
    const sent = runCli(
      ["send", "--to", "beta", "--title", "Verify existing bytes", "--body", document, "--json"],
      home,
      workA,
    );
    expect(sent.status, sent.stderr).toBe(0);
    const handoffId = JSON.parse(sent.stdout).data.handoffs[0].handoffId;
    const resultPath = join(workB, "result.txt");
    writeFileSync(resultPath, "pending\n");
    const reference = readFileSync(
      fileURLToPath(new URL("../../../../skills/use-sorage/references/handoffs.md", import.meta.url)),
      "utf8",
    );
    const calls = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      ([, json]) => JSON.parse(json as string) as { tool: string; arguments: Record<string, unknown> },
    );
    expect(calls.length).toBeGreaterThan(0);
    const session = startServer(home, workB);
    await session.request("initialize", { protocolVersion: "2025-11-25" });
    const workspaces = new Map([
      ["/lab/recipient", workB],
      ["/lab/sender", workA],
    ]);
    for (const call of calls) {
      const cwd = workspaces.get(call.arguments.cwd as string);
      expect(cwd, call.tool).toBeDefined();
      if (call.tool === "handoff_processing_complete") expect(readFileSync(resultPath, "utf8")).toBe("pending\n");
      const answer = await toolCall(session, call.tool, {
        ...call.arguments,
        handoffId: call.arguments.handoffId === "handoff-id" ? handoffId : call.arguments.handoffId,
        cwd,
      });
      expect(answer.error, call.tool).toBeUndefined();
      expect(answer.result?.isError, JSON.stringify(answer.result)).toBe(false);
      expect(answer.result?.structuredContent.ok, call.tool).toBe(true);
      if (call.tool === "handoff_fetch") {
        const data = answer.result?.structuredContent.data as { localPath: string };
        expect(readFileSync(data.localPath, "utf8")).toBe(document);
      }
    }
    const metadata = runCli(["get", handoffId, "--json"], home, workA);
    expect(metadata.status, metadata.stderr).toBe(0);
    expect(JSON.parse(metadata.stdout).data).toMatchObject({
      revision: 1,
      rowVersion: 4,
      reviewState: "awaiting_recipient",
      read: { status: "read" },
      processing: { status: "completed" },
    });
    const comment = runCli(["comment", "show", handoffId, "--json"], home, workA);
    expect(comment.status, comment.stderr).toBe(0);
    expect(JSON.parse(comment.stdout).data).toMatchObject({
      body: "Verified result.txt contains pending; no file changed.",
      purpose: "general",
      active: false,
      targetRevision: 1,
    });
    expect(readFileSync(resultPath, "utf8")).toBe("pending\n");
    await session.close();
  }, 30_000);

  it("preserves exact CLI envelopes, observations, declined feedback and independent processing", async () => {
    const { home, workA, workB } = installation("sorage-mcp-reporting-");
    const session = startServer(home, workB);
    const cli = (args: string[], cwd = workB) => runCli([...args, "--json"], home, cwd);
    const data = (args: string[], cwd = workB) => {
      const result = cli(args, cwd);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    const id = data(["send", "--to", "beta", "--title", "Reports", "--body", "Document"], workA).handoffs[0].handoffId;
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = await toolCall(session, name, { handoffId: id, cwd: workB, ...args });
      expect(answer.error).toBeUndefined();
      expect(answer.result).toBeDefined();
      expect(answer.result?.content[0]?.text).toBeDefined();
      expect(answer.result?.structuredContent).toEqual(JSON.parse(answer.result?.content[0]?.text ?? "null"));
      return answer.result;
    };
    const before = data(["events", id]);
    for (const name of ["handoff_comment_set", "handoff_processing_start", "handoff_processing_complete"]) {
      const answer = await toolCall(session, name, { handoffId: id, cwd: workB, text: "Proposal" });
      expect(answer.error?.code).toBe(-32602);
    }
    expect(data(["events", id])).toEqual(before);
    const fields = { expectedRevision: 1, expectedRowVersion: 1 };
    const sender = await call("handoff_comment_set", { ...fields, text: "Sender", cwd: workA });
    const senderCli = cli(
      ["comment", "set", id, "--text", "Sender", "--expected-revision", "1", "--expected-row-version", "1"],
      workA,
    );
    expect(normalizedRequestId(sender?.content[0]?.text ?? "")).toBe(normalizedRequestId(senderCli.stderr));
    expect(sender?.structuredContent).toMatchObject({ error: { code: "FORBIDDEN_ACTOR" } });
    writeFileSync(join(workB, "request.md"), "  Please change\n");
    const requested = await call("handoff_comment_set", { ...fields, file: "request.md", purpose: "change_request" });
    expect(requested?.structuredContent).toMatchObject({
      data: { comment: { body: "  Please change\n", active: true } },
    });
    const stored = data(["get", id]);
    const events = data(["events", id]);
    for (const [name, args, cliArgs] of [
      [
        "handoff_comment_set",
        { ...fields, text: "Proposal", purpose: "change_request" },
        [
          "comment",
          "set",
          id,
          "--text",
          "Proposal",
          "--purpose",
          "change_request",
          "--expected-revision",
          "1",
          "--expected-row-version",
          "1",
        ],
      ],
      [
        "handoff_processing_start",
        fields,
        ["processing", "start", id, "--expected-revision", "1", "--expected-row-version", "1"],
      ],
      ["handoff_review_withdraw", { expectedRowVersion: 1 }, ["review", "withdraw", id, "--expected-row-version", "1"]],
      [
        "handoff_revise",
        { noChange: true, reason: "Keep", expectedRowVersion: 1 },
        ["revise", id, "--no-change", "--reason", "Keep", "--expected-row-version", "1"],
      ],
    ] as Array<[string, Record<string, unknown>, string[]]>) {
      const refused = await call(name, { ...args, ...(name === "handoff_revise" ? { cwd: workA } : {}) });
      expect(refused?.structuredContent).toMatchObject({ error: { code: "ROW_VERSION_CONFLICT" } });
      expect(normalizedRequestId(refused?.content[0]?.text ?? "")).toBe(
        normalizedRequestId(cli(cliArgs, name === "handoff_revise" ? workA : workB).stderr),
      );
    }
    expect(data(["get", id])).toEqual(stored);
    expect(data(["events", id])).toEqual(events);
    const declined = await call("handoff_decline", { reason: "Stopped", expectedRowVersion: 2 });
    expect(declined?.structuredContent).toMatchObject({ data: { reviewState: "declined" } });
    const inventory = storageInventory(home);
    const read = await call("handoff_comment_show", {});
    expect(read?.structuredContent).toMatchObject({
      data: { body: "  Please change\n", purpose: "change_request", active: false, targetRevision: 1 },
    });
    expect(normalizedRequestId(read?.content[0]?.text ?? "")).toBe(
      normalizedRequestId(cli(["comment", "show", id]).stdout),
    );
    expect((await call("handoff_review_show", {}))?.structuredContent).toMatchObject({ data: null });
    expect(storageInventory(home)).toEqual(inventory);
    const replaced = await call("handoff_comment_set", {
      text: "Why stopped",
      expectedRevision: 1,
      expectedRowVersion: 3,
    });
    expect(replaced?.structuredContent).toMatchObject({
      data: {
        handoff: { reviewState: "declined", processing: { status: "not_started", completedAt: null } },
        comment: { purpose: "general", active: false },
      },
    });
    expect(
      (await call("handoff_processing_start", { expectedRevision: 1, expectedRowVersion: 4 }))?.structuredContent,
    ).toMatchObject({ error: { code: "HANDOFF_TERMINAL" } });

    const second = data(["send", "--to", "beta", "--title", "Accepted work", "--body", "Document"], workA).handoffs[0]
      .handoffId;
    const started = await call("handoff_processing_start", { handoffId: second, ...fields, commentText: "Started" });
    expect(started?.structuredContent).toMatchObject({
      data: { handoff: { rowVersion: 2, read: { status: "unconfirmed" }, processing: { status: "in_progress" } } },
    });
    await call("handoff_accept", { handoffId: second, expectedRevision: 1, expectedRowVersion: 2 });
    writeFileSync(join(workB, "done.md"), "Completed\n");
    const done = await call("handoff_processing_complete", {
      handoffId: second,
      expectedRevision: 1,
      expectedRowVersion: 3,
      commentFile: "done.md",
    });
    expect(done?.structuredContent).toMatchObject({
      data: {
        handoff: { reviewState: "accepted", rowVersion: 4, processing: { status: "completed" } },
        comment: { body: "Completed\n" },
      },
    });
    expect(
      (
        await call("handoff_processing_complete", {
          handoffId: second,
          expectedRevision: 1,
          expectedRowVersion: 4,
          commentText: "Retry proposal",
        })
      )?.structuredContent,
    ).toMatchObject({ error: { code: "PROCESSING_STATE_CONFLICT" } });
    await session.close();
  }, 30_000);

  it("retains conditional successful revise replay before fresh-observation admission", async () => {
    const { home, workA, workB } = installation("sorage-mcp-report-replay-");
    const session = startServer(home, workA);
    const run = (args: string[], cwd = workA) => {
      const result = runCli([...args, "--json"], home, cwd);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    const id = run(["send", "--to", "beta", "--title", "Replay", "--body", "Document"]).handoffs[0].handoffId;
    run(["review", "set", id, "--text", "Request", "--target-revision", "1", "--expected-row-version", "1"], workB);
    const original = await toolCall(session, "handoff_revise", {
      handoffId: id,
      cwd: workA,
      noChange: true,
      reason: "No change",
      expectedRowVersion: 2,
      idempotencyKey: "report-replay",
    });
    expect(original.result?.isError).toBe(false);
    run(["comment", "set", id, "--text", "Later", "--expected-revision", "1", "--expected-row-version", "3"], workB);
    const before = run(["get", id]);
    const events = run(["events", id]);
    const replay = await toolCall(session, "handoff_revise", {
      handoffId: id,
      cwd: workA,
      noChange: true,
      reason: "No change",
      idempotencyKey: "report-replay",
    });
    expect(replay.result?.structuredContent).toMatchObject({
      data: { ...(original.result?.structuredContent as { data: Record<string, unknown> }).data, replayed: true },
    });
    const replayCli = runCli(
      ["revise", id, "--no-change", "--reason", "No change", "--idempotency-key", "report-replay", "--json"],
      home,
      workA,
    );
    expect(normalizedRequestId(envelopeText(replay.result as never))).toBe(normalizedRequestId(replayCli.stdout));
    const miss = await toolCall(session, "handoff_revise", {
      handoffId: id,
      cwd: workA,
      noChange: true,
      reason: "No change",
      idempotencyKey: "missing-report-replay",
    });
    expect(miss.error).toBeUndefined();
    expect(miss.result?.structuredContent).toMatchObject({ error: { code: "HANDOFF_INVALID_INPUT" } });
    expect(run(["get", id])).toEqual(before);
    expect(run(["events", id])).toEqual(events);
    await session.close();
  }, 15_000);
});
