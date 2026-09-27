import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerMemoCommands } from "../../src/memo-commands";

describe("Memo CLI validation before opening storage", () => {
  it.each([
    ["add"],
    ["add", "--title", "Reminder", "--body", "", "--body-file", "not-read"],
    ["add", "--title", "Reminder", "--replay-only"],
    ["list", "--project", "alpha", "--all-projects"],
    ["show", "00000000-0000-4000-8000-000000000000", "--replay-only"],
    ["done", "00000000-0000-4000-8000-000000000000"],
  ])("rejects invalid input %j with no success output", (...args) => {
    const program = new Command();
    const out = vi.fn();
    const fail = vi.fn();
    registerMemoCommands(program, { out, fail, requestId: () => "unused" });
    program.parse(["memo", ...args], { from: "user" });
    expect(out).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "MEMO_INVALID_INPUT" }), false);
  });
});
