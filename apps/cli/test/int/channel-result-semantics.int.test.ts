import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appError, err, ok } from "@sorage/core";
import { openSorageDatabase, type SorageSqlite } from "@sorage/adapters/src/sqlite/connection";
import { runCli } from "../../src/main";
import { memoCliFixture } from "../fixtures/memo-cli";

/**
 * The TASK-113 Channel result semantics through the actual CLI (CHN-007,
 * CHN-012, interface sections 38.4 and 38.5): the committed submit and handle
 * envelopes, the contained warnings and the human lines that never assert an
 * unobserved activation, the per-surface recovery rendering, the wait's three
 * deadline outcomes, and the immediate not-found filters. Faults are injected
 * only after real domain commits or on the read seam; the actual CLI, envelope
 * renderer, SQLite rows, and content storage still run.
 */
const fault = vi.hoisted(() => ({
  activation: "none" as "none" | "failed" | "paused",
  probe: false,
  preview: false,
  throwProbeAfterActivation: false,
  throwProbeInInspection: false,
  busyProbe: false,
  listFailures: 0,
  handoffListFailures: 0,
}));

/** The operational connections opened for the busy-probe fault, closed per test. */
const busyConnections: SorageSqlite[] = [];

/**
 * A real database connection whose probe read throws the engine's busy
 * signature; every other statement still runs, so the command itself works.
 */
function busyProbeDatabase(real: SorageSqlite): SorageSqlite {
  return new Proxy(real, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("cr.materialized")) {
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SorageSqlite;
}

/** Hides the probed column behind the real probe's SQL on the fixture's home. */
function hideContentRecords(home: string): void {
  const side = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    side.exec("PRAGMA foreign_keys = OFF");
    side.exec("ALTER TABLE content_records RENAME COLUMN materialized TO materialized_hidden");
  } finally {
    side.close();
  }
}

function restoreContentRecords(home: string): void {
  const side = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    side.exec("PRAGMA foreign_keys = OFF");
    side.exec("ALTER TABLE content_records RENAME COLUMN materialized_hidden TO materialized");
  } finally {
    side.close();
  }
}

vi.mock("@sorage/adapters/src/channel-command-ports", async (original) => {
  const actual = await original<typeof import("@sorage/adapters/src/channel-command-ports")>();
  return {
    ...actual,
    createNodeChannelPorts: (...args: Parameters<typeof actual.createNodeChannelPorts>) => {
      const home = process.env.SORAGE_HOME;
      if (fault.busyProbe && home !== undefined) {
        const raw = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
        busyConnections.push(raw);
        return actual.createNodeChannelPorts({ ...(args[0] ?? {}), database: busyProbeDatabase(raw) });
      }
      const ports = actual.createNodeChannelPorts(...args);
      if (fault.activation === "failed") {
        ports.staging.activateContent = () => err(appError("CONTENT_MATERIALIZING", "injected activation failure"));
      }
      if (fault.activation === "paused") {
        ports.staging.activateContent = () => ok({ status: "paused" as const });
      }
      if (fault.probe) {
        ports.bodies.messageContentState = () => err(appError("STORAGE_INTEGRITY_ERROR", "injected probe failure"));
      }
      if (fault.preview) {
        ports.bodies.readRecordPreviewSeed = () => err(appError("INTERNAL_ERROR", "injected preview failure"));
      }
      if (fault.throwProbeAfterActivation) {
        const activate = ports.staging.activateContent;
        ports.staging.activateContent = (input, binding) => {
          const result = activate(input, binding);
          const home = process.env.SORAGE_HOME;
          if (home !== undefined) hideContentRecords(home);
          return result;
        };
      }
      if (fault.listFailures > 0) {
        const capture = ports.channels.captureMessageList;
        let remaining = fault.listFailures;
        ports.channels.captureMessageList = (...captureArgs: Parameters<typeof capture>) => {
          if (remaining > 0) {
            remaining -= 1;
            return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "injected listing failure"));
          }
          return capture(...captureArgs);
        };
      }
      return ports;
    },
    createNodeChannelRecoveryPorts: (...args: Parameters<typeof actual.createNodeChannelRecoveryPorts>) => {
      const options = args[0] ?? {};
      if (!fault.throwProbeInInspection && !fault.busyProbe) return actual.createNodeChannelRecoveryPorts(...args);
      return actual.createNodeChannelRecoveryPorts({
        ...options,
        inspection: {
          ...(options.inspection ?? {}),
          openPrivateDatabase(path) {
            const db = new DatabaseSync(path);
            return {
              exec: (sql: string) => db.exec(sql),
              prepare(sql: string) {
                if (sql.includes("cr.materialized")) {
                  throw fault.busyProbe
                    ? Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
                    : new Error("injected probe SQL failure");
                }
                return db.prepare(sql);
              },
              close() {
                db.close();
              },
            };
          },
        },
      });
    },
  };
});

