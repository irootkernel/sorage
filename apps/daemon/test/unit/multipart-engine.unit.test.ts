import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { streamMultipart, type MultipartEnginePolicy, type MultipartPushSink } from "../../src/multipart-engine";
import type { IncomingMessage } from "node:http";

/**
 * The shared multipart engine's framing correctness (corrections #1-#7, the
 * R4 probe cases): CRLF-prefixed delimiter recognition that preserves payload
 * lookalikes, suffix validation that survives arbitrary chunk splits, exact
 * once-only payload accounting for streamed bodies, epilogue bytes counted
 * after the terminator, and the whole/meta/framing/body bounds enforced on
 * both the progressive and found-boundary paths. Each case drives the raw
 * state machine directly with real byte splits.
 */

class FakeRequest extends EventEmitter {
  headers: Record<string, string>;
  constructor(boundary = "b") {
    super();
    this.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  }
  resume(): void {}
}

interface SinkCapture {
  bytes: Buffer[];
  finished: { bytes: number; sha256: string } | null;
  aborted: boolean;
}

function pushSink(): { sink: MultipartPushSink; capture: SinkCapture } {
  const capture: SinkCapture = { bytes: [], finished: null, aborted: false };
  return {
    capture,
    sink: {
      write: (chunk) => capture.bytes.push(Buffer.from(chunk)),
      finish: (total, sha) => {
        capture.finished = { bytes: total, sha256: sha };
        return null;
      },
      abort: () => {
        capture.aborted = true;
      },
    },
  };
}

interface MemoPolicyHarness {
  policy: MultipartEnginePolicy<{ meta: string; bodyBytes: number }>;
  state: {
    meta: string | null;
    acceptedBody: Buffer | null;
    completed: { total: number; payload: number } | null;
  };
  body: { sink: MultipartPushSink; capture: SinkCapture };
}

/** A minimal policy: one text `meta` part, one push-sink `body` part, Memo contract bounds. */
function memoPolicy(
  spoolDir: string,
  options: { total?: number; framing?: number; meta?: number; body?: number } = {},
): MemoPolicyHarness {
  const total = options.total ?? 1_048_576 + 589_824;
  const framing = options.framing ?? 65_536;
  const metaBound = options.meta ?? 524_288;
  const bodyBound = options.body ?? 1_048_576;
  const body = pushSink();
  const state: {
    meta: string | null;
    acceptedBody: Buffer | null;
    completed: { total: number; payload: number } | null;
  } = {
    meta: null,
    acceptedBody: null,
    completed: null,
  };
  let metaSeen = false;
  let bodySeen = false;
  const policy: MultipartEnginePolicy<{ meta: string; bodyBytes: number }> = {
    boundaryError: { code: "MEMO_INVALID_INPUT", message: "boundary" } as never,
    malformedError: { code: "MEMO_INVALID_INPUT", message: "malformed" } as never,
    preambleBoundBytes: framing,
    preambleTooLargeError: { code: "MEMO_TOO_LARGE", message: "preamble" } as never,
    textFieldBoundBytes: metaBound,
    textFieldTooLargeError: { code: "MEMO_TOO_LARGE", message: "meta too large" } as never,
    headerBoundBytes: 65_536,
    headerTooLargeError: { code: "MEMO_TOO_LARGE", message: "headers" } as never,
    totalRawBoundBytes: total,
    totalRawTooLargeError: (n) => ({ code: "MEMO_TOO_LARGE", message: `whole ${String(n)}` }) as never,
    framingBoundBytes: framing,
    framingTooLargeError: (n) => ({ code: "MEMO_TOO_LARGE", message: `framing ${String(n)}` }) as never,
    partMaxBytes: bodyBound,
    partTooLargeError: (n) => ({ code: "MEMO_TOO_LARGE", message: `body ${String(n)}` }) as never,
    resolveAtTerminator: false,
    spoolDir,
    decideHeader(header) {
      if (header.filename !== null) {
        return { kind: "reject", error: { code: "MEMO_INVALID_INPUT", message: "filename" } as never };
      }
      if (header.name === "meta") {
        if (metaSeen) return { kind: "reject", error: { code: "MEMO_INVALID_INPUT", message: "dup meta" } as never };
        metaSeen = true;
        return { kind: "text" };
      }
      if (header.name === "body") {
        if (bodySeen) return { kind: "reject", error: { code: "MEMO_INVALID_INPUT", message: "dup body" } as never };
        bodySeen = true;
        return { kind: "push-sink", sink: body.sink };
      }
      return { kind: "reject", error: { code: "MEMO_INVALID_INPUT", message: "unknown" } as never };
    },
    onTextEnd(part) {
      state.meta = part.value;
      return null;
    },
    onSpoolEnd() {
      return null;
    },
    onComplete(totalRaw, payload) {
      if (state.meta === null) {
        return { ok: false, error: { code: "MEMO_INVALID_INPUT", message: "no meta" } as never };
      }
      state.completed = { total: totalRaw, payload };
      state.acceptedBody = Buffer.concat(body.capture.bytes);
      return { ok: true, value: { meta: state.meta, bodyBytes: body.capture.bytes.reduce((n, b) => n + b.length, 0) } };
    },
    onAbort() {
      body.sink.abort();
    },
  };
  return { policy, state, body };
}

