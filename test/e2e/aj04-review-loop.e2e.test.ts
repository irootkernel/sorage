import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  envelopeOf,
  errorEnvelopeOf,
  git,
  makeTempDir,
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

type BindingKind = "directory" | "git_repository";

function workspaceFixture(kind: BindingKind) {
  const parent = makeTempDir("aj04-workspace-");
  const home = join(parent, "home");
  const sender = join(parent, "sender");
  const recipient = join(parent, "recipient");
  const nested = join(sender, "_workspace", "nested");
  for (const path of [home, nested, recipient]) mkdirSync(path, { recursive: true });
  if (kind === "git_repository") git(sender, ["init", "--initial-branch=main"]);
  expect(sorage(["init", "--non-interactive"], { home }).status).toBe(0);
  const added = sorage(["project", "add", "--name", "Alpha", "--dir", sender, "--json"], { home });
  expect(added.status, added.stderr).toBe(0);
  const binding = (envelopeOf(added) as { data: { binding: { bindingKind: string; directory: string } } }).data.binding;
  expect(binding.bindingKind).toBe(kind);
  expect(binding.directory).toBe(realpathSync(kind === "git_repository" ? join(sender, ".git") : sender));
  expect(sorage(["project", "add", "--name", "Beta", "--dir", recipient], { home }).status).toBe(0);
  const document = join(sender, "_workspace", "proposal.md");
  writeFileSync(document, "# Proposal revision one\n");
  const sent = sorage(["send", "--to", "beta", "--title", "Workspace loop", "--file", document, "--json"], {
    home,
    cwd: sender,
  });
  expect(sent.status, sent.stderr).toBe(0);
  const id = (envelopeOf(sent) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]?.handoffId;
  expect(id).toBeDefined();
  return { parent, home, sender, recipient, nested, document, id: id as string };
}

interface HandoffState {
  revision: number;
  rowVersion: number;
  reviewState: string;
  hasReviewNote: boolean;
  currentArtifact: { id: string; storageKey: string; sha256: string };
}

function handoffOf(home: string, cwd: string, id: string): HandoffState {
  const got = sorage(["get", id, "--json"], { home, cwd });
  expect(got.status, got.stderr).toBe(0);
  return (envelopeOf(got) as { data: HandoffState }).data;
}

function expectFetchedContent(home: string, cwd: string, id: string, content: string): void {
  const fetched = sorage(["fetch", id, "--json"], { home, cwd });
  expect(fetched.status, fetched.stderr).toBe(0);
  const data = (envelopeOf(fetched) as { data: { localPath: string; artifact: { sha256: string } } }).data;
  const bytes = readFileSync(data.localPath);
  expect(bytes).toEqual(Buffer.from(content));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(data.artifact.sha256);
}

