import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { cliData } from "../../../cli/test/fixtures/memo-cli";
import { memoHttpFixture, value, code } from "../fixtures/memo-http";

const fixtures: Awaited<ReturnType<typeof memoHttpFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await memoHttpFixture();
  fixtures.push(f);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const boundary = "sorage_http_memo_boundary";
const headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
function part(name: string, content: string | Buffer, extra = ""): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`),
    Buffer.from(content),
    Buffer.from("\r\n"),
  ]);
}
const end = Buffer.from(`--${boundary}--\r\n`);
function wire(meta: unknown, body?: string | Buffer): Buffer {
  return Buffer.concat([part("meta", JSON.stringify(meta)), ...(body === undefined ? [] : [part("body", body)]), end]);
}
function inventory(f: Fixture) {
  return ["project_memos", "content_records", "events", "idempotency_keys", "pending_fs_ops"].map((table) =>
    f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}
function spools(f: Fixture): string[] {
  return ["uploads", "memo-input"].flatMap((name) => {
    const path = join(f.home, "state", name);
    return existsSync(path) ? readdirSync(path).map((entry) => `${name}/${entry}`) : [];
  });
}
function cap(f: Fixture, maxBytes: number) {
  const store = createNodeConfigCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).store;
  const read = store.read();
  if (!read.ok || read.value === null) throw new Error("Missing temporary config");
  const result = store.write(
    { ...read.value.config, artifact: { ...read.value.config.artifact, maxBytes } },
    { etag: read.value.etag },
  );
  if (!result.ok) throw new Error(result.error.message);
}

describe("authenticated Memo multipart transport", () => {
  it("streams exact large UTF-8 bytes, replays through the native CLI, and keeps an omitted PATCH body", async () => {
    const f = await fixture();
    const body = "\uFEFF" + "😀한글\r\n".repeat(52000) + `literal--${boundary}XX\rlast byte`;
    const bytes = wire({ projectId: f.projectId, title: "Large wire" }, body);
    const key = randomUUID();
    const first = await f.call("/api/v1/memos", {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
      chunks: Array.from({ length: Math.ceil(bytes.length / 32767) }, (_, i) =>
        bytes.subarray(i * 32767, (i + 1) * 32767),
      ),
    });
    expect(first.status).toBe(200);
    expect(value(first).memo.body).toBe(body);
    const source = join(f.home, "original-body.txt");
    writeFileSync(source, Buffer.from(body));
    const before = inventory(f);
    expect(
      cliData(
        f.run([
          "memo",
          "add",
          "--project",
          "memo",
          "--title",
          "Large wire",
          "--body-file",
          source,
          "--idempotency-key",
          key,
          "--replay-only",
          "--json",
        ]),
      ),
    ).toEqual({ ...value(first), replayed: true });
    expect(inventory(f)).toEqual(before);
    const patched = await f.call(`/api/v1/memos/${value(first).memo.id}`, {
      method: "PATCH",
      headers,
      raw: wire({ title: "Title only", expectedRowVersion: 1 }),
    });
    expect(patched.status).toBe(200);
    expect(value(patched).memo.body).toBe(body);
    expect(value(patched).memo.rowVersion).toBe(2);
    expect(spools(f)).toEqual([]);
  });

  it("shares the original key between JSON and multipart spellings, including explicit empty bodies", async () => {
    const f = await fixture();
    for (const body of ["", "\uFEFFexact\r\nlone\rno final LF"]) {
      const key = randomUUID();
      const original = await f.call("/api/v1/memos", {
        method: "POST",
        headers: { "idempotency-key": key },
        body: { projectId: f.projectId, title: "Cross encoding", body },
      });
      const before = inventory(f);
      const replay = await f.call("/api/v1/memos", {
        method: "POST",
        headers: { ...headers, "idempotency-key": key, "idempotency-mode": "replay-only" },
        raw: wire({ title: "Cross encoding", projectId: f.projectId }, body),
      });
      expect(replay.status).toBe(200);
      expect(value(replay)).toEqual({ ...value(original), replayed: true });
      expect(inventory(f)).toEqual(before);
    }
  });

  it("rejects malformed part identities, filename presence and invalid text without changing any authoritative row", async () => {
    const f = await fixture();
    const meta = { projectId: f.projectId, title: "Refused" };
    const validMeta = part("meta", JSON.stringify(meta));
    const badHeaders = [
      'X-Content-Disposition: form-data; name="meta"',
      'X-Note: content-disposition: form-data; name="meta"',
      'Content-Disposition: form-data; x="text; name=meta"',
    ];
    const invalid = [
      ...badHeaders.map((h) => Buffer.from(`--${boundary}\r\n${h}\r\n\r\n${JSON.stringify(meta)}\r\n${end}`)),
      ...["; filename", '; filename=""', "; filename=", "; filename*=UTF-8''memo.txt"].flatMap((attribute) => [
        Buffer.concat([part("meta", JSON.stringify(meta), attribute), end]),
        Buffer.concat([validMeta, part("body", "x", attribute), end]),
      ]),
      Buffer.concat([validMeta, part("meta", JSON.stringify(meta)), end]),
      Buffer.concat([validMeta, part("body", "x"), part("body", "y"), end]),
      Buffer.concat([validMeta, part("unknown", "x"), end]),
      wire({ ...meta, body: "forbidden" }, "x"),
      Buffer.concat([part("meta", Buffer.from([0xff])), end]),
      wire(meta, Buffer.from([0xff])),
      wire(meta, Buffer.from([0x61, 0])),
      Buffer.concat([part("body", "x".repeat(90000)), part("meta", "{bad JSON"), end]),
    ];
    for (const raw of invalid) {
      const before = inventory(f);
      const result = await f.call("/api/v1/memos", { method: "POST", headers, raw });
      expect(result.status).toBe(422);
      expect(code(result)).toBe("MEMO_INVALID_INPUT");
      expect(inventory(f)).toEqual(before);
      expect(spools(f)).toEqual([]);
    }
    const quoted = await f.call("/api/v1/memos", {
      method: "POST",
      headers,
      raw: Buffer.concat([part("meta", JSON.stringify(meta), '; note="text; filename=literal"'), end]),
    });
    expect(quoted.status).toBe(200);
  });

  it("enforces actual Memo content-type and charset policy while allowing absent types and quoted UTF-8", async () => {
    const f = await fixture();
    const meta = { projectId: f.projectId, title: "Charset" };
    for (const type of [
      'text/plain; charset="utf-16"',
      'text/plain; charset=""',
      "text/plain; charset=",
      "text/plain; charset",
      "application/octet-stream",
    ]) {
      const before = inventory(f);
      const result = await f.call("/api/v1/memos", {
        method: "POST",
        headers,
        raw: Buffer.concat([part("meta", JSON.stringify(meta)), part("body", "x", `\r\nContent-Type: ${type}`), end]),
      });
      expect(result.status).toBe(422);
      expect(inventory(f)).toEqual(before);
    }
    for (const extra of ["", '\r\nContent-Type: text/plain; CHARSET = "UTF-8"']) {
      const result = await f.call("/api/v1/memos", {
        method: "POST",
        headers,
        raw: Buffer.concat([
          part("meta", JSON.stringify(meta), '\r\nContent-Type: application/json; charset="utf-8"'),
          part("body", "valid 😀", extra),
          end,
        ]),
      });
      expect(result.status).toBe(200);
      expect(value(result).memo.body).toBe("valid 😀");
    }
  });

  it("accepts exact meta/framing limits and refuses each over-limit request as 413 with no effects", async () => {
    const f = await fixture();
    cap(f, 1024);
    const meta = JSON.stringify({ projectId: f.projectId, title: "Bounds" });
    const exactMeta = meta + " ".repeat(524288 - Buffer.byteLength(meta));
    expect(
      (await f.call("/api/v1/memos", { method: "POST", headers, raw: Buffer.concat([part("meta", exactMeta), end]) }))
        .status,
    ).toBe(200);
    const base = Buffer.concat([part("meta", meta, `\r\nX-Pad: ${"x".repeat(20000)}`), part("body", "x"), end]);
    const framing = base.length - Buffer.byteLength(meta) - 1;
    const exactFrame = Buffer.concat([base, Buffer.alloc(65536 - framing, 0x78)]);
    expect((await f.call("/api/v1/memos", { method: "POST", headers, raw: exactFrame })).status).toBe(200);
    const invalid = [
      Buffer.concat([part("meta", exactMeta + " "), end]),
      wire(JSON.parse(meta), "x".repeat(1025)),
      Buffer.concat([exactFrame, Buffer.from("x")]),
      Buffer.alloc(1024 + 589825, 0x78),
    ];
    for (const raw of invalid) {
      const before = inventory(f);
      const refused = await f.call("/api/v1/memos", { method: "POST", headers, raw });
      expect(refused.status).toBe(413);
      expect(code(refused)).toBe("MEMO_TOO_LARGE");
      expect(inventory(f)).toEqual(before);
      expect(spools(f)).toEqual([]);
    }
  });

  it("checks Host and authentication before multipart ingestion and leaves replay-only misses unchanged", async () => {
    const f = await fixture();
    const raw = wire({ projectId: f.projectId, title: "Authority" }, "x".repeat(90000));
    const before = inventory(f);
    for (const [options, status] of [
      [{ bearer: null }, 401],
      [{ headers: { ...headers, host: "attacker.invalid" } }, 421],
    ] as const) {
      const result = await f.call("/api/v1/memos", { method: "POST", headers, raw, ...options });
      expect(result.status).toBe(status);
      expect(existsSync(join(f.home, "state", "uploads"))).toBe(false);
      expect(spools(f)).toEqual([]);
      expect(inventory(f)).toEqual(before);
    }
    const result = await f.call("/api/v1/memos", {
      method: "POST",
      headers: { ...headers, "idempotency-key": randomUUID(), "idempotency-mode": "replay-only" },
      raw,
    });
    expect(code(result)).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(inventory(f)).toEqual(before);
    expect(spools(f)).toEqual([]);
  });

  it("releases a genuinely streamed partial body when the HTTP connection aborts", async () => {
    const f = await fixture();
    const before = inventory(f);
    const raw = Buffer.concat([
      part("meta", JSON.stringify({ projectId: f.projectId, title: "Interrupted" })),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="body"\r\n\r\n`),
      Buffer.alloc(100000, 0x78),
    ]);
    await expect(
      f.call("/api/v1/memos", {
        method: "POST",
        headers,
        raw,
        beforeEnd: async () => {
          await vi.waitFor(() => expect(spools(f).some((name) => name.startsWith("memo-input/"))).toBe(true));
          throw new Error("Intentional client disconnect");
        },
      }),
    ).rejects.toThrow("Intentional client disconnect");
    await vi.waitFor(() => expect(spools(f)).toEqual([]));
    expect(inventory(f)).toEqual(before);
  });
});
