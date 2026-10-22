import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  envelopeOf,
  errorEnvelopeOf,
  makeTempDir,
  registerCleanup,
  runCleanups,
  sorage,
  storageProof,
} from "./helpers";

/**
 * The TASK-119 compiled write-protected journey: a stable, readable
 * installation whose database and WAL are write-protected (the saved modes are
 * restored by the journey's cleanup) inspects normally — preflight reports
 * `compatible` and both replay-only modes return their retained results, all
 * with a byte-identical installation — while Channel, Handoff, and Project
 * operational commands refuse with the typed write-protected envelope at exit
 * 75, and genuine lock contention on a writable home still answers the
 * contention wording, never the write-protected one.
 */

afterEach(runCleanups);

const WRITE_PROTECTED_CHANNEL_MESSAGE =
  "Channel storage is write-protected: the Sorage database cannot be written by this invocation, so this Channel command committed none of the changes it was asked to make.";
const WRITE_PROTECTED_CHANNEL_RECOVERY =
  "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical channel command with its original mode, inputs, and idempotency key; when the original outcome of a keyed submission is unknown, inspect with --replay-only and the original material first, which runs without write access.";
const WRITE_PROTECTED_HANDOFF_MESSAGE =
  "Handoff storage is write-protected: the Sorage database cannot be written by this invocation, so this command committed none of the changes it was asked to make.";
const WRITE_PROTECTED_HANDOFF_RECOVERY =
  "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical command with its original mode, inputs, and idempotency key; when the original outcome of a keyed send is unknown, inspect with sorage send --replay-only and the original material first, which runs without write access.";
const WRITE_PROTECTED_PROJECT_MESSAGE =
  "Project storage is write-protected: the Sorage database cannot be written by this invocation, so this command committed none of the changes it was asked to make.";
const WRITE_PROTECTED_PROJECT_RECOVERY =
  "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical command; it committed none of the changes it was asked to make.";

/** One installation with retained keyed send and Channel receipts, then — by default — write-protected. */
function protectedInstallation(protect = true): {
  home: string;
  work: string;
  sendArgs: string[];
  channelArgs: string[];
  channelId: string;
  databasePath: string;
} {
  const home = makeTempDir("sorage-write-protected-home-");
  const work = makeTempDir("sorage-write-protected-work-");
  for (const args of [
    ["init", "--non-interactive"],
    ["project", "add", "--name", "Alpha", "--dir", work],
  ]) {
    const run = sorage([...args, "--json"], { home, cwd: work });
    expect(run.status, run.stderr).toBe(0);
  }
  const created = sorage(["channel", "create", "--main-handle", "orchestrator", "--as-user", "--json"], {
    home,
    cwd: work,
  });
  expect(created.status, created.stderr).toBe(0);
  const channel = envelopeOf(created).data as { channel: { id: string; mainParticipantId: string } };
  const body = "original body";
  const sendArgs = ["send", "--to", "alpha", "--title", "Original", "--body", body, "--idempotency-key", "send-key"];
  const sent = sorage([...sendArgs, "--json"], { home, cwd: work });
  expect(sent.status, sent.stderr).toBe(0);
  const channelArgs = [
    "channel",
    "submit",
    channel.channel.id,
    "--as-participant",
    channel.channel.mainParticipantId,
    "--kind",
    "report",
    "--body",
    "channel body",
    "--idempotency-key",
    "channel-key",
  ];
  const submitted = sorage([...channelArgs, "--json"], { home, cwd: work });
  expect(submitted.status, submitted.stderr).toBe(0);
  const databasePath = join(home, "state", "sorage.sqlite3");
  if (protect) {
    const savedModes = new Map<string, number>();
    for (const path of [databasePath, `${databasePath}-wal`]) {
      const mode = statSync(path).mode & 0o777;
      savedModes.set(path, mode);
      chmodSync(path, 0o444);
    }
    registerCleanup(() => {
      for (const [path, mode] of savedModes) chmodSync(path, mode);
    });
  }
  return { home, work, sendArgs, channelArgs, channelId: channel.channel.id, databasePath };
}

