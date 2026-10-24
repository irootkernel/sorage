import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { appError, err } from "@sorage/core";
import * as handoffCommandPorts from "@sorage/adapters/src/handoff-command-ports";
import * as channelCommandPorts from "@sorage/adapters/src/channel-command-ports";
import * as projectCommandPorts from "@sorage/adapters/src/project-command-ports";
import * as inboxMarkerPorts from "@sorage/adapters/src/inbox-marker-ports";
import * as migrator from "@sorage/adapters/src/sqlite/migrator";
import * as sqliteConnections from "@sorage/adapters/src/sqlite/connection";
import type { SorageSqlite } from "@sorage/adapters/src/sqlite/connection";
import { runCli } from "../../src/main";

/**
 * The SHR-015 storage-preparation contention contract at the CLI boundary: the
 * typed envelope, exit 75, and per-surface recovery for the Channel, Handoff,
 * and Project families; genuine usage errors keeping exit 2; the unreadable
 * configuration split (covered CONFIG_INVALID, excluded NOT_INITIALIZED,
 * replay-only keeping its recovery semantics); the contained post-commit
 * warning paths; and the Channel command's one-open-and-migrate actor
 * resolution with every connection closed.
 */

interface Captured {
  out: string[];
  err: string[];
  ports: { out: (text: string) => void; err: (text: string) => void };
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, ports: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

function envelopeOf(captured: Captured): {
  ok: boolean;
  error?: { code: string; message: string; details: Record<string, unknown>; recovery?: { suggestedCommand: string } };
} {
  return JSON.parse(captured.err.join(""));
}

let home: string;
let work: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sorage-cli-contention-"));
  work = mkdtempSync(join(tmpdir(), "sorage-cli-contention-work-"));
  process.env.SORAGE_HOME = home;
  const init = capture();
  expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive"], init.ports)).toBe(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function registerProject(slug = "alpha"): void {
  const added = capture();
  const dir = slug === "alpha" ? work : mkdtempSync(join(tmpdir(), `sorage-cli-contention-${slug}-`));
  const code = runCli(["project", "add", "--name", "Alpha", "--slug", slug, "--dir", dir, "--json"], added.ports);
  expect(code, added.err.join("")).toBe(0);
}

/** A file-backed body exceeds the 65,536-byte inline threshold, so activation runs. */
const largeBody = `# report\n${"x".repeat(70_000)}\n`;

const busyError = (): Error => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

/** Throws the busy signature from every operational database open. */
function throwOnOpen() {
  return vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation(() => {
    throw busyError();
  });
}

describe("typed refusals per family", () => {
  it("returns the envelope, exit 75, and per-surface recovery for Channel, Handoff, and Project", () => {
    registerProject();
    const openSpy = throwOnOpen();

    const channel = capture();
    expect(runCli(["channel", "list", "--json"], channel.ports)).toBe(75);
    const channelEnvelope = envelopeOf(channel);
    expect(channelEnvelope.ok).toBe(false);
    expect(channelEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(channelEnvelope.error?.details.storageContention).toBe(true);
    expect(channelEnvelope.error?.message).toContain("Channel storage is contended");
    expect(channelEnvelope.error?.recovery?.suggestedCommand).toBe(
      "Retry the same channel command with its original mode, input, and idempotency key when storage is quieter; a replay-only retry stays replay-only, and after an unknown submission outcome inspect with --replay-only first.",
    );
    expect(channel.out.join("")).toBe("");

    const send = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], send.ports)).toBe(75);
    const sendEnvelope = envelopeOf(send);
    expect(sendEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(sendEnvelope.error?.message).toContain("Handoff storage is contended");
    expect(sendEnvelope.error?.recovery?.suggestedCommand).toBe(
      "Retry the same command with its original mode, input, and idempotency key when storage is quieter; after an unknown send outcome inspect with sorage send --replay-only first.",
    );

    const project = capture();
    expect(runCli(["project", "add", "--name", "N", "--dir", work, "--json"], project.ports)).toBe(75);
    const projectEnvelope = envelopeOf(project);
    expect(projectEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(projectEnvelope.error?.message).toContain("Project storage is contended");
    expect(projectEnvelope.error?.recovery?.suggestedCommand).toBe(
      "Retry the same command when storage is quieter; it committed none of the changes it was asked to make.",
    );

    // The human form carries the recovery line too.
    const human = capture();
    expect(runCli(["channel", "list"], human.ports)).toBe(75);
    expect(human.err.join("")).toContain("Recovery: Retry the same channel command");
    openSpy.mockRestore();
  });

  it("keeps the open-unavailability condition wording distinct", () => {
    registerProject();
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation(() => {
      throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
    });
    const channel = capture();
    expect(runCli(["channel", "list", "--json"], channel.ports)).toBe(75);
    expect(envelopeOf(channel).error?.message).toContain("opening the Sorage database did not succeed");
    openSpy.mockRestore();
  });

  it("reaches the domain transaction of project add through a real engine busy (W1 barrier)", () => {
    registerProject();
    const fresh = mkdtempSync(join(tmpdir(), "sorage-cli-contention-fresh-"));
    // Ports are built for real; the injected wrapper blocks the domain
    // BEGIN IMMEDIATE (the second globally: the rebuild migration takes the
    // first on its dedicated connection) with a self-held lock, so the real
    // engine returns SQLITE_BUSY against the short busy timeout.
    const realOpen = sqliteConnections.openSorageDatabase;
    let beginCount = 0;
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
      const db = realOpen(path);
      db.exec("PRAGMA busy_timeout = 50");
      const wrapped = {
        prepare: (sql: string) => db.prepare(sql),
        exec(sql: string) {
          if (sql === "BEGIN IMMEDIATE") {
            beginCount += 1;
            if (beginCount === 2) {
              const blocker = new DatabaseSync(path);
              blocker.exec("BEGIN IMMEDIATE");
              try {
                return db.exec(sql);
              } finally {
                blocker.exec("ROLLBACK");
                blocker.close();
              }
            }
          }
          return db.exec(sql);
        },
        close: () => db.close(),
      } as unknown as SorageSqlite;
      return wrapped;
    });
    const project = capture();
    const code = runCli(["project", "add", "--name", "N", "--dir", fresh, "--json"], project.ports);
    expect(code, project.err.join("")).toBe(75);
    expect(envelopeOf(project).error?.message).toContain("Project storage is contended");
    openSpy.mockRestore();
    const count = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      const rows = count.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug != 'alpha'").get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      count.close();
    }
  });

  it("renders the invoking family's wording when actor resolution meets contention (V11, W1)", () => {
    registerProject();
    const realOpen = sqliteConnections.openSorageDatabase;
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
      const db = realOpen(path);
      const wrapped = {
        prepare(sql: string) {
          if (sql.includes("FROM project_bindings ORDER BY")) throw busyError();
          return db.prepare(sql);
        },
        exec: (sql: string) => db.exec(sql),
        close: () => db.close(),
      } as unknown as SorageSqlite;
      return wrapped;
    });
    const send = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], send.ports)).toBe(75);
    expect(envelopeOf(send).error?.message).toContain("Handoff storage is contended");
    expect(envelopeOf(send).error?.recovery?.suggestedCommand).toContain("sorage send --replay-only first");
    openSpy.mockRestore();
  });
});

