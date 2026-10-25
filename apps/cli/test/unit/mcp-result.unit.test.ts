import { describe, expect, it } from "vitest";
import { buildChildResult, handleToolCall, parseTrailingEnvelope, type SpawnedChild } from "../../src/mcp-server";

/**
 * Result building from recorded child outcomes (SOT-2): `content[0]` is
 * unconditionally the CLI envelope item — the trailing JSON object — taken
 * verbatim and never re-serialized; the child's remaining stderr lines travel
 * verbatim, in their original order, as exactly one additional text item after
 * it; exit 2 without an envelope answers `-32602` with the child's stderr
 * text; a crash, a signal or a spawn failure settles as the synthesized
 * `INTERNAL_ERROR` envelope and never throws.
 */
function envelopeOf(ok: boolean, extra: Record<string, unknown> = {}): string {
  const body = ok
    ? { ok: true, data: { canned: true }, meta: { requestId: "canned" }, ...extra }
    : {
        ok: false,
        error: { code: "CHN_NOT_FOUND", message: "no such channel", details: {} },
        meta: { requestId: "canned" },
        ...extra,
      };
  return `${JSON.stringify(body, null, 2)}\n`;
}

describe("buildChildResult (SOT-2)", () => {
  it("takes a success envelope from stdout verbatim as content[0], with the format check", () => {
    const built = buildChildResult({ status: 0, signal: null, stdout: envelopeOf(true), stderr: "" });
    expect(built.kind).toBe("result");
    if (built.kind !== "result") return;
    expect(built.payload.isError).toBe(false);
    expect(built.payload.content).toHaveLength(1);
    const envelopeItem = built.payload.content[0] as { type: string; text: string };
    expect(envelopeItem.type).toBe("text");
    expect(envelopeItem.text).toBe(envelopeOf(true));
    expect(envelopeItem.text).toBe(`${JSON.stringify(built.payload.structuredContent, null, 2)}\n`);
  });

  it("carries success-path stderr warnings as exactly one additional item after the envelope", () => {
    const warnings =
      "warning: content activation paused; the pending intent remains for the next process start.\nwarning: second line.\n";
    const built = buildChildResult({ status: 0, signal: null, stdout: envelopeOf(true), stderr: warnings });
    expect(built.kind).toBe("result");
    if (built.kind !== "result") return;
    expect(built.payload.content).toHaveLength(2);
    const diagnostic = built.payload.content[1] as { text: string };
    expect(diagnostic.text).toBe(warnings);
  });

  it("takes a coded failure envelope from stderr with preceding diagnostics as one item after it", () => {
    const diagnostics = "warning: something first.\n";
    const built = buildChildResult({
      status: 64,
      signal: null,
      stdout: "",
      stderr: `${diagnostics}${envelopeOf(false)}`,
    });
    expect(built.kind).toBe("result");
    if (built.kind !== "result") return;
    expect(built.payload.isError).toBe(true);
    const envelopeItem = built.payload.content[0] as { text: string };
    const diagnostic = built.payload.content[1] as { text: string };
    expect(envelopeItem.text).toBe(envelopeOf(false));
    expect(diagnostic.text).toBe(diagnostics);
  });

  it("answers a child exit 2 without an envelope as -32602 carrying the child's stderr text", () => {
    const built = buildChildResult({
      status: 2,
      signal: null,
      stdout: "",
      stderr: "sorage: unknown usage refusal\nRun 'sorage --help' for usage.\n",
    });
    expect(built).toEqual({
      kind: "protocolError",
      code: -32602,
      message: "sorage: unknown usage refusal\nRun 'sorage --help' for usage.",
    });
  });

  it("settles a signal death and an envelope-less other exit as the synthesized INTERNAL_ERROR envelope", () => {
    for (const outcome of [
      { status: null, signal: "SIGKILL" as const, stdout: "", stderr: "" },
      { status: 1, signal: null, stdout: "partial without an envelope", stderr: "" },
      { status: 0, signal: null, stdout: "", stderr: "" },
    ]) {
      const built = buildChildResult(outcome);
      expect(built.kind).toBe("result");
      if (built.kind !== "result") return;
      expect(built.payload.isError).toBe(true);
      const failure = built.payload.structuredContent as { error: { code: string; message: string } };
      expect(failure.error.code).toBe("INTERNAL_ERROR");
      // A child fault keeps the child wording, so it stays distinguishable
      // from the server-fault message of the dispatch rejection handler.
      expect(failure.error.message).toContain("the sorage child process failed");
    }
  });
});

describe("the spawn failure channels never throw (plan 4.5)", () => {
  class FailingChild implements SpawnedChild {
    stdout = { on: () => {} };
    stderr = { on: () => {} };

    on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(
      event: "close" | "error",
      listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
    ): void {
      if (event === "error") {
        queueMicrotask(() => {
          (listener as (error: Error) => void)(new Error("spawn ENOENT"));
        });
      }
    }

    kill(): boolean {
      return true;
    }
  }

  it("settles an emitted child error with the synthesized envelope", async () => {
    const answer = (await handleToolCall("project_list", {}, undefined, () => new FailingChild())) as {
      result?: { isError: boolean; structuredContent: { error: { code: string } } };
    };
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.structuredContent.error.code).toBe("INTERNAL_ERROR");
  });

  it("settles a synchronous spawn throw with the synthesized envelope", async () => {
    const answer = (await handleToolCall("project_list", {}, undefined, () => {
      throw new Error("spawn rejected the arguments");
    })) as { result?: { isError: boolean; structuredContent: { error: { code: string; message: string } } } };
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.structuredContent.error.code).toBe("INTERNAL_ERROR");
    expect(answer.result?.structuredContent.error.message).toContain("spawn threw");
  });
});

describe("parseTrailingEnvelope", () => {
  it("finds the trailing object across a multi-line pretty-printed envelope", () => {
    const parsed = parseTrailingEnvelope(`noise before\n${envelopeOf(true)}`);
    expect(parsed?.raw).toBe(envelopeOf(true));
    expect(parsed?.preceding).toBe("noise before\n");
  });

  it("returns undefined when no JSON object closes the stream", () => {
    expect(parseTrailingEnvelope("plain text only\n")).toBeUndefined();
    expect(parseTrailingEnvelope("")).toBeUndefined();
  });

  it("terminates on {}, a truncated object and a non-envelope object, settling each outcome", () => {
    // Before the fix, each of these looped forever when the brace at index 0
    // failed to parse as an envelope; the assertions only run because the
    // search now strictly progresses past index 0.
    expect(parseTrailingEnvelope("{}")).toBeUndefined();
    expect(parseTrailingEnvelope('{\\n  "ok":')).toBeUndefined();
    expect(parseTrailingEnvelope('{ "not": "an envelope" }')).toBeUndefined();
    for (const malformed of ["{}", '{\\n  "ok":', '{ "not": "an envelope" }']) {
      const built = buildChildResult({ status: 0, signal: null, stdout: malformed, stderr: "" });
      expect(built.kind).toBe("result");
      if (built.kind !== "result") return;
      expect(built.payload.isError).toBe(true);
      expect((built.payload.structuredContent as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
    }
  });
});