describe("AJ-04 registered workspace import roots", () => {
  it.each([
    ["directory", "nested"],
    ["directory", "explicit"],
    ["git_repository", "nested"],
    ["git_repository", "explicit"],
  ] as const)("completes the %s review loop with %s Project selection without an override", (kind, selection) => {
    const f = workspaceFixture(kind);
    expect(handoffOf(f.home, f.recipient, f.id)).toMatchObject({
      revision: 1,
      rowVersion: 1,
      reviewState: "awaiting_recipient",
    });
    expectFetchedContent(f.home, f.recipient, f.id, "# Proposal revision one\n");
    const beforeNote = handoffOf(f.home, f.recipient, f.id);
    const note = sorage(
      [
        "review",
        "set",
        f.id,
        "--text",
        "Clarify the proposal",
        "--expected-row-version",
        String(beforeNote.rowVersion),
        "--json",
      ],
      { home: f.home, cwd: f.recipient },
    );
    expect(note.status, note.stderr).toBe(0);
    const beforeRevision = handoffOf(f.home, f.sender, f.id);
    expect(beforeRevision).toMatchObject({
      revision: 1,
      rowVersion: 2,
      reviewState: "changes_requested",
      hasReviewNote: true,
    });
    expect(sorage(["review", "show", f.id, "--json"], { home: f.home, cwd: f.sender }).status).toBe(0);
    const content = "# Proposal revision two\n\nClarified.\n";
    writeFileSync(f.document, content);
    const revised = sorage(
      [
        "revise",
        f.id,
        "--file",
        f.document,
        "--expected-row-version",
        String(beforeRevision.rowVersion),
        ...(selection === "explicit" ? ["--as", "alpha"] : []),
        "--json",
      ],
      { home: f.home, cwd: selection === "explicit" ? f.parent : f.nested },
    );
    expect(revised.status, revised.stderr).toBe(0);
    const afterRevision = handoffOf(f.home, f.recipient, f.id);
    expect(afterRevision).toMatchObject({
      revision: 2,
      rowVersion: 3,
      reviewState: "awaiting_recipient",
      hasReviewNote: false,
    });
    expect(afterRevision.currentArtifact.id).not.toBe(beforeRevision.currentArtifact.id);
    expectFetchedContent(f.home, f.recipient, f.id, content);
    const beforeAccept = handoffOf(f.home, f.recipient, f.id);
    const accepted = sorage(
      [
        "accept",
        f.id,
        "--expected-revision",
        String(beforeAccept.revision),
        "--expected-row-version",
        String(beforeAccept.rowVersion),
        "--json",
      ],
      { home: f.home, cwd: f.recipient },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect((envelopeOf(accepted) as { data: { acceptedRevision: number } }).data.acceptedRevision).toBe(2);
    expect(handoffOf(f.home, f.recipient, f.id)).toMatchObject({
      revision: 2,
      rowVersion: 4,
      reviewState: "accepted",
      hasReviewNote: false,
    });
  });

  it.each(["directory", "git_repository"] as const)(
    "preserves the %s Handoff and Note after outside and symlink rejection",
    (kind) => {
      const f = workspaceFixture(kind);
      const initial = handoffOf(f.home, f.recipient, f.id);
      expect(
        sorage(
          [
            "review",
            "set",
            f.id,
            "--text",
            "Keep this Note until a valid revision",
            "--expected-row-version",
            String(initial.rowVersion),
            "--json",
          ],
          { home: f.home, cwd: f.recipient },
        ).status,
      ).toBe(0);
      const before = handoffOf(f.home, f.sender, f.id);
      const noteBefore = envelopeOf(sorage(["review", "show", f.id, "--json"], { home: f.home, cwd: f.sender })).data;
      const outside = join(f.parent, "outside.md");
      const link = join(f.sender, "_workspace", "linked.md");
      writeFileSync(outside, "# Outside replacement\n");
      symlinkSync(outside, link);
      for (const file of [outside, link]) {
        const refused = sorage(
          ["revise", f.id, "--file", file, "--expected-row-version", String(before.rowVersion), "--json"],
          { home: f.home, cwd: f.nested },
        );
        expect(refused.status, refused.stderr).toBe(77);
        const error = errorEnvelopeOf(refused).error;
        expect(error.code).toBe("SOURCE_OUTSIDE_WORKSPACE");
        expect(error.details.workspaceRoot).toBe(realpathSync(f.sender));
        expect(error.details.resolvedSourcePath).toBe(realpathSync(outside));
        expect(handoffOf(f.home, f.sender, f.id)).toEqual(before);
        expect(envelopeOf(sorage(["review", "show", f.id, "--json"], { home: f.home, cwd: f.sender })).data).toEqual(
          noteBefore,
        );
        expectFetchedContent(f.home, f.sender, f.id, "# Proposal revision one\n");
      }
      const content = "# Valid inside replacement\n";
      writeFileSync(f.document, content);
      const observed = handoffOf(f.home, f.sender, f.id);
      const revised = sorage(
        ["revise", f.id, "--file", f.document, "--expected-row-version", String(observed.rowVersion), "--json"],
        { home: f.home, cwd: f.nested },
      );
      expect(revised.status, revised.stderr).toBe(0);
      expect(handoffOf(f.home, f.sender, f.id)).toMatchObject({
        revision: 2,
        rowVersion: 3,
        reviewState: "awaiting_recipient",
        hasReviewNote: false,
      });
      expectFetchedContent(f.home, f.recipient, f.id, content);
    },
  );
});
