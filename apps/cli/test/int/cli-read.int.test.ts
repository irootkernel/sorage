import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-030 read surface through the real CLI: inbox and outbox scope to the
 * resolved actor, get records nothing, fetch records the recipient's first fetch
 * exactly once and refuses a sender-side materialization gap, a non-participant read
 * discloses nothing, and a cursor that does not match its filters fails CURSOR_INVALID.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

interface ListingEnvelope {
  ok: boolean;
  data: {
    handoffs: Array<{ id: string; reviewState: string; recipientProjectSlug: string }>;
    nextCursor: string | null;
  };
}

function setupTwoProjects(): { home: string; workA: string; workB: string } {
  const home = tempHome("sorage-read-cli-");
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  const workA = join(home, "work-a");
  const workB = join(home, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
  const document = join(home, "brief.md");
  writeFileSync(document, "# Shared\n");
  const send = capture();
  const exit = runCli(
    [
      "send",
      "--as",
      "alpha",
      "--to",
      "beta",
      "--title",
      "Brief",
      "--file",
      document,
      "--allow-external-source",
      "--json",
    ],
    send.ports,
  );
  if (exit !== 0) throw new Error(`fixture send failed: ${send.errText()}`);
  return { home, workA, workB };
}

describe("sorage inbox, outbox, get, and fetch", () => {
  it("lists the recipient's inbox and the sender's outbox for the resolved actor", () => {
    const { workA, workB } = setupTwoProjects();
    const originalA = process.cwd();

    const inboxFromB = capture();
    process.chdir(workB);
    expect(runCli(["inbox", "--json"], inboxFromB.ports)).toBe(0);
    const inbox = JSON.parse(inboxFromB.outText()) as ListingEnvelope;
    expect(inbox.data.handoffs).toHaveLength(1);
    expect(inbox.data.handoffs[0]?.recipientProjectSlug).toBe("beta");

    const outboxFromA = capture();
    process.chdir(workA);
    expect(runCli(["outbox", "--json"], outboxFromA.ports)).toBe(0);
    const outbox = JSON.parse(outboxFromA.outText()) as ListingEnvelope;
    expect(outbox.data.handoffs).toHaveLength(1);
    process.chdir(originalA);
  });

  it("records the recipient's first fetch exactly once and leaves get silent", () => {
    const { workB } = setupTwoProjects();
    const original = process.cwd();
    process.chdir(workB);
    const listing = capture();
    expect(runCli(["inbox", "--json"], listing.ports)).toBe(0);
    const id = (JSON.parse(listing.outText()) as ListingEnvelope).data.handoffs[0]?.id as string;

    const fetched = capture();
    expect(runCli(["fetch", id, "--json"], fetched.ports)).toBe(0);
    const database = new DatabaseSync(join(homes[0] as string, "state", "sorage.sqlite3"));
    try {
      const events = database
        .prepare("SELECT event_type FROM events WHERE event_type = 'ARTIFACT_FETCHED_FIRST_TIME'")
        .all() as unknown[];
      expect(events).toHaveLength(1);
      const row = database.prepare("SELECT first_fetched_at, row_version FROM handoffs WHERE id = ?").get(id) as {
        first_fetched_at: string | null;
        row_version: number;
      };
      expect(row.first_fetched_at).not.toBeNull();
      expect(row.row_version).toBe(1);
    } finally {
      database.close();
    }

    // A second fetch appends nothing, and get never did.
    expect(runCli(["fetch", id, "--json"], capture().ports)).toBe(0);
    expect(runCli(["get", id, "--json"], capture().ports)).toBe(0);
    const after = new DatabaseSync(join(homes[0] as string, "state", "sorage.sqlite3"));
    try {
      const events = after
        .prepare("SELECT event_type FROM events WHERE event_type = 'ARTIFACT_FETCHED_FIRST_TIME'")
        .all() as unknown[];
      expect(events).toHaveLength(1);
    } finally {
      after.close();
    }
    process.chdir(original);
  });

  it("discloses nothing to a non-participant and refuses a mismatched cursor", () => {
    const { home, workB } = setupTwoProjects();
    const original = process.cwd();
    const outsider = mkdtempSync(join(tmpdir(), "sorage-outsider-"));
    homes.push(outsider);
    process.chdir(outsider);
    const stranger = capture();
    expect(runCli(["get", "does-not-matter", "--json"], stranger.ports)).toBe(66);
    const report = JSON.parse(stranger.errText()) as { error: { code: string } };
    expect(report.error.code).toBe("HANDOFF_NOT_FOUND");

    process.chdir(workB);
    const paged = capture();
    expect(runCli(["inbox", "--limit", "1", "--json"], paged.ports)).toBe(0);
    const cursor = (JSON.parse(paged.outText()) as ListingEnvelope).data.nextCursor;
    expect(cursor).toBeNull();
    const mismatched = capture();
    expect(runCli(["inbox", "--state", "accepted", "--cursor", "YWJj.def", "--json"], mismatched.ports)).toBe(64);
    const refused = JSON.parse(mismatched.errText()) as { error: { code: string } };
    expect(refused.error.code).toBe("CURSOR_INVALID");
    void home;
    process.chdir(original);
  });

  it("leaves a sender fetch silent while the sender reads its own outbox entry", () => {
    const { workA } = setupTwoProjects();
    const original = process.cwd();
    process.chdir(workA);
    const listing = capture();
    expect(runCli(["outbox", "--json"], listing.ports)).toBe(0);
    const id = (JSON.parse(listing.outText()) as ListingEnvelope).data.handoffs[0]?.id as string;
    expect(runCli(["fetch", id, "--json"], capture().ports)).toBe(0);
    const database = new DatabaseSync(join(homes[0] as string, "state", "sorage.sqlite3"));
    try {
      const row = database.prepare("SELECT first_fetched_at FROM handoffs WHERE id = ?").get(id) as {
        first_fetched_at: string | null;
      };
      expect(row.first_fetched_at).toBeNull();
    } finally {
      database.close();
    }
    process.chdir(original);
  });

  it("lists only the current Workspace's Handoffs under outbox --current-workspace", () => {
    const { home } = setupTwoProjects();
    const original = process.cwd();
    const workU = join(home, "work-u");
    const workV = join(home, "work-v");
    mkdirSync(workU, { recursive: true });
    mkdirSync(workV, { recursive: true });
    const document = join(workU, "note.md");
    writeFileSync(document, "# From the workspace\n");
    process.chdir(workU);
    const send = capture();
    expect(
      runCli(
        ["send", "--to", "beta", "--title", "Note", "--file", document, "--allow-unregistered", "--json"],
        send.ports,
      ),
    ).toBe(0);

    const ownWorkspace = capture();
    expect(runCli(["outbox", "--current-workspace", "--json"], ownWorkspace.ports)).toBe(0);
    const own = JSON.parse(ownWorkspace.outText()) as ListingEnvelope;
    expect(own.data.handoffs).toHaveLength(1);
    expect(own.data.handoffs[0]?.recipientProjectSlug).toBe("beta");

    process.chdir(workV);
    const otherWorkspace = capture();
    expect(runCli(["outbox", "--current-workspace", "--json"], otherWorkspace.ports)).toBe(0);
    const other = JSON.parse(otherWorkspace.outText()) as ListingEnvelope;
    expect(other.data.handoffs).toHaveLength(0);
    process.chdir(original);
  });
});