vi.mock("@sorage/adapters/src/handoff-command-ports", async (original) => {
  const actual = await original<typeof import("@sorage/adapters/src/handoff-command-ports")>();
  return {
    ...actual,
    createNodeHandoffReadPorts: (...args: Parameters<typeof actual.createNodeHandoffReadPorts>) => {
      const ports = actual.createNodeHandoffReadPorts(...args);
      if (fault.handoffListFailures > 0) {
        const listPage = ports.handoffs.listPage;
        ports.handoffs.listPage = (...pageArgs: Parameters<typeof listPage>) => {
          // The wait re-admits storage on every poll, so the composition is
          // rebuilt per poll; the fault budget is global to the test, not per
          // composition, matching one real transient listing failure.
          if (fault.handoffListFailures > 0) {
            fault.handoffListFailures -= 1;
            return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "injected Handoff listing failure"));
          }
          return listPage(...pageArgs);
        };
      }
      return ports;
    },
  };
});

const fixtures: Array<ReturnType<typeof memoCliFixture>> = [];
const previousHome = process.env.SORAGE_HOME;
afterEach(() => {
  Object.assign(fault, {
    activation: "none",
    probe: false,
    preview: false,
    throwProbeAfterActivation: false,
    throwProbeInInspection: false,
    busyProbe: false,
    listFailures: 0,
    handoffListFailures: 0,
  });
  for (const connection of busyConnections.splice(0)) {
    try {
      connection.close();
    } catch {
      // Best-effort test teardown.
    }
  }
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup();
  if (previousHome === undefined) delete process.env.SORAGE_HOME;
  else process.env.SORAGE_HOME = previousHome;
});

function run(args: string[], throwingSink = false) {
  let out = "";
  let stderr = "";
  const code = runCli(args, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      if (throwingSink) throw new Error("injected sink failure");
      stderr += text;
    },
  });
  return { code, out, stderr };
}

interface ChannelFixture extends ReturnType<typeof memoCliFixture> {
  channelId: string;
  mainId: string;
  workerId: string;
  bodyFile: string;
}

function channelFixture(): ChannelFixture {
  const fixture = memoCliFixture();
  fixtures.push(fixture);
  process.env.SORAGE_HOME = fixture.home;
  const created = run(["channel", "create", "--main-handle", "orchestrator", "--json"]);
  if (created.code !== 0) throw new Error(created.stderr);
  const channel = JSON.parse(created.out).data.channel as { id: string; mainParticipantId: string };
  const worker = run([
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
    "--json",
  ]);
  if (worker.code !== 0) throw new Error(worker.stderr);
  const workerId = JSON.parse(worker.out).data.participant.id as string;
  const bodyFile = join(fixture.home, "large-body.txt");
  writeFileSync(bodyFile, "channel body line\n".repeat(7000));
  return { ...fixture, channelId: channel.id, mainId: channel.mainParticipantId, workerId, bodyFile };
}

function submitArgs(f: ChannelFixture, key: string, extra: string[] = []): string[] {
  return [
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
    key,
    ...extra,
  ];
}