describe("genuine usage errors keep exit 2", () => {
  it("rejects unknown options, cursor combinations, missing bodies, and unknown commands without an envelope", () => {
    const unknownOption = capture();
    expect(runCli(["channel", "list", "--bogus"], unknownOption.ports)).toBe(2);
    expect(unknownOption.err.join("")).not.toContain('"ok"');

    const cursor = capture();
    expect(
      runCli(["channel", "messages", "8f19d8c8-1111-4111-8111-111111111111", "--wait", "--cursor", "c"], cursor.ports),
    ).toBe(2);

    const missingBody = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t"], missingBody.ports)).toBe(2);

    const unknownCommand = capture();
    expect(runCli(["frobnicate"], unknownCommand.ports)).toBe(2);
    expect(unknownCommand.err.join("")).not.toContain('"ok"');
  });
});

describe("the unreadable configuration split", () => {
  it("reports CONFIG_INVALID on covered operational paths and NOT_INITIALIZED on excluded ones", () => {
    chmodSync(join(home, "config.yaml"), 0o000);
    const channel = capture();
    expect(runCli(["channel", "list", "--json"], channel.ports)).toBe(78);
    expect(envelopeOf(channel).error?.code).toBe("CONFIG_INVALID");

    const send = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], send.ports)).toBe(78);
    expect(envelopeOf(send).error?.code).toBe("CONFIG_INVALID");

    const project = capture();
    expect(runCli(["project", "list", "--json"], project.ports)).toBe(78);
    expect(envelopeOf(project).error?.code).toBe("CONFIG_INVALID");

    const vault = capture();
    expect(runCli(["vault", "status", "--json"], vault.ports)).toBe(78);
    expect(envelopeOf(vault).error?.code).toBe("NOT_INITIALIZED");
  });

  it("keeps the replay-only recovery semantics for an unreadable configuration (W4)", () => {
    chmodSync(join(home, "config.yaml"), 0o000);
    const sendRecovery = capture();
    expect(
      runCli(
        ["send", "--to", "alpha", "--title", "t", "--body", "b", "--idempotency-key", "k", "--replay-only", "--json"],
        sendRecovery.ports,
      ),
    ).toBe(75);
    expect(envelopeOf(sendRecovery).error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");

    const channelRecovery = capture();
    expect(
      runCli(
        [
          "channel",
          "submit",
          "8f19d8c8-1111-4111-8111-111111111111",
          "--as-participant",
          "7e19d8c8-1111-4111-8111-111111111111",
          "--kind",
          "report",
          "--body",
          "b",
          "--idempotency-key",
          "k",
          "--replay-only",
          "--json",
        ],
        channelRecovery.ports,
      ),
    ).toBe(75);
    expect(envelopeOf(channelRecovery).error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(envelopeOf(channelRecovery).error?.message).toContain("remains unknown");
  });
});

