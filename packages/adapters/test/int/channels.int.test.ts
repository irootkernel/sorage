import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  addAssignment,
  addParticipant,
  appError,
  closeAssignment,
  closeChannel,
  createChannel,
  deactivateParticipant,
  err,
  handleChannelMessage,
  listChannelMessages,
  listChannels,
  readChannelMessage,
  showChannel,
  submitMessage,
  submitMessageReplayOnly,
  waitForChannelMessages,
  projectActor,
  SYSTEM_ACTOR,
  type ChannelActorAssertion,
} from "@sorage/core";
import {
  createNodeChannelPorts,
  createNodeChannelRecoveryPorts,
  captureChannelBodyText,
  type NodeChannelPorts,
} from "../../src/channels";
import { createNodeInitPorts } from "../../src/init-ports";
import {
  createSqliteContentStore,
  sqliteContentReferences,
  validateChannelContentLinks,
} from "../../src/content-store";
import { createSqliteEventLedger } from "../../src/events";
import { createSqliteIntentLog } from "../../src/intent-log";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { migrate } from "../../src/sqlite/migrator";
import { productionMigrationPlan } from "../../src/sqlite/migrations";
import { makeTempDatabase } from "../../src/testkit/temp-database";
import { createNodeVaultCommandPorts } from "../../src/vault-command-ports";
import { createNodeDoctorPorts } from "../../src/doctor";
import { createNodeBackupCommandPorts } from "../../src/backup-command-ports";
import { unwrap } from "../fixtures/memo-installation";
import { initializeInstallation } from "@sorage/core";
import { FakeClock } from "../../src/testkit/fakes";

// Anchored one hour in the past so receipts written under this clock stay
// unexpired for the replay-only seams that read with the real system clock; a
// fixed calendar date crossed its own 24-hour receipt expiry on 2026-10-21.
const INSTALLATION_TIME = new Date(Date.now() - 3_600_000).toISOString();

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Fixture {
  home: string;
  ports: NodeChannelPorts;
  close: () => void;
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "sorage-channel-int-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  unwrap(
    initializeInstallation(
      createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
      {
        vaultPath: join(home, "vault"),
      },
    ),
  );
  const ports = createNodeChannelPorts({
    env: { SORAGE_HOME: home },
    userHome: home,
    clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
  });
  return { home, ports, close: ports.close };
}

function mainAssertion(mainParticipantId: string): ChannelActorAssertion {
  return { actor: projectActor("11111111-2222-4333-8444-555555555555"), asParticipant: mainParticipantId };
}

const userAssertion: ChannelActorAssertion = { actor: { kind: "user", id: null }, asUser: true };

function eventCount(home: string): number {
  const db = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type LIKE 'CHANNEL_%'").get() as {
      count: number;
    };
    return Number(row.count);
  } finally {
    db.close();
  }
}

function seedChannel(ports: NodeChannelPorts) {
  const created = unwrap(
    createChannel(ports, {
      creator: projectActor("11111111-2222-4333-8444-555555555555"),
      mainHandle: "orchestrator",
      title: "Epic run",
    }),
  );
  const worker = unwrap(
    addParticipant(ports, {
      channelId: created.channel.id,
      assertion: mainAssertion(created.channel.mainParticipantId),
      role: "worker",
      handle: "worker-a",
    }),
  );
  const judge = unwrap(
    addParticipant(ports, {
      channelId: created.channel.id,
      assertion: mainAssertion(created.channel.mainParticipantId),
      role: "judge",
      handle: "judge-x",
      nativeProvenance: ["podway:node-9"],
    }),
  );
  return { channelId: created.channel.id, main: created.channel.mainParticipantId, worker: worker.id, judge: judge.id };
}

function accepted(ports: NodeChannelPorts, text: string) {
  return unwrap(
    captureChannelBodyText(text, {
      maxBytes: ports.maxBytes,
      stateDir: ports.stateDir,
      spoolId: randomUUID(),
    }),
  );
}

/** Wires the contained post-commit warning sink the CLI composition wires. */
function captureWarnings(ports: NodeChannelPorts): string[] {
  const warnings: string[] = [];
  const current = ports.disclosures;
  if (current === undefined) throw new Error("expected the Channel disclosures seam");
  ports.disclosures = { ...current, completionWarning: (text) => warnings.push(text) };
  return warnings;
}

/**
 * A real database connection whose probe read throws the engine's busy
 * signature; every other statement still runs, so the command itself works.
 */
