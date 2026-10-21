import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY, envelopeOf, errorEnvelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

afterEach(runCleanups);

/**
 * TASK-113 compiled coverage on the AJ-28 surface: a committed submit whose
 * file-backed activation cannot complete returns its message ID and summary
 * with `contentActivating` and a warning, the read-side failure carries the
 * state-accurate recovery, replay-only returns the same message, a wait
 * survives read-side materialization failures and reports only a failure that
 * persists at its deadline, a committed handle returns its decision with the
 * unavailable-preview indicator, and unknown filters fail immediately.
 */

function fixture() {
  const home = makeTempDir("aj28-results-home-");
  const work = makeTempDir("aj28-results-work-");
  const init = sorage(["init", "--non-interactive"], { home });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const created = run({ home }, ["channel", "create", "--main-handle", "orchestrator"]);
  expect(created.status, created.stderr).toBe(0);
  const channel = (envelopeOf(created) as { data: { channel: { id: string; mainParticipantId: string } } }).data
    .channel;
  const worker = run({ home }, [
    "channel",
    "participant",
    "add",
    channel.id,
    "--role",
    "worker",
    "--handle",
    "worker-a",
    "--as-participant",
    channel.mainParticipantId,
  ]);
  expect(worker.status, worker.stderr).toBe(0);
  const workerId = (envelopeOf(worker) as { data: { participant: { id: string } } }).data.participant.id;
  const bodyFile = join(home, "large-body.txt");
  writeFileSync(bodyFile, "compiled channel body\n".repeat(7000));
  return { home, work, channelId: channel.id, mainId: channel.mainParticipantId, workerId, bodyFile };
}

function run(f: { home: string }, args: string[]) {
  return sorage([...args, "--json"], { home: f.home });
}

function db(home: string): DatabaseSync {
  return new DatabaseSync(join(home, "state", "sorage.sqlite3"));
}

/**
 * The independent domain snapshot plan r3 section 7.6 requires around waits:
 * messages, their handling state, Channel events, and retained submission
 * receipts. `content_records` is deliberately outside the snapshot because the
 * fixture itself flips `materialized` to model the read-side failure; that
 * explicit change is asserted separately.
 */
function domainState(home: string): unknown {
  const inspection = db(home);
  try {
    return {
      messages: inspection
        .prepare(
          "SELECT id, channel_id, handled, handled_at, handled_by_participant_id, handled_by_kind, handle_note, processing_row_version, content_record_id, created_at FROM channel_messages ORDER BY id",
        )
        .all(),
      events: inspection
        .prepare(
          "SELECT id, event_type, actor_kind, actor_id, metadata_json, created_at FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY id",
        )
        .all(),
      receipts: inspection
        .prepare(
          "SELECT key, scope, request_hash, response_json, created_at, expires_at FROM idempotency_keys WHERE scope LIKE 'channel-submit:%' ORDER BY key",
        )
        .all(),
    };
  } finally {
    inspection.close();
  }
}

function contentMaterialized(home: string, contentId: string): number {
  const inspection = db(home);
  try {
    const row = inspection.prepare("SELECT materialized FROM content_records WHERE id = ?").get(contentId) as {
      materialized: number;
    };
    return row.materialized;
  } finally {
    inspection.close();
  }
}

