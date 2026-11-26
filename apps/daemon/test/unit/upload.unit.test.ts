import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consumeMultipartUpload } from "../../src/upload";
import type { IncomingMessage } from "node:http";

/**
 * The TASK-047 concurrency seam: one upload's cleanup removes only its own spool
 * file, so the shared `state/uploads` directory of a concurrent upload survives.
 */
class FakeMultipartRequest extends EventEmitter {
  headers: Record<string, string>;

  constructor() {
    super();
    this.headers = { "content-type": "multipart/form-data; boundary=b" };
  }

  resume(): void {}
}

function part(name: string, filename: string | undefined, value: string): Buffer {
  const disposition =
    filename === undefined
      ? `Content-Disposition: form-data; name="${name}"\r\n\r\n`
      : `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`;
  return Buffer.from(`--b\r\n${disposition}${value}\r\n`);
}

const closing = Buffer.from("--b--\r\n");

describe("upload cleanup isolation", () => {
  it("removes only its own spool file so a concurrent upload's directory survives", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      // The slow upload reaches its file body and pauses mid-stream.
      const slow = new FakeMultipartRequest();
      const slowPromise = consumeMultipartUpload(slow as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      slow.emit("data", part("title", undefined, "Slow"));
      slow.emit("data", part("file", "slow.md", "# slow payload"));

      // A sibling upload completes against the same shared spool directory.
      const fast = new FakeMultipartRequest();
      const fastPromise = consumeMultipartUpload(fast as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      fast.emit("data", part("title", undefined, "Fast"));
      fast.emit("data", part("file", "fast.md", "# fast payload"));
      fast.emit("data", closing);
      fast.emit("end");
      const fastResult = await fastPromise;
      expect(fastResult.ok).toBe(true);
      if (!fastResult.ok) return;

      // Both spools exist before cleanup; the finished one removes only its own.
      expect(readdirSync(spoolDir)).toHaveLength(2);
      fastResult.value.cleanup();
      const survivors = readdirSync(spoolDir);
      expect(survivors).toHaveLength(1);
      expect(existsSync(join(spoolDir, survivors[0] as string))).toBe(true);

      // The paused upload still completes with its bytes intact after the sibling
      // cleanup ran: the old recursive directory removal used to make this fail.
      slow.emit("data", closing);
      slow.emit("end");
      const slowResult = await slowPromise;
      expect(slowResult.ok).toBe(true);
      if (!slowResult.ok) return;
      const file = slowResult.value.file;
      expect(file).not.toBeNull();
      if (file === null) return;
      expect(readFileSync(file.path, "utf8")).toBe("# slow payload");
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("streams a body field to disk without a file part", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      request.emit("data", part("title", undefined, "Note"));
      request.emit("data", part("body", undefined, "# Hello\n"));
      request.emit("data", closing);
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.file).toBeNull();
      expect(result.value.body?.bytes).toBe(Buffer.byteLength("# Hello\n"));
      expect(readFileSync(result.value.body?.path ?? "").toString("utf8")).toBe("# Hello\n");
      result.value.cleanup();
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("keeps a body whose Markdown starts with YAML frontmatter dashes", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    const markdown = "---\ntitle: x\n---\n\n# Hello\n";
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      request.emit("data", part("title", undefined, "Frontmatter"));
      request.emit("data", part("body", undefined, markdown));
      request.emit("data", closing);
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(readFileSync(result.value.body?.path ?? "").toString("utf8")).toBe(markdown);
      result.value.cleanup();
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid UTF-8 body and leaves no spool", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      request.emit("data", part("title", undefined, "Broken"));
      request.emit(
        "data",
        Buffer.concat([
          Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n'),
          Buffer.from([0xff, 0xfe]),
          Buffer.from("\r\n"),
        ]),
      );
      request.emit("data", closing);
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("rejects a file part and a body field together", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      request.emit("data", part("file", "a.md", "# a\n"));
      request.emit("data", part("body", undefined, "# b\n"));
      request.emit("data", closing);
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("both");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate body field", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      request.emit("data", part("body", undefined, "# one\n"));
      request.emit("data", part("body", undefined, "# two\n"));
      request.emit("data", closing);
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("more than one body");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("rejects a whitespace-only body and leaves no spool", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      request.emit("data", part("body", undefined, "  \n\t  "));
      request.emit("data", closing);
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("empty after trimming");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("aborts a body that crosses artifact.maxBytes mid-stream", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 16,
        spoolDir,
      });
      request.emit("data", part("body", undefined, "x".repeat(64)));
      request.emit("data", closing);
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("ARTIFACT_TOO_LARGE");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("refuses a multipart preamble that never finds its boundary", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-unit-"));
    try {
      const hostile = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(hostile as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      // A boundary-less preamble larger than the bound must fail instead of
      // buffering an endless stream in memory.
      hostile.emit("data", Buffer.alloc(70_000, 0x61));
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("preamble");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("cleans up the active push-sink spool on premature disconnect and stream error", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-abort-"));
    try {
      const disconnected = new FakeMultipartRequest();
      const disconnectPromise = consumeMultipartUpload(disconnected as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      disconnected.emit(
        "data",
        Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="drop.md"\r\n\r\npartial payload'),
      );
      expect(readdirSync(spoolDir)).toHaveLength(1);
      disconnected.emit("close");
      const disconnectResult = await disconnectPromise;
      expect(disconnectResult.ok).toBe(false);
      expect(readdirSync(spoolDir)).toHaveLength(0);

      const errored = new FakeMultipartRequest();
      const errorPromise = consumeMultipartUpload(errored as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      errored.emit("data", Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\npartial body'));
      expect(readdirSync(spoolDir)).toHaveLength(1);
      errored.emit("error", new Error("ECONNRESET"));
      const errorResult = await errorPromise;
      expect(errorResult.ok).toBe(false);
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("returns INTERNAL_ERROR without throwing when opening the upload spool fails", async () => {
    const temp = mkdtempSync(join(tmpdir(), "sorage-upload-badspool-"));
    const blockingFile = join(temp, "not-a-directory");
    writeFileSync(blockingFile, "blocker");
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir: blockingFile,
      });
      // Must return a typed INTERNAL_ERROR rather than throwing synchronously out of EventEmitter.
      expect(() => {
        request.emit("data", part("file", "a.md", "# hello\n"));
        request.emit("data", closing);
        request.emit("end");
      }).not.toThrow();
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.message).toContain("spool");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects a large in-limit whitespace-only body across multiple chunks and leaves no spool", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-large-ws-"));
    try {
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 256 * 1024,
        spoolDir,
      });
      request.emit("data", part("title", undefined, "Large whitespace"));
      request.emit("data", Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n'));
      // Stream 144 KiB of mixed ASCII and multi-byte UTF-8 whitespace in 9 KiB chunks (9-byte pattern x 1024 x 16).
      const chunk = Buffer.from(" \t\r\n\u00A0\u3000".repeat(1024));
      for (let index = 0; index < 16; index += 1) {
        request.emit("data", chunk);
      }
      request.emit("data", Buffer.from("\r\n--b--\r\n"));
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("empty after trimming");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("accepts split multi-byte UTF-8 body content delivered one byte per chunk", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-utf8-split-"));
    try {
      const text = "   \u3000# 한글 제목 🚀\n\n내용 끝\n";
      const payload = Buffer.concat([
        part("title", undefined, "Unicode"),
        Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n'),
        Buffer.from(text, "utf8"),
        Buffer.from("\r\n"),
        closing,
      ]);
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      for (let offset = 0; offset < payload.length; offset += 1) {
        request.emit("data", payload.subarray(offset, offset + 1));
      }
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body?.bytes).toBe(Buffer.byteLength(text, "utf8"));
      expect(readFileSync(result.value.body?.path ?? "", "utf8")).toBe(text);
      result.value.cleanup();
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("rejects split multi-byte UTF-8 whitespace-only body as empty rather than invalid UTF-8", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-utf8-ws-"));
    try {
      const payload = Buffer.concat([
        Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n'),
        Buffer.from("\u00A0\u3000\uFEFF \t\n", "utf8"),
        Buffer.from("\r\n"),
        closing,
      ]);
      const request = new FakeMultipartRequest();
      const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      for (let offset = 0; offset < payload.length; offset += 1) {
        request.emit("data", payload.subarray(offset, offset + 1));
      }
      request.emit("end");
      const result = await promise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("empty after trimming");
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("rejects trailing invalid or truncated UTF-8 after valid non-whitespace text including past 64 KiB and leaves no spool", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-utf8-tail-"));
    try {
      const prefixes = [
        Buffer.from("# Valid heading\n", "utf8"),
        Buffer.from(`# Long valid\n${"a".repeat(70 * 1024)}`, "utf8"),
      ];
      for (const prefix of prefixes) {
        for (const badTail of [Buffer.from([0xff, 0xfe]), Buffer.from([0xf0, 0x9f])]) {
          const request = new FakeMultipartRequest();
          const promise = consumeMultipartUpload(request as unknown as IncomingMessage, {
            maxBytes: 256 * 1024,
            spoolDir,
          });
          request.emit("data", Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n'));
          request.emit("data", prefix);
          request.emit("data", badTail);
          request.emit("data", Buffer.from("\r\n--b--\r\n"));
          request.emit("end");
          const result = await promise;
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("CONFIG_INVALID");
          expect(result.error.message).toContain("valid UTF-8");
          expect(readdirSync(spoolDir)).toHaveLength(0);
        }
      }
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("accepts a body whose only non-whitespace character arrives at the very end, including a 1-byte split trailing rune", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-eof-char-"));
    try {
      const longTailText = `${" ".repeat(70 * 1024)}x`;
      const longReq = new FakeMultipartRequest();
      const longPromise = consumeMultipartUpload(longReq as unknown as IncomingMessage, {
        maxBytes: 256 * 1024,
        spoolDir,
      });
      longReq.emit("data", part("body", undefined, longTailText));
      longReq.emit("data", closing);
      longReq.emit("end");
      const longResult = await longPromise;
      expect(longResult.ok).toBe(true);
      if (!longResult.ok) return;
      expect(longResult.value.body?.bytes).toBe(Buffer.byteLength(longTailText, "utf8"));
      expect(readFileSync(longResult.value.body?.path ?? "", "utf8")).toBe(longTailText);
      longResult.value.cleanup();
      expect(readdirSync(spoolDir)).toHaveLength(0);

      const trailingRuneText = `${" ".repeat(64)}한`;
      const payload = Buffer.concat([
        Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n'),
        Buffer.from(trailingRuneText, "utf8"),
        Buffer.from("\r\n"),
        closing,
      ]);
      const splitReq = new FakeMultipartRequest();
      const splitPromise = consumeMultipartUpload(splitReq as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      for (let offset = 0; offset < payload.length; offset += 1) {
        splitReq.emit("data", payload.subarray(offset, offset + 1));
      }
      splitReq.emit("end");
      const splitResult = await splitPromise;
      expect(splitResult.ok).toBe(true);
      if (!splitResult.ok) return;
      expect(splitResult.value.body?.bytes).toBe(Buffer.byteLength(trailingRuneText, "utf8"));
      expect(readFileSync(splitResult.value.body?.path ?? "", "utf8")).toBe(trailingRuneText);
      splitResult.value.cleanup();
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("preserves error precedence when a whitespace or invalid-UTF-8 body collides with file, duplicate body, size, or malformed framing", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "sorage-upload-precedence-"));
    try {
      // Whitespace body followed by a file part still reports both-parts conflict.
      const both = new FakeMultipartRequest();
      const bothPromise = consumeMultipartUpload(both as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      both.emit("data", part("body", undefined, "   "));
      both.emit("data", part("file", "a.md", "# a\n"));
      both.emit("data", closing);
      both.emit("end");
      const bothResult = await bothPromise;
      expect(bothResult.ok).toBe(false);
      if (!bothResult.ok) {
        expect(bothResult.error.code).toBe("CONFIG_INVALID");
        expect(bothResult.error.message).toContain("both");
      }
      expect(readdirSync(spoolDir)).toHaveLength(0);

      // Whitespace body followed by a second body part still reports duplicate-body conflict.
      const duplicate = new FakeMultipartRequest();
      const duplicatePromise = consumeMultipartUpload(duplicate as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      duplicate.emit("data", part("body", undefined, "   "));
      duplicate.emit("data", part("body", undefined, "# second\n"));
      duplicate.emit("data", closing);
      duplicate.emit("end");
      const duplicateResult = await duplicatePromise;
      expect(duplicateResult.ok).toBe(false);
      if (!duplicateResult.ok) {
        expect(duplicateResult.error.code).toBe("CONFIG_INVALID");
        expect(duplicateResult.error.message).toContain("more than one body");
      }
      expect(readdirSync(spoolDir)).toHaveLength(0);

      // Invalid UTF-8 body that later crosses maxBytes still aborts with ARTIFACT_TOO_LARGE.
      const oversized = new FakeMultipartRequest();
      const oversizedPromise = consumeMultipartUpload(oversized as unknown as IncomingMessage, {
        maxBytes: 16,
        spoolDir,
      });
      oversized.emit("data", Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n'));
      oversized.emit("data", Buffer.from([0xff, 0xfe]));
      oversized.emit("data", Buffer.from("x".repeat(64)));
      oversized.emit("data", Buffer.from("\r\n--b--\r\n"));
      oversized.emit("end");
      const oversizedResult = await oversizedPromise;
      expect(oversizedResult.ok).toBe(false);
      if (!oversizedResult.ok) {
        expect(oversizedResult.error.code).toBe("ARTIFACT_TOO_LARGE");
      }
      expect(readdirSync(spoolDir)).toHaveLength(0);

      // Truncated multipart without closing boundary still fails malformed framing and removes spool.
      const truncated = new FakeMultipartRequest();
      const truncatedPromise = consumeMultipartUpload(truncated as unknown as IncomingMessage, {
        maxBytes: 1_000_000,
        spoolDir,
      });
      truncated.emit("data", Buffer.from('--b\r\nContent-Disposition: form-data; name="body"\r\n\r\n# cut off'));
      truncated.emit("end");
      const truncatedResult = await truncatedPromise;
      expect(truncatedResult.ok).toBe(false);
      if (!truncatedResult.ok) {
        expect(truncatedResult.error.code).toBe("CONFIG_INVALID");
        expect(truncatedResult.error.message).toContain("closing boundary");
      }
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });
});
