import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BINARY, envelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

afterEach(runCleanups);

/**
 * The TASK-123 rebuilt multi-process Channel concurrency (AJ-28 step 6, plan
 * §7): several compiled posting processes start together with one compiled
 * waiter on one real installation, and the run proves the three invariants of
 * the per-Channel sequence number — no message lost (a dense `seq` with no
 * gap), none duplicated or misattributed (every post result is either a fresh
 * `seq` whose sender matches its poster or `duplicate: true` naming an
 * existing identical message), and a racing ack that names an impossible
 * sequence number commits nothing (CHN-006 all-or-nothing). At least two
 * posters send byte-identical content from the same handle — exactly one
 * fresh `seq` and one `duplicate: true` — and identical content from
 * different handles yields two messages. Everything is real: compiled
 * binaries, one shared database, no mocks.
 */
interface PostOutcome {
  poster: string;
  from: string;
  body: string;
  status: number | null;
  seq: number | null;
  duplicate: boolean | null;
  code: string | null;
}

function readOutcome(poster: string, from: string, body: string, text: string): PostOutcome {
  const outcome: PostOutcome = { poster, from, body, status: null, seq: null, duplicate: null, code: null };
  try {
    const envelope = JSON.parse(text) as {
      ok: boolean;
      data?: { message: { seq: number }; duplicate: boolean };
      error?: { code: string };
    };
    if (envelope.ok && envelope.data !== undefined) {
      outcome.seq = envelope.data.message.seq;
      outcome.duplicate = envelope.data.duplicate;
    } else if (envelope.error !== undefined) {
      outcome.code = envelope.error.code;
    }
  } catch {
    // A non-JSON line is a hard failure the assertion below surfaces.
  }
  return outcome;
}

