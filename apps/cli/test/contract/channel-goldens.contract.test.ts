import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
      timeout: 20_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  const result = run(["init", "--non-interactive"]);
  if (result.status !== 0) throw new Error(result.stderr);
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

describe("the rebuilt Channel CLI JSON contract (TASK-123, section 38.4)", () => {
  it("pins the nine commands' closed envelopes, the duplicate rule, and the typed errors", { timeout: 30_000 }, () => {
    const f = fixture();
    try {
      const outputs: Record<string, unknown> = {};
      function capture(name: string, args: string[], status = 0) {
        const result = f.run([...args, "--json"]);
        expect(result.status, `${name}: ${result.stderr}`).toBe(status);
        expect(status === 0 ? result.stderr : result.stdout).toBe("");
        outputs[name] = {
          status,
          envelope: JSON.parse(normalize(status === 0 ? result.stdout : result.stderr)),
        };
        return result;
      }

      capture("create", ["channel", "create", "aq-golden", "--title", "Golden", "--main", "orchestrator"]);
      capture("create-existing", ["channel", "create", "aq-golden", "--title", "Golden", "--main", "orchestrator"]);
      capture("create-different-main", ["channel", "create", "aq-golden", "--main", "other"], 64);
      capture("create-uuid-name", ["channel", "create", "10000000-0000-4000-8000-000000000001"], 64);
      capture("add", ["channel", "add", "aq-golden", "worker-1", "--role", "worker"]);
      capture("add-repeat", ["channel", "add", "aq-golden", "worker-1", "--role", "worker"]);
      capture("add-different-role", ["channel", "add", "aq-golden", "worker-1", "--role", "judge"], 64);
      capture("add-judge", ["channel", "add", "aq-golden", "judge-1", "--role", "judge"]);
      capture("post", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "report",
        "--ref",
        "pr-1",
        "--body",
        "first report body",
      ]);
      capture("post-duplicate", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "report",
        "--ref",
        "pr-1",
        "--body",
        "first report body",
      ]);
      capture("post-duplicate-no-ref", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "report",
        "--body",
        "plain retry body",
      ]);
      capture("post-duplicate-no-ref-retry", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "report",
        "--body",
        "plain retry body",
      ]);
      capture("post-relay", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "relay_request",
        "--to",
        "judge-1",
        "--body",
        "please relay",
      ]);
      capture("post-relay-duplicate", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "relay_request",
        "--to",
        "judge-1",
        "--body",
        "please relay",
      ]);
      capture(
        "post-relay-missing-to",
        ["channel", "post", "aq-golden", "--from", "worker-1", "--kind", "relay_request", "--body", "no target"],
        64,
      );
      capture(
        "post-to-unknown",
        [
          "channel",
          "post",
          "aq-golden",
          "--from",
          "worker-1",
          "--kind",
          "relay_request",
          "--to",
          "ghost",
          "--body",
          "b",
        ],
        66,
      );
      capture(
        "post-from-main",
        ["channel", "post", "aq-golden", "--from", "orchestrator", "--kind", "report", "--body", "b"],
        64,
      );
      const removed = capture("remove", ["channel", "remove", "aq-golden", "judge-1"]);
      void removed;
      capture("remove-repeat", ["channel", "remove", "aq-golden", "judge-1"]);
      capture(
        "post-from-removed",
        ["channel", "post", "aq-golden", "--from", "judge-1", "--kind", "report", "--body", "removed sender"],
        66,
      );
      capture("readd", ["channel", "add", "aq-golden", "judge-1", "--role", "judge"]);
      capture("messages", ["channel", "messages", "aq-golden"]);
      capture("ack", ["channel", "ack", "aq-golden", "1", "--note", "reviewed"]);
      capture("ack-already-handled", ["channel", "ack", "aq-golden", "1"]);
      capture("ack-unknown-seq", ["channel", "ack", "aq-golden", "1", "99"], 66);
      capture("post-after-ack", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "report",
        "--ref",
        "pr-1",
        "--body",
        "first report body",
      ]);
      capture("messages-all", ["channel", "messages", "aq-golden", "--all"]);
      capture("messages-after", ["channel", "messages", "aq-golden", "--all", "--after", "2"]);
      capture("messages-from-unknown", ["channel", "messages", "aq-golden", "--from", "ghost"], 66);
      capture("close", ["channel", "close", "aq-golden"]);
      capture("close-repeat", ["channel", "close", "aq-golden"]);
      capture(
        "post-closed",
        ["channel", "post", "aq-golden", "--from", "worker-1", "--kind", "report", "--body", "never posted before"],
        65,
      );
      capture("post-duplicate-after-close", [
        "channel",
        "post",
        "aq-golden",
        "--from",
        "worker-1",
        "--kind",
        "report",
        "--body",
        "plain retry body",
      ]);
      capture("add-closed", ["channel", "add", "aq-golden", "late", "--role", "judge"], 65);
      capture("create-closed-name", ["channel", "create", "aq-golden"], 65);
      capture("ack-after-close", ["channel", "ack", "aq-golden", "4"]);
      capture("list", ["channel", "list"]);
      capture("list-state", ["channel", "list", "--state", "closed"]);
      capture("show", ["channel", "show", "aq-golden"]);
      capture("not-found", ["channel", "show", "ghost"], 66);
      capture(
        "blank-body",
        ["channel", "post", "aq-golden", "--from", "worker-1", "--kind", "report", "--body", "   "],
        64,
      );

      // TASK-119 (V8) on the rebuilt surface: the write-protected refusal is
      // created inside this harness's own fixture by write-protecting its
      // database and WAL; the saved modes are restored before cleanup.
      const databasePath = join(f.home, "state", "sorage.sqlite3");
      const walPath = `${databasePath}-wal`;
      const savedMode = statSync(databasePath).mode & 0o777;
      const walSavedMode = existsSync(walPath) ? statSync(walPath).mode & 0o777 : undefined;
      chmodSync(databasePath, 0o444);
      if (walSavedMode !== undefined) chmodSync(walPath, 0o444);
      try {
        capture("storage-write-protected", ["channel", "create", "refused"], 75);
      } finally {
        chmodSync(databasePath, savedMode);
        if (walSavedMode !== undefined) chmodSync(walPath, walSavedMode);
      }

      const path = fileURLToPath(new URL("./golden/channels.json", import.meta.url));
      const actual = `${JSON.stringify(outputs, null, 2)}\n`;
      if (process.env.SORAGE_UPDATE_GOLDENS === "1") writeFileSync(path, actual);
      expect(actual).toBe(readFileSync(path, "utf8"));

      // The duplicate rule: the pinned envelopes answer duplicate: true with
      // the original sequence number, never a second message.
      const duplicate = outputs["post-duplicate"] as {
        status: number;
        envelope: { data: { message: { seq: number }; duplicate: boolean } };
      };
      expect(duplicate.status).toBe(0);
      expect(duplicate.envelope.data.duplicate).toBe(true);
      const fresh = outputs.post as { envelope: { data: { message: { seq: number }; duplicate: boolean } } };
      expect(duplicate.envelope.data.message.seq).toBe(fresh.envelope.data.message.seq);
      expect(fresh.envelope.data.duplicate).toBe(false);
      const afterAck = outputs["post-after-ack"] as {
        envelope: { data: { message: { seq: number }; duplicate: boolean } };
      };
      expect(afterAck.envelope.data.duplicate).toBe(false);
      expect(afterAck.envelope.data.message.seq).toBeGreaterThan(fresh.envelope.data.message.seq);

      // The removed-machinery vocabulary never returns in any pinned output.
      const serialized = JSON.stringify(outputs);
      for (const forbidden of [
        "idempotency",
        "replay",
        "as-participant",
        "expectedRowVersion",
        "processingRowVersion",
        "assignment",
        "nativeProvenance",
        "contentActivating",
        "bodyPreviewUnavailable",
        "mainParticipantId",
      ]) {
        expect(serialized.includes(forbidden), forbidden).toBe(false);
      }
    } finally {
      f.cleanup();
    }
  });
});