describe("a write-protected installation (TASK-119)", () => {
  it("inspects normally: preflight reports its real verdict and both replays return their retained results, all without writing the installation", () => {
    const f = protectedInstallation();
    const before = storageProof(f.home);

    const preflight = sorage(["preflight", "--json"], { home: f.home });
    expect(preflight.status, preflight.stderr).toBe(0);
    expect((envelopeOf(preflight).data as { status: string }).status).toBe("compatible");

    const sendReplay = sorage([...f.sendArgs, "--replay-only", "--json"], { home: f.home, cwd: f.work });
    expect(sendReplay.status, sendReplay.stderr).toBe(0);
    expect((envelopeOf(sendReplay).data as { replayed: boolean }).replayed).toBe(true);

    const channelReplay = sorage([...f.channelArgs, "--replay-only", "--json"], { home: f.home, cwd: f.work });
    expect(channelReplay.status, channelReplay.stderr).toBe(0);
    const replayed = envelopeOf(channelReplay).data as { replayed: boolean; message: { bodyPreview: string } };
    expect(replayed.replayed).toBe(true);
    expect(replayed.message.bodyPreview).toContain("channel body");

    expect(storageProof(f.home)).toEqual(before);
  });

  it("refuses Channel, Handoff, and Project operational commands with the typed write-protected envelope", () => {
    const f = protectedInstallation();

    const channel = sorage(["channel", "list", "--json"], { home: f.home, cwd: f.work });
    expect(channel.status).toBe(75);
    expect(channel.stdout).toBe("");
    const channelEnvelope = JSON.parse(channel.stderr) as {
      error: {
        code: string;
        message: string;
        details: Record<string, unknown>;
        recovery: { suggestedCommand: string };
      };
    };
    expect(channelEnvelope.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(channelEnvelope.error.message).toBe(WRITE_PROTECTED_CHANNEL_MESSAGE);
    expect(channelEnvelope.error.details.storageContention).toBe(true);
    expect(channelEnvelope.error.recovery.suggestedCommand).toBe(WRITE_PROTECTED_CHANNEL_RECOVERY);

    const human = sorage(["channel", "list"], { home: f.home, cwd: f.work });
    expect(human.status).toBe(75);
    expect(human.stderr).toBe(
      `STORAGE_INSPECTION_UNAVAILABLE: ${WRITE_PROTECTED_CHANNEL_MESSAGE}\nRecovery: ${WRITE_PROTECTED_CHANNEL_RECOVERY}\n`,
    );

    const send = sorage(["send", "--to", "alpha", "--title", "Second", "--body", "b2", "--json"], {
      home: f.home,
      cwd: f.work,
    });
    expect(send.status).toBe(75);
    expect(send.stdout).toBe("");
    const sendEnvelope = JSON.parse(send.stderr) as {
      error: { code: string; message: string; recovery: { suggestedCommand: string } };
    };
    expect(sendEnvelope.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(sendEnvelope.error.message).toBe(WRITE_PROTECTED_HANDOFF_MESSAGE);
    expect(sendEnvelope.error.recovery.suggestedCommand).toBe(WRITE_PROTECTED_HANDOFF_RECOVERY);

    const sendHuman = sorage(["send", "--to", "alpha", "--title", "Second", "--body", "b3"], {
      home: f.home,
      cwd: f.work,
    });
    expect(sendHuman.status).toBe(75);
    expect(sendHuman.stderr).toBe(
      `STORAGE_INSPECTION_UNAVAILABLE: ${WRITE_PROTECTED_HANDOFF_MESSAGE}\nRecovery: ${WRITE_PROTECTED_HANDOFF_RECOVERY}\n`,
    );

    const project = sorage(["project", "list", "--json"], { home: f.home, cwd: f.work });
    expect(project.status).toBe(75);
    expect(project.stdout).toBe("");
    const projectEnvelope = JSON.parse(project.stderr) as {
      error: { code: string; message: string; recovery: { suggestedCommand: string } };
    };
    expect(projectEnvelope.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(projectEnvelope.error.message).toBe(WRITE_PROTECTED_PROJECT_MESSAGE);
    expect(projectEnvelope.error.recovery.suggestedCommand).toBe(WRITE_PROTECTED_PROJECT_RECOVERY);

    const projectHuman = sorage(["project", "list"], { home: f.home, cwd: f.work });
    expect(projectHuman.status).toBe(75);
    expect(projectHuman.stderr).toBe(
      `STORAGE_INSPECTION_UNAVAILABLE: ${WRITE_PROTECTED_PROJECT_MESSAGE}\nRecovery: ${WRITE_PROTECTED_PROJECT_RECOVERY}\n`,
    );
    // Project surfaces take no idempotency key and have no replay-only mode,
    // so no key, mode, or replay-only guidance appears (S1).
    expect(projectHuman.stderr).not.toContain("idempotency");
    expect(projectHuman.stderr).not.toContain("mode");
    expect(projectHuman.stderr).not.toContain("replay-only");
  });

  it("still answers genuine lock contention with the contention wording on a writable home", () => {
    const f = protectedInstallation(false);
    const holder = new DatabaseSync(f.databasePath);
    registerCleanup(() => holder.close());
    holder.exec("BEGIN IMMEDIATE");
    const run = sorage(["channel", "list", "--json"], { home: f.home, cwd: f.work });
    expect(run.status).toBe(75);
    const refusal = errorEnvelopeOf(run);
    expect(refusal.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(refusal.error.message).toContain("Channel storage is contended");
    expect(refusal.error.message).not.toContain("write-protected");
  });
});
