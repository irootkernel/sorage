import { describe, expect, it } from "vitest";
import { LineSplitter } from "../contract/mcp-line-splitter";

/**
 * The byte-level line splitter every MCP test client and relay shares
 * (C3 item 8): newline-free fragments survive, a multibyte character split
 * across chunks decodes once, and a line spread over three chunks is
 * reconstructed exactly. One copy serves the contract and e2e suites alike.
 */
describe("the byte-level line splitter (C3 item 8)", () => {
  it("keeps newline-free fragments until a later chunk completes the line", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(Buffer.from('{"jsonrpc":', "utf8"))).toEqual([]);
    expect(splitter.push(Buffer.from('"2.0"}', "utf8"))).toEqual([]);
    expect(splitter.push(Buffer.from("\n", "utf8"))).toEqual(['{"jsonrpc":"2.0"}']);
  });

  it("decodes a multibyte character split across chunks exactly once", () => {
    const splitter = new LineSplitter();
    const whole = Buffer.from("다국어 본문 — 서울\n", "utf8");
    const split = whole.indexOf(Buffer.from("국", "utf8")) + 1;
    expect(splitter.push(whole.subarray(0, split))).toEqual([]);
    expect(splitter.push(whole.subarray(split))).toEqual(["다국어 본문 — 서울"]);
  });

  it("reconstructs one line spread over three chunks and keeps two records apart", () => {
    const splitter = new LineSplitter();
    const first = '{"id":1}';
    const second = '{"id":2}';
    expect(splitter.push(Buffer.from(`${first.slice(0, 3)}`, "utf8"))).toEqual([]);
    expect(splitter.push(Buffer.from(`${first.slice(3)}\n${second.slice(0, 4)}`, "utf8"))).toEqual([first]);
    expect(splitter.push(Buffer.from(`${second.slice(4)}\n`, "utf8"))).toEqual([second]);
    expect([...splitter.recorded()]).toEqual([first, second]);
  });
});
