import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureMemoBodyFile, captureMemoBodyText } from "../../src/memo-body-file";

const faults = vi.hoisted(() => ({
  read: false,
  write: false,
  sync: false,
  close: false,
  reads: 0,
  writes: 0,
  closes: 0,
}));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readSync: (...args: unknown[]) => {
      // The first two chunks have already caused a real spill before refusal.
      if (faults.read && faults.reads++ === 2) throw new Error("injected read failure");
      return Reflect.apply(fs.readSync, undefined, args) as number;
    },
    writeSync: (...args: unknown[]) => {
      // Leave a genuinely partial spool before the write failure.
      if (faults.write && faults.writes++ === 1) throw new Error("injected write failure");
      return Reflect.apply(fs.writeSync, undefined, args) as number;
    },
    fsyncSync: (...args: unknown[]) => {
      if (faults.sync) throw new Error("injected sync failure");
      return Reflect.apply(fs.fsyncSync, undefined, args);
    },
    closeSync: (...args: unknown[]) => {
      faults.closes++;
      Reflect.apply(fs.closeSync, undefined, args);
      // Model an ambiguous close that already disposed its descriptor. Never
      // retry that descriptor or let its exception skip the other close.
      if (faults.close) throw new Error("injected close failure");
    },
  };
});

let root: string;
const body = "x".repeat(192 * 1024);
beforeEach(() => {
  Object.assign(faults, { read: false, write: false, sync: false, close: false, reads: 0, writes: 0, closes: 0 });
  root = mkdtempSync(join(tmpdir(), "sorage-memo-capture-fault-"));
  writeFileSync(join(root, "body.md"), body);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function options() {
  return { maxBytes: 256 * 1024, stateDir: join(root, "state"), spoolId: randomUUID() };
}
function spoolEntries() {
  const directory = join(root, "state", "memo-input");
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("accepted Memo input cleanup after actual partial writes", () => {
  it.each(["read", "write", "sync"] as const)("releases the file capture spool after %s fails", (fault) => {
    faults[fault] = true;
    const result = captureMemoBodyFile(join(root, "body.md"), options());
    expect(result.ok).toBe(false);
    expect(faults.closes).toBe(2);
    expect(spoolEntries()).toEqual([]);
  });

  it.each(["write", "sync"] as const)("releases the text capture spool after %s fails", (fault) => {
    faults[fault] = true;
    expect(captureMemoBodyText(body, options())).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(faults.closes).toBe(1);
    expect(spoolEntries()).toEqual([]);
  });

  it("disposes both file descriptors and preserves the original capture refusal when closes throw", () => {
    faults.read = true;
    faults.close = true;
    expect(captureMemoBodyFile(join(root, "body.md"), options())).toMatchObject({
      ok: false,
      error: { code: "MEMO_FILE_READ_FAILED" },
    });
    expect(faults.closes).toBe(2);
    expect(spoolEntries()).toEqual([]);
  });
});

describe("bounded text encoding of in-memory bodies", () => {
  const unit = "\uFEFF🙂áあ漢\r\né\rgo😀";

  it("captures the empty body exactly", () => {
    expect(captureMemoBodyText("", options())).toMatchObject({
      ok: true,
      value: { kind: "text", text: "", sizeBytes: 0, sha256: createHash("sha256").digest("hex") },
    });
  });

  it("captures a small multi-charset body inline with exact bytes and digest", () => {
    const reference = Buffer.from(unit, "utf8");
    const referenceSha = createHash("sha256").update(reference).digest("hex");
    expect(captureMemoBodyText(unit, options())).toMatchObject({
      ok: true,
      value: { kind: "text", text: unit, sizeBytes: reference.byteLength, sha256: referenceSha },
    });
  });

  it("spills a large multi-charset body whose spool bytes and digest equal the whole-text reference", () => {
    const input = unit.repeat(10_000);
    // The reference is computed before any spy is active, never through it.
    const reference = Buffer.from(input, "utf8");
    const referenceSha = createHash("sha256").update(reference).digest("hex");
    const result = captureMemoBodyText(input, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("spool");
    if (result.value.kind !== "spool") return;
    expect(result.value.sizeBytes).toBe(reference.byteLength);
    expect(result.value.sha256).toBe(referenceSha);
    expect(readFileSync(result.value.spoolPath).equals(reference)).toBe(true);
  });

  it("keeps a surrogate pair whole when it straddles a slice boundary", () => {
    // The first slice would otherwise end between the pair's two code units;
    // the exact spool comparison fails on U+FFFD replacement bytes if the
    // boundary ever splits it.
    const input = `${"a".repeat(16_383)}🙂${"b".repeat(84_000)}`;
    const reference = Buffer.from(input, "utf8");
    const referenceSha = createHash("sha256").update(reference).digest("hex");
    const result = captureMemoBodyText(input, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("spool");
    if (result.value.kind !== "spool") return;
    expect(result.value.sizeBytes).toBe(reference.byteLength);
    expect(result.value.sha256).toBe(referenceSha);
    expect(readFileSync(result.value.spoolPath).equals(reference)).toBe(true);
  });

  it("allocates every encoder buffer at or below the 64 KiB capture bound", () => {
    const spy = vi.spyOn(Buffer, "from");
    try {
      const ascii = captureMemoBodyText(body, options());
      expect(ascii.ok).toBe(true);
      const astral = captureMemoBodyText(unit.repeat(10_000), options());
      expect(astral.ok).toBe(true);
      // Every observed allocation — bounded string encodes and inline prefix
      // copies alike — stays at or under the capture chunk size regardless of
      // the input's total size; a whole-body encode would exceed it.
      const sizes = spy.mock.results.map((call) =>
        call.type === "return" ? call.value.byteLength : Number.POSITIVE_INFINITY,
      );
      expect(sizes.length).toBeGreaterThan(1);
      for (const size of sizes) expect(size).toBeLessThanOrEqual(65_536);
    } finally {
      spy.mockRestore();
    }
  });

  it("aborts the real partial spill when the encoder throws after spilling has begun", () => {
    const originalFrom = Buffer.from.bind(Buffer) as unknown as (
      value: string | Buffer,
      encoding?: BufferEncoding,
    ) => Buffer;
    let threw = false;
    let spilledBytesAtThrow = 0;
    const spy = vi.spyOn(Buffer, "from").mockImplementation(((value: string | Buffer, encoding?: BufferEncoding) => {
      const encoded = originalFrom(value, encoding);
      // Throw only from the text-encoder path (a string argument) and only
      // once a real spill already holds bytes on disk — measured, not
      // assumed from the call count.
      if (!threw && typeof value === "string" && value.length > 0) {
        const directory = join(root, "state", "memo-input");
        const names = existsSync(directory) ? readdirSync(directory) : [];
        let onDisk = 0;
        for (const name of names) onDisk += statSync(join(directory, name)).size;
        if (onDisk > 0) {
          threw = true;
          spilledBytesAtThrow = onDisk;
          throw new Error("injected encoder failure");
        }
      }
      return encoded;
    }) as unknown as typeof Buffer.from);
    try {
      const result = captureMemoBodyText(body, options());
      expect(threw).toBe(true);
      expect(spilledBytesAtThrow).toBeGreaterThan(0);
      expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
      expect(faults.closes).toBe(1);
      expect(spoolEntries()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a text body above the configured cap without leaving a spool behind", () => {
    expect(captureMemoBodyText(body, { ...options(), maxBytes: 64 * 1024 })).toMatchObject({
      ok: false,
      error: { code: "MEMO_TOO_LARGE" },
    });
    expect(spoolEntries()).toEqual([]);
  });
});
