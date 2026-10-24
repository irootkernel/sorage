import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appError, err } from "@sorage/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/main";
import { memoCliFixture } from "../fixtures/memo-cli";

/**
 * The TASK-123 rebuilt Channel result semantics through the actual CLI
 * (CHN-005, CHN-012, interface sections 38.4 to 38.6): a committed post whose
 * file-backed activation pauses returns its committed envelope with
 * `bodyPending: true` and a contained warning, never a plain failure; the
 * duplicate-by-content rule returns the original with `duplicate: true`
 * through the CLI; the wait's three deadline outcomes; the immediate
 * not-found filter refusals; and a failure persisting at the wait's deadline
 * is the typed error with exit 75 and no `meta.timedOut`. Faults are injected
 * only after real domain commits or on the listing seam; the actual CLI,
 * envelope renderer, SQLite rows, and content storage still run.
 */
const fault = vi.hoisted(() => ({
  activation: "none" as "none" | "paused",
  listFailures: 0,
  /** How many activations the paused fault answered and how many listings it failed: every injection proves it ran. */
  pausedActivations: 0,
  failedListings: 0,
}));

/**
 * The covered-read storage seam of the wait: `beforeOpen` runs before the
 * n-th `openCoveredReadStorage` call of the test (1 is the start admission,
 * whose listing is the wait's first poll; 2 is the second poll's open), so a
 * test can change the on-disk state or stall exactly there and record that it
 * did.
 */
const readStorage = vi.hoisted(() => ({
  calls: 0,
  beforeOpen: null as ((call: number) => void) | null,
}));

vi.mock("@sorage/adapters/src/read-storage", async (original) => {
  const actual = await original<typeof import("@sorage/adapters/src/read-storage")>();
  return {
    ...actual,
    openCoveredReadStorage: (...args: Parameters<typeof actual.openCoveredReadStorage>) => {
      readStorage.calls += 1;
      readStorage.beforeOpen?.(readStorage.calls);
      return actual.openCoveredReadStorage(...args);
    },
  };
});

vi.mock("@sorage/adapters/src/channel-command-ports", async (original) => {
  const actual = await original<typeof import("@sorage/adapters/src/channel-command-ports")>();
  return {
    ...actual,
    createNodeChannelPorts: (...args: Parameters<typeof actual.createNodeChannelPorts>) => {
      const ports = actual.createNodeChannelPorts(...args);
      if (fault.activation === "paused") {
        const activate = ports.staging.activateContent;
        ports.staging.activateContent = (...activateArgs: Parameters<typeof activate>) => {
          // Report the paused outcome without touching the real Vault: the
          // pause path's contract is the committed envelope plus warning.
          void activateArgs;
          fault.pausedActivations += 1;
          return { ok: true, value: { status: "paused" as const } } as unknown as ReturnType<typeof activate>;
        };
      }
      if (fault.listFailures > 0) {
        // The budget is global to the test, not per composition: the wait
        // re-admits storage on every poll and each poll builds fresh ports.
        const page = ports.channels.read;
        ports.channels.read = (<T>(...readArgs: Parameters<typeof page>) => {
          if (fault.listFailures > 0) {
            fault.listFailures -= 1;
            fault.failedListings += 1;
            return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "injected listing failure")) as unknown as {
              ok: true;
              value: T;
            };
          }
          return page(...readArgs) as unknown as { ok: true; value: T };
        }) as typeof page;
      }
      return ports;
    },
  };
});

