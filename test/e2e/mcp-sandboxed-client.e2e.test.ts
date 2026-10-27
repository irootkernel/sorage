import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LineSplitter } from "../../apps/cli/test/contract/mcp-line-splitter";
import { BINARY, makeTempDir, registerCleanup, runCleanups, sorage, type Run } from "./helpers";

/**
 * The TASK-124 acceptance gate (AJ-30 step 3): a process under a real
 * `sandbox-exec` profile that denies every write and all network acts as the
 * MCP client of a host-spawned `sorage mcp`, sends and reads Handoffs, Memos
 * and Channel messages, and refuses a file argument outside the call's
 * workspace — beside the per-tool snapshot oracle that proves MCP-006 against
 * direct CLI runs on equivalent byte copies of the prepared home.
 */
const SANDBOX = "/usr/bin/sandbox-exec";
const PROFILE = "(version 1)(allow default)(deny file-write*)(deny network*)";
const DRIVER = fileURLToPath(new URL("./mcp-client-driver.ts", import.meta.url));

afterAll(runCleanups);

function makeInstallation(prefix: string): { home: string; workA: string; workB: string } {
  const home = makeTempDir(prefix);
  const workA = join(home, "work-a");
  const workB = join(home, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  for (const args of [
    ["init", "--non-interactive"],
    ["project", "add", "--name", "Alpha", "--dir", workA],
    ["project", "add", "--name", "Beta", "--dir", workB],
  ]) {
    const run = sorage([...args, "--json"], { home, cwd: workA });
    expect(run.status, run.stderr).toBe(0);
  }
  return { home, workA, workB };
}

function copyInstallation(source: string, prefix: string): string {
  const copy = makeTempDir(prefix);
  cpSync(source, copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}

interface HostSession {
  request(method: string, params: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** A host-driven JSON-RPC session against a `sorage mcp` server process. */
function hostSession(home: string, cwd: string): HostSession {
  const child = spawn(BINARY, ["mcp"], {
    cwd,
    env: {
      ...process.env,
      SORAGE_HOME: home,
      SORAGE_TEST_REQUEST_ID: undefined,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  registerCleanup(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let nextId = 0;
  // One byte-level splitter keeps the unconsumed remainder after every chunk
  // (mcp-line-splitter; its unit cases cover this client's framing).
  const splitter = new LineSplitter();
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) {
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message.id;
      if (typeof id === "number") {
        const resolve = pending.get(id);
        if (resolve !== undefined) {
          pending.delete(id);
          resolve(message);
        }
      }
    }
  });
  const done = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  return {
    request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async close(): Promise<void> {
      child.stdin?.end();
      await done;
    },
  };
}

async function mcpCall(
  home: string,
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ envelope: Record<string, unknown>; wireText: string }> {
  const session = hostSession(home, cwd);
  await session.request("initialize", { protocolVersion: "2025-06-18" });
  const answer = (await session.request("tools/call", { name, arguments: { cwd, ...args } })) as {
    result?: { structuredContent: Record<string, unknown>; content: Array<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };
  await session.close();
  if (answer.error !== undefined)
    throw new Error(`${name} answered ${String(answer.error.code)}: ${answer.error.message}`);
  const result = answer.result as {
    structuredContent: Record<string, unknown>;
    content: Array<{ type: string; text: string }>;
  };
  return { envelope: result.structuredContent, wireText: result.content[0]?.text ?? "" };
}

/**
 * Replaces the per-process requestId as an exact substring and nothing else:
 * formatting, escapes and every other byte of the forwarded text stay, so a
 * reformatted text fails the comparison (C3 item 7).
 */
function normalizeReads(envelopeText: string, requestId: string): string {
  return envelopeText.split(requestId).join("<rid>");
}

/**
 * Deep normalization of only the nondeterminism a call creates: the home
 * path, instants, the request id and the per-tool createdKeys. Pre-existing
 * identities — Project, Channel or referenced Handoff and Memo ids — stay
 * literal, so a wrong-actor comparison fails instead of passing (C2 item 12).
 */
function normalizeMutation(value: unknown, homes: string[], createdKeys: Set<string>): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const home of homes) text = text.split(home).join("<home>");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) return "<instant>";
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeMutation(item, homes, createdKeys));
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "requestId") normalized[key] = "<rid>";
      // Only a created identity — a string, and strings only — is
      // nondeterministic. Null, numbers, booleans and arrays stay literal, so
      // `storageKey: null` never equals a staged path and a numeric created
      // value can still fail the comparison (C4 item 4, TE 2).
      else if (createdKeys.has(key) && typeof item === "string") normalized[key] = "<created>";
      else normalized[key] = normalizeMutation(item, homes, createdKeys);
    }
    return normalized;
  }
  return value;
}

