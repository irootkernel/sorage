import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memoCliFixture, cliData } from "../fixtures/memo-cli";

// Normalize only generated identities and instants; versions, flags and errors stay literal.
function normalize(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>");
}
describe("Memo CLI additive contracts", () => {
  it("pins receipts, details, summaries, historical replay and typed errors", () => {
    const f = memoCliFixture();
    try {
      const outputs: Record<string, unknown> = {};
      function capture(name: string, args: string[], status = 0) {
        const result = f.run([...args, "--json"]);
        expect(result.status, result.stderr).toBe(status);
        expect(status === 0 ? result.stderr : result.stdout).toBe("");
        outputs[name] = { status, envelope: JSON.parse(normalize(status === 0 ? result.stdout : result.stderr)) };
        return result;
      }
      const key = randomUUID();
      const add = ["memo", "add", "--title", "Reminder", "--body", "한글\r\nBody", "--idempotency-key", key];
      const memo = cliData(capture("add", add)).memo;
      capture("list", ["memo", "list"]);
      capture("show", ["memo", "show", memo.id]);
      capture("no-op", ["memo", "update", memo.id, "--title", "Reminder", "--expected-row-version", "1"]);
      capture("done", ["memo", "done", memo.id, "--expected-row-version", "1"]);
      capture("historical-replay", [...add, "--replay-only"]);
      capture("stale-version", ["memo", "done", memo.id, "--expected-row-version", "1"], 75);
      capture("closed-content", ["memo", "update", memo.id, "--body", "new", "--expected-row-version", "2"], 65);
      capture("missing-key", ["memo", "add", "--title", "Reminder", "--replay-only"], 64);
      capture(
        "unavailable",
        ["memo", "add", "--title", "Reminder", "--replay-only", "--idempotency-key", randomUUID()],
        75,
      );
      capture("unsafe-version", ["memo", "done", memo.id, "--expected-row-version", "9007199254740992"], 64);
      capture("file-read-failure", ["memo", "add", "--title", "Reminder", "--body-file", `${f.home}/missing`], 73);
      capture("not-found", ["memo", "show", randomUUID()], 66);
      capture("too-large", ["memo", "add", "--title", "Reminder", "--body", "x".repeat(65537)], 65);
      const path = fileURLToPath(new URL("./golden/memos.json", import.meta.url));
      const actual = `${JSON.stringify(outputs, null, 2)}\n`;
      if (process.env.SORAGE_UPDATE_GOLDENS === "1") writeFileSync(path, actual);
      expect(actual).toBe(readFileSync(path, "utf8"));
    } finally {
      f.cleanup();
    }
  }, 30_000);
  it("discovers the Memo group and seven commands in help and completion", () => {
    const f = memoCliFixture();
    try {
      const help = f.run(["memo", "--help"]);
      const completion = f.run(["completion", "zsh"]);
      expect(help.status).toBe(0);
      expect(completion.status).toBe(0);
      for (const name of ["add", "list", "show", "update", "done", "dismiss", "reopen"]) {
        expect(help.stdout).toContain(name);
        expect(completion.stdout).toContain(`memo ${name}:`);
      }
      expect(f.run(["memo", "update", "--help"]).stdout).toContain("--replay-only");
      expect(f.run(["memo", "list", "--help"]).stdout).not.toContain("--replay-only");
      expect(f.run(["completion", "bash"]).stdout).toContain("memo");
    } finally {
      f.cleanup();
    }
  });
});