describe("contained post-commit warnings (category (i))", () => {
  it("returns the committed send with warnings when activation or completion fails", () => {
    registerProject();
    registerProject("beta");
    const realSend = handoffCommandPorts.createNodeSendPorts;
    const sendSpy = vi.spyOn(handoffCommandPorts, "createNodeSendPorts").mockImplementation((options = {}) => {
      const ports = realSend(options);
      let activations = 0;
      const activate = ports.artifactStore.activate.bind(ports.artifactStore);
      ports.artifactStore.activate = (request: { stagingPath: string; storageKey: string }) => {
        activations += 1;
        if (activations === 1) return err(appError("INTERNAL_ERROR", "injected activation failure"));
        return activate(request);
      };
      ports.handoffs.completeActivations = () => err(appError("INTERNAL_ERROR", "injected completion failure"));
      return ports;
    });
    const sent = capture();
    const code = runCli(
      ["send", "--to", "alpha", "--to", "beta", "--title", "t", "--body", largeBody, "--json"],
      sent.ports,
    );
    expect(code, sent.err.join("")).toBe(0);
    const envelope = JSON.parse(sent.out.join("")) as { ok: boolean; data: { handoffs: unknown[] } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.handoffs).toHaveLength(2);
    const stderr = sent.err.join("");
    expect(stderr).toContain("warning: The Handoff fan-out committed, but activating");
    expect(stderr).toContain("warning: The Handoff fan-out committed, but recording its activation completions failed");
    sendSpy.mockRestore();
  });

  it("returns the committed send with a warning when only the physical activation fails", () => {
    registerProject();
    const realSend = handoffCommandPorts.createNodeSendPorts;
    const sendSpy = vi.spyOn(handoffCommandPorts, "createNodeSendPorts").mockImplementation((options = {}) => {
      const ports = realSend(options);
      ports.artifactStore.activate = () => err(appError("INTERNAL_ERROR", "injected activation failure"));
      return ports;
    });
    const sent = capture();
    const code = runCli(["send", "--to", "alpha", "--title", "t", "--body", largeBody, "--json"], sent.ports);
    expect(code, sent.err.join("")).toBe(0);
    expect(JSON.parse(sent.out.join("")).data.handoffs).toHaveLength(1);
    expect(sent.err.join("")).toContain("warning: The Handoff fan-out committed, but activating");
    sendSpy.mockRestore();
  });

  it("keeps a throwing completion sink from changing the committed result or skipping steps", () => {
    registerProject();
    registerProject("beta");
    const realSend = handoffCommandPorts.createNodeSendPorts;
    let throwSink = false;
    const sendSpy = vi.spyOn(handoffCommandPorts, "createNodeSendPorts").mockImplementation((options = {}) => {
      const ports = realSend(options);
      ports.artifactStore.activate = () => err(appError("INTERNAL_ERROR", "injected activation failure"));
      if (throwSink) {
        ports.disclosures = {
          backupEnabled: ports.disclosures?.backupEnabled ?? false,
          thresholdBytes: ports.disclosures?.thresholdBytes ?? 1,
          largeContent: ports.disclosures
            ? (sizeBytes: number, thresholdBytes: number) => ports.disclosures?.largeContent(sizeBytes, thresholdBytes)
            : () => undefined,
          completionWarning: () => {
            throw new Error("sink threw");
          },
        };
      }
      return ports;
    });
    const healthy = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", largeBody, "--json"], healthy.ports)).toBe(0);
    expect(healthy.err.join("")).toContain("warning:");

    throwSink = true;
    const throwing = capture();
    const code = runCli(
      ["send", "--to", "alpha", "--to", "beta", "--title", "t", "--body", largeBody, "--json"],
      throwing.ports,
    );
    expect(code, throwing.err.join("")).toBe(0);
    expect(JSON.parse(throwing.out.join("")).data.handoffs).toHaveLength(2);
    sendSpy.mockRestore();
  });

  it("returns the committed revision and deletion approval with warnings on physical failures", () => {
    registerProject();
    writeFileSync(join(work, "r.txt"), `# revision\n${"y".repeat(70_000)}\n`);
    // A send whose activation genuinely completes, so a revision has content.
    const sent = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], sent.ports)).toBe(0);
    const sendEnvelope = JSON.parse(sent.out.join("")) as { data: { handoffs: Array<{ handoffId: string }> } };
    const handoffId = sendEnvelope.data.handoffs[0]?.handoffId;

    const realRevision = handoffCommandPorts.createNodeRevisionPorts;
    const revisionSpy = vi.spyOn(handoffCommandPorts, "createNodeRevisionPorts").mockImplementation((options = {}) => {
      const ports = realRevision(options);
      ports.artifactStore.activate = () => err(appError("INTERNAL_ERROR", "injected revision activation failure"));
      return ports;
    });
    const revised = capture();
    const reviseCode = runCli(
      ["revise", handoffId as string, "--file", join(work, "r.txt"), "--allow-external-source", "--json"],
      revised.ports,
    );
    expect(reviseCode, revised.err.join("")).toBe(0);
    expect(revised.err.join("")).toContain("warning: The revision committed, but activating");
    revisionSpy.mockRestore();

    // Request deletion, decline to a terminal state as the recipient, then
    // approve with a failing unlink.
    const requested = capture();
    expect(runCli(["delete", "request", handoffId as string, "--json"], requested.ports)).toBe(0);
    const fetched = capture();
    expect(runCli(["get", handoffId as string, "--as", "alpha", "--json"], fetched.ports)).toBe(0);
    const fetchedEnvelope = JSON.parse(fetched.out.join("")) as { data: Record<string, unknown> };
    const handoffView = (fetchedEnvelope.data.handoff ?? fetchedEnvelope.data) as { rowVersion?: number };
    const rowVersion = handoffView.rowVersion;
    const declined = capture();
    expect(
      runCli(
        [
          "decline",
          handoffId as string,
          "--reason",
          "r",
          "--expected-row-version",
          String(rowVersion),
          "--as",
          "alpha",
          "--json",
        ],
        declined.ports,
      ),
    ).toBe(0);
    const realRetention = handoffCommandPorts.createNodeRetentionPorts;
    const retentionSpy = vi
      .spyOn(handoffCommandPorts, "createNodeRetentionPorts")
      .mockImplementation((options = {}) => {
        const ports = realRetention(options);
        ports.artifact.remove = () => err(appError("INTERNAL_ERROR", "injected unlink failure"));
        return ports;
      });
    const approved = capture();
    const approveCode = runCli(
      ["delete", "approve", handoffId as string, "--as-user", "--confirm", "--json"],
      approved.ports,
    );
    expect(approveCode, approved.err.join("")).toBe(0);
    expect(approved.err.join("")).toContain("warning: The deletion approval committed, but unlinking");
    retentionSpy.mockRestore();
  });

  it("warns on every post-commit revise failure: unlink, unlink completion, and activation completion", () => {
    registerProject();
    writeFileSync(join(work, "r1.txt"), `# large original\n${"a".repeat(70_000)}\n`);
    writeFileSync(join(work, "r2.txt"), `# large replacement\n${"b".repeat(70_000)}\n`);
    const sent = capture();
    expect(
      runCli(
        ["send", "--to", "alpha", "--title", "t", "--file", join(work, "r1.txt"), "--allow-external-source", "--json"],
        sent.ports,
      ),
    ).toBe(0);
    const handoffId = (JSON.parse(sent.out.join("")) as { data: { handoffs: Array<{ handoffId: string }> } }).data
      .handoffs[0]?.handoffId as string;

    const runReviseWith = (patch: (ports: ReturnType<typeof handoffCommandPorts.createNodeRevisionPorts>) => void) => {
      const realRevision = handoffCommandPorts.createNodeRevisionPorts;
      const spy = vi.spyOn(handoffCommandPorts, "createNodeRevisionPorts").mockImplementation((options = {}) => {
        const ports = realRevision(options);
        patch(ports);
        return ports;
      });
      try {
        const revised = capture();
        const code = runCli(
          ["revise", handoffId, "--file", join(work, `r${reviseRun}.txt`), "--allow-external-source", "--json"],
          revised.ports,
        );
        return { code, stderr: revised.err.join(""), stdout: revised.out.join("") };
      } finally {
        spy.mockRestore();
      }
    };

    let reviseRun = 2;
    const unlinkFailed = runReviseWith((ports) => {
      ports.artifactStore.remove = () => err(appError("INTERNAL_ERROR", "injected unlink failure"));
    });
    expect(unlinkFailed.code, unlinkFailed.stderr).toBe(0);
    expect(unlinkFailed.stderr).toContain("warning: The revision committed, but unlinking");

    reviseRun = 3;
    writeFileSync(join(work, "r3.txt"), `# third body\n${"c".repeat(70_050)}\n`);
    const unlinkCompletionFailed = runReviseWith((ports) => {
      ports.revisions.completeUnlinks = () => err(appError("INTERNAL_ERROR", "injected unlink completion failure"));
    });
    expect(unlinkCompletionFailed.code, unlinkCompletionFailed.stderr).toBe(0);
    expect(unlinkCompletionFailed.stderr).toContain(
      "warning: The revision committed, but recording its unlink completion failed",
    );

    reviseRun = 4;
    writeFileSync(join(work, "r4.txt"), `# fourth body\n${"d".repeat(70_100)}\n`);
    const activationCompletionFailed = runReviseWith((ports) => {
      ports.revisions.completeActivations = () =>
        err(appError("INTERNAL_ERROR", "injected activation completion failure"));
    });
    expect(activationCompletionFailed.code, activationCompletionFailed.stderr).toBe(0);
    expect(activationCompletionFailed.stderr).toContain(
      "warning: The revision committed, but recording its activation completion failed",
    );
    for (const outcome of [unlinkFailed, unlinkCompletionFailed, activationCompletionFailed]) {
      expect(JSON.parse(outcome.stdout).data.rowVersion).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns the committed --no-change resolution with no physical-step warnings", () => {
    registerProject();
    writeFileSync(join(work, "note-source.txt"), "note text");
    const sent = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], sent.ports)).toBe(0);
    const handoffId = (JSON.parse(sent.out.join("")) as { data: { handoffs: Array<{ handoffId: string }> } }).data
      .handoffs[0]?.handoffId as string;
    const reviewed = capture();
    expect(
      runCli(["review", "set", handoffId, "--text", "needs work", "--as", "alpha", "--json"], reviewed.ports),
    ).toBe(0);
    // The --no-change form prepares no body, so it owns no activation or unlink
    // intent and has no physical post-commit step to fail.
    const resolved = capture();
    const code = runCli(
      ["revise", handoffId, "--no-change", "--reason", "standoff", "--as-user", "--json"],
      resolved.ports,
    );
    expect(code, resolved.err.join("")).toBe(0);
    expect(resolved.err.join("")).not.toContain("warning:");
    expect(JSON.parse(resolved.out.join("")).data.reviewState).toBe("awaiting_recipient");
  });

  it("returns the committed deletion approval with a warning when only the completion fails", () => {
    registerProject();
    const sent = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", largeBody, "--json"], sent.ports)).toBe(0);
    const handoffId = (JSON.parse(sent.out.join("")) as { data: { handoffs: Array<{ handoffId: string }> } }).data
      .handoffs[0]?.handoffId as string;
    expect(
      runCli(
        ["decline", handoffId, "--reason", "r", "--expected-row-version", "1", "--as", "alpha", "--json"],
        capture().ports,
      ),
    ).toBe(0);
    expect(runCli(["delete", "request", handoffId, "--json"], capture().ports)).toBe(0);
    const realRetention = handoffCommandPorts.createNodeRetentionPorts;
    const retentionSpy = vi
      .spyOn(handoffCommandPorts, "createNodeRetentionPorts")
      .mockImplementation((options = {}) => {
        const ports = realRetention(options);
        ports.retention.completeUnlink = () => err(appError("INTERNAL_ERROR", "injected approval completion failure"));
        return ports;
      });
    const approved = capture();
    const code = runCli(["delete", "approve", handoffId, "--as-user", "--confirm", "--json"], approved.ports);
    expect(code, approved.err.join("")).toBe(0);
    expect(approved.err.join("")).toContain(
      "warning: The deletion approval committed, but recording its unlink completion failed",
    );
    retentionSpy.mockRestore();
  });

  it("proves a throwing completion sink skips no later step on a two-recipient send", () => {
    registerProject();
    registerProject("beta");
    const realSend = handoffCommandPorts.createNodeSendPorts;
    let activateCalls = 0;
    let completeCalls = 0;
    let sinkThrows = 0;
    const sendSpy = vi.spyOn(handoffCommandPorts, "createNodeSendPorts").mockImplementation((options = {}) => {
      const ports = realSend(options);
      let activations = 0;
      const activate = ports.artifactStore.activate.bind(ports.artifactStore);
      ports.artifactStore.activate = (request: { stagingPath: string; storageKey: string }) => {
        activateCalls += 1;
        activations += 1;
        if (activations === 1) return err(appError("INTERNAL_ERROR", "injected first activation failure"));
        return activate(request);
      };
      const complete = ports.handoffs.completeActivations.bind(ports.handoffs);
      ports.handoffs.completeActivations = (completions: unknown) => {
        completeCalls += 1;
        void complete(completions as never);
        return err(appError("INTERNAL_ERROR", "injected completion failure"));
      };
      ports.disclosures = {
        backupEnabled: ports.disclosures?.backupEnabled ?? false,
        thresholdBytes: ports.disclosures?.thresholdBytes ?? 1,
        largeContent: ports.disclosures
          ? (sizeBytes: number, thresholdBytes: number) => ports.disclosures?.largeContent(sizeBytes, thresholdBytes)
          : () => undefined,
        completionWarning: () => {
          sinkThrows += 1;
          throw new Error("sink threw");
        },
      };
      return ports;
    });
    const sent = capture();
    const code = runCli(
      ["send", "--to", "alpha", "--to", "beta", "--title", "t", "--body", largeBody, "--json"],
      sent.ports,
    );
    expect(code, sent.err.join("")).toBe(0);
    // The second recipient's activation still ran after the first warning
    // threw, and the completion transaction was still attempted afterwards.
    expect(activateCalls).toBe(2);
    expect(completeCalls).toBe(1);
    expect(sinkThrows).toBe(2);
    expect(JSON.parse(sent.out.join("")).data.handoffs).toHaveLength(2);
    sendSpy.mockRestore();
  });
});

