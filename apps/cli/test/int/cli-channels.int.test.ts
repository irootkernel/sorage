import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/main";

/**
 * The rebuilt Channel CLI surface of TASK-123 (interface sections 38.4 to
 * 38.6): the nine-command catalog's structure and defaults read from the real
 * program, the closed JSON data keyset of every operation, the usage errors of
 * the rebuilt option coherence, both rendering forms of the reads, and the
 * 60-second wait default pinned cheaply beside the behavioral timeout case.
 * Behavioral depth lives in the adapter and E2E suites; these are the CLI's
 * own structural and rendering contracts.
 */
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "sorage-channel-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(args: string[], h: string, taskEnv: NodeJS.ProcessEnv = {}) {
  const work = join(h, "work");
  mkdirSync(work, { recursive: true });
  const result = spawnSync("bun", [entry, ...args], {
    encoding: "utf8",
    cwd: work,
    env: { ...process.env, ...taskEnv, SORAGE_HOME: h },
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function initialized(_prefix = "sorage-channel-cli-"): string {
  const h = home();
  const init = cli(["init", "--non-interactive"], h);
  expect(init.status, init.stderr).toBe(0);
  return h;
}

function dataOf(run: { status: number | null; stdout: string; stderr: string }): Record<string, unknown> {
  expect(run.status, run.stderr).toBe(0);
  const parsed = JSON.parse(run.stdout) as { ok: boolean; data: Record<string, unknown> };
  expect(parsed.ok).toBe(true);
  return parsed.data;
}

function errorOf(run: { status: number | null; stdout: string; stderr: string }): { code: string; message: string } {
  const parsed = JSON.parse(run.stderr) as { error: { code: string; message: string } };
  return parsed.error;
}

function fingerprint(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && !item.name.endsWith("-shm"))
        result[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  visit(root);
  return result;
}

describe("the rebuilt channel CLI surface", () => {
  it("registers exactly the nine leaf commands with their local options", () => {
    const program = buildProgram({ out: () => {}, err: () => {} });
    const group = program.commands.find((command) => command.name() === "channel");
    expect(group).toBeDefined();
    const leaves = new Map(
      (group?.commands ?? [])
        .filter((command) => command.name() !== "help")
        .map((command) => [
          command.name(),
          command.options.map((option) => option.long).filter((flag) => flag !== "--help"),
        ]),
    );
    expect([...leaves.keys()].sort()).toEqual([
      "ack",
      "add",
      "close",
      "create",
      "list",
      "messages",
      "post",
      "remove",
      "show",
    ]);
    expect(leaves.get("create")).toEqual(["--title", "--main"]);
    expect(leaves.get("add")).toEqual(["--role"]);
    expect(leaves.get("remove")).toEqual([]);
    expect([...(leaves.get("post") ?? [])].sort()).toEqual([
      "--body",
      "--body-file",
      "--from",
      "--kind",
      "--ref",
      "--to",
    ]);
    expect([...(leaves.get("messages") ?? [])].sort()).toEqual([
      "--after",
      "--all",
      "--from",
      "--interval",
      "--kind",
      "--limit",
      "--timeout",
      "--wait",
    ]);
    expect(leaves.get("ack")).toEqual(["--note"]);
    expect(leaves.get("close")).toEqual([]);
    expect(leaves.get("list")).toEqual(["--state"]);
    expect(leaves.get("show")).toEqual([]);
  });

  it("pins the 60-second wait default and the 2-second interval cheaply beside the behavioral case", () => {
    const program = buildProgram({ out: () => {}, err: () => {} });
    const group = program.commands.find((command) => command.name() === "channel");
    const messages = group?.commands.find((command) => command.name() === "messages");
    const timeout = messages?.options.find((option) => option.long === "--timeout");
    const interval = messages?.options.find((option) => option.long === "--interval");
    expect(timeout?.defaultValue).toBe(60);
    expect(timeout?.description).toContain("default is 60");
    expect(interval?.defaultValue).toBe(2);
    expect(interval?.description).toContain("default is 2");
  });

  it("shows the group in the root help", () => {
    const h = home();
    const help = cli(["help"], h);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("channel");
  });

  it("returns the exact closed JSON keyset of every operation", () => {
    const h = initialized();
    const channel = dataOf(cli(["channel", "create", "aq-cli", "--json"], h)) as {
      channel: Record<string, unknown>;
      existing: boolean;
    };
    expect(Object.keys(channel).sort()).toEqual(["channel", "existing"]);
    expect(Object.keys(channel.channel).sort()).toEqual([
      "closedAt",
      "createdAt",
      "id",
      "main",
      "messageCount",
      "name",
      "participantCount",
      "participants",
      "state",
      "title",
      "unhandledCount",
    ]);
    const added = dataOf(cli(["channel", "add", "aq-cli", "w1", "--role", "worker", "--json"], h)) as {
      participant: Record<string, unknown>;
    };
    expect(Object.keys(added).sort()).toEqual(["participant"]);
    expect(Object.keys(added.participant).sort()).toEqual(["addedAt", "handle", "removedAt", "role"]);
    const posted = dataOf(
      cli(["channel", "post", "aq-cli", "--from", "w1", "--kind", "report", "--body", "b", "--json"], h),
    ) as {
      message: Record<string, unknown>;
      duplicate: boolean;
    };
    expect(Object.keys(posted).sort()).toEqual(["duplicate", "message"]);
    expect(Object.keys(posted.message).sort()).toEqual([
      "body",
      "bodyPath",
      "bodyPending",
      "createdAt",
      "from",
      "handleNote",
      "handled",
      "handledAt",
      "kind",
      "ref",
      "seq",
      "to",
    ]);
    const listed = dataOf(cli(["channel", "messages", "aq-cli", "--json"], h)) as { items: unknown[] };
    expect(Object.keys(listed)).toEqual(["items"]);
    const acked = dataOf(cli(["channel", "ack", "aq-cli", "1", "--note", "ok", "--json"], h)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(acked).sort()).toEqual(["alreadyHandled", "handled", "note"]);
    const closed = dataOf(cli(["channel", "close", "aq-cli", "--json"], h)) as { channel: Record<string, unknown> };
    expect(Object.keys(closed)).toEqual(["channel"]);
    const summaries = dataOf(cli(["channel", "list", "--json"], h)) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(summaries)).toEqual(["items"]);
    expect(Object.keys(summaries.items[0] as Record<string, unknown>).sort()).toEqual([
      "closedAt",
      "createdAt",
      "id",
      "main",
      "name",
      "state",
      "title",
    ]);
    const shown = dataOf(cli(["channel", "show", "aq-cli", "--json"], h));
    expect(Object.keys(shown)).toEqual(["channel"]);
    const removed = dataOf(cli(["channel", "remove", "aq-cli", "w1", "--json"], h)) as {
      participant: Record<string, unknown>;
    };
    expect(Object.keys(removed)).toEqual(["participant"]);
  });

  it("refuses the rebuilt option incoherences as exit-2 usage errors", () => {
    const h = initialized();
    expect(cli(["channel", "create", "aq-cli", "--json"], h).status).toBe(0);
    expect(cli(["channel", "list", "aq-cli", "--cursor", "c", "--json"], h).status).toBe(2);
    expect(cli(["channel", "messages", "aq-cli", "--limit", "5", "--cursor", "c", "--json"], h).status).toBe(2);
    expect(cli(["channel", "close", "aq-cli", "--limit", "5", "--json"], h).status).toBe(2);
    expect(cli(["channel", "messages", "aq-cli", "--wait", "--all", "--json"], h).status).toBe(2);
    expect(cli(["channel", "messages", "aq-cli", "--interval", "1", "--json"], h).status).toBe(2);
    expect(cli(["channel", "messages", "aq-cli", "--timeout", "5", "--json"], h).status).toBe(2);
    expect(
      cli(["channel", "messages", "aq-cli", "--wait", "--interval", "0", "--timeout", "1", "--json"], h).status,
    ).toBe(2);
    expect(cli(["channel", "create", "aq-cli2", "--expected-row-version", "1", "--json"], h).status).toBe(2);
  });

  it("refuses the removed root options with CHN_INVALID_INPUT, both forms", () => {
    const h = initialized();
    const json = cli(["channel", "create", "aq-cli", "--as", "alpha", "--json"], h);
    expect(json.status).toBe(64);
    expect(errorOf(json).code).toBe("CHN_INVALID_INPUT");
    expect(errorOf(json).message).toContain("provenance is always User");
    const human = cli(["channel", "create", "aq-cli", "--confirm"], h);
    expect(human.status).toBe(64);
    expect(human.stderr).toContain("CHN_INVALID_INPUT");
    expect(human.stderr).toContain("--confirm");
  });

  it("renders both forms of the reads: list, show, messages, and ack", () => {
    const h = initialized();
    for (const args of [
      ["channel", "create", "render", "--title", "Rendered"],
      ["channel", "add", "render", "w1", "--role", "worker"],
      ["channel", "post", "render", "--from", "w1", "--kind", "report", "--body", "human form body"],
    ]) {
      expect(cli([...args, "--json"], h).status).toBe(0);
    }
    const list = cli(["channel", "list"], h);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("render [open] Rendered — main: main");
    const show = cli(["channel", "show", "render"], h);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Main: main");
    expect(show.stdout).toContain("w1 [worker]");
    expect(show.stdout).toContain("Messages: 1 (1 unhandled)");
    const messages = cli(["channel", "messages", "render"], h);
    expect(messages.status).toBe(0);
    expect(messages.stdout).toContain("#1 [report] w1: human form body");
    const acked = cli(["channel", "ack", "render", "1"], h);
    expect(acked.status).toBe(0);
    expect(acked.stdout).toContain("Handled: #1");
    expect(acked.stdout).toContain("Already handled: none");
  });

  it("refuses unknown kinds at the parser stage and typed role/state field violations at exit 64 (38.4 line 1712)", () => {
    const h = initialized();
    // Only --kind is a parser usage error; bad role and state values are
    // field violations through the core validators (decision item 4).
    expect(cli(["channel", "post", "x", "--from", "w", "--kind", "bug", "--body", "b", "--json"], h).status).toBe(2);
    expect(cli(["channel", "messages", "x", "--kind", "bug", "--json"], h).status).toBe(2);
    for (const args of [
      ["channel", "add", "x", "w", "--role", "boss", "--json"],
      ["channel", "list", "--state", "frozen", "--json"],
    ]) {
      const result = cli(args, h);
      expect(result.status, args.join(" ")).toBe(64);
      expect(errorOf(result).code, args.join(" ")).toBe("CHN_INVALID_INPUT");
    }
    const human = cli(["channel", "add", "x", "w", "--role", "boss"], h);
    expect(human.status).toBe(64);
    expect(human.stderr).toContain("CHN_INVALID_INPUT");
  });

  it("reads never mutate: the home fingerprint is identical across both forms", () => {
    const h = initialized();
    for (const args of [
      ["channel", "create", "stable"],
      ["channel", "add", "stable", "w1", "--role", "worker"],
      ["channel", "post", "stable", "--from", "w1", "--kind", "report", "--body", "stable body"],
      ["channel", "ack", "stable", "1"],
    ]) {
      expect(cli([...args, "--json"], h).status).toBe(0);
    }
    const before = fingerprint(h);
    for (const args of [
      ["channel", "list"],
      ["channel", "list", "--json"],
      ["channel", "show", "stable"],
      ["channel", "show", "stable", "--json"],
      ["channel", "messages", "stable", "--all"],
      ["channel", "messages", "stable", "--all", "--json"],
      ["channel", "messages", "stable", "--wait", "--timeout", "1", "--json"],
    ]) {
      expect(cli(args, h).status, args.join(" ")).toBe(0);
    }
    expect(fingerprint(h)).toEqual(before);
  });

  it("answers the typed refusals of the 38.4 line 1712 matrix with their exits", () => {
    const h = initialized();
    expect(cli(["channel", "show", "ghost", "--json"], h).status).toBe(66);
    expect(errorOf(cli(["channel", "show", "ghost", "--json"], h)).code).toBe("CHN_NOT_FOUND");
    expect(cli(["channel", "ack", "ghost", "1", "--json"], h).status).toBe(66);
    expect(cli(["channel", "messages", "ghost", "--json"], h).status).toBe(66);
    expect(cli(["channel", "create", "aq-cli", "--json"], h).status).toBe(0);
    expect(cli(["channel", "add", "aq-cli", "w1", "--role", "worker", "--json"], h).status).toBe(0);
    expect(
      cli(["channel", "post", "aq-cli", "--from", "w1", "--kind", "report", "--body", "b", "--json"], h).status,
    ).toBe(0);
    const badAck = cli(["channel", "ack", "aq-cli", "1", "99", "--json"], h);
    expect(badAck.status).toBe(66);
    expect(errorOf(badAck).code).toBe("CHN_MESSAGE_NOT_FOUND");
    expect(errorOf(badAck).message).toContain("99");
    expect(cli(["channel", "messages", "aq-cli", "--from", "ghost", "--json"], h).status).toBe(66);
    expect(cli(["channel", "remove", "aq-cli", "ghost", "--json"], h).status).toBe(66);
    const uuidShaped = cli(["channel", "create", "10000000-0000-4000-8000-000000000001", "--json"], h);
    expect(uuidShaped.status).toBe(64);
    expect(errorOf(uuidShaped).code).toBe("CHN_INVALID_INPUT");
    const mainPost = cli(
      ["channel", "post", "aq-cli", "--from", "main", "--kind", "report", "--body", "b", "--json"],
      h,
    );
    expect(mainPost.status).toBe(64);
    expect(errorOf(mainPost).message).toContain("upstream");
    const relayWithoutTo = cli(
      ["channel", "post", "aq-cli", "--from", "w1", "--kind", "relay_request", "--body", "b", "--json"],
      h,
    );
    expect(relayWithoutTo.status).toBe(64);
    const toWithReport = cli(
      ["channel", "post", "aq-cli", "--from", "w1", "--kind", "report", "--to", "main", "--body", "b", "--json"],
      h,
    );
    expect(toWithReport.status).toBe(64);
    expect(cli(["channel", "close", "aq-cli", "--json"], h).status).toBe(0);
    const closedPost = cli(
      ["channel", "post", "aq-cli", "--from", "w1", "--kind", "report", "--body", "c", "--json"],
      h,
    );
    expect(closedPost.status).toBe(65);
    expect(errorOf(closedPost).code).toBe("CHN_CLOSED");
    const closedAdd = cli(["channel", "add", "aq-cli", "late", "--role", "judge", "--json"], h);
    expect(closedAdd.status).toBe(65);
    expect(cli(["channel", "ack", "aq-cli", "1", "--json"], h).status).toBe(0);
    const closedName = cli(["channel", "create", "aq-cli", "--json"], h);
    expect(closedName.status).toBe(65);
  });

  it("times out an empty wait at exit 0 with meta.timedOut", () => {
    const h = initialized();
    expect(cli(["channel", "create", "quiet", "--json"], h).status).toBe(0);
    const wait = cli(["channel", "messages", "quiet", "--wait", "--timeout", "1", "--json"], h);
    expect(wait.status).toBe(0);
    const parsed = JSON.parse(wait.stdout) as { data: { items: unknown[] }; meta: { timedOut?: boolean } };
    expect(parsed.data.items).toEqual([]);
    expect(parsed.meta.timedOut).toBe(true);
    const human = cli(["channel", "messages", "quiet", "--wait", "--timeout", "1"], h);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("No matching unhandled message appeared within 1s");
  });

  it("passes exact positional identities through without joining or splitting on spaces (decision item 1)", () => {
    const h = initialized();
    // A name and a handle with internal spaces flow byte-exact through every
    // command; `run one` and `run` never alias (CHN-002).
    expect(cli(["channel", "create", "run", "--json"], h).status).toBe(0);
    expect(cli(["channel", "create", "run one", "--json"], h).status).toBe(0);
    expect(cli(["channel", "add", "run one", "worker one", "--role", "worker", "--json"], h).status).toBe(0);
    const posted = cli(
      ["channel", "post", "run one", "--from", "worker one", "--kind", "report", "--body", "spaced body", "--json"],
      h,
    );
    expect(posted.status, posted.stderr).toBe(0);
    expect((dataOf(posted) as { message: { from: string } }).message.from).toBe("worker one");
    const messages = cli(["channel", "messages", "run one", "--json"], h);
    expect((dataOf(messages) as { items: Array<{ from: string }> }).items[0]?.from).toBe("worker one");
    const acked = cli(["channel", "ack", "run one", "1", "--json"], h);
    expect(acked.status, acked.stderr).toBe(0);
    const shown = cli(["channel", "show", "run one", "--json"], h);
    expect((dataOf(shown) as { channel: { name: string; participantCount: number } }).channel).toMatchObject({
      name: "run one",
      participantCount: 2,
    });
    const removed = cli(["channel", "remove", "run one", "worker one", "--json"], h);
    expect(removed.status, removed.stderr).toBe(0);
    // The plain `run` Channel was never touched by any `run one` operation.
    const plain = cli(["channel", "show", "run", "--json"], h);
    expect((dataOf(plain) as { channel: { participantCount: number; messageCount: number } }).channel).toMatchObject({
      participantCount: 1,
      messageCount: 0,
    });
    // Leading and trailing spaces and a whitespace-only value pass byte-exact;
    // the CLI never trims an identity (the whitespace-only name is a
    // bounded-but-valid identity under the validators' exact rule).
    const led = cli(["channel", "create", " padded ", "--main", " main handle ", "--json"], h);
    expect(led.status, led.stderr).toBe(0);
    const added = cli(["channel", "add", " padded ", " handle two ", "--role", "worker", "--json"], h);
    expect(added.status, added.stderr).toBe(0);
    expect((dataOf(added) as { participant: { handle: string } }).participant.handle).toBe(" handle two ");
    const shownPadded = cli(["channel", "show", " padded ", "--json"], h);
    expect((dataOf(shownPadded) as { channel: { name: string; main: string } }).channel).toMatchObject({
      name: " padded ",
      main: " main handle ",
    });
    // A whitespace-only value is a bounded identity under the validators'
    // exact rule (only the empty string is empty), and it passes through the
    // CLI byte-exact — never trimmed and never refused.
    const blank = cli(["channel", "create", "   ", "--main", "  ", "--json"], h);
    expect(blank.status, blank.stderr).toBe(0);
    expect((dataOf(blank) as { channel: { name: string; main: string } }).channel).toMatchObject({
      name: "   ",
      main: "  ",
    });
  });

  it("refuses malformed ack operands whole, before any mutation (decision item 2)", () => {
    const h = initialized();
    for (const args of [
      ["channel", "ack", "c", "1junk", "--json"],
      ["channel", "ack", "c", "1.5", "--json"],
      ["channel", "ack", "c", "1e3", "--json"],
      ["channel", "ack", "c", "+1", "--json"],
      ["channel", "ack", "c", "0x1", "--json"],
      ["channel", "ack", "c", "", "--json"],
      ["channel", "ack", "c", "9007199254740992", "--json"],
    ]) {
      const result = cli(args, h);
      expect(result.status, args.join(" ")).toBe(64);
      expect(errorOf(result).code, args.join(" ")).toBe("CHN_INVALID_INPUT");
    }
    expect(cli(["channel", "create", "c", "--json"], h).status).toBe(0);
    expect(cli(["channel", "add", "c", "w1", "--role", "worker", "--json"], h).status).toBe(0);
    expect(cli(["channel", "post", "c", "--from", "w1", "--kind", "report", "--body", "b", "--json"], h).status).toBe(
      0,
    );
    const mixed = cli(["channel", "ack", "c", "1", "2junk", "--json"], h);
    expect(mixed.status).toBe(64);
    expect(errorOf(mixed).code).toBe("CHN_INVALID_INPUT");
    // Nothing was handled and no event was appended by any refused operand.
    const listed = cli(["channel", "messages", "c", "--json"], h);
    expect((dataOf(listed) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("parses the local --limit with the same integer rule as the root option, in the root form too, accepting the bound of 200 and refusing 201 (decision item 3; C3 item 9)", () => {
    const h = initialized();
    for (const args of [
      ["channel", "create", "lim", "--json"],
      ["channel", "add", "lim", "w1", "--role", "worker", "--json"],
      ["channel", "post", "lim", "--from", "w1", "--kind", "report", "--body", "one", "--json"],
      ["channel", "post", "lim", "--from", "w1", "--kind", "report", "--body", "two", "--json"],
    ]) {
      expect(cli(args, h).status).toBe(0);
    }
    // The local form accepts a plain integer.
    const local = cli(["channel", "messages", "lim", "--limit", "1", "--json"], h);
    expect(local.status, local.stderr).toBe(0);
    expect((dataOf(local) as { items: unknown[] }).items).toHaveLength(1);
    // It combines with --wait (a matching unhandled message returns at once).
    const waited = cli(["channel", "messages", "lim", "--wait", "--timeout", "2", "--limit", "1", "--json"], h);
    expect(waited.status, waited.stderr).toBe(0);
    expect((dataOf(waited) as { items: unknown[] }).items).toHaveLength(1);
    // The root form: the global option before the subcommand.
    const rooted = cli(["--limit", "1", "channel", "messages", "lim", "--json"], h);
    expect(rooted.status, rooted.stderr).toBe(0);
    expect((dataOf(rooted) as { items: unknown[] }).items).toHaveLength(1);
    // The maximum bound of 200 is accepted in both forms; 201 is refused by
    // core validation at exit 64, and an invalid token is a parser usage error.
    const atBound = cli(["channel", "messages", "lim", "--limit", "200", "--json"], h);
    expect(atBound.status, atBound.stderr).toBe(0);
    expect((dataOf(atBound) as { items: unknown[] }).items).toHaveLength(2);
    const rootedAtBound = cli(["--limit", "200", "channel", "messages", "lim", "--json"], h);
    expect(rootedAtBound.status, rootedAtBound.stderr).toBe(0);
    expect((dataOf(rootedAtBound) as { items: unknown[] }).items).toHaveLength(2);
    expect(cli(["channel", "messages", "lim", "--limit", "x", "--json"], h).status).toBe(2);
    const overBound = cli(["channel", "messages", "lim", "--limit", "201", "--json"], h);
    expect(overBound.status).toBe(64);
    expect((JSON.parse(overBound.stderr) as { error: { code: string } }).error.code).toBe("CHN_INVALID_INPUT");
    expect(cli(["--limit", "201", "channel", "messages", "lim", "--json"], h).status).toBe(64);
  });

  it("keeps a large body's file-backed post honest in both forms", () => {
    const h = initialized();
    expect(cli(["channel", "create", "big", "--json"], h).status).toBe(0);
    expect(cli(["channel", "add", "big", "w1", "--role", "worker", "--json"], h).status).toBe(0);
    const bodyPath = join(h, "big-body.txt");
    writeFileSync(bodyPath, `${"x".repeat(70_000)}\n`);
    const posted = cli(
      ["channel", "post", "big", "--from", "w1", "--kind", "report", "--body-file", bodyPath, "--json"],
      h,
    );
    expect(posted.status, posted.stderr).toBe(0);
    const message = dataOf(posted) as { message: { body: string; bodyPath: string; bodyPending: boolean } };
    expect(message.message.bodyPending).toBe(false);
    expect(message.message.bodyPath).toContain("content/channel/");
    expect(message.message.body.length).toBe(70_001);
    const listed = dataOf(cli(["channel", "messages", "big", "--json"], h)) as {
      items: Array<{ body: string }>;
    };
    expect(listed.items[0]?.body.length).toBe(70_001);
  });
});
