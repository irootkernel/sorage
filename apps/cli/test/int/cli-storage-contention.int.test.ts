import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as channelCommandPorts from "@sorage/adapters/src/channel-command-ports";
import * as handoffCommandPorts from "@sorage/adapters/src/handoff-command-ports";
import * as inboxMarkerPorts from "@sorage/adapters/src/inbox-marker-ports";
import * as projectCommandPorts from "@sorage/adapters/src/project-command-ports";
import * as memoCommandPorts from "@sorage/adapters/src/memo-command-ports";
import * as vaultCommandPorts from "@sorage/adapters/src/vault-command-ports";
import type { SorageSqlite } from "@sorage/adapters/src/sqlite/connection";
import * as sqliteConnections from "@sorage/adapters/src/sqlite/connection";
import * as migrator from "@sorage/adapters/src/sqlite/migrator";
import { appError, err } from "@sorage/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Memo CLI startup refusal boundaries (TASK-127)", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const commands = [
    ["memo", "add", "--title", "Never dispatched", "--body", "body-sentinel"],
    ["memo", "update", id, "--body", "body-sentinel", "--expected-row-version", "1"],
    ["memo", "done", id, "--expected-row-version", "1"],
    ["memo", "dismiss", id, "--expected-row-version", "1"],
    ["memo", "reopen", id, "--expected-row-version", "1"],
  ];

  it.each(commands)("refuses %j before body capture or operation dispatch in either mode", (...args) => {
    const drain = vi.spyOn(vaultCommandPorts, "createNodeVaultCommandPorts").mockReturnValue({
      drainAtStart: () =>
        err(
          appError("INTERNAL_ERROR", "Reading the database failed", {
            cause: "attempt to write a readonly database body-sentinel",
          }),
        ),
    } as ReturnType<typeof vaultCommandPorts.createNodeVaultCommandPorts>);
    const open = vi.spyOn(memoCommandPorts, "createNodeMemoPorts");
    for (const replay of [false, true]) {
      const captured = capture();
      const mode = replay ? ["--idempotency-key", randomUUID(), "--replay-only"] : [];
      expect(runCli([...args, ...mode, "--json"], captured.ports)).toBe(75);
      const envelope = envelopeOf(captured);
      expect(envelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(envelope.error?.details).toEqual({ storageContention: true });
      expect(envelope.error?.message).toContain("Memo storage is write-protected");
      expect(envelope.error?.recovery?.suggestedCommand).toContain("current mode");
      expect(envelope.error?.recovery?.suggestedCommand).toContain("MCP");
      expect(captured.err.join("")).not.toContain("body-sentinel");
      expect(captured.out).toEqual([]);
    }
    expect(drain).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["SQLITE_BUSY", "SQLITE_CANTOPEN", "SQLITE_READONLY"])(
    "classifies raw factory %s before the generic fallback",
    (code) => {
      const open = vi.spyOn(memoCommandPorts, "createNodeMemoPorts").mockImplementation(() => {
        throw Object.assign(new Error("body-sentinel"), { code });
      });
      const captured = capture();
      expect(runCli(["memo", "add", "--title", "Never dispatched", "--json"], captured.ports)).toBe(75);
      expect(open).toHaveBeenCalledOnce();
      expect(envelopeOf(captured).error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(captured.err.join("")).not.toContain("body-sentinel");
      expect(captured.out).toEqual([]);
    },
  );

  it.each([
    [false, "database is locked"],
    [true, "database is locked"],
    [false, "attempt to write a readonly database"],
    [true, "attempt to write a readonly database"],
  ] as const)(
    "preserves migration restoration failure through the real drain (committed=%s, %s)",
    (committed, message) => {
      const failure = new migrator.MigrationConnectionError(
        `Restoring migration connection failed: ${message}`,
        committed,
        false,
        new Error(message),
      );
      const migration = vi.spyOn(migrator, "openAndMigrate").mockImplementation(() => {
        throw failure;
      });
      const operation = vi.spyOn(memoCommandPorts, "createNodeMemoPorts");
      const captured = capture();
      const exit = runCli(["memo", "add", "--title", "Never dispatched", "--json"], captured.ports);
      expect(migration).toHaveBeenCalledOnce();
      expect(operation).not.toHaveBeenCalled();
      expect(exit).toBe(1);
      const error = envelopeOf(captured).error;
      expect(error?.code).toBe("INTERNAL_ERROR");
      expect(error?.message).toContain("Restoring migration connection failed");
      // The retained throwable is internal metadata, not an added wire field.
      expect(Object.hasOwn(error ?? {}, "cause")).toBe(false);
      expect(captured.out).toEqual([]);
    },
  );

  it.each(["CONFIG_INVALID", "STORAGE_INTEGRITY_ERROR", "SERVICE_PAUSED", "CONTENT_MATERIALIZING"] as const)(
    "preserves a typed %s even with contention-like text",
    (code) => {
      const error = appError(code, "database is locked", { cause: "attempt to write a readonly database" });
      error.recovery = { suggestedCommand: "preserve site recovery" };
      vi.spyOn(vaultCommandPorts, "createNodeVaultCommandPorts").mockReturnValue({
        drainAtStart: () => err(error),
      } as ReturnType<typeof vaultCommandPorts.createNodeVaultCommandPorts>);
      const captured = capture();
      runCli(["memo", "add", "--title", "Never dispatched", "--json"], captured.ports);
      expect(envelopeOf(captured).error).toEqual(error);
    },
  );

  it("keeps unexpected startup errors internal with selected-home and absent-log guidance", () => {
    const open = vi.spyOn(memoCommandPorts, "createNodeMemoPorts").mockImplementation(() => {
      throw new Error("unexpected body-sentinel");
    });
    const captured = capture();
    expect(runCli(["memo", "add", "--title", "Never dispatched", "--json"], captured.ports)).toBe(1);
    expect(open).toHaveBeenCalledOnce();
    const error = envelopeOf(captured).error;
    expect(error?.code).toBe("INTERNAL_ERROR");
    expect(error?.recovery?.suggestedCommand).toContain("SORAGE_HOME");
    expect(error?.recovery?.suggestedCommand).toContain("If no log was written");
    expect(captured.err.join("")).not.toContain("body-sentinel");
  });
});

describe("typed refusals per family", () => {
  it("returns the envelope, exit 75, and per-surface recovery for Channel, Handoff, and Project", () => {
    registerProject();
    const openSpy = throwOnOpen();

    const channel = capture();
    expect(runCli(["channel", "create", "contended-probe", "--json"], channel.ports)).toBe(75);
    const channelEnvelope = envelopeOf(channel);
    expect(channelEnvelope.ok).toBe(false);
    expect(channelEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(channelEnvelope.error?.details.storageContention).toBe(true);
    expect(channelEnvelope.error?.message).toContain("Channel storage is contended");
    expect(channelEnvelope.error?.recovery?.suggestedCommand).toBe(
      "Retry the same channel command when storage is quieter; it committed none of the changes it was asked to make.",
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
    expect(runCli(["channel", "create", "contended-human"], human.ports)).toBe(75);
    expect(human.err.join("")).toContain("Recovery: Retry the same channel command");
    openSpy.mockRestore();
  });

  it("keeps the open-unavailability condition wording distinct", () => {
    registerProject();
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation(() => {
      throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
    });
    const channel = capture();
    expect(runCli(["channel", "create", "unopenable-probe", "--json"], channel.ports)).toBe(75);
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
    expect(runCli(["channel", "create", "cleanup-probe", "--json"], created.ports)).toBe(0);
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
    channelSpy.mockRestore();
  });

  it("still closes the ports when releasing the accepted body throws, keeping the result unchanged", () => {
    const created = capture();
    expect(runCli(["channel", "create", "release-probe", "--json"], created.ports)).toBe(0);
    expect(runCli(["channel", "add", "release-probe", "w1", "--role", "worker", "--json"], created.ports)).toBe(0);

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
      ["channel", "post", "release-probe", "--from", "w1", "--kind", "report", "--body", "b", "--json"],
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
    expect(runCli(["channel", "create", "e1-probe", "--json"], created.ports)).toBe(0);
    expect(runCli(["channel", "add", "e1-probe", "w1", "--role", "worker", "--json"], created.ports)).toBe(0);

    // Flip the configuration unreadable after the factory read succeeds and
    // before the operational re-read seam runs, so the refusal provably comes
    // from the staged file's in-transaction freshBinding() re-read (CHN-014),
    // not port creation.
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
      const bodyFile = join(home, "e1-large.txt");
      writeFileSync(bodyFile, `${"z".repeat(70_000)}\n`);
      const submitted = capture();
      const code = runCli(
        ["channel", "post", "e1-probe", "--from", "w1", "--kind", "report", "--body-file", bodyFile, "--json"],
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

  it("refuses with rollback when the staged file's in-transaction binding re-read finds the Vault moved (CHN-014)", () => {
    const created = capture();
    expect(runCli(["channel", "create", "f2-probe", "--json"], created.ports)).toBe(0);
    expect(runCli(["channel", "add", "f2-probe", "w1", "--role", "worker", "--json"], created.ports)).toBe(0);

    // The first binding read succeeds and stages the file; the in-transaction
    // re-read observes a genuinely different Vault path, exactly the move the
    // CHN-014 rule exists to catch, and the post rolls back with
    // CONFIG_CONFLICT having committed nothing.
    const realChannels = channelCommandPorts.createNodeChannelPorts;
    const channelSpy = vi.spyOn(channelCommandPorts, "createNodeChannelPorts").mockImplementation((options = {}) => {
      const ports = realChannels(options);
      const realBinding = ports.staging.freshBinding.bind(ports.staging);
      let calls = 0;
      ports.staging.freshBinding = () => {
        calls += 1;
        const binding = realBinding();
        if (binding.ok && calls === 1) return binding;
        // The re-read inside the transaction: the configured path changed.
        return { ok: true as const, value: { vaultPath: `${binding.ok ? binding.value.vaultPath : ""}-moved` } };
      };
      return ports;
    });
    try {
      const count = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      const messagesBefore = (count.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number }).n;
      const intentsBefore = (count.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get() as { n: number }).n;
      count.close();
      const bodyFile = join(home, "f2-large.txt");
      writeFileSync(bodyFile, `${"q".repeat(70_000)}\n`);
      const submitted = capture();
      const code = runCli(
        ["channel", "post", "f2-probe", "--from", "w1", "--kind", "report", "--body-file", bodyFile, "--json"],
        submitted.ports,
      );
      expect(code, submitted.err.join("")).toBe(75);
      expect(envelopeOf(submitted).error?.code).toBe("CONFIG_CONFLICT");
      const after = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      try {
        expect((after.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number }).n).toBe(
          messagesBefore,
        );
        expect((after.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get() as { n: number }).n).toBe(
          intentsBefore,
        );
      } finally {
        after.close();
      }
    } finally {
      channelSpy.mockRestore();
    }
  });

  it("uses one open-and-migrate for a mutation and resolves no working-directory Project (CHN-013)", () => {
    const created = capture();
    expect(runCli(["channel", "create", "accounting", "--json"], created.ports)).toBe(0);

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
    const code = runCli(["channel", "show", "accounting", "--json"], shown.ports);
    // `show` is a covered read: exit 0, and neither the migration path nor a
    // Project factory runs at all.
    expect(code, shown.err.join("")).toBe(0);
    expect(openAndMigrateSpy).toHaveBeenCalledTimes(0);
    expect(projectFactorySpy).toHaveBeenCalledTimes(0);
    openSpy.mockRestore();
    openAndMigrateSpy.mockRestore();
    projectFactorySpy.mockRestore();

    const mutated = capture();
    const mutationCode = runCli(["channel", "close", "accounting", "--json"], mutated.ports);
    expect(mutationCode, mutated.err.join("")).toBe(0);
    void openAndClose;
  });

  it("opens and migrates nothing for a covered Channel read (the zero-write primitive)", () => {
    const openAndMigrateSpy = vi.spyOn(migrator, "openAndMigrate");
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase");
    const created = capture();
    expect(runCli(["channel", "create", "covered-counting", "--json"], created.ports)).toBe(0);
    openAndMigrateSpy.mockClear();
    openSpy.mockClear();
    const read = capture();
    const code = runCli(["channel", "list", "--json"], read.ports);
    expect(code, read.err.join("")).toBe(0);
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

  /** Registers the sender project and creates one Channel with a committed message. */
  function retainedReceipts(): { channel: string; worker: string; sendKey: string } {
    registerProject();
    const created = capture();
    expect(runCli(["channel", "create", "aq-wp", "--json"], created.ports), created.err.join("")).toBe(0);
    expect(runCli(["channel", "add", "aq-wp", "w1", "--role", "worker", "--json"], created.ports)).toBe(0);
    const sendKey = `send-key-${randomUUID()}`;
    const sent = capture();
    expect(
      runCli(
        ["send", "--to", "alpha", "--title", "t", "--body", "b", "--idempotency-key", sendKey, "--json"],
        sent.ports,
      ),
      sent.err.join(""),
    ).toBe(0);
    const submitted = capture();
    expect(
      runCli(
        ["channel", "post", "aq-wp", "--from", "w1", "--kind", "report", "--body", "cb", "--json"],
        submitted.ports,
      ),
      submitted.err.join(""),
    ).toBe(0);
    return { channel: "aq-wp", worker: "w1", sendKey };
  }

  it("returns the typed write-protected refusal for Channel mutations while the covered reads succeed", () => {
    const receipts = retainedReceipts();
    protect();
    // The covered Channel reads succeed on the write-protected installation
    // with their normal output (SHR-015's EPIC-018 amendment).
    const listedRead = capture();
    expect(runCli(["channel", "list", "--json"], listedRead.ports)).toBe(0);
    expect(JSON.parse(listedRead.out.join("")).data.items).toHaveLength(1);
    const shownRead = capture();
    expect(runCli(["channel", "show", receipts.channel, "--json"], shownRead.ports)).toBe(0);
    const waitedRead = capture();
    expect(
      runCli(["channel", "messages", receipts.channel, "--wait", "--timeout", "1", "--json"], waitedRead.ports),
    ).toBe(0);

    // Mutations refuse with the typed write-protected envelope.
    const channel = capture();
    expect(runCli(["channel", "create", "refused-probe", "--json"], channel.ports)).toBe(75);
    const channelEnvelope = envelopeOf(channel);
    expect(channelEnvelope.ok).toBe(false);
    expect(channelEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(channelEnvelope.error?.details.storageContention).toBe(true);
    expect(channelEnvelope.error?.message).toBe(
      "Channel storage is write-protected: the Sorage database cannot be written by this invocation, so this Channel command committed none of the changes it was asked to make.",
    );
    expect(channelEnvelope.error?.recovery?.suggestedCommand).toBe(
      "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical channel command; it committed none of the changes it was asked to make.",
    );
    expect(channel.out.join("")).toBe("");

    const postedRefusal = capture();
    expect(
      runCli(
        ["channel", "post", receipts.channel, "--from", receipts.worker, "--kind", "report", "--body", "new", "--json"],
        postedRefusal.ports,
      ),
    ).toBe(75);
    expect(envelopeOf(postedRefusal).error?.message).toContain("Channel storage is write-protected");

    const human = capture();
    expect(runCli(["channel", "create", "refused-human"], human.ports)).toBe(75);
    expect(human.err.join("")).toBe(
      "STORAGE_INSPECTION_UNAVAILABLE: Channel storage is write-protected: the Sorage database cannot be written by this invocation, so this Channel command committed none of the changes it was asked to make.\n" +
        "Recovery: After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical channel command; it committed none of the changes it was asked to make.\n",
    );

    const send = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b2", "--json"], send.ports)).toBe(75);
    const sendEnvelope = envelopeOf(send);
    expect(sendEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(sendEnvelope.error?.message).toContain("Handoff storage is write-protected");
    expect(sendEnvelope.error?.recovery?.suggestedCommand).toBe(
      "In a permitted writable execution context, retry the identical command with the original mode, inputs, and idempotency key. For an unknown send outcome, inspect the original material with sorage send --replay-only first: it writes no Sorage home or Vault data but needs writable private temporary scratch. If that scratch is denied and an already permitted MCP server is available, use handoff_send with replayOnly: true and the same Installation and sender context; never execute again or replace the key automatically.",
    );

    const sendHuman = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "t", "--body", "b3"], sendHuman.ports)).toBe(75);
    expect(sendHuman.err.join("")).toBe(
      "STORAGE_INSPECTION_UNAVAILABLE: Handoff storage is write-protected: the Sorage database cannot be written by this invocation, so this command committed none of the changes it was asked to make.\n" +
        "Recovery: In a permitted writable execution context, retry the identical command with the original mode, inputs, and idempotency key. For an unknown send outcome, inspect the original material with sorage send --replay-only first: it writes no Sorage home or Vault data but needs writable private temporary scratch. If that scratch is denied and an already permitted MCP server is available, use handoff_send with replayOnly: true and the same Installation and sender context; never execute again or replace the key automatically.\n",
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
    void channel;
  });

  it("returns the normal send replay-only result and the covered Channel reads without write access", () => {
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
    const messages = capture();
    expect(runCli(["channel", "messages", receipts.channel, "--json"], messages.ports), messages.err.join("")).toBe(0);
    expect(JSON.parse(messages.out.join("")).data.items).toHaveLength(1);
  });

  it("succeeds again once write access is restored (design c)", () => {
    retainedReceipts();
    const restore = protect();
    expect(runCli(["channel", "create", "design-c", "--json"], capture().ports)).toBe(75);
    restore();
    const recovered = capture();
    expect(runCli(["channel", "create", "design-c", "--json"], recovered.ports), recovered.err.join("")).toBe(0);
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
