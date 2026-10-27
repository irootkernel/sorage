import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  confineFileArgument,
  handleToolCall,
  WORKSPACE_ESCAPE_RECOVERY,
  type SpawnedChild,
} from "../../src/mcp-server";

/**
 * The MCP-004 workspace confinement on real paths, through the real call
 * handler: every escape class is refused before any child — the injected
 * spawner asserts it executed, zero times on refusal — while an
 * inside-but-nonexistent path flows to the child with the checked real path,
 * and the `handoff_send`/`handoff_revise` children receive the tilde-expanded
 * user path their own `checkExternalSource` re-checks.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      try {
        cleanup();
      } catch {
        // Best effort.
      }
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class StreamEmitter {
  private listeners: Array<(chunk: Buffer) => void> = [];

  on(_event: "data", listener: (chunk: Buffer) => void): void {
    this.listeners.push(listener);
  }

  emit(text: string): void {
    this.emitBuffer(Buffer.from(text, "utf8"));
  }

  emitBuffer(chunk: Buffer): void {
    for (const listener of [...this.listeners]) listener(chunk);
  }
}

interface FakeOutcome {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** A real-shaped child that replays one recorded outcome once the handler listens. */
class FakeChild implements SpawnedChild {
  /** When set, stdout is emitted as these raw chunks instead of one piece. */
  static stdoutChunks: Buffer[] | null = null;
  stdout = new StreamEmitter();
  stderr = new StreamEmitter();
  killed = false;
  private closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  constructor(private readonly outcome: FakeOutcome) {}

  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "close" | "error",
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
  ): void {
    if (event !== "close") return;
    const close = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
    this.closeListeners.push(close);
    queueMicrotask(() => {
      const chunks = FakeChild.stdoutChunks;
      if (chunks !== null) {
        for (const chunk of chunks) this.stdout.emitBuffer(chunk);
      }
      if (chunks === null || chunks.length === 0) {
        this.stdout.emit(this.outcome.stdout);
      }
      this.stderr.emit(this.outcome.stderr);
      for (const each of this.closeListeners) each(this.outcome.status, this.outcome.signal ?? null);
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function cannedSuccess(): FakeOutcome {
  const envelope = { ok: true, data: { canned: true }, meta: { requestId: "canned" } };
  return { status: 0, stdout: `${JSON.stringify(envelope, null, 2)}\n`, stderr: "" };
}

function recordingSpawner(outcome: FakeOutcome = cannedSuccess()): {
  calls: Array<{ argv: string[]; cwd: string }>;
  spawn: (argv: string[], cwd: string) => SpawnedChild;
} {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  return {
    calls,
    spawn: (argv, cwd) => {
      calls.push({ argv, cwd });
      return new FakeChild(outcome);
    },
  };
}

interface ObservedCall {
  isError: boolean | undefined;
  code: string | undefined;
  message: string | undefined;
  recovery: string | undefined;
  errorMessage: string | undefined;
}

async function observe(
  name: string,
  arguments_: Record<string, unknown>,
  cwd: string,
): Promise<{ observed: ObservedCall; calls: Array<{ argv: string[]; cwd: string }> }> {
  const spawner = recordingSpawner();
  const answer = (await handleToolCall(name, arguments_, cwd, spawner.spawn)) as {
    result?: {
      isError: boolean;
      structuredContent: { error?: { code: string; message: string; recovery?: { suggestedCommand: string } } };
    };
    error?: { code: number; message: string };
  };
  if (answer.error !== undefined) {
    return {
      observed: {
        isError: undefined,
        code: undefined,
        message: undefined,
        recovery: undefined,
        errorMessage: answer.error.message,
      },
      calls: spawner.calls,
    };
  }
  const failure = answer.result?.structuredContent.error;
  return {
    observed: {
      isError: answer.result?.isError,
      code: failure?.code,
      message: failure?.message,
      recovery: failure?.recovery?.suggestedCommand,
      errorMessage: undefined,
    },
    calls: spawner.calls,
  };
}

const escapeCases: Array<[string, string, Record<string, unknown>]> = [
  ["handoff_send", "file", { to: ["alpha"], title: "T", file: "" }],
  ["handoff_review_set", "file", { handoffId: "h1", file: "", targetRevision: 1, expectedRowVersion: 1 }],
  ["handoff_revise", "file", { handoffId: "h1", file: "", expectedRowVersion: 1 }],
  ["memo_add", "bodyFile", { title: "t", bodyFile: "" }],
  ["memo_update", "bodyFile", { memoId: "m1", expectedRowVersion: 2, bodyFile: "" }],
  ["channel_post", "bodyFile", { channel: "c", from: "h", kind: "report", bodyFile: "" }],
];

describe("the six file-like properties through the real call handler (MCP-004)", () => {
  for (const [toolName, property, base] of escapeCases) {
    it(`refuses an absolute escape on ${toolName}'s ${property} before any child, with the fixed envelope`, async () => {
      const root = tempDir("sorage-mcp-confine-");
      const outside = tempDir("sorage-mcp-outside-");
      const target = join(outside, "secret.md");
      writeFileSync(target, "secret\n");
      const { observed, calls } = await observe(toolName, { ...base, [property]: target }, root);
      expect(observed.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
      expect(observed.isError).toBe(true);
      expect(observed.recovery).toBe(WORKSPACE_ESCAPE_RECOVERY);
      expect(observed.message).toContain(target);
      expect(observed.message).toContain("outside the call's workspace");
      // The injection asserts it executed: zero spawns on refusal.
      expect(calls).toHaveLength(0);
    });
  }
});

describe("the escape classes (MCP-004, SEC-006)", () => {
  it("refuses a relative parent escape and a tilde-prefixed expansion escape", () => {
    const root = tempDir("sorage-mcp-confine-");
    expect(confineFileArgument(root, "../escape.md").ok).toBe(false);
    expect(confineFileArgument(root, "~/.ssh/keys").ok).toBe(false);
  });

  it("refuses a symlink inside the root whose target is outside, and an escape through a symlinked ancestor", () => {
    const root = tempDir("sorage-mcp-confine-");
    const outside = tempDir("sorage-mcp-outside-");
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "secret\n");
    const insideLink = join(root, "link.md");
    symlinkSync(secret, insideLink);
    expect(confineFileArgument(root, "link.md").ok).toBe(false);
    // The discriminating form: a workspace root already in real-path form, so
    // no /tmp alias difference can refuse the link on the lexical comparison's
    // behalf — only resolving the symlink itself can.
    expect(confineFileArgument(realpathSync(root), "link.md").ok).toBe(false);

    const linkedDir = join(root, "linked");
    symlinkSync(outside, linkedDir);
    expect(confineFileArgument(root, "linked/secret.md").ok).toBe(false);
  });

  it("treats the /tmp and /private/tmp aliases of one workspace as inside, in both directions", () => {
    const workspace = mkdtempSync("/tmp/sorage-mcp-alias-");
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const real = realpathSync(workspace);
    const file = join(real, "doc.md");
    const forward = confineFileArgument(workspace, file);
    expect(forward.ok, `${workspace} vs ${file}`).toBe(true);
    if (forward.ok) expect(forward.realPath).toBe(join(real, "doc.md"));
    const backward = confineFileArgument(real, join(workspace, "doc.md"));
    expect(backward.ok, `${real} vs ${workspace}`).toBe(true);
  });

  it("accepts an absolute file inside a workspace rooted at the filesystem root", () => {
    const realTmp = realpathSync(tmpdir());
    expect(confineFileArgument("/", join(realTmp, "doc.md")).ok).toBe(true);
  });
});

describe("the accepted path and what each child receives", () => {
  it("accepts a relative, an absolute, a nested and the root itself, and spawns exactly once", async () => {
    const root = tempDir("sorage-mcp-confine-");
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "doc.md"), "content\n");
    writeFileSync(join(root, "nested", "doc.md"), "content\n");
    for (const fileArgument of ["doc.md", join(root, "doc.md"), "nested/doc.md", "."]) {
      const { observed, calls } = await observe("memo_add", { title: "t", bodyFile: fileArgument }, root);
      expect(observed.isError, fileArgument).not.toBe(true);
      // The injection asserts it executed: exactly one spawn per accepted call.
      expect(calls, fileArgument).toHaveLength(1);
    }
  });

  it("passes the tilde-expanded user path to the handoff children and the checked real path to the four server-only properties", async () => {
    const root = tempDir("sorage-mcp-confine-");
    const nested = join(root, "nested");
    mkdirSync(nested);
    const target = join(nested, "doc.md");
    writeFileSync(target, "content\n");
    const linked = join(root, "linked.md");
    symlinkSync(target, linked);
    const realTarget = realpathSync(target);

    const send = await observe("handoff_send", { to: ["alpha"], title: "T", file: linked }, root);
    expect(send.calls[0]?.argv).toContain(linked);
    const revise = await observe("handoff_revise", { handoffId: "h1", file: linked }, root);
    expect(revise.calls[0]?.argv).toContain(linked);

    for (const [toolName, base, property] of [
      ["handoff_review_set", { handoffId: "h1", targetRevision: 1, expectedRowVersion: 1 }, "file"],
      ["memo_add", { title: "t" }, "bodyFile"],
      ["memo_update", { memoId: "m1", expectedRowVersion: 2 }, "bodyFile"],
      ["channel_post", { channel: "c", from: "h", kind: "report" }, "bodyFile"],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const accepted = await observe(toolName, { ...base, [property]: linked }, root);
      expect(accepted.calls, toolName).toHaveLength(1);
      // The checked real path — the server alone guards these four.
      expect(accepted.calls[0]?.argv, toolName).toContain(realTarget);
      expect(accepted.calls[0]?.argv, toolName).not.toContain(linked);
    }
  });

  it("passes a nonexistent path inside the root to the child with its nearest-ancestor real path", async () => {
    const root = tempDir("sorage-mcp-confine-");
    const { observed, calls } = await observe("memo_add", { title: "t", bodyFile: "missing/doc.md" }, root);
    expect(observed.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toContain(join(realpathSync(root), "missing/doc.md"));
  });

  it("refuses a call whose cwd is not an existing directory before any child", async () => {
    const root = tempDir("sorage-mcp-confine-");
    const spawner = recordingSpawner();
    const answer = (await handleToolCall("project_list", {}, join(root, "absent"), spawner.spawn)) as {
      error?: { code: number; message: string };
    };
    expect(answer.error?.code).toBe(-32602);
    expect(answer.error?.message).toContain("cwd");
    expect(spawner.calls).toHaveLength(0);
  });
});

describe("streaming UTF-8 across chunk boundaries (C2 item 4)", () => {
  it("decodes a multibyte character split across stdout chunks exactly once", async () => {
    const envelope = {
      ok: true,
      data: { body: "다국어 본문 — 서울" },
      meta: { requestId: "canned" },
    };
    const whole = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    // Split in the middle of the Korean text so both halves carry partial
    // multibyte sequences — per-chunk decoding would corrupt them.
    const split = whole.indexOf(Buffer.from("국", "utf8")) + 1;
    const first = whole.subarray(0, split);
    const second = whole.subarray(split);
    expect(Buffer.compare(Buffer.concat([first, second]), whole)).toBe(0);
    const spawner = recordingSpawner({ status: 0, stdout: "", stderr: "" });
    FakeChild.stdoutChunks = [first, second];
    try {
      const answer = (await handleToolCall("memo_list", {}, undefined, spawner.spawn)) as {
        result?: { structuredContent: { data: { body: string } }; isError: boolean };
      };
      expect(spawner.calls).toHaveLength(1);
      expect(answer.result?.isError).toBe(false);
      expect(answer.result?.structuredContent.data.body).toBe("다국어 본문 — 서울");
    } finally {
      FakeChild.stdoutChunks = null;
    }
  });

  it("accepts a confined filename that merely begins with two dots (C2 item 9)", async () => {
    const root = tempDir("sorage-mcp-dots-");
    const dotted = join(root, "..draft.md");
    writeFileSync(dotted, "content\n");
    const { observed, calls } = await observe("memo_add", { title: "t", bodyFile: "..draft.md" }, root);
    expect(observed.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toContain(join(realpathSync(root), "..draft.md"));
  });

  it("refuses prototype-named keys through the full handler with zero spawns (C3 item 8)", async () => {
    const root = tempDir("sorage-mcp-proto-");
    for (const [name, args] of [
      ["handoff_get", { toString: "no" }],
      ["memo_list", { constructor: 1 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const spawner = recordingSpawner();
      const answer = (await handleToolCall(name, args, root, spawner.spawn)) as {
        error?: { code: number; message: string };
      };
      expect(answer.error?.code, name).toBe(-32602);
      expect(answer.error?.message, name).toContain("unknown property");
      expect(spawner.calls, name).toHaveLength(0);
    }
  });

  it("refuses a missing positional through the full handler with zero spawns", async () => {
    const root = tempDir("sorage-mcp-positional-");
    for (const [name, args] of [
      ["channel_create", {}],
      ["channel_ack", { channel: "c" }],
      ["handoff_get", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const spawner = recordingSpawner();
      const answer = (await handleToolCall(name, args, root, spawner.spawn)) as {
        error?: { code: number; message: string };
      };
      expect(answer.error?.code, name).toBe(-32602);
      expect(answer.error?.message, name).toContain("missing required argument");
      expect(spawner.calls, name).toHaveLength(0);
    }
  });
});
