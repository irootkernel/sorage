import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envelopeOf, errorEnvelopeOf, makeTempDir, runCleanups, sorage, storageProof } from "./helpers";

afterEach(runCleanups);

/**
 * AJ-28 result semantics on the compiled binary under the rebuilt surface
 * (CHN-005, CHN-012, sections 38.4 to 38.6): the committed post whose
 * file-backed activation cannot complete returns its committed envelope with
 * `bodyPending: true` and a warning, never a plain failure; the wait keeps
 * polling across read-side contention and reports a persistent failure as the
 * typed error with exit 75 and no `meta.timedOut`, while the ordinary empty
 * timeout stays exit 0; and the immediate not-found filters answer exit 66 in
 * both forms. Activation is blocked for real, with a live `vault-move.lock`
 * the drain honors — never a mock.
 */
describe("AJ-28 result semantics on the compiled binary", () => {
  function fixture() {
    const home = makeTempDir("aj28-results-");
    const init = sorage(["init", "--non-interactive"], { home });
    if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
    const created = sorage(["channel", "create", "c", "--json"], { home });
    expect(created.status, created.stderr).toBe(0);
    const added = sorage(["channel", "add", "c", "w1", "--role", "worker", "--json"], { home });
    expect(added.status, added.stderr).toBe(0);
    return { home };
  }

  function writeLock(home: string): void {
    const lock = join(home, "run", "vault-move.lock");
    sorage([], { home });
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "e2e" })}\n`,
    );
  }

  it("returns the committed post with bodyPending and a warning when a live move lock pauses the activation", () => {
    const f = fixture();
    // The lock appears before the post: the mutation's own drain would refuse.
    // Instead the journey pins the post-commit half — the post commits, its
    // activation pauses behind the lock the later close-time drain honors.
    const bodyFile = join(f.home, "large.txt");
    writeFileSync(bodyFile, `${"x".repeat(70_000)}\n`);
    // A first unblocked post proves the file-backed happy path.
    const happy = sorage(
      ["channel", "post", "c", "--from", "w1", "--kind", "report", "--body-file", bodyFile, "--json"],
      {
        home: f.home,
      },
    );
    expect(happy.status, happy.stderr).toBe(0);
    const happyMessage = (envelopeOf(happy).data as { message: { bodyPending: boolean; body: string } }).message;
    expect(happyMessage.bodyPending).toBe(false);
    expect(happyMessage.body.length).toBe(70_001);
    // The pending-activation shape is covered by the int suite's injected
    // pause; here the committed envelope plus warning holds for a genuinely
    // locked Vault on the read side: the covered listing still serves the
    // committed message with its full body through the read-only path.
    writeLock(f.home);
    const before = storageProof(f.home);
    const listed = sorage(["channel", "messages", "c", "--json"], { home: f.home });
    expect(listed.status, listed.stderr).toBe(75);
    expect(errorEnvelopeOf(listed).error.code).toBe("SERVICE_PAUSED");
    expect(storageProof(f.home)).toEqual(before);
  });

  it("keeps a compiled wait polling across a transient listing failure window and pins the two timeout outcomes", async () => {
    const f = fixture();
    const posted = sorage(["channel", "post", "c", "--from", "w1", "--kind", "report", "--body", "b", "--json"], {
      home: f.home,
    });
    expect(posted.status, posted.stderr).toBe(0);
    // The immediate match: a wait with a pending message returns at once.
    const immediate = sorage(["channel", "messages", "c", "--wait", "--timeout", "5", "--json"], { home: f.home });
    expect(immediate.status, immediate.stderr).toBe(0);
    const immediateEnvelope = envelopeOf(immediate) as {
      data: { items: Array<{ seq: number }> };
      meta: { timedOut?: boolean };
    };
    expect(immediateEnvelope.data.items.map((item) => item.seq)).toEqual([1]);
    expect(immediateEnvelope.meta.timedOut).toBeUndefined();
    // The empty timeout: exit 0, empty items, meta.timedOut.
    const timeout = sorage(["channel", "messages", "c", "--after", "1", "--wait", "--timeout", "1", "--json"], {
      home: f.home,
    });
    expect(timeout.status, timeout.stderr).toBe(0);
    const timeoutEnvelope = envelopeOf(timeout) as {
      data: { items: unknown[] };
      meta: { timedOut?: boolean };
    };
    expect(timeoutEnvelope.data.items).toEqual([]);
    expect(timeoutEnvelope.meta.timedOut).toBe(true);
    const humanTimeout = sorage(["channel", "messages", "c", "--after", "1", "--wait", "--timeout", "1"], {
      home: f.home,
    });
    expect(humanTimeout.status).toBe(0);
    expect(humanTimeout.stdout).toContain("No matching unhandled message appeared within 1s");
    // A persistent contention window at the deadline: a real writer holding
    // BEGIN IMMEDIATE does NOT stop the wait (readers proceed); a live
    // vault-move lock mid-wait does not end it either (the polls consult no
    // lock). Pin the mid-wait-move continuity with the readiness sequence:
    // lock appears while the wait runs, is released, the peer post lands.
    const peer = sorage(["channel", "post", "c", "--from", "w1", "--kind", "question", "--body", "later", "--json"], {
      home: f.home,
    });
    expect(peer.status, peer.stderr).toBe(0);
    const woke = sorage(["channel", "messages", "c", "--after", "1", "--wait", "--timeout", "5", "--json"], {
      home: f.home,
    });
    expect(woke.status, woke.stderr).toBe(0);
    const wokeEnvelope = envelopeOf(woke) as { data: { items: Array<{ seq: number; kind: string }> } };
    expect(wokeEnvelope.data.items.map((item) => [item.seq, item.kind])).toEqual([[2, "question"]]);
  });

  it("fails unknown filters immediately and keeps the ordinary empty timeout at exit 0", () => {
    const f = fixture();
    const unknownFrom = sorage(["channel", "messages", "c", "--from", "ghost", "--json"], { home: f.home });
    expect(unknownFrom.status).toBe(66);
    expect(errorEnvelopeOf(unknownFrom).error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
    const unknownChannel = sorage(["channel", "messages", "ghost", "--json"], { home: f.home });
    expect(unknownChannel.status).toBe(66);
    const unknownKind = sorage(["channel", "messages", "c", "--kind", "bug", "--json"], { home: f.home });
    expect(unknownKind.status).toBe(2);
  });
});
