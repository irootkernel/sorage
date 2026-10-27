import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";

/**
 * The AJ-30 step-3 MCP client driver: it runs under `sandbox-exec` with every
 * write and all network denied, speaks JSON-RPC on its stdout/stdin only, and
 * reports its controls and journey steps on stderr. The host relays its
 * streams to a host-spawned `sorage mcp` server and records every response;
 * this file must stay dependency-free so bun can run it inside the sandbox.
 */
const WORK_A = process.env.JOURNEY_WORK_A as string;
const WORK_B = process.env.JOURNEY_WORK_B as string;
const HOST_PORT = Number.parseInt(process.env.JOURNEY_HOST_PORT ?? "0", 10);
const JOURNEY_TITLE = "Journey";
const JOURNEY_BODY = "the journey body";
const REVISED_BODY = "the revised body";

let nextId = 0;
const pending = new Map<number, (message: Record<string, unknown>) => void>();
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const note = (text: string): void => {
  process.stderr.write(`DRIVER ${text}\n`);
};
const fail = (text: string): never => {
  note(`FAIL ${text}`);
  process.exit(1);
};

function request(method: string, params: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function call(
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const answer = (await request("tools/call", { name, arguments: args }, timeoutMs)) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
  if (answer.error !== undefined) {
    note(`${name} answered protocol error ${String(answer.error.code)}: ${answer.error.message}`);
    return { ok: false, error: answer.error };
  }
  return { ok: true, result: answer.result as Record<string, unknown> };
}

function envelopeOf(result: Record<string, unknown> | undefined): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; recovery?: { suggestedCommand: string } };
} {
  return result?.structuredContent as never;
}

async function controls(): Promise<void> {
  try {
    writeFileSync(`${WORK_A}/driver-write-control.txt`, "must be denied\n");
    fail("the write control unexpectedly succeeded");
  } catch (error) {
    note(`control write denied: ${(error as NodeJS.ErrnoException).code}`);
  }
  await new Promise<void>((resolve) => {
    const socket = connect(HOST_PORT, "127.0.0.1");
    socket.on("error", () => {
      note("control network denied");
      socket.destroy();
      resolve();
    });
    socket.on("connect", () => {
      socket.destroy();
      // The host decides acceptance; a sandboxed connect must never be
      // accepted, and the host asserts that separately.
      note("control network connect reported success");
      resolve();
    });
  });
}