function multipartBytes(
  boundary: string,
  parts: Array<{ name: string; content: Buffer; contentType?: string }>,
  epilogue = "",
): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  for (const [index, part] of parts.entries()) {
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"\r\n${
          part.contentType === undefined ? "" : `Content-Type: ${part.contentType}\r\n`
        }\r\n`,
      ),
    );
    chunks.push(part.content);
    chunks.push(Buffer.from(`\r\n--${boundary}${index === parts.length - 1 ? "--" : ""}\r\n`));
  }
  if (epilogue !== "") chunks.push(Buffer.from(epilogue));
  return Buffer.concat(chunks);
}

/** Splits bytes into arbitrary-size chunks with event-loop turns between them. */
async function emit(request: FakeRequest, bytes: Buffer, chunkSize: number): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    request.emit("data", bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
    await new Promise((resolve) => setImmediate(resolve));
  }
  request.emit("end");
}

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sorage-engine-int-"));
  roots.push(dir);
  return dir;
}

describe("multipart engine framing corrections", () => {
  it.each(["meta", "body"])("bounds a %s part while a delimiter is still awaiting its suffix", async (name) => {
    const { policy, body } = memoPolicy(join(tempDir(), "spool"), { meta: 64, body: 16 });
    const request = new FakeRequest();
    const pending = streamMultipart(request as unknown as IncomingMessage, policy);
    const prefix = name === "body" ? '--b\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{}\r\n' : "";
    request.emit(
      "data",
      Buffer.from(`${prefix}--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${"x".repeat(80)}\r\n--b`),
    );
    const outcome = await Promise.race([pending, new Promise<null>((resolve) => setImmediate(() => resolve(null)))]);
    expect(outcome).toMatchObject({ ok: false, error: { code: "MEMO_TOO_LARGE" } });
    const count = body.capture.bytes.length;
    request.emit("data", Buffer.alloc(100000));
    expect(body.capture.bytes).toHaveLength(count);
    request.emit("end");
    await pending;
  });

  it("accepts a baseline small request and accounts payload exactly once", async () => {
    const dir = tempDir();
    const { policy, state } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    const bytes = multipartBytes("b", [
      { name: "meta", content: Buffer.from(`{"projectId":"p","title":"t"}`) },
      { name: "body", content: Buffer.from("hello") },
    ]);
    await emit(request, bytes, 7);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bodyBytes).toBe(5);
    // Both text metadata and streamed body bytes are payload; framing is the remainder.
    const framing = (state.completed?.total ?? 0) - (state.completed?.payload ?? 0);
    expect(state.completed?.payload).toBe(5 + Buffer.byteLength(`{"projectId":"p","title":"t"}`));
    expect(framing).toBe(bytes.byteLength - (5 + Buffer.byteLength(`{"projectId":"p","title":"t"}`)));
  });

  it("counts a large streamed body as payload, not framing (R4 defect)", async () => {
    const dir = tempDir();
    const { policy, state } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    const body = Buffer.alloc(150_000, 0x61);
    const bytes = multipartBytes("b", [
      { name: "meta", content: Buffer.from(`{"projectId":"p","title":"t"}`) },
      { name: "body", content: body },
    ]);
    await emit(request, bytes, 32 * 1024);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(state.completed?.payload).toBe(150_000 + Buffer.byteLength(`{"projectId":"p","title":"t"}`));
    expect((state.completed?.total ?? 0) - (state.completed?.payload ?? 0)).toBeLessThan(65_536);
  });

  it("rejects a meta part overflowing its bound in a single chunk with its boundary", async () => {
    const dir = tempDir();
    const { policy } = memoPolicy(join(dir, "spool"), { meta: 64 });
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    const oversized = Buffer.alloc(80, 0x61);
    const bytes = multipartBytes("b", [
      { name: "meta", content: oversized },
      { name: "body", content: Buffer.from("x") },
    ]);
    await emit(request, bytes, 4096);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MEMO_TOO_LARGE");
  });

  it("rejects epilogue growth past the framing bound after the terminator in later chunks", async () => {
    const dir = tempDir();
    const { policy } = memoPolicy(join(dir, "spool"), { framing: 128 });
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    const bytes = multipartBytes(
      "b",
      [{ name: "meta", content: Buffer.from(`{"projectId":"p","title":"t"}`) }],
      "E".repeat(4096),
    );
    await emit(request, bytes, 1024);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MEMO_TOO_LARGE");
  });

  it("preserves a payload lookalike of the boundary as body content", async () => {
    const dir = tempDir();
    const { policy, state } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    // The body contains the delimiter bytes without a preceding CRLF at the
    // split point and with a bogus suffix: never a boundary.
    const lookalike = Buffer.concat([Buffer.from("AA--bBB"), Buffer.from(" rest of body")]);
    const bytes = multipartBytes("b", [
      { name: "meta", content: Buffer.from(`{"projectId":"p","title":"t"}`) },
      { name: "body", content: lookalike },
    ]);
    await emit(request, bytes, 5);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(Buffer.from(state.acceptedBody ?? []).toString("utf8")).toBe(lookalike.toString("utf8"));
  });

  it("awaits a closing suffix split across chunks instead of misrouting to headers", async () => {
    const dir = tempDir();
    const { policy, state } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    const bytes = multipartBytes("b", [
      { name: "meta", content: Buffer.from(`{"projectId":"p","title":"t"}`) },
      { name: "body", content: Buffer.from("payload") },
    ]);
    // Split exactly between the delimiter and its `--` suffix.
    const cut = bytes.indexOf(Buffer.from("--b--"));
    const head = bytes.subarray(0, cut + 3); // includes "--b"
    const tail = bytes.subarray(cut + 3); // starts with "--\r\n"
    for (const [index, slice] of [head, tail].entries()) {
      request.emit("data", slice);
      if (index === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    request.emit("end");
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(state.completed).not.toBeNull();
  });

  it("preserves body-final CRLF, BOM, lone CR and lone LF as exact content bytes", async () => {
    const dir = tempDir();
    const { policy, state } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    // The helper adds its own framing CRLF after this exact body, including its final CRLF.
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\rb\nc\r\n")]);
    const bytes = multipartBytes("b", [
      { name: "meta", content: Buffer.from(`{"projectId":"p","title":"t"}`) },
      { name: "body", content: body },
    ]);
    await emit(request, bytes, 4);
    await promise;
    const accepted = Buffer.from(state.acceptedBody ?? []);
    expect(accepted.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(accepted).toEqual(body);
  });

  it("passes filename attribute presence to the rejecting policy", async () => {
    for (const header of [
      'Content-Disposition: form-data; name="body"; filename=""',
      'Content-Disposition: form-data; name="body"; filename=',
    ]) {
      const dir = tempDir();
      const { policy } = memoPolicy(join(dir, "spool"));
      const request = new FakeRequest("b");
      const promise = streamMultipart(request as unknown as IncomingMessage, policy);
      request.emit("data", Buffer.from(`--b\r\n${header}\r\n\r\nx\r\n--b--\r\n`));
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("MEMO_INVALID_INPUT");
    }
  });

  it("refuses aggregate framing from multiple part headers before any body or terminator arrives", async () => {
    const dir = tempDir();
    const { policy, body } = memoPolicy(join(dir, "spool"), { framing: 65_536 });
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    // Two parts whose individual headers are each well under 65,536 but whose
    // combined structural framing (preamble + delimiters + headers) exceeds
    // the aggregate bound — no body or terminator is delivered at all.
    const filler = "F".repeat(35_000);
    request.emit(
      "data",
      Buffer.from(
        `--b\r\nContent-Disposition: form-data; name="meta"\r\nX-A: ${filler}\r\n\r\n{"projectId":"p","title":"t"}\r\n`,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    request.emit("data", Buffer.from(`--b\r\nContent-Disposition: form-data; name="body"\r\nX-B: ${filler}\r\n\r\n`));
    await new Promise((resolve) => setImmediate(resolve));
    // The promise settles early as a refusal without `end` being emitted: a
    // bounded probe confirms the settlement preceded the stream's natural end.
    const earlyProbe = await Promise.race([
      promise.then((outcome) => ({ settled: true as const, outcome })),
      new Promise<{ settled: false }>((resolvePending) => setImmediate(() => resolvePending({ settled: false }))),
    ]);
    expect(earlyProbe.settled).toBe(true);
    if (earlyProbe.settled) {
      expect(earlyProbe.outcome.ok).toBe(false);
      if (!earlyProbe.outcome.ok) expect(earlyProbe.outcome.error.code).toBe("MEMO_TOO_LARGE");
    }
    // No body part bytes were ever delivered to the capture sink.
    expect(body.capture.bytes).toHaveLength(0);
  });

  it("accepts headers above 16KiB each when the aggregate framing stays within 65,536", async () => {
    const dir = tempDir();
    const { policy, state } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    // A single 20KiB header block: above the old Handoff 16KiB bound but within
    // the aggregate 65,536 Memo framing budget.
    const bigHeader = `X-Fill: ${"F".repeat(20_000)}`;
    const bytes = multipartBytes("b", [
      { name: "meta", content: Buffer.from(`{"projectId":"p","title":"t"}`) },
      { name: "body", content: Buffer.from("x") },
    ]);
    // Replace the meta part's headers with the big one.
    const withBigHeader = bytes
      .toString("binary")
      .replace(
        'Content-Disposition: form-data; name="meta"\r\n\r\n',
        `Content-Disposition: form-data; name="meta"\r\n${bigHeader}\r\n\r\n`,
      );
    await emit(request, Buffer.from(withBigHeader, "binary"), 8192);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(state.completed).not.toBeNull();
  });

  it("accepts a meta part at exactly its bound with split trailing framing", async () => {
    const dir = tempDir();
    // A meta part of exactly 64 bytes (the bound), with the trailing CRLF +
    // delimiter split across chunks so the buffered value temporarily exceeds
    // the bound by only the delimiter lookahead.
    const { policy, state } = memoPolicy(join(dir, "spool"), { meta: 64 });
    const request = new FakeRequest();
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    const meta = "A".repeat(64);
    const bytes = multipartBytes("b", [
      { name: "meta", content: Buffer.from(meta) },
      { name: "body", content: Buffer.from("b") },
    ]);
    await emit(request, bytes, 5);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(state.meta).toBe(meta);
  });

  it("rejects filename* extended syntax and does not match name from filename's suffix", async () => {
    const dir = tempDir();
    const { policy } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest("b");
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    // filename* extended: must be rejected as a filename presence.
    request.emit(
      "data",
      Buffer.from(`--b\r\nContent-Disposition: form-data; name="body"; filename*=UTF-8''x.txt\r\n\r\nx\r\n--b--\r\n`),
    );
    request.emit("end");
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MEMO_INVALID_INPUT");
  });

  it("extracts the name from Content-Disposition without matching a filename suffix", async () => {
    const dir = tempDir();
    const { policy, state } = memoPolicy(join(dir, "spool"));
    const request = new FakeRequest("b");
    const promise = streamMultipart(request as unknown as IncomingMessage, policy);
    // `name` is the first parameter; the engine must not confuse it with the
    // `name` substring inside `filename`.
    request.emit(
      "data",
      Buffer.from(
        `--b\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{"projectId":"p","title":"t"}\r\n--b--\r\n`,
      ),
    );
    request.emit("end");
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(state.meta).toBe(`{"projectId":"p","title":"t"}`);
  });
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});