function spawnPoster(home: string, from: string, body: string): { poster: string; done: Promise<PostOutcome> } {
  const poster = `${from}:${body.slice(0, 6)}`;
  const child = spawn(BINARY, ["channel", "post", "c", "--from", from, "--kind", "report", "--body", body, "--json"], {
    cwd: home,
    env: { ...process.env, SORAGE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const done = new Promise<PostOutcome>((resolve) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (status) => {
      const outcome = readOutcome(poster, from, body, stdout || stderr);
      outcome.status = status;
      resolve(outcome);
    });
  });
  return { poster, done };
}

describe("TASK-123 rebuilt multi-process Channel concurrency", () => {
  it("loses, duplicates, and misattributes no message across concurrent posters with one waiter", async () => {
    if (!existsSync(BINARY)) throw new Error("the compiled binary is missing; run make package first");
    const home = makeTempDir("t123-concurrency-");
    const init = sorage(["init", "--non-interactive"], { home });
    expect(init.status, init.stderr).toBe(0);
    for (const args of [
      ["channel", "create", "c"],
      ["channel", "add", "c", "w1", "--role", "worker"],
      ["channel", "add", "c", "w2", "--role", "worker"],
      ["channel", "add", "c", "w3", "--role", "judge"],
    ]) {
      const seeded = sorage([...args, "--json"], { home });
      expect(seeded.status, seeded.stderr).toBe(0);
    }
    // Seed one message before the posters so the racing ack has a known
    // valid seq to name beside an impossible one (decision item 9).
    const seeded = sorage(["channel", "post", "c", "--from", "w1", "--kind", "report", "--body", "seeded", "--json"], {
      home,
    });
    expect(seeded.status, seeded.stderr).toBe(0);
    // The waiter starts on an empty *filter* (--after the seed) before the
    // posters fire; its first poll is the start admission. Item 7: a lead-in
    // of two poll intervals (1 s each) of undisturbed time, then the proof
    // that the waiter has not exited when the posters start — there was no
    // early return. No observable empty-poll signal exists without a product
    // or production-hook change (recorded in the report).
    const waiter = spawn(
      BINARY,
      ["channel", "messages", "c", "--after", "1", "--wait", "--timeout", "60", "--interval", "1", "--json"],
      {
        cwd: home,
        env: { ...process.env, SORAGE_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let waiterOut = "";
    const waiterDone = new Promise<{ status: number | null; items: Array<{ seq: number; from: string }> }>(
      (resolve) => {
        waiter.stdout?.on("data", (chunk: Buffer) => {
          waiterOut += chunk.toString("utf8");
        });
        waiter.on("close", (status) => {
          try {
            const envelope = JSON.parse(waiterOut) as { data: { items: Array<{ seq: number; from: string }> } };
            resolve({ status, items: envelope.data.items });
          } catch {
            resolve({ status, items: [] });
          }
        });
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(waiter.exitCode, "the waiter is still waiting when the posters start").toBeNull();
    expect(waiterOut, "the waiter has printed nothing before the posters start").toBe("");

    // Posters: two identical bodies from the SAME handle (the duplicate
    // window), identical content from DIFFERENT handles, and distinct bodies.
    const spawned = [
      spawnPoster(home, "w1", "identical body"),
      spawnPoster(home, "w1", "identical body"),
      spawnPoster(home, "w2", "identical body"),
      spawnPoster(home, "w2", "distinct alpha"),
      spawnPoster(home, "w3", "distinct beta"),
      spawnPoster(home, "w3", "distinct beta"),
    ];
    // The racing ack runs concurrently with the posters: it is spawned
    // before any poster is awaited and names the seeded seq (1, known valid
    // before the posters started) beside an impossible one, so all-or-nothing
    // refuses it while the posters hold the write lock in turn (item 9).
    const impossible = 10_000;
    const racing = spawn(BINARY, ["channel", "ack", "c", "1", String(impossible), "--json"], {
      cwd: home,
      env: { ...process.env, SORAGE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let racingOut = "";
    let racingErr = "";
    const racingDone = new Promise<{ status: number | null; code: string | null }>((resolve) => {
      racing.stdout?.on("data", (chunk: Buffer) => {
        racingOut += chunk.toString("utf8");
      });
      racing.stderr?.on("data", (chunk: Buffer) => {
        racingErr += chunk.toString("utf8");
      });
      racing.on("close", (status) => {
        let code: string | null = null;
        try {
          code = (JSON.parse(racingOut || racingErr) as { error?: { code: string } }).error?.code ?? null;
        } catch {
          code = null;
        }
        resolve({ status, code });
      });
    });

    const outcomes = await Promise.all(spawned.map((entry) => entry.done));
    for (const outcome of outcomes) {
      expect(outcome.status, `${outcome.poster}: exit`).toBe(0);
      expect(outcome.code, `${outcome.poster}: no typed refusal`).toBeNull();
    }
    // The same-handle identical pair: exactly one fresh seq and one duplicate.
    const sameHandle = outcomes.filter((outcome) => outcome.poster === "w1:identi");
    const freshSame = sameHandle.filter((outcome) => outcome.duplicate === false);
    const duplicateSame = sameHandle.filter((outcome) => outcome.duplicate === true);
    expect(freshSame).toHaveLength(1);
    expect(duplicateSame).toHaveLength(1);
    // Identical content from different handles yields two messages.
    const acrossHandles = outcomes.filter(
      (outcome) => (outcome.poster === "w1:identi" || outcome.poster === "w2:identi") && outcome.duplicate === false,
    );
    expect(acrossHandles).toHaveLength(2);
    // The w3 pair repeats the same-handle rule.
    const w3Pair = outcomes.filter((outcome) => outcome.from === "w3");
    expect(w3Pair.filter((outcome) => outcome.duplicate === false)).toHaveLength(1);
    expect(w3Pair.filter((outcome) => outcome.duplicate === true)).toHaveLength(1);
    // No message lost: a dense 1..N sequence with no gap.
    const freshSeqs = outcomes
      .filter((outcome) => outcome.duplicate === false)
      .map((outcome) => outcome.seq as number)
      .sort((left, right) => left - right);
    expect(freshSeqs).toEqual([2, 3, 4, 5]);
    // Every duplicate names the seq of the fresh message with the same
    // handle and body — its exact original (decision item 9).
    const freshByHandleBody = new Map<string, number>();
    for (const outcome of outcomes) {
      if (outcome.duplicate === false)
        freshByHandleBody.set(`${outcome.from}\u0000${outcome.body}`, outcome.seq as number);
    }
    for (const outcome of outcomes) {
      if (outcome.duplicate === true) {
        const original = freshByHandleBody.get(`${outcome.from}\u0000${outcome.body}`);
        expect(original, `${outcome.poster} names its original`).toBeDefined();
        expect(outcome.seq).toBe(original);
      }
    }
    // Attribution joined per seq: each fresh poster's returned seq maps, in
    // the authoritative listing, to exactly its own handle and body.
    const listed = sorage(["channel", "messages", "c", "--all", "--json"], { home });
    expect(listed.status, listed.stderr).toBe(0);
    const items = (envelopeOf(listed).data as { items: Array<{ seq: number; from: string; body: string }> }).items;
    expect(items.map((item) => item.seq)).toEqual([1, ...freshSeqs]);
    const bySeq = new Map(items.map((item) => [item.seq, item]));
    for (const outcome of outcomes) {
      if (outcome.duplicate === false) {
        const entry = bySeq.get(outcome.seq as number);
        expect(entry, `${outcome.poster} seq in listing`).toBeDefined();
        expect(entry?.from, `${outcome.poster} attribution`).toBe(outcome.from);
        expect(entry?.body, `${outcome.poster} body`).toBe(outcome.body);
      }
    }
    // The waiter woke with at least one unhandled message, exit 0.
    const waited = await waiterDone;
    expect(waited.status).toBe(0);
    expect(waited.items.length).toBeGreaterThanOrEqual(1);
    const raced = await racingDone;
    expect(raced.status).toBe(66);
    expect(raced.code).toBe("CHN_MESSAGE_NOT_FOUND");
    const afterRace = sorage(["channel", "messages", "c", "--json"], { home });
    expect(afterRace.status, afterRace.stderr).toBe(0);
    expect((envelopeOf(afterRace).data as { items: unknown[] }).items).toHaveLength(5);
    // No ACKED event was appended and the named seq stays unhandled.
    const eventsProbe = new DatabaseSync(join(home, "state", "sorage.sqlite3"), { readOnly: true });
    try {
      const acked = eventsProbe
        .prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'CHANNEL_MESSAGE_ACKED'")
        .get() as { n: number };
      expect(acked.n).toBe(0);
    } finally {
      eventsProbe.close();
    }
  });
});