function busyProbeDatabase(real: ReturnType<typeof openSorageDatabase>): ReturnType<typeof openSorageDatabase> {
  return new Proxy(real, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("cr.materialized")) {
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReturnType<typeof openSorageDatabase>;
}

/** Hides the probed column behind the real probe's SQL, so the real connection throws. */
function hideContentRecords(home: string): void {
  const side = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
  try {
    side.exec("PRAGMA foreign_keys = OFF");
    side.exec("ALTER TABLE content_records RENAME COLUMN materialized TO materialized_hidden");
  } finally {
    side.close();
  }
}

function restoreContentRecords(home: string): void {
  const side = openSorageDatabase(join(home, "state", "sorage.sqlite3"));
  try {
    side.exec("PRAGMA foreign_keys = OFF");
    side.exec("ALTER TABLE content_records RENAME COLUMN materialized_hidden TO materialized");
  } finally {
    side.close();
  }
}

describe("channel domain on real SQLite and filesystem", () => {
  it("creates a Channel with its single main and exactly one creation event", () => {
    const f = fixture();
    const before = eventCount(f.home);
    const created = unwrap(
      createChannel(f.ports, {
        creator: projectActor("11111111-2222-4333-8444-555555555555"),
        mainHandle: "orchestrator",
        title: null,
      }),
    );
    expect(created.replayed).toBe(false);
    expect(created.channel.state).toBe("open");
    expect(created.channel.participants).toHaveLength(1);
    expect(created.channel.participants[0]?.role).toBe("main");
    expect(eventCount(f.home)).toBe(before + 1);
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    try {
      const rows = db
        .prepare(
          "SELECT event_type, handoff_id, memo_id, row_version, metadata_json FROM events WHERE event_type = 'CHANNEL_CREATED'",
        )
        .all() as Array<{
        event_type: string;
        handoff_id: string | null;
        memo_id: unknown;
        row_version: number | null;
        metadata_json: string;
      }>;
      expect(rows).toHaveLength(1);
      const row = rows[0] as { handoff_id: string | null; row_version: number | null; metadata_json: string };
      expect(row.handoff_id).toBeNull();
      expect(row.row_version).toBeNull();
      const metadata = JSON.parse(row.metadata_json) as { channelId: string; mainParticipantId: string };
      expect(Object.keys(metadata).sort()).toEqual(["channelId", "mainParticipantId"]);
      expect(metadata.mainParticipantId).toBe(created.channel.mainParticipantId);
      const secondMain = (): unknown =>
        db
          .prepare(
            "INSERT INTO channel_participants (id, channel_id, role, handle, native_provenance_json, active, registered_at) VALUES (?, ?, 'main', 'other-main', '[]', 1, ?)",
          )
          .run("eeeeeeee-0000-4000-8000-000000000009", created.channel.id, INSTALLATION_TIME);
      expect(secondMain).toThrow();
      // The real constraint outcome: the roster is unchanged, exactly one main.
      const roster = db
        .prepare("SELECT role, COUNT(*) AS count FROM channel_participants WHERE channel_id = ? GROUP BY role")
        .all(created.channel.id) as Array<{ role: string; count: number }>;
      expect(roster).toEqual([{ role: "main", count: 1 }]);
    } finally {
      db.close();
      f.close();
    }
  });

  it("submits exact inline bytes, freezes assignmentLate inside the insertion transaction, and replays the original outcome", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const assignment = unwrap(
      addAssignment(f.ports, {
        channelId: seed.channelId,
        assertion: mainAssertion(seed.main),
        participantId: seed.worker,
        label: "lint pass",
      }),
    );
    const text = "report body with é and CRLF\r\nlines";
    const submission = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, text),
        assignmentId: assignment.id,
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "key-original",
      }),
    );
    expect(submission.replayed).toBe(false);
    expect(submission.message.assignmentLate).toBe(false);
    expect(submission.message.processingRowVersion).toBe(1);
    const detail = unwrap(readChannelMessage(f.ports, seed.channelId, submission.message.id));
    expect(detail.body).toBe(text);
    expect(detail.bodyBytes).toBe(Buffer.byteLength(text, "utf8"));
    unwrap(
      closeAssignment(f.ports, {
        channelId: seed.channelId,
        assignmentId: assignment.id,
        assertion: mainAssertion(seed.main),
      }),
    );
    const late = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "second report"),
        assignmentId: assignment.id,
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    expect(late.message.assignmentLate).toBe(true);
    // The first handling changes live state; the retained receipt still replays
    // the original unhandled outcome before any live-state eligibility.
    unwrap(
      handleChannelMessage(f.ports, {
        channelId: seed.channelId,
        messageId: submission.message.id,
        assertion: mainAssertion(seed.main),
        expectedRowVersion: 1,
        note: "done",
      }),
    );
    const eventsBefore = eventCount(f.home);
    const replay = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, text),
        assignmentId: assignment.id,
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "key-original",
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.message.handled).toBe(false);
    expect(replay.message.processingRowVersion).toBe(1);
    expect(eventCount(f.home)).toBe(eventsBefore);
    const conflict = submitMessage(f.ports, {
      channelId: seed.channelId,
      senderParticipantId: seed.worker,
      kind: "report",
      accepted: accepted(f.ports, "changed body"),
      assignmentId: assignment.id,
      actor: projectActor("11111111-2222-4333-8444-555555555555"),
      idempotencyKey: "key-original",
    });
    expect(!conflict.ok && conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    f.close();
  });

  it("keeps the first handling decision immutable with the two explicit duplicate errors", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const submission = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.judge,
        kind: "question",
        accepted: accepted(f.ports, "should we proceed?"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    const first = unwrap(
      handleChannelMessage(f.ports, {
        channelId: seed.channelId,
        messageId: submission.message.id,
        assertion: userAssertion,
        expectedRowVersion: 1,
      }),
    );
    expect(first.message.handledByKind).toBe("user");
    expect(first.message.handleNote).toBeNull();
    const stale = handleChannelMessage(f.ports, {
      channelId: seed.channelId,
      messageId: submission.message.id,
      assertion: mainAssertion(seed.main),
      expectedRowVersion: 1,
      note: "second",
    });
    expect(!stale.ok && stale.error.code).toBe("ROW_VERSION_CONFLICT");
    const current = handleChannelMessage(f.ports, {
      channelId: seed.channelId,
      messageId: submission.message.id,
      assertion: mainAssertion(seed.main),
      expectedRowVersion: 2,
      note: "second",
    });
    expect(!current.ok && current.error.code).toBe("CHN_INVALID_INPUT");
    expect(!current.ok && current.error.message).toContain("first handling decision is immutable");
    f.close();
  });

  it("applies the M0 closed-Channel disposition per operation with zero-event no-ops", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const submissionBeforeClose = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.judge,
        kind: "question",
        accepted: accepted(f.ports, "pre-close question"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    const closed = unwrap(closeChannel(f.ports, { channelId: seed.channelId, assertion: mainAssertion(seed.main) }));
    expect(closed.state).toBe("closed");
    const eventsAtClose = eventCount(f.home);
    const submission = submitMessage(f.ports, {
      channelId: seed.channelId,
      senderParticipantId: seed.worker,
      kind: "report",
      accepted: accepted(f.ports, "late report"),
      actor: projectActor("11111111-2222-4333-8444-555555555555"),
    });
    expect(!submission.ok && submission.error.code).toBe("CHN_CLOSED");
    const registration = addParticipant(f.ports, {
      channelId: seed.channelId,
      assertion: mainAssertion(seed.main),
      role: "worker",
      handle: "late-worker",
    });
    expect(!registration.ok && registration.error.code).toBe("CHN_CLOSED");
    const assignment = unwrap(
      addAssignment(f.ports, { channelId: seed.channelId, assertion: userAssertion, label: "post-close" }),
    );
    const closedAssignment = unwrap(
      closeAssignment(f.ports, {
        channelId: seed.channelId,
        assignmentId: assignment.id,
        assertion: mainAssertion(seed.main),
      }),
    );
    expect(closedAssignment.state).toBe("closed");
    const deactivated = unwrap(
      deactivateParticipant(f.ports, {
        channelId: seed.channelId,
        participantId: seed.worker,
        assertion: mainAssertion(seed.main),
      }),
    );
    expect(deactivated.active).toBe(false);
    const mainDeactivation = deactivateParticipant(f.ports, {
      channelId: seed.channelId,
      participantId: seed.main,
      assertion: mainAssertion(seed.main),
    });
    expect(!mainDeactivation.ok && mainDeactivation.error.code).toBe("CHN_INVALID_INPUT");
    expect(eventCount(f.home)).toBe(eventsAtClose + 3);
    const beforeRepeats = eventCount(f.home);
    // The unchanged repeats keep first timestamps and provenance and append nothing.
    const firstClose = closed;
    const repeatClose = unwrap(
      closeChannel(f.ports, { channelId: seed.channelId, assertion: mainAssertion(seed.main) }),
    );
    expect(repeatClose.closedAt).toBe(firstClose.closedAt);
    expect(repeatClose.closedByKind).toBe(firstClose.closedByKind);
    const repeatDeactivate = unwrap(
      deactivateParticipant(f.ports, {
        channelId: seed.channelId,
        participantId: seed.worker,
        assertion: mainAssertion(seed.main),
      }),
    );
    expect(repeatDeactivate.deactivatedAt).toBe(deactivated.deactivatedAt);
    const repeatAssignmentClose = unwrap(
      closeAssignment(f.ports, {
        channelId: seed.channelId,
        assignmentId: assignment.id,
        assertion: mainAssertion(seed.main),
      }),
    );
    expect(repeatAssignmentClose.closedAt).toBe(closedAssignment.closedAt);
    expect(eventCount(f.home)).toBe(beforeRepeats);
    // Reads and continued processing stay available on the closed Channel.
    const shown = unwrap(showChannel(f.ports, seed.channelId));
    expect(shown.state).toBe("closed");
    const handledAfterClose = unwrap(
      handleChannelMessage(f.ports, {
        channelId: seed.channelId,
        messageId: submissionBeforeClose.message.id,
        assertion: mainAssertion(seed.main),
        expectedRowVersion: 1,
        note: "processed after close",
      }),
    );
    expect(handledAfterClose.message.handled).toBe(true);
    expect(unwrap(readChannelMessage(f.ports, seed.channelId, submissionBeforeClose.message.id)).body).toBe(
      "pre-close question",
    );
    f.close();
  });

  it("keeps waiting pending-inclusive without mutation and bounds the page", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const first = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "pending report"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    const page = unwrap(listChannelMessages(f.ports, seed.channelId, { handling: "unhandled" }));
    expect(page.items.map((item) => item.id)).toContain(first.message.id);
    expect(page.nextCursor).toBeNull();
    const handled = unwrap(
      handleChannelMessage(f.ports, {
        channelId: seed.channelId,
        messageId: first.message.id,
        assertion: mainAssertion(seed.main),
        expectedRowVersion: 1,
      }),
    );
    const afterHandle = unwrap(listChannelMessages(f.ports, seed.channelId, { handling: "unhandled" }));
    expect(afterHandle.items).toHaveLength(0);
    const all = unwrap(listChannelMessages(f.ports, seed.channelId, { handling: "all" }));
    expect(all.items.map((item) => item.id)).toEqual([handled.message.id]);
    f.close();
  });

  it("routes a large body through the Vault with exact bytes and an honest preview", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const large = `${"report line\n".repeat(6600)}tail-é`;
    const submission = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, large),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    expect(submission.message.bodyBytes).toBeGreaterThan(65_536);
    expect(submission.message.bodyPreviewTruncated).toBe(true);
    const detail = unwrap(readChannelMessage(f.ports, seed.channelId, submission.message.id));
    expect(detail.body).toBe(large);
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    try {
      const record = db
        .prepare(
          "SELECT inline_text, storage_key, materialized FROM content_records cr JOIN channel_messages m ON m.content_record_id = cr.id WHERE m.id = ?",
        )
        .get(submission.message.id) as { inline_text: string | null; storage_key: string; materialized: number };
      expect(record.inline_text).toBeNull();
      expect(record.storage_key.startsWith("content/channel/")).toBe(true);
      expect(record.materialized).toBe(1);
      expect(existsSync(join(f.home, "vault", record.storage_key))).toBe(true);
    } finally {
      db.close();
      f.close();
    }
  });

  it("protects live Channel content at the standalone-cleanup boundary and fails that boundary closed on a corrupt layout", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const inline = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "protected inline body"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    const large = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, `${"vault body\n".repeat(7000)}`),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    f.close();
    // The standalone cleanup protects both live records: nothing is deleted,
    // no unlink intent is scheduled, and the physical files stay.
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    const ledger = createSqliteEventLedger(db);
    const store = createSqliteContentStore({
      db,
      vaultPath: join(f.home, "vault"),
      installationId: f.ports.installationId,
      runDir: join(f.home, "run"),
      ledger,
    });
    try {
      const before = db.prepare("SELECT COUNT(*) AS count FROM content_records").get() as { count: number };
      const report = unwrap(store.cleanup(sqliteContentReferences(db), new Date()));
      expect(report.removedInlineIds).toHaveLength(0);
      expect(report.scheduledUnlinkIds).toHaveLength(0);
      const after = db.prepare("SELECT COUNT(*) AS count FROM content_records").get() as { count: number };
      expect(after.count).toBe(before.count);
      const vaultKey = (
        db
          .prepare(
            "SELECT storage_key FROM content_records WHERE id = (SELECT content_record_id FROM channel_messages WHERE id = ?)",
          )
          .get(large.message.id) as { storage_key: string }
      ).storage_key;
      expect(existsSync(join(f.home, "vault", vaultKey))).toBe(true);
      // A dangling reference on an otherwise normal schema-11 layout fails
      // every guard closed with no deletion and no physical GC fall-through.
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        "DELETE FROM content_records WHERE id = (SELECT content_record_id FROM channel_messages WHERE id = ?)",
      ).run(inline.message.id);
      db.exec("PRAGMA foreign_keys = ON");
      const guard = validateChannelContentLinks(db);
      expect(!guard.ok && guard.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      const refusedCleanup = store.cleanup(sqliteContentReferences(db), new Date());
      expect(!refusedCleanup.ok && refusedCleanup.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      // Enumeration is not the proof: cleanup must run the complete link guard first.
      const survivor = db.prepare("SELECT COUNT(*) AS count FROM content_records").get() as { count: number };
      expect(survivor.count).toBe(after.count - 1);
      expect(existsSync(join(f.home, "vault", vaultKey))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("refuses a system creator and narrows the public creator kinds", () => {
    const f = fixture();
    const refused = createChannel(f.ports, { creator: SYSTEM_ACTOR, mainHandle: "orchestrator", title: null });
    expect(!refused.ok && refused.error.code).toBe("CHN_INVALID_INPUT");
    const userCreated = unwrap(
      createChannel(f.ports, { creator: { kind: "user", id: null }, mainHandle: "orchestrator", title: null }),
    );
    expect(userCreated.channel.creatorKind).toBe("user");
    expect(userCreated.channel.creatorId).toBeNull();
    f.close();
  });

  it("fails a malformed stored submit receipt closed on the normal and read-only paths without executing", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const text = "receipt guarded body";
    const submission = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, text),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "key-corrupt",
      }),
    );
    f.close();
    const scope = `channel-submit:${f.ports.installationId}:${seed.channelId}`;
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    try {
      const stored = db
        .prepare("SELECT response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
        .get("key-corrupt", scope) as { response_json: string };
      const base = JSON.parse(stored.response_json) as { message: Record<string, unknown> };
      const cases: unknown[] = [
        { message: { ...base.message, body: "leaked full body" } },
        { message: { ...base.message, handled: true, processingRowVersion: 2 } },
        { message: Object.fromEntries(Object.entries(base.message).filter(([key]) => key !== "createdAt")) },
        { message: { ...base.message, channelId: "99999999-9999-4999-8999-999999999999" } },
        { message: { ...base.message, bodyBytes: "not-a-number" } },
        { message: { ...base.message, bodyBytes: 0 } },
        { message: { ...base.message, senderHandle: "" } },
        { message: { ...base.message, contextNode: "invalid\ncontext" } },
        { message: { ...base.message, contextAttempt: "x".repeat(201) } },
        { message: { ...base.message, assignmentId: null, assignmentLate: true } },
        { message: { ...base.message, bodyPreview: "changed-length" } },
        { message: { ...base.message, bodyPreview: String.fromCharCode(0xd800) } },
        { message: {} },
        { message: base.message, extra: 1 },
      ];
      for (const corrupted of cases) {
        db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
          JSON.stringify(corrupted),
          "key-corrupt",
          scope,
        );
        // The mutation path fails closed and never executes a fresh submission.
        const replayPorts = createNodeChannelPorts({
          env: { SORAGE_HOME: f.home },
          userHome: f.home,
          clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
        });
        try {
          const replay = submitMessage(replayPorts, {
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(replayPorts, text),
            actor: projectActor("11111111-2222-4333-8444-555555555555"),
            idempotencyKey: "key-corrupt",
          });
          expect(!replay.ok && replay.error.code).toBe("STORAGE_INTEGRITY_ERROR");
          if (replay.ok) throw new Error("expected refusal");
        } finally {
          replayPorts.close();
        }
        // The read-only inspection path fails closed identically, without
        // executing, creating, or mutating anything.
        const recovery = createNodeChannelRecoveryPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
        const inspected = submitMessageReplayOnly(recovery, {
          installationId: f.ports.installationId,
          maxBytes: 1024 * 1024 * 100,
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: {
            kind: "text",
            text,
            sizeBytes: Buffer.byteLength(text, "utf8"),
            sha256: createHash("sha256").update(text, "utf8").digest("hex"),
          },
          idempotencyKey: "key-corrupt",
        });
        expect(!inspected.ok && inspected.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      }
      // No fresh message was ever created by the refused replays.
      const count = db.prepare("SELECT COUNT(*) AS count FROM channel_messages").get() as { count: number };
      expect(count.count).toBe(1);
      expect(db.prepare("SELECT id FROM channel_messages").get()).toEqual({ id: submission.message.id });
      // A restored valid receipt replays normally again.
      db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
        stored.response_json,
        "key-corrupt",
        scope,
      );
      const validPorts = createNodeChannelPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
        clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
      });
      try {
        const valid = unwrap(
          submitMessage(validPorts, {
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(validPorts, text),
            actor: projectActor("11111111-2222-4333-8444-555555555555"),
            idempotencyKey: "key-corrupt",
          }),
        );
        expect(valid.replayed).toBe(true);
      } finally {
        validPorts.close();
      }
    } finally {
      db.close();
    }
  });

  it("rejects malformed original creation rosters without creating another Channel", () => {
    const f = fixture();
    const input = {
      creator: { kind: "user" as const, id: null },
      mainHandle: "main",
      title: "Original",
      idempotencyKey: "original-creation",
    };
    const original = unwrap(createChannel(f.ports, input));
    f.close();
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    const scope = `channel-create:${f.ports.installationId}`;
    try {
      const row = db
        .prepare("SELECT response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
        .get(input.idempotencyKey, scope) as { response_json: string };
      const base = JSON.parse(row.response_json) as {
        channel: { participants: Array<Record<string, unknown>>; [key: string]: unknown };
      };
      const participant = base.channel.participants[0];
      if (!participant) throw new Error("missing initial main fixture");
      const cases = [
        { ...base.channel, mainParticipantId: randomUUID() },
        {
          ...base.channel,
          participantCount: 2,
          participants: [participant, { ...participant, id: randomUUID(), role: "worker" }],
        },
        { ...base.channel, participants: [{ ...participant, active: false, deactivatedAt: INSTALLATION_TIME }] },
        { ...base.channel, participants: [{ ...participant, nativeProvenance: ["invalid\nprovenance"] }] },
        { ...base.channel, title: " unnormalized " },
        { ...base.channel, creatorKind: "system" },
        { ...base.channel, updatedAt: "2026-10-21T00:00:00.000Z" },
        { ...base.channel, body: "unexpected full body" },
      ];
      const beforeEvents = db.prepare("SELECT id FROM events ORDER BY id").all();
      for (const channel of cases) {
        db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
          JSON.stringify({ channel }),
          input.idempotencyKey,
          scope,
        );
        const ports = createNodeChannelPorts({
          env: { SORAGE_HOME: f.home },
          userHome: f.home,
          clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
        });
        try {
          const replay = createChannel(ports, input);
          expect(!replay.ok && replay.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        } finally {
          ports.close();
        }
      }
      expect(db.prepare("SELECT id FROM channels").all()).toEqual([{ id: original.channel.id }]);
      expect(db.prepare("SELECT id FROM events ORDER BY id").all()).toEqual(beforeEvents);
      db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
        row.response_json,
        input.idempotencyKey,
        scope,
      );
      const ports = createNodeChannelPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
        clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
      });
      try {
        expect(unwrap(createChannel(ports, input))).toEqual({ ...original, replayed: true });
      } finally {
        ports.close();
      }
    } finally {
      db.close();
    }
  });

  it("refuses an all-whitespace spool body before any transaction and accepts leading whitespace beyond the head byte-exactly", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const before = eventCount(f.home);
    const blank = submitMessage(f.ports, {
      channelId: seed.channelId,
      senderParticipantId: seed.worker,
      kind: "report",
      accepted: accepted(f.ports, " ".repeat(70_000)),
      actor: projectActor("11111111-2222-4333-8444-555555555555"),
    });
    expect(!blank.ok && blank.error.code).toBe("CHN_INVALID_INPUT");
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    try {
      const count = db.prepare("SELECT COUNT(*) AS count FROM channel_messages").get() as { count: number };
      expect(count.count).toBe(0);
    } finally {
      db.close();
    }
    expect(eventCount(f.home)).toBe(before);
    // Leading whitespace beyond the preview head and the inline threshold
    // stays accepted when a nonblank scalar exists, with exact bytes kept.
    const paddedText = `${" \t".repeat(33_000)}x`;
    const padded = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, paddedText),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    expect(padded.message.bodyBytes).toBe(Buffer.byteLength(paddedText, "utf8"));
    expect(padded.message.bodyPreview).toBe(paddedText.slice(0, 512));
    expect(padded.message.bodyPreviewTruncated).toBe(true);
    const detail = unwrap(readChannelMessage(f.ports, seed.channelId, padded.message.id));
    expect(detail.body).toBe(paddedText);
    f.close();
  });

  it("applies the same nonblank proof on the replay-only seam over a spool original", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const recovery = createNodeChannelRecoveryPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
    const blankSpool = unwrap(
      captureChannelBodyText(" ".repeat(70_000), {
        maxBytes: f.ports.maxBytes,
        stateDir: f.ports.stateDir,
        spoolId: "replay-blank",
      }),
    );
    const refused = submitMessageReplayOnly(recovery, {
      installationId: f.ports.installationId,
      maxBytes: f.ports.maxBytes,
      channelId: seed.channelId,
      senderParticipantId: seed.worker,
      kind: "report",
      accepted: blankSpool,
      idempotencyKey: "key-blank",
    });
    expect(!refused.ok && refused.error.code).toBe("CHN_INVALID_INPUT");
    f.close();
  });

  it("bounds the list page inside the shared 1-to-200 validated upper bound", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const valid = listChannelMessages(f.ports, seed.channelId, { limit: 200 });
    expect(valid.ok).toBe(true);
    const tooLarge = listChannelMessages(f.ports, seed.channelId, { limit: 201 });
    expect(!tooLarge.ok && tooLarge.error.code).toBe("CHN_INVALID_INPUT");
    const unsafe = listChannelMessages(f.ports, seed.channelId, { limit: Number.MAX_SAFE_INTEGER + 1 });
    expect(!unsafe.ok && unsafe.error.code).toBe("CHN_INVALID_INPUT");
    f.close();
  });

  it("refuses the in-transaction removal, the Vault-verify census, the Doctor census, and the export read on a dangling Channel reference", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const submission = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "guarded body"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    f.close();
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    const ledger = createSqliteEventLedger(db);
    const store = createSqliteContentStore({
      db,
      vaultPath: join(f.home, "vault"),
      installationId: f.ports.installationId,
      runDir: join(f.home, "run"),
      ledger,
    });
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        "DELETE FROM content_records WHERE id = (SELECT content_record_id FROM channel_messages WHERE id = ?)",
      ).run(submission.message.id);
      db.exec("PRAGMA foreign_keys = ON");
      // The in-transaction removal refuses before any row change; the caller's
      // transaction aborts on this Result.
      const removal = store.removeContentRecordInTx(
        (
          db.prepare("SELECT content_record_id FROM channel_messages WHERE id = ?").get(submission.message.id) as {
            content_record_id: string;
          }
        ).content_record_id,
        { references: sqliteContentReferences(db), now: new Date() },
      );
      expect(!removal.ok && removal.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      // The Vault-verify census boundary fails the proof loudly.
      const verify = createNodeVaultCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).verifyPorts();
      expect(verify.ok).toBe(true);
      if (verify.ok) {
        const census = verify.value.recordedContent();
        expect(!census.ok && census.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      }
      // The Doctor census reports the broken links as a blocking finding.
      const doctor = createNodeDoctorPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
      const probe = doctor.probe("content.checksums");
      expect(probe.severity).toBe("blocking");
      // The consistent export read fails loudly instead of a reduced inventory.
      const exportPorts = createNodeBackupCommandPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
      }).exportPorts();
      expect(exportPorts.ok).toBe(true);
      if (exportPorts.ok) {
        const exported = exportPorts.value.readSnapshotData();
        expect(!exported.ok && exported.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      }
    } finally {
      db.close();
    }
  });

  it.each(["null-reference", "missing-table", "missing-column"] as const)(
    "refuses all five deletion and census boundaries on %s corruption without deleting bytes",
    (fault) => {
      const f = fixture();
      const seed = seedChannel(f.ports);
      const text = "retained vault body\n".repeat(4000);
      const submitted = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
        }),
      );
      f.close();
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      try {
        const record = db
          .prepare(
            "SELECT c.id, c.storage_key FROM content_records c JOIN channel_messages m ON m.content_record_id = c.id WHERE m.id = ?",
          )
          .get(submitted.message.id) as { id: string; storage_key: string };
        // Deliberately malformed storage is outside the valid producer schema.
        // Keeping content_record_id present but NULL exercises the actual join
        // guard rather than merely the producer's NOT NULL constraint.
        db.exec("PRAGMA foreign_keys = OFF; DROP TABLE channel_messages");
        if (fault === "null-reference") {
          db.exec("CREATE TABLE channel_messages (id TEXT PRIMARY KEY, content_record_id TEXT)");
          db.prepare("INSERT INTO channel_messages VALUES (?, NULL)").run(submitted.message.id);
        } else if (fault === "missing-column") {
          db.exec("CREATE TABLE channel_messages (id TEXT PRIMARY KEY)");
        }
        db.exec("PRAGMA foreign_keys = ON");
        const store = createSqliteContentStore({
          db,
          vaultPath: join(f.home, "vault"),
          installationId: f.ports.installationId,
          runDir: join(f.home, "run"),
          ledger: createSqliteEventLedger(db),
        });
        const before = db.prepare("SELECT id, materialized FROM content_records ORDER BY id").all();
        const beforeEvents = db.prepare("SELECT id FROM events ORDER BY id").all();
        const beforeIntents = db.prepare("SELECT id FROM pending_fs_ops ORDER BY id").all();
        const cleanup = store.cleanup(sqliteContentReferences(db), new Date());
        expect(!cleanup.ok && cleanup.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        db.exec("BEGIN IMMEDIATE");
        try {
          store.insertContentRecord({
            id: randomUUID(),
            inlineText: "rollback sentinel",
            storageKey: null,
            sizeBytes: 17,
            sha256: createHash("sha256").update("rollback sentinel").digest("hex"),
            materialized: true,
            createdAt: INSTALLATION_TIME,
          });
          const removal = store.removeContentRecordInTx(record.id, {
            references: sqliteContentReferences(db),
            now: new Date(),
          });
          expect(!removal.ok && removal.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        } finally {
          db.exec("ROLLBACK");
        }
        const vault = unwrap(
          createNodeVaultCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).verifyPorts(),
        );
        const census = vault.recordedContent();
        expect(!census.ok && census.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        expect(
          createNodeDoctorPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).probe("content.checksums").severity,
        ).toBe("blocking");
        const exported = unwrap(
          createNodeBackupCommandPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }).exportPorts(),
        ).readSnapshotData();
        expect(!exported.ok && exported.error.code).toBe("STORAGE_INTEGRITY_ERROR");
        expect(db.prepare("SELECT id, materialized FROM content_records ORDER BY id").all()).toEqual(before);
        expect(db.prepare("SELECT id FROM events ORDER BY id").all()).toEqual(beforeEvents);
        expect(db.prepare("SELECT id FROM pending_fs_ops ORDER BY id").all()).toEqual(beforeIntents);
        expect(readFileSync(join(f.home, "vault", record.storage_key), "utf8")).toBe(text);
      } finally {
        db.close();
      }
    },
  );

  it("restarts a whole message page after a concurrent handling commit and refuses perpetual external churn", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const submitted = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "coherent body"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    const other = createNodeChannelPorts({
      env: { SORAGE_HOME: f.home },
      userHome: f.home,
      clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
    });
    const read = f.ports.bodies.readRecordPreviewSeed;
    let changed = false;
    try {
      f.ports.bodies.readRecordPreviewSeed = (ref, binding) => {
        const result = read(ref, binding);
        if (!changed) {
          changed = true;
          unwrap(
            handleChannelMessage(other, {
              channelId: seed.channelId,
              messageId: submitted.message.id,
              assertion: mainAssertion(seed.main),
              expectedRowVersion: 1,
              note: "concurrent handling",
            }),
          );
        }
        return result;
      };
      const page = unwrap(listChannelMessages(f.ports, seed.channelId, { handling: "all" }));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.handled).toBe(true);
      expect(page.items[0]?.handleNote).toBe("concurrent handling");
      f.ports.bodies.readRecordPreviewSeed = (ref, binding) => {
        const result = read(ref, binding);
        unwrap(createChannel(other, { creator: { kind: "user", id: null }, mainHandle: "other-main", title: null }));
        return result;
      };
      const refused = listChannelMessages(f.ports, seed.channelId, { handling: "all" });
      expect(!refused.ok && refused.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    } finally {
      other.close();
      f.close();
    }
  });

  it("keeps the migration plan's ordinary 11 behind the guarded batch and reapplies idempotently", () => {
    const temp = makeTempDatabase();
    cleanups.push(temp.cleanup);
    const plan = productionMigrationPlan();
    const outcome = migrate(temp.db, plan.migrations, () => "2026-01-01T00:00:00.000Z", {
      databasePath: temp.databasePath,
      rebuilds: plan.rebuilds,
    });
    expect(outcome.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const again = migrate(temp.db, plan.migrations, () => "2026-01-02T00:00:00.000Z", {
      databasePath: temp.databasePath,
      rebuilds: plan.rebuilds,
    });
    expect(again.alreadyUpToDate).toBe(true);
    const raw = openSorageDatabase(temp.databasePath);
    try {
      const versions = (
        raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>
      ).map((row) => row.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      const violations = raw.prepare("PRAGMA foreign_key_check").all();
      expect(violations).toHaveLength(0);
    } finally {
      raw.close();
    }
  });

  it("aborts a Channel event row that carries a foreign association", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      const insert = (): unknown =>
        db
          .prepare(
            "INSERT INTO events (id, memo_id, event_type, actor_kind, actor_id, row_version, metadata_json, created_at) VALUES (?, ?, 'CHANNEL_CREATED', 'user', NULL, NULL, ?, ?)",
          )
          .run(
            "ffffffff-0000-4000-8000-00000000000f",
            "abcdefab-0000-4000-8000-00000000000a",
            JSON.stringify({ channelId: seed.channelId, mainParticipantId: seed.main }),
            INSTALLATION_TIME,
          );
      expect(insert).toThrow();
      const rows = db
        .prepare("SELECT COUNT(*) AS count FROM events WHERE id = 'ffffffff-0000-4000-8000-00000000000f'")
        .get() as { count: number };
      expect(rows.count).toBe(0);
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
      db.close();
      f.close();
    }
  });

  it("refuses a live fence, retains a post-commit activation pause, and converges after restart without redispatch", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const lockPath = join(f.home, "run", "vault-move.lock");
    const placeLock = () => {
      mkdirSync(join(f.home, "run"), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: INSTALLATION_TIME, hostname: "test" }));
    };
    let closed = false;
    try {
      const before = eventCount(f.home);
      placeLock();
      const fenced = submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "fenced body"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      });
      expect(!fenced.ok && fenced.error.code).toBe("SERVICE_PAUSED");
      expect(eventCount(f.home)).toBe(before);
      rmSync(lockPath);
      // Let the actual domain transaction commit before a live move lock wins
      // the native post-commit activation gate. No storage primitive is stubbed.
      const activate = f.ports.staging.activateContent;
      f.ports.staging.activateContent = (input, binding) => {
        placeLock();
        return activate(input, binding);
      };
      const warnings = captureWarnings(f.ports);
      const text = "vault body\n".repeat(7000);
      const paused = submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, text),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "paused-submission",
      });
      expect(paused.ok).toBe(true);
      if (!paused.ok) return;
      expect(paused.value.contentActivating).toBe(true);
      expect(warnings).toEqual([
        "the Channel message committed but its content activation paused behind a held Vault-move lock; the pending intent remains for the next process start",
      ]);
      const pausedMessageId = paused.value.message.id;
      f.close();
      closed = true;
      rmSync(lockPath);
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      let messageId: string;
      try {
        const row = db
          .prepare(
            "SELECT m.id, c.materialized FROM channel_messages m JOIN content_records c ON c.id = m.content_record_id WHERE m.channel_id = ?",
          )
          .get(seed.channelId) as { id: string; materialized: number };
        messageId = row.id;
        expect(messageId).toBe(pausedMessageId);
        expect(row.materialized).toBe(0);
        expect(db.prepare("SELECT id FROM pending_fs_ops WHERE owner_domain = 'channel'").all()).toHaveLength(1);
        const log = createSqliteIntentLog({
          db,
          installationId: f.ports.installationId,
          events: createSqliteEventLedger(db),
        });
        expect(unwrap(log.drain(join(f.home, "vault"))).resolved).toHaveLength(1);
        expect(unwrap(log.drain(join(f.home, "vault"))).resolved).toHaveLength(0);
        expect(db.prepare("SELECT id FROM pending_fs_ops WHERE owner_domain = 'channel'").all()).toHaveLength(0);
        expect(db.prepare("SELECT id FROM events WHERE event_type = 'CONTENT_ACTIVATED'").all()).toHaveLength(1);
      } finally {
        db.close();
      }
      const restarted = createNodeChannelPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
        clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
      });
      try {
        const detail = unwrap(readChannelMessage(restarted, seed.channelId, messageId));
        expect(detail.body).toBe(text);
        expect(detail.handled).toBe(false);
        const replay = unwrap(
          submitMessage(restarted, {
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(restarted, text),
            actor: projectActor("11111111-2222-4333-8444-555555555555"),
            idempotencyKey: "paused-submission",
          }),
        );
        expect(replay.replayed).toBe(true);
        expect(replay.message.id).toBe(messageId);
        expect(replay.contentActivating).toBe(false);
        expect(eventCount(f.home)).toBe(before + 1);
      } finally {
        restarted.close();
      }
    } finally {
      rmSync(lockPath, { force: true });
      if (!closed) f.close();
    }
  });

  it("reports a committed failed activation honestly and converges after repairing the owned destination conflict", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    let closed = false;
    try {
      // The bounded wrapper injects real owned conflicting bytes at the exact
      // managed destination after the SQL commit and before the production
      // activation runs; the shared executor then commits its destination-
      // conflict failure assessment and the submission reports honestly.
      const activate = f.ports.staging.activateContent;
      f.ports.staging.activateContent = (input, binding) => {
        const destination = join(f.home, "vault", input.storageKey);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, "conflicting bytes");
        return activate(input, binding);
      };
      const warnings = captureWarnings(f.ports);
      const text = "conflicted vault body\n".repeat(7000);
      const failed = submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, text),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "conflicted-submission",
      });
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(failed.value.contentActivating).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("its content activation failed");
      expect(warnings[0]).toContain("destination_conflict");
      expect(warnings[0]).toContain("the pending intent remains for the next process start");
      f.close();
      closed = true;
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      let messageId: string;
      let storageKey: string;
      try {
        const row = db
          .prepare(
            "SELECT m.id AS id, c.storage_key AS storage_key, c.materialized FROM channel_messages m JOIN content_records c ON c.id = m.content_record_id WHERE m.channel_id = ?",
          )
          .get(seed.channelId) as { id: string; storage_key: string; materialized: number };
        messageId = row.id;
        storageKey = row.storage_key;
        // The authoritative commit survives: one message, one retained receipt,
        // the intent retained, and the record still unmaterialized.
        expect(row.materialized).toBe(0);
        expect(db.prepare("SELECT id FROM pending_fs_ops WHERE owner_domain = 'channel'").all()).toHaveLength(1);
        expect(db.prepare("SELECT key FROM idempotency_keys WHERE key = 'conflicted-submission'").all()).toHaveLength(
          1,
        );
        // Exactly one metadata-only failure event with the closed reason; no
        // fabricated success activation.
        const failures = db
          .prepare("SELECT metadata_json FROM events WHERE event_type = 'CONTENT_INTEGRITY_FAILED'")
          .all() as Array<{ metadata_json: string }>;
        expect(failures).toHaveLength(1);
        const metadata = JSON.parse(failures[0]?.metadata_json ?? "{}") as {
          ownerDomain: string;
          reason: string;
        };
        expect(metadata.ownerDomain).toBe("channel");
        expect(metadata.reason).toBe("destination_conflict");
        expect(db.prepare("SELECT id FROM events WHERE event_type = 'CONTENT_ACTIVATED'").all()).toHaveLength(0);
        // Repair the owned conflict and converge through the shared drain: the
        // exact original staged bytes land at the managed key, exactly one
        // activation lands, and nothing redispatches.
        rmSync(join(f.home, "vault", storageKey), { force: true });
        const log = createSqliteIntentLog({
          db,
          installationId: f.ports.installationId,
          events: createSqliteEventLedger(db),
        });
        expect(unwrap(log.drain(join(f.home, "vault"))).resolved).toHaveLength(1);
        expect(db.prepare("SELECT id FROM pending_fs_ops WHERE owner_domain = 'channel'").all()).toHaveLength(0);
        expect(db.prepare("SELECT id FROM events WHERE event_type = 'CONTENT_ACTIVATED'").all()).toHaveLength(1);
        expect(
          db.prepare("SELECT materialized FROM content_records WHERE storage_key = ?").get(storageKey),
        ).toMatchObject({
          materialized: 1,
        });
        expect(readFileSync(join(f.home, "vault", storageKey), "utf8")).toBe(text);
      } finally {
        db.close();
      }
      const restarted = createNodeChannelPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
        clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
      });
      try {
        const detail = unwrap(readChannelMessage(restarted, seed.channelId, messageId));
        expect(detail.body).toBe(text);
        expect(detail.handled).toBe(false);
        const replay = unwrap(
          submitMessage(restarted, {
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(restarted, text),
            actor: projectActor("11111111-2222-4333-8444-555555555555"),
            idempotencyKey: "conflicted-submission",
          }),
        );
        expect(replay.replayed).toBe(true);
        expect(replay.message.id).toBe(messageId);
        expect(replay.contentActivating).toBe(false);
        const recovery = createNodeChannelRecoveryPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
        const inspected = unwrap(
          submitMessageReplayOnly(recovery, {
            installationId: restarted.installationId,
            maxBytes: restarted.maxBytes,
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(restarted, text),
            idempotencyKey: "conflicted-submission",
          }),
        );
        expect(inspected.message.id).toBe(messageId);
        expect(inspected.contentActivating).toBe(false);
      } finally {
        restarted.close();
      }
    } finally {
      if (!closed) f.close();
    }
  });

  it("refuses a hash-matching submit receipt that contradicts the original request on both surfaces without any fresh effect", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const text = "c1 guarded body";
    const submission = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, text),
        contextSession: "orig-session",
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "c1-key",
      }),
    );
    const large = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.judge,
        kind: "report",
        accepted: accepted(f.ports, `${"c1 large body\n".repeat(7000)}`),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "c1-large-key",
      }),
    );
    expect(large.message.bodyPreviewTruncated).toBe(true);
    // Historical state moves on; the retained receipt must still be this
    // request's original outcome.
    unwrap(
      handleChannelMessage(f.ports, {
        channelId: seed.channelId,
        messageId: submission.message.id,
        assertion: mainAssertion(seed.main),
        expectedRowVersion: 1,
        note: "done",
      }),
    );
    unwrap(closeChannel(f.ports, { channelId: seed.channelId, assertion: mainAssertion(seed.main) }));
    const scope = `channel-submit:${f.ports.installationId}:${seed.channelId}`;
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    try {
      const stored = db
        .prepare("SELECT response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
        .get("c1-key", scope) as { response_json: string };
      const base = JSON.parse(stored.response_json) as { message: Record<string, unknown> };
      const tampered = (mutate: (message: Record<string, unknown>) => void): string => {
        const copy = JSON.parse(JSON.stringify(base.message)) as Record<string, unknown>;
        mutate(copy);
        return JSON.stringify({ message: copy });
      };
      const cases: Array<{ name: string; json: string }> = [
        {
          name: "same-Channel sender swap",
          json: tampered((m) => {
            m.senderParticipantId = seed.judge;
            m.senderHandle = "judge-x";
          }),
        },
        {
          name: "valid kind swap",
          json: tampered((m) => {
            m.kind = "question";
          }),
        },
        {
          name: "invented assignment",
          json: tampered((m) => {
            m.assignmentId = "abcdef01-2345-4378-8abc-def012345678";
          }),
        },
        {
          name: "context text swap",
          json: tampered((m) => {
            m.contextSession = "tampered";
          }),
        },
        {
          name: "null-to-empty context",
          json: tampered((m) => {
            m.contextNode = "";
          }),
        },
        {
          name: "body byte count",
          json: tampered((m) => {
            m.bodyBytes = 99;
          }),
        },
      ];
      const expiresBefore = (
        db.prepare("SELECT expires_at FROM idempotency_keys WHERE key = 'c1-key' AND scope = ?").get(scope) as {
          expires_at: string;
        }
      ).expires_at;
      const effectsBefore = {
        messages: db.prepare("SELECT * FROM channel_messages ORDER BY id").all(),
        events: db.prepare("SELECT * FROM events ORDER BY id").all(),
      };
      for (const corruption of cases) {
        db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
          corruption.json,
          "c1-key",
          scope,
        );
        const replayPorts = createNodeChannelPorts({
          env: { SORAGE_HOME: f.home },
          userHome: f.home,
          clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
        });
        try {
          const replay = submitMessage(replayPorts, {
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(replayPorts, text),
            contextSession: "orig-session",
            actor: projectActor("11111111-2222-4333-8444-555555555555"),
            idempotencyKey: "c1-key",
          });
          expect(!replay.ok && replay.error.code, corruption.name).toBe("STORAGE_INTEGRITY_ERROR");
        } finally {
          replayPorts.close();
        }
        const recovery = createNodeChannelRecoveryPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
        const inspected = submitMessageReplayOnly(recovery, {
          installationId: f.ports.installationId,
          maxBytes: f.ports.maxBytes,
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: {
            kind: "text",
            text,
            sizeBytes: Buffer.byteLength(text, "utf8"),
            sha256: createHash("sha256").update(text, "utf8").digest("hex"),
          },
          contextSession: "orig-session",
          idempotencyKey: "c1-key",
        });
        expect(!inspected.ok && inspected.error.code, corruption.name).toBe("STORAGE_INTEGRITY_ERROR");
        // No fresh row, event, or receipt-expiry mutation ever happened.
        expect(db.prepare("SELECT * FROM channel_messages ORDER BY id").all()).toEqual(effectsBefore.messages);
        expect(db.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(effectsBefore.events);
        expect(
          (
            db.prepare("SELECT expires_at FROM idempotency_keys WHERE key = 'c1-key' AND scope = ?").get(scope) as {
              expires_at: string;
            }
          ).expires_at,
        ).toBe(expiresBefore);
      }
      // A shape-consistent preview tamper on a truncated receipt is caught by
      // the once-prepared preview comparison on the normal surface.
      const largeRow = db
        .prepare("SELECT response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
        .get("c1-large-key", `channel-submit:${f.ports.installationId}:${seed.channelId}`) as { response_json: string };
      const largeBase = JSON.parse(largeRow.response_json) as { message: Record<string, unknown> };
      const previewTampered = JSON.parse(JSON.stringify(largeBase)) as typeof largeBase;
      (previewTampered.message as Record<string, unknown>).bodyPreview = `X${large.message.bodyPreview.slice(1)}`;
      db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
        JSON.stringify(previewTampered),
        "c1-large-key",
        `channel-submit:${f.ports.installationId}:${seed.channelId}`,
      );
      const largeAccepted = accepted(f.ports, `${"c1 large body\n".repeat(7000)}`);
      const normalLarge = submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.judge,
        kind: "report",
        accepted: largeAccepted,
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "c1-large-key",
      });
      expect(!normalLarge.ok && normalLarge.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      const readonlyLarge = submitMessageReplayOnly(
        createNodeChannelRecoveryPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home }),
        {
          installationId: f.ports.installationId,
          maxBytes: f.ports.maxBytes,
          channelId: seed.channelId,
          senderParticipantId: seed.judge,
          kind: "report",
          accepted: largeAccepted,
          idempotencyKey: "c1-large-key",
        },
      );
      expect(!readonlyLarge.ok && readonlyLarge.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      expect(db.prepare("SELECT * FROM channel_messages ORDER BY id").all()).toEqual(effectsBefore.messages);
      expect(db.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(effectsBefore.events);
      db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
        stored.response_json,
        "c1-key",
        scope,
      );
      db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
        largeRow.response_json,
        "c1-large-key",
        `channel-submit:${f.ports.installationId}:${seed.channelId}`,
      );
      // The honest original input still replays the retained outcome, and a
      // genuinely different request still conflicts.
      const honest = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          contextSession: "orig-session",
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "c1-key",
        }),
      );
      expect(honest.replayed).toBe(true);
      expect(honest.message.handled).toBe(false);
      const changed = submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "changed c1 body"),
        contextSession: "orig-session",
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
        idempotencyKey: "c1-key",
      });
      expect(!changed.ok && changed.error.code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      db.close();
      f.close();
    }
  });

  it("refuses a hash-matching creation receipt that contradicts the request or invents the creation main's provenance", () => {
    const f = fixture();
    const created = unwrap(
      createChannel(f.ports, {
        creator: projectActor("11111111-2222-4333-8444-555555555555"),
        mainHandle: "orig-main",
        title: "Original",
        idempotencyKey: "c1-create-key",
      }),
    );
    const scope = `channel-create:${f.ports.installationId}`;
    const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    try {
      const stored = db
        .prepare("SELECT response_json FROM idempotency_keys WHERE key = ? AND scope = ?")
        .get("c1-create-key", scope) as { response_json: string };
      const base = JSON.parse(stored.response_json) as {
        channel: Record<string, unknown> & { participants: Array<Record<string, unknown>> };
      };
      const tampered = (mutate: (channel: typeof base.channel) => void): string => {
        const copy = JSON.parse(JSON.stringify(base.channel)) as typeof base.channel;
        mutate(copy);
        return JSON.stringify({ channel: copy });
      };
      const cases: Array<{ name: string; json: string }> = [
        {
          name: "title swap",
          json: tampered((c) => {
            c.title = "Other";
          }),
        },
        {
          name: "main handle swap",
          json: tampered((c) => {
            (c.participants[0] as Record<string, unknown>).handle = "other-main";
          }),
        },
        {
          name: "creator id swap",
          json: tampered((c) => {
            c.creatorId = "22222222-3333-4333-8444-555555555555";
          }),
        },
        {
          name: "invented creation main native",
          json: tampered((c) => {
            (c.participants[0] as Record<string, unknown>).nativeProvenance = [""];
          }),
        },
      ];
      for (const corruption of cases) {
        db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
          corruption.json,
          "c1-create-key",
          scope,
        );
        const replayPorts = createNodeChannelPorts({
          env: { SORAGE_HOME: f.home },
          userHome: f.home,
          clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
        });
        try {
          const replay = createChannel(replayPorts, {
            creator: projectActor("11111111-2222-4333-8444-555555555555"),
            mainHandle: "orig-main",
            title: "Original",
            idempotencyKey: "c1-create-key",
          });
          expect(!replay.ok && replay.error.code, corruption.name).toBe("STORAGE_INTEGRITY_ERROR");
          // No second Channel was ever created.
          expect((db.prepare("SELECT COUNT(*) AS count FROM channels").get() as { count: number }).count).toBe(1);
        } finally {
          replayPorts.close();
        }
      }
      db.prepare("UPDATE idempotency_keys SET response_json = ? WHERE key = ? AND scope = ?").run(
        stored.response_json,
        "c1-create-key",
        scope,
      );
      const honestPorts = createNodeChannelPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
        clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
      });
      try {
        const honest = unwrap(
          createChannel(honestPorts, {
            creator: projectActor("11111111-2222-4333-8444-555555555555"),
            mainHandle: "orig-main",
            title: "Original",
            idempotencyKey: "c1-create-key",
          }),
        );
        expect(honest.replayed).toBe(true);
        expect(honest.channel.id).toBe(created.channel.id);
        const changed = createChannel(honestPorts, {
          creator: projectActor("11111111-2222-4333-8444-555555555555"),
          mainHandle: "orig-main",
          title: "Changed",
          idempotencyKey: "c1-create-key",
        });
        expect(!changed.ok && changed.error.code).toBe("IDEMPOTENCY_CONFLICT");
      } finally {
        honestPorts.close();
      }
    } finally {
      db.close();
      f.close();
    }
  });

  it("registers whitespace-only and BOM-only handles byte-exactly as distinct nonempty identities", () => {
    const f = fixture();
    const created = unwrap(
      createChannel(f.ports, {
        creator: projectActor("11111111-2222-4333-8444-555555555555"),
        mainHandle: "orchestrator",
        title: null,
      }),
    );
    const assertion = mainAssertion(created.channel.mainParticipantId);
    const space = unwrap(
      addParticipant(f.ports, { channelId: created.channel.id, assertion, role: "worker", handle: " " }),
    );
    expect(space.handle).toBe(" ");
    const bom = unwrap(
      addParticipant(f.ports, { channelId: created.channel.id, assertion, role: "worker", handle: "\uFEFF" }),
    );
    expect(bom.handle).toBe("\uFEFF");
    const duplicateSpace = addParticipant(f.ports, {
      channelId: created.channel.id,
      assertion,
      role: "worker",
      handle: " ",
    });
    expect(!duplicateSpace.ok && duplicateSpace.error.code).toBe("CHN_INVALID_INPUT");
    const shown = unwrap(showChannel(f.ports, created.channel.id));
    expect(shown.participants.map((participant) => participant.handle)).toContain(" ");
    expect(shown.participants.map((participant) => participant.handle)).toContain("\uFEFF");
    f.close();
  });

  it("waits pending-inclusive without mutation: immediate on pending, arrival between polls, and honest timeout", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    let sleeps = 0;
    const sleepMs = (_ms: number): void => {
      sleeps += 1;
    };
    // No unhandled message: the wait times out with an empty list and the
    // shared timedOut flag, without a single poll sleep.
    const timedOut = unwrap(
      waitForChannelMessages(f.ports, seed.channelId, {}, { intervalSeconds: 1, timeoutSeconds: 0, sleepMs }),
    );
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.messages).toHaveLength(0);
    expect(sleeps).toBe(0);
    // An already-unhandled message returns immediately, again without sleeping.
    const first = unwrap(
      submitMessage(f.ports, {
        channelId: seed.channelId,
        senderParticipantId: seed.worker,
        kind: "report",
        accepted: accepted(f.ports, "pending report"),
        actor: projectActor("11111111-2222-4333-8444-555555555555"),
      }),
    );
    const immediate = unwrap(
      waitForChannelMessages(f.ports, seed.channelId, {}, { intervalSeconds: 1, timeoutSeconds: 30, sleepMs }),
    );
    expect(immediate.timedOut).toBe(false);
    expect(immediate.messages.map((message) => message.id)).toEqual([first.message.id]);
    expect(sleeps).toBe(0);
    // A new arrival between polls: the controlled sleep hook is the producer's
    // explicit separate write, and the wait returns the bounded page without
    // handling, acknowledging, or appending anything.
    unwrap(
      handleChannelMessage(f.ports, {
        channelId: seed.channelId,
        messageId: first.message.id,
        assertion: mainAssertion(seed.main),
        expectedRowVersion: 1,
      }),
    );
    const eventsBefore = eventCount(f.home);
    const producingSleep = (_ms: number): void => {
      sleeps += 1;
      unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "question",
          accepted: accepted(f.ports, "arriving question"),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
        }),
      );
    };
    const arrival = unwrap(
      waitForChannelMessages(
        f.ports,
        seed.channelId,
        {},
        { intervalSeconds: 1, timeoutSeconds: 30, sleepMs: producingSleep },
      ),
    );
    expect(arrival.timedOut).toBe(false);
    expect(arrival.messages).toHaveLength(1);
    expect(arrival.messages[0]?.kind).toBe("question");
    expect(arrival.messages[0]?.handled).toBe(false);
    // The wait itself read only: the producer's submission is the sole new event.
    expect(eventCount(f.home)).toBe(eventsBefore + 1);
    // A closed Channel's still-unhandled messages drain identically.
    unwrap(closeChannel(f.ports, { channelId: seed.channelId, assertion: mainAssertion(seed.main) }));
    const closedWait = unwrap(
      waitForChannelMessages(f.ports, seed.channelId, {}, { intervalSeconds: 1, timeoutSeconds: 5, sleepMs }),
    );
    expect(closedWait.timedOut).toBe(false);
    expect(closedWait.messages[0]?.handled).toBe(false);
    unwrap(
      handleChannelMessage(f.ports, {
        channelId: seed.channelId,
        messageId: closedWait.messages[0]?.id,
        assertion: mainAssertion(seed.main),
        expectedRowVersion: 1,
      }),
    );
    const beforeTimeout = unwrap(listChannelMessages(f.ports, seed.channelId, { handling: "all" }));
    const eventsAtTimeout = eventCount(f.home);
    let now = Date.now();
    const time = vi.spyOn(Date, "now").mockImplementation(() => now);
    const intervals: number[] = [];
    try {
      const expired = unwrap(
        waitForChannelMessages(
          f.ports,
          seed.channelId,
          {},
          {
            intervalSeconds: 2,
            timeoutSeconds: 3,
            sleepMs: (ms) => {
              intervals.push(ms);
              now += ms;
            },
          },
        ),
      );
      expect(expired).toEqual({ timedOut: true, messages: [], nextCursor: null });
      expect(intervals).toEqual([2000, 1000]);
    } finally {
      time.mockRestore();
    }
    expect(eventCount(f.home)).toBe(eventsAtTimeout);
    expect(unwrap(listChannelMessages(f.ports, seed.channelId, { handling: "all" }))).toEqual(beforeTimeout);
    f.close();
  });

  it("pages same-timestamp ties exactly once and binds cursors to their full scope", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const assignment = unwrap(
      addAssignment(f.ports, { channelId: seed.channelId, assertion: mainAssertion(seed.main), label: "scope filter" }),
    );
    const submitted: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const message = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: index % 2 === 0 ? seed.worker : seed.judge,
          kind: "report",
          accepted: accepted(f.ports, `tie body ${String(index)}`),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
        }),
      );
      submitted.push(message.message.id);
    }
    const channelIds = [seed.channelId];
    for (let index = 0; index < 4; index += 1) {
      channelIds.push(
        unwrap(
          createChannel(f.ports, {
            creator: { kind: "user", id: null },
            mainHandle: `other-main-${index}`,
            title: null,
          }),
        ).channel.id,
      );
    }
    const invalid = (result: ReturnType<typeof listChannels> | ReturnType<typeof listChannelMessages>) =>
      expect(!result.ok && result.error.code).toBe("CURSOR_INVALID");
    const seen: string[] = [];
    let cursor: string | undefined;
    let messagePages = 0;
    for (;;) {
      const page = unwrap(listChannelMessages(f.ports, seed.channelId, { handling: "all", limit: 2, cursor }));
      messagePages += 1;
      seen.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(messagePages).toBe(3);
    expect(seen).toEqual([...submitted].sort().reverse());
    expect(new Set(seen).size).toBe(5);
    const messageCursor = unwrap(
      listChannelMessages(f.ports, seed.channelId, { handling: "all", limit: 2 }),
    ).nextCursor;
    if (messageCursor === null) throw new Error("expected a continuation cursor for five messages");
    invalid(listChannelMessages(f.ports, seed.channelId, { handling: "unhandled", limit: 2, cursor: messageCursor }));
    invalid(listChannelMessages(f.ports, seed.channelId, { handling: "all", limit: 1, cursor: messageCursor }));
    invalid(listChannelMessages(f.ports, channelIds[1], { handling: "all", limit: 2, cursor: messageCursor }));
    invalid(
      listChannelMessages(f.ports, seed.channelId, {
        handling: "all",
        limit: 2,
        cursor: messageCursor,
        kind: "report",
      }),
    );
    invalid(
      listChannelMessages(f.ports, seed.channelId, {
        handling: "all",
        limit: 2,
        cursor: messageCursor,
        participantId: seed.worker,
      }),
    );
    invalid(
      listChannelMessages(f.ports, seed.channelId, {
        handling: "all",
        limit: 2,
        cursor: messageCursor,
        assignmentId: assignment.id,
      }),
    );
    const channelsSeen: string[] = [];
    let channelCursor: string | undefined;
    let channelPages = 0;
    for (;;) {
      const page = unwrap(listChannels(f.ports, { limit: 2, cursor: channelCursor }));
      channelPages += 1;
      channelsSeen.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      channelCursor = page.nextCursor;
    }
    expect(channelPages).toBe(3);
    expect(channelsSeen).toEqual([...channelIds].sort().reverse());
    expect(new Set(channelsSeen).size).toBe(5);
    const firstChannelCursor = unwrap(listChannels(f.ports, { limit: 2 })).nextCursor;
    if (firstChannelCursor === null) throw new Error("expected a continuation cursor for five Channels");
    invalid(listChannels(f.ports, { limit: 1, cursor: firstChannelCursor }));
    invalid(listChannels(f.ports, { state: "open", limit: 2, cursor: firstChannelCursor }));
    invalid(listChannels(f.ports, { limit: 2, cursor: messageCursor }));
    invalid(listChannelMessages(f.ports, seed.channelId, { handling: "all", limit: 2, cursor: firstChannelCursor }));
    const anotherInstallation = fixture();
    try {
      expect(anotherInstallation.ports.installationId).not.toBe(f.ports.installationId);
      invalid(listChannels(anotherInstallation.ports, { limit: 2, cursor: firstChannelCursor }));
      invalid(
        listChannelMessages(anotherInstallation.ports, seed.channelId, {
          handling: "all",
          limit: 2,
          cursor: messageCursor,
        }),
      );
    } finally {
      anotherInstallation.close();
      f.close();
    }
  });

  it("returns a committed handle decision with the unavailable-preview indicator on post-commit binding and preview failures", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    try {
      const first = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, "binding failure body"),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
        }),
      );
      const binding = f.ports.staging.freshBinding;
      let bindingCalls = 0;
      f.ports.staging.freshBinding = () => {
        bindingCalls += 1;
        if (bindingCalls > 1) return err(appError("CONFIG_INVALID", "injected post-commit binding failure"));
        return binding();
      };
      const handled = unwrap(
        handleChannelMessage(f.ports, {
          channelId: seed.channelId,
          messageId: first.message.id,
          assertion: mainAssertion(seed.main),
          expectedRowVersion: 1,
        }),
      );
      expect(handled.bodyPreviewUnavailable).toBe(true);
      expect(handled.message.bodyPreview).toBe("");
      expect(handled.message.bodyPreviewTruncated).toBe(false);
      expect(handled.message.handled).toBe(true);
      f.ports.staging.freshBinding = binding;

      const second = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, "preview failure body"),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
        }),
      );
      f.ports.bodies.readRecordPreviewSeed = () => err(appError("INTERNAL_ERROR", "injected preview failure"));
      const previewRefused = unwrap(
        handleChannelMessage(f.ports, {
          channelId: seed.channelId,
          messageId: second.message.id,
          assertion: userAssertion,
          expectedRowVersion: 1,
        }),
      );
      expect(previewRefused.bodyPreviewUnavailable).toBe(true);
      expect(previewRefused.message.bodyPreview).toBe("");
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      try {
        const rows = db
          .prepare("SELECT handled FROM channel_messages WHERE channel_id = ? ORDER BY created_at, id")
          .all(seed.channelId) as Array<{ handled: number }>;
        expect(rows.map((row) => row.handled)).toEqual([1, 1]);
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  });

  it("keeps a wait polling across an unmaterialized record and converges when activation completes", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const lockPath = join(f.home, "run", "vault-move.lock");
    const placeLock = () => {
      mkdirSync(join(f.home, "run"), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: INSTALLATION_TIME, hostname: "test" }));
    };
    let db: ReturnType<typeof openSorageDatabase> | undefined;
    let now = Date.now();
    const time = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const activate = f.ports.staging.activateContent;
      f.ports.staging.activateContent = (input, binding) => {
        placeLock();
        return activate(input, binding);
      };
      const text = "wait activation body\n".repeat(7000);
      const submitted = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "wait-activation",
        }),
      );
      expect(submitted.contentActivating).toBe(true);
      let sleeps = 0;
      const waited = unwrap(
        waitForChannelMessages(
          f.ports,
          seed.channelId,
          {},
          {
            intervalSeconds: 1,
            timeoutSeconds: 8,
            sleepMs: () => {
              sleeps += 1;
              now += 1_000;
              // The first poll must meet the unmaterialized record; the second
              // sleep repairs it and the next poll returns the arrival.
              if (sleeps === 2) {
                rmSync(lockPath, { force: true });
                db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
                const log = createSqliteIntentLog({
                  db,
                  installationId: f.ports.installationId,
                  events: createSqliteEventLedger(db),
                });
                expect(unwrap(log.drain(join(f.home, "vault"))).resolved).toHaveLength(1);
              }
            },
          },
        ),
      );
      expect(sleeps).toBe(2);
      expect(waited.timedOut).toBe(false);
      expect(waited.messages.map((message) => message.id)).toEqual([submitted.message.id]);
    } finally {
      time.mockRestore();
      db?.close();
      rmSync(lockPath, { force: true });
      f.close();
    }
  });

  it("reports a wait failure that persists at the deadline as its typed error", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const lockPath = join(f.home, "run", "vault-move.lock");
    let now = Date.now();
    const time = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const activate = f.ports.staging.activateContent;
      f.ports.staging.activateContent = (input, binding) => {
        mkdirSync(join(f.home, "run"), { recursive: true });
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: INSTALLATION_TIME, hostname: "test" }));
        return activate(input, binding);
      };
      const text = "persistent wait body\n".repeat(7000);
      const submitted = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
        }),
      );
      expect(submitted.contentActivating).toBe(true);
      let sleeps = 0;
      const waited = waitForChannelMessages(
        f.ports,
        seed.channelId,
        {},
        {
          intervalSeconds: 1,
          timeoutSeconds: 1,
          sleepMs: () => {
            sleeps += 1;
            now += 1_000;
          },
        },
      );
      expect(sleeps).toBe(1);
      expect(!waited.ok && waited.error.code).toBe("CONTENT_MATERIALIZING");
    } finally {
      time.mockRestore();
      rmSync(lockPath, { force: true });
      f.close();
    }
  });

  it("fails unknown participant and assignment filters immediately, with and without a wait", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    try {
      const unknown = randomUUID();
      const participant = listChannelMessages(f.ports, seed.channelId, { participantId: unknown });
      expect(!participant.ok && participant.error.code).toBe("CHN_PARTICIPANT_NOT_FOUND");
      const assignment = listChannelMessages(f.ports, seed.channelId, { assignmentId: unknown });
      expect(!assignment.ok && assignment.error.code).toBe("CHN_ASSIGNMENT_NOT_FOUND");
      const unknownChannel = listChannelMessages(f.ports, randomUUID(), {});
      expect(!unknownChannel.ok && unknownChannel.error.code).toBe("CHN_NOT_FOUND");
      for (const filter of [{ participantId: unknown }, { assignmentId: unknown }]) {
        let sleeps = 0;
        const waited = waitForChannelMessages(f.ports, seed.channelId, filter, {
          intervalSeconds: 1,
          timeoutSeconds: 30,
          sleepMs: () => {
            sleeps += 1;
          },
        });
        expect(sleeps).toBe(0);
        expect(!waited.ok && waited.error.code).toBe(
          "participantId" in filter ? "CHN_PARTICIPANT_NOT_FOUND" : "CHN_ASSIGNMENT_NOT_FOUND",
        );
      }
    } finally {
      f.close();
    }
  });

  it("retries a transient existence-stage failure through the wait and reports a persistent one", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    let now = Date.now();
    const time = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleepMs = (): void => {
      now += 1_000;
    };
    try {
      const inspect = f.ports.channels.inspect;
      let calls = 0;
      let sleeps = 0;
      f.ports.channels.inspect = (work) => {
        calls += 1;
        if (calls === 1) return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "injected existence failure"));
        return inspect(work);
      };
      const transient = waitForChannelMessages(
        f.ports,
        seed.channelId,
        { participantId: seed.worker },
        {
          intervalSeconds: 1,
          timeoutSeconds: 5,
          sleepMs: () => {
            sleeps += 1;
            sleepMs();
          },
        },
      );
      expect(sleeps).toBe(5);
      expect(transient.ok && transient.value.timedOut).toBe(true);
      f.ports.channels.inspect = () => err(appError("STORAGE_INSPECTION_UNAVAILABLE", "persistent existence failure"));
      const persistent = waitForChannelMessages(
        f.ports,
        seed.channelId,
        { participantId: seed.worker },
        {
          intervalSeconds: 1,
          timeoutSeconds: 1,
          sleepMs,
        },
      );
      expect(!persistent.ok && persistent.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    } finally {
      time.mockRestore();
      f.close();
    }
  });

  it("absorbs a thrown content-state probe on fresh submit, ordinary replay, and replay-only", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const warnings = captureWarnings(f.ports);
    const text = "thrown probe body\n".repeat(7000);
    const activate = f.ports.staging.activateContent;
    let hidden = false;
    try {
      // The real activation completes, then the probed column disappears behind
      // the real probe's SQL: prepare/get throws on the live connection.
      f.ports.staging.activateContent = (input, binding) => {
        const result = activate(input, binding);
        if (!hidden) {
          hidden = true;
          hideContentRecords(f.home);
        }
        return result;
      };
      const fresh = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "thrown-probe-key",
        }),
      );
      f.ports.staging.activateContent = activate;
      expect(fresh.contentActivating).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`the content-state probe for message ${fresh.message.id} failed`);
      expect(warnings[0]).toContain("activation is not confirmed and contentActivating is reported as true");
      // The ordinary same-key replay observes the same thrown failure.
      const replay = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "thrown-probe-key",
        }),
      );
      expect(replay.replayed).toBe(true);
      expect(replay.message.id).toBe(fresh.message.id);
      expect(replay.contentActivating).toBe(true);
      expect(warnings).toHaveLength(2);
      // The replay-only observation translates a thrown inspection read too;
      // the schema stays valid, only the probe's SQL throws inside the reader.
      restoreContentRecords(f.home);
      hidden = false;
      const readonlyWarnings: string[] = [];
      const recovery = createNodeChannelRecoveryPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
        inspection: {
          openPrivateDatabase(path) {
            const db = new DatabaseSync(path);
            return {
              exec: (sql) => db.exec(sql),
              prepare(sql) {
                if (sql.includes("cr.materialized")) throw new Error("injected probe SQL failure");
                return db.prepare(sql);
              },
              close() {
                db.close();
              },
            };
          },
        },
      });
      const readonly = unwrap(
        submitMessageReplayOnly(
          { ...recovery, warnings: (warning) => readonlyWarnings.push(warning) },
          {
            installationId: f.ports.installationId,
            maxBytes: f.ports.maxBytes,
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(f.ports, text),
            idempotencyKey: "thrown-probe-key",
          },
        ),
      );
      expect(readonly.message.id).toBe(fresh.message.id);
      expect(readonly.contentActivating).toBe(true);
      expect(readonlyWarnings).toHaveLength(1);
      expect(readonlyWarnings[0]).toContain(`the content-state probe for message ${fresh.message.id} failed`);
    } finally {
      f.ports.staging.activateContent = activate;
      if (hidden) restoreContentRecords(f.home);
      f.close();
    }
  });

  it("never reports a busy content-state probe as the pre-commit contention refusal", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    const raw = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
    const ports = createNodeChannelPorts({
      env: { SORAGE_HOME: f.home },
      userHome: f.home,
      clock: new FakeClock(Date.parse(INSTALLATION_TIME)),
      database: busyProbeDatabase(raw),
    });
    const warnings = captureWarnings(ports);
    const text = "busy probe body\n".repeat(7000);
    try {
      const fresh = unwrap(
        submitMessage(ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "busy-probe-key",
        }),
      );
      const probe = ports.bodies.messageContentState(seed.channelId, fresh.message.id);
      expect(!probe.ok && probe.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      if (!probe.ok) {
        expect(probe.error.message).toContain("content state could not be read");
        expect(probe.error.message).toContain("database is locked");
        expect(probe.error.message).not.toContain("committed none of the changes");
      }
      expect(fresh.contentActivating).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`the content-state probe for message ${fresh.message.id} failed`);
      expect(warnings[0]).toContain("content state could not be read");
      expect(warnings[0]).toContain("database is locked");
      expect(warnings[0]).not.toContain("committed none of the changes");
      const replay = unwrap(
        submitMessage(ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "busy-probe-key",
        }),
      );
      expect(replay.replayed).toBe(true);
      expect(replay.message.id).toBe(fresh.message.id);
      expect(replay.contentActivating).toBe(true);
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).not.toContain("committed none of the changes");
      const readonlyWarnings: string[] = [];
      const recovery = createNodeChannelRecoveryPorts({
        env: { SORAGE_HOME: f.home },
        userHome: f.home,
        inspection: {
          openPrivateDatabase(path) {
            const db = new DatabaseSync(path);
            return {
              exec: (sql: string) => db.exec(sql),
              prepare(sql: string) {
                if (sql.includes("cr.materialized")) {
                  throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                }
                return db.prepare(sql);
              },
              close() {
                db.close();
              },
            };
          },
        },
      });
      const readonly = unwrap(
        submitMessageReplayOnly(
          { ...recovery, warnings: (warning) => readonlyWarnings.push(warning) },
          {
            installationId: ports.installationId,
            maxBytes: ports.maxBytes,
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(ports, text),
            idempotencyKey: "busy-probe-key",
          },
        ),
      );
      expect(readonly.message.id).toBe(fresh.message.id);
      expect(readonly.contentActivating).toBe(true);
      expect(readonlyWarnings).toHaveLength(1);
      expect(readonlyWarnings[0]).toContain("content state could not be read");
      expect(readonlyWarnings[0]).toContain("database is locked");
      expect(readonlyWarnings[0]).not.toContain("committed none of the changes");
    } finally {
      ports.close();
      raw.close();
      f.close();
    }
  });

  it("keeps the database-only content-state probe honest and never duplicates a committed message", () => {
    const f = fixture();
    const seed = seedChannel(f.ports);
    try {
      const missing = f.ports.bodies.messageContentState(seed.channelId, randomUUID());
      expect(!missing.ok && missing.error.code).toBe("STORAGE_INTEGRITY_ERROR");
      const warnings = captureWarnings(f.ports);
      const text = "probe seam body\n".repeat(7000);
      const probe = f.ports.bodies.messageContentState;
      f.ports.bodies.messageContentState = () => err(appError("STORAGE_INTEGRITY_ERROR", "injected probe failure"));
      const submitted = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "probe-seam-key",
        }),
      );
      expect(submitted.contentActivating).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("injected probe failure");
      expect(warnings[0]).toContain("activation is not confirmed and contentActivating is reported as true");
      const recovery = createNodeChannelRecoveryPorts({ env: { SORAGE_HOME: f.home }, userHome: f.home });
      const replayOnly = unwrap(
        submitMessageReplayOnly(
          {
            ...recovery,
            warnings: (warning) => warnings.push(warning),
            inspect: (consume) =>
              recovery.inspect((observation) =>
                consume({
                  ...observation,
                  contentState: () => err(appError("STORAGE_INTEGRITY_ERROR", "injected replay probe failure")),
                }),
              ),
          },
          {
            installationId: f.ports.installationId,
            maxBytes: f.ports.maxBytes,
            channelId: seed.channelId,
            senderParticipantId: seed.worker,
            kind: "report",
            accepted: accepted(f.ports, text),
            idempotencyKey: "probe-seam-key",
          },
        ),
      );
      expect(replayOnly.message.id).toBe(submitted.message.id);
      expect(replayOnly.contentActivating).toBe(true);
      f.ports.bodies.messageContentState = probe;
      const replay = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, text),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "probe-seam-key",
        }),
      );
      expect(replay.replayed).toBe(true);
      expect(replay.message.id).toBe(submitted.message.id);
      expect(replay.contentActivating).toBe(false);
      // One committed message and one submission event: no path duplicated the effect.
      const db = openSorageDatabase(join(f.home, "state", "sorage.sqlite3"));
      try {
        const messages = db
          .prepare("SELECT COUNT(*) AS count FROM channel_messages WHERE channel_id = ?")
          .get(seed.channelId) as { count: number };
        expect(messages.count).toBe(1);
        const events = db
          .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'CHANNEL_MESSAGE_SUBMITTED'")
          .get() as { count: number };
        expect(events.count).toBe(1);
      } finally {
        db.close();
      }
      // Inline content never probes: a replayed inline message reports false.
      const inline = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, "inline body"),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "inline-seam-key",
        }),
      );
      expect(inline.contentActivating).toBe(false);
      let probes = 0;
      const counting = f.ports.bodies.messageContentState;
      f.ports.bodies.messageContentState = (channelId, messageId) => {
        probes += 1;
        return counting(channelId, messageId);
      };
      const inlineReplay = unwrap(
        submitMessage(f.ports, {
          channelId: seed.channelId,
          senderParticipantId: seed.worker,
          kind: "report",
          accepted: accepted(f.ports, "inline body"),
          actor: projectActor("11111111-2222-4333-8444-555555555555"),
          idempotencyKey: "inline-seam-key",
        }),
      );
      expect(inlineReplay.replayed).toBe(true);
      expect(inlineReplay.contentActivating).toBe(false);
      expect(probes).toBe(0);
      f.ports.bodies.messageContentState = counting;
    } finally {
      f.close();
    }
  });
});