async function journey(): Promise<void> {
  const initialize = (await request("initialize", { protocolVersion: "2025-06-18" })) as {
    result: { serverInfo: { name: string }; protocolVersion: string };
  };
  if (initialize.result.serverInfo.name !== "sorage") fail("initialize serverInfo");
  note("initialize ok");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const listing = (await request("tools/list", {})) as { result: { tools: Array<{ name: string }> } };
  if (listing.result.tools.length !== 31) fail(`tools/list held ${String(listing.result.tools.length)} tools`);
  note("tools/list ok (31 tools)");

  const sent = await call("handoff_send", { cwd: WORK_B, to: ["alpha"], title: JOURNEY_TITLE, body: JOURNEY_BODY });
  if (!sent.ok || !envelopeOf(sent.result).ok) fail("handoff_send");

  const inbox = await call("handoff_inbox", { cwd: WORK_A });
  const inboxTitles = (envelopeOf(inbox.result).data?.handoffs as Array<{ title: string }>).map((row) => row.title);
  if (!inboxTitles.includes(JOURNEY_TITLE)) fail("handoff_inbox title");
  note("handoff_inbox ok");

  const handoffId = ((envelopeOf(inbox.result).data?.handoffs as Array<{ id: string }>)[0] as { id: string }).id;
  const got = await call("handoff_get", {
    cwd: WORK_A,
    handoffId,
  });
  const detail = envelopeOf(got.result).data as {
    title: string;
    reviewState: string;
    revision: number;
    rowVersion: number;
    currentArtifact: { sha256: string };
  };
  if (detail.title !== JOURNEY_TITLE) fail("handoff_get title");
  if (detail.reviewState !== "awaiting_recipient") fail("handoff_get state");
  if (detail.revision !== 1) fail("handoff_get revision");
  const expectedDigest = createHash("sha256").update(JOURNEY_BODY, "utf8").digest("hex");
  if (detail.currentArtifact.sha256 !== expectedDigest) fail("handoff_get sha256");
  note("handoff_get ok (title, state, revision, sha256)");

  const revised = await call("handoff_revise", {
    cwd: WORK_B,
    handoffId,
    body: REVISED_BODY,
    expectedRowVersion: detail.rowVersion,
  });
  if (!revised.ok || !envelopeOf(revised.result).ok) fail("handoff_revise");
  note("handoff_revise ok");

  const memoAdded = await call("memo_add", { cwd: WORK_A, title: "Journey memo", body: "memo body" });
  if (!memoAdded.ok || !envelopeOf(memoAdded.result).ok) fail("memo_add");
  const memoId = (envelopeOf(memoAdded.result).data as { memo: { id: string } }).memo.id;

  const memoList = await call("memo_list", { cwd: WORK_A });
  const listData = envelopeOf(memoList.result).data as { items?: Array<{ id: string }> };
  const listed = (listData.items ?? []).find((memo) => memo.id === memoId);
  if (listed === undefined) fail("memo_list");
  note("memo_list ok");

  const memoShown = await call("memo_show", { cwd: WORK_A, memoId });
  const shown = envelopeOf(memoShown.result).data as { id: string; body: string; rowVersion: number };
  if (shown.body !== "memo body") fail("memo_show body");
  note("memo_show ok (body)");

  const memoDone = await call("memo_done", { cwd: WORK_A, memoId, expectedRowVersion: shown.rowVersion });
  if (!memoDone.ok || !envelopeOf(memoDone.result).ok) fail("memo_done");
  note("memo_done ok");

  for (const step of [
    ["channel_create", { cwd: WORK_A, name: "gate" }],
    ["channel_add", { cwd: WORK_A, channel: "gate", handle: "w1", role: "worker" }],
  ] as Array<[string, Record<string, unknown>]>) {
    const done = await call(step[0], step[1]);
    if (!done.ok || !envelopeOf(done.result).ok) fail(step[0]);
    note(`${step[0]} ok`);
  }

  // The sandboxed client itself posts a Channel message and reads it back
  // before the host-side wake exercises the wait (C2 item 13).
  const posted = await call("channel_post", {
    cwd: WORK_A,
    channel: "gate",
    from: "w1",
    kind: "report",
    body: "posted from inside the sandbox",
  });
  if (!posted.ok || !envelopeOf(posted.result).ok) fail("channel_post");
  const postedSeq = (envelopeOf(posted.result).data as { message: { seq: number } }).message.seq;
  const readback = await call("channel_messages", { cwd: WORK_A, channel: "gate" });
  const readItems = (envelopeOf(readback.result).data as { items: Array<{ body: string; seq: number }> }).items;
  if (!readItems.some((item) => item.body === "posted from inside the sandbox" && item.seq === postedSeq))
    fail("channel_messages readback");
  const postedAck = await call("channel_ack", { cwd: WORK_A, channel: "gate", seq: [postedSeq] });
  if (!postedAck.ok || !envelopeOf(postedAck.result).ok) fail("channel_ack of the sandbox post");
  note("channel_post + readback + ack ok");

  // The Memo states r4 promises: after memo_done the read shows done.
  const doneState = await call("memo_show", { cwd: WORK_A, memoId });
  const doneDetail = envelopeOf(doneState.result).data as { state: string };
  if (doneDetail.state !== "done") fail(`memo state after done: ${doneDetail.state}`);
  note("memo state after done ok");

  const wait = await call("channel_messages", { cwd: WORK_A, channel: "gate", wait: true, timeout: 30 }, 45_000);
  const waited = envelopeOf(wait.result);
  if (!waited.ok) fail("channel_messages wait");
  const items = (waited.data as { items: Array<{ body: string; seq: number }> }).items;
  if (items.length !== 1 || items[0]?.body !== "the wake") fail("channel_messages wait body");
  note("channel_messages wait woke with the message");

  const acked = await call("channel_ack", { cwd: WORK_A, channel: "gate", seq: [items[0]?.seq as number] });
  if (!acked.ok || !envelopeOf(acked.result).ok) fail("channel_ack");
  note("channel_ack ok");

  const escaped = await call("memo_add", { cwd: WORK_A, title: "escape", bodyFile: "/etc/hosts" });
  const escapedEnvelope = envelopeOf(escaped.result);
  if (escapedEnvelope.error?.code !== "SOURCE_OUTSIDE_WORKSPACE") fail("escape refusal code");
  if (escaped.result?.isError !== true) fail("escape isError");
  if (
    escapedEnvelope.error?.recovery?.suggestedCommand !==
    "Pass a file inside the call's workspace (the call's `cwd`), or use the inline body"
  )
    fail("escape recovery");
  note("outside-workspace refusal ok (fixed envelope)");

  const coded = await call("channel_messages", { cwd: WORK_A, channel: "absent-channel" });
  if (envelopeOf(coded.result).error?.code !== "CHN_NOT_FOUND") fail("coded child failure");
  if (coded.result?.isError !== true) fail("coded child isError");
  note("CHN_NOT_FOUND envelope ok");

  const usage = await call("channel_messages", { cwd: WORK_A, channel: "gate", wait: true, all: true });
  if (usage.ok || usage.error?.code !== -32602) fail("usage -32602");
  note("usage-class -32602 ok");

  note("JOURNEY COMPLETE");
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line: string) => {
  if (line.trim().length === 0) return;
  const message = JSON.parse(line) as Record<string, unknown>;
  const id = message.id;
  if (typeof id === "number") {
    const resolve = pending.get(id);
    if (resolve !== undefined) {
      pending.delete(id);
      resolve(message);
    }
  }
});

controls()
  .then(journey)
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    fail(String(error));
  });