describe("committed Channel results through the CLI", () => {
  it("returns the committed submit envelope with the pending line and the activation warning", () => {
    const f = channelFixture();
    fault.activation = "failed";
    const human = run(submitArgs(f, "activation-failed"));
    expect(human.code, human.stderr).toBe(0);
    expect(human.out).toContain("Content activation is pending; the next process start retries it.");
    expect(human.stderr).toContain("the Channel message committed but its content activation failed");
    expect(human.stderr).toContain("injected activation failure");
    const json = run(submitArgs(f, "activation-failed-json", ["--json"]));
    expect(json.code, json.stderr).toBe(0);
    const data = JSON.parse(json.out).data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["contentActivating", "message", "replayed"]);
    expect(data.contentActivating).toBe(true);
    expect(json.stderr).toContain("its content activation failed");
    // Replay-only skips the startup drain, so the record is still unobserved.
    const replay = run(submitArgs(f, "activation-failed-json", ["--json", "--replay-only"]));
    expect(replay.code, replay.stderr).toBe(0);
    expect(Object.keys(JSON.parse(replay.out).data as object).sort()).toEqual([
      "contentActivating",
      "message",
      "replayed",
    ]);
    expect((JSON.parse(replay.out).data as { replayed: boolean }).replayed).toBe(true);
    expect((JSON.parse(replay.out).data as { contentActivating: boolean }).contentActivating).toBe(true);
  });

  it("keeps the committed envelope when the warning sink throws", () => {
    const f = channelFixture();
    fault.activation = "failed";
    const result = run(submitArgs(f, "throwing-sink", ["--json"]), true);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.out) as { ok: boolean; data: { contentActivating: boolean } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.contentActivating).toBe(true);
  });

  it("renders the unconfirmed-content line and warning for an unobservable file-backed state", () => {
    const f = channelFixture();
    fault.probe = true;
    const human = run(submitArgs(f, "probe-uncertain"));
    expect(human.code, human.stderr).toBe(0);
    expect(human.out).toContain(
      "Content activation could not be confirmed; the message is committed and needs no resubmission.",
    );
    expect(human.out).not.toContain("Content activation is pending");
    expect(human.stderr).toContain("the content-state probe for message");
    expect(human.stderr).toContain("activation is not confirmed and contentActivating is reported as true");
    const json = run(submitArgs(f, "probe-uncertain", ["--json"]));
    expect(json.code, json.stderr).toBe(0);
    expect((JSON.parse(json.out).data as { contentActivating: boolean }).contentActivating).toBe(true);
    expect(json.stderr).toContain("injected probe failure");
  });

  it("never probes inline content on the execute or replay-only surfaces", () => {
    const f = channelFixture();
    fault.probe = true;
    const args = [
      "channel",
      "submit",
      f.channelId,
      "--as-participant",
      f.workerId,
      "--kind",
      "report",
      "--body",
      "inline body",
      "--idempotency-key",
      "inline-key",
      "--json",
    ];
    const fresh = run(args);
    expect(fresh.code, fresh.stderr).toBe(0);
    expect((JSON.parse(fresh.out).data as { contentActivating: boolean }).contentActivating).toBe(false);
    expect(fresh.stderr).toBe("");
    const replay = run([...args, "--replay-only"]);
    expect(replay.code, replay.stderr).toBe(0);
    expect(Object.keys(JSON.parse(replay.out).data as object).sort()).toEqual([
      "contentActivating",
      "message",
      "replayed",
    ]);
    expect((JSON.parse(replay.out).data as { contentActivating: boolean }).contentActivating).toBe(false);
    expect(replay.stderr).toBe("");
  });

  it("keeps exit 0 when the real content-state probe throws on fresh, replay, and replay-only", () => {
    const f = channelFixture();
    // Fresh: the real activation completes, then the real content table
    // disappears behind the real probe's SQL inside the same command.
    fault.throwProbeAfterActivation = true;
    try {
      const fresh = run(submitArgs(f, "thrown-probe-cli", ["--json"]));
      expect(fresh.code, fresh.stderr).toBe(0);
      const freshData = JSON.parse(fresh.out).data as { contentActivating: boolean; message: { id: string } };
      expect(freshData.contentActivating).toBe(true);
      expect(fresh.stderr).toContain(`the content-state probe for message ${freshData.message.id} failed`);
      expect(fresh.stderr).toContain("activation is not confirmed and contentActivating is reported as true");
    } finally {
      fault.throwProbeAfterActivation = false;
      restoreContentRecords(f.home);
    }
    // Ordinary same-key replay: the receipt validation runs, the probe throws.
    hideContentRecords(f.home);
    try {
      const replay = run(submitArgs(f, "thrown-probe-cli", ["--json"]));
      expect(replay.code, replay.stderr).toBe(0);
      const replayData = JSON.parse(replay.out).data as { contentActivating: boolean; replayed: boolean };
      expect(replayData.replayed).toBe(true);
      expect(replayData.contentActivating).toBe(true);
      expect(replay.stderr).toContain("the content-state probe for message");
    } finally {
      restoreContentRecords(f.home);
    }
    // Replay-only inspection: the same translation on the read-only seam.
    fault.throwProbeInInspection = true;
    try {
      const readonly = run(submitArgs(f, "thrown-probe-cli", ["--json", "--replay-only"]));
      expect(readonly.code, readonly.stderr).toBe(0);
      expect(Object.keys(JSON.parse(readonly.out).data as object).sort()).toEqual([
        "contentActivating",
        "message",
        "replayed",
      ]);
      expect((JSON.parse(readonly.out).data as { contentActivating: boolean }).contentActivating).toBe(true);
      expect(readonly.stderr).toContain("the content-state probe for message");
    } finally {
      fault.throwProbeInInspection = false;
    }
  });

  it("keeps exit 0 and a probe-specific warning when the real probe meets a busy signature", () => {
    const f = channelFixture();
    fault.busyProbe = true;
    const fresh = run(submitArgs(f, "busy-probe-cli", ["--json"]));
    expect(fresh.code, fresh.stderr).toBe(0);
    const freshData = JSON.parse(fresh.out).data as { contentActivating: boolean; message: { id: string } };
    expect(freshData.contentActivating).toBe(true);
    expect(fresh.stderr).toContain(`the content-state probe for message ${freshData.message.id} failed`);
    expect(fresh.stderr).toContain("content state could not be read");
    expect(fresh.stderr).toContain("database is locked");
    expect(fresh.stderr).not.toContain("committed none of the changes");
    const replay = run(submitArgs(f, "busy-probe-cli", ["--json"]));
    expect(replay.code, replay.stderr).toBe(0);
    const replayData = JSON.parse(replay.out).data as { contentActivating: boolean; replayed: boolean };
    expect(replayData.replayed).toBe(true);
    expect(replayData.contentActivating).toBe(true);
    expect(replay.stderr).not.toContain("committed none of the changes");
    const readonly = run(submitArgs(f, "busy-probe-cli", ["--json", "--replay-only"]));
    expect(readonly.code, readonly.stderr).toBe(0);
    expect((JSON.parse(readonly.out).data as { contentActivating: boolean }).contentActivating).toBe(true);
    expect(readonly.stderr).toContain("content state could not be read");
    expect(readonly.stderr).toContain("database is locked");
    expect(readonly.stderr).not.toContain("committed none of the changes");
    fault.busyProbe = false;
  });

  it("returns the committed handle decision with the unavailable-preview indicator", () => {
    const f = channelFixture();
    fault.preview = true;
    const submitted = run([
      "channel",
      "submit",
      f.channelId,
      "--as-participant",
      f.workerId,
      "--kind",
      "report",
      "--body",
      "preview body",
      "--json",
    ]);
    expect(submitted.code, submitted.stderr).toBe(0);
    const messageId = (JSON.parse(submitted.out).data as { message: { id: string } }).message.id;
    const handled = run([
      "channel",
      "handle",
      f.channelId,
      messageId,
      "--expected-row-version",
      "1",
      "--as-participant",
      f.mainId,
      "--json",
    ]);
    expect(handled.code, handled.stderr).toBe(0);
    const data = JSON.parse(handled.out).data as { bodyPreviewUnavailable: boolean; message: { handled: boolean } };
    expect(Object.keys(data).sort()).toEqual(["bodyPreviewUnavailable", "message"]);
    expect(data.bodyPreviewUnavailable).toBe(true);
    expect(data.message.handled).toBe(true);
  });
});