describe("the marker and Channel cleanup warning paths (categories (ii) and (iv))", () => {
  it("warns contained when marker port creation fails after a committed send", () => {
    registerProject();
    const markerSpy = vi.spyOn(inboxMarkerPorts, "createNodeInboxMarkerPorts").mockImplementation(() => {
      throw new Error("injected marker port failure");
    });
    const sent = capture();
    const code = runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], sent.ports);
    expect(code, sent.err.join("")).toBe(0);
    expect(JSON.parse(sent.out.join("")).data.handoffs).toHaveLength(1);
    expect(sent.err.join("")).toContain(
      "warning: the inbox marker could not be refreshed: injected marker port failure",
    );
    markerSpy.mockRestore();
  });

  it("warns contained when the rebind reconciliation cannot create its ports, keeping the committed rebind", () => {
    registerProject();
    const bound = mkdtempSync(join(work, "bound-"));
    const markerSpy = vi.spyOn(inboxMarkerPorts, "createNodeInboxMarkerPorts").mockImplementation(() => {
      throw new Error("injected marker port failure");
    });
    const rebound = capture();
    const code = runCli(
      ["project", "rebind", "alpha", "--from", realpathSync(work), "--to", bound, "--json"],
      rebound.ports,
    );
    expect(code, rebound.err.join("")).toBe(0);
    expect(rebound.err.join("")).toContain("warning: the rebound inbox marker could not be refreshed");
    markerSpy.mockRestore();
  });

  it("keeps the Channel result unchanged when the finally cleanup fails", () => {
    const created = capture();
    expect(runCli(["channel", "create", "--main-handle", "orchestrator", "--json"], created.ports)).toBe(0);
    const realChannels = channelCommandPorts.createNodeChannelPorts;
    const channelSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = realChannels(options);
      ports.close = () => {
        throw new Error("injected close failure");
      };
      return ports;
    });
    const listed = capture();
    const code = runCli(["channel", "list", "--json"], listed.ports);
    expect(code, listed.err.join("")).toBe(0);
    expect(JSON.parse(listed.out.join("")).data.items).toHaveLength(1);
    expect(listed.err.join("")).toContain("warning: the Channel storage connection could not be closed");
    channelSpy.mockRestore();
  });

  it("still closes the ports when releasing the accepted body throws, keeping the result unchanged", () => {
    const created = capture();
    expect(runCli(["channel", "create", "--main-handle", "orchestrator", "--json"], created.ports)).toBe(0);
    const createdEnvelope = JSON.parse(created.out.join("")) as {
      data: { channel: { id: string; mainParticipantId: string } };
    };
    const channelId = createdEnvelope.data.channel.id;
    const mainId = createdEnvelope.data.channel.mainParticipantId;

    const realChannels = channelCommandPorts.createNodeChannelPorts;
    let closed = false;
    const channelSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = realChannels(options);
      const close = ports.close.bind(ports);
      ports.close = () => {
        closed = true;
        close();
      };
      return ports;
    });
    const releaseSpy = vi.spyOn(channelCommandPorts, "releaseAcceptedChannelBody").mockImplementation(() => {
      throw new Error("injected release failure");
    });
    const submitted = capture();
    const code = runCli(
      ["channel", "submit", channelId, "--as-participant", mainId, "--kind", "report", "--body", "b", "--json"],
      submitted.ports,
    );
    expect(code, submitted.err.join("")).toBe(0);
    expect(JSON.parse(submitted.out.join("")).data.message.kind).toBe("report");
    expect(submitted.err.join("")).toContain("warning: the accepted Channel body could not be released");
    expect(closed).toBe(true);
    releaseSpy.mockRestore();
    channelSpy.mockRestore();
  });

  it("keeps the committed send and exit code when the marker warning's diagnostic sink throws", () => {
    registerProject();
    const markerSpy = vi.spyOn(inboxMarkerPorts, "createNodeInboxMarkerPorts").mockImplementation(() => {
      throw new Error("injected marker port failure");
    });
    let stdout = "";
    const throwing = {
      out: (text: string) => {
        stdout += text;
      },
      err: (text: string) => {
        if (text.startsWith("warning:")) throw new Error("injected diagnostic sink failure");
      },
    };
    const code = runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], throwing);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).data.handoffs).toHaveLength(1);
    markerSpy.mockRestore();
  });

  it("keeps the committed rebind when the marker warning's diagnostic sink throws", () => {
    registerProject();
    const bound = mkdtempSync(join(work, "bound-"));
    const markerSpy = vi.spyOn(inboxMarkerPorts, "createNodeInboxMarkerPorts").mockImplementation(() => {
      throw new Error("injected marker port failure");
    });
    let stdout = "";
    const throwing = {
      out: (text: string) => {
        stdout += text;
      },
      err: (text: string) => {
        if (text.startsWith("warning:")) throw new Error("injected diagnostic sink failure");
      },
    };
    const code = runCli(
      ["project", "rebind", "alpha", "--from", realpathSync(work), "--to", bound, "--json"],
      throwing,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    markerSpy.mockRestore();
  });
});

