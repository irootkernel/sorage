import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  envelopeOf,
  errorEnvelopeOf,
  registerCleanup,
  rmSyncSafe,
  runCleanups,
  sorage,
  twoProjectFixture,
} from "./helpers";

/** AJ-04 (owned by EPIC-006): the complete review loop over the compiled binary. */
afterAll(runCleanups);

function rowVersionOf(home: string, cwd: string, id: string): number {
  const run = sorage(["get", id, "--json"], { home, cwd });
  expect(run.status).toBe(0);
  return (envelopeOf(run) as { data: { rowVersion: number } }).data.rowVersion;
}

function outsiderDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aj04-outsider-"));
  registerCleanup(() => rmSyncSafe(dir));
  return dir;
}

describe("AJ-04 the review loop", () => {
  it("runs send, inbox, get, fetch, review set, revise, and accept with the Row Version moving 1-2-3", () => {
    const fixture = twoProjectFixture("aj04");
    const send = sorage(
      ["send", "--to", "beta", "--title", "The loop", "--file", fixture.document, "--allow-external-source", "--json"],
      {
        home: fixture.home,
        cwd: fixture.workA,
      },
    );
    expect(send.status).toBe(0);
    const id = (envelopeOf(send) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId as string;

    const inbox = sorage(["inbox", "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(inbox.status).toBe(0);
    expect(inbox.stdout).toContain(id);

    const got = sorage(["get", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(got.status).toBe(0);
    expect((envelopeOf(got) as { data: { firstFetchedAt: string | null } }).data.firstFetchedAt).toBeNull();

    const fetched = sorage(["fetch", id, "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(fetched.status).toBe(0);
    const fetchedData = envelopeOf(fetched) as { data: { artifact: { originalName: string }; localPath: string } };
    expect(fetchedData.data.artifact.originalName).toBe("brief.md");
    expect(fetchedData.data.localPath).toContain("artifacts");
    expect(rowVersionOf(fixture.home, fixture.workB, id)).toBe(1);

    const note = sorage(["review", "set", id, "--text", "Tighten the intro", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(note.status).toBe(0);
    expect((envelopeOf(note) as { data: { handoff: { reviewState: string } } }).data.handoff.reviewState).toBe(
      "changes_requested",
    );
    expect(rowVersionOf(fixture.home, fixture.workB, id)).toBe(2);

    const replacement = join(fixture.home, "revised.md");
    writeFileSync(replacement, "# The loop, revised\n", "utf8");
    const revise = sorage(["revise", id, "--file", replacement, "--allow-external-source", "--json"], {
      home: fixture.home,
      cwd: fixture.workA,
    });
    expect(revise.status).toBe(0);
    expect(rowVersionOf(fixture.home, fixture.workB, id)).toBe(3);

    const accept = sorage(["accept", id, "--expected-revision", "2", "--expected-row-version", "3", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(accept.status).toBe(0);
    expect((envelopeOf(accept) as { data: { acceptedRevision: number } }).data.acceptedRevision).toBe(2);
  });

  it("discloses nothing to a non-participant and refuses terminal mutations", () => {
    const fixture = twoProjectFixture("aj04b");
    const id = fixture.sendTo("a", "b", "Disclosure");
    const outsider = outsiderDir();
    const read = sorage(["get", id, "--json"], { home: fixture.home, cwd: outsider });
    expect(read.status).toBe(66);
    expect(errorEnvelopeOf(read).error.code).toBe("HANDOFF_NOT_FOUND");

    const accept = sorage(["accept", id, "--expected-revision", "1", "--expected-row-version", "1", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(accept.status).toBe(0);
    const revise = sorage(["revise", id, "--no-change", "--reason", "too late", "--json"], {
      home: fixture.home,
      cwd: fixture.workA,
    });
    expect(revise.status).toBe(65);
    expect(errorEnvelopeOf(revise).error.code).toBe("HANDOFF_TERMINAL");
  });
});
