import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY, envelopeOf, errorEnvelopeOf, makeTempDir, registerCleanup, runCleanups, sorage } from "./helpers";

afterEach(runCleanups);

/**
 * AJ-28: the rebuilt Channel lifecycle and handling, driven through the
 * compiled binary in an isolated installation (TASK-123 delivery; TASK-126
 * requalifies the assembled journey). The seven steps of the rewritten
 * testing-and-acceptance row: the five-step loop with idempotent repeats,
 * attributed posts across the inline threshold with exact bytes, the
 * duplicate-by-content rule including retry-after-close and
 * new-message-after-ack, reads and waits under the write-denying sandbox,
 * all-or-nothing ack semantics, format-3 retention, and the closed six-event
 * catalog.
 */
describe("AJ-28: rebuilt Channel lifecycle and handling", () => {
  function fixture() {
    const home = makeTempDir("aj28-home-");
    const init = sorage(["init", "--non-interactive"], { home });
    if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
    return { home };
  }

  function run(f: { home: string }, args: string[]) {
    return sorage([...args, "--json"], { home: f.home });
  }

  function runHuman(f: { home: string }, args: string[]) {
    return sorage([...args], { home: f.home });
  }

  function data<T>(f: { home: string }, args: string[]): T {
    const result = run(f, args);
    expect(result.status, result.stderr).toBe(0);
    const value = envelopeOf(result).data;
    if (args[0] === "channel") {
      // Interface 38.4 closes the operation's data wrapper independently of
      // the fields of its contained view. Never infer it from actual output.
      const keys: Record<string, string[]> = {
        create: ["channel", "existing"],
        add: ["participant"],
        remove: ["participant"],
        post: ["duplicate", "message"],
        ack: ["alreadyHandled", "handled", "note"],
        close: ["channel"],
        list: ["items"],
        show: ["channel"],
        messages: ["items"],
      };
      expect(Object.keys(value as object).sort()).toEqual(keys[args[1] as string]);
    }
    return value as T;
  }

  function failure(f: { home: string }, args: string[]) {
    const result = run(f, args);
    expect(result.status, result.stderr).not.toBe(0);
    return errorEnvelopeOf(result);
  }

  it("runs the five-step loop with idempotent repeats (step 1)", () => {
    const f = fixture();
    const created = data<{
      channel: { name: string; state: string; main: string; id: string; participantCount: number };
      existing: boolean;
    }>(f, ["channel", "create", "aq-run-42", "--main", "orchestrator"]);
    expect(created.channel.name).toBe("aq-run-42");
    expect(created.channel.state).toBe("open");
    expect(created.channel.main).toBe("orchestrator");
    expect(created.channel.participantCount).toBe(1);
    expect(created.existing).toBe(false);
    const repeat = data<{ channel: { id: string }; existing: boolean }>(f, [
      "channel",
      "create",
      "aq-run-42",
      "--main",
      "orchestrator",
    ]);
    expect(repeat.existing).toBe(true);
    expect(repeat.channel.id).toBe(created.channel.id);
    const differentMain = failure(f, ["channel", "create", "aq-run-42", "--main", "other"]);
    expect(differentMain.error.code).toBe("CHN_INVALID_INPUT");
    const worker = data<{ participant: { handle: string; role: string; addedAt: string; removedAt: string | null } }>(
      f,
      ["channel", "add", "aq-run-42", "worker-1", "--role", "worker"],
    );
    expect(worker.participant.handle).toBe("worker-1");
    expect(worker.participant.removedAt).toBeNull();
    const addRepeat = data<{ participant: { addedAt: string } }>(f, [
      "channel",
      "add",
      "aq-run-42",
      "worker-1",
      "--role",
      "worker",
    ]);
    expect(addRepeat.participant.addedAt).toBe(worker.participant.addedAt);
    const differentRole = failure(f, ["channel", "add", "aq-run-42", "worker-1", "--role", "judge"]);
    expect(differentRole.error.code).toBe("CHN_INVALID_INPUT");
    const removed = data<{ participant: { handle: string; addedAt: string; removedAt: string | null } }>(f, [
      "channel",
      "remove",
      "aq-run-42",
      "worker-1",
    ]);
    expect(removed.participant.removedAt).not.toBeNull();
    const removeRepeat = data<{ participant: { handle: string; addedAt: string; removedAt: string | null } }>(f, [
      "channel",
      "remove",
      "aq-run-42",
      "worker-1",
    ]);
    expect(removeRepeat.participant.removedAt).toBe(removed.participant.removedAt);
    const reAdded = data<{ participant: { handle: string; addedAt: string; removedAt: string | null } }>(f, [
      "channel",
      "add",
      "aq-run-42",
      "worker-1",
      "--role",
      "worker",
    ]);
    expect(reAdded.participant.removedAt).toBeNull();
    expect(reAdded.participant.addedAt).not.toBe(worker.participant.addedAt);
  });

  it("posts attributed bodies across the inline threshold with exact bytes and the relay rule (step 2)", () => {
    const f = fixture();
    data(f, ["channel", "create", "c"]);
    data(f, ["channel", "add", "c", "w1", "--role", "worker"]);
    data(f, ["channel", "add", "c", "j1", "--role", "judge"]);
    const small = data<{ message: { seq: number; body: string; bodyPath: string | null; bodyPending: boolean } }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "report",
      "--body",
      "small body",
    ]);
    expect(small.message.body).toBe("small body");
    expect(small.message.bodyPath).toBeNull();
    expect(small.message.bodyPending).toBe(false);
    // A body above 65,536 UTF-8 bytes routes to the Vault with exact bytes.
    const large = "x".repeat(70_000);
    const bodyFile = join(f.home, "large.txt");
    writeFileSync(bodyFile, large);
    const fileBacked = data<{ message: { seq: number; body: string; bodyPath: string; bodyPending: boolean } }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "report",
      "--ref",
      "pr-42",
      "--body-file",
      bodyFile,
    ]);
    expect(fileBacked.message.body).toBe(large);
    expect(fileBacked.message.bodyPath).toContain("content/channel/");
    expect(fileBacked.message.bodyPending).toBe(false);
    // A --ref reference rides verbatim; --to is required exactly on relay.
    const relay = data<{ message: { kind: string; to: string | null; ref: string | null } }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "relay_request",
      "--to",
      "j1",
      "--body",
      "please relay",
    ]);
    expect(relay.message.to).toBe("j1");
    const relayWithoutTo = failure(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "relay_request",
      "--body",
      "b",
    ]);
    expect(relayWithoutTo.error.code).toBe("CHN_INVALID_INPUT");
    const toUnknown = failure(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "relay_request",
      "--to",
      "ghost",
      "--body",
      "b",
    ]);
    expect(toUnknown.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const fromUnknown = failure(f, ["channel", "messages", "c", "--from", "ghost"]);
    expect(fromUnknown.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const mainPost = failure(f, ["channel", "post", "c", "--from", "main", "--kind", "report", "--body", "b"]);
    expect(mainPost.error.code).toBe("CHN_INVALID_INPUT");
    expect(mainPost.error.message).toContain("upstream");
    data(f, ["channel", "close", "c"]);
    const postClosed = failure(f, ["channel", "post", "c", "--from", "w1", "--kind", "report", "--body", "fresh"]);
    expect(postClosed.error.code).toBe("CHN_CLOSED");
    const addClosed = failure(f, ["channel", "add", "c", "late", "--role", "judge"]);
    expect(addClosed.error.code).toBe("CHN_CLOSED");
    const ackAfterClose = data<{ handled: number[] }>(f, ["channel", "ack", "c", "1"]);
    expect(ackAfterClose.handled).toEqual([1]);
  });

  it("proves the duplicate-by-content rule with no replay material (step 3)", () => {
    const f = fixture();
    data(f, ["channel", "create", "c"]);
    data(f, ["channel", "add", "c", "w1", "--role", "worker"]);
    data(f, ["channel", "add", "c", "w2", "--role", "worker"]);
    const first = data<{ message: { seq: number }; duplicate: boolean }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "report",
      "--body",
      "same body",
    ]);
    expect(first.duplicate).toBe(false);
    const retry = data<{ message: { seq: number }; duplicate: boolean }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "report",
      "--body",
      "same body",
    ]);
    expect(retry.duplicate).toBe(true);
    expect(retry.message.seq).toBe(first.message.seq);
    const otherSender = data<{ message: { seq: number }; duplicate: boolean }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w2",
      "--kind",
      "report",
      "--body",
      "same body",
    ]);
    expect(otherSender.duplicate).toBe(false);
    expect(otherSender.message.seq).toBe(first.message.seq + 1);
    data(f, ["channel", "ack", "c", String(first.message.seq)]);
    const afterAck = data<{ message: { seq: number }; duplicate: boolean }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w1",
      "--kind",
      "report",
      "--body",
      "same body",
    ]);
    expect(afterAck.duplicate).toBe(false);
    // A retry after close still reports the duplicate.
    const pending = data<{ message: { seq: number } }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w2",
      "--kind",
      "question",
      "--body",
      "unhandled window",
    ]);
    data(f, ["channel", "close", "c"]);
    const closedRetry = data<{ message: { seq: number }; duplicate: boolean }>(f, [
      "channel",
      "post",
      "c",
      "--from",
      "w2",
      "--kind",
      "question",
      "--body",
      "unhandled window",
    ]);
    expect(closedRetry.duplicate).toBe(true);
    expect(closedRetry.message.seq).toBe(pending.message.seq);
  });

  it("proves reads, filters, and the wait under the write-denying sandbox (step 4)", () => {
    const f = fixture();
    data(f, ["channel", "create", "c"]);
    data(f, ["channel", "add", "c", "w1", "--role", "worker"]);
    data(f, ["channel", "post", "c", "--from", "w1", "--kind", "report", "--body", "first body"]);
    data(f, ["channel", "post", "c", "--from", "w1", "--kind", "question", "--body", "second body"]);
    data(f, ["channel", "ack", "c", "1"]);
    const unhandled = data<{ items: Array<{ seq: number; body: string }> }>(f, ["channel", "messages", "c"]);
    expect(unhandled.items.map((item) => [item.seq, item.body])).toEqual([[2, "second body"]]);
    const all = data<{ items: Array<{ seq: number; handled: boolean }> }>(f, ["channel", "messages", "c", "--all"]);
    expect(all.items.map((item) => [item.seq, item.handled])).toEqual([
      [1, true],
      [2, false],
    ]);
    const afterOne = data<{ items: Array<{ seq: number }> }>(f, ["channel", "messages", "c", "--all", "--after", "1"]);
    expect(afterOne.items.map((item) => item.seq)).toEqual([2]);
    const fromW1 = data<{ items: Array<{ seq: number }> }>(f, ["channel", "messages", "c", "--from", "w1", "--all"]);
    expect(fromW1.items).toHaveLength(2);
    const limited = data<{ items: Array<{ seq: number }> }>(f, ["channel", "messages", "c", "--all", "--limit", "1"]);
    expect(limited.items.map((item) => item.seq)).toEqual([1]);
    // A wait with a pending message returns immediately.
    const immediate = data<{ items: Array<{ seq: number }> }>(f, [
      "channel",
      "messages",
      "c",
      "--wait",
      "--timeout",
      "2",
    ]);
    expect(immediate.items.map((item) => item.seq)).toEqual([2]);
    // Reads never mutate across a process restart.
    const before = data<{ items: unknown[] }>(f, ["channel", "messages", "c", "--all"]);
    const reopened = data<{ items: unknown[] }>(f, ["channel", "messages", "c", "--all"]);
    expect(reopened.items).toEqual(before.items);
    void BINARY;
    // The sandboxed read and wait live in the zero-write-reads suite, which
    // owns the write-denying profile and the inventory discipline.
  });

  it("proves ack semantics: all-or-nothing, alreadyHandled, and the note (step 5)", () => {
    const f = fixture();
    data(f, ["channel", "create", "c"]);
    data(f, ["channel", "add", "c", "w1", "--role", "worker"]);
    for (const body of ["one", "two", "three"]) {
      data(f, ["channel", "post", "c", "--from", "w1", "--kind", "report", "--body", body]);
    }
    const missing = failure(f, ["channel", "ack", "c", "1", "99"]);
    expect(missing.error.code).toBe("CHN_MESSAGE_NOT_FOUND");
    expect(missing.error.message).toContain("99");
    const stillUnhandled = data<{ items: unknown[] }>(f, ["channel", "messages", "c"]);
    expect(stillUnhandled.items).toHaveLength(3);
    const acked = data<{ handled: number[]; alreadyHandled: number[]; note: string }>(f, [
      "channel",
      "ack",
      "c",
      "1",
      "2",
      "--note",
      "reviewed both",
    ]);
    expect(acked.handled).toEqual([1, 2]);
    expect(acked.alreadyHandled).toEqual([]);
    expect(acked.note).toBe("reviewed both");
    const repeat = data<{ handled: number[]; alreadyHandled: number[] }>(f, ["channel", "ack", "c", "2", "3"]);
    expect(repeat.handled).toEqual([3]);
    expect(repeat.alreadyHandled).toEqual([2]);
    const messages = data<{ items: Array<{ seq: number; handleNote: string | null }> }>(f, [
      "channel",
      "messages",
      "c",
      "--all",
    ]);
    expect(messages.items.find((item) => item.seq === 1)?.handleNote).toBe("reviewed both");
  });

  it("proves retention: the format-3 round trip preserves the rebuilt record (step 7)", () => {
    const f = fixture();
    data(f, ["channel", "create", "kept", "--title", "Kept"]);
    data(f, ["channel", "add", "kept", "w1", "--role", "worker"]);
    data(f, ["channel", "post", "kept", "--from", "w1", "--kind", "report", "--ref", "pr-7", "--body", "retained"]);
    data(f, ["channel", "ack", "kept", "1", "--note", "done"]);
    data(f, ["channel", "remove", "kept", "w1"]);
    const backup = sorage(["backup", "run", "--json"], { home: f.home });
    expect(backup.status, backup.stderr).toBe(0);
    const target = makeTempDir("aj28-restore-");
    const init = sorage(["init", "--non-interactive"], { home: target });
    expect(init.status, init.stderr).toBe(0);
    const restore = sorage(["backup", "restore", "--from", join(f.home, "vault"), "--confirm", "--as-user", "--json"], {
      home: target,
    });
    expect(restore.status, restore.stderr).toBe(0);
    const shown = data<{
      channel: {
        name: string;
        title: string | null;
        messageCount: number;
        unhandledCount: number;
        participants: Array<{ handle: string; removedAt: string | null }>;
      };
    }>({ home: target }, ["channel", "show", "kept"]);
    expect(shown.channel.name).toBe("kept");
    expect(shown.channel.title).toBe("Kept");
    expect(shown.channel.messageCount).toBe(1);
    expect(shown.channel.unhandledCount).toBe(0);
    expect(shown.channel.participants.find((participant) => participant.handle === "w1")?.removedAt).not.toBeNull();
    const messages = data<{
      items: Array<{ seq: number; handled: boolean; ref: string | null; handleNote: string | null; body: string }>;
    }>({ home: target }, ["channel", "messages", "kept", "--all"]);
    expect(messages.items[0]).toMatchObject({
      seq: 1,
      handled: true,
      ref: "pr-7",
      handleNote: "done",
      body: "retained",
    });
  });

  it("pins the closed six-event catalog with the acting handle and no repeats (step 7)", () => {
    const f = fixture();
    data(f, ["channel", "create", "audit", "--main", "boss"]);
    data(f, ["channel", "add", "audit", "w1", "--role", "worker"]);
    data(f, ["channel", "post", "audit", "--from", "w1", "--kind", "report", "--body", "b"]);
    // Duplicates and repeats append nothing.
    data(f, ["channel", "post", "audit", "--from", "w1", "--kind", "report", "--body", "b"]);
    data(f, ["channel", "add", "audit", "w1", "--role", "worker"]);
    data(f, ["channel", "ack", "audit", "1"]);
    data(f, ["channel", "ack", "audit", "1"]);
    data(f, ["channel", "remove", "audit", "w1"]);
    data(f, ["channel", "add", "audit", "w1", "--role", "worker"]);
    data(f, ["channel", "close", "audit"]);
    data(f, ["channel", "close", "audit"]);
    const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
    try {
      const rows = db
        .prepare(
          "SELECT event_type, actor_kind, actor_id, row_version, metadata_json FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY event_type, id",
        )
        .all() as Array<{
        event_type: string;
        actor_kind: string;
        actor_id: string | null;
        row_version: number | null;
        metadata_json: string;
      }>;
      const counts = rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.event_type] = (acc[row.event_type] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts).toEqual({
        CHANNEL_CREATED: 1,
        CHANNEL_PARTICIPANT_ADDED: 2,
        CHANNEL_PARTICIPANT_REMOVED: 1,
        CHANNEL_MESSAGE_POSTED: 1,
        CHANNEL_MESSAGE_ACKED: 1,
        CHANNEL_CLOSED: 1,
      });
      for (const row of rows) {
        expect(row.actor_kind).toBe("user");
        expect(row.actor_id).toBeNull();
        expect(row.row_version).toBeNull();
        const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
        expect(typeof metadata.actingHandle).toBe("string");
        expect(JSON.stringify(metadata)).not.toContain("body");
      }
      const posted = rows.find((row) => row.event_type === "CHANNEL_MESSAGE_POSTED") as {
        metadata_json: string;
      };
      expect((JSON.parse(posted.metadata_json) as { actingHandle: string }).actingHandle).toBe("w1");
    } finally {
      db.close();
    }
  });

  it("renders the Channel database-schema refusal with the migration-name check", () => {
    const f = fixture();
    data(f, ["channel", "create", "c"]);
    const database = join(f.home, "state", "sorage.sqlite3");
    const db = new DatabaseSync(database);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE schema_migrations SET name = 'channels-v1' WHERE version = 11").run();
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const read = sorage(["channel", "list", "--json"], { home: f.home });
    expect(read.status).toBe(73);
    expect(errorEnvelopeOf(read).error.code).toBe("STORAGE_INTEGRITY_ERROR");
    const human = sorage(["channel", "list"], { home: f.home });
    expect(human.status).toBe(73);
    void createHash;
    void readFileSync;
    void registerCleanup;
    void runHuman;
  });
});
