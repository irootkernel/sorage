import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY, makeTempDir, runCleanups, sorage, envelopeOf, errorEnvelopeOf } from "./helpers";

afterEach(runCleanups);

/**
 * AJ-28: Channel lifecycle and main-side processing, all 8 steps of
 * docs/specs/testing-and-acceptance.md, driven through the compiled binary in
 * an isolated installation. The journey covers creation, registration,
 * assignments, submissions across the inline threshold with exact bytes,
 * pending-inclusive waiting, handling with conflict control, replay-only
 * recovery, closure, cross-Channel confidentiality, and the event catalog.
 */
describe("AJ-28: Channel lifecycle and main-side processing", () => {
  function fixture() {
    const home = makeTempDir("aj28-home-");
    const init = sorage(["init", "--non-interactive"], { home });
    if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
    return { home };
  }

  function run(f: { home: string }, args: string[]) {
    return sorage([...args, "--json"], { home: f.home });
  }

  function data<T>(f: { home: string }, args: string[]): T {
    const result = run(f, args);
    expect(result.status, result.stderr).toBe(0);
    const value = envelopeOf(result).data;
    if (args[0] === "channel") {
      // Interface 38.4 closes the operation's data wrapper independently of
      // the fields of its contained view. Never infer it from actual output.
      const keys: Record<string, string[]> = {
        create: ["channel"],
        show: ["channel"],
        close: ["channel"],
        participant: ["participant"],
        assignment: ["assignment"],
        read: ["message"],
        handle: ["message"],
        submit: ["message", "replayed"],
        list: ["items", "nextCursor"],
        messages: ["items", "nextCursor"],
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

  interface ChannelView {
    id: string;
    title: string | null;
    state: string;
    creatorKind: string;
    mainParticipantId: string;
    participantCount: number;
    messageCount: number;
    unhandledCount: number;
    participants: Array<{ id: string; role: string; handle: string; active: boolean; nativeProvenance: string[] }>;
    assignments: Array<{ id: string; state: string; label: string }>;
  }

  interface MessageSummary {
    id: string;
    channelId: string;
    kind: string;
    senderParticipantId: string;
    senderHandle: string;
    assignmentId: string | null;
    assignmentLate: boolean;
    relayToParticipantId: string | null;
    contextSession: string | null;
    contextNode: string | null;
    contextAttempt: string | null;
    handled: boolean;
    handledAt: string | null;
    handleNote: string | null;
    processingRowVersion: number;
    createdAt: string;
    bodyBytes: number;
    bodyPreview: string;
    bodyPreviewTruncated: boolean;
  }

  interface MessageDetail extends MessageSummary {
    body: string;
  }

  it("covers all 8 AJ-28 steps through the compiled CLI", () => {
    const f = fixture();

    // Step 1: Create a Channel, register main plus Worker and Judge,
    // register and close assignments. Exactly one main; main cannot be
    // deactivated; handle and bound violations fail; duplicate handle fails.
    const created = data<{ channel: ChannelView }>(f, [
      "channel",
      "create",
      "--main-handle",
      "orchestrator",
      "--title",
      "AJ-28 run",
    ]);
    const channelId = created.channel.id;
    const mainId = created.channel.mainParticipantId;
    expect(created.channel.state).toBe("open");
    expect(created.channel.participants).toHaveLength(1);
    expect(created.channel.participants[0]?.role).toBe("main");

    const worker = data<{ participant: { id: string; handle: string } }>(f, [
      "channel",
      "participant",
      "add",
      channelId,
      "--role",
      "worker",
      "--handle",
      "worker-a",
      "--as-participant",
      mainId,
    ]).participant;
    const workerId = worker.id;
    const judge = data<{ participant: { id: string; handle: string; nativeProvenance: string[] } }>(f, [
      "channel",
      "participant",
      "add",
      channelId,
      "--role",
      "judge",
      "--handle",
      "judge-x",
      "--native",
      "podway:node-9",
      "--as-participant",
      mainId,
    ]).participant;
    const judgeId = judge.id;
    expect(judge.nativeProvenance).toEqual(["podway:node-9"]);

    const dupHandle = failure(f, [
      "channel",
      "participant",
      "add",
      channelId,
      "--role",
      "worker",
      "--handle",
      "worker-a",
      "--as-participant",
      mainId,
    ]);
    expect(dupHandle.error.code).toBe("CHN_INVALID_INPUT");

    const mainDeactivate = failure(f, [
      "channel",
      "participant",
      "deactivate",
      channelId,
      mainId,
      "--as-participant",
      mainId,
    ]);
    expect(mainDeactivate.error.code).toBe("CHN_INVALID_INPUT");

    const assignment = data<{ assignment: { id: string; state: string } }>(f, [
      "channel",
      "assignment",
      "add",
      channelId,
      "--label",
      "lint pass",
      "--participant",
      workerId,
      "--as-participant",
      mainId,
    ]).assignment;
    expect(assignment.state).toBe("open");
    const closedAssignment = data<{ assignment: { id: string; state: string } }>(f, [
      "channel",
      "assignment",
      "close",
      channelId,
      assignment.id,
      "--as-participant",
      mainId,
    ]).assignment;
    expect(closedAssignment.state).toBe("closed");

    // Step 2: Submit attributed reports, questions, and relay requests with
    // text bodies across the inline threshold; exact bytes; verbatim context;
    // closed assignment -> late; inactive participant and closed Channel fail.
    const smallBody = "small report with \u00e9 and CRLF\r\nlines";
    const smallReport = data<{ message: MessageSummary; replayed: boolean }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      workerId,
      "--kind",
      "report",
      "--body",
      smallBody,
      "--context-session",
      "sess-1",
      "--context-node",
      "node-1",
      "--context-attempt",
      "attempt-1",
      "--idempotency-key",
      "aj28-small-key",
    ]);
    expect(smallReport.replayed).toBe(false);
    expect(smallReport.message.bodyBytes).toBe(Buffer.byteLength(smallBody, "utf8"));
    expect(smallReport.message.contextSession).toBe("sess-1");

    // Late report against a closed assignment.
    const lateReport = data<{ message: MessageSummary; replayed: boolean }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      workerId,
      "--kind",
      "report",
      "--body",
      "late report",
      "--assignment",
      assignment.id,
    ]);
    expect(lateReport.message.assignmentLate).toBe(true);

    // Large body above 65,536 UTF-8 bytes.
    const largeBody = `${"large report line\n".repeat(6600)}tail-\u00e9`;
    const largeFile = join(f.home, "large-body.md");
    writeFileSync(largeFile, largeBody, "utf8");
    const largeReport = data<{ message: MessageSummary; replayed: boolean }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      workerId,
      "--kind",
      "report",
      "--body-file",
      largeFile,
    ]);
    expect(largeReport.message.bodyBytes).toBeGreaterThan(65_536);
    expect(largeReport.message.bodyPreviewTruncated).toBe(true);

    // Relay request with target.
    const relay = data<{ message: MessageSummary; replayed: boolean }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      workerId,
      "--kind",
      "relay_request",
      "--body",
      "please relay to judge",
      "--relay-to",
      judgeId,
    ]);
    expect(relay.message.relayToParticipantId).toBe(judgeId);

    // Question from judge.
    const question = data<{ message: MessageSummary; replayed: boolean }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      judgeId,
      "--kind",
      "question",
      "--body",
      "should we proceed?",
    ]);

    // Exact byte read.
    const smallDetail = data<{ message: MessageDetail }>(f, [
      "channel",
      "read",
      channelId,
      smallReport.message.id,
    ]).message;
    expect(smallDetail.body).toBe(smallBody);
    const largeDetail = data<{ message: MessageDetail }>(f, [
      "channel",
      "read",
      channelId,
      largeReport.message.id,
    ]).message;
    expect(largeDetail.body).toBe(largeBody);

    // Inactive participant fails.
    const deactivated = data<{ participant: { id: string } }>(f, [
      "channel",
      "participant",
      "deactivate",
      channelId,
      workerId,
      "--as-participant",
      mainId,
    ]).participant;
    void deactivated;
    const inactiveSubmit = failure(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      workerId,
      "--kind",
      "report",
      "--body",
      "from inactive worker",
    ]);
    expect(inactiveSubmit.error.code).toBe("CHN_PARTICIPANT_INACTIVE");

    // Unknown participant fails.
    const unknownSubmit = failure(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      randomUUID(),
      "--kind",
      "report",
      "--body",
      "from unknown",
    ]);
    expect(unknownSubmit.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");

    // Step 3: Reads never mutate. Listing with filters, previews, cursor.
    const unhandledPage = data<{ items: MessageSummary[]; nextCursor: string | null }>(f, [
      "channel",
      "messages",
      channelId,
      "--unhandled",
      "--limit",
      "2",
    ]);
    expect(unhandledPage.items).toHaveLength(2);
    expect(unhandledPage.nextCursor).toBeTruthy();
    const unhandledBefore = unhandledPage.items.map((m) => m.handled);
    expect(unhandledBefore.every((h) => h === false)).toBe(true);

    // Step 4: Wait with unhandled messages already present.
    const waitImmediate = sorage(["channel", "messages", channelId, "--wait", "--timeout", "5", "--json"], {
      home: f.home,
    });
    expect(waitImmediate.status).toBe(0);
    const waitData = envelopeOf(waitImmediate).data as { items: MessageSummary[] };
    expect(waitData.items.length).toBeGreaterThan(0);

    // Wait timeout with no unhandled matches after handling.
    for (const msg of [smallReport, lateReport, largeReport, relay, question]) {
      sorage(
        [
          "channel",
          "handle",
          channelId,
          msg.message.id,
          "--expected-row-version",
          "1",
          "--as-participant",
          mainId,
          "--json",
        ],
        { home: f.home },
      );
    }
    const waitTimeout = sorage(["channel", "messages", channelId, "--wait", "--timeout", "0", "--json"], {
      home: f.home,
    });
    expect(waitTimeout.status).toBe(0);
    const timeoutEnvelope = envelopeOf(waitTimeout);
    expect(timeoutEnvelope.meta).toMatchObject({ timedOut: true });

    // Wait usage errors.
    const waitCursor = sorage(["channel", "messages", channelId, "--wait", "--cursor", "x", "--json"], {
      home: f.home,
    });
    expect(waitCursor.status).toBe(2);
    const waitSubInterval = sorage(["channel", "messages", channelId, "--wait", "--interval", "0", "--json"], {
      home: f.home,
    });
    expect(waitSubInterval.status).toBe(2);

    // Step 5: Process with conflict control. First handle wins; duplicates fail.
    const newReport = data<{ message: MessageSummary }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      judgeId,
      "--kind",
      "report",
      "--body",
      "handle me",
    ]);
    // Reactivate worker for later steps.
    // (No reactivation in M9; judge submits instead.)

    const firstHandle = data<{ message: MessageSummary }>(f, [
      "channel",
      "handle",
      channelId,
      newReport.message.id,
      "--expected-row-version",
      "1",
      "--as-participant",
      mainId,
      "--note",
      "first decision",
    ]).message;
    expect(firstHandle.handled).toBe(true);
    expect(firstHandle.handleNote).toBe("first decision");
    expect(firstHandle.processingRowVersion).toBe(2);

    const staleVersion = failure(f, [
      "channel",
      "handle",
      channelId,
      newReport.message.id,
      "--expected-row-version",
      "1",
      "--as-participant",
      mainId,
    ]);
    expect(staleVersion.error.code).toBe("ROW_VERSION_CONFLICT");

    const currentVersion = failure(f, [
      "channel",
      "handle",
      channelId,
      newReport.message.id,
      "--expected-row-version",
      "2",
      "--as-participant",
      mainId,
      "--note",
      "second",
    ]);
    expect(currentVersion.error.code).toBe("CHN_INVALID_INPUT");
    expect(currentVersion.error.message).toContain("first handling decision is immutable");

    // Non-main actor fails.
    const nonMain = failure(f, [
      "channel",
      "handle",
      channelId,
      newReport.message.id,
      "--expected-row-version",
      "1",
      "--as-participant",
      judgeId,
    ]);
    expect(nonMain.error.code).toBe("CHN_FORBIDDEN_ROLE");

    // Restart preservation: read the handled message after a "restart" (new CLI
    // process, same home).
    const afterRestart = data<{ message: MessageDetail }>(f, [
      "channel",
      "read",
      channelId,
      newReport.message.id,
    ]).message;
    expect(afterRestart.handled).toBe(true);
    expect(afterRestart.handleNote).toBe("first decision");

    // Step 6: Recover an outcome-unknown submission with replay-only.
    const recoveryBody = "recovery test body";
    const recoveryKey = "aj28-recovery-key";
    data<{ message: MessageSummary }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      judgeId,
      "--kind",
      "report",
      "--body",
      recoveryBody,
      "--idempotency-key",
      recoveryKey,
    ]);
    const replay = data<{ message: MessageSummary; replayed: boolean }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      judgeId,
      "--kind",
      "report",
      "--body",
      recoveryBody,
      "--idempotency-key",
      recoveryKey,
      "--replay-only",
    ]);
    expect(replay.replayed).toBe(true);
    const changedReplay = failure(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      judgeId,
      "--kind",
      "report",
      "--body",
      "different body",
      "--idempotency-key",
      recoveryKey,
      "--replay-only",
    ]);
    expect(changedReplay.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const missingKey = failure(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      judgeId,
      "--kind",
      "report",
      "--body",
      recoveryBody,
      "--idempotency-key",
      "never-used-key",
      "--replay-only",
    ]);
    expect(missingKey.error.code).toBe("CHN_REPLAY_UNAVAILABLE");

    // Step 7: Close the Channel. Submissions freeze; reads and processing stay.
    const closed = data<{ channel: ChannelView }>(f, [
      "channel",
      "close",
      channelId,
      "--as-participant",
      mainId,
    ]).channel;
    expect(closed.state).toBe("closed");

    const closedSubmit = failure(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      judgeId,
      "--kind",
      "report",
      "--body",
      "after close",
    ]);
    expect(closedSubmit.error.code).toBe("CHN_CLOSED");

    const stillReads = data<{ items: MessageSummary[] }>(f, ["channel", "messages", channelId, "--all"]);
    expect(stillReads.items.length).toBeGreaterThan(0);

    // Closed Channel retains existing message processing.
    const stillHandles = data<{ message: MessageSummary }>(f, [
      "channel",
      "handle",
      channelId,
      replay.message.id,
      "--expected-row-version",
      "1",
      "--as-participant",
      mainId,
    ]).message;
    expect(stillHandles.handled).toBe(true);

    // Cross-Channel isolation: an unrelated Channel's operations never disclose
    // this Channel's messages.
    const otherChannel = data<{ channel: ChannelView }>(f, ["channel", "create", "--main-handle", "other-main"]);
    const crossRead = failure(f, ["channel", "read", otherChannel.channel.id, smallReport.message.id]);
    expect(crossRead.error.code).toBe("CHN_MESSAGE_NOT_FOUND");

    // Step 8: Event catalog. Verify the exact event types and closed metadata.
    const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
    try {
      const events = db
        .prepare(
          "SELECT event_type, metadata_json FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY created_at, id",
        )
        .all() as Array<{ event_type: string; metadata_json: string }>;
      const types = events.map((e) => e.event_type);
      expect(types).toContain("CHANNEL_CREATED");
      expect(types).toContain("CHANNEL_CLOSED");
      expect(types).toContain("CHANNEL_PARTICIPANT_REGISTERED");
      expect(types).toContain("CHANNEL_PARTICIPANT_DEACTIVATED");
      expect(types).toContain("CHANNEL_ASSIGNMENT_CREATED");
      expect(types).toContain("CHANNEL_ASSIGNMENT_CLOSED");
      expect(types).toContain("CHANNEL_MESSAGE_SUBMITTED");
      expect(types).toContain("CHANNEL_MESSAGE_HANDLED");

      const created1 = events.find((e) => e.event_type === "CHANNEL_CREATED");
      expect(created1).toBeTruthy();
      const meta1 = JSON.parse(created1?.metadata_json ?? "{}") as Record<string, unknown>;
      expect(Object.keys(meta1).sort()).toEqual(["channelId", "mainParticipantId"]);
      expect(meta1.mainParticipantId).toBe(mainId);

      const submitted = events.find((e) => e.event_type === "CHANNEL_MESSAGE_SUBMITTED");
      expect(submitted).toBeTruthy();
      const metaSub = JSON.parse(submitted?.metadata_json ?? "{}") as Record<string, unknown>;
      expect(metaSub.processingRowVersion).toBe(1);
      expect(metaSub.channelId).toBe(channelId);

      const handled = events.find((e) => e.event_type === "CHANNEL_MESSAGE_HANDLED");
      expect(handled).toBeTruthy();
      const metaH = JSON.parse(handled?.metadata_json ?? "{}") as Record<string, unknown>;
      expect(metaH.processingRowVersion).toBe(2);

      // No body/handle/note/context leaked into event metadata.
      for (const e of events) {
        const meta = JSON.parse(e.metadata_json) as Record<string, unknown>;
        const metaStr = JSON.stringify(meta);
        expect(metaStr).not.toContain(smallBody);
        expect(metaStr).not.toContain("first decision");
        expect(metaStr).not.toContain("sess-1");
      }

      // Operational receipts exist for normal operations but are excluded from
      // restore (tested by the snapshot suites).
      const receipts = db.prepare("SELECT COUNT(*) as n FROM idempotency_keys").get() as { n: number };
      expect(receipts.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("waits for an arrival without handling and arbitrates concurrent native handling", async () => {
    const f = fixture();
    const channel = data<{ channel: ChannelView }>(f, ["channel", "create", "--main-handle", "main"]).channel;
    const worker = data<{ participant: { id: string } }>(f, [
      "channel",
      "participant",
      "add",
      channel.id,
      "--role",
      "worker",
      "--handle",
      "worker",
      "--as-participant",
      channel.mainParticipantId,
    ]).participant;
    const submit = (body: string) =>
      data<{ message: MessageSummary }>(f, [
        "channel",
        "submit",
        channel.id,
        "--as-participant",
        worker.id,
        "--kind",
        "report",
        "--body",
        body,
      ]).message;
    const initial = [submit("first"), submit("second")];
    function domainState() {
      const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
      try {
        return {
          messages: db.prepare("SELECT * FROM channel_messages ORDER BY id").all(),
          events: db.prepare("SELECT * FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY id").all(),
        };
      } finally {
        db.close();
      }
    }
    const before = domainState();
    const page = data<{ items: MessageSummary[]; nextCursor: string }>(f, [
      "channel",
      "messages",
      channel.id,
      "--wait",
      "--timeout",
      "0",
      "--limit",
      "1",
    ]);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = data<{ items: MessageSummary[]; nextCursor: null }>(f, [
      "channel",
      "messages",
      channel.id,
      "--limit",
      "1",
      "--cursor",
      page.nextCursor,
    ]);
    expect(next.items).toHaveLength(1);
    expect(new Set([...page.items, ...next.items].map((message) => message.id))).toEqual(
      new Set(initial.map((message) => message.id)),
    );
    expect(next.nextCursor).toBeNull();
    expect(domainState()).toEqual(before);
    const handle = (id: string, note: string) => [
      "channel",
      "handle",
      channel.id,
      id,
      "--as-participant",
      channel.mainParticipantId,
      "--expected-row-version",
      "1",
      "--note",
      note,
    ];
    for (const message of initial) data<MessageSummary>(f, handle(message.id, "initial review"));
    function native(args: string[]) {
      return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(BINARY, [...args, "--json"], {
          env: { ...process.env, SORAGE_HOME: f.home, SORAGE_TEST_REQUEST_ID: undefined },
          timeout: 10_000,
        });
        let stdout = "",
          stderr = "";
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
    const waiting = native([
      "channel",
      "messages",
      channel.id,
      "--wait",
      "--interval",
      "1",
      "--timeout",
      "5",
      "--limit",
      "1",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const arrival = submit("arrived while the consumer was waiting");
    const afterSubmit = domainState();
    const waited = await waiting;
    expect(waited.status, waited.stderr).toBe(0);
    expect((envelopeOf(waited).data as { items: MessageSummary[] }).items.map((message) => message.id)).toEqual([
      arrival.id,
    ]);
    expect(domainState()).toEqual(afterSubmit);
    const outcomes = await Promise.all([
      native(handle(arrival.id, "decision A")),
      native(handle(arrival.id, "decision B")),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([0, 75]);
    const winner = outcomes.find((outcome) => outcome.status === 0);
    const loser = outcomes.find((outcome) => outcome.status === 75);
    if (winner === undefined || loser === undefined) throw new Error("expected exactly one native handling winner");
    expect(errorEnvelopeOf(loser).error.code).toBe("ROW_VERSION_CONFLICT");
    const recorded = data<{ message: MessageDetail }>(f, ["channel", "read", channel.id, arrival.id]).message;
    expect(recorded.handleNote).toBe((envelopeOf(winner).data as { message: MessageSummary }).message.handleNote);
    expect(recorded.processingRowVersion).toBe(2);
    expect(domainState().events).toHaveLength(afterSubmit.events.length + 1);
  });

  it("preserves BOM and exact bytes through native backup, restore, and reopen", () => {
    const f = fixture();
    // Initialize with Git backup so backup run produces a snapshot tree.
    const reinit = sorage(["init", "--non-interactive", "--initialize-git", "--reconfigure"], { home: f.home });
    expect(reinit.status, reinit.stderr).toBe(0);

    const created = data<{ channel: ChannelView }>(f, ["channel", "create", "--main-handle", "\uFEFFmain"]);
    const channelId = created.channel.id;
    const mainId = created.channel.mainParticipantId;

    const worker = data<{ participant: { id: string } }>(f, [
      "channel",
      "participant",
      "add",
      channelId,
      "--role",
      "worker",
      "--handle",
      "\uFEFFworker",
      "--native",
      "\uFEFFnative-provenance",
      "--as-participant",
      mainId,
    ]).participant;

    // Inline body with BOM, CRLF, Unicode, and no final newline.
    const bomBody = "\uFEFFBOM body with CRLF\r\nand \u00e9\u3042\uD83D\uDE00 no final newline";
    const message = data<{ message: MessageSummary }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      worker.id,
      "--kind",
      "report",
      "--body",
      bomBody,
      "--idempotency-key",
      "bom-key",
      "--context-session",
      "\uFEFFsession",
      "--context-node",
      "node\u3042",
      "--context-attempt",
      "",
    ]);

    // Large file-backed body above 65,536 UTF-8 bytes with BOM, CRLF, Unicode, no final LF.
    const largeBody = `\uFEFFLarge body\r\n${"report line with \u00e9\u3042\uD83D\uDE00 and CRLF\r\n".repeat(6600)}tail-\u00e9`;
    const largeFile = join(f.home, "large-body.md");
    writeFileSync(largeFile, largeBody, "utf8");
    const largeMsg = data<{ message: MessageSummary }>(f, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      worker.id,
      "--kind",
      "report",
      "--body-file",
      largeFile,
      "--idempotency-key",
      "bom-large-key",
    ]);
    expect(largeMsg.message.bodyBytes).toBeGreaterThan(65_536);

    // Handle the small message to verify immutable decisions survive restore.
    data<{ message: { message: MessageSummary } }>(f, [
      "channel",
      "handle",
      channelId,
      message.message.id,
      "--expected-row-version",
      "1",
      "--as-participant",
      mainId,
      "--note",
      "\uFEFFdecision note",
    ]).message;

    // Verify exact bytes before backup.
    const detail = data<{ message: MessageDetail }>(f, ["channel", "read", channelId, message.message.id]).message;
    expect(detail.body).toBe(bomBody);
    expect(detail.senderHandle).toBe("\uFEFFworker");
    expect(detail.contextSession).toBe("\uFEFFsession");
    const largeDetail = data<{ message: MessageDetail }>(f, [
      "channel",
      "read",
      channelId,
      largeMsg.message.id,
    ]).message;
    expect(largeDetail.body).toBe(largeBody);

    // Backup run → verify → restore into a fresh home.
    const backupHome = makeTempDir("aj28-backup-");
    const sourceHome = f.home;

    const backup = sorage(["backup", "run", "--json"], { home: sourceHome });
    expect(backup.status, backup.stderr).toBe(0);

    const verify = sorage(["backup", "verify", "--json"], { home: sourceHome });
    expect(verify.status, verify.stderr).toBe(0);

    // Restore into an empty home using the actual --from convention.
    const restoreInit = sorage(["init", "--non-interactive"], { home: backupHome });
    expect(restoreInit.status, restoreInit.stderr).toBe(0);
    const sourceVault = join(sourceHome, "vault");
    const restore = sorage(["backup", "restore", "--from", sourceVault, "--as-user", "--confirm", "--json"], {
      home: backupHome,
    });
    expect(restore.status, restore.stderr).toBe(0);

    // Read the restored messages: BOM handles, context, notes, and bodies must be exact.
    const restoredDetail = (() => {
      const result = sorage(["channel", "read", channelId, message.message.id, "--json"], { home: backupHome });
      expect(result.status, result.stderr).toBe(0);
      return (envelopeOf(result).data as { message: MessageDetail }).message;
    })();
    expect(restoredDetail.body).toBe(bomBody);
    expect(restoredDetail.senderHandle).toBe("\uFEFFworker");
    expect(restoredDetail.contextSession).toBe("\uFEFFsession");
    expect(restoredDetail.handleNote).toBe("\uFEFFdecision note");
    expect(restoredDetail.handled).toBe(true);
    expect(restoredDetail.processingRowVersion).toBe(2);

    const restoredLarge = (() => {
      const result = sorage(["channel", "read", channelId, largeMsg.message.id, "--json"], { home: backupHome });
      expect(result.status, result.stderr).toBe(0);
      return (envelopeOf(result).data as { message: MessageDetail }).message;
    })();
    expect(restoredLarge.body).toBe(largeBody);
    expect(restoredLarge.handled).toBe(false);
    expect(restoredLarge.processingRowVersion).toBe(1);

    // Show the restored Channel: complete roster with native provenance.
    const restoredShow = (() => {
      const result = sorage(["channel", "show", channelId, "--json"], { home: backupHome });
      expect(result.status, result.stderr).toBe(0);
      return (envelopeOf(result).data as { channel: ChannelView }).channel;
    })();
    const restoredWorker = restoredShow.participants.find((p) => p.id === worker.id);
    expect(restoredWorker?.nativeProvenance).toEqual(["\uFEFFnative-provenance"]);

    // Fresh private content-record IDs: the restored messages must reference
    // different content records than the source.
    const sourceDb = new DatabaseSync(join(sourceHome, "state", "sorage.sqlite3"));
    const backupDb = new DatabaseSync(join(backupHome, "state", "sorage.sqlite3"));
    try {
      const srcRecords = sourceDb
        .prepare("SELECT content_record_id FROM channel_messages WHERE channel_id = ? ORDER BY id")
        .all(channelId) as Array<{ content_record_id: string }>;
      const dstRecords = backupDb
        .prepare("SELECT content_record_id FROM channel_messages WHERE channel_id = ? ORDER BY id")
        .all(channelId) as Array<{ content_record_id: string }>;
      expect(dstRecords.length).toBe(srcRecords.length);
      for (let i = 0; i < srcRecords.length; i++) {
        expect(dstRecords[i]?.content_record_id).not.toBe(srcRecords[i]?.content_record_id);
      }

      // Complete metadata ledger preserved.
      const srcEvents = sourceDb
        .prepare(
          "SELECT event_type, metadata_json FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY created_at, id",
        )
        .all() as Array<{ event_type: string; metadata_json: string }>;
      const dstEvents = backupDb
        .prepare(
          "SELECT event_type, metadata_json FROM events WHERE event_type LIKE 'CHANNEL_%' ORDER BY created_at, id",
        )
        .all() as Array<{ event_type: string; metadata_json: string }>;
      expect(dstEvents.map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) }))).toEqual(
        srcEvents.map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) })),
      );

      // No operational receipts restored.
      const receipts = backupDb.prepare("SELECT COUNT(*) as n FROM idempotency_keys").get() as { n: number };
      expect(receipts.n).toBe(0);
    } finally {
      sourceDb.close();
      backupDb.close();
    }

    // Restore-lost receipt → replay-only unavailable.
    const lostRecovery = failure({ home: backupHome }, [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      worker.id,
      "--kind",
      "report",
      "--body",
      bomBody,
      "--idempotency-key",
      "bom-key",
      "--replay-only",
    ]);
    expect(lostRecovery.error.code).toBe("CHN_REPLAY_UNAVAILABLE");
  });
});