describe("Channel connection accounting", () => {
  it("returns CONFIG_INVALID at the operational configuration re-reads when the file becomes unreadable mid-command (E1)", () => {
    const created = capture();
    expect(runCli(["channel", "create", "--main-handle", "orchestrator", "--json"], created.ports)).toBe(0);
    const createdEnvelope = JSON.parse(created.out.join("")) as {
      data: { channel: { id: string; mainParticipantId: string } };
    };
    const channelId = createdEnvelope.data.channel.id;
    const mainId = createdEnvelope.data.channel.mainParticipantId;

    // Flip the configuration unreadable after the factory read succeeds and
    // before the operational re-read seams run, so the refusal provably comes
    // from freshBinding()/classifyExternalChange(), not port creation.
    const realChannels = channelCommandPorts.createNodeChannelPorts;
    const channelSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = realChannels(options);
      chmodSync(join(home, "config.yaml"), 0o000);
      return ports;
    });
    try {
      const count = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      const messagesBefore = (count.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number }).n;
      count.close();
      const submitted = capture();
      const code = runCli(
        ["channel", "submit", channelId, "--as-participant", mainId, "--kind", "report", "--body", "b", "--json"],
        submitted.ports,
      );
      expect(code, submitted.err.join("")).toBe(78);
      expect(envelopeOf(submitted).error?.code).toBe("CONFIG_INVALID");
      const after = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      try {
        expect((after.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number }).n).toBe(
          messagesBefore,
        );
      } finally {
        after.close();
      }
    } finally {
      chmodSync(join(home, "config.yaml"), 0o644);
      channelSpy.mockRestore();
    }
  });

  it("refuses CONFIG_INVALID at the page-size read when the configuration becomes unreadable after the gate (F1)", () => {
    registerProject();
    const sent = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b", "--json"], sent.ports)).toBe(0);

    // Flip the configuration unreadable after the covered gate and the read
    // ports' own factory read, and before the page-size default is resolved,
    // so the refusal provably comes from defaultPageSize().
    const realReadPorts = handoffCommandPorts.createNodeHandoffReadPorts;
    const readPortsSpy = vi
      .spyOn(handoffCommandPorts, "createNodeHandoffReadPorts")
      .mockImplementation((options = {}) => {
        const ports = realReadPorts(options);
        chmodSync(join(home, "config.yaml"), 0o000);
        return ports;
      });
    try {
      for (const args of [
        ["inbox", "--json"],
        ["outbox", "--json"],
        ["inbox", "--wait", "--timeout", "1", "--json"],
      ]) {
        const listed = capture();
        const code = runCli(args, listed.ports);
        expect(code, `${args.join(" ")}: ${listed.err.join("")}`).toBe(78);
        expect(envelopeOf(listed).error?.code).toBe("CONFIG_INVALID");
        // The command lists nothing: stdout carries no items envelope.
        expect(listed.out.join("")).toBe("");
        chmodSync(join(home, "config.yaml"), 0o644);
      }
      // An explicit --limit never reads the configuration for the default, so
      // the listing still works even though the factory wrapper flips the file
      // unreadable again after the read ports are built.
      const limited = capture();
      expect(runCli(["inbox", "--as", "alpha", "--limit", "5", "--json"], limited.ports)).toBe(0);
      expect(JSON.parse(limited.out.join("")).data.handoffs).toHaveLength(1);
    } finally {
      chmodSync(join(home, "config.yaml"), 0o644);
      readPortsSpy.mockRestore();
    }
  });

  it("refuses CONFIG_INVALID at the classifyExternalChange re-read when a real external change meets an unreadable configuration (F2)", () => {
    registerProject();
    const created = capture();
    expect(runCli(["channel", "create", "--main-handle", "orchestrator", "--json"], created.ports)).toBe(0);
    const createdEnvelope = JSON.parse(created.out.join("")) as {
      data: { channel: { id: string; mainParticipantId: string } };
    };
    const channelId = createdEnvelope.data.channel.id;
    const mainId = createdEnvelope.data.channel.mainParticipantId;

    const realChannels = channelCommandPorts.createNodeChannelPorts;
    let classifyCalls = 0;
    const channelSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = realChannels(options);
      const realBinding = ports.staging.freshBinding.bind(ports.staging);
      const realClassify = ports.coherence.classifyExternalChange.bind(ports.coherence);
      // The initial binding read succeeds; then a real external commit from an
      // independent connection bumps data_version so the mutation transaction
      // reports a coherence mismatch, and the configuration becomes unreadable
      // before classifyExternalChange() runs.
      ports.staging.freshBinding = () => {
        const binding = realBinding();
        if (binding.ok) {
          const external = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
          try {
            external.exec("BEGIN IMMEDIATE");
            external.prepare("UPDATE projects SET display_name = ?").run(`f2-churn-${Date.now()}`);
            external.exec("COMMIT");
          } finally {
            external.close();
          }
          chmodSync(join(home, "config.yaml"), 0o000);
        }
        return binding;
      };
      ports.coherence.classifyExternalChange = (expectedVaultPath: string) => {
        classifyCalls += 1;
        return realClassify(expectedVaultPath);
      };
      return ports;
    });
    try {
      const messagesBefore = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      const before = (messagesBefore.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number }).n;
      messagesBefore.close();
      const submitted = capture();
      const code = runCli(
        ["channel", "submit", channelId, "--as-participant", mainId, "--kind", "report", "--body", "b", "--json"],
        submitted.ports,
      );
      expect(code, submitted.err.join("")).toBe(78);
      expect(envelopeOf(submitted).error?.code).toBe("CONFIG_INVALID");
      // The coherence classifier genuinely ran against the unreadable file.
      expect(classifyCalls).toBe(1);
      const messagesAfter = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      try {
        expect((messagesAfter.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number }).n).toBe(
          before,
        );
      } finally {
        messagesAfter.close();
      }
    } finally {
      chmodSync(join(home, "config.yaml"), 0o644);
      channelSpy.mockRestore();
    }
  });

  it("uses one open-and-migrate for operational and actor work and closes every connection", () => {
    const created = capture();
    expect(runCli(["channel", "create", "--main-handle", "orchestrator", "--json"], created.ports)).toBe(0);

    const realOpen = sqliteConnections.openSorageDatabase;
    const openAndClose: Array<{ closed: boolean }> = [];
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
      const db = realOpen(path);
      const record = { closed: false };
      openAndClose.push(record);
      return {
        prepare: (sql: string) => db.prepare(sql),
        exec: (sql: string) => db.exec(sql),
        close: () => {
          record.closed = true;
          db.close();
        },
      } as unknown as SorageSqlite;
    });
    const realOpenAndMigrate = migrator.openAndMigrate;
    const openAndMigrateSpy = vi
      .spyOn(migrator, "openAndMigrate")
      .mockImplementation((...args: Parameters<typeof migrator.openAndMigrate>) => realOpenAndMigrate(...args));
    const realProjectFactory = projectCommandPorts.createNodeProjectPorts;
    const projectFactorySpy = vi
      .spyOn(projectCommandPorts, "createNodeProjectPorts")
      .mockImplementation((...args: Parameters<typeof realProjectFactory>) => realProjectFactory(...args));
    const shown = capture();
    const code = runCli(["channel", "show", "8f19d8c8-1111-4111-8111-111111111111", "--json"], shown.ports);
    expect(code, shown.err.join("")).toBe(66);
    // The drain's startup housekeeping performs two pre-existing opens (its own
    // drain transaction and the recorded-artifacts read); the command itself
    // performs exactly one operational open-and-migrate, and the actor resolves
    // on that composition's shared connection — the Project factory is entered
    // once, with the injected database, never standalone.
    expect(openAndMigrateSpy.mock.calls.length, JSON.stringify(openAndMigrateSpy.mock.calls.length)).toBe(3);
    expect(projectFactorySpy).toHaveBeenCalledTimes(1);
    const projectFactoryCall = projectFactorySpy.mock.calls[0]?.[0] ?? {};
    expect((projectFactoryCall as { database?: unknown }).database).toBeDefined();
    expect((projectFactoryCall as { contentionSurface?: unknown }).contentionSurface).toBe("channel");
    expect(openAndClose.length).toBeGreaterThanOrEqual(3);
    for (const record of openAndClose) expect(record.closed).toBe(true);
    openSpy.mockRestore();
    openAndMigrateSpy.mockRestore();
    projectFactorySpy.mockRestore();
  });

  it("opens and migrates nothing for replay-only inspection (one inspection connection)", () => {
    const openAndMigrateSpy = vi.spyOn(migrator, "openAndMigrate");
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase");
    const replay = capture();
    const code = runCli(
      [
        "channel",
        "submit",
        "8f19d8c8-1111-4111-8111-111111111111",
        "--as-participant",
        "7e19d8c8-1111-4111-8111-111111111111",
        "--kind",
        "report",
        "--body",
        "b",
        "--idempotency-key",
        "k",
        "--replay-only",
        "--json",
      ],
      replay.ports,
    );
    expect(code, replay.err.join("")).toBe(75);
    expect(JSON.parse(replay.err.join("")).error.code).toBe("CHN_REPLAY_UNAVAILABLE");
    expect(openAndMigrateSpy).toHaveBeenCalledTimes(0);
    expect(openSpy).toHaveBeenCalledTimes(0);
    openAndMigrateSpy.mockRestore();
    openSpy.mockRestore();
  });
});

