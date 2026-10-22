import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sqliteConnections from "../../src/sqlite/connection";
import {
  MigrationConnectionError,
  MigrationFailedError,
  MigrationIntegrityError,
  SchemaAdmissionError,
  openAndMigrate,
} from "../../src/sqlite/migrator";
import {
  appError,
  type AppError,
  approveDeletion,
  archiveProject,
  createChannel,
  declineHandoff,
  err,
  fetchHandoff,
  initializeInstallation,
  addProject,
  listChannelMessages,
  renameProject,
  requestDeletion,
  resolveCommandActor,
  resolveMemoProject,
  sendHandoffs,
  setReviewNote,
  submitMessage,
  handleChannelMessage,
  USER_ACTOR,
} from "@sorage/core";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeProjectPorts } from "../../src/project-command-ports";
import {
  createNodeSendPorts,
  createNodeReviewPorts,
  createNodeRetentionPorts,
  createNodeTerminalPorts,
  createNodeHandoffReadPorts,
} from "../../src/handoff-command-ports";
import { createNodeChannelPorts, captureChannelBodyText, channelStorageError } from "../../src/channels";
import { createNodeMemoPorts, memoStorageError } from "../../src/memo-command-ports";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { storageContentionOf, AppCommandError, asAppCommandError } from "../../src/storage-contention";
import { openSorageDatabase, openSorageInspectionCopy } from "../../src/sqlite/connection";
import type { SorageSqlite } from "../../src/sqlite/connection";
import { productionMigrationPlan } from "../../src/sqlite/migrations";

/**
 * The SHR-015 storage-preparation contention contract at the adapter boundary:
 * the shared classifier's recognition and exclusions, the surfaced family
 * compositions' refusals with their invoking-family wording, the Project
 * adapter's in-transaction result reads, the drain's two contention sites, and
 * the excluded (Memo) and coherence-outcome pins. Write-lock contention is real
 * (a second connection holds BEGIN IMMEDIATE) with a short injected busy
 * timeout; read-side sites use statement-level busy injection because a WAL
 * write lock never fails a SELECT.
 */

/** An inline accepted body with honest size and digest. */
function textAccepted(text: string): { kind: "text"; text: string; sizeBytes: number; sha256: string } {
  return {
    kind: "text",
    text,
    sizeBytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

const busyError = (message = "database is locked"): Error => Object.assign(new Error(message), { code: "SQLITE_BUSY" });

/** The error of a failed Result, refusing to pass a success through. */
function errorOf<T>(result: { ok: true; value: T } | { ok: false; error: AppError }): AppError {
  if (!result.ok) return result.error;
  throw new Error("expected a failure result");
}

let home: string;
let work: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sorage-contention-"));
  work = mkdtempSync(join(tmpdir(), "sorage-contention-work-"));
  process.env.SORAGE_HOME = home;
  const init = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(init.ok).toBe(true);
});

