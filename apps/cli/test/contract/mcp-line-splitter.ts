/**
 * One byte-level line splitter for every MCP test client and relay (c2-decision
 * item 3): it keeps the unconsumed remainder after every chunk — including a
 * chunk that carries no newline — and decodes each complete line exactly once.
 * 0x0a never appears inside a UTF-8 multibyte sequence, so cutting lines from
 * the raw bytes is exact even when a multibyte character splits across chunks.
 * The e2e suite imports this same module; the unit cases in
 * mcp-line-splitter.unit.test.ts cover it.
 */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);
  private readonly lines: string[] = [];

  push(chunk: Buffer): string[] {
    const buffer = Buffer.concat([this.pending, chunk]);
    const produced: string[] = [];
    let start = 0;
    let newline = buffer.indexOf(0x0a, start);
    while (newline >= 0) {
      const line = buffer.subarray(start, newline).toString("utf8");
      produced.push(line);
      this.lines.push(line);
      start = newline + 1;
      newline = buffer.indexOf(0x0a, start);
    }
    // The unconsumed remainder survives every push, newline or not.
    this.pending = buffer.subarray(start);
    return produced;
  }

  /** Every complete line so far, in order. */
  recorded(): readonly string[] {
    return this.lines;
  }
}