describe("a write-protected installation (TASK-119)", () => {
  const stateRestores: Array<() => void> = [];

  /**
   * Protects the installation database and its WAL and returns the restore
   * function; the restore also removes journal side effects a refused
   * writable open leaves behind (a read-only `-shm`), returning the state
   * directory to its pre-protection inventory.
   */
  function protect(): () => void {
    const stateDir = join(home, "state");
    const before = new Map<string, number>();
    for (const entry of readdirSync(stateDir)) {
      const path = join(stateDir, entry);
      const mode = statSync(path).mode & 0o777;
      before.set(entry, mode);
      if (entry.startsWith("sorage.sqlite3")) chmodSync(path, 0o444);
    }
    const restore = () => {
      for (const entry of readdirSync(stateDir)) {
        const path = join(stateDir, entry);
        const mode = before.get(entry);
        if (mode !== undefined) chmodSync(path, mode);
        else rmSync(path, { force: true });
      }
    };
    stateRestores.push(restore);
    return restore;
  }

  /** Registers the sender project and retains one keyed send and one keyed Channel submission. */
  function retainedReceipts(): { channel: string; main: string; sendKey: string; channelKey: string } {
    registerProject();
    const created = capture();
    expect(
      runCli(["channel", "create", "--main-handle", "orchestrator", "--as-user", "--json"], created.ports),
      created.err.join(""),
    ).toBe(0);
    const channel = JSON.parse(created.out.join("")).data.channel as { id: string; mainParticipantId: string };
    const sendKey = `send-key-${randomUUID()}`;
    const sent = capture();
    expect(
      runCli(
        ["send", "--to", "alpha", "--title", "t", "--body", "b", "--idempotency-key", sendKey, "--json"],
        sent.ports,
      ),
      sent.err.join(""),
    ).toBe(0);
    const channelKey = `channel-key-${randomUUID()}`;
    const submitted = capture();
    expect(
      runCli(
        [
          "channel",
          "submit",
          channel.id,
          "--as-participant",
          channel.mainParticipantId,
          "--kind",
          "report",
          "--body",
          "cb",
          "--idempotency-key",
          channelKey,
          "--json",
        ],
        submitted.ports,
      ),
      submitted.err.join(""),
    ).toBe(0);
    return { channel: channel.id, main: channel.mainParticipantId, sendKey, channelKey };
  }

  it("returns the typed write-protected refusal for Channel, Handoff, and Project commands", () => {
    const receipts = retainedReceipts();
    protect();
    const channel = capture();
    expect(runCli(["channel", "list", "--json"], channel.ports)).toBe(75);
    const channelEnvelope = envelopeOf(channel);
    expect(channelEnvelope.ok).toBe(false);
    expect(channelEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(channelEnvelope.error?.details.storageContention).toBe(true);
    expect(channelEnvelope.error?.message).toBe(
      "Channel storage is write-protected: the Sorage database cannot be written by this invocation, so this Channel command committed none of the changes it was asked to make.",
    );
    expect(channelEnvelope.error?.recovery?.suggestedCommand).toBe(
      "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical channel command with its original mode, inputs, and idempotency key; when the original outcome of a keyed submission is unknown, inspect with --replay-only and the original material first, which runs without write access.",
    );
    expect(channel.out.join("")).toBe("");

    const show = capture();
    expect(runCli(["channel", "show", receipts.channel, "--json"], show.ports)).toBe(75);
    expect(envelopeOf(show).error?.message).toContain("Channel storage is write-protected");

    const wait = capture();
    expect(runCli(["channel", "messages", receipts.channel, "--wait", "--timeout", "1", "--json"], wait.ports)).toBe(
      75,
    );
    expect(envelopeOf(wait).error?.message).toContain("Channel storage is write-protected");

    const human = capture();
    expect(runCli(["channel", "list"], human.ports)).toBe(75);
    expect(human.err.join("")).toBe(
      "STORAGE_INSPECTION_UNAVAILABLE: Channel storage is write-protected: the Sorage database cannot be written by this invocation, so this Channel command committed none of the changes it was asked to make.\n" +
        "Recovery: After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical channel command with its original mode, inputs, and idempotency key; when the original outcome of a keyed submission is unknown, inspect with --replay-only and the original material first, which runs without write access.\n",
    );

    const send = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b2", "--json"], send.ports)).toBe(75);
    const sendEnvelope = envelopeOf(send);
    expect(sendEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(sendEnvelope.error?.message).toContain("Handoff storage is write-protected");
    expect(sendEnvelope.error?.recovery?.suggestedCommand).toBe(
      "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical command with its original mode, inputs, and idempotency key; when the original outcome of a keyed send is unknown, inspect with sorage send --replay-only and the original material first, which runs without write access.",
    );

    const sendHuman = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b3"], sendHuman.ports)).toBe(75);
    expect(sendHuman.err.join("")).toBe(
      "STORAGE_INSPECTION_UNAVAILABLE: Handoff storage is write-protected: the Sorage database cannot be written by this invocation, so this command committed none of the changes it was asked to make.\n" +
        "Recovery: After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical command with its original mode, inputs, and idempotency key; when the original outcome of a keyed send is unknown, inspect with sorage send --replay-only and the original material first, which runs without write access.\n",
    );

    // A covered zero-write read succeeds on the write-protected installation
    // with its normal output (SHR-015's EPIC-018 amendment; storage opens
    // read-only through the shared covered-read primitive).
    const project = capture();
    expect(runCli(["project", "list", "--json"], project.ports)).toBe(0);
    expect(project.out.join("")).toContain("alpha");
    expect(runCli(["project", "list"], capture().ports)).toBe(0);

    // A genuine usage error keeps exit 2 under write protection.
    const usage = capture();
    expect(runCli(["channel", "messages", receipts.channel, "--wait", "--interval", "0.5"], usage.ports)).toBe(2);
  });

  it("returns the normal replay-only results without write access", () => {
    const receipts = retainedReceipts();
    protect();
    const sendReplay = capture();
    expect(
      runCli(
        [
          "send",
          "--to",
          "alpha",
          "--title",
          "t",
          "--body",
          "b",
          "--idempotency-key",
          receipts.sendKey,
          "--replay-only",
          "--json",
        ],
        sendReplay.ports,
      ),
      sendReplay.err.join(""),
    ).toBe(0);
    const replayed = JSON.parse(sendReplay.out.join("")).data as { replayed: boolean };
    expect(replayed.replayed).toBe(true);

    const channelReplay = capture();
    expect(
      runCli(
        [
          "channel",
          "submit",
          receipts.channel,
          "--as-participant",
          receipts.main,
          "--kind",
          "report",
          "--body",
          "cb",
          "--idempotency-key",
          receipts.channelKey,
          "--replay-only",
          "--json",
        ],
        channelReplay.ports,
      ),
      channelReplay.err.join(""),
    ).toBe(0);
    const message = JSON.parse(channelReplay.out.join("")).data as {
      replayed: boolean;
      message: { bodyPreview: string };
    };
    expect(message.replayed).toBe(true);
    expect(message.message.bodyPreview).toContain("cb");
  });

  it("succeeds again once write access is restored (design c)", () => {
    retainedReceipts();
    const restore = protect();
    expect(runCli(["channel", "list", "--json"], capture().ports)).toBe(75);
    restore();
    const recovered = capture();
    expect(runCli(["channel", "list", "--json"], recovered.ports), recovered.err.join("")).toBe(0);
  });

  afterEach(() => {
    for (const restore of stateRestores.splice(0)) {
      try {
        restore();
      } catch {
        // Teardown is best-effort; afterEach's rmSync finishes the job.
      }
    }
  });
});