afterEach(() => {
  delete process.env.SORAGE_HOME;
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // Teardown is best-effort.
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

/** A database handle whose busy timeout is short, so held-lock cases cost milliseconds. */
function quickDb(path = join(home, "state", "sorage.sqlite3")): SorageSqlite {
  const db = openSorageDatabase(path);
  db.exec("PRAGMA busy_timeout = 50");
  return db;
}

/** Wraps a handle so the targeted prepared statement throws the busy signature (W1 read-side injection). */
function withBusyStatement(db: SorageSqlite, sqlNeedle: string): SorageSqlite {
  return {
    prepare(sql: string) {
      if (sql.includes(sqlNeedle)) throw busyError();
      return db.prepare(sql);
    },
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  } as unknown as SorageSqlite;
}

/** An independent connection holding the database write lock until released. */
function holdWriteLock(): { release(): void } {
  const holder = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  holder.exec("BEGIN IMMEDIATE");
  cleanups.push(() => {
    try {
      holder.exec("ROLLBACK");
    } catch {
      // Already closed.
    }
    holder.close();
  });
  return {
    release() {
      holder.exec("ROLLBACK");
      holder.close();
    },
  };
}

function rowCount(holder: () => DatabaseSync, sql: string): number {
  const db = holder();
  try {
    const row = db.prepare(sql).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

const independentConnection = (): DatabaseSync => new DatabaseSync(join(home, "state", "sorage.sqlite3"));

/** A sorted snapshot of every row of the given tables, read through an independent connection. */
function snapshot(tables: string[]): Record<string, unknown[]> {
  const db = independentConnection();
  try {
    const result: Record<string, unknown[]> = {};
    for (const table of tables) {
      result[table] = db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => JSON.parse(JSON.stringify(row)));
    }
    return result;
  } finally {
    db.close();
  }
}

/** Wraps a handle so `COMMIT` throws the busy signature (the domain COMMIT-failure site). */
function withCommitFailure(db: SorageSqlite): SorageSqlite {
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec(sql: string) {
      if (sql === "COMMIT") throw busyError();
      return db.exec(sql);
    },
    close: () => db.close(),
  } as unknown as SorageSqlite;
}

/** Registers a bound Project and returns the shared database handle. */
function registeredHome(): { db: SorageSqlite; slug: string; dir: string } {
  const db = quickDb();
  const dir = mkdtempSync(join(tmpdir(), "sorage-contention-dir-"));
  const added = addProject(createNodeProjectPorts({ contentionSurface: "project", database: db }), {
    name: "Alpha",
    slug: "alpha",
    dir,
    userHome: homedir(),
    actor: USER_ACTOR,
  });
  expect(added.ok).toBe(true);
  return { db, slug: "alpha", dir };
}

/** Sends one small inline Handoff and returns its id; the sender may differ from the recipient. */
function sentHandoffId(db: SorageSqlite, dir: string, senderPath?: string): string {
  const outcome = sendHandoffs(createNodeSendPorts({ database: db }), {
    to: ["alpha"],
    title: "t",
    body: "b",
    allowExternalSource: false,
    allowUnregistered: false,
    path: senderPath ?? dir,
    userHome: homedir(),
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("send failed");
  return outcome.value.handoffs[0]?.handoffId ?? "";
}

describe("the shared classifier", () => {
  it("maps busy and unavailability signatures to the marked surface-stamped refusal", () => {
    for (const surface of ["channel", "handoff", "project"] as const) {
      const byCode = storageContentionOf(
        Object.assign(new Error("sqlite error"), { code: "ERR_SQLITE_BUSY" }),
        surface,
      );
      expect(byCode?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(byCode?.details?.storageContention).toBe(true);
      const head = surface === "channel" ? "Channel" : surface === "handoff" ? "Handoff" : "Project";
      expect(byCode?.message).toContain(`${head} storage is contended`);
      expect(byCode?.message).toContain("committed none of the changes it was asked to make");
      expect(byCode?.recovery?.suggestedCommand).toBe(
        surface === "channel"
          ? "Retry the same channel command with its original mode, input, and idempotency key when storage is quieter; a replay-only retry stays replay-only, and after an unknown submission outcome inspect with --replay-only first."
          : surface === "handoff"
            ? "Retry the same command with its original mode, input, and idempotency key when storage is quieter; after an unknown send outcome inspect with sorage send --replay-only first."
            : "Retry the same command when storage is quieter; it committed none of the changes it was asked to make.",
      );
    }
    const byMessage = storageContentionOf(busyError(), "handoff");
    expect(byMessage?.message).toContain("locking the Sorage database did not succeed within the busy timeout");
    const unopenable = storageContentionOf(
      Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" }),
      "project",
    );
    expect(unopenable?.message).toContain("opening the Sorage database did not succeed");
    const mappedCause = storageContentionOf(
      appError("INTERNAL_ERROR", "Reading the database failed.", { cause: String(busyError()) }),
      "handoff",
    );
    expect(mappedCause?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
  });

  it("maps the write-protected signature to the state-accurate refusal in every form it surfaces (TASK-119)", () => {
    for (const surface of ["channel", "handoff", "project"] as const) {
      const head = surface === "channel" ? "Channel" : surface === "handoff" ? "Handoff" : "Project";
      const subject = surface === "channel" ? "Channel command" : "command";
      const byCode = storageContentionOf(
        Object.assign(new Error("sqlite error"), { code: "SQLITE_READONLY" }),
        surface,
      );
      expect(byCode?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(byCode?.details?.storageContention).toBe(true);
      expect(byCode?.message).toBe(
        `${head} storage is write-protected: the Sorage database cannot be written by this invocation, so this ${subject} committed none of the changes it was asked to make.`,
      );
      expect(byCode?.recovery?.suggestedCommand).toBe(
        surface === "channel"
          ? "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical channel command with its original mode, inputs, and idempotency key; when the original outcome of a keyed submission is unknown, inspect with --replay-only and the original material first, which runs without write access."
          : surface === "handoff"
            ? "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical command with its original mode, inputs, and idempotency key; when the original outcome of a keyed send is unknown, inspect with sorage send --replay-only and the original material first, which runs without write access."
            : "After write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), retry the identical command; it committed none of the changes it was asked to make.",
      );
    }
    // Project surfaces take no idempotency key and have no mode, so their
    // restore-access retry names neither (S1).
    const projectReadonly = storageContentionOf(
      Object.assign(new Error("sqlite error"), { code: "SQLITE_READONLY" }),
      "project",
    );
    const projectRecovery = projectReadonly?.recovery?.suggestedCommand ?? "";
    expect(projectRecovery).not.toContain("idempotency");
    expect(projectRecovery).not.toContain("mode");
    expect(projectRecovery).not.toContain("--replay-only");
    const byAltCode = storageContentionOf(
      Object.assign(new Error("sqlite error"), { code: "ERR_SQLITE_READONLY" }),
      "handoff",
    );
    expect(byAltCode?.message).toContain("Handoff storage is write-protected");
    const byMessage = storageContentionOf(new Error("attempt to write a readonly database"), "project");
    expect(byMessage?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(byMessage?.message).toContain("Project storage is write-protected");
    const wrapped = new MigrationFailedError(
      9,
      "handoff-shared-content",
      Object.assign(new Error("attempt to write a readonly database"), { code: "SQLITE_READONLY" }),
    );
    expect(storageContentionOf(wrapped, "handoff")?.message).toContain("Handoff storage is write-protected");
    const mappedReadonlyCause = storageContentionOf(
      appError("INTERNAL_ERROR", "Reading the database failed.", {
        cause: String(Object.assign(new Error("attempt to write a readonly database"), { code: "SQLITE_READONLY" })),
      }),
      "channel",
    );
    expect(mappedReadonlyCause?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    // The write-protection recovery never suggests a quieter-storage retry, a
    // fresh key, a mode switch, or an authority flag (V1).
    for (const recovery of [
      byAltCode?.recovery?.suggestedCommand,
      byMessage?.recovery?.suggestedCommand,
      mappedReadonlyCause?.recovery?.suggestedCommand,
    ]) {
      expect(recovery).not.toContain("when storage is quieter");
    }
  });

  it("classifies a wrapped migration step failure only when its preserved cause is contention (W3)", () => {
    const wrapped = new MigrationFailedError(9, "handoff-shared-content", busyError());
    expect(storageContentionOf(wrapped, "handoff")?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    const corrupted = new MigrationFailedError(
      9,
      "handoff-shared-content",
      new Error("database disk image is malformed"),
    );
    expect(storageContentionOf(corrupted, "handoff")).toBeNull();
  });

  it("never relabels admission, restoration, or integrity outcomes (V13)", () => {
    const admission = new SchemaAdmissionError(appError("STORAGE_SCHEMA_UNSUPPORTED", "newer schema"));
    expect(storageContentionOf(admission, "handoff")).toBeNull();
    expect(
      storageContentionOf(new MigrationConnectionError("restoration failed", true, false, busyError()), "handoff"),
    ).toBeNull();
    expect(
      storageContentionOf(new MigrationConnectionError("restoration failed", false, false, busyError()), "handoff"),
    ).toBeNull();
    expect(storageContentionOf(new MigrationIntegrityError(2, 9, "step"), "handoff")).toBeNull();
    expect(storageContentionOf(new Error("database disk image is malformed"), "handoff")).toBeNull();
    expect(storageContentionOf(new Error("no such table: channels"), "channel")).toBeNull();
  });

  it("carries typed errors through the AppCommandError carrier", () => {
    const carrier = new AppCommandError(appError("CONFIG_INVALID", "unreadable"));
    expect(asAppCommandError(carrier)?.error.code).toBe("CONFIG_INVALID");
    expect(asAppCommandError(new Error("raw"))).toBeNull();
  });
});

describe("the surfaced Project composition", () => {
  it("refuses add, rename, and archive with the Project refusal and committed nothing (real held lock)", () => {
    const ports = createNodeProjectPorts({ contentionSurface: "project", database: quickDb() });
    const lock = holdWriteLock();
    const projectsBefore = rowCount(independentConnection, "SELECT COUNT(*) AS n FROM projects");
    const eventsBefore = rowCount(independentConnection, "SELECT COUNT(*) AS n FROM events");

    const added = addProject(ports, {
      name: "Alpha",
      slug: "alpha",
      dir: work,
      userHome: homedir(),
      actor: USER_ACTOR,
    });
    expect(added.ok).toBe(false);
    expect(errorOf(added).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(errorOf(added).details?.storageContention).toBe(true);
    expect(errorOf(added).recovery?.suggestedCommand).toBe(
      "Retry the same command when storage is quieter; it committed none of the changes it was asked to make.",
    );

    lock.release();
    const registered = addProject(ports, {
      name: "Alpha",
      slug: "alpha",
      dir: work,
      userHome: homedir(),
      actor: USER_ACTOR,
    });
    expect(registered.ok).toBe(true);
    expect(rowCount(independentConnection, "SELECT COUNT(*) AS n FROM projects")).toBe(projectsBefore + 1);

    const renameLock = holdWriteLock();
    const displayNameBefore = (
      independentConnection().prepare("SELECT display_name FROM projects WHERE slug = 'alpha'").get() as {
        display_name: string;
      }
    ).display_name;
    const renamed = renameProject(ports, { slug: "alpha", name: "Beta", actor: USER_ACTOR });
    expect(renamed.ok).toBe(false);
    expect(errorOf(renamed).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    const afterFailedRename = (
      independentConnection().prepare("SELECT display_name FROM projects WHERE slug = 'alpha'").get() as {
        display_name: string;
      }
    ).display_name;
    expect(afterFailedRename).toBe(displayNameBefore);
    expect(rowCount(independentConnection, "SELECT COUNT(*) AS n FROM events")).toBe(eventsBefore + 2);

    renameLock.release();
    const archiveLock = holdWriteLock();
    const archived = archiveProject(ports, { slug: "alpha" });
    expect(archived.ok).toBe(false);
    expect(errorOf(archived).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    const status = independentConnection().prepare("SELECT status FROM projects WHERE slug = 'alpha'").get() as {
      status: string;
    };
    expect(status.status).toBe("active");
    archiveLock.release();
  });

  it("rolls the in-transaction result read back with nothing committed when the read fails", () => {
    const base = quickDb();
    // The read runs inside the committing transaction; a failing read rolls the
    // registration and its events back (SHR-015 category (iii) removal).
    const realPrepare = base.prepare.bind(base);
    let failNextProjectRead = false;
    const db = {
      prepare(sql: string) {
        if (failNextProjectRead && sql === "SELECT * FROM projects WHERE id = ?") {
          throw new Error("injected result-read failure");
        }
        return realPrepare(sql);
      },
      exec: (sql: string) => base.exec(sql),
      close: () => base.close(),
    } as unknown as SorageSqlite;
    const ports = createNodeProjectPorts({ contentionSurface: "project", database: db });
    const before = rowCount(independentConnection, "SELECT COUNT(*) AS n FROM projects");
    const eventsBefore = rowCount(independentConnection, "SELECT COUNT(*) AS n FROM events");
    failNextProjectRead = true;
    const added = addProject(ports, {
      name: "Gamma",
      slug: "gamma",
      dir: work,
      userHome: homedir(),
      actor: USER_ACTOR,
    });
    expect(added.ok).toBe(false);
    expect(errorOf(added).code).toBe("INTERNAL_ERROR");
    expect(rowCount(independentConnection, "SELECT COUNT(*) AS n FROM projects")).toBe(before);
    expect(rowCount(independentConnection, "SELECT COUNT(*) AS n FROM events")).toBe(eventsBefore);
  });

  it("refuses with rollback when the domain COMMIT itself fails with the busy signature", () => {
    const base = quickDb();
    let failCommit = false;
    const db = {
      prepare: (sql: string) => base.prepare(sql),
      exec(sql: string) {
        if (sql === "COMMIT" && failCommit) throw busyError();
        return base.exec(sql);
      },
      close: () => base.close(),
    } as unknown as SorageSqlite;
    const ports = createNodeProjectPorts({ contentionSurface: "project", database: db });
    const before = rowCount(independentConnection, "SELECT COUNT(*) AS n FROM projects");
    failCommit = true;
    const added = addProject(ports, {
      name: "Delta",
      slug: "delta",
      dir: work,
      userHome: homedir(),
      actor: USER_ACTOR,
    });
    expect(added.ok).toBe(false);
    expect(errorOf(added).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(rowCount(independentConnection, "SELECT COUNT(*) AS n FROM projects")).toBe(before);
  });

  it("keeps the unsurfaced composition byte-for-byte on INTERNAL_ERROR (init and Memo share it)", () => {
    const ports = createNodeProjectPorts({ database: quickDb() });
    const lock = holdWriteLock();
    const added = addProject(ports, {
      name: "Epsilon",
      slug: "epsilon",
      dir: work,
      userHome: homedir(),
      actor: USER_ACTOR,
    });
    expect(added.ok).toBe(false);
    expect(errorOf(added).code).toBe("INTERNAL_ERROR");
    expect(errorOf(added).message).toContain("the project repository failed:");
    lock.release();
  });
});

describe("the surfaced Channel composition", () => {
  it("refuses a domain mutation with the Channel refusal and committed nothing (real held lock)", () => {
    const ports = createNodeChannelPorts({ database: quickDb() });
    const lock = holdWriteLock();
    const before = rowCount(independentConnection, "SELECT COUNT(*) AS n FROM channels");
    const created = createChannel(ports, { creator: USER_ACTOR, mainHandle: "orchestrator", title: undefined });
    expect(created.ok).toBe(false);
    expect(errorOf(created).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(errorOf(created).message).toContain("Channel storage is contended");
    expect(errorOf(created).recovery?.suggestedCommand).toContain("a replay-only retry stays replay-only");
    expect(rowCount(independentConnection, "SELECT COUNT(*) AS n FROM channels")).toBe(before);
    lock.release();
    const retry = createChannel(ports, { creator: USER_ACTOR, mainHandle: "orchestrator", title: undefined });
    expect(retry.ok).toBe(true);
  });

  it("stamps the Channel wording on a refusal raised in the shared Project repository during actor resolution (V11, W1)", () => {
    const ports = createNodeChannelPorts({ database: withBusyStatement(quickDb(), "FROM projects WHERE slug =") });
    const resolved = resolveCommandActor(ports.projectPorts, {
      path: work,
      userHome: homedir(),
      as: "nope",
      asUser: false,
    });
    expect(resolved.ok).toBe(false);
    expect(errorOf(resolved).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(errorOf(resolved).message).toContain("Channel storage is contended");
    expect(errorOf(resolved).message).toContain(
      "this Channel command committed none of the changes it was asked to make",
    );
  });

  it("drives the real coherence-exhaustion path and keeps its own text, never the contention stamp (V1)", () => {
    // The mechanism reuses the established churn pattern: a concurrent commit
    // lands between the page's external-version capture and its re-check, and
    // repeating it past the bounded budget exhausts coherence (listExhausted).
    const ports = createNodeChannelPorts({ database: quickDb() });
    const other = createNodeChannelPorts({ database: quickDb() });
    try {
      const created = createChannel(ports, { creator: USER_ACTOR, mainHandle: "orchestrator", title: undefined });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const submitted = submitMessage(ports, {
        channelId: created.value.channel.id,
        senderParticipantId: created.value.channel.mainParticipantId,
        kind: "report",
        accepted: textAccepted("coherent body"),
        actor: USER_ACTOR,
      });
      expect(submitted.ok).toBe(true);
      const read = ports.bodies.readRecordPreviewSeed;
      ports.bodies.readRecordPreviewSeed = (ref, binding) => {
        const result = read(ref, binding);
        void createChannel(other, { creator: { kind: "user", id: null }, mainHandle: "churn", title: null });
        return result;
      };
      const refused = listChannelMessages(ports, created.value.channel.id, { handling: "all" });
      expect(refused.ok).toBe(false);
      const coherence = errorOf(refused);
      expect(coherence.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(coherence.message).toBe(
        "A coherent Channel list page could not be assembled because the database kept changing; no page was emitted",
      );
      expect(coherence.recovery?.suggestedCommand).toBe("Retry the Channel list; no partial page was emitted");
      expect(coherence.details?.storageContention).toBeUndefined();
      // The shared classifier never captures the coherence refusal.
      expect(storageContentionOf(coherence, "channel")).toBeNull();
    } finally {
      ports.close();
      other.close();
    }
  });

  it("returns the committed Channel outcomes on the real post-commit failure paths", () => {
    const ports = createNodeChannelPorts({ database: quickDb() });
    try {
      const created = createChannel(ports, { creator: USER_ACTOR, mainHandle: "orchestrator", title: undefined });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const channelId = created.value.channel.id;
      const mainId = created.value.channel.mainParticipantId;
      const warnings: string[] = [];
      const disclosures = ports.disclosures;
      if (disclosures === undefined) throw new Error("expected the Channel disclosures seam");
      ports.disclosures = { ...disclosures, completionWarning: (text) => warnings.push(text) };

      // A committed submit whose file-backed activation pauses behind a live
      // move lock returns its committed outcome with `contentActivating` and a
      // contained warning, never the interim CONTENT_MATERIALIZING failure.
      mkdirSync(join(home, "run"), { recursive: true });
      const lockPath = join(home, "run", "vault-move.lock");
      const placeLock = () => {
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "test" }),
        );
      };
      const activate = ports.staging.activateContent;
      ports.staging.activateContent = (input, binding) => {
        placeLock();
        return activate(input, binding);
      };
      const largeText = "vault body\n".repeat(7000);
      const captured = captureChannelBodyText(largeText, {
        maxBytes: ports.maxBytes,
        stateDir: ports.stateDir,
        spoolId: "contention-pause",
      });
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      const paused = submitMessage(ports, {
        channelId,
        senderParticipantId: mainId,
        kind: "report",
        accepted: captured.value,
        actor: USER_ACTOR,
      });
      expect(paused.ok).toBe(true);
      if (!paused.ok) return;
      expect(paused.value.contentActivating).toBe(true);
      expect(warnings).toEqual([
        "the Channel message committed but its content activation paused behind a held Vault-move lock; the pending intent remains for the next process start",
      ]);
      const pausedSummary = paused.value.message;
      expect(pausedSummary.bodyBytes).toBeGreaterThan(65_536);
      rmSync(lockPath, { force: true });
      ports.staging.activateContent = activate;

      // A committed handle whose post-commit preview read fails returns its
      // committed decision with the explicit unavailable-preview indicator and
      // never becomes the contention refusal.
      const submitted = submitMessage(ports, {
        channelId,
        senderParticipantId: mainId,
        kind: "report",
        accepted: textAccepted("preview body"),
        actor: USER_ACTOR,
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      ports.bodies.readRecordPreviewSeed = () => err(appError("INTERNAL_ERROR", "injected preview failure"));
      const handled = handleChannelMessage(ports, {
        channelId,
        messageId: submitted.value.message.id,
        assertion: { actor: USER_ACTOR, asParticipant: mainId },
        expectedRowVersion: 1,
      });
      expect(handled.ok).toBe(true);
      if (handled.ok) {
        expect(handled.value.bodyPreviewUnavailable).toBe(true);
        expect(handled.value.message.bodyPreview).toBe("");
        expect(handled.value.message.handled).toBe(true);
      }
      // The decision itself committed: the message is handled in the database.
      const count = independentConnection();
      try {
        const row = count
          .prepare("SELECT handled FROM channel_messages WHERE id = ?")
          .get(submitted.value.message.id) as {
          handled: number;
        };
        expect(row.handled).toBe(1);
      } finally {
        count.close();
      }
    } finally {
      ports.close();
    }
  });
});

describe("the surfaced Handoff composition", () => {
  it("stamps the Handoff wording on a refusal raised in the shared Project repository during actor resolution (V11, W1)", () => {
    const ports = createNodeSendPorts({ database: withBusyStatement(quickDb(), "FROM projects WHERE slug =") });
    const resolved = resolveCommandActor(ports.projectPorts, {
      path: work,
      userHome: homedir(),
      as: "nope",
      asUser: false,
    });
    expect(resolved.ok).toBe(false);
    expect(errorOf(resolved).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(errorOf(resolved).message).toContain("Handoff storage is contended");
    expect(errorOf(resolved).recovery?.suggestedCommand).toContain("sorage send --replay-only first");
  });
});

describe("the excluded Memo composition", () => {
  it("keeps Memo output byte-for-byte through factory contention and busy Project lookups (V2)", () => {
    // Factory open contention: the real open meets a held lock through the
    // connection seam with a short busy timeout.
    const realOpen = sqliteConnections.openSorageDatabase;
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
      const db = realOpen(path);
      db.exec("PRAGMA busy_timeout = 50");
      return db;
    });
    try {
      const lock = holdWriteLock();
      let threw: unknown;
      try {
        createNodeMemoPorts();
      } catch (error) {
        threw = error;
      }
      // memoStorageError collapses every non-admission failure, including a
      // carried refusal, to the unchanged INTERNAL_ERROR wording.
      const mapped = memoStorageError(threw ?? new Error("unused"));
      expect(mapped.code).toBe("INTERNAL_ERROR");
      expect(mapped.message).toBe("Memo storage could not be opened");
      lock.release();
    } finally {
      openSpy.mockRestore();
    }

    // Project-lookup contention inside the Memo surface keeps INTERNAL_ERROR.
    const busyLookup = createNodeMemoPorts({ database: withBusyStatement(quickDb(), "FROM projects WHERE slug =") });
    const selected = resolveMemoProject(busyLookup.projectPorts, "memo", {
      path: work,
      userHome: homedir(),
    });
    expect(selected.ok).toBe(false);
    expect(errorOf(selected).code).toBe("INTERNAL_ERROR");
    expect(errorOf(selected).message).toBe("the project repository failed: database is locked");
  });
});

describe("the composition factories", () => {
  it("carries the stamped refusal for open contention and the typed configuration conditions", () => {
    const realOpen = sqliteConnections.openSorageDatabase;
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
      const db = realOpen(path);
      db.exec("PRAGMA busy_timeout = 50");
      return db;
    });
    try {
      const lock = holdWriteLock();
      for (const [build, surface] of [
        [() => createNodeProjectPorts({ contentionSurface: "project" }), "Project"],
        [() => createNodeSendPorts(), "Handoff"],
        [() => createNodeChannelPorts(), "Channel"],
      ] as const) {
        let carried: unknown;
        try {
          build();
        } catch (error) {
          carried = error;
        }
        const typed = asAppCommandError(carried);
        expect(typed).not.toBeNull();
        expect(typed?.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
        expect(typed?.error.message).toContain(`${surface} storage is contended`);
      }
      lock.release();

      // Open unavailability keeps the open-condition message.
      openSpy.mockImplementation(() => {
        throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
      });
      let unopenable: unknown;
      try {
        createNodeProjectPorts({ contentionSurface: "project" });
      } catch (error) {
        unopenable = error;
      }
      expect(asAppCommandError(unopenable)?.error.message).toContain("opening the Sorage database did not succeed");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("carries CONFIG_INVALID for an unreadable configuration and NOT_INITIALIZED for an absent one (surface-independent)", () => {
    const configPath = join(home, "config.yaml");
    chmodSync(configPath, 0o000);
    let unreadable: unknown;
    try {
      createNodeProjectPorts();
    } catch (error) {
      unreadable = error;
    }
    const unreadableTyped = asAppCommandError(unreadable);
    expect(unreadableTyped?.error.code).toBe("CONFIG_INVALID");
    expect(unreadableTyped?.error.message).toContain("cannot be read");

    rmSync(configPath, { force: true });
    let absent: unknown;
    try {
      createNodeChannelPorts();
    } catch (error) {
      absent = error;
    }
    expect(asAppCommandError(absent)?.error.code).toBe("NOT_INITIALIZED");
  });
});

describe("the flagged startup drain", () => {
  it("classifies migration contention and the drain-internal failure separately, on both surfaces (W1)", async () => {
    const realOpen = sqliteConnections.openSorageDatabase;
    // Case (a): the lock is held before the drain opens, so the rebuild
    // migration's dedicated connection refuses first — the migration site.
    const openSpy = vi.spyOn(sqliteConnections, "openSorageDatabase").mockImplementation((path: string) => {
      const db = realOpen(path);
      db.exec("PRAGMA busy_timeout = 50");
      return db;
    });
    try {
      const lock = holdWriteLock();
      const flagged = createNodeVaultCommandPorts({ contentionSurface: "handoff" });
      const refusedDrain = flagged.drainAtStart();
      expect(refusedDrain.ok).toBe(false);
      expect(errorOf(refusedDrain).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(errorOf(refusedDrain).message).toContain("Handoff storage is contended");
      const unflagged = createNodeVaultCommandPorts();
      const internalDrain = unflagged.drainAtStart();
      expect(internalDrain.ok).toBe(false);
      expect(errorOf(internalDrain).code).toBe("INTERNAL_ERROR");
      lock.release();

      // Case (b): the migration completes normally on its dedicated connection
      // (its BEGIN IMMEDIATE and COMMIT run through), and the busy failure is
      // injected only at the drain's own internal transaction on the drain's
      // connection. The event log proves the target site: the failing BEGIN
      // ran after the dedicated connection's COMMIT, on a different connection.
      const events: Array<{ conn: number; sql: string }> = [];
      let connSeq = 0;
      let migrationCommitted = false;
      openSpy.mockImplementation((path: string) => {
        const db = realOpen(path);
        db.exec("PRAGMA busy_timeout = 50");
        connSeq += 1;
        const conn = connSeq;
        let inMigrationTransaction = false;
        return {
          prepare: (sql: string) => db.prepare(sql),
          exec(sql: string) {
            if (sql === "BEGIN IMMEDIATE") {
              events.push({ conn, sql });
              inMigrationTransaction = true;
              if (migrationCommitted) throw busyError();
              return db.exec(sql);
            }
            if (sql === "COMMIT") {
              events.push({ conn, sql });
              const outcome = db.exec(sql);
              if (inMigrationTransaction) {
                inMigrationTransaction = false;
                migrationCommitted = true;
              }
              return outcome;
            }
            return db.exec(sql);
          },
          close: () => db.close(),
        } as unknown as SorageSqlite;
      });
      for (const surface of ["handoff", "channel"] as const) {
        events.length = 0;
        connSeq = 0;
        migrationCommitted = false;
        const surfaced = createNodeVaultCommandPorts({ contentionSurface: surface });
        const internalRefused = surfaced.drainAtStart();
        expect(internalRefused.ok).toBe(false);
        expect(errorOf(internalRefused).code, surface).toBe("STORAGE_INSPECTION_UNAVAILABLE");
        expect(errorOf(internalRefused).message).toContain(
          surface === "handoff" ? "Handoff storage is contended" : "Channel storage is contended",
        );
        // The dedicated migration connection completed its transaction before
        // the failing BEGIN ran on the drain's own connection.
        const dedicatedCommit = events.findIndex((event) => event.sql === "COMMIT");
        const failingBegin = events.findIndex(
          (event) => event.sql === "BEGIN IMMEDIATE" && event.conn !== events[dedicatedCommit]?.conn,
        );
        expect(dedicatedCommit).toBeGreaterThanOrEqual(0);
        expect(failingBegin).toBeGreaterThan(dedicatedCommit);
      }
    } finally {
      openSpy.mockRestore();
    }
  });

  it("reports an unreadable configuration as CONFIG_INVALID when surfaced", () => {
    chmodSync(join(home, "config.yaml"), 0o000);
    const flagged = createNodeVaultCommandPorts({ contentionSurface: "channel" });
    const drained = flagged.drainAtStart();
    expect(drained.ok).toBe(false);
    expect(errorOf(drained).code).toBe("CONFIG_INVALID");
  });
});

describe("the Handoff domain transactions under contention (R2)", () => {
  const HANDOFF_TABLES = ["handoffs", "events", "idempotency_keys", "pending_fs_ops"];

  it("refuses createFanout, the review-note transaction, and the first-fetch fence with the Handoff refusal and no change", () => {
    const { db, dir } = registeredHome();
    // An unregistered-workspace sender keeps the recipient's first fetch a
    // settling recipient fetch rather than a silent sender fetch.
    const senderPath = mkdtempSync(join(tmpdir(), "sorage-contention-sender-"));
    const handoffId = sentHandoffId(db, dir, senderPath);
    const before = snapshot(HANDOFF_TABLES);

    const lock = holdWriteLock();
    const sendPorts = createNodeSendPorts({ database: db });
    const sent = sendHandoffs(sendPorts, {
      to: ["alpha"],
      title: "contended",
      body: "b",
      allowExternalSource: false,
      allowUnregistered: false,
      path: dir,
      userHome: homedir(),
    });
    expect(sent.ok).toBe(false);
    expect(errorOf(sent).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(errorOf(sent).message).toContain("Handoff storage is contended");

    const reviewPorts = createNodeReviewPorts({ database: db });
    const reviewed = setReviewNote(reviewPorts, {
      handoffId,
      text: "note",
      path: dir,
      userHome: homedir(),
      as: undefined,
      asUser: false,
    });
    expect(reviewed.ok).toBe(false);
    expect(errorOf(reviewed).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");

    const readPorts = createNodeHandoffReadPorts({ database: db });
    const fetched = fetchHandoff(
      readPorts,
      { path: dir, userHome: homedir(), as: undefined, asUser: false },
      handoffId,
    );
    expect(fetched.ok).toBe(false);
    expect(errorOf(fetched).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    lock.release();

    expect(snapshot(HANDOFF_TABLES)).toEqual(before);
  });

  it("refuses with rollback when the domain COMMIT itself fails busy", () => {
    const { db, dir } = registeredHome();
    const handoffId = sentHandoffId(db, dir);

    // Handoff createFanout: the fan-out COMMIT fails, everything rolls back.
    const fanoutBefore = snapshot(HANDOFF_TABLES);
    const fanoutPorts = createNodeSendPorts({ database: withCommitFailure(db) });
    const sent = sendHandoffs(fanoutPorts, {
      to: ["alpha"],
      title: "commit fails",
      body: "b",
      allowExternalSource: false,
      allowUnregistered: false,
      path: dir,
      userHome: homedir(),
    });
    expect(sent.ok).toBe(false);
    expect(errorOf(sent).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(snapshot(HANDOFF_TABLES)).toEqual(fanoutBefore);

    // One decision transaction: decline's COMMIT fails, nothing changes.
    const decisionBefore = snapshot(HANDOFF_TABLES);
    const terminalPorts = createNodeTerminalPorts({ database: withCommitFailure(db) });
    const declined = declineHandoff(terminalPorts, {
      handoffId,
      reason: "r",
      expectedRowVersion: 1,
      path: dir,
      userHome: homedir(),
      as: undefined,
      asUser: false,
    });
    expect(declined.ok).toBe(false);
    expect(errorOf(declined).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(snapshot(HANDOFF_TABLES)).toEqual(decisionBefore);
  });

  it("refuses the keyed lookups' expiry-cleanup write under a held lock, in both stores (D1, D2)", () => {
    const { db, dir } = registeredHome();
    const senderPath = mkdtempSync(join(tmpdir(), "sorage-contention-sender-"));
    const handoffId = sentHandoffId(db, dir, senderPath);

    // Reach a terminal state with a pending deletion request, so a keyed
    // delete approve is one lookup away from its decision transaction.
    const declined = declineHandoff(createNodeTerminalPorts({ database: db }), {
      handoffId,
      reason: "r",
      expectedRowVersion: 1,
      path: dir,
      userHome: homedir(),
      as: undefined,
      asUser: false,
    });
    expect(declined.ok).toBe(true);
    const retentionPorts = createNodeRetentionPorts({ database: db });
    const requested = requestDeletion(retentionPorts, {
      handoffId,
      path: dir,
      userHome: homedir(),
      as: undefined,
      asUser: false,
    });
    expect(requested.ok).toBe(true);

    const tables = [...HANDOFF_TABLES, "deletion_requests"];
    const before = snapshot(tables);
    const lock = holdWriteLock();
    try {
      // The retention store's keyed lookup runs its expiry-cleanup DELETE
      // before the decision transaction; the busy becomes the Handoff refusal.
      const refusedApproval = approveDeletion(retentionPorts, {
        handoffId,
        confirm: true,
        idempotencyKey: "approve-key",
        path: dir,
        userHome: homedir(),
        as: undefined,
        asUser: true,
      });
      expect(refusedApproval.ok).toBe(false);
      expect(errorOf(refusedApproval).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(errorOf(refusedApproval).message).toContain("Handoff storage is contended");

      // The write store's keyed lookup (send/revise) carries the same refusal.
      const refusedSend = sendHandoffs(createNodeSendPorts({ database: db }), {
        to: ["alpha"],
        title: "keyed send",
        body: "b",
        allowExternalSource: false,
        allowUnregistered: false,
        path: senderPath,
        userHome: homedir(),
        idempotencyKey: "send-key",
      });
      expect(refusedSend.ok).toBe(false);
      expect(errorOf(refusedSend).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(errorOf(refusedSend).message).toContain("Handoff storage is contended");
    } finally {
      lock.release();
    }
    expect(snapshot(tables)).toEqual(before);
  });
});

describe("the Project domain transactions under contention (R2)", () => {
  const PROJECT_TABLES = ["projects", "project_bindings", "events"];

  it("refuses with rollback when the domain COMMIT itself fails busy", () => {
    const { db } = registeredHome();

    // createProjectWithBinding: the registration COMMIT fails.
    const addBefore = snapshot(PROJECT_TABLES);
    const addPorts = createNodeProjectPorts({ contentionSurface: "project", database: withCommitFailure(db) });
    const added = addProject(addPorts, {
      name: "Beta",
      slug: "beta",
      dir: mkdtempSync(join(tmpdir(), "sorage-contention-beta-")),
      userHome: homedir(),
      actor: USER_ACTOR,
    });
    expect(added.ok).toBe(false);
    expect(errorOf(added).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(snapshot(PROJECT_TABLES)).toEqual(addBefore);

    // updateProjectStatus: the archive COMMIT fails, the state value stands.
    const statusBefore = snapshot(PROJECT_TABLES);
    const statusPorts = createNodeProjectPorts({ contentionSurface: "project", database: withCommitFailure(db) });
    const archived = archiveProject(statusPorts, { slug: "alpha" });
    expect(archived.ok).toBe(false);
    expect(errorOf(archived).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(snapshot(PROJECT_TABLES)).toEqual(statusBefore);
    const row = independentConnection().prepare("SELECT status FROM projects WHERE slug = 'alpha'").get() as {
      status: string;
    };
    expect(row.status).toBe("active");
  });

  it("rolls the in-transaction result read back for rename and archive too, proven by unchanged values", () => {
    const { db } = registeredHome();
    const renamePorts = createNodeProjectPorts({ contentionSurface: "project", database: db });
    const renamed = renameProject(renamePorts, { slug: "alpha", name: "Renamed", actor: USER_ACTOR });
    expect(renamed.ok).toBe(true);

    // rename: the result read inside the transaction fails.
    const base = quickDb();
    let armed = false;
    const readFailDb = {
      prepare(sql: string) {
        if (armed && sql === "SELECT * FROM projects WHERE id = ?") throw new Error("injected result-read failure");
        return base.prepare(sql);
      },
      exec: (sql: string) => base.exec(sql),
      close: () => base.close(),
    } as unknown as SorageSqlite;
    const beforeRename = snapshot(PROJECT_TABLES);
    const renamePorts2 = createNodeProjectPorts({ contentionSurface: "project", database: readFailDb });
    armed = true;
    const refusedRename = renameProject(renamePorts2, { slug: "alpha", name: "Refused", actor: USER_ACTOR });
    armed = false;
    expect(refusedRename.ok).toBe(false);
    expect(errorOf(refusedRename).code).toBe("INTERNAL_ERROR");
    expect(snapshot(PROJECT_TABLES)).toEqual(beforeRename);
    const renamedRow = independentConnection()
      .prepare("SELECT display_name FROM projects WHERE slug = 'alpha'")
      .get() as {
      display_name: string;
    };
    expect(renamedRow.display_name).toBe("Renamed");

    // archive/unarchive: the same in-transaction read failure.
    const beforeArchive = snapshot(PROJECT_TABLES);
    const archivePorts = createNodeProjectPorts({ contentionSurface: "project", database: readFailDb });
    armed = true;
    const refusedArchive = archiveProject(archivePorts, { slug: "alpha" });
    armed = false;
    expect(refusedArchive.ok).toBe(false);
    expect(errorOf(refusedArchive).code).toBe("INTERNAL_ERROR");
    expect(snapshot(PROJECT_TABLES)).toEqual(beforeArchive);
    const statusRow = independentConnection().prepare("SELECT status FROM projects WHERE slug = 'alpha'").get() as {
      status: string;
    };
    expect(statusRow.status).toBe("active");
  });
});

describe("the Channel domain transaction under a failing COMMIT (R2)", () => {
  it("refuses with rollback when the mutation COMMIT fails busy", () => {
    const base = quickDb();
    const ports = createNodeChannelPorts({ database: withCommitFailure(base) });
    const before = snapshot(["channels", "channel_participants", "events", "idempotency_keys"]);
    const created = createChannel(ports, { creator: USER_ACTOR, mainHandle: "orchestrator", title: undefined });
    expect(created.ok).toBe(false);
    expect(errorOf(created).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(errorOf(created).message).toContain("Channel storage is contended");
    expect(snapshot(["channels", "channel_participants", "events", "idempotency_keys"])).toEqual(before);
  });
});

describe("a write-protected installation (TASK-119)", () => {
  /**
   * Protects the installation database and its WAL (and any journal sidecar
   * files) and returns the restore function. The restore returns the state
   * directory to its pre-protection inventory: a refused writable open can
   * leave a read-only `-shm` behind, and that side effect — not the
   * installation — must not outlive the protected phase.
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
    cleanups.push(restore);
    return restore;
  }

  it("rethrows the native readonly failure from the raw layers and classifies it at the boundary (V2)", () => {
    protect();
    let native: unknown;
    try {
      const plan = productionMigrationPlan();
      openAndMigrate(join(home, "state", "sorage.sqlite3"), plan.migrations, { rebuilds: plan.rebuilds });
    } catch (error) {
      native = error;
    }
    expect(native).toBeInstanceOf(Error);
    expect((native as Error).message).toMatch(/readonly/i);
    expect(asAppCommandError(native)).toBeNull();
    const refusal = storageContentionOf(native, "channel");
    expect(refusal?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(refusal?.message).toContain("Channel storage is write-protected");
    expect(refusal?.recovery?.suggestedCommand).toContain(
      "After write access to the Sorage home and Vault is restored",
    );
  });

  it("recognizes the native readonly failure at the private-copy checkpoint site (V2)", () => {
    // A live writer keeps committed bytes in the WAL, so the protected copy's
    // passive checkpoint has real work and fails on the write-protected copy.
    const source = join(work, "checkpoint.sqlite3");
    const writer = openSorageDatabase(source);
    writer.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    writer.exec("INSERT INTO probe (id) VALUES (1)");
    try {
      const protectedMain = join(work, "protected.sqlite3");
      copyFileSync(source, protectedMain);
      copyFileSync(`${source}-wal`, `${protectedMain}-wal`);
      chmodSync(protectedMain, 0o444);
      chmodSync(`${protectedMain}-wal`, 0o444);
      const copy = openSorageInspectionCopy(protectedMain);
      let native: unknown;
      try {
        copy.exec("PRAGMA busy_timeout = 1000");
        copy.exec("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (error) {
        native = error;
      } finally {
        copy.close();
      }
      expect((native as Error)?.message).toMatch(/readonly/i);
      expect(storageContentionOf(native, "channel")?.message).toContain("Channel storage is write-protected");
    } finally {
      writer.close();
    }
  });

  it("refuses the surfaced startup drain with the typed write-protected refusal on both surfaces (V2)", () => {
    protect();
    const before = snapshot(["channels", "projects", "events"]);
    for (const surface of ["channel", "handoff"] as const) {
      const head = surface === "channel" ? "Channel" : "Handoff";
      const drained = createNodeVaultCommandPorts({ contentionSurface: surface }).drainAtStart();
      expect(drained.ok).toBe(false);
      expect(errorOf(drained).code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(errorOf(drained).details?.storageContention).toBe(true);
      expect(errorOf(drained).message).toContain(`${head} storage is write-protected`);
      expect(errorOf(drained).recovery?.suggestedCommand).toContain("retry the identical");
    }
    // The unflagged (excluded-family) composition keeps its INTERNAL_ERROR contract.
    const unflagged = createNodeVaultCommandPorts().drainAtStart();
    expect(unflagged.ok).toBe(false);
    expect(errorOf(unflagged).code).toBe("INTERNAL_ERROR");
    expect(errorOf(unflagged).message).toContain("Reading the database failed");
    expect(snapshot(["channels", "projects", "events"])).toEqual(before);
  });

  it("refuses the surfaced Project, Handoff, and Channel factories with the typed write-protected refusal (V2)", () => {
    protect();
    let projectFailure: unknown;
    try {
      createNodeProjectPorts({ contentionSurface: "project" });
    } catch (error) {
      projectFailure = error;
    }
    const projectRefusal = asAppCommandError(projectFailure)?.error;
    expect(projectRefusal?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(projectRefusal?.message).toContain("Project storage is write-protected");
    expect(projectRefusal?.recovery?.suggestedCommand).toContain(
      "After write access to the Sorage home and Vault is restored",
    );
    expect(projectRefusal?.recovery?.suggestedCommand).not.toContain("replay-only");

    let handoffFailure: unknown;
    try {
      createNodeSendPorts();
    } catch (error) {
      handoffFailure = error;
    }
    const handoffRefusal = asAppCommandError(handoffFailure)?.error;
    expect(handoffRefusal?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(handoffRefusal?.message).toContain("Handoff storage is write-protected");
    expect(handoffRefusal?.recovery?.suggestedCommand).toContain("sorage send --replay-only");

    let channelFailure: unknown;
    try {
      createNodeChannelPorts();
    } catch (error) {
      channelFailure = error;
    }
    const channelRefusal = asAppCommandError(channelFailure)?.error ?? channelStorageError(channelFailure);
    expect(channelRefusal.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(channelRefusal.message).toContain("Channel storage is write-protected");
    expect(channelRefusal.recovery?.suggestedCommand).toContain("runs without write access");
  });

  it("succeeds again once write access is restored, proving the protection caused the refusals (design c)", () => {
    const restore = protect();
    expect(createNodeVaultCommandPorts({ contentionSurface: "channel" }).drainAtStart().ok).toBe(false);
    restore();
    const drained = createNodeVaultCommandPorts({ contentionSurface: "channel" }).drainAtStart();
    expect(drained.ok).toBe(true);
  });
});