describe("the sandboxed MCP client journey (AJ-30 step 3, the TASK-124 gate)", () => {
  it(
    "a write- and network-denied client sends and reads through a host-spawned sorage mcp",
    { timeout: 240_000 },
    async () => {
      const { home, workA, workB } = makeInstallation("sorage-mcp-e2e-");

      const listener = createServer();
      let accepted = false;
      listener.on("connection", () => {
        accepted = true;
      });
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const port = (listener.address() as { port: number }).port;
      registerCleanup(() => listener.close());

      const driver = spawn(SANDBOX, ["-p", PROFILE, "bun", DRIVER], {
        cwd: tmpdir(),
        env: {
          ...process.env,
          SORAGE_HOME: home,
          SORAGE_TEST_REQUEST_ID: undefined,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          JOURNEY_WORK_A: workA,
          JOURNEY_WORK_B: workB,
          JOURNEY_HOST_PORT: String(port),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const server = spawn(BINARY, ["mcp"], {
        cwd: workA,
        env: {
          ...process.env,
          SORAGE_HOME: home,
          SORAGE_TEST_REQUEST_ID: undefined,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      registerCleanup(() => {
        if (driver.exitCode === null && !driver.killed) driver.kill("SIGKILL");
        if (server.exitCode === null && !server.killed) server.kill("SIGKILL");
      });

      let driverStderr = "";
      driver.stderr?.on("data", (chunk: Buffer) => {
        driverStderr += chunk.toString("utf8");
      });
      let wakePosted = false;
      const watchWake = (line: string): void => {
        if (wakePosted) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const params = message.params as { name?: string; arguments?: { wait?: boolean } } | undefined;
        if (message.method === "tools/call" && params?.name === "channel_messages" && params.arguments?.wait === true) {
          wakePosted = true;
          setTimeout(() => {
            const posted = sorage(
              ["channel", "post", "gate", "--from", "w1", "--kind", "report", "--body", "the wake", "--json"],
              { home, cwd: workA },
            );
            expect(posted.status, posted.stderr).toBe(0);
          }, 800);
        }
      };
      // The relay forwards each side's raw bytes unchanged; the wake watcher
      // sees whole lines through the same byte-level splitter, so a request
      // split across pipe chunks is still detected.
      const relaySplitter = new LineSplitter();
      driver.stdout?.on("data", (chunk: Buffer) => {
        server.stdin?.write(chunk);
        for (const line of relaySplitter.push(chunk)) if (line.trim().length > 0) watchWake(line);
      });
      server.stdout?.on("data", (chunk: Buffer) => {
        driver.stdin?.write(chunk);
      });

      const driverExit = new Promise<number | null>((resolve) => {
        driver.on("close", (code) => resolve(code));
      });
      const timer = setTimeout(() => {
        driver.kill("SIGKILL");
        throw new Error(`the driver never finished; stderr so far: ${driverStderr.slice(-800)}`);
      }, 180_000);
      const code = await driverExit;
      clearTimeout(timer);
      server.kill("SIGTERM");

      expect(driverStderr).toContain("control write denied");
      expect(driverStderr).toContain("JOURNEY COMPLETE");
      expect(code).toBe(0);
      // The sandboxed network control never reached the listener.
      expect(accepted).toBe(false);

      const control = spawnSync(
        "bun",
        [
          "-e",
          `import { connect } from "node:net"; const s = connect(${String(port)}, "127.0.0.1"); s.on("connect", () => { s.destroy(); process.exit(0); }); s.on("error", () => process.exit(1));`,
        ],
        { timeout: 10_000 },
      );
      expect(control.status).toBe(0);
      const acceptedSoon = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const poll = (): void => {
          if (accepted) resolve(true);
          else if (Date.now() - started > 5_000) resolve(false);
          else setTimeout(poll, 25);
        };
        poll();
      });
      expect(acceptedSoon).toBe(true);
    },
  );
});

function memoByTitle(home: string, cwd: string, title: string): { id: string; rowVersion: number } {
  const listed = JSON.parse(sorage(["memo", "list", "--state", "all", "--json"], { home, cwd }).stdout) as {
    data: {
      memos?: Array<{ id: string; title: string; rowVersion: number }>;
      items?: Array<{ id: string; title: string; rowVersion: number }>;
    };
  };
  const rows = listed.data.memos ?? listed.data.items ?? [];
  const memo = rows.find((row) => row.title === title);
  if (memo === undefined) throw new Error(`no memo titled ${title}`);
  return memo;
}

describe("the MCP-006 oracle: every compared call against an equivalent snapshot", () => {
  it(
    "reads are byte-equal modulo the request id, and mutations structurally equal, against direct CLI runs",
    { timeout: 300_000 },
    async () => {
      const base = makeInstallation("sorage-mcp-oracle-");
      const prepared = (() => {
        const sent = sorage(
          ["send", "--to", "alpha", "--title", "Oracle read", "--body", "oracle read body", "--json"],
          {
            home: base.home,
            cwd: base.workB,
          },
        );
        expect(sent.status, sent.stderr).toBe(0);
        const handoffId = (JSON.parse(sent.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data
          .handoffs[0]?.handoffId as string;
        const memo = sorage(["memo", "add", "--title", "Oracle memo", "--body", "oracle memo body", "--json"], {
          home: base.home,
          cwd: base.workA,
        });
        expect(memo.status, memo.stderr).toBe(0);
        const memoId = (JSON.parse(memo.stdout) as { data: { memo: { id: string } } }).data.memo.id;
        for (const args of [
          ["channel", "create", "oracle", "--json"],
          ["channel", "add", "oracle", "w1", "--role", "worker", "--json"],
          ["channel", "post", "oracle", "--from", "w1", "--kind", "report", "--body", "oracle post body", "--json"],
        ]) {
          const done = sorage(args, { home: base.home, cwd: base.workA });
          expect(done.status, done.stderr).toBe(0);
        }
        return { handoffId, memoId };
      })();

      // Reads: MCP on one copy, direct CLI on the equivalent copy.
      const readA = copyInstallation(base.home, "sorage-mcp-read-a-");
      const readB = copyInstallation(base.home, "sorage-mcp-read-b-");
      const reads: Array<[string, Record<string, unknown>, string[]]> = [
        ["handoff_inbox", {}, ["inbox", "--json"]],
        ["handoff_get", { handoffId: prepared.handoffId }, ["get", prepared.handoffId, "--json"]],
        ["memo_list", {}, ["memo", "list", "--json"]],
        ["memo_show", { memoId: prepared.memoId }, ["memo", "show", prepared.memoId, "--json"]],
        ["channel_messages", { channel: "oracle" }, ["channel", "messages", "oracle", "--json"]],
        ["channel_list", {}, ["channel", "list", "--json"]],
        ["channel_show", { channel: "oracle" }, ["channel", "show", "oracle", "--json"]],
        ["project_list", {}, ["project", "list", "--json"]],
        ["project_show", { project: "alpha" }, ["project", "show", "alpha", "--json"]],
      ];
      for (const [tool, args, cli] of reads) {
        const { wireText, envelope } = await mcpCall(readA, base.workA, tool, args);
        const direct = sorage(cli, { home: readB, cwd: base.workA });
        expect(direct.status, tool).toBe(0);
        const mcpRequestId = (envelope.meta as { requestId: string }).requestId;
        const directRequestId = (JSON.parse(direct.stdout) as { meta: { requestId: string } }).meta.requestId;
        // The forwarded bytes, not a re-serialization: the wire text of
        // content[0] equals the CLI's stdout with each requestId replaced as
        // an exact substring and every other byte untouched.
        expect(normalizeReads(wireText, mcpRequestId), tool).toBe(normalizeReads(direct.stdout, directRequestId));
      }

      // Mutations: one equivalent snapshot pair per tool, the CLI twin on the copy.
      const mutations: Array<{
        tool: string;
        args: (homes: {
          homeA: string;
          workA: string;
          workB: string;
          handoffId: string;
          memoId: string;
        }) => Record<string, unknown>;
        cli: (home: string) => string[];
        /** The twin's cwd — the same acting workspace the MCP arguments carry. */
        twinCwd: "workA" | "workB";
        prepare?: string[][];
        createdKeys: string[];
      }> = [
        {
          tool: "handoff_send",
          args: ({ workB }) => ({ cwd: workB, to: ["alpha"], title: "Oracle send", body: "oracle mutation body" }),
          cli: () => ["send", "--to", "alpha", "--title", "Oracle send", "--body", "oracle mutation body", "--json"],
          twinCwd: "workB",
          createdKeys: ["handoffId", "dispatchGroupId", "artifactId"],
        },
        {
          tool: "handoff_revise",
          args: ({ workB, handoffId }) => ({
            cwd: workB,
            handoffId,
            body: "oracle revision body",
            expectedRowVersion: 1,
          }),
          cli: () => [
            "revise",
            prepared.handoffId,
            "--body",
            "oracle revision body",
            "--expected-row-version",
            "1",
            "--json",
          ],
          twinCwd: "workB",
          createdKeys: ["artifactId"],
        },
        {
          tool: "memo_add",
          args: ({ workA }) => ({ cwd: workA, title: "Oracle mutation memo", body: "oracle memo mutation body" }),
          twinCwd: "workA",
          cli: () => [
            "memo",
            "add",
            "--title",
            "Oracle mutation memo",
            "--body",
            "oracle memo mutation body",
            "--json",
          ],
          createdKeys: ["id"],
        },
        {
          tool: "memo_done",
          args: ({ workA, homeA }) => {
            const memo = memoByTitle(homeA, workA, "Oracle done");
            return { cwd: workA, memoId: memo.id, expectedRowVersion: memo.rowVersion };
          },
          cli: (home) => {
            const memo = memoByTitle(home, base.workA, "Oracle done");
            return ["memo", "done", memo.id, "--expected-row-version", String(memo.rowVersion), "--json"];
          },
          prepare: [["memo", "add", "--title", "Oracle done", "--body", "done body", "--json"]],
          twinCwd: "workA",
          createdKeys: [],
        },
        {
          tool: "channel_create",
          args: ({ workA }) => ({ cwd: workA, name: "oracle-created" }),
          cli: () => ["channel", "create", "oracle-created", "--json"],
          twinCwd: "workA",
          createdKeys: ["id"],
        },
        {
          tool: "channel_add",
          args: ({ workA }) => ({ cwd: workA, channel: "oracle-add", handle: "w9", role: "judge" }),
          cli: () => ["channel", "add", "oracle-add", "w9", "--role", "judge", "--json"],
          prepare: [["channel", "create", "oracle-add", "--json"]],
          twinCwd: "workA",
          createdKeys: [],
        },
        {
          tool: "channel_post",
          args: ({ workA }) => ({
            cwd: workA,
            channel: "oracle-post",
            from: "w1",
            kind: "report",
            body: "oracle post mutation",
          }),
          cli: () => [
            "channel",
            "post",
            "oracle-post",
            "--from",
            "w1",
            "--kind",
            "report",
            "--body",
            "oracle post mutation",
            "--json",
          ],
          prepare: [
            ["channel", "create", "oracle-post", "--json"],
            ["channel", "add", "oracle-post", "w1", "--role", "worker", "--json"],
          ],
          twinCwd: "workA",
          createdKeys: [],
        },
        {
          tool: "channel_ack",
          args: ({ workA }) => ({ cwd: workA, channel: "oracle-ack", seq: [1] }),
          cli: () => ["channel", "ack", "oracle-ack", "1", "--json"],
          prepare: [
            ["channel", "create", "oracle-ack", "--json"],
            ["channel", "add", "oracle-ack", "w1", "--role", "worker", "--json"],
            ["channel", "post", "oracle-ack", "--from", "w1", "--kind", "report", "--body", "ack me", "--json"],
          ],
          twinCwd: "workA",
          createdKeys: [],
        },
      ];

      for (const mutation of mutations) {
        const sourceHome = makeTempDir(`sorage-mcp-${mutation.tool}-src-`);
        cpSync(base.home, sourceHome, { recursive: true, verbatimSymlinks: true });
        for (const args of mutation.prepare ?? []) {
          const done = sorage([...args], { home: sourceHome, cwd: base.workA });
          expect(done.status, `${mutation.tool} prepare: ${args.join(" ")}`).toBe(0);
        }
        const homeA = copyInstallation(sourceHome, `sorage-mcp-${mutation.tool}-a-`);
        const homeB = copyInstallation(sourceHome, `sorage-mcp-${mutation.tool}-b-`);
        const handoffId = prepared.handoffId;
        const memoId = prepared.memoId;
        const { envelope: mcpEnvelope } = await mcpCall(
          homeA,
          base.workA,
          mutation.tool,
          mutation.args({ homeA, workA: base.workA, workB: base.workB, handoffId, memoId }),
        );
        const cliRun: Run = sorage(mutation.cli(homeB), {
          home: homeB,
          cwd: mutation.twinCwd === "workA" ? base.workA : base.workB,
        });
        expect(cliRun.status, `${mutation.tool} CLI twin`).toBe(0);
        const cliEnvelope = JSON.parse(cliRun.stdout) as Record<string, unknown>;
        expect(normalizeMutation(mcpEnvelope, [homeA], new Set(mutation.createdKeys)), mutation.tool).toEqual(
          normalizeMutation(cliEnvelope, [homeB], new Set(mutation.createdKeys)),
        );
      }

      // Comparison controls (C3 item 7): a reformatted read text and a
      // null-versus-path identity must each FAIL the comparison, so the
      // byte-for-byte rule and the null preservation are discriminated.
      {
        const { wireText } = await mcpCall(readA, base.workA, "project_list", {});
        const direct = sorage(["project", "list", "--json"], { home: readB, cwd: base.workA });
        const mcpRequestId = (JSON.parse(wireText) as { meta: { requestId: string } }).meta.requestId;
        const directRequestId = (JSON.parse(direct.stdout) as { meta: { requestId: string } }).meta.requestId;
        const reformatted = JSON.stringify(JSON.parse(wireText), null, 4);
        expect(normalizeReads(wireText, mcpRequestId)).not.toBe(normalizeReads(reformatted, mcpRequestId));
        expect(normalizeReads(wireText, mcpRequestId)).toBe(normalizeReads(direct.stdout, directRequestId));
      }
      {
        // Value types stay literal: a string-vs-number under one created key
        // fails, null against a path fails, and two different strings under
        // one created key compare equal (only strings are normalized).
        const withString = { artifactId: "a-1" };
        const withNumber = { artifactId: 7 };
        expect(normalizeMutation(withString, [], new Set(["artifactId"]))).not.toEqual(
          normalizeMutation(withNumber, [], new Set(["artifactId"])),
        );
        // storageKey sits in the created-key set, so this comparison fails
        // only because null stays null against the staged path (c3-decision
        // item 4, second control).
        const withNull = { storageKey: null as string | null, artifactId: "a-1" };
        const withPath = { storageKey: "artifacts/x/y", artifactId: "a-1" };
        expect(normalizeMutation(withNull, [], new Set(["artifactId", "storageKey"]))).not.toEqual(
          normalizeMutation(withPath, [], new Set(["artifactId", "storageKey"])),
        );
        const firstString = { artifactId: "a-1" };
        const secondString = { artifactId: "b-2" };
        expect(normalizeMutation(firstString, [], new Set(["artifactId"]))).toEqual(
          normalizeMutation(secondString, [], new Set(["artifactId"])),
        );
      }

      // The discriminating control: the same memo_add under a wrong-acting
      // twin must FAIL the comparison, because the pre-existing projectId is
      // no longer normalized away (the C1 defect this control pins).
      const controlSource = copyInstallation(base.home, "sorage-mcp-wrong-actor-src-");
      const controlA = copyInstallation(controlSource, "sorage-mcp-wrong-actor-a-");
      const controlB = copyInstallation(controlSource, "sorage-mcp-wrong-actor-b-");
      const mcpSide = await mcpCall(controlA, base.workA, "memo_add", {
        cwd: base.workA,
        title: "Wrong actor",
        body: "wrong actor body",
      });
      const wrongActorRun = sorage(["memo", "add", "--title", "Wrong actor", "--body", "wrong actor body", "--json"], {
        home: controlB,
        cwd: base.workB,
      });
      expect(wrongActorRun.status).toBe(0);
      const wrongActorEnvelope = JSON.parse(wrongActorRun.stdout) as Record<string, unknown>;
      expect(normalizeMutation(mcpSide.envelope, [controlA], new Set(["id"]))).not.toEqual(
        normalizeMutation(wrongActorEnvelope, [controlB], new Set(["id"])),
      );
    },
  );
});
