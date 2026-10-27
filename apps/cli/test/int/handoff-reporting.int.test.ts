import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteEventLedger } from "@sorage/adapters/src/events";
import {
  createNodeHandoffReadPorts,
  createNodeRetentionPorts,
  createNodeReviewPorts,
  createNodeRevisionPorts,
} from "@sorage/adapters/src/handoff-command-ports";
import { createSqliteReviewStore } from "@sorage/adapters/src/review-store";
import { openSorageDatabase } from "@sorage/adapters/src/sqlite/connection";
import {
  approveDeletion,
  completeProcessing,
  type HandoffView,
  prepareHandoffFetch,
  type RecipientComment,
  reviseHandoff,
  sendRequestHash,
  setRecipientComment,
  setReviewNote,
  startProcessing,
} from "@sorage/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cliData, memoCliFixture } from "../fixtures/memo-cli";

const scratch = mkdtempSync(join(tmpdir(), "sorage-reporting-compiled-"));
const binary = join(scratch, "sorage");
const cleanups: Array<() => void> = [];
beforeAll(() =>
  execFileSync("bun", ["build", "--compile", "apps/cli/src/main.ts", "--outfile", binary], { stdio: "pipe" }),
);
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function fixture(initialBody = "Revision one") {
  const f = memoCliFixture();
  cleanups.push(f.cleanup);
  function run(args: string[]) {
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      cwd: f.work,
      env: { ...process.env, SORAGE_HOME: f.home },
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  const sent = cliData<{ handoffs: Array<{ handoffId: string }> }>(
    run(["send", "--as", "memo", "--to", "other", "--title", "Reporting", "--body", initialBody, "--json"]),
  );
  const id = sent.handoffs[0]?.handoffId;
  if (id === undefined) throw new Error("the fixture send returned no Handoff");
  const get = () => cliData<HandoffView>(run(["get", id, "--as-user", "--json"]));
  const observe = () => {
    const h = get();
    return ["--expected-revision", String(h.revision), "--expected-row-version", String(h.rowVersion)];
  };
  const state = () =>
    Object.fromEntries(
      ["handoffs", "review_notes", "events", "idempotency_keys", "pending_fs_ops", "content_records", "artifacts"].map(
        (table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
      ),
    );
  const mutate = (args: string[]) => run([...args, "--as", "other", "--json"]);
  const comment = () => cliData<RecipientComment | null>(run(["comment", "show", id, "--as-user", "--json"]));
  return { ...f, run, id, get, observe, state, mutate, comment };
}
function code(result: { status: number | null; stdout: string; stderr: string }, expected: string) {
  expect(result.status, result.stderr).not.toBe(0);
  expect(JSON.parse(result.stdout || result.stderr).error.code).toBe(expected);
}

describe("compiled Handoff reporting and real SQLite", () => {
  it("keeps acceptance independent, replaces one comment atomically, retains terminal/archive feedback and rejects repeated processing", () => {
    const f = fixture();
    expect(f.get()).toMatchObject({
      read: { status: "unconfirmed", revision: 1 },
      processing: { status: "not_started", startedAt: null, completedAt: null },
      comment: null,
      rowVersion: 1,
    });
    cliData(f.mutate(["comment", "set", f.id, "--text", " General report\r\n", ...f.observe()]));
    expect(f.comment()?.body).toBe(" General report\r\n");
    expect(f.get()).toMatchObject({
      hasReviewNote: false,
      reviewState: "awaiting_recipient",
      read: { status: "unconfirmed" },
      processing: { status: "not_started" },
    });
    cliData(f.mutate(["accept", f.id, ...f.observe()]));
    expect(f.get()).toMatchObject({
      reviewState: "accepted",
      nextActors: { reviewNextActor: null },
      processing: { status: "not_started" },
    });
    cliData(f.mutate(["processing", "start", f.id, "--comment-text", "Working", ...f.observe()]));
    const started = f.get();
    expect(started.processing.status).toBe("in_progress");
    let before = f.state();
    code(
      f.mutate(["processing", "start", f.id, "--comment-text", "Rejected proposal", ...f.observe()]),
      "PROCESSING_STATE_CONFLICT",
    );
    expect(f.state()).toEqual(before);
    cliData(f.mutate(["processing", "complete", f.id, "--comment-text", "Done", ...f.observe()]));
    expect(f.get()).toMatchObject({
      rowVersion: started.rowVersion + 1,
      read: { status: "unconfirmed" },
      processing: { status: "completed", startedAt: started.processing.startedAt },
      reviewState: "accepted",
    });
    expect(f.comment()?.body).toBe("Done");
    const events = f.db
      .prepare("SELECT event_type,row_version,metadata_json FROM events WHERE handoff_id=? ORDER BY rowid DESC LIMIT 2")
      .all(f.id) as Array<{ event_type: string; row_version: number; metadata_json: string }>;
    expect(events.map((e) => e.event_type)).toEqual(["HANDOFF_PROCESSING_COMPLETED", "HANDOFF_COMMENT_SET"]);
    expect(events.every((e) => e.row_version === f.get().rowVersion && !e.metadata_json.includes("Done"))).toBe(true);
    before = f.state();
    code(f.mutate(["processing", "complete", f.id, ...f.observe()]), "PROCESSING_STATE_CONFLICT");
    expect(f.state()).toEqual(before);
    cliData(f.run(["archive", f.id, "--as-user", "--json"]));
    cliData(f.mutate(["comment", "set", f.id, "--text", "Archived report", ...f.observe()]));
    expect(f.get().reviewState).toBe("accepted");
    expect(f.comment()?.body).toBe("Archived report");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM review_notes WHERE handoff_id=?").get(f.id)).toEqual({ n: 1 });
    expect(f.run(["get", f.id, "--as-user"]).stdout).toContain("read unconfirmed, processing completed");
    expect(f.run(["inbox", "--as", "other", "--include-archived"]).stdout).toContain("processing completed");
  });

  it("retains resolved older requests, resets only changed revisions, and ends activity on decline before a later general report", () => {
    const f = fixture();
    cliData(
      f.mutate([
        "review",
        "set",
        f.id,
        "--target-revision",
        "1",
        "--expected-row-version",
        "1",
        "--text",
        "Change this",
      ]),
    );
    cliData(f.mutate(["processing", "start", f.id, ...f.observe()]));
    for (const args of [
      ["comment", "set", f.id, "--text", "General"],
      ["processing", "complete", f.id],
    ]) {
      const before = f.state();
      code(f.mutate([...args, ...f.observe()]), "REVIEW_NOTE_PRESENT");
      expect(f.state()).toEqual(before);
    }
    cliData(
      f.run([
        "revise",
        f.id,
        "--as",
        "memo",
        "--body",
        "Revision two",
        "--expected-row-version",
        String(f.get().rowVersion),
        "--json",
      ]),
    );
    expect(f.get()).toMatchObject({
      revision: 2,
      read: { status: "unconfirmed" },
      processing: { status: "not_started" },
      hasReviewNote: false,
      comment: { purpose: "change_request", active: false, targetRevision: 1 },
    });
    expect(f.comment()?.body).toBe("Change this");
    expect(cliData(f.run(["review", "show", f.id, "--as-user", "--json"]))).toBeNull();
    expect(f.run(["get", f.id, "--as-user"]).stdout).toContain("(older revision)");
    cliData(
      f.mutate([
        "review",
        "set",
        f.id,
        "--target-revision",
        "2",
        "--expected-row-version",
        String(f.get().rowVersion),
        "--text",
        "Second request",
      ]),
    );
    cliData(f.mutate(["processing", "start", f.id, ...f.observe()]));
    const beforeRepeatedStart = f.state();
    code(
      f.mutate(["processing", "start", f.id, "--comment-text", "Rejected repeated proposal", ...f.observe()]),
      "PROCESSING_STATE_CONFLICT",
    );
    expect(f.state()).toEqual(beforeRepeatedStart);
    const processing = f.get().processing;
    cliData(
      f.run([
        "revise",
        f.id,
        "--as",
        "memo",
        "--no-change",
        "--reason",
        "Already correct",
        "--expected-row-version",
        String(f.get().rowVersion),
        "--json",
      ]),
    );
    expect(f.get().processing).toEqual(processing);
    cliData(
      f.mutate([
        "review",
        "set",
        f.id,
        "--target-revision",
        "2",
        "--expected-row-version",
        String(f.get().rowVersion),
        "--text",
        "Retained declined request",
      ]),
    );
    cliData(f.mutate(["decline", f.id, "--reason", "Stopped", "--expected-row-version", String(f.get().rowVersion)]));
    expect(f.comment()).toMatchObject({
      purpose: "change_request",
      active: false,
      targetRevision: 2,
      body: "Retained declined request",
    });
    expect(f.get().processing).toEqual(processing);
    const event = f.db.prepare("SELECT metadata_json FROM events WHERE event_type='HANDOFF_DECLINED'").get() as {
      metadata_json: string;
    };
    expect(JSON.parse(event.metadata_json).requestDeactivated).toBe(true);
    cliData(f.mutate(["comment", "set", f.id, "--text", "Why work stopped", ...f.observe()]));
    expect(f.get()).toMatchObject({ reviewState: "declined", processing });
    expect(f.comment()).toMatchObject({ purpose: "general", active: false, body: "Why work stopped" });
    expect(f.run(["get", f.id, "--as-user"]).stdout).toContain("processing stopped (in_progress)");
    for (const action of ["start", "complete"])
      code(f.mutate(["processing", action, f.id, ...f.observe()]), "HANDOFF_TERMINAL");
  });

  it("requires fresh observations, compares revision before row, validates sources, and preserves state/events/proposals on every refusal", () => {
    const f = fixture();
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    cleanups.push(() => db.close());
    const ports = createNodeReviewPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, database: db });
    const actor = { path: f.other, userHome: f.home, as: "other", asUser: false, handoffId: f.id };
    const before = f.state();
    for (const result of [
      setRecipientComment(ports, { ...actor, text: "Missing" }),
      setReviewNote(ports, { ...actor, text: "Legacy missing" }),
      completeProcessing(ports, actor),
    ])
      expect(result).toMatchObject({ ok: false, error: { code: "HANDOFF_INVALID_INPUT" } });
    expect(f.state()).toEqual(before);
    cliData(f.run(["revise", f.id, "--as", "memo", "--body", "Revision two", "--expected-row-version", "1", "--json"]));
    const current = f.state();
    code(
      f.mutate([
        "comment",
        "set",
        f.id,
        "--text",
        "Old proposal",
        "--expected-revision",
        "1",
        "--expected-row-version",
        "1",
      ]),
      "REVISION_CONFLICT",
    );
    code(
      f.mutate([
        "comment",
        "set",
        f.id,
        "--text",
        "Same revision stale proposal",
        "--expected-revision",
        "2",
        "--expected-row-version",
        "1",
      ]),
      "ROW_VERSION_CONFLICT",
    );
    for (const text of [" ", "NUL\0", "\ud800"])
      expect(setRecipientComment(ports, { ...actor, text, expectedRevision: 2, expectedRowVersion: 2 })).toMatchObject({
        ok: false,
        error: { code: "HANDOFF_INVALID_INPUT" },
      });
    const invalid = join(f.work, "invalid.txt");
    writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
    code(f.mutate(["comment", "set", f.id, "--file", invalid, ...f.observe()]), "HANDOFF_INVALID_INPUT");
    code(f.mutate(["comment", "set", f.id, "--file", f.work, ...f.observe()]), "HANDOFF_INVALID_INPUT");
    code(
      f.run(["comment", "set", f.id, "--as", "memo", "--text", "Sender", ...f.observe(), "--json"]),
      "FORBIDDEN_ACTOR",
    );
    expect(f.state()).toEqual(current);
    cliData(f.mutate(["comment", "set", f.id, "--text", "Engaged", ...f.observe()]));
    cliData(
      f.run([
        "review",
        "remove",
        f.id,
        "--as-user",
        "--confirm",
        "--expected-row-version",
        String(f.get().rowVersion),
        "--json",
      ]),
    );
    code(f.run(["withdraw", f.id, "--as", "memo", "--json"]), "HANDOFF_ALREADY_FETCHED");
  });

  it("prevents stale legacy writers from overwriting, removing or resolving newer feedback", () => {
    const f = fixture();
    cliData(
      f.mutate(["review", "set", f.id, "--text", "First", "--target-revision", "1", "--expected-row-version", "1"]),
    );
    const oldProposal = "2";
    cliData(
      f.mutate([
        "review",
        "set",
        f.id,
        "--text",
        "Newer",
        "--target-revision",
        "1",
        "--expected-row-version",
        oldProposal,
      ]),
    );
    const before = f.state();
    for (const args of [
      ["review", "set", f.id, "--as", "other", "--text", "Stale", "--target-revision", "1"],
      ["review", "withdraw", f.id, "--as", "other"],
      ["review", "remove", f.id, "--as-user", "--confirm"],
      ["revise", f.id, "--as", "memo", "--no-change", "--reason", "Stale resolution"],
      ["revise", f.id, "--as", "memo", "--body", "Stale replacement"],
    ]) {
      code(f.run([...args, "--expected-row-version", oldProposal, "--json"]), "ROW_VERSION_CONFLICT");
      expect(f.state()).toEqual(before);
    }
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    cleanups.push(() => db.close());
    const ports = createNodeReviewPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, database: db });
    const actor = { path: f.other, userHome: f.home, as: "other", asUser: false, handoffId: f.id };
    // Missing flags remain an application admission failure, even behind parser-required options.
    expect(setReviewNote(ports, { ...actor, text: "Missing row", targetRevision: 1 })).toMatchObject({
      ok: false,
      error: { code: "HANDOFF_INVALID_INPUT" },
    });
    expect(f.state()).toEqual(before);
    cliData(f.run(["revise", f.id, "--as", "memo", "--body", "Revision two", "--expected-row-version", "3", "--json"]));
    expect(f.comment()).toMatchObject({ active: false, targetRevision: 1, body: "Newer" });
    cliData(f.run(["review", "remove", f.id, "--as-user", "--confirm", "--expected-row-version", "4", "--json"]));
    expect(f.comment()).toBeNull();
    expect(f.get().reviewState).toBe("awaiting_recipient");
    cliData(
      f.mutate([
        "review",
        "set",
        f.id,
        "--text",
        "Legacy older target",
        "--target-revision",
        "2",
        "--expected-row-version",
        "5",
      ]),
    );
    f.db.prepare("UPDATE review_notes SET target_revision=1 WHERE handoff_id=?").run(f.id);
    cliData(f.mutate(["review", "withdraw", f.id, "--expected-row-version", "6"]));
    expect(f.comment()).toMatchObject({ active: false, targetRevision: 1, body: "Legacy older target" });
  });

  it("rolls back status, replacement, engagement and both events on ledger failure and stale CAS", () => {
    const f = fixture();
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    cleanups.push(() => db.close());
    const real = createNodeReviewPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, database: db });
    const ledger = createSqliteEventLedger(db);
    let count = 0;
    const ports = {
      ...real,
      reviews: createSqliteReviewStore(db, {
        ...ledger,
        append(event) {
          if (++count === 2) throw new Error("second event failed");
          ledger.append(event);
        },
      }),
    };
    const before = f.state();
    const result = completeProcessing(ports, {
      path: f.other,
      userHome: f.home,
      as: "other",
      asUser: false,
      handoffId: f.id,
      expectedRevision: 1,
      expectedRowVersion: 1,
      comment: "Atomic proposal",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(f.state()).toEqual(before);
    const stale = {
      ...real,
      reviews: {
        ...real.reviews,
        applyReportMutation(input: Parameters<typeof real.reviews.applyReportMutation>[0]) {
          cliData(f.mutate(["comment", "set", f.id, "--text", "Winner", ...f.observe()]));
          return real.reviews.applyReportMutation(input);
        },
      },
    };
    expect(
      completeProcessing(stale, {
        path: f.other,
        userHome: f.home,
        as: "other",
        asUser: false,
        handoffId: f.id,
        expectedRevision: 1,
        expectedRowVersion: 1,
        comment: "Loser",
      }),
    ).toMatchObject({ ok: false, error: { code: "ROW_VERSION_CONFLICT" } });
    expect(f.get()).toMatchObject({ processing: { status: "not_started" }, rowVersion: 2 });
    expect(f.comment()?.body).toBe("Winner");
  });

  it.each(["comment", "start", "complete"] as const)(
    "T130-R1-003 classifies a changed-Revision %s CAS with the explicit Revision first",
    (operation) => {
      const f = fixture();
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      cleanups.push(() => db.close());
      const real = createNodeReviewPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, database: db });
      let afterWinner: ReturnType<typeof f.state> | undefined;
      const ports = {
        ...real,
        reviews: {
          ...real.reviews,
          applyReportMutation(input: Parameters<typeof real.reviews.applyReportMutation>[0]) {
            cliData(
              f.run(["revise", f.id, "--as", "memo", "--body", "Winning R2", "--expected-row-version", "1", "--json"]),
            );
            afterWinner = f.state();
            return real.reviews.applyReportMutation(input);
          },
        },
      };
      const input = {
        path: f.other,
        userHome: f.home,
        as: "other",
        asUser: false,
        handoffId: f.id,
        expectedRevision: 1,
        expectedRowVersion: 1,
      };
      const result =
        operation === "comment"
          ? setRecipientComment(ports, { ...input, text: "Rejected R1 proposal" })
          : operation === "start"
            ? startProcessing(ports, { ...input, comment: "Rejected R1 proposal" })
            : completeProcessing(ports, { ...input, comment: "Rejected R1 proposal" });
      expect(result).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
      expect(afterWinner).toBeDefined();
      expect(f.state()).toEqual(afterWinner);
      expect(f.get()).toMatchObject({
        revision: 2,
        rowVersion: 2,
        reviewEngagedAt: null,
        processing: { status: "not_started" },
        comment: null,
      });
    },
  );

  it("T130-R1-002 preserves revise/no-change/delete state and operation refusals before stale rows", () => {
    const f = fixture();
    cliData(f.mutate(["comment", "set", f.id, "--text", "General", ...f.observe()]));
    let before = f.state();
    code(
      f.run([
        "revise",
        f.id,
        "--as",
        "memo",
        "--no-change",
        "--reason",
        "Old proposal",
        "--expected-row-version",
        "1",
        "--json",
      ]),
      "NO_REVIEW_NOTE",
    );
    code(
      f.run(["revise", f.id, "--as", "other", "--body", "Forbidden", "--expected-row-version", "1", "--json"]),
      "FORBIDDEN_ACTOR",
    );
    code(
      f.run(["delete", "approve", f.id, "--as-user", "--confirm", "--expected-row-version", "1", "--json"]),
      "HANDOFF_NOT_TERMINAL",
    );
    expect(f.state()).toEqual(before);
    cliData(
      f.mutate([
        "review",
        "set",
        f.id,
        "--text",
        "First request",
        "--target-revision",
        "1",
        "--expected-row-version",
        "2",
      ]),
    );
    cliData(
      f.run([
        "revise",
        f.id,
        "--as",
        "memo",
        "--no-change",
        "--reason",
        "First bounded resolution",
        "--expected-row-version",
        "3",
        "--json",
      ]),
    );
    cliData(
      f.mutate([
        "review",
        "set",
        f.id,
        "--text",
        "Repeated request",
        "--target-revision",
        "1",
        "--expected-row-version",
        "4",
      ]),
    );
    before = f.state();
    code(
      f.run([
        "revise",
        f.id,
        "--as",
        "memo",
        "--no-change",
        "--reason",
        "Repeated stale resolution",
        "--expected-row-version",
        "1",
        "--json",
      ]),
      "NO_CHANGE_LIMIT",
    );
    expect(f.state()).toEqual(before);
    cliData(
      f.run(["revise", f.id, "--as", "memo", "--body", "Changed content R2", "--expected-row-version", "5", "--json"]),
    );
    cliData(f.mutate(["accept", f.id, ...f.observe()]));
    before = f.state();
    for (const args of [
      ["revise", f.id, "--as", "memo", "--body", "Terminal"],
      ["revise", f.id, "--as", "memo", "--no-change", "--reason", "Terminal"],
      ["review", "set", f.id, "--as", "other", "--text", "Terminal", "--target-revision", "1"],
      ["review", "withdraw", f.id, "--as", "other"],
      ["review", "remove", f.id, "--as-user", "--confirm"],
    ])
      code(f.run([...args, "--expected-row-version", "1", "--json"]), "HANDOFF_TERMINAL");
    code(
      f.run(["delete", "approve", f.id, "--as-user", "--confirm", "--expected-row-version", "1", "--json"]),
      "HANDOFF_NOT_FOUND",
    );
    expect(f.state()).toEqual(before);
    cliData(f.run(["pin", f.id, "--as-user", "--json"]));
    cliData(f.run(["delete", "request", f.id, "--as-user", "--json"]));
    before = f.state();
    code(
      f.run(["delete", "approve", f.id, "--as-user", "--confirm", "--expected-row-version", "1", "--json"]),
      "PINNED_DELETE_CONFIRMATION",
    );
    expect(f.state()).toEqual(before);
    cliData(
      f.run([
        "delete",
        "approve",
        f.id,
        "--as-user",
        "--confirm",
        "--confirm-pinned",
        f.id,
        "--expected-row-version",
        String(f.get().rowVersion),
        "--json",
      ]),
    );
    before = f.state();
    for (const args of [
      ["revise", f.id, "--as", "memo", "--body", "Deleted"],
      ["revise", f.id, "--as", "memo", "--no-change", "--reason", "Deleted"],
      ["review", "set", f.id, "--as", "other", "--text", "Deleted", "--target-revision", "1"],
      ["review", "withdraw", f.id, "--as", "other"],
      ["review", "remove", f.id, "--as-user", "--confirm"],
      ["delete", "approve", f.id, "--as-user", "--confirm"],
    ])
      code(f.run([...args, "--expected-row-version", "1", "--json"]), "HANDOFF_DELETED");
    expect(f.state()).toEqual(before);
  });

  it("settles only delivered Artifact+Revision, preserves row versions and ignores stale or cancelled acquisitions", () => {
    const f = fixture();
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    cleanups.push(() => db.close());
    const ports = createNodeHandoffReadPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, database: db });
    const actor = { path: f.other, userHome: f.home, as: "other", asUser: false };
    const old = prepareHandoffFetch(ports, actor, f.id, { kind: "body" });
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    const before = f.state();
    old.value.close();
    expect(f.state()).toEqual(before);
    const stale = prepareHandoffFetch(ports, actor, f.id, { kind: "body" });
    if (!stale.ok) throw stale.error;
    cliData(f.run(["fetch", f.id, "--as", "memo", "--json"]));
    expect(f.get().read.status).toBe("unconfirmed");
    cliData(f.run(["revise", f.id, "--as", "memo", "--body", "Revision two", "--expected-row-version", "1", "--json"]));
    cliData(f.run(["fetch", f.id, "--as", "other", "--json"]));
    const read = f.get();
    expect(read).toMatchObject({
      rowVersion: 2,
      read: { status: "read", revision: 2 },
      processing: { status: "not_started" },
    });
    const settled = f.state();
    expect(stale.value.settleFirstFetch().ok).toBe(true);
    stale.value.close();
    expect(f.state()).toEqual(settled);
    cliData(f.run(["fetch", f.id, "--as-user", "--json"]));
    expect(f.state()).toEqual(settled);
    const events = f.db
      .prepare(
        "SELECT event_type,row_version,metadata_json FROM events WHERE event_type IN ('HANDOFF_REVISION_READ','ARTIFACT_FETCHED_FIRST_TIME')",
      )
      .all() as Array<{ event_type: string; row_version: number; metadata_json: string }>;
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.event_type === "HANDOFF_REVISION_READ")).toMatchObject({ row_version: 2 });
  });

  it.each([
    { author: "recipient", representation: "inline" },
    { author: "recipient", representation: "file" },
    { author: "user", representation: "inline" },
    { author: "user", representation: "file" },
  ] as const)(
    "T130-EV-W01 first $author delivery of old $representation bytes preserves historical engagement after revise",
    ({ author, representation }) => {
      const originalBody = representation === "inline" ? "Revision one" : `Revision one\n${"x".repeat(70000)}`;
      const f = fixture(originalBody);
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      cleanups.push(() => db.close());
      const ports = createNodeHandoffReadPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home, database: db });
      const acquired = prepareHandoffFetch(
        ports,
        { path: f.other, userHome: f.home, as: "other", asUser: author === "user" },
        f.id,
        { kind: "body" },
      );
      if (!acquired.ok) throw acquired.error;
      if (acquired.value.kind !== "body") throw new Error("the race requires an acquired body handle");
      const oldArtifact = acquired.value.artifact.id;
      expect(acquired.value.artifact.storageKey === null).toBe(representation === "inline");
      expect(f.get()).toMatchObject({
        revision: 1,
        rowVersion: 1,
        firstFetchedAt: null,
        read: { status: "unconfirmed" },
      });
      cliData(
        f.run(["revise", f.id, "--as", "memo", "--body", "Revision two", "--expected-row-version", "1", "--json"]),
      );
      const revised = f.get();
      expect(revised).toMatchObject({
        revision: 2,
        rowVersion: 2,
        firstFetchedAt: null,
        read: { revision: 2, status: "unconfirmed", readAt: null },
      });
      // Deliver only the previously acquired body. No recipient/User fetch of R2
      // may mask the historical first-delivery marker this settlement owes.
      const chunks: Buffer[] = [];
      for (let position = 0; position < acquired.value.body.sizeBytes; ) {
        const read = acquired.value.body.read(position, Math.min(65536, acquired.value.body.sizeBytes - position));
        if (!read.ok) throw read.error;
        expect(read.value.length).toBeGreaterThan(0);
        chunks.push(Buffer.from(read.value));
        position += read.value.length;
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe(originalBody);
      expect(acquired.value.settleFirstFetch()).toEqual({ ok: true, value: undefined });
      const settled = f.get();
      expect(settled.firstFetchedAt).not.toBeNull();
      expect(settled).toMatchObject({
        revision: 2,
        rowVersion: 2,
        read: revised.read,
        processing: revised.processing,
        currentArtifact: revised.currentArtifact,
        reviewEngagedAt: null,
      });
      const events = f.db
        .prepare(
          "SELECT event_type,actor_kind,row_version,metadata_json FROM events WHERE event_type IN ('HANDOFF_REVISION_READ','ARTIFACT_FETCHED_FIRST_TIME') ORDER BY rowid",
        )
        .all() as Array<{ event_type: string; actor_kind: string; row_version: number | null; metadata_json: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: "ARTIFACT_FETCHED_FIRST_TIME",
        actor_kind: author === "user" ? "user" : "registered_project",
        row_version: null,
      });
      expect(JSON.parse(events[0]?.metadata_json ?? "{}")).toMatchObject({ artifactId: oldArtifact });
      const afterFirstDelivery = f.state();
      expect(acquired.value.settleFirstFetch()).toEqual({ ok: true, value: undefined });
      acquired.value.close();
      expect(f.state()).toEqual(afterFirstDelivery);
      code(f.run(["withdraw", f.id, "--as", "memo", "--json"]), "HANDOFF_ALREADY_FETCHED");
      expect(f.state()).toEqual(afterFirstDelivery);
    },
  );

  it("replays exact historical successful receipts before fresh-state checks and refuses receipt misses without staging", () => {
    const f = fixture();
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    cleanups.push(() => db.close());
    const options = { env: { SORAGE_HOME: f.home }, userHome: f.home, database: db };
    const revisionPorts = createNodeRevisionPorts(options);
    const retentionPorts = createNodeRetentionPorts(options);
    const sender = { path: f.work, userHome: f.home, as: "memo", asUser: false, handoffId: f.id };
    const before = f.state();
    expect(reviseHandoff(revisionPorts, { ...sender, body: "Missing observations" })).toMatchObject({
      ok: false,
      error: { code: "HANDOFF_INVALID_INPUT" },
    });
    expect(approveDeletion(retentionPorts, { ...sender, asUser: true, confirm: true })).toMatchObject({
      ok: false,
      error: { code: "HANDOFF_INVALID_INPUT" },
    });
    expect(f.state()).toEqual(before);
    const key = randomUUID();
    const deletionKey = randomUUID();
    const legacyRevision = {
      handoffId: f.id,
      revision: 2,
      rowVersion: 2,
      reviewState: "awaiting_recipient",
      storageKey: null,
      replayed: false,
    };
    const legacyDeletion = {
      handoffId: f.id,
      reviewState: "accepted",
      rowVersion: 9,
      deleted: true,
      warning: "prior Git commits may retain earlier content",
    };
    const expiry = new Date(Date.now() + 3600000).toISOString();
    const insert = f.db.prepare(
      "INSERT INTO idempotency_keys (key,scope,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,?,?)",
    );
    insert.run(
      key,
      "revise",
      sendRequestHash({
        to: [f.id],
        title: "Reporting",
        contentSha256: createHash("sha256").update("Legacy replacement").digest("hex"),
        kind: "body",
      }),
      JSON.stringify(legacyRevision),
      new Date().toISOString(),
      expiry,
    );
    insert.run(
      deletionKey,
      "deletion-approve",
      createHash("sha256")
        .update(JSON.stringify({ kind: "deletion-approve", handoffId: f.id, confirmPinned: null }))
        .digest("hex"),
      JSON.stringify(legacyDeletion),
      new Date().toISOString(),
      expiry,
    );
    cliData(f.mutate(["accept", f.id, ...f.observe()]));
    const saved = f.state();
    expect(reviseHandoff(revisionPorts, { ...sender, body: "Legacy replacement", idempotencyKey: key })).toEqual({
      ok: true,
      value: { ...legacyRevision, replayed: true },
    });
    expect(
      approveDeletion(retentionPorts, { ...sender, asUser: true, confirm: true, idempotencyKey: deletionKey }),
    ).toEqual({ ok: true, value: { ...legacyDeletion, replayed: true } });
    expect(
      reviseHandoff(revisionPorts, {
        ...sender,
        body: "Legacy replacement",
        idempotencyKey: key,
        expectedRowVersion: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: "HANDOFF_INVALID_INPUT" } });
    expect(f.state()).toEqual(saved);
    f.db.prepare("UPDATE idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect(reviseHandoff(revisionPorts, { ...sender, body: "Legacy replacement", idempotencyKey: key })).toMatchObject({
      ok: false,
      error: { code: "HANDOFF_INVALID_INPUT" },
    });
    expect(
      approveDeletion(retentionPorts, { ...sender, asUser: true, confirm: true, idempotencyKey: deletionKey }),
    ).toMatchObject({ ok: false, error: { code: "HANDOFF_INVALID_INPUT" } });
    expect(f.get()).toMatchObject({ reviewState: "accepted", rowVersion: 2, revision: 1 });
  });

  it.each(["not_started", "unrecorded"] as const)(
    "directly completes %s work without inventing reading or a start",
    (status) => {
      const f = fixture();
      if (status === "unrecorded")
        f.db.prepare("UPDATE handoffs SET read_status='unrecorded',processing_status='unrecorded'").run();
      cliData(f.mutate(["processing", "complete", f.id, ...f.observe()]));
      expect(f.get()).toMatchObject({
        read: { status: status === "unrecorded" ? "unrecorded" : "unconfirmed" },
        processing: { status: "completed", startedAt: null },
        reviewState: "awaiting_recipient",
      });
      cliData(f.mutate(["comment", "set", f.id, "--text", "Final report", ...f.observe()]));
      cliData(f.mutate(["accept", f.id, ...f.observe()]));
      cliData(f.run(["delete", "request", f.id, "--as-user", "--json"]));
      const stale = f.get().rowVersion - 1;
      const before = f.state();
      code(
        f.run(["delete", "approve", f.id, "--as-user", "--confirm", "--expected-row-version", String(stale), "--json"]),
        "ROW_VERSION_CONFLICT",
      );
      expect(f.state()).toEqual(before);
      cliData(
        f.run([
          "delete",
          "approve",
          f.id,
          "--as-user",
          "--confirm",
          "--expected-row-version",
          String(f.get().rowVersion),
          "--json",
        ]),
      );
      expect(f.get()).toMatchObject({
        comment: null,
        read: { status: "unrecorded" },
        processing: { status: "unrecorded" },
      });
      code(f.mutate(["comment", "set", f.id, "--text", "No resurrection", ...f.observe()]), "HANDOFF_DELETED");
      cliData(f.run(["project", "unbind", "other", "--dir", f.other, "--json"]));
    },
  );

  it("protects known unfinished accepted work and last binding, retains archived work, and excludes unknown/completed/tombstones", () => {
    for (const status of ["not_started", "in_progress", "completed", "unrecorded"] as const) {
      const f = fixture();
      cliData(f.mutate(["accept", f.id, ...f.observe()]));
      f.db
        .prepare("UPDATE handoffs SET processing_status=?,processing_started_at=?,processing_completed_at=? WHERE id=?")
        .run(
          status,
          status === "in_progress" ? new Date().toISOString() : null,
          status === "completed" ? new Date().toISOString() : null,
          f.id,
        );
      cliData(f.run(["archive", f.id, "--as-user", "--json"]));
      const args = ["project", "unbind", "other", "--dir", f.other, "--json"];
      const result = f.run(args);
      if (status === "not_started" || status === "in_progress") {
        code(result, "CONFIRMATION_REQUIRED");
        cliData(f.run([...args, "--confirm"]));
      } else expect(result.status, result.stderr).toBe(0);
    }
  });
});
