import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, errorEnvelopeOf, runCleanups, sorage, twoProjectFixture, BINARY } from "./helpers";
import { withFifo } from "./fifo";

/**
 * AJ-08: conflicts, idempotency replay, and a journey-level crash with restart drain.
 * The crash is externally deterministic: the send reads a FIFO whose writer never
 * finishes, so the process is killed mid-staging and the restart must drain and
 * answer a clean vault; the full CP-1 to CP-7 matrix stays pinned by the
 * failure-injection integration suites that own it.
 */
afterAll(runCleanups);

describe("AJ-08 conflicts, replay, and crash recovery", () => {
  it("loses cleanly against a stale Row Version", () => {
    const fixture = twoProjectFixture("aj08-stale");
    const id = fixture.sendTo("a", "b", "Stale");
    expect(
      sorage(["review", "set", id, "--text", "Bump", "--json"], { home: fixture.home, cwd: fixture.workB }).status,
    ).toBe(0);
    // The Note must be resolved first, or the accept answers REVIEW_NOTE_PRESENT;
    // with no Note left, only the stale Row Version can refuse the accept.
    expect(sorage(["review", "withdraw", id, "--json"], { home: fixture.home, cwd: fixture.workB }).status).toBe(0);
    const stale = sorage(["accept", id, "--expected-revision", "1", "--expected-row-version", "1", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(stale.status).toBe(75);
    expect(errorEnvelopeOf(stale).error.code).toBe("ROW_VERSION_CONFLICT");
  });

  it("replays an identical request and refuses a different one under the same key", () => {
    const fixture = twoProjectFixture("aj08-replay");
    const key = "11111111-1111-4111-8111-111111111111";
    const first = sorage(
      ["send", "--to", "beta", "--title", "Replay", "--body", "# Original", "--idempotency-key", key, "--json"],
      {
        home: fixture.home,
        cwd: fixture.workA,
      },
    );
    expect(first.status).toBe(0);
    const originalId = (envelopeOf(first) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId as string;
    const replay = sorage(
      ["send", "--to", "beta", "--title", "Replay", "--body", "# Original", "--idempotency-key", key, "--json"],
      {
        home: fixture.home,
        cwd: fixture.workA,
      },
    );
    expect(replay.status).toBe(0);
    const replayEnvelope = envelopeOf(replay) as {
      data: { handoffs: Array<{ handoffId: string }>; replayed: boolean };
    };
    expect(replayEnvelope.data.replayed).toBe(true);
    expect(replayEnvelope.data.handoffs[0]?.handoffId).toBe(originalId);

    const conflict = sorage(
      ["send", "--to", "beta", "--title", "Replay", "--body", "# Different", "--idempotency-key", key, "--json"],
      {
        home: fixture.home,
        cwd: fixture.workA,
      },
    );
    expect(conflict.status).toBe(75);
    expect(errorEnvelopeOf(conflict).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("recovers from a kill mid-send: the restart drains, verifies, and retries to exactly one Handoff", () => {
    const fixture = twoProjectFixture("aj08-crash");
    const key = "22222222-2222-4222-8222-222222222222";
    withFifo((fifo) => {
      const child = spawn(
        BINARY,
        [
          "send",
          "--to",
          "beta",
          "--title",
          "Crash",
          "--file",
          fifo,
          "--allow-external-source",
          "--idempotency-key",
          key,
          "--json",
        ],
        {
          cwd: fixture.workA,
          env: { ...process.env, SORAGE_HOME: fixture.home },
          stdio: "ignore",
        },
      );
      // The FIFO read blocks the staging copy; kill the process mid-operation.
      const killer = spawn("sh", ["-c", `sleep 0.8; kill -9 ${child.pid as number}`], { stdio: "ignore" });
      child.on("exit", () => undefined);
      killer.unref();
    });

    // The restart drains at start and both reports come back clean.
    const doctor = sorage(["doctor", "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(doctor.status).toBe(0);
    const verify = sorage(["vault", "verify", "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(verify.status).toBe(0);

    // The same-key retry creates exactly one Handoff.
    const retry = sorage(
      ["send", "--to", "beta", "--title", "Crash", "--body", "# After the crash", "--idempotency-key", key, "--json"],
      {
        home: fixture.home,
        cwd: fixture.workA,
      },
    );
    expect(retry.status).toBe(0);
    const outbox = sorage(["outbox", "--json"], { home: fixture.home, cwd: fixture.workA });
    const matches = (envelopeOf(outbox) as { data: { handoffs: Array<{ title: string }> } }).data.handoffs.filter(
      (handoff) => handoff.title === "Crash",
    );
    expect(matches).toHaveLength(1);
    const verify2 = sorage(["vault", "verify", "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(verify2.status).toBe(0);
  }, 30_000);
});
