import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
});
