import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, runCleanups, sorage, twoProjectFixture } from "./helpers";

/** AJ-17 (owned by EPIC-010): the sender reads the Review Note through the CLI before revising. */
afterAll(runCleanups);

describe("AJ-17 sender reads the Review Note through the CLI before revising", () => {
  it("hides the Note from get and outbox, returns it from review show, and keeps sender fetch silent", () => {
    const fixture = twoProjectFixture("aj17");
    const send = sorage(
      ["send", "--to", "beta", "--title", "The note", "--file", fixture.document, "--allow-external-source", "--json"],
      { home: fixture.home, cwd: fixture.workA },
    );
    expect(send.status).toBe(0);
    const id = (envelopeOf(send) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId as string;

    const note = sorage(["review", "set", id, "--text", "Tighten the intro", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(note.status).toBe(0);

    const outbox = sorage(["outbox", "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(outbox.status).toBe(0);
    const outboxData = envelopeOf(outbox) as { data: { handoffs: Array<Record<string, unknown>> } };
    expect(outboxData.data.handoffs[0]?.hasReviewNote).toBe(true);
    expect(JSON.stringify(outboxData)).not.toContain("Tighten the intro");

    const got = sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(got.status).toBe(0);
    const gotData = envelopeOf(got) as { data: Record<string, unknown> };
    expect(gotData.data.hasReviewNote).toBe(true);
    expect(JSON.stringify(gotData)).not.toContain("Tighten the intro");
    expect(gotData.data.firstFetchedAt).toBeNull();

    const shown = sorage(["review", "show", id, "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(shown.status).toBe(0);
    const shownData = envelopeOf(shown) as {
      data: { body: string; targetRevision: number; authorKind: string };
    };
    expect(shownData.data.body).toBe("Tighten the intro");
    expect(shownData.data.targetRevision).toBe(1);
    expect(shownData.data.authorKind).toBe("registered_project");
    expect(
      (
        envelopeOf(sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workA })) as {
          data: { rowVersion: number };
        }
      ).data.rowVersion,
    ).toBe(2);

    const fetched = sorage(["fetch", id, "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(fetched.status).toBe(0);
    const fetchedData = envelopeOf(fetched) as { data: { localPath: string } };
    const afterFetch = envelopeOf(sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workA })) as {
      data: { firstFetchedAt: string | null };
    };
    expect(afterFetch.data.firstFetchedAt).toBeNull();

    expect(fetchedData.data.localPath).toContain("artifacts");
    const workspaceCopy = join(fixture.workA, "brief-copy.md");
    writeFileSync(workspaceCopy, `${readFileSync(fixture.document, "utf8")}\nRevised intro.\n`, "utf8");
    const revise = sorage(["revise", id, "--file", workspaceCopy, "--json"], {
      home: fixture.home,
      cwd: fixture.workA,
    });
    expect(revise.status).toBe(0);

    const recipientGet = sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(recipientGet.status).toBe(0);
    const recipient = envelopeOf(recipientGet) as { data: { revision: number; rowVersion: number } };
    expect(recipient.data.revision).toBe(2);
    expect(recipient.data.rowVersion).toBe(3);
    const recipientFetch = sorage(["fetch", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(recipientFetch.status).toBe(0);
    const accept = sorage(["accept", id, "--expected-revision", "2", "--expected-row-version", "3", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(accept.status).toBe(0);

    const events = sorage(["events", id, "--json"], { home: fixture.home, cwd: fixture.workA });
    expect(events.status).toBe(0);
    const timeline = envelopeOf(events) as { data: Array<Record<string, unknown>> };
    expect(timeline.data.length).toBeGreaterThan(0);
    expect(timeline.data.length).toBeLessThanOrEqual(50);
    for (const event of timeline.data) {
      expect(event).not.toHaveProperty("artifactBytes");
      expect(JSON.stringify(event)).not.toContain("Revised intro");
    }

    const boxOnly = twoProjectFixture("aj17-box");
    const boxId = boxOnly.sendTo("a", "b", "Box only");
    expect(
      sorage(["review", "set", boxId, "--text", "hidden from a box check", "--json"], {
        home: boxOnly.home,
        cwd: boxOnly.workB,
      }).status,
    ).toBe(0);
    const boxOutbox = sorage(["outbox", "--json"], { home: boxOnly.home, cwd: boxOnly.workA });
    expect(boxOutbox.status).toBe(0);
    expect(JSON.stringify(envelopeOf(boxOutbox))).not.toContain("hidden from a box check");
  });
});
