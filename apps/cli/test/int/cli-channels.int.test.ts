import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Channel CLI structural checks: actual --help output for the channel group
 * and its subcommands, --as-participant registration on every main-role
 * command, its absence from reads, the repeatable --native collector with
 * empty entries, and opaque non-UUID idempotency keys. These are surface
 * checks only; behavioral coverage lives in the adapter and E2E suites.
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
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function fingerprint(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !entry.name.endsWith("-shm"))
        result[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  visit(root);
  return result;
}

describe("channel CLI surface", () => {
  it("registers the channel group in the root help", () => {
    const h = home();
    const help = cli(["help"], h);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("channel");
  });

  it("shows --as-participant on every main-role command help", () => {
    const h = home();
    const mainRoleCommands = [
      ["channel", "close", "--help"],
      ["channel", "participant", "add", "--help"],
      ["channel", "participant", "deactivate", "--help"],
      ["channel", "assignment", "add", "--help"],
      ["channel", "assignment", "close", "--help"],
      ["channel", "handle", "--help"],
    ];
    for (const args of mainRoleCommands) {
      const help = cli(args, h);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("--as-participant");
    }
  });

  it("does not show --as-participant on reads and listings", () => {
    const h = home();
    const readCommands = [
      ["channel", "list", "--help"],
      ["channel", "show", "--help"],
      ["channel", "messages", "--help"],
      ["channel", "read", "--help"],
    ];
    for (const args of readCommands) {
      const help = cli(args, h);
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain("--as-participant <id>");
    }
  });

  it("accepts four native entries including an empty one, rejects a fifth", () => {
    const h = home();
    const init = cli(["init", "--non-interactive"], h);
    expect(init.status, init.stderr).toBe(0);
    const create = cli(["channel", "create", "--main-handle", "m", "--json"], h);
    expect(create.status, create.stderr).toBe(0);
    // F1: top-level data keyset is exactly {channel}.
    const createEnvelope = JSON.parse(create.stdout) as Record<string, unknown>;
    expect(Object.keys(createEnvelope.data as object).sort()).toEqual(["channel"]);
    const channelId = (createEnvelope.data as { channel: { id: string } }).channel.id;
    const mainId = (createEnvelope.data as { channel: { mainParticipantId: string } }).channel.mainParticipantId;

    const four = cli(
      [
        "channel",
        "participant",
        "add",
        channelId,
        "--role",
        "worker",
        "--handle",
        "w4",
        "--native",
        "",
        "--native",
        "a",
        "--native",
        "b\ttab",
        "--native",
        "c",
        "--as-participant",
        mainId,
        "--json",
      ],
      h,
    );
    expect(four.status, four.stderr).toBe(0);
    const provenance = (JSON.parse(four.stdout) as { data: { participant: { nativeProvenance: string[] } } }).data
      .participant.nativeProvenance;
    expect(provenance).toEqual(["", "a", "b\ttab", "c"]);

    const five = cli(
      [
        "channel",
        "participant",
        "add",
        channelId,
        "--role",
        "worker",
        "--handle",
        "w5",
        "--native",
        "1",
        "--native",
        "2",
        "--native",
        "3",
        "--native",
        "4",
        "--native",
        "5",
        "--as-participant",
        mainId,
        "--json",
      ],
      h,
    );
    expect(five.status, five.stderr).not.toBe(0);
    expect(five.stderr).toContain("CHN_INVALID_INPUT");
  });

  it("accepts an opaque non-UUID idempotency key", () => {
    const h = home();
    const init = cli(["init", "--non-interactive"], h);
    expect(init.status).toBe(0);
    const create = cli(["channel", "create", "--main-handle", "m", "--json"], h);
    expect(create.status).toBe(0);
    const channelId = (JSON.parse(create.stdout) as { data: { channel: { id: string } } }).data.channel.id;
    const mainId = (JSON.parse(create.stdout) as { data: { channel: { mainParticipantId: string } } }).data.channel
      .mainParticipantId;
    cli(
      [
        "channel",
        "participant",
        "add",
        channelId,
        "--role",
        "worker",
        "--handle",
        "w",
        "--as-participant",
        mainId,
        "--json",
      ],
      h,
    );
    const participant = JSON.parse(cli(["channel", "show", channelId, "--json"], h).stdout) as {
      data: { channel: { participants: Array<{ id: string }> } };
    };
    const workerId = participant.data.channel.participants.find((p) => p.id !== mainId)?.id;

    const submit = cli(
      [
        "channel",
        "submit",
        channelId,
        "--as-participant",
        workerId as string,
        "--kind",
        "report",
        "--body",
        "opaque key test",
        "--idempotency-key",
        "not-a-uuid-key",
        "--json",
      ],
      h,
    );
    expect(submit.status, submit.stderr).toBe(0);
    const result = JSON.parse(submit.stdout) as { data: { message: { id: string }; replayed: boolean } };
    expect(result.data.replayed).toBe(false);

    const replay = cli(
      [
        "channel",
        "submit",
        channelId,
        "--as-participant",
        workerId as string,
        "--kind",
        "report",
        "--body",
        "opaque key test",
        "--idempotency-key",
        "not-a-uuid-key",
        "--json",
      ],
      h,
    );
    expect(replay.status, replay.stderr).toBe(0);
    const replayResult = JSON.parse(replay.stdout) as { data: { replayed: boolean; message: { id: string } } };
    expect(replayResult.data.replayed).toBe(true);
    expect(replayResult.data.message.id).toBe(result.data.message.id);
  });

  it("D1: refuses --wait with --handled or --all, and --interval/--timeout without --wait, as exit-2 usage errors", () => {
    const h = home();
    const init = cli(["init", "--non-interactive"], h);
    expect(init.status).toBe(0);
    const create = cli(["channel", "create", "--main-handle", "m", "--json"], h);
    const channelId = (JSON.parse(create.stdout) as { data: { channel: { id: string } } }).data.channel.id;

    // --wait with --handled is a usage error before any operational startup.
    const waitHandled = cli(["channel", "messages", channelId, "--wait", "--handled", "--json"], h);
    expect(waitHandled.status).toBe(2);
    expect(waitHandled.stderr).toContain("--wait lists only unhandled");
    expect(waitHandled.stdout).toBe("");

    // --wait with --all is a usage error.
    const waitAll = cli(["channel", "messages", channelId, "--wait", "--all", "--json"], h);
    expect(waitAll.status).toBe(2);
    expect(waitAll.stderr).toContain("--wait lists only unhandled");

    // --interval without --wait is a usage error (user-supplied, not default).
    const intervalNoWait = cli(["channel", "messages", channelId, "--interval", "3", "--json"], h);
    expect(intervalNoWait.status).toBe(2);
    expect(intervalNoWait.stderr).toContain("--interval and --timeout apply only with --wait");

    // --timeout without --wait is a usage error.
    const timeoutNoWait = cli(["channel", "messages", channelId, "--timeout", "30", "--json"], h);
    expect(timeoutNoWait.status).toBe(2);
    expect(timeoutNoWait.stderr).toContain("--interval and --timeout apply only with --wait");

    // Without those flags, a normal listing still works (defaults are not rejected).
    const normalList = cli(["channel", "messages", channelId, "--json"], h);
    expect(normalList.status, normalList.stderr).toBe(0);
  });

  it("D2: refuses mutually exclusive handling filter combinations", () => {
    const h = home();
    const init = cli(["init", "--non-interactive"], h);
    expect(init.status).toBe(0);
    const create = cli(["channel", "create", "--main-handle", "m", "--json"], h);
    const channelId = (JSON.parse(create.stdout) as { data: { channel: { id: string } } }).data.channel.id;

    const both = cli(["channel", "messages", channelId, "--unhandled", "--handled", "--json"], h);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("at most one of --unhandled, --handled, or --all");

    const three = cli(["channel", "messages", channelId, "--unhandled", "--handled", "--all", "--json"], h);
    expect(three.status).toBe(2);
    expect(three.stderr).toContain("at most one of --unhandled, --handled, or --all");
  });

  it("D3: --as registered Project provides provenance without Channel role authority", () => {
    const h = home();
    const init = cli(["init", "--non-interactive"], h);
    expect(init.status).toBe(0);
    const workDir = mkdtempSync(join(tmpdir(), "sorage-channel-cli-work-"));
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
    const add = cli(["project", "add", "--name", "Alpha", "--dir", workDir], h);
    expect(add.status, add.stderr).toBe(0);

    // Channel creation with --as records the Project as creator provenance.
    const createWithAs = cli(["channel", "create", "--main-handle", "m", "--as", "alpha", "--json"], h);
    expect(createWithAs.status, createWithAs.stderr).toBe(0);
    const channel = JSON.parse(createWithAs.stdout) as {
      data: { channel: { id: string; creatorKind: string; mainParticipantId: string } };
    };
    expect(channel.data.channel.creatorKind).toBe("registered_project");

    // Without --as from an unbound cwd, the actor falls to unregistered workspace.
    const createWithout = cli(["channel", "create", "--main-handle", "m2", "--json"], h);
    expect(createWithout.status, createWithout.stderr).toBe(0);
    const channel2 = JSON.parse(createWithout.stdout) as {
      data: { channel: { creatorKind: string } };
    };
    expect(channel2.data.channel.creatorKind).toBe("unregistered_workspace");

    // --as with an unknown Project gives the existing resolution error, not an invented Channel one.
    const invalidAs = cli(["channel", "create", "--main-handle", "m3", "--as", "nonexistent", "--json"], h);
    expect(invalidAs.status, invalidAs.stderr).not.toBe(0);
    expect(invalidAs.stderr).not.toContain("CHN_");
  });

  it.each(["absolute", "tilde"])(
    "keeps replay capture outside an external Vault with a %s path and TMPDIR inside it",
    async (pathMode) => {
      const h = home();
      const external = home();
      const taskEnv = { HOME: external };
      const vault = join(external, "vault");
      expect(cli(["init", "--non-interactive", "--vault", vault], h, taskEnv).status).toBe(0);
      if (pathMode === "tilde") {
        // Change only the valid file-view representation, preserving the actual
        // Vault binding. Shell expansion of an init argument is a different path.
        const configPath = join(h, "config.yaml");
        const text = readFileSync(configPath, "utf8");
        const absolute = `  path: ${vault}\n`;
        expect(text).toContain(absolute);
        writeFileSync(configPath, text.replace(absolute, "  path: ~/vault\n"));
      }
      const created = JSON.parse(cli(["channel", "create", "--main-handle", "m", "--json"], h, taskEnv).stdout).data
        .channel;
      const worker = JSON.parse(
        cli(
          [
            "channel",
            "participant",
            "add",
            created.id,
            "--role",
            "worker",
            "--handle",
            "w",
            "--as-participant",
            created.mainParticipantId,
            "--json",
          ],
          h,
          taskEnv,
        ).stdout,
      ).data.participant;
      const original = join(h, "original.txt");
      writeFileSync(original, `\uFEFF${"body ".repeat(1_600_000)}tail`);
      const submit = [
        "channel",
        "submit",
        created.id,
        "--as-participant",
        worker.id,
        "--kind",
        "report",
        "--body-file",
        original,
        "--idempotency-key",
        "scratch-key",
        "--json",
      ];
      const accepted = cli(submit, h, taskEnv);
      expect(accepted.status, accepted.stderr).toBe(0);
      const tmpInsideVault = join(vault, "tmp-inside");
      mkdirSync(tmpInsideVault);
      const observation = home();
      const tracePath = join(observation, "scratch.jsonl");
      const preload = join(observation, "observe-scratch.mjs");
      // Observe the actual native filesystem call, including scratch that is
      // removed before exit. Directory notifications can drop/coalesce events.
      writeFileSync(
        preload,
        `import { mock } from "bun:test";
import * as fs from "node:fs";
import { dirname, sep } from "node:path";
const original = fs.mkdtempSync;
const roots = ${JSON.stringify([h, vault])}.map((root) => fs.realpathSync(root));
mock.module("node:fs", () => ({ ...fs, mkdtempSync(prefix, options) {
  const parent = fs.realpathSync(dirname(String(prefix)));
  if (roots.some((root) => parent === root || parent.startsWith(root + sep))) {
    throw new Error("REPLAY_SCRATCH_INSIDE_PROTECTED_ROOT");
  }
  const path = original(prefix, options);
  fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ parent, path }) + "\\n");
  return path;
} }));
`,
      );
      const beforeHome = fingerprint(h),
        beforeVault = fingerprint(vault);
      // Positive controls prove that the preload rejects either forbidden
      // placement before its transient creation, rather than silently missing it.
      for (const root of [h, tmpInsideVault]) {
        const control = spawnSync(
          "bun",
          [
            "--preload",
            preload,
            "--eval",
            `import { mkdtempSync } from "node:fs"; mkdtempSync(${JSON.stringify(join(root, "forbidden-"))});`,
          ],
          { encoding: "utf8", env: { ...process.env, ...taskEnv, SORAGE_HOME: h }, timeout: 10_000 },
        );
        expect(control.status).not.toBe(0);
        expect(control.stderr).toContain("REPLAY_SCRATCH_INSIDE_PROTECTED_ROOT");
      }
      const replay = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(
          "bun",
          [
            "--preload",
            preload,
            entry,
            ...submit,
            "--replay-only",
            "--as",
            "missing-current-project",
            "--expected-row-version",
            "9",
          ],
          {
            cwd: join(h, "work"),
            env: { ...process.env, ...taskEnv, SORAGE_HOME: h, TMPDIR: tmpInsideVault },
            timeout: 10_000,
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(replay.code, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout).data).toMatchObject({
        replayed: true,
        message: { id: JSON.parse(accepted.stdout).data.message.id },
      });
      const scratch = readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { parent: string; path: string });
      expect(scratch.some((record) => record.path.includes("sorage-channel-recovery-"))).toBe(true);
      for (const record of scratch) {
        for (const root of [h, vault]) {
          expect(record.parent === root || record.parent.startsWith(`${root}/`)).toBe(false);
        }
      }
      expect(fingerprint(h)).toEqual(beforeHome);
      expect(fingerprint(vault)).toEqual(beforeVault);
    },
  );

  it("accepts the uniform version option on all seven unversioned mutations and refuses it on reads", () => {
    const h = home();
    expect(cli(["init", "--non-interactive"], h).status).toBe(0);
    function mutate(args: string[], before = false) {
      const flag = ["--expected-row-version", "9"];
      const result = cli(before ? [...flag, ...args, "--json"] : [...args, ...flag, "--json"], h);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).data;
    }
    const channel = mutate(["channel", "create", "--main-handle", "m"], true).channel;
    const assertion = ["--as-participant", channel.mainParticipantId];
    const worker = mutate([
      "channel",
      "participant",
      "add",
      channel.id,
      "--role",
      "worker",
      "--handle",
      "w",
      ...assertion,
    ]).participant;
    const assignment = mutate(
      ["channel", "assignment", "add", channel.id, "--label", "task", "--participant", worker.id, ...assertion],
      true,
    ).assignment;
    const submit = [
      "channel",
      "submit",
      channel.id,
      "--as-participant",
      worker.id,
      "--kind",
      "report",
      "--body",
      "report",
    ];
    const message = mutate(submit).message;
    mutate(["channel", "assignment", "close", channel.id, assignment.id, ...assertion]);
    mutate(["channel", "participant", "deactivate", channel.id, worker.id, ...assertion], true);
    mutate(["channel", "close", channel.id, ...assertion]);
    for (const args of [
      ["channel", "list"],
      ["channel", "show", channel.id],
      ["channel", "messages", channel.id],
      ["channel", "read", channel.id, message.id],
    ]) {
      const result = cli(["--expected-row-version", "1", ...args, "--json"], h);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
    }
    for (const value of ["1.5", "-1", "9007199254740992", "not-a-number"]) {
      const result = cli(["channel", "create", "--main-handle", "invalid-version", "--expected-row-version", value], h);
      expect(result.status, result.stderr).toBe(2);
    }
    const unchanged = JSON.parse(cli(["channel", "show", channel.id, "--json"], h).stdout).data.channel;
    expect(unchanged.messageCount).toBe(1);
    expect(unchanged.unhandledCount).toBe(1);
    expect(unchanged.state).toBe("closed");
  });

  it("P3-G: handle accepts the global --expected-row-version before or after the command", () => {
    const h = home();
    const init = cli(["init", "--non-interactive"], h);
    expect(init.status).toBe(0);
    const create = cli(["channel", "create", "--main-handle", "m", "--json"], h);
    const channelId = (JSON.parse(create.stdout) as { data: { channel: { id: string; mainParticipantId: string } } })
      .data.channel.id;
    const mainId = (JSON.parse(create.stdout) as { data: { channel: { mainParticipantId: string } } }).data.channel
      .mainParticipantId;
    cli(
      [
        "channel",
        "participant",
        "add",
        channelId,
        "--role",
        "worker",
        "--handle",
        "w",
        "--as-participant",
        mainId,
        "--json",
      ],
      h,
    );
    const show = JSON.parse(cli(["channel", "show", channelId, "--json"], h).stdout) as {
      data: { channel: { participants: Array<{ id: string }> } };
    };
    const workerId = show.data.channel.participants.find((p) => p.id !== mainId)?.id;
    cli(
      [
        "channel",
        "submit",
        channelId,
        "--as-participant",
        workerId as string,
        "--kind",
        "report",
        "--body",
        "handle me",
        "--json",
      ],
      h,
    );
    const messages = JSON.parse(cli(["channel", "messages", channelId, "--json"], h).stdout) as {
      data: { items: Array<{ id: string }> };
    };
    const messageId = messages.data.items[0]?.id;

    // Global flag before the command.
    const before = cli(
      [
        "--expected-row-version",
        "1",
        "channel",
        "handle",
        channelId,
        messageId as string,
        "--as-participant",
        mainId,
        "--json",
      ],
      h,
    );
    // This should fail because the message was already handled by the first attempt (or succeed if this is the first).
    // Re-submit for the second test.
    expect(before.status, before.stderr).toBe(0);

    // Submit another message and handle with the flag after the command.
    cli(
      [
        "channel",
        "submit",
        channelId,
        "--as-participant",
        workerId as string,
        "--kind",
        "report",
        "--body",
        "second",
        "--json",
      ],
      h,
    );
    const messages2 = JSON.parse(cli(["channel", "messages", channelId, "--json"], h).stdout) as {
      data: { items: Array<{ id: string }> };
    };
    const messageId2 = messages2.data.items[0]?.id;
    const after = cli(
      [
        "channel",
        "handle",
        channelId,
        messageId2 as string,
        "--as-participant",
        mainId,
        "--expected-row-version",
        "1",
        "--json",
      ],
      h,
    );
    expect(after.status, after.stderr).toBe(0);

    // Missing version on handle is an error.
    cli(
      [
        "channel",
        "submit",
        channelId,
        "--as-participant",
        workerId as string,
        "--kind",
        "report",
        "--body",
        "third",
        "--json",
      ],
      h,
    );
    const messages3 = JSON.parse(cli(["channel", "messages", channelId, "--json"], h).stdout) as {
      data: { items: Array<{ id: string }> };
    };
    const messageId3 = messages3.data.items[0]?.id;
    const missing = cli(
      ["channel", "handle", channelId, messageId3 as string, "--as-participant", mainId, "--json"],
      h,
    );
    expect(missing.status, missing.stderr).not.toBe(0);
    expect(missing.stderr).toContain("expected-row-version");
  });

  it("renders channel list with ChannelSummary fields, not MessageSummary fields", () => {
    const h = home();
    const init = cli(["init", "--non-interactive"], h);
    expect(init.status).toBe(0);
    cli(["channel", "create", "--main-handle", "alpha-main", "--title", "Alpha Channel", "--json"], h);
    cli(["channel", "create", "--main-handle", "beta-main", "--json"], h);

    const list = cli(["channel", "list"], h);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain("alpha-main");
    expect(list.stdout).toContain("Alpha Channel");
    expect(list.stdout).toContain("beta-main");
    expect(list.stdout).toContain("[open]");
    expect(list.stdout).not.toContain("undefined");
    expect(list.stdout).not.toContain("bodyPreview");
    expect(list.stdout).not.toContain("senderHandle");
    expect(list.stdout).not.toContain("[report]");
    expect(list.stdout).not.toContain("[question]");

    // An empty list is reasonable.
    const emptyHome = home();
    cli(["init", "--non-interactive"], emptyHome);
    const empty = cli(["channel", "list"], emptyHome);
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout.trim()).toBe("");
  });

  it("F1: every operation returns its exact closed top-level data keyset", () => {
    const h = home();
    cli(["init", "--non-interactive"], h);
    const keys = (stdout: string): string[] => Object.keys(JSON.parse(stdout).data as object).sort();

    // create → {channel}
    const create = cli(["channel", "create", "--main-handle", "m", "--title", "T", "--json"], h);
    expect(create.status).toBe(0);
    expect(keys(create.stdout)).toEqual(["channel"]);
    const ch = JSON.parse(create.stdout).data.channel as { id: string; mainParticipantId: string };
    const channelId = ch.id;
    const mainId = ch.mainParticipantId;

    // list → {items, nextCursor}
    const list = cli(["channel", "list", "--json"], h);
    expect(list.status).toBe(0);
    expect(keys(list.stdout)).toEqual(["items", "nextCursor"]);

    // show → {channel}
    const show = cli(["channel", "show", channelId, "--json"], h);
    expect(show.status).toBe(0);
    expect(keys(show.stdout)).toEqual(["channel"]);

    // participant add → {participant}
    const participant = cli(
      [
        "channel",
        "participant",
        "add",
        channelId,
        "--role",
        "worker",
        "--handle",
        "w",
        "--as-participant",
        mainId,
        "--json",
      ],
      h,
    );
    expect(participant.status, participant.stderr).toBe(0);
    expect(keys(participant.stdout)).toEqual(["participant"]);
    const workerId = JSON.parse(participant.stdout).data.participant.id as string;

    // participant deactivate → {participant}
    const deactivate = cli(
      ["channel", "participant", "deactivate", channelId, workerId, "--as-participant", mainId, "--json"],
      h,
    );
    expect(deactivate.status).toBe(0);
    expect(keys(deactivate.stdout)).toEqual(["participant"]);

    // assignment add → {assignment}
    const assignment = cli(
      ["channel", "assignment", "add", channelId, "--label", "L", "--as-participant", mainId, "--json"],
      h,
    );
    expect(assignment.status).toBe(0);
    expect(keys(assignment.stdout)).toEqual(["assignment"]);
    const assignmentId = JSON.parse(assignment.stdout).data.assignment.id as string;

    // assignment close → {assignment}
    const closeA = cli(
      ["channel", "assignment", "close", channelId, assignmentId, "--as-participant", mainId, "--json"],
      h,
    );
    expect(closeA.status).toBe(0);
    expect(keys(closeA.stdout)).toEqual(["assignment"]);

    // submit → {message, replayed}
    const submitArgs = [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      mainId,
      "--kind",
      "report",
      "--body",
      "body text",
      "--idempotency-key",
      "wrapper-original",
      "--json",
    ];
    const submit = cli(submitArgs, h);
    expect(submit.status, submit.stderr).toBe(0);
    expect(keys(submit.stdout)).toEqual(["message", "replayed"]);
    const messageId = JSON.parse(submit.stdout).data.message.id as string;
    const replay = cli([...submitArgs, "--replay-only"], h);
    expect(replay.status, replay.stderr).toBe(0);
    expect(keys(replay.stdout)).toEqual(["message", "replayed"]);
    expect(JSON.parse(replay.stdout).data.replayed).toBe(true);

    // messages → {items, nextCursor}
    const messages = cli(["channel", "messages", channelId, "--json"], h);
    expect(messages.status).toBe(0);
    expect(keys(messages.stdout)).toEqual(["items", "nextCursor"]);
    const pending = cli(["channel", "messages", channelId, "--wait", "--timeout", "1", "--json"], h);
    expect(pending.status, pending.stderr).toBe(0);
    expect(keys(pending.stdout)).toEqual(["items", "nextCursor"]);
    expect(JSON.parse(pending.stdout).data.items).toHaveLength(1);

    // read → {message}
    const read = cli(["channel", "read", channelId, messageId, "--json"], h);
    expect(read.status).toBe(0);
    expect(keys(read.stdout)).toEqual(["message"]);

    // handle → {message}
    const handle = cli(
      ["channel", "handle", channelId, messageId, "--expected-row-version", "1", "--as-participant", mainId, "--json"],
      h,
    );
    expect(handle.status, handle.stderr).toBe(0);
    expect(keys(handle.stdout)).toEqual(["message"]);
    const timeout = cli(["channel", "messages", channelId, "--wait", "--interval", "1", "--timeout", "1", "--json"], h);
    expect(timeout.status, timeout.stderr).toBe(0);
    expect(keys(timeout.stdout)).toEqual(["items", "nextCursor"]);
    expect(JSON.parse(timeout.stdout)).toMatchObject({
      data: { items: [], nextCursor: null },
      meta: { timedOut: true },
    });

    // close → {channel}
    const close = cli(["channel", "close", channelId, "--as-participant", mainId, "--json"], h);
    expect(close.status).toBe(0);
    expect(keys(close.stdout)).toEqual(["channel"]);
  });

  it("refuses conflicting body sources in normal and replay-only modes without changing the original outcome", () => {
    const h = home();
    cli(["init", "--non-interactive"], h);
    const create = cli(["channel", "create", "--main-handle", "m", "--json"], h);
    const channelId = JSON.parse(create.stdout).data.channel.id as string;
    const mainId = JSON.parse(create.stdout).data.channel.mainParticipantId as string;
    const bodyFile = join(h, "body.txt");
    writeFileSync(bodyFile, "\uFEFFfile body\r\n");
    const originalArgs = [
      "channel",
      "submit",
      channelId,
      "--as-participant",
      mainId,
      "--kind",
      "report",
      "--body-file",
      bodyFile,
      "--idempotency-key",
      "original-file-key",
      "--json",
    ];
    const original = cli(originalArgs, h);
    expect(original.status, original.stderr).toBe(0);
    const authoritative = () =>
      Object.fromEntries(Object.entries(fingerprint(h)).filter(([path]) => !path.startsWith(`${join(h, "logs")}/`)));
    const before = authoritative();
    for (const mode of [[], ["--replay-only"]]) {
      const beforeInvocation = fingerprint(h);
      const refused = cli([...originalArgs, "--body", "different text body", ...mode], h);
      expect(refused.status, refused.stderr).toBe(64);
      expect(JSON.parse(refused.stderr).error.code).toBe("CHN_INVALID_INPUT");
      expect(refused.stderr).toContain("Choose one body source");
      // Normal errors retain the existing diagnostic logger. Both modes
      // preserve authoritative bytes; replay-only must not even change logs.
      expect(authoritative()).toEqual(before);
      if (mode.length > 0) expect(fingerprint(h)).toEqual(beforeInvocation);
    }
    const beforeRecovery = fingerprint(h);
    const recovered = cli([...originalArgs, "--replay-only"], h);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).data).toEqual({
      message: JSON.parse(original.stdout).data.message,
      replayed: true,
    });
    expect(fingerprint(h)).toEqual(beforeRecovery);
  });

  it.each([false, true])("keeps recovery failures non-mutating with JSON=%s", (json) => {
    const h = home();
    expect(cli(["init", "--non-interactive"], h).status).toBe(0);
    const created = JSON.parse(cli(["channel", "create", "--main-handle", "m", "--json"], h).stdout).data.channel;
    const bodyFile = join(h, "original.txt");
    writeFileSync(bodyFile, "\uFEFForiginal\r\n");
    const base = ["channel", "submit", created.id, "--as-participant", created.mainParticipantId, "--kind", "report"];
    const original = [...base, "--body-file", bodyFile, "--idempotency-key", "original-key"];
    expect(cli([...original, "--json"], h).status).toBe(0);
    const output = json ? ["--json"] : [];
    const replay = [...original, "--replay-only", ...output];

    function refused(args: string[], code: string, status: number, preload?: string) {
      const before = fingerprint(h);
      const result =
        preload === undefined
          ? cli(args, h)
          : spawnSync("bun", ["--preload", preload, entry, ...args], {
              encoding: "utf8",
              cwd: join(h, "work"),
              env: { ...process.env, SORAGE_HOME: h },
              timeout: 10_000,
            });
      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(code);
      expect(result.stderr).toContain("original submission outcome remains unknown");
      expect(result.stderr).toContain("request ");
      expect(result.stderr).not.toMatch(
        /\b(?:check|see|inspect)\s+(?:the\s+)?(?:installation\s+)?logs?\b|sorage\.log/i,
      );
      if (json) expect(JSON.parse(result.stderr as string).error.code).toBe(code);
      expect(fingerprint(h)).toEqual(before);
    }

    refused([...replay, "--confirm"], "CHN_INVALID_INPUT", 64);
    refused([...replay, "--body", "conflicting source"], "CHN_INVALID_INPUT", 64);
    refused([...base, "--body-file", bodyFile, "--replay-only", ...output], "CHN_INVALID_INPUT", 64);
    refused(
      [...base, "--body-file", bodyFile, "--idempotency-key", "unknown-original", "--replay-only", ...output],
      "CHN_REPLAY_UNAVAILABLE",
      75,
    );
    refused(
      [
        ...base,
        "--body",
        "different original material",
        "--idempotency-key",
        "original-key",
        "--replay-only",
        ...output,
      ],
      "IDEMPOTENCY_CONFLICT",
      75,
    );
    refused(
      [...base, "--body-file", join(h, "missing.txt"), "--idempotency-key", "original-key", "--replay-only", ...output],
      "CHN_INVALID_INPUT",
      64,
    );

    const configPath = join(h, "config.yaml");
    const config = readFileSync(configPath);
    try {
      writeFileSync(configPath, "not: the-supported-configuration\n");
      refused(replay, "CONFIG_INVALID", 78);
    } finally {
      writeFileSync(configPath, config);
    }

    try {
      writeFileSync(configPath, config.toString("utf8").replace("schemaVersion: 1", "schemaVersion: 2"));
      refused(replay, "STORAGE_SCHEMA_UNSUPPORTED", 78);
    } finally {
      writeFileSync(configPath, config);
    }

    const configObservation = home();
    const savedConfig = join(configObservation, "original-config.yaml");
    const linkedConfig = join(configObservation, "invalid-config.yaml");
    writeFileSync(linkedConfig, "schemaVersion: 1\ninvalid: configuration\n");
    renameSync(configPath, savedConfig);
    try {
      refused(replay, "NOT_INITIALIZED", 78);
      mkdirSync(configPath);
      refused(replay, "STORAGE_INSPECTION_UNAVAILABLE", 75);
      expect(lstatSync(configPath).isDirectory()).toBe(true);
      expect(readdirSync(configPath)).toEqual([]);
      rmSync(configPath, { recursive: true });
      for (const target of [linkedConfig, join(configObservation, "missing-config.yaml")]) {
        symlinkSync(target, configPath);
        refused(replay, "STORAGE_INSPECTION_UNAVAILABLE", 75);
        expect(readlinkSync(configPath)).toBe(target);
        rmSync(configPath);
      }
    } finally {
      rmSync(configPath, { force: true, recursive: true });
      renameSync(savedConfig, configPath);
    }

    const canonicalConfigPath = realpathSync(configPath);
    for (const code of ["EACCES", "EPERM", "unexpected"]) {
      const preload = join(configObservation, `deny-config-${code}.mjs`);
      const marker = join(configObservation, `denied-${code}.txt`);
      writeFileSync(
        preload,
        `import { mock } from "bun:test";
import * as fs from "node:fs";
const original = fs.readFileSync;
mock.module("node:fs", () => ({ ...fs, readFileSync(path, options) {
  if (String(path) === ${JSON.stringify(canonicalConfigPath)}) {
    fs.writeFileSync(${JSON.stringify(marker)}, "denied");
    throw ${code === "unexpected" ? 'new Error("unexpected configuration reader defect")' : `Object.assign(new Error("config read denied"), { code: ${JSON.stringify(code)} })`};
  }
  return original(path, options);
} }));
`,
      );
      refused(
        replay,
        code === "unexpected" ? "INTERNAL_ERROR" : "STORAGE_INSPECTION_UNAVAILABLE",
        code === "unexpected" ? 1 : 75,
        preload,
      );
      expect(readFileSync(marker, "utf8")).toBe("denied");
    }

    // A directory alias is allowed; a linked managed config file is not.
    const alias = join(configObservation, "installation-alias");
    symlinkSync(h, alias, "dir");
    const beforeAlias = fingerprint(h);
    const aliasReplay = cli(replay, alias);
    expect(aliasReplay.status, aliasReplay.stderr).toBe(0);
    expect(fingerprint(h)).toEqual(beforeAlias);

    const changingPreload = join(configObservation, "change-config.mjs");
    const changedConfig = `${config.toString("utf8")}\n# concurrent configuration update\n`;
    const changedMarker = join(configObservation, "changed-config.txt");
    writeFileSync(
      changingPreload,
      `import { mock } from "bun:test";
import * as fs from "node:fs";
const original = fs.readFileSync;
let changed = false;
mock.module("node:fs", () => ({ ...fs, readFileSync(path, options) {
  const bytes = original(path, options);
  if (!changed && String(path) === ${JSON.stringify(canonicalConfigPath)}) {
    changed = true;
    fs.writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(changedConfig)});
    fs.writeFileSync(${JSON.stringify(changedMarker)}, "changed after first actual read");
  }
  return bytes;
} }));
`,
    );
    const beforeChanging = fingerprint(h);
    try {
      const changing = spawnSync("bun", ["--preload", changingPreload, entry, ...replay], {
        encoding: "utf8",
        cwd: join(h, "work"),
        env: { ...process.env, SORAGE_HOME: h },
        timeout: 10_000,
      });
      expect(changing.status, changing.stderr).toBe(75);
      expect(changing.stdout).toBe("");
      expect(changing.stderr).toContain("STORAGE_INSPECTION_UNAVAILABLE");
      expect(changing.stderr).toContain("original submission outcome remains unknown");
      if (json) expect(JSON.parse(changing.stderr).error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(readFileSync(changedMarker, "utf8")).toBe("changed after first actual read");
      // The test's concurrent writer changes only config; recovery adds no changes.
      expect(fingerprint(h)).toEqual({
        ...beforeChanging,
        [configPath]: createHash("sha256").update(changedConfig).digest("hex"),
      });
    } finally {
      writeFileSync(configPath, config);
    }

    const saved = join(home(), "preserved.sqlite3");
    const database = join(h, "state", "sorage.sqlite3");
    renameSync(database, saved);
    try {
      refused(replay, "STORAGE_INTEGRITY_ERROR", 73);
    } finally {
      renameSync(saved, database);
    }

    // A native exception at the actual scratch-creation boundary must not
    // escape to the general parser's usage renderer or installation logger.
    const observation = home();
    const preload = join(observation, "throw-scratch.mjs");
    const marker = join(observation, "attempted.txt");
    writeFileSync(
      preload,
      `import { mock } from "bun:test";
import * as fs from "node:fs";
const original = fs.mkdtempSync;
mock.module("node:fs", () => ({ ...fs, mkdtempSync(prefix, options) {
  if (String(prefix).includes("sorage-channel-recovery-")) {
    fs.writeFileSync(${JSON.stringify(marker)}, "attempted");
    throw new Error("forced-scratch-failure: inspect installation logs");
  }
  return original(prefix, options);
} }));
`,
    );
    refused(replay, "INTERNAL_ERROR", 1, preload);
    expect(readFileSync(marker, "utf8")).toBe("attempted");

    const beforeSuccess = fingerprint(h);
    const recovered = cli(replay, h);
    expect(recovered.status, recovered.stderr).toBe(0);
    if (json) expect(JSON.parse(recovered.stdout).data.replayed).toBe(true);
    else expect(recovered.stdout).toContain("Replayed the original recorded outcome");
    expect(fingerprint(h)).toEqual(beforeSuccess);
  });
});