const fixtures: Array<ReturnType<typeof memoCliFixture>> = [];
const previousHome = process.env.SORAGE_HOME;
afterEach(() => {
  Object.assign(fault, { activation: "none", listFailures: 0, pausedActivations: 0, failedListings: 0 });
  Object.assign(readStorage, { calls: 0, beforeOpen: null });
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

interface Fixture extends ReturnType<typeof memoCliFixture> {
  bodyFile: string;
}

function fixture(): Fixture {
  const base = memoCliFixture();
  fixtures.push(base);
  process.env.SORAGE_HOME = base.home;
  const created = run(["channel", "create", "aq-rs", "--main", "orchestrator", "--json"]);
  if (created.code !== 0) throw new Error(created.stderr);
  const added = run(["channel", "add", "aq-rs", "w1", "--role", "worker", "--json"]);
  if (added.code !== 0) throw new Error(added.stderr);
  const bodyFile = join(base.home, "large-body.txt");
  writeFileSync(bodyFile, `${"y".repeat(70_000)}\n`);
  return { ...base, bodyFile };
}

const envelope = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

const cliEntry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

/** Spawns one real CLI process against the fixture home, for wait arrivals. */
function spawnArrival(f: Fixture, args: string[]): void {
  const child = spawn("bun", [cliEntry, ...args], {
    env: { ...process.env, SORAGE_HOME: f.home },
    stdio: "ignore",
  });
  child.on("error", () => undefined);
}

describe("the rebuilt committed-post semantics through the CLI", () => {
  it("returns the committed post envelope with bodyPending and the pause warning when the activation pauses", () => {
    const f = fixture();
    fault.activation = "paused";
    const posted = run([
      "channel",
      "post",
      "aq-rs",
      "--from",
      "w1",
      "--kind",
      "report",
      "--body-file",
      f.bodyFile,
      "--json",
    ]);
    expect(posted.code, posted.stderr).toBe(0);
    expect(fault.pausedActivations, "the paused activation executed").toBeGreaterThanOrEqual(1);
    const data = (envelope(posted.out) as { data: { message: Record<string, unknown>; duplicate: boolean } }).data;
    expect(data.duplicate).toBe(false);
    expect(data.message.bodyPending).toBe(true);
    expect(data.message.body).toBeNull();
    expect(data.message.bodyPath).toBeNull();
    expect(data.message.seq).toBe(1);
    expect(posted.stderr).toContain("warning:");
    expect(posted.stderr).toContain("paused behind a held Vault-move lock");
    // The human form keeps the same honesty: the committed line plus the
    // pending body, never an unobserved activation.
    const human = run(["channel", "post", "aq-rs", "--from", "w1", "--kind", "report", "--body-file", f.bodyFile]);
    expect(human.code).toBe(0);
    // The duplicate of the paused original: the committed line prints with
    // its honest body state and the duplicate line; never a failure, and no
    // warning — nothing changed on the duplicate path.
    expect(human.out).toContain("#1 [report] w1");
    expect(human.out).toContain("Duplicate of the original unhandled message");
  });

  it("keeps the committed envelope when the warning sink throws", () => {
    const f = fixture();
    fault.activation = "paused";
    const posted = run(
      ["channel", "post", "aq-rs", "--from", "w1", "--kind", "report", "--body-file", f.bodyFile, "--json"],
      true,
    );
    expect(posted.code).toBe(0);
    expect(fault.pausedActivations, "the paused activation executed").toBeGreaterThanOrEqual(1);
    const data = (envelope(posted.out) as { data: { message: { bodyPending: boolean } } }).data;
    expect(data.message.bodyPending).toBe(true);
  });

  it("returns the original message with duplicate: true for an identical retry, and a new message after ack", () => {
    const _f = fixture();
    const first = run([
      "channel",
      "post",
      "aq-rs",
      "--from",
      "w1",
      "--kind",
      "report",
      "--ref",
      "pr-1",
      "--body",
      "same body",
      "--json",
    ]);
    expect(first.code).toBe(0);
    const retry = run([
      "channel",
      "post",
      "aq-rs",
      "--from",
      "w1",
      "--kind",
      "report",
      "--ref",
      "pr-1",
      "--body",
      "same body",
      "--json",
    ]);
    expect(retry.code).toBe(0);
    const retryData = (envelope(retry.out) as { data: { message: { seq: number }; duplicate: boolean } }).data;
    expect(retryData.duplicate).toBe(true);
    expect(retryData.message.seq).toBe(1);
    const acked = run(["channel", "ack", "aq-rs", "1", "--json"]);
    expect(acked.code).toBe(0);
    const after = run([
      "channel",
      "post",
      "aq-rs",
      "--from",
      "w1",
      "--kind",
      "report",
      "--ref",
      "pr-1",
      "--body",
      "same body",
      "--json",
    ]);
    const afterData = (envelope(after.out) as { data: { message: { seq: number }; duplicate: boolean } }).data;
    expect(afterData.duplicate).toBe(false);
    expect(afterData.message.seq).toBe(2);
  });

  it("answers the wait's three deadline outcomes", () => {
    const f = fixture();
    // Immediate return: an unhandled message already matches.
    const posted = run([
      "channel",
      "post",
      "aq-rs",
      "--from",
      "w1",
      "--kind",
      "report",
      "--body",
      "wake body",
      "--json",
    ]);
    expect(posted.code).toBe(0);
    const immediate = run(["channel", "messages", "aq-rs", "--wait", "--timeout", "2", "--json"]);
    expect(immediate.code).toBe(0);
    const immediateParsed = envelope(immediate.out) as {
      data: { items: Array<{ seq: number }> };
      meta: { timedOut?: boolean };
    };
    expect(immediateParsed.data.items.map((item) => item.seq)).toEqual([1]);
    expect(immediateParsed.meta.timedOut).toBeUndefined();
    // Empty timeout: exit 0 with meta.timedOut and the empty list.
    const timeout = run(["channel", "messages", "aq-rs", "--after", "1", "--wait", "--timeout", "1", "--json"]);
    expect(timeout.code).toBe(0);
    const timeoutParsed = envelope(timeout.out) as { data: { items: unknown[] }; meta: { timedOut?: boolean } };
    expect(timeoutParsed.data.items).toEqual([]);
    expect(timeoutParsed.meta.timedOut).toBe(true);
    // Arrival: a peer process posts while the wait polls; the wait returns the
    // arrival with exit 0, the full body and no meta.timedOut.
    spawnArrival(f, [
      "channel",
      "post",
      "aq-rs",
      "--from",
      "w1",
      "--kind",
      "question",
      "--body",
      "later body",
      "--json",
    ]);
    const arrival = run([
      "channel",
      "messages",
      "aq-rs",
      "--after",
      "1",
      "--wait",
      "--timeout",
      "15",
      "--interval",
      "1",
      "--json",
    ]);
    expect(arrival.code, arrival.stderr).toBe(0);
    const arrivalParsed = envelope(arrival.out) as {
      data: { items: Array<{ seq: number; body: string }> };
      meta: { timedOut?: boolean };
    };
    expect(arrivalParsed.meta.timedOut).toBeUndefined();
    expect(arrivalParsed.data.items.map((item) => [item.seq, item.body])).toEqual([[2, "later body"]]);
  });

  it("reports a listing failure that persists at the deadline as the typed error with exit 75 and no timedOut", () => {
    fixture();
    fault.listFailures = 100;
    const waited = run(["channel", "messages", "aq-rs", "--wait", "--timeout", "1", "--json"]);
    expect(waited.code).toBe(75);
    // The start listing and at least one later poll failed through the fault.
    expect(fault.failedListings, "the listing fault executed").toBeGreaterThanOrEqual(2);
    const parsed = envelope(waited.stderr) as {
      error: { code: string; message: string };
      meta: { timedOut?: boolean };
    };
    expect(parsed.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(parsed.meta.timedOut).toBeUndefined();
  });

  it("keeps a wait running when its --from handle is removed before the second storage open (decision item 5; C3 item 1)", () => {
    const f = fixture();
    let removedBeforeOpen: number | null = null;
    const openedAt: number[] = [];
    readStorage.beforeOpen = (call) => {
      openedAt.push(Date.now());
      // The first open is the start admission, whose listing validates the
      // filter and is the first poll. The removal lands before the second open
      // returns, so that poll's storage already holds w1 as removed: a roster
      // re-validation there would end the wait with the typed handle refusal,
      // which this regression forbids.
      if (call === 2) {
        const child = spawnSync("bun", [cliEntry, "channel", "remove", "aq-rs", "w1", "--json"], {
          env: { ...process.env, SORAGE_HOME: f.home },
          encoding: "utf8",
        });
        expect(child.status, child.stderr).toBe(0);
        removedBeforeOpen = call;
      }
    };
    const wait = run([
      "channel",
      "messages",
      "aq-rs",
      "--from",
      "w1",
      "--wait",
      "--timeout",
      "2",
      "--interval",
      "1",
      "--json",
    ]);
    // The injection ran, before the second open, and the removal is on disk.
    expect(removedBeforeOpen).toBe(2);
    expect(readStorage.calls).toBeGreaterThanOrEqual(2);
    // No second listing at invocation: the second storage open is the second
    // poll, one interval after the start listing.
    expect((openedAt[1] ?? 0) - (openedAt[0] ?? 0)).toBeGreaterThanOrEqual(900);
    const shown = run(["channel", "show", "aq-rs", "--json"]);
    const roster = (
      envelope(shown.out) as {
        data: { channel: { participants: Array<{ handle: string; removedAt: string | null }> } };
      }
    ).data.channel.participants;
    expect(roster.find((participant) => participant.handle === "w1")?.removedAt).not.toBeNull();
    // The wait ran to its timeout: exit 0 with meta.timedOut, never
    // CHN_PARTICIPANT_NOT_FOUND.
    expect(wait.code, wait.stderr).toBe(0);
    const parsed = JSON.parse(wait.out) as { data: { items: unknown[] }; meta: { timedOut?: boolean } };
    expect(parsed.data.items).toEqual([]);
    expect(parsed.meta.timedOut).toBe(true);
  });

  it("retries a read-side contention on the first listing until the deadline and reports the persistent typed error (decision item 5)", () => {
    fixture();
    fault.listFailures = 1;
    const wait = run(["channel", "messages", "aq-rs", "--after", "1", "--wait", "--timeout", "1", "--json"]);
    expect(wait.code).toBe(0);
    // Exactly the start listing failed through the fault; the next poll served.
    expect(fault.failedListings, "the one-shot listing fault executed").toBe(1);
    expect(fault.listFailures).toBe(0);
    const parsed = JSON.parse(wait.out) as { data: { items: unknown[] }; meta: { timedOut?: boolean } };
    expect(parsed.data.items).toEqual([]);
    expect(parsed.meta.timedOut).toBe(true);
    // A contention persisting to the deadline is the typed error with exit 75.
    fault.failedListings = 0;
    fault.listFailures = 100;
    const persistent = run(["channel", "messages", "aq-rs", "--after", "1", "--wait", "--timeout", "1", "--json"]);
    expect(persistent.code).toBe(75);
    expect(fault.failedListings, "the persistent listing fault executed").toBeGreaterThanOrEqual(2);
    const envelope = JSON.parse(persistent.stderr) as { error: { code: string }; meta: { timedOut?: boolean } };
    expect(envelope.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(envelope.meta.timedOut).toBeUndefined();
  });

  it("measures the deadline from invocation: a stalled start admission consumes the wait's own budget (decision item 5; C3 item 2)", () => {
    fixture();
    let stalled = 0;
    readStorage.beforeOpen = (call) => {
      // The first open is the start admission. Stalling it ~1.2 s before it
      // runs makes a deadline computed after the start work let a 2 s wait run
      // ~3.2 s; a deadline stamped at invocation ends it at ~2 s.
      if (call === 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
        stalled += 1;
      }
    };
    const started = Date.now();
    const wait = run(["channel", "messages", "aq-rs", "--after", "1", "--wait", "--timeout", "2", "--json"]);
    const elapsed = Date.now() - started;
    expect(stalled, "the stall executed on the start admission").toBe(1);
    expect(wait.code, wait.stderr).toBe(0);
    const parsed = JSON.parse(wait.out) as { meta: { timedOut?: boolean } };
    expect(parsed.meta.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2800);
  });

  it("fails unknown filters immediately with exit 66", () => {
    const f = fixture();
    const posted = run(["channel", "post", "aq-rs", "--from", "w1", "--kind", "report", "--body", "b", "--json"]);
    expect(posted.code).toBe(0);
    const ghost = run(["channel", "messages", "aq-rs", "--from", "ghost", "--json"]);
    expect(ghost.code).toBe(66);
    const waitGhost = run(["channel", "messages", "aq-rs", "--from", "ghost", "--wait", "--timeout", "1", "--json"]);
    expect(waitGhost.code).toBe(66);
    void f;
  });
});