describe("Channel recovery rendering through the CLI", () => {
  it("renders the exact materializing message and recovery in JSON and human output", () => {
    const f = channelFixture();
    const submitted = run(submitArgs(f, "read-materializing", ["--json"]));
    expect(submitted.code, submitted.stderr).toBe(0);
    const messageId = (JSON.parse(submitted.out).data as { message: { id: string } }).message.id;
    // The record stays unmaterialized with no pending intent: the read-side
    // CONTENT_MATERIALIZING path, not a fresh activation attempt.
    const row = f.db
      .prepare("SELECT content_record_id AS contentId FROM channel_messages WHERE id = ?")
      .get(messageId) as { contentId: string };
    f.db.prepare("UPDATE content_records SET materialized = 0 WHERE id = ?").run(row.contentId);
    const json = run(["channel", "read", f.channelId, messageId, "--json"]);
    expect(json.code).toBe(75);
    const envelope = JSON.parse(json.stderr) as {
      error: { code: string; message: string; recovery?: { suggestedCommand: string } };
    };
    expect(envelope.error.code).toBe("CONTENT_MATERIALIZING");
    expect(envelope.error.message).toBe(
      "The message itself is committed and needs no resubmission; its file-backed content has not activated yet",
    );
    expect(envelope.error.recovery?.suggestedCommand).toBe(
      "Retry the read or wait after activation; the next process start retries the pending activation, and the message needs no resubmission",
    );
    const human = run(["channel", "read", f.channelId, messageId]);
    expect(human.code).toBe(75);
    expect(human.stderr).toContain("CONTENT_MATERIALIZING: The message itself is committed and needs no resubmission");
    expect(human.stderr).toContain(
      "Recovery: Retry the read or wait after activation; the next process start retries the pending activation",
    );
  });

  it("fills the integrity recovery on a Channel listing of a damaged content row", () => {
    const f = channelFixture();
    const submitted = run([
      "channel",
      "submit",
      f.channelId,
      "--as-participant",
      f.workerId,
      "--kind",
      "report",
      "--body",
      "damaged body",
      "--json",
    ]);
    expect(submitted.code, submitted.stderr).toBe(0);
    const messageId = (JSON.parse(submitted.out).data as { message: { id: string } }).message.id;
    const row = f.db
      .prepare("SELECT content_record_id AS contentId FROM channel_messages WHERE id = ?")
      .get(messageId) as { contentId: string };
    f.db.exec("PRAGMA foreign_keys = OFF");
    f.db.prepare("DELETE FROM content_records WHERE id = ?").run(row.contentId);
    const json = run(["channel", "messages", f.channelId, "--json"]);
    expect(json.code).toBe(73);
    const envelope = JSON.parse(json.stderr) as {
      error: { code: string; recovery?: { suggestedCommand: string } };
    };
    expect(envelope.error.code).toBe("STORAGE_INTEGRITY_ERROR");
    expect(envelope.error.recovery?.suggestedCommand).toBe(
      "Diagnose the installation with sorage doctor and sorage vault verify before further Channel work; any committed outcome already reported stands",
    );
    const human = run(["channel", "messages", f.channelId]);
    expect(human.code).toBe(73);
    expect(human.stderr).toContain(
      "Recovery: Diagnose the installation with sorage doctor and sorage vault verify before further Channel work; any committed outcome already reported stands",
    );
  });
});

