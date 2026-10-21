import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

function normalize(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "sorage-channel-golden-"));
  const work = mkdtempSync(join(tmpdir(), "sorage-channel-golden-work-"));
  function run(args: string[], cwd = work) {
    const result = spawnSync("bun", [entry, ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: "5f0ac9a0-0000-4000-8000-0000000000cc" },
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  for (const args of [
    ["init", "--non-interactive"],
    ["project", "add", "--name", "Golden", "--slug", "golden", "--dir", work],
  ]) {
    const result = run(args);
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return {
    home,
    work,
    run,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

describe("Channel CLI additive contracts", () => {
  it("pins create, show, list, submit, messages, read, handle, and typed errors", () => {
    const f = fixture();
    try {
      const outputs: Record<string, unknown> = {};
      function capture(name: string, args: string[], status = 0) {
        const result = f.run([...args, "--json"]);
        expect(result.status, result.stderr).toBe(status);
        expect(status === 0 ? result.stderr : result.stdout).toBe("");
        outputs[name] = { status, envelope: JSON.parse(normalize(status === 0 ? result.stdout : result.stderr)) };
        return result;
      }

      const created = JSON.parse(
        capture("create", [
          "channel",
          "create",
          "--main-handle",
          "orchestrator",
          "--title",
          "Journey",
          "--idempotency-key",
          "create-key",
        ]).stdout,
      ) as {
        data: { channel: { id: string; mainParticipantId: string } };
      };
      const channelId = created.data.channel.id;
      const mainId = created.data.channel.mainParticipantId;
      capture("create-retained", [
        "channel",
        "create",
        "--main-handle",
        "orchestrator",
        "--title",
        "Journey",
        "--idempotency-key",
        "create-key",
      ]);
      const worker = JSON.parse(
        capture("participant-add", [
          "channel",
          "participant",
          "add",
          channelId,
          "--role",
          "worker",
          "--handle",
          "worker-a",
          "--native",
          "",
          "--as-participant",
          mainId,
        ]).stdout,
      ) as { data: { participant: { id: string } } };
      const workerId = worker.data.participant.id;
      capture("judge-add", [
        "channel",
        "participant",
        "add",
        channelId,
        "--role",
        "judge",
        "--handle",
        "judge-x",
        "--native",
        "ctx:node",
        "--as-participant",
        mainId,
      ]);
      const assignment = JSON.parse(
        capture("assignment-add", [
          "channel",
          "assignment",
          "add",
          channelId,
          "--label",
          "task",
          "--participant",
          workerId,
          "--as-participant",
          mainId,
        ]).stdout,
      ) as { data: { assignment: { id: string } } };
      capture("assignment-close", [
        "channel",
        "assignment",
        "close",
        channelId,
        assignment.data.assignment.id,
        "--as-participant",
        mainId,
      ]);
      capture("list", ["channel", "list"]);
      capture("show", ["channel", "show", channelId]);
      const submit = [
        "channel",
        "submit",
        channelId,
        "--as-participant",
        workerId,
        "--kind",
        "report",
        "--body",
        "Report body\r\nwith CRLF",
        "--context-session",
        "sess",
        "--context-node",
        "",
        "--assignment",
        assignment.data.assignment.id,
        "--idempotency-key",
        "submit-key",
      ];
      const message = JSON.parse(capture("submit", submit).stdout) as { data: { message: { id: string } } };
      const messageId = message.data.message.id;
      capture("messages-unhandled", ["channel", "messages", channelId]);
      capture("wait-pending", ["channel", "messages", channelId, "--wait", "--timeout", "0"]);
      capture("read", ["channel", "read", channelId, messageId]);
      capture(
        "handle-wrong-version",
        ["channel", "handle", channelId, messageId, "--expected-row-version", "2", "--as-participant", mainId],
        75,
      );
      capture(
        "forbidden-role",
        ["channel", "handle", channelId, messageId, "--expected-row-version", "1", "--as-participant", workerId],
        77,
      );
      capture("handle", [
        "channel",
        "handle",
        channelId,
        messageId,
        "--expected-row-version",
        "1",
        "--as-participant",
        mainId,
        "--note",
        "done",
      ]);
      capture(
        "handle-stale",
        ["channel", "handle", channelId, messageId, "--expected-row-version", "1", "--as-participant", mainId],
        75,
      );
      capture(
        "re-handle",
        ["channel", "handle", channelId, messageId, "--expected-row-version", "2", "--as-participant", mainId],
        64,
      );
      capture("messages-handled", ["channel", "messages", channelId, "--handled"]);
      capture(
        "messages-filter-participant-not-found",
        ["channel", "messages", channelId, "--participant", randomUUID()],
        66,
      );
      capture("wait-timeout", ["channel", "messages", channelId, "--wait", "--timeout", "0"]);
      capture("participant-deactivate", [
        "channel",
        "participant",
        "deactivate",
        channelId,
        workerId,
        "--as-participant",
        mainId,
      ]);
      capture("participant-deactivate-noop", [
        "channel",
        "participant",
        "deactivate",
        channelId,
        workerId,
        "--as-participant",
        mainId,
      ]);
      capture("not-found", ["channel", "show", randomUUID()], 66);
      capture("closed", ["channel", "close", channelId, "--as-participant", mainId]);
      capture(
        "submit-closed",
        ["channel", "submit", channelId, "--as-participant", workerId, "--kind", "report", "--body", "after close"],
        65,
      );
      capture("historical-replay", [...submit, "--replay-only"]);
      capture(
        "replay-unavailable",
        [
          "channel",
          "submit",
          channelId,
          "--as-participant",
          workerId,
          "--kind",
          "report",
          "--body",
          "x",
          "--idempotency-key",
          "missing-key",
          "--replay-only",
        ],
        75,
      );
      capture(
        "blank-body",
        ["channel", "submit", channelId, "--as-participant", workerId, "--kind", "report", "--body", "   "],
        64,
      );

      const path = fileURLToPath(new URL("./golden/channels.json", import.meta.url));
      const actual = `${JSON.stringify(outputs, null, 2)}\n`;
      if (process.env.SORAGE_UPDATE_GOLDENS === "1") writeFileSync(path, actual);
      expect(actual).toBe(readFileSync(path, "utf8"));
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("discovers the channel group and its commands in help and completion", () => {
    const f = fixture();
    try {
      const help = f.run(["channel", "--help"]);
      const completion = f.run(["completion", "zsh"]);
      expect(help.status).toBe(0);
      expect(completion.status).toBe(0);
      for (const name of [
        "create",
        "list",
        "show",
        "close",
        "participant",
        "assignment",
        "submit",
        "messages",
        "read",
        "handle",
      ]) {
        expect(help.stdout).toContain(name);
        expect(completion.stdout).toContain("channel");
      }
      const rootHelp = f.run(["--help"]);
      expect(rootHelp.status).toBe(0);
      expect(rootHelp.stdout).toContain("channel");
    } finally {
      f.cleanup();
    }
  });
});