function native(home: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(BINARY, [...args, "--json"], {
      env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: undefined },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const MATERIALIZING_MESSAGE =
  "The message itself is committed and needs no resubmission; its file-backed content has not activated yet";
const MATERIALIZING_RECOVERY =
  "Retry the read or wait after activation; the next process start retries the pending activation, and the message needs no resubmission";

describe("AJ-28 result semantics on the compiled binary", () => {
  it("returns the committed submit, exact read-side recovery, and a converged replay after a blocked activation", () => {
    const f = fixture();
    const content = join(f.home, "vault", "content");
    if (!existsSync(content)) mkdirSync(content, { recursive: true });
    let restored = false;
    try {
      chmodSync(content, 0o500);
      const submitted = run(f, [
        "channel",
        "submit",
        f.channelId,
        "--as-participant",
        f.workerId,
        "--kind",
        "report",
        "--body-file",
        f.bodyFile,
        "--idempotency-key",
        "compiled-blocked-activation",
      ]);
      expect(submitted.status, submitted.stderr).toBe(0);
      const data = (envelopeOf(submitted) as { data: { contentActivating: boolean } }).data;
      expect(Object.keys(data as object).sort()).toEqual(["contentActivating", "message", "replayed"]);
      expect(data.contentActivating).toBe(true);
      expect(submitted.stderr).toContain("the Channel message committed but its content activation failed");
      const message = (data as unknown as { message: { id: string } }).message;
      const read = run(f, ["channel", "read", f.channelId, message.id]);
      expect(read.status).toBe(75);
      const failure = errorEnvelopeOf(read);
      expect(failure.error.code).toBe("CONTENT_MATERIALIZING");
      expect(failure.error.message).toBe(MATERIALIZING_MESSAGE);
      expect((failure.error as unknown as { recovery?: { suggestedCommand: string } }).recovery?.suggestedCommand).toBe(
        MATERIALIZING_RECOVERY,
      );
      const replay = run(f, [
        "channel",
        "submit",
        f.channelId,
        "--as-participant",
        f.workerId,
        "--kind",
        "report",
        "--body-file",
        f.bodyFile,
        "--idempotency-key",
        "compiled-blocked-activation",
        "--replay-only",
      ]);
      expect(replay.status, replay.stderr).toBe(0);
      const replayed = (envelopeOf(replay) as { data: { contentActivating: boolean; message: { id: string } } }).data;
      expect(replayed.message.id).toBe(message.id);
      expect(replayed.contentActivating).toBe(true);
      const inspection = db(f.home);
      try {
        const rows = inspection
          .prepare(
            "SELECT m.id AS id, c.materialized AS materialized FROM channel_messages m JOIN content_records c ON c.id = m.content_record_id WHERE m.channel_id = ?",
          )
          .all(f.channelId) as Array<{ id: string; materialized: number }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(message.id);
        expect(rows[0]?.materialized).toBe(0);
        const events = inspection
          .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'CHANNEL_MESSAGE_SUBMITTED'")
          .get() as { count: number };
        expect(events.count).toBe(1);
      } finally {
        inspection.close();
      }
      chmodSync(content, 0o755);
      restored = true;
      // A later Channel command drains the retained intent.
      const converged = run(f, ["channel", "show", f.channelId]);
      expect(converged.status, converged.stderr).toBe(0);
      const settled = run(f, [
        "channel",
        "submit",
        f.channelId,
        "--as-participant",
        f.workerId,
        "--kind",
        "report",
        "--body-file",
        f.bodyFile,
        "--idempotency-key",
        "compiled-blocked-activation",
        "--replay-only",
      ]);
      expect(settled.status, settled.stderr).toBe(0);
      expect((envelopeOf(settled) as { data: { contentActivating: boolean } }).data.contentActivating).toBe(false);
    } finally {
      if (!restored) {
        try {
          chmodSync(content, 0o755);
        } catch {
          // Best-effort restore for cleanup.
        }
      }
    }
  });

  it("keeps a compiled wait polling across a read-side materialization failure and reports the persistent case", async () => {
    const f = fixture();
    const submitted = run(f, [
      "channel",
      "submit",
      f.channelId,
      "--as-participant",
      f.workerId,
      "--kind",
      "report",
      "--body-file",
      f.bodyFile,
      "--idempotency-key",
      "compiled-wait-arrival",
    ]);
    expect(submitted.status, submitted.stderr).toBe(0);
    const message = (envelopeOf(submitted) as { data: { message: { id: string } } }).data.message;
    const inspection = db(f.home);
    const row = inspection
      .prepare("SELECT content_record_id AS contentId FROM channel_messages WHERE id = ?")
      .get(message.id) as { contentId: string };
    // The named alternative injection for this compiled case: the record is
    // marked unmaterialized directly, so every poll's preview read reports the
    // real read-side CONTENT_MATERIALIZING until a second process flips it.
    inspection.prepare("UPDATE content_records SET materialized = 0 WHERE id = ?").run(row.contentId);
    try {
      const beforeRetried = domainState(f.home);
      const waiting = native(f.home, [
        "channel",
        "messages",
        f.channelId,
        "--wait",
        "--interval",
        "1",
        "--timeout",
        "8",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      inspection.prepare("UPDATE content_records SET materialized = 1 WHERE id = ?").run(row.contentId);
      const result = await waiting;
      expect(result.status, result.stderr).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        data: { items: Array<{ id: string }> };
        meta: { timedOut?: boolean };
      };
      expect(envelope.meta.timedOut).toBeUndefined();
      expect(envelope.data.items.map((item) => item.id)).toEqual([message.id]);
      // The retried wait changed no domain row; the only content-record change
      // is the fixture's own explicit repair, asserted here.
      expect(domainState(f.home)).toEqual(beforeRetried);
      expect(contentMaterialized(f.home, row.contentId)).toBe(1);

      inspection.prepare("UPDATE content_records SET materialized = 0 WHERE id = ?").run(row.contentId);
      const beforePersistent = domainState(f.home);
      const persistent = await native(f.home, [
        "channel",
        "messages",
        f.channelId,
        "--wait",
        "--interval",
        "1",
        "--timeout",
        "2",
      ]);
      expect(persistent.status).toBe(75);
      const failure = JSON.parse(persistent.stderr) as {
        error: { code: string; message: string; recovery?: { suggestedCommand: string } };
        meta: { timedOut?: boolean };
      };
      expect(failure.error.code).toBe("CONTENT_MATERIALIZING");
      expect(failure.error.message).toBe(MATERIALIZING_MESSAGE);
      expect(failure.error.recovery?.suggestedCommand).toBe(MATERIALIZING_RECOVERY);
      expect(failure.meta.timedOut).toBeUndefined();
      // The failing wait mutated nothing either, and the fixture's flag is
      // still the unmaterialized value it set before the wait.
      expect(domainState(f.home)).toEqual(beforePersistent);
      expect(contentMaterialized(f.home, row.contentId)).toBe(0);
      inspection.prepare("UPDATE content_records SET materialized = 1 WHERE id = ?").run(row.contentId);
    } finally {
      inspection.close();
    }
  });

  it("returns the committed handle decision with the unavailable-preview indicator", () => {
    const f = fixture();
    const submitted = run(f, [
      "channel",
      "submit",
      f.channelId,
      "--as-participant",
      f.workerId,
      "--kind",
      "report",
      "--body-file",
      f.bodyFile,
      "--idempotency-key",
      "compiled-handle-preview",
    ]);
    expect(submitted.status, submitted.stderr).toBe(0);
    const message = (envelopeOf(submitted) as { data: { message: { id: string } } }).data.message;
    const inspection = db(f.home);
    try {
      const row = inspection
        .prepare(
          "SELECT c.storage_key AS storageKey FROM channel_messages m JOIN content_records c ON c.id = m.content_record_id WHERE m.id = ?",
        )
        .get(message.id) as { storageKey: string | null };
      expect(row.storageKey).not.toBeNull();
      rmSync(join(f.home, "vault", row.storageKey as string), { force: true });
      const handled = run(f, [
        "channel",
        "handle",
        f.channelId,
        message.id,
        "--expected-row-version",
        "1",
        "--as-participant",
        f.mainId,
      ]);
      expect(handled.status, handled.stderr).toBe(0);
      const data = (envelopeOf(handled) as { data: { bodyPreviewUnavailable: boolean; message: { handled: boolean } } })
        .data;
      expect(Object.keys(data as object).sort()).toEqual(["bodyPreviewUnavailable", "message"]);
      expect(data.bodyPreviewUnavailable).toBe(true);
      expect(data.message.handled).toBe(true);
      const rows = inspection.prepare("SELECT handled FROM channel_messages WHERE id = ?").get(message.id) as {
        handled: number;
      };
      expect(rows.handled).toBe(1);
    } finally {
      inspection.close();
    }
  });

  it("fails unknown filters immediately and keeps the ordinary empty timeout at exit 0", () => {
    const f = fixture();
    const empty = run(f, ["channel", "create", "--main-handle", "empty-main"]);
    expect(empty.status, empty.stderr).toBe(0);
    const emptyChannel = (envelopeOf(empty) as { data: { channel: { id: string } } }).data.channel;
    const unknown = "99999999-9999-4999-8999-999999999999";
    const started = Date.now();
    const filtered = run(f, [
      "channel",
      "messages",
      emptyChannel.id,
      "--participant",
      unknown,
      "--wait",
      "--interval",
      "1",
      "--timeout",
      "30",
    ]);
    expect(filtered.status).toBe(66);
    expect(errorEnvelopeOf(filtered).error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    expect(Date.now() - started).toBeLessThan(5_000);
    const timeout = run(f, ["channel", "messages", emptyChannel.id, "--wait", "--interval", "1", "--timeout", "1"]);
    expect(timeout.status, timeout.stderr).toBe(0);
    const envelope = envelopeOf(timeout) as { data: { items: unknown[] }; meta: { timedOut?: boolean } };
    expect(envelope.data.items).toEqual([]);
    expect(envelope.meta.timedOut).toBe(true);
  });
});