describe("wait and filter outcomes through the CLI", () => {
  it("refuses an invalid kind or filter UUID immediately, exactly as the listing does, with and without --wait", () => {
    const f = channelFixture();
    const invalidKind = ["channel", "messages", f.channelId, "--kind", "bogus"];
    const invalidKindWait = [...invalidKind, "--wait", "--interval", "1", "--timeout", "30"];
    const invalidParticipant = ["channel", "messages", f.channelId, "--participant", "not-a-uuid"];
    const invalidChannel = ["channel", "messages", "not-a-uuid"];
    const invalidChannelWait = [...invalidChannel, "--wait", "--interval", "1", "--timeout", "30"];
    const cases: Array<{ args: string[]; code: number; name: string }> = [
      { args: invalidKind, code: 64, name: "CHN_INVALID_INPUT" },
      { args: invalidKindWait, code: 64, name: "CHN_INVALID_INPUT" },
      { args: invalidParticipant, code: 66, name: "CHN_PARTICIPANT_NOT_FOUND" },
      {
        args: [...invalidParticipant, "--wait", "--interval", "1", "--timeout", "30"],
        code: 66,
        name: "CHN_PARTICIPANT_NOT_FOUND",
      },
      { args: invalidChannel, code: 66, name: "CHN_NOT_FOUND" },
      { args: invalidChannelWait, code: 66, name: "CHN_NOT_FOUND" },
    ];
    for (const entry of cases) {
      const started = Date.now();
      const result = run([...entry.args, "--json"]);
      expect(result.code, JSON.stringify(entry.args)).toBe(entry.code);
      expect((JSON.parse(result.stderr) as { error: { code: string } }).error.code).toBe(entry.name);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    for (const [plain, waited] of [
      [invalidKind, invalidKindWait],
      [invalidParticipant, [...invalidParticipant, "--wait", "--interval", "1", "--timeout", "30"]],
    ] as Array<[string[], string[]]>) {
      const plainResult = run([...plain, "--json"]);
      const waitedResult = run([...waited, "--json"]);
      expect((JSON.parse(waitedResult.stderr) as { error: unknown }).error).toEqual(
        (JSON.parse(plainResult.stderr) as { error: unknown }).error,
      );
    }
  });

  it("survives a retryable Channel listing failure and returns the existing pending message", () => {
    const f = channelFixture();
    const submitted = run([
      "channel",
      "submit",
      f.channelId,
      "--as-participant",
      f.workerId,
      "--kind",
      "report",
      "--body",
      "wait arrival",
      "--json",
    ]);
    expect(submitted.code, submitted.stderr).toBe(0);
    fault.listFailures = 1;
    const waited = run(["channel", "messages", f.channelId, "--wait", "--interval", "1", "--timeout", "5", "--json"]);
    expect(waited.code, waited.stderr).toBe(0);
    const envelope = JSON.parse(waited.out) as { data: { items: Array<{ id: string }> }; meta: { timedOut?: boolean } };
    expect(envelope.data.items).toHaveLength(1);
    expect(envelope.meta.timedOut).toBeUndefined();
  });

  it("reports a persistent Channel listing failure as the typed exit-75 envelope", () => {
    const f = channelFixture();
    fault.listFailures = 99;
    const waited = run(["channel", "messages", f.channelId, "--wait", "--interval", "1", "--timeout", "1", "--json"]);
    expect(waited.code).toBe(75);
    const envelope = JSON.parse(waited.stderr) as { error: { code: string }; meta: { timedOut?: boolean } };
    expect(envelope.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(envelope.meta.timedOut).toBeUndefined();
  });

  it("keeps an ordinary empty Channel timeout at exit 0 with meta.timedOut", () => {
    const f = channelFixture();
    const waited = run(["channel", "messages", f.channelId, "--wait", "--interval", "1", "--timeout", "1", "--json"]);
    expect(waited.code, waited.stderr).toBe(0);
    const envelope = JSON.parse(waited.out) as { data: { items: unknown[] }; meta: { timedOut?: boolean } };
    expect(envelope.data.items).toEqual([]);
    expect(envelope.meta.timedOut).toBe(true);
  });

  it("survives a retryable Handoff inbox seed failure and times out at exit 0", () => {
    channelFixture();
    fault.handoffListFailures = 1;
    const waited = run(["inbox", "--as", "memo", "--wait", "--interval", "1", "--timeout", "3", "--json"]);
    expect(waited.code, waited.stderr).toBe(0);
    const envelope = JSON.parse(waited.out) as { data: { handoffs: unknown[] }; meta: { timedOut?: boolean } };
    expect(envelope.data.handoffs).toEqual([]);
    expect(envelope.meta.timedOut).toBe(true);
  });

  it("reports a persistent Handoff inbox seed failure as the typed exit-75 envelope", () => {
    channelFixture();
    fault.handoffListFailures = 99;
    const waited = run(["inbox", "--as", "memo", "--wait", "--interval", "1", "--timeout", "1", "--json"]);
    expect(waited.code).toBe(75);
    const envelope = JSON.parse(waited.stderr) as { error: { code: string }; meta: { timedOut?: boolean } };
    expect(envelope.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(envelope.meta.timedOut).toBeUndefined();
  });

  it("fails an unknown participant filter immediately at exit 66 with and without --wait", () => {
    const f = channelFixture();
    const unknown = "99999999-9999-4999-8999-999999999999";
    const plain = run(["channel", "messages", f.channelId, "--participant", unknown, "--json"]);
    expect(plain.code).toBe(66);
    expect((JSON.parse(plain.stderr) as { error: { code: string } }).error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const started = Date.now();
    const waited = run([
      "channel",
      "messages",
      f.channelId,
      "--participant",
      unknown,
      "--wait",
      "--interval",
      "1",
      "--timeout",
      "30",
      "--json",
    ]);
    expect(waited.code).toBe(66);
    expect((JSON.parse(waited.stderr) as { error: { code: string } }).error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    expect(Date.now() - started).toBeLessThan(5_000);
    const assignment = run(["channel", "messages", f.channelId, "--assignment", unknown, "--wait", "--json"]);
    expect(assignment.code).toBe(66);
    expect((JSON.parse(assignment.stderr) as { error: { code: string } }).error.code).toBe("CHN_ASSIGNMENT_NOT_FOUND");
  });
});
